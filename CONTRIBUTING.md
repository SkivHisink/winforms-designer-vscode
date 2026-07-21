# Contributing to WinForms Designer for VS Code

Thanks for your interest in contributing! This guide covers the repo layout, how to build and test, the dev loop, and the conventions (and a few hard-won gotchas) that keep the project healthy.

By participating you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md).

## Repository layout

| Path | What it is |
|------|------------|
| [`engine/`](engine/) | The primary C# rendering/editing engine (`net10.0-windows`). Parses `.Designer.cs` with Roslyn, safely interprets it, hosts the controls in WinForms, renders with `DrawToBitmap`, and applies edits. It supports modern `.NET 8` / `.NET 9` / `.NET 10` WinForms projects and talks JSON-RPC over a named pipe. |
| [`engine-net48/`](engine-net48/) | The experimental **.NET Framework 4.8** x64 engine (`net48`) for `net4x` / DevExpress forms the modern engine can't load. Instantiates the *compiled* control types from the project's build output and renders them; the extension routes a form here when its control assembly targets .NET Framework. Same JSON-RPC surface. |
| [`extension/`](extension/) | The VS Code extension (TypeScript). Custom editor, dockable panel, two-engine routing/lifecycle, and the JSON-RPC client to the engines. |
| `extension/media/` | Webview UI scripts (plain JS): `designer.js` (canvas), `panel.js` (properties + toolbox + outline). |
| `engine/samples/`, `samples/` | Sample `.Designer.cs` forms used as fixtures and for the F5 dev loop. |

## Prerequisites

