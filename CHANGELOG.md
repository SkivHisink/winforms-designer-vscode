# Changelog

All notable changes to **WinForms Designer for VS Code** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
From **1.0** the core designer loop is stable and follows semantic versioning; the .NET Framework 4.8 engine
(for `net4x` / DevExpress) remains **experimental**.

## [Unreleased]

## [2.0.0] - 2026-08-28

**The v2 managed designer foundation ships as an explicitly bounded release.** It freezes the generated protocol,
transaction and worker contracts; expands repository-automated standard-control, resource, accessibility, recovery,
and diagnostic coverage; and packages Windows x64 alongside an untested `win32-arm64` build that carries no ARM64
support claim.
What is bounded is the *claim*, not the packaging: this is a stable `2.0.0` package, but it is **not** an unqualified
Visual Studio-parity or vendor-certification claim, and the gates listed under **Release boundary** below stay open
and are not converted into a green result by wording.
The strengthened scenario gate records 111 repository `PASS` rows backed by nine completed machine-readable reports,
exact executed xUnit/TRX test identities, runtime assertion anchors, one run id, the exact git HEAD, and a shared SHA-256
over 215 product files. It records 12 `NOT_EXECUTED` and 5 explicitly excluded Tier-D `GATED`; measured refusal coverage
that is not enough to lift S057-S060 or S096 is machine-labelled `MEASURED_BUT_INSUFFICIENT` with a mandatory reason. Eleven non-executed
rows are classified `HARNESS_ONLY`: ten caller-supplied capability-inspection/echo scenarios were deliberately removed
from `PASS`, while S102 still requires physical Windows ARM64 execution. A mutation acceptance test removes a real
assertion anchor and proves that the affected catalog `PASS` can no longer validate; four required adversarial controls
plus a product-source mutation prove quoted TSV, handwritten-report, trivial-Fact, and stale-product attacks fail closed.
Forty actual Visual Studio Enterprise 2026 (18.7) reference traces are archived as `PASS` (S001, S005, S006,
S009, S011, S012, S013, S014, S015, S017, S021, S022, S024, S025, S026, S029, S030, S031, S037, S038, S039, S041,
S042, S045, S046, S049, S050, S051, S053, S061, S062, S079, S085, S086, S087, S088, S100, S108, S110, and S120); the remaining 88 reference traces stay
`NOT_EXECUTED`, for an explicit actual-Visual-Studio result of `40/88`; this is not a broad parity result. S079 now also
opens an exact classic-net48 `RightToLeft=Yes` / `RightToLeftLayout=true` fixture in the installed designer and measures
the real Form/Button/Label HWNDs: logical `(20,30,90×28)` and `(50,82,80×20)` render at exact mirrored client
`(210,30,90×28)` and `(190,82,80×20)` inside `320×160`, while source, Designer, and project stay byte-identical. S085
opens an exact net10 derived Form, selects the protected inherited Button exposed by the installed designer, and changes
`Text` from `Base inherited` to `Derived override` through native Properties. Visual Studio writes exactly one bounded
derived assignment, leaves both base artifacts, derived code-behind, and project byte-identical, removes the override on
one native Undo after deterministic first-touch CodeDOM canonicalization, and reproduces the applied Designer byte-exact
on Redo. S086 opens a separate exact net10 derived Form, selects its private inherited Label with the visible native
lock glyph, and shows `Text=Private inherited label` on a disabled Properties row. A direct UI Automation `SetValue`
attempt is rejected as not allowed on a nonenabled element; the value, base source, base Designer, derived code-behind,
derived Designer, and project bytes remain exact. This x64 reference does not claim the still-gated physical ARM64 leg.
S087 opens an exact classic-net48 derived Form over a compiled base with a protected inherited Panel, filters the native
Toolbox to `All Windows Forms → Button`, invokes its actual MSAA Double-Click default action, and writes exactly one
derived-root `button1` field/construction/property set/`Controls.Add` without touching the base artifacts. Native Undo
removes every `button1` shape after measured CodeDOM whitespace canonicalization; Redo restores the complete operation
contract while the trace honestly records Visual Studio's generated `TabIndex 1→0` and `SetChildIndex` call-order byte
difference instead of claiming byte identity. S088 repeats the private-inherited move refusal in source-identical modern
and classic-net48 Forms: the exact locked Button is selected through native Properties/Document Outline, a bounded
cursor-synchronized drag leaves its screen bounds and all ten base/derived/project files exact, and the observable
Saved/Undo-availability states remain unchanged. Classic net48 exposes the real `WindowsForms10.BUTTON` HWND through
UIA as `ControlType.Pane`; physical Windows ARM64 remains external.
S001 additionally
proves that a no-edit Visual Studio Save All preserves SDK source, Designer, neutral resx, and project bytes exactly;
S009 records Visual Studio's fail-closed refusal for a Form nested inside another type, which the product now matches
before rendering or mutation. S011 proves a concrete generic-base form on both Visual Studio and the live net48
interpreted path. S012 records that Visual Studio opens a blank design surface when an otherwise proven empty Form
partial lacks `InitializeComponent`. S015 places two Labels at identical bounds with the frontmost sibling first in the
native `Controls.Add` z-order, clicks the shared pixel through the real designer `InputShield`, and proves that Visual
Studio selects `topLabel` by exposing `Text=Top z-order` in native Properties; all fixture bytes remain exact. The
repository hit-test independently matches the same WinForms index-0-first rule. Physical ARM64 remains external. S021
multi-selects two Buttons in the actual designer, performs one real
InputShield/capture-window drag by `+17,+9`, proves both `Location` assignments move exactly once, and proves that one
Visual Studio Undo/Redo restores/reapplies both controls together while source/project stay byte-identical. S022
captures an actual designer east-handle drag and proves that resizing an
anchored Button from 120×30 to 160×30 preserves `Anchor` and `Location`; the real product CustomEditor matches the
semantic source patch with one native Undo/Redo unit on both supported VS Code test lines. Physical ARM64 execution
remains externally gated. S029 executes Visual Studio's native `Format.AlignLefts` command over three selected Buttons,
proves the exact two-`Location` source patch, and is matched by the product CustomEditor with one native Undo/Redo unit.
S030 executes Visual Studio's native `Format.MakeSameWidth`, proves the exact two-`Size` source patch while preserving
all heights and Locations, and is matched by the product CustomEditor with one native Undo/Redo unit.
S031 selects the nested Button through the actual owner-drawn Document Outline and executes Visual Studio's native
`Format.CenterHorizontally`: relative X changes `15→80`, UI bounds move by `+65`, and asymmetric
`Padding(10,0,20,0)` does not shift the complete-client-area center. The product now matches both that full
`ClientRectangle` rule and WinForms integer truncation, with the exact one-`Location` patch and one native Undo/Redo
unit on both supported VS Code lines.
S017 records the installed modern designer's native marquee rule instead of relying on the former catalog assumption:
within the active Panel, Visual Studio selects every direct child whose bounds intersect the marquee, including a
partially intersected Button. A reversible Copy/Paste probe duplicates exactly the three intersecting Text identities,
excludes the same-Panel nonintersecting and Form-level controls, and leaves the marquee/Copy Designer bytes exact. The
product now uses the same intersection and active-container boundary; its full webview regression passes 970 checks
across 209 tests. Native Undo restores the original semantic shape after the probe, while Visual Studio's modern CodeDOM
serializer only reorders component blocks, which the trace records separately rather than misreporting as a marquee edit.
S110 inspects the installed designer's real UI Automation tree for a purpose-built modern Form. It records
`Submit button` as `ControlType.Button`, `Customer name` as `ControlType.Edit`, the visual `Main menu` as
`ControlType.MenuBar` with the nested `fileMenuItem` as `ControlType.MenuItem`, and `refreshTimer` as a
`ComponentTray` pane. Every record is enabled, onscreen, has non-empty bounds and raw-view ancestry, and source,
Designer, and project bytes remain exact. This x64 trace does not substitute for physical ARM64 or live assistive-
technology acceptance; those gates remain external.
S061 selects `button1` in the actual owner-drawn Document Outline and commits `submitButton` through the native
Properties `(Name)` row. Visual Studio changes the field plus all eight member references and the `Name` literal once,
preserves `Button.Text = "button1"` and every `textBox1` reference, and gives the transaction exact native Undo/Redo;
source and project bytes remain exact. A real outline F2 route did not expose an inline editor and is not claimed as
native behavior. The product matches the selected-control atomic rename and retains F2 only as an additive shortcut;
its more minimal source patch deliberately avoids Visual Studio CodeDOM's unrelated qualifier/comment normalization.
S062 clicks the actual `refreshTimer` bounds in the native Component Tray and proves the selection through native
Properties: its object selector reads `refreshTimer System.Windows.Forms.Timer`, `(Name)=refreshTimer`,
`Enabled=False`, and `Interval=1500`. Source, Designer, and project bytes remain exact. The product independently
matches this workflow through its engine-authoritative nonvisual tray/session pick and publishes live Timer properties
without source, dirty-state, disk, or native-history mutation; physical Windows ARM64 remains external.
S046 starts from an explicit actual-Visual-Studio `Button.BackColor=Red`, opens the native owner-drawn framework Color
editor through its real Properties `Open` button, and freezes the visible `Custom / Web / System` tabs with `Red`
selected. `Esc` restores `BackColor=Red`; source, Designer, and project hashes remain exact. The product's matching
typed `CANCELLED` path independently preserves source, dirty state, native history, and disk on both supported VS Code
lines. S045 uses the same installed editor from an explicit Red fixture, selects the exact native `Blue` Web-color row,
accepts it with Enter, and saves canonical `Color.Blue` without changing the Button's Location, Name, Size, Text, or
`UseVisualStyleBackColor`. One native Undo restores Red and one native Redo reproduces the Blue Designer bytes exactly;
source and project hashes remain exact.
S037 selects the actual Visual Studio Button and captures its categorized Properties view: Text is visibly bold at
`Button reference`, default `Enabled=True` is not bold, the Text description matches, and source/Designer/project bytes
remain exact. The repository Properties panel matches the categorized/default/non-default/description semantics.
S038 selects an actual Visual Studio Button and TextBox together: the shared `Text` row is blank/mixed, the common
property intersection remains visible, and type-specific `DialogResult`, `Multiline`, `AcceptsReturn`, and
`UseSystemPasswordChar` rows are absent. Both controls show selection handles and all project inputs remain exact; the
repository multi-property grid matches the same intersection/mixed-value contract. Physical ARM64 remains external.
S039 opens the actual in-process net48 designer, selects `button1` through the visible legacy Document Outline after
the rendered child absorbs a synthetic click, and invokes the enabled Property Browser `Reset` command for its explicit
`Text=Custom reset text`. The visible value becomes empty and the exact Designer patch removes only the
`this.button1.Text` assignment; net48 CodeDOM preserves `this.` qualifiers and sibling semantics, canonicalizes four
separator comments, inserts one pre-close blank line, and rewrites only the generated region to CRLF while
source/project bytes remain exact. In the disconnected capture session the native context popup was not exposed through
UI Automation, so the exact enabled
`OtherContextMenus.PropertyBrowser.Reset` handler was invoked through DTE; repository unit, webview, and named-pipe
paths independently prove the matching reset enablement and source-safe assignment removal.
S041 opens the actual Visual Studio `FlatStyle` dropdown for a default Button and captures the native list child order
`Flat, Popup, Standard, System` with `Standard` selected; source, Designer, and project bytes remain exact. The product
publishes the same exclusive closed list and selection through the real modern CustomEditor without mutation on both
supported VS Code lines.
S042 opens the actual modern Visual Studio designer, selects `button1`, expands the owner-drawn `Padding` row through
the PropertyGrid keyboard contract, and commits only `Left: 3→8` through the real child value editor. The exact saved
CodeDOM artifact preserves `Top=4`, `Right=5`, `Bottom=6`, source, and project bytes while performing Visual Studio's
first-write canonicalization of `this.` qualifiers and separator comments. Repository unit, webview, and E2E paths
cover the same bounded subproperty update and sibling-value preservation.
S053 opens the supported `net10.0-windows` form in actual Visual Studio, executes native `View.Toolbox`, finds the real
`Search Toolbox` / `PART_SearchBox` control, and enters `Button` through UI Automation `ValuePattern`. Visual Studio
reports exactly `2 results found`; its legacy native Toolbox exposes the MSAA hierarchy
`Toolbox → All Windows Forms → Button` beside `RadioButton`, while source, Designer, and project bytes remain exact.
Repository unit/E2E evidence independently proves `System.Windows.Forms.Button` framework provenance and
`Common Controls` categorization; the Visual Studio claim remains bounded to the observed `All Windows Forms` search
result and is not a claim about custom/vendor Toolbox discovery.
S049 double-clicks a real Visual Studio designer Button, creates exactly one default `Click` subscription and one
`button1_Click` method, navigates the DTE cursor into the method, and preserves project bytes. Its Save All watcher now
keeps the exact line-ending modal lifecycle bounded until the dialog appears and records `observed`, `clickPosted`, and
`dismissed` only after the HWND is gone, preventing the former synchronous/expired-watcher deadlock. The product CustomEditor
now treats generated-source wiring and the code-behind insertion as one compensated history transaction: both buffers
remain unsaved until Save, one native Undo restores both, and one native Redo reapplies both on VS Code 1.84.0 and
1.134.0. Independent code edits cancel the narrow redo bridge fail-closed.
S120 now executes its bounded extension leg in every full product regression rather than only while exporting a manual
reference trace. The real CustomEditor moves `button1` by `+11,+7`, saves exact generated-source bytes, preserves the
code-behind, proves the saved CustomDocument and Designer disk bytes agree, then uses native Undo plus Save to restore
the byte-exact clean baseline. The archived Visual Studio Enterprise 2026 18.7 Save All trace preserves those same
source and Designer artifacts byte-identically.
S100 and S108 now close their bounded cross-tool corpus through a real two-way round trip. The modern and compiled-net48
CustomEditors edit and save disposable Forms, actual Visual Studio Enterprise 2026 18.7 opens those exact exported
artifacts and saves them, and a later product run reopens the archived Visual Studio output through the matching real
engine. Both lanes prove the expected `Button.Text`, byte equality between CustomDocument and disk, clean state, and
native Undo plus Save restoration of the original baseline. The accepted static S100 adapter manifest remains data-only:
vendor code is not loaded and the adapter has no workspace-mutation authority. These fixtures close S100/S108, not the
remaining 105-reference-trace corpus or arbitrary vendor compatibility.
S050 now opens a separately wired form in actual Visual Studio, selects `button1`, switches the native Properties grid
to Events, verifies the owner-drawn `Click=button1_Click` row and its real writable child editor, and commits that same
handler through `ValuePattern.SetValue` plus Enter. Source, Designer, and project stay byte-identical with exactly one
subscription and one method. The product independently exercises its adjacent real Events `setHandler` ingress on both
VS Code host lines with both buffers clean and both disk hashes exact. Physical ARM64 remains external.
S016 replaces its former synthetic timing record with real x64 product evidence. Generated 300-control standard-control
forms open through both modern and compiled-net48 CustomEditors with 301 layout nodes; initial interaction remains under
5000 ms and a selected Text commit plus reconciliation under 500 ms on VS Code 1.84.0 and 1.134.0. The accepted snapshot
feeds Properties without a trailing describe, native Undo restores the exact baseline, and every fixture file remains
byte-identical on disk. Actual Visual Studio, physical cross-architecture, and external performance-lab p95 evidence
remain external.
S122 replaces the synthetic headless-only record with product telemetry captured from real x64 CustomEditor sessions.
Generated 50-control and 300-control forms run through modern and compiled-net48 engines, and a 180-control form with 96
real in-repo FakeVendor controls runs through net48, at logical 100/125/150/200% DPI. Retained high-DPI dirty patches now
scale only the changed leaf while the webview composites logical patch coordinates into the physical backing store.
All 12 frozen capture/preview/commit/reconciliation budgets pass on VS Code 1.84.0 and 1.134.0 with native Undo,
same-snapshot reconciliation, and byte-exact disk guards. Physical performance-lab p95, a licensed vendor corpus, and
the Visual Studio reference trace remain explicit external gates.
S126 replaces its preview-only headless record with a visible High-DPI Advisor command on a real modern CustomEditor.
`AutoScaleMode.None` is authorized from live root metadata and planned through the normal safe source lane; preview
opens the exact before/after bytes in a read-only VS Code diff without dirty state or hot-exit participation. Apply
accepts only that retained revision-bound proposal, commits `AutoScaleMode.Font` through the ordinary CustomDocument
firewall as one native Undo/Redo unit, and leaves source, Designer, and project disk hashes exact. The adjacent S128
product leg proves that an intervening ordinary edit makes the stale preview refuse without replacing the newer text.
Both flows pass on VS Code 1.84.0 and 1.134.0; physical ARM64 and actual Visual Studio reference execution remain external.
S124 replaces its caller-supplied headless crash record with real product recovery. While a modern CustomEditor is
open, the actual mapped worker is terminated; the session immediately revokes edit authority, records the loss in
Diagnostics, starts a different OS process through the bounded crash policy, and re-renders the byte-exact clean
document. Ordinary Properties edit/native Undo then succeeds, and a later form renders and edits through the same
recovered worker. Both supported VS Code lines pass without an unhandled pipe rejection; the Visual Studio reference
trace and an external crashing-vendor artifact remain external.
S095 closes the repository's hosted-designer crash path through the real compiled-net48 product route. The exact
repository-certified `FakeVendor.CrashOnInitializeDesigner` is first activated successfully on the engine's private
desktop in a disposable child process. Its next real `ComponentDesigner.Initialize` terminates that OS process; the
main mapped net48 EngineApi PID stays alive, the dead child is observed, and the exact assembly SHA-256/component/
certificate identity is quarantined. A retry returns `DESIGNER_QUARANTINED` without starting another child, while the
generic source-first surface remains renderable and a Text edit completes one native Undo/Redo unit with byte-exact
disk artifacts on VS Code 1.84.0 and 1.134.0. This is process crash containment, not an OS security sandbox or licensed
vendor certification; its Visual Studio reference and licensed-vendor legs remain external.
S089/S090 close the adjacent modern hosted-service action path through the ordinary product CustomEditor. The exact
repository-certified `HostedServiceKernelControl` publishes `Apply Service Preset` only after the engine proves STA,
assembly SHA-256, component/designer/certificate identity, and complete container, selection, change, name, command,
and toolbox services; an incomplete kernel withholds `IDesignerHost`, and an unsupported service returns an explicit
refusal. The webview sends only the certified command identity, never source proposals. The host revalidates the live
revision and the exact one-transaction/two-change outcome, independently plans `Text = "Hosted service preset"` and
`Size = 180, 42`, and commits both as one unsaved native Undo/Redo unit. A forged certificate leaves source, history,
dirty state, and disk unchanged. Unit, webview, and full Extension Host suites pass on VS Code 1.84.0 and 1.134.0.
This is one bounded modern contract, not arbitrary vendor, net48/cross-runtime, licensed-vendor, or Visual Studio proof.
S085-S088 move visual inheritance beyond metadata-only coverage. Source-identical modern and compiled-net48 base forms
publish protected and private inherited controls through the real CustomEditor: a protected Button accepts one
token-authorized derived Text override with exact native Undo/Redo, private controls remain visibly read-only and reject
property/move intents without dirty state or phantom history, and adding a new control writes only the derived Designer
buffer. Base, code-behind, and Designer files remain byte-exact on disk before Save on VS Code 1.84.0 and 1.134.0;
actual Visual Studio reference execution and physical ARM64 remain external.
S082 now drives the shipped Data Sources surface through a real modern CustomEditor: an opaque `Customer` schema with
`Id`, `Name`, and `Email` generates the complete DataGridView/BindingSource/BindingNavigator graph as one native
Undo/Redo unit while source, Designer, project, and model files remain byte-exact before Save. S084 adds the paired
modern/compiled-net48 fail-closed path: unsupported provider metadata returns typed
`UNSUPPORTED_DATA_PROVIDER` before source, created IDs, dirty state, native history, or disk mutation. Both product
proofs pass on VS Code 1.84.0 and 1.134.0; actual Visual Studio traces and S082 physical ARM64 remain external.
S051 closes the adjacent revision-race gap: after the engine validates an existing TextChanged handler against one
project-partial snapshot, a deterministic code-behind rename before commit makes the CustomEditor refuse the stale
Designer wiring while preserving both disk hashes and a clean Designer buffer. Once the net48 render recovers on the
exact reverted code snapshot, the same stable rewire changes exactly one subscription and passes one native Undo/Redo
unit on VS Code 1.84.0 and 1.134.0. The archived actual Visual Studio 18.7 x64 trace independently selects `textBox1`
through native Document Outline, commits the compatible alternate handler through the real Events cell, and freezes
Visual Studio's exact empty-handler lifecycle: initial original+alternate becomes alternate, Undo becomes original,
and Redo becomes alternate while project bytes and all unrelated source/Designer facts remain exact.
S052 applies the same fail-closed boundary to new handler generation on both runtime lanes. A deterministic change to
the real open code-behind document after the engine has produced a valid Click stub makes both a modern SDK and a
compiled-net48 CustomEditor commit neither artifact: the independent edit remains visible, Designer stays clean, no
stub or subscription appears, and both disk hashes remain exact on VS Code 1.84.0 and 1.134.0. Its Visual Studio
reference leg remains external.
S007 now records the already-live public Explorer refusal as scenario-bound product evidence: `Add Component` receives
the traversal name `..\Injected`, returns the typed `invalidName` result, and leaves the target directory entries
unchanged on both Extension Host versions. S035 adds the corresponding visible container workflow: a compiled-net48
CustomEditor moves an external TextBox onto selected `tabPage2`, converts Form-client `(300,80)` to the live page-client
`(276,38)`, retains exactly one owner, leaves disk untouched, and binds ownership plus Location to one native
Undo/Redo unit on both host lines. Their Visual Studio reference legs remain external.
S036 now makes a previously published `SplitContainer.Panel2` target genuinely stale by renaming its owning
SplitContainer through the product, then proves that both modern and compiled-net48 CustomEditors refuse reparenting
without source, disk, or history mutation. S061 selects `button1` through the real canvas/outline session pick and
renames it to `submitButton` through the product transaction: the selection follows, every declaration/Name/reference
changes once, unrelated Text and `textBox1` stay exact, and one native Undo/Redo unit owns the whole edit on both host
lines. S036's actual Visual Studio reference leg remains external; S061's bounded reference is archived above.
S024 now drives the real shared designer clipboard: Copy remains a no-op, while Paste beside an occupied
`submitButton` generates the non-colliding VS-style `button1` before commit on both modern and compiled-net48 paths,
preserves disk, and forms one native Undo/Redo unit. S063 binds the existing net48 outline-reparent proof to its exact
catalog scenario: `button1` moves from `panel1` to `groupBox1`, gets live client-relative `(10,15)`, and restores/replays
ownership plus geometry with one native Undo/Redo unit. S024 now also has an archived actual Visual Studio 18.7 x64
reference on both modern and net48: native Copy/Paste produces `button1` at `(98,74)` and passes exact Undo/Redo. That
bounded reference closes collision-safety semantics without claiming coordinate parity with the product's 8px nudge;
S063's actual Visual Studio reference leg remains external.
S005 now archives the actual Visual Studio modern SDK **Add New Windows Form** baseline. The installed
`Microsoft.CSharp.WindowsForm` project template creates exactly `S005GeneratedForm.cs`, its nested
`S005GeneratedForm.Designer.cs`, and nested `S005GeneratedForm.resx`; the SDK project remains byte-identical, the
solution builds, and the new Form opens in the native designer. Visual Studio also writes one bounded per-user
`.csproj.user` `SubType=Form` sidecar, recorded separately from the immutable project contract; every other top-level
delta is rejected by the capture harness. The authoritative 26-scenario control run finishes 19 `PASS`, 6
`CAPTURED_UNREVIEWED`, 1 `NOT_EXECUTED`, and 0 `FAIL`.
S006 now archives the adjacent actual Visual Studio classic-project **Add New User Control** baseline. The installed
`Microsoft.CSharp.WindowsFormsUserControl` template creates exactly `S006GeneratedUserControl.cs` plus its nested
`S006GeneratedUserControl.Designer.cs`: the classic project gains one `Compile` item with `SubType=UserControl` and one
Designer `Compile` item with `DependentUpon`, while no neutral `.resx` or `EmbeddedResource` is created. This observed
two-file contract corrected the product's former three-file assumption; Explorer Add now persists the same exact
relationships atomically, opens the clean CustomEditor, and passes on VS Code 1.84.0 and 1.134.0. The authoritative
27-scenario control run finishes 20 `PASS`, 6 `CAPTURED_UNREVIEWED`, 1 `NOT_EXECUTED`, and 0 `FAIL`.
S025 now archives an actual Visual Studio baseline-snap transaction instead of extrapolating from generic layout
helpers. With a default 96-DPI `Button` baseline offset of 21 and `TextBox` baseline offset of 16, a real native drag to
raw source Y `36` is corrected by Visual Studio to exact Y `35`; X, Size, the reference control, source, and project
remain exact, and Save All creates the standard empty neutral Form resx. The product now publishes the same Button and
TextBox baseline snap lines and prioritizes that baseline correction over a numerically nearer center snap. The exact
engine and webview scenario covers the full-frame coordinate translation, visible guide, final `manipulate` payload,
and margin-snapping subcase. The authoritative 28-scenario control run finishes 21 `PASS`, 6
`CAPTURED_UNREVIEWED`, 1 `NOT_EXECUTED`, and 0 `FAIL`.
S026 now archives the installed Visual Studio SnapToGrid contract rather than relying on a generic lattice assumption.
With `LayoutMode=1`, `ShowGrid=true`, and `SnapToGrid=true`, an AutoSize Label at source `(13,25)`, Size `57×15`, is
dragged by raw `(+20,0)` through the actual designer input HWND; Visual Studio persists exact `(32,24)` on its effective
8×8 parent grid. The reference Button, source/project bytes, Label size, and standard empty neutral resx remain exact,
and the harness restores the original `LayoutMode=0, ShowGrid=true, SnapToGrid=true` options in `finally`. On the
disconnected capture desktop the manifest names the bounded input as `cursor-relative-capture-owned-window-offset`, so
it does not overclaim a physical mouse. The full-frame webview test independently reproduces
`(13,25) + (+20,0) → (32,24)` and grid-aware resize. The authoritative 29-scenario control run finishes 22 `PASS`, 6
`CAPTURED_UNREVIEWED`, 1 `NOT_EXECUTED`, and 0 `FAIL`.
S062 now proves the non-visual component surface through a real modern CustomEditor: the engine publishes `timer1` in
the component tray rather than the visual-control tree, the shared tray/outline selection ingress selects it, and
Properties publishes live `Interval=250` and `Enabled=false` values without source, dirty-state, history, or disk
mutation on both Extension Host versions. Its actual Visual Studio and physical Windows ARM64 legs remain external.
S064 exercises the adjacent fail-closed outline path through the compiled-net48 CustomEditor: dropping `panel1` onto
its own descendant `button1` returns the product's containment-cycle refusal before engine mutation and preserves
Designer source, clean state, native history, and both disk hashes on both host lines. Its actual Visual Studio leg
remains external.
S065 opens an empty modern `MenuStrip` through the real Properties Items read/write seam and commits the panel's full
Visual Studio-style File/Edit/Tools/Help standard skeleton, including nested items and separators, as one native
Undo/Redo unit. S066 moves `Open` before `New/Save` through the real canvas item ingress while preserving unmanaged
metadata. S067 moves top-level `Help` into `Tools.DropDownItems` through a compiled-net48 CustomEditor. All three leave
disk untouched before Save and pass on VS Code 1.84.0 and 1.134.0. S068 proves the adjacent fail-closed path on modern
and compiled-net48: `openButton` cannot be moved under non-dropdown `newButton`; the exact diagnostic is returned before
source/history mutation and both disk hashes remain exact. Actual Visual Studio and applicable ARM64 hardware legs
remain external.
S069 hardens the existing typed `ListView.Columns` product path: the real modern CustomEditor reads an empty collection,
adds `Name` at width 180 through the panel editor, mints `columnHeader1`, renders the result, and binds it to one native
Undo/Redo unit without touching disk before Save. S070 adds a Visual Studio-style `TabControl.TabPages` order editor.
It submits the complete `C,A,B` permutation once, rewrites only canonical page references, publishes `pageC` as the
visible page, and restores/reapplies the exact order with one native Undo/Redo unit. Both editors reject stale reads;
the TabPages path additionally rejects comments attached to page statements/expressions, duplicates, incomplete
permutations, and ambiguous collection source while correctly preserving the canonical three-line Visual Studio host
section banner.
Both scenarios pass on VS Code 1.84.0 and 1.134.0. Their actual Visual Studio traces, and S070's physical ARM64 leg,
remain external.
S033 and S034 close the corresponding real canvas-drag paths for layout-owned children. A modern CustomEditor uses the
engine's live `TableLayoutPanel` column/row extents to move a Button from cell `(0,0)` to `(1,1)`, and uses live
`FlowDirection` plus child geometry to move C before A as exact `Controls.Add` order `C,A,B`. Neither operation emits a
free `Location`; both render the committed result, keep code-behind and Designer files byte-identical before Save, and
form exactly one native Undo/Redo unit on VS Code 1.84.0 and 1.134.0. Their actual Visual Studio traces remain external.
S041 now reaches the same Properties publication used by the real modern CustomEditor instead of stopping at metadata
helpers. Selecting a live Button publishes `FlatStyle` as the exclusive ordered list Flat / Popup / Standard / System
with Standard selected; the panel renders the same order as a closed dropdown. Opening/focusing it emits no edit,
keeps Designer and both disk files exact, and preserves an existing native Redo on VS Code 1.84.0 and 1.134.0. Its
actual Visual Studio reference trace remains external.
S040 now exercises the same live Button metadata through the shipped keyboard-search path. Typing the exact
`flatstyle` query leaves only `FlatStyle`; `ArrowDown` focuses its selected `Standard` editor, updates the description
pane, and posts no mutation. S083 opens a real compiled-net48 form, reads its live `customerBindingSource`, commits
`TextBox.Text → Customer.Name` through the exact Properties DataBindings OK seam, and generates exactly one canonical
`DataBindings.Add` statement. Product readback is exact, disk stays byte-identical before Save, and one native
Undo/Redo unit restores/reapplies the binding on VS Code 1.84.0 and 1.134.0. Their actual Visual Studio traces remain
external.
S073 now drives the shipped **Project…** image-resource action through a real modern CustomEditor. It discovers the
strongly typed `DemoApp.Properties.Resources.Logo` Bitmap from the project `.resx`/generated accessor pair and emits
exactly one canonical `this.imageButton.Image = global::DemoApp.Properties.Resources.Logo;` assignment. No form
`.resx`, `resources.GetObject`, or copied base64 payload is created; both project resource authority files and both
source files stay byte-identical on disk before Save, and one native Undo/Redo unit restores/reapplies the assignment
on VS Code 1.84.0 and 1.134.0. Its actual Visual Studio reference trace remains external.
S074 now drives the shipped Properties **Import…** action for a Form `Icon` through the same real modern CustomEditor;
only the native file chooser is replaced by a deterministic URI. The product validates a real ICO, writes a typed
`$this.Icon` resource, emits the canonical `resources.GetObject("$this.Icon")` assignment, and preserves the unknown
resource node's payload and `xml:space` metadata while permitting safe XML formatting. Code-behind and Designer disk
bytes remain exact before Save, and native Undo/Redo/final Undo restores and reapplies the exact Designer-plus-resx
transaction on VS Code 1.84.0 and 1.134.0. Actual Visual Studio and physical ARM64 execution remain external.
S075 now exercises the shipped ImageList images transaction in a real compiled-net48 CustomEditor. With `imageList1`
selected from the component tray, two real 16×16 PNGs are validated and serialized by the bundled net48 engine into a
VS-compatible `ImageListStreamer`; the product emits the canonical `ImageStream`/`resources.GetObject` assignment and
ordered `SetKeyName` calls, writes the binary neutral-resx node, preserves an unrelated resource, and reconciles the
live compiled instance. Code-behind and Designer disk bytes remain unchanged before Save, while one native
Undo/Redo/final-Undo unit restores/reapplies exact Designer and resx baselines on VS Code 1.84.0 and 1.134.0. Actual
Visual Studio execution remains external.
S076 now drives an unsafe project-resource picker result through real modern and compiled-net48 CustomEditors. After
the engine-published `Button.Image` metadata authorizes the exact target, a punctuation/property-chain accessor is
rejected as typed `INVALID_RESOURCE_SYMBOL` before project-resource discovery, engine source planning, in-memory
Designer mutation, native history, or any source/Designer/resource disk write. Both runtime paths pass on VS Code
1.84.0 and 1.134.0; actual Visual Studio execution remains external.
S045/S046 now drive the standard framework `ColorEditor` ingress from live `Button.BackColor` metadata in a real
modern CustomEditor. Only the native modal accept/dismiss outcome is deterministic: the product still authorizes the
published editor, enters the shared UITypeEditor path, performs the normal engine source plan and CustomDocument
commit, writes canonical `System.Drawing.Color.Blue`, and owns exactly one native Undo/Redo unit. Dismissal returns the
typed `CANCELLED` result with exact source, dirty-state, history, and disk no-mutation. Both paths pass on VS Code
1.84.0 and 1.134.0, and the isolated broker's 24 tests independently cover its applied/dismissed wire contract. S046's
actual Visual Studio cancel reference and S045's actual Visual Studio apply/Undo/Redo reference are archived above; the
physical ARM64 leg remains external where the catalog requires it.
S047 now drives the actual in-repo MIT FakeVendor drop-down editor through a real compiled-net48 CustomEditor. Live
`TypeDescriptor` metadata authorizes the exact component/property/editor tuple plus assembly path, SHA-256, and
certification id; the isolated child worker returns `Vendor Beta`, and the normal scalar transaction commits one
canonical Lane B owned-region assignment with exact native Undo/Redo/final Undo and no disk write before Save. S048
executes the same certified editor with a wrong-type object result on both modern and compiled-net48 sessions; the
shared broker returns `INVALID_EDITOR_RESULT` without changing Designer text, dirty state, disk hashes, or native
history. Both VS Code 1.84.0 and 1.134.0 pass. This is repository contract evidence for the MIT fixture, not licensed
vendor certification; actual vendor artifacts and Visual Studio reference executions remain external.
S071 now drives the actual in-repo MIT FakeVendor collection editor from live modern and compiled-net48 metadata.
The exact component/property/editor/value tuple, resolved assembly path, SHA-256, and certification id authorize the
isolated child worker; its `[1,2] → [3,5]` result is converted to a generic-list proposal, checked by the engine's
bounded owned-region planner, and committed as one Lane B native Undo/Redo/final-Undo unit while disk remains unchanged
before Save. S072 runs the same real worker successfully, then injects a proposal that also changes root `Form.Text`;
the product returns typed `OWNED_REGION_VIOLATION` and preserves exact Designer text, dirty state, native history, and
both disk hashes on modern and compiled-net48 sessions. Both VS Code 1.84.0 and 1.134.0 pass. Licensed-vendor and actual
Visual Studio certification remain external.
S020 now closes the stale-canvas input gap at the product authority boundary. Every click, move, resize, group move,
and keyboard nudge emitted from a drawn PNG carries that exact render generation; the open CustomEditor rejects any
missing, malformed, or superseded generation as typed `STALE_CANVAS` before selection, source, dirty state, or native
history can change. Real modern and compiled-net48 sessions deliberately start a newer full render, submit an old
selection and nudge, prove exact no-mutation plus native Undo no-op, then accept the same selection with the fresh
generation on VS Code 1.84.0 and 1.134.0. The browser-side pending-image gate remains an additional UX shield rather
than the source of authority; actual Visual Studio reference execution remains external.
S093 now renders a bounded `ControlDesigner` adorner on the actual modern CustomEditor canvas. The disposable
workspace builds the in-repo MIT `FakeVendor.FancyButton`; its live designer publishes one control-local Caption
descriptor, and hover becomes active only after the host reloads a fresh engine graph and the same live designer
confirms the exact local hit. Stale selection/revision, malformed or duplicate descriptors, and unconfirmed points
fail closed. Unit, webview, and both Extension Host lines prove the visible overlay and exact source-buffer,
dirty-state, native-history, code-disk, and Designer-disk no-mutation boundary. Actual Visual Studio execution and a
licensed vendor artifact remain external; this is not vendor certification.
S094 now drives the VS-style on-canvas smart tag from a real modern CustomEditor. A disposable workspace-local build of
the in-repo MIT `FakeVendor` fixture publishes its live `ComponentDesigner.ActionLists`; the product maps the `Caption`
row to writable `Text`, routes `Hosted caption` through the normal source-first engine planner, emits exactly one
canonical assignment, and owns it as one native Undo/Redo unit while both source files remain byte-identical on disk
before Save. The same flyout metadata, label, tooltip, and edit intent are covered in the webview. Both VS Code 1.84.0
and 1.134.0 pass; an actual licensed vendor artifact, Visual Studio execution, and physical ARM64 remain external.
S118 now exercises failed-commit compensation through the shipped modern ImageList transaction in a real CustomEditor.
The transaction writes its planned binary resource image and passes the real byte-fingerprint checks; a deterministic
test-only seam then rejects the final forward postcondition, so the normal runner compensates instead of publishing the
edit. Exact code-behind, Designer, opaque `.resx`, clean-tab, and empty native-history baselines are proven on VS Code
1.84.0 and 1.134.0. Actual Visual Studio and physical ARM64 execution remain external.
S077 and S078 now exercise Visual Studio-style Language-scoped scalar editing through a real modern CustomEditor.
With Language at Default, editing `label1.Text` changes only the exact neutral `.resx` value; selecting the discovered
`fr-FR` culture writes nothing by itself, publishes the French value in Properties, and the following edit changes
only that culture overlay. Both paths preserve code-behind, generated `ApplyResources` source, the other resource
layer, original LF/CRLF and terminal-newline shape, and expose each resource-only transaction as one native Undo/Redo
unit on VS Code 1.84.0 and 1.134.0. The transaction runner now distinguishes the first forward authorization from a
replay of the same durable native history entry, while still rechecking resource baselines and postconditions on Redo.
Their actual Visual Studio traces, and S078's physical ARM64 leg, remain external.
S080 closes the adjacent stale-resource race through that same product path. A fresh CustomEditor selects `fr-FR`,
starts the shipped Properties Text edit, and pauses only after the durable transaction has captured the exact resource
baseline. A deterministic external writer then changes the culture resource before the first product write. The
transaction refuses, preserves the newer external bytes plus neutral fallback and both source files, leaves the tab
clean with no native history entry, and restores the fixture after proof on VS Code 1.84.0 and 1.134.0. The actual
Visual Studio trace remains external.

