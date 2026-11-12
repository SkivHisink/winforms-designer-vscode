# Release 2.3.4: forms that showed nothing, vendor values from the build, one project choice per folder, ImageLists, and one engine across clicks

Date: 2026-11-12  
Status: **PREPARED — engine and extension checks pass on the final tree; the Extension Host suites run in CI on the release commit**

Patch release over 2.3.3 (tag `v2.3.3`, commit `8669cb6`). Under the maintenance rule
[R20-04](roadmap-2.0.0-to-3.0.0.md#200--20x--fix-the-baseline-and-maintain-it), a patch release carries fixes for
breakage of existing workflows. This one fixes .NET Framework forms that showed no preview at all, the vendor values
that sent ordinary DevExpress-style forms to the last build, an engine failure that reached the user as a bare code,
a project choice that had to be repeated for every form of a shared folder, a new engine started for every click on
projects with large build outputs, ImageLists that drew nothing in the modern engine, and tray and text-box behaviour
unlike Visual Studio's. No generated protocol or dependency changed; the engines' tray result carries one more field.
The interpreter allowlists in `DesignerAllowlists.cs` are unchanged; two rules are added beside them, a build-witnessed
value for the .NET Framework engine and `Images.SetKeyName` on an exact `ImageList` (below). The .resx trust gate admits
one binary payload, an ImageList's `ImageStream`, under the checks below. The edit-minimality gates and identifier
validation are untouched.

## Defects

1. **No preview at all.** A .NET Framework form whose source the interpreter could not fully reproduce fell back to
   its last build; when the build could not be constructed either — a constructor, the form's or a child control's,
   that asks the running application for a service and gets nothing in the designer — the render failed with
   `UNHANDLED_EXCEPTION` and the canvas stayed empty. Visual Studio shows such a form, without the parts that failed.
2. **The reason was lost.** The engine composed a message naming both failures, but the request envelope carries only
   the outcome code, so the Output channel showed `UNHANDLED_EXCEPTION` and nothing else.
3. **Vendor values sent forms to the last build.** `new EditorButton(ButtonPredefines.Combo)` inside
   `Properties.Buttons.AddRange(…)` — what every DevExpress-style combo box writes — is a value of a type no allowlist
   names, so the statement was unrepresented and the whole form fell back to its last build, running the form's own
   constructor; a form with such a value and a constructor that needs the application had no preview at all.
4. **One project choice per form.** A shared or linked folder compiled by several projects made each of its forms ask
   which project to use, again for every form, although the choice is almost always the same for the whole folder.
5. **A new engine for every click.** An engine is reused only for the same build output, proven by a digest of every
   file that output can load, read within one request's budget (100 ms, 64 MB, 16 MB a file). A log folder or a
   publish copy beside the build exhausted the folder walk, a `runtimes/<rid>/lib/<tfm>` tree was deeper than it
   allowed, and an output with large vendor or native libraries (a reported project: 98 files, 446 MB, the largest
   201 MB) exceeded the byte budget. The proof failed on every request, so no engine could be reused and every click
   started a new one — on .NET Framework a new domain that loaded the form again.
6. **Each click loaded the form twice.** A selection's properties and its move and resize rights each loaded the whole
   form (about 200 ms each on an 850-statement form).
7. **ImageLists drew nothing in the modern engine.** Visual Studio saves an ImageList's images as a BinaryFormatter
   `ImageStream` node, which the .resx trust gate refused; `Images.SetKeyName`, written once per image, was
   unrepresented; and `Images` did not appear in the Properties grid, which leaves out a `Hidden` property.
8. **Tray and text boxes unlike Visual Studio.** ListView and DataGridView columns appeared as tray chips, and a
   multiline text box could not be resized, because a text box is always AutoSize.

## Change

- **Partial preview** (`engine/DesignerIrExecutor.cs`, `engine-net48/RenderWorker.cs`). The order is: the complete
  interpretation, then the compiled build, then — only when the build cannot be constructed — a partial replay of the
  source, Visual Studio's *Ignore and Continue*. A component whose constructor throws (a design-time license gate
  included) is recorded instead of ending the replay. A failed control gets an engine-owned placeholder that takes
  only the geometry and the parent the source gives it (`Location`, `Size`, `Dock`, `Anchor`, `Margin`, minimum and
  maximum size, `Name`, `TabIndex`, `Visible`, and the same keys from a localized form's resources through the safe
  resolver); it paints no background, so the controls that did build show through it. Every other statement that uses
  a failed component is not applied; statements about the failed component alone are counted on its line, and those
  that would have changed a component that built are listed. A placeholder no parent accepts (a `TabControl` takes only
  tab pages) is named as not shown, with everything inside it. Every other failure stays as hard as in the complete
  interpretation: validation, identity, unresolved types, refused values, a setter or an init call that throws. A
  failed name that hides a component of the compiled base is the same identity collision it would be had it built.
  The result is the mode `interpretedPartial` with the reason `partialInterpretation`; it is never reported as a
  complete interpretation. The build's construction failure is remembered for that build, so an edit, which renders
  the source again, does not run the failing constructor again; a rebuild, closing the form or **Retry** forget it,
  and Undo keeps it.
