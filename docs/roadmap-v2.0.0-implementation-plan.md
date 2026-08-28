# v2.0.0 implementation roadmap — Visual Studio WinForms Designer parity

**Status:** repository implementation through the bounded 2.0.0 managed standard-control parity preview is closed;
the unqualified Visual Studio-parity/GA program and its external gates remain open.
**Last updated:** 2026-08-26.
**Baseline:** repository v1.15.0, including atomic Explorer Form/UserControl/Component/Class creation, real
default-event double-click, all-or-nothing mixed-value multi-object properties, and engine-measured precision layout,
plus default-size/exact-rectangle toolbox creation, canonical existing-project image-resource assignment, direct
strip-item reorder/reparent, **Insert Standard Items** for editable MenuStrip/ToolStrip collections, bounded
derived-source visual-inheritance overrides with fail-closed base reconciliation, and bounded Data Sources generation
and application-settings binding.
**Long-term target:** the Visual Studio **WinForms Designer** workflow, hosted naturally inside VS Code — not a second copy of the entire Visual Studio IDE. The planned 2.0.0 claim is narrower and is defined by the release gate record; the current clean-Git/tag gate remains `NO-GO`.

This is the execution document behind the public roadmap. It turns “Visual Studio parity” into bounded behaviors, architectural contracts, ordered work, kill gates, verification evidence, and an honest release claim. A v2 feature is not complete until it is safe on source and resources, keyboard and assistive-technology accessible, measured on a representative corpus, recoverable after a worker failure, and covered on every runtime tier it claims to support.

**Post-close continuation (2026-08-22):** the real VS Code Extension Host product suite now closes S001-S008,
S010-S012, S021, and S023 at repository level: clean/stale CustomEditor save, a real two-process S003 hot-exit restart
with one recovered native move/Undo unit on modern and compiled-net48 CustomEditors, aggregate nested-form Save As
collision refusal, SDK/classic Explorer Add with atomic persistence and forced-write compensation, unsafe item-name
refusal, ambiguous/missing-owner pre-render refusal, and a two-control engine-authorized move whose single native
Undo/Redo restores/reapplies both assignments. It also proves net48 reparenting rebases the child's absolute frame to
its new parent's client origin and proves that a concrete `GenericBaseForm<int>` session exposes inherited controls as
read-only while keeping derived controls editable. Subsequent bounded product proofs include selected-control rename,
tray selection, outline/menu/collection editing, real Properties search and standard values, strongly typed project
resources, local Form Icon Import, standard ColorEditor apply/cancel, Language-scoped neutral/fr-FR resource editing,
stale-resource refusal, compiled net48 binding, and exact ImageList compensation after a rejected final postcondition.
 The current catalog is 111 repository `PASS`, 12 `NOT_EXECUTED`, and 5 `GATED`; every PASS is backed by a completed
 machine-readable suite report and direct executed assertion anchors. Ten former caller-supplied capability-inspection
 echo rows are now honestly `NOT_EXECUTED / HARNESS_ONLY`. Forty actual Visual Studio reference traces are archived as
 `PASS`, while the remaining 88 stay explicitly `NOT_EXECUTED`. S074 specifically
uses the shipped Properties `Icon` Import transaction in the real modern CustomEditor on VS Code 1.84.0 and 1.134.0,
preserves opaque resx payload/metadata, and proves exact Designer-plus-resource Undo/Redo; actual Visual Studio and
physical ARM64 execution remain external.
S126 now replaces its preview-only headless evidence with the contributed High-DPI Advisor command on a real modern
CustomEditor. Live root metadata authorizes the exact `AutoScaleMode.None` assignment, the normal safe planner feeds a
read-only before/after VS Code diff, and Apply commits only that retained revision through the ordinary CustomDocument
firewall as one native Undo/Redo unit. S128 proves an intervening ordinary edit makes the preview stale and refuses
without replacing it. Both VS Code 1.84.0 and 1.134.0 pass with byte-exact disk; physical ARM64 and actual Visual Studio
reference execution remain external.
S124 now replaces caller-supplied headless crash metadata with an actual product worker loss in a real modern
CustomEditor. The mapped child is terminated while the form is open; the session becomes non-editable, Diagnostics
records the loss, bounded recovery starts a different PID, the exact clean graph returns, ordinary edit/native Undo
passes, and a later form continues through that recovered process on both VS Code 1.84.0 and 1.134.0. The actual
Visual Studio trace and an external crashing-vendor artifact remain external.
 S085-S088 additionally exercise visual inheritance through real source-identical modern and compiled-net48
CustomEditors. Protected inherited controls accept only a live-token-authorized derived override; private inherited
controls publish a visible read-only reason and reject Properties and canvas moves without mutation/history; a toolbox
 Add targets only the derived root and remains one native Undo/Redo unit. Base and derived disks remain exact before Save
 on both supported host lines. S085 now also has an actual Visual Studio Enterprise 2026 18.7 x64 reference: the installed
 designer selects the protected inherited Button, changes `Text` through native Properties, writes exactly one derived
 override, preserves both base artifacts, derived code-behind, and project bytes, removes the override through native
 Undo after deterministic CodeDOM canonicalization, and reproduces the applied Designer byte-exact on Redo. S086 now
 also has an actual Visual Studio 18.7 x64 reference: the installed designer exposes the private inherited Label with a
 native lock glyph, selects it, publishes `Text=Private inherited label` on a disabled Properties row, rejects an
 attempted UI Automation `SetValue`, and preserves all five base/derived/project artifacts byte-exact. S087 now has an
 actual classic-net48 reference: native `All Windows Forms → Button` adds exactly one derived-root control, native Undo
 removes it, and Redo restores the complete operation contract while measured CodeDOM byte differences remain visible.
 S088 now has actual modern and classic-net48 references: native locked/read-only selection plus a bounded designer-HWND
 drag leaves bounds, observable Saved/Undo states, and all ten artifacts exact. Physical ARM64 remains external.
