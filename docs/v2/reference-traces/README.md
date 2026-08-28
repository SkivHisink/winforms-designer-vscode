# Visual Studio reference traces

This directory contains immutable, scenario-scoped evidence captured from the actual Visual Studio WinForms Designer.
It is not a generated approximation and it is not a repository-side product screenshot.

The release candidate retains only the 40 reviewed scenario directories cited by the catalog. Each link below targets
the authoritative scenario `manifest.json` directly; parent run directories and their aggregate manifests are capture
scratch space and are deliberately excluded by [`.gitignore`](.gitignore).

| Scenarios | Archived scenario manifests |
|---|---|
| S001 | [manifest](VS18.7.11911.148-20260821T123101Z/V2-FND-001-S001/manifest.json) |
| S005 | [manifest](VS18.7.11911.148-20260823T030759Z/V2-FND-001-S005/manifest.json) |
| S006 | [manifest](VS18.7.11911.148-20260823T034954Z/V2-FND-001-S006/manifest.json) |
| S009 | [manifest](VS18.7.11911.148-20260821T140047Z/V2-FND-001-S009/manifest.json) |
| S011 | [manifest](VS18.7.11911.148-20260821T124034Z/V2-FND-001-S011/manifest.json) |
| S012 | [manifest](VS18.7.11911.148-20260821T132217Z/V2-FND-001-S012/manifest.json) |
| S013, S014 | [S013](VS18.0-20260821T082946Z/V2-FND-001-S013/manifest.json), [S014](VS18.0-20260821T082946Z/V2-FND-001-S014/manifest.json) |
| S015 | [manifest](VS18.7.11911.148-20260823T003946Z/V2-FND-001-S015/manifest.json) |
| S017 | [manifest](VS18.7.11911.148-20260824T072607Z/V2-FND-001-S017/manifest.json) |
| S021 | [manifest](VS18.7.11911.148-20260822T160305Z/V2-FND-001-S021/manifest.json) |
| S022 | [manifest](VS18.7.11911.148-20260821T150518Z/V2-FND-001-S022/manifest.json) |
| S024 | [manifest](VS18.7.11911.148-20260823T020455Z/V2-FND-001-S024/manifest.json) |
| S025 | [manifest](VS18.7.11911.148-20260823T044854Z/V2-FND-001-S025/manifest.json) |
| S026 | [manifest](VS18.7.11911.148-20260824T062506Z/V2-FND-001-S026/manifest.json) |
| S029 | [manifest](VS18.7.11911.148-20260821T160747Z/V2-FND-001-S029/manifest.json) |
| S030 | [manifest](VS18.7.11911.148-20260821T163055Z/V2-FND-001-S030/manifest.json) |
| S031 | [manifest](VS18.7.11911.148-20260822T181918Z/V2-FND-001-S031/manifest.json) |
| S037 | [manifest](VS18.7.11911.148-20260822T162725Z/V2-FND-001-S037/manifest.json) |
| S038 | [manifest](VS18.7.11911.148-20260822T192402Z/V2-FND-001-S038/manifest.json) |
| S039, S049 | [S039](VS18.7.11911.148-20260822T204633Z/V2-FND-001-S039/manifest.json), [S049](VS18.7.11911.148-20260822T204633Z/V2-FND-001-S049/manifest.json) |
| S041 | [manifest](VS18.7.11911.148-20260822T185223Z/V2-FND-001-S041/manifest.json) |
| S042 | [manifest](VS18.7.11911.148-20260822T214634Z/V2-FND-001-S042/manifest.json) |
| S045 | [manifest](VS18.7.11911.148-20260824T101950Z/V2-FND-001-S045/manifest.json) |
| S046 | [manifest](VS18.7.11911.148-20260824T094716Z/V2-FND-001-S046/manifest.json) |
| S050 | [manifest](VS18.7.11911.148-20260822T234847Z/V2-FND-001-S050/manifest.json) |
| S051 | [manifest](VS18.7.11911.148-20260824T122309Z/V2-FND-001-S051/manifest.json) |
| S053 | [manifest](VS18.7.11911.148-20260822T223724Z/V2-FND-001-S053/manifest.json) |
| S061 | [manifest](VS18.7.11911.148-20260824T085431Z/V2-FND-001-S061/manifest.json) |
| S062 | [manifest](VS18.7.11911.148-20260824T091246Z/V2-FND-001-S062/manifest.json) |
| S079 | [manifest](VS18.7.11911.148-20260824T131153Z/V2-FND-001-S079/manifest.json) |
| S085 | [manifest](VS18.7.11911.148-20260824T134348Z/V2-FND-001-S085/manifest.json) |
| S086 | [manifest](VS18.7.11911.148-20260824T140405Z/V2-FND-001-S086/manifest.json) |
| S087 | [manifest](VS18.7.11911.148-20260824T142933Z/V2-FND-001-S087/manifest.json) |
| S088 | [manifest](VS18.7.11911.148-20260824T150121Z/V2-FND-001-S088/manifest.json) |
| S100, S108 | [S100](VS18.7.11911.148-20260822T143728Z/V2-FND-001-S100/manifest.json), [S108](VS18.7.11911.148-20260822T143728Z/V2-FND-001-S108/manifest.json) |
| S110 | [manifest](VS18.7.11911.148-20260824T080449Z/V2-FND-001-S110/manifest.json) |
| S120 | [manifest](VS18.7.11911.148-20260821T173527Z/V2-FND-001-S120/manifest.json) |

