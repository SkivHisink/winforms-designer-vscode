# Release 2.3.3: constants as the compiler folds them, and resources read without running what the file chooses

Date: 2026-11-09  
Status: **PREPARED — engine checks pass on the final tree; the extension and Extension Host suites run in CI on the release commit**

Patch release over 2.3.2 (tag `v2.3.2`, commit `ec969e2`). Under the maintenance rule
[R20-04](roadmap-2.0.0-to-3.0.0.md#200--20x--fix-the-baseline-and-maintain-it), a patch release carries fixes for
breakage of existing workflows. This one closes issue [#9](https://github.com/SkivHisink/winforms-designer-vscode/issues/9)
(constant expressions evaluated exactly as the C# compiler evaluates them), a trust defect in how the modern engine read
a localized form's `.resx`, and the statements the interpreters applied although the compiler rejects them or the
compiled form behaves otherwise. It also carries two defects the reporter of
[#8](https://github.com/SkivHisink/winforms-designer-vscode/issues/8) found in real projects after 2.3.2, with an
analysis and a patch: simplified-style forms of projects that import MSBuild files, and the high-DPI preview. No
protocol or dependency changed. The interpreter allowlists in
`DesignerAllowlists.cs`, the edit-minimality gates and identifier validation are untouched. The list of `.resx` value
types is extended by the scalar types of the properties Windows Forms marks localizable (below).

## Defects

1. **Two constant folders.** The modern interpreter computed a value with its own rules, and the check against the
   project's build (2.3.2) folded constants with a second implementation. Where they disagreed, the build confirmed a
   statement and the preview applied another value. A corpus of constant expressions compiled by the C# compiler showed,
   against 2.3.2: 151 values and types the interpreter took differently from the compiled ones (`(int)-2.6` was −3, a
   zero constant for an enum property stayed an `int`), 2,353 expressions or assignments the compiler rejects that the
   interpreter applied (`byte` properties given 256, `1.5` truncated into an `int`), and 1,434 constants the build check
   folded differently (`(decimal)0.1F` as 0.100000001490116, `(float)ulong.MaxValue` as −1, `16777217 + 1F` as 16777218,
   `1u + 1` as a `long`). Operators the interpreter did not evaluate (`100 + 20`, `1 << 4`, `~0u`) were refused.
2. **The `.resx` decided which code ran.** The modern engine handed a typed `.resx` entry to the framework's resource
   reader, which resolves the type from the name and assembly written in the file and runs that type's converter. An
   entry typed `System.Drawing.Point, <another assembly>` resolved to a project type of that name, whose converter ran when
   the form was opened. The resolver shared with the .NET Framework engine never resolved types from the input, but its
   `ApplyResources` converted a value through the converter of the property's type, which a project type named like a
   framework one supplies.
3. **Statements applied in a shape other than the one written.** Among them: a bare name `Top` read as the property's
   enum member even where it is a constant of the form; `MaxLength = 1L + 1L`; `null` for a value type (set to its
   default); `Color.FromArgb((object)12, 0, 0)` and `new Point((object)12, 0)`, chosen by the runtime type of the boxed
   value; `new Point(1, 2) { X = 99 }` (the initializer dropped); `new Point(y: 1, x: 2)` (replayed positionally);
   `new[] { 1 }` given to a `string[]`; `(string)(object)2` converted to `"2"`; a cast to an unresolved type ignored; a
   statement with a syntax error replayed as the parser recovered it; `ApplyResources` without a `.resx` treated as a
   success; `GetString` of a non-string entry shown as empty text; a tree node built by guessing its constructor.
4. **Localized values set to defaults.** `char`, `LinkArea`, `Keys` and most localizable enums were outside the `.resx`
   types, so `PasswordChar`, `ShortcutKeys`, `BackgroundImageLayout`, `StartPosition` and similar values from a localized
   form's resources were left at their defaults or refused.
5. **Projects that import MSBuild files (#8).** A project file with an `<Import>`, a linked or wildcard `Compile` item or
   changed default item globs pulls in sources and `Using` items the designer's folder walk does not read. 2.3.2 then
   refused every name a simplified-style designer file leaves unqualified, so such forms, the usual shape of projects
   that share settings, rendered empty.
6. **The high-DPI preview (#8).** At a capture scale of 2, which the extension asks for whenever the display's device
   pixel ratio is above 1, both engines scaled the live form up with `Control.Scale`, drew it, and scaled it back.
   Measured: `Scale` leaves fonts at their size, so text and auto-sized controls were drawn at half the size of
   everything else, for every kind of root; a form's title bar and borders do not grow, so its client area sat
   offset from the hit-test map and the selection outline; Windows limits a captioned window to the screen's maximum
   tracking size, so a form that fits only at 1x was clamped and laid out again, and scaling back left it smaller than
   serialized (client 1400×900 became 1400×530) in the modern engine's retained graph and in the .NET Framework engine's
   cached instance, for every later render; the progress-bar overlay was placed in 1x coordinates on the 2x image.

## Change

- **One constant folder** (`engine/DesignerConstantFolder.cs`) serves the interpreter, which applies the value, and the
  build check, which compares it with the IL. It follows the C# rules: literals as the lexer types them; unary and binary
  operators chosen by overload resolution over the predefined operators, with the implicit conversions of an int or long
  constant and of a numeric zero to an enum; the enum operators; string concatenation and equality; explicit conversions;
  and the checked context constants are folded in unless `unchecked(…)` says otherwise. Where the compiler departs from
  the specification it follows the compiler, as the corpus measured: `-0x80000000` is an `int` (a `U` suffix keeps it
  unsigned); every folded NaN is stored as `double.NaN`/`float.NaN`; a zero of any numeric type but `char` converts to an
  enum; `U - E` applies only where `E - E` and `E - U` do not; `MinValue % -1` is 0. What the compiler rejects is refused,
  and so is a floating value cast in an unchecked context to an integral type it does not fit, which C# leaves
  unspecified. Names inside a constant are bound by each caller: the interpreter takes only an enum member named through
  its type; the build check also takes constant fields.
- **Values by their static types.** The interpreter decides from the syntax and from metadata, before evaluating, the
  type C# gives each argument, array length and cast operand. A factory call (`Color.FromArgb`, `FromName`,
  `FromKnownColor`) or an allowlisted construction picks the one applicable overload — a constant by the conversions of
  its value, anything else by those of its type — and calls exactly that overload; the `Font` character set accepts an
  `int` constant that fits a `byte`, such as `200 + 4`. A cast converts a number as C# does (checked: a value out of range
  is refused), casts an object or an interface by type (an instance, an unboxing to exactly its type, an enum from its
  underlying type), and is refused between types C# has no conversion between. A value goes to a property, parameter or
  element only by C#'s implicit conversion. `new[] { … }` takes the type of its elements; a length written with elements
  is an `int` constant equal to their count. `GetObject` is an `object` and `GetString` a `string`.
- **A gate before any path.** A statement the parser had to recover, or one with a named or `ref`/`out`/`in` argument, an
  object or collection initializer, or a generic member or method name, is refused before either engine looks at it
  (`DesignerIrBuilder.UnreplayedSyntax`). The CodeDom serializer writes none of them; across the 133 designer files of the
  repository the gate refuses no statement. The tree-node builder builds a node only through a `TreeNode` constructor
  chosen as above, from nodes built before it.
- **One trusted resource reader.** `SafeResxResolver` is the reader of both engines; the modern `ResxResolver` overlays
  the culture chain on it. Parsing is pure XML. A typed entry is served only for a type of a fixed registry, written with
  that type's own assembly (or a framework alias of it); its value is made from the invariant text by the registry type's
  own converter and must come back as exactly that type. Nothing the file names is loaded or run. The registry adds the
  scalar types of the properties Windows Forms marks localizable: `Char`, `LinkArea`, `Appearance`, `AutoSizeMode`, `Day`,
  `FlowDirection`, `FormStartPosition`, `HorizontalAlignment`, `ImageLayout`, `ImeMode`, `Keys`, `LeftRightAlignment`,
  `ListViewAlignment`, `Orientation`, `PictureBoxSizeMode`, `RichTextBoxScrollBars`, `ScrollBars`, `TabAlignment`,
  `TabAppearance`, `TableLayoutPanelCellBorderStyle`, `TextImageRelation`, `ToolStripItemImageScaling`, and on the .NET
  Framework `Shortcut`, `ToolBarAppearance` and `ToolBarTextAlign`. Binary, SOAP and file-reference entries stay refused;
  images and icons keep their size limits. `ApplyResources` checks every resource of a component before setting any and
  sets a property only to a value of its type; without a resource set, or with one that is not well formed, it is
  refused. `GetString` of an entry of another type, of a refused entry, or without a resource set is refused; a missing
  key is null, as `ResourceManager` returns it. The .NET Framework engine reads the culture chain the same way.
- **Global usings from the build.** For a project file that pulls in what the folder walk does not read, the modern
  engine still walks the folder, whose sources stay authoritative, and adds the global usings of the build it loaded,
  read from its portable PDB. The DLL must still be the loaded image (its MVID), and the PDB is the one next to it or
  embedded in it, matched to the DLL by its id. The PDB gives each file one scope holding the global usings and that
  file's own; a file of the project whose bytes still have the hash the PDB records is the text the build compiled,
  and when it declares every type whose methods the PDB attributes to it (a `#line` elsewhere can attribute others),
  removing its own usings leaves the global ones. The designer file's own usings are always its buffer's. A
  namespace import is taken; an alias makes its name refused; a `using static` of a top-level type is taken; any
  other import kind refuses. A part of the form linked in from outside the folder is known only through the build,
  so a bare `SuspendLayout()`, `ResumeLayout(…)` or `PerformLayout()` there is replayed only when the build proves
  it is `Control`'s: a partial method declared there without a body is erased with its calls and leaves nothing in
  metadata. The proof is made on the build's own text — the designer file while its bytes have the hash the PDB
  records — against the build's IL: the build calls that method of `Control` on the form itself (`ldarg.0`) exactly
  as many times as that text invokes the name on the form, bare or through `this` or `base`. An invocation compiles
  to at most one call, so equal counts mean that none was erased or bound to another method of that name; a receiver
  that might be the form in another way (a local, `as`, a call's result) proves nothing. The proof is kept for that
  build, and a current bare call written the same way is replayed. Every statement naming a type by inference is
  still confirmed by its IL. Without the build, its PDB, or a file unchanged since the build, the project's usings and
  sources stay unknown exactly as in 2.3.2, with the reason.
- **High-DPI capture by pixels** (`engine/CapturePixels.cs`, shared by both engines). Every capture draws the tree at its
  own size; for a scale above 1 each pixel becomes a block of that scale. The tree is never rescaled. A block depends
  on one pixel only, so a dirty patch scaled alone is the same bytes as that area of the scaled full frame, and the
  hit-test map is exact. The 1x capture is unchanged byte for byte.

Unchanged: what may be constructed, read or invoked is decided by the same allowlists; the Visual Studio reference
fixtures and the sample forms render and describe exactly as with 2.3.2.

## Independent review

Adversarial review rounds of the change ran until a round found nothing. They found, and the change fixes and tests:

- the bare-name enum guess (`Top + 4` with a form constant `Top` rendered 5 instead of 6), which the first draft of the
  folder had extended to compound expressions; it is now refused everywhere;
- a value-preserving explicit conversion accepted for an assignment (`MaxLength = 1L + 1L`), and a corpus check that
  accepted it; only implicit conversions are taken, and the corpus requires refusal;
- the resource reader running a converter of a type the file names, found while the extension of the resource types
  was being agreed; the reader was rebuilt on a fixed registry before any type was added;
- statements the compiler rejects reaching the shared .NET Framework executor once the new resource types were admitted
  (`this.ImeMode = resources.GetObject(…)`, `(long)resources.GetObject(…)` of a `Keys` entry,
  `(long)(object)resources.GetObject(…)`); the executor now types a resource as `object`/`string` and casts it by type;
- byte arrays as the resource writer stores them (typed, without MIME), which a draft refused; a broken `.resx` read as an
  empty resource set; `GetString` without a resource set shown as empty text, also where only a culture's `.resx`
  exists (a lookup ends in the neutral set); and a resource cast to an integer through another numeric cast rounded by
  the shared executor (`(int)(double)…` of 300.6 gave 301), which now converts as C# does;
- syntax the special paths still replayed (generic names, named and `ref` arguments in `ApplyResources` and in the
  component construction, an initializer on a tree node), now refused by the shared gate.

The #8 follow-up was reviewed the same way, over eight rounds, until a round found nothing that blocks. Each finding
below is fixed and has its own regression test:

- the global usings taken from the import scope of `InitializeComponent`, which held the designer file's own usings
  as the build compiled them (usings removed from the buffer since were still applied), and which replaced what the
  folder walk read (a global alias added since was ignored);
- the bare layout calls of a form whose linked part declares a partial method of that name without a body, which the
  compiler erases with its calls. Successive designs that confirmed them through the edited buffer were defeated by a
  `base.` call, by a field of a base form hidden by the form's own, by a container removed since the build, by
  statements deleted around a late call, and by code under an inactive `#if`. The proof is now made on the build's own
  text and kept per build, form and file; an optimized localized form, which the pairing could not confirm, keeps its
  calls;
- witnesses rejected because of a `file`-local type, escaped identifiers or a comment inside a `using` name, a witness
  taken from a `#line` mapping, and a project folder spelled in another case than in the PDB.

## Limitations

- A nullable cast written with an inferred type name (`(Int32?)x` in Visual Studio's simplified style) is refused even
  with a matching build: the build check does not model nullable conversions, and the compiler erases some of them from
  the IL. Fully qualified or keyword nullable casts (`(int?)x`) work. No Visual Studio form or sample uses one.
- The interpreter reads enum members but not constant fields of a class (`int.MaxValue`, a project's `const`); a
  statement naming one is refused. The build check folds them.
- Refused although the compiler accepts them, because the interpreter does not model the rule: `E - 0` for an enum whose
  underlying type is not `int`; a floating value out of range cast in an unchecked context; comparisons with `null`;
  unboxing a boxed enum as another enum of the same underlying type; an argument written as `default`.
- `GetObject` of a refused (binary, SOAP or file-reference) entry still leaves the property unset, counted among the
  form's unrenderable resources, as before; a cast of it to a value type is refused.
- The .NET Framework engine's own constant handling is unchanged; it covers the constant shapes Visual Studio writes.
- On a high-DPI display the preview is the form drawn at its own size with each pixel repeated, so text is no sharper
  than at 100%. A sharper capture would have to rescale the fonts of the live form, which `AutoScaleMode.Font` answers
  by scaling the form again, and which cannot be undone exactly.
- The usings of a project that imports MSBuild files are read only from a portable PDB of the loaded build (the default
  of SDK projects). A build without one (`DebugType` `none`, or a Windows PDB), or a build whose source paths are mapped
  (`PathMap`, as continuous-integration builds do), keeps such a project's unqualified names refused, as before, and
  so does a state where every file of the project changed since the build. A global using removed from a source since
  the build applies until the project is built again, as one removed from an imported `.props` does. A `#line`
  directive that maps a source onto another file of the project declaring part of the same type can make that
  source's own usings count as global; a using taken for global in excess can only make names ambiguous or refused,
  since every name bound by inference is confirmed by the build's IL. The bare layout calls of such a project are
  proven once the designer opens a form whose file is still the one the build compiled; a form changed on disk since
  the build, before the designer has opened it with that build in the current session, has them refused until the
  project is built again, and so has a designer file with code under an inactive `#if`. A file of the project is
  taken as compiled when the PDB records its path with its hash; a source that claims another file's path and hash
  (`#line` with `#pragma checksum`) is taken for that file — a project that forges its own debug information is
  outside what the preview can check, as is code the project runs when its controls are constructed.
- Unchanged since 2.3.2: the build's InitializeComponent is read only as straight-line code. A subscription of a
  static method by its name (`button1.Click += Handler;` with a `static` handler) compiles to a cached delegate
  behind a branch, so neither its unqualified names nor such a project's bare layout calls can be proven; an instance
  handler, which Visual Studio writes, or `new EventHandler(Handler)` keeps them.
- Unchanged since 2.3.2: in an optimized build, a simplified-style statement that the compiler merged with the next
  ones on the evaluation stack (a localized form's `resources` kept there across `ApplyResources` calls) is not
  paired with the build, so its unqualified type names are refused; a Debug build, or fully qualified names, render.

## Verification

On the final tree, without opening VS Code windows:

- Modern engine suite **1065/1065**, .NET Framework engine suite **108/108**.
- Constant corpus (`ConstantFoldingCorpusTests`): every expression compiled by the C# compiler, its constant read back
  from the emitted assembly, compared with the interpreter (43,384 agreed, 2,520 refused, 0 different) and with the build
  check through `DesignerTypeScope.Describe` (19,079 agreed, 760 not folded, 0 different). Every refusal of a compiled
  constant falls into a listed category, and every expression the compiler rejects is refused.
- Non-constant corpus (`NonConstantCorpusTests`): 155 statements compiled and run: 69 take the compiled value, 76 that
  the compiler rejects or whose compiled form throws are refused, 10 valid shapes the interpreter does not model are
  refused, none differs.
- Each new check fails its own tests when disabled: overload applicability 16, the resource registry's assembly check 2,
  `GetString` of a non-string 3, the shared executor's static resource type 1 and its resource cast by type 3; for the
  #8 follow-up, each guard of the usings from the build and of the bare-call proof, and the pixel
  repetition, whose tests also fail against the 2.3.3 engine before the follow-up and against the reporter's patch.
- 132 of the 133 designer files of the repository render and describe byte-identically to the 2.3.2 engine (PNG,
  layout and property values). The other, `fixtures/Net48CtxFixture/VendorShapedForm.Designer.cs`, belongs to a project
  that compiles linked sources from outside its folder: with its build it now has 20 of its 21 statements represented
  instead of 12, and renders the control it declares; its picture is unchanged. Coverage gate over `engine/samples`:
  91.43% (unchanged). The archived Visual Studio reference comparison passes.
- Headless end-to-end with the .NET Framework legs, webview end-to-end (1,047 checks), extension unit tests 931/931,
  release metadata preflight (`--metadata-only`), mojibake scan and strict localization parity pass.

Not executed on the final tree: the Extension Host suites, VSIX packaging and isolation, and the installed
upgrade/downgrade. The extension source is unchanged; CI on the release commit runs all of them. No VSIX hash is bound
here; the release workflow builds and publishes both packages from the tagged commit.

## Publication

1. Commit the release tree and push it; CI must pass every step.
2. Tag `v2.3.3` on that commit and push the tag. The release workflow checks the tag against the version, builds both
   VSIX packages, and publishes them with the `2.3.3` changelog section as release notes.
