# Designing on the canvas

The canvas is the rendered picture of your form plus an overlay of selection boxes, guides, badges and tethers.
This page covers every mouse and keyboard gesture on that surface and what each one writes into `.Designer.cs` —
one targeted edit and one undo step per gesture, as described in
[Editing model and safety gates](Editing-model-and-safety-gates).

## Selecting

Click a control to select it. The hit test walks the engine's own control order — deepest first, then smallest
area, with the form last — so the innermost control under the pointer wins and clicking empty background selects
the form. Hovering draws a thin outline over the control a click *would* select, which matters in a dense layout.

- **Ctrl+click**, **Cmd+click** or **Shift+click** adds a control to the selection, or removes it while more than
  one is selected. The control you touched last is the **primary selection** — the one with grab handles, and the
  anchor for every align and make-same-size command.
- **Rubber band**: press on the form background or empty space and drag. The band activates after 3 px of movement
  and selects every control it *intersects*, not only those fully inside. An empty band clears the selection.
- **Ctrl+A** selects every sibling in the current design scope — the primary selection's parent, or the form's own
  children when the form is selected. **Tab** and **Shift+Tab** cycle those same siblings with wrap-around, and
  **Esc** selects the parent container. None of the four touches your source.
- The form itself has the id `this`. It can never join a multi-selection, and while only the form is selected Cut,
  Copy, Duplicate, Delete, Bring to Front, Send to Back and Align to Grid are all disabled.

The label at the left of the toolbar reads `name : ShortType` (with ` (form)` after the root's name), or
`{n} controls selected`. Canvas selection drives the side panel — see [Property grid](Property-grid).

Two overlays are always on: a dashed grey outline around every control that holds children, and dashed orange
anchor tethers from a single selected control's anchored edges to its parent (hidden while dragging, in tab-order
mode, and for a docked control). A **▸** *Tasks* glyph appears at the top-right of a single selection when the
control has common tasks to offer.

## Moving and resizing

A move-drag starts only when you press on a control that is already selected, is not the form, is not locked, and
that the host has marked movable. Otherwise the press just selects it and you drag on the second attempt. A
TabControl never starts a move-drag, because its headers must stay clickable for tab switching. With two or more
controls selected the whole set translates by the same delta; the primary drives the snapping.

Eight grab handles (`nw n ne w e sw s se`) appear only for a single, unlocked, resizable selection. The form gets
only **e**, **s** and **se** — a form is resized, never moved. Width and height clamp at 4 px, and a gesture that
ends within 2 px in both axes commits nothing.

| Gesture | Source edit |
|---|---|
| Move a child | `Location` |
| Resize a child | `Size`, plus `Location` in the same chained edit when the top-left also moved |
| Resize the form | `ClientSize` — never `Bounds` |

**Why a control sometimes will not move.** Movability is settled before the canvas draws a grab handle, and the two
engines settle it differently. On the .NET Framework engine — and for the form itself on either engine — the host
decides per selection and tells the canvas: the form resizes but does not move; a control whose `Dock` is anything
other than `None` does neither; a child of a `TableLayoutPanel` or `FlowLayoutPanel` does neither, because the cell
owns its position; an `AutoSize = True` child moves but does not resize. `Anchor` alone never blocks a gesture.

On the modern engine every non-root control is authorized by the engine itself, against the live control graph. It
refuses the same `Dock` and layout-panel cases, refuses **both** move and resize for an `AutoSize` control, and
refuses three more the list above gives you no way to predict: a control whose type does not come from a framework
assembly — which is every control of your own project or a vendor's — a form whose inherited base could not be
resolved, and a control that is not declared as a designer field. A refused control shows no grab handles and
refuses the drag outright, so a `UserControl` from your own project can be dragged on a `net4x` form and cannot be
dragged at all on a modern one.

A refused single gesture reports `edit rejected: {reason}` on the modern engine, and on `net4x` reports nothing at
all when the control has no representable `Location`. The status line says `nothing moved (layout-managed?)` or
`nothing resized (layout-managed?)` for group moves and the arrange commands, when not one member could be written.
Either way your file is untouched — change `Dock`/`AutoSize` in the [Property grid](Property-grid), or move the
container instead.

While you drag, the status line shows `position / size → x=…, y=…, w=…, h=…`, and for a group move
`move {count} → Δ({dx}, {dy})` in front of it. On release it shows `committing…` until the edit lands.

