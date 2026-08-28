<div align="center">

# WinForms Designer for VS Code

**A Visual Studio–style WinForms form designer, running natively inside VS Code.**

Render, click-select, edit and lay out `.Designer.cs` forms — live — without leaving the editor.

[![CI](https://github.com/SkivHisink/winforms-designer-vscode/actions/workflows/ci.yml/badge.svg)](https://github.com/SkivHisink/winforms-designer-vscode/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![VS Code Engine](https://img.shields.io/badge/VS%20Code-%5E1.84-007ACC?logo=visualstudiocode)](https://code.visualstudio.com/)
[![.NET](https://img.shields.io/badge/.NET-10.0%20LTS-512BD4?logo=dotnet)](https://dotnet.microsoft.com/)
[![Version 2.0](https://img.shields.io/badge/version-2.0-brightgreen.svg)](#support-matrix)

</div>

<div align="center">

![WinForms Designer for VS Code](pictures/main-picture.png)

</div>

## 🎬 Drag & drop, live

Drop a control from the toolbox onto a **DevExpress** form and it lands where you put it — snaplines, selection handles and all — while the change goes back into `.Designer.cs` as a minimal edit.

<div align="center">

![Dragging a ComboBox from the toolbox onto a DevExpress form](pictures/demo-drag-drop.gif)

</div>

---

## What is this?

VS Code has no native WinForms designer — to draw a `Form` you normally have to open Visual Studio. This extension brings that designer surface into VS Code:

- Open a form's `Form1.cs` (with its generated `Form1.Designer.cs` sibling) and a **live preview of the rendered form** appears.
- **Click any control** to select it; a **property grid** and **toolbox** dock alongside the canvas.
- **Edit properties, drag/resize, align, set tab order, wire events** — changes go back into `.Designer.cs` as **byte-local** edits; the rest of the file is preserved exactly.

The rendering is real: a headless .NET host instantiates your controls — including custom and third-party ones — and paints them with their real `OnPaint`, so the preview matches runtime. Two engines are bundled — **.NET 10 LTS** for modern projects and **.NET Framework 4.8** for classic `net4x` / DevExpress ones — and each form is routed automatically.

📖 **[Feature list, settings and support matrix →](extension/README.md)** (the Marketplace page)
📚 **[Wiki](https://github.com/SkivHisink/winforms-designer-vscode/wiki)** — step-by-step guides and a full command/keybinding reference.

## 📸 Screenshots

**A DevExpress form, designed in VS Code.** The canvas is your live `.Designer.cs` replayed onto the real vendor controls; the property grid is the `XtraForm` itself, not a stand-in.

![A DevExpress XtraForm in the designer, with its property grid](pictures/demo-devexpress.png)

**Vendor smart tags** — the control's own designer verbs, read off the compiled type:

![The XtraTabControl Tasks smart-tag panel on the canvas](pictures/demo-devexpress-xtratab-menu.png)

**Zoom, snaplines and your own controls** — a custom gauge painted by its real `OnPaint` at 214%:

![A custom gauge control on the canvas at 214% zoom with snaplines](pictures/demo-zoomed.png)

**A real production form** — hundreds of controls, a third-party suite, and an honest disclosure when a construct falls outside what the designer can replay:

![A production line-of-business form open in the designer](pictures/real-window.png)

## 🏗️ Architecture

```
  Form1.cs  ─────────────┐
  Form1.Designer.cs ─────┤
                         ▼
        ┌────────────────────────────────────────────────┐
        │  Engine host — routed per form:                │
        │  • .NET 10 LTS engine (C#)                     │
        │      Roslyn parse → safe interpret →           │  render • describe • edit
        │      WinForms host → DrawToBitmap              │
        │  • .NET Framework 4.8 engine (C#)              │
        │      interpret live source (VS model) onto     │  render • describe • edit
        │      compiled net4x / DevExpress controls      │
        └────────────────────────────────────────────────┘
                         ▲  JSON-RPC over a named pipe
                         │  (StreamJsonRpc, camelCase DTOs)
                         ▼
        ┌───────────────────────────────────┐
        │  VS Code extension (TypeScript)   │
        │  custom editor + dockable panel   │
        └───────────────────────────────────┘
                         ▲
                         │ postMessage
                         ▼
        ┌───────────────────────────────────┐
        │  Webview (canvas preview +        │
        │  property grid / toolbox / tree)  │
        └───────────────────────────────────┘
```

| Part | Folder | Tech |
|------|--------|------|
| Rendering / editing engine (.NET 10 LTS) | [`engine/`](engine/) | C# · `net10.0-windows` · WinForms · Roslyn · StreamJsonRpc |
| .NET Framework engine | [`engine-net48/`](engine-net48/) | C# · `net48` · WinForms · live-source IR interpretation onto compiled controls |
| VS Code extension | [`extension/`](extension/) | TypeScript · esbuild · VS Code Custom Editor API |
| Webview UI | [`extension/media/`](extension/media/) | Plain JS (canvas + DOM) |
| Sample forms / fixtures | [`engine/samples/`](engine/samples/), [`samples/`](samples/) | `.Designer.cs` forms |

**The .NET Framework engine follows the Visual Studio model:** parse `InitializeComponent` (never execute it), instantiate the form's base type, and replay the parsed statements onto the *compiled* control instances — so real net4x / DevExpress controls paint. The property panel and live edits re-derive from that same interpreted picture. A construct the interpreter can't reproduce falls back to a render of your last build with a named reason, never a silent mismatch.

## 📦 Requirements

- **Windows x64** — WinForms is Windows-only. Linux, macOS and WSL are not supported.
- **[.NET 10 Desktop Runtime](https://dotnet.microsoft.com/download/dotnet/10.0)** matching the VSIX architecture. Building from source needs the .NET 10 SDK pinned by `global.json`.
- **.NET Framework 4.8** — for `net4x` / DevExpress projects. Building `engine-net48/` from source needs its targeting pack.

**Windows ARM64:** a `win32-arm64` package is published and genuinely contains an ARM64 engine, but it has never been run on ARM64 hardware — CI and releases build on x64 runners. Treat it as unverified; only `win32-x64` is covered by 2.0.0's tested claims. See [ARM64 notes](docs/arm64-support.md).

## 🚀 Installing

Install from the **VS Code Marketplace** — search for **“WinForms Designer”**, or open the [Marketplace listing](https://marketplace.visualstudio.com/items?itemName=SkivHisink.winforms-designer-vscode).

### Build & run from source

```bash
# 1. Build the .NET engine
dotnet build engine -c Release

# 2. Build the extension
cd extension
npm ci
npm run build
```

Then open the `extension/` folder in VS Code and press **F5**. An *Extension Development Host* opens on the `engine/samples` folder with all other extensions disabled. Open **`SampleForm.cs`** to see the designer.

See **[CONTRIBUTING.md](CONTRIBUTING.md)** for the full dev loop, tests, and architecture notes.

## 🧭 Usage

1. Open a form's **`Form1.cs`** (it must have a sibling generated **`Form1.Designer.cs`**). You can also right-click a `.cs` file → **Reopen Editor With… → WinForms Designer**.
2. **Click a control** to select it. Edit it in **Properties**, or drag/resize on the canvas.
3. Drop new controls from the **Toolbox**. Press **F4** to focus Properties; **View Code** switches back to text.
4. **Save** (`Ctrl+S`) writes minimal edits back into `.Designer.cs`.

## 🔒 Security & workspace trust

Rendering a designer **loads and runs your project's control assemblies** — constructors and `OnPaint` execute during preview. The extension is **disabled in untrusted workspaces**, and the engine interprets `.Designer.cs` through strict allowlists rather than executing arbitrary code from the file. Only open projects you trust.

## Support matrix

Both engines support render, select, property grid, collection editors, direct manipulation, on-canvas menu/toolbar editing, `.resx` images, localized forms, tab pages, component tray, outline, events, inherited forms and byte-local save. The **full matrix, per-capability caveats and every setting** live on the [Marketplace page](extension/README.md).

### Fail-closed by design

The designer refuses rather than guesses:

- A **capability preflight** classifies every form (`safe` / `localizable` / `binaryResx` / `unresolvedType` / `lostStatements` / `unrepresentable`). A form it can't regenerate losslessly stays editable through targeted splices, but whole-file regeneration is refused **with the category named**.
- Every save route has multi-file preflight, one undo/redo boundary, conflict-safe compensation, and preservation of unknown comments and opaque binary resources.
- **x86, COM and ActiveX** are outside the 2.0.0 claim and refuse before touching files. So do arbitrary vendor-specific property editors and hosted designers beyond the supported framework routes.
- Visual Studio reference traces, licensed-vendor certification, physical ARM64/DPI and assistive-tech acceptance are recorded as **external or not executed**, never inferred from tests. See the [2.0.0 gate record](docs/release-2.0.0-gate-record.md).

### `net4x` build coordination

The net48 preview renders a real compiled instance of your form, so it loads your assemblies in place (shadow-copying would break delay-signed vendor controls). A build started **outside** VS Code is detected as it compiles and the output is handed back before the build needs it, so it doesn't fail with `MSB3027`. **WinForms: Release .NET Framework Assembly (for Rebuild)** remains as a manual control. The modern engine loads from an in-memory copy and never pins your build output.

## 🗺️ Roadmap & quality

See the **[release roadmap](ROADMAP.md)** for the shipped milestones and what 2.0.0 does and does not claim.

The safety core has C# and TypeScript unit coverage; the webview UI is validated headless; startup and render latency are guarded by a repeatable performance baseline; and activation, engine startup, capabilities and lifecycle diagnostics are smoke-tested in the real VS Code Extension Host on **VS Code 1.84 and current Stable**.

Found a rough edge? Please [file an issue](https://github.com/SkivHisink/winforms-designer-vscode/issues) — the **WinForms: Export Designer Diagnostics** command produces a ready-to-paste report.

## 🤝 Contributing

Contributions are very welcome! Start with **[CONTRIBUTING.md](CONTRIBUTING.md)** — it covers the repo layout, build/test commands, the F5 dev loop, and the **security gates that must not be weakened**. Please also read the **[Code of Conduct](CODE_OF_CONDUCT.md)**.

## 📄 License

[MIT](LICENSE) © 2026 SkivHisink

Third-party material shipped in the extension — the VS Code codicon font, `vscode-jsonrpc`, and the engine's .NET dependencies — is credited in **[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)**.
