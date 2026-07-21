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

**Status: current strengthened baseline**

- Stable modern .NET designer for `net8.0-windows`, `net9.0-windows`, and `net10.0-windows`.
- Experimental compiled .NET Framework 4.8 / DevExpress preview with source-first, byte-local edits.
- Capability preflight that names why a form can't be whole-file regenerated (binary-resource, unresolved base,
  unrepresentable statement); those forms stay editable via targeted byte-local splices, while a `Localizable = true`
  form is read-only outright. The experimental .NET Framework preview is build-based and discloses that a rebuild is
  authoritative.
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

## 1.1.0 — Absorbed into 1.0.0

The hardening work originally planned for 1.1.0 now ships in the strengthened 1.0.0 baseline above. There is
no separate compatibility step: existing 1.0 projects and settings remain compatible, common safe forms are
refused less often, cross-runtime preview parity is tighter, and failures are faster to localize.

## 1.2.0 — Data-bound forms

- Add first-class `BindingSource`, `DataSource`, and `DataBindings` workflows.
- Extend the DataGridView experience with cell-style, format-string, and binding-related editors.
- Improve component-tray lifecycle operations, icons, references, and common extender-provider workflows.
- Add safe cross-form copy/paste with reference validation and explicit handling of unavailable dependencies.

**Exit criterion:** a typical data-bound line-of-business form can be built and maintained without dropping
to generated code for routine binding work.

## 1.3.0 — General editor framework

- Replace more hard-coded collection cases with an editable `IList` / `IList<T>` collection framework.
- Surface expandable objects and vendor value types through `TypeConverter` metadata.
- Broker supported modal `UITypeEditor` operations through a cancellable, isolated host path.
- Unify complex editor changes into source-first transactions with one undo unit and the same fail-closed
  verification used by built-in editors.

**Exit criterion:** adding support for a new property or collection type usually requires metadata or a
small adapter, not a new end-to-end bespoke pipeline.

## 1.4.0 — Layout, inheritance, DPI, and ARM64

- Make inherited forms editable with explicit base/derived ownership and read-only rules.
- Add visual TableLayoutPanel / FlowLayoutPanel structure tools and outline drag/reparent/reorder.
- Move snap, drag, and layout constraints into the engine where real-form testing shows client-side geometry
  can drift.
- Verify HiDPI coordinate correctness across every supported scaling factor and fractional ratio (the crisp
  backing-store render itself shipped in 1.0.0).
- Publish a native Windows ARM64 package for the modern engine, with an explicit reduced-feature policy for
  .NET Framework and vendor controls that remain x64-only.

**Exit criterion:** complex nested layouts remain pixel- and source-correct across DPI modes, inheritance,
and supported Windows architectures.

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
