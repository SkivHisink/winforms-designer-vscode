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
2.0 design-host problem. See the [1.4.0 completion record](docs/release-1.4.0-completion-plan.md).

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
net48/vendor stacks on ARM64, and Marketplace/Open VSX publication remain explicit external gates in the
[completion record](docs/release-1.4.0-completion-plan.md).

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
operations now share source-first, revision-checked, ownership-aware, collision-safe, fail-closed boundaries. The
terminal implementation and verification evidence is recorded in the
[v1.9.0 completion record](docs/release-1.9.0-completion-plan.md).

- **Explorer Add creates complete project items** ([#4](https://github.com/SkivHisink/winforms-designer-vscode/issues/4)).
  Windows Form and User Control produce a collision-checked `.cs` / `.Designer.cs` / `.resx` set and open in the
  designer; Component and Class produce complete code items. Static SDK projects use implicit inclusion, while
  classic/default-item-disabled projects receive exact item entries in the same undoable edit. Ambiguous, shared,
  dynamic/conditioned, wildcard, non-WinForms, and colliding shapes are refused before any file is created.
- **Rename a control.** `(Name)` is an editable design-time row in the property grid, with F2 on the canvas and in
  the outline. Both gestures reuse the proven component-tray rename path; code-behind references remain fail-closed.
- **Double-click creates the default event** ([#5](https://github.com/SkivHisink/winforms-designer-vscode/issues/5)). The control's real `DefaultEventAttribute` (Button → Click,
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

- Editing a property once for a multi-selection: intersect the browsable, writable, type-compatible properties of
  every selected component instead of showing only the primary selection.
- Mixed values are displayed as mixed and never silently propagate the first control's value to the rest.
- One prevalidated, revision-checked transaction covers all targets and undoes as a single unit; a stale
  revision, inherited/read-only member, or unrepresentable target writes nothing at all.
- Multi-object Reset only where every target has a representable reset.
- Categorized / Alphabetical toggle, with search behaving identically in both modes.

**Exit criterion:** editing or resetting a shared property across heterogeneous controls produces exactly the
per-control source splices, one undo step restores all of them, and a single ineligible target causes zero
partial writes.

## 1.11.0 — Precision layout

- Layout modes — `SnapLines`, `SnapToGrid`, `None` — with configurable grid size and an optional visible grid.
  **Align to Grid** stops being a permanently disabled menu entry. The 1.8.0 per-gesture Alt suppression stays.
- Snaplines become Margin/Padding-aware, so a control snaps at its declared margin distance the way VS does,
  instead of only edge-to-edge and center-to-center.
- Text-baseline snaplines for label/textbox-class controls, measured by the engine so font, DPI, and zoom cannot
  drift the guide away from the rendered text.
- Horizontal/vertical spacing **Increase**, **Decrease**, and **Remove** alongside the existing Make Equal.
- `Ctrl` + drag duplicates a control in place of moving it, reusing the proven copy/paste transaction.

**Exit criterion:** move, resize, spacing, and grid operations are deterministic across nested containers, zoom
levels, and DPI scales on both engines; repeated gestures round-trip without accumulating coordinate drift.

## 1.12.0 — Toolbox creation and placing

- Toolbox double-click inserts a default-sized control into the active container.
- Dragging a rectangle from a selected toolbox item creates the control at exactly that size, instead of always
  dropping a default-sized control at a point.

**Exit criterion:** both creation gestures select the new control and round-trip the exact intended parent, size,
and position on modern and net48 projects; an ineligible container or stale source leaves the document unchanged.

## 1.13.0 — Assets and menu/toolbar productivity

- Resource-valued properties (`Image`, `BackgroundImage`, `Icon`, …) can pick an existing project resource, not
  only import a file into the form's own `.resx`. Only losslessly representable resource forms are offered.
- On-canvas drag to reorder and reparent `ToolStrip` / `MenuStrip` items, complementing the existing add, rename,
  delete, and type-picker gestures.
- Separators and **Insert Standard Items** for the standard menu and toolbar skeletons.
- Unknown item statements and unknown `.resx` entries stay byte-identical; an operation that cannot be
  represented is the only thing disabled.

**Exit criterion:** assets and strip structures survive save, reopen, build, undo, and redo with only the
intended regions changed, and a binary or structurally unknown resource fails before any mutation.

## 1.14.0 — Visual inheritance overrides

- Classify inherited members by ownership **and effective accessibility** instead of one blanket read-only rule,
  so `public`/`protected` inherited controls can take allowlisted property and layout overrides.
- Overrides are emitted only in the derived class; the base form is never modified as a side effect.
- Private, unresolved, vendor-dependent, and last-build-mismatched nodes stay visibly inherited and read-only.
- Reconcile derived overrides when a rebuilt base changes identity, type, accessibility, or available properties.

**Exit criterion:** a derived-form matrix proves accessible inherited controls can be overridden and inaccessible
ones cannot, the base source stays untouched, and a base-version mismatch fails closed rather than guessing.

## 1.15.0 — Bounded data-binding productivity

- A Data Sources pane for recognized object/list types and the binding components already in the form.
- Drag-to-generate a curated set of detail and tabular controls with their `BindingSource` and `BindingNavigator`
  wiring, from allowlisted source patterns only.
- `DataGridView` column generation from known schema metadata that preserves hand-written columns.
- Application-settings binding for recognized project/settings formats.
- Unsupported providers, custom generators, and runtime-only schemas are named as unsupported rather than guessed.

**Exit criterion:** representative list, detail, navigation, grid, and settings samples build and reproduce their
designer state after reopening; an unsupported schema changes no files.

## 2.0.0 — Visual Studio-class extensible design-time platform

**Status: implementation blueprint ready; Phase 0 architecture, legal, hosting, round-trip, and bitness gates are not yet passed**

The v2 target is deliberately larger than the old five-item host sketch: reach workflow and compatibility parity with
the **Visual Studio WinForms Designer** for the advertised support tiers, keep the UI native to VS Code, and be better in
the areas this project already owns — source safety, diagnostics, cross-runtime transparency, reproducible validation,
and recovery. It is not a plan to rebuild the Visual Studio code editor, Roslyn, debugger, Test Explorer, Git, or NuGet;
those remain integrations with the VS Code/C# toolchain.

The complete execution contract is
[docs/roadmap-v2.0.0-implementation-plan.md](docs/roadmap-v2.0.0-implementation-plan.md). It contains the
capability matrix, exact current code seams, target modules, phase IDs, dependencies, corpus, performance objectives,
risk/cut rules, Definition of Ready/Done, and the conjunctive GA gates.

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

### GA product surface

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
- **Runtime and vendor tiers:** modern .NET x64/ARM64 plus net48 x64; x86/COM/ActiveX only if the explicit Phase 0
  feasibility, security, redistribution and packaging gates pass. Certified vendor versions are named from archived
  manifests; untested vendors remain best-effort generic support.
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
   legal/dependency route. Remove x86/COM or generic vendor claims if their spikes fail.
1. **Architecture runway:** characterize v1.x; split modules; introduce the schema-generated protocol, document store,
   PatchSet/journal, worker supervisor, capabilities, N/N−1 compatibility, migration and self-repair with zero behavior
   or source-output regression.
2. **First-party parity:** finish the standard-control layout, properties, events, toolbox, resources, scaffolding,
   containers and the surviving 1.8–1.15 scope on modern and net48 live-source tiers.
3. **Hosted extensibility:** land the service kernel, designers/verbs/action lists, converter/editor broker, approved
   designer-owned serialization, adapter SDK, and hostile design-time component corpus.
4. **Runtime/vendor certification:** complete the advertised runtime/bitness matrix and certify named vendor cohorts with
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

### Release-claim gates

- Tier A (Microsoft framework scenarios): **100%** required workflows on every advertised runtime/architecture.
- Tier B (custom managed controls): at least **98%** of the declared scenario corpus, every miss classified and
  non-mutating.
- Tier C (named certified vendors): at least **95% per advertised cohort**, zero silent mismatch/data loss, archived
  redacted certification manifest.
- Tier D (x86/COM/ActiveX): **100% of the advertised conditional matrix** or it is excluded by name from v2 GA.
- Percentages never waive a single silent mutation, unrelated diff, arbitrary-source execution, cross-document overwrite,
  undisclosed stale canvas, partial transaction, or misleading capability claim.

**Exit criterion:** all advertised parity tiers clear their exact scenario, integrity, security, cross-tool, protocol,
migration, reliability, performance, accessibility/localization, package and independent-review gates. Publication,
licensed-vendor access, physical hardware, legal approval and credentials remain explicit external PASS/GATED/NOT
EXECUTED decisions; repository-side evidence cannot stand in for them.

## Release rules

- The fail-closed safety boundary is permanent; a roadmap feature never ships by bypassing it.
- Every source/resource/project writer needs a bounded patch plan, exact-baseline conflict handling, one undo unit,
  rollback/compensation, and an independent proof that only the intended semantic change occurred.
- Features that touch multiple engines, runtimes, architectures or trust tiers require parity tests or a visible,
  documented capability difference. A skip, fallback, timeout or unavailable external cohort is not silently green.
- Compiled project/vendor code is trusted-to-execute. Workspace Trust and explicit design-time enablement gate loading;
  lifecycle isolation is never marketed as a security sandbox without a verified OS boundary.
- Protocol, configuration, cache, adapter and persistence-contract changes are versioned and ship migration, rollback and
  partial-update self-repair evidence.
- 1.x preserves project files, user settings, public workflows and the source-first safety contract. Any unavoidable
  compatibility break belongs in 2.0.0 with a documented migration path and rollback.
- “Visual Studio parity” is an evidence-backed release claim tied to the declared support tiers, not an aspirational label.
