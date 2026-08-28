# Release roadmap: 1.0.0 → 2.0.0

Version **1.0.0** establishes and hardens the trust floor: the common render → select → edit → save loop is stable,
and unsupported forms fail closed instead of being silently mis-rendered or rewritten. The 1.x line builds
outward from that invariant; **2.0.0** is reserved for the design-time hosting changes that may require an
intentional protocol or compatibility break.

This roadmap describes release outcomes, not calendar commitments. Security, data-loss prevention, and
regressions in the stable workflow take priority over the order below.

The editable visual version lives in
[`docs/roadmap-to-2.0.0.drawio`](docs/roadmap-to-2.0.0.drawio).

## 1.0.0 — Stable foundation

**Status: shipped baseline, maintained by 1.0.x patches**

- Stable modern .NET designer for `net8.0-windows`, `net9.0-windows`, and `net10.0-windows`.
- Live-source .NET Framework 4.8 / DevExpress interpretation with a disclosed compiled fallback and source-first,
  byte-local edits.
- Capability preflight that names why a form can't be faithfully replayed or whole-file regenerated (binary-resource,
  unresolved base, unrepresentable statement); those forms stay editable via targeted byte-local splices. At the 1.0
  trust-floor baseline a `Localizable = true` form was read-only; 1.5 replaces that lock with a resource-first path.
  A net48 form that exceeds the safe interpreter falls back to its
  last build with a named reason instead of silently showing a partial live-source picture.
- Atomic/conflict-checked writes, round-trip golden fixtures, and real Extension Host smoke coverage.
- Fast C# and TypeScript unit layers pin save-safety, interpreter allowlists, identifier/value conversion,
  TFM selection, extension expression helpers, and bounded engine recovery.
- Equivalent generated-local spelling and safe `AddRange`/`Add` collection syntax no longer cause false
  read-only results; all other statement changes remain fail-closed.
- The .NET Framework compiled path surfaces `Modifiers` / `GenerateMember` and reconciles ImageList edits
  immediately on its cached live instance.
- High-DPI backing-store rendering: both engines draw the picture at the display's device pixel ratio by scaling the
  control tree before capture (not a post-hoc upscale), so the canvas is crisp on 4K while layout, hit-testing and zoom
  stay in logical form pixels; the 1× path is byte-identical to before.
- Exported diagnostics include capabilities, latency, memory, PID and lifecycle/crash state; bounded crash
  recovery, performance thresholds, and stronger CI/release preflight are release gates.

**Exit criterion:** every supported edit either preserves the source outside its declared span or is refused
with a concrete reason.

## 1.1.0 — Daily workflow and project integration

**Status: shipped in `v1.1.0`**

The first post-1.0 minor removes the manual recovery steps that interrupted an otherwise stable design session.
It deliberately finishes existing product seams before the larger data-binding and general-editor work in 1.2–1.3.

- The **.NET** side of **Choose Toolbox Items** discovers controls from project outputs, configured probe
  directories, explicitly browsed assemblies, and installed / registered .NET assemblies; it caches scan results and
  persists custom toolbox tabs and chosen items across reloads.
- Per-form designer view state is persisted outside project source files: **Lock Controls**, zoom, active design tab, and
  toolbox / outline expansion survive closing the editor and reloading VS Code without touching `.Designer.cs` or
  `.resx`.
- The **ImageList** workflow supports image reordering and key renaming, stable `ImageIndex` / `ImageKey`
  reconciliation, one undoable resource transaction, and immediate modern/net48 preview parity.
- The net48 preview coordinates with VS Code build and test tasks: release pinned outputs before a build, invalidate
  stale compiled fallbacks, and re-render after the task, while keeping the manual Stop / Restart / Release commands
  as recovery controls.
- Degraded renders are actionable on both engines: they identify the affected control or statement, preserve the last
  known-good canvas as view-only after a failed render, and offer direct Retry, Rebuild, Choose Control Assembly, and
  Copy Diagnostics actions.

**Exit criterion — met:** a user can reopen a real project, recover the same designer workspace, discover a missing
control, reorganize an ImageList, and run a net48 build from VS Code without a manual release step; any degraded
preview names the affected target, cause, and recovery action, and all persisted changes remain conflict-checked,
undoable, and covered on both engines.

## 1.2.0 — Data-bound forms

**Status: implemented — release candidate verified locally**

- `BindingSource`, `DataSource`, and `DataBindings` are first-class source editors: bindings expose their target
  property, component source, data member, formatting flag, update mode, and format string; supported data sources
  can be cleared, pointed at a compatible component, or set to `typeof(T)`.
- The DataGridView column editor round-trips `DataPropertyName`, format strings, alignment, and literal null display
  values together with the existing column metadata.
- The component tray carries framework icons and inline field rename; compatible component references remain
  selectable, while common `ToolTip`, `ErrorProvider`, and `HelpProvider` extender properties are editable directly
  on their target controls.
- Cross-form copy/paste carries exact typed dependencies for bindings and common extender providers, validates them
  against the target form, and explicitly lists every unavailable or type-mismatched dependency without changing
  source.

**Exit criterion — met:** the checked-in `DataBoundForm` release fixture is rendered and maintained through the
designer's binding, data-source, bound-column, extender, tray, and dependency-aware clipboard paths without manual
generated-code edits. Focused unit tests, the cross-runtime named-pipe E2E, and live-webview tests cover those paths;
unsupported expressions continue to fail closed.

## 1.3.0 — General editor framework

**Status: repository-side closed by the 1.4.0 completion work**

- Bounded metadata routes canonical, allowlisted `IList` / `IList<T>` values through a shared source adapter instead
  of a per-property pipeline; ambiguous types, expressions, or trivia-sensitive rewrites remain read-only.
- Expandable objects and vendor value types expose recursive `TypeConverter` metadata with depth/node limits,
  exception/cycle guards, and explicit truncation. Nested metadata is display-only until a safe nested writer exists.
- The supported framework Color/Font `UITypeEditor` pairs run through a cancellable, short-lived isolated worker.
  Project/vendor/editor-attribute types are not loaded merely because metadata advertises them.
- Every new generic/modal edit returns to the existing source-first transaction, revision/minimality firewall,
  authoritative re-render, and one undo unit.

**Exit criterion — met for the supported adapter surface:** adding a safe property or collection shape normally
requires metadata or a bounded adapter, not a new end-to-end stack. Arbitrary vendor editors remain a deliberate
2.0 design-host problem.

## 1.4.0 — Layout, inheritance, DPI, and ARM64

**Status: repository-side implementation complete; publication and hardware/vendor acceptance are external gates**

- Inherited surfaces carry explicit `root` / `currentSource` / `inherited` / `unresolved` ownership. Current-source
  properties remain source-editable; inherited or ambiguous identities stay visible and are refused by server
  mutation gates. Direct geometry additionally requires the base graph to resolve, because its layout constraints
  cannot be inferred safely from an unavailable base type.
- TableLayoutPanel cell/style and FlowLayoutPanel order tools compose with outline drag/reparent/reorder, preserving
  the existing source-first structural writers and one-undo behavior.
- Modern free-control commits are authorized and corrected by the live WinForms graph; docking, auto-size,
  layout-managed, inherited, custom, and unsafe source shapes fail closed.
- HiDPI tests cover `1`, `1.25`, `1.5`, `1.75`, and `2`: coordinates stay logical while fractional displays use a
  safe 2x capture that Chromium downsamples to the device grid.
- CI/release packaging produces separate `win32-x64` and `win32-arm64` VSIX artifacts with matching native modern
  apphosts. The net48 engine is explicitly an x64 compatibility fallback in the ARM64 package.

**Exit criterion — met in the checked-in automated and package corpus:** supported nested layouts remain source-safe
across the DPR matrix, ownership modes, and x64/ARM64 artifacts. Real multi-monitor visual inspection, x64-emulated
net48/vendor stacks on ARM64, and Marketplace/Open VSX publication remain explicit external gates.

