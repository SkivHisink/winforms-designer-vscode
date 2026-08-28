# Creating forms and controls

How to add new items to a project — forms, user controls, components, classes — and how to put controls on a
form once it opens. Every creation gesture is one source edit gated the same way as any other; see
[Editing model and safety gates](Editing-model-and-safety-gates).

## Add a form, user control, component or class

1. In the VS Code Explorer, right-click the folder that should own the new file (or any file inside it).
2. Choose **Add**, then **Windows Form**, **User Control**, **Component** or **Class**.
3. Type the C# type name in the input box and press Enter.

The input box is titled **Add Windows Form** (or the matching kind) and prompts *Enter the C# type name. The .cs
suffix is optional.* It opens pre-filled with the first free Visual-Studio-style default — `Form1`,
`UserControl1`, `Component1`, `Class1`, counting up — with the whole name selected so you can type over it. A
name that is not a single C# identifier, or that is a keyword, is rejected while you type with *Enter one valid
C# identifier (no path, punctuation, or reserved keyword).*

These four commands live only in the Explorer context menu. They are hidden from the command palette, because
they need a selected folder to know which directory and which project you mean. Right-clicking a `.csproj`
directly is treated as an explicit choice of that project.

| Kind | Files created |
|---|---|
| **Windows Form** | `<Name>.cs`, `<Name>.Designer.cs`, and `<Name>.resx` on a classic (non-SDK) project only |
| **User Control** | the same three, with the *Component Designer generated code* region instead |
| **Component** | `<Name>.cs` only — a `public class <Name> : System.ComponentModel.Component` |
| **Class** | `<Name>.cs` only |

On an SDK-style project no `.resx` is seeded, because Visual Studio does not seed one either; the engine writes
it the first time a resource actually needs it. The name is still checked against `<Name>.resx`, so a leftover
`Form2.resx` in the folder makes `Form2` unavailable and the default name skips to `Form3`.

The generated `<Name>.cs` is `public partial class <Name> : Form` (or `: UserControl`) with a constructor that
calls `InitializeComponent();`. The nine template `using` directives are written unless the project enables
`ImplicitUsings`, and they go inside the namespace when the nearest `.editorconfig` sets
`csharp_using_directive_placement = inside_namespace`. The namespace is the project's `RootNamespace` plus the
folder path from the project directory down to the target folder. The `.Designer.cs` half is the Visual Studio
template byte for byte — see [Code generation](Code-generation) for exactly what it contains and what it
deliberately leaves out.

A classic project, or an SDK project with default items disabled, also receives the exact `<Compile>` /
`<EmbeddedResource>` entries with their `SubType` and `DependentUpon` metadata, inserted into the `.csproj` in
the **same** undoable edit as the files.

When it succeeds you get the notification *{kind} {name} was created.* A form or user control then opens
straight in the designer; a component or class opens as ordinary source.

## When Add refuses

Every project-shape problem is refused before a single byte is written. All planned files and the optional
`.csproj` insertion go in as one bulk edit, so a refusal never leaves half a form behind.

- *"The item cannot be added safely here ({reason}: {detail}). Select a folder owned by one unambiguous C#
  project with a standard static project file; Forms and User Controls additionally require WinForms. No files
  were changed."* — `{reason}` names the exact cause: `noProject`, `ambiguousProject` (two `.csproj` in one
  directory), `sharedProjectUnsupported` (a `.projitems` shared project), `outsideWorkspace`, `outsideProject`,
  `malformedProject`, `dynamicProjectProperty` (an MSBuild property that is conditioned or computed, so its
  value cannot be read statically), `notWinFormsProject`, or `unsupportedProjectItems` (wildcard or dynamic
  `Compile`/`EmbeddedResource` shapes the planner will not edit). Move the file to a folder owned by one plain
  project, or add the item by hand.
- *"A generated file already exists ({detail}). Choose another type name; no files were changed."* — pick a
  different name.
- *"The project changed while the item was being prepared. Run Add again; no files were changed."* — something
  edited the `.csproj` buffer while the prompt was open, so the insertion point is no longer trustworthy.

A form or user control additionally requires the project to be a WinForms project: `UseWindowsForms=true`, or a
legacy `<Reference Include="System.Windows.Forms…">`. Components and classes have no such requirement.

## Add controls from the toolbox

Open the **Toolbox** tab of the WinForms Designer panel. Visual controls can be added two ways:

- **Drag** the item onto the canvas. The control lands where you dropped it: the drop point is converted to a
  position relative to the container's client origin and clamped to 0.