- **The host treats the partial canvas as the live source.** Describes, tab clicks and structural edits go through the
  interpreter, never through a compiled instance; every edit renders the committed source again (the engine refuses to
  edit a partial graph in place). A placeholder is described with no properties, events or actions and a read-only
  reason; it cannot be moved, resized, deleted, cut, copied, duplicated, reordered, used as a parent or as a drop
  target, and the hosted-designer probe skips it. A persistent notice (in all seven languages) marks the canvas as
  partial, also when the form is localizable; the diagnostics list names every omission. Save writes the in-memory
  source as it is.
- **Build-witnessed values** (`engine-net48/BuildConstructionWitness.cs`). The front-end keeps such a statement a gap
  and attaches the same statement as a *witness candidate*. Only the .NET Framework engine uses candidates. It reads the
  designed type's compiled `InitializeComponent`: a construction is witnessed when some path reaches it, every
  argument is a constant loaded immediately before it (with the widening conversion the compiler adds, applied as the
  runtime applies it to the stack value), and no branch, `switch` or exception handler enters those instructions or
  the construction. Before anything runs, every value of the source statement — all elements of an `AddRange` — must
  be such a construction: the same constructor (its metadata identity), the argument types exactly the parameter
  types, and the same constant values; a `null` argument only where the type has a single constructor, since C#
  binds `null` to the most specific overload, and no constructor of the type with an overload resolution priority.
  Every name — the type's and each enum argument's — must bind as C# binds it: no namespace of the file may make it
  another type, its first part may not be a member of the form or of a type enclosing it, nor a type nested in one
  of their base types, and a designer file with a using alias, a static import or an extern alias gets no
  build-witnessed values at all. A type whose constructors carry custom modifiers is not taken. The value must reach
  its use unconverted: the value of a property
  assignment or a collection add, or an element of the array that is that value and holds it as it is — never under
  a cast or inside another construction, factory, extender or tree-node value. The type must not be abstract,
  generic, a component, a delegate, a framework type or a type of the platform's assemblies, and the arguments must
  be constants the replay reads exactly as the compiler does: null, `bool`, `char`, `string`, enum members and integer
  literals (not a negated unsigned one); floating and decimal literals are not taken.
  The statement is then replayed whole, each value through the build's own constructor; otherwise it stays the gap it
  was, with nothing of it run: a complete interpretation falls back as before, with the same reason, and a partial one
  lists it. The modern engine, the coverage figures, the regeneration checks and the owned-region planner see these
  statements exactly as before. This change sets the IR schema version to 5; the ImageList change below sets it to 6.
- **Fault reasons in the Output channel** (`engine/RuntimeProtocol.cs`). When an engine method throws, the exception
  chain is written to the engine's error stream on one line, which the host copies to the Output channel next to the
  outcome code. The reply itself is unchanged.
- **One project choice per folder** (`extension/src/designerEditor.ts`). A project chosen for a form also becomes the
  choice for its folder and the folders below; the nearest folder with a choice wins. A form with no choice of its own
  that several projects compile takes it when the engine lists that project among the form's owners, proves membership
  again with it, and keeps it as its own choice. Forms already open and waiting for a choice render at once. A form's
  own choice wins, and a stale choice is refused, as before.
