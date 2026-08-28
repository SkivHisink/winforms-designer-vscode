# Release 2.0.0 gate record

Date: 2026-08-26  
Scope: live dirty working tree, repository implementation and local release artifacts  
Package version: `2.0.0` (`preview: false`)  
Repository verdict: **EVIDENCE INTEGRITY CLOSED; W0-W3 CLOSED; W4 PARTIAL; BOUNDED W5 PRODUCT SURFACE CLOSED; W6 LOCAL PACKAGE/METADATA CLOSED; GIT IDENTITY NO-GO**  
Unqualified Visual Studio parity / GA verdict: **NO-GO**  
Publication verdict: **NOT EXECUTED**

## Closure decision

The bounded repository/product work and the evidence-integrity remediation have been executed in this working tree.
W0-W3 and the bounded W5 product surface are repository-side closed; W4 remains partial, with forty real Visual Studio
traces and the other 88 explicitly left `NOT_EXECUTED`. The catalog now reports 111 measured repository `PASS`,
12 `NOT_EXECUTED`, and 5 `GATED`: ten caller-supplied capability-inspection/echo rows were removed from `PASS` rather
than presented as product execution. Nine machine-readable reports provide 235 result rows, 152 unique scenario/suite
pairs and 5,203 assertion executions, with direct file/line hashes for every declared PASS. A mutation acceptance test
proves that removing an executed assertion invalidates the affected PASS.

W6 has exact engine/package versions, one npm lock/toolchain, and the newly frozen/re-verified `vs41` x64/ARM64 VSIX
pair. The remaining immutable W6 failure is Git identity: the live tree is dirty, HEAD is still tagged `v1.9.0`, and
`v2.0.0` does not exist. Therefore the artifacts are authoritative **local dirty-tree package evidence**, but the
release tag/clean-checkout gate remains `NO-GO`.

This distinction is intentional:

- current repository progress is backed by final-tree unit/Vitest/webview/named-pipe evidence, strict measured-evidence
  validators, both supported VS Code Extension Host lines, the retained Visual Studio scenario manifests, and a fresh
  re-verified VSIX pair;
- every unavailable scenario remains `NOT_EXECUTED` or `GATED` in the catalog;
- 40/128 actual Visual Studio reference traces are archived as `PASS`; the other 88 remain `NOT_EXECUTED` with
  `referenceTraceId=UNSET`;
- no commit, tag, push, signing, Marketplace/Open VSX publication, rollout, or rollback drill was performed by this
  closeout.

The previous 1.15.0 boundary remains recorded in
[`release-1.15.0-completion-plan.md`](release-1.15.0-completion-plan.md). The larger, still-open parity program remains
defined by [`roadmap-v2.0.0-implementation-plan.md`](roadmap-v2.0.0-implementation-plan.md).

## Bounded repository surface prepared for release

### Protocol, persistence, and recovery

- [`v2/designer-protocol-v2.schema.json`](v2/designer-protocol-v2.schema.json) and
  [`../scripts/generate-v2-protocol.mjs`](../scripts/generate-v2-protocol.mjs) generate and verify the modern C#,
  net48 C#, and TypeScript protocol bindings from one schema.
- [`../extension/src/documentStore.ts`](../extension/src/documentStore.ts),
  [`../extension/src/patchSet.ts`](../extension/src/patchSet.ts),
  [`../extension/src/transactionJournal.ts`](../extension/src/transactionJournal.ts), and
  [`../extension/src/transactionRunner.ts`](../extension/src/transactionRunner.ts) implement exact-baseline capture,
  validation, atomic application, postcondition checks, compensation, journal recovery, and undo registration.
- [`../extension/src/resourceTransactionCoordinator.ts`](../extension/src/resourceTransactionCoordinator.ts) is used
  by real localized-resource commands. Make Localizable flushes the converted `.Designer.cs` inside the transaction
  runner's undo-registration phase; a source-flush failure rolls the `.resx` back and does not report success.
- [`../extension/src/workerSelection.ts`](../extension/src/workerSelection.ts) and
  [`../extension/src/workerSupervisor.ts`](../extension/src/workerSupervisor.ts) cover runtime/architecture selection,
  generation tracking, cancellation, crash accounting, recycle, and quarantine handoff for the diagnostics probe.
  Normal render/edit traffic does not use this supervisor. [`../extension/src/v2Migration.ts`](../extension/src/v2Migration.ts)
  is an experimental contract-test module: activation does not persist or migrate that cache shape.

### Managed designer workflows

- Standard-control selection, z-order hit testing, grouped manipulation intents, snap/grid/layout commands,
  reparenting source paths, property-grid modes, converter metadata, toolbox discovery, outline/menu/collection
  operations, resources/localization/inheritance, Data Sources, diagnostics, headless validation, and advisor flows
  have bounded repository evidence.
- The real VS Code Extension Host product path now proves clean CustomEditor open/save, aggregate fail-closed Save As
  collision detection across nested form artifacts, SDK Form Add, classic UserControl Add with atomic `.csproj`
  persistence, unsafe Add-name refusal, generated-source `STALE_SOURCE` save refusal, partial-Add compensation,
  ambiguous/missing-owner pre-render refusal, a two-control engine-authorized move, and default-event generation across
  `.Designer.cs` plus code-behind with one native Undo/Redo gesture. Selecting the already-wired handler through the
  real Events `setHandler` ingress is also proved as a clean, byte-identical no-op.
- The real webview scripts expose keyboard-addressable commands and resize handles, accessible component mirrors,
  forced-colors styling, and 200%/400% keyboard paths. This is repository/jsdom evidence, not physical screen-reader,
  OS high-contrast, or hardware acceptance.
- Modern and net48 converter metadata calls are bounded. A stalled `TypeConverter` publishes
  `CONVERTER_TIMEOUT`, offers no stale dropdown, and does not poison a later healthy query.
- SplitContainer `Panel1`/`Panel2` are real selectable/drop targets; Table/Flow/Split layout behavior, drop feedback,
  `AutoSize`/Dock geometry, custom/vendor modern geometry, and stateful `ProgressBar.Value` rendering are product-tested.
- Real `DesignerActionList` metadata replaces the former property-name smart-tag heuristic. Framework
  `CollectionEditor` runs through the isolated worker path, while unsupported editor/item shapes remain inert or
  fail-closed.
- Project-wide partial event discovery, typed DataSet generation, `.sln`/`.slnx` owner resolution, classic
  `<TargetFrameworkVersion>`, inline `InitializeComponent`, and derived-source-only inherited overrides for verified
  custom/vendor controls are covered by modern/net48/product E2E.
- Localizable forms now support journaled structural Add/Delete/Reparent and bounded event wiring in the Default
  language. On VS Code 1.84 the transaction watcher no longer mistakes its own generated-source write for an external
  edit and roll the operation back.

### Bounded hosted/editor product surface

- [`../engine/DesignerServiceKernel.cs`](../engine/DesignerServiceKernel.cs) contains the fail-closed hosted-service
  kernel. S089/S090 product-adopt one exact modern repository-certified component/designer/action contract: all six
  required service capabilities, STA, assembly identity, one transaction, two changes, independent source planning,
  and one native Undo/Redo unit are verified. Incomplete `IDesignerHost`, unsupported services, forged certificates,
  stale revisions, arbitrary vendors, and the still-unproven net48/cross-runtime paths remain withheld or refused.
- [`../engine/DesignerUiTypeEditorBroker.cs`](../engine/DesignerUiTypeEditorBroker.cs),
  [`../engine/DesignerUiTypeEditorWorker.cs`](../engine/DesignerUiTypeEditorWorker.cs), and the net48 metadata path
  demonstrate one exact repository FakeVendor dropdown contract. Assembly path, SHA-256, certification ID, editor
  type, component/property/value type, and returned invariant value are revalidated. Wrong-type results produce
  `INVALID_EDITOR_RESULT` before mutation. Arbitrary vendor editors remain disabled.
- This FakeVendor proof is not a licensed third-party vendor certification and is not an OS sandbox claim.

### W2 product/runtime boundary

| Surface | 2.0.0 product truth |
|---|---|
| Hosted service kernel | **PRODUCT-WIRED / BOUNDED MODERN + NET48 CONTRACTS**; S089/S090 publish and invoke one exact certified modern smart-tag command through complete container/selection/change/name/command/toolbox capabilities and the ordinary source/native-history transaction. S091/S092 exercise the shared registry through the real compiled-net48 CustomEditor, refuse a nested designer transaction as `REENTRANT_CANCELLED`, restore the transient graph, return no source proposal, and preserve source/history/disk/process state. Arbitrary designers remain outside the claim |
| Generated v2 envelope | **DIAGNOSTICS ONLY**; generated bindings are drift-checked, while ordinary render/edit RPC remains on the established transport |
| v2 worker supervisor | **DIAGNOSTICS ONLY**; the exported diagnostics probe uses it, normal designer traffic does not |
| Established preview-engine lifecycle | **PRODUCT-WIRED / BOUNDED**; modern and compiled-net48 workers stay warm for a 30-second idle-reuse window after the last form closes, then the host waits for both child processes to exit before a later designer can start fresh workers. S104 proves the healthy modern PID stays warm, residency stays at exactly two children, a fail-closed net48 whole-worker replacement cannot coexist with its old PID, and the final idle path returns mapped/registered processes to zero on both supported host lines |
| Runtime/culture routing | **PRODUCT-WIRED / BOUNDED**; S101/S105 resolve real `net8.0-windows` and built `net48` projects to live host-owned modern/net48 workers, with the framework form publishing interpreted live-source authority. S079 drives ar-SA through the compiled-net48 Language path and captures exact mirrored geometry without mutation |
| Settings migration / adapter manifest | **HARNESS ONLY**; neither module is consumed by activation, settings persistence, or adapter discovery |
| Owned-region Lane B | **PRODUCT-WIRED FOR PROVEN MODERN SCALAR EDITS**; exact Lane-A text/semantic equivalence and outside-region byte preservation are required, otherwise source-first is used |
| Document store / hot exit | **BOUNDED PRODUCT USE**; transaction snapshots and Save As collision planning are product paths. S003 proves one unsaved move/one native Undo unit across real VS Code quit/restart for modern and compiled-net48 CustomEditors, using VS Code-owned backup bytes plus the workspace recovery index. Arbitrary multi-unit or multi-artifact history serialization is not claimed |
| Tier D | **PRODUCT-WIRED ACTIVEX SOURCE REFUSAL ONLY**; Designer source carrying an AxInterop/AxHost control refuses before render or mutation, for every declaration shape (any modifier, `readonly`/`static`, initializers, multiple declarators, `global::`, `using`-imported and aliased spellings, the construction site, and the `AxHost.State` marker of a re-namespaced interop assembly). General x86 project/output detection and COM-toolbox request refusal are **GATED / NOT EXECUTED** and are not part of the product-wired 2.0.0 claim: the x86 PE predicate is reachable only on the Framework route, nothing reads `PlatformTarget`/`Prefer32Bit`, and the COM tab is inert client-side text rather than a named refusal contract. Source-level ActiveX detection proves an unsupported COM/ActiveX route, not PE architecture |
| Headless/soak CLI | **DEVELOPMENT ONLY**; both bundles are excluded from the VSIX and forbidden by `assert-vsix.ps1` |