- **Click** the item. It is added to the current selection when that selection is itself one of the container
  types below, and to the form otherwise — selecting a `Button` that sits inside a `Panel` puts the new control
  on the form, not in the panel. Position is a cascade: `13, 13` for the container's first child, stepping 8
  pixels down and right for each one after it (wrapping back after ten).

The drop lands **inside** the container under the pointer only if that container is a `Panel`, `GroupBox`,
`TabPage`, `FlowLayoutPanel` or `TableLayoutPanel`; anything else (a `Button`, a `Label`, empty background) puts
the control on the form. Click-to-add follows the same rule against the current selection.

The new control is named the way Visual Studio names it — the short type name with its first letter lowered plus
the first free number (`button1`, `dataGridView1`), checked case-insensitively so a `tabpage1` can never collide
with an existing `tabPage1`. It becomes the selection, and the status line reads `added {name} — unsaved`. What
the splice writes — the field, the constructor run, the commented property block, the `Controls.Add` in z-order —
is documented in [Code generation](Code-generation).

An add that cannot be proven safe writes nothing and reports `add rejected: {reason}`. The reasons are precise:
`unknown control type: …`, `unknown parent: …`, `invalid parent id: …`, `InitializeComponent not found`,
`could not place the field declaration`, `added text has syntax errors`, `edit changed more than the new control`.

### Toolbox categories and project controls

The toolbox shows **All Windows Forms**, **Common Controls**, **Containers**, **Menus & Toolbars**,
**Components**, **Printing**, **Dialogs**, **WPF Interoperability** (marked *coming soon* — nothing is populated
there), and **Data**. A **Project Controls** category appears as soon as controls from your own projects are
found, followed by any custom tabs you created.

`winformsDesigner.toolbox.autoDiscoverProjectControls` (default `true`) walks the build-output directories of
the owning and referenced projects after a designer opens, under hard file, depth and time budgets, and reports
`toolbox discovery: {controls} controls; {directories} directories; {skipped} skipped` with the details in the
**WinForms Designer** output channel. A project with no build output is logged as one to build first. Turn the
setting off to keep only the engine baseline plus whatever you added yourself.

### Choose Toolbox Items

Right-click in the toolbox for the VS-style menu: **Paste** (disabled), **List View**, **Show All**, **Choose
Items…**, **Sort Items Alphabetically**, **Reset Toolbox**, **Add Tab**, **Delete Tab**, **Rename Tab**, **Move
Up**, **Move Down**.

**Choose Items…** opens an editor tab titled **Choose Toolbox Items** (with ` → <tab>` appended when you opened
it from a custom tab). Its three pages are **.NET Framework Components**, **COM Components** and **WPF
Components**; only the first works — the other two state that *COM and WPF components are intentionally
unsupported; only .NET components can be added.* Check a row to add it (or to restore an auto-discovered item
you hid), clear a row to hide or drop it, then press OK. The status line reports
`toolbox updated ({added} added, {hidden} hidden)`. **Browse…** takes one or more `.dll` files, scans each for
toolbox components and pre-checks what it found: `Loaded {items} from {asm} (pre-checked — click OK to add them)`,
or `no toolbox components`.

This remains true for the v2.0.0 GA boundary: COM and ActiveX are not part of the managed baseline. A future Tier D
path would need a separate release decision; current operations that require it fail closed with
`COM_ACTIVE_X_UNSUPPORTED` and no source/project mutation.

### Referencing the assembly a control came from

After you add a control that came from a chosen control-source assembly, the generated `new Ns.Foo()` will not
compile until the project references that assembly, so you are asked: *"{asm} isn't referenced by {proj}. Add a
reference so the added control compiles?"* with **Add reference** and **Not now**. Accepting inserts a
`<Reference>` with a `HintPath` as an undoable edit. The question is asked at most once per project and assembly
per session, and on the .NET Framework engine it is skipped for controls that come from the form's own compiled
assembly, where no reference is needed; a control from a separately browsed or probed assembly still prompts.

## Non-visual components (the tray)

`Timer`, `ToolTip`, `ErrorProvider`, the file and colour dialogs and their kind have no position on a form, so
they are **click-only** — their toolbox tooltip ends with *" — click to add to the component tray"*, while a
visual control reads *" — click to add, or drag onto the form"*. Adding one writes a field and a single
`this.timer1 = new System.Windows.Forms.Timer(this.components);` — the `components` container is used when the
form has an initialized one and the type accepts it, so `Dispose` still disposes the component — and nothing
else: no `Location`, no `Size`, no `Controls.Add`. The status line reads `added {name} to the tray — unsaved`.