### Added

- **Versioned v2 protocol and compatibility floor.** One schema generates the modern C#, net48 C#, and TypeScript
  bindings. The shipped engine probe uses that envelope for diagnostics only. N/N-1 settings-cache migration,
  self-repair, and adapter-manifest validation remain experimental contract-test modules: 2.0.0 activation does not
  consume them and no vendor adapter is discovered through them.
- **Journaled multi-artifact transactions.** The document store, `PatchSet`, transaction journal, runner, and resource
  coordinator provide exact-baseline preflight, postcondition verification, compensation, recovery classification,
  and one undo-registration boundary. Localized resource commands use the runner instead of an ad-hoc write path.
- **Managed worker lifecycle contracts.** Runtime/architecture selection, generation tracking, cancellation, crash-loop
  accounting, recycle/quarantine handoff, real modern dependency-start recovery, and real net48 crash replacement are
  exercised by the diagnostics probe. Normal render/edit traffic still uses the established engine lifecycle; the v2
  supervisor is not claimed as the product traffic supervisor and no OS sandbox is claimed. That established product
  lifecycle now keeps modern and compiled-net48 workers warm for a bounded 30-second idle window, then waits for both
  child processes to exit before a later designer starts fresh workers.
- **Expanded standard-control workflow evidence.** Repository scenarios now cover z-order hit testing, grouped
  manipulation intents, layout commands, property-grid modes, bounded converter metadata, toolbox discovery,
  outline/menu/collection editing, localization/resources/inheritance, Data Sources, runtime recovery, diagnostics,
  headless validation, and advisor workflows.
- **Real Visual Studio render comparison.** A CI harness verifies the archived VS 18.7 screenshot/source hashes, renders
  S011 and S014 through the net48 interpreted engine and S013 through the modern engine, crops the matching 360×180
  client surfaces, and enforces a frozen pixel tolerance. S013/S014 are exact at 0 / 64,800 differing pixels; S011
  differs by 113 / 64,800 pixels (0.174383%, MAE/channel 0.149388), including the VS-only inheritance adornment, and
  remains inside the 1% / 1.0 tolerance. The claim is limited to those three reference forms.
- **Real Visual Studio anchored-resize transaction.** The S022 capture selects `anchoredButton` in the actual WinForms
  Designer and drags the east sizing handle by 40 physical pixels. The archive proves live bounds 120×30 → 160×30,
  unchanged `Anchor`/`Location`, byte-identical source/project inputs, and the exact Designer serialization result. The
  product CustomEditor changes only the `Size` assignment and passes native Undo/Redo in VS Code 1.84.0 and 1.134.0.
- **Real Visual Studio Align Left transaction.** The S029 capture invokes `Edit.SelectAll` and the native
  `Format.AlignLefts` command in the actual WinForms Designer. The archive proves button1 stays at X=12, button2 moves
  42→12, button3 moves 77→12, every Y/Size survives, and source/project inputs remain byte-identical outside the exact
  Designer serialization. The product now exercises the same `applyAlign` ingress in both Extension Host lines and
  proves the two edits form one native Undo/Redo unit.