## 1.5.0 — Enterprise localization

**Status: repository-side implementation complete; publication and hands-on culture/RTL acceptance are external gates**

- `Localizable = true` forms render through executable `ApplyResources` IR on both engines instead of being treated
  as unsupported or globally read-only.
- **WinForms: Select Localization Culture** selects the neutral layer, an existing culture, or a newly validated
  culture. Resolution follows neutral → parent → exact overlays, and Reset removes the selected override so normal
  ResourceManager fallback resumes.
- Supported scalar, Color/Font, geometry, image/icon, `RightToLeft`, and `RightToLeftLayout` edits are written only
  to the selected `.resx`; generated `.Designer.cs` remains byte-identical. Structural/source edits with no safe
  resource representation remain fail-closed.
- Resource transactions preflight every exact source state, reject duplicate targets, participate in one undo/redo
  unit, and compensate partial I/O failures without overwriting a concurrent external edit. Comments, unknown nodes,
  and opaque binary resources are preserved.
- Modern and .NET Framework corpora cover neutral/parent/exact fallback, translated forms, localized images/scalars,
  RTL mirroring, and resource RPC upsert/remove behavior.

**Exit criterion — met in the checked-in automated corpus:** an internationalized form can be edited in multiple
cultures without losing fallback values, translations, binary resources, or generated-source formatting. Hands-on
native RTL/culture UX and Marketplace/Open VSX publication remain explicit external gates.

## 1.6.0 — Workflow parity and release hardening

**Status: repository-side implementation complete; publication and hands-on platform/vendor acceptance are external gates**

- Standard WinForms `TabControl` hosts expose engine-authoritative tab identity on both runtimes. Header clicks switch
  the transient designer view, double-click renames a field-backed page, and Add Tab / Delete Tab reuse the existing
  source-first byte-local writers on modern .NET as well as the .NET Framework path.
- The selected page of each tab host is bounded per-form workspace state. On modern and net48 live-source canvases it
  survives render, undo/redo, and close/reopen without changing project files; unknown or deleted mappings safely fall
  back to the selection expressed by the form source. A disclosed net48 compiled fallback remains build-derived.
- Every supported extension locale now translates the localization-culture workflow introduced in 1.5. The command
  title distinguishes the form's resource culture from the extension UI language.
- Unsupported COM/WPF pages in **Choose Toolbox Items** are inert and explicit: hidden `.NET` candidates cannot be
  browsed or applied while an unsupported page is selected.
- CI and release use the same sample-corpus interpreted-coverage floor, and all three shipped webview scripts receive a
  standalone syntax gate before packaging.

**Exit criterion — met in the checked-in automated corpus:** a standard tabbed form has the same safe canvas workflow
on both engines, its modern/net48-live-source view-only selected page survives reopening, localization UI does not fall back to English in a
supported locale, unsupported Choose Items pages cannot mutate `.NET` toolbox state, and release cannot omit the
coverage or webview syntax gates. Tab reorder, arbitrary vendor design-time services, COM/WPF toolbox support, real
hardware/vendor acceptance, and publication remain outside this minor release.

## 1.7.0 — Safe tab ordering

**Status: repository-side implementation complete; publication and hands-on platform/vendor acceptance are external gates**

- The active field-backed page of a standard tab host can move one position left or right from the canvas context
  menu on modern .NET and .NET Framework forms. The commands are translated in all seven shipped UI locales.
- Source order is derived from canonical `Controls.Add`, `TabPages.Add`, and fresh-array `AddRange` statements. The
  writer swaps only two adjacent page-reference expressions, including across an `AddRange` + later `Add` boundary;
  page construction, property blocks, `TabIndex`, and selected-page view state remain untouched.
- A dedicated gate proves the exact adjacent permutation and unchanged non-tab statements/fields/member count.
  Duplicate, unknown, comment-bearing/non-trivial page expressions, inherited/unresolved, stale-render, and
  localizable structural-source cases decline instead of guessing.
- Modern and net48 live-source canvases replay the committed source. A disclosed net48 compiled fallback mirrors the
  order in its live collection, preserves the active page, and remains rebuild-authoritative.

**Exit criterion — met in the checked-in automated corpus:** `Controls.Add`, `TabPages.Add`, `AddRange`, and mixed
`AddRange + Add` tab orders move by exactly one adjacent position, round-trip across both engines, stay one undoable
source transaction, and fail closed on ambiguous source. Real vendor/hardware interaction and Marketplace/Open VSX
publication remain explicit external gates.

## 1.8.0 — Placement override, a self-maintaining toolbox, and design-time safety

**Status: repository-side implementation complete; publication and hands-on platform/vendor acceptance are external gates**

This milestone closes two workflow gaps that showed up in daily use: the canvas always deciding where a control
lands, and the toolbox only knowing about libraries the user pointed it at by hand.

### Placement override

- A held modifier suppresses alignment for the duration of one drag or resize, so a control can be
  placed at an arbitrary position instead of being pulled to a sibling edge/center within the snap threshold.
  The suppression is per-gesture and never a persistent mode, so the default stays "aligned unless asked".
- The default is **Alt** (the Visual Studio binding) rather than Shift: on this canvas `Shift`/`Ctrl` + click already
  extend the selection, and `Shift` + arrow already means resize-by-keyboard, so a Shift-drag override would
  collide with multi-select. The modifier is configurable if the VS default is not wanted.
- While the override is held, the canvas draws no snaplines and shows the live position/size readout, so the user can see
  the exact value they are choosing instead of guessing why the control stopped moving.
- Free placement still goes through the existing geometry pipeline: the engine corrects final bounds, and
  layout-managed, docked, locked, inherited, and read-only controls keep refusing the move as they do today.
  Suppressing alignment must not become a way around a fail-closed geometry rule.

### Self-maintaining toolbox

- The owning project and its explicit `ProjectReference` graph supply build-output roots automatically instead of
  an all-workspace project scan or a required manual pass through **Choose Toolbox Items**. Conventional `bin` roots
  and concrete custom `BaseOutputPath` / `OutputPath` / `OutDir` values are recognized without expanding dynamic
  MSBuild properties into an unbounded traversal.
- Discovery stays lazy and cheap by construction: no scan on activation, work started off the critical path and
  in bounded slices, cancellable when the user starts typing or the window loses focus, with explicit file,
  depth, and time budgets. Metadata continues to be read without instantiating or executing control code.
- Results are cached by path plus size and mtime, and refreshed incrementally through a watcher on the
  directories that actually produced hits, so a rebuild re-reads one output rather than re-walking the tree.
- The user can add and remove discovered entries, and a removal sticks: an item the user deleted does not
  reappear on the next scan. Removals, additions, and custom tabs stay workspace state and survive reload; legacy
  global curation is migrated once so upgrading to the workspace contract does not discard existing choices.
- Auto-discovery is visible and switchable — a setting disables it entirely, diagnostics name which directories
  were scanned and what was skipped by a budget, and the result list is never silently truncated.

**Exit criterion — met in the repository automated and package corpus:** a control can be dropped at an exact
position without weakening engine geometry authorization, and the owning project's controls appear without manual
assembly configuration. Discovery does not run on activation, walks only the owning project plus explicit project
references under bounded/cancellable budgets, and preserves workspace-scoped user additions, removals, and tabs
across later scans. Real vendor/hardware interaction and Marketplace/Open VSX publication remain explicit external
gates outside this repository-side milestone.

### Also in this milestone — design-time safety: opening a form stops running your application

Taken from three reports on one real DevExpress solution during the 1.8 cycle: opening a form opened the
application's own windows, an open designer made the project unbuildable, and the preview quietly ran code that a
designer has no business running.

