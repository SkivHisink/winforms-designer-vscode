# Release 2.3.2: forms in Visual Studio's simplified designer style render in the modern engine

Date: 2026-11-08  
Status: **PREPARED — engine checks pass on the final tree; the extension and Extension Host suites run in CI on the release commit**

Patch release over 2.3.1 (tag `v2.3.1`, commit `110936a`). Under the maintenance rule
[R20-04](roadmap-2.0.0-to-3.0.0.md#200--20x--fix-the-baseline-and-maintain-it), a patch release carries fixes for
breakage of existing workflows. This one makes the designer files Visual Studio writes for modern projects open in the
modern engine (issue #8). No protocol or dependency changed; the interpreter allowlists, the edit-minimality gates and
identifier validation are untouched.

## Defect

For a .NET 6+ project Visual Studio 2022 writes `InitializeComponent` without `this.` and with type names left
unqualified, relying on the project's implicit usings:

```csharp
button1 = new Button();
SuspendLayout();
button1.Location = new Point(20, 20);
ClientSize = new Size(800, 450);
ResumeLayout(false);
```

The modern engine rendered only the empty form and listed every statement as a missing type, an unrecognized target,
an unknown child or an unsupported call. There were two causes.

1. **No unqualified type name could resolve.** The modern interpreter looked a written name up as a full name only.
   Neither the file's `using` directives nor the project's global usings were consulted, so `Button`, `Size` or
   `Color` were never found. The changelog item of 2.x about unqualified names covered only component construction on
   the .NET Framework engine.
2. **Layout calls without `this.` were unsupported.** `SuspendLayout();` has no receiver, and both front ends accepted
   only `this.SuspendLayout()` or a field receiver. Even with every type written in full, the form stayed partial.

Six of the archived Visual Studio reference forms (S017, S022, S025, S026, S029, S030) carry the second shape; their
renders were already complete, but the two or three layout calls of each were listed as unsupported.

## Change

- **Binding.** A name the file leaves unqualified is bound the way the compiler binds it: the form's own nested types
  and those of its base, each enclosing namespace's members, the usings written in that namespace (resolved relative
  to it), its parent namespaces, the global namespace, and last the compilation unit's usings together with the
  project's global usings — the generated `obj\…\<Project>.GlobalUsings.g.cs` of its build and every `global using` in
  its own sources. The sources are read as a superset of what the project compiles (every C# file of the folder except
  dot folders; build output and nested project folders included), inside the project folder only and without
  following links. In an expression, a local or a member of the form with that name is what C# reads, not the type.
- **Refusal.** What cannot be bound that way is reported as a missing type with the reason, never guessed: two imports
  that supply the name, a `using` alias of that name or a `using` that starts with an alias, a `using static` type that
  cannot be inspected, a type the project's sources declare (also under an inactive `#if`) that its build does not
  hold, global usings under `#if`, and a project file that imports MSBuild files, compiles sources the folder walk does
  not read or changes the default item globs. A form declared inside another type is not bound by simple name. A
  simple name nothing in scope supplies refuses its statement too, also where the interpreter would otherwise accept
  the statement by its shape (a resource manager, an enum member parsed as the property's own enum), and a resource
  manager that is refused answers none of its lookups from the form's `.resx`.
- **Confirmation by the build.** A statement that names a type by inference runs only when the project's build compiled
  it to exactly what it implies. The engine reads the IL of the loaded build of `InitializeComponent` — metadata and IL
  bytes only, nothing is invoked — and cuts it where the evaluation stack is empty, which is where C# statements begin
  and end (an optimized build may keep a value on the stack across several statements, and then one piece holds all of
  them). Each piece is paired with the source statement it ends with, by the field that statement starts from and the
  member it finally sets, adds to or calls, in order. From the source statement the engine derives the steps it must
  compile to, in evaluation order — every construction, static property, field and method, instance member, array,
  cast, `typeof` type and delegate, and every constant with its value and its C# type (literals, enum members, `const`
  fields and decimals folded as C# folds them); an instance call made through a cast also names the type that declares
  it — and requires them to be exactly the steps of its piece, in the same order, or, for a piece holding several
  statements, of that run of statements together. In the IL a constant takes the type of what consumes it where that
  type is told: an enum parameter, field, local or array element, or the type it is boxed as; an enum constant whose
  type the IL does not tell does not match. A 32-bit load matches a source value by its 32 bits only when that value
  fits 32 bits. An array's length is a step, the initializer's count or the size written. What only the compiler adds
  is left out on both sides: a decimal is one constant with its value however the compiler builds it (an int,
  constant words, an int array, `Decimal.Zero`), and an array's element indexes and the elements equal to the default
  the array starts with are not steps. An unseen alias changes
  some step (another type's getter, method or constructor, a property call, another value or another enum where an
  enum constant was expected, the constructions nested the other way round, an interface method of another type), so
  the statement is refused before any part of it runs. A control is also confirmed by the type stored into its field.
  No build, a build that cannot be read or that branches, or a statement the build does not show (one added by hand
  since the last build) refuses the name with "build the project". Edits made in the designer write fully qualified
  names and keep rendering without a rebuild.
- **Layout calls.** In the modern engine, `SuspendLayout();`, `ResumeLayout(false);` and `PerformLayout();` are
  replayed on the form unless a local of `InitializeComponent`, a member of the form (in the designer file, another
  partial or the build) or a base form below `Control` declares that name. The .NET Framework engine keeps the bare
  form a gap: its syntax-only front end cannot see such a member in another part of the form, and its executor would
  call whatever the instance carries. Its interpreted renders are unchanged.
- **Font character set.** `new Font("Segoe UI", 9F, FontStyle.Regular, GraphicsUnit.Point, 0)` with a bare `0` is
  constructed: an int literal argument converts to a narrower integral parameter as C# converts it, only when exactly
  one public constructor of the already allowlisted type accepts the result.
- **Array length.** In the modern engine an array written with a length and no elements (`new string[3]`) has that
  many default elements; 2.3.1 created it empty. A length the interpreter cannot evaluate or above 65,536, and an
  array of more than one dimension, are unrepresentable.
- **Casts and negation.** In the modern engine a value cast or negated takes the value C# gives it: a floating or
  decimal value cast to an integral type (`(int)2.6`) is truncated toward zero (2.3.1 rounded it), a `char` cast to a
  number is its code (2.3.1 left the `char`), and unary minus negates in the operand's own type before converting to
  the target: a narrow operand is promoted to `int` (`-(sbyte)(-128)` is 128; 2.3.1 kept the `sbyte`),
  `-2147483648` is an `int`, and `(double)(-0)` is a positive zero (2.3.1 converted first and made a negative zero).
  A cast that cannot be made is unrepresentable; 2.3.1 left the operand unconverted.

Unchanged: fully qualified names keep the exact lookup and need no build; what may be constructed, read or invoked is
decided by the same allowlists on the resolved type.

## Independent review

Adversarial review rounds of the first design (binding proven from project files alone) found configurations in which
a written name would have bound to a different type than the compiler's: a comment between `global` and `using`, a
`using` inside a namespace that names a nested namespace, an alias from an SDK-attributed import, a package or a
source generator, a type added to the sources after the last build. The design was changed so that the build confirms
every inferred binding. The sign-off rounds then found these, all fixed and covered by tests:

- Evidence taken from the whole method let one statement confirm another: `this.BackColor = System.Drawing.Color.Red;`
  vouched for `this.ForeColor = Color.Red;` under an unseen alias that makes it a different colour.
- Checking that an operation occurs in the statement's piece was not enough. An optimized build merges statements that
  share a value on the stack; an inner `System.Drawing.Color.FromArgb(…)` vouched for an aliased outer
  `Color.FromArgb(…)`; and an enum was accepted because the setter takes that enum, while an unseen alias had made
  `AnchorStyles.Top` a property returning `Bottom`. Statements are now confirmed by exact equality of their operations,
  alone or as the run an optimized build merged.
- Equality of the operations as a collection was still not enough. Under unseen aliases that swap `Size` and `Point`,
  `new Size(new Point(10, 20))` has the same two constructions nested the other way round; an alias class whose
  `Top` is a `const` of another value leaves the same constant step as the real enum member; and
  `((ISupportInitialize)this).BeginInit()` through an alias of an interface the form implements calls a method of the
  same name. Steps are now compared in evaluation order, with the values of constants, and an instance call through a
  cast with the type that declares it. The compiler's own steps (decimal construction, array lengths and element
  indexes, elements left at their default) are told apart by tracking which steps compute each value on the stack.
- Comparing constants by value alone was still not enough. An alias class whose `Italic` is a `GraphicsUnit` constant
  of the same value as `FontStyle.Italic` makes the compiler take `Font(string, float, GraphicsUnit)`; a `long`
  constant matched by its low 32 bits; and a decimal took no step, so `(decimal)AnchorStyles.Top` under an alias of
  another value matched. Constants now carry their type wherever the IL tells it, the 32-bit tolerance applies only to
  32-bit loads of values that fit them, and a decimal is compared by its value. This also compares the enum of a
  constant boxed into an `object` property, which an earlier draft listed as a limitation.
- A name the binder could not bind left its statement out of the confirmation: a resource manager accepted by its
  shape read the form's `.resx` whatever the `typeof` named, and an enum member nothing in scope supplied was parsed
  into the property's own enum. Such names now refuse their statement, `typeof` compares its type, and a refused
  resource manager answers no lookups.
- An array's length took no step, and the interpreter dropped a length written without elements, so
  `new String[(int)AnchorStyles.Top]` rendered empty under an alias that makes it 2 (and `new string[3]` was empty in
  2.3.1 already). The length is now a step on both sides, and the interpreter creates that many elements.
- The interpreter rounded a floating value cast to an integral type while the compiler truncates it: the build
  confirmed `new String[(Int32)2.6]` with two elements and the preview made three. The interpreter now truncates as
  C# does, for a length and for any other value.
- The same comparison of what the build confirms with what the interpreter computes found two more: unary minus kept a
  narrow operand's type (`-(SByte)(-128)` became −128 instead of 128), and a cast from `char` that `Convert` cannot
  make left the `char` in place (`(Single)'A'`). Negation now promotes as C# does, a `char` is its code to a number,
  and a cast that cannot be made refuses its statement. Two more followed from the order of negation and conversion:
  `(IComparable)(-2147483648)` became a `long`, and `(Double)(-0)` a negative zero. Negation now happens in the
  operand's own type, with the two minimum literals as C# reads them, and only then is the result converted; a
  floating constant is compared with the build bit for bit.
- The .NET Framework front end, taught bare layout calls, would have called a base form's method where the compiled
  form invokes a delegate property of the same name. That front end keeps the bare form a gap.
- A generic nested type `System<T>` of the form hid the namespace `System` from fully qualified names. Nested types are
  now compared with their generic arity.

## Limitations

- The build is the reference: a statement whose meaning a package, a source generator or a file outside the project
  changed since the last build renders as that build compiled it, and so does a statement edited by hand in place
  since then.
- Constant expressions Visual Studio does not write (numeric conversions at the edges of their ranges, decimal
  casts and arithmetic, operators the interpreter does not evaluate) are computed by the interpreter's own rules. The
  disagreements with C# found so far are corrected and tested; checking every compilable shape against the compiler
  is tracked in [#9](https://github.com/SkivHisink/winforms-designer-vscode/issues/9).
- A static method group as an event handler makes the compiler cache the delegate behind a branch; such a build of
  `InitializeComponent` cannot be cut into statements, and every inferred name of the form refuses until the handler
  is an instance method or the names are qualified.
- Rename and Remove of a control refuse in a file without `this.`, and whole-file regeneration refuses (lost
  statements), as before; targeted property edits work. Teaching those editors the simplified style is a separate
  change.

## Verification

On the final tree, without opening VS Code windows:

- Modern engine suite **884/884** (87 new: binding, refusals, build confirmation with assemblies compiled in the test in
  debug and optimized form — an alias no project file shows for a control, for a value, for an enum as a property and
  as a constant of another value, for a constant of another enum, width or decimal value, for an array length, for an
  outer call around the same inner call, for constructions nested the other way round, for an interface bracket, for
  a resource manager and its `typeof`, for an enum name nothing in scope supplies, next to a statement that really
  reads that member, and across statements an optimized build merges; constants of every kind a designer writes
  confirmed in both builds — layout calls, the font conversion, array lengths, casts and negation as C# computes them,
  and the unchanged security gates). Each
  check fails its own tests when disabled: the build confirmation 19, the source-declaration and relative-import
  checks 4, the constant values 4, the constant types 2, the refused resource manager's lookups 2, and the order of
  steps, the 32-bit width, the decimal value, the declaring type of a call through a cast, the `typeof` type, unbound
  names, the array length as a step and the interpreter's written length 1 each; the truncation of a cast literal 2;
  each of the value tests for casts and negation fails against the interpreter code it corrects, and a fold without
  decimal-to-integer casts fails 1.
- .NET Framework engine suite **89/89**.
- The form from the report, a full Visual Studio 2022 form (fonts with a bare character set, colours, `ToolTip`,
  `TableLayoutPanel`, `ISupportInitialize`, a system icon) and a 130-statement .NET 8-style form (menu, grid with
  columns, table cells, combo items, `NumericUpDown`, tree-node locals, method-group events), each built with `dotnet
  build`, render every statement from both a Debug and a Release build (10/10, 63/63, 130/130).
- Every Visual Studio reference fixture and every sample form renders byte-identically to the 2.3.1 engine; the six
  reference forms above now have no unsupported statement. Coverage gate over `engine/samples`: 91.43% (unchanged).
- `npm run release:preflight -- --metadata-only` passes for v2.3.2; mojibake scan passes.

Not executed on the final tree: the extension unit, webview and headless end-to-end suites, the Extension Host
suites, the reference-render comparison script, VSIX packaging and isolation, and the installed upgrade/downgrade. The
extension source is unchanged; CI on the release commit runs all of them. No VSIX hash is bound here; the release
workflow builds and publishes both packages from the tagged commit.

## Publication

1. Commit the release tree and push it; CI must pass every step.
2. Tag `v2.3.2` on that commit and push the tag. The release workflow checks the tag against the version, builds both
   VSIX packages, and publishes them with the `2.3.2` changelog section as release notes.
