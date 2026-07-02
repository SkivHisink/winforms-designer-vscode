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
- **.NET Framework & DevExpress support (experimental)** — forms whose controls target **.NET Framework** (`net4x`) render on a dedicated bundled **.NET Framework 4.8** engine that instantiates the compiled controls, so classic component suites (e.g. **DevExpress**) look pixel-accurate. Each form is auto-routed to the right engine; the property grid, drag/resize/align, add/remove, z-order, **cut/paste**, **tab-page add/rename/delete**, and dropping the project's own vendor controls from the toolbox all apply live.
- **VS Code–native workflow** — opening `Form.cs` opens the designer; **View Code** switches back to text.
- **Property grid** — primitives, enums, complex types (`Point`, `Size`, `Color`, `Font`, `Padding`, `Rectangle`), composite expansion, and standard-value dropdowns, plus VS-style **Color**, **Font** (expandable), **flags-enum**, **Anchor/Dock**, and **image** editors.
- **Images & `.resx`** — render images from a form's sibling `.resx`, and import / clear `Image` / `BackgroundImage` / `Icon` back into both files.
- **Layout panels** — edit `TableLayoutPanel` cells & column/row styles, `SplitContainer` splitter distance, and `FlowLayoutPanel` order.
- **Toolbox** — ~39 `System.Windows.Forms` controls (with native icons) plus controls from your own project; **Choose Toolbox Items** and a **control-source** picker for custom / 3rd-party assemblies.
- **Direct manipulation** — select, move, resize (8 handles), multi-select + rubber-band, group move/delete, reparent, z-order, copy/paste, align / distribute / make-same-size, tab-order editor, snaplines, on-canvas **smart-tags**, and a right-click menu.
- **Events** — wire / unwire / rewire handlers, generate a stub, navigate to the handler body.
- **Component tray** and **document outline** for non-visual components and the control hierarchy.
- **Localized UI (6 languages)** — the designer surface, dialogs and messages can be shown in English, Русский, 简体中文, Français, Deutsch or Español via the `winformsDesigner.language` setting.
- **Safe save** — targeted, byte-minimal text edits; everything outside the change is preserved exactly.

## Requirements

- **Windows** (WinForms is Windows-only).
- **[.NET 9 SDK](https://dotnet.microsoft.com/download)**.
- **.NET Framework projects** (`net4x`, e.g. DevExpress) render through a **bundled .NET Framework 4.8 engine** — its runtime ships with Windows, so no extra install is needed.
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
| `winformsDesigner.language` | `en` | UI language of the designer, dialogs and messages (English, Русский, 简体中文, Français, Deutsch, Español). |

### Language

The designer surface, property grid, toolbox, dialogs and status/notification messages are localized and follow the `winformsDesigner.language` setting — chosen **here**, not from the VS Code display language. Changing it takes full effect after a **Reload Window** (you'll be prompted). Note: the VS Code **command palette** titles and the settings page itself follow VS Code's own *Display Language* (a platform limitation), so those pieces of "chrome" may stay in a different language than the designer UI.

## Security & Workspace Trust

Rendering a designer **loads and runs your project's control assemblies** (constructors and `OnPaint` execute on preview), so the extension is **disabled in untrusted workspaces**. The engine interprets `.Designer.cs` through strict allowlists rather than executing arbitrary code from the file. Only open projects you trust.

## Status & limitations

This is a **preview**. The core render → select → edit → save loop, property grid (with Color / Font / flags / image editors), toolbox, layout-panel editing, `.resx` image support, 6-language UI localization, and safe save all work. **.NET Framework (net48) hosting** is an experimental compiled preview for `net4x` / DevExpress forms — render plus live property / drag / add / remove / z-order / **cut / paste** edits, **tab-page add / rename / delete**, and dropping the project's own vendor controls from the toolbox. `UITypeEditor` / collection-editor modals and advanced `.resx` are still in progress. Please report issues — the **WinForms: Export Designer Diagnostics** command generates a ready-to-paste bug report.

## Links

- **Source, issues & contributing:** https://github.com/SkivHisink/winforms-designer-vscode
- **License:** [MIT](https://github.com/SkivHisink/winforms-designer-vscode/blob/master/LICENSE)