The component appears as a chip in the tray strip below the form surface. Click a chip to select it and load its
properties; double-click a chip to rename it inline (Enter or focus loss commits, Escape cancels).

## Naming a control

Renaming goes through one path, whichever way you start it: the **(Name)** row in the property grid's **Design**
category, `F2` on the canvas or in the Document Outline, or a double-click on a tray chip. The engine rewrites
the field, its `this.<field>` uses and its `Name` assignment as one minimal edit, and the status shows
`{old} renamed to {new} — unsaved`.

A rename is **refused** when the sibling code-behind `.cs` mentions the current name anywhere:
`cannot rename {old}: {file} references it — rename it there first`. The scan matches whole identifiers and
deliberately also matches comments — it fails closed, because the engine only ever sees the `.Designer.cs` and
cannot know whether your `timer1.Start()` would still compile. Rename it in the code-behind first, then here.
Inherited, unresolved and read-only components are refused up front.

Two neighbouring rows in the same **Design** category:

- **Modifiers** — the generated field's access keyword, chosen from *Public, Private, Protected, Internal,
  Protected Internal, Private Protected*. Editing it is a byte-local splice of that one field declaration; it
  never touches `InitializeComponent`, so it works even on forms the whole-file serializer refuses to
  regenerate (binary `.resx`, unresolved vendor types), and the canvas does not re-render. Like every other
  design-time row it is still refused on a localizable form. The row is read-only when several fields share one
  declaration, because the change would hit the neighbours too.
- **GenerateMember** — always read-only. Toggling a component between a field and a local is a structural change
  that is not round-trip safe, so the value is shown but never written.

## Deleting a control

Press `Del` on the canvas, or use the context menu's **Delete**. Pressing `Del` while the side panel has focus
routes back to the same path. A multi-selection is removed as one undo entry; the status reads
`removed {id} — unsaved` or `removed {n} controls — unsaved`, and the selection falls back to the form. `Del` is
ignored while you are typing in a text field, and a selected menu or toolbar item is deleted instead of the
control that hosts it — see [Menus, toolbars and tabs](Menus-toolbars-and-tabs).

Deleting removes the control's statements, its field declaration and its `//` header comment block. It is
refused, with the file untouched, when the removal would leave a dangling reference:

- the root form — it can never be removed, and while only the form is selected Delete is disabled;
- `control is a container with children — remove them first`;
- `control is referenced in {method}(...) — handle that first` (an `AddRange`, an extender `SetX`, and the like);
- `control shares a field declaration with other fields`;
- `remove rejected: nothing removable` when the selection holds nothing that can be deleted.

## Deleting a form

A form is several files that VS Code's file nesting only makes *look* like one. With
`winformsDesigner.deleteFormSiblings` (default `true`), deleting `Form1.cs` contributes `Form1.Designer.cs`,
`Form1.resx` and every `Form1.<culture>.resx` to the **same** delete operation — one confirmation, one undo. It
applies to whatever performs the delete, not just the Explorer.

Only a `.cs` that really has a generated `.Designer.cs` partner triggers this, and only culture-shaped
qualifiers count: `Form1.Backup.resx` is never taken, because it is not a file this designer created. Turn the
setting off to delete exactly the file you selected.

Only files are deleted. On a classic (non-SDK) project the `<Compile>` / `<EmbeddedResource>` entries that
**Add** inserted are left behind — remove them from the `.csproj` by hand, or the project will not build.

## On a localizable form

Adding, deleting and renaming are structural source edits, so on a `[Localizable(true)]` form they are refused
with *"This operation changes generated source and is not supported on a localizable form. ApplyResources-backed
property edits remain enabled."* Values still edit normally and route into the `.resx`. See
[Localization](Localization).

## On the .NET Framework engine

Adding and deleting a control is written by the same Roslyn splice, then applied to the live preview instance
rather than re-rendered from scratch, so the canvas updates without a rebuild. When the preview cannot reflect
the change — an unconvertible value, a component the preview will not mutate — the source edit still stands and
you are told so: *"Your code was updated, but the view can’t show this change yet ({diag}) — it appears after
you rebuild the project."* Project and vendor controls are added by fully-qualified name, so a vendor `Panel` can
never resolve to the framework one. See [.NET Framework and DevExpress](Framework-and-DevExpress).