S104 additionally exercises the established product engine lifecycle rather than the diagnostics-only v2 supervisor.
Three clean modern/compiled-net48 close/reopen cycles reuse the same two warm PIDs without duplicate children; after
the last session, the 30-second product idle path returns mapped engines and host-owned process registrations to zero,
proves both old OS PIDs exited, and starts fresh PIDs on reopen. VS Code 1.84.0 and 1.134.0 pass; Visual Studio,
physical ARM64, and performance-lab handle telemetry remain external.
S079 now selects ar-SA on a real compiled-net48 localizable CustomEditor and proves exact mirrored child geometry,
Arabic metadata, clean native history, and byte-exact source/Designer/neutral/culture resources on both host lines.
Its bounded actual Visual Studio Enterprise 2026 18.7 x64 reference independently opens an exact classic-net48
`RightToLeft=Yes` / `RightToLeftLayout=true` fixture, measures the real native Form/Button/Label HWNDs, and proves the
same mirror formula inside a `320×160` client without changing source, Designer, or project bytes.
S101 and S105 resolve actual `net8.0-windows` and built `net48` projects to running host-owned modern and net48
workers; S105 also reports live-source interpreted authority. Their remaining Visual Studio reference execution and
physical ARM64 stay external where applicable.
S016 now runs a generated 300-control standard-control form through real x64 modern and compiled-net48 CustomEditors
instead of accepting caller-supplied timings. Both publish 301 layout nodes; initial open stays below 5000 ms and a
selected Text commit plus reconciliation below 500 ms on VS Code 1.84.0 and 1.134.0. The accepted snapshot feeds
Properties without a trailing describe, native Undo restores the exact baseline, and all fixture disk hashes remain
unchanged. Actual Visual Studio, physical cross-architecture, and external performance-lab p95 evidence remain open.
S122 now consumes only real product telemetry from 50-control, 300-control modern/net48, and 180-control/96-FakeVendor
CustomEditor sessions at logical 100/125/150/200% DPI. High-DPI retained patches scale only the invalidated leaf and the
webview maps logical patch rectangles to physical canvas pixels; all 12 frozen budgets, same-snapshot checks, native
Undo, and disk guards pass on VS Code 1.84.0 and 1.134.0. Physical performance-lab p95, a licensed vendor artifact, and
the Visual Studio reference remain open. S120 is also repository-automated on both host lines: its mandatory bounded
move/save/native-Undo leg matches the archived Visual Studio Enterprise 2026 18.7 byte-identical Save All trace.
S100 and S108 now add the missing bidirectional product corpus: modern and compiled-net48 CustomEditors save the exact
exported Forms, actual Visual Studio Enterprise 2026 18.7 opens and saves those artifacts, and subsequent real product
runs reopen the archived Visual Studio output through the matching engine with exact Text semantics, clean state, and
CustomDocument/disk equality. The static S100 adapter remains data-only and has no vendor-code or workspace-write
authority. Only S096 (OS-enforced isolation of arbitrary designer callbacks) and S102 (physical Windows ARM64 execution)
  remain repository `NOT_EXECUTED`; the other 88 Visual Studio reference traces remain open. S024 now has an actual
  Visual Studio 18.7 x64 reference on both modern and net48: native Copy/Paste resolves occupied `submitButton` to
  unique `button1`, preserves copied properties/ownership, and passes exact Undo/Redo. Visual Studio's observed
  `(98,74)` Paste location is recorded separately from the product's bounded 8px placement, so no coordinate-parity
  claim is inferred from the collision-safety `PASS`. S005 now records the actual modern SDK project-system baseline:
  Visual Studio resolves its installed `Microsoft.CSharp.WindowsForm` template, creates the source, nested Designer
  source, and neutral resx, leaves the SDK project byte-identical, builds the solution, and opens the new Form in the
  native designer. The bounded per-user `.csproj.user` sidecar is recorded separately from the immutable project file.
S051 now also has a bounded classic-net48 Visual Studio 18.7 x64 reference: native Document Outline selects `textBox1`,
the real Events editor rewires `TextChanged` to the compatible alternate handler, and Visual Studio's empty-handler
lifecycle is frozen across native Undo/Redo while project bytes and unrelated source/Designer facts stay exact. The
repository CustomEditor independently retains its dual-document revision refusal and stable rewire transaction.
S006 records the adjacent classic net48 project-system baseline. Visual Studio resolves the installed
`Microsoft.CSharp.WindowsFormsUserControl` item template, creates only source plus nested Designer source, writes the
exact `SubType=UserControl`/`DependentUpon` Compile relationships, adds no neutral resx or `EmbeddedResource`, rebuilds,
and opens the native designer. The product Explorer Add implementation now matches that observed two-file contract
instead of pre-seeding a resource that Visual Studio does not create.
S025 records the actual native baseline-snap contract at 96 DPI: moving a default Button to raw source Y `36` is
corrected to Y `35`, aligning its measured baseline offset `21` with the default TextBox offset `16`. The product now
publishes those exact baseline snap lines, translates the guide through the full-frame client origin, and gives the
baseline candidate precedence over a closer center candidate, with exact engine and webview regression coverage.
S026 records the actual native SnapToGrid contract at 96 DPI: with the effective 8×8 parent grid, a raw AutoSize Label
target `(33,25)` persists at `(32,24)` and preserves Size `57×15`. The capture restores the exact original designer
options, while the product's full-frame webview evidence reproduces the same move and grid-aware resize. The resulting
29-scenario actual-Visual-Studio control run terminates with 22 `PASS`, 6 `CAPTURED_UNREVIEWED`, 1 `NOT_EXECUTED`, and
0 `FAIL`; at that control-run snapshot W4 remained open for the other 94 rows. A later focused S017 trace proves that the modern designer marquee
selects every positive-area intersection among direct children of the active Panel, including a partially intersected
Button, while excluding nonintersecting Panel children and Form-level controls. The product marquee now uses that same
intersection rule and container boundary; its full webview suite passes 970 checks across 209 tests. The reversible
Copy/Paste selection probe is archived separately from its disclosed CodeDOM block-order normalization after Undo.
The later focused S110 trace reads the installed designer's UI Automation model without mutation: Button, TextBox,
visual MenuStrip, nested File menu item, and Timer tray component each expose an exact role/type, enabled and onscreen
state, non-empty bounds, and raw-view parent chain. Source, Designer, and project hashes remain exact. This closes the
x64 Visual Studio reference leg only; physical ARM64 and live assistive-technology acceptance remain external gates.
The focused S061 trace selects `button1` in the real owner-drawn Document Outline and commits `submitButton` through
Properties `(Name)`. Visual Studio changes the field, all eight member references, and the `Name` literal exactly once;
one native Undo restores the semantic original and Redo reproduces the renamed Designer bytes exactly, while source and
project remain byte-identical. Native outline F2 did not expose an inline editor, so it is not claimed as Visual Studio
behavior; the product's F2 binding is an additive shortcut over the matching atomic selected-control rename.
The focused S062 trace clicks the installed designer's visible `refreshTimer` Pane beneath `ComponentTray`; native
Properties identifies `refreshTimer System.Windows.Forms.Timer` and shows `(Name)=refreshTimer`, `Enabled=False`,
and `Interval=1500` while source, Designer, and project hashes remain exact. The product independently matches the
nonvisual tray/session-pick and live Timer Properties contract; physical Windows ARM64 execution remains external.
S082 additionally refreshes the dedicated Data Sources pane from a real modern `Customer` schema and commits its
DataGridView, BindingSource, columns, and BindingNavigator as one unsaved native history unit with exact pre-Save disk
bytes. S084 proves the adjacent unsupported-provider boundary through real modern and compiled-net48 CustomEditors:
typed `UNSUPPORTED_DATA_PROVIDER`, no generated IDs, no dirty/history entry, and no disk mutation. Both host lines pass;
actual Visual Studio reference execution and S082 physical ARM64 remain external.
S075 additionally selects a compiled-net48 tray `ImageList`, serializes two PNGs through the bundled engine, commits
canonical Designer plus binary-resx output as one native history unit, and proves exact Undo/Redo on both supported
VS Code host lines; its actual Visual Studio trace remains external.
S076 additionally runs an injection-shaped project-resource accessor through real modern and compiled-net48
CustomEditors after live `Button.Image` metadata authorization. Both refuse with typed `INVALID_RESOURCE_SYMBOL`
before resource discovery, source planning, mutation, native history, or disk writes on both supported host lines;
actual Visual Studio execution remains external.
S118 additionally drives the shipped modern ImageList transaction through a real CustomEditor, writes and verifies the
planned resource bytes, then rejects only the final forward postcondition through a deterministic Extension Host seam.
The normal durable runner compensates to exact source, Designer, opaque-resx, clean-tab, and empty-history baselines on
both supported host lines; actual Visual Studio and physical ARM64 execution remain external.
S045/S046 additionally start from live `Button.BackColor` metadata that publishes the framework `ColorEditor`. A
deterministic seam replaces only the native modal Blue/dismiss outcome; the shared product ingress, normal source plan,
CustomDocument commit, canonical `Color.Blue` expression, dirty state, native Undo/Redo, typed `CANCELLED` result, and
cancel no-mutation checks run on VS Code 1.84.0 and Stable. S046 now also has an actual Visual Studio x64 reference:
explicit `BackColor=Red` opens the native owner-drawn `Custom / Web / System` Color editor with Red selected, and
`Esc` preserves Red plus every project input hash. S045 independently selects the exact native `Blue` Web-color row,
accepts canonical `Color.Blue`, preserves all sibling Button properties, and proves one native Undo back to Red plus one
Redo byte-identical to apply while source/project remain exact. Physical ARM64 remains external where catalogued.
S047 additionally runs the exact in-repo MIT FakeVendor dropdown through the actual isolated child worker from live
compiled-net48 metadata, then commits `Vendor Beta` through the proven Lane B owned region as one native Undo/Redo
unit. S048 runs the actual wrong-type worker outcome on modern and compiled-net48 sessions and receives
`INVALID_EDITOR_RESULT` with no source/history mutation. Both host lines pass; licensed-vendor and Visual Studio gates
remain external.
S071 additionally runs the exact certified FakeVendor collection editor through the actual isolated worker from live
modern and compiled-net48 metadata. Its `[1,2] → [3,5]` result enters the product as a generic-list proposal, passes the
engine-owned bounded-region planner, and becomes one Lane B native Undo/Redo/final-Undo unit without writing disk.
S072 proves the negative boundary with the same successful worker: a proposal that also changes root `Form.Text` is
rejected as `OWNED_REGION_VIOLATION` with exact source, dirty-state, history, and disk no-mutation on both host lines.
Licensed-vendor and actual Visual Studio certification remain external.
S020 additionally binds every canvas selection/manipulation intent to the generation of the PNG actually drawn. The
open CustomEditor, not the browser, is authoritative: missing, malformed, and older generations return typed
`STALE_CANVAS` before selection, source, dirty state, history, or disk mutation. Real modern and compiled-net48
sessions start a newer full render, reject an old click and keyboard nudge with native Undo remaining a no-op, then
accept the fresh generation on both VS Code host lines. Actual Visual Studio reference execution remains external.
S093 additionally renders a bounded `ControlDesigner` adorner on the real modern CustomEditor canvas from the
workspace-built in-repo MIT FakeVendor fixture. Hover is accepted only after a fresh engine graph and the live designer
confirm the exact control-local point; unit, webview, and both Extension Host lines prove visible feedback plus exact
source, dirty-state, native-history, and disk no-mutation. Licensed-vendor and Visual Studio gates stay external.
S094 additionally builds the in-repo MIT FakeVendor project inside the disposable workspace, reads the live
`ComponentDesigner.ActionLists` Caption descriptor through the real modern CustomEditor, maps it to `Text`, and proves
canonical source plus one native Undo/Redo unit. Licensed-vendor, Visual Studio, and physical ARM64 gates stay external.
S089/S090 additionally bind the exact repository-certified modern hosted-service fixture to the ordinary CustomEditor.
The engine publishes `Apply Service Preset` only after proving STA, assembly/component/designer/certificate identity,
and complete container, selection, change, name, command, and toolbox capabilities; incomplete kernels withhold
`IDesignerHost`, and unsupported services refuse explicitly. The webview sends only the certified command identity.
The host revalidates the live revision and exact one-transaction/two-change result, independently plans `Text` and
`Size`, and commits them as one unsaved native Undo/Redo unit; a forged certificate is exact no-mutation. Unit, webview,
and both Extension Host lines pass. S091/S092 additionally run the shared service registry through a real
compiled-net48 CustomEditor: the certified cancellation command opens one outer transaction in a disposable private-
desktop child, refuses the nested transaction as `REENTRANT_CANCELLED`, balances all four change events, restores the
transient graph, emits no source proposal, and leaves source, dirty state, native history, project/assembly disks, and
the mapped EngineApi process exact. Arbitrary vendor designers, licensed-vendor certification, physical ARM64, and
actual Visual Studio reference execution remain external.

