# Changelog

All notable changes to **WinForms Designer for VS Code** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
This is a **preview** — expect rough edges and breaking changes between minor versions.

## [Unreleased]

## [0.2.0] — 2026-07-01

Second preview — a large round of Visual Studio-parity work in the property grid,
image / `.resx` support, layout-panel editing and control-source selection, on top of
the 0.1.0 foundation.

### Added

#### Property grid
- **VS-style Color editor** — the Color properties (BackColor/ForeColor/…) now show a
  colour swatch plus a dropdown to a tabbed palette (**Custom / Web / System**) with
  theme-accurate swatches, alongside the existing free-text field.
- **VS-style Font editor** — Font properties are now **expandable** into sub-rows
  (Name / Size / Unit / Bold / Italic / Underline / Strikeout); the Name row suggests
  installed font families and the Unit row uses the framework's own unit list.
- **Flags-enum dropdown** — `[Flags]` enum properties (other than Anchor, which keeps
  its glyph editor) now get a checkbox dropdown to toggle individual members.
- **Anchor / Dock editors** — a visual **Anchor** editor (a frame with four toggle
  bars) and a **Dock** zone picker, replacing free-text editing of these properties.
- **Image properties** — Image / BackgroundImage / Icon properties show a thumbnail
  preview with **Import…** and **(none)** actions.

#### Images & `.resx`
- **`.resx` image pipeline** — images stored in a form's sibling `.resx` (the
  `resources.GetObject(...)` pattern the VS designer emits) are now **rendered** in the
  preview, and you can **Import** a new image or **clear** it; the change is written
  back into both the `.Designer.cs` and the `.resx`, with safety limits on file and
  pixel size.

#### Layout panels
- **TableLayoutPanel editing** — a control's cell (**Column / Row**) and the
  **Column/Row styles** (size type + value) are surfaced in the grid and editable; the
  designer now honours 3-argument `Controls.Add(child, col, row)`.
- **SplitContainer** — `SplitterDistance` is editable and reflected in the layout.
- **FlowLayoutPanel** — reorder controls (flow follows z-order).
- **Canvas anchor tethers** — the selected control shows dashed tether lines to its
  anchored edges, plus a badge when it is docked.

#### Direct manipulation
- **Reparent** — move a control into another container from the Outline or canvas.
- **Reset property** — reset a property to its default; setting Dock/Anchor now clears
  its conjugate automatically (matching VS).
- **VS-style right-click menu** on the canvas (View Code, Bring to Front / Send to
  Back, Cut / Copy / Paste / Delete, *Select `<parent>`* chain, Properties, …) with the
  form root protected from cut / delete / z-order.
- **Equal-spacing snaplines**, and **Distribute** / **Make Same Size** on the align
  toolbar.

#### Toolbox & control sources
- **Toolbox control icons** — controls now show their native `[ToolboxBitmap]` icons
  (the same ones Visual Studio uses).
- **Control Source picker** — a command and a status-bar item to choose which
  **project (`.csproj`) or assembly (`.dll`)** provides custom / third-party controls;
  the designer prompts when a form references types it cannot resolve.
- **Auto-add project reference** — dropping a control from an assembly the form's
  project does not yet reference offers to add the `<Reference>` for you.
- **Choose Toolbox Items** improvements — the dialog shows its target tab, respects
  `[DesignTimeVisible(false)]`, and pre-checks and adds browsed items.

#### Accessibility
- **Outline mirror-tree** is exposed as an ARIA tree (roles, levels, keyboard
  navigation).

### Changed
- **Discoverability** — expanded the Marketplace tags/keywords: `winforms`,
  `windows forms`, `c#`, `csharp`, `designer`, `form designer`, `ui designer`,
  `visual designer`, `gui`, `forms`, `.net`, `dotnet`, `net9`, `wysiwyg`,
  `drag and drop`.
- **Accurate compatibility** — declared `extensionKind: ["workspace"]`. The
  extension hosts a .NET process and reads the project on the machine where the
  code lives, so it is **not** a universal/web extension; the listing now reflects
  that instead of showing *Works with Universal*.
- The **CHANGELOG is now bundled** into the package, so the Marketplace shows a
  proper **Changelog** tab.

## [0.1.0] — 2026-06-30

First public preview — a Visual Studio-style WinForms designer running natively in
VS Code, backed by a headless .NET 9 rendering/editing engine.

### Designer surface
- **Live form rendering** of `.Designer.cs` — controls (including custom and
  third-party ones) are really instantiated and painted via their own `OnPaint`,
  so the preview matches runtime. Full-frame render plus fast per-control
  dirty-region patches.
- **Visual Studio-style custom editor** — opening a form's `.cs` (with a sibling
  generated `.Designer.cs`) opens the designer; **View Code** switches back to text.
- **Unsaved-buffer preview** with a dirty indicator and a toolbar **Save** button;
  live update on save and on external file changes.
- **Zoom** (toolbar, `Ctrl`+wheel, `Ctrl` `±`/`0`) and in-panel **Properties /
  Outline / Toolbox** tabs (focus with **F4**).

### Property grid
- Primitives and enums, plus complex types — `Point`, `Size`, `Color`, `Font`,
  `Padding`, `Rectangle` — converted to idiomatic C# via `InstanceDescriptor`.
- **Composite expansion** (`Size` → `Width`/`Height`, etc.), **standard-value
  dropdowns**, search, and **Properties / Events** views with sort by category or
  name.

### Toolbox
- Auto-populated from `System.Windows.Forms` (≈39 controls across Visual Studio
  categories) **plus controls discovered in your project assembly** (collectible
  load context).
- **Choose Toolbox Items** dialog and toolbox search.

### Direct manipulation & editing
- Click-to-select, move, 8-handle resize, and form resize.
- **Multi-select** (`Ctrl`/`Shift`-click and rubber-band) with group move/delete.
- **Add / remove controls**, **copy/paste controls** (clone with rename + offset,
  injection-guarded, parents into containers), and **z-order** (bring to front /
  send to back).
- **Align toolbar**, **tab-order editor**, and **snaplines**.

### Events
- Describe events; **wire / unwire / rewire** handlers via an editable combobox;
  **generate a handler stub** with the correct signature; **double-click to
  navigate** to the handler body in the code-behind.

### Save & code sync
- **Byte-minimal targeted edits** written back into `.Designer.cs`; a save-splice
  path guarded by representability and statement-diff gates; original encoding/BOM
  preserved.
- **Component tray** for non-visual components and a **Document outline** of the
  control hierarchy.

### Project & runtime
- **MSBuild design-time assembly resolution** (multi-target aware, with a
  candidate cache) and an explicit `winformsDesigner.assemblyPath` setting.
- Requires **Windows** and the **.NET 9 SDK**.

### Safety
- **Workspace Trust** gating (the engine loads and runs project control
  assemblies on preview).
- Interpreter **allowlists** (construction / static-invocation / static-read) and
  **identifier validation** to keep rendering a crafted `.Designer.cs` safe.

[Unreleased]: https://github.com/SkivHisink/winforms-designer-vscode/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/SkivHisink/winforms-designer-vscode/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/SkivHisink/winforms-designer-vscode/releases/tag/v0.1.0