## Nudging with the keyboard

| Keys | Effect |
|---|---|
| Arrow | Move the whole selection by 1 pixel |
| Ctrl+Arrow | Move by one grid cell |
| Shift+Arrow | Resize the single selection by 1 pixel |
| Ctrl+Shift+Arrow | Resize by one grid cell |

A run of arrow presses updates the overlay immediately and is debounced into **one** commit after 250 ms of idle —
one undo entry, one re-render. Switching between move and resize, or changing the selection mid-run, commits the
previous run first, and so does starting a drag, a delete or a copy. Nudging is a raw delta: it runs neither
snaplines nor grid snapping. Locked controls refuse it, moves need the host's movability grant, and resizing needs
a single resizable selection. Arrow keys are ignored while you are typing in a text field.

## Layout modes and the grid

Placement is governed by four resource-scoped settings. Changing any of them reaches an open designer immediately —
no reload, no re-render.

| Setting | Default | What it does |
|---|---|---|
| `winformsDesigner.layoutMode` | `snapLines` | "Placement mode for move and resize gestures: WinForms SnapLines, Snap to Grid, or no snapping." Shown as **SnapLines** / **Snap to Grid** / **None** |
| `winformsDesigner.gridSize` | `8` | "Grid cell size in logical WinForms pixels (2–128) used by Snap to Grid, Align to Grid, and spacing commands." |
| `winformsDesigner.showGrid` | `false` | "Show the placement grid inside the form's exact client area." |
| `winformsDesigner.placementSnapOverrideModifier` | `alt` | The key that suspends snapping for one gesture: `alt`, `control`, `shift` or `disabled` |

`gridSize` is used whatever the layout mode is: it is the Ctrl+Arrow nudge step, the step for the Increase and
Decrease spacing commands, and the lattice for **Align to Grid**. `showGrid` is independent of the mode too — the
dot grid is drawn inside the form's engine-reported client rectangle, so it never spills over the caption or
border, and the dots stay one logical cell apart at any zoom.

In **Snap to Grid**, a move rounds the control's top-left to the nearest grid multiple measured from its *parent's*
client origin, and a resize snaps only the dragged edges to the same lattice — the grid is anchored to the
container, not to the window. In **None** the raw pointer rectangle is used and no guides are drawn.

### What SnapLines match

The default mode reproduces the WinForms snapline set. A candidate is accepted only when the correction it needs is
within **6 pixels**; per axis the nearest candidate wins, and ties break by priority.

| Guide | Priority | What it aligns |
|---|---|---|
| Text baseline | highest | The engine-measured text baselines of the moving control and a sibling |
| Sibling margin | | The larger of the two facing `Margin` values, so neighbours stop at their declared gap instead of touching |
| Container padding | | The parent's client rectangle inset by the parent's `Padding` plus the moving control's `Margin` |
| Edges and centers | lowest | A sibling's left / center / right and top / center / bottom |

Only true siblings participate — controls with the same parent, excluding everything else in the selection.
**Equal spacing** is offered separately: when the moving control sits between two flanking siblings, a candidate
places it so both gaps are identical, and it wins the axis when its correction is at least as small as the best
edge or center snap. Alignment guides draw as thin magenta lines; equal-spacing guides as dashed teal bars in the
two equal gaps.

Every number behind this — outer bounds, live client rectangle, `Margin`, `Padding`, and a Font/DPI-measured text
baseline — comes from the engine, not from browser text measurement, and both engines emit the same fields, so
snapping behaves identically on a `net4x` form. Resizing snaps **only the dragged edge** against sibling edges and
the parent's padded client box; baseline and equal-spacing guides do not take part, and each snapped edge keeps the
4 px minimum.

### Suspending snapping for one gesture

Hold the configured modifier — **Alt** by default — during a move or resize and the raw pointer rectangle is used,
all guides disappear, and the status line switches to `free placement → x=…, y=…, w=…, h=…`. One collision is worth
knowing: if you set the modifier to `control`, Ctrl+drag still means Duplicate on a **move**, and Duplicate wins, so
with that setting the override reaches resize gestures only. Set it to `disabled` to keep snapping on always.

## Arranging several controls