## 1. Product contract

### 1.1 The v2 promise

v2.0.0 should let a WinForms developer perform the normal Visual Studio designer loop without opening Visual Studio:

1. create or open a Form/UserControl;
2. discover framework, project, and vendor components;
3. select, place, align, resize, reparent, order, copy, and remove components;
4. edit properties, events, collections, resources, localization, bindings, and inherited overrides;
5. use supported ControlDesigner, DesignerActionList, designer verbs, converters, and modal editors;
6. save, undo, redo, build, reopen, and round-trip through Visual Studio without silent source or resource loss;
7. diagnose an unsupported or failed design-time operation without guessing what the designer executed or changed.

The UI follows VS Code conventions, but gestures, results, keyboard reflexes, component behavior, generated-code compatibility, and failure semantics should be equivalent to the Visual Studio WinForms Designer. Where this project is already stronger — minimal source diffs, named refusal reasons, cross-runtime visibility, headless validation, and reproducible diagnostics — v2 preserves and expands that advantage.

### 1.2 What “parity” means

| Term | Required meaning |
|---|---|
| **Exact parity** | The same input produces the same component graph, persisted semantics, selection/layout result, and undo unit as Visual Studio. UI chrome may remain VS Code-native. |
| **Workflow parity** | The developer completes the same task with no extra source editing, even if the command is surfaced differently. |
| **Compatible parity** | A form round-trips between Visual Studio and this extension without semantic drift or unrelated changes. |
| **Superior workflow** | The extension adds measurable value without producing a dialect Visual Studio cannot reopen: source/resource diff preview, capability explanations, CI validation, recovery, or broader diagnostics. |
| **Unsupported** | The operation is disabled before mutation, with a stable reason code, affected target, recovery action, and support-tier link. A partial or silent imitation does not count as parity. |

The unqualified public phrase **“Visual Studio parity”** is allowed only after all GA gates in section 9 pass. Until then, release notes must name the achieved tier, for example “managed standard-control parity preview.”

### 1.3 Scope boundary: designer, not another IDE

v2 integrates with VS Code/C# tooling for code completion, semantic rename, navigation, diagnostics, build, debugging, testing, source control, and package management. It does not reimplement Roslyn, a C# editor, a debugger, Test Explorer, Git, or NuGet. Designer commands may invoke or deep-link to those existing surfaces.

The following are not part of the v2 parity claim:

- WPF, MAUI, Avalonia, web, or non-Windows visual designers;
- pixel-identical Visual Studio window chrome;
- undocumented Visual Studio/DesignToolsServer protocol compatibility or redistribution of proprietary binaries;
- arbitrary code execution made “safe” by AppDomain, ALC, or a child process — those are lifecycle boundaries, not security sandboxes;
- universal compatibility with every vendor version, licensing system, native dependency, or broken designer;
- VB WithEvents/Handles parity unless separately staffed, designed, and added to the release claim;
- Linux/macOS/WSL rendering. A Windows UI host remains required.