- **Real Visual Studio Make Same Width transaction.** The S030 capture invokes `Edit.SelectAll` and the native
  `Format.MakeSameWidth` command in the actual WinForms Designer. The archive proves button1 remains 120×30, button2
  changes 60×24→120×24, button3 changes 90×36→120×36, every Location/height survives, and source/project inputs stay
  byte-identical outside the exact Designer serialization. The product exercises the same `applyResize` ingress in
  both Extension Host lines and proves the two edits form one native Undo/Redo unit.
- **Real Visual Studio default-event transaction.** The S049 capture sends a double-click through the real designer
  input HWND to `button1`. Visual Studio emits exactly one `button1.Click += button1_Click` subscription and one
  signature-correct handler, navigates its DTE cursor inside the method, and leaves the project byte-identical. The
  archived action log records the explicit **No** choice for the unrelated mixed-line-ending normalization prompt.
  The product resolves the control's actual default event, confines its code edit to the changed span, compensates
  either artifact on a refused final gate, keeps both documents dirty until explicit Save, and binds both artifacts to
  one native Undo/Redo gesture on both supported VS Code host lines.
- **Existing event handler is a product no-op.** S050 now invokes the real CustomEditor `setHandler` ingress used by
  the Events dropdown with the already-selected, signature-compatible `button1_Click`. Both supported Extension Host
  versions prove one subscription, one method, clean Designer/code buffers, and byte-identical files before and after.
  The archived actual Visual Studio 18.7 x64 trace independently drives the native Events cell and proves the same
  byte-identical no-op; physical ARM64 remains external.
- **Event rewiring is revision-safe across both files.** S051 now snapshots every bounded project partial used to
  validate a signature-compatible event handler and checks those document versions again at the final Designer commit
  boundary. A real compiled-net48 CustomEditor interleave proves a code-behind rename refuses the stale subscription
  without dirtying Designer or touching disk; after exact revert and authoritative re-render, the stable rewire changes
  one subscription and forms one native Undo/Redo unit on VS Code 1.84.0 and 1.134.0. Actual Visual Studio 18.7 x64
  independently performs the rewire through native Document Outline and Events, retains only the currently referenced
  empty handler across rewire/Undo/Redo, reproduces the rewire Designer bytes exactly on Redo, and preserves the project
  plus every unrelated source/Designer fact.
- **Stale handler generation commits neither artifact.** S052 reaches the real `createHandler` product path through
  modern SDK and compiled-net48 CustomEditors, changes the open code-behind document after engine generation, and
  proves the project-partial version gate runs before either the stub or Designer subscription. Both supported
  Extension Host versions retain the independent edit, keep Designer clean, preserve both disk hashes, and create no
  orphan method or wiring. Actual Visual Studio execution remains unclaimed.
- **Unsafe Explorer component names refuse before creation.** S007 drives the registered public `Add Component`
  command with `..\Injected` in a real SDK project. Both Extension Host versions return `invalidName` before creating
  source/generated/resource/project artifacts and preserve the target directory entries exactly. Actual Visual Studio
  execution remains unclaimed.
- **Selected TabPage receives exact ownership and client geometry.** S035 opens a compiled-net48 form whose second
  TabPage is selected, moves an external TextBox through the product reparent ingress, replaces the Form owner with
  exactly one `tabPage2.Controls.Add`, and converts `(300,80)` to the live TabPage client `(276,38)`. Both supported
  Extension Host versions keep disk unchanged and restore/reapply membership plus Location with one native Undo/Redo
  unit. Actual Visual Studio execution remains unclaimed.
- **Stale SplitContainer targets refuse without a hidden history edit.** S036 first renames `splitContainer1` through
  the product so the old `splitContainer1.Panel2` identity is no longer live, then routes a reparent intent to that
  stale target through real modern and compiled-net48 CustomEditors. Both supported Extension Host versions preserve
  source/disk exactly; one native Undo removes the setup rename, proving the refusal registered no second edit.
- **Document Outline rename is one selected-control transaction.** S061 selects `button1` through the real session pick
  shared by canvas/outline and renames it to `submitButton` through the product. Both supported Extension Host versions
  prove selected identity transfer, exact declaration/Name/reference rewriting, unchanged unrelated strings/control,
  no pre-Save disk write, and one native Undo/Redo unit. Actual Visual Studio execution remains unclaimed.
- **Collision-safe Paste is a real cross-runtime product transaction.** S024 copies `submitButton` through the shared
  product clipboard without mutation, then pastes into the same form. Modern and compiled-net48 CustomEditors generate
  `button1` before commit, keep the original identity/property/owner exact, apply the bounded 8px nudge, select the
  clone, preserve disk, and restore/reapply the whole Paste with one native Undo/Redo unit on both host lines. The
  archived actual Visual Studio 18.7 x64 trace independently executes native Copy/Paste on both runtime lanes, also
  generates `button1`, preserves copied properties/ownership, and passes shape-exact Undo plus byte-exact Redo; VS
  places the clone at `(98,74)`, so the evidence is intentionally bounded to collision safety rather than geometry.
- **Outline reparent is scenario-bound to the compiled-net48 CustomEditor.** S063 combines the real outline drag intent
  with the product reparent ingress: `button1` leaves `panel1`, gains exactly one `groupBox1` owner and live
  GroupBox-relative `(10,15)`, and one native Undo/Redo unit restores/reapplies membership plus geometry on both host
  lines. Actual Visual Studio execution remains unclaimed.
- **Real net48 Center Horizontally product transaction.** S031 now opens a compiled net48 CustomEditor with a 241px
  Panel and asymmetric `Padding(10,0,20,0)`, computes the actual Visual Studio result `X 15→80` from the complete
  `ClientRectangle` with WinForms integer truncation, changes only the
  Button `Location`, leaves disk untouched before save, and passes one native Undo/Redo unit on VS Code 1.84.0 and
  1.134.0. The archived Visual Studio 18.7 trace selects the same Button through the real owner-drawn Document Outline,
  enables and executes native `Format.CenterHorizontally`, proves the exact generated-source/trivia region, and leaves
  source/project byte-identical.
- **Visible Visual Studio-style designer workflows.** `SplitContainer.Panel1` / `.Panel2` are selectable and accept
  exact toolbox drops/reparenting; Table/Flow/Split container edits, drop feedback, `AutoSize`/Dock geometry,
  custom/vendor-control manipulation, and stateful `ProgressBar.Value` rendering now follow the live WinForms graph.
- **Real design-time metadata routes.** Product smart tags consume bounded `DesignerActionList` metadata instead of a
  property-name heuristic, and properties carrying the framework `CollectionEditor` route through the cancellable
  isolated editor worker. Unsupported actions/editors remain inert or fail closed.
- **Project-wide designer semantics.** Event discovery/wiring spans project partials; typed DataSet tables generate a
  real DataSet/DataMember/BindingSource graph; `.sln`/`.slnx`, classic `<TargetFrameworkVersion>`, and inline
  `InitializeComponent` ownership/routing are covered.
- **Localized structural editing.** In the Default language, bounded Add/Delete/Reparent and event wiring commit the
  generated source and neutral resources through one durable, conflict-checked undo transaction.
- **Real CustomEditor product E2E.** The minimum/current VS Code Extension Host matrix now uses a disposable workspace
  to prove clean open/save, nested-form Save As collision refusal, SDK/classic Explorer Add, unsafe-name refusal,
  generated-source stale-save refusal, partial-Add compensation, ambiguous/unproven-owner pre-render refusals, grouped
  engine-authorized movement, three-control Align Left, composite default-event creation with one native Undo/Redo
  gesture, and same-handler Events selection with no mutation; it also covers net48 reparenting with parent-relative coordinate conversion, generic-base
  visual-inheritance ownership, the proven missing-`InitializeComponent` blank read-only surface, diff suppression,
  and form-family deletion.
- **Repository accessibility surface.** Keyboard-addressable commands and resize handles, accessible component mirrors,
  forced-colors styling, and 200%/400% keyboard paths are covered by the real webview scripts in jsdom. Physical
  assistive-technology and hardware acceptance remain external.
- **Certified editor preview contract.** The repository FakeVendor fixture demonstrates one exact allowlisted dropdown
  editor contract using assembly path, SHA-256, certification ID, isolated execution, bounded invariant return, and
  fail-closed wrong-type handling on modern and net48 metadata paths. This does not enable arbitrary vendor editors.
- **Headless and soak development tooling.** Non-mutating compatibility reports, synthetic observations, redacted
  diagnostics, recovery timelines, and performance-report classification remain repository-only CLI entry points;
  `v2-headless-validate.cjs` and `v2-soak.cjs` are explicitly excluded from the VSIX.
- **`ContextMenuStrip` can finally be created from the toolbox.** It fell between two filters — excluded from the
  control path because a `ToolStripDropDown` throws if parented, and from the component path because it derives from
  `Control` — so the designer could render and edit a context menu but never add one. It is now offered under
  **Menus & Toolbars** and lands in the component tray, as in Visual Studio.
- **Nine more framework toolbox items**, closing most of the remaining Visual Studio gap:
  `PrintDocument` and `PrintPreviewDialog` (Printing is now complete), `BackgroundWorker`, `FileSystemWatcher`,
  `Process`, `EventLog` and `PerformanceCounter` (Components), and `DataSet` (Data). Each was verified to compile in
  a bare `UseWindowsForms` project on **both** `net10.0-windows` and `net48` and to construct on the engine runtime;
  `DirectoryEntry` / `DirectorySearcher` are deliberately still absent because they need a `System.DirectoryServices`
  reference the designer does not add. The palette is now 69 items across 8 categories.
- **`winformsDesigner.toolbox.runtimeFilter`** decides which runtime's controls the palette offers: `auto` (default)
  follows the open form's project, `modern` / `net48` pin it for a mixed workspace, and `all` shows everything.

### Changed

- The v2 scenario catalog and validator now require concrete, nonblank evidence references for repository `PASS`,
  a cited executable test containing the same scenario ID and matching `testKinds`, architecture legs consistent with
  each scenario, and truthful external gates. There is no allowlist path to `PASS`; harness-only and synthetic rows
  remain `NOT_EXECUTED`/`HARNESS_ONLY`.
- Proven modern scalar property edits now use the designer-owned `InitializeComponent` region only when the engine
  proves byte preservation outside the region and exact Lane-A semantic/text equivalence. Unsupported forms retain
  the established source-first path, and the CustomEditor Extension Host test proves the product route plus Undo.
- Form Save As now consumes the document-store aggregate create-only collision plan before the durable multi-artifact
  transaction. S003 now exercises a real two-process hot-exit lifecycle on VS Code 1.84.0 and 1.134.0: one modern and
  one compiled-net48 CustomEditor each persist one VS Code-owned dirty backup, reopen through the workspace recovery
  index, and reconstruct the frozen one-move/one-unit native Undo/Redo state without changing source or Designer disk
  bytes. This bounded proof does not claim serialization of arbitrary multi-unit or multi-artifact history.
- S104 now exercises the established product engine lifecycle through real modern and compiled-net48 CustomEditors on
  VS Code 1.84.0 and 1.134.0. Three clean close/reopen cycles keep the healthy modern PID warm and exactly two owned
  children; a fail-closed net48 whole-worker replacement is accepted only after its old OS PID exits. The final
  last-session idle cycle returns mapped engines and process registrations to zero, proves both current PIDs exited,
  and starts fresh PIDs on reopen. The product budget is 30 seconds; the test shortens only the next timer delay.
  Physical ARM64, Visual Studio execution, and performance-lab handle telemetry remain external.
- S079, S101, and S105 now run through real product CustomEditors on both supported host lines. An ar-SA
  compiled-net48 localizable form mirrors Button and Label window-space X exactly while preserving Y/size, publishes
  Arabic resource metadata, and leaves all four artifacts clean and byte-exact. Separate actual `net8.0-windows` and
  built `net48` projects resolve to live host-owned modern and compiled-net48 workers respectively; the framework form
  explicitly reports live-source interpreted authority. Their actual Visual Studio traces and physical ARM64 legs
  remain external where applicable.
- Modern and net48 metadata queries bound third-party `TypeConverter` calls and publish `CONVERTER_TIMEOUT` instead of
  hanging the property grid or leaking stale dropdown metadata.
- Release packaging stages each target in isolation, verifies RID/TFM/PE machine values, freezes the verified x64
  artifact before ARM64 staging, then restores and re-verifies both immutable VSIX files together.
- Release tooling now has one chain: Node `24.14.0`, npm `11.9.0`, exact dependency versions, and the sole
  `extension/package-lock.json`. Both engines declare `Version=2.0.0`, `AssemblyVersion=2.0.0.0`, and
  `FileVersion=2.0.0.0`; metadata-only and clean-tag identity preflights are separate and explicit.
- Explorer Add commands accept an optional programmatic item name while preserving the normal interactive prompt.
  Classic-project item insertion is now persisted atomically as part of the generated-file transaction instead of
  leaving a hidden dirty `.csproj` document.
- Toolbox categories now follow Visual Studio's tabs rather than the type's shape: `NotifyIcon` and `ToolTip` sit in
  **Common Controls**, `BindingSource` in **Data**, and `PageSetupDialog` / `PrintDialog` in **Printing**.
- The Windows ARM64 wording is narrowed everywhere it appeared. The `win32-arm64` package is still published and
  still genuinely contains an ARM64 modern engine — the release assertion fails the build otherwise — but nothing in
  it has ever been executed on ARM64 hardware, because every build and test run happens on x64. It is now described
  as untested and carrying no support claim, and the requirement line reads **Windows x64**.

### Fixed

- **Make Localizable atomicity.** The converted `.Designer.cs` is flushed inside the journaled resource transaction's
  undo-registration phase. A source flush failure now rolls the `.resx` back and reports rejection instead of posting
  a false success with only half of the conversion persisted.
- Certified editor results with a malformed or wrong runtime type now return `INVALID_EDITOR_RESULT` before the normal
  source transaction can mutate the document.
- Converter timeouts no longer poison later healthy metadata queries on either engine.
- Project output discovery no longer treats the newest file under `bin/` as loadable merely because it exists. The
  resolver inspects the managed PE machine and CLR flags, accepts portable AnyCPU images, and skips foreign-RID or
  fixed-machine assemblies that cannot load in the current designer process; this prevents a newer ARM64 publish from
  degrading an x64 custom-control form to a framework-only or near-empty canvas.
- Form `Save As` now preflights the visible `.cs`, generated `.Designer.cs`, neutral `.resx`, and existing localized
  `.resx` destinations together. Any collision is reported before a sidecar is created, with all conflicting names.
- Generated-source save conflicts now carry the stable `STALE_SOURCE` code while preserving the external bytes and the
  user's dirty buffer. Late render/describe replies after a designer tab closes no longer leak a disposed-webview
  rejection from the Extension Host.
- The VS Code 1.84 generated-source watcher no longer adopts a journaled transaction's own forward write as an external
  revision and roll back a valid localized reparent. Exact transaction-owned text/BOM images are suppressed only for
  the runner lifetime; every other external change still follows the normal stale/conflict path.
- Modern and net48 inherited overrides now authorize protected custom/vendor `Control` fields from the resolved live
  field/runtime types, preserving the opaque base token and keeping mismatched/private targets read-only.
- VS-canonical `SystemIcons.<member>.ToBitmap()` assignments now pass through a finite trusted-framework allowlist in
  both interpreters, so the S013 Button renders its actual icon instead of silently dropping the Image statement.
- The net48 render-desktop host clears transient child focus and TextBox selection before `DrawToBitmap`, matching the
  Visual Studio design surface instead of capturing runtime-blue selected text in S014.
- The net48 stale-base handshake now compares assembly-version-independent closed generic identities. A derived
  `GenericBaseForm<int>` no longer falls back as if its base had changed merely because Roslyn described the open
  definition while reflection returned a closed CLR name; S011 stays live-source interpreted and keeps inherited
  metadata visible. Net48 reflection tests also resolve the engine from their own build configuration instead of
  mixing Debug and Release `Assembly.LoadFrom` inputs, removing an order-dependent false result in the full suite.
- A proven Form/UserControl with exactly one empty generated partial and no `InitializeComponent` now opens as the
  same blank surface observed in Visual Studio instead of being rejected. The product uses an engine-only transient
  method, exposes the root as read-only, refuses every mutation at ingress and commit, and never writes placeholder
  source. Visual Studio's neutral-resx creation on Save All is recorded but is not claimed as product parity yet.
- **The toolbox no longer hands a modern project a control that breaks the form.** Seven .NET Framework
  binary-compatibility types — `DataGrid`, `ToolBar`, `StatusBar`, `MainMenu`, `ContextMenu` and the
  `DataGrid*Column` pair — are public in the modern reference assembly, so the generated line compiled, but their
  constructors throw `PlatformNotSupportedException` on .NET Core and later: the control never entered the graph and
  the form rendered permanently short a control. They stay available for a `net4x` form, where they are real working
  controls, and are filtered out on the modern route.
- The Properties panel no longer wastes width and height on inset that does nothing. VS Code injects
  `body { padding: 0 20px }` into every webview and only the margin was being reset, so the whole surface sat in a
  frame; the property grid also carried its own inset and now runs edge to edge like Visual Studio's. The bottom tab
  strip could not shrink below its labels, which wrapped them to two lines and, on a narrow panel, forced a
  horizontal scrollbar whose gutter read as padding under the tabs.

### Release boundary

- The shipped claim is a **bounded repository-side managed standard-control release**, not “full Visual Studio parity,”
  vendor-suite certification, physical ARM64/DPI acceptance, live assistive-technology acceptance, an 8-hour real
  product soak, or publication approval.
- x86, COM, and ActiveX remain explicitly excluded and fail closed. Licensed vendor cohorts, Visual Studio
  round-trips/reference traces, physical hardware, legal/product approval, and rollout/rollback observation remain
  `GATED` or `NOT_EXECUTED` in the release record. Publishing this tag does not change any of them.

## [1.15.0] - 2026-08-20

**Bounded Data Sources are now source-first and fail-closed.** The designer can discover conventional project DTOs
and application settings, generate detail/grid binding surfaces, append schema columns to an existing
`DataGridView`, and bind a compatible setting without reading setting values or invoking project code.

### Added

- **Data Sources pane and RPC contract.** `ListDataSources` returns engine-owned schema and setting keys for
  recognized project-local `.cs` DTOs and `Properties/Settings.settings` metadata. Discovery is parse-only,
  bounded, excludes build/IDE directories, and reports existing `BindingSource` fields whose canonical
  `DataSource` is `typeof(schema)`.
- **Detail and grid generation.** `GenerateDataSource` emits one all-or-nothing source edit that creates a typed
  `BindingSource`, detail labels/editors or a bound `DataGridView`, and optional `BindingNavigator` wiring.
- **Existing grid append.** Supported `DataGridView` columns can be extended with missing schema columns while
  preserving existing hand-written supported columns and their source order.
- **Application setting binding.** `BindApplicationSetting` binds a discovered setting to a curated compatible target
  property through a canonical `global::...Properties.Settings.Default` binding.

### Safety

- Schema keys, setting keys, parents, existing grids, and existing binding sources are revalidated against the
  current source and project before every edit. Forged/stale keys, unsupported schemas, duplicate type identities,
  incompatible targets, unsafe existing columns, comments/directives in managed binding/column blocks, non-container
  parents, and partial-edit attempts return no changed text.
- Settings discovery returns only name, type, scope, and an opaque key. Setting default values are never read or
  returned, and the generated settings namespace must be proven from `Settings.Designer.cs` or the project
  `RootNamespace`; it is not inferred from the form namespace.

## [1.14.0] - 2026-08-20

**Visual inheritance is now editable through bounded, derived-source-only overrides.** Eligible inherited
first-party WinForms controls remain visibly inherited while exposing a narrow property and geometry override surface;
the base form source is never modified.

### Added

- **Accessible inherited overrides.** Public, protected, and protected-internal first-party WinForms controls can
  override the bounded `Text`, `Enabled`, `Visible`, `TabIndex`, and authorized layout property set from the property
  grid or canvas on modern and .NET Framework paths.
- **Reset to the base value.** Reset removes only the canonical derived-class assignment, restoring the inherited
  value without rewriting the base form or unrelated derived source.
- **Explicit ownership and authority.** Layout and property metadata carry effective accessibility, separate inherited
  property/geometry capabilities, and an engine-authored base identity token.

### Changed

- Direct manipulation and property-grid edits share the same live layout restrictions. Docked, autosized,
  TableLayoutPanel-managed, FlowLayoutPanel-managed, unsupported, inaccessible, custom/vendor, or unresolved
  inherited controls remain read-only for the refused operation.
- The .NET Framework engine resolves the current declared base semantically from the unsaved designer and sibling
  code-behind buffers. It requires the exact runtime full name and no longer guesses from an equal short type name.

### Safety

- A dirty or rebuilt base-type mismatch produces a visible `BaseTypeChanged` fallback with all inherited tokens and
  capabilities removed. Describe, apply, reset, and geometry commits revalidate current designer and code-behind
  snapshots and refuse stale authority before writing.
- Derived edits are limited to one canonical `this.<field>.<property> = ...;` assignment. Ambiguous control flow,
  unsafe expressions, duplicate or handwritten target writes, unsupported enum/literal shapes, source-field
  collisions, and comment/directive loss fail closed.