- **Windows x64** (WinForms is Windows-only; the stable VSIX targets `win32-x64`).
- **[.NET 10 SDK](https://dotnet.microsoft.com/download/dotnet/10.0)** — the repo pins it via [`global.json`](global.json).
- **.NET Framework 4.8 targeting pack** — only needed to build the experimental `engine-net48/` engine (ships with the Visual Studio Build Tools; the runtime itself is part of Windows).
- **Node.js 20+** and npm.
- **VS Code** `^1.84`.

## Build

```bash
# Engine (C#)
dotnet build engine -c Release
#   → engine/bin/Release/net10.0-windows/WinFormsDesigner.Engine.exe/.dll

# .NET Framework 4.8 engine (experimental — net4x / DevExpress forms)
dotnet build engine-net48 -c Release
#   → engine-net48/bin/Release/net48/WinFormsDesigner.Engine.Net48.exe

# Extension (from extension/)
cd extension
npm ci
npm run typecheck     # tsc --noEmit
npm run build         # esbuild → dist/extension.js + dist/e2e.cjs
```

## Test

```bash
# Fast unit layers (run from the repository root / extension folder respectively).
dotnet test tests/Engine.UnitTests -c Release
cd extension
npm test

# Headless end-to-end (drives the engine like the extension does, no GUI).
# Build both engines in Release first — release-mode e2e requires the net48 cross-runtime legs too.
$env:WFD_REQUIRE_NET48 = "1"   # PowerShell
npm run e2e
npm run webview-e2e
npm run l10n:parity
npm run build
npm run perf:baseline
npm run extension-host-e2e -- --version=1.84.0
npm run extension-host-e2e -- --version=stable

# Webview scripts have no type checker — at minimum syntax-check them:
node --check media/designer.js
node --check media/panel.js
```

The engine also has a CLI for poking at it directly on a sample form:

```bash
dotnet engine/bin/Release/net10.0-windows/WinFormsDesigner.Engine.dll --render engine/samples/SampleForm.Designer.cs
# other verbs: --describe --layout --render-layout --set-prop --convert --resolve --save --selftest --pipe
```

> 📋 For the complete testing strategy and tier boundaries, see [docs/TESTING.md](docs/TESTING.md).

## The F5 dev loop (interactive)

Headless tests **do not execute webview JavaScript**, so any webview/UI change must be verified by running the extension:

1. Open the **`extension/`** folder in VS Code.
2. Press **F5** (full restart — not `Ctrl+R` — because launch args matter). This builds the extension and opens an *Extension Development Host*.
3. The host opens on `engine/samples` with all other extensions disabled (see [`extension/.vscode/launch.json`](extension/.vscode/launch.json)).
4. Open **`SampleForm.cs`** — the designer should render the form. Try selecting controls, editing properties, the toolbox, drag/resize, and saving.

The engine logs to the **WinForms Designer** output channel.

## Conventions

### Code style
- **C#:** `nullable enable`, `var` for obvious types, explicit types where it aids clarity, `async/await` (never `.Result`/`.Wait()`). Match the existing file's style.
- **TypeScript:** strict; keep the engine interop **camelCase** (the engine serializes DTOs as camelCase — do not reintroduce PascalCase).
- **Comments and identifiers in English.**

### Hard-won lessons (please don't re-learn these)
- **Webview scripts must be external files** loaded via `webview.asWebviewUri(...)` + a `nonce` + `localResourceRoots` — inline `<script>` silently fails to execute in the Extension Host.
- **For in-canvas direct manipulation (move/resize), use mouse/pointer events** — HTML5 drag-and-drop is unreliable for that.
- **Toolbox → canvas “add” uses HTML5 drag/drop with a _custom_ MIME type** (`application/vnd.winforms-toolbox-item`) that carries only a control-type token, not pixels — and **always keeps click-to-add as a reliable fallback** (drag across separate webviews behaves differently per host, so it must never be the only path).
- `acquireVsCodeApi()` may be called **only once per webview** — that's why properties + toolbox share one `panel.js`.
- A C# `null` arrives in TypeScript as `undefined` — compare with `!= null`.
- Engine DTOs are serialized **camelCase**; keep the TypeScript interop camelCase.

### Engine security gates — do not weaken
The engine executes interpreted code from `.Designer.cs` when building a preview. Several **allowlists / minimality gates** keep that safe:
- Construction / static-invocation / static-read **allowlists** in the interpreter (`Eval`).
- Edit-minimality gates: `OnlyTargetChanged`, `OnlyWiringChanged`, `OnlyControlAdded`, `OnlyControlRemoved`, and the statement-diff save gate.

**Never relax these.** Controls are created through the design-time host (`host.CreateComponent`), not through `Eval`. Always **validate identifiers** before interpolating them into generated code (injection risk). Any change touching these gates must ship with new tests **and** a focused security review.

## Submitting a pull request

Before opening a PR, please make sure you've:

1. Built both engines and run `dotnet test tests/Engine.UnitTests -c Release` — **0 warnings, 0 errors, all green**.
2. Run `npm test`, `npm run typecheck`, `npm run build`, `npm run perf:baseline`, and `npm run e2e` — all green.
3. `node --check`-ed any changed webview script, and **manually verified UI changes via F5**.
4. Kept the change set **minimal and focused** (one logical change per PR).
5. Not weakened any security gate (or, if you touched one, included tests + a review note).
6. Updated [`CHANGELOG.md`](CHANGELOG.md) under *Unreleased*.
7. **Not committed any secrets**, local paths, or build output.

Then open the PR and fill in the template. Link the issue it closes, describe the risk, and attach a screenshot/GIF for any UI change. A maintainer will review — be ready for a round or two of feedback.

## Releasing (maintainers)

Continuous integration runs on every push/PR ([`ci.yml`](.github/workflows/ci.yml)); releases are automated by [`release.yml`](.github/workflows/release.yml):

1. Bump the version in [`extension/package.json`](extension/package.json) and `package-lock.json`, then add the matching section to [`CHANGELOG.md`](CHANGELOG.md). Run `npm run release:preflight`.
2. Commit, then tag and push:
   ```bash
   git tag v1.0.0
   git push origin v1.0.0
   ```
3. The workflow builds both engines, runs the strict net48 and VS Code Extension Host gates, packages a `win32-x64` VSIX with a framework-dependent .NET 10 x64 apphost, attaches that exact artifact to a new **GitHub Release**, and publishes the same VSIX to the marketplaces.

**Repository secrets** (*Settings → Secrets and variables → Actions*):

| Secret | Purpose |
|--------|---------|
| `VSCE_PAT` | **Required for a tagged stable release.** Publishes to the **VS Code Marketplace** (`vsce publish`). Requires a verified publisher matching `publisher` in `package.json`. |
| `OVSX_PAT` | Optional. Publishes to **[Open VSX](https://open-vsx.org/)** (`ovsx publish`). |

If `VSCE_PAT` is absent, a tagged stable release fails instead of silently producing a GitHub-only release. If `OVSX_PAT` is absent, only the Open VSX step is skipped. `GITHUB_TOKEN` is provided automatically.

Thank you! 💙