Phase 0 records the v2.0.0 runtime cut explicitly: the managed GA baseline is modern `win-x64` / `win-arm64`
plus .NET Framework 4.8 x64 compatibility. Tier D (`x86`, `COM`, and `ActiveX`) is excluded by name from
v2.0.0 GA and moves to a post-v2 decision. Unsupported Tier D requests must fail before mutation with stable
diagnostics such as `X86_WORKER_UNAVAILABLE` or `COM_ACTIVE_X_UNSUPPORTED`, never by attempting a partial edit.
As shipped, only the ActiveX source route meets that bar: an AxInterop/AxHost-bearing Designer file refuses before
render. The x86 predicate is reachable only on the Framework route (nothing reads `PlatformTarget`/`Prefer32Bit`)
and the COM refusal has no product caller, so both remain gated rather than product-wired.

## 2. Live baseline and constraints

The plan builds on the existing product instead of restarting it:

- [extension/src/designerEditor.ts](../extension/src/designerEditor.ts) owns the custom document (WinFormsDesignDocument, line 772), session orchestration (DesignerSession, line 1107), safe commit funnel (commit, line 1996), and full render reconciliation (fullRender, line 2621).
- [extension/src/engineClient.ts](../extension/src/engineClient.ts) contains the RPC handle and a large hand-written DTO/client surface; EngineHandle begins at line 17 and the render DTO family near line 216.
- [engine/Program.cs](../engine/Program.cs) exposes the modern RPC boundary through EngineApi at line 1446.
- [engine/DesignerRenderer.cs](../engine/DesignerRenderer.cs) is the modern render/describe/edit facade at line 59.
- [engine/DesignerControlEditor.cs](../engine/DesignerControlEditor.cs) owns source-first structural writers and independent safety gates; the current tab-order writer/gate are at lines 928 and 1096.
- [engine-net48/RenderWorker.cs](../engine-net48/RenderWorker.cs) owns interpreted and compiled-fallback runtime state; interpreted rendering begins at line 203 and the worker has both render and mutation responsibilities.
- [ADR 0001](adr/0001-net48-live-source-interpretation.md) and [ADR 0002](adr/0002-m4-edit-parity-design.md) make source authority, closed IR, runtime validation, identity/origin, and disclosed fallback load-bearing constraints.

As of this audit, the largest coordination files are approximately 7,497 lines (designerEditor.ts), 3,617 lines (DesignerRenderer.cs), 3,491 lines (RenderWorker.cs), 2,494 lines (panel.js), 2,290 lines (DesignerControlEditor.cs), 2,273 lines (engineClient.ts), and 2,229 lines (designer.js). v2 must not add a second architecture inside these files. Controlled decomposition with characterization tests is a release-enabling feature, not optional cleanup.

The 1.15 Data Sources milestone is now repository-side complete and becomes input to the v2 parity corpus; v2 does
not postpone every daily-workflow improvement behind the new design-time host.

## 3. Capability and parity matrix

Legend: **GA** is required for the v2 parity claim; **conditional** is required only when its Phase 0 gate passes and the claim includes that tier; **2.x** is outside v2 GA.

| ID | Capability | v2 target | Tier | Acceptance summary |
|---|---|---|---|---|
| DOC-01 | Form/UserControl open, save, Save As, hot exit, external changes | Exact | GA | No blind overwrite; dirty/undo state survives reload; concurrent disk changes refuse before mutation. |
| DOC-02 | Add Form/UserControl/component class | Workflow | GA | SDK and classic projects compile; file/project/resource creation is atomic and collision-safe. |
| DOC-03 | Partial/nested/generic/base-type resolution | Compatible | GA | Correct owning project/type; ambiguous topology is a named refusal. |
| SRF-01 | Real control rendering and hit testing | Exact | GA | Framework corpus matches runtime geometry/appearance within approved pixel tolerances. |
| SRF-02 | Select, multi-select, keyboard traversal, marquee | Exact | GA | Mouse and keyboard scenario suite; deterministic nested-container scope. |
| SRF-03 | Move, resize, reparent, z-order, copy/cut/paste/duplicate | Exact | GA | One transaction, engine-authoritative final layout, no coordinate drift. |
| LAY-01 | SnapLines/SnapToGrid/None, Alt override, grid visibility | Exact | GA | Margin/padding/baseline guides and configurable grid match reference scenarios. |
| LAY-02 | Align, size, center, spacing, anchors/dock | Exact | GA | Multi-selection commands match Visual Studio outcomes across DPI and zoom. |
| LAY-03 | Table/Flow/Split/Tab/container editing | Exact | GA | Container adapters round-trip on modern and net48 tiers. |
| PRP-01 | Categorized/alphabetical/search property grid | Workflow | GA | Multi-object intersection, mixed values, defaults/bold/reset, descriptions, keyboard navigation. |
| PRP-02 | TypeConverter, standard values, expandable values | Exact | GA | Bounded metadata and hosted converter paths; exception/cycle/latency isolation. |
| PRP-03 | Framework and vendor UITypeEditor | Compatible | GA for managed supported set | Modal/dropdown broker is cancellable, owned, DPI/theme-aware, and cannot bypass the transaction planner. |
| EVT-01 | Events tab, default event, handler generation/navigation | Exact | GA | Double-click and event grid use real metadata; source/code-behind revisions are checked together. |
| TLB-01 | Toolbox discovery/search/categories/favorites/Choose Items | Workflow | GA | Framework/project/vendor items, auto-population, cache provenance, user-curated suppression. |
| TLB-02 | COM/ActiveX toolbox and AxHost generation | Exact | 2.x; excluded from v2.0.0 GA | v2.0.0 refuses before mutation with `COM_ACTIVE_X_UNSUPPORTED`; future support needs x86/x64 fixtures, license/resource generation, packaging and security gates. |
| OUT-01 | Document Outline and component tray | Exact | GA | Rename/reparent/order/select; nonvisual components and inherited ownership are accurate. |
| MNU-01 | MenuStrip/ToolStrip/ContextMenuStrip | Exact | GA | Direct nested edit, verbs, standard items, drag/reorder/reparent, overflow and tray paths. |
| COL-01 | Collection editors | Compatible | GA | Standard and hosted vendor collection editors plan an inspectable atomic patch. |
| RES-01 | .resx, images/icons/ImageList/project resources | Compatible | GA | Unknown/opaque nodes preserved; multi-file undo/conflict/rollback proven. |
| LOC-01 | Localizable forms, culture overlays, RTL | Exact | GA | Neutral/parent/exact fallback, ApplyResources and native RTL UX pass the matrix. |
| DAT-01 | Data Sources, binding UI, detail/grid/navigation generation | Workflow | GA | Recognized schemas produce stable BindingSource/Navigator/grid code; unsupported providers refuse. |
| INH-01 | Visual inheritance | Compatible | GA | Accessible inherited controls allow bounded derived overrides; base source is never modified implicitly. |
| EXT-01 | IDesignerHost service kernel | Compatible | GA | Documented service contract with transactions, selection, changes, names, commands, toolbox and serialization. |
| EXT-02 | ControlDesigner, adorners, verbs, DesignerActionList | Compatible | GA | Certified managed designers run in an isolated worker tier; capabilities and failures are explicit. |
| EXT-03 | Vendor adapter SDK | Superior | GA | Versioned public adapter/protocol surface, samples, compatibility tests, no product-specific hard-coded branch. |
| RUN-01 | Modern .NET runtime/architecture matrix | Compatible | GA | Project TFM/runtime selection, `win-x64` / `win-arm64` workers, unload/recycle and dependency isolation. |
| RUN-02 | .NET Framework runtime/bitness matrix | Compatible | GA for x64 compatibility only; x86 excluded from v2.0.0 GA | Live-source authority retained on x64 compatibility. As shipped, the `X86_WORKER_UNAVAILABLE` refusal is reached by the ActiveX source gate and by an explicitly bound Framework output; general x86 project detection is gated and not executed. |
| ACC-01 | Keyboard, screen reader, high contrast, zoom | Workflow | GA | All product operations are keyboard reachable; accessible mirror tree and manual AT evidence. |
| DIA-01 | Capability inspector and diagnostics | Superior | GA | Every unavailable operation has reason, target, recovery; export is reproducible and redacted. |
| SAF-01 | Source/resource integrity | Superior | GA | Zero silent loss/corruption; every mutation has a validated patch plan and independent postcondition. |
| AUT-01 | Headless designer validation CLI/CI | Superior | GA | Machine-readable compatibility, fallback, diff, performance, security and leak reports. |
| A11-01 | Accessibility/DPI/localization advisor | Superior | GA | Non-mutating Problems diagnostics plus opt-in, previewed quick fixes for supported rules. |
| AI-01 | Natural-language layout/repair | Integrated, optional | 2.x | Use VS Code chat/tool APIs; never a v2 safety dependency and default off until separately approved. |

