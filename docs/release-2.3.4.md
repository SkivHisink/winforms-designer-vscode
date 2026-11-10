# Release 2.3.4: forms that showed nothing, vendor values from the build, and one project choice per folder

Date: 2026-11-10  
Status: **PREPARED — engine and extension checks pass on the final tree; the Extension Host suites run in CI on the release commit**

Patch release over 2.3.3 (tag `v2.3.3`, commit `8669cb6`). Under the maintenance rule
[R20-04](roadmap-2.0.0-to-3.0.0.md#200--20x--fix-the-baseline-and-maintain-it), a patch release carries fixes for
breakage of existing workflows. This one fixes .NET Framework forms that showed no preview at all, the vendor values
that sent ordinary DevExpress-style forms to the last build, an engine failure that reached the user as a bare code,
and a project choice that had to be repeated for every form of a shared folder. No protocol or dependency changed. The
interpreter allowlists in `DesignerAllowlists.cs` are unchanged; one rule is added beside them, for the .NET Framework
engine only (below). The edit-minimality gates and identifier validation are untouched.

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
  statements exactly as before. The IR schema version is 5.
- **Fault reasons in the Output channel** (`engine/RuntimeProtocol.cs`). When an engine method throws, the exception
  chain is written to the engine's error stream on one line, which the host copies to the Output channel next to the
  outcome code. The reply itself is unchanged.
- **One project choice per folder** (`extension/src/designerEditor.ts`). A project chosen for a form also becomes the
  choice for its folder and the folders below; the nearest folder with a choice wins. A form with no choice of its own
  that several projects compile takes it when the engine lists that project among the form's owners, proves membership
  again with it, and keeps it as its own choice. Forms already open and waiting for a choice render at once. A form's
  own choice wins, and a stale choice is refused, as before.

Unchanged: what may be constructed, read or invoked by the modern engine; the sample forms, the Visual Studio reference
fixtures and every form that already rendered render as before (verification below).

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

## Verification

On the final tree, without opening VS Code windows, every step of `ci.yml` except the Extension Host suites:

- Modern engine suite **1066/1066**, .NET Framework engine suite **140/140** (32 new: the partial replay, the
  placeholders, the worker's ordering and memory of the construction failure, and the build witness — hand-written IL
  for each control-flow and conversion case, the authorization of whole statements, and an end-to-end compiled form
  for a witnessed value, an edited argument, a construction made outside `InitializeComponent` and an argument chosen
  by a branch).
- Every one of the repository's 133 designer files renders through the modern engine exactly as with the 2.3.3
  engine (PNG and layout listing; the three files that are not forms fail with the same message, which differs only
  in the build folder named in its stack trace), and all 32 of them that belong to projects with a .NET Framework
  build render through the .NET Framework engine byte for byte as with 2.3.3. No form of the repository has a vendor
  value the witness admits or a constructor that throws, so none of them changes mode.
- The form that motivated the release, a vendor-style user control whose own constructor and whose three cone
  controls ask the running application for a service, rendered with the 2.3.3 engine to `UNHANDLED_EXCEPTION`; with
  2.3.4 it renders as a partial preview with the three cones as placeholders, its two combo boxes with the editor
  buttons the build witnesses.
- The archived Visual Studio reference comparison passes; the coverage gate over `engine/samples` is 91.43%
  (unchanged); the Adapter SDK contract, type contract and samples, the Designer SDK ABI probe, the static scenario
  catalog, the generated protocol check, the release metadata preflight (`--metadata-only`) and the VSIX isolation
  tests pass.
- Extension unit tests **932/932**, webview end-to-end **1,047 checks**, headless end-to-end with the .NET Framework
  legs required, typecheck, build, performance baseline, webview syntax, mojibake scan and strict localization parity
  pass.
- Both VSIX packages build and pass `assert-vsix.ps1` (x64 and ARM64 targets).

Not executed on the final tree: the Extension Host suites and the installed upgrade/downgrade, which open VS Code
windows; CI on the release commit runs them. No VSIX hash is bound here; the release workflow builds and publishes
both packages from the tagged commit.

## Publication

1. Commit the release tree and push it; CI must pass every step.
2. Tag `v2.3.4` on that commit and push the tag. The release workflow checks the tag against the version, builds both
   VSIX packages, and publishes them with the `2.3.4` changelog section as release notes.
