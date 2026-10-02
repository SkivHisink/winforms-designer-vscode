# AGENTS.md

Instructions for coding agents working in this repository. Human contributors: see [CONTRIBUTING.md](CONTRIBUTING.md).
For where things are, read [docs/project-map.md](docs/project-map.md) first.

## Environment

- Windows only. The engine needs the .NET SDK pinned by `global.json`. The `net4x` engine needs the .NET Framework
  4.8 targeting pack. The extension needs Node 24.
- Two engines run as separate processes: `engine/` (modern, net10.0-windows) and `engine-net48/` (.NET Framework 4.8, x64).
  About twenty `engine/*.cs` files are compiled into both. The list is in the project map.

## Build and test

```powershell
dotnet build engine -c Release
dotnet build engine-net48 -c Release -p:PlatformTarget=x64
dotnet test tests/Engine.UnitTests -c Release
dotnet test tests/Engine.Net48.UnitTests -c Release
cd extension
npm ci
npm run typecheck
npm test
npm run build
npm run e2e            # headless; set WFD_REQUIRE_NET48=1 to require the net48 legs
npm run webview-e2e    # headless jsdom
npm run l10n:parity -- --strict
npm run mojibake:scan
```

`npm run extension-host-e2e -- --version=1.84.0` and `--version=stable` launch real VS Code windows.

`.github/workflows/ci.yml` is the definition of green. Before claiming that everything passes, run every step it
runs, not a subset.

## Rules

- **Security gates.** Never relax:
  - the interpreter allowlists in `engine/DesignerAllowlists.cs`;
  - the edit-minimality gates;
  - the identifier validation done before generated code is written.

  Controls are created through the design host, never through `Eval`. Any change that touches a gate needs new tests.
- **No windows.** Engines, tests and probes stay headless:
  - never call `Show`, `ShowDialog`, `MessageBox` or `Application.Run`;
  - designer errors go through `HeadlessDesignerUIService` and become listed constructs.
- **Fail closed.** What the engine cannot reproduce is listed by name. It is never silently dropped or guessed.
  Saving writes the in-memory text byte for byte. A form that cannot be regenerated losslessly keeps targeted edits
  and refuses whole-file regeneration.
- **Project files.** A preview reads only files inside the owning project. It does not follow links and does not
  execute the generated resource accessors.
- **Localization.** Every runtime string goes into `extension/src/i18n/en.ts` and the six translations in
  `extension/src/i18n/*.json`. Contribution strings go into `extension/package.nls*.json`. Keep `l10n:parity --strict`
  and `mojibake:scan` green.
- **Pinned and generated files.** Never hand-edit:
  - files `.gitattributes` marks as byte-pinned: reference traces, `fixtures/VisualStudioReference`, the
    adapter-manifest sample;
  - the generated protocol files (`V2Protocol.cs`, `v2Protocol.ts`). Regenerate them with
    `node scripts/generate-v2-protocol.mjs`.

  Preserve each file's existing line endings.
- **Release evidence.** `docs/release-<version>.md` and its `docs/release-<version>/*.json` reports are bound to
  artifact SHA-256 hashes. A product change after the evidence was taken means re-running it.
- **Docs.** `CHANGELOG.md` at the root is the maintained changelog; `extension/CHANGELOG.md` is a build copy.
  Tracked files must not link to the ignored notes folders (`docs/plans/`, `docs/handoffs/`, `docs/maps/`,
  `docs/release-*-completion-plan.md`).
- **Commits and docs text.** Describe the product change and how it was verified. Do not name tools, models or
  agents, and do not add co-author trailers.
- **Scope.** Keep changes minimal. Do not upgrade dependencies unless asked. Do not commit, push or tag unless the
  maintainer asks.