### 3.1 Support tiers and claim thresholds

| Tier | Corpus | Minimum claim gate |
|---|---|---|
| **A — Microsoft framework** | Standard controls, containers, components, resources and binding patterns on supported runtimes | 100% required scenarios; zero silent fallback, corruption, crash, or unexplained semantic diff. |
| **B — custom managed controls** | In-repo FakeVendor plus independent samples using documented design-time APIs | At least 98% required scenarios; every miss classified and non-mutating. |
| **C — certified vendor suites** | Licensed, versioned cohorts from at least three materially different suites, or an explicitly smaller named set | At least 95% required scenarios per advertised cohort; zero silent mismatch/data loss; archived redacted manifest. |
| **D — COM/ActiveX/x86** | Signed/unsigned test controls, AxHost resources/licenses, AnyCPU/x86/x64 projects | Excluded by name from v2.0.0 GA. Future 2.x support requires 100% of an advertised matrix. v2.0.0 refuses ActiveX-bearing Designer source before render with `X86_WORKER_UNAVAILABLE` and no mutation; general x86 project detection and the `COM_ACTIVE_X_UNSUPPORTED` toolbox contract are gated and not executed. |

Percentages never waive a safety failure. One silent mutation, unexplained source loss, arbitrary-source execution, cross-document overwrite, or undisclosed stale canvas is a release blocker regardless of aggregate pass rate.

## 4. Target architecture

~~~text
VS Code extension host
  ├─ Project & document resolver
  ├─ DesignerDocumentStore (source, resx, code-behind, project baselines)
  ├─ DesignerCommandBus (intent → plan → authorize → commit → reconcile)
  ├─ Undo/resource transaction journal
  ├─ WorkerSupervisor (runtime × architecture × project × trust tier)
  ├─ generated protocol client + capability negotiation
  └─ Webview workbench
       ├─ state store / focus / keyboard / accessibility
       ├─ canvas + adorner layers
       ├─ toolbox / outline / tray
       └─ properties / events / resources / data sources / diagnostics

Versioned Designer Protocol
  ├─ control channel: bounded typed request/response/events
  ├─ render channel: sequenced frame/tile payloads
  └─ adapter SDK: versioned vendor-neutral contracts

Disposable designer workers
  ├─ Session kernel and design-time service container
  ├─ runtime adapter: modern .NET or .NET Framework
  ├─ component graph + stable identity/origin
  ├─ rendering, hit testing, layout and capture
  ├─ converters/editors/designers/verbs broker
  ├─ source-first and hosted-serialization planners
  └─ diagnostics, quotas, cancellation and deterministic teardown
~~~

### 4.1 Module boundaries

| Current concentration | Planned modules |
|---|---|
| designerEditor.ts | document, session, commands, render, transactions, resources, toolbox, localization, diagnostics |
| engineClient.ts | generated protocol DTO/client, small lifecycle client, binary render transport |
| designer.js / panel.js | typed message facade, state store, canvas, property/event grid, toolbox, outline/tray, dialogs, a11y |
| DesignerRenderer.cs | parse/IR, hosted session, render/capture, describe/metadata, capability classification |
| DesignerControlEditor.cs | command-specific planners plus shared independent postcondition gates |
| net48 RenderWorker.cs | session lifecycle, interpreted host, compiled fallback, metadata, live adapter, capture, disposal |

Characterization tests must land before moving behavior. No decomposition patch may change source output, protocol payloads, failure codes, render geometry, or undo boundaries unless its issue declares and tests the change. New hand-written coordination files should stay below roughly 1,500 lines; generated protocol code is exempt.

### 4.2 Protocol contract

Every envelope carries at least:

- protocol version and compatible range, binary build ID, and feature flags;
- session, document, request, and optional idempotent command identity;
- document revision, render generation, and source/resource fingerprints;
- deadline/cancellation identity, payload-size limits, and trace correlation;
- structured success, refusal, partial, cancelled, stale, unsupported, and fault outcomes.

The protocol uses closed, bounded DTOs. It never transports delegates, reflection objects, syntax nodes, arbitrary serialized graphs, or expression strings for a worker to execute. Unknown required fields/capabilities refuse. N and N−1 compatibility and partial-update self-repair are release tests.

### 4.3 One command model

Every mutation, whether initiated by drag, property grid, smart tag, vendor editor, quick fix, keyboard command, or automation, follows the same lifecycle:

1. capture exact document/resource/code/project revisions;
2. translate UI input to a typed designer intent;
3. resolve identity, ownership, runtime tier, and capabilities in the authoritative session;
4. produce a deterministic PatchSet plus semantic postconditions and reconciliation intent;
5. optionally preview high-impact/normalizing/vendor-generated diffs;
6. revalidate all baselines and authorize the whole set;
7. apply atomically or compensate without overwriting a concurrent external edit;
8. record one undo unit and a redacted audit event;
9. reconcile from committed state and reject stale replies;
10. independently verify the intended graph/source/resource change.

Webview messages and vendor-returned values are untrusted input. They request an intent; they cannot supply an authorized patch or bypass capability, revision, source-minimality, ownership, or resource gates.

### 4.4 Dual persistence lane

- **Lane A — minimal source adapters.** Existing byte-local Roslyn/text writers remain the default for known shapes. The current broad commit firewall remains a final guard.
- **Lane B — designer-owned region serialization.** Operations that genuinely require a hosted designer may propose a replacement only for explicitly identified generated regions/resources. The planner proves the user partial class, unrelated members, unknown statements/resources, encoding, BOM, and declared preservation zones are unchanged. Semantic equivalence and expected component-graph delta are checked independently.
- A Lane B diff above the normalization threshold requires clear preview/consent and never occurs merely by opening a form. Ambiguous ownership or equivalence refuses.
- Multi-file changes to source, resources, code-behind, or project files use a journaled exact-baseline transaction. No worker writes workspace files directly.

ADR 0001/0002 remain authoritative until Phase 0 approves **ADR 0003: v2 hosted design-time services and dual-lane persistence**. ADR 0003 must state exactly which previous non-goals it supersedes; a roadmap line alone does not weaken those decisions.

### 4.5 Hosted service kernel