- **Dependency identity** (`extension/src/outputDependencyIdentity.ts`, `extension/src/dependencyGraphIdentity.ts`).
  The output walk reads only what the loaders load: the output's own files, the `runtimes` tree, the satellites of
  every assembly found (`<culture>/<name>.resources.dll`, and .NET Framework's `<culture>/<name>.resources/…`), .NET
  Framework's `<name>/<name>.dll` probing, and the `privatePath` folders and `codeBase` files of the configuration the
  .NET Framework engine gives the domain, decoded as XML (byte order mark or declared encoding). A code base that is
  not a file, or a configuration the walk cannot decode, leaves the graph unproven. Each file's digest is kept with the
  snapshot it was read under (device, file id, size, write, change and creation times) and reused while that snapshot
  is unchanged; a file written less than 2 s before its read began is not kept. A file over a request's budget is
  digested in the background, and the graph stays unproven until it is. A write through a memory-mapped view changes
  no snapshot field, so a kept digest whose read began 30 s ago is read again in the background whenever a request
  uses it; a different result changes the identity, and a failed read drops the digest (see Limitations).
- **Kept read-only graphs** (`engine/DesignerRenderer.cs`, `engine/ProjectResourceResolver.cs`). Describing a component
  and starting a geometry gesture each keep the last graph they loaded, in separate slots, because the geometry start
  creates window handles. A graph is kept only when the host passes the build, and reused only for the same document,
  source text and assembly while the design culture, the form's .resx chain, the assembly, the places its portable PDB
  is looked for, every file and folder of the owning project, and every project file the resource reader read (checked
  as that read checks it, never beneath a refused link) are unchanged. Any other load drops both; a graph that cannot
  be kept is disposed when its call ends.
- **ImageList** (`engine/SafeResxResolver.cs`, `engine/DesignerIr*.cs`, `engine/DesignerRenderer.cs`,
  `engine/DesignerDescribe.cs`). On the modern engine only, the .resx trust gate admits an `ImageStream` whose records,
  read as data (`System.Formats.Nrbf`, never BinaryFormatter), are exactly an `ImageListStreamer` with one byte array,
  and whose bytes are an image list in Visual Studio's layout — the version 0x101 header, an image size of 1 to 256,
  a capacity within the image budget, a four-column image bitmap and a 1-bit mask of the size the header implies, and
  every pixel byte present — before Windows Forms' own constructor and comctl32 read them. Any other binary payload is
  refused as before. `Images.SetKeyName` is replayed with literal arguments on an exact `ImageList` by both engines
  (IR schema version 6 for the .NET Framework engine's interpreted path); a key for an image that did not load is
  listed. `Images` is listed in the modern grid, with the ImageList editor behind its "…".
- **Tray and text boxes** (`engine/DesignerRenderer.cs`, `engine-net48/RenderWorker.cs`, `engine/DesignerGeometry.cs`,
  `extension/media/*.js`). A `[DesignTimeVisible(false)]` component is marked, not dropped: the canvas draws no chip
  for it and keeps it selectable, and the Properties view's component list now offers every non-visual component.
  AutoSize no longer blocks resizing a text box; a single-line one keeps its height (left and right grips only, none
  when docked to the top or bottom, and the commit refuses that height change).

Unchanged: what may be constructed or read by the modern engine; besides the rules above, nothing more may be invoked.
The sample forms, the Visual Studio reference fixtures and every form that already rendered render as before, except
that an ImageList with an `ImageStream` now holds its images (verification below).

## Independent review

The ordering of the partial preview was settled over two rounds: the first proposal put the partial replay before the
compiled build; the second, measuring that the compiled build keeps its live edits across ordinary renders, kept the
build first so that no form with a picture today changes. Adversarial review of the result found, and the change
fixes and tests:

- a placeholder offered to a `TabControl` (or a tab page placed into a placeholder) threw and ended the whole partial
  replay;
- a failed component named like a component of the compiled base produced two controls with one id;
- placeholders that the canvas showed as read-only could still be deleted, reordered, copied or duplicated through the
  host's commands;
- a localized form's placeholders had no size, because their geometry is in the resources;
- Undo and Redo forgot the construction failure and ran the failing constructor again;
- a localizable partial preview lost its partial notice under the localization notice.

The build witness was reviewed the same way, with reproductions against the built engine, until a round found nothing
that blocks. It found, and the change fixes and tests:

- a constant run entered by a branch: `new X(flag ? 2 : 1)` compiled to two constant arms joining at the
  construction, and the witness took the arm listed last as the argument;
- a `conv.r8` folded through `float` and a `conv.u8` that truncated an existing 64-bit constant, so the witness
  admitted a value the build never passes;
- a construction in unreachable code taken as one the build makes, also inside a protected block no path enters and
  after a `jmp`;
- a `null` argument matched to a constructor other than the overload C# binds `null` to, also where the overload
  C# prefers has optional parameters or a params collection;
- a constructor chosen by exact parameter types where an overload resolution priority makes C# choose another;
- a dotted name the file's namespaces make into another type (`Vendor.Value` inside a namespace that has its own
  `Vendor.Value`), and an enum-shaped argument whose first name is a member of the form (`Kind.One` read through a
  field `Kind`), both taken as the type the name spells out from the root — also through a using alias, a static
  import, a member of a type enclosing the form, or a type nested in a base form;
- overloads told apart only by custom modifiers in a vendor's metadata, between which C# prefers the plainer one;
- an `AddRange` element of another type than its array, whose conversion the replay dropped when it added the
  elements one by one;
- arguments the .NET Framework reads differently from the compiler — a negated unsigned literal (`-0U`, a `long` in
  C#), a negative zero, floating literals its parser rounds otherwise, even some that format back to the same text —
  matched to a construction of another value;
- a witnessed value under a cast, or inside an allowlisted construction or factory, which the replay converted
  through `IConvertible` where C# calls the type's own conversion operator;
- a refusal discovered while the statement ran — after receiver getters, `CanExtend` or an earlier element's
  constructor — and an `AddRange` left half applied. Every value of a statement is now authorized before any of it
  runs, and the statement is replayed whole or not at all.

The last round reproduced every earlier case against the final engine and found nothing in the witness itself. What
it still reproduced is the .NET Framework interpreter's general binding of names and members — the same for an
ordinary property value as for a witnessed one — listed under Limitations.

The dependency identity, the kept graphs, the ImageList gate and the tray were reviewed over eight further rounds,
with reproductions against the built engines and the reported 446 MB output, until a round found no defect in the
product code. Found, fixed and tested: a tray-hidden selection dropped by the canvas on re-layout; component names
that are members of `Object.prototype`; project resources, project sources, an external portable PDB and an
auto-discovered assembly left out of a kept graph's key; a resource read's file queried before its containment and
link checks; graphs left undisposed when nothing could be kept; `codeBase` files, satellite layouts, XML entities,
UTF-16 and long declarations missed by the output walk; a kept digest made stale by a write through a memory-mapped
view; the recent-write guard measured at the end of a slow read; a background read that read before checking its path
again; a failed re-read that left an overdue digest usable; a wall clock set back delaying re-reading; an older
failed re-read deleting a newer digest; and a backstop that kept slow successful reads from ever proving a graph. The
same review agreed to keep a digest across requests at all — the one exception to proving the bytes for each request
— with its residual stated as below.

## Limitations

- A placeholder shows nothing of what it stands for: no contents, properties, events or smart tags. A healthy control
  that only a failed container (or a failed container's panel) could hold is listed, not drawn.
- A partial preview renders the whole source again for every edit; the fast in-place edit of the complete
  interpretation is not used.
- The build witness reads `InitializeComponent` as straight-line code: a construction counts only when every argument
  is a constant loaded immediately before it on a path no branch joins. A value built by a helper method, an argument
  that is an expression or chosen by a branch (`flag ? A : B`), an argument converted to another type than the one
  written, a floating or decimal argument, a `null` argument of a type with several constructors, and a value under a
  cast or inside another construction stay unrepresented, and so does every value of a statement one of whose values
  is. An argument
  changed since the last build stays unrepresented until the next build. The modern engine does not construct such
  values.
- Unchanged since 2.3.3: the .NET Framework interpreter resolves the names a statement writes against the compiled
  assemblies by their text and the file's namespaces; the build witness adds the checks above for the values it
  admits, but a name whose meaning depends on a global using alias in another file of the project is read as written.
- Unchanged since 2.3.3: the .NET Framework interpreter binds the member a statement calls on the object's runtime
  type, not on the type the source names. A property setter hidden with `new` in a derived type, an explicit interface
  implementation beside a public member of the same name, or a collection whose `Add` overloads differ from its
  `IList.Add` can therefore run another member than the compiled form does — for any value, including a
  build-witnessed one. The build witness guarantees which constructor runs with which arguments, not which member then
  receives the value.
- The folder choice is stored per workspace and applies only to a form that several projects compile and that has no
  choice of its own.
- The Output channel shows the reason of an engine failure; the notification still shows the outcome code.
- The dependency identity is the one place where reuse rests on kept evidence rather than on bytes read for the
  request. A write through a memory-mapped view moves no file time, so it is noticed eventually while the designer is
  in use — the re-read waits for a request, the queue and the read itself, so there is no time bound — and a mapped
  write that an engine loads and that is undone before the re-read is not seen. A native image or a .NET Framework
  assembly an engine has loaded cannot be written while it is loaded; an assembly the modern engine read into memory
  can.
- A graph is kept between clicks only when the host passes the build; without one, every click loads the form, as
  before.
- The ImageList gate admits only Visual Studio's version 0x101 layout; another layout stays refused. The .NET Framework
  engine still reads `ImageStream` only from the compiled build.
- The single-line text-box rule is the modern engine's; the .NET Framework canvas offers every grip, as before.

## Verification

On the final tree:

- Modern engine suite **1109/1109**, .NET Framework engine suite **147/147**. For the first part of the release, 32
  new: the partial replay, the placeholders, the worker's ordering and memory of the construction failure, and the
  build witness — hand-written IL for each control-flow and conversion case, the authorization of whole statements,
  and an end-to-end compiled form for a witnessed value, an edited argument, a construction made outside
  `InitializeComponent` and an argument chosen by a branch. For the second, 50 new: the ImageList gate against Visual
  Studio's payloads and every malformed layout, `SetKeyName` in both execution paths, the tray flag in both engines,
  the text-box grips, and the kept graphs — a geometry start beside a describe, a changed .resx, a replaced
  resource file inside a dot folder, a PDB appearing beside an external build, the project stamp, and a resource read
  refused outside the project or beneath a link. Each of the kept-graph checks was also run against the code with its
  part of the key removed, and failed.
- Every one of the repository's 133 designer files renders through the modern engine exactly as with the 2.3.3
  engine (PNG and layout listing; the three files that are not forms fail with the same message, which differs only
  in the build folder and line numbers in its stack trace), and all 32 of them that belong to projects with a .NET
  Framework build render through the .NET Framework engine byte for byte as with 2.3.3. No form of the repository has
  a vendor value the witness admits, a constructor that throws or a valid `ImageStream`, so none of them changes.
- The dependency identity against the reported project's real output (98 files, 446 MB): the walk is complete in
  about 15 ms; the first request is unproven while the background digests the large libraries (0.5–2 s); every later
  request has the same content identity, in about 15 ms. On Windows, a write through a memory-mapped view is
  reproduced in a test: it moves no file time, and the identity follows it once the digest is read again.
- The form that motivated the release, a vendor-style user control whose own constructor and whose three cone
  controls ask the running application for a service, rendered with the 2.3.3 engine to `UNHANDLED_EXCEPTION`; with
  2.3.4 it renders as a partial preview with the three cones as placeholders, its two combo boxes with the editor
  buttons the build witnesses.
- The archived Visual Studio reference comparison passes; the coverage gate over `engine/samples` is 91.43%
  (unchanged); the Adapter SDK contract, type contract and samples, the static scenario catalog, the generated
  protocol check, the release metadata preflight (`--metadata-only`) and the VSIX isolation tests pass.
- Extension unit tests **951/955**, webview end-to-end **1,047 checks**, headless end-to-end with the .NET Framework
  legs required, typecheck, build, performance baseline, webview syntax, mojibake scan and strict localization parity
  pass. The four other unit tests, of the adapter runtime's process cleanup (a module this release does not change),
  time out on the machine they ran on, whose process enumeration stopped responding during the run; they passed on
  the same tree earlier that day.
- The Extension Host suites, pinned to four processors as on the CI runner: the Release 2.2, 2.3 and 2.4 acceptance
  suites pass on VS Code 1.84 and Stable. The two smoke suites failed in two runs each on that loaded machine, each
  time in another scenario and each time on a wait or a deadline: an MSBuild evaluation past its request deadline,
  performance budgets exceeded by under 3 %, a project file held open while the test rewrote it, and a property value
  not published before the wait ended. CI on the release commit runs them on a quiet runner.

Not executed on the final tree: the Designer SDK ABI probe, the VSIX packages and the installed upgrade/downgrade;
CI on the release commit runs them. No VSIX hash is bound here; the release workflow builds and publishes both
packages from the tagged commit.

## Publication

1. Commit the release tree and push it; CI must pass every step.
2. Tag `v2.3.4` on that commit and push the tag. The release workflow checks the tag against the version, builds both
   VSIX packages, and publishes them with the `2.3.4` changelog section as release notes.