- **The Visual Studio route, for real files.** VS never constructs the class being edited; it instantiates the
  declared base type and replays the designer statements onto it. Three shapes common in hand-written designer files
  used to defeat that and force the compiled fallback — an unqualified type name resolved through the file's own
  `using` scope, a non-public constructor, and a vendor collection that is not an `IList`. All three now interpret.
  Measured on the reporting project: 8 of 10 forms, including the one whose `Load` opened two windows.
- **The build output is no longer held.** The modern engine loads user assemblies from a private in-memory copy, so
  it pins nothing at any time; the net48 engine, which must load in place, detects a build started outside VS Code
  and hands the output back before MSBuild's copy needs it.
- **Windows cannot reach the screen.** The net48 engine runs on a private desktop that is never displayed, so a
  form's own design-time windows — splash screens, docking panels, dialogs — are contained and named in the log
  instead of appearing next to the editor. A modal one is closed after a bounded wait so a preview cannot wedge.
- **Optional metadata never costs a construction.** The vendor "Tasks" menu is read from a compiled instance that
  already exists, and never causes one to be built.

**Exit criterion — met in the repository automated corpus:** a form whose designer file uses an unqualified vendor
type, an internal constructor and a non-IList collection interprets without its own class being constructed (proved
by a marker window that must not appear); a real MSBuild rebuild of a rendered project succeeds; a self-maximizing
form that opens a window from `Load` renders at its designed size with nothing on the interactive desktop; and the
vendor-task query leaves nothing loaded. Static reads off user/vendor types remain refused by the value allowlists
and therefore still disclose a compiled fallback. Real vendor/hardware interaction and Marketplace/Open VSX
publication remain explicit external gates.

## 1.9.0 — The daily loop and project item creation

**Status: repository-side complete (2026-08-14).** These high-frequency Visual Studio reflexes and Explorer project
operations now share source-first, revision-checked, ownership-aware, collision-safe, fail-closed boundaries.

- **Explorer Add creates complete project items.**
  Windows Form and User Control produce a collision-checked `.cs` / `.Designer.cs` / `.resx` set and open in the
  designer; Component and Class produce complete code items. Static SDK projects use implicit inclusion, while
  classic/default-item-disabled projects receive exact item entries in the same undoable edit. Ambiguous, shared,
  dynamic/conditioned, wildcard, non-WinForms, and colliding shapes are refused before any file is created.
- **Rename a control.** `(Name)` is an editable design-time row in the property grid, with F2 on the canvas and in
  the outline. Both gestures reuse the proven component-tray rename path; code-behind references remain fail-closed.
- **Double-click creates the default event.** The control's real `DefaultEventAttribute` (Button → Click,
  TextBox → TextChanged, Form → Load) feeds the existing handler-stub generator and code navigation path. An
  already-wired event opens the body without changing source.
- **`F7` / `Shift+F7`** provide View Code / View Designer with the familiar Visual Studio bindings.
- **Keyboard selection traversal:** `Tab` / `Shift+Tab` walk siblings, `Esc` selects the parent container, and
  `Ctrl+A` selects everything in the current design scope.
- **Live position/size readout** reports complete `x`, `y`, width, and height values during every move or resize.

**Exit criterion — met in the repository automated corpus:** all four project items compile in representative modern
and net48 projects; a refused project shape leaves no partial file set; and a control can be renamed, given its real
default handler, and navigated to and from code without touching the mouse or property grid, on both engines. A rename
that code-behind would break is refused, and an existing handler opens without changing source. Hands-on platform
interaction, physical ARM64/DPI coverage, licensed-vendor acceptance, and publication remain external gates.

## 1.10.0 — Multi-object properties

**Status (2026-08-18): repository-side complete.**

- Editing a property once for a multi-selection: intersect the browsable, writable, type-compatible properties of
  every selected component instead of showing only the primary selection.
- Mixed values are displayed as mixed and never silently propagate the first control's value to the rest.
- One prevalidated, revision-checked transaction covers all targets and undoes as a single unit; a stale
  revision, inherited/read-only member, or unrepresentable target writes nothing at all.
- Multi-object Reset only where every target has a representable reset.
- Categorized / Alphabetical toggle, with search behaving identically in both modes.

**Exit criterion — met in the repository automated corpus:** editing or resetting a shared property across
heterogeneous controls produces exactly the per-control source splices in one revision-checked transaction; the
custom document records one undo unit, and a single ineligible target returns no text and causes zero partial writes.
Modern and real net48 named-pipe runs, mixed-value webview behavior, sorting/search, localized batches, and reset
mirroring are covered. Hands-on platform interaction, physical ARM64/DPI coverage, licensed-vendor acceptance, and
publication remain external gates.

## 1.11.0 — Precision layout

**Status (2026-08-18): repository-side complete.**

- Layout modes — `SnapLines`, `SnapToGrid`, `None` — with configurable grid size and an optional visible grid.
  **Align to Grid** stops being a permanently disabled menu entry. The 1.8.0 per-gesture Alt suppression stays.
- Snaplines become Margin/Padding-aware, so a control snaps at its declared margin distance the way VS does,
  instead of only edge-to-edge and center-to-center.
- Text-baseline snaplines for label/textbox-class controls, measured by the engine so font, DPI, and zoom cannot
  drift the guide away from the rendered text.
- Horizontal/vertical spacing **Increase**, **Decrease**, and **Remove** alongside the existing Make Equal.
- `Ctrl` + drag duplicates a control in place of moving it, reusing the proven copy/paste transaction.

**Exit criterion — met in the repository automated corpus:** move, resize, spacing, and grid operations consume
engine-authored client, Margin/Padding, and Font/DPI baseline geometry; nested containers, zoom, mirrored layout,
both runtime engines, and repeated renders retain one coordinate model without accumulating drift. Hands-on physical
multi-monitor/DPI, ARM64, licensed-vendor, and publication acceptance remain external gates.

## 1.12.0 — Toolbox creation and placing

**Status (2026-08-19): repository-side complete.**

- Toolbox double-click inserts a default-sized control into the active container.
- Dragging a rectangle from a selected toolbox item creates the control at exactly that size, instead of always
  dropping a default-sized control at a point.

**Exit criterion — met in the repository automated corpus:** both creation gestures select the new control and
round-trip the exact intended parent, size, and position through modern and real net48 named-pipe processes. The
webview proves one-add double-click behavior, exact rectangle payloads, nested-container resolution, cancellation,
and preservation of ordinary point drops; engine tests prove exact emitted/live geometry and fail-closed invalid-size
handling. An ineligible container, unknown item, invalid rectangle, or stale source leaves the document unchanged.
Hands-on physical ARM64/DPI, licensed-vendor, and publication acceptance remain external gates.

## 1.13.0 — Assets and menu/toolbar productivity

**Status (2026-08-19): repository-side complete.**

- Resource-valued properties (`Image`, `BackgroundImage`, `Icon`, …) can pick an existing project resource, not
  only import a file into the form's own `.resx`. Only losslessly representable resource forms are offered.
- On-canvas drag to reorder and reparent `ToolStrip` / `MenuStrip` items, complementing the existing add, rename,
  delete, and type-picker gestures.
- Separators and **Insert Standard Items** for the standard menu and toolbar skeletons. Editable
  `MenuStrip.Items` and `ToolStrip.Items` popups append the standard skeleton
  as one pending forest, Cancel posts no mutation, and OK commits atomically through `setToolStripItems`; the engine
  permits brand-new dropdown items with brand-new children and existing field-backed moves between modelled
  collections while still refusing brand-new non-dropdown parents with children.
- Unknown item statements and unknown `.resx` entries stay byte-identical; an operation that cannot be
  represented is the only thing disabled.

