# Events and code

Wiring behavior to a design touches two files: the `+=` statement goes into `.Designer.cs`, and the handler
method goes into the **code-behind** `.cs` beside it — never the other way round. This page covers double-click,
the Events tab, moving between the canvas and the method body, renaming a wired control, and the refusals.

## Double-click a control

Double-clicking a control on the canvas creates or opens its **default event**, the same gesture as Visual Studio.

1. Double-click the control on the canvas (or empty form background for the form itself).
2. The designer resolves the type's real `DefaultEventAttribute` — Button → `Click`, TextBox → `TextChanged`,
   Form → `Load`. Only a **browsable** default event counts.
3. If the event is not wired yet, a method named `<component>_<Event>` (`okButton_Click`; the form uses its class
   name, so `Form1_Load`) is written to the code-behind and wired in `.Designer.cs`.
4. The code-behind opens with the caret on the blank line inside the new method.

An event that is already wired to a method that exists changes nothing — you are only taken to it. If the event
is wired but the method has since been deleted from the code-behind, **only the missing stub is regenerated** and
the existing wiring is left untouched.

A type that declares no browsable default event reports *"button1 has no browsable default event"*; use the
Events tab to pick a specific event instead.

Two targets take double-click first: a TabControl header renames the tab, and a top-level menu or toolbar item
opens its inline rename editor. See [Menus, toolbars and tabs](Menus-toolbars-and-tabs).

## The Events tab

The property grid in the **Designer** panel has two icon buttons after the sort pair: **Properties** and
**Events**. `F4` (**WinForms: Show Properties**) focuses the panel; click **Events** to switch the grid.

The tab lists every **browsable** event of the selected component, sorted by name and grouped by event category
(switch to **Alphabetical** to drop the category rows). The search box filters by event name. A wired event's
name is **bold** and its value cell shows the handler.

The handler shown is parsed from your `.Designer.cs` buffer, not read from a built assembly, so it reflects
unsaved wiring immediately. Three spellings are recognized: `+= new EventHandler(this.M)`, `+= this.M`, and
`+= M`. Each row's tooltip ends with "double-click to go to the handler" or "double-click to create a handler",
depending on which one applies.

### Pick an existing method

The value cell is a combo box, tooltip **Type a handler name (new or existing), or clear to unwire**. Its
dropdown offers only methods declared by your form's own partial class whose signature matches the event's
delegate — same parameter count, matching parameter types, same return type.

A method is deliberately **left out** when compatibility cannot be decided from syntax alone: a `ref` / `out` /
`in` parameter, a type reached through a `using X = …;` alias, an extern-alias qualification, or a
partially-qualified spelling such as `Forms.MouseEventArgs`. A missing candidate you can type by hand is
recoverable; a wiring that stops the project compiling is not.

Choose a name and press `Enter`. Only `.Designer.cs` changes, and the status bar reads
*"wired Click → okButton_Click — unsaved"*. Candidates are fetched lazily: only while the Events tab is showing,
and only when the selected component changes.

### Create a handler by name

Type a name that is **not** in the dropdown and press `Enter`. On an **unwired** event that is the create path,
not the wire path: a name that matches no existing method is generated with the correct signature and the event
is wired to it — the double-click flow with your name instead of the default one. A name that matches a method
that **already exists** only adds the wiring; no stub is written. And unlike the dropdown path, the create path
does not verify that method's signature, so typing the name of an existing but incompatible method — a
`void Wrong(string s)` for a `Click` — wires it, reports success and takes you to it, and the project stops
compiling.

On an event that is **already wired**, a new name is ignored: nothing is created or rewired, the cell reverts to
the existing handler and you are taken to it. To point a wired event at a brand-new method, clear the cell to
unwire it first, then type the new name.

### Unwire

Clear the value cell and press `Enter`. The `+=` statement is removed from `.Designer.cs` and the status bar
reads *"unwired Click — unsaved"*. **The handler method is never deleted** — deleting code you may still call
from elsewhere is not the designer's decision.

## What gets written, and where

```csharp
// Form1.Designer.cs — inside InitializeComponent, after the control's last statement
this.okButton.Click += new System.EventHandler(this.okButton_Click);
```

```csharp
// Form1.cs — inserted as the last member of the form's partial class
private void okButton_Click(object sender, System.EventArgs e)
{

}
```

- The stub lands in the **code-behind**, never in `.Designer.cs`, immediately before the class's closing brace,
  so every existing member keeps its position.
- The form class is matched by **full identity** — namespace, enclosing types, generic arity — not by simple
  name. A decoy `Form1` declared earlier in the same file cannot capture the stub.
- Parameter and return types are written qualified (`System.EventArgs`), so the stub compiles whatever the
  file's `using` block contains.
- The stub is applied as a **one-point insert**, never a whole-document write, so a formatter or source
  generator running during the same moment cannot be erased.
- The stub is written **first**, then verified to have landed where it was aimed; the wiring is committed only
  afterwards. An event is never wired to a stub that failed to write.
- The stub is an ordinary text edit in your `.cs` (undo it with `Ctrl+Z` in that editor). The wiring is a
  designer edit in the `.Designer.cs` buffer (undo it with `Ctrl+Z` on the designer tab) — see
  [Editing model and safety gates](Editing-model-and-safety-gates).

## Going to the code and back

| Gesture | Result |
|---|---|
| Double-click a **wired** event row | opens the code-behind with the caret inside the handler body |
| Double-click an **unwired** event row | creates the handler (auto-named) and goes to it |
| `F7`, **WinForms: View Code**, or right-click → **View Code** | opens the current form as text |
| `Shift+F7` or **WinForms: Open Designer** | opens the designer for the focused `.cs` |

