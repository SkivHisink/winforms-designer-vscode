# Testing strategy & unit-test roadmap

This document describes how the project is tested today and the plan for adding a
fast **unit-test** layer. It complements the dev/test commands in
[CONTRIBUTING.md](../CONTRIBUTING.md).

> Status: the unit-test layer described below is **planned, not yet implemented**.
> This is the agreed roadmap — see [Rollout](#rollout).

## Test pyramid

| Tier | What it covers | Speed | Where |
|------|----------------|-------|-------|
| **Unit** *(to add)* | Pure / near-pure functions in isolation: security gates, allowlists, value conversion, identifier validation, TFM selection, the TS expression helpers. No WinForms host, no STA, no filesystem. | ms | `tests/` (C#), `extension/` (TS) |
| **Integration / E2E** *(exists)* | The whole engine driven over the named pipe against sample `.Designer.cs` fixtures: render, layout, property edits, add/remove, events, MSBuild resolution, byte-identity. | seconds | [`extension/src/e2e.ts`](../extension/src/e2e.ts) → `npm run e2e` |
| **Manual / F5** *(exists)* | Webview UI (canvas, property grid, toolbox, drag/resize) — not covered by headless tests. | manual | Extension Development Host (F5) |

## What exists today

- **E2E harness** — [`extension/src/e2e.ts`](../extension/src/e2e.ts) (`npm run e2e`) spins up the engine and runs ~25 sequential assertions across the full pipeline. Runs in CI.
- **Engine self-test** — the `--selftest <designerFile>` CLI verb does a smoke check on a designer file.

These prove the system end-to-end but are **not** unit tests: they exercise everything together (including the WinForms host) rather than individual functions in isolation, and a single regression can be hard to localize.

## Why add unit tests

1. **Pin the security boundary.** The engine interprets and edits code from `.Designer.cs`. The §6.5 gates and interpreter allowlists are the line between "safe preview" and RCE-on-open. They deserve direct, exhaustive, fast tests — including adversarial/negative cases — that don't depend on rendering.
2. **Fast feedback & refactor safety.** Pure-function tests run in milliseconds and localize regressions to one function.
3. **Contributor confidence.** A `dotnet test` / `npm test` that runs in seconds lowers the bar to contribute (vs. needing the full engine + sample builds for e2e).

## Testability — the good news

Most high-value targets are **already `public static` and accept a source-text string** (an in-memory `.Designer.cs` buffer), so they can be unit-tested with **no temp files, no STA thread, and no WinForms rendering**:

- §6.5 gate classifiers: `OnlyControlAdded`, `OnlyControlRemoved`, `OnlyWiringAdded`, `OnlyWiringChanged`, `OnlyTargetChanged` (all `public static`, `string → bool`).
- `DesignerControlEditor.AddControl(string src, …)` / `RemoveControl(string src, …)` → results expose `.Safe`/`.Reason`.
- `DesignerRenderer.IsValidIdentifier(string)` (`public static`) — the injection guard.
- `DesignerValueConverter.ToExpression(string typeName, string invariantValue)` (`public static`, pure).
- `ApplyPropertyEdit(…, sourceText)`, `SetEventWiring(string src, …)`, `GenerateEventHandler(…)` — all accept buffers.

A few targets are `private` and need a tiny refactor to test directly (see below):

- Interpreter allowlists in `DesignerRenderer`: `IsConstructionAllowed` / `AllowedConstructionTypes`, `AllowedStaticInvocations`, `AllowedStaticReadTypes`.
- `ProjectResolver` TFM logic: the `NetCoreTfm` regex and the `ChooseTfm` selection.

**Refactor:** add `[assembly: InternalsVisibleTo("Engine.UnitTests")]` to the engine and bump those few members from `private` to `internal`. (Alternatively, the allowlists can be tested *through* the public boundary by feeding crafted source to `SerializeFromFile` and asserting `Unrepresentable` — no visibility change needed; prefer this where practical to keep the surface small.)

## Engine unit tests (C#) — highest value

**Project:** `tests/Engine.UnitTests/Engine.UnitTests.csproj` — xUnit, `net9.0-windows` (the engine references WinForms/`System.Drawing` types), references `engine/Engine.csproj`. Runs on `windows-latest`.

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

`ProjectResolver` (needs the few members made `internal`):

- `NetCoreTfm` regex accepts `net9.0-windows`, `net48`, and versioned `net9.0-windows10.0.19041.0`; rejects junk.
- `ChooseTfm` prefers a host-loadable, `-windows`, highest-but-≤-host-major TFM.

The full MSBuild design-time evaluation path (filesystem + `dotnet msbuild`) stays in **e2e** (the `ComplexProject` fixture already covers multi-target / custom `OutputPath`).

## Extension unit tests (TS)

**Framework:** [vitest](https://vitest.dev/) (pure, no `vscode`). Add a `"test": "vitest run"` script + dev-dependency.

| Target ([`valueExpr.ts`](../extension/src/valueExpr.ts)) | Assert |
|--------|--------|
| `toCSharpExpression(type, isEnum, raw)` | Correct literals for primitives/enums/strings (incl. escaping); `null` on invalid. |
| `COMPLEX_TYPE_SET` / `shortName` | Membership of the complex types; namespace-stripping. |

Later (P2): factor the pure parts of the `assemblyPath` resolution out of the `vscode`-coupled code in `extension.ts` so the `~` / relative / missing-path logic can be unit-tested without mocking the VS Code API.

## CI integration

Add to [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) (and `release.yml` as a gate):

```yaml
- name: Unit tests (engine)
  run: dotnet test tests/Engine.UnitTests -c Release
- name: Unit tests (extension)
  working-directory: extension
  run: npm test
```

Optional coverage: `coverlet` for C#, `vitest --coverage` for TS — report only at first; a coverage gate can come later.

## Rollout

- **P0 — security core (no refactor):** §6.5 gates, `IsValidIdentifier`, `DesignerValueConverter.ToExpression`, `AddControl`/`RemoveControl` `.Safe` — all via existing public APIs. Create `tests/Engine.UnitTests`, wire `dotnet test` into CI.
- **P1 — allowlists + resolver + TS:** allowlist negative tests (boundary or `InternalsVisibleTo`); `ProjectResolver` TFM regex/selection; vitest for `valueExpr.ts`; wire `npm test` into CI.
- **P2 — broaden + decouple:** factor pure config/path logic out of `vscode`-coupled code; widen TS coverage; add coverage reporting.
- **P3 — golden fixtures:** snapshot/golden tests for fragile constructs (DataGridView, BindingSource, etc.) — overlaps the e2e fixtures.

## Non-goals for the unit layer

These stay in their existing tiers (don't try to unit-test them):

- Full WinForms rendering / `DrawToBitmap` (needs an STA thread + a real host) → **e2e**.
- MSBuild design-time evaluation (needs the filesystem + `dotnet`) → **e2e**.
- Webview JavaScript behavior (`media/*.js`) → **manual F5** + `node --check` for syntax.