**Exit criterion — met in the repository automated corpus:** project-resource assignment is source-only and binds a
canonical strongly typed accessor after current-revision property metadata, canonical path, UTF-8/size, `.resx`,
generated-class, and getter-shape validation; resource files remain byte-identical. Menu/toolbar standard insertion and
on-canvas reorder/reparent commit one modelled forest edit, preserve survivor statements, and refuse cycles,
non-dropdown targets, anonymous/shared items, unsupported collection shapes, or comment loss. Modern and real net48
named-pipe E2E, 711 webview checks across 177 tests, 139 TypeScript tests, current C# unit suites, build/typecheck,
localization, mojibake, audit, coverage, performance, and VS Code 1.84/current Extension Host gates pass. Hands-on
physical ARM64/DPI, licensed-vendor, cross-tool Visual Studio interaction, publication, and external approval remain
external gates.

## 1.14.0 — Visual inheritance overrides

**Status (2026-08-20): repository-side complete.**

- Classify inherited members by ownership **and effective accessibility** instead of one blanket read-only rule,
  so `public`/`protected` inherited controls can take allowlisted property and layout overrides.
- Overrides are emitted only in the derived class; the base form is never modified as a side effect.
- Private, unresolved, vendor-dependent, and last-build-mismatched nodes stay visibly inherited and read-only.
- Reconcile derived overrides when a rebuilt base changes identity, type, accessibility, or available properties.

**Exit criterion — met in the repository automated corpus:** modern and real net48 derived-form matrices prove
eligible accessible first-party controls can receive bounded property and authorized geometry overrides, Reset removes
only the derived assignment, inaccessible/custom/vendor/unresolved/layout-managed nodes remain read-only, and the base
source stays untouched. Dirty designer and sibling code-behind snapshots, semantic exact-base identity, stale-token
checks, and `BaseTypeChanged` fallback scrubbing make a base-version mismatch fail closed rather than guess. Modern
373/373 and net48 37/37 unit tests, 143/143 TypeScript tests, 719 webview checks across 178 tests, full named-pipe E2E,
build/typecheck, localization, mojibake, audit, coverage, performance, and VS Code 1.84/current Extension Host gates
pass. Hands-on physical ARM64/DPI, licensed-vendor, cross-tool Visual Studio interaction, publication, and external
approval remain external gates.

## 1.15.0 — Bounded data-binding productivity

**Status (2026-08-20): repository-side complete.**

The Data Sources workflow is now bounded and source-first. The engine discovers conventional project DTOs and
application settings without evaluating project code or returning setting defaults, exposes existing typed
`BindingSource` components, generates detail/grid surfaces with optional `BindingNavigator` wiring, appends missing
schema columns to supported existing `DataGridView` controls while preserving existing columns, and binds compatible
application settings through a canonical proven `global::...Properties.Settings.Default` path. Forged/stale keys,
duplicate DTO identities, unsupported schemas/providers, unsafe existing columns, non-container parents, incompatible
settings targets, comments/directives in managed blocks, and partial-edit attempts return no changed text.

Modern 388/388 and net48 37/37 unit tests, 143/143 TypeScript tests, 729 webview checks across 180 tests, full
named-pipe E2E with live v1.15 RPC scenarios, build/typecheck, localization, mojibake, audit, coverage, performance,
and VS Code Extension Host gates pass. Hands-on physical ARM64/DPI, licensed-vendor data-binding matrices,
cross-tool Visual Studio interaction, publication, and external approval remain external gates.

## 2.0.0 — Visual Studio-class extensible design-time platform

**Status: W0-W3 CLOSED; W4 PARTIAL; bounded W5 product surface CLOSED; W6 package/metadata CLOSED; clean `v2.0.0`
Git identity NO-GO; unqualified Visual Studio parity/GA, licensed-vendor certification, physical hardware/AT, legal,
publication, and long-soak gates remain explicitly open**

The 2.0.0 worktree is prepared as a stable SemVer package candidate for the bounded repository surface, not a declaration that the larger
Visual Studio-parity program below is complete. Its audited claim is intentionally narrower: managed standard-control
workflows and the v2 safety/runtime foundations that have direct repository evidence. The release does not advertise
the still-unproven scenario rows or substitute repository tests for Visual Studio, vendor, hardware, accessibility-lab,
legal, or publication decisions.

The 2026-08-21/22 closure continued through the visible W5 gaps: SplitContainer panels/drop routing, Table/Flow/Split
container behavior, custom/vendor modern geometry, `AutoSize`/Dock semantics, stateful ProgressBar rendering, real
`DesignerActionList` and framework `CollectionEditor` routes, project-wide partial events, typed DataSet generation,
localized structural transactions, vendor inherited overrides, `.sln`/`.slnx`, classic target frameworks, and inline
`InitializeComponent`. Real source-identical modern and compiled-net48 inheritance sessions now also prove protected
derived overrides, private inherited read-only refusal, and derived-only toolbox additions. The exact minimum VS Code
1.84.0 and Stable 1.134.0 product suites pass, including the repaired
journaled-source watcher race, the cross-document default-event history transaction, and S003's real two-process
hot-exit restoration of one native move/Undo unit on modern and compiled-net48 CustomEditors. S104 additionally keeps
the healthy modern worker warm for a bounded 30-second idle window, keeps exactly two owned children while a failed
net48 AppDomain unload may correctly self-heal through a confirmed whole-worker replacement, then proves the
last-session recycle exits both current PIDs before fresh workers start. S079 now proves exact ar-SA mirrored geometry
and clean resource overlays through compiled-net48; S101/S105 prove real `net8.0-windows`/`net48` project routing to
live modern/net48 workers. S016 now opens a generated 300-control form through both real x64 product engines, publishes
301 layout nodes, and keeps initial open plus selected Text commit/reconciliation under frozen `5000/500 ms` budgets
with same-snapshot Properties, native Undo, and byte-exact disk on both host lines. S122 now captures real product
telemetry for generated 50/300-control modern/net48 forms and a 180-control/96-FakeVendor net48 form at logical
100/125/150/200% DPI. High-DPI retained patches scale only the changed leaf, the webview maps logical dirty rectangles
onto the physical canvas, and all 12 frozen budgets pass with same-snapshot reconciliation, native Undo, and byte-exact
disk on both host lines. Physical performance-lab p95, the licensed vendor corpus, and actual Visual Studio remain
external. S120 now runs its bounded move/save/native-Undo leg in every full Extension Host regression and matches the
archived Visual Studio 18.7 byte-identical Save All trace. S100 and S108 now complete the bounded two-way corpus:
modern and compiled-net48 CustomEditors save their Forms, actual Visual Studio 18.7 opens and saves those exact
artifacts, and later real product sessions reopen the archived Visual Studio output with exact Text semantics,
CustomDocument/disk equality, clean state, and native Undo restoration. The static S100 adapter remains data-only and
cannot load vendor code or mutate the workspace.
S126 now exposes a visible
High-DPI Advisor command: it previews the exact `AutoScaleMode.None` → `Font` patch in a read-only VS Code diff,
applies that retained revision through the ordinary CustomDocument transaction as one native Undo/Redo unit, and
refuses the same preview after an intervening edit without replacing newer text. Both supported host lines pass;
physical ARM64 and actual Visual Studio remain external. S124 now kills the actual mapped modern worker under an open
CustomEditor: edit authority is revoked, Diagnostics records the crash, a different PID restores the byte-exact clean
graph, ordinary edit/native Undo succeeds, and the following form continues on that recovered worker without an
unhandled pipe rejection. S095 now activates the exact repository-certified net48 `ComponentDesigner` in a disposable
private-desktop child, observes a real `Initialize` process crash without losing the mapped EngineApi process,
quarantines that assembly SHA-256/component/certificate identity, and refuses a retry without launching another child.
The generic source-first surface stays editable with exact native Undo/Redo and disk preservation. This is process
containment rather than an OS security sandbox; actual Visual Studio and licensed-vendor certification remain external.
S089/S090 now connect the exact repository-certified modern hosted-service kernel to the ordinary CustomEditor rather
than leaving it as a probe. The engine publishes `Apply Service Preset` only after STA plus six complete service
capabilities and exact assembly/component/designer/certificate checks; incomplete `IDesignerHost` and unsupported
service requests refuse explicitly. The webview supplies only the certified command identity, and the host independently
plans the exact Text/Size result and commits it as one unsaved native Undo/Redo unit. A forged certificate is exact
no-mutation on both supported host lines. S091/S092 now exercise the shared registry through a real compiled-net48
CustomEditor: the certified cancellation action opens one disposable-child transaction, refuses the nested transaction
as `REENTRANT_CANCELLED`, balances all change events, restores the transient graph, and returns no source proposal;
unsupported services remain withheld explicitly. Source, dirty state, native history, project/assembly disks, and the
mapped net48 EngineApi process remain exact. Arbitrary designers, licensed-vendor certification, physical ARM64, and
actual Visual Studio reference execution remain external.
The strict catalog now records
111 `PASS`, 12 `NOT_EXECUTED`, 5 `GATED`, and 11 `HARNESS_ONLY` automation classifications; all 111 repository passes
are backed by completed machine-readable suite reports and direct executed assertion anchors. Ten caller-supplied
capability-inspection/echo scenarios were removed from `PASS` rather than treated as product execution. Forty actual
Visual Studio Enterprise 2026 (18.7) reference traces are
archived as `PASS` (S001, S005, S006, S009, S011, S012, S013, S014, S015, S017, S021, S022, S024, S025, S026, S029,
 S030, S031, S037, S038, S039, S041, S042, S045, S046, S049, S050, S051, S053, S061, S062, S079, S085, S086, S087, S088, S100, S108, S110, and S120), while 88 remain
