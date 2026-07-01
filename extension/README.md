# WinForms Designer for VS Code

**A Visual Studio–style WinForms form designer, running natively inside VS Code.**

Open a form's `Form1.cs` and get a **live, interactive preview** of the rendered form — click controls, edit properties, drag and resize, wire events, and save minimal changes back into `.Designer.cs`. No round-trip through Visual Studio.

> ⚠️ **Preview.** This extension is under active development. It requires **Windows** and the **.NET 9 SDK**. See [Status & limitations](#status--limitations).

![The WinForms designer surface running inside VS Code](https://raw.githubusercontent.com/SkivHisink/winforms-designer-vscode/master/docs/images/canvas.png)

| Property grid | Toolbox |
| :---: | :---: |
| ![Visual Studio-style property grid](https://raw.githubusercontent.com/SkivHisink/winforms-designer-vscode/master/docs/images/properties.png) | ![Toolbox grouped into VS categories](https://raw.githubusercontent.com/SkivHisink/winforms-designer-vscode/master/docs/images/toolbox.png) |

## Features

- **Live form rendering** from `.Designer.cs` — your controls (including custom/3rd-party ones) are really instantiated and painted, so the preview matches runtime.
- **VS Code–native workflow** — opening `Form.cs` opens the designer; **View Code** switches back to text.
- **Property grid** — primitives, enums, complex types (`Point`, `Size`, `Color`, `Font`, `Padding`, `Rectangle`), composite expansion, and standard-value dropdowns, plus VS-style **Color**, **Font** (expandable), **flags-enum**, **Anchor/Dock**, and **image** editors.
- **Images & `.resx`** — render images from a form's sibling `.resx`, and import / clear `Image` / `BackgroundImage` / `Icon` back into both files.
- **Layout panels** — edit `TableLayoutPanel` cells & column/row styles, `SplitContainer` splitter distance, and `FlowLayoutPanel` order.
- **Toolbox** — ~39 `System.Windows.Forms` controls (with native icons) plus controls from your own project; **Choose Toolbox Items** and a **control-source** picker for custom / 3rd-party assemblies.
- **Direct manipulation** — select, move, resize (8 handles), multi-select + rubber-band, group move/delete, reparent, z-order, copy/paste, align / distribute / make-same-size, tab-order editor, snaplines, and a right-click menu.
- **Events** — wire / unwire / rewire handlers, generate a stub, navigate to the handler body.
- **Component tray** and **document outline** for non-visual components and the control hierarchy.
- **Safe save** — targeted, byte-minimal text edits; everything outside the change is preserved exactly.

## Requirements

- **Windows** (WinForms is Windows-only).
- **[.NET 9 SDK](https://dotnet.microsoft.com/download)**.
- A **trusted workspace** (see below).

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

## Security & Workspace Trust

Rendering a designer **loads and runs your project's control assemblies** (constructors and `OnPaint` execute on preview), so the extension is **disabled in untrusted workspaces**. The engine interprets `.Designer.cs` through strict allowlists rather than executing arbitrary code from the file. Only open projects you trust.

## Status & limitations

This is a **preview**. The core render → select → edit → save loop, property grid (with Color / Font / flags / image editors), toolbox, layout-panel editing, `.resx` image support, and safe save all work; `UITypeEditor` / collection-editor modals, `.NET Framework` hosting, and advanced `.resx` are still in progress. Please report issues — the **WinForms: Export Designer Diagnostics** command generates a ready-to-paste bug report.

## Links

- **Source, issues & contributing:** https://github.com/SkivHisink/winforms-designer-vscode
- **License:** [MIT](https://github.com/SkivHisink/winforms-designer-vscode/blob/master/LICENSE)
