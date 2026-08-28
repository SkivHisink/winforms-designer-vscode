# Menus, toolbars and tabs

Menu items, toolbar items, tab pages and layout containers are not edited with the ordinary move/resize handles —
they have their own gestures, the same ones Visual Studio uses. This page covers those gestures, what each one
writes into `.Designer.cs`, and where the designer declines.

For selection, dragging, snaplines and alignment see [Designing on the canvas](Designing-on-the-canvas); for the
property grid itself see [Property grid](Property-grid).

## Menu and toolbar items on the canvas

A `MenuStrip`, `ToolStrip` or `StatusStrip` that is parented into the form gets a trailing dashed `+` slot on the
canvas whose tooltip is **Type Here**. Items are edited in place.

| Gesture | What it does |
|---|---|
| Click the trailing `+` (**Type Here**) slot | opens the inline add editor: an item-type dropdown plus a caption field |
| Click an item | selects *that item*, not the strip, and loads its own properties |
| Double-click an item, or `F2` | opens the inline editor prefilled with the item's caption |
| `Delete`, or right-click → **Delete Item** | removes the item and its whole submenu subtree |
| Right-click an item | a focused menu with only **Rename** (`F2`) and **Delete Item** (`Del`) |
| Click an item that has sub-items | opens a dropdown listing its `DropDownItems` |
| Click the strip's overflow chevron | opens a list of the items pushed into the overflow area |
| Click a `ContextMenuStrip` chip in the component tray | opens that off-tree strip's items as a flyout |

Every editing gesture here is one commit and one `Ctrl+Z`; the status line reports `set <strip>.Items — unsaved`.

### Add an item

1. Click the `+` slot at the end of the strip, or the **Type Here** row at the bottom of an open submenu.
2. Choose the item type in the dropdown.
3. Type the caption and press `Enter`. `Escape`, or a click outside the editor, cancels.

The offered types depend on what owns the slot:

| Owner | Types offered |
|---|---|
| `MenuStrip`, `ContextMenuStrip`, and every submenu level | Menu Item, ComboBox, TextBox, Separator |
| `StatusStrip` | Status Label, Progress Bar, DropDown Button, Split Button, Separator |
| `ToolStrip` (and any other non-menu, non-status strip) | Button, Label, Separator, Split Button, DropDown Button, ComboBox, TextBox, Progress Bar |

Choosing **Separator** hides the caption field — a separator carries no `Text`. Confirming a non-separator with an
empty caption adds nothing, matching Visual Studio's empty "Type Here". After a committed add from a submenu or a
tray flyout, that flyout re-opens on the same path so the new item is visible.

### Select an item and edit its properties

Clicking an item gives it a solid highlight and posts it to the panel as its own component: you get the item's
`Text`, `Enabled`, `ToolTipText`, `ShortcutKeys` and the rest, plus its **Events** tab. This selection is kept
separate from the control selection on purpose — a `ToolStripItem` is a component, not a control, so the generic
**Cut**, **Copy**, **Bring to Front** and control **Delete** never act on it.

Collection, image and data-source rows stay read-only for an item — a menu item's `DropDownItems` is a whole item
forest, edited on the canvas or in the panel **Items** editor instead.

An item that has no field in `.Designer.cs` — for example a hand-written `statusStrip1.Items.Add("Ready")` — is
deliberately not clickable. There is no source identity to splice, so the click falls through to selecting the
strip rather than offering a rename or delete that would target the wrong item.

To wire an item's `Click` handler, use the **Events** tab of the item's own grid. Double-clicking an item on the
canvas renames it; it does not create a handler.

### Rename an item, or change its type

`F2`, a double-click, or **Rename** opens the same inline editor prefilled with the caption, text pre-selected.
Confirming without changing anything posts nothing at all, so a caption with padding is never silently rewritten.
Clearing the caption cancels the rename rather than writing an empty `Text`.

A **top-level** item that is not a separator and has no submenu also gets a type dropdown in that editor. Changing
it retypes the item: the old item is removed and a fresh one of the new type is minted at the same position,
carrying **only** its `Text`. Type-specific properties (`Image`, `ShortcutKeys`, …) are lost — this is a
data-losing operation by design, so it is offered only where the result is predictable. Retyping an item that has
a submenu is refused with `edit rejected: cannot retype an item that has a submenu`, because the engine cannot
re-create the submenu under a new item.

Renaming an item's **caption** is not the same as renaming its **field** — and the field cannot be renamed from the
designer at all. The Design rows `(Name)`, `Modifiers` and `GenerateMember` are deliberately not injected for a
`ToolStripItem`, because an item's edits travel the item channel rather than the control-field route; rename the
field in `.Designer.cs` yourself. Those rows exist for ordinary controls — see [Property grid](Property-grid).

### Delete an item