These manifests identify Visual Studio Enterprise 2026, DTE 18.0, installation 18.7.11911.148 (the S013/S014
baseline records its earlier exact installation identity). Each scenario directory contains its exact source inputs and
the scenario-specific screenshots named by its manifest; S120 also contains the
product CustomEditor extension leg, while S001 records exact before/after hashes for source, Designer, neutral resx,
and project files. S012 records exact source/Designer/project preservation and the neutral resx Visual Studio creates
on Save All; the product's bounded read-only open is proved separately by the Extension Host suite. S009 records the
actual Visual Studio fail-closed page for a Form nested inside another type, byte-identical source/Designer inputs, and
the matching product pre-render refusal. S022 records a real designer selection and east-handle drag: the Button grows
from 120×30 to 160×30 while `Anchor` and `Location` remain exact. Its manifest preserves before/after hashes, accessible
bounds, the exact input window and drag delta, and the gzip-compressed byte-exact Designer output (including Visual
Studio's four separator-comment trivia normalizations).
S015 places `topLabel` and `bottomLabel` at identical accessible bounds `(782,195,158,46)` with the first
`Controls.Add` sibling at WinForms z-order index 0. A click at the shared center `(861,218)` travels through the actual
designer `InputShield`; native Properties then exposes `Text=Top z-order`, proving the frontmost selection rather than
inferring it from the screenshot. Source, Designer, and project SHA-256 remain respectively
`28e5e38f6e07d4a1716c2f4ce63b34d1d638204e438519c0ce7ea4327bedbf85`,
`13bf49f557caf3c0ea2a4361caebc32de3e07b30639746038d74450ed2a171aa`, and
`a6c6eeb100f8038132dd69dcc556b43f5fb54463794986e148a9317fe8bf748a`; screenshot SHA-256 is
`b63e7abb10791952eb565c6547dbfd3e6d06f12a383048297d3090859012eb49`. Repository unit/webview evidence independently
matches the same index-0-first hit-test; physical ARM64 remains external.
S017 opens a modern Form with four Panel children and two Form-level Buttons. Its marquee fully contains
`enclosedButtonA/B`, partially intersects `partialButton`, excludes the fourth Panel child and both Form-level controls,
and travels through the actual `InputShield` before and after the capture-owned cursor-relative window offset. Native
Copy is byte-exact and a reversible Paste creates exactly three new Panel children with Text counts
`Enclosed A=2`, `Enclosed B=2`, `Partial=2`; every excluded Text remains at one. The selection-outcome Designer SHA-256
stays `3211af8ddda929a3cf67436cf9b0611a9338b8c9a7f1cd7b6c2f6477da1711c7`. One Undo restores the exact original
semantic shape, while modern CodeDOM reorders component blocks and therefore produces the separately disclosed
post-probe SHA-256 `f85a6f850d61fcef17367473c8f5b3deda9bcc6e9b71f4bae9c2c1486a0f060b`; this normalization is not attributed to
the marquee. The selected-state screenshot SHA-256 is
`faf40dca57b896f540e99cfa5163b56f9bdb4b27d33a0955193160d34c663956`; scenario manifest SHA-256 is
`0f9f62b1a258945958c30a25bbafde2083b3c20785a72233ba252ebbe3429f35`. Product webview selection was corrected from
full-containment to the same positive-area intersection rule while retaining the active-container boundary.
S110 opens a modern Form with an accessible Button, TextBox, MenuStrip/File item, and Timer. The installed designer's
UI Automation tree exposes `Submit button` as `ControlType.Button`, `Customer name` as `ControlType.Edit`, the visual
`Main menu` as `ControlType.MenuBar`, its nested `fileMenuItem` as `ControlType.MenuItem`, and `refreshTimer` as a
`ControlType.Pane` beneath the native `ComponentTray`. All records are enabled, onscreen, have non-empty bounds and
raw-view ancestry through the real `DesignerFrame`; source, Designer, and project hashes remain exact. The screenshot
SHA-256 is `1106ea75fe2b0b663c873f307021c442cc0aaab555d38cebc455e5ec6db0715b`; scenario manifest SHA-256 is
`c33ff77c49e4f0ce6285aeb6c0c617e3976b98e1da44e82d6562831376593372`. This is an x64 reference trace, not physical
ARM64 or live assistive-technology acceptance.
S061 selects `button1` in the actual owner-drawn Document Outline, verifies the native Properties `(Name)` value, and
commits `submitButton` through that writable row. Visual Studio updates the field, eight member references, and the
`Name` literal once; `Button.Text = "button1"` and all six `textBox1` references remain semantically exact. One native
Undo restores the original semantic shape and Redo reproduces the renamed Designer bytes exactly; source and project
stay byte-identical. The screenshot SHA-256 is
`747a700f66e475482bc8905d37f264e84a166b053919e0e8aaa66cfde2a56f94`; scenario manifest SHA-256 is
`70a5a24be0c7f67000bf17afca24d28c5d8894c1f86885e058690042c420c930`. Physical and synthetic F2 probes did not expose
an inline editor, so native outline F2 is not claimed. The product matches the selected-control atomic rename; its F2
binding is an additive shortcut, and its minimal source patch intentionally avoids unrelated CodeDOM normalization.
S062 clicks the measured center of the actual `refreshTimer` Pane below `ComponentTray`. Native Properties then
identifies `refreshTimer System.Windows.Forms.Timer` and exposes `(Name)=refreshTimer`, `Enabled=False`, and
`Interval=1500`; source, Designer, and project remain byte-identical. The selected Properties screenshot SHA-256 is
`66ddb48b8e384abc3c93339ec4c9158c3ea5f9903560fa804ee0aa83d43e889b`; scenario manifest SHA-256 is
`8d6c0249849985a8b4ce6a444646f9c1641475965a7a92e2e587408e34504aeb`. This x64 reference proves the native
selection-to-Properties contract, not physical Windows ARM64 execution.
S046 opens a purpose-built modern Form whose Button has explicit `BackColor=Red` and
`UseVisualStyleBackColor=false`. The harness selects the actual designer Button, resolves the live alphabetical
`BackColor=Red` row, and clicks the real WinForms `Open` child. The canonical `Graphics.CopyFromScreen` capture freezes
the owner-drawn framework Color editor with visible `Custom / Web / System` tabs, Web palette, and selected `Red`;
two popup HWND captures are archived independently. `Esc` closes the editor, native Properties remains `Red`, and
source, Designer, and project hashes stay exact. The open-editor screenshot SHA-256 is
`b81819e5880ffed62ca88ba0cc571eae6970441bada2df52f164d4c1e35a48d6`; after-cancel screenshot SHA-256 is
`205f182332e9da858b75638b44414eba3823104292b17086f0cddf0cc2d0a405`; scenario manifest SHA-256 is
`37b1049f01951531cabaf108b16bb782d7b63a1c5391dbf2dd173673cab5ba24`. The product independently proves the same
typed `CANCELLED` no-mutation boundary. Physical Windows ARM64 remains external where catalogued.
S045 starts from the companion purpose-built Red fixture, selects `button1` through the native owner-drawn Document
Outline, opens the real Properties `BackColor` editor, and navigates the actual Web ColorEditor list to the exact named
`Blue` row. The canonical open-editor screenshot visibly freezes Blue selected; Enter commits `Color.Blue` while
Location `(48,54)`, Name, Size `160×42`, Text, and `UseVisualStyleBackColor=false` remain exact. One native Undo restores
Red and one native Redo reproduces the applied Designer bytes exactly; source and project bytes stay unchanged. The
open-editor screenshot SHA-256 is
`37cd4a0eda4d0491d758773fd457534a98f453a634cc492e320a1eb070348284`; the after-apply screenshot SHA-256 is
`71d40122284bd15f388870d58d52824df92a1049f39d7f7aaa7cb6098d015d2a`; scenario manifest SHA-256 is
`c7fe78566cada9e296ae045ef80de2e1d4a23b686acbe8c6607b9c786952a6c7`.
S024 executes native `Edit.Copy` and `Edit.Paste` independently in the modern and net48 Visual Studio designers.
Both preserve the occupied `submitButton`, generate the unique `button1`, copy `Text=Submit existing` and Size
`124×32`, serialize `TabIndex=1` with exactly one root owner, Undo to the exact one-Button shape, and Redo the first
Paste bytes exactly. Modern selection routes through the actual `InputShield`; net48 selects the deterministic second
row of the native `SysTreeView32` Document Outline. Both lanes place the clone at `(98,74)`. The product independently
matches collision-safe naming, copied properties, ownership, and one Undo/Redo transaction, but intentionally uses its
bounded 8px placement rather than claiming coordinate parity. Modern/net48 screenshot SHA-256 values are respectively
`7b7516fae8eca70375202887fcc943f1fa169594d7baa65003f64637be297da2` and
`2a2bb6cd215307594f8345c746fa93846bcf57b412b328a18032d38bc9894089`; physical ARM64 remains external.
S005 selects the exact modern SDK project through the real Solution Explorer hierarchy, resolves the installed
`Microsoft.CSharp.WindowsForm` template through `Solution2.GetProjectItemTemplate`, and invokes native
`ProjectItems.AddFromTemplate`. Visual Studio creates `S005GeneratedForm.cs`, nests
`S005GeneratedForm.Designer.cs` and `S005GeneratedForm.resx` beneath it, rebuilds the solution, and opens the new Form
in the actual WinForms Designer while the SDK `.csproj` remains byte-identical. The only auxiliary top-level delta is
the exact per-user `.csproj.user` subtype sidecar; its SHA-256 is
`9ea9b1599dbe8277bfe6cdd3452a0e35e4c70dd178399fdef33e9ee311a608b4`, every other unexpected delta is forbidden,
and the screenshot SHA-256 is `1b3217c12060c9e3b87e033b1fbf0a0d174be8eaa1191b838036bfa797b268b7`.
S006 selects the exact classic non-SDK net48 project, resolves
`Microsoft.CSharp.WindowsFormsUserControl` through `Solution2.GetProjectItemTemplate`, and invokes native
`ProjectItems.AddFromTemplate`. Visual Studio creates only `S006GeneratedUserControl.cs` and its nested
`S006GeneratedUserControl.Designer.cs`; the classic project gains exactly one `Compile` item with
`SubType=UserControl` and one Designer `Compile` item with `DependentUpon`. No neutral resx or `EmbeddedResource` is
created. The solution rebuilds and the new UserControl opens in the native designer. Source and Designer SHA-256 values
are `27fcbbc7cb76e158e5a4cf9e72fa793ef90d52912915f819454edd1c3582da65` and
`fc810825f7784f91eaeaf35c242ae33b8d715626df9ca740a436bc074d50e81f`; project before/after values are
`38771ffe6a2827ed5d9934f17dc486ef936767ddc3a6a6395b589c729282c18a` and
`c51eb92dc84eeaa09238c6dd75413b32794744dfac026252c972283ea6825add`; screenshot SHA-256 is
`a4c404b7935a7c5c92bc5dfad3656ea11187b087cdeddd28274b52b67f230be2`.
S025 uses a default 100×30 Button at source `(32,80)` and a default 120×23 TextBox at `(180,40)`. The installed
ButtonDesigner and TextBoxDesigner expose baseline offsets 21 and 16. A raw vertical pointer delta of `-44` requests
Button Y=36, where its center is only 0.5px from the TextBox center, but the actual Visual Studio designer gives the
compatible text baseline priority and persists Y=35. Button X/Size and the complete TextBox geometry remain exact;
source and SDK project hashes are byte-identical. Save All creates one standard empty neutral Form resx with no data
or metadata entries; it is archived with SHA-256
`d679c8de86ccb99ed1f69895706946ec8b2e9eed458dd6d7b8d5144cb3bb3cf5`. The exact before Designer hash is
`7d5f539c5b638406c829901364794e26f1f7a7bd245d630889c687e4ca006c29`, the persisted Designer hash is
`228071b8a04a4c7fa8cb1057c3830779bd90a696f8193e7e3f69b9b72ec9c698`, and the final selected-control screenshot
SHA-256 is `83b4c3af6d2373e718d995c8aaaefe2b155b54847ac5f7fe2ad182aeecdbdc04`. The active-drag capture is retained
separately because disconnected-desktop `PrintWindow` can omit transient adorner layers; the one-pixel persisted
correction is the hard reference gate. Product unit/webview evidence independently proves live Button/TextBox
baseline publication, baseline-over-center priority, the visible product guide, and the full-frame-to-source mapping.
S026 temporarily changes the installed designer options from exact `LayoutMode=0, ShowGrid=true, SnapToGrid=true` to
`LayoutMode=1, ShowGrid=true, SnapToGrid=true`, opens an AutoSize Label at off-grid source `(13,25)` with Size `57×15`,
and drives the actual designer input HWND by raw delta `(+20,0)`. On the disconnected capture desktop the bounded input
mode is explicitly recorded as `cursor-relative-capture-owned-window-offset`, not as an unobserved physical-mouse
claim. Visual Studio persists `(32,24)` on its effective 8×8 parent grid, preserves the Label size, the reference Button
`(190,96,110×30)`, source/project bytes, and a standard empty neutral resx, then restores all three original options in
`finally`. The final screenshot SHA-256 is
`fc06ae80cdb284bd748db80407272b2fbdbcfbc33770193b6463f2069580ba6b`; the scenario manifest SHA-256 is
`ca5e523da00224d3b2ce7406a194c89810fe992040a209bf09c8fb9dc86168be`. The product webview evidence independently
repeats the complete `(13,25) + (+20,0) → (32,24)` frame and preserves `57×15`, while also covering grid-aware resize.
S021 records `Edit.SelectAll` followed by a real drag through the actual WinForms Designer `InputShield` and its
internal capture HWND. Both Buttons move exactly `+17,+9`, from `(21,27)/(50,60)` to `(38,36)/(67,69)`; exactly one
Visual Studio Undo restores both and one Redo reapplies both. The manifest also freezes live accessible bounds,
source/project byte identity, disconnected-desktop input orchestration, exact before/after-redo Designer bytes, and the
selected-controls screenshot.
S037 selects the actual `referenceButton`, opens Visual Studio's categorized Properties window, and archives both the
1920×1080 screenshot and a bounded UI Automation inventory. Accessibility, Appearance, and Behavior categories are
visible; `Text=Button reference` is visually bold, default `Enabled=True` is not bold, and the description pane reports
`The text associated with the control.` Source, Designer, and project hashes remain byte-identical.
S029 records `Edit.SelectAll` followed by the actual designer's `Format.AlignLefts`: button1 remains at X=12,
button2 changes 42→12, button3 changes 77→12, every Y/Size survives, and the exact post-serialization bytes are
archived as gzip with a verified manifest hash.
S030 records `Edit.SelectAll` followed by the actual designer's `Format.MakeSameWidth`: the primary button1 remains
120×30, button2 changes 60×24→120×24, button3 changes 90×36→120×36, every Location and height survives, and the
exact post-serialization bytes are archived as gzip with a verified manifest hash.
S031 opens the real owner-drawn Document Outline, selects its deterministic nested `button1` row, returns focus to the
designer, and executes native `Format.CenterHorizontally`. The 241px Panel and 80px Button produce relative X `15→80`;
asymmetric `Padding(10,0,20,0)` does not shift the complete-client-area center. Accessible bounds move exactly `+65`,
the exact mixed-line-ending CodeDOM Location/trivia region is archived as gzip, source/project remain byte-identical,
and the selected centered Button screenshot SHA-256 is
`9753ec2f6043c4ec2e31f360887ce27573bf49f4f0f30583e6228ad4f54c0416`.
S041 selects a default Button, opens the actual Visual Studio `FlatStyle` dropdown, and captures the native
`ControlType.List` children in exact order: `Flat, Popup, Standard, System`. `List.Current.Name` and the visible
highlight identify `Standard`; source, Designer, and project hashes remain byte-identical, and the screenshot SHA-256
is `1b4ebea8a2ff6df92ffd93e88b91d053ede2417fb28b92b678c6194c11e799f6`.
S042 selects `button1`, expands the actual owner-drawn `Padding` row with the PropertyGrid `VK_RIGHT` contract, observes
`Left=3`, and commits `8` through the real child Edit `ValuePattern`. The archived Designer bytes contain exactly
`Padding(8,4,5,6)`: `Top`, `Right`, and `Bottom` are preserved, source/project stay byte-identical, and Visual Studio's
modern first-write removal of `this.` qualifiers plus separator-comment normalization is frozen byte-for-byte. The exact
Designer SHA-256 is `7c2d864e23abfe2ee338c693eafa67f07d12a3961930fde5061704dbe3c86962`; the screenshot SHA-256 is
`b8bf4d36d946161bc8a5afc2053686d702693b60de9c9af9b1679e16123c7983`.
S053 opens a supported `net10.0-windows` SDK-style Form, executes native `View.Toolbox`, and bounds the actual Toolbox
surface. The real WPF search host is recovered by a screen-point UIA probe as `Search Toolbox` / `PART_SearchBox`;
`ValuePattern.SetValue("Button")` produces the native live result `2 results found`. The Toolbox body is a legacy
`TBToolboxPane`, so the harness reads its actual MSAA tree and freezes the exact hierarchy
`Toolbox → All Windows Forms → Button`, plus the sibling `RadioButton`. The archived screenshot visibly agrees, source,
Designer, and project bytes remain exact, and screenshot SHA-256 is
`974c824913dddd92a0d51a3907b1c3a927bf8f0da82898d49bd630c466388e49`. Repository evidence separately proves
`System.Windows.Forms.Button` framework provenance and `Common Controls` categorization; this reference trace claims
only the observed Visual Studio `All Windows Forms` search result.
S038 selects `button1` and `textBox1` together. The UI Automation inventory records one shared `Text` TreeItem with an
empty mixed value, the common `AllowDrop/Enabled/Visible/Anchor/Location/Size` intersection, and no Button-only
`DialogResult` or TextBox-only `Multiline/AcceptsReturn/UseSystemPasswordChar`; the screenshot shows selection handles
on both controls. Source, Designer, and project bytes remain exact, and the screenshot SHA-256 is
`cd07cc383397b76c211f47f49179753d9d43f8196f4c89a5c1deedf875b9c872`.
S039 opens the in-process net48 designer. Its rendered Button exposes `Name=Custom reset text`, but the child absorbs a
synthetic click, so the harness selects the visible second `button1 | Button` row in the legacy Document Outline and
requires the Property Grid to report `Text=Custom reset text` before mutation. It then invokes the exact enabled
`OtherContextMenus.PropertyBrowser.Reset` command. The native context popup is not exposed through UI Automation in
the disconnected capture session, so the same registered command handler is invoked through DTE and recorded as such.
The visible value becomes empty; the exact Designer patch removes only `this.button1.Text`, preserves `this.` qualifiers
and sibling semantics, canonicalizes four separator comments, inserts one pre-close blank line, and rewrites only the
generated serialization region to CRLF. Source/project hashes remain byte-identical, the exact Designer SHA-256 is
`f2cfc31bb56c15f55dab14b452b4aa7bddba2a6f33ec23d89f7e0156e5f457e7`, and the post-reset screenshot SHA-256 is
`51043f6de51a835d5e3cecb75313ef9f81d516eb72730368c0699fc12b70e1b4`.
S049 sends a double-click through the actual designer input HWND to the UI-Automation-located `button1`. Visual Studio
adds exactly one `button1.Click += button1_Click` subscription and one signature-correct handler, navigates the DTE
cursor into the method, and preserves the project bytes. The selected-Button designer capture, exact before/after
source artifacts, hashes, cursor coordinates, and explicit **No** choice for the unrelated mixed-line-ending
normalization prompt are archived in the manifest. The refreshed autonomous watcher records `observed=true`,
`clickPosted=true`, and `dismissed=true` only after the exact dialog HWND disappears; its screenshot SHA-256 is
`c5ca845d44ff4c369d792f174793cf2b85f84f7595a3bd3055d2dedaa32be9b4`. The product's matching composite Undo/Redo
transaction is proved separately by the Extension Host suite on VS Code 1.84.0 and 1.134.0.
S050 opens a separately wired form in the actual Visual Studio designer, selects `button1`, activates native
`Show Events`, and requires the owner-drawn `Click` row and the real writable child Edit to report
`button1_Click`. The harness commits that same value with `UIAutomation.ValuePattern.SetValue + Enter`, then proves
source, Designer, and project bytes remain exact with one handler method and one subscription. Their respective
SHA-256 values are `a64028cdb47a7c0d3bff88a9b48e65aef58dead35f064f7c1ee9b9d443f96ac9`,
`b7418110c276174eeba4e32a27dbe8f21dc83c0f75e69d102237556f472093f9`, and
`ad9b851b5893c76498edbe80e52ee2ec062f9bd5c8c9019d8f6629034eadc638`; the screenshot SHA-256 is
`460be1745ee698c88eb105060bc408534c41cd232e1ae980906dd5dbb8472a30`. The product's real Events `setHandler`
ingress independently proves the same clean no-op on both supported host lines; physical ARM64 remains external.
S051 opens the exact classic-net48 Form, selects `textBox1` through native Document Outline, verifies the live
`TextChanged=textBox1_TextChanged` Events row, and commits the existing compatible
`textBox1_TextChangedAlternate` through the real writable child Edit using UIAutomation ValuePattern plus Enter.
Visual Studio changes exactly one subscription and retains only the currently referenced empty handler method:
initial original+alternate becomes alternate, one native Undo becomes original, and one native Redo becomes alternate.
Designer Redo is byte-identical to rewire; source Redo is identical after whitespace normalization; project bytes,
the complete unrelated source skeleton, and all unrelated TextBox facts remain exact. The screenshot SHA-256 is
`2a69e4d1a06f061a29912a93cea6eb18d3be4c731b2e690a2da814e500403904`; scenario manifest SHA-256 is
`6b18d6ea1a2231fde902490c752c4b81d2fa95e961eba532c05c48c5aed4290f`.
S027 has not been promoted: the real owner-drawn Document Outline selects exact `button1`, native selection handles and
Properties prove `Location=13;25`, `Size=75;23`, and `Text=Alt drag`, but the capture host has no foreground input
desktop (`actual=0`). Physical Alt-drag and ordinary-drag controls cannot create a transaction, while both message
fallbacks preserve every artifact and leave Undo unavailable. It therefore remains reference `NOT_EXECUTED`.
S079 opens an exact classic-net48 Form with `RightToLeft=Yes`, `RightToLeftLayout=true`, and client `320×160` without
Save. Actual native Form/Button/Label HWND measurements prove logical `primaryButton (20,30,90×28)` renders at mirrored
client `(210,30,90×28)`, while logical `statusLabel (50,82,80×20)` renders at `(190,82,80×20)`; Y and Size remain
exact, and source/Designer/project SHA-256 values remain byte-identical. The screenshot SHA-256 is
`a625709b28e66336b6da1753702ba5763d5dec39caea58a41e63ed7f7c062a28`; scenario manifest SHA-256 is
`f7aa0c20d2d34b82d664689a2750f11e64a76eb1792eef798677dffed8154914`.
S085 opens an exact net10 derived Form and selects the visible protected `inheritedButton` exposed by the installed
designer. Native Properties begins at `Text=Base inherited`; the edit to `Derived override` writes exactly one bounded
derived assignment without a field declaration or unrelated inherited assignment. Base source, base Designer, derived
code-behind, and project hashes stay byte-identical. One native Undo removes the override and is semantically exact after
normalizing only Visual Studio's measured first-touch CodeDOM `this.`/comment-spacing canonicalization (raw bytes are
therefore intentionally reported unequal); one Redo reproduces the applied Designer bytes exactly. The applied screenshot
SHA-256 is `985d6f28c7e1fd798bfac6ea1737818641509a9d45ff49bd5d6d7678ea7330ae`; scenario manifest SHA-256 is
`28c2e5346bfd5887c8d5b843086c40e2e270d687bed377c362ba4c472f7e5456`.
S086 opens a separate exact net10 derived Form and selects the private inherited Label exposed by the installed
designer as `ControlType.Text`, AutomationId `privateInheritedLabel`, with the native lock glyph visible. Properties
shows `Text=Private inherited label` on a disabled row. The exposed UI Automation ValuePattern reports a value but its
`SetValue` attempt is rejected because the element is not enabled; the value and all five base/derived/project artifacts
remain byte-identical. Screenshot SHA-256 is
`aff489a0a05c300b8a1f61e55cb9e83dce8d988d60a3299af26da6a2739f03f9`; scenario manifest SHA-256 is
`81d25207b10dc5eab4c1b7750d572aab30d89264eab080fcd1e7286f69b4af63`. This x64 reference closes the bounded
Visual Studio observation only; physical Windows ARM64 remains externally gated.
S087 opens the exact classic-net48 derived Form over its compiled base, selects empty root space outside the protected
inherited `basePanel`, filters the native Toolbox to `All Windows Forms → Button`, and invokes that exact item's MSAA
Double-Click default action. Save writes exactly one `button1` field, construction, Location, Size, TabIndex, Text,
UseVisualStyleBackColor, Name, derived-root `Controls.Add`, and the two required `SetChildIndex` calls; it never writes
`basePanel.Controls.Add` or changes base source, base Designer, derived code-behind, or project bytes. Native Undo
removes every `button1` shape after measured CodeDOM line-ending/comment/blank-line normalization. Redo restores the
complete operation contract; its raw artifact intentionally records Visual Studio changing generated `TabIndex 1→0`
and reversing the two `SetChildIndex` calls instead of claiming byte identity. Screenshot SHA-256 is
`79d8a5fe41a498fec5281d5654d00ee0b28b80207a74f7d0d119802809959123`; scenario manifest SHA-256 is
`c6fc48b9c2109d41ca23e468a48734c9060e7d8dc25a412b0328a0270d646e62`.
S088 opens source-identical modern net10 and classic-net48 derived Forms, each with a private inherited Button and a
writable derived peer. Modern exposes the target as `ControlType.Button` / AutomationId `privateInheritedButton`;
classic exposes exact accessible Name `Private inherited` and native `WindowsForms10.BUTTON` class as
`ControlType.Pane`, then selects it through the measured native Document Outline. Both show the native lock glyph and
disabled Properties `Text=Private inherited`. A cursor-synchronized drag through the actual designer capture HWND
leaves bounds and all ten base/derived/project artifacts exact. Modern preserves observable Undo/Saved
`False→False` / `True→True`; classic preserves its preexisting `True→True` / `False→False` state. DTE exposes no stack
depth, so no stronger Undo-stack claim is made. Primary screenshot SHA-256 is
`da88fdf3880a1b06cec43d152d6eb3d9612e045b1506cd3f05541e86a43685bf`; scenario manifest SHA-256 is
`3abd6dc937da075745be5a91fb61ac19ee6ab4f863079bd7613c97fbc87c0ec9`. Physical Windows ARM64 remains external.
The corrected repository CustomEditor transaction is exercised on both supported VS Code host lines with the same
X=80 result.