`NOT_EXECUTED`. S079 measures the installed classic-net48 designer's real RTL Form/Button/Label HWNDs: the exact
`320×160` client mirrors logical Button `(20,30,90×28)` to `(210,30,90×28)` and Label `(50,82,80×20)` to
`(190,82,80×20)` with source, Designer, and project bytes unchanged. S085 selects an actual protected inherited Button
on a net10 derived Form and changes `Text` through native Properties; Visual Studio writes exactly one derived override,
keeps both base files, derived code-behind, and project byte-identical, removes the override through native Undo after
its deterministic first-touch CodeDOM canonicalization, and reproduces the applied Designer byte-exact on Redo. S086
selects the exact private inherited Label with the native lock glyph, shows `Text=Private inherited label` on a disabled
Properties row, rejects UI Automation `SetValue`, and preserves all five base/derived/project artifacts byte-exact;
physical ARM64 remains gated. S087 invokes the exact classic-net48 `All Windows Forms → Button` Toolbox action into a
derived root, proves the complete one-Button derived-only CodeDOM shape plus native Undo/Redo operation contract, and
retains raw `TabIndex`/`SetChildIndex` differences instead of claiming byte identity. S088 opens source-identical modern
and classic-net48 derived Forms, selects the private inherited Button with native lock/read-only Properties, and proves
a bounded drag leaves bounds, observable Saved/Undo availability, and all ten source/project artifacts unchanged;
physical ARM64 remains gated. S001 proves an exact no-edit Save All across SDK source, Designer, neutral resx, and
project bytes. S011 proves concrete generic-base inheritance and now stays on the live net48 interpreted path instead
of a false `baseTypeChanged` compiled fallback. S012 proves that Visual Studio opens a missing-`InitializeComponent`
Form as a blank surface; the product now matches that bounded open as an explicitly read-only surface without
synthesizing source, while Visual Studio's neutral-resx creation on Save All remains an unclaimed difference. S015
clicks the exact shared pixel of two actual designer Labels through `InputShield`; native Properties reports
`Text=Top z-order` for the first `Controls.Add` sibling and all project inputs remain exact. The repository hit-test
matches the same WinForms index-0-first rule; physical ARM64 remains external. S009
proves that Visual Studio refuses a nested `Outer.InnerForm` with its no-designable-class error page; the product now
  matches that result in the pre-render owner gate and preserves both partials and the project. S021 records a real
  two-Button designer drag by `+17,+9`: both Locations change in one Visual Studio transaction, one Undo restores both,
  one Redo reapplies both, and the product CustomEditor matches the same transaction semantics. S022 records a real
designer east-handle drag from 120×30 to 160×30 with unchanged `Anchor` and `Location`; the product uses the same
engine-authorized resize path as its canvas, changes only `Size`, and passes one native Undo/Redo unit on both supported
VS Code host lines. S029 executes Visual Studio's native `Format.AlignLefts` over three selected Buttons and matches its
exact two-`Location` patch through the product's canvas-equivalent `applyAlign` transaction with one native Undo/Redo
unit. S030 executes Visual Studio's native `Format.MakeSameWidth` over the same selection shape and matches its exact
  two-`Size` patch, unchanged heights/Locations, and one native Undo/Redo unit through product `applyResize`. S031
  selects the nested net48 Button through the actual owner-drawn Document Outline and executes native
  `Format.CenterHorizontally`: X changes `15→80`, Padding does not shift the complete-client-area center, and the product
  now matches the same WinForms integer truncation with one native Undo/Redo unit on both host lines. S037
  follows the actual categorized Properties trace: `Text=Button reference` is visibly non-default/bold,
  `Enabled=True` is default/non-bold, the Text description is exact, and the product Properties panel matches those
  category/default/description semantics without mutation. S038 selects an actual Button and TextBox together, exposes
  one blank mixed `Text` row plus only the common property intersection, and matches the repository multi-property
  contract; physical ARM64 remains external. S039 opens the actual in-process net48 designer, selects `button1` through
  the visible legacy Document Outline, verifies `Text=Custom reset text`, and invokes the enabled Property Browser Reset
  handler. The exact patch removes only `this.button1.Text`; net48 CodeDOM preserves `this.` qualifiers and siblings,
  canonicalizes four separators, adds one pre-close blank line, rewrites only the generated region to CRLF, and preserves
  source/project bytes. The repository Reset path proves the matching bounded mutation.
  S017 replaces the catalog's former full-containment assumption with an observed actual-Visual-Studio rule: a marquee
  inside an active Panel selects every intersecting direct child, including a partially intersected Button, but neither
  a nonintersecting sibling nor Form-level controls. A reversible native Copy/Paste probe proves the exact three-control
  identity set while the marquee/Copy bytes stay exact; the product now matches the same intersection/container rule.
  S041 opens the actual native `FlatStyle` list and records
  its exact child order `Flat, Popup, Standard, System` with `Standard` selected; the product publishes the same closed
  list and selection without mutation on both host lines. S042 expands the actual modern PropertyGrid `Padding` row,
  commits `Left: 3→8` through the child editor, preserves `Top/Right/Bottom` and source/project bytes, and matches the
  repository's bounded subproperty transaction despite Visual Studio's exact first-write CodeDOM canonicalization.
  S053 executes actual `View.Toolbox`, enters `Button` through the real `Search Toolbox` UIA ValuePattern, observes the
  exact live count `2 results found`, and reads the native MSAA hierarchy
  `Toolbox → All Windows Forms → Button` beside `RadioButton`; source, Designer, and project bytes remain exact. The
  repository independently proves `System.Windows.Forms.Button` framework provenance and `Common Controls`
  categorization; the reference claim remains bounded to the observed Visual Studio search result. S049
double-clicks the actual Visual Studio designer Button, creates exactly one default Click subscription and one handler,
navigates the DTE cursor into the method, and preserves project bytes. The product resolves the same default event and
commits the generated-source wiring plus code-behind insertion as one compensated history unit: both buffers remain
dirty until explicit Save, one native Undo restores both, and one native Redo reapplies both on both host lines. The
adjacent S050 actual Visual Studio path selects the already-wired `button1_Click` through the native Events surface,
commits that same value through the real writable child editor, and preserves exact source/Designer/project bytes with
one subscription and one method. The product's real Events `setHandler` ingress independently proves the matching
 clean-buffer/disk-exact no-op on both host lines; physical ARM64 remains external. S051 then exercises the real
 compiled-net48 CustomEditor revision race: a
 code-behind handler rename after engine validation makes the final dual-revision gate refuse stale Designer wiring,
 keep the Designer clean, and preserve both disk hashes; after exact revert and authoritative re-render the stable
 rewire changes one subscription and passes one native Undo/Redo unit on both host lines. Its archived actual Visual
 Studio 18.7 x64 reference selects `textBox1` through the native Document Outline, commits the compatible alternate
 through the real Events editor, and retains only the currently wired empty handler across rewire/Undo/Redo while
 preserving project bytes and all unrelated source/Designer semantics. S052 proves the generation sibling on both runtime lanes: after the engine emits