## Scenario catalog evidence

Command:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\validate-v2-scenario-catalog.ps1 `
  -EvidenceDirectory .codex-tmp\v2-scenario-evidence
```

Terminal result:

```text
V2-FND-001 scenario catalog validation PASS
Schema version: 1.2.0
Catalog version: 2.0.0-phase0.2
Scenario count: 128
Capability count: 32
Domain count: 23
Safety/refusal count: 51
Reference trace statuses: NOT_EXECUTED=88, PASS=40
Repository execution statuses: GATED=5, NOT_EXECUTED=12, PASS=111
Repository automation statuses: AUTOMATED=111, GATED=5, HARNESS_ONLY=11, NOT_AUTOMATED=1
Claim boundaries: HARNESS_ONLY=11, REPO_AUTOMATED=111, REPO_PARTIAL=1, TIER_D_EXCLUDED=5
Architecture legs: catalog-arm64=20, catalog-cross-arch=28, catalog-x64=69, catalog-x86=5, not-applicable=7, physical-arm64-gated=26, repo-functional=111, x86-com-gated=5
External gates: ACCESSIBILITY_AT=2, ARM64_HARDWARE=26, NONE=29, PERFORMANCE_LAB=3, VENDOR_ARTIFACT=25, VENDOR_LICENSE=3, VISUAL_STUDIO_REFERENCE_TRACE=88, X86_COM_HOST=5
V2-FND-001 runtime execution evidence PASS
Evidence reports: 9
Measured declared PASS: 111
Measured suites: e2e, extension-host, unit, webview
```

Each of the 111 repository `PASS` rows is present in a completed machine-readable report, has one or more direct
executed assertion anchors with current file/line and SHA-256 checks, and carries a `repo-functional` architecture leg.
The validator has no promoted-ID allowlist. Eleven harness-only rows remain repository `NOT_EXECUTED`; a synthetic
helper or caller-supplied expected result cannot become `PASS`. None of these repository
states is a Visual Studio-parity score. Only S001, S005, S006, S009, S011, S012, S013, S014, S015, S017, S021, S022, S025, S026, S029, S030, S031, S037,
 S038, S039, S041, S042, S045, S046, S049, S050, S051, S053, S061, S062, S079, S085, S086, S087, S088, S110, and S120 plus S024 and the S100/S108 cross-tool round trips have archived Visual Studio traces; 88 remain
`NOT_EXECUTED`.

### Actual Visual Studio reference evidence

The reproducible capture harness is
[`../scripts/capture-visual-studio-reference-traces.ps1`](../scripts/capture-visual-studio-reference-traces.ps1).
The authoritative public index is
[`v2/reference-traces/README.md`](v2/reference-traces/README.md): it contains exactly 40 direct links to retained
scenario `manifest.json` files. The candidate tree contains 284 scenario files / 5,391,418 bytes and no parent
`run-manifest.json`; raw parent/control runs and abandoned attempts remain local-only rather than being cited as public
release evidence.
All were captured from **Visual Studio Enterprise 2026**, DTE `18.0`, installation `18.7.11911.148`, on Windows AMD64.
The catalog validator now verifies each `PASS` manifest, exact authority/version, screenshot existence and SHA-256,
scenario/trace identity, and `byteIdentical=true` for a round-trip trace.
The product comparison harness is
[`../scripts/compare-visual-studio-reference-renders.ps1`](../scripts/compare-visual-studio-reference-renders.ps1);
its current archived run is
[`v2/reference-comparisons/VS18.7.11911.148-20260821T124034Z-product`](v2/reference-comparisons/VS18.7.11911.148-20260821T124034Z-product).
It hashes the VS inputs (including the S011 generic base), renders through the real modern and net48 interpreted
engines, compares the matching 360×180 client areas, and runs in CI with a frozen tolerance.

