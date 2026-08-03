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
  unresolved base, unrepresentable statement); those forms stay editable via targeted byte-local splices, while a
  `Localizable = true` form is read-only outright. A net48 form that exceeds the safe interpreter falls back to its
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

This is the headline 1.x milestone: forms that are deliberately read-only in 1.0 become safely editable.

- Implement the full `Localizable = true` workflow instead of treating `ApplyResources` as an unsupported
  statement.
- Read and write neutral plus per-culture `.resx` files, including the Visual Studio-style `$this.Language`
  culture switch.
- Make multi-file resource edits atomic, undoable, conflict-checked, and lossless for unknown or binary
  resource nodes.
- Add `RightToLeft`, `RightToLeftLayout`, RTL mirroring, and localized string/image editing.
- Add a cross-runtime golden corpus for neutral and translated forms so an edit in one culture cannot damage
  another culture.

**Exit criterion:** an internationalized enterprise form can be edited in multiple cultures without losing
fallback values, translations, binary resources, or source formatting.

## 2.0.0 — Extensible design-time platform

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