a valid new Click stub, a deterministic edit to the real code-behind `TextDocument` makes modern SDK and compiled-net48
CustomEditors retain the independent edit but commit neither stub nor subscription, leave Designer clean, and preserve
both disk hashes on both host lines. Its Visual Studio reference leg remains external. The S031 product leg now centers
a nested net48 Button at the actual Visual Studio X=80 result in an odd-width, asymmetrically padded Panel through the
real CustomEditor with an exact one-`Location` patch and native Undo/Redo on both host lines. The
catalog's ARM64 leg remains physically gated. For the three captured render
fixtures, the real modern S013 Button and net48 interpreted S014 TextBox product clients match their archived VS clients
at 0 / 64,800 differing pixels; S011 generic inheritance is also forced through the live interpreted path and stays
inside tolerance at 113 / 64,800 pixels (0.174383%, MAE/channel 0.149388). This bounded comparison is enforced by a CI
PowerShell harness. The final x64 performance pass also caught a cross-RID output-selection defect: a newer ARM64 DLL
could outrank a loadable x64/AnyCPU project output. The resolver now filters managed PE machine/CLR flags before
freshness ordering; focused architecture tests, the 522-test Modern suite, the real performance path, and the full
modern+net48 named-pipe corpus pass without the former foreign-architecture load warning.

Six further harness-only labels were removed where real product evidence already exists or could be made exact. S007
drives the registered Explorer `Add Component` command with `..\Injected`, receives `invalidName`, and preserves the
target directory on both host lines. S035 opens a compiled-net48 TabControl with page 2 selected and moves an external
TextBox through the engine-authorized reparent ingress: the Form owner is replaced by exactly one `tabPage2` owner,
live client coordinates become `(276,38)`, disk remains unchanged, and one native Undo/Redo unit owns both membership
and Location. Both Visual Studio reference legs remain `NOT_EXECUTED`.
S036 makes the old `splitContainer1.Panel2` identity genuinely stale by first renaming the SplitContainer through the
product, then proves real modern and compiled-net48 CustomEditors refuse the reparent without source, disk, or history
mutation; one native Undo removes the setup rename. S061 selects `button1` through the real canvas/outline session pick,
renames it to `submitButton` through the product, transfers the selected identity, rewrites every declaration/Name/C#
reference exactly once while preserving unrelated Text and `textBox1`, and binds the whole edit to one native
Undo/Redo unit on both host lines. Their actual Visual Studio references remain `NOT_EXECUTED`.
S024 now uses the actual shared designer clipboard on both runtime lanes: Copy of an existing `submitButton` is a no-op,
Paste into the same form generates non-colliding `button1` before commit, preserves the original and disk, applies the
8px paste nudge, selects the clone, and creates one native Undo/Redo unit. Its archived actual Visual Studio reference
proves collision-safe identity, property/owner preservation, and Undo/Redo on both runtime lanes while recording VS's
distinct `(98,74)` placement separately from the product's bounded nudge. S005 records the adjacent actual modern SDK
project-system baseline: Visual Studio resolves its installed `Microsoft.CSharp.WindowsForm` template, creates exactly
the source plus nested Designer and neutral-resx items, preserves the SDK `.csproj` byte-for-byte, rebuilds the solution,
and opens the generated Form in the native designer. Its bounded per-user `.csproj.user` `SubType=Form` sidecar is
allowed and hashed separately; any other top-level delta fails the capture. S063 binds the existing compiled-net48
outline drag/reparent evidence to its exact catalog row: `button1` moves from `panel1` to `groupBox1`, ownership changes
once, live GroupBox-relative Location becomes `(10,15)`, and one native Undo/Redo restores/reapplies both. Its actual
Visual Studio reference remains `NOT_EXECUTED`.
S062 closes the adjacent non-visual selection gap through a real modern CustomEditor. The accepted engine render keeps
`timer1` in the component tray and out of the visual-control tree; the shared tray/outline pick selects it and publishes
live Timer `Interval=250` and `Enabled=false` rows to Properties while source text, dirty state, native history, and disk
hashes remain unchanged on both host lines. Actual Visual Studio and physical Windows ARM64 remain external.
S064 then drives the same compiled-net48 outline ingress with the inverse unsafe move: placing `panel1` beneath its own
descendant `button1`. The rendered-tree gate returns the containment-cycle refusal before the engine or history runs;
Designer source, clean state, and both disk hashes stay exact on both host lines. Actual Visual Studio remains external.
S071 now drives the real in-repo MIT FakeVendor collection editor from live modern and compiled-net48 metadata through
the isolated worker. The worker's `[1,2] → [3,5]` outcome is treated as a proposal, proved component-local by the
bounded owned-region planner, and committed as one Lane B native Undo/Redo/final-Undo unit while disk remains exact.
S072 proves the corresponding fail-closed boundary: after the same worker succeeds, a proposal that also modifies root
`Form.Text` returns `OWNED_REGION_VIOLATION` without source, dirty-state, native-history, or disk mutation on either
host line. Licensed-vendor and actual Visual Studio certification remain external.
S020 closes the adjacent render/input race at the real product boundary. Canvas selection, move, resize, group move,
and nudge intents now carry the generation of the PNG actually shown; the open CustomEditor accepts only its current
render generation and returns `STALE_CANVAS` before mutation for an old, missing, or malformed value. Modern and
compiled-net48 Extension Host scenarios start a newer full render, prove that an old click and nudge cannot change
selection, source, dirty state, native history, or disk, then prove that the fresh generation is accepted on both host
lines. The webview's pending-image suppression remains a second responsive shield, not an authority shortcut.

The v2 target is deliberately larger than the old five-item host sketch: reach workflow and compatibility parity with
the **Visual Studio WinForms Designer** for the advertised support tiers, keep the UI native to VS Code, and be better in
the areas this project already owns — source safety, diagnostics, cross-runtime transparency, reproducible validation,
and recovery. It is not a plan to rebuild the Visual Studio code editor, Roslyn, debugger, Test Explorer, Git, or NuGet;
those remain integrations with the VS Code/C# toolchain.

The complete execution contract is
[docs/roadmap-v2.0.0-implementation-plan.md](docs/roadmap-v2.0.0-implementation-plan.md). It contains the
capability matrix, exact current code seams, target modules, phase IDs, dependencies, corpus, performance objectives,
risk/cut rules, Definition of Ready/Done, and the conjunctive GA gates.
The Data Sources surface is now product-bound as well: S082 refreshes a real `Customer` schema and commits the full
grid/BindingSource/navigator graph as one native history unit; S084 proves typed `UNSUPPORTED_DATA_PROVIDER`
no-mutation refusal through real modern and compiled-net48 CustomEditors.
S025 now has an exact actual-Visual-Studio baseline-snap transaction: a raw Button Y `36` snaps to Y `35` so its
baseline offset `21` aligns with the TextBox offset `16`. Product rendering publishes those same baselines and gives the
baseline candidate Visual Studio-compatible precedence over the nearer center candidate.
S026 now has an exact actual-Visual-Studio SnapToGrid transaction: with the effective 8×8 parent grid, an AutoSize Label
at `(13,25)`, Size `57×15`, dragged to raw `(33,25)` persists at `(32,24)` without changing its size or unrelated
artifacts. The capture restores the exact original designer options, and the full-frame webview scenario independently
matches the move and grid-aware resize. The 29-scenario control run terminates with 22 `PASS`, 6
`CAPTURED_UNREVIEWED`, 1 `NOT_EXECUTED`, and 0 `FAIL`; the later focused S017, S110, S061, S062, S046, and S045
 promotions raise the then-current bounded reference count to `34/94` and do not close W4. The subsequent focused S051
 Events rewire promotion raises that historical count to `35/93`; focused S079 native RTL geometry raises the next
 historical count to `36/92`, focused S085 inherited-property override raises the next historical count to `37/91`,
 focused S086 locked inherited Properties raises the next historical count to `38/90`, focused S087 native Toolbox Add
 raises it to `39/89`, and focused S088 cross-runtime private-inherited drag refusal raises the current count to `40/88` without
 closing W4. S110 freezes the actual designer UIA roles, names, onscreen state,