| Scenario | Actual evidence | Result boundary |
|---|---|---|
| S001 | Actual Visual Studio built and opened the SDK form, executed Save All without a designer edit, and preserved SHA-256 for `.cs`, `.Designer.cs`, neutral `.resx`, and `.csproj` exactly; screenshot SHA-256 `3ffe1766eceb5092ed1f384803ff767ebb25b082085a15625ce457d98bb9d379` | Reference `PASS` + existing repository Extension Host `PASS`; exact no-mutation evidence for this bounded fixture |
| S005 | Actual Visual Studio resolves the installed `Microsoft.CSharp.WindowsForm` template for the exact modern SDK project and creates `S005GeneratedForm.cs` with nested `.Designer.cs` and `.resx` ProjectItems. The SDK `.csproj` remains byte-identical, required file hashes are frozen, the only allowed auxiliary top-level delta is the per-user `.csproj.user` `SubType=Form` sidecar, the solution rebuilds, and the generated Form opens in the native designer; screenshot SHA-256 is `1b3217c12060c9e3b87e033b1fbf0a0d174be8eaa1191b838036bfa797b268b7` | Reference `PASS` + repository automated Add-item `PASS`; exact bounded project-system/file/hierarchy/build semantics without claiming package-manager or arbitrary-template parity |
| S006 | Actual Visual Studio resolves `Microsoft.CSharp.WindowsFormsUserControl` for the exact classic net48 project and creates only `S006GeneratedUserControl.cs` plus its nested `.Designer.cs`. The project gains exactly one source `Compile` with `SubType=UserControl` and one Designer `Compile` with `DependentUpon`, no neutral resx or `EmbeddedResource` exists, the solution rebuilds, and the UserControl opens in the native designer; screenshot SHA-256 is `a4c404b7935a7c5c92bc5dfad3656ea11187b087cdeddd28274b52b67f230be2` | Reference `PASS` + repository unit/Extension Host `PASS`; product Explorer Add was corrected to the observed two-file contract and persists the same classic project graph atomically without claiming arbitrary-template parity |
| S009 | Actual Visual Studio refuses the nested `S009Outer.InnerForm` with its no-designable-class page, screenshot SHA-256 `2993fb6ab502c2ff45e72126555796ab9e8f5b9ad2d3a689a9b473a2e7ed808e`, while both partials remain byte-identical | Reference `PASS` + repository Extension Host `PASS` on 1.84.0/1.134.0; the product returns `NESTED_DESIGNER_UNSUPPORTED` before render/mutation and preserves source, Designer, and project bytes |
| S011 | Actual Visual Studio resolves `S011GenericBaseForm<int>` and displays both the inherited Label and derived Button; screenshot SHA-256 `1a32e2337027afd4c27438de5efa8cb8f429e4ed969b6a0a20e4b8d9853a6053` | Reference `PASS` + repository automated pixel `PASS`; product uses `net48-interpreted` after fixing concrete generic-base identity and differs by **113 / 64,800 pixels (0.174383%, MAE 0.149388)**, within tolerance |
| S012 | Actual Visual Studio opens the proven empty Form as a blank designer surface, preserves `.cs`, `.Designer.cs`, and `.csproj` hashes, and creates neutral resx SHA-256 `4363cd7d5b8671c72442ce1a1bfc10d64ebd24b2d718b54bd4fcd025e4967298` on Save All; screenshot SHA-256 `52cb8bd5a1566ebfce28cdba2ae7d25b45bb4aafde53b1cf9a65508b5ec5b94a` | Reference `PASS` + repository Extension Host `PASS` on 1.84.0/1.134.0 for bounded blank read-only open and no input mutation; product neutral-resx generation and editing remain unclaimed |
| S013 | Visual Studio WinForms designer screenshot shows the standard Button with Information image, text, ImageBeforeText/MiddleLeft layout, and Popup border; screenshot SHA-256 `6a4151917e3b184cae2f1ba15b17258ca92d7cfe1cb1a6c65a7718d375338341` | Reference `PASS` + repository automated pixel `PASS`; modern product client is **0 / 64,800 pixels different**, client SHA-256 `4bf5b23978aecc8d6cc7da79fc46fca5bcc234af0484d9dd56151155e1c436ec` |
| S014 | Visual Studio net48 designer screenshot shows multiline text, a visible vertical scrollbar, and FixedSingle border; screenshot SHA-256 `5671eff22df3c8b7361e43af65f8b34453ece55789117f3c02635ec2a7c1a716` | Reference `PASS` + repository automated pixel `PASS`; net48 interpreted product client is **0 / 64,800 pixels different**, client SHA-256 `d48ac41a7f930e8b5219d2b0d23d5a28afd4422c62a8fa157bb1ee73470b501f` |
| S015 | Actual Visual Studio exposes `topLabel` and `bottomLabel` at identical `158×46` bounds, receives one shared-center click through the real designer `InputShield`, and publishes `Text=Top z-order` in native Properties for the first `Controls.Add` sibling at WinForms z-order index 0. Source/Designer/project hashes remain exact and screenshot SHA-256 is `b63e7abb10791952eb565c6547dbfd3e6d06f12a383048297d3090859012eb49` | Reference `PASS` + repository unit/webview `PASS`; product hit testing applies the same explicit WinForms z-order before layout order. Physical ARM64 remains external `GATED` |
| S017 | Actual Visual Studio drags a marquee inside a Panel through the real `InputShield`; two Buttons are fully enclosed, `partialButton` is only partially intersected, and Visual Studio selects all three. Native Copy preserves Designer SHA-256 `3211af8ddda929a3cf67436cf9b0611a9338b8c9a7f1cd7b6c2f6477da1711c7`; a reversible Paste creates exactly three Panel-owned clones with only `Enclosed A`, `Enclosed B`, and `Partial` duplicated, while the nonintersecting Panel child and both Form-level controls remain single. Undo restores the original semantic shape; modern CodeDOM block reordering is separately disclosed. Selected-state screenshot SHA-256 is `faf40dca57b896f540e99cfa5163b56f9bdb4b27d33a0955193160d34c663956` | Reference `PASS` + corrected full webview `PASS`; product now uses Visual Studio's positive-area intersection rule while preserving the active-container boundary, deterministic primary, and exact multi-selection delete payload |
| S021 | Actual Visual Studio multi-selected both Buttons and executed one real drag through the WinForms Designer `InputShield` and internal capture HWND; Locations changed `(21,27)/(50,60)` → `(38,36)/(67,69)`, live bounds moved exactly `+17,+9`, one native Undo restored both, one Redo reapplied both, source/project stayed byte-identical, and screenshot SHA-256 is `a1741c9472058f8d3b002d2df096d745e1b03fa0eadf9f0145d965d76df15e47` | Reference `PASS` + repository CustomEditor `PASS`; the product uses one engine-authorized two-control transaction, leaves disk untouched until Save, and one native VS Code Undo/Redo restores/reapplies both on 1.84.0 and 1.134.0 |
| S022 | Actual Visual Studio selected `anchoredButton` and dragged its east sizing handle by +40 physical pixels; live bounds changed 120×30 → 160×30, `Anchor` and `Location` remained exact, source/project stayed byte-identical, and screenshot SHA-256 is `a4b3d7b792a026f702121e57620215c8684e5cc8ed7c8d48174d4eae594c704e` | Reference `PASS` + repository CustomEditor `PASS` on 1.84.0/1.134.0; product changes only the `Size` assignment and one native Undo/Redo unit restores/reapplies it. Physical ARM64 remains external `GATED` |
| S024 | Actual Visual Studio independently runs native Copy/Paste on equivalent modern and net48 Forms with an occupied `submitButton`; both generate unique `button1` at `(98,74)`, preserve copied Text/Size and one root owner, Undo to the original shape, Redo the first serialization byte-exactly, and preserve source/project hashes. Modern/net48 screenshot SHA-256 values are `7b7516fae8eca70375202887fcc943f1fa169594d7baa65003f64637be297da2` and `2a2bb6cd215307594f8345c746fa93846bcf57b412b328a18032d38bc9894089` | Bounded reference `PASS` + repository CustomEditor `PASS` on both host lines for collision-safe identity/properties/ownership/history. Product uses its bounded 8px placement, so coordinate parity is not claimed; physical ARM64 remains external `GATED` |
| S025 | Actual Visual Studio gives the default 96-DPI `Button` baseline offset `21` and `TextBox` offset `16`; a real native drag to raw source Y `36` snaps to exact Y `35`. X/Size, reference-control geometry, source, and project stay exact, and Save All creates the standard empty neutral resx SHA-256 `d679c8de86ccb99ed1f69895706946ec8b2e9eed458dd6d7b8d5144cb3bb3cf5`; final screenshot SHA-256 is `83b4c3af6d2373e718d995c8aaaefe2b155b54847ac5f7fe2ad182aeecdbdc04` | Reference `PASS` + exact engine/webview product `PASS`; product publishes the same two baselines, translates through the full frame origin, and gives the baseline candidate precedence over the nearer center candidate |
| S026 | Actual Visual Studio temporarily uses exact `LayoutMode=1`, `ShowGrid=true`, `SnapToGrid=true`; an AutoSize Label at `(13,25)`, Size `57×15`, receives raw drag `(+20,0)` through the actual designer input HWND and persists at exact `(32,24)` on the effective 8×8 parent grid. Label size, reference Button `(190,96,110×30)`, source/project, and standard empty neutral resx remain exact; original options `0/true/true` are restored. The disconnected-desktop manifest honestly records `cursor-relative-capture-owned-window-offset`; final screenshot SHA-256 is `fc06ae80cdb284bd748db80407272b2fbdbcfbc33770193b6463f2069580ba6b` | Reference `PASS` + full-frame webview product `PASS`; product reproduces `(13,25) + (+20,0) → (32,24)` without size change and independently covers grid-aware resize |
| S029 | Actual Visual Studio selected all three Buttons and executed native `Format.AlignLefts`; X values changed `12,42,77` → `12,12,12`, all Y/Size values remained exact, source/project stayed byte-identical, exact Designer output SHA-256 is `6be1cc9f3116eb6381ac3f559156e16e9951aad2d767c0cf158a2916c067d2ff`, and screenshot SHA-256 is `3b5a1ecb64122785537bbfd7ea6f304cf27bb827b05cf8f96dca28f260a68d07` | Reference `PASS` + repository CustomEditor `PASS` on 1.84.0/1.134.0; product changes only button2/button3 `Location` assignments and one native Undo/Redo unit restores/reapplies both |
| S030 | Actual Visual Studio selected all three Buttons and executed native `Format.MakeSameWidth`; sizes changed `120×30,60×24,90×36` → `120×30,120×24,120×36`, all Locations/heights remained exact, source/project stayed byte-identical, exact Designer output SHA-256 is `50aefa158d326f2a33c064df015dbcc4c636ab6520afa5509506b9aefe221d0b`, and screenshot SHA-256 is `89fb035d16260e073ec727ab4d5b65ec60f2f42a9c53067e93890b731ea4c947` | Reference `PASS` + repository CustomEditor `PASS` on 1.84.0/1.134.0; product changes only button2/button3 `Size` assignments and one native Undo/Redo unit restores/reapplies both. Physical ARM64 remains external `GATED` |
| S031 | Actual Visual Studio selected nested `button1` through the real owner-drawn Document Outline and executed native `Format.CenterHorizontally`; relative X changed `15→80`, accessible bounds moved `+65`, asymmetric `Padding(10,0,20,0)` did not shift the complete-client-area center, the exact CodeDOM Location/trivia region matched byte-for-byte, source/project remained byte-identical, and screenshot SHA-256 is `9753ec2f6043c4ec2e31f360887ce27573bf49f4f0f30583e6228ad4f54c0416` | Reference `PASS` + corrected compiled-net48 CustomEditor `PASS` on 1.84.0/1.134.0; product uses the complete `ClientRectangle`, WinForms integer truncation, exact one-Location mutation, untouched disk before Save, and one native Undo/Redo unit |
| S037 | Actual Visual Studio selects `referenceButton` and exposes a categorized Properties grid with Accessibility/Appearance/Behavior groups; `Text=Button reference` is visibly bold, default `Enabled=True` is not bold, and the description pane says `The text associated with the control.`; source/Designer/project remain byte-identical and screenshot SHA-256 is `32607d6834d2bca175bb358c8f1f8e9d7e7827953b6b33afbc12dfbeeccd040c` | Reference `PASS` + repository webview `PASS`; the product matches categorized grouping, non-default/default emphasis, ambient-noise suppression, and description semantics for the bounded Button fixture |
| S038 | Actual Visual Studio selects `button1` and `textBox1` together; the shared `Text` TreeItem has an empty mixed value, common `AllowDrop/Enabled/Visible/Anchor/Location/Size` rows are present, Button-only `DialogResult` and TextBox-only `Multiline/AcceptsReturn/UseSystemPasswordChar` are absent, both controls show selection handles, all project inputs remain byte-identical, and screenshot SHA-256 is `cd07cc383397b76c211f47f49179753d9d43f8196f4c89a5c1deedf875b9c872` | Reference `PASS` + repository unit/webview `PASS`; product matches intersection, mixed-value, hidden-row, and all-target edit/reset semantics. Physical ARM64 remains external `GATED` |
| S039 | Actual Visual Studio opens the in-process net48 designer. The rendered child absorbs a synthetic click, so the harness selects the visible legacy Document Outline row `button1 | Button` and refuses mutation unless the Property Grid reports `Text=Custom reset text`; it then runs the exact enabled `OtherContextMenus.PropertyBrowser.Reset` handler. The native popup is unavailable to UIA on the disconnected capture desktop, so DTE invokes that same registered handler; the visible value becomes empty, and the exact Designer patch removes only `this.button1.Text`, preserves `this.` qualifiers and sibling semantics, canonicalizes four separators, adds one pre-close blank line, and rewrites only the generated region to CRLF. Source/project stay byte-identical; Designer SHA-256 is `f2cfc31bb56c15f55dab14b452b4aa7bddba2a6f33ec23d89f7e0156e5f457e7`, and screenshot SHA-256 is `51043f6de51a835d5e3cecb75313ef9f81d516eb72730368c0699fc12b70e1b4` | Reference `PASS` + repository unit/webview/named-pipe `PASS`; product Reset enablement and source-safe assignment removal match this bounded reference |
| S041 | Actual Visual Studio opens the native `FlatStyle` dropdown for a default Button; `ControlType.List` children are exactly `Flat, Popup, Standard, System`, `List.Current.Name` and the visible highlight identify `Standard`, source/Designer/project remain byte-identical, and screenshot SHA-256 is `1b4ebea8a2ff6df92ffd93e88b91d053ede2417fb28b92b678c6194c11e799f6` | Reference `PASS` + real modern CustomEditor `PASS` on 1.84.0/1.134.0; product publishes the same exclusive list and selected value, opening/focusing it emits no edit, disk stays exact, and native history is untouched |
| S042 | Actual Visual Studio selects `button1`, expands the owner-drawn `Padding` row through the PropertyGrid `VK_RIGHT` contract, observes `Left=3`, and commits `8` through the real child Edit `ValuePattern`; exact saved semantics become `Padding(8,4,5,6)`, Top/Right/Bottom survive, source/project stay byte-identical, modern CodeDOM canonicalization is frozen exactly, Designer SHA-256 is `7c2d864e23abfe2ee338c693eafa67f07d12a3961930fde5061704dbe3c86962`, and screenshot SHA-256 is `b8bf4d36d946161bc8a5afc2053686d702693b60de9c9af9b1679e16123c7983` | Reference `PASS` + repository unit/webview/E2E `PASS`; the product changes only the requested Padding subvalue and preserves all sibling subvalues |
| S045 | Actual Visual Studio starts from explicit `Button.BackColor=Red`, selects `button1` through the native owner-drawn Document Outline, activates the real Properties `Open` button, selects the exact `Blue` row in the native Web ColorEditor, and commits canonical `Color.Blue`. Location `(48,54)`, Name, Size `160×42`, Text, and `UseVisualStyleBackColor=false` remain exact; one native Undo restores Red and one native Redo reproduces apply bytes exactly while source/project stay unchanged. Open-editor screenshot SHA-256 is `37cd4a0eda4d0491d758773fd457534a98f453a634cc492e320a1eb070348284`; after-apply screenshot SHA-256 is `71d40122284bd15f388870d58d52824df92a1049f39d7f7aaa7cb6098d015d2a` | Reference `PASS` + repository modern CustomEditor `PASS` on 1.84.0/1.134.0; product independently proves live metadata authorization, shared framework-editor ingress, canonical source commit, dirty state, exact pre-Save disk, and one native Undo/Redo unit |
| S046 | Actual Visual Studio starts from explicit `Button.BackColor=Red`, activates the native Properties `Open` button, and exposes the owner-drawn framework Color editor with visible `Custom / Web / System` tabs, Web palette, and selected `Red`. `Esc` closes it; native Properties remains `Red`, source/Designer/project hashes are byte-identical, open-editor screenshot SHA-256 is `b81819e5880ffed62ca88ba0cc571eae6970441bada2df52f164d4c1e35a48d6`, and after-cancel screenshot SHA-256 is `205f182332e9da858b75638b44414eba3823104292b17086f0cddf0cc2d0a405` | Reference `PASS` + repository modern CustomEditor `PASS` on 1.84.0/1.134.0 for the typed `CANCELLED` source/dirty/history/disk no-mutation contract. Physical ARM64 remains external |
| S050 | Actual Visual Studio opens a separately wired Form, selects `button1`, activates native `Show Events`, verifies the owner-drawn `Click=button1_Click` row and its real writable child Edit, then commits that same handler through `UIAutomation.ValuePattern.SetValue + Enter`. Source, Designer, and project remain byte-identical with exactly one handler and one subscription; source SHA-256 is `a64028cdb47a7c0d3bff88a9b48e65aef58dead35f064f7c1ee9b9d443f96ac9`, Designer SHA-256 is `b7418110c276174eeba4e32a27dbe8f21dc83c0f75e69d102237556f472093f9`, project SHA-256 is `ad9b851b5893c76498edbe80e52ee2ec062f9bd5c8c9019d8f6629034eadc638`, and screenshot SHA-256 is `460be1745ee698c88eb105060bc408534c41cd232e1ae980906dd5dbb8472a30` | Reference `PASS` + repository CustomEditor `PASS` on 1.84.0/1.134.0; selecting the already wired handler is a clean no-op with exact disk hashes and no duplicate method/subscription. Physical ARM64 remains external `GATED` |
| S051 | Actual Visual Studio opens the exact classic-net48 Form, selects `textBox1` through native Document Outline, verifies `TextChanged=textBox1_TextChanged` in the real Events grid, and commits the compatible `textBox1_TextChangedAlternate` through `UIAutomation.ValuePattern.SetValue + Enter`. Exactly one subscription changes and Visual Studio retains only the currently referenced empty handler: initial original+alternate becomes alternate, one native Undo becomes original, and one native Redo becomes alternate. Designer Redo is byte-identical to rewire, source Redo is whitespace-normalized identical, project bytes and all unrelated source/Designer facts remain exact; screenshot SHA-256 is `2a69e4d1a06f061a29912a93cea6eb18d3be4c731b2e690a2da814e500403904` | Reference `PASS` + repository compiled-net48 CustomEditor `PASS` on 1.84.0/1.134.0; the product independently proves the stable rewire/native Undo/Redo and refuses a deterministic stale code-behind revision without Designer/disk mutation |
| S079 | Actual Visual Studio opens the exact classic-net48 `RightToLeft=Yes` / `RightToLeftLayout=true` Form without Save, measures its real native Form/Button/Label HWNDs relative to the normalized `320×160` physical client, and proves the exact mirror formula: logical `primaryButton (20,30,90×28)` renders at `(210,30,90×28)`, while logical `statusLabel (50,82,80×20)` renders at `(190,82,80×20)`. Source, Designer, and project hashes remain byte-identical; screenshot SHA-256 is `a625709b28e66336b6da1753702ba5763d5dec39caea58a41e63ed7f7c062a28` | Reference `PASS` + repository compiled-net48 CustomEditor `PASS` on 1.84.0/1.134.0; the product independently drives the ar-SA Language path, applies the same X mirror with Y/Size preservation, publishes Arabic metadata, keeps history clean, and preserves source/Designer/neutral/culture resource hashes |
| S085 | Actual Visual Studio opens the exact net10 derived Form, resolves the protected `inheritedButton` by native AutomationId, requires native Properties `Text=Base inherited`, and writes exactly one `inheritedButton.Text = "Derived override"` assignment into the derived Designer without a derived field or unrelated inherited assignment. Base source, base Designer, derived code-behind, and project stay byte-identical. Native Undo removes the override and restores the input semantics after deterministic first-touch CodeDOM `this.`/comment-spacing canonicalization (raw bytes are explicitly unequal); Redo reproduces the applied Designer byte-exact. Screenshot SHA-256 is `985d6f28c7e1fd798bfac6ea1737818641509a9d45ff49bd5d6d7678ea7330ae` | Reference `PASS` + repository modern CustomEditor `PASS` on 1.84.0/1.134.0; the product independently requires the live base identity token, writes one bounded derived override, preserves base/derived disks before Save, and proves native Undo/Redo/final-Undo |
| S086 | Actual Visual Studio opens a separate exact net10 derived Form, exposes the private inherited Label as `ControlType.Text` / AutomationId `privateInheritedLabel` with the native lock glyph, selects it, and shows native Properties `Text=Private inherited label` on a disabled row. Direct `UIAutomation.ValuePattern.SetValue` is rejected as not allowed on a nonenabled element; the value, base source, base Designer, derived code-behind, derived Designer, and project hashes remain byte-identical. Screenshot SHA-256 is `aff489a0a05c300b8a1f61e55cb9e83dce8d988d60a3299af26da6a2739f03f9` | Reference `PASS` + repository modern CustomEditor `PASS` on 1.84.0/1.134.0; the product independently publishes inherited `editable=false`, a visible base-type reason, read-only Text, direct edit refusal, clean state/history, and exact disks. Physical Windows ARM64 remains external `GATED` |
| S087 | Actual Visual Studio opens the exact classic-net48 derived Form over a compiled protected-Panel base, filters native Toolbox search to `All Windows Forms → Button`, and invokes the exact MSAA Double-Click default action. Save writes one complete derived-root `button1` CodeDOM shape and no `basePanel.Controls.Add`; base source/Designer, derived code-behind, and project stay exact. Undo removes all button shapes after measured CodeDOM whitespace normalization; Redo restores the operation contract while raw artifacts retain generated `TabIndex 1→0` and `SetChildIndex`-order differences. Screenshot SHA-256 is `79d8a5fe41a498fec5281d5654d00ee0b28b80207a74f7d0d119802809959123` | Reference `PASS` + repository compiled-net48 CustomEditor `PASS` on 1.84.0/1.134.0 for derived-root toolbox Add with exact base/disk preservation and one native Undo/Redo/final-Undo unit |
| S088 | Actual Visual Studio opens source-identical modern and classic-net48 derived Forms, selects the private inherited Button with native lock glyph and disabled `Text=Private inherited` Properties, then attempts a bounded cursor-synchronized drag through the actual designer capture HWND. Both runtime legs preserve exact bounds and all ten base/derived/project artifacts; modern keeps Undo/Saved `False→False` / `True→True`, classic keeps its preexisting `True→True` / `False→False`. DTE stack depth is not claimed. Primary screenshot SHA-256 is `da88fdf3880a1b06cec43d152d6eb3d9612e045b1506cd3f05541e86a43685bf` | Reference `PASS` + repository modern/compiled-net48 CustomEditor `PASS` on 1.84.0/1.134.0 for typed `INHERITED_READONLY`, exact source/disk preservation, and product-native Undo no-op. Physical Windows ARM64 remains external `GATED` |
| S053 | Actual Visual Studio opens the supported `net10.0-windows` Form, executes native `View.Toolbox`, exposes `Search Toolbox` / `PART_SearchBox`, accepts `Button` through its real UIA `ValuePattern`, reports exactly `2 results found`, and exposes the legacy native MSAA path `Toolbox → All Windows Forms → Button` beside `RadioButton`; source, Designer, and project remain byte-identical, and screenshot SHA-256 is `974c824913dddd92a0d51a3907b1c3a927bf8f0da82898d49bd630c466388e49` | Reference `PASS` + repository unit/E2E `PASS`; product evidence independently proves `System.Windows.Forms.Button` framework provenance and `Common Controls` category. The reference claim is bounded to the observed Visual Studio `All Windows Forms` search result |
| S049 | Actual Visual Studio double-clicked the UI-Automation-located designer `button1`, emitted exactly one `button1.Click += button1_Click` subscription and one handler, navigated its DTE cursor inside the method, and preserved project bytes. The autonomous Save All watcher observes the exact `Inconsistent Line Endings` dialog, posts **No** to control id 7, and records `observed/clickPosted/dismissed=true` only after the HWND disappears; screenshot SHA-256 is `c5ca845d44ff4c369d792f174793cf2b85f84f7595a3bd3055d2dedaa32be9b4` | Reference `PASS` + repository CustomEditor `PASS` on 1.84.0/1.134.0; generated-source wiring and the confined code-behind edit stay unsaved until Save and one native Undo/Redo gesture restores/reapplies both artifacts. Independent code edits cancel the redo bridge fail-closed |
| S100 | The modern product CustomEditor saves `Button.Text = "Extension + Visual Studio round-trip"` beside an accepted static adapter manifest; actual Visual Studio opens and Save All preserves source, Designer, and manifest bytes exactly; the later product run reopens the archived Visual Studio output through the modern engine | Reference `PASS` + repository Extension Host `PASS` on 1.84.0/1.134.0; exact Text semantics, clean state, CustomDocument/disk equality, native Undo restoration, and no adapter vendor-code/workspace authority for this bounded corpus |
| S108 | The compiled-net48 product CustomEditor saves `Button.Text = "Extension + VS net48 round-trip"`; actual Visual Studio opens and Save All preserves code-behind and Designer bytes exactly; the later product run reopens the archived Visual Studio output through the compiled-net48 lane | Reference `PASS` + repository Extension Host `PASS` on 1.84.0/1.134.0; exact Text semantics, clean state, CustomDocument/disk equality, and native Undo restoration for this bounded corpus |
| S110 | Actual Visual Studio exposes `Submit button` as `ControlType.Button`, `Customer name` as `ControlType.Edit`, visual `Main menu` as `ControlType.MenuBar`, nested `fileMenuItem` as `ControlType.MenuItem`, and `refreshTimer` as a `ComponentTray` Pane. Every record is enabled, onscreen, has non-empty bounds and raw-view ancestry through the real `DesignerFrame`; source/Designer/project stay exact and screenshot SHA-256 is `1106ea75fe2b0b663c873f307021c442cc0aaab555d38cebc455e5ec6db0715b` | Reference `PASS` + repository webview `PASS` for matching ARIA tree/tray roles and names. Physical ARM64 and live assistive-technology acceptance remain external `GATED`/`NOT_EXECUTED` |
| S061 | Actual Visual Studio selects `button1` in the owner-drawn Document Outline and commits `submitButton` through native Properties `(Name)`. The field, eight member references, and `Name` literal change once; `Button.Text = "button1"` and all `textBox1` references remain semantically exact. One native Undo restores the original semantics and Redo reproduces the renamed Designer bytes exactly; source/project remain byte-identical. Native outline F2 did not expose an editor and is not claimed; screenshot SHA-256 is `747a700f66e475482bc8905d37f264e84a166b053919e0e8aaa66cfde2a56f94` | Reference `PASS` + repository modern/net48 CustomEditor `PASS` on 1.84.0/1.134.0 for selected-control atomic rename and exact native Undo/Redo. Product F2 is an additive shortcut; its minimal source patch deliberately avoids unrelated Visual Studio CodeDOM normalization |
| S062 | Actual Visual Studio resolves `refreshTimer` as a visible `ControlType.Pane` beneath native `ComponentTray`, clicks its measured bounds, and native Properties identifies `refreshTimer System.Windows.Forms.Timer` with `(Name)=refreshTimer`, `Enabled=False`, and `Interval=1500`. Source, Designer, and project remain byte-identical; screenshot SHA-256 is `66ddb48b8e384abc3c93339ec4c9158c3ea5f9903560fa804ee0aa83d43e889b` | Reference `PASS` + repository modern CustomEditor `PASS` on 1.84.0/1.134.0 for engine-authoritative nonvisual tray/session selection and live Timer properties without source, dirty-state, disk, or native-history mutation. Physical Windows ARM64 remains external `GATED` |
| S120 | Every full product regression moves `button1` by `+11,+7`, saves the exact Designer bytes, preserves code-behind, proves CustomDocument/disk equality, and restores the byte-exact baseline with native Undo; actual Visual Studio 18.7 opens the exported form and Save All preserves both source artifacts exactly | Reference `PASS` + repository Extension Host `PASS` on 1.84.0/1.134.0 for this bounded fixture |

