# Commands and settings

The reference page: every command the extension contributes, every keyboard shortcut it registers or handles on
the canvas, and every setting it reads. All names, titles and defaults here are copied from the extension
manifest and string catalogs — what you see in the Command Palette and the Settings editor.

## Commands

Command titles are shown exactly as they appear in the Command Palette. "Palette" below means the command is
listed there; the four **Add** commands are deliberately hidden from it, because they need a selected folder to
resolve a target directory.

| Title | Command id | Where it appears | What it does |
|---|---|---|---|
| **WinForms: Open Designer** | `winformsDesigner.open` | Palette, editor title bar — only when the active file is a form `.cs` with a `.Designer.cs` partner, or a `.Designer.cs` | Opens that form in the designer. A `.Designer.cs` redirects to its `Foo.cs` partner when one exists |
| **WinForms: View Code** | `winformsDesigner.viewCode` | Palette, editor title bar — only while a designer tab is focused | Reopens the same file as C# text and suppresses auto-open for it until you reopen the file |
| **WinForms: Preview High-DPI Scaling Fix…** | `winformsDesigner.previewHighDpiQuickFix` | Palette and editor title bar — only while a designer tab is focused | When the form explicitly sets `AutoScaleMode.None`, opens the exact safe `None` → `Font` source proposal in a read-only diff. **Apply** commits that retained revision as one normal designer Undo/Redo unit; a changed source snapshot is refused instead of overwritten |
| **Windows Form** | `winformsDesigner.addForm` | Explorer right-click → **Add** | Scaffolds `<Name>.cs` + `<Name>.Designer.cs` (plus `<Name>.resx` on a classic project) and opens it in the designer |
| **User Control** | `winformsDesigner.addUserControl` | Explorer right-click → **Add** | Same, with `UserControl` as the base type |
| **Component** | `winformsDesigner.addComponent` | Explorer right-click → **Add** | Scaffolds a single `<Name>.cs` deriving from `System.ComponentModel.Component` and opens it as code |
| **Class** | `winformsDesigner.addClass` | Explorer right-click → **Add** | Scaffolds a single `<Name>.cs` and opens it as code |
| **WinForms: Show Properties** | `winformsDesigner.showProperties` | Palette (always) | Focuses the **Designer** panel and switches it to the Properties tab |
| **WinForms: Export Designer Diagnostics** | `winformsDesigner.exportDiagnostics` | Palette (always) | Opens a Markdown report as an untitled document — see [Diagnostics](#diagnostics-and-the-output-channel) |
| **WinForms: Select Control Assembly / Project…** | `winformsDesigner.selectControlAssembly` | Palette and editor title bar while a designer is focused; also the click action of the control-assembly status bar item | Points the active form at the project or `.dll` that provides its custom controls, remembered per form |
| **WinForms: Select Form Localization Culture…** | `winformsDesigner.selectLocalizationCulture` | Palette and editor title bar while a designer is focused | Picks the culture whose `.resx` edits go to; offers **Add Localization** on a form that is not localizable yet. See [Localization](Localization) |
| **WinForms: Edit ImageList Images…** | `winformsDesigner.editImageListImages` | Palette, while a designer is focused | Edits the selected `ImageList`'s images. Refuses when the selection is not an `ImageList`, or when the existing images cannot be read back — saving replaces the whole set, so it fails closed |
| **WinForms: Release .NET Framework Assembly (for Rebuild)** | `winformsDesigner.releaseAssembly` | Palette (always, on purpose) | Frees the build output the .NET Framework preview holds open, so you can rebuild without closing the designer. It stays available with no designer focused, because that is exactly when you need it |
| **WinForms: Run Build Task (Release Preview First)** | `winformsDesigner.runBuildTask` | Palette (always) | Picks your existing VS Code build task, waits for the .NET Framework preview to hand the output back, then runs it |
| **WinForms: Run Test Task (Release Preview First)** | `winformsDesigner.runTestTask` | Palette (always) | The same barrier for your test task |
| **WinForms: Stop the Designer Preview Engine** | `winformsDesigner.stopEngines` | Palette (always) | Shuts down the resident engine process(es). They start lazily and otherwise live until the window closes |
| **WinForms: Restart the Designer Preview Engine** | `winformsDesigner.restartEngines` | Palette (always) | Stops the engines and reloads the active designer, so a fresh engine comes straight back |

The Explorer **Add** submenu is labelled **Add** and appears on any local file or folder — it is not restricted to
`.cs` files. A refused scaffold writes nothing at all; every project-shape check runs before the first byte, see
[Creating forms and controls](Creating-forms-and-controls).

## Registered keyboard shortcuts

These four are contributed as keybindings, so they show in VS Code's Keyboard Shortcuts editor and can be
rebound there. Only `Ctrl+Shift+B` declares a macOS variant; the function keys are the same on every platform.

| Key | Command | Active when |
|---|---|---|
| `F7` | **WinForms: View Code** | the designer tab is focused |
| `Shift+F7` | **WinForms: Open Designer** | a text editor has focus *and* that file can open a designer |
| `F4` | **WinForms: Show Properties** | the designer tab is focused |
| `Ctrl+Shift+B` (`Cmd+Shift+B`) | **WinForms: Run Build Task (Release Preview First)** | the designer tab is focused |

`Ctrl+S` saves and `Ctrl+Z` / `Ctrl+Y` undo and redo through VS Code's own custom-document plumbing — the
designer contributes no key of its own for either. One gesture is one undo entry; see
[Editing model and safety gates](Editing-model-and-safety-gates).

## Canvas shortcuts

These are handled inside the canvas itself and are not rebindable. Every one of them is ignored while the focus
is in a text field, a dropdown or a text area, so typing a property value never triggers a canvas gesture.

| Key | Does |
|---|---|
| `F7` | View Code |
| `F2` | Rename. A selected menu/toolbar item first, then the current component. Refused on the form, on a separator, and on a read-only, inherited or unresolved component |
| `Delete` | Delete the selection. A selected menu/toolbar item is deleted instead of the control that owns it |
| `Ctrl+A` | Select every sibling in the current design scope — selection only, nothing is written |
| `Tab` / `Shift+Tab` | Next / previous sibling, wrapping |
| `Esc` | Select the parent container. Suppressed while the context menu or a menu flyout is open — there it closes them |
| `Arrow` | Move the selection 1 logical pixel |
| `Ctrl+Arrow` | Move by one grid cell (`winformsDesigner.gridSize`) |
| `Shift+Arrow` | Resize by 1 pixel — single, resizable selection only, minimum 4 px |
| `Ctrl+Shift+Arrow` | Resize by one grid cell |
| `Ctrl+X` / `Ctrl+C` / `Ctrl+V` | Cut / Copy / Paste |
| `Ctrl+D` | Duplicate in place, without touching the Cut/Copy clipboard |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | Zoom in / out one step, reset to 100 % |
| `Ctrl`+mouse wheel | Zoom by a factor of 1.1 per notch |
| `Ctrl`+drag | Duplicate the selection at the drag offset instead of moving it |
| `Alt`+drag | Free placement — snapping is off for that gesture. The modifier is configurable, see `placementSnapOverrideModifier` |
| `Ctrl`/`Shift`+click | Add or remove a control from the multi-selection. The form itself is never added to one |
| `Enter` / `Esc` | Commit / cancel an inline editor (a "Type Here" menu slot, an item rename, a component-tray rename) |

A run of arrow presses is one undo entry: the moves apply optimistically on screen and commit once, 250 ms after
the last key. Arrows are refused when any selected control is locked, and when the host has not granted movement
for that selection — a docked control or a child of a `TableLayoutPanel` cannot be nudged, because its position
is not written as a `Location`. The context menu shows these accelerators next to its items: **View Code** `F7`,
**Cut** `Ctrl+X`, **Copy** `Ctrl+C`, **Paste** `Ctrl+V`, **Duplicate** `Ctrl+D`, **Delete** `Del`, and for a
selected menu item **Rename** `F2` and **Delete Item** `Del`.

In the side panel, `Delete` deletes the canvas selection (the canvas owns the selection, so the panel forwards
it). In the Document Outline, arrow keys move and expand, `Enter` or `Space` selects, `F2` renames, and
`Alt+Home` / `Alt+End` (or `Ctrl+Home` / `Ctrl+End`) send the node to front or back.

## Settings

Thirteen settings, all under the `winformsDesigner.` prefix. **Resource** scope means you can set it per
workspace folder or per file in `.vscode/settings.json`; **window** scope means it applies to the whole window.

| Setting | Default | Values | Scope | Effect |
|---|---|---|---|---|
| `autoOpenDesigner` | `true` | boolean | resource | Opens the designer when a form `.cs` becomes the active editor, mirroring Visual Studio. **View Code** suppresses it until you reopen the file. Turn it off to keep the text editor and open the designer manually |
| `assemblyPath` | `""` | string | resource | Explicit path to the built control assembly (`.dll`). Leave empty to auto-discover the build output. A leading `~` expands to your home directory and a relative path resolves against the workspace folder; environment variables are **not** expanded. A path that does not exist produces a warning and falls back to auto-discovery |
| `layoutMode` | `"snapLines"` | `snapLines`, `snapToGrid`, `none` (shown as **SnapLines**, **Snap to Grid**, **None**) | resource | Placement mode for move and resize gestures |
| `gridSize` | `8` | integer, 2–128 | resource | Grid cell size in logical WinForms pixels, used by Snap to Grid, **Align to Grid**, the spacing commands and `Ctrl+Arrow` |
| `showGrid` | `false` | boolean | resource | Draws the placement grid inside the form's exact client area. Independent of `layoutMode` |
| `placementSnapOverrideModifier` | `"alt"` | `alt`, `control`, `shift`, `disabled` (**Alt**, **Control**, **Shift**, **Disabled**) | resource | The key that turns snapping off for the current drag. Set it to **Disabled** to always keep snapping on |
| `toolbox.autoDiscoverProjectControls` | `true` | boolean | resource | Discovers toolbox-eligible controls in the workspace's build-output directories. Discovery starts only after a designer opens and runs under file, depth and time budgets; details go to the output channel. Turn it off to use only the engine baseline plus **Choose Toolbox Items** |
| `net48.probeDirectories` | `[]` | array of strings | window | Extra directories the .NET Framework engine searches when a control's assembly is not found. Absolute paths (a leading `~` expands); missing directories are ignored. Takes effect after **Reload Window**, and assemblies found here are loaded and executed on preview, so it is honored only in a trusted workspace |
| `net48.releaseOnFocusLoss` | `false` | boolean | window | Releases the .NET Framework build output whenever VS Code loses focus. Mostly superseded by `net48.releaseOnExternalBuild`; off by default because releasing unloads the preview and the next edit waits for the assembly graph to load again |
| `deleteFormSiblings` | `true` | boolean | resource | Deleting `Form1.cs` also removes `Form1.Designer.cs`, `Form1.resx` and any `Form1.<culture>.resx` in the **same** operation — one confirmation, one undo. Files that are not generated for the form, including a `.resx` whose middle segment is not a culture, are never touched |
| `net48.isolateRenderWindows` | `true` | boolean | window | Runs the .NET Framework preview engine on a private desktop that is never displayed, so a form's own `Load`/`Shown` code cannot put windows on your screen. Rendering is unaffected. Takes effect after the preview engine restarts |
| `net48.releaseOnExternalBuild` | `true` | boolean | window | Hands the .NET Framework build output back when a build started **outside** VS Code is about to overwrite it, so that build is never blocked by `MSB3027`. Previews go view-only until the build lands, then re-render from it |
| `language` | `"en"` | `en`, `ru`, `zh-cn`, `fr`, `de`, `es`, `hi` | window | The language of the designer's own interface — see below |

Changing `layoutMode`, `gridSize`, `showGrid` or `placementSnapOverrideModifier` reaches the open canvas
immediately; no reload is needed. The three `net48.*` engine settings and `language` need the engine or the
window to restart, as their descriptions say. The `net48.*` settings only matter for `net4x` projects — see
[.NET Framework and DevExpress](Framework-and-DevExpress).

One interaction is worth knowing: with `placementSnapOverrideModifier` set to `control`, a `Ctrl`+drag is
treated as **Duplicate** and takes precedence, so it does not act as a snap override for a move.

## The interface language

`winformsDesigner.language` is chosen **in these settings**. It does not follow VS Code's display language, and
there is no "auto" value: the default is `en`, and any unsupported value falls back to `en`.

1. Set `winformsDesigner.language` to one of `en`, `ru`, `zh-cn`, `fr`, `de`, `es`, `hi`.
2. The open designer and panel rebuild at once, so the canvas, property grid, toolbox and status messages switch
   language on the spot.
3. A notification appears — *"WinForms Designer language changed. Reload the window to apply it everywhere."*
   with a **Reload Window** button. Take it to switch the rest.

What the reload is for: the Command Palette titles (**WinForms: Open Designer** and friends), the settings page
itself and the view names come from the extension manifest, which VS Code resolves against its own **Display
Language**, not this setting. That is a platform limitation, not a gap in the catalogs — so a Russian designer
UI under an English VS Code keeps English palette titles. Property *values* are never translated either: an enum
member or a colour name is committed exactly as it is written into your source.

## Diagnostics and the output channel

The extension writes to an output channel named **WinForms Designer** (View → Output, then pick it from the
dropdown). It records: each render and its result, every edit the safety gates refused and which gate refused
it, toolbox auto-discovery scans and their budgets, engine start/stop/release lifecycle, and the .NET Framework
compiled-preview disclosure (deduped, so it is logged once per form rather than per render).

**WinForms: Export Designer Diagnostics** produces a full report as an **untitled Markdown document** — it never
writes a file, so it raises no permission prompt and you decide whether to save it. It gathers the extension,
VS Code, platform and Node versions, the engine entry point, ping time, PID and capabilities, the lifecycle of
both engines (starts, last startup time, recent crashes, last exit), the active document and its resolved
designer file, the effective settings, the designer graph (root type, component count, representable statements)
and the toolbox count. Every probe is guarded, so a dead engine still produces a usable report.

When a render is only partial, the canvas shows a diagnostics banner with **Show details** / **Hide details**,
a **Dismiss** ×, and four actions: **Retry**, **Rebuild** (runs **WinForms: Run Build Task (Release Preview
First)**), **Choose Control Assembly…** and **Copy Diagnostics**. The copied text comes from the host's own
retained state. For what the individual entries mean, see [Troubleshooting](Troubleshooting).
