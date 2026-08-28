# Property grid

The property grid is the **Properties** pane of the **Designer** view in the WinForms Designer activity bar. It
shows the selected component's properties and events, and every value you commit becomes one targeted edit to
`.Designer.cs` — or, on a localizable form, to the culture's `.resx`.

## Opening it

- Press `F4` (**WinForms: Show Properties**) while a designer tab is focused.
- Right-click the canvas and choose **All Properties…** or **Properties**.
- Click any control, tray chip, or Document Outline node — the grid always follows the canvas selection.

The pane header holds four things, top to bottom: a component dropdown listing every control as
`name : ShortType` (the form's own entry gets " (form)" appended), the **Categorized** / **Alphabetical** and
**Properties** / **Events** buttons, and a search box.

## Reading the grid

| Element | Behavior |
|---|---|
| **Categorized** (default) | Groups rows under clickable category headers rendered `▾ Appearance`, or `▸ Appearance` when collapsed. Categories come from the type's `CategoryAttribute` (`Misc` when there is none) and are not translated. |
| **Alphabetical** | Emits no category rows at all; rows sort by name. |
| Search box | Filters on the property **name** only, case-insensitively, as you type. A collapsed category still hides its matches, so expand it if a row you expected is missing. |
| Empty results | `no matching properties` (or `no properties` with an empty box); on the Events tab, `no matching events` / `no events`. |
| Bold name | The value is non-default: it is assigned in `.Designer.cs`, or the type reports it differs from its default. `Visible`, `Enabled` and `TabIndex` are never bolded on the type-default signal alone — the interpreted host over-reports them — but they still bold when the assignment is present in `.Designer.cs`, so `TabIndex` normally shows bold on a VS-generated form. |
| Description pane | Pinned below the grid. Shows the active row's name and its `DescriptionAttribute`, falling back to the property's type plus an edit hint when it carries no description. With no active row it shows the component's name and short type. |
| Name column | Drag the thin strip on the right edge of any name cell to resize it. |

Category collapse state, expanded rows and the column width are shared across selections and reset only when the
webview reloads.

## Read-only rows

A read-only row renders as plain text with no editor. The trailing marker `  (read-only)` appears whenever the engine
reports the property read-only: the type's own read-only properties, the guarded `Font` and `Cursor` rows below,
`GenerateMember`, a `Modifiers` with no editable field, an unhandled `(Collection)`, and **every** row of an inherited
or unresolved component. A row that is inert only because the panel cannot edit its type carries no marker.

A failed render is not one of these cases — nothing in the grid changes at all. The rows keep their live editors and
**Reset** stays enabled, the value is accepted in the UI, and the refusal arrives only when you commit: the status line
reads `Read-only — the last render failed; editing is disabled until the form renders successfully.` and nothing is
written. Fix the render first; see [Troubleshooting](Troubleshooting). Editing a picture that is not your form would
write the wrong thing.

| Reason the row is inert | What you can do |
|---|---|
| The component is **inherited** (`Component belongs to inherited base type '<Base>'.`) | Change it in the base class. The designer cannot address a member it does not declare. |
| The component is **unresolved** (`Component has no unique source-addressable identity.`, `More than one live component resolves to source id '<id>'.`, `Component is not declared by the current designer source and is not a resolved base component.`) | Give it a unique field in `InitializeComponent`. Without a single source anchor no splice can be proven minimal. |
| The property is read-only on the type | Nothing — it has no setter, or its `PropertyDescriptor` says read-only. |
| A `Font` whose `GdiCharSet` is not 1, or a vertical GDI font | Edit it in code. `FontConverter`'s string form omits the charset, so committing through the grid would silently drop it. |
| A `Cursor` whose current value is not one of the offered standard cursors | Edit it in code. Committing through the picker would replace your custom cursor with a standard one. |
| `GenerateMember` | Always read-only: toggling field ↔ local is a structural change that is not round-trip safe. |
| `Modifiers` on a multi-declarator field, or a component with no field | Split the declaration first; changing one keyword would change its siblings too. |
| The panel cannot edit the property's **type** | Edit it in code. Editable types are enums, component references, `String`, `Boolean`, `Char`, the numeric types, and `Point`, `Size`, `Color`, `Rectangle`, `Padding`, `Font`, `Cursor`. |
| A ToolStrip item that could not be resolved (`Item properties are unavailable when rendering from the compiled assembly.`) | Build the project. This is the .NET Framework engine describing an item it has no compiled instance for. |

**Lock Controls** does not grey anything out. It removes the canvas grab handles and blocks mouse move, resize and
nudge; `Location` and `Size` stay editable in the grid.

## Committing a value

Type into a text field and press `Enter` (or move focus); pick from a dropdown, glyph or checkbox and it commits on
the spot. The engine composes one targeted splice, a gate proves it changed only that value, and the host commits it
as one undo entry:

```diff
- this.button1.Text = "button1";
+ this.button1.Text = "Save";
```

The status line reads `set button1.Text — unsaved`. Nothing else in the file moves — not the surrounding statements,
their order, whitespace, line endings or BOM. A refused edit reports `edit rejected: {reason}` and leaves the file
untouched; see [Editing model and safety gates](Editing-model-and-safety-gates).

On the modern engine the form re-renders from the edited text. On the .NET Framework 4.8 engine the canvas is a
compiled instance, so the same value is also applied to that live instance — the text edit is what persists on save.

**Dock and Anchor are mutually exclusive.** Setting `Anchor`, or setting `Dock` to anything other than empty or
`None`, deletes the conjugate assignment in the **same** commit, so one `Ctrl+Z` undoes both.

## Reset

Right-click a row and choose **Reset**. It deletes the property's assignment from `.Designer.cs`, so the value falls
back to the type's default; the status reads `reset button1.Text — unsaved`.

- **Reset** is greyed out when the component is not editable, the property is read-only, or there is no assignment to
  delete. A property with nothing to delete is already at its default.
- If the engine finds no assignment anyway, you get `button1.Text is already default` and nothing is written.
- A refusal reports `reset rejected: {reason}`.
- Reset performs **no** Dock/Anchor conjugate clearing — that rule lives on the edit path only.
- On a localizable form Reset removes the culture override instead, so the value falls back down the culture chain.
  See [Localization](Localization).

## The specialized editors

| Property | Editor |
|---|---|
| `Anchor` | A glyph box with four clickable edge bars (`Anchor — click a bar to tether/untether that edge`). Each click commits immediately, in `Top, Bottom, Left, Right` order, or the literal `None` when every edge is released. Expand the row for one True/False dropdown per edge. |
| `Dock` | A five-zone picker (`Dock Top`, `Dock Left`, `Dock Fill`, …) plus a separate `Dock None` button. Expand the row for a plain `DockStyle` dropdown. |
| `Color` | Swatch, free-text field (`Color — a name, "R, G, B" / "A, R, G, B", or pick from the dropdown`) and a ▾ dropdown with **Custom**, **Web** and **System** tabs. Picking a swatch commits the color *name*. `Transparent` shows as a checkerboard, not white. |
| `Font` | Collapsed: the whole invariant `FontConverter` string. Expanded: **Name** (a combobox of installed families that also accepts free text), **Size**, **Unit**, and Bold / Italic / Underline / Strikeout. A commit is refused without a family name and a numeric size, because `FontConverter` silently *defaults* a malformed string instead of failing. A comma decimal such as `9,75` is normalized to `9.75`. |
| `[Flags]` enums | A read-only summary plus a ▾ checkbox list. Clearing every member commits the enum's zero member; if the enum has none, the checkbox is silently restored and nothing is committed rather than emitting an invalid value. |
| `Cursor` | A standard-values dropdown. Non-standard cursors are read-only, as above. |
| Any property with standard values | An exclusive set becomes a dropdown; a non-exclusive set becomes a combobox that also accepts free text. A current value outside an exclusive set is prepended so a change is deliberate, shown as `(unset)` when empty. |
| `Point`, `Size`, `Rectangle`, `Padding` | Expand into numeric sub-rows (`X`/`Y`, `Width`/`Height`, `X`/`Y`/`Width`/`Height`, `Left`/`Top`/`Right`/`Bottom`). `Padding` gets a leading **All** row that writes all four. Sub-rows appear only when the collapsed value parses as exactly that many integers. |
| Component references (`AcceptButton`, `CancelButton`, `ContextMenuStrip`, …) | An exclusive dropdown of sibling field names plus `(none)`. The host re-derives the candidate list from the engine and accepts only an exact match, otherwise `edit rejected: invalid reference`. |
| `(Name)`, `Modifiers`, `GenerateMember` | Injected into the **Design** category for field-backed components. `(Name)` rewrites the field, its `this.` references and `Name` in one edit; it is refused when the code-behind `.cs` mentions the old name anywhere (`cannot rename {old}: {file} references it — rename it there first`) — rename it there first. `Modifiers` splices the field declaration's access keyword and needs no re-render. |
| `Image` / `Icon` | No text field: a 16×16 preview, **Import…** (`Import an image file into the form’s resources`, max 16 MB) and a `(none)` button. The image bytes go into the sibling `.resx`, written atomically and bundled into the *same* undo entry as the source edit. |
| Modal editor `…` | Offered for `Color` and `Font` only, labelled `Open ColorEditor…` / `Open FontEditor…`. Re-entry is refused with `A property editor is already open.` |
| TableLayoutPanel `Column` / `Row` | Not a property assignment — the grid rewrites the three-argument `Controls.Add(this.child, col, row)` and re-renders, because a cell move can reflow siblings. A non-integer reports `{cell} must be a non-negative integer`. |

## Collection editors

A collection row shows `(Collection)` and a `…` button. Every editor commits atomically on **OK**, and an unchanged
model posts nothing at all — so opening an editor and closing it never dirties the document.

| Collection | What opens |
|---|---|
| String items (`ComboBox`/`ListBox`/`CheckedListBox.Items`) | A one-item-per-line text area. Trailing blank lines are dropped. |
| `string[]` properties (`TextBox`/`RichTextBox.Lines`) | The same line editor, but a trailing blank line is **kept** — it is meaningful content the engine round-trips. |
| A bounded generic `IList<T>` | The same line editor, labelled `Edit <ItemType> items…`. Refused for reading when an item contains a newline, because it could not be edited losslessly line by line. |
| `ListView.Columns` | A typed grid: header text, `Width` (`-1` = size to content, `-2` = size to header), alignment, reorder and remove, plus **+ Add column**. |
| `DataGridView.Columns` | A two-line card per column: header text, `Width`, `RO`, `Vis`; then `DataPropertyName`, `Format`, cell alignment and null text. |
| `TreeView.Nodes` | A recursive node editor — text, key, image keys/indexes, tooltip, `Checked`, add child / add sibling, indent, outdent, reorder, per-node colors and font. `ImageKey` and `ImageIndex` are mutually exclusive: typing one clears the other. |
| `ToolStrip` / `MenuStrip` `Items` | A recursive item editor. A **new** row offers an owner-appropriate type picker; existing items keep their concrete type, because retyping would drop type-specific properties. See [Menus, toolbars and tabs](Menus-toolbars-and-tabs). |
| `DataBindings` | Property, data source, data member, update mode and formatting per binding. **+ Add binding** is disabled until the form has a data component. |
| `DataSource` | A `…` picker over `(none)` / `Component` / `Object type`. |
| `ImageList` images | **Not** in the grid — run **WinForms: Edit ImageList Images…** with the ImageList selected. Anything else reports `Select an ImageList first, then edit its images.` |

If the engine cannot read a collection back safely, the popup says `This collection can’t be edited here (<reason>).`
and stays read-only, so nothing can be dropped. `ImageList` editing is refused the same way — `cannot edit {id} — its
current images could not be read safely; editing was refused to avoid dropping them` — because saving replaces the
whole set.

## Editing several controls at once

Select two or more controls (`Ctrl`/`Shift`+click, a marquee, or `Ctrl+A`) and the grid switches to the shared view.
The description pane reads **{n} selected controls** and *Only shared writable properties are shown. Each edit is one
all-or-nothing transaction.* A selection that contains an inherited or unresolved control gets no shared view at all:
the pane goes empty and shows the generic `Select a control in the WinForms designer to edit its properties.` —
deselect that control to get the shared rows back. The `edit rejected: target '…'` messages below only ever name a
target that survived into the shared view.

**What survives the intersection.** A row appears only when it is present on **every** selected control, is a plain
scalar, and has the exact same type and enum shape everywhere. Standard-value lists must be present on all targets or
none, and are intersected; an exclusive list that intersects to nothing drops the row. That deliberately excludes
images, every collection editor, `DataSource`, `DataBindings`, extender properties, component references,
`(Name)`/`Modifiers`/`GenerateMember` and the modal `…` editors — they keep their single-target transactions rather
than pretending to be atomic batch rows. The Events tab is empty for a multi-selection.

**Mixed values.** When the targets disagree, the editor is blank and carries `(mixed values)` as its placeholder,
tooltip and accessible label; a read-only cell shows that text directly. Mixed rows do not offer the Anchor, Dock,
Color, Font or flags editors, and cannot be expanded — the composite editors need a single starting value. Typing a
value into a mixed row writes it to every target.

**All or nothing.** The engine validates the target set (2–128 unique ids, all declared by the current designer
source), preflights every target against one immutable snapshot, composes the splices, and re-parses the result. It
returns **no text at all** unless the whole selection composes, so a valid prefix can never be committed. On success
the host makes exactly one commit: `set Enabled on 4 selected controls — unsaved`.

One ineligible control therefore cancels the entire edit. The reason names the target, in the form
`edit rejected: target 'label3' refused Enabled: <reason>` or
`edit rejected: target 'label3' could not be composed atomically: <reason>`; a composed batch that will not parse
reports `edit rejected: multi-object edited text has syntax errors`. If the selection moved under the grid you get
`edit rejected: stale or incompatible multi-object property metadata` — reselect and try again. Otherwise deselect the
control the message names, or edit it on its own.

**Multi Reset** works the same way: **Reset** is enabled when at least one target has an assignment to delete, targets
already at their default are representable no-ops, and any target that refuses rejects the whole batch. Nothing to do
reports `4 controls.Enabled is already default`; success reports
`reset Enabled on 4 selected controls — unsaved` as one undo unit. Multi Reset does no Dock/Anchor conjugate
clearing, though a multi **edit** still does — and a conjugate reset that fails rejects the whole edit.

## Engine differences

- **Modern engine.** A scalar edit or reset re-renders the form from the edited text.
- **.NET Framework 4.8 engine.** The canvas is a compiled instance, so a text-only edit would leave a stale picture.
  Each committed value is also applied to that live instance — single edits, multi edits and resets alike. `Modifiers`
  is spliced by the modern engine even for a `net4x` form, because it is pure text surgery on a field declaration and
  never loads the form.
- On the .NET Framework engine a ToolStrip item's own property grid is editable as soon as the item resolves, and the
  value is applied to the live instance too. Before the project is built the item cannot be resolved, so the pane shows
  the `Item properties are unavailable when rendering from the compiled assembly.` placeholder instead of a grid.

See [.NET Framework and DevExpress](Framework-and-DevExpress) for what else differs, and
[Events and code](Events-and-code) for the Events tab.