The host grows by contract and corpus evidence, not by advertising a fake all-purpose service provider. Candidate milestones include real container/siting and naming; selection and component-change notifications; designer transactions and command routing; toolbox and serialization services; type resolution and property filtering; and the minimum UI broker for supported editors. For every advertised service:

- method semantics, STA/threading, lifetime, reentrancy, cancellation, and exception mapping are documented;
- a contract test proves successful and unavailable behavior;
- vendor code never receives a non-null service whose invariants are incomplete;
- design-time changes still return through the common command/patch planner.

### 4.6 Worker and trust model

Workers are disposable lifecycle boundaries selected by runtime, architecture, dependency graph, and trust tier. They run on STA with a message pump and are supervised for deadlines, memory, GDI/USER handles, crash loops, output locks, and deterministic unload/recycle.

Compiled project/vendor controls are **trusted-to-execute**: constructors, accessors, type descriptors, designers, editors, painting, and native dependencies can run arbitrary code. ALC, AppDomain, process separation, Job Objects, and quotas reduce blast radius and improve recovery; they are not a sandbox. Therefore:

- untrusted workspaces get parse-only/read-only behavior and no build, restore, assembly load, or design-time code;
- hosted vendor design-time code requires a trusted workspace plus explicit per-workspace enablement and provenance UI;
- generic source-first behavior remains available where its existing trust contract permits;
- network/filesystem restriction is claimed only if a verified OS sandbox is actually implemented;
- diagnostics distinguish refusal, dependency failure, vendor exception, timeout/crash, quota recycle, and disabled code.

## 5. Workstreams and owned deliverables

| Workstream | Deliverables | Primary areas |
|---|---|---|
| **FND — product/ground truth** | Scenario catalog, parity matrix, support tiers, ADR 0003, legal/licensing records | roadmap, ADRs, planned parity tests |
| **ARC — decomposition/protocol** | Module seams, schema source, generated clients/servers, capabilities, compatibility tests | extension, webview, planned protocol project |
| **DOC — documents/transactions** | Multi-artifact store, PatchSet, journal, undo/redo, diff preview, conflict recovery | extension document/transaction modules, engine planners |
| **HST — designer host** | Session kernel, services, designers/verbs/action lists, editor broker | planned engine Hosting modules, net48 adapter |
| **SRF — canvas/layout** | Authoritative geometry, prediction, guides/grid, selection, container adapters, smooth interaction | engine geometry/capture, webview canvas |
| **PRP — metadata/editors/events** | Multi-object grid, converters, editors, events/default handlers, collections | engine describe/editor, panel modules |
| **PRJ — project/assets/data** | Scaffolding, project resolution, resources, localization, Data Sources, settings binding | extension resolver, resource/data planners |
| **RUN — runtime/vendor** | Managed modern/net48 matrix, Tier D refusal boundary, bitness/dependencies, adapter SDK, certification | engines, supervisor, fixtures |
| **QAS — quality/security/a11y** | Threat model, adversarial/parity/golden/perf/soak/a11y CI, manifests | tests, scripts, workflows, testing docs |
| **REL — migration/release** | Settings/cache/protocol migrations, packages, rollback, support matrix, evidence ledger | metadata, release workflow/docs |

Every issue names one owner, affected protocol version, source/resource risk, tests, diagnostics impact, runtime matrix, and closing gate.

## 6. Execution phases

Effort bands assume a stable core team of roughly 6–9 people: lead/architect, three C# engine/runtime engineers, two TypeScript/webview engineers, QA/test infrastructure, and part-time security, UX/a11y, release and legal/vendor support. They are planning ranges, not calendar commitments. With that team, v2 is plausibly an 18–30 month program; a single maintainer should treat near-Visual-Studio parity as multi-year and cut claims by tier rather than weaken gates.

### Phase 0 — definition and kill spikes (4–8 weeks)

- **V2-FND-001:** freeze a versioned Visual Studio catalog with traces and at least 100 core scenarios.
- **V2-FND-002:** approve ADR 0003, trust model, proprietary-binary exclusion, rollback and cut decisions.
- **V2-HST-001:** host a real Form and UserControl on the exact modern runtime using approved redistributable dependencies; inventory actual services.
- **V2-HST-002:** prove net48 x64 compatibility feasibility only; x86/COM is explicitly outside v2.0.0 GA and must
  fail closed with `X86_WORKER_UNAVAILABLE` / `COM_ACTIVE_X_UNSUPPORTED`.
- **V2-PRP-001:** prove one framework and one FakeVendor designer/action list/editor through the broker, including cancellation, reentrancy, crash, and invalid return.
- **V2-DOC-001:** produce Lane A/Lane B plans for the same forms; prove byte/semantic preservation and Visual Studio round-trip.
- **V2-SRF-001:** measure capture, preview, commit, and reconciliation on 50-, 300-, and vendor-heavy forms across the DPI matrix.
- **V2-RUN-001:** approve the repo-side managed runtime baseline (`win-x64`, `win-arm64`, and net48 x64
  compatibility) while recording licensing, redistribution, security, vendor certification, physical hardware,
  legal/product, and publication decisions as external PASS/GATED/NOT EXECUTED evidence.

**Phase 0 runtime/legal decision:** `V2-RUN-001` is repo-side approved for the managed baseline only. The repository
can document and package the managed route, but legal approval, vendor agreements/certification, physical x64/ARM64
hardware validation, publication credentials, and public rollout remain **GATED** or **NOT EXECUTED** until separately
proven.

**Exit / kill gate:** no production implementation before managed hosting, dual-lane round-trip, worker recovery, and
editor broker pass. The managed runtime route may proceed within the recorded external gates above. A failed hosted
serializer keeps that shape source-first. A failed vendor-host route narrows the claim. Tier D is already removed from
v2.0.0 GA, so x86/COM/ActiveX work cannot delay the managed baseline.

### Phase 1 — architectural runway, zero feature regression (8–14 weeks)

- **V2-ARC-001:** characterize current document, commit, render, property, resource, toolbox, tab, event, and fallback behavior.
- **V2-ARC-002:** split designerEditor.ts by document/session/command/render/transaction domains.
- **V2-ARC-003:** define protocol schema source and generate TypeScript/C# bindings.
- **V2-ARC-004:** split webview scripts into typed bundled modules with one validated message facade and central state.
- **V2-ARC-005:** split modern/net48 workers by session/render/metadata/mutation/lifecycle.
- **V2-DOC-002:** introduce document store, multi-artifact fingerprints, DesignerIntent, PatchSet, and journal behind current commands.
- **V2-RUN-002:** introduce WorkerSupervisor, capabilities, deadlines, cancellation, crash policy, worker keys, and diagnostics.
- **V2-REL-001:** add N/N−1 protocol, partial-update, settings/cache migration, rollback, and self-repair tests.

**Current repository-side foundation evidence:** [`v1-characterization-matrix.md`](v2/v1-characterization-matrix.md)
freezes the observable document, commit, render, property, resource, toolbox, tab, event, fallback, lifecycle, and
diagnostic behavior that the architecture runway must preserve. The working tree also contains a generated v2 protocol
schema and TypeScript/C# bindings, document snapshots/fingerprints, bounded PatchSet validation, an atomic process-crash journal
model, a pure transaction runner with exact-baseline revalidation, per-target progress, guarded compensation,
`recoveryRequired` ambiguity handling, and one-undo-unit registration, Phase 0 performance-report validation, and a pure
WorkerSupervisor/worker-selection foundation for the managed runtime cut. These pieces are covered by focused unit tests
and build/typecheck gates, but they are not yet wired as the sole command path, do not prove Visual Studio reference
parity, and do not satisfy the Phase 1 exit condition above.