Run `scripts/capture-visual-studio-reference-traces.ps1` from the repository root to capture a new run. The harness
uses a dedicated solution and selects only the Visual Studio process whose main-window title contains that solution
name; it must not attach to or close unrelated Visual Studio sessions.

`scripts/validate-v2-scenario-catalog.ps1` treats a reference `PASS` as valid only when its repo-relative manifest
exists, identifies the same scenario and trace, names an exact Visual Studio installation version, has `PASS` status,
and matches the archived screenshot SHA-256. Round-trip scenarios must additionally prove `byteIdentical=true`.

Current boundary: 40 of 128 reference traces are `PASS`; 88 remain `NOT_EXECUTED`. Only the 40 scenario directories
cited above are release inputs; aggregate capture-run metadata, superseded diagnostics, and uncited scenarios are not
part of the public candidate tree.
S011, S013, and S014 also have
archived product-to-Visual-Studio pixel comparisons; S001, S009, S012, S021, S022, S029, S030, S037, S100, S108, and S120 are bounded no-mutation,
refusal, open, designer-transaction, or round-trip traces rather than product pixel comparisons. S015 is a bounded
z-order hit-test/selection trace, not a render-equivalence claim. S042 is a bounded
subproperty/serialization transaction, S049 is a bounded multi-artifact event-generation trace, S050 is a bounded
existing-handler no-op trace, and S051 is a bounded existing-handler rewire/empty-handler-lifecycle trace; none of
these event scenarios is a pixel-equivalence claim. S021's matching grouped move, S022's matching resize, S029's matching Align
Left, S017's matching active-container intersection marquee, S025's matching Button/TextBox baseline snap, S026's matching 8×8 SnapToGrid move, S030's matching Make Same Width, S031's matching complete-client-area Center Horizontally, S042's matching
subproperty edit, S049's matching default-event product transaction, and S053's matching framework Toolbox discovery,
provenance, and category repository evidence, including native
Undo/Redo, are independently exercised on VS Code 1.84.0 and 1.134.0; physical
ARM64 execution remains externally gated. S051's dual-revision event-rewire refusal is likewise repository-functional
on both host lines, and the independently archived actual Visual Studio run above now closes its bounded reference
lane without turning that scenario into a pixel-equivalence claim. S079's independently archived read-only native-HWND
reference closes the bounded RTL geometry lane, while the product ar-SA Language path remains separately executable on
both host lines. S085's independently archived inherited-property reference closes the bounded native derived-override
lane while the product keeps its separate live base-identity-token safety boundary on both host lines. S086's
independently archived locked-Label reference closes the bounded native read-only Properties observation while its
repository product refusal remains independently executable and physical ARM64 remains gated. S087's archived native
Toolbox Add closes the bounded classic-net48 derived-root creation lane, and S088's two-runtime archive closes the
bounded private-inherited drag-refusal observation while retaining physical ARM64 as a separate gate. S052's
modern/net48 stale-handler-generation refusal
is also repository-functional on both host lines and remains in the reference `NOT_EXECUTED` set. The public S007
unsafe-name refusal and compiled-net48 S035 selected-TabPage reparent transaction are now repository-functional on both
host lines as well. S036's real modern/net48 stale-SplitContainer-target refusal and S061's selected-control atomic
Document Outline rename are likewise repository-functional with native history proof on both host lines. S061 has the
archived bounded actual-Visual-Studio rename reference above; S007, S035, and S036 still do not.
S063's compiled-net48 outline reparent is repository-functional with native Undo/Redo evidence on both host lines, but
it still has no archived Visual Studio run and therefore remains in the 88 reference `NOT_EXECUTED` set. S024 no
longer belongs to that set: its bounded collision-safety reference claim is archived above on both runtime lanes.