S051 has repository-functional evidence on the same two Extension Host lines and the bounded actual Visual Studio
reference above. The compiled-net48 CustomEditor asks
the engine to validate `textBox1_TextChanged_Renamed` against one bounded project-partial snapshot, then the test actor
renames that method in the real open `TextDocument` before the Designer commit. The final dual-revision gate refuses
the stale subscription, keeps the Designer clean, preserves both disk hashes, and leaves the independent code edit
visible. After exact revert and authoritative net48 re-render, the stable product call changes exactly one subscription
and one native Undo/Redo unit restores/reapplies it. Actual Visual Studio independently proves the native Events
transaction and its exact empty-handler lifecycle; no broader event-editor parity is inferred.

S052 closes the adjacent generation refusal on both runtime lanes. A modern SDK CustomEditor and a compiled-net48
CustomEditor each ask the engine to generate a new Click stub against one bounded project-partial snapshot; a
deterministic edit then changes the real open code-behind `TextDocument` before either artifact commits. On VS Code
1.84.0 and 1.134.0 the independent edit remains visible, Designer stays clean, neither method nor subscription is
created, and both source/Designer disk hashes remain exact. Actual Visual Studio reference execution remains
`NOT_EXECUTED`.

S007 is now scenario-bound to the real public Explorer command: both Extension Host lines invoke registered
`winformsDesigner.addComponent` with `..\Injected`, receive the typed `invalidName` refusal, and preserve the target
directory entries exactly. S035 opens a real compiled-net48 CustomEditor with page 2 selected and reparents an external
TextBox through the product ingress; the exact result is one `tabPage2.Controls.Add`, no Form owner, live page-client
Location `(276,38)`, clean disk, and one native Undo/Redo unit covering both membership and geometry. Neither scenario
has an archived Visual Studio reference run.

