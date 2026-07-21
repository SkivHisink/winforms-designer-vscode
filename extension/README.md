# WinForms Designer for VS Code

**A Visual Studio–style WinForms form designer, running natively inside VS Code.**

Open a form's `Form1.cs` and get a **live, interactive preview** of the rendered form — click controls, edit properties, drag and resize, wire events, and save minimal changes back into `.Designer.cs`. No round-trip through Visual Studio.

> ✅ **1.0.** Requires **Windows x64** and the **.NET 10 Desktop Runtime (x64)**. Linux, macOS, WSL and Linux remote workspaces are not supported. The **.NET Framework 4.8 engine** (for `net4x` / DevExpress) renders your **live source** through an IR interpreter, with a disclosed compiled fallback for constructs it can't yet reproduce — see [Support matrix & limitations](#support-matrix--limitations).

![The WinForms designer surface running inside VS Code](https://raw.githubusercontent.com/SkivHisink/winforms-designer-vscode/master/docs/images/canvas.png)

| Property grid | Toolbox |
| :---: | :---: |
| ![Visual Studio-style property grid](https://raw.githubusercontent.com/SkivHisink/winforms-designer-vscode/master/docs/images/properties.png) | ![Toolbox grouped into VS categories](https://raw.githubusercontent.com/SkivHisink/winforms-designer-vscode/master/docs/images/toolbox.png) |

## Features

- **Live form rendering** from `.Designer.cs` — your controls (including custom/3rd-party ones) are really instantiated and painted, so the preview matches runtime. The canvas renders at your display's device pixel ratio, so it stays **crisp on 4K / high-DPI** screens.
- **.NET Framework & DevExpress support** — forms whose controls target **.NET Framework** (`net4x`) render on a dedicated bundled **.NET Framework 4.8** engine that interprets your **live source** (the Visual Studio model) onto the compiled controls, so classic component suites (e.g. **DevExpress**) look pixel-accurate. Each form is auto-routed to the right engine; the property grid, drag/resize/align, add/remove, z-order, **cut/paste**, **tab-page add/rename/delete**, dropping the project's own vendor controls from the toolbox, and the **collection editors** apply live on the interpreted picture. A construct the interpreter can't yet reproduce falls back to a disclosed compiled render of the last build.
- **VS Code–native workflow** — opening `Form.cs` opens the designer; **View Code** switches back to text.
- **Property grid** — primitives, enums, complex types (`Point`, `Size`, `Color`, `Font`, `Padding`, `Rectangle`, `Cursor`), composite expansion, and standard-value dropdowns, plus VS-style **Color**, **Font** (expandable), **flags-enum**, **Anchor/Dock**, **Cursor**, and **image** editors. **Component-reference** properties (`AcceptButton`, `ContextMenuStrip`, `ContainerControl`, …) become a **dropdown** of compatible components (plus `(this)` for the form), and an `ImageList`-backed **`ImageIndex` / `ImageKey`** picks from a dropdown of indices / keys. Non-default values are **bold**, a **description pane** explains the selected property, and right-click **Reset** restores the default.
- **Collection editors** — the `…` button opens a VS-style **Collection Editor** for string collections (`ComboBox` / `ListBox` / `CheckedListBox.Items`), string-array properties (`TextBox.Lines`), `ListView.Columns`, `DataGridView.Columns`, and a recursive `TreeView.Nodes` tree editor (with per-node **images, check state, tooltip, colors & font**) — on both engines. A panel **"Type Here"** editor also **reorders / adds / removes / renames** `MenuStrip` / `ToolStrip` items.
- **On-canvas menu & toolbar editing** — edit `MenuStrip` / `ToolStrip` items **directly on the strip**: a **"Type Here"** slot to **add** (with a type picker), **double-click / F2** to **rename**, click to **select** and **Delete** — including **nested submenus**, an **off-tree `ContextMenuStrip`** (from its tray chip), and the **overflow** area. Selecting an item opens **its own property grid** with an **Events** tab. On both engines.
- **Images & `.resx`** — render images from a form's sibling `.resx`, and import / clear `Image` / `BackgroundImage` / `Icon` back into both files.
- **Layout panels** — edit `TableLayoutPanel` cells & column/row styles, `SplitContainer` splitter distance, and `FlowLayoutPanel` order.
- **Toolbox** — ~39 `System.Windows.Forms` controls (with native icons) plus controls from your own project; **Choose Toolbox Items** and a **control-source** picker for custom / 3rd-party assemblies.
- **Direct manipulation** — select, move, resize (8 handles), keyboard nudge (arrow keys), multi-select + rubber-band, group move/delete, reparent, z-order, copy/paste, **duplicate** (`Ctrl+D`), **lock controls**, align / distribute / make-same-size, tab-order editor, snaplines, on-canvas **smart-tags**, and a right-click menu.
- **Events** — wire / unwire / rewire handlers, generate a stub, navigate to the handler body.
- **Component tray** and **document outline** for non-visual components and the control hierarchy.
- **Localized UI (7 languages)** — the designer surface, dialogs and messages can be shown in English, Русский, 简体中文, Français, Deutsch, Español or हिन्दी via the `winformsDesigner.language` setting.
- **Safe save** — targeted, byte-minimal text edits; everything outside the change is preserved exactly.

## Requirements

- **Windows** (WinForms is Windows-only).
- **[.NET 10 Desktop Runtime, x64](https://dotnet.microsoft.com/download/dotnet/10.0)**. The SDK is only required when building the extension from source.
- **.NET Framework projects** (`net4x`, e.g. DevExpress) render through a **bundled .NET Framework 4.8 engine** — its runtime ships with Windows, so no extra install is needed.
- A **trusted workspace** (see below).

Windows ARM64 is a viable post-1.0 target through a separate `win32-arm64` VSIX and a `win-arm64` modern engine,
but it is not shipped yet: it needs native ARM64 Extension Host/E2E coverage plus an explicit policy for the
x64-only .NET Framework/vendor engine. There is intentionally no Linux/macOS/WSL fallback package.

## Getting started

1. Open a form's **`Form1.cs`** (with its generated **`Form1.Designer.cs`** sibling). The designer opens automatically.
2. **Click a control** to select it, then edit it in the **Properties** panel or drag/resize it directly.
3. Add controls from the **Toolbox**; press **F4** to focus Properties.
4. **Save** to write minimal changes back into `.Designer.cs`.

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `winformsDesigner.autoOpenDesigner` | `true` | Open the designer automatically when a form's `.cs` becomes active. |
| `winformsDesigner.assemblyPath` | `""` | Explicit path to the built control assembly. Leave empty for auto-discovery. |
| `winformsDesigner.net48.probeDirectories` | `[]` | Extra directories the **net48** engine searches for control assemblies it can't otherwise find (e.g. a 3rd-party control SDK installed outside the project's output and not in the GAC). Applies after a **Reload Window**. |
| `winformsDesigner.language` | `en` | UI language of the designer, dialogs and messages (English, Русский, 简体中文, Français, Deutsch, Español, हिन्दी). |

### Language

The designer surface, property grid, toolbox, dialogs and status/notification messages are localized and follow the `winformsDesigner.language` setting — chosen **here**, not from the VS Code display language. Changing it takes full effect after a **Reload Window** (you'll be prompted). Note: the VS Code **command palette** titles and the settings page itself follow VS Code's own *Display Language* (a platform limitation), so those pieces of "chrome" may stay in a different language than the designer UI.

## Security & Workspace Trust

Rendering a designer **loads and runs your project's control assemblies** (constructors and `OnPaint` execute on preview), so the extension is **disabled in untrusted workspaces**. The engine interprets `.Designer.cs` through strict allowlists rather than executing arbitrary code from the file. Only open projects you trust.

## Support matrix & limitations

**1.0 guarantees safe persistence.** Supported edits are written as **byte-local, conflict-checked** source splices; anything the designer can't persist safely is **refused with a stated reason**, never guessed. The **modern engine** renders your current source buffer. The **.NET Framework engine** interprets your **live source** (the VS model), and its property panel + live edits re-derive from that interpreted picture; a construct it can't yet reproduce falls back to a compiled render of your **last build** with a **disclosed, named reason** — never a silent mismatch — and your source edits stay byte-local either way.

| Capability | Modern projects (`net8.0-windows` / `net9.0-windows` / `net10.0-windows`) | .NET Framework 4.8 (`net4x` / DevExpress, x64) |
| --- | :---: | :---: |
| Render · select · property grid · collection & "Type Here" editors | ✅ | ✅ |
| Move / resize / align / z-order / copy-paste / duplicate / lock | ✅ | ✅ live-rebuilt |
| On-canvas menu / toolbar editing · `.resx` images · ImageList | ✅ | ✅ |
| Component tray · document outline · events · Modifiers | ✅ | ✅ |
| Safe byte-surgical save | ✅ | ✅ (via modern Roslyn splice) |
| **Overall** | **Stable** | **Live-source preview** (IR interpreter, VS model) + disclosed compiled fallback |

A **capability preflight** classifies every form (`safe` / `localizable` / `binaryResx` / `unresolvedType` / `lostStatements` / `unrepresentable`), so a form it can't whole-file regenerate — binary `.resx`, an unresolved base type, or an unrepresentable statement — is **refused that regenerate, with the reason named**, rather than saved unsafely; individual property and geometry edits still apply as targeted byte-surgical splices, which preserve everything outside the edited span. (`Localizable = true` is the one case that is read-only outright: its layout lives in per-culture `.resx`, so any edit here would diverge from it.) The engines have bounded automatic crash recovery, and **WinForms: Export Designer Diagnostics** reports capabilities, ping time, memory, PID, and lifecycle/crash state. **Known limitation:** the `net4x` preview runs your compiled form, so it holds that project's build output open — close the designer, or run **WinForms: Release .NET Framework Assembly (for Rebuild)**, before rebuilding it. **Not yet:** `DesignerActionList` / vendor smart-tag action lists, advanced `.resx` (non-image resources, the full `ApplyResources` localization workflow), generic `IList<T>` editors, and RTL — all read-only-safe today. Please report issues with the generated diagnostics.

## Links

- **Source, issues & contributing:** https://github.com/SkivHisink/winforms-designer-vscode
- **License:** [MIT](https://github.com/SkivHisink/winforms-designer-vscode/blob/master/LICENSE)
