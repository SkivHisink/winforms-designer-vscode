# Testing strategy

This document describes the project's unit, integration, webview, Extension Host, and performance gates.
It complements the dev/test commands in
[CONTRIBUTING.md](../CONTRIBUTING.md).

> Status: the fast C# and TypeScript unit layers are implemented and required in both CI and release builds.

## Test pyramid

| Tier | What it covers | Speed | Where |
|------|----------------|-------|-------|
| **Unit** *(exists)* | Pure / near-pure functions in isolation: security gates, allowlists, value conversion, identifier validation, TFM selection, TS expression helpers, and engine recovery policy. No WinForms host, no STA, no filesystem. | ms | [`tests/Engine.UnitTests`](../tests/Engine.UnitTests) (C#), [`extension/src/*.test.ts`](../extension/src) (TS) |
| **Performance baseline** *(exists)* | Engine cold start plus seven warm render/layout RPC samples, checked against configurable regression thresholds. | seconds | [`extension/src/performance-baseline.ts`](../extension/src/performance-baseline.ts) → `npm run perf:baseline` |
| **Integration / E2E** *(exists)* | The whole engine driven over the named pipe against sample `.Designer.cs` fixtures: render, layout, property edits, add/remove, events, MSBuild resolution, byte-identity. | seconds | [`extension/src/e2e.ts`](../extension/src/e2e.ts) → `npm run e2e` |
| **Live-webview** *(exists)* | The real `media/designer.js` + `media/panel.js` loaded into a headless jsdom window; synthetic events (keyboard nudge, click/selection, context-menu, banner dismiss, zoom, property-grid edits) assert on the messages the webview posts back + the resulting DOM. No Extension Host, no engine. | seconds | [`extension/src/webview-e2e.ts`](../extension/src/webview-e2e.ts) → `npm run webview-e2e` |
| **VS Code Extension Host smoke** *(exists)* | Loads the real extension in VS Code, verifies its manifest and commands, activates it, runs Export Diagnostics, and proves the .NET 10 engine starts. Runs against VS Code 1.84 and current Stable. | minutes | [`extension/src/extension-host-suite.ts`](../extension/src/extension-host-suite.ts) → `npm run extension-host-e2e -- --version=…` |
| **Manual / F5** *(exists)* | Anything the headless webview layer can't reach: real PNG rendering, cross-webview drag geometry, VS Code focus/theming, layout that depends on real `getBoundingClientRect`. | manual | Extension Development Host (F5) |

## What exists today

- **Engine unit tests** — `dotnet test tests/Engine.UnitTests -c Release` directly covers safe-save minimality,
  syntax equivalence, identifier injection guards, interpreter allowlists, value conversion, and TFM selection.
- **Extension unit tests** — `npm test` runs Vitest over C# expression conversion helpers and the bounded,
  per-engine crash-recovery policy.
- **E2E harness** — [`extension/src/e2e.ts`](../extension/src/e2e.ts) (`npm run e2e`) spins up the modern and net48 engines and runs the full cross-runtime pipeline. Release CI sets `WFD_REQUIRE_NET48=1`, so missing net48 coverage is a failure rather than a skip. The multi-target fixture is also compiled separately for `net8.0-windows`, `net9.0-windows`, and `net10.0-windows`, preventing the advertised modern-project range from drifting unnoticed.
- **Extension Host smoke** — the extension is built and executed in both the declared minimum VS Code 1.84 and current Stable; it must activate, start the .NET 10 engine, and export latency, memory, capability, PID, and lifecycle diagnostics.
- **Performance baseline** — `npm run perf:baseline` checks startup, warm median, and warm p95 in CI and release jobs. Thresholds can be overridden with `WFD_PERF_STARTUP_MS`, `WFD_PERF_WARM_MEDIAN_MS`, and `WFD_PERF_WARM_P95_MS`.
- **Engine self-test** — the `--selftest <designerFile>` CLI verb does a smoke check on a designer file.

The unit layers localize pure/security regressions quickly; the other tiers prove that the real WinForms host,
named-pipe protocol, webview, and VS Code activation path still agree end to end.

## Why the unit layer exists

1. **Pin the security boundary.** The engine interprets and edits code from `.Designer.cs`. The safe-save gates and interpreter allowlists are the line between "safe preview" and RCE-on-open. They deserve direct, exhaustive, fast tests — including adversarial/negative cases — that don't depend on rendering.
2. **Fast feedback & refactor safety.** Pure-function tests run in milliseconds and localize regressions to one function.
3. **Contributor confidence.** A `dotnet test` / `npm test` that runs in seconds lowers the bar to contribute (vs. needing the full engine + sample builds for e2e).

## Testability — the good news

Most high-value targets are **already `public static` and accept a source-text string** (an in-memory `.Designer.cs` buffer), so they can be unit-tested with **no temp files, no STA thread, and no WinForms rendering**:

- safe-save gate classifiers: `OnlyControlAdded`, `OnlyControlRemoved`, `OnlyWiringAdded`, `OnlyWiringChanged`, `OnlyTargetChanged` (all `public static`, `string → bool`).
- `DesignerControlEditor.AddControl(string src, …)` / `RemoveControl(string src, …)` → results expose `.Safe`/`.Reason`.
- `DesignerControlEditor.IsValidIdentifier(string)` (`public static`) — the injection guard.
- `DesignerValueConverter.ToExpression(string typeName, string invariantValue)` (`public static`, pure).
- `ApplyPropertyEdit(…, sourceText)`, `SetEventWiring(string src, …)`, `GenerateEventHandler(…)` — all accept buffers.

A few targets are exposed as `internal` test hooks rather than widening the public engine API:

- Interpreter allowlists in `DesignerRenderer`: `IsConstructionAllowed` / `AllowedConstructionTypes`, `AllowedStaticInvocations`, `AllowedStaticReadTypes`.
- `ProjectResolver` TFM logic: the `NetCoreTfm` regex and the `ChooseTfm` selection.

The engine uses `[assembly: InternalsVisibleTo("Engine.UnitTests")]`; allowlists and TFM selection are
`internal`, while the product-facing API stays unchanged.

## Engine unit tests (C#) — highest value

**Project:** `tests/Engine.UnitTests/Engine.UnitTests.csproj` — xUnit, `net10.0-windows` (the engine references WinForms/`System.Drawing` types), references `engine/Engine.csproj`. Runs on `windows-latest`.

| Target | Assert |
|--------|--------|
| `OnlyControlAdded` / `OnlyControlRemoved` | Legit single add/remove → `true`; an extra unrelated statement, a sibling change, or a dangling `this.<id>` reference → `false`. |
| `OnlyTargetChanged` / `OnlyWiringChanged` / `OnlyWiringAdded` | Only the targeted `(comp, prop)` / wiring changed → `true`; any side-effect statement → `false`. |
| `IsValidIdentifier` | Accepts valid C# identifiers; rejects injection (`"x; System.Diagnostics.Process.Start(...)"`), keywords, empty, leading digits, and look-alike unicode. |
| `DesignerValueConverter.ToExpression` | Round-trips `Point`, `Size`, `Color` (named / `FromArgb` / `SystemColors`), `Font` (plain / bold / bold+italic), `Padding`, `Rectangle`; returns `null` on invalid input, an uninstalled font family, and blank. |
| `AddControl(src, …)` / `RemoveControl(src, …)` | `.Safe` true for a leaf control on the form; false for root, a container-with-children, or an unknown type/parent. `add` then `remove` returns the **original bytes**. |
| Interpreter allowlists (via crafted source or `internal`) | `new FileStream/Bitmap/Cursor(path)`, `MessageBox.Show(...)`, `Image.FromFile(...)`, `Environment.MachineName` → unrepresentable / not executed (no file created). Allowed: `Color.FromArgb(...)`, `new Point(...)`, `SystemColors.Control`. |

**Conventions:** Arrange-Act-Assert; one behavior per test; name `Method_Scenario_Expected`; use the `sourceText`/`src` overloads (inline `.Designer.cs` strings, no temp files); keep tests STA-free and render-free.

## Resolver unit tests (C#)

`ProjectResolver` test hooks are `internal`:

- `NetCoreTfm` regex accepts `net8.0-windows`, `net9.0-windows`, `net10.0-windows`, and versioned Windows TFMs such as `net10.0-windows10.0.19041.0`; rejects `net48`, `netstandard`, and junk.
- `ChooseTfm` prefers a host-loadable, `-windows`, highest-but-≤-host-major TFM.

The full MSBuild design-time evaluation path (filesystem + `dotnet msbuild`) stays in **e2e** (the `ComplexProject` fixture already covers multi-target / custom `OutputPath`).

## Extension unit tests (TS)

**Framework:** [Vitest](https://vitest.dev/) (pure, no `vscode`), invoked by `npm test`.

| Target ([`valueExpr.ts`](../extension/src/valueExpr.ts)) | Assert |
|--------|--------|
| `toCSharpExpression(type, isEnum, raw)` | Correct literals for primitives/enums/strings (incl. escaping); `null` on invalid. |
| `COMPLEX_TYPE_SET` / `shortName` | Membership of the complex types; namespace-stripping. |
| `EngineRecoveryPolicy` | Two bounded restarts with exponential backoff, crash-loop stop, independent runtime state, and window expiry. |

Later (P2): factor the pure parts of the `assemblyPath` resolution out of the `vscode`-coupled code in `extension.ts` so the `~` / relative / missing-path logic can be unit-tested without mocking the VS Code API.

## CI integration

Both [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) and
[`release.yml`](../.github/workflows/release.yml) require:

```yaml
- name: Unit tests (engine)
  run: dotnet test tests/Engine.UnitTests -c Release
- name: Unit tests (extension)
  working-directory: extension
  run: npm test
- name: Performance baseline
  working-directory: extension
  run: npm run perf:baseline
```

Optional coverage: `coverlet` for C#, `vitest --coverage` for TS — report only at first; a coverage gate can come later.

## Rollout

- **P0 — complete:** safe-save gates, `IsValidIdentifier`, `DesignerValueConverter.ToExpression`, and add/remove safety; C# tests required in CI/release.
- **P1 — complete:** allowlists, TFM regex/selection, Vitest for `valueExpr.ts` and recovery policy; TS tests required in CI/release.
- **P2 — broaden + decouple:** factor pure config/path logic out of `vscode`-coupled code; widen TS coverage; add coverage reporting.
- **P3 — golden fixtures:** snapshot/golden tests for fragile constructs (DataGridView, BindingSource, etc.) — overlaps the e2e fixtures.

## Non-goals for the unit layer

These stay in their existing tiers (don't try to unit-test them):

- Full WinForms rendering / `DrawToBitmap` (needs an STA thread + a real host) → **e2e**.
- MSBuild design-time evaluation (needs the filesystem + `dotnet`) → **e2e**.
- Webview JavaScript **rendering fidelity** (real PNG blit, `getBoundingClientRect`-dependent drag/marquee geometry, VS Code theming/focus) → **manual F5**. The webview *logic* (event → posted message, DOM state) is now covered headlessly by [`webview-e2e.ts`](../extension/src/webview-e2e.ts) (`npm run webview-e2e`), on top of `node --check` for syntax.