`Delete` or **Delete Item** removes the selected item together with everything under it; the engine computes the
removed field list recursively and strips each field, its construction, its property block and its `AddRange`
membership. An item that has already vanished from the source is a silent no-op.

### Submenus, overflow, and off-tree context menus

A closed dropdown has no bounds in the rendered picture, so the designer draws it itself:

- **Submenus.** Clicking a top-level item that has sub-items opens a dropdown; a row with its own children opens a
  further level to its right. Rows are selectable, renamable (`F2` or double-click) and deletable at any depth,
  and each level ends with its own **Type Here** row that appends into that item's `DropDownItems`.
- **Overflow.** When a strip is too narrow, the items WinForms pushed into the overflow area are reachable through
  the chevron. They are still top-level items, so select/rename/delete behave normally. The overflow list has no
  **Type Here** row — widen the strip first.
- **`ContextMenuStrip`.** An off-tree strip is never painted on the form, so it appears as a component-tray chip.
  Clicking the chip opens its items as a flyout anchored inside the surface. An **empty** context menu opens too:
  its lone **Type Here** row is the only on-canvas way to seed the first item.

In every flyout, a row with neither a field nor children is drawn inert — no hover, no handlers — so a
hand-authored item can never masquerade as a clickable one.

### The panel Items editor

Selecting the strip itself and clicking `…` on the `Items` row (button tooltip **Edit items…**) opens a popup
titled **Items** covering the whole forest at once: `↑` / `↓` **Move up** / **Move down**, `＋⇢` **Add item
below**, `＋` **Add child item** (only under an existing `ToolStripMenuItem`), `✕` **Delete item (and any
sub-items)**, and **+ Add item** at the foot. A brand-new row gets a type picker; existing rows keep their
concrete type. **OK** commits the whole forest as one edit; an unchanged forest posts nothing. If the source shape
cannot be read the popup says *"This collection can’t be edited here (…)"* and stays read-only. Use this editor
for bulk reordering; use the canvas for single-item work.

## Tab pages

### Switching the designed page

Click a `TabControl` header to switch the page you are designing. This writes **nothing**: controls on a page that
is not shown are excluded from the surface entirely (so they cannot steal a click from the page in front), and the
chosen page is stored as per-form view state in VS Code's workspace state — no `SelectedIndex` assignment is added
to your generated source. That state is replayed into the render on the modern engine and on an interpreted .NET
Framework canvas, so the page survives closing and reopening the form; on the disclosed compiled fallback the
reopened picture shows the built default page until you click a header again. Because hidden pages are off the
surface, switch to a page before you try to select, drop onto, or delete anything on it.

### Add, rename, reorder and delete

Select the `TabControl` and right-click. The tab commands act on the page you are currently looking at.

| Command | Effect | Notes |
|---|---|---|
| **Add Tab** | appends a new empty page and makes it active | the page type is copied from an existing page |
| **Move Tab Left** / **Move Tab Right** | moves the active page one position | swaps only adjacent page references |
| **Delete Tab "\<name\>"** | deletes the page and everything on it | asks for confirmation first |
| Double-click a tab header | prompts `Rename tab "<page>"` and edits that page's `Text` | validation: `Enter a tab caption` |

Delete asks *Delete tab "\<page\>" and all controls on it? This cannot be undone except via Undo.* with a
single **Delete Tab** button. All four operations are one undo entry each.

Refusals you can meet here:

- `add tab: could not determine the tab page type` — the `TabControl` has no existing page to copy a type from.
  Add the first page in code, then use **Add Tab**.
- `tab <page> is already first` / `is already last` — the move had nowhere to go; nothing was written.
- `add tab rejected: …`, `move tab rejected: …`, `delete tab rejected: …` — the engine could not prove the edit was
  confined (for example a page referenced from outside its own subtree, or a non-canonical `TabPages.AddRange`).
  Nothing is written; edit that part as code.

Toolbox tabs are a different thing entirely: the **Add Tab** / **Rename Tab** / **Delete Tab** entries on the
Toolbox pane organize the toolbox, not your form.

## Containers that behave specially

| Container | Move/resize its children by dragging? | How you actually place things |
|---|---|---|
| `Panel`, `GroupBox`, `TabPage` | yes | drop from the toolbox onto them; drag freely inside |
| `SplitContainer` | yes, inside a panel | only by editing `.Designer.cs` — `Panel1` / `Panel2` are not drop targets; set `SplitterDistance` in the grid |
| `TableLayoutPanel` | no | the `Column` and `Row` rows in the property grid |
| `FlowLayoutPanel` | no | **Bring to Front** / **Send to Back** to change flow order |

A child of a `TableLayoutPanel` or `FlowLayoutPanel` can be neither moved nor resized on the canvas — the panel
owns its geometry, so the drag handles are withdrawn and the status would otherwise lie about the result.

### SplitContainer