**Exit:** every v1.7 plus landed 1.x test is green with byte-identical expected output. Protocol fuzzing, stale replies, crash recovery, and transactions pass. Old coordination classes become facades or are removed; there are not two truths.

### Phase 2 — first-party Visual Studio workflow parity (12–18 weeks)

- complete keyboard selection/focus/marquee and accessible state;
- complete layout modes, grid, baseline/margin/padding snaplines, spacing, live dimensions, and authoritative reconciliation;
- complete first-party container and menu/toolstrip direct manipulation;
- ship multi-object properties, mixed values, categorized/alphabetical/search, and atomic reset/edit;
- harden the landed default-event double-click and F7/Shift+F7 routes through cross-tool round-trip, accessibility,
  and safe refactoring integration while completing broader events parity;
- complete toolbox auto-population, provenance/cache/budgets, favorites/search, and Choose Items;
- extend the landed atomic Form/UserControl/Component/Class scaffolding beyond its fail-closed standard static
  SDK/classic boundary only with transaction-safe shared/imported/complex project integration;
- complete resource picker, standard menu items, inheritance overrides, and unshipped 1.8–1.15 carry-in scope.

**Exit:** Tier A passes end-to-end on modern and net48 live-source tiers. The standard-control workflow is complete with keyboard or mouse. Cross-tool round-trip is green and unsupported shapes refuse before mutation.

### Phase 3 — hosted design-time extensibility (12–20 weeks)

- land session kernel, service registry, and contract tests incrementally;
- host framework ControlDesigner behavior, adorners, verbs, action lists, and command routing through DesignerIntent;
- land converter/editor/collection broker with ownership, DPI/theme, cancellation, timeout, and result validation;
- enable Lane B only for proven owned-region serializers; add normalization preview and independent postconditions;
- publish adapter SDK preview, sample adapters, compatibility analyzer, and version policy;
- add malicious/pathological designers, editors, converters, modal deadlocks, handle leaks, and crash-loop fixtures.

**Exit:** Tier B clears its threshold with zero silent fallback. Every service has a contract test/capability flag. Vendor code cannot write workspace files or commit outside the command bus. Disabling hosted code returns to honest generic/source-first mode.

### Phase 4 — runtime, bitness, and certified vendors (12–20 weeks)

- select modern workers by compatible TFM/runtime and x64/ARM64 architecture;
- harden net48 x64 host, dependency redirects, output release/rebuild, and live-source authority;
- keep x86/COM/ActiveX out of v2.0.0 GA; future 2.x work may implement it only after a new explicit approval;
- certify vendor cohorts with versioned manifests, reference results, diffs, fallbacks, timings, licenses, and environment;
- exercise dependency collisions, native DLLs, static state, multiple projects/forms, unload, crash, quota recycle, and build churn.

**Exit:** each advertised cohort clears its threshold. Package RID/PE inspection proves worker architecture. Uncertified vendors remain “best effort generic support,” never implied parity.

### Phase 5 — better than Visual Studio in targeted workflows (8–14 weeks)

- capability inspector for operation support, authority, ownership, runtime, fallback, and recovery;
- readable source/resource diff preview for high-impact, normalization, and vendor-generated edits;
- headless designer validate command with JSON/SARIF-like compatibility, security, fallback, diff, a11y, performance, and leak output;
- non-mutating accessibility, tab-order, DPI, anchoring/localization, and naming advisor with previewed quick fixes;
- reproducible redacted diagnostics: versions, capabilities, dependencies, worker events, traces, and hashes — no source, secrets, or proprietary payload by default;
- recovery timeline explaining crash/recycle/rebuild/fallback and restoring the last safe view/document state.

**Exit:** superior features are not mutation back doors. Every fix is opt-in, previewable, and undoable. Headless validation needs licensed software only for explicitly configured vendor tiers.

### Phase 6 — beta hardening (8–12 weeks)

- close extra-click, focus, shortcut, and misleading-status gaps against the reference catalog;
- independently review source/IR/protocol/resx/editor/adapter security boundaries;
- run an 8-hour multi-form soak, 500 open/edit/close cycles, crash loops, build churn, memory/handle budgets, slow/cancelled modal paths, and disk conflicts;
- complete high-contrast, 200/400% zoom, keyboard-only, NVDA, and a second screen-reader pass;
- verify all seven locales plus native culture/RTL acceptance;
- publish migration preview, compatibility report, and rollback instructions.

**Exit:** no open P0/P1 integrity, security, crash-loop, deadlock, accessibility, migration, or misleading-capability defects. Performance is measured, not hidden by broader timeouts.

### Phase 7 — RC and GA evidence (4–8 weeks)

- freeze protocol/configuration/adapter versions and support matrix;
- run clean-machine, package, minimum/current VS Code, runtime, architecture, corpus, migration, and rollback matrix from immutable artifacts;
- archive exact counts, versions, hashes, thresholds, skipped/gated legs, and vendor manifests;
- require independent code/security review and explicit maintainer product/legal/vendor GO.

**Exit:** all section 9 gates pass. Repository completion is separate from publication, vendor licensing, hardware, legal approval, and external certification.

## 7. Dependency graph and critical path

~~~text
Phase 0 decisions
  └─ Phase 1 protocol + document/command runway
       ├─ Phase 2 first-party parity ─────────────┐
       └─ Phase 3 hosted extensibility ──────────┤
             └─ Phase 4 runtime/vendor matrix ───┤
Phase 2 + Phase 3 ── Phase 5 superior workflows ┤
                                                 └─ Phase 6 beta ── Phase 7 RC/GA
~~~

Hard dependencies:

- Lane B waits for the transaction journal and independent postcondition gate.
- Vendor designers/editors wait for service contracts, trust tier, quotas, and malicious fixtures.
- x86/COM cannot delay managed parity because Phase 0 excludes Tier D from the v2.0.0 GA claim.
- Data Sources generation depends on scaffolding, project resolution, resource transactions, property metadata, and atomic commands.
- Headless validation uses the same protocol/capability/command truth as the interactive product.
- GA waits for real vendor/hardware/accessibility evidence for every named tier.

## 8. Verification program

### 8.1 Required corpus

- modern .NET 8/9/10 and current target; net48 SDK/classic projects; `win-x64` / `win-arm64` plus net48 x64
  compatibility; x86/COM/ActiveX negative-refusal scenarios;
- Form, UserControl, inherited/multi-level/abstract/generic/nested/partial roots;
- standard controls, nonvisual components, all layout containers, menus, tabs, grids, trees, lists/images, binding and extenders;
- neutral/multi-culture resources, RTL, images/icons/ImageList, opaque/binary/corrupt/unsafe resources;
- same-name assemblies, version conflicts, native dependencies, vendor licensing accept/refuse paths;
- 50-, 300-, and 1,000-control stress forms, pathological TypeDescriptor graphs, crashing controls;
- forms saved by supported Visual Studio references and round-tripped back through them.

Each scenario records support tier, authority/render mode, graph, metadata, operation result, exact/normalized diff, undo/redo, diagnostics, timing, lifecycle, and reference result.

### 8.2 Test layers

