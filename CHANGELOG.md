# Changelog

All notable changes to **WinForms Designer for VS Code** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
This is a **preview** — expect rough edges and breaking changes between minor versions.

## [Unreleased]

## [0.4.0] — 2026-07-02

This preview introduces **UI localization in six languages** and a large round of **.NET
Framework (net48) editing** — you can now add, delete, rename and switch tab pages on compiled
DevExpress / WinForms forms, drop the project's own vendor controls from the toolbox, and cut /
paste on the compiled preview — plus an on-canvas smart-tag *Tasks* flyout, persistent container
outlines, and smarter engine routing.

### Added

#### Localization
- **UI localization (6 languages).** The interactive designer UI — the canvas surface and toolbar
  tooltips (zoom / align / distribute / tab-order / ruler), most of the right-click context menu,
  the Properties / Events / Outline / Toolbox panels, the Choose Items dialog, edit hints, and the
  canvas status line — is now translatable via a new **`winformsDesigner.language`** setting:
  **English** (default), **Русский**, **简体中文**, **Français**, **Deutsch**, **Español**. The
  language is chosen **in the extension settings** (scope *window*) and does **not** follow the VS
  Code display language. Counts are pluralized per each language's CLDR rules, and any untranslated
  string falls back to English, so translations can arrive incrementally. Enum and color *values*
  stay canonical English so they remain typeable and round-trip cleanly; engine diagnostic text is
  passed through. _(A few of the newest strings — the on-canvas tab-editing menu items and the
  smart-tag flyout links — are still English-only.)_
- **Localized host dialogs, notifications and status bar.** The extension-side chrome is translated
  too — the *Select Control Assembly / Project* quick-pick and file dialogs, the control-source
  status-bar item and its tooltips, and the toast / notification messages (unresolved controls,
  add-reference prompt, assembly-path fallback warning, …).
- **Localized VS Code manifest chrome.** Static chrome rendered by VS Code — the Marketplace
  description, the custom-editor and view names, the activity-bar title, and every settings-page
  title and description — is now localized via `package.nls*.json`. _Command-palette command titles
  intentionally stay English in the runtime setting's non-English modes, because VS Code renders
  palette titles from its own Display Language (a documented platform limitation)._
- **Live language switch.** Changing `winformsDesigner.language` takes effect **immediately** in
  already-open designer and panel webviews (they are re-emitted on the spot), and a translated toast
  offers **Reload Window** so the manifest chrome (palette / settings) catches up.

#### .NET Framework (net48) engine
- **Tab-page editing on compiled DevExpress / WinForms forms.** On a net48 (Framework / DevExpress)
  form you can now **single-click a tab header to switch** the active tab, **double-click to rename**
  it, **add** a new empty tab page, and **delete** the active tab page together with its whole
  subtree (with a modal confirm). Each is a single undoable edit that persists to the `.Designer.cs`
  (via the .NET 9 text-splice) and updates the live picture. Works reflectively, so it covers both
  WinForms `TabControl` and DevExpress `XtraTabControl` with no compile-time DevExpress reference.
- **Vendor / project (DevExpress) controls in the toolbox.** The toolbox for a net48/DevExpress form
  now merges the framework controls with the **project's own custom / vendor controls** (the ones
  the .NET 9 loader can't read) under a *Project Controls* category, each shown with its 16×16
  `ToolboxBitmap` icon — so those controls can be dropped onto a compiled-preview form. Adding one
  emits a pure-text `new <Fqn>()` edit without loading the vendor assembly into the .NET 9 engine.
- **Source-set (bold) properties and wired event handlers for net48 controls.** For compiled
  net48/DevExpress controls the property grid now **bolds properties that were assigned in the
  `.Designer.cs` source**, and the **Events** tab shows which handlers are wired — matching the
  .NET 9 engine. (Previously neither was populated for the net48 engine.)

#### Designer surface
- **On-canvas smart-tag *Tasks* flyout.** A chevron glyph now appears at the top-right of the single
  selected control (VS / DevExpress-style). Clicking it opens a flyout that edits the control's
  common properties inline (*Text, Enabled, Visible, Dock, Anchor, colors, …*) through the same edit
  path as the property grid, with checkbox / dropdown / text editors, plus **All Properties…** and
  **Learn More Online** links.
- **Persistent dashed outlines around container controls.** Every control holding at least one
  visible child now gets a persistent dashed outline on the surface (VS-style layout hint), making
  panels / group boxes / table layouts visible even when not selected.

### Changed
- **Adding a project / vendor control now resolves the exact type.** When adding a control from the
  toolbox that comes from a project / vendor assembly, the **fully-qualified name** is sent as the
  add key instead of the short name. A vendor control whose short name collides with a framework
  type (e.g. a custom `Panel`), or two project controls sharing a short name, now resolve
  unambiguously in both engines. Framework controls / components are unchanged.
- **Cut and paste now work on the .NET Framework compiled preview.** Cut / paste are no longer
  blocked on a net48 form; a paste is **mirrored into the live picture** by live-instantiating each
  pasted clone (with a status note when the control assembly is unavailable and only the text / undo
  state can be updated).
- **Framework / DevExpress forms auto-route to the compiled engine.** When no control source is
  chosen, the host now detects a .NET Framework / DevExpress project and routes its form to the
  **net48 engine** instead of the .NET 9 engine drawing a near-empty form. A single-target Framework
  project that **isn't built yet** now shows a message and offers to pick a control source, rather
  than rendering a misleading empty form.
- **Removed the on-canvas "Dock:" text badge.** A docked control no longer paints a
  `⬓ Dock: <side>` label on the surface — it simply shows no anchor tethers. Dock remains editable
  via the property grid's dock glyph.