## [1.13.0] - 2026-08-19

**Assets and menu/toolbar editing now stay source-first across project resources and direct manipulation.** Existing
strongly typed image resources can be assigned without copying bytes, menu and toolbar items can be reordered or
reparented on the canvas, and standard Visual Studio-style menu/toolbar skeletons insert as one atomic edit.

### Added

- **Existing project image resources.** Image, Bitmap, and Icon properties expose a **Project…** action before
  **Import…**. Discovery is bounded to conventional project-local `.resx` plus adjacent `.Designer.cs` pairs; the
  engine cross-checks losslessly representable byte-array/FileRef metadata with canonical strongly typed accessors and
  emits only the typed `global::…Resources.<name>` assignment. The project resource files are never written.
- **On-canvas strip moves.** A field-backed `ToolStrip`/`MenuStrip` item can be dragged within its current collection or
  reparented between modelled `Items`/`DropDownItems` collections. The host emits one forest transaction, retains item
  identity/selection, creates a missing target `AddRange` when safe, and preserves unrelated item statements.
- **Insert Standard Items.** The ToolStrip/MenuStrip item editor now exposes **Insert Standard Items**
  for editable `MenuStrip.Items` and `ToolStrip.Items` collections. The command appends the standard menu or toolbar
  skeleton as one pending forest edit, supports Cancel without posting a mutation, and commits through the existing
  `setToolStripItems` safety funnel.

### Changed

- The ToolStrip item engine now accepts a brand-new dropdown item with brand-new children in the same atomic forest
  edit and existing field-backed item moves between modelled collections. New non-dropdown items with children,
  non-dropdown move targets, cycles, shared/anonymous items, and unsupported collection shapes still fail closed.

### Safety

- Webview messages cannot forge a target property type: the host re-resolves the exact writable image property from
  engine metadata published for the current source revision. Project resource paths are canonical-realpath checked
  before and after reading, including parent junctions/symlinks, and reads are UTF-8/regular-file/64 MiB bounded.
- A resource accessor is offered only from a non-partial generated-like class without a base, static constructor, or
  static member initializer, with canonical `resourceMan`/`resourceCulture`, a canonical lazy `ResourceManager`, and a
  side-effect-free `GetObject(key, resourceCulture)` image getter. Duplicate accessors, malformed/binary/unknown
  resources, stale form/resource inputs, localizable forms, and unknown baselines cause zero source/resource writes.
- Strip moves refuse cycles, missing/non-dropdown targets, unsupported Add/AddRange shapes, shared/anonymous items,
  and any rewrite that would drop an item-adjacent comment or unknown statement.

## [1.12.0] - 2026-08-19

**Toolbox creation now supports both familiar placement gestures without sacrificing source-first safety.** A
double-click inserts a default-sized control into the active container, while an armed toolbox item can be drawn as
an exact rectangle on the canvas. Modern and .NET Framework previews consume the same parent, position, and size.

### Added

- **Selected toolbox placement.** A single click arms a visual toolbox control, exposes the selected state in the
  Toolbox and canvas, and `Escape` cancels it. Double-click performs exactly one default-sized insert. Non-visual
  components retain their tray-only add path and explicitly disarm any previously selected visual control.
- **Exact rectangle creation.** Dragging on the canvas posts the exact logical rectangle and hit target. The host walks
  from a child hit to the nearest supported container, converts the rectangle to that container's client coordinates,
  and emits explicit `Location` and `Size` assignments. Autosized controls receive `AutoSize = false` before the
  requested size, matching an intentional user-drawn rectangle.
- **Cross-runtime size protocol.** Optional trailing width/height fields extend the modern and net48 add RPCs without
  changing older point-drop callers. The compiled net48 live instance receives the exact size immediately, so the
  preview and persisted source agree before the next rebuild.

### Changed

- Ordinary cross-webview drag/drop remains a point placement with the curated default size. Toolbox selection is
  host-owned across panel re-renders and is cleared only by cancellation, switching to a component, or a successful
  source commit.
- Mixed exclusive property editors now display an explicit mixed value instead of mislabelling disagreement as
  unset; choosing a concrete enum or Boolean value still uses the existing all-target transaction.

### Safety

- Unknown/stale toolbox keys, components on the rectangle route, incomplete/non-integer/non-positive/oversized
  rectangles, unsupported parents, stale document revisions, and failed source commits leave the document unchanged.
  Requested dimensions are bounded to `100000` logical pixels in both engines, and the net48 live mirror validates the
  same pair before creating a control.

## [1.11.0] - 2026-08-18

**Precision layout is now driven by the live WinForms geometry instead of browser approximations.** Move and resize
can use SnapLines, a configurable grid, or free placement; nested client insets, margins, padding, font baselines,
DPI, zoom, and mirrored forms all share the same engine-authored coordinate model.

### Added

- **Three layout modes.** `winformsDesigner.layoutMode` selects `SnapLines`, `SnapToGrid`, or `None`;
  `winformsDesigner.gridSize` sets the 2–128 logical-pixel cell size, and `winformsDesigner.showGrid` draws that
  grid only inside the form's exact client rectangle. **Align to Grid** is now an active context command. The existing
  per-gesture snap-override modifier still bypasses the selected mode.
- **WinForms-aware snaplines.** The engine sends every control's exact outer/client rectangle, `Margin`, `Padding`,
  and a live Font/DPI-measured baseline for Label/TextBox-class controls. SnapLines use those values for container
  padding, adjacent-control margin distance, and text-baseline alignment without measuring text in the webview.
- **Complete spacing commands.** Horizontal and vertical Increase, Decrease, and Remove join Make Equal. The first
  sorted control is stable, every original gap changes by exactly one configured grid cell (or becomes zero), and
  controls from different containers are refused.
- **Ctrl+drag duplication.** A snapped drag can clone a single or multi-selection instead of moving the originals.
  It reuses the source-first copy/paste representation, applies the exact preview delta to every clone, and commits
  the whole set as one undoable edit without changing the ordinary clipboard.

### Changed

- Nested window and client coordinates now use live WinForms screen translation, including GroupBox/container
  non-client insets and `RightToLeftLayout`; the deterministic hierarchy calculation remains the fail-closed fallback
  for a hostile or unrealized vendor handle.
- Toolbox drop placement and Center in Container now consume the same exact client rectangles as SnapLines. Ctrl+Arrow
  and spacing steps follow the configured grid size instead of a separate fixed constant.

### Safety

- Exact-offset paste is a bounded RPC. Ctrl+drag preflights every source, composes every clone against one immutable
  revision, and returns without a document edit if any member cannot be represented safely; no valid prefix is
  committed. Layout metadata also participates in the dirty-region geometry equality gate, preventing a stale
  snap model after a font, margin, padding, or client-inset change.

## [1.10.0] - 2026-08-18

**The property grid now edits a multi-selection as one source transaction.** It shows only the browsable, writable,
type-compatible properties shared by every selected control, represents disagreement as a mixed value, and never
uses the primary control's value as an implicit write to the rest.

### Added

- **Multi-object property editing.** Ctrl/rubber-band/Ctrl+A selection is carried from the canvas to the host as an
  exact ordered target set. Modern, net48 interpreted, and net48 compiled-property descriptions are intersected by
  property name, type, enum shape, editability, and compatible standard values. Structural, resource, reference,
  collection, extender, table-cell, and modal-editor properties stay on their dedicated single-target transactions.
- **Mixed-value and multi-reset UI.** A shared property whose values differ renders an explicit blank mixed editor.
  Reset is offered only when the shared row has a representable source override and sends the same multi-object
  transaction marker as Edit.
- **Atomic batch RPCs.** `SetProperties` and `ResetProperties` preflight the complete current-source target set before
  returning any text. Every safe per-control splice is composed in memory, revision-checked by the host, and committed
  as one undo unit. Duplicate, missing, inherited, unrepresentable, unsafe-comment/directive, or stale targets return
  no text, so a valid prefix can never be committed.

### Changed

- The existing **Categorized / Alphabetical** property-grid toggle is now covered as part of the multi-object workflow;
  both modes use the same search predicate.
- net48's one-snapshot live batch accepts explicit Reset operations, so a committed multi-object source reset is
  mirrored with `PropertyDescriptor.ResetValue` instead of parsing an empty value.

### Safety

- Webview multi-object requests are authorized only against the exact synthetic property intersection published for
  the current source revision and still-current canvas selection. The server independently validates the closed target
  set and the source ownership of every member before computing a batch preview.

## [1.9.0] - 2026-08-14

**The daily design loop now matches the familiar Visual Studio gestures and project workflow.** Naming,
default-event creation, code/designer navigation, keyboard selection traversal, live geometry, and Explorer item
creation are available without leaving VS Code. All source-changing gestures retain the existing revision, ownership,
localizable-form, stale-render, byte-local, collision, and fail-closed project-shape gates.

### Added

