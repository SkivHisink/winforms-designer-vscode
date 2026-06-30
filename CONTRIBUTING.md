# Contributing to WinForms Designer for VS Code

Thanks for your interest in contributing! This guide covers the repo layout, how to build and test, the dev loop, and the conventions (and a few hard-won gotchas) that keep the project healthy.

By participating you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md).

## Repository layout

| Path | What it is |
|------|------------|
| [`engine/`](engine/) | The C# rendering/editing engine (`net9.0-windows`). Parses `.Designer.cs` with Roslyn, safely interprets it, hosts the controls in WinForms, renders with `DrawToBitmap`, and applies edits. Talks JSON-RPC over a named pipe. |
| [`extension/`](extension/) | The VS Code extension (TypeScript). Custom editor, dockable panel, and the JSON-RPC client to the engine. |
| `extension/media/` | Webview UI scripts (plain JS): `designer.js` (canvas), `panel.js` (properties + toolbox + outline). |
| `engine/samples/`, `samples/` | Sample `.Designer.cs` forms used as fixtures and for the F5 dev loop. |

## Prerequisites

- **Windows** (WinForms is Windows-only).
- **[.NET 9 SDK](https://dotnet.microsoft.com/download)** — the repo pins it via [`global.json`](global.json).
- **Node.js 20+** and npm.
- **VS Code** `^1.84`.

## Build

```bash
# Engine (C#)
dotnet build engine -c Release
#   → engine/bin/Release/net9.0-windows/WinFormsDesigner.Engine.dll

# Extension (from extension/)
cd extension
npm ci
npm run typecheck     # tsc --noEmit
npm run build         # esbuild → dist/extension.js + dist/e2e.cjs
```

## Test

```bash
# Headless end-to-end (drives the engine like the extension does, no GUI).
# Build the engine in Release first — e2e launches that DLL.
cd extension
npm run e2e

# Webview scripts have no type checker — at minimum syntax-check them:
node --check media/designer.js
node --check media/panel.js
```

The engine also has a CLI for poking at it directly on a sample form:

```bash
dotnet engine/bin/Release/net9.0-windows/WinFormsDesigner.Engine.dll --render engine/samples/SampleForm.Designer.cs
# other verbs: --describe --layout --render-layout --set-prop --convert --resolve --save --selftest --pipe
```

> 📋 For the testing strategy and the **unit-test roadmap**, see [docs/TESTING.md](docs/TESTING.md).

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

1. Built the engine (`dotnet build engine -c Release`) — **0 warnings, 0 errors**.
2. Run `npm run typecheck`, `npm run build`, and `npm run e2e` — all green.
3. `node --check`-ed any changed webview script, and **manually verified UI changes via F5**.
4. Kept the change set **minimal and focused** (one logical change per PR).
5. Not weakened any security gate (or, if you touched one, included tests + a review note).
6. Updated [`CHANGELOG.md`](CHANGELOG.md) under *Unreleased*.
7. **Not committed any secrets**, local paths, or build output.

Then open the PR and fill in the template. Link the issue it closes, describe the risk, and attach a screenshot/GIF for any UI change. A maintainer will review — be ready for a round or two of feedback.

## Releasing (maintainers)

Continuous integration runs on every push/PR ([`ci.yml`](.github/workflows/ci.yml)); releases are automated by [`release.yml`](.github/workflows/release.yml):

1. Bump `version` in [`extension/package.json`](extension/package.json) and add a section to [`CHANGELOG.md`](CHANGELOG.md).
2. Commit, then tag and push:
   ```bash
   git tag v0.1.0
   git push origin v0.1.0
   ```
3. The workflow builds, runs the e2e gate, packages a self-contained VSIX (engine bundled via `vscode:prepublish`), attaches it to a new **GitHub Release**, and — if the secrets below are configured — publishes to the marketplaces.

**Optional repository secrets** (*Settings → Secrets and variables → Actions*):

| Secret | Purpose |
|--------|---------|
| `VSCE_PAT` | Publish to the **VS Code Marketplace** (`vsce publish`). Requires a verified publisher matching `publisher` in `package.json`. |
| `OVSX_PAT` | Publish to **[Open VSX](https://open-vsx.org/)** (`ovsx publish`). |

If a secret is absent, that publish step is skipped — the GitHub Release with the attached VSIX is still created. `GITHUB_TOKEN` is provided automatically.

Thank you! 💙
