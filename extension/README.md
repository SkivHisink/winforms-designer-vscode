# WinForms Designer for VS Code

**A Visual Studio–style WinForms form designer, running natively inside VS Code.**

Open a form's `Form1.cs` and get a **live, interactive preview** of the rendered form — click controls, edit properties, drag and resize, wire events, and save minimal changes back into `.Designer.cs`. No round-trip through Visual Studio.

> ✅ **1.9.0.** Requires **Windows x64 or Windows ARM64** and the matching **.NET 10 Desktop Runtime**. Linux, macOS, WSL and Linux remote workspaces are not supported. The daily loop now includes Explorer **Add → Windows Form / User Control / Component / Class**, `(Name)`/F2 rename, double-click default-event creation, F7/Shift+F7 code navigation, scoped keyboard selection, and live position/size feedback. The **.NET Framework 4.8 engine** (for `net4x` / DevExpress) is native on x64 and a reduced-feature x64 compatibility fallback on Windows ARM64; it renders your **live source** through an IR interpreter — the Visual Studio model, which never constructs the form you are editing — with a disclosed compiled fallback for constructs it can't yet reproduce. An open designer never holds your build output and never puts a window on your screen - see [Support matrix & limitations](#support-matrix--limitations).

![WinForms Designer for VS Code](https://raw.githubusercontent.com/SkivHisink/winforms-designer-vscode/master/pictures/main-picture.png)

## Drag & drop, live

Drop a control from the toolbox onto a **DevExpress** form and it lands where you put it — snaplines, selection
handles and all — while the change goes back into `.Designer.cs` as a minimal edit.

![Dragging a ComboBox from the toolbox onto a DevExpress form](https://raw.githubusercontent.com/SkivHisink/winforms-designer-vscode/master/pictures/demo-drag-drop.gif)

## Screenshots

**A DevExpress form, designed in VS Code.** The canvas is your live `.Designer.cs` replayed onto the real vendor
controls; the property grid is the `XtraForm` itself, not a stand-in.

![A DevExpress XtraForm in the designer, with its property grid](https://raw.githubusercontent.com/SkivHisink/winforms-designer-vscode/master/pictures/demo-devexpress.png)

**Vendor smart tags** — the control's own designer verbs, read off the compiled type:

![The XtraTabControl Tasks smart-tag panel on the canvas](https://raw.githubusercontent.com/SkivHisink/winforms-designer-vscode/master/pictures/demo-devexpress-xtratab-menu.png)

**Choose Toolbox Items** — framework, project and browsed assemblies, with sortable columns:

![Choose Toolbox Items dialog](https://raw.githubusercontent.com/SkivHisink/winforms-designer-vscode/master/pictures/demo-choose-toolbox-items.png)

**Zoom, snaplines and your own controls** — a custom gauge painted by its real `OnPaint` at 214%:

![A custom gauge control on the canvas at 214% zoom with snaplines](https://raw.githubusercontent.com/SkivHisink/winforms-designer-vscode/master/pictures/demo-zoomed.png)

**A real production form** — hundreds of controls, a third-party suite, and an honest disclosure when a construct
falls outside what the designer can replay:

![A production line-of-business form open in the designer](https://raw.githubusercontent.com/SkivHisink/winforms-designer-vscode/master/pictures/real-window.png)

## Features

- **Live form rendering** from `.Designer.cs` — your controls (including custom/3rd-party ones) are really instantiated and painted, so the preview matches runtime. A DPI-aware backing capture stays **crisp on 4K / high-DPI** screens while layout and hit-testing remain in logical WinForms pixels.
- **.NET Framework & DevExpress support** — forms whose controls target **.NET Framework** (`net4x`) render on a dedicated bundled **.NET Framework 4.8** engine that interprets your **live source** (the Visual Studio model) onto the compiled controls, so classic component suites (e.g. **DevExpress**) look pixel-accurate. Each form is auto-routed to the right engine; the property grid, drag/resize/align, add/remove, z-order, **cut/paste**, **tab-page add/rename/delete/reorder**, dropping the project's own vendor controls from the toolbox, and the **collection editors** apply live on the interpreted picture. A construct the interpreter can't yet reproduce falls back to a disclosed compiled render of the last build.
- **VS Code–native workflow** — opening `Form.cs` opens the designer; **View Code** switches back to text.
- **Explorer project items** — right-click a project file/folder and use **Add → Windows Form, User Control,
  Component, or Class** ([#4](https://github.com/SkivHisink/winforms-designer-vscode/issues/4)). Form/User Control
  creation is a single undoable `.cs` / `.Designer.cs` / `.resx` transaction and opens the new root in the designer;
  supported SDK/classic project inclusion is automatic, and unsafe/ambiguous project shapes or collisions write
  nothing.
- **Property grid** — primitives, enums, safe complex values, and bounded metadata-driven `TypeConverter` expansion, plus VS-style **Color**, **Font**, **flags-enum**, **Anchor/Dock**, **Cursor**, and **image** editors. Supported framework Color/Font `UITypeEditor` dialogs run in a cancellable isolated process; arbitrary vendor editors remain disabled. **Component-reference** properties become compatible-component dropdowns, non-default values are **bold**, and right-click **Reset** restores the default.
- **Data-bound forms** — edit canonical `DataBindings` entries (target property, component source, data member, formatting, update mode, and format string), choose a supported `DataSource` as `(none)`, a compatible component, or `typeof(T)`, and maintain bound `DataGridView` columns including `DataPropertyName`, format, alignment, and literal null-display values. Editing is source-first and exact on both engines; the preview does not evaluate bindings (neither does Visual Studio's), so a `DataBindings.Add(…)` statement is disclosed as a skipped construct — and on the .NET Framework engine a bound form previews from your last build.
- **Collection editors** — the `…` button opens a VS-style **Collection Editor** for string collections, string arrays, allowlisted scalar/enum/complex `IList` / `IList<T>` values, `ListView.Columns`, `DataGridView.Columns`, and recursive `TreeView.Nodes`. Unsupported item types and non-canonical expressions stay read-only. A panel **"Type Here"** editor also **reorders / adds / removes / renames** `MenuStrip` / `ToolStrip` items.
- **On-canvas menu & toolbar editing** — edit `MenuStrip` / `ToolStrip` items **directly on the strip**: a **"Type Here"** slot to **add** (with a type picker), **double-click / F2** to **rename**, click to **select** and **Delete** — including **nested submenus**, an **off-tree `ContextMenuStrip`** (from its tray chip), and the **overflow** area. Selecting an item opens **its own property grid** with an **Events** tab. On both engines.
- **Images & `.resx`** — render images from a form's sibling `.resx`, and import / clear `Image` / `BackgroundImage` / `Icon` back into both files.
- **Localized forms** — edit `Localizable = true` / `ApplyResources` forms in the neutral or a selected culture `.resx`. Scalar/Color/Font/geometry edits, localized images/icons, `RightToLeft`, and `RightToLeftLayout` use lossless, conflict-checked resource transactions; Reset removes the override and restores ResourceManager fallback.
- **Tabbed forms** — standard WinForms tab headers support view-only navigation, double-click rename, Add/Delete, and one-position Move Left/Right on both engines. Reordering swaps only canonical adjacent `Controls/TabPages.Add[Range]` references and refuses ambiguous source. The active page is remembered per form on modern and net48 live-source canvases without changing generated source; a disclosed net48 compiled fallback remains build-derived and mirrors supported moves live.
- **Layout panels** — edit `TableLayoutPanel` cells & column/row styles, `SplitContainer` splitter distance, and `FlowLayoutPanel` order.
- **Toolbox** - ~39 `System.Windows.Forms` controls (with native icons) plus controls lazily discovered from the open form's owning project/reference outputs, including concrete custom output roots. Discovery is budgeted, cancellable, metadata-only, cached, and incrementally refreshed; **Choose Toolbox Items** hides/restores discovered controls and keeps chosen items/custom tabs in workspace state, migrating existing pre-1.8 curation once. A **control-source** picker still handles explicit custom / 3rd-party assemblies. COM/WPF toolbox pages are explicitly unsupported and inert.
- **Direct manipulation** - select, move, resize (8 handles), keyboard nudge (arrow keys), multi-select + rubber-band, group move/delete, reparent, z-order, copy/paste, **duplicate** (`Ctrl+D`), **lock controls**, align / distribute / make-same-size, tab-order editor, snaplines, on-canvas **smart-tags**, and a right-click menu. Hold **Alt** during one move/resize to suppress snapping and see exact live bounds; the configurable override never bypasses geometry authorization. Modern final free-control bounds are corrected by the real WinForms graph before source is accepted. Cross-form paste validates typed binding and extender dependencies before changing source.
- **Events** — wire / unwire / rewire handlers, generate a stub, navigate to the handler body, or double-click a
  control to create/open its real metadata-defined default event ([#5](https://github.com/SkivHisink/winforms-designer-vscode/issues/5)).
- **Component tray** and **document outline** for non-visual components and the control hierarchy. Editable outline nodes support safe drag/reparent and keyboard/context z-order changes; inherited or unresolved nodes remain visible and read-only. Tray components show framework icons, support inline field rename, retain compatible references, and expose common `ToolTip`, `ErrorProvider`, and `HelpProvider` extender properties.
- **Localized UI (7 languages)** — the designer surface, dialogs and messages can be shown in English, Русский, 简体中文, Français, Deutsch, Español or हिन्दी via the `winformsDesigner.language` setting.
- **Safe save** — targeted, byte-minimal text edits; everything outside the change is preserved exactly.

## Requirements

- **Windows x64 or Windows ARM64** (WinForms is Windows-only).
- **[.NET 10 Desktop Runtime](https://dotnet.microsoft.com/download/dotnet/10.0)** matching the VSIX architecture. The SDK is only required when building the extension from source.
- **.NET Framework projects** (`net4x`, e.g. DevExpress) render through a **bundled .NET Framework 4.8 engine** on x64. On Windows ARM64 this is a reduced-feature x64 compatibility fallback, not a native ARM64 engine; vendor controls and targeting packs must work under Windows x64 emulation.
- A **trusted workspace** (see below).

Since version 1.4.0, packaging produces separate `win32-x64` and `win32-arm64` VSIX artifacts. The ARM64 package bundles the modern engine with `dotnet publish -r win-arm64`; it does not make the .NET Framework 4.8/vendor-control path native ARM64. See [Windows ARM64 support](../docs/arm64-support.md).

## Getting started

1. Open an existing form's **`Form1.cs`**, or right-click a project folder and choose **Add → Windows Form**. The
   designer opens automatically.
2. **Click a control** to select it, then edit it in the **Properties** panel or drag/resize it directly.
3. Add controls from the **Toolbox**; press **F4** to focus Properties.
4. **Save** to write minimal changes back into `.Designer.cs`.

For a localized form, run **WinForms: Select Localization Culture**, choose **(Default)**, an existing culture, or create one such as `fr-FR`/`ar-SA`, then edit normally. Supported localization edits are written immediately to the selected `.resx` and participate in the designer's single undo/redo history without dirtying generated source.

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `winformsDesigner.autoOpenDesigner` | `true` | Open the designer automatically when a form's `.cs` becomes active. |
| `winformsDesigner.deleteFormSiblings` | `true` | Delete a form’s generated files together with the form: its `.Designer.cs` and its `.resx` / `.<culture>.resx`, in the **same operation** (one confirmation, one undo). Files that were not generated for that form — a `.resx` whose middle segment is not a culture, or a same-prefix neighbour like `Form10.resx` — are never touched. |
| `winformsDesigner.assemblyPath` | `""` | Explicit path to the built control assembly. Leave empty for auto-discovery. |
| `winformsDesigner.placementSnapOverrideModifier` | `alt` | Modifier held during one move/resize to suppress snaplines (`alt`, `control`, `shift`, or `disabled`). |
| `winformsDesigner.toolbox.autoDiscoverProjectControls` | `true` | Lazily discover toolbox controls from the owning project and its explicit project references. |
| `winformsDesigner.net48.probeDirectories` | `[]` | Extra directories the **net48** engine searches for control assemblies it can't otherwise find (e.g. a 3rd-party control SDK installed outside the project's output and not in the GAC). Applies after a **Reload Window**. |
| `winformsDesigner.net48.releaseOnFocusLoss` | `false` | Release the **net48** build output on every focus loss. Mostly superseded by `releaseOnExternalBuild` above, which hands the output back exactly when a build needs it; keep this for anything else outside VS Code that replaces files in the output directory (a checkout, an installer, a sync tool), because a write your open designer blocks raises no event for the build detector to see. Releasing unloads the preview, so the next edit waits for the assembly graph to load again. |
| `winformsDesigner.net48.isolateRenderWindows` | `true` | Run the **net48** preview engine on a private desktop that is never displayed, so a form being designed (its own `Load`/`Shown` code runs in a compiled preview) cannot put windows on your screen. Rendering is unaffected; takes effect when the preview engine restarts. |
| `winformsDesigner.net48.releaseOnExternalBuild` | `true` | Hand the **net48** build output back automatically when a build started **outside** VS Code (Visual Studio, an external `msbuild`) is about to overwrite it, so that build never fails with `MSB3027`. The previews are view-only until the build lands, then re-render from it. |
| `winformsDesigner.language` | `en` | UI language of the designer, dialogs and messages (English, Русский, 简体中文, Français, Deutsch, Español, हिन्दी). |

### Language

The designer surface, property grid, toolbox, dialogs and status/notification messages are localized and follow the `winformsDesigner.language` setting — chosen **here**, not from the VS Code display language. Changing it takes full effect after a **Reload Window** (you'll be prompted). Note: the VS Code **command palette** titles and the settings page itself follow VS Code's own *Display Language* (a platform limitation), so those pieces of "chrome" may stay in a different language than the designer UI.

## Security & Workspace Trust

Rendering a designer **loads and runs your project's control assemblies** (constructors and `OnPaint` execute on preview), so the extension is **disabled in untrusted workspaces**. The engine interprets `.Designer.cs` through strict allowlists rather than executing arbitrary code from the file. Only open projects you trust.

## Support matrix & limitations

**1.0 guarantees safe persistence.** Supported edits are written as **byte-local, conflict-checked** source splices; anything the designer can't persist safely is **refused with a stated reason**, never guessed. The **modern engine** renders your current source buffer. The **.NET Framework engine** interprets your **live source** (the VS model), and its property panel + live edits re-derive from that interpreted picture; a construct it can't yet reproduce falls back to a compiled render of your **last build** with a **disclosed, named reason** — never a silent mismatch — and your source edits stay byte-local either way.

| Capability | Modern projects (`net8.0-windows` / `net9.0-windows` / `net10.0-windows`) | .NET Framework 4.8 (`net4x` / DevExpress, x64 native; ARM64 x64-compat fallback) |
| --- | :---: | :---: |
| Render · select · property grid · collection & "Type Here" editors | ✅ | ✅ |
| DataBindings · DataSource · bound DataGridView styles · common extenders | ✅ edits; binding statements skipped in the preview | ✅ source-first edits; a bound form previews from the last build |
| Move / resize / align / z-order / copy-paste / duplicate / lock | ✅ | ✅ live-rebuilt |
| On-canvas menu / toolbar editing · `.resx` images · ImageList | ✅ | ✅ |
| `Localizable = true` · neutral/per-culture `.resx` · RTL · localized scalar/image edits | ✅ | ✅ interpreted resource overlay; disclosed compiled fallback |
| Tab header navigation · add/rename/delete · selected-page continuity | ✅ | ✅ live-source; compiled fallback remains build-derived |
| Component tray · document outline · events · Modifiers | ✅ | ✅ |
| Inherited-form ownership (derived fields editable; inherited/unresolved nodes read-only) | ✅ | ✅ |
| Safe byte-surgical save | ✅ | ✅ (via modern Roslyn splice) |
| **Overall** | **Stable** | **Live-source preview** (IR interpreter, VS model) + disclosed compiled fallback |

A **capability preflight** classifies every form (`safe` / `localizable` / `binaryResx` / `unresolvedType` / `lostStatements` / `unrepresentable`), so a form it can't whole-file regenerate — binary `.resx`, an unresolved base type, or an unrepresentable statement — is **refused that regenerate, with the reason named**, rather than saved unsafely. Ordinary limited forms use targeted byte-surgical source splices. `Localizable = true` forms use the v1.5 resource-first route: supported value, geometry, RTL, Color/Font, image/icon, and Reset edits touch only the selected `.resx`, with set-wide exact preflight, undo/redo, conflict-safe compensation, and preservation of unknown/binary nodes. Generated-source structural edits on localized forms remain refused. The engines have bounded automatic crash recovery, and **WinForms: Export Designer Diagnostics** reports capabilities, ping time, memory, PID, and lifecycle/crash state. **`net4x` builds:** the compiled preview holds the project's build output open while it renders, but a build — inside VS Code or in an external Visual Studio — is detected and the output handed back before the build needs it; **WinForms: Release .NET Framework Assembly (for Rebuild)** remains as a manual control. **Not yet:** arbitrary vendor-specific property editors beyond the supported framework Color/Font pair and a full vendor design-time service host. Please report issues with the generated diagnostics.

## Links

- **Source, issues & contributing:** https://github.com/SkivHisink/winforms-designer-vscode
- **License:** [MIT](https://github.com/SkivHisink/winforms-designer-vscode/blob/master/LICENSE)