1. pure source/resource planners and independent safety/postcondition gates;
2. protocol schema/compatibility/fuzz/bounds/stale/cancellation;
3. service contracts and hostile design-time components;
4. engine integration for every runtime/architecture;
5. webview interaction/focus/keyboard/accessibility;
6. Extension Host at minimum/current VS Code;
7. Visual Studio cross-tool round-trip and geometry/pixel references;
8. package/RID/PE/payload/migration/rollback;
9. performance, memory, handles, locks, crash loops, soak;
10. licensed vendor and physical hardware as explicit external legs.

### 8.3 Initial performance objectives

| Metric | Initial objective |
|---|---|
| Pointer/key input to local visual preview | p95 ≤ 16 ms on the reference workstation |
| Standard authoritative commit acknowledgement | p95 ≤ 100 ms warm; no UI-thread blocking |
| 300-control authoritative commit | p95 ≤ 250 ms warm |
| Warm standard form interactive | p95 ≤ 3 s |
| Warm 300-control/vendor form interactive | p95 ≤ 5 s or a corpus-approved bound |
| Capture/render | 30 fps authoritative plus 60 fps client overlay; stale frames never commit state |
| Idle CPU | statistically indistinguishable from baseline when idle |
| Memory/handles | bounded per worker; no positive soak leak trend; recycle before limits |
| Regression policy | more than 10% on a frozen metric requires investigation/sign-off, not a larger timeout |

Cold restore/build uses a responsiveness gate: progress within 500 ms, cancellation at every awaited stage, no editor freeze, named phase, and no assembly execution before trust/consent.

## 9. Unqualified Visual Studio-parity / GA gates

These gates define the larger claim and are deliberately **not** represented as complete by the 2.0.0 managed-preview
package. The package can be repository-side closed while these remain `GATED` or `NOT_EXECUTED`, provided the public
release wording does not advertise the unavailable tiers or evidence.

All gates are conjunctive:

1. capability matrix, support tiers, and marketing match tested artifacts;
2. Tier A is 100% on every advertised runtime/architecture;
3. every advertised Tier B/C/D clears its threshold with an archived manifest;
4. zero silent loss/corruption, unrelated change, partial transaction, or stale canvas presented as current;
5. hostile source/IR/protocol/resx produces no prohibited side effect; compiled code follows trust/consent; no fake sandbox claim;
6. representative forms survive extension → Visual Studio → extension without unexplained semantic drift;
7. N/N−1, partial update, rollback, migration, and self-repair pass;
8. soak/build churn has bounded memory/handles, no leaked output locks, deterministic recovery;
9. frozen performance budgets pass on standard, large, and vendor corpora;
10. keyboard/AT, all locales, and native RTL/culture acceptance pass;
11. clean-machine x64/ARM64 packages and the net48 x64 compatibility payload have correct architecture; x86/COM
    requests fail closed with stable diagnostics and no mutation;
12. evidence includes exact totals, failures, skips, and gates; a timed-out aggregate is not a pass;
13. final architecture, safety, and release evidence receive independent review;
14. publication, vendor licenses, hardware, legal approval, and credentials are PASS, GATED, or NOT EXECUTED — never inferred from repository evidence.

## 10. Definition of Ready and Done

Before implementation, split phase epics into reviewable issues. An issue is **Ready** only with scenario IDs/tier, exact current symbols and owner module, protocol impact, trust/source/resource/undo/concurrency impact, runtime matrix, positive/negative/perf/a11y tests, migration/diagnostics/localization impact, dependencies, and rollback/cut behavior.

An issue is **Done** only when code, tests, support matrix, diagnostics, localization, migration, performance evidence, and independent review are complete. “Works in F5” or “matches a screenshot once” is not Done.

Suggested first order after Phase 0:

1. characterization harness;
2. protocol envelope/schema generator and compatibility tests;
3. document fingerprint and PatchSet behind current commit;
4. worker supervisor lifecycle/cancellation/crash policy;
5. split render/session/transaction code without behavior changes;
6. hosted Form/UserControl kernel behind an experimental capability flag;
7. one first-party command through the new bus;
8. one hosted verb/editor through the same bus;
9. expand corpus and services one independently releasable slice at a time.

## 11. Risk register and cut rules

| Risk | Early signal | Required control / cut |
|---|---|---|
| Proprietary dependency | No written approved distribution route | Do not ship it; use approved public contracts or narrow scope. |
| Hosted serializer rewrites user code | Lane B changes outside ownership or normalizes unexpectedly | Kill Lane B for that shape; source-first/refuse or explicit migration only. |
| Fake service compatibility | Vendor detects incomplete service semantics | Return unavailable until the full contract passes; no no-op compatibility stubs. |
| Vendor code trust | Process isolation described as sandbox | Block claim/implementation; require trusted-to-execute consent and verified OS controls. |
| Decomposition regression | Golden/protocol/source output changes during moves | Stop features, restore characterization, split smaller. |
| Cross-runtime dialect divergence | Same intent emits different source | Canonical planner persists; runtime adapters only validate/reconcile. |
| Modal deadlock/reentrancy | UI or worker hangs | Deadline/cancel/owner broker; quarantine offender; generic fallback. |
| Vendor matrix unavailable | No licenses/hardware/versioned projects | Do not claim vendor parity; ship only verified Tier A/B. |
| x86/COM destabilizes core | Phase 0 packaging/hosting/security/legal route is not approved for v2.0.0 | Tier D is excluded from v2.0.0 GA; return `X86_WORKER_UNAVAILABLE` / `COM_ACTIVE_X_UNSUPPORTED` and continue managed GA. |
| Performance hidden by timeouts | Frozen budgets miss | Profile/cut/disclose reduced mode; do not silently raise thresholds. |
| C# tooling varies | Optional integration absent/incompatible | Capability-detect and degrade visibly; keep core designer independent. |
| Scope exceeds capacity | Many areas remain half-built | Ship preview tiers; reduce cohorts, not integrity/security/a11y gates. |

## 12. Official reference baseline

- [Windows Forms designer differences and out-of-process model](https://learn.microsoft.com/en-us/dotnet/desktop/winforms/controls-design/designer-differences-framework)
- [Windows Forms design-time overview and action lists](https://learn.microsoft.com/en-us/dotnet/desktop/winforms/controls-design/designer-overview)
- [Designer options: grid, snaplines, rename, smart tags, toolbox](https://learn.microsoft.com/en-us/visualstudio/ide/configure-windows-forms-designer-options?view=visualstudio)
- [Designer walkthrough: layout, Outline, Properties, size/location](https://learn.microsoft.com/en-us/visualstudio/designers/walkthrough-windows-forms-designer?view=visualstudio)
- [Data-bound WinForms controls and Data Sources](https://learn.microsoft.com/en-us/visualstudio/data-tools/bind-windows-forms-controls-to-data-in-visual-studio?view=visualstudio)
- [Interactive tab-order mode](https://learn.microsoft.com/en-us/dotnet/desktop/winforms/controls/how-to-set-the-tab-order)
- [Visual Studio Toolbox behavior](https://learn.microsoft.com/en-us/visualstudio/ide/reference/toolbox?view=vs-2022)
- [Windows Forms runtime repository and design-time context](https://github.com/dotnet/winforms)
- [Visual Studio 2026 release notes](https://learn.microsoft.com/en-us/visualstudio/releases/2026/release-notes)

These sources define reference behavior, not permission to redistribute Visual Studio designer components. Licenses and product terms require a separate Phase 0 review.