S036 first renames `splitContainer1` through the product so the formerly published `splitContainer1.Panel2` identity is
genuinely stale, then sends `button1` through the same reparent ingress. Real modern and compiled-net48 CustomEditors on
both host lines preserve the Designer text and both disk hashes; one native Undo removes the setup rename, proving the
refusal added no hidden history unit. S061 selects `button1` through the canvas/outline session pick and renames it to
`submitButton` through the product: selected identity follows, every declaration, Name literal, and C# reference changes
exactly once, unrelated Text and `textBox1` remain exact, disk stays untouched, and one native Undo/Redo unit owns the
whole edit. S036 has no archived Visual Studio reference run; S061's bounded owner-drawn Outline → Properties `(Name)`
reference transaction is archived above.

S024 uses the real shared designer clipboard on both runtime lanes. Copying the existing `submitButton` leaves the
CustomDocument clean; Paste into the same form generates non-colliding `button1` before commit, retains the original,
applies the bounded 8px nudge, selects the clone, leaves both disk hashes exact, and passes one native Undo/Redo unit.
The archived actual Visual Studio run above closes the bounded collision-safety reference on both runtime lanes while
recording VS's distinct `(98,74)` placement rather than claiming spatial equality.
S063 combines the real outline drag intent with the existing compiled-net48 product reparent ingress: `button1` moves
from `panel1` to `groupBox1`, gets live GroupBox-relative Location `(10,15)`, leaves disk untouched, and one native
Undo/Redo unit restores/reapplies membership plus geometry. S063 still has no archived Visual Studio run.

S065 drives the real Properties Items read/write baseline on an empty modern `MenuStrip`, submits the panel's full
`Insert Standard Items` payload, and atomically mints the complete File/Edit/Tools/Help forest with nested commands and
separators. S066 moves `Open` before `New/Save` through the real canvas ingress while preserving unmanaged item
metadata. S067 moves top-level `Help` under `Tools.DropDownItems` through a real compiled-net48 CustomEditor. Each
successful mutation leaves disk untouched and is exactly one native Undo/Redo unit on VS Code 1.84.0 and 1.134.0.
S068 attempts the adjacent ineligible move in both modern and compiled-net48 sessions; the product returns
`newButton has no DropDownItems collection` before source/history mutation and preserves both disk hashes. Their actual
Visual Studio traces, and the ARM64 hardware legs where catalogued, remain external.

S069 uses the real modern Properties `ListView.Columns` read/write seam. Starting from an empty collection, the panel
submits `Name` at width 180, the product mints `columnHeader1`, reads the committed collection back, renders the column,
and proves exactly one native Undo/Redo unit while source and Designer remain byte-identical on disk. S070 uses the new
typed `TabControl.TabPages` editor to submit the complete `C,A,B` permutation once. The engine rewrites only canonical
page references, product readback returns `C,A,B`, the rendered active surface is `pageC`, and one native Undo/Redo unit
restores/reapplies `A,B,C`/`C,A,B` without a disk write. Both paths have stale-read gates; TabPages also refuses
comments, duplicates, incomplete permutations, and ambiguous source. Both pass on VS Code 1.84.0 and 1.134.0. Their
actual Visual Studio traces and S070's physical ARM64 leg remain external.

S033 and S034 now drive real modern canvas drags rather than only the underlying source helpers. S033 publishes the
live 2x2 `TableLayoutPanel` cell extents, resolves the canvas release point into cell `(1,1)`, commits the Button move
from `(0,0)` once, and renders it in the lower-right cell. S034 publishes live `FlowDirection` and child geometry,
moves C before A as exact `Controls.Add` order `C,A,B`, and renders C first. Neither synthesizes a free `Location`;
both preserve code-behind and Designer disk hashes and form one native Undo/Redo unit on VS Code 1.84.0 and 1.134.0.
Their actual Visual Studio traces remain `NOT_EXECUTED`. The full named-pipe regression also proved that the canonical
three-line VS host section banner is preserved by TabPages reorder while inline, trailing, and user leading comments
remain fail-closed.

S041 now binds standard-value metadata to the real modern CustomEditor and the real Properties-panel rendering route.
Selecting a live Button publishes `FlatStyle` as the exclusive ordered list Flat / Popup / Standard / System with
Standard selected; the webview renders those exact value/display pairs as a closed dropdown and emits no edit merely
for opening/focusing it. Designer text, clean state, both disk hashes, and the pre-existing native Redo remain exact on
VS Code 1.84.0 and 1.134.0. Actual Visual Studio 18.7 independently opens the native list with the same exact order and
selection while source, Designer, and project bytes remain exact; the strict reference status is `PASS`.

S040 uses the same live Button metadata through the shipped keyboard-search surface. The exact `flatstyle` query
leaves only `FlatStyle`; `ArrowDown` focuses the selected `Standard` closed-list editor, updates the description pane,
and posts no host edit. Designer state and both disk hashes remain exact on VS Code 1.84.0 and 1.134.0. S083 opens the
permanent compiled-net48 binding form, reads an empty `nameTextBox` binding collection plus the real
`customerBindingSource`, then commits `Text → Customer.Name` through the exact Properties DataBindings OK seam. The
product emits exactly one canonical `DataBindings.Add` statement, reads the requested binding back exactly, keeps disk
byte-identical before Save, and restores/reapplies it through one native Undo/Redo unit on both host versions. Their
actual Visual Studio traces remain `NOT_EXECUTED`.

S073 drives the shipped Properties **Project…** action through a real modern CustomEditor. The product discovers the
strongly typed `DemoApp.Properties.Resources.Logo` Bitmap from the exact project `.resx`/generated-accessor pair and
commits exactly one canonical `this.imageButton.Image = global::DemoApp.Properties.Resources.Logo;` statement. It
creates no form `.resx`, emits neither `resources.GetObject` nor copied base64, preserves both project-resource
authority files and both source disks exactly, and restores/reapplies the unsaved source edit through one native
Undo/Redo unit on VS Code 1.84.0 and 1.134.0. Its actual Visual Studio reference trace remains `NOT_EXECUTED`.

S074 drives the shipped Properties **Import…** action for the Form `Icon` through a real modern CustomEditor, bypassing
only the native file chooser with a deterministic URI. The product validates the ICO, adds a typed `$this.Icon` resx
entry and canonical `resources.GetObject("$this.Icon")` assignment, preserves the unknown node payload and `xml:space`
metadata across safe XML formatting, and leaves code-behind and Designer disk bytes unchanged before Save. One native
Undo/Redo/final-Undo unit restores and reapplies the exact Designer-plus-resx baselines on VS Code 1.84.0 and 1.134.0.
Its physical ARM64 and actual Visual Studio executions remain `GATED`/`NOT_EXECUTED`.