Children live in the panels, not in the container: the source reads
`this.splitContainer1.Panel1.Controls.Add(this.leftButton);`. The designer follows that intermediate segment, so a
control written into the left panel renders, hit-tests and drag-moves in the left panel exactly as you would
expect. What you cannot do is put it there *from* the designer. A `SplitterPanel` is a property of the container,
never a field, and both engines emit only field-backed controls — so neither panel exists as a selectable node, an
outline entry or a drop target. A toolbox drop over the `SplitContainer` therefore hit-tests to `splitContainer1`,
which is not one of the recognized containers, and the new control is parented to the **form** at the drop point.
Add the `Panel1` / `Panel2` line to `.Designer.cs` yourself; the designer takes it from there. The splitter
position is the ordinary integer property `SplitterDistance` in the property grid; there is no splitter-drag
gesture on the canvas.

Dragging a control onto the `SplitContainer` in the document outline never reaches the engine either: the node
colours as an invalid drop and the outline status reads *Drop on the form or a container.*, and nothing is posted.
That guard exists because `SplitContainer.Controls.Add` throws at load and would silently detach your control.

### TableLayoutPanel

A child's cell is not a property assignment: it is the three-argument
`this.tableLayoutPanel1.Controls.Add(this.button1, 1, 2)`. The grid therefore shows `Column` and `Row` rows for
any control whose parent is a `TableLayoutPanel`, and editing one rewrites that call rather than emitting a
property. Both must be non-negative integers — anything else reports `<cell> must be a non-negative integer` and
the grid reloads unchanged. A cell change re-flows the siblings, so it always triggers a full re-render.

Because a cell child is not parented by a one-argument `Controls.Add`, dragging it out of the table in the outline
is declined rather than guessed at; move it by editing its cell, or edit the source directly.

### FlowLayoutPanel

A `FlowLayoutPanel` positions its children by the order of their `Controls.Add` calls, which is exactly what the
z-order commands reorder. **Bring to Front** moves a child's `Controls.Add` first, so it flows first; **Send to
Back** moves it last. Both are on the canvas right-click menu and on a right-click in the document outline.

### GroupBox, Panel and TabPage as drop targets

Dropping a toolbox item onto a `Panel`, `GroupBox`, `TabPage`, `FlowLayoutPanel` or `TableLayoutPanel` parents the
new control into that container; anywhere else it lands on the form. The outline colours an invalid drop before you
release it, but its reparent set is that drop set minus `TableLayoutPanel`: a table shows the drop as valid and the
engine then refuses it with `edit rejected: target is not a container that accepts a direct child (use
Panel/GroupBox/FlowLayoutPanel/…) — cannot reparent here`, because a cell child needs the three-argument `Add`.
That is the mirror image of the rule above, where a cell child cannot be dragged *out* of the table — move such a
control by editing its cell, or by re-dropping it from the toolbox.

## Engine differences

Both engines emit the same item geometry, the same **Type Here** slot and the same tab hit-testing, so every
gesture above is available on `net4x`/DevExpress projects too. What differs is how the picture catches up:

- **Modern engine.** The edit is spliced and the form is re-rendered from your live source.
- **.NET Framework 4.8 engine.** The splice is identical (it is pure text). An interpreted canvas simply
  re-interprets the new source. On the disclosed compiled fallback the live strip is reconciled in place instead;
  where that is not possible you get *"Your code was updated, but the view can’t show this change yet (…) — it
  appears after you rebuild the project."* Your code is already correct — only the picture is waiting.
- **Item properties on the Framework engine** are read and written against the live instance. If the item cannot
  be resolved — typically because the project has not been built — the grid shows *"Item properties are
  unavailable when rendering from the compiled assembly."* and stays read-only. Build the project to get it back.
  See [.NET Framework and DevExpress](Framework-and-DevExpress) for the routing and fallback rules.

## What is refused, and why

| Situation | Message | What to do |
|---|---|---|
| The last render failed | `Read-only — the last render failed; editing is disabled until the form renders successfully.` | fix the render first; you would be editing a picture that is not your form |
| The form is localizable | `This operation changes generated source and is not supported on a localizable form. ApplyResources-backed property edits remain enabled.` | item add/rename/retype/delete, all four tab commands, header-rename and cell edits change generated source. Switching tab pages still works, and a page's caption can be edited as the `Text` property, which routes to the `.resx` |
| The strip's items cannot be parsed | `edit rejected: items not editable` | the `Items` shape is non-canonical; edit it as code |
| A submenu owner disappeared mid-edit | `edit rejected: submenu owner not found` | re-open the submenu and repeat |
| The document changed during the round-trip | `document changed during edit — try again` | repeat the gesture |

Nothing on this page regenerates `InitializeComponent`; each gesture is a confined splice checked by the gates in
[Editing model and safety gates](Editing-model-and-safety-gates).