These live in the canvas toolbar along the bottom edge — below the canvas, the component tray and the status line.
The align / distribute / spacing / same-size group ("Arrange the selected controls relative to the primary
selection") appears only for a rendered form with 2 or more controls selected and no locked control among them.

- **Align lefts / rights / tops / bottoms / horizontal centers / vertical centers** move every *other* selected
  control onto the primary selection's edge or center. The primary never moves.
- **Make same width / height / size as the primary selection** resizes the others to match; the primary is left
  alone and unchanged controls are omitted from the batch.
- **Distribute horizontally — equalize the gaps (needs 3+)** (and the vertical twin) needs 3 or more controls in the
  same container: the outermost two hold their positions and the ones between move so every gap is identical.
  Refusals: `select 3+ controls to distribute`, `spacing commands require controls in the same container`,
  `controls overlap — cannot distribute`.
- **Increase / Decrease / Remove horizontal (vertical) spacing** need 2 or more controls in the same container. The
  first control in sorted order is the fixed anchor; each following gap grows by one grid cell, shrinks by one
  (never below 0), or becomes exactly 0. Refusal: `select 2+ controls to adjust spacing`.
- **Center horizontally / vertically in the container** works from a single visual selection upwards and shifts the
  whole bounding box, so relative offsets inside the selection are preserved. The host computes the shift, because
  only it knows the container's real client origin inside the window chrome. A selection spanning different parents
  is refused and nothing is written.

All of them are written as `Location` (or `Size`) edits in one undo step, reporting `aligned {n} controls — unsaved`,
`nothing aligned (layout-managed?)` or `edit rejected: {reason}`.

**Align to Grid** lives on the right-click menu instead of the toolbar, and works in every layout mode including
None: it snaps each selected control's top-left onto the grid. The menu item is greyed out when nothing selectable
is selected or the selection contains a locked control.

## Adding, duplicating, clipboard and delete

Drag an item from the **Toolbox** onto the canvas and it is added to the container under the cursor at that point —
see [Creating forms and controls](Creating-forms-and-controls). Double-clicking a control creates or opens its
default event handler — see [Events and code](Events-and-code).

| Gesture | What happens |
|---|---|
| **Ctrl+drag** a selection | Duplicate at the drop offset; the originals stay put and the status reads `duplicate {count} → Δ({dx}, {dy})`. All-or-nothing: if any clone cannot be represented safely, nothing is written |
| **Ctrl+D** / **Duplicate** | Clone the selection in place without touching the Cut/Copy clipboard. The last clone becomes the selection, so repeated Ctrl+D cascades |
| **Ctrl+X** / **Ctrl+C** / **Ctrl+V** | Cut, Copy, Paste. Paste targets the current selection, or the form; it stays greyed out until the host reports a non-empty clipboard |
| **Delete** | Remove the selection. The root form can never be removed; with nothing removable you get `remove rejected: nothing removable` |

A refused clone reports `nothing to duplicate (root / container with children / referenced elsewhere)` — copy a
container only after its children have been moved out. All of these accelerators are ignored while the focus is in a
text field, so typing in a value editor is never intercepted.

## Z-order, reparenting and tab order

**Bring to Front** and **Send to Back** are right-click commands with no canvas accelerator. They apply to visual,
non-root controls, reorder the `Controls.Add` calls as one undo, and report `brought to front — unsaved` or
`already at front`. The same two commands are on the right-click menu of the Outline pane, where **Alt+Home** and
**Alt+End** also reach them.

**Dragging on the canvas never reparents a control** — a move writes `Location` and nothing else. To move a control
into a different container, drag its node in the **Outline** pane onto the target node. Valid drop targets are
highlighted, invalid ones marked, and a refusal states why: the control cannot be moved (root, inherited or
unresolved), the target cannot accept moved controls, a control cannot be moved into itself or into its own child,
*move child controls first, then move the empty container*, or the target is not a supported container. Supported
containers are the form, `Panel`, `GroupBox`, `TabPage`, `FlowLayoutPanel` and `TableLayoutPanel`.

The **Tab Order** button in the toolbar strip below the canvas toggles tab-order editing ("Toggle tab-order editing:
click controls in order to renumber TabIndex"). Every non-root control shows a badge with its current `TabIndex`;
clicking controls in the order you want writes `TabIndex` from 0 upwards through the ordinary property-edit path.
Dragging, selecting and rubber-banding are all off while the mode is on — click the button again to leave it.

## Lock Controls

The right-click **Lock Controls** command toggles the locked state of **every** control on the form at once, and
carries a checkmark when they all are (it is disabled on an empty form). A locked control keeps a muted dashed
selection border, loses its grab handles, gains a 🔒 badge, and cannot be moved, resized or nudged; it is also
excluded from the align and spacing toolbar and from **Align to Grid**.

This is view state only. It is persisted per form in VS Code's workspace state and is **never** written to
`.Designer.cs` or `.resx`, so it does not travel with your project — and it does not grey out the property grid,
where `Location` and `Size` stay editable.

## Zoom and the ruler

Zoom steps through 25, 33, 50, 67, 75, 90, 100, 110, 125, 150, 200, 300 and 400 %, clamped to 10–800 %. Use the
**−** / **+** buttons, click the percentage to reset to 100 %, or **Fit** to scale the form into the view.
**Ctrl+=**, **Ctrl+-** and **Ctrl+0** do the same and **Ctrl+wheel** zooms continuously. The level is remembered
per form.

The ruler button in the toolbar strip below the canvas ("Show/hide the pixel ruler", face **Show ruler** /
**Hide ruler**) adds horizontal and vertical strips with a minor tick every 10 form pixels and a labelled major tick
every 50, and marks the selected control's extent on both — tracking it live while you move or resize.

## The right-click menu

On a control or the form, in order: **View Code** · **Bring to Front**, **Send to Back** · **Align to Grid**,
**Lock Controls** · **All Properties…**, **Learn More Online** (single selection) · a **Select '\<name\>'** entry
for each ancestor · for a TabControl **Add Tab**, **Move Tab Left**, **Move Tab Right**, **Delete Tab "\<name\>"** ·
**Cut**, **Copy**, **Paste**, **Duplicate** · **Delete** · **Properties**. Right-clicking a control that is not part
of the current selection selects it first; right-clicking a tray chip selects that component.

When an on-canvas menu or toolbar item is selected the menu is replaced by just **Rename** and **Delete Item** —
see [Menus, toolbars and tabs](Menus-toolbars-and-tabs).

## Shortcuts

| Keys | Action |
|---|---|
| Arrow / Ctrl+Arrow | Move 1 px / one grid cell |
| Shift+Arrow / Ctrl+Shift+Arrow | Resize 1 px / one grid cell |
| Ctrl+A | Select every sibling in the current scope |
| Tab / Shift+Tab / Esc | Next sibling / previous sibling / the parent container |
| F2 | Rename the selection (or the selected menu item) |
| Delete | Delete the selection (or the selected menu item) |
| Ctrl+X / Ctrl+C / Ctrl+V | Cut / Copy / Paste |
| Ctrl+D / Ctrl+drag | Duplicate in place / at the drop offset |
| Alt+drag | Suspend snapping for this gesture (configurable) |
| Ctrl+= / Ctrl+- / Ctrl+0 / Ctrl+wheel | Zoom in / out / 100 % / continuous |
| F7 / F4 | **WinForms: View Code** / **WinForms: Show Properties** |
| Shift+F7 | **WinForms: Open Designer**, from the text editor |

More on the commands and every setting mentioned here: [Commands and settings](Commands-and-settings).

## When the canvas refuses

- **The last render failed.** Every mutating gesture answers `Read-only — the last render failed; editing is
  disabled until the form renders successfully.` You would otherwise be editing a picture that is not your form —
  fix the render first, see [Troubleshooting](Troubleshooting).
- **The form is localizable.** Move, resize, align, center and make-same-size stay enabled and are routed into the
  culture's `.resx`. Structural gestures — drop, delete, cut, paste, duplicate, z-order, reparent — are refused with
  `This operation changes generated source and is not supported on a localizable form. ApplyResources-backed
  property edits remain enabled.` See [Localization](Localization).
- **The layout owns the geometry.** See *Why a control sometimes will not move* above.

Snapping is identical on both engines: the geometry math runs in the webview, and both engines emit the same
snapline inputs. Commits are not. On the modern engine every move, resize, align, center and same-size runs as an
engine-authoritative geometry transaction — stricter refusals, and one refused member rejects the whole batch,
reporting `edit rejected: {reason}`. On a `net4x` form the same commands splice `Location` (or `Size`) per control,
commit the members they can and skip the rest, so a selection holding a docked or `TableLayoutPanel`-hosted child
aligns all-or-nothing on the modern engine and partially on `net4x`. What differs on top of that is how the picture
catches up after a commit — see [.NET Framework and DevExpress](Framework-and-DevExpress).