S075 selects a real `ImageList` from the component tray in a compiled-net48 CustomEditor and runs the shipped images
transaction with only QuickPick/OpenDialog replaced by deterministic inputs. The bundled net48 engine validates and
serializes two 16×16 PNGs as a VS-compatible `ImageListStreamer`; the source planner emits the canonical `ImageStream`
assignment and ordered `SetKeyName` calls, the resource transaction writes the binary node while preserving an
unrelated neutral resource, and the compiled live instance is reconciled. Code-behind and Designer disk bytes remain
unchanged before Save, and one native Undo/Redo/final-Undo unit restores/reapplies exact Designer plus resx baselines
on VS Code 1.84.0 and 1.134.0. Actual Visual Studio execution remains `NOT_EXECUTED`.

S076 drives an injection-shaped Project-resource accessor through real modern and compiled-net48 CustomEditors after
each has selected a live Button and published writable `Image` metadata. The shipped picker ingress returns typed
`INVALID_RESOURCE_SYMBOL` before project-resource discovery or engine planning; both in-memory Designer baselines,
native history, source/Designer disk hashes, and project/form resource hashes stay exact on VS Code 1.84.0 and
1.134.0. Actual Visual Studio execution remains `NOT_EXECUTED`.

S045/S046 drive live framework `ColorEditor` metadata through the real modern CustomEditor. The deterministic seam
replaces only the native modal Blue/dismiss outcome: metadata authorization, the shared UITypeEditor ingress, normal
engine source planning, CustomDocument commit, canonical `System.Drawing.Color.Blue`, dirty state, and one native
Undo/Redo unit remain the shipped product path. Dismissal returns typed `CANCELLED` with exact source, dirty-state,
history, and disk no-mutation. VS Code 1.84.0 and Stable pass, while 24 broker tests independently cover the applied and
dismissed wire results. S046 now also has bounded actual Visual Studio x64 `PASS` for opening the explicit
`BackColor=Red` framework editor and cancelling it with `Esc` without mutation. S045 apply-to-Blue remains
`NOT_EXECUTED`; physical ARM64 remains `GATED`.

S047 drives the real in-repo MIT FakeVendor dropdown editor through a compiled-net48 CustomEditor. Live metadata
authorizes the exact `VendorEdit.ComplexValue`/editor/value tuple together with the resolved assembly path, SHA-256,
and certification id even though the product no-lock-loads that assembly into a collectible context. The actual
isolated child worker returns `Vendor Beta`; the normal scalar transaction commits one canonical Lane B owned-region
assignment, preserves both disk hashes before Save, and exposes one exact native Undo/Redo/final-Undo unit on VS Code
1.84.0 and Stable. S048 executes the actual wrong-type worker result on modern and compiled-net48 sessions; the shared
broker returns `INVALID_EDITOR_RESULT` and adds neither source mutation nor native-history entry while preserving the
existing dirty state and disk hashes. These are repository proofs for the MIT fixture; licensed vendor artifacts and
Visual Studio reference executions remain external.

S093 drives a visible `ControlDesigner` adorner through a real modern CustomEditor using the disposable
workspace-local build of the in-repo MIT FakeVendor fixture. Its live designer publishes one bounded control-local
Caption descriptor; the canvas renders it only for the selected control, and provisional hover becomes active only
after a fresh engine graph and the same live designer confirm the exact point. The reflection bridge accepts only
bounded DTO metadata and returns no `Behavior`, `Glyph`, delegate, service, or path across the process boundary.
Malformed, duplicate, stale-selection, stale-revision, and unconfirmed results fail closed. Unit, webview, and VS Code
1.84.0/1.134.0 Extension Host evidence proves the visible overlay and exact source-buffer, dirty-state, native-history,
code-disk, and Designer-disk no-mutation boundary. Actual Visual Studio and licensed-vendor execution remain external.

S094 drives the VS-style canvas smart tag through a real modern CustomEditor using a disposable workspace-local build
of the in-repo MIT FakeVendor fixture. Its live `ComponentDesigner.ActionLists` descriptor maps `Caption` to writable
`Text`; the shared smart-tag/source-first path emits exactly one canonical `Hosted caption` assignment, keeps both disk
hashes unchanged before Save, and exposes one native Undo/Redo/final-Undo unit on VS Code 1.84.0 and Stable. Webview
evidence covers the real flyout label, tooltip, and ordinary edit intent. Licensed-vendor, actual Visual Studio, and
physical ARM64 execution remain external.

S118 drives the shipped modern ImageList edit through a real CustomEditor and verifies the planned resource bytes after
the write. A deterministic Extension Host-only seam rejects only that already-verified forward postcondition; the
normal transaction runner returns `POSTCONDITION_FAILED_ROLLED_BACK`, compensates to the exact opaque-resx bytes, and
publishes neither transient Designer text nor dirty/native-history state. Code-behind, Designer, and resource hashes
remain exact on VS Code 1.84.0 and 1.134.0. Actual Visual Studio remains `NOT_EXECUTED`; physical ARM64 remains `GATED`.

S077/S078 drive Language-scoped scalar resource edits through a real modern CustomEditor. Default Language changes
only the neutral `label1.Text`; selecting a discovered `fr-FR` resource is itself non-mutating, publishes the French
value in Properties, and the subsequent edit changes only that overlay. Code-behind and generated `ApplyResources`
source remain byte-identical, the non-selected resource layer remains exact, the visible designer owns one native
Undo/Redo unit per edit while the source buffer stays clean, and final Undo restores the exact resource baseline on
VS Code 1.84.0 and 1.134.0. The `.resx` writer additionally preserves LF/CRLF and terminal-newline presence. Actual
Visual Studio traces remain `NOT_EXECUTED`; S078 physical ARM64 remains `GATED`.

S080 now proves the corresponding race refusal in a fresh real CustomEditor. The shipped Properties edit captures the
exact `fr-FR` baseline, an external writer changes that resource before the first product write, and the shared
transaction boundary refuses rather than overwriting it. The newer external bytes, neutral fallback, code-behind,
generated source, clean tab, and empty native history remain exact on both host versions; cleanup restores the fixture.
Its actual Visual Studio trace remains `NOT_EXECUTED`.

## Final current-tree local acceptance — 2026-08-22

These commands were rerun after the bounded W5 implementation, the VS Code 1.84 transaction-race fix, the Visual
Studio render-parity fixes, the composite S049 event transaction, the dual-revision S051 event-rewire refusal, the
cross-runtime S052 handler-generation refusal, S007 unsafe-name refusal, S035 TabPage transaction, S036 stale-target
refusal, S061 selected-control rename, S024 cross-runtime collision-safe Paste, S062 Timer tray selection and
Properties publication, S063 outline reparent, S064 product containment-cycle refusal, S065 full standard MenuStrip,
S066 top-level reorder, S067 net48 dropdown reparent, S068 cross-runtime non-dropdown refusal, S069 product
ListView.Columns editing, S070 atomic TabPages ordering, S033 Table cell drag, S034 Flow child drag, S040 keyboard
property search, S041 live standard values, S073 strongly typed project image assignment, S074 local Icon Import,
S075 compiled-net48 ImageList transaction, S076 cross-runtime unsafe-resource-symbol refusal, S045/S046 framework
ColorEditor apply/cancel, S047 certified FakeVendor dropdown apply, S048 cross-runtime invalid-result refusal, S093 real
ControlDesigner adorner render/hit test, S094 real ComponentDesigner ActionLists smart tag, S118 verified
postcondition-failure ImageList compensation,
S077/S078 Language-scoped
resource editing, S080 stale-culture refusal, S083 compiled-net48 Text binding, the
npm-only toolchain freeze, and the final extension build. They verify the live dirty
tree; they do not substitute for the clean-tag gate.

S020 additionally runs at the authoritative open-document boundary rather than relying on webview timing alone.
Canvas selection, move, resize, group move, and nudge intents carry the generation of the PNG actually drawn; missing,
malformed, and superseded values return typed `STALE_CANVAS` before selection, source, dirty state, native history, or
disk mutation. Real modern and compiled-net48 Extension Host sessions start a newer full render, reject an old click
and nudge with native Undo remaining a no-op, then accept the fresh generation on both supported host lines.

S085-S088 additionally run the real source-identical modern and compiled-net48 inheritance surfaces. A protected base
Button requires the live SHA-256 inheritance token and commits one derived-only Text override as one native history
unit; private inherited Label/Button metadata is visibly read-only and both Properties and canvas move ingress refuse
without source, dirty-state, history, or disk mutation. A new toolbox Button is emitted only into the derived Designer
buffer, with base/code/Designer disks remaining exact before Save on both supported host lines.

S082 additionally runs the shipped Data Sources surface inside a real modern CustomEditor. The pane discovers
`Customer(Id, Name, Email)`, the grid-with-navigator action creates DataGridView, BindingSource, three bound columns,
and BindingNavigator as one native history unit, and all four project files stay byte-exact before Save. S084 runs the
same product ingress on modern and compiled-net48 unsupported-provider projects and returns typed
`UNSUPPORTED_DATA_PROVIDER` before generated IDs, source, dirty state, native history, or disk mutation.

S016 additionally replaces its original synthetic timing record with real product evidence. The disposable x64
Extension Host fixture contains 300 mixed standard controls and both modern and compiled-net48 CustomEditors publish
the complete 301-node graph. VS Code 1.84.0 measured modern `1968 ms` initial / `219 ms` commit+reconciliation and
net48 `3153/136 ms`; Stable 1.134.0 measured modern `2187/154 ms` and net48 `3151/140 ms`, against frozen `5000/500 ms`
budgets. The selected Button's Properties metadata comes from the accepted snapshot with no trailing describe, one
native Undo restores the byte-exact baseline, and all source/project hashes remain unchanged. Actual Visual Studio,
physical cross-architecture runs, and external performance-lab p95 remain `NOT_EXECUTED`/external.

S122 now consumes only real `vscode-extension-host` product telemetry carrying the exact host version, architecture,
PID, and timestamp. On VS Code 1.84.0, the standard-50 totals were `211/230/293/233 ms`, standard-300 totals were
`552/853/755/792 ms`, and the 180-control/96-FakeVendor totals were `759/827/906/878 ms` at logical
100/125/150/200% scale. Stable 1.134.0 measured `161/213/224/223 ms`, `650/712/819/862 ms`, and
`663/772/803/806 ms` respectively. Every leg retained same-snapshot Properties, native Undo, and byte-exact disk;
the headless evaluator rejects missing product evidence. The 2x retained-frame/leaf-patch unit and webview proofs also
verify correct physical backing dimensions. Visual Studio profiling, physical lab telemetry, and licensed vendor
artifacts remain external.

