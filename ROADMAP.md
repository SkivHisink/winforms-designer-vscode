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

## 2.0.0 — Extensible design-time platform

**Status: next active roadmap milestone**

- Introduce an isolated design-time service host with the `IDesignerHost` / `IDesigner` services required by
  real `ControlDesigner` implementations.
- Execute supported third-party `DesignerActionList` and designer verbs instead of only displaying vendor
  smart-tag metadata and mapping a small safe subset to built-in operations.
- Run design workers under explicit runtime/architecture isolation policies with deterministic recovery,
  unload, timeout, and crash reporting.
- Define a versioned protocol and adapter surface for vendor-specific toolbox, property-editor, collection,
  and smart-tag integrations.
- Ship migration and self-repair paths for any setting, cache, or worker-protocol changes introduced by the
  new host.

**Exit criterion:** third-party control suites can participate through a documented design-time integration
surface rather than project-specific hard-coding, while the 1.0 fail-closed and no-silent-data-loss promises
remain intact.

## Release rules

- The fail-closed safety boundary is permanent; a roadmap feature never ships by bypassing it.
- Every source-writing feature needs byte-local or round-trip proof, undo/redo coverage, and conflict handling.
- Features that touch both engines require modern/.NET Framework parity tests or a documented, visible
  capability difference.
- 1.x releases preserve project files, user settings, and the public extension workflow. Any unavoidable
  compatibility break belongs in 2.0.0 with a migration path.