raw-view ancestry, and bounds for Button, TextBox, MenuStrip/File item, and Timer/ComponentTray; physical ARM64 and
live assistive-technology acceptance remain external. S061 proves the native owner-drawn Document Outline selection →
Properties `(Name)` route: `button1` becomes `submitButton`, eight member references and the `Name` literal change once,
Text and `textBox1` stay semantically exact, and one native Undo/Redo owns the edit. Native outline F2 did not expose an
inline editor, so the product's matching atomic rename is parity while its F2 binding is only an additive shortcut.
S062 then selects the real `refreshTimer` in Component Tray and verifies native Properties `(Name)=refreshTimer`,
`Enabled=False`, and `Interval=1500` with byte-exact project inputs; the product matches the nonvisual
tray/session-pick → live Properties contract without mutation, while physical ARM64 remains external.
S046 additionally opens the real framework Color editor for explicit `BackColor=Red`, captures its owner-drawn
`Custom / Web / System` tabs and selected `Red`, then cancels with `Esc`; the value and all fixture hashes remain
exact. S045 then selects the exact native `Blue` Web-color row, commits canonical `Color.Blue`, and proves one native
Undo back to Red plus one Redo byte-identical to the applied Designer output without moving the control or changing
source/project bytes. Product apply/cancel semantics match; physical ARM64 remains open where catalogued.
S079 additionally opens the exact classic-net48 RTL fixture in actual Visual Studio, normalizes the mirrored native
client coordinate system, and proves Button `(20,30,90×28) → (210,30,90×28)` plus Label
`(50,82,80×20) → (190,82,80×20)` inside a `320×160` client with source, Designer, and project bytes unchanged.
S085 additionally opens the exact modern derived Form, selects its protected inherited Button through the native
designer and Properties, and freezes Visual Studio's single derived `Text` override plus semantic Undo/byte-exact Redo
boundary without changing either base artifact, derived code-behind, or project.
S086 additionally opens a separate exact modern derived Form, selects the private inherited Label with its native lock
glyph, proves the native `Text` row is disabled and rejects `ValuePattern.SetValue`, and preserves both base artifacts,
derived code-behind, derived Designer, and project byte-exact. This reference is x64; physical ARM64 remains gated.
S087 additionally opens the exact classic-net48 derived Form over a compiled protected-Panel base, invokes the exact
native Toolbox Button default action, and freezes its derived-only CodeDOM/Undo/Redo boundary without changing any base
artifact. S088 additionally executes the private inherited-Button drag refusal on actual modern and classic-net48
designers, preserving exact bounds, observable Saved/Undo states, and all ten artifacts; physical ARM64 remains gated.
The closure audit is
[docs/release-2.0.0-gate-record.md](docs/release-2.0.0-gate-record.md): the scenario catalog validates with 111
repository `PASS`, 12 `NOT_EXECUTED`, and 5 explicitly excluded Tier-D `GATED` scenarios. Nine runtime reports provide
235 result rows, 152 unique scenario/suite pairs and 5,203 assertion executions; the mutation self-test proves that
removing an executed anchor invalidates the associated catalog PASS. The current frozen x64/ARM64 pair at
`.codex-tmp/release-2.0.0-remaining-fixes-20260826` includes the exact S088 cross-runtime private-inherited
 drag refusal, the exact S087 classic-net48 native Toolbox Add/Undo/Redo contract, the exact S086 actual-Visual-Studio locked
 inherited-Label/Properties evidence, the exact S085 inherited property override/native-Undo/Redo evidence, the exact
 S079 actual-Visual-Studio RTL geometry evidence, and the exact S025 actual-Visual-Studio baseline
snap/product correction, exact S026 actual-Visual-Studio 8×8 SnapToGrid/full-frame product evidence, S017 actual
Visual Studio active-container marquee intersection and matching product correction, the real S124 worker-recovery, S095
hosted-designer process-crash quarantine, S089/S090 modern hosted-service action, S031 actual Visual Studio
CenterHorizontally parity, S015 actual Visual Studio overlapping-label z-order hit testing, S038 actual Visual Studio multi-object Properties intersection, runtime-matching net48 S039
Reset parity, S041 native FlatStyle standard-values parity, S042 expandable-Padding parity, S050 actual Visual Studio
existing-handler no-op, S053 actual Visual Studio native Toolbox search/category/provenance, S024 actual Visual Studio
cross-runtime native clipboard collision/Undo/Redo, S005 actual Visual Studio native modern-SDK Windows Form item
creation with exact nested project hierarchy and byte-identical `.csproj`, S006 actual Visual Studio classic-project
UserControl creation with the exact two-file/Compile/DependentUpon graph and no initial resx, the refreshed autonomous
S049 modal lifecycle, S110 actual Visual Studio accessibility roles/ancestry/bounds, S061 actual Visual Studio
 Document Outline selection/Properties-name atomic rename, S062 actual Visual Studio Timer tray selection/Properties,
 S046 actual Visual Studio `BackColor=Red` framework Color editor open/Escape-cancel evidence, S045 actual Visual Studio
 framework Color editor Blue apply/native-Undo/Redo evidence, S051 actual Visual Studio classic-net48 native Events
 rewire/empty-handler lifecycle evidence, S079 actual Visual Studio classic-net48 native RTL mirroring evidence,
 S085 actual Visual Studio protected inherited-property override/native-Undo/Redo evidence,
 S086 actual Visual Studio private inherited-Label locked-Properties evidence,
S120 bounded
Visual Studio move/save parity,
S122 real product-telemetry/high-DPI paths, and
 the S100/S108 real Extension → Visual Studio → Extension reopen corpus. It passes package/RID/PE checks (x64 SHA-256
 `015A292F1800C8B114101D3A27C0EA8265AC203779C088FA271F592CF9EB5EFA`, ARM64 SHA-256
 `6F9AD2E4003EE7A6EC029DFD67C00BBE8C21505B9E2EEF80526E2D8C58B1D949`), but the live working tree is dirty while HEAD
is still at exact tag `v1.9.0` and tag `v2.0.0` is
 absent. Forty actual Visual Studio traces pass while 88 remain `NOT_EXECUTED`; therefore release identity,
the wider real-parity program, and the unqualified parity/GA claim remain `NO-GO`.

### What “Visual Studio parity” means

- **Exact parity** for core designer results: component graph, layout, persisted semantics, keyboard/mouse gesture outcome,
  and undo boundary match the reference workflow even though the chrome remains VS Code-native.
- **Workflow parity** where platform UI differs: the task completes without a manual source edit or an unexplained extra
  recovery step.
- **Compatible parity** on disk: representative forms round-trip extension → Visual Studio → extension without semantic
  drift or unrelated source/resource/project changes.
- **Superior workflow** where this extension can safely do more: capability inspection, human-readable patch preview,
  headless CI validation, accessibility/DPI/localization advice, redacted diagnostics, and recovery history.
- A partial, stale, silently degraded, or data-losing imitation never counts. Unsupported work is disabled before mutation
  with a stable reason, target, support tier, and recovery action.