S120 is mandatory in every full Extension Host regression: it moves `button1` by `+11,+7`, preserves code-behind,
proves CustomDocument/disk equality, and restores the exact clean Designer baseline with native Undo and Save. The
archived actual Visual Studio Enterprise 2026 18.7 trace independently proves byte-identical Save All for the same
bounded fixture. S100 and S108 independently close the two-way modern/static-adapter and compiled-net48 corpus: the
real product creates and saves the edited artifacts, Visual Studio opens and saves them byte-identically, and the next
real product run reopens the archived Visual Studio output through the matching engine with exact semantics and clean
document/disk equality.

S095 additionally replaces the former caller-supplied supervisor/quarantine record with a real compiled-net48 product
route. The exact repository-certified `FakeVendor.CrashOnInitializeDesigner` first activates through
`DesignSurface`/`IDesignerHost` in a disposable child on the engine's private desktop. A marker then makes its actual
`ComponentDesigner.Initialize` terminate that OS process: the mapped net48 EngineApi PID remains unchanged, the child
is confirmed dead, and the exact assembly SHA-256/component/certificate identity is quarantined. A repeat returns
`DESIGNER_QUARANTINED` with `workerStarted=false`; the generic source-first canvas stays render-ready and a Text edit
plus native Undo/Redo succeeds with byte-exact source/Designer/project/assembly disks on VS Code 1.84.0 and 1.134.0.
This proves process crash containment, not an OS security sandbox, arbitrary hosted-designer compatibility, licensed
vendor certification, or Visual Studio reference parity; those legs remain external.

S089/S090 additionally replace kernel-only evidence with a real modern product path. A normal CustomEditor selection
resolves the same workspace assembly as the canvas and publishes `Apply Service Preset` only for the exact certified
component/designer/action identity after the hosted graph proves STA and complete container, selection, change, name,
command, and toolbox services. Incomplete capability sets withhold `IDesignerHost`; an unsupported service has an
explicit refusal. The webview submits only command/certificate identity. The extension revalidates the live revision,
exact assembly SHA-256, one transaction, two changes, and the returned proposals, then independently plans and commits
`Text = "Hosted service preset"` plus `Size = 180, 42` as one unsaved native Undo/Redo unit. A forged certificate is
refused with exact source/history/dirty/disk no-mutation. Unit, webview, and full VS Code 1.84.0/1.134.0 product suites
pass. S091/S092 additionally use a real compiled-net48 CustomEditor and the same registry: the certified cancellation
action opens one outer transaction in a disposable private-desktop child, refuses its nested transaction as
`REENTRANT_CANCELLED`, balances all change events, restores the transient graph, and returns no source proposal.
Source, dirty state, native history, project/assembly disks, and the mapped EngineApi process remain exact. Arbitrary
designers, licensed vendors, physical ARM64, and Visual Studio reference execution remain external.

| Gate | Terminal result |
|---|---|
| Generated v2 protocol | **PASS**; generated outputs match SHA-256 `e80c86785fa1563da5d544561ea32efc8ab08830a57889bb85c4c535bb79e6fa` |
| Scenario catalog | **PASS**; 128 scenarios, 111 repo `PASS`, 12 `NOT_EXECUTED`, 5 `GATED`, 11 `HARNESS_ONLY`, 40 reference `PASS`, 88 reference `NOT_EXECUTED`; 9 completed reports contain 235 PASS result rows, 152 unique scenario/suite pairs and 5,203 assertion executions. Every declared repository PASS has measured direct anchors; the mutation self-test invalidates PASS after an assertion removal |
| Product ↔ Visual Studio render comparison | **PASS (three frozen fixtures only)**; S013 modern Button and S014 net48 TextBox are exact at 0 / 64,800 pixels, MAE 0, max-channel delta 0. S011 generic-base net48 interpreted surface differs by 113 / 64,800 (0.174383%, MAE 0.149388), with the new max-channel gate passing at 246 |
| Modern engine, Release | **533/533 PASS**, 0 failed, 0 skipped; includes the shared SaveSafety/Controls.AddRange data-loss guards plus the retained product, architecture, resource, editor, S016, S025, S047, S071, S072, S089/S090, S093 and S122 proofs |
| .NET Framework 4.8 engine, Release | **49/49 PASS**, 0 failed, 0 skipped; net48 now links the shared SaveSafety gate and refuses a lost-control result before write |
| TypeScript/Vitest | **324/324 PASS** across 42 files; literal `#if false` regions are excluded from Tier-D ActiveX detection while unknown symbolic branches remain conservative |
| TypeScript typecheck and production build | **PASS** |
| Webview E2E | **970 checks across 209 tests, 0 failed**; S017 matches actual Visual Studio's partial-intersection marquee rule inside the active container; S025 proves full-frame client-origin translation, the visible baseline guide, exact snapped `manipulate` payload, and margin subcase; S026 mirrors the actual `(13,25,57×15) + (+20,0) → (32,24,57×15)` grid move and preserves the resize subcase |
| Full named-pipe E2E | **PASS** with terminal `E2E RESULT: PASS`, exit code 0, and `WFD_REQUIRE_NET48=1`; real modern/net48 processes exercised, including ProgressBar state, vendor geometry, real DesignerActionList metadata, framework and certified-vendor CollectionEditor metadata, typed DataSet, inherited override apply/reset, and the exact Arabic RTL mirror `38 → 178` |
| Short soak harness | Command **PASS**; 25 deterministic synthetic observations; report explicitly says real-product path and 8-hour hardware run **NOT EXECUTED** |
| Sample-corpus coverage | **PASS**; 32/35 interpreted, 3 disclosed fallback, 91.43% against the 80% floor |
| Performance baseline | **PASS**; latest run: startup 398.7 ms, warm median 44.6 ms, warm p95 61.7 ms against 15000/1000/2500 ms thresholds |
| VS Code Extension Host product E2E | **PASS** on exact minimum 1.84.0 and Stable 1.134.0. Each main report contains 77/77 scenario rows and 1,778 executed assertions; each separate hot-exit restore report contains 3/3 rows and 40 assertions, so S003 cannot overwrite or be overwritten by the main suite. S016 is within the frozen `5000/500 ms` budgets: 1.84 modern `1824/136 ms`, net48 `3066/141 ms`; Stable modern `1860/130 ms`, net48 `3089/131 ms`. All 12 S122 legs remain same-snapshot with native Undo and byte-exact disk |
| Localization parity | **PASS**; 470 runtime keys and 37 package keys for every shipped locale |
| Mojibake scan | **PASS** across 316 tracked text files |
| JavaScript syntax | **PASS** for all shipped webview scripts |
| npm audit | **PASS**; 0 vulnerabilities at `moderate` threshold |
| NuGet vulnerability audit | **PASS** for 12 live PackageReference projects, 0 vulnerable packages; **NOT EXECUTED** for the one classic-net48 `packages.config` reference fixture because `dotnet list package --vulnerable` does not support that format |
| VSIX isolation self-tests | **PASS**; the script now clears the deliberately failing child test's `$LASTEXITCODE` so CI receives exit 0 after the positive isolation result |
| Release builds / versions | **PASS**; both engines have `Version=2.0.0`, `AssemblyVersion=2.0.0.0`, and `FileVersion=2.0.0.0` |
| Release metadata/toolchain preflight | **PASS** in explicit `--metadata-only` mode; Node `24.14.0`, npm `11.9.0`, exact dependency specs, and the sole `extension/package-lock.json` are enforced |
| Full release identity preflight | **EXPECTED FAIL / NO-GO**; the live tree has 682 changed paths under `git status --porcelain=v1 --untracked-files=all`. Separate exact-tag inspection confirms HEAD `2ce79bbc892f965b04257ab8133384c77724c5cf` remains tagged `v1.9.0` and `v2.0.0` is absent |

The synthetic headless/soak commands are recorded at their real evidence level. Their zero exit codes do not convert
real-product, physical-lab, Visual Studio, vendor, or 8-hour evidence to `PASS`.

## Authoritative local frozen package pair

The current immutable local pair is
`.codex-tmp/release-2.0.0-remaining-fixes-20260826`. It was rebuilt after the measured-evidence reconciliation,
the ten echo downgrades, the refusal corrections, the SaveSafety/Tier-D fixes, final tests, and the public
release-candidate/`Unreleased` wording correction. Each target was asserted immediately; ARM64 staging then replaced
the shared engine directory, and the frozen x64 file was asserted again. The machine ledger is `manifest.json`
(1,884 bytes, SHA-256 `9E54DB4A025EFE5B77DD5506619ED43BD1D5155D5F15281216FB6B948D6A205C`).

| Artifact | Evidence |
|---|---|
| `.codex-tmp/release-2.0.0-remaining-fixes-20260826/winforms-designer-vscode-2.0.0-win32-x64.vsix` | version `2.0.0`; target `win32-x64`; modern RID `win-x64`; modern PE `0x8664`; net48 PE `0x8664`; 204 entries; 18,182,950 bytes; SHA-256 `015A292F1800C8B114101D3A27C0EA8265AC203779C088FA271F592CF9EB5EFA` |
| `.codex-tmp/release-2.0.0-remaining-fixes-20260826/winforms-designer-vscode-2.0.0-win32-arm64.vsix` | version `2.0.0`; target `win32-arm64`; modern RID `win-arm64`; modern PE `0xAA64`; net48 x64-compat PE `0x8664`; 204 entries; 18,170,757 bytes; SHA-256 `6F9AD2E4003EE7A6EC029DFD67C00BBE8C21505B9E2EEF80526E2D8C58B1D949` |

The source CHANGELOG supplied to the package build has 212,339 bytes and SHA-256
`AF82D32CE246760A8BB5D0E10D8B26569CC3D419474007FF1BBA6293FAD694D3`. Both packages contain the same 212,409-byte
VSCE-expanded CHANGELOG (SHA-256 `91C75E8D431C71256D2B153A2B1107AEB6A2985072E5BDB5B3B59F22E6634888`), which marks 2.0.0 `Unreleased`, records the
measured `111/12/5` repository result, and names the ten removed echo-PASS rows. The modern ARM64 apphost is native ARM64, while the
net48 engine remains explicitly x64 compatibility code and has not been exercised on physical ARM64 hardware.

## Superseded local frozen package pair (vs39 snapshot)

