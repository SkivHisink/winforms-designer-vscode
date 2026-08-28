# Getting started

This page takes you from an installed extension to your first saved designer edit. It covers what the designer
needs, how a form gets onto the canvas, what the three surfaces are, and how edits are saved and undone.

## What you need

| Requirement | Detail |
|---|---|
| Windows | Windows x64 or Windows ARM64. WinForms is Windows-only — Linux, macOS, WSL and Linux remote workspaces are not supported. |
| VS Code | `^1.84` |
| .NET 10 Desktop Runtime | Runs the primary engine; must match the VSIX architecture (`win32-x64` → x64, `win32-arm64` → ARM64). |
| .NET Framework 4.8 | Only needed for `net4x` / DevExpress projects. Native on x64; on Windows ARM64 it is a reduced-feature x64 compatibility fallback, not a native ARM64 engine. |
| A trusted workspace | The extension is disabled in untrusted and virtual workspaces. |

The v2.0.0 roadmap keeps that managed runtime boundary: modern `win-x64` / `win-arm64` plus net48 x64 compatibility.
x86, COM, and ActiveX are excluded from v2.0.0 GA. If a project or toolbox operation requires that Tier D path, the
designer must refuse before changing files with a reason such as `X86_WORKER_UNAVAILABLE` or
`COM_ACTIVE_X_UNSUPPORTED`.

Workspace Trust is not a formality here. The manifest states the reason: *"Rendering a designer loads and executes
the project's control assemblies (constructors / OnPaint run on preview), so the extension is disabled in
untrusted workspaces."* If a folder is open in Restricted Mode, trust it before the designer will render.

The extension activates on startup and runs on the workspace side of a remote connection.

## Which projects are supported

Routing is automatic and per form. There is nothing to configure for the common case.

| Project | Engine | What you get |
|---|---|---|
| `net8.0-windows`, `net9.0-windows`, `net10.0-windows` | modern (.NET 10) | Renders from your live `.Designer.cs` source. No build required. |
| `net4x` (including DevExpress and other vendor suites) | .NET Framework 4.8 | Interprets your live source onto the *compiled* vendor controls, with a disclosed fallback to your last build for constructs it cannot yet reproduce. |

A `net4x` project that has never been built is refused before rendering, with the reason and the fix:
*"This form's project targets .NET Framework and hasn't been built yet. Build it so its controls can load, or
select the project or assembly that provides them."* Build the project, or use
**WinForms: Select Control Assembly / Project…** to point the designer at an existing output.

See [.NET Framework and DevExpress](Framework-and-DevExpress) for the differences that matter day to day.

## Opening a form

A `.cs` file opens in the designer only when a generated sibling `<name>.Designer.cs` exists next to it. That is
the whole rule.

1. Open `Form1.cs`. The designer opens automatically, the way Visual Studio does.
2. If it opened as text instead, use one of: **WinForms: Open Designer** (`Shift+F7`, or the toolbar button in the
   editor title bar), or right-click the file → **Reopen Editor With… → WinForms Designer**.

Auto-open is controlled by `winformsDesigner.autoOpenDesigner` (default `true`) and fires **at most once per
file**: once you switch a form to its code, the extension respects that and stops pulling the tab back until you
reopen the file.

If the `.cs` has no generated partner, the tab shows a static page rather than a broken canvas:
**No WinForms designer for `<name>`** / *"The designer view needs a generated `<base>.Designer.cs` next to this
file."* Nothing is wrong with your project — the designer simply has no generated file to read or write.

To create a new form, right-click a folder in Explorer → **Add** → **Windows Form**. See
[Creating forms and controls](Creating-forms-and-controls).

## The three surfaces

### 1. The canvas

The designer tab itself. It holds the rendered form, the selection, and — below the form surface — the
**component tray**, a strip of chips for non-visual components such as timers and `ContextMenuStrip`s.

Along the bottom edge is the canvas toolbar: the selection readout on the left (`button1 : Button`, or
`3 controls selected`), then zoom (`−` / `100%` / `+` / **Fit**), the alignment and spacing groups that appear
once two or more controls are selected, **Tab Order**, **Show ruler**, and the unsaved badge.

Click to select, drag to move, drag a grab handle to resize. Details are in
[Designing on the canvas](Designing-on-the-canvas).

### 2. The side panel

Click the **WinForms Designer** icon in the activity bar to open the **Designer** view. A tab strip at the bottom
switches between three full-size panes:

- **Properties** — the property grid for the current selection. Its own header carries a component picker, the
  **Categorized** / **Alphabetical** sort toggle, the **Properties** / **Events** toggle, and a search box; a
  description pane is pinned at the bottom. See [Property grid](Property-grid) and
  [Events and code](Events-and-code).
- **Outline** — the control hierarchy as a tree. Drag a node onto another node to reparent; the canvas never
  reparents on a drag.
- **Toolbox** — click an item to add it, or drag a control onto the canvas to drop it where you point.

`F4` (**WinForms: Show Properties**) focuses the panel and switches it to Properties.

### 3. Status and notices

Four places report what the designer is doing. Learning to read them saves most of the guesswork:

| Where | What it says |
|---|---|
| Canvas status line (just above the toolbar) | The result of your last gesture — `set button1.Text — unsaved`, `moved 1 control — unsaved`, `committing…`, or `error: …`. |
| Canvas toolbar badge | `● unsaved` while the form has designer changes that are not written to disk. |
| Notice banner (top of the canvas) | A persistent condition, not a result — for example *"Localizable form — editing {culture}. Values are written to the .resx."* A clean render hides it. |
| Diagnostics strip (top of the canvas) | A partial or failed render: *"{n} constructs skipped from this designer"*, or *"Render failed — still showing the last form that rendered."* It offers **Retry**, **Rebuild**, **Choose Control Assembly…** and **Copy Diagnostics**. |

VS Code's own status bar shows `$(package) Controls: …` for the focused form — which assembly is supplying its
controls. Click it to change that.

## Switching between the designer and the text editor

| Direction | How |
|---|---|
| Designer → code | `F7`, the `$(code)` button in the editor title bar, or right-click the canvas → **View Code**. This opens the form's code-behind `.cs` as text. |
| Code → designer | `Shift+F7`, or the designer button in the editor title bar. |

A `.Designer.cs` you open directly also opens in the designer; **WinForms: Open Designer** on it redirects to the
`Foo.cs` partner when that file exists.

If **WinForms: Open Designer** has nothing to work with, it says so: *"Open a form .cs (with a .Designer.cs
partner) to open its designer."*

## How edits are saved

The designer never opens `.Designer.cs` as a text editor. It keeps the generated text in memory and the form's
visible `Foo.cs` designer tab is the thing that goes dirty. So:

- Your gestures do **not** touch `.Designer.cs` on disk until you save.
- `Ctrl+S` (or **File → Save**) writes the file, atomically — staged into a sibling temp file and renamed into
  place, preserving the original BOM. There is no Save button on the canvas, only the `● unsaved` badge.
- If the file changed on disk since the designer read it, the save is refused rather than overwriting someone
  else's work: *"The .Designer.cs changed on disk since it was opened — saving would overwrite that change."*
  Revert the file to take the on-disk version, or save a copy elsewhere first.
- While you have no unsaved designer edits, an external write to `.Designer.cs` (a checkout, a generator) is
  adopted and re-rendered automatically.

## How edits are undone

Every persisted gesture is one undo entry. With the designer tab focused, `Ctrl+Z` walks designer gestures, not
text edits — a move, a property change, a delete, a multi-control edit each undo as a whole. A run of arrow-key
nudges collapses into a single entry, and when an edit also writes a `.resx` (an image import, a localized value),
the resource write is undone in the same step.

**File → Revert** is different: it re-reads `.Designer.cs` from disk and discards unsaved generated-source edits.
It does not roll back a `.resx` that was already written — `Ctrl+Z` is the gesture that reverts a resource.

## Your first change

1. Open a form's `Form1.cs`. The canvas renders it.
2. Click a **Button** on the canvas. A blue selection box with grab handles appears, and the Properties panel
   follows the selection. Press `F4` if the panel is not visible.
3. In the panel's search box, type `Text`. The grid filters to matching property names.
4. Click into the **Text** value cell, type a new caption, and press `Enter`. The status line reads
   `set button1.Text — unsaved`, the toolbar shows `● unsaved`, and the canvas re-renders with the new caption.
5. Press `Ctrl+S`. Now open `Form1.Designer.cs` in a text editor: exactly one line changed.

   ```diff
   - this.button1.Text = "button1";
   + this.button1.Text = "Save";
   ```

   Nothing else moved — not the surrounding statements, not their order, not the whitespace, not the line endings.
6. Focus the designer tab again and press `Ctrl+Z`. The caption goes back, in one step.

That fifth step is the whole product in miniature. Read
[Editing model and safety gates](Editing-model-and-safety-gates) for why it works that way, and what happens when
the designer cannot prove an edit is that confined — it refuses, and leaves your file alone.

## Where to go next

| Page | What it answers |
|---|---|
| [Designing on the canvas](Designing-on-the-canvas) | Selection, drag and resize, snaplines, the grid, alignment, zoom |
| [Creating forms and controls](Creating-forms-and-controls) | `Add → Windows Form`, the toolbox, dropping controls |
| [Property grid](Property-grid) | Categories, the editors, multi-selection, Reset, read-only rows |
| [Events and code](Events-and-code) | Wiring handlers, double-click, navigating to code |
| [Menus, toolbars and tabs](Menus-toolbars-and-tabs) | On-canvas menu editing, ToolStrip items, TabControl pages |
| [Commands and settings](Commands-and-settings) | Every command, keybinding and setting |
| [Editing model and safety gates](Editing-model-and-safety-gates) | What the designer writes, what it refuses, and why |
| [Code generation](Code-generation) | Exactly what a scaffold and a control drop produce |
| [Localization](Localization) | The `.resx` model, cultures, `Add Localization` |
| [.NET Framework and DevExpress](Framework-and-DevExpress) | How `net4x` projects render and what differs |
| [Troubleshooting](Troubleshooting) | Blank previews, refused saves, missing toolbox items |
| [Architecture](Architecture) | How a form becomes a picture, and why there are two engines |
| [Development](Development) | Building, the test suites, and where the code lives |