- **Create complete project items from Explorer** ([#4](https://github.com/SkivHisink/winforms-designer-vscode/issues/4)).
  A new **Add** submenu creates a Windows Form, User Control, Component, or Class in the selected project folder.
  Forms and user controls are generated as a compile-ready `.cs` / `.Designer.cs` pair — the Visual Studio item
  template itself, down to the documented designer members, the generated-code region, the unqualified base type,
  and the `using` block the project's implicit usings and `.editorconfig`
  `csharp_using_directive_placement` decide the shape of. As in Visual Studio, no `.resx` is seeded on an SDK
  project (the engine writes one when a resource first needs it) while classic projects get theirs, and the
  template writes no constant `AutoScaleDimensions` — a fixed pair would rescale every form whose target font is
  not the modern default. The new form opens directly
  in the designer; components and classes are complete code items and open as source. Names are collision-safe,
  namespaces follow the static project root plus folder path, SDK projects use implicit items, and classic or
  default-item-disabled projects receive the exact `Compile` / `EmbeddedResource` entries in the **same undoable
  workspace edit** as the files. Ambiguous projects, shared `.projitems`, dynamic/conditioned MSBuild properties,
  unsupported wildcard item shapes, non-WinForms form targets, and any companion-file collision are refused before
  writing, so a failed Add cannot leave half a form behind.
- **Rename ordinary controls.** `(Name)` is an editable source-backed Design row for field-backed controls, and `F2`
  invokes the same rename from both the canvas and Document Outline. The established minimal field/`this.field`/Name
  rewrite is reused; invalid or duplicate identifiers, inherited/unresolved controls, localizable generated source,
  unqualified designer references, stale revisions, and any code-behind reference are refused without changing source.
- **Double-click creates or opens the real default event** ([#5](https://github.com/SkivHisink/winforms-designer-vscode/issues/5)). Both engines resolve the component's actual
  `DefaultEventAttribute` through `TypeDescriptor`; Button → Click, TextBox → TextChanged, and Form → Load therefore
  use the existing signature-aware handler generator. An already-wired handler only opens its body and changes no
  source. Controls with no browsable default event remain unchanged.
- **Visual Studio navigation keys.** `F7` opens code from the designer and `Shift+F7` opens the designer from a form
  source file.
- **Keyboard selection traversal.** `Tab` / `Shift+Tab` cycle siblings, `Esc` selects the parent container, and
  `Ctrl+A` selects every sibling in the current design scope without crossing a container boundary.
- **Live geometry for every placement gesture.** Normal snapped move/resize now shows `x`, `y`, width, and height as
  the pointer moves; the existing per-gesture free-placement status keeps the same complete readout.

- **Make a form localizable, from the designer** — the culture picker on a plain form now offers **Add
  Localization** instead of only explaining why a culture would do nothing. The conversion is Visual Studio's
  `Localizable = true`: every localizable value (text, position, size, tab order, fonts, anchoring) is lifted out
  of `InitializeComponent` into the neutral `.resx` behind `resources.ApplyResources(...)`, while `Name`, event
  wiring, `Controls.Add` and the rest of the structural code stay exactly where they are. Values are read from the
  live rendered form, so the picture does not change — the engine e2e compares the rendered PNG byte-for-byte
  across the conversion. Source and `.resx` are applied as ONE undoable edit, and the conversion is refused rather
  than approximated when the form uses constructs this engine cannot interpret, when a value's type cannot
  round-trip through the resource writer, or when the form is already localizable. After converting, the culture
  picker opens on the form you asked for. The converted `.Designer.cs` is written to disk together with its
  `.resx`: a localizable form must never be left dirty, because the save path refuses to flush that state (it
  cannot tell it from a recovered pre-1.5 buffer that diverges from the resources) — leaving it dirty would have
  meant the conversion produced a form the user could not save. Selecting a culture whose `.resx` does not exist
  yet now says what to do next, instead of only stating that the file will appear.

### Changed

- **Dropping a control now writes what Visual Studio writes.** The generated code was correct but shaped
  differently, and two of those differences were behavioral. Field names follow VS (`checkBox1`, not `checkbox1`).
  Constructors form one leading run; each control gets its own `//`-header block; the form's block carries
  `Controls.Add` **newest-first**, so a freshly dropped control lands on TOP of the z-order instead of underneath
  its siblings. A form that has no layout scaffold gains `SuspendLayout()` / `ResumeLayout(false)` and its own
  `Name` on the first drop, and `AutoScaleDimensions` is persisted **from the live rendered form** — 6,13 on .NET
  Framework, 7,15 on modern .NET — where a constant would rescale the form on the wrong target. Text-sized
  controls (Label, LinkLabel, CheckBox, RadioButton) arrive with `AutoSize = true` plus the `PerformLayout()` that
  makes it take effect, button-family controls with `UseVisualStyleBackColor = true`, and control fields are
  declared below `#endregion`. A designer file Visual Studio itself generated is added to in place — its
  constructor run, blocks and existing members are located and reused, never rearranged — and a file with an
  unfamiliar shape is still only appended to, as before.
  - An AutoSize control now shows no size grips, matching Visual Studio: dragging one would have written a `Size`
    the layout engine discards.
  - Removing a control also removes its `//`-header block. Add-then-remove no longer restores the original bytes
    exactly — the layout scaffold a first drop installs stays, exactly as it does in Visual Studio.

### Fixed

- **Editor toolbar icons.** *Open Designer* and *View Code* declared no icon, so VS Code drew its own placeholder
  in the editor title bar. *Open Designer* now ships a themed 16×16 designer-surface glyph and *View Code* uses the
  standard `$(code)` codicon.
- **The form notice could not be got out of the way.** The persistent strip ("Localizable form — editing …",
  the stale-compiled-preview and inherited-base disclosures) occupied two lines of canvas forever. It now
  collapses to its icon with a click — the icon keeps the full text as its tooltip and expands again on click,
  and the choice is remembered — so the disclosure is never removed, just no longer in the way. Its text is also
  shorter now.
- **The `.Designer.cs` disappearing on every save.** Saving replaced the designer file (and its sibling `.resx`)
  through `vscode.workspace.fs.rename`, whose overwrite is a DELETE followed by a rename — so the form's designer
  file really was removed from disk mid-save, the file watcher reported the deletion, and the Explorer showed it
  vanish and reappear. The replacement now uses the platform's own primitive (`MoveFileEx(MOVEFILE_REPLACE_EXISTING)`
  on Windows), which swaps the staged file over the target in place. The crash-safety guarantee is unchanged and
  the target is never observably absent — pinned by a test that fails against the delete-then-rename sequence.
- **Culture selection on a form that has no resources.** Choosing a localization culture for an ordinary form
  changed nothing, wrote no file, and said nothing — the picker only selects *which* resource set a **localizable**
  form reads and writes, and an ordinary form keeps every property in `InitializeComponent`. The command now
  explains that instead of silently succeeding, and on a localizable form it names the `.resx` a culture will
  produce with the first localized edit. A well-formed but non-existent culture such as `en-EN` is also refused
  now: ICU accepted it, and the resulting file would never be loaded by any `ResourceManager`.
- **Repeating toolbox auto-discovery log.** Background discovery reran on every text-document change — including
  changes to VS Code's own output-channel documents, so an open extension log rescheduled the pass that wrote the
  next line into it. Discovery now yields only for real user edits, an unchanged result is no longer reprinted, and
  the "no related build-output roots" line names the actionable cause (projects that have not been built yet).

## [1.8.0] - 2026-08-13

**Exact free placement, a self-maintaining workspace toolbox — and a designer that no longer runs your application,
blocks your build, or puts windows on your screen.** Placement stays aligned and source-safe unless the override
modifier is held, and toolbox discovery follows only the open form's related project graph. Alongside that, real
`net4x` forms now take the Visual Studio route — the declared base type plus the replayed designer statements —
instead of falling back to constructing your own class; the modern engine stopped holding your build output open at
all; and the .NET Framework preview both hands that output back for an external build and confines every window it
realizes to a desktop that is never displayed.

### Added

- **Deleting a form deletes the whole form** ([#3](https://github.com/SkivHisink/winforms-designer-vscode/issues/3)).
  `Form1.cs` is only part of a form: `Form1.Designer.cs` and `Form1.resx` (plus any `Form1.<culture>.resx` the
  localization workflow wrote) exist solely for it, and this extension already shows them nested under it — but
  nesting is display only, so deleting the form left its resources behind as orphans. They now go in the **same
  operation**, which means one confirmation and one undo, and it applies to whatever performs the delete (the
  Explorer, a command, another extension) rather than to one gesture. Only files generated for that form are taken:
  a `.resx` whose middle segment is not a culture, and a same-prefix neighbour like `Form10.resx`, are never touched.
  Set `winformsDesigner.deleteFormSiblings` to false to delete only the file you selected.
- **Alt placement override.** Holding Alt during one move or resize suppresses alignment snaplines and shows the live
  `x`, `y`, width, and height values. The binding can be changed to Control or Shift, or disabled entirely. The final
  operation still uses the existing engine geometry authorization/correction path, so docked, locked, inherited,
  layout-managed, stale, and read-only controls do not become movable through the override.
- **Self-maintaining project toolbox.** Opening a designer schedules a bounded, off-critical-path scan of the owning
  `.csproj` and its explicit `ProjectReference` graph. Conventional `bin` roots and concrete custom
  `BaseOutputPath` / `OutputPath` / `OutDir` values are recognized without evaluating untrusted MSBuild properties.
  Assembly metadata is cached by path plus size/mtime, successful output directories receive incremental DLL watchers,
  and file/directory/depth/time/project/reflection budgets plus cancellation and skipped-work reporting keep discovery
  visible and bounded.
- **Workspace curation.** Auto-discovered rows are available in **Choose Toolbox Items** so users can hide and restore
  them. Chosen entries, hidden entries, browsed assemblies, and custom tabs persist in workspace state and are not
  overwritten by a later full scan or incremental rebuild refresh. Existing pre-1.8 global curation seeds workspace
  state once during upgrade instead of disappearing.


- **Real-world `net4x` forms now render the way Visual Studio does — without running your code.** VS never constructs
  the form you are editing: it instantiates the declared base type and replays the designer statements onto it. Our
  interpreted preview is that model, but three shapes that appear in hand-written designer files (and never in
  VS-generated ones) used to defeat it and drop the form to the compiled fallback — the one path that constructs your
  real class and runs its constructor, field initializers and `Load`:
  - **an unqualified type name.** `namespace X { using Vendor.Controls; … new VelModelControl(); }` is ordinary C#,
    but no `Assembly.GetType` call can resolve a name with no namespace. The parsed document now carries the file's
    own scope — its enclosing namespace chain and `using` directives, in the order C# itself binds them: a namespace's
    own members before the imports written in that scope, innermost scope first, covering file-scoped (`namespace X;`)
    and nested declarations. So a control declared in the form's own namespace wins over an identically named one
    reached through a `using`, exactly as the compiled source would. Alias and `static` usings are deliberately
    skipped rather than half-resolved.
  - **an assembly-visible constructor.** `internal MyControl()` compiles because `InitializeComponent` is in the same
    assembly; a designer that only calls public constructors declared such a form unrenderable over an access
    modifier. Constructors are now chosen the way C# would from the designed assembly — `public`, plus `internal` /
    `protected internal` declared in an assembly the designer file belongs to, and an all-optional parameter list
    with the author's own defaults. A `private` or `protected` constructor stays refused: no designer file could have
    called it, so the interpreter must not either.
  - **a vendor collection that is not an `IList`.** Measured on a real project: `TreeListColumnCollection` implements
    only `ICollection` plus a typed `Add`. Items now go in through that method — the *most specific* applicable
    overload, as C# would bind it, so a collection offering both `Add(object)` and `Add(Control)` gets the typed one
    rather than whichever reflection happened to return first, and the vendor's no-argument `Add()` overload (which
    *creates* an element) is never chosen.

  Measured on the project that prompted this: 8 of its 10 forms now interpret, including the one whose `Load` opened
  two windows. That form's own code no longer runs at all when you open the designer.
- When neither path can draw a form, the error now names **why the interpreted path bailed** as well as what the
  compiled fallback threw — previously only the second half survived, which hid the gap actually worth closing.

### Changed


- **Selecting a control on a `net4x` form no longer runs your form's code.** The vendor "Tasks" menu (the DevExpress
  smart tags) can only be read from a real compiled instance — and asking for it used to CREATE one, so clicking a
  control on a preview that was drawn by interpreting your source constructed your actual form and ran its
  constructor and `Load`. Both sides now refuse to build for it: the engine answers only from an instance that
  already exists (a peek, never a load), and the designer only asks when the preview *is* that compiled instance.
  The consequence to know about: on an interpreted preview the vendor section of the smart-tag flyout is simply
  absent instead of being paid for with a full form construction; everything the designer offers itself is
  unchanged, and on a compiled preview — including after a live edit re-renders that instance — the vendor menu is
  exactly as before.

### Fixed


- **A designer no longer puts windows on your screen.** Opening a `net4x` form could pop real WinForms windows next to
  VS Code — the form itself, and whatever its own code opened. The compiled preview realizes the REAL type, so
  `Form.Show()` runs the form's `Load`/`Shown` handlers and the vendor's: a splash screen, a docking panel or a
  dialog opened there appeared on the desktop, and a form that is `WindowState = Maximized` ignored the preview's
  off-screen placement entirely — it was realized full-screen (and captured at monitor size instead of its designed
  size). Now the net48 engine runs on a **private desktop that is never displayed** — a desktop belongs to the
  process, so every window the engine, your form or its vendor controls open in the ordinary way is created there and
  never composited to your screen (it also stops the preview stealing keyboard focus). The root window's state is
  normalized before and after `Show`, so the picture is the size you designed rather than the size of your monitor.
  Rendering is unchanged (verified byte-identical), the isolated engine is held in a kill-on-close job so it can
  never outlive the process the editor is watching, and any window your form opened is named in the WinForms Designer
  output. A window that opened *modally* — a message box or licence dialog from `Load` — would block the preview
  where nobody can click it, so it is asked to close after ten seconds and the render continues. If the desktop
  cannot be created at all (a locked-down window station), the log says so plainly and previews behave as they did
  before. New setting `winformsDesigner.net48.isolateRenderWindows` (default on) turns it off for diagnosing a
  vendor control. Note this is containment, not a sandbox: a compiled preview still runs your form's own code with
  your own permissions.

- **An open designer no longer blocks your own build**
  ([#2](https://github.com/SkivHisink/winforms-designer-vscode/issues/2)). Building the project — in Visual Studio, in
  any `msbuild` outside VS Code, or with `dotnet build` on a plain modern project — failed with `MSB3026`/`MSB3027 …
  The file is locked by: "WinFormsDesigner.Engine"` / `"WinFormsDesigner.Engine.Net48"`. Before this release no
  setting could release the modern engine's handles at all: `net48.releaseOnFocusLoss` only ever applied to the
  .NET Framework engine, so a `net8`/`net9`/`net10` project had nothing but **Restart the Designer Preview Engine**.
  Both halves are addressed:
  - The **modern engine never pins a file again.** It loaded every user assembly with
    `LoadFromAssemblyPath`, which maps the file and holds an OS handle until the load context is collected — and
    nothing collected it: the render path never unloaded its context at all (a fresh one leaked on *every* render,
    describe, serialize and preview-save), and the toolbox path only *started* an unload. A **.NET Framework**
    project was hit hardest: loading a `net48` output into the .NET engine SUCCEEDS (only its types fail to
    resolve), so opening a `net48` form pinned that project's `.exe` in the engine that can never render it, with
    no command anywhere in the product able to release it. Assemblies now load from a private in-memory copy, so
    the file is free to overwrite at all times, and one load context is kept per output and reused until that
    output actually changes instead of one leaking per call. Two consequences worth knowing: an assembly loaded
    this way reports an empty `Assembly.Location` (the Choose Toolbox Items path directory is tracked separately,
    but design-time code that locates files through its own `Assembly.Location` sees the change), and a
    project-local **native** dll a control P/Invokes is still mapped in place — replacing that one file still needs
    **Restart the Designer Preview Engine**.
  - **The `net48` preview hands its output back for an external build.** It must load your assemblies in place
    (shadow-copying breaks delay-signed vendor graphs), so it still pins them while rendering — but a build
    started outside VS Code is now detected as it compiles, and the compiled domains are unloaded before MSBuild's
    copy needs the file. The previews go view-only while the build runs and re-render from the new output when it
    lands. New setting `winformsDesigner.net48.releaseOnExternalBuild` (default on); the in-VS-Code task
    coordination, the opt-in focus-loss release and the manual **Release .NET Framework Assembly (for Rebuild)**
    command are unchanged.


- The redistributable vendor corpus now exercises a reflected `TabPages` / `SelectedTabPage` control that does not
  inherit `TabControl`. Interpreted selected-page state, hit testing, source-first ordering, and compiled-fallback
  live moves preserve exact page identity and reject foreign view-state targets.
- Incremental toolbox watchers now honor the same focus cancellation boundary as a full discovery pass; a DLL event
  received while VS Code is unfocused waits for the bounded refresh scheduled when focus returns.

### Safety and release policy

- The interpreted path widened where a type NAME may be looked up and how a component is CONSTRUCTED; it did not
  widen what may be executed. The value allowlists (`DesignerAllowlists`) are untouched, so a static read off a
  user/vendor type is still refused and still falls back with a named reason — one shape (`Resources.Icon16`-style
  reads) therefore remains on the compiled path by design.
- The IR is a versioned contract: carrying the file's namespace scope bumps its schema to 4, so a producer and an
  executor from different builds refuse each other loudly instead of half-reading a document. The new field is
  validated exactly like every other type name, with its own bound.
- Desktop isolation is containment, not a security sandbox: a compiled preview still executes project and vendor code
  with the user's own token, under Workspace Trust as before. It fails open with an explicit log line rather than
  refusing to render, and the isolated process is confined to a kill-on-close job so it cannot outlive its parent.
- Automatic discovery never scans every sibling project in a workspace: only the form's owning project and explicit
  project-reference graph can contribute build-output roots. Typing or losing window focus cancels an in-flight pass.
- This repository-side close does not create a commit, tag, push, Marketplace/Open VSX publication, or external
  credential operation. Real ARM64 hardware, multi-monitor/DPI, native RTL/culture UX, licensed vendor acceptance,
  and publication remain explicit external gates.

## [1.7.0] - 2026-08-09

**Tab order is now a safe, source-first part of the standard tab workflow on both engines.** An active field-backed
page can move one position left or right without regenerating the form, rewriting its property block, or persisting
the designer's view-only selected page.

### Added

- **Move Tab Left / Move Tab Right.** The `TabControl` context menu exposes adjacent page moves on modern .NET and
  .NET Framework canvases. All seven shipped UI locales include the new commands.
- **Canonical `Add` / `AddRange` order editing.** The engine flattens `Controls.Add`, `TabPages.Add`, and fresh-array
  `AddRange` attachments into one execution order, then swaps only the two adjacent field-reference expressions. A
  move can cross an `AddRange` + later `Add` boundary without changing collection shape or page initialization code.
- **Compiled-fallback live parity.** A net48 last-build canvas mirrors the committed move in its live tab collection,
  preserves the active page, and verifies the new first-header identity. Live-source modern/net48 canvases replay the
  edited source as the authority.

### Safety and release policy

- A separate safety gate proves the exact adjacent permutation while requiring every non-tab statement, attachment
  shape, field, and class member count to remain unchanged. Duplicate pages, unknown fields, non-trivial collection
  expressions, inherited/unresolved ownership, stale renders, and localizable structural-source edits fail closed.
- `TabIndex`, page property blocks, and selected-page view state are not rewritten. Edge moves are explicit no-ops;
  successful moves remain one conflict-checked undo unit.
- This repository-side close does not create a commit, tag, push, Marketplace/Open VSX publication, or external
  credential operation. Real ARM64 hardware, multi-monitor/DPI, native RTL/culture UX, and licensed vendor acceptance
  remain explicit external gates.

## [1.6.0] — 2026-08-09

**The standard WinForms `TabControl` workflow is now engine-neutral and durable, while the localization and release
surfaces introduced around 1.5 fail closed more consistently.** Modern .NET forms gain the same on-canvas tab
navigation and source-first tab operations already available on the .NET Framework path, without persisting a
view-only page selection into generated source.

### Added

- **Modern on-canvas tab workflow.** A standard WinForms `TabControl` is identified by the modern engine, tab-header
  clicks are hit-tested against the real hosted control, double-click renames the field-backed page, and the existing
  byte-local Add Tab / Delete Tab writers are available on modern forms as well as net48 forms.
- **Durable per-form tab selection.** The selected page of each tab host is bounded, validated view state stored in the
  workspace. It survives re-render, undo/redo, and editor close/reopen on modern and net48 live-source canvases without
  changing `.Designer.cs` or `.resx`; a removed or unknown host/page degrades to the source-selected page. A disclosed
  net48 compiled fallback remains build-derived and does not promise to restore that view override after restart.
- **Complete localization-workflow copy.** The v1.5 culture selector, localized-resource status, and fail-closed
  structural-edit messages are translated in every supported runtime locale. The command title now explicitly refers
  to the form's localization culture rather than the extension UI language.

### Fixed

- The intentionally unsupported COM and WPF tabs in **Choose Toolbox Items** no longer leave the `.NET` filter,
  Browse, Reset, or OK actions live behind an unsupported placeholder. They cannot invisibly browse or apply hidden
  `.NET` rows; returning to the `.NET` tab restores the normal controls.
- Adding a tab while the net48 canvas is in live-source interpreted mode now records the new page as transient view
  state before re-rendering, so the page the user just added is actually the active page.

### Release hardening

- The release workflow now runs the same `engine/samples` interpreted-coverage floor as CI and syntax-checks both
  shipped webview scripts. Release preflight asserts that neither workflow can silently lose those gates.
- Tab navigation remains view-only, while rename/add/delete reuse existing revision, ownership, byte-locality,
  undo/redo, and localizable-source firewalls. Tab-page reorder and arbitrary vendor tab hosts are not implied by this
  release; vendor design-time hosting remains the 2.0 boundary.
- This repository-side close does not create a commit, tag, push, Marketplace/Open VSX publication, or external
  credential operation. Real ARM64 hardware, multi-monitor/DPI, native RTL/culture UX, and licensed vendor acceptance
  remain explicit external gates.

## [1.5.0] — 2026-08-09

**Localized `ApplyResources` forms are now editable across neutral and culture-specific resources instead of being
globally read-only.** The workflow keeps generated source unchanged, preserves fallback and opaque resources, and
uses the same fail-closed conflict/undo discipline on both modern .NET and .NET Framework forms.

### Added

- **Per-form localization culture selector.** **WinForms: Select Localization Culture** switches between the neutral
  `.resx`, discovered translations, and a newly validated culture name such as `fr-FR` or `ar-SA`. The choice is
  stored in designer view state and normalized through the engine rather than trusted as an arbitrary filename.
- **Executable `ApplyResources` IR.** Both engines resolve same-form resources with neutral → parent → exact overlay
  semantics and apply allowlisted scalar, `Color`, `Font`, geometry, image/icon, `RightToLeft`, and
  `RightToLeftLayout` values. The net48 interpreter uses the same shared host/resolver model; unsupported binary,
  SOAP, external-file, or unsafe typed resource payloads still fail closed.
- **Lossless localized resource editor.** Scalar upsert, image/icon upsert, and Remove Override RPCs preserve comments,
  unknown nodes, and opaque binary resource entries. Removing an exact-culture value restores parent/neutral
  ResourceManager fallback instead of copying a fallback value into the child file.
- **Atomic resource-set history.** Multi-file edits preflight every exact source state, recheck each target immediately
  before its write, reject duplicate targets, run as one undo/redo unit, and compensate a partial write only while the
  just-written bytes remain unchanged. Detected conflicts fail closed; incomplete compensation is reported instead of
  overwriting a later external edit.
- **Cross-runtime localization corpus.** Modern and net48 tests cover neutral/parent/exact strings and geometry,
  translated images/scalars, RTL properties and mirrored layout, culture isolation, unknown/binary preservation, and
  named-pipe resource upsert/remove behavior.

### Changed

- Property-grid edits, Reset, supported Color/Font dialogs, image/icon import/clear, direct geometry, group move,
  align, center, resize, and ToolStrip item property edits route through the selected culture `.resx` on localizable
  forms. Generated `.Designer.cs` stays byte-identical and does not become dirty for those operations.
- The localizable-form banner is now an editable culture-context disclosure. Structural/reference operations that
  require generated-source changes remain explicitly refused because they have no safe resource-only representation.
- The shared IR schema is version 3 and advertises the `ApplyResources` capability; render/describe/hit-test/edit
  requests configure the selected culture before interpreted execution.

### Safety and release policy

- Whole-file regeneration of a localizable form remains classified `localizable` and refused. v1.5 adds a targeted
  resource writer; it does not weaken the established source-regeneration firewall.
- This repository-side close does not create a commit, tag, push, Marketplace/Open VSX publication, or external
  credential operation. Native RTL/culture UX, Windows ARM64 hardware, multi-monitor fidelity, and vendor/device
  compatibility remain external acceptance gates.

## [1.4.0] — 2026-08-03

**Layout decisions now come back from the WinForms engine, inherited controls carry explicit ownership, and the
modern engine ships natively for Windows ARM64.** This release also closes the bounded, metadata-driven editor
framework work left open by the broader 1.3.0 roadmap without enabling arbitrary project or vendor code editors.

### Added

- **Explicit visual-inheritance ownership.** Layout and component descriptions distinguish the root, controls
  declared by the current source, inherited controls, and unresolved ownership. Inherited or unresolved controls
  stay visible but are read-only, and edit routes enforce the same rule in the engine instead of trusting the UI.
- **Outline drag/reparent/reorder.** Non-root editable controls can be moved onto the form or a supported container
  from the document outline, with self/descendant/unsupported/read-only drops refused. Context and keyboard actions
  use the existing source-first z-order path.
- **Engine-authoritative modern geometry commits.** Direct manipulation still previews responsively in the webview,
  but final free-control bounds are applied to a real WinForms graph, laid out, read back, and converted into a
  minimal source preview by the engine. `MinimumSize`/`MaximumSize`, docking, auto-size, layout-managed children,
  inherited controls, custom-control constraints, and unsafe source shapes fail closed instead of accepting
  client-invented final bounds.
  A form whose base graph cannot be resolved may still accept safe current-source property edits, but direct geometry
  stays disabled because the missing base layout constraints cannot be made engine-authoritative.
- **Native Windows ARM64 VSIX.** CI and release workflows now build and verify separate `win32-x64`/`win-x64` and
  `win32-arm64`/`win-arm64` modern-engine artifacts, including VSIX target, deps RID, and PE-machine assertions.
  The bundled .NET Framework engine remains an explicitly reduced-feature x64 compatibility fallback on ARM64.
- **Metadata-driven expandable values.** Bounded `TypeConverter` child metadata includes stable paths, categories,
  descriptions, standard values, nested children, truncation disclosure, and cycle/exception guards. Bespoke image,
  reference, data-source, table-cell, and collection editors retain their dedicated safe routes.
- **Generic scalar `IList` / `IList<T>` adapter.** Metadata-routed lists use one bounded source-first adapter for
  canonical `Add`/`AddRange` statements and allowlisted strings, primitives, enums/flags, and existing safe complex
  values. Unsupported types, expressions, comments that would move, ambiguous item types, and oversized inputs stay
  read-only or are rejected before a source preview is returned.
- **Isolated supported `UITypeEditor` broker.** The framework Color and Font editor pairs can run in a short-lived
  child process with a fixed timeout, cancellation, bounded stdin/stdout/stderr, strict JSON, process-tree cleanup,
  invariant-value revalidation, and the normal one-undo source-first property transaction. Project/vendor,
  assembly-qualified, file/image/resource, and arbitrary `EditorAttribute` editors remain disabled.

### Changed

- Fractional Windows display ratios (`1.25`, `1.5`, `1.75`) use a safe 2x integer backing capture while preserving
  exact logical WinForms coordinates; the browser downsamples the backing image to the actual device grid. This
  keeps the cached .NET Framework control graph on its reversible integer-scale path and avoids cumulative drift.
- TableLayoutPanel cell/style tools and FlowLayoutPanel order now compose with the document-outline container and
  order gestures, so nested layout structure can be maintained without a client-only source rewrite.
- Complex editor commits introduced by this release reuse the existing revision check, minimal engine preview,
  byte-local persistence firewall, full re-render, and single undo unit.

### Safety and release policy

- ARM64 packaging is a repository/CI capability, not a claim that an x64-only vendor DLL, COM/ActiveX control,
  targeting pack, kernel driver, or native dependency works on Windows ARM64. Those remain compatibility- and
  hardware-gated as documented in `docs/arm64-support.md`.
- Marketplace/Open VSX publication is still performed only by the guarded tag workflow; this repository-side close
  does not create a tag, publish an artifact, or exercise external credentials.

## [1.3.0] — 2026-07-29

**Vendor forms render live, and editing them keeps up.** Canonical third-party editor forms (the DevExpress
`XtraForm` / `XtraTabControl` shape is the reference case) used to fall back to the disclosed last-build picture
because of two constructs their generated designer files always emit. Both are now part of the executable statement
IR, so those forms render from the source you are editing — and a drag on one no longer re-interprets the whole
form for every frame.

### Added

- **Chained `ISupportInitialize` brackets.** `((ISupportInitialize)(this.textEdit1.Properties)).BeginInit()` — the
  bracket every XtraEditors control emits around its `RepositoryItem` — is now represented and replayed. The IR
  carries the member path, and the executor walks it with the same most-derived member rule the C# compiler uses,
  so a property covariantly re-declared per editor type resolves to the one the source names.
- **Nested flag expressions.** A parenthesized `A | B | C | D` (four-member `AnchorStyles`, for example) is
  collected across the whole tree instead of only the outermost `|`. Every member must belong to one enum type and
  the count is bounded, so a malformed or mixed expression still fails closed with a reason.
- **Executable layout calls.** `SuspendLayout` / `ResumeLayout(bool)` / `PerformLayout` are replayed as real calls
  rather than dropped as no-ops. Dropping them made the interpreted picture disagree with the build — a demo tab page
  measured 116×1 against the compiled 120×36. Resolution is C#-like: a root that hides `SuspendLayout` with its own
  `new` member (`XtraForm` does exactly this) gets the member the compiler would have picked, and an ambiguous or
  non-exact signature is refused rather than guessed.
- **Sortable Choose Toolbox Items.** Name, Namespace, Assembly, Version, and Directory are click- and
  keyboard-sortable. Version compares numerically (`21.2` sorts above `9.0`), the active column is announced through
  `aria-sort`, and keyboard focus survives the re-sort.
- **A DevExpress sample form** under `samples/DevExpressDemo` — `XtraForm` root, `XtraTabControl` with two pages, and
  the editors a real form uses. It is deliberately outside the CI solution (it needs a licensed DevExpress install);
  `DevExpressBinDir` and `DevExpressVersion` are overridable so it builds against whichever version is installed.
- **`winformsDesigner.net48.releaseOnFocusLoss`** — the setting behind the change below.

### Changed

- **Releasing the .NET Framework build output when VS Code loses focus is now opt-in, and off by default.** It exists
  so a build started in an *external* Visual Studio is not blocked by the open designer, but it charged every
  alt-tab for that case: the release unloads the AppDomain, so the first edit after coming back waited for the whole
  assembly graph to load again — measured at 6.7 s on a DevExpress form, against ~20 ms warm. Builds started inside
  VS Code already release the output through the existing task coordination, and **Release .NET Framework Assembly
  (for Rebuild)** remains available on demand. Turn the setting on if you build outside VS Code.
- **Refocus now re-renders unconditionally** when the release did happen. The size+mtime shortcut that was there to
  suppress the churn cannot see a changed dependency, a resource-only rebuild, a same-size copy with a preserved
  timestamp, or a build still running — and guessing wrong leaves pre-build pixels on the canvas with no disclosure.
  The churn it was suppressing is gone because the release itself no longer happens by default.

### Performance

- **A drag on a .NET Framework form no longer re-interprets it.** The engine keeps the interpreted control graph and
  applies the same committed edit to it, returning a fresh picture and layout instead of rebuilding from source:
  ~410–480 ms per frame down to 12–26 ms. When the user stops, the buffer is re-interpreted once off the critical
  path, so the canvas always settles on a genuine interpretation of the source rather than trusting the live value.
- **Re-rendering an unchanged buffer reuses the graph** (~23 ms), and `describeInterpretedComponent` — every property
  grid load and every reference-write revalidation — went from ~414 ms to 7–24 ms.
- **A geometry edit on the modern engine no longer probes for a dirty-region patch.** The probe is a full extra graph
  build whose only outcome would be "patch refused", because a control that moved leaves a hole its own patch cannot
  repaint. A drag went from probe + frame (~127 ms) to frame (~74 ms).

### Safety and verification

- Graph reuse requires exact identity — designer buffer hash, `.resx` content hash, selected tab state, render scale,
  requested size, and the build id of the assembly — plus a bounded age (10 s, on a monotonic clock, so a system
  clock change cannot make a stale graph look fresh). Anything else evicts and re-interprets.
- A graph that has been live-edited is marked mutated and can never answer a later render or describe: the live
  picture is provisional by construction. A partially applied batch, a stale or missing buffer, a rebuilt assembly,
  or a buffer that moved while the edit was in flight all evict the graph and fall back to interpretation from source.
  `Dock` / `Anchor` commits never take the fast path — setting one deletes its conjugate assignment in the same
  commit, so the live batch would carry half the change.
- The host applies a live edit only when the committed buffer is exactly one revision ahead of the picture, so a
  commit that deliberately changes source without re-rendering (Modifiers, event wiring) cannot ride along uncertified.
- The cached graph is handed back when the designer closes — but only if the engine is actually running, and without
  ever starting an AppDomain just to be told there is nothing to discard.
- Engine unit tests cover the new IR shapes directly: nested and chained forms, an empty member path for an unchained
  bracket, layout-call IR including parameterless `ResumeLayout()`, misbound shapes, type-uncertain fields, the
  root-declared method gate, and same-simple-name types in different namespaces. A `VendorEdit` fixture reproduces the
  vendor pattern — an `ISupportInitialize` whose `EndInit` changes geometry, and a `new`-hiding `SuspendLayout` — so a
  regression in either rule shows up as a wrong picture, not just a wrong call count.
- The named-pipe E2E gained two legs: an interpreted live edit compared two-way against a genuine rebuild of the same
  buffer (control ids, rects, frame and client size, tray), and a describe served from a reused graph compared
  property-for-property against a fresh one.

### Known limitation

- Reuse of an interpreted graph is a bounded-staleness policy, not a proof of equivalence with a fresh replay: a
  control that animates on its own timer can differ within the window. The bound (exact identity + 10 s + mutation
  barrier) is the guarantee; forms whose picture depends on wall-clock time are outside it.

## [1.2.0] — 2026-07-24

**Data-bound forms.** This release closes the routine line-of-business binding workflow: controls, binding
components, grid columns, common extender providers, and cross-form clipboard dependencies can now be maintained
through the designer without hand-editing generated binding code.

### Added

- **First-class `DataBindings` editing.** The property grid reads and writes canonical
  `Control.DataBindings.Add(new Binding(...))` statements through a dedicated editor for the target property,
  component data source, data member, formatting flag, `DataSourceUpdateMode`, and format string. Custom or
  non-literal binding expressions remain read-only with a concrete reason.
- **First-class `DataSource` choices.** Supported `BindingSource` and control data-source properties can be cleared,
  assigned to a compatible form component, or assigned to `typeof(T)` through a closed, validated source-first
  workflow.
- **Bound `DataGridView` columns.** The existing column collection editor now round-trips `DataPropertyName`,
  `DefaultCellStyle.Format`, `DefaultCellStyle.Alignment`, and a literal `DefaultCellStyle.NullValue` alongside
  header, width, visibility, and read-only state.
- **Richer component tray.** Non-visual components carry framework toolbox icons, support inline field rename from
  the tray, retain component-reference dropdowns, and surface the common `ToolTip`, `ErrorProvider`, and
  `HelpProvider` extender properties in the selected control's property grid.
- **Dependency-aware cross-form copy/paste.** A copied control carries the exact field names and types referenced by
  its canonical bindings and common extender assignments. Paste succeeds only when the target form exposes matching
  dependencies; otherwise it reports every unavailable or mismatched dependency and leaves the target unchanged.

### Fixed

- **Viewing a diff no longer opens the designer.** Comparing a form (Source Control, *Compare With…*, file history)
  activates a text editor for one side of the comparison, and auto-open treated that as "the user landed on a form"
  — replacing the diff being read with a form preview. Either side of a diff, and any non-file document, is now left
  alone; reviewing a change is not a request to edit it. The explicit **Open Designer** action is unaffected, and
  merely looking at a diff no longer counts as the file's one automatic open.

### Safety and verification

- Binding, data-source, grid-style, extender, tray-rename, and clipboard edits use targeted Roslyn splices with
  reverse/minimal-diff gates. Unsupported expressions, provider types, enum members, comments that would be lost,
  and crafted clipboard references fail closed.
- The loss guards look INSIDE a statement, not only at its edges, so a comment between the arguments of a
  `new Binding(…)` or a `SetToolTip(…)` call blocks the edit instead of being regenerated away. An extender call
  whose current value is a hand-written expression, a grid column with an explicit `DefaultCellStyle.NullValue = null`,
  and an owner whose own initialization sits between two of its `DataBindings.Add` calls are all refused with a
  concrete reason rather than rewritten.
- Component-tray rename refuses when the designer file refers to the field without a `this.` qualifier, or when the
  form's code-behind partial references it — neither is rewritten by a source-only rename, and both would otherwise
  produce a file that no longer compiles while the designer reported success.
- Added a complete `DataBoundForm.Designer.cs` fixture plus focused engine unit coverage for bindings, bound grid
  columns, tray-component rename, common extenders, and cross-form dependency validation.
- The named-pipe engine E2E exercises the complete data-bound form workflow (and now fails, rather than skipping, if
  that fixture is missing); the live-webview suite covers the `DataBindings` and `DataSource` popups, extender
  routing, tray icons, and inline tray rename on the real panel and designer scripts.
- A `mojibake:scan` gate fails the build when a tracked text file carries a double-encoded typographic or
  multi-letter sequence — the CP1251/Latin-1 round trip that produced those literals. Such a file still parses, so no
  other gate could see it. A corrupted single accented letter is deliberately out of scope: at that length valid
  locale text is indistinguishable from the corruption, and the gate must never fail a correct file.

### Known limitation

- The preview does not evaluate data bindings (neither does the Visual Studio designer). A
  `Control.DataBindings.Add(new Binding(…))` statement is therefore reported as a skipped construct in the render
  note, and on the .NET Framework engine it drops that form to the disclosed last-build preview. Editing bindings is
  unaffected — it is source-first and exact on both engines.

## [1.1.0] — 2026-07-24

**Daily workflow and project integration.** This release closes the first post-1.0 workflow milestone: designer
workspace state survives a reopen, Choose Toolbox Items can find controls outside the already-built project, the
ImageList editor safely reorganizes existing images, net48 build/test tasks no longer require a manual release step,
and a degraded render provides an actionable recovery path instead of only reporting that it failed.

### Added

- **Complete Choose Toolbox Items discovery.** The modern and net48 engines scan project outputs, configured probe
  directories, explicitly browsed DLLs, and registered .NET assemblies without instantiating candidate controls.
  Modern scans use a collectible `AssemblyLoadContext`; net48 scans use a short-lived `AppDomain`. Both return the
  exact source assembly path used by Add Control and the optional `<Reference>` flow, cache bounded scan results, and
  release browsed files before the scan RPC completes. Chosen items and custom toolbox tabs persist across reloads.
- **Per-form workspace persistence.** Zoom, **Lock Controls**, the active designer tab, collapsed toolbox categories,
  outline state, custom tabs, and chosen toolbox items are restored when a form or VS Code is reopened. The bounded
  workspace state lives in VS Code storage and never touches `.Designer.cs` or `.resx`.
- **Complete ImageList organization.** Existing images can be reordered and their keys renamed in addition to
  add/remove. Every attached literal `ImageIndex` / `ImageKey` is reconciled by image identity; removed images clear
  their assignment, duplicate-key ambiguity fails closed, and the `.Designer.cs` + `.resx` update remains one atomic,
  conflict-checked undo transaction with immediate modern/net48 preview refresh.
- **Coordinated build and test commands.** **WinForms: Run Build Task** and **Run Test Task** release net48 compiled
  instances before the task, make the designer temporarily view-only, invalidate stale fallback state, and re-render
  every affected form after completion. `Ctrl+Shift+B` uses the hard-barrier build path while a designer is active;
  ordinary VS Code build/test lifecycle events receive the same best-effort release/re-render coordination. Manual
  Stop, Restart, and Release commands remain available for recovery.
- **Actionable degraded-render diagnostics.** Diagnostics identify the affected control or statement and show the
  cause. A failed refresh keeps the last known-good canvas visible but view-only, with direct **Retry**, **Rebuild**,
  **Choose Control Assembly**, and **Copy Diagnostics** actions. A net48 compiled fallback is reported explicitly
  with its reason instead of appearing to be a fully live-source render.

### Fixed

- A collectible modern toolbox scan called `Unload()` but returned before collection completed, so Windows could
  still reject a rebuild or replacement of the browsed DLL. Assembly/type references are now isolated in a no-inline
  scan frame and the collectible context is finalized before the RPC returns. The net48 scanner similarly avoids
  shadow-copy APIs that could fail or keep the scan path pinned.
- Build/test task lifecycle events are correlated by a stable task key rather than JavaScript object identity, so a
  task reported through different VS Code event objects cannot double-release or leave the designer permanently
  view-only.

## [1.0.2] — 2026-07-21

**Patch — manage the preview engine's lifecycle from the UI.** The rendering engine process starts on the first render
and stays resident until the window closes (closing a designer tab does not stop it). Two new commands let you stop it
when you're done, or restart it when it goes stale.

- **New command: *WinForms: Stop the Designer Preview Engine*.** Shuts down the modern and/or .NET Framework engine on
  demand — for when you're done with the designer and don't want the engine `exe` lingering — and it restarts
  automatically the next time you open or render a designer. Stopping the net48 engine also frees any build output it
  was holding open.
- **New command: *WinForms: Restart the Designer Preview Engine*.** Stops the resident engine and immediately reloads
  the active designer so a fresh engine comes straight back — a one-click "give me a clean engine" for when the preview
  has gone stale or wedged (a bare *Stop* only restarts on the next render). Restarting the .NET Framework engine also
  drops and reloads the compiled build it was holding. With no designer open it simply stops the engine, which then
  starts fresh on your next open/render.

Both commands are in the Command Palette and localized in all 7 UI languages.

## [1.0.1] — 2026-07-21

**Patch — the .NET Framework preview no longer blocks your own build.** While a net48 designer tab was open, the
experimental compiled preview held the project's build output (`.dll`) open, so the user's own build in Visual Studio
or `dotnet build` failed with `MSB3026`/`MSB3027` ("The file is locked by: WinFormsDesigner.Engine.Net48") until the
designer was closed or the *Release .NET Framework Assembly (for Rebuild)* command was run by hand.

- **The lock is now released automatically when VS Code loses focus.** Switch to Visual Studio to build and the
  preview lets go of the output on its own; switch back and the active preview re-renders to show the build you just
  produced. The lock now only exists while the designer window is actually in the foreground, so the common
  alt-tab-to-Visual-Studio-and-Build flow just works without touching the release command. The manual command remains
  for the case where you rebuild without leaving VS Code. This uses the same bounded release + engine-recycle path the
  command does (delay-signed vendor assembly loading is unchanged — the preview still loads in place, it just doesn't
  keep the handle while you're away).

## [1.0.0] — 2026-07-21

**1.0 — out of preview.** The core designer loop is stable, and this release makes the project's central promise
explicit: **safe persistence**. Supported edits are written as byte-local, conflict-checked source splices; anything
the designer can't persist safely is refused with a stated reason, never guessed — backed by the capability preflight,
the byte-local save firewall, and the golden-corpus round-trip that landed across 0.10–0.12. The **modern** engine
renders your current source. The **experimental .NET Framework** engine renders a compiled instance of your last build,
applies supported live edits best-effort, and always discloses that a rebuild is authoritative; it stays editable, and
your source edits stay byte-local on either engine.

The stable package is deliberately **Windows x64 only** (`win32-x64`). Its modern engine now targets
**.NET 10 LTS** and supports WinForms projects targeting .NET 8, .NET 9, or .NET 10; Linux, macOS, WSL and
Linux-hosted remote workspaces are not supported. The .NET Framework 4.8 / DevExpress x64 engine remains experimental.

Getting to 1.0 meant auditing that promise instead of asserting it. An adversarial sweep of the engine, the host and
the webview — plus repeated independent review — turned up a series of paths that genuinely broke it, and they are
fixed below: a form could render **the wrong class entirely** and call it save-safe, a save could **silently overwrite
someone else's change** or **truncate the form outright**, an event handler could be written into **a different class
than the one wired to it**, a negative number could be **shown wrong**, and an ImageList edit could **replace the images
it failed to read**. Three long-standing **false** refusals are gone too. The VSIX also no longer ships local scratch
files.

The root cause behind several of these was the same: **~30 places each decided for themselves which class in a
`.Designer.cs` was the form**, and the preview and the save path only agreed by luck. There is now **one resolver, in
one file, compile-linked into both engines** — the modern .NET 10 designer and the .NET Framework 4.8 compiled preview
literally cannot answer that question differently. That is what made it safe to tighten the rule at all.

### Strengthened stable core

- **The .NET Framework preview is now honest about what it is, without pretending to be more.** The experimental net48
  engine renders a compiled instance of your **last build**, never the live `.Designer.cs` — and it fundamentally
  *cannot* prove the build matches your source, because you can hand-edit the file and never rebuild. Earlier release
  candidates tried to infer divergence and put the form **read-only** when the picture looked stale. Across repeated
  review that inference proved unable to converge — it produced both false locks (bricking a perfectly good edit) and
  false unlocks (clearing the lock over a genuinely stale picture) — and a lock that can misclassify is *less*
  trustworthy than a plain statement of the facts. So net48 forms are **fully editable**, and the fact that the picture
  is a compiled instance of your **last build** (live updates best-effort; rebuild is authoritative) is recorded in the
  **WinForms Designer output channel** rather than occupying the canvas with an always-on banner. Source safety does not
  depend on that disclosure at all — it comes from the byte-local save firewall, which refuses any edit that isn't a
  confined source splice, on either engine. The modern engine, which renders your current buffer directly, is unaffected.
- **High-DPI rendering — the canvas is crisp on 4K.** Both engines now render the form PNG at the display's device
  pixel ratio by scaling the control tree before capture (so text and metrics are drawn at the higher resolution),
  instead of upscaling a logical-size bitmap after the fact. Layout, hit-testing and zoom stay in logical form pixels,
  so selection, drag and the rulers are unchanged; only the picture gains resolution. The default (1×) path is
  byte-identical to before, and a differential test pins that a 2× render carries real detail rather than a plain upscale.
- **Adding or deleting a tab now updates an interpreted .NET Framework canvas immediately.** On an interpreted net48
  form, an on-canvas tab add/delete (WinForms `TabControl` / DevExpress `XtraTabControl`) re-interprets the committed
  source instead of mutating the compiled instance — closing a case where deleting a page changed the `.Designer.cs` but
  left the on-screen tab in place. The pure-text page-removal splice is unchanged and pinned for the DevExpress shape.
- **A Properties/describe race is closed.** A control or item describe now captures the source revision together with
  the text it reads (no `await` between), so a describe that resolves after a concurrent edit can no longer repaint the
  property grid or item grid with values from the superseded source.
- **You can rebuild your project again while using the .NET Framework designer.** This one was hiding behind every
  "rebuild to refresh the preview" instruction the product gives. Because the preview loads your build output *in
  place* — shadow-copying it would break delay-signed vendor control assemblies — the engine **pinned your dll for as
  long as it lived**, and nothing ever released it. So `dotnet build` failed outright with
  `MSB3027: The file is locked by: WinFormsDesigner.Engine.Net48`, the engine's own "reload when the assembly changes"
  check could never fire (the timestamp it waited for could never change), and every instruction that said *rebuild*
  was unfollowable. The engine now exposes an explicit release. The designer calls it automatically when the last form
  using an output closes (and when a form switches to a different control source, releasing the one it used to pin),
  and **WinForms: Release .NET Framework Assembly** does it on demand — asking the engine to free *everything* it has
  loaded, since a form that switched sources no longer names the output it forgot. If a preview's own control started a
  thread that refuses to unload, or the engine is wedged, the command recycles the whole preview process so the handles
  are freed the operating-system way rather than reporting a release that didn't happen. A regression test drives a real
  MSBuild rebuild against a live engine and requires it to fail while the assembly is held and to succeed once it is
  released — pinning both halves, so this cannot quietly come back.
- **A clearer promise, unchanged behavior: an *incomplete* preview is not a locked one.** The README's one-line summary
  of fail-closed read as though anything the designer can't fully draw becomes read-only. The rule the designer has
  always applied — and the one its own "Fail-closed by design" section spells out — is narrower and is what 1.0 keeps:
  a form it can't faithfully reproduce is **disclosed** (a banner naming what was skipped) and **never whole-file
  regenerated**, while property and geometry edits continue to apply as targeted byte-surgical splices. Those splices
  preserve everything outside the edited span *by construction* — including the very constructs the preview couldn't
  draw — so locking such forms outright would remove a working, advertised capability without making anything safer.
  The summary now says that, rather than implying a stricter rule than the product has.
- **The planned 1.1 hardening ships in 1.0.0.** A fast `net10.0-windows` xUnit layer directly pins the
  safe-save minimality gates, statement equivalence, interpreter allowlists, ASCII/keyword identifier boundary,
  framework value conversion, and TFM selection. A pure Vitest layer pins TypeScript expression conversion and
  bounded per-engine crash recovery. Both layers are mandatory in CI and release workflows.
- **Fewer false read-only results without a wider trust boundary.** The statement firewall now alpha-normalizes
  generated locals by declaration order and treats a side-effect-free `AddRange(new T[] { ... })` as the same
  ordered collection operation as equivalent `Add(...)` statements. Invocations, object construction, and every
  unproved collection element still fail closed.
- **Tighter .NET Framework parity.** Compiled describes now surface source-derived `Modifiers` and read-only
  `GenerateMember`; a committed ImageList transaction reconciles the cached compiled instance immediately, so
  dependent `ImageKey` / `ImageIndex` choices and the canvas no longer wait for a rebuild.
- **Operational hardening.** Diagnostics now include extension/engine versions, capabilities, ping latency, memory,
  engine PID, starts, startup time, recent crashes, and last exit. Unexpected exits get two bounded exponential-
  backoff restarts before a crash-loop guard pauses recovery. CI/release also enforce a cold-start + warm-render
  performance baseline and a release preflight that verifies .NET 10, unit layers, and workflow gates.
- **The .NET Framework release/recycle and shutdown lifecycle is fail-closed.** Freeing a pinned build output now
  waits for a **confirmed** process exit before telling you a rebuild is safe, never starts a replacement engine beside
  a process that might still hold the dll, and quarantines an AppDomain that refuses to unload rather than handing it
  back. The host **owns every engine child from the instant it spawns** — including one still connecting — so none is
  orphaned (and left pinning your dll) when a window closes or the extension deactivates, and a failed spawn is cleaned
  up rather than leaked. The compiled-preview banner's *last build* / clean-vs-dirty disclosure now updates the moment
  the document changes, so it can't lag behind a stalled render. These paths were audited across repeated independent
  review specifically for orphaned processes, stuck locks, and dishonest status.

### Fixed
- **The engine rendered the first class in the file, not the form.** A `.Designer.cs` that declares a second class
  ahead of the form rendered **that** class, reported it **save-safe with no banner**, and let a regenerate splice
  generated code into it — producing a file that no longer compiles. The renderer now resolves the form the same way
  the save splicer and the byte-surgical editors already did — the class declaring `InitializeComponent` — so the
  parts of the engine can no longer disagree about which class the file even is. If a file declares **no** such class,
  or **more than one** (a second form, or a helper — including a **nested** one), the designer now **fails closed** and
  renders nothing rather than picking one: whichever it picked, the splicer might pick the other and regenerate one
  class's body into the other's. The same fix ends a **false read-only** on a form legitimately split across partials
  (component fields in one, `InitializeComponent` in another) — its fields are now found across all of them.
- **Saving could silently overwrite an external change.** The `.Designer.cs` write went to disk unconditionally: if
  the file had changed underneath the open designer (a `git checkout`, Visual Studio, a generator — or simply an
  event the watcher never delivered), Ctrl+S destroyed that revision without a word. The save now re-reads the file
  and refuses — keeping your edits unsaved and saying why — when it no longer matches the version the designer last
  saw, when it carries a different byte-order mark, or when it was **deleted** since being opened; an unreadable
  file (locked, permissions) surfaces the error instead of being written over. And a form whose file couldn't be read
  when it was opened holds no trustworthy baseline at all: rather than let you edit against a file it has never seen,
  the designer treats it as **read-only** — every edit, resource write and *Save As* refuses — until a successful read
  establishes one (the next change to the file clears it automatically; *File → Revert* does so on demand). *Save As*
  also no longer overwrites an existing generated partner: picking `NewForm.cs` writes `NewForm.Designer.cs`, a path
  the overwrite prompt never mentioned, so it is **created conditionally** and refused — not clobbered — if it already
  exists (a form you really mean to replace can be picked directly, where VS Code's own prompt covers it). The sibling `.resx` write
  path was already conflict-guarded; the primary artifact now matches it. Note the ordinary-save check is a re-read,
  not an atomic compare-and-swap — the VS Code filesystem API offers no conditional write, so a write landing in the
  instant between the check and ours can still win. That window is far smaller than the previous behaviour (which
  never looked at all), but it is not zero.
- **A negative number could be rendered and reported wrong.** Unary minus was only applied to `int`, `double` and
  `long` literals — every other numeric literal came back **unnegated and without complaint**, so a
  `numericUpDown1.Minimum = -100` (a `decimal`) showed as **100** in the preview and the property grid, and
  `new SizeF(-6F, -13F)` lost both signs. Negation now happens in the literal's own type, and anything that can't be
  negated is reported as `unrepresentable` — disclosed on the banner and refused a whole-file regenerate — rather than
  shown as a plausible wrong number.
- **An ImageList edit could replace images it hadn't read.** The reader that feeds the editor's data-loss guard
  matched only the canonical `name="…"` spelling, so a `.resx` written by hand or round-tripped through another tool
  (`name='…'`, `name = "…"`) read back as *no images* — precisely the state the guard lets through — and saving then
  replaced the real image set. The reader now tolerates the same attribute spellings the binary-resource scanner
  already did, and the guard additionally refuses whenever the `.resx` demonstrably holds binary resources but none
  resolved for that ImageList: ambiguity fails closed instead of defaulting to "replace everything".
- **TreeView forms round-trip again (a false read-only is gone).** The serializer named the locals it generates for
  `TreeNode`s using the framework's fallback rule, which lower-cases the whole type name (`treenode1`). Every
  Visual-Studio-generated `.Designer.cs` spells them `treeNode1`, and the save gate compares statement **text** — so
  every generated `TreeNode` line looked *lost* and an otherwise perfectly faithful TreeView form was refused
  read-only with a `lostStatements` reason. The engine now emits VS's camelCase, so a VS-generated TreeView form is
  **save-safe**, its regenerate is idempotent, and node names / text / structure are preserved. **The safe-save gate
  itself is untouched and exactly as strict** — this fixes the generator, not the guard. A form written in a spelling
  VS never emits (a hand-simplified `Color.FromArgb(255, 224, 192)`, or `TabPages.AddRange`) still refuses honestly,
  because regenerating it would rewrite bytes you never edited.
- **Resetting a property no longer eats the comment next to it.** A reset deletes whole lines, and its gate compares
  statements — a comment is trivia, invisible to it — so `this.p.Dock = …; // KEEP: pinned by ticket #4711` lost the
  comment and still reported success (reachable from the UI, since setting `Dock` resets `Anchor`). It now refuses
  when the target's line carries anything else, **or** when the assignment itself contains a comment
  (`this.p.Dock /* KEEP */ = …`) or a **preprocessor directive** (a `#if`/`#else` around the value — build-affecting
  structure that was being deleted just as silently). Two assignments of the same property on one line still reset fine.
- **On-canvas menu/toolbar edits could splice a stale item tree.** The add / rename / retype / delete paths read the
  item forest and only then snapshotted the document revision, leaving that read unguarded: an undo landing during
  the round-trip meant the edit was applied to text that no longer existed and could resurrect a removed item. They
  now snapshot the revision before the read, like every other edit path.
- **A handler stub could be written on a form that failed to render.** `navigateHandler` reached `createHandler`
  without the stale-render gate (it isn't one of the blocked message types), so the code-behind stub was written to
  your `.cs` and only the wiring was refused — leaving an orphan handler. It now refuses up front, and re-checks after
  the stub write so the refusal names the real reason rather than arriving as a generic backstop.
- **The .NET Framework 4.8 preview had the same wrong-class bug — and edited a different class than it showed.** It
  resolved the form by taking the **first class in the file**, without even checking for `InitializeComponent`: a
  helper class ahead of the form was instantiated and previewed as your form, with no banner, while the modern host
  spliced your edits into the *real* form. Preview one class, edit another. Both engines now share **one** resolver —
  the same physical file, compile-linked into each — so this cannot recur by drift. The 4.8 host also **built the type
  name itself** and got it wrong for a form nested inside a `record`/`struct` or a generic type; when that name then
  failed to resolve, it quietly fell back to *any unique control with the same short name* — rendering a different
  form as yours, with the explanation written to a buffer nobody reads. The name now comes from the shared identity
  (already reflection's own format), and a lookup miss is reported honestly as a stale build.
- **An event handler could be created in — and validated against — the wrong class.** The `.Designer.cs` class rule is
  shared now, but the paired code-behind was matched by **simple name**, first hit. A `.cs` holding
  `namespace Other { class Form1 }` ahead of the real `namespace Product.Ui { partial class Form1 }` made the events
  dropdown offer *Other.Form1's* methods, made the "does this handler exist?" check validate against them, and wrote
  new stubs **into Other.Form1** — while the wiring went into `Product.Ui.Form1`, which has no such method. Both files
  parse, the save reports success, and the project no longer compiles. The code-behind is now matched on the full
  identity (namespace + enclosing type chain + generic arity), with no simple-name fallback even for a form in the
  global namespace — where a nested `Helper.Form1` decoy would otherwise slip straight back in.
- **The events dropdown could offer a handler that doesn't compile.** Candidate parameter types were compared by their
  **last segment**, so a handler taking your own `Custom.EventArgs` matched `System.EventArgs`: picking it emitted
  `Click += new EventHandler(this.WrongClick)` — not a compatible method group — and the build broke. A qualified
  spelling must now match the real type exactly; a spelling that goes through a `using` **alias** (or an `extern
  alias`) is refused rather than guessed at, since the alias carries the binding that decides compatibility and
  nothing here can resolve it. Bare `EventArgs` — what Visual Studio actually generates — is unaffected.
- **Creating an event handler could erase concurrent edits to your code-behind.** The stub was applied by replacing
  the **entire** `.cs` with a copy generated from a snapshot taken before the round-trip. `applyEdit` has no version
  precondition, so anything that touched the file while that write was in flight — format-on-save, a source
  generator, your own typing — was silently overwritten. The stub is now applied as a **one-point insert**, so the
  rest of the file is untouched no matter what else lands.
- **A handler stub for an exotic event signature could be written without compiling.** The stub's parameter types came
  from a name that truncated at the first backtick, so an event whose argument type is **nested inside a generic**
  (`Outer<int>.ChangedArgs<string>`) produced `Outer<int, string>` — a different, often nonexistent type. A
  **multidimensional** `int[,]` parameter likewise came out as `int[]`, because every array was spelled `[]`
  regardless of rank. Both parsed, so the parse-only guard passed and the wiring was written. Ranks are now emitted
  correctly, and signatures that can't be spelled faithfully (nested-in-generic, by-ref, pointer, open type
  parameters — including the event's own delegate type) are **refused with a reason** instead of a stub that only
  looks right.
- **Any method with the right NAME could be wired to an event.** The write path checked only that a method of that
  name existed somewhere in the form — not its signature — so `void WrongClick(string text)` could be wired to
  `Click`, emitting a method group that isn't an `EventHandler` and breaking the build. The dropdown had always
  filtered by signature; the write path now applies the same rule rather than trusting the UI that called it. That
  rule also got stricter: a non-void **return type** is compared (only void-ness was), and a `ref`/`out`/`in`
  parameter — which this comparison cannot decide — is no longer offered.
- **Wiring to an existing handler never checked the code-behind for changes.** The engine confirmed the handler
  existed in a snapshot, then the wiring was committed after an `await` during which the method could have been
  renamed or deleted — `Click += new EventHandler(this.button1_Click)` against a method that no longer exists,
  reported as wired. It now re-checks the code-behind document, exactly as the stub-writing path does.
- **A form using escaped identifiers rendered as a "stale build".** `namespace @Ui { partial class @Form1 }` is legal
  C# whose metadata name is plainly `Ui.Form1`, but the identity was built from the raw spelling (`@Ui.@Form1`) — so
  the .NET 4.8 host could not find the type in a perfectly current assembly, and the code-behind match failed too.
  Identities are now built from the decoded identifier text.
- **Removing a grid/list column from a split form could strand a field forever null.** The typed `DataGridView.Columns`
  and `ListView.Columns` editors rewrite exactly one declaration — the one holding `InitializeComponent`. For a form
  split across partials they would delete a column's construction and `AddRange` while its **field declaration**,
  living in the sibling partial, survived: the file still compiled, the field was permanently `null`, and the edit was
  reported **safe**. Their "is anything else using this column?" scan was likewise blind to a helper method in that
  sibling partial. Both editors now scan every partial of the form, and refuse to remove a column they cannot remove
  atomically.
- **An unreadable `.resx` was treated as an absent one — and overwritten.** The image and ImageList paths collapsed
  *every* read error into "there is no `.resx`", so a resource file that couldn't be read but could be written
  (permissions, a virtual/remote provider, a transient failure) was rebuilt from scratch: the freshness check compared
  nothing to nothing and passed, the binary-resource drop guard saw zero resources and disarmed, and the atomic rename
  replaced the real file. Only a genuine *file not found* now means "absent"; anything else surfaces as an error.
- **The `.Designer.cs` is now written atomically.** The sibling `.resx` has been written temp-then-rename since 0.11.0,
  but the form itself went out with a plain write — so a crash, a full disk or a power cut mid-save could leave it
  **truncated**. Guarding the resource file while writing the form unprotected had it backwards: a half-written `.resx`
  costs an image, a half-written `.Designer.cs` costs the form. Both now take the same path.
- **An image import no longer strips the `.resx` BOM.** Visual Studio writes `.resx` files with a UTF-8 byte-order
  mark; the engine round-trips the stripped text, so writing it back plain quietly dropped the mark and turned a
  one-image import into a whole-file diff in your history. The original mark is preserved on every write (a `.resx`
  the designer *creates* still has none), and the conflict guards — forward, undo and redo alike — now treat a
  BOM-only external change as the conflict it is.

### Changed
- **Left preview.** The Marketplace listing no longer carries the **Preview** flag; `1.0.0` is the first stable release.
- **The VSIX no longer ships local scratch.** `.vscodeignore` now excludes `.claude/**`, `**/*.log` and `*.vsix`, which
  were being packaged into the published extension.
- **Published support matrix.** The README now states, per runtime, exactly what is supported and — crucially — what the
  designer **refuses to whole-file regenerate** rather than risk corrupting: `Localizable = true` forms, binary `.resx`,
  unresolved base types, and unrepresentable statements, each named by the capability preflight (`safe` / `localizable` /
  `binaryResx` / `unresolvedType` / `lostStatements` / `unrepresentable`). Individual property and geometry edits still
  apply as targeted byte-surgical splices even on those forms. (A `Localizable = true` form is the one case that is
  read-only outright: its layout lives in per-culture `.resx`, so any edit here would diverge from it.)

### Notes
- The **.NET Framework 4.8 compiled preview** (for `net4x` / DevExpress forms) remains **experimental** — render is
  proven and the live edit flow is wired, but it is best confirmed with an F5 run.
- **Post-1.0**, read-only-safe today: `DesignerActionList` / vendor smart-tag action lists, advanced `.resx` (non-image
  resources, the full `ApplyResources` per-culture localization workflow), generic `IList<T>` collection editors, and RTL.
- **External changes now lock the canvas while it catches up.** Adopting an externally-changed `.Designer.cs` used to
  leave the old canvas actionable until the replacement render finished, so a click or drag aimed at what was on
  screen could splice into source the user had never seen; overlapping watcher events could also let an older read
  re-adopt superseded text. Edits are now refused for the whole re-render, the newest read wins, and a read that
  **fails** after the form was opened (the file deleted, locked, or the provider erroring) latches the same read-only
  state instead of being ignored — previously the stale preview stayed fully editable, and the `.resx` paths kept
  writing, against a source that no longer existed.

- **One resolver, one identity.** The class and the `InitializeComponent` method are now a **single decision**, made in
  one file (`FormClassResolver`) that both engines compile-link. That is what allowed the rule to be tightened: a
  class declaring an `InitializeComponent(int)` **overload ahead of** the real parameterless one used to render the
  form **empty** with no banner (every consumer took the first method matching the *name*), and a class declaring only
  such an overload was treated as a designer class at all. Both are fixed. Applying that tightening to one selector
  alone — the shape of an earlier attempt — is precisely the disagreement that regenerates one class's body into
  another's, which is why it waited for the unification rather than shipping as a local patch.
- Known limits, honestly stated — neither loses data:
  - **The ordinary save is a re-read, not a compare-and-swap.** The VS Code filesystem API offers no conditional
    write, so a write landing in the instant between our check and ours can still win. Nothing is awaited between the
    two, making the window as small as the platform allows — and vastly smaller than the previous behaviour, which
    never checked at all — but it is not zero.
  - **A refused handler stub stays.** If a fail-closed gate flips *while* the code-behind stub is being written, the
    wiring is refused but the stub — an unused empty method — remains in your `.cs`, undoable with Ctrl+Z. Taking it
    back would mean re-reading and replacing the whole file, and `applyEdit` carries no version precondition, so a
    concurrent edit landing in that gap would be **erased** by the rollback. Leaving an empty method is the smaller
    harm, and refusing to roll back is the fail-closed side of that trade. For the same want of a version precondition,
    an edit landing during the stub's own (awaited) write can shift where it lands; because that write is now a
    one-point insert rather than a whole-file replace, the worst case is a visibly misplaced method you can undo — not
    the silent loss of everything else in the file.
  - **The events dropdown is matched syntactically, so it can omit a valid handler.** Deciding a parameter type
    exactly needs a semantic model (which `using` directives are in scope). A **bare** name is therefore matched by
    simple name — correct unless the file imports a same-named type in place of the delegate's — while a
    **partially-qualified** spelling (`Windows.Forms.MouseEventArgs`), one reached through an alias, or one whose
    alias is a `global using` in another file, is not offered at all. Because the qualified comparison is exact, an
    alias the parser cannot see can only cause a miss, never a wrong match. A missing entry in a dropdown is
    recoverable; a wired handler that doesn't compile is not.
  - **The designer reads one code-behind file, not the whole compilation.** It parses `Foo.Designer.cs` and `Foo.cs`
    — so a handler living in a *third* partial file (`Foo.Events.cs`) isn't seen, and "new handler" would add a
    second one; a `global using` alias declared elsewhere isn't seen either (see above). Likewise, deleting a control
    or a grid/list column that code in `Foo.cs` refers to leaves that reference dangling. These produce **compiler
    errors you can see and undo**, not silent corruption — and the last is what Visual Studio's own designer does
    too. The fail-closed guarantee is that the designer never quietly writes something wrong; it does not promise to
    predict every consequence of a deletion you asked for.

## [0.12.0] — 2026-07-14

**Release-candidate hardening — round-trip fidelity, re-verified end to end.** This release closes the loop on
"can the designer safely regenerate this form?" It makes **ISupportInitialize** forms round-trip, adds an
**authoritative capability preflight** (so the designer never claims a form is save-safe when a statement would be
lost), locks the whole behaviour down with a **golden-corpus** test, and adds a **Modifiers** editor. Nothing you had
becomes less safe — the designer just tells the truth about what it can and can't regenerate, and can now regenerate more.

### Added
- **`BeginInit` / `EndInit` round-trip.** A form with any `DataGridView`, `BindingSource`, `PictureBox`,
  `NumericUpDown`, `SplitContainer` (or similar `ISupportInitialize` control) emits
  `((ISupportInitialize)(x)).BeginInit()/.EndInit()` brackets. These are now **re-emitted faithfully** when the form
  round-trips (previously they held the form in read-only fallback to avoid dropping them). The safe-save gate stays
  strict — if a bracket ever failed to round-trip, the form still falls back to read-only rather than lose it.
- **Modifiers editor.** A control's design-time **Modifiers** property (the access level of its generated field —
  Public / Private / Protected / Internal / …) is now editable from the property grid, applied as a **byte-local edit**
  of the field declaration that never touches `InitializeComponent`, so it is safe on **every** form. **GenerateMember**
  is shown read-only (toggling a field to a local is a structural change that isn't round-trip-safe).
- **Capability preflight + reason.** The save-safety preview now reports a **category** explaining why a form is or
  isn't safe to whole-file regenerate — `safe`, `localizable`, `binaryResx`, `unresolvedType`, `lostStatements` or
  `unrepresentable` — so a regenerate-based operation can gate honestly instead of guessing.

### Changed
- **Honest `--roundtrip` diagnostic.** The engine's round-trip check used to report the render-only "RoundTripSafe"
  signal as PASS, which could look save-safe when it wasn't. It now also runs the authoritative safe-save gate and
  agrees with `--save`, so `renders` and `saves` are never conflated.
- **Round-trip fidelity re-verified end to end.** Event wirings, component-reference assignments and `BeginInit`
  brackets were re-checked against a **16-form golden corpus**: every form is either fully save-safe or **fail-closed
  with a named reason** — never silently divergent. (This closes a long-standing documentation discrepancy: the
  previous "sturdier round-trip saving" claim was accurate; the designer refused rather than dropped, and now
  round-trips the `ISupportInitialize` case outright.)

### Notes
- Some forms remain **honestly read-only** for whole-file regenerate and continue to edit safely via targeted edits:
  binary/`ImageStream` resources, `[Localizable(true)]` forms, unresolved vendor/custom controls, and a few
  canonicalization cases (`TabPages.AddRange`, `TreeView` node locals) that render and edit fine but aren't
  whole-file-round-trippable yet. The **Modifiers** editor is surfaced on the .NET-9 preview; its edit path is
  engine-agnostic and ready to extend to the .NET Framework preview.

## [0.11.0] — 2026-07-13

**Resource write-safety + the ImageList images editor.** Building on the 0.10.0 trust floor, this release makes the
`.resx` write path **atomic, undoable and conflict-checked**, and adds the first **image-list editor** — you can now
add and remove an ImageList's images directly, with the binary `ImageStream` serialized faithfully (the way Visual
Studio does it) through the .NET Framework engine. Unhandled collections are now shown honestly, and undo on the
compiled (.NET Framework) preview no longer lingers.

### Added
- **ImageList images editor.** Select an ImageList and run **"WinForms: Edit ImageList Images…"** (Command Palette /
  editor context menu) to add or remove its images. The images are serialized into the sibling `.resx` as a
  Visual-Studio-format `ImageListStreamer` (binary) resource via the .NET Framework engine — the one operation the
  .NET-9 preview can't do itself — and the `.Designer.cs` is rewritten to the canonical `ImageStream` +
  `Images.SetKeyName(...)` form. **Fail-closed:** if the current images can't be read back safely, the edit is refused
  rather than risk dropping them; the payload is validated as a genuine image-list stream before it's written.
- **`(Collection)` property routing.** A collection property the designer doesn't have a dedicated editor for
  (e.g. a `ListView`'s `Items` / `Groups` / `DataBindings`) is now shown as a clean **read-only `(Collection)`** entry —
  visible, like Visual Studio, instead of a raw type name or nothing — with no editable surface that couldn't round-trip.

### Changed
- **Atomic, undoable, conflict-checked `.resx` writes.** Embedding an image now writes the `.resx` **atomically**
  (staged temp file + rename, so a crash can't leave it half-written) and ties the write into the **same undo step** as
  the code edit — pressing Ctrl+Z reverts both the code and the resource (deleting a resource the import created, or
  restoring its prior bytes), conflict-guarded so a concurrent external change to the `.resx` is never clobbered. A
  symlinked `.resx` is written through rather than replaced.
- **Undo on the compiled (.NET Framework) preview no longer lingers.** Previously, undoing an edit on a compiled-preview
  form could keep showing the undone change (the live instance was reused); the preview now re-renders from the compiled
  baseline so undo/redo/revert are reflected.

### Fixed
- A re-import of a new image into a property that already referenced a resource is now undoable (previously it changed
  the resource on disk with no undo step).

## [0.10.0] — 2026-07-13

**The trust floor — the most important release.** The designer now **fails closed**: when a form uses something the
.NET-9 preview can't faithfully reproduce, it says so **honestly** and **refuses to silently corrupt or mis-render**
your file, rather than quietly saving a divergent or incomplete result. Five safety pillars, each surfaced with a
non-dismissible banner or a read-only lock. No feature you had is taken away — the designer just stops guessing when it
shouldn't.

### Added
- **"Localizable form — read-only preview" banner + lock.** A `[Localizable(true)]` form keeps its real values in the
  sibling `.resx`; the .NET-9 preview can't reproduce them, and an edit would splice a value Visual Studio drops on its
  next save. The designer now marks such a form **read-only** and shows why, instead of persisting a silent divergence.
- **"Preview may be incomplete — inherits from X" banner.** A form whose base class is an inherited or vendor type
  (a visual-inheritance `BaseForm`, DevExpress `XtraForm`, …) used to render as a plain empty `Form` on the .NET-9
  preview, silently dropping the base's controls. It now renders best-effort **and tells you** the base couldn't be
  resolved, so controls may be missing. (The .NET Framework preview instantiates the real base and shows no banner.)
- **"Binary / ImageStream resources not shown" banner.** A form whose `.resx` holds BinaryFormatter/SOAP/`ImageList`
  ImageStream resources (which the .NET-9 runtime can't deserialize) now reports how many resources the preview can't
  render — they are **preserved on disk**, and the designer won't regenerate the `.resx`.
- **"Read-only — last render failed" lock.** When a form fails to load or render, its stale preview is no longer
  silently editable — the designer refuses mutations until the form renders successfully again, so you can't edit a
  graph that didn't load. Undo / revert / fixing the source re-enables editing.

### Changed
- **Byte-local save firewall.** Every persisted edit is verified to be a **confined splice** of the file — the designer
  refuses any operation that would rewrite, reflow, re-indent, EOL-normalize, or regenerate the whole `.Designer.cs`
  beyond the intended change. Layered under the existing statement-level gate, a save can only change the bytes you
  edited.
- **No unsafe `.resx` regeneration.** The image-import write path verifies, at the moment of writing, that no binary
  resource would be dropped, and refuses the write (leaving the `.resx` untouched) if the file changed underneath it.
- **Honest refusals.** A refused edit no longer shows a "success" status or a diverging live preview; refusals are
  surfaced consistently across every read-only condition.

The new banners and statuses are translated across all seven locales.

## [0.9.0] — 2026-07-11

**Menu & toolbar editing goes all the way down.** The on-canvas item editing introduced in 0.8.x now reaches **nested
submenu items**, an **off-tree `ContextMenuStrip`**, and **overflow** items; each gets its **own property grid** (with an
**Events** tab); and reference- and image-typed properties become **Visual Studio–style dropdowns**. A pre-commit,
fail-closed hardening pass over the whole stack rounds out the release.

### Added
- **Deep on-canvas item editing.** The 0.8.1 limitation is lifted — **nested / submenu** items, an **off-tree
  `ContextMenuStrip`** (edited from its component-tray chip), and **overflow** items can now be **selected**, **renamed**
  (double-click / **F2**), **deleted** (**Delete**), and grown via a **"Type Here"** slot, at any depth, through
  synthetic flyouts that mirror Visual Studio. Works on **both** engines; the underlying source splices are unchanged and
  depth-agnostic, so nothing outside the edited items is touched.
- **Item → Properties, everywhere — with an Events tab.** Selecting any item — top-level, nested, context-menu,
  overflow, or an off-tree menu — loads **its own** property grid (kept separate from the control selection), and an
  **Events** tab **wires / unwires / navigates** that item's events. Right-click **Reset** works per item.
- **Component-reference property dropdowns.** A property whose type is a component reference — `Form.AcceptButton` /
  `CancelButton`, `Control.ContextMenuStrip`, `NotifyIcon.ContextMenuStrip`, `ErrorProvider.ContainerControl`, … — now
  renders as a **dropdown** of the compatible sibling components plus **(none)**, matching Visual Studio; a property that
  references the form itself offers **(this)**. Editable on **both** engines — the reference is written back as a minimal
  `this.<name>` / `this` / `null` splice.
- **`ImageIndex` / `ImageKey` dropdowns.** A control with an attached `ImageList` now picks its image from a **dropdown**
  of the list's indices / keys, matching Visual Studio. Fully on the .NET Framework compiled preview; the .NET 9 engine
  keeps the plain field when it can't populate the list (empty `ImageList`), with no regression.

### Fixed
- **Pre-commit fail-closed hardening (5 fixes).** Two independent review passes — a second-opinion model and an
  adversarial workflow — over the whole uncommitted stack, closing everything reachable before release:
  - the .NET Framework engine no longer offers an **inherited base-class private field** as a reference candidate (it
    would have saved a non-compiling `this.<baseField>` and diverged from .NET 9);
  - a concurrent-edit **TOCTOU** in the reference-edit round-trip that could commit a dangling `this.<field>` is closed by
    snapshotting the document revision before the describe round-trip;
  - the item editor now **rejects, engine-side**, a nested add under a non-dropdown item (a direct-RPC hole that emitted
    non-compiling `.DropDownItems.AddRange(...)`), so offer ⇔ accept holds on the engine, not just in the UI;
  - a **stale submenu selection** after navigating through an id-less (anonymous) parent could target the wrong item on
    **Delete** / **F2**; the selection is now dropped only when its level is actually truncated;
  - new end-to-end legs no longer **silently pass** when a sample fixture is missing (false-green guard).

## [0.8.1] — 2026-07-09

**Edit `MenuStrip` / `ToolStrip` items directly on the canvas** — add (with a Visual Studio–style **"Type Here"**
slot + a type picker), rename (double-click / **F2**), select and delete — and open a **Properties grid for a single
item** (editable on both engines). The **component tray** now matches Visual Studio by no longer listing strip items.
Plus three fixes: file nesting, third-party "Learn More" links, and DevExpress `XtraTabControl` tab-adding.

### Added
- **On-canvas item editing.** Click the trailing **"Type Here"** slot to add an item via an inline editor with a type
  picker; **double-click** or **F2** to rename a top-level item; single-click to **select** an item and **Delete** it
  (or use the item's Rename / Delete context menu). Builds on 0.8.0's on-canvas item geometry; works on **both** engines.
- **Item → Properties.** Selecting a strip item now loads **its own** property grid, kept separate from the control
  selection. Editable on **.NET 9**; on the **.NET Framework** compiled preview an item both **describes** and
  **live-edits** — the picture updates immediately, without a rebuild. A non-`Control` non-item component (e.g. a
  `Timer`) is described but never live-mutated, so a design surface never runs a component's runtime behavior.

### Changed
- **The component tray no longer lists `ToolStripItem`s** on either engine — Visual Studio never trays strip items;
  they are edited on the strip itself. Off-tree `ContextMenuStrip`s and non-visual components (`Timer`, `ToolTip`, …)
  still appear in the tray. _Known limitation:_ the full property grid of **nested / context-menu / overflow** items
  awaits on-canvas editing of those items.

### Fixed
- **File nesting no longer swallows unrelated partial-class files.** A sibling like `TestControl.Utils.cs` is no longer
  nested under `TestControl.cs`; the designer nests only `.Designer.cs` and `.resx`, matching Visual Studio.
- **"Learn More Online" works for third-party controls.** For a non-Microsoft type (e.g. DevExpress) it now opens a web
  search instead of a `learn.microsoft.com/dotnet/api` page that 404s.
- **DevExpress `XtraTabControl` "Add Tab" / "Delete Tab" now appear and work.** Tab-host detection previously broke on
  DevExpress's `new`-shadowed properties (reflection threw `AmbiguousMatchException`), so the tab menu never showed for
  an `XtraTabControl`; detection now scans the property list instead, with no change for a standard `TabControl`.

---

_Internal:_ a dedicated `selectItem` → `loadItemProps` → `itemProps` channel keeps item Properties off the control
selection; net48 resolves a `ToolStripItem` id via a `FieldNames` reverse-scan (describe + a `Control||ToolStripItem`-
gated live-edit); both `BuildTray`s skip `ToolStripItem`; a shared `FindTabProp` scan replaces the throwing
`GetProperty` at every tab-host reflection site on both engines; the "Learn More" URL builder is extracted + unit-tested.

## [0.8.0] — 2026-07-08

Draws **`MenuStrip` / `ToolStrip` item geometry on the canvas** — each top-level item plus a trailing
Visual Studio–style **"Type Here"** slot are now shown in place (the groundwork for editing items directly
on the canvas) — and fixes a **`ContextMenuStrip`** that used to appear as an invisible rectangle stealing
clicks over the menu bar: an off-tree menu strip now surfaces in the **component tray** on both engines,
matching Visual Studio.

### Added
- **On-canvas menu / toolbar item geometry.** The designer now knows each top-level `MenuStrip` /
  `ToolStrip` / `StatusStrip` item's on-surface rectangle and draws a trailing **"Type Here"** slot after
  the last item (VS-style), on **both** engines. This is the visual groundwork for editing items directly
  on the canvas; the `…` item editor remains the way to add / rename / remove items in this release.

### Fixed
- **`ContextMenuStrip` no longer paints a phantom rectangle over the menu bar.** A context-menu strip is a
  non-visual component (assigned to a control's `ContextMenuStrip`, never placed on the form), but the
  .NET 9 engine used to emit it as an invisible control rectangle in the top-left corner that **stole
  clicks** from the menu bar beneath it. It now appears where Visual Studio puts it — as a selectable chip
  in the **component tray** — on **both** engines, and the menu bar is clickable again. Editing a tray
  component's collection (e.g. a `ContextMenuStrip`'s `Items`) also no longer snaps the selection back to
  the form.

---

_Internal:_ both engines emit per-`ToolStripItem` bounds + an `IsStripHost` flag through the render→canvas
layout path; off-tree controls are partitioned into the tray (never the visual layout) under a shared
invariant; new `ContextMenuForm` sample + a `Net48CtxFixture` project; extended coverage — a
selection-retention regression and a cross-runtime net48 partition leg that compiles the sample and asserts
both engines agree.

## [0.7.1] — 2026-07-07

Adds a **Hindi (हिन्दी)** UI localization — the localized designer UI now spans **seven** languages.

### Added
- **Hindi (हिन्दी) UI localization.** The designer surface, property grid, toolbox, dialogs and status /
  notification messages can now be shown in Hindi via `winformsDesigner.language: "hi"` — bringing the
  localized UI to **seven** languages (English, Русский, 简体中文, Français, Deutsch, Español, हिन्दी).

## [0.7.0] — 2026-07-07

This preview completes **structural editing of `MenuStrip` / `ToolStrip` items**. The "Type Here"
item editor introduced in 0.6.0 (reorder + add) now also **removes** and **renames** existing items
and lets a new item **pick its type** — Visual Studio–style CRUD on a menu / toolbar item tree, on
both engines, with every untouched item preserved byte-for-byte.

### Added

#### Menu & toolbar editing
- **Remove items.** The `…` editor's ✕ now deletes an **existing** item, not just an unsaved one.
  Removing a submenu parent takes its **whole subtree** with it: the item's field declaration,
  construction, property block, event wiring and `Items` / `DropDownItems.AddRange` membership are
  all stripped, and a parent `AddRange` that loses its last element is deleted outright rather than
  left empty. Every surviving item stays byte-identical.
- **Rename items.** An existing item's caption is now editable inline — the engine rewrites its
  `Text = "…"` string literal **in place**, leaving every other property (`Image`, `ShortcutKeys`,
  `Checked`, …) untouched. Clearing the field leaves the source `Text` unchanged, so a rename can
  never silently wipe a caption.
- **Item-type picker.** A new item now chooses its type from a **context-appropriate** list keyed to
  the owner strip — menu item / combo / text box for a `MenuStrip`; button / label / separator /
  split & dropdown button for a `ToolStrip`; status label / progress bar for a `StatusStrip`.
  Choosing **Separator** drops the caption; existing items keep their concrete type.

### Safety
- The safe-save gate (`OnlyItemsChanged`, ex-`OnlyItemsAddedOrReordered`) proves a
  remove / rename / reorder / add edit touched **only** the item tree: exactly the removed fields
  were dropped and the added fields minted (the class-member count moves by that net, so no method or
  property is smuggled in or silently deleted), and no removed field name lingers anywhere — a
  dangling reference the syntax-only parse check would miss. Edits that would **reparent** an item,
  drop a hand-written comment inside a shrunk `AddRange`, remove an item still referenced by non-item
  code (e.g. `MdiWindowListItem`), or delete a field declaration sharing a physical line with a
  neighbour are **refused**, never silently applied.

---

_Internal:_ engine `SetItems` extended to REMOVE (whole-subtree, whitespace-safe whole-line splices)
and RENAME (in-place literal rewrite) behind a reparent guard; the gate renamed and hardened for
removed-id / rename canonical-form / comment fail-safes; extended end-to-end and live-webview
coverage including the adversarial refusal cases.

## [0.6.0] — 2026-07-07

This preview deepens the **collection & value editors** toward Visual Studio parity. The
`TreeView.Nodes` editor now round-trips a node's **images, check state, tooltip and visual style**;
menus and toolbars gain a **"Type Here" item editor** (reorder + add) on both engines; and the
property grid picks up a **Cursor** picker and a generic **`string[]` (`Lines`) editor**.

### Added

#### TreeView node editor
- **Node images.** A tree node's `ImageKey` / `ImageIndex` and `SelectedImageKey` /
  `SelectedImageIndex` now round-trip through the `TreeView.Nodes` editor. The key and index of a
  pair are mutually exclusive (last-write-wins, matching WinForms), so setting one clears the other.
  On the **.NET Framework** engine the node's glyph is drawn live from the form's `ImageList`.
- **Check state & tooltip.** A node's `Checked` flag and `ToolTipText` are now editable and persist
  to the `.Designer.cs`.
- **Node visual style.** A node's `ForeColor`, `BackColor` and `NodeFont` round-trip as
  property-grid–style values. A font that can't be reproduced safely (an uninstalled family that GDI+
  would substitute, a non-`Default` GDI charset, or a vertical font) stays **read-only** rather than
  being silently changed.

#### Menu & toolbar editing
- **ToolStrip / MenuStrip "Type Here" item editor.** The `…` on a `MenuStrip` / `ToolStrip` /
  `StatusStrip`'s `Items` now opens a structural editor to **reorder** items within a sibling group
  and **add** a new item — either at the top level or into a menu item's drop-down — Visual
  Studio–style. Every other item property (`Image`, `ShortcutKeys`, event wirings, …) is preserved:
  only the affected `Items.AddRange` order / membership is rewritten. Works on **both** engines (the
  .NET Framework compiled preview reflects the change on its next render).

#### Property grid
- **Cursor editor.** The `Cursor` property is now a standard-value dropdown (Default / Hand / …); the
  picked cursor round-trips as `Cursors.<Name>` via `InstanceDescriptor`. A custom / `.cur` cursor
  with no matching `Cursors.*` member stays read-only instead of being clobbered.

#### Collection editors
- **`string[]` collection editor.** String-array properties such as `TextBox.Lines` now open the same
  string-collection editor as `Items`. When `Lines` is backed by the control's `Text` in the source
  (the pattern the VS designer emits), the edit rewrites the **effective** assignment so the two stay
  in sync and no content is lost; a value that can't be represented safely (e.g. RTF-backed or
  `.resx`-backed text) stays read-only.

---

_Internal:_ new sample fixtures (`LinesForm`, `MenuForm`, `TreeImageForm`, `TreeStyleForm`), extended
engine, end-to-end and live-webview coverage for every new editor, and adversarial review passes over
the round-trip / data-loss gates.

## [0.5.0] — 2026-07-05

This preview brings **Visual Studio Collection Editors** to both engines — the `…` button now
opens a real editor for `Items`, `ListView.Columns`, `DataGridView.Columns` and (hierarchical)
`TreeView.Nodes`, including on compiled **.NET Framework / DevExpress** forms — plus a round of
**canvas & property-grid polish** (keyboard nudge, Duplicate, Reset, bold non-default properties,
a description pane), **Lock Controls**, smarter **cross-runtime routing**, and sturdier
**round-trip saving** and **load-failure** handling.

### Added

#### Collection editors
- **Visual Studio Collection Editors (`…`).** Collection properties now open a real editor instead
  of being read-only: **String collections** (`ComboBox` / `ListBox` / `CheckedListBox.Items`),
  **`ListView.Columns`**, **`DataGridView.Columns`**, and a recursive **`TreeView.Nodes`** tree
  editor. Edits reconcile the collection in place — concrete column / node types, canonical names,
  and `ISupportInitialize` blocks are preserved — and persist as `.Designer.cs` text.
- **Collection editors on compiled net48 / DevExpress forms.** All of the above also work on the
  .NET Framework engine: the editor reads and writes through the .NET 9 pure-text path (no vendor
  assembly is loaded just to edit a collection), and the compiled preview's collection or node tree
  is **rebuilt live** on the running instance, so the canvas updates immediately instead of waiting
  for a rebuild.

#### Designer surface
- **Keyboard nudge.** Move the selection one pixel with the arrow keys (resize with `Shift`),
  matching Visual Studio.
- **Duplicate (`Ctrl+D`).** Clone the selection in place with a cascade offset, without touching the
  clipboard.
- **Lock Controls.** A form-wide *Lock Controls* toggle (VS-style) freezes move / resize / nudge /
  align and shows a 🔒 glyph with no resize handles. _(Session-only for now — not yet persisted to
  the `.resx`.)_
- **Center horizontally / vertically in form** for the current selection, plus **resize snaplines**
  and a **hover-hint** outline as the pointer moves over controls.

#### Property grid
- **Right-click *Reset*.** Reset a property to its default from the grid's context menu, on **both**
  engines; a non-resettable property surfaces a partial-preview note instead of going stale.
- **Bold non-default properties** and a **description pane** at the bottom of the grid (the selected
  property's name and summary), matching Visual Studio.

### Changed
- **Cross-runtime routing.** A **multi-target** form whose vendor controls the .NET 9 engine can't
  load now offers a **one-click switch to the .NET Framework compiled preview**; the choice is
  remembered as the form's control source and survives a reload.
- **Sturdier round-trip saving.** Whole-file save now preserves constructs the serializer used to
  drop: `BeginInit` / `EndInit` blocks keep a form in the safe-save gate (the save is refused rather
  than silently stripping them), `+=` event wirings are captured verbatim and re-emitted, and
  component-reference assignments (`this.AcceptButton = this.okButton`) resolve on load.

### Fixed
- **Load-failure & partial-render feedback.** When a form only partially renders (unresolved
  controls) or fails to load, the canvas now shows a categorized banner — a *partial render* warning
  vs. an error with the last-known-good picture — instead of a misleading blank surface, with a
  non-nagging dismiss.
- **"Project Controls" toolbox no longer silently empties on .NET-Core `WinExe` projects.** The
  project resolver now prefers the managed `.dll` over the apphost `.exe`, so the dependency resolver
  no longer trips on the native launcher and the project's own controls appear in the toolbox.

---

_Internal:_ a headless **live-webview test harness** (jsdom loads the real `designer.js` /
`panel.js`) now guards the webview interaction loop in CI, alongside the existing engine and
end-to-end suites.

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
  / align**, **add / remove**, and **z-order** apply **live** against the instantiated
  instance on a **best-effort basis** (a rebuild is authoritative); the change is persisted
  as `.Designer.cs` text (via the .NET 9 splice) and re-renders on the next build. A
  **compiled-preview badge** (🔒 *preview*) appears in the status bar. *Cut / paste and dropping project-specific (non-framework) controls are not
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

[Unreleased]: https://github.com/SkivHisink/winforms-designer-vscode/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/SkivHisink/winforms-designer-vscode/compare/v1.15.0...v2.0.0
[1.15.0]: https://github.com/SkivHisink/winforms-designer-vscode/compare/v1.14.0...v1.15.0
[1.14.0]: https://github.com/SkivHisink/winforms-designer-vscode/compare/v1.13.0...v1.14.0
[1.13.0]: https://github.com/SkivHisink/winforms-designer-vscode/compare/v1.12.0...v1.13.0
[1.12.0]: https://github.com/SkivHisink/winforms-designer-vscode/compare/v1.11.0...v1.12.0
[1.11.0]: https://github.com/SkivHisink/winforms-designer-vscode/compare/v1.10.0...v1.11.0
[1.10.0]: https://github.com/SkivHisink/winforms-designer-vscode/compare/v1.9.0...v1.10.0
[1.9.0]: https://github.com/SkivHisink/winforms-designer-vscode/compare/v1.8.0...v1.9.0
[1.8.0]: https://github.com/SkivHisink/winforms-designer-vscode/compare/v1.7.0...v1.8.0
[1.7.0]: https://github.com/SkivHisink/winforms-designer-vscode/compare/v1.6.0...v1.7.0
[1.6.0]: https://github.com/SkivHisink/winforms-designer-vscode/compare/v1.5.0...v1.6.0
[1.5.0]: https://github.com/SkivHisink/winforms-designer-vscode/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/SkivHisink/winforms-designer-vscode/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/SkivHisink/winforms-designer-vscode/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/SkivHisink/winforms-designer-vscode/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/SkivHisink/winforms-designer-vscode/compare/v1.0.2...v1.1.0
[1.0.2]: https://github.com/SkivHisink/winforms-designer-vscode/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/SkivHisink/winforms-designer-vscode/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/SkivHisink/winforms-designer-vscode/compare/v0.12.0...v1.0.0
[0.12.0]: https://github.com/SkivHisink/winforms-designer-vscode/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/SkivHisink/winforms-designer-vscode/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/SkivHisink/winforms-designer-vscode/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/SkivHisink/winforms-designer-vscode/compare/v0.8.1...v0.9.0
[0.8.1]: https://github.com/SkivHisink/winforms-designer-vscode/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/SkivHisink/winforms-designer-vscode/compare/v0.7.1...v0.8.0
[0.7.1]: https://github.com/SkivHisink/winforms-designer-vscode/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/SkivHisink/winforms-designer-vscode/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/SkivHisink/winforms-designer-vscode/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/SkivHisink/winforms-designer-vscode/compare/v0.4.1...v0.5.0
[0.4.0]: https://github.com/SkivHisink/winforms-designer-vscode/compare/v0.3.2...v0.4.0
[0.3.2]: https://github.com/SkivHisink/winforms-designer-vscode/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/SkivHisink/winforms-designer-vscode/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/SkivHisink/winforms-designer-vscode/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/SkivHisink/winforms-designer-vscode/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/SkivHisink/winforms-designer-vscode/releases/tag/v0.1.0