### Long-term unqualified GA product surface — not claimed by the bounded 2.0.0 repository release

- **Documents and projects:** Form/UserControl creation, partial/base/project resolution, SDK/classic project inclusion,
  save/hot-exit/external-change safety, and atomic multi-artifact undo/redo.
- **Design surface:** real framework/project/vendor controls; mouse and keyboard selection; move/resize/reparent/z-order;
  clipboard/duplicate; grid/snapline/Alt modes; margin, padding and baseline guides; complete standard layout-container,
  tab, menu, toolbar, outline, and component-tray workflows.
- **Properties and events:** categorized/alphabetical/search and multi-object property grid; mixed/default/reset values;
  bounded converters; supported framework/vendor modal/dropdown editors; collections; events/default-event double-click;
  code/designer navigation and semantic-rename integration.
- **Resources, localization and data:** project/form resources, images/icons/ImageList, neutral/culture overlays, RTL,
  Data Sources, bindings, generated detail/grid/navigation controls, settings, and bounded visual inheritance overrides.
- **Extensibility:** a real, contract-tested design-time service kernel for supported ControlDesigner behavior, adorners,
  verbs, DesignerActionList, toolbox, converters/editors, plus a versioned vendor adapter SDK. A service whose invariants
  are incomplete is reported unavailable instead of being faked.
- **Runtime and vendor tiers:** modern .NET `win-x64` / `win-arm64` plus net48 x64 compatibility. Tier D
  (`x86`, `COM`, `ActiveX`) is excluded by name from v2.0.0 GA. Of the three, only ActiveX-bearing Designer source
  has a product-wired fail-closed refusal before render or mutation; x86 project/output detection and a COM
  request/refusal contract are gated and not executed. Certified vendor versions are named from
  archived manifests; untested vendors remain best-effort generic support.
- **Product quality:** keyboard and assistive-technology operation, high contrast, all shipped locales, native RTL/culture
  acceptance, bounded worker resources, crash recovery, migration/self-repair, clean-machine packages, and exact evidence.

### Architecture contract

- Decompose the current session, render, RPC, webview and net48 coordination concentrations behind characterization tests
  before adding the hosted platform. v2 must not place a second architecture inside today’s largest files.
- Route every UI, smart-tag, vendor-editor, quick-fix and automation mutation through one typed command lifecycle:
  capture revisions → plan a PatchSet → authorize → atomically commit → one undo unit → reconcile → independently verify.
- Generate TypeScript/C# protocol bindings from one versioned schema. Every request carries session/document/request,
  revision/generation, capability, deadline/cancellation and source/resource fingerprints; stale replies cannot win.
- Supervise disposable workers by runtime × architecture × project × trust tier, with STA/message-pump ownership,
  dependency isolation, deadlines, memory/GDI/USER-handle budgets, crash-loop limits, unload and rebuild coordination.
- Preserve two persistence lanes: the existing minimal source adapters by default, plus a designer-owned-region serializer
  only where ownership and semantic preservation are independently proven. Workers never write workspace files directly.
- Treat compiled project/vendor design-time code as **trusted to execute**, not sandboxed. Hosted vendor services require a
  trusted workspace, explicit per-workspace enablement and provenance; process/AppDomain/ALC isolation is for lifecycle
  and recovery unless a separately verified OS sandbox exists.

### Delivery waves

0. **Definition and kill spikes:** freeze at least 100 reference scenarios; approve ADR 0003; prove modern/net48 hosted
   Form/UserControl, designer/editor broker, dual-lane Visual Studio round-trip, worker recovery, performance, and the
   legal/dependency route. The repo-side managed baseline is approved for planning, while legal/vendor/physical
   hardware/publication decisions remain gated or not executed. Keep x86/COM/ActiveX outside v2.0.0 GA.
1. **Architecture runway:** characterize v1.x; split modules; introduce the schema-generated protocol, document store,
   PatchSet/journal, worker supervisor, capabilities, N/N−1 compatibility, migration and self-repair with zero behavior
   or source-output regression.
2. **First-party parity:** finish the standard-control layout, properties, events, toolbox, resources, scaffolding,
   containers and the surviving 1.8–1.15 scope on modern and net48 live-source tiers.
3. **Hosted extensibility:** land the service kernel, designers/verbs/action lists, converter/editor broker, approved
   designer-owned serialization, adapter SDK, and hostile design-time component corpus.
4. **Runtime/vendor certification:** complete the advertised managed runtime/bitness matrix and certify named vendor cohorts with
   Visual Studio references, exact diffs, fallback reasons, timings, licenses and lifecycle evidence.
5. **Beyond-VS strengths:** capability inspector, patch preview, headless designer validation, design-time advisor,
   reproducible diagnostics and recovery timeline — all opt-in/previewed where they mutate.
6. **Beta hardening:** independent security review; 8-hour soak; 500 open/edit/close cycles; crash/build/disk conflicts;
   memory/handle/performance budgets; keyboard, screen-reader, high-contrast, locale and native RTL/culture acceptance.
7. **RC/GA:** freeze contracts, run the clean-machine/package/runtime/corpus/migration/rollback matrix from immutable
   artifacts, archive exact evidence, and obtain explicit product/legal/vendor/hardware/publication decisions.

With a stable 6–9 person cross-functional core, the detailed plan treats this as an approximately **18–30 month**
program, not a normal minor release; one maintainer should plan it as multi-year. These are capacity ranges, not calendar
commitments. Reduce advertised tiers or cohorts when capacity/evidence is absent — never safety, integrity, accessibility,
or truthfulness gates.

### Unqualified parity release-claim gates

- Tier A (Microsoft framework scenarios): **100%** required workflows on every advertised runtime/architecture.
- Tier B (custom managed controls): at least **98%** of the declared scenario corpus, every miss classified and
  non-mutating.
- Tier C (named certified vendors): at least **95% per advertised cohort**, zero silent mismatch/data loss, archived
  redacted certification manifest.
- Tier D (x86/COM/ActiveX): excluded by name from v2.0.0 GA; future 2.x support needs **100% of a newly advertised
  matrix** before any claim.
- Percentages never waive a single silent mutation, unrelated diff, arbitrary-source execution, cross-document overwrite,
  undisclosed stale canvas, partial transaction, or misleading capability claim.

**Unqualified-GA exit criterion:** all advertised parity tiers clear their exact scenario, integrity, security, cross-tool, protocol,
migration, reliability, performance, accessibility/localization, package and independent-review gates. Publication,
licensed-vendor access, physical hardware, legal approval and credentials remain explicit external PASS/GATED/NOT
EXECUTED decisions; repository-side evidence cannot stand in for them.

## Release rules

- The fail-closed safety boundary is permanent; a roadmap feature never ships by bypassing it.
- Every source/resource/project writer needs a bounded patch plan, exact-baseline conflict handling, one undo unit,
  rollback/compensation, and an independent proof that only the intended semantic change occurred.
- Features that touch multiple engines, runtimes, architectures or trust tiers require parity tests or a visible,
  documented capability difference. A skip, fallback, timeout or unavailable external cohort is not silently green.
- The bounded 2.0.0 package ships only the managed runtime baseline named above; x86/COM/ActiveX remains a non-mutating unsupported tier
  with stable diagnostics until a later release explicitly changes the support matrix.
- Compiled project/vendor code is trusted-to-execute. Workspace Trust and explicit design-time enablement gate loading;
  lifecycle isolation is never marketed as a security sandbox without a verified OS boundary.
- Protocol, configuration, cache, adapter and persistence-contract changes are versioned and ship migration, rollback and
  partial-update self-repair evidence.
- 1.x preserves project files, user settings, public workflows and the source-first safety contract. Any unavoidable
  compatibility break belongs in 2.0.0 with a documented migration path and rollback.
- “Visual Studio parity” is an evidence-backed release claim tied to the declared support tiers, not an aspirational label.