Navigation locates the method by name and puts the caret on the first line of its body. Opening code also records
that you asked for code, so the designer does not auto-open over it again until the file is closed and reopened
(`winformsDesigner.autoOpenDesigner`) — see [Commands and settings](Commands-and-settings).

If the method cannot be found — renamed by hand, or moved to another partial file — the status bar says
*"handler 'okButton_Click' not found in Form1.cs"* and nothing changes.

## Renaming a control that already has handlers

Rename through the `(Name)` row in the property grid, `F2` on the canvas or in the Document Outline, or a
double-click on a component-tray chip. All of them reach the same source-first rename.

Inside `.Designer.cs` the rename rewrites the field declarator, every `this.<name>` reference — including the
left side of each `+=` wiring — and the canonical `this.<name>.Name = "…"` value.

**The handler method keeps its old name.** After `okButton` becomes `saveButton`, `okButton_Click` is still
`okButton_Click` and the wiring still points at it, exactly as in Visual Studio. Rename the method yourself if
you want the names to agree; the dropdown keeps offering it either way.

The rename is **refused** when the sibling code-behind mentions the current name anywhere:

> cannot rename timer1: Form1.cs references it — rename it there first

The scan is a whole-identifier match and deliberately counts mentions in comments. The designer never edits your
code-behind during a rename, so a `timer1.Start()` left behind would compile in the designer and break at the
next build. Rename it in the `.cs` first (VS Code's `F2` symbol rename does the whole file), then rename it here.
The check runs a second time immediately before the commit, so a reference typed while the rename was in flight
is still caught.

Note that a handler *named* after the control does not by itself block the rename: `okButton_Click` is one
identifier, not a mention of `okButton`.

Two more refusals come from the designer file itself: a target whose `this.` qualifiers were stripped
(*"cannot rename button1: the designer file references it without a this. qualifier"* — what
`dotnet format` / IDE0003 does to a designer file), and a new name that is already a field
(*"a field named button2 already exists"*).

## Menu and toolbar items

Clicking a `ToolStrip` / `MenuStrip` item on the canvas loads **that item's** properties and events into the
panel through a dedicated channel that leaves the host's control selection (`currentId`, smart tags,
move/resize) alone. On the canvas the control selection is deliberately dropped, so Delete now targets the
**item** and the z-order / Cut / Duplicate commands do nothing until you select a control again. The item's
Events tab works the same way, and the refresh returns through the item channel, so the item stays highlighted
on the canvas after a wire. See [Menus, toolbars and tabs](Menus-toolbars-and-tabs).

## Refusals

| Message | Why, and what to do |
|---|---|
| *"no code-behind .cs to add a handler to"* | The designer is open on a `.Designer.cs` with no partner `.cs`. Wiring an event with nowhere to put the method would not compile, so nothing is written. Create the code-behind partial first. |
| *"{id} has no browsable default event"* | Double-click found no browsable `DefaultEventAttribute` on the type. Pick a specific event in the Events tab. |
| *"wiring rejected: handler 'X' does not match the event's signature"* | The write path re-checks the signature rather than trusting the dropdown, which can go stale. Fix the method's parameters, or pick another handler. |
| *"wiring rejected: handler method not found in code-behind: X"* | The method was renamed or deleted after the candidate list was built. Reselect the control to refresh it. |
| *"create handler rejected: {reason}"* | The engine refused before anything was written. Reasons include a handler name that is not a plain identifier, no statement for the component to anchor the wiring to, and a delegate or parameter type that cannot be spelled faithfully in C#. |
| *"could not write the handler stub — wiring not added"* | The stub insert was declined. The event is left unwired rather than pointing at a method that does not exist. |
| *"document changed during edit — try again"* | The `.Designer.cs` buffer or the code-behind moved during the engine round-trip. If the stub had already been inserted it stays — undo it in the `.cs`; the wiring is not committed. |
| *"no .cs code-behind to navigate to"* / *"cannot open {file}"* | There is no partner `.cs`, or it could not be opened. Nothing is changed. |
| *"Read-only — the last render failed; editing is disabled until the form renders successfully."* | Events, like every other edit, need a form that renders. See [Troubleshooting](Troubleshooting). |
| *"This operation changes generated source and is not supported on a localizable form. ApplyResources-backed property edits remain enabled."* | Wiring, unwiring and stub creation are structural source edits, so they are refused on a `[Localizable(true)]` form. Edit the wiring as code. See [Localization](Localization). |

Every refusal on this page is fail-closed for your `.Designer.cs`: the wiring is never committed. The one
exception is a handler stub that had already been inserted into the code-behind before a late refusal — the
*document changed during edit* verification, and the read-only and localizable gates re-checked across that
write. The stub is left in place rather than rolled back (taking it back would mean rewriting the whole `.cs`,
which could erase a concurrent edit); undo it with `Ctrl+Z` in the `.cs`.

## Differences between the two engines

- **What is listed** — the event set, its categories, and the default event come from whichever engine renders
  the form. On a `net4x` form that is the live interpreted instance (or the disclosed compiled fallback); see
  [.NET Framework and DevExpress](Framework-and-DevExpress).
- **Which handler is shown** — read from your unsaved `.Designer.cs` buffer on both engines, so a wiring you
  have not saved yet still shows.
- **What is written** — the candidate list, the wiring splice and the stub are always computed by the modern
  engine as a Roslyn pass over your two source files, so the generated code has the same shape on both.
- **Read-only components** — for a component the engine reports as inherited or unresolved, the Events tab
  renders as plain text with no combo box, and double-click is refused with *"edit rejected: …"* carrying the
  ownership reason. See [Property grid](Property-grid).