- **net48 add-control skips the project-reference prompt.** Adding a control on a net48 form no
  longer offers to add a project `<Reference>`, since a Framework form's project controls already
  live in the form's own compiled assembly.

### Fixed
- **Only the active tab's controls are hit-testable.** Controls sitting on non-active (hidden) tab
  pages are no longer in the click / hit-test map, so a control stacked under the active page can no
  longer steal a click (e.g. clicking a footer panel no longer selects a control from an inactive
  tab). Fixed in **both** engines, covering standard WinForms inactive pages as well as DevExpress
  pages that stay `Visible = true`.
- **Add-control failures report the real cause (net48).** When adding a control fails in its
  constructor, the error note now shows the **underlying exception message** (unwrapped from
  `TargetInvocationException`) instead of a generic reflection-wrapper message.
- **Control-type resolution hardened against cross-assembly short-name rebinding (net48).** A dotted,
  fully-qualified type name that fails to resolve no longer silently falls back to a same-short-name
  type in a different assembly — which a crafted paste clip could otherwise use to steer the resolved
  type. Only a bare short name uses the short-name fallback.

---

_Internal:_ a new `npm run l10n:parity` CI helper checks every locale against the English source of
truth (runtime catalog and `package.nls`), reporting missing / extra keys, `{placeholder}`
mismatches, and missing CLDR plural categories.

## [0.3.2] — 2026-07-01

Patch release. Completes the Marketplace refresh begun in 0.3.1 — whose Marketplace
publish failed on a transient network error (`ECONNRESET`), so the listing had not yet
picked up the net48 documentation — and adds discoverability keywords plus a more
resilient publish step.

### Changed
- **Discoverability** — added Marketplace keywords for the .NET Framework engine:
  `net framework`, `net48`, `devexpress`.
- **Release reliability** — the Marketplace / Open VSX publish steps now **retry** on
  transient network failures (e.g. `ECONNRESET`), so a flaky connection no longer fails a
  release.

## [0.3.1] — 2026-07-01

Documentation-only patch — no functional changes to the designer. Refreshes the
Marketplace listing and repository docs, which still described .NET Framework hosting as
*not started* after the net48 engine shipped in 0.3.0.

### Changed
- **Docs** — the READMEs (repository + Marketplace) and `CONTRIBUTING` now document the
  **.NET Framework (net48) engine**: the experimental compiled preview for `net4x` /
  DevExpress forms, its requirements, the two-engine architecture, the `engine-net48/`
  repository layout, and its status — instead of listing .NET Framework hosting as *not
  started*.

## [0.3.0] — 2026-07-01

Adds a **second rendering engine for .NET Framework projects**, so forms built on
classic WinForms component suites (e.g. **DevExpress** and other `net4x` control
libraries) that the .NET 9 engine cannot load now render — and can be edited — inside the
designer. The extension runs both engines side by side and routes each form to the right
one automatically.

### Added

#### .NET Framework (net48) engine — *experimental*
- **Compiled preview for Framework forms** — forms whose controls target .NET Framework
  (`net4x`) are rendered by a dedicated **.NET Framework 4.8** engine that **instantiates
  the compiled control types** from the project's build output and paints them, so vendor
  controls (DevExpress `XtraUserControl`, …) look pixel-accurate — the same fidelity the
  .NET 9 engine gives modern controls.
- **Automatic engine routing** — the extension now runs **two engine processes** and picks
  one per form from the resolved control assembly's runtime: a Framework assembly (no
  `.deps.json` / `.runtimeconfig.json` sidecar) → the net48 engine; everything else → the
  .NET 9 engine. Each engine starts lazily and self-heals if its process exits.
- **Live editing on the compiled preview** — the **property grid**, **drag / move / resize
  / align**, **add / remove**, and **z-order** all apply **live** against the instantiated
  instance; the change is persisted as `.Designer.cs` text (via the .NET 9 splice) and
  re-renders on the next build. A **compiled-preview badge** (🔒 *preview*) appears in the
  status bar. *Cut / paste and dropping project-specific (non-framework) controls are not
  supported on this engine yet — manual source edits appear after a rebuild.*

### Changed
- **Control-source resolution for Framework projects** — choosing a `.csproj` or browsing
  for a control source now resolves **`OutputType=Exe`** projects (a net48 WinForms app's
  `.exe`, not only a `.dll`) and picks the freshest build under `bin/`, fixing
  *"Could not resolve build output"* for Framework projects. The **Browse** dialog now
  accepts `.exe` as well as `.dll`.

### Fixed
- **Root-type detection via the sibling `.cs`** — the base type (`Form` vs `UserControl`,
  including vendor bases such as `XtraUserControl` that derive from `UserControl`) is now
  read from a form's main `.cs` when its `.Designer.cs` partial omits the base clause, so a
  `UserControl` opened through its `.Designer.cs` is no longer mis-rendered as a `Form`.
- The .NET 9 project resolver's `bin/**` search now also matches `<AssemblyName>.exe`
  (not just `.dll`), another cause of *"could not resolve build output"* on `OutputType=Exe`
  projects.

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

[Unreleased]: https://github.com/SkivHisink/winforms-designer-vscode/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/SkivHisink/winforms-designer-vscode/compare/v0.3.2...v0.4.0
[0.3.2]: https://github.com/SkivHisink/winforms-designer-vscode/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/SkivHisink/winforms-designer-vscode/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/SkivHisink/winforms-designer-vscode/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/SkivHisink/winforms-designer-vscode/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/SkivHisink/winforms-designer-vscode/releases/tag/v0.1.0