The pair below was built after the S025 baseline, S026 SnapToGrid, and S017 marquee actual-Visual-Studio corrections
and after the S110 accessibility, S061 Outline/Properties rename, S062 Timer tray/Properties, S046 explicit-Red
framework Color editor/Escape-cancel, S045 Red→Blue apply/native-Undo/Redo, S051 classic-net48 native Events
rewire/empty-handler lifecycle, S079 classic-net48 native RTL geometry, S085 protected inherited-property
override/native-Undo/Redo, S086 private inherited-Label locked-Properties, S087 classic-net48 native Toolbox Add, and
S088 modern/classic-net48 private inherited-Button drag-refusal traces were archived and documented
and the complete post-S017 final-tree regression. It also
contains the earlier S003 real two-process hot-exit recovery, the S005 actual Visual Studio modern-SDK
Windows Form item-template transaction, the S006 actual Visual Studio classic-project UserControl transaction and
matching two-file product correction, the S015 actual Visual Studio overlapping-label z-order hit test, the S020 host-authoritative stale-canvas generation guard, the S049 actual Visual Studio transaction, S050 actual Visual Studio and product existing-handler no-op, S051 dual-revision
rewire refusal, S052 cross-runtime generation refusal, S007 unsafe-name public-command proof, S035 selected-TabPage
transaction, S024 same-form collision paste, S036 cross-runtime stale-target refusal, S061 selected-control rename,
S062–S064 outline/tray safety evidence, S065–S068 MenuStrip/ToolStrip evidence, S069 typed ListView.Columns editing,
S070 atomic TabPages ordering, S033 live Table cell drag, S034 live Flow child drag, S040 keyboard Properties search,
S041 live FlatStyle standard-values publication/no-mutation, S042 actual Visual Studio expandable-Padding transaction,
S053 actual Visual Studio native Toolbox search/category/provenance evidence,
S073 strongly typed project Bitmap assignment, S074 local
Form Icon Import with opaque-resx preservation and native multi-artifact history, S075 compiled-net48 ImageListStreamer
transaction with native multi-artifact history, S076 cross-runtime unsafe resource-symbol refusal, S045/S046 framework
ColorEditor apply/cancel, S047 actual certified FakeVendor dropdown apply, S048 modern/net48 wrong-type result refusal,
S071 actual certified FakeVendor collection worker apply, S072 cross-component owned-region refusal,
S093 live ControlDesigner adorner render/hit test, S094 live ComponentDesigner ActionLists smart tag, S118 verified
postcondition-failure ImageList compensation, S077/S078 Language-scoped resource editing, S080 stale-culture refusal,
S082 real Data Sources grid/navigator history, S084 typed modern/net48 provider refusal, S083 compiled-net48 Text
 binding, the real S085-S088 source-identical modern/net48 inheritance surface, S079 ar-SA RTL geometry and actual
 Visual Studio classic-net48 native RTL mirroring,
S101/S105 real project/runtime routing, S104 product idle-worker recycle, S016 real 300-control retained/same-snapshot
  product performance, S100/S108 real Extension → Visual Studio → Extension reopen evidence, S120 bounded
  extension/Visual Studio move-save evidence, S122 real 12-leg product telemetry and
2x dirty-patch proof, S126/S128 read-only High-DPI advisor preview/apply/stale-refusal, S124 real mapped-worker crash
recovery/edit continuation, S095 exact hosted-designer process-crash quarantine, and S089/S090 exact modern
hosted-service discovery/action/transaction/refusal product paths, plus the exact S025 Button/TextBox baseline-snap
producer/browser candidate-priority correction, the exact S026 full-frame 8×8 grid move/resize evidence, and the S017
positive-area intersection rule constrained to direct children of the active container, plus the S110 actual Visual
Studio UI Automation roles, names, ancestry, state, and screen bounds, and the S061 actual Document Outline selection →
Properties `(Name)` atomic rename with exact native Undo/Redo, the S062 native Timer tray selection-to-Properties
 contract, the S046 owner-drawn framework Color editor open/Escape-cancel trace, the S045 exact Blue
 apply/one-native-Undo/Redo trace, the S079 exact normalized native Form/Button/Label geometry trace, the S085 exact
 protected inherited-Button `Text` override with semantic Undo after measured CodeDOM normalization and byte-exact Redo,
 the S086 exact private inherited-Label lock/disabled-Properties/refused-SetValue trace, the S087 derived-root native
 Toolbox Add/Undo/Redo contract, and the S088 cross-runtime locked-selection/drag-refusal/artifact-exact contract.
Each target was
asserted immediately, and both immutable files
were asserted again after ARM64 staging. Its machine-readable ledger is
`.codex-tmp/release-2.0.0-final-vs39-20260824T153000Z/manifest.json` (SHA-256
`FD6933A5187FADC19FB9BF9527B4BEDEA72672A6767A9D946DBCA3DD352780D6`); this pair also contains byte-identical
Marketplace README (SHA-256 `B7C2C6A733D3382D369BAFDADA2147E25F029FAF42C4A809ADB64943BED5A3F5`), `designer.js`
(SHA-256 `DC32A8506E8F51249F887D121F41DFCCD153943C069FB30B65D3885A646AEFB4`), and packaged `2.0.0` CHANGELOG
(SHA-256 `7FA2C0FD33CC7F1475AD279EF8119A4BCC6868D0DE331B62E03FD1B13F9EBA3D`) bytes across both architectures. The embedded
CHANGELOG contains S003/S015/S016/S021/S031/S037/S038/S039/S041/S042/S049/S050/S053/S079/S089/S090/S095/S100/S101/S104/S105/S108/S120/S122/S124/S126/S128,
  actual Visual Studio S005 and S006 project item-template transactions, actual Visual Studio S024 cross-runtime clipboard
  collision, actual Visual Studio S025 baseline snap, actual Visual Studio S026 SnapToGrid, actual Visual Studio S017
  marquee intersection, actual Visual Studio S110 UI Automation roles/ancestry/bounds, actual Visual Studio S061
  outline/Properties rename, actual Visual Studio S062 Timer tray/Properties selection, actual Visual Studio S046
  Red Color editor/Escape-cancel, actual Visual Studio S045 Red→Blue Color editor apply/native-Undo/Redo, actual Visual
  Studio S051 native Events rewire/empty-handler lifecycle, actual Visual Studio S079 native RTL mirroring, actual Visual
  Studio S085 protected inherited-property override/native-Undo/Redo, actual Visual Studio S086 private inherited-Label
  locked-Properties/refused-SetValue, actual Visual Studio S087 native Toolbox Add, actual Visual Studio S088
  cross-runtime private inherited drag refusal, the 121 `PASS` / 2 `NOT_EXECUTED` / 5 `GATED` repository result, and the `40/88`
  actual-Visual-Studio result.

The packaged CHANGELOG is 211,492 bytes; the 211,422-byte source SHA-256 is
`83261A1862E0FCF8B59419C232C7C768A1C28FCD522D1B96638296F87F38D5B3`. The 70-byte delta is only VSCE's
deterministic expansion of issue reference `#4711`. The restored-x64 performance run passes at startup **283.7 ms**,
warm median **42.6 ms**, and warm p95 **548.3 ms** against budgets **15000/1000/2500 ms**. The prior `vs38` ledger
and package pair remain retained as historical evidence but are superseded by this `vs39` pair.

| Artifact | Evidence |
|---|---|
| `.codex-tmp/release-2.0.0-final-vs39-20260824T153000Z/winforms-designer-2.0.0-win32-x64.vsix` | version `2.0.0`; target `win32-x64`; modern RID `win-x64`; modern PE `0x8664`; net48 PE `0x8664`; 204 entries; 18,179,308 bytes; SHA-256 `E0F4EE670ACA91DE72187B350B72D4A25E462FE3674AA35C638BC8F092CC3CBC` |
| `.codex-tmp/release-2.0.0-final-vs39-20260824T153000Z/winforms-designer-2.0.0-win32-arm64.vsix` | version `2.0.0`; target `win32-arm64`; modern RID `win-arm64`; modern PE `0xAA64`; net48 x64-compat PE `0x8664`; 204 entries; 18,167,109 bytes; SHA-256 `298FA4E0C06B2C1ADE57C387E216E7ADA7C5F6C0541ECB8651003100A60E7FEB` |

These are local package proofs from the live dirty tree, not clean-machine installation, signing, upload, publication,
or rollout evidence.

## Open gates and forbidden claims

The following remain explicit and must not be described as completed by this release:

- **NOT EXECUTED:** 88 Visual Studio reference traces outside the bounded archived corpus;
- **NOT EXECUTED:** 12 repository catalog scenarios: S096 still needs an OS-enforced workspace-write sandbox;
  S102 needs a physical Windows ARM64 package/worker run; S113/S114/S115/S116/S117/S119/S121/S123/S125/S127 are
  caller-supplied inspection/echo harnesses and therefore remain `HARNESS_ONLY`, not product PASS;
- **GATED / EXCLUDED:** x86, COM, and ActiveX support. Only the ActiveX source route has a product-wired
  non-mutating refusal; x86 project/output detection and a COM request/refusal contract are **NOT EXECUTED** and
  must not be described as product-wired;
- **GATED:** licensed third-party vendor artifacts, manifests, contracts, licenses, and certification cohorts;
- **NOT EXECUTED:** physical Windows ARM64 installation, DPI/multi-monitor interaction, screen readers, and OS
  high-contrast acceptance;
- **NOT EXECUTED:** 8-hour/500-cycle real-product soak and physical performance lab;
- **GATED / NOT EXECUTED:** independent legal/product/publication approval, signing/credentials, Marketplace/Open VSX
  publication, rollout monitoring, and rollback drill;
- **NO-GO:** clean Git release identity — the current implementation is not committed at `v2.0.0`, and this closeout
  neither creates commits nor tags;
- **NO-GO:** the phrases “full Visual Studio parity,” “Visual Studio-equivalent GA,” “arbitrary vendor compatibility,”
  “sandboxed vendor code,” or any equivalent unbounded claim.

## Final verdict

**Evidence integrity, W0-W3, and the bounded W5 product surface are repository-side closed; W4 is partial, and W6 local
package/metadata evidence is closed with the re-verified release-candidate pair. The overall release identity remains NO-GO until the exact tree is
committed and tagged `v2.0.0` from a clean checkout.** This is the remaining repository release-identity gate for the
bounded package claim; it is not papered over by the local VSIX hashes and does not close the wider W4 program.

**Unqualified Visual Studio parity/GA and external release/publication acceptance remain NO-GO / GATED / NOT
EXECUTED.** Those gates are deliberately preserved rather than being converted into a green result by wording.
