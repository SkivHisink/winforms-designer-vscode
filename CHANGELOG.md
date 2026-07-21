# Changelog

All notable changes to **WinForms Designer for VS Code** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
From **1.0** the core designer loop is stable and follows semantic versioning; the .NET Framework 4.8 compiled preview (for `net4x` / DevExpress) remains **experimental**.

## [Unreleased]

## [1.0.0] — 2026-07-21

**1.0 — out of preview.** The core designer loop is stable, and this release makes the project's central promise
explicit: **safe persistence**. Supported edits are written as byte-local, conflict-checked source splices; anything
the designer can't persist safely is refused with a stated reason, never guessed — backed by the capability preflight,
the byte-local save firewall, and the golden-corpus round-trip that landed across 0.10–0.12. The **modern** engine
renders your current source. The **experimental .NET Framework** engine renders a compiled instance of your last build,
applies supported live edits best-effort, and always discloses that a rebuild is authoritative; it stays editable, and
your source edits stay byte-local on either engine.

The stable package is deliberately **Windows x64 only** (`win32-x64`). Its modern engine now targets
**.NET 10 LTS** and supports WinForms projects targeting .NET 8, .NET 9, or .NET 10; Linux, macOS, WSL and
Linux-hosted remote workspaces are not supported. The .NET Framework 4.8 / DevExpress x64 engine remains experimental.

Getting to 1.0 meant auditing that promise instead of asserting it. An adversarial sweep of the engine, the host and
the webview — plus repeated independent review — turned up a series of paths that genuinely broke it, and they are
fixed below: a form could render **the wrong class entirely** and call it save-safe, a save could **silently overwrite
someone else's change** or **truncate the form outright**, an event handler could be written into **a different class
than the one wired to it**, a negative number could be **shown wrong**, and an ImageList edit could **replace the images
it failed to read**. Three long-standing **false** refusals are gone too. The VSIX also no longer ships local scratch
files.

The root cause behind several of these was the same: **~30 places each decided for themselves which class in a
`.Designer.cs` was the form**, and the preview and the save path only agreed by luck. There is now **one resolver, in
one file, compile-linked into both engines** — the modern .NET 10 designer and the .NET Framework 4.8 compiled preview
literally cannot answer that question differently. That is what made it safe to tighten the rule at all.

### Strengthened stable core

- **The .NET Framework preview is now honest about what it is, without pretending to be more.** The experimental net48
  engine renders a compiled instance of your **last build**, never the live `.Designer.cs` — and it fundamentally
  *cannot* prove the build matches your source, because you can hand-edit the file and never rebuild. Earlier release
  candidates tried to infer divergence and put the form **read-only** when the picture looked stale. Across repeated
  review that inference proved unable to converge — it produced both false locks (bricking a perfectly good edit) and
  false unlocks (clearing the lock over a genuinely stale picture) — and a lock that can misclassify is *less*
  trustworthy than a plain statement of the facts. So net48 forms are **fully editable**, and the fact that the picture
  is a compiled instance of your **last build** (live updates best-effort; rebuild is authoritative) is recorded in the
  **WinForms Designer output channel** rather than occupying the canvas with an always-on banner. Source safety does not
  depend on that disclosure at all — it comes from the byte-local save firewall, which refuses any edit that isn't a
  confined source splice, on either engine. The modern engine, which renders your current buffer directly, is unaffected.
- **High-DPI rendering — the canvas is crisp on 4K.** Both engines now render the form PNG at the display's device
  pixel ratio by scaling the control tree before capture (so text and metrics are drawn at the higher resolution),
  instead of upscaling a logical-size bitmap after the fact. Layout, hit-testing and zoom stay in logical form pixels,
  so selection, drag and the rulers are unchanged; only the picture gains resolution. The default (1×) path is
  byte-identical to before, and a differential test pins that a 2× render carries real detail rather than a plain upscale.
- **Adding or deleting a tab now updates an interpreted .NET Framework canvas immediately.** On an interpreted net48
  form, an on-canvas tab add/delete (WinForms `TabControl` / DevExpress `XtraTabControl`) re-interprets the committed
  source instead of mutating the compiled instance — closing a case where deleting a page changed the `.Designer.cs` but
  left the on-screen tab in place. The pure-text page-removal splice is unchanged and pinned for the DevExpress shape.
- **A Properties/describe race is closed.** A control or item describe now captures the source revision together with
  the text it reads (no `await` between), so a describe that resolves after a concurrent edit can no longer repaint the
  property grid or item grid with values from the superseded source.
- **You can rebuild your project again while using the .NET Framework designer.** This one was hiding behind every
  "rebuild to refresh the preview" instruction the product gives. Because the preview loads your build output *in
  place* — shadow-copying it would break delay-signed vendor control assemblies — the engine **pinned your dll for as
  long as it lived**, and nothing ever released it. So `dotnet build` failed outright with
  `MSB3027: The file is locked by: WinFormsDesigner.Engine.Net48`, the engine's own "reload when the assembly changes"
  check could never fire (the timestamp it waited for could never change), and every instruction that said *rebuild*
  was unfollowable. The engine now exposes an explicit release. The designer calls it automatically when the last form
  using an output closes (and when a form switches to a different control source, releasing the one it used to pin),
  and **WinForms: Release .NET Framework Assembly** does it on demand — asking the engine to free *everything* it has
  loaded, since a form that switched sources no longer names the output it forgot. If a preview's own control started a
  thread that refuses to unload, or the engine is wedged, the command recycles the whole preview process so the handles
  are freed the operating-system way rather than reporting a release that didn't happen. A regression test drives a real
  MSBuild rebuild against a live engine and requires it to fail while the assembly is held and to succeed once it is
  released — pinning both halves, so this cannot quietly come back.
- **A clearer promise, unchanged behavior: an *incomplete* preview is not a locked one.** The README's one-line summary
  of fail-closed read as though anything the designer can't fully draw becomes read-only. The rule the designer has
  always applied — and the one its own "Fail-closed by design" section spells out — is narrower and is what 1.0 keeps:
  a form it can't faithfully reproduce is **disclosed** (a banner naming what was skipped) and **never whole-file
  regenerated**, while property and geometry edits continue to apply as targeted byte-surgical splices. Those splices
  preserve everything outside the edited span *by construction* — including the very constructs the preview couldn't
  draw — so locking such forms outright would remove a working, advertised capability without making anything safer.
  The summary now says that, rather than implying a stricter rule than the product has.
- **The planned 1.1 hardening ships in 1.0.0.** A fast `net10.0-windows` xUnit layer directly pins the
  safe-save minimality gates, statement equivalence, interpreter allowlists, ASCII/keyword identifier boundary,
  framework value conversion, and TFM selection. A pure Vitest layer pins TypeScript expression conversion and
  bounded per-engine crash recovery. Both layers are mandatory in CI and release workflows.
- **Fewer false read-only results without a wider trust boundary.** The statement firewall now alpha-normalizes
  generated locals by declaration order and treats a side-effect-free `AddRange(new T[] { ... })` as the same
  ordered collection operation as equivalent `Add(...)` statements. Invocations, object construction, and every
  unproved collection element still fail closed.
- **Tighter .NET Framework parity.** Compiled describes now surface source-derived `Modifiers` and read-only
  `GenerateMember`; a committed ImageList transaction reconciles the cached compiled instance immediately, so
  dependent `ImageKey` / `ImageIndex` choices and the canvas no longer wait for a rebuild.
- **Operational hardening.** Diagnostics now include extension/engine versions, capabilities, ping latency, memory,
  engine PID, starts, startup time, recent crashes, and last exit. Unexpected exits get two bounded exponential-
  backoff restarts before a crash-loop guard pauses recovery. CI/release also enforce a cold-start + warm-render
  performance baseline and a release preflight that verifies .NET 10, unit layers, and workflow gates.
- **The .NET Framework release/recycle and shutdown lifecycle is fail-closed.** Freeing a pinned build output now
  waits for a **confirmed** process exit before telling you a rebuild is safe, never starts a replacement engine beside
  a process that might still hold the dll, and quarantines an AppDomain that refuses to unload rather than handing it
  back. The host **owns every engine child from the instant it spawns** — including one still connecting — so none is
  orphaned (and left pinning your dll) when a window closes or the extension deactivates, and a failed spawn is cleaned
  up rather than leaked. The compiled-preview banner's *last build* / clean-vs-dirty disclosure now updates the moment
  the document changes, so it can't lag behind a stalled render. These paths were audited across repeated independent
  review specifically for orphaned processes, stuck locks, and dishonest status.

### Fixed
- **The engine rendered the first class in the file, not the form.** A `.Designer.cs` that declares a second class
  ahead of the form rendered **that** class, reported it **save-safe with no banner**, and let a regenerate splice
  generated code into it — producing a file that no longer compiles. The renderer now resolves the form the same way
  the save splicer and the byte-surgical editors already did — the class declaring `InitializeComponent` — so the
  parts of the engine can no longer disagree about which class the file even is. If a file declares **no** such class,
  or **more than one** (a second form, or a helper — including a **nested** one), the designer now **fails closed** and
  renders nothing rather than picking one: whichever it picked, the splicer might pick the other and regenerate one
  class's body into the other's. The same fix ends a **false read-only** on a form legitimately split across partials
  (component fields in one, `InitializeComponent` in another) — its fields are now found across all of them.
- **Saving could silently overwrite an external change.** The `.Designer.cs` write went to disk unconditionally: if
  the file had changed underneath the open designer (a `git checkout`, Visual Studio, a generator — or simply an
  event the watcher never delivered), Ctrl+S destroyed that revision without a word. The save now re-reads the file
  and refuses — keeping your edits unsaved and saying why — when it no longer matches the version the designer last
  saw, when it carries a different byte-order mark, or when it was **deleted** since being opened; an unreadable
  file (locked, permissions) surfaces the error instead of being written over. And a form whose file couldn't be read
  when it was opened holds no trustworthy baseline at all: rather than let you edit against a file it has never seen,
  the designer treats it as **read-only** — every edit, resource write and *Save As* refuses — until a successful read
  establishes one (the next change to the file clears it automatically; *File → Revert* does so on demand). *Save As*
  also no longer overwrites an existing generated partner: picking `NewForm.cs` writes `NewForm.Designer.cs`, a path
  the overwrite prompt never mentioned, so it is **created conditionally** and refused — not clobbered — if it already
  exists (a form you really mean to replace can be picked directly, where VS Code's own prompt covers it). The sibling `.resx` write
  path was already conflict-guarded; the primary artifact now matches it. Note the ordinary-save check is a re-read,
  not an atomic compare-and-swap — the VS Code filesystem API offers no conditional write, so a write landing in the
  instant between the check and ours can still win. That window is far smaller than the previous behaviour (which
  never looked at all), but it is not zero.
- **A negative number could be rendered and reported wrong.** Unary minus was only applied to `int`, `double` and
  `long` literals — every other numeric literal came back **unnegated and without complaint**, so a
  `numericUpDown1.Minimum = -100` (a `decimal`) showed as **100** in the preview and the property grid, and
  `new SizeF(-6F, -13F)` lost both signs. Negation now happens in the literal's own type, and anything that can't be
  negated is reported as `unrepresentable` — disclosed on the banner and refused a whole-file regenerate — rather than
  shown as a plausible wrong number.
- **An ImageList edit could replace images it hadn't read.** The reader that feeds the editor's data-loss guard
  matched only the canonical `name="…"` spelling, so a `.resx` written by hand or round-tripped through another tool
  (`name='…'`, `name = "…"`) read back as *no images* — precisely the state the guard lets through — and saving then
  replaced the real image set. The reader now tolerates the same attribute spellings the binary-resource scanner
  already did, and the guard additionally refuses whenever the `.resx` demonstrably holds binary resources but none
  resolved for that ImageList: ambiguity fails closed instead of defaulting to "replace everything".
- **TreeView forms round-trip again (a false read-only is gone).** The serializer named the locals it generates for
  `TreeNode`s using the framework's fallback rule, which lower-cases the whole type name (`treenode1`). Every
  Visual-Studio-generated `.Designer.cs` spells them `treeNode1`, and the save gate compares statement **text** — so
  every generated `TreeNode` line looked *lost* and an otherwise perfectly faithful TreeView form was refused
  read-only with a `lostStatements` reason. The engine now emits VS's camelCase, so a VS-generated TreeView form is
  **save-safe**, its regenerate is idempotent, and node names / text / structure are preserved. **The safe-save gate
  itself is untouched and exactly as strict** — this fixes the generator, not the guard. A form written in a spelling
  VS never emits (a hand-simplified `Color.FromArgb(255, 224, 192)`, or `TabPages.AddRange`) still refuses honestly,
  because regenerating it would rewrite bytes you never edited.
- **Resetting a property no longer eats the comment next to it.** A reset deletes whole lines, and its gate compares
  statements — a comment is trivia, invisible to it — so `this.p.Dock = …; // KEEP: pinned by ticket #4711` lost the
  comment and still reported success (reachable from the UI, since setting `Dock` resets `Anchor`). It now refuses
  when the target's line carries anything else, **or** when the assignment itself contains a comment
  (`this.p.Dock /* KEEP */ = …`) or a **preprocessor directive** (a `#if`/`#else` around the value — build-affecting
  structure that was being deleted just as silently). Two assignments of the same property on one line still reset fine.
- **On-canvas menu/toolbar edits could splice a stale item tree.** The add / rename / retype / delete paths read the
  item forest and only then snapshotted the document revision, leaving that read unguarded: an undo landing during
  the round-trip meant the edit was applied to text that no longer existed and could resurrect a removed item. They
  now snapshot the revision before the read, like every other edit path.
- **A handler stub could be written on a form that failed to render.** `navigateHandler` reached `createHandler`
  without the stale-render gate (it isn't one of the blocked message types), so the code-behind stub was written to
  your `.cs` and only the wiring was refused — leaving an orphan handler. It now refuses up front, and re-checks after
  the stub write so the refusal names the real reason rather than arriving as a generic backstop.
- **The .NET Framework 4.8 preview had the same wrong-class bug — and edited a different class than it showed.** It
  resolved the form by taking the **first class in the file**, without even checking for `InitializeComponent`: a
  helper class ahead of the form was instantiated and previewed as your form, with no banner, while the modern host
  spliced your edits into the *real* form. Preview one class, edit another. Both engines now share **one** resolver —
  the same physical file, compile-linked into each — so this cannot recur by drift. The 4.8 host also **built the type
  name itself** and got it wrong for a form nested inside a `record`/`struct` or a generic type; when that name then
  failed to resolve, it quietly fell back to *any unique control with the same short name* — rendering a different
  form as yours, with the explanation written to a buffer nobody reads. The name now comes from the shared identity
  (already reflection's own format), and a lookup miss is reported honestly as a stale build.
- **An event handler could be created in — and validated against — the wrong class.** The `.Designer.cs` class rule is
  shared now, but the paired code-behind was matched by **simple name**, first hit. A `.cs` holding
  `namespace Other { class Form1 }` ahead of the real `namespace Product.Ui { partial class Form1 }` made the events
  dropdown offer *Other.Form1's* methods, made the "does this handler exist?" check validate against them, and wrote
  new stubs **into Other.Form1** — while the wiring went into `Product.Ui.Form1`, which has no such method. Both files
  parse, the save reports success, and the project no longer compiles. The code-behind is now matched on the full
  identity (namespace + enclosing type chain + generic arity), with no simple-name fallback even for a form in the
  global namespace — where a nested `Helper.Form1` decoy would otherwise slip straight back in.
- **The events dropdown could offer a handler that doesn't compile.** Candidate parameter types were compared by their
  **last segment**, so a handler taking your own `Custom.EventArgs` matched `System.EventArgs`: picking it emitted
  `Click += new EventHandler(this.WrongClick)` — not a compatible method group — and the build broke. A qualified
  spelling must now match the real type exactly; a spelling that goes through a `using` **alias** (or an `extern
  alias`) is refused rather than guessed at, since the alias carries the binding that decides compatibility and
  nothing here can resolve it. Bare `EventArgs` — what Visual Studio actually generates — is unaffected.
- **Creating an event handler could erase concurrent edits to your code-behind.** The stub was applied by replacing
  the **entire** `.cs` with a copy generated from a snapshot taken before the round-trip. `applyEdit` has no version
  precondition, so anything that touched the file while that write was in flight — format-on-save, a source
  generator, your own typing — was silently overwritten. The stub is now applied as a **one-point insert**, so the
  rest of the file is untouched no matter what else lands.
- **A handler stub for an exotic event signature could be written without compiling.** The stub's parameter types came
  from a name that truncated at the first backtick, so an event whose argument type is **nested inside a generic**
  (`Outer<int>.ChangedArgs<string>`) produced `Outer<int, string>` — a different, often nonexistent type. A
  **multidimensional** `int[,]` parameter likewise came out as `int[]`, because every array was spelled `[]`
  regardless of rank. Both parsed, so the parse-only guard passed and the wiring was written. Ranks are now emitted
  correctly, and signatures that can't be spelled faithfully (nested-in-generic, by-ref, pointer, open type
  parameters — including the event's own delegate type) are **refused with a reason** instead of a stub that only
  looks right.
- **Any method with the right NAME could be wired to an event.** The write path checked only that a method of that
  name existed somewhere in the form — not its signature — so `void WrongClick(string text)` could be wired to
  `Click`, emitting a method group that isn't an `EventHandler` and breaking the build. The dropdown had always
  filtered by signature; the write path now applies the same rule rather than trusting the UI that called it. That
  rule also got stricter: a non-void **return type** is compared (only void-ness was), and a `ref`/`out`/`in`
  parameter — which this comparison cannot decide — is no longer offered.
- **Wiring to an existing handler never checked the code-behind for changes.** The engine confirmed the handler
  existed in a snapshot, then the wiring was committed after an `await` during which the method could have been
  renamed or deleted — `Click += new EventHandler(this.button1_Click)` against a method that no longer exists,
  reported as wired. It now re-checks the code-behind document, exactly as the stub-writing path does.
- **A form using escaped identifiers rendered as a "stale build".** `namespace @Ui { partial class @Form1 }` is legal
  C# whose metadata name is plainly `Ui.Form1`, but the identity was built from the raw spelling (`@Ui.@Form1`) — so
  the .NET 4.8 host could not find the type in a perfectly current assembly, and the code-behind match failed too.
  Identities are now built from the decoded identifier text.
- **Removing a grid/list column from a split form could strand a field forever null.** The typed `DataGridView.Columns`
  and `ListView.Columns` editors rewrite exactly one declaration — the one holding `InitializeComponent`. For a form
  split across partials they would delete a column's construction and `AddRange` while its **field declaration**,
  living in the sibling partial, survived: the file still compiled, the field was permanently `null`, and the edit was
  reported **safe**. Their "is anything else using this column?" scan was likewise blind to a helper method in that
  sibling partial. Both editors now scan every partial of the form, and refuse to remove a column they cannot remove
  atomically.
- **An unreadable `.resx` was treated as an absent one — and overwritten.** The image and ImageList paths collapsed
  *every* read error into "there is no `.resx`", so a resource file that couldn't be read but could be written
  (permissions, a virtual/remote provider, a transient failure) was rebuilt from scratch: the freshness check compared
  nothing to nothing and passed, the binary-resource drop guard saw zero resources and disarmed, and the atomic rename
  replaced the real file. Only a genuine *file not found* now means "absent"; anything else surfaces as an error.
- **The `.Designer.cs` is now written atomically.** The sibling `.resx` has been written temp-then-rename since 0.11.0,
  but the form itself went out with a plain write — so a crash, a full disk or a power cut mid-save could leave it
  **truncated**. Guarding the resource file while writing the form unprotected had it backwards: a half-written `.resx`
  costs an image, a half-written `.Designer.cs` costs the form. Both now take the same path.
- **An image import no longer strips the `.resx` BOM.** Visual Studio writes `.resx` files with a UTF-8 byte-order
  mark; the engine round-trips the stripped text, so writing it back plain quietly dropped the mark and turned a
  one-image import into a whole-file diff in your history. The original mark is preserved on every write (a `.resx`
  the designer *creates* still has none), and the conflict guards — forward, undo and redo alike — now treat a
  BOM-only external change as the conflict it is.

### Changed
- **Left preview.** The Marketplace listing no longer carries the **Preview** flag; `1.0.0` is the first stable release.
- **The VSIX no longer ships local scratch.** `.vscodeignore` now excludes `.claude/**`, `**/*.log` and `*.vsix`, which
  were being packaged into the published extension.
- **Published support matrix.** The README now states, per runtime, exactly what is supported and — crucially — what the
  designer **refuses to whole-file regenerate** rather than risk corrupting: `Localizable = true` forms, binary `.resx`,
  unresolved base types, and unrepresentable statements, each named by the capability preflight (`safe` / `localizable` /
  `binaryResx` / `unresolvedType` / `lostStatements` / `unrepresentable`). Individual property and geometry edits still
  apply as targeted byte-surgical splices even on those forms. (A `Localizable = true` form is the one case that is
  read-only outright: its layout lives in per-culture `.resx`, so any edit here would diverge from it.)

### Notes
- The **.NET Framework 4.8 compiled preview** (for `net4x` / DevExpress forms) remains **experimental** — render is
  proven and the live edit flow is wired, but it is best confirmed with an F5 run.
- **Post-1.0**, read-only-safe today: `DesignerActionList` / vendor smart-tag action lists, advanced `.resx` (non-image
  resources, the full `ApplyResources` per-culture localization workflow), generic `IList<T>` collection editors, and RTL.
- **External changes now lock the canvas while it catches up.** Adopting an externally-changed `.Designer.cs` used to
  leave the old canvas actionable until the replacement render finished, so a click or drag aimed at what was on
  screen could splice into source the user had never seen; overlapping watcher events could also let an older read
  re-adopt superseded text. Edits are now refused for the whole re-render, the newest read wins, and a read that
  **fails** after the form was opened (the file deleted, locked, or the provider erroring) latches the same read-only
  state instead of being ignored — previously the stale preview stayed fully editable, and the `.resx` paths kept
  writing, against a source that no longer existed.

- **One resolver, one identity.** The class and the `InitializeComponent` method are now a **single decision**, made in
  one file (`FormClassResolver`) that both engines compile-link. That is what allowed the rule to be tightened: a
  class declaring an `InitializeComponent(int)` **overload ahead of** the real parameterless one used to render the
  form **empty** with no banner (every consumer took the first method matching the *name*), and a class declaring only
  such an overload was treated as a designer class at all. Both are fixed. Applying that tightening to one selector
  alone — the shape of an earlier attempt — is precisely the disagreement that regenerates one class's body into
  another's, which is why it waited for the unification rather than shipping as a local patch.
- Known limits, honestly stated — neither loses data:
  - **The ordinary save is a re-read, not a compare-and-swap.** The VS Code filesystem API offers no conditional
    write, so a write landing in the instant between our check and ours can still win. Nothing is awaited between the
    two, making the window as small as the platform allows — and vastly smaller than the previous behaviour, which
    never checked at all — but it is not zero.
  - **A refused handler stub stays.** If a fail-closed gate flips *while* the code-behind stub is being written, the
    wiring is refused but the stub — an unused empty method — remains in your `.cs`, undoable with Ctrl+Z. Taking it
    back would mean re-reading and replacing the whole file, and `applyEdit` carries no version precondition, so a
    concurrent edit landing in that gap would be **erased** by the rollback. Leaving an empty method is the smaller
    harm, and refusing to roll back is the fail-closed side of that trade. For the same want of a version precondition,
    an edit landing during the stub's own (awaited) write can shift where it lands; because that write is now a
    one-point insert rather than a whole-file replace, the worst case is a visibly misplaced method you can undo — not
    the silent loss of everything else in the file.
  - **The events dropdown is matched syntactically, so it can omit a valid handler.** Deciding a parameter type
    exactly needs a semantic model (which `using` directives are in scope). A **bare** name is therefore matched by
    simple name — correct unless the file imports a same-named type in place of the delegate's — while a
    **partially-qualified** spelling (`Windows.Forms.MouseEventArgs`), one reached through an alias, or one whose
    alias is a `global using` in another file, is not offered at all. Because the qualified comparison is exact, an
    alias the parser cannot see can only cause a miss, never a wrong match. A missing entry in a dropdown is
    recoverable; a wired handler that doesn't compile is not.
  - **The designer reads one code-behind file, not the whole compilation.** It parses `Foo.Designer.cs` and `Foo.cs`
    — so a handler living in a *third* partial file (`Foo.Events.cs`) isn't seen, and "new handler" would add a
    second one; a `global using` alias declared elsewhere isn't seen either (see above). Likewise, deleting a control
    or a grid/list column that code in `Foo.cs` refers to leaves that reference dangling. These produce **compiler
    errors you can see and undo**, not silent corruption — and the last is what Visual Studio's own designer does
    too. The fail-closed guarantee is that the designer never quietly writes something wrong; it does not promise to
    predict every consequence of a deletion you asked for.

## [0.12.0] — 2026-07-14

**Release-candidate hardening — round-trip fidelity, re-verified end to end.** This release closes the loop on
"can the designer safely regenerate this form?" It makes **ISupportInitialize** forms round-trip, adds an
**authoritative capability preflight** (so the designer never claims a form is save-safe when a statement would be
lost), locks the whole behaviour down with a **golden-corpus** test, and adds a **Modifiers** editor. Nothing you had
becomes less safe — the designer just tells the truth about what it can and can't regenerate, and can now regenerate more.

### Added
- **`BeginInit` / `EndInit` round-trip.** A form with any `DataGridView`, `BindingSource`, `PictureBox`,
  `NumericUpDown`, `SplitContainer` (or similar `ISupportInitialize` control) emits
  `((ISupportInitialize)(x)).BeginInit()/.EndInit()` brackets. These are now **re-emitted faithfully** when the form
  round-trips (previously they held the form in read-only fallback to avoid dropping them). The safe-save gate stays
  strict — if a bracket ever failed to round-trip, the form still falls back to read-only rather than lose it.
- **Modifiers editor.** A control's design-time **Modifiers** property (the access level of its generated field —
  Public / Private / Protected / Internal / …) is now editable from the property grid, applied as a **byte-local edit**
  of the field declaration that never touches `InitializeComponent`, so it is safe on **every** form. **GenerateMember**
  is shown read-only (toggling a field to a local is a structural change that isn't round-trip-safe).
- **Capability preflight + reason.** The save-safety preview now reports a **category** explaining why a form is or
  isn't safe to whole-file regenerate — `safe`, `localizable`, `binaryResx`, `unresolvedType`, `lostStatements` or
  `unrepresentable` — so a regenerate-based operation can gate honestly instead of guessing.

### Changed
- **Honest `--roundtrip` diagnostic.** The engine's round-trip check used to report the render-only "RoundTripSafe"
  signal as PASS, which could look save-safe when it wasn't. It now also runs the authoritative safe-save gate and
  agrees with `--save`, so `renders` and `saves` are never conflated.
- **Round-trip fidelity re-verified end to end.** Event wirings, component-reference assignments and `BeginInit`
  brackets were re-checked against a **16-form golden corpus**: every form is either fully save-safe or **fail-closed
  with a named reason** — never silently divergent. (This closes a long-standing documentation discrepancy: the
  previous "sturdier round-trip saving" claim was accurate; the designer refused rather than dropped, and now
  round-trips the `ISupportInitialize` case outright.)

### Notes
- Some forms remain **honestly read-only** for whole-file regenerate and continue to edit safely via targeted edits:
  binary/`ImageStream` resources, `[Localizable(true)]` forms, unresolved vendor/custom controls, and a few
  canonicalization cases (`TabPages.AddRange`, `TreeView` node locals) that render and edit fine but aren't
  whole-file-round-trippable yet. The **Modifiers** editor is surfaced on the .NET-9 preview; its edit path is
  engine-agnostic and ready to extend to the .NET Framework preview.

## [0.11.0] — 2026-07-13

**Resource write-safety + the ImageList images editor.** Building on the 0.10.0 trust floor, this release makes the
`.resx` write path **atomic, undoable and conflict-checked**, and adds the first **image-list editor** — you can now
add and remove an ImageList's images directly, with the binary `ImageStream` serialized faithfully (the way Visual
Studio does it) through the .NET Framework engine. Unhandled collections are now shown honestly, and undo on the
compiled (.NET Framework) preview no longer lingers.

### Added
- **ImageList images editor.** Select an ImageList and run **"WinForms: Edit ImageList Images…"** (Command Palette /
  editor context menu) to add or remove its images. The images are serialized into the sibling `.resx` as a
  Visual-Studio-format `ImageListStreamer` (binary) resource via the .NET Framework engine — the one operation the
  .NET-9 preview can't do itself — and the `.Designer.cs` is rewritten to the canonical `ImageStream` +
  `Images.SetKeyName(...)` form. **Fail-closed:** if the current images can't be read back safely, the edit is refused
  rather than risk dropping them; the payload is validated as a genuine image-list stream before it's written.
- **`(Collection)` property routing.** A collection property the designer doesn't have a dedicated editor for
  (e.g. a `ListView`'s `Items` / `Groups` / `DataBindings`) is now shown as a clean **read-only `(Collection)`** entry —
  visible, like Visual Studio, instead of a raw type name or nothing — with no editable surface that couldn't round-trip.

### Changed
- **Atomic, undoable, conflict-checked `.resx` writes.** Embedding an image now writes the `.resx` **atomically**
  (staged temp file + rename, so a crash can't leave it half-written) and ties the write into the **same undo step** as
  the code edit — pressing Ctrl+Z reverts both the code and the resource (deleting a resource the import created, or
  restoring its prior bytes), conflict-guarded so a concurrent external change to the `.resx` is never clobbered. A
  symlinked `.resx` is written through rather than replaced.
- **Undo on the compiled (.NET Framework) preview no longer lingers.** Previously, undoing an edit on a compiled-preview
  form could keep showing the undone change (the live instance was reused); the preview now re-renders from the compiled
  baseline so undo/redo/revert are reflected.

### Fixed
- A re-import of a new image into a property that already referenced a resource is now undoable (previously it changed
  the resource on disk with no undo step).

## [0.10.0] — 2026-07-13

**The trust floor — the most important release.** The designer now **fails closed**: when a form uses something the
.NET-9 preview can't faithfully reproduce, it says so **honestly** and **refuses to silently corrupt or mis-render**
your file, rather than quietly saving a divergent or incomplete result. Five safety pillars, each surfaced with a
non-dismissible banner or a read-only lock. No feature you had is taken away — the designer just stops guessing when it
shouldn't.

### Added
- **"Localizable form — read-only preview" banner + lock.** A `[Localizable(true)]` form keeps its real values in the
  sibling `.resx`; the .NET-9 preview can't reproduce them, and an edit would splice a value Visual Studio drops on its
  next save. The designer now marks such a form **read-only** and shows why, instead of persisting a silent divergence.
- **"Preview may be incomplete — inherits from X" banner.** A form whose base class is an inherited or vendor type
  (a visual-inheritance `BaseForm`, DevExpress `XtraForm`, …) used to render as a plain empty `Form` on the .NET-9
  preview, silently dropping the base's controls. It now renders best-effort **and tells you** the base couldn't be
  resolved, so controls may be missing. (The .NET Framework preview instantiates the real base and shows no banner.)
- **"Binary / ImageStream resources not shown" banner.** A form whose `.resx` holds BinaryFormatter/SOAP/`ImageList`
  ImageStream resources (which the .NET-9 runtime can't deserialize) now reports how many resources the preview can't
  render — they are **preserved on disk**, and the designer won't regenerate the `.resx`.
- **"Read-only — last render failed" lock.** When a form fails to load or render, its stale preview is no longer
  silently editable — the designer refuses mutations until the form renders successfully again, so you can't edit a
  graph that didn't load. Undo / revert / fixing the source re-enables editing.

### Changed
- **Byte-local save firewall.** Every persisted edit is verified to be a **confined splice** of the file — the designer
  refuses any operation that would rewrite, reflow, re-indent, EOL-normalize, or regenerate the whole `.Designer.cs`
  beyond the intended change. Layered under the existing statement-level gate, a save can only change the bytes you
  edited.
- **No unsafe `.resx` regeneration.** The image-import write path verifies, at the moment of writing, that no binary
  resource would be dropped, and refuses the write (leaving the `.resx` untouched) if the file changed underneath it.
- **Honest refusals.** A refused edit no longer shows a "success" status or a diverging live preview; refusals are
  surfaced consistently across every read-only condition.

The new banners and statuses are translated across all seven locales.

## [0.9.0] — 2026-07-11

**Menu & toolbar editing goes all the way down.** The on-canvas item editing introduced in 0.8.x now reaches **nested
submenu items**, an **off-tree `ContextMenuStrip`**, and **overflow** items; each gets its **own property grid** (with an
**Events** tab); and reference- and image-typed properties become **Visual Studio–style dropdowns**. A pre-commit,
fail-closed hardening pass over the whole stack rounds out the release.

### Added
- **Deep on-canvas item editing.** The 0.8.1 limitation is lifted — **nested / submenu** items, an **off-tree
  `ContextMenuStrip`** (edited from its component-tray chip), and **overflow** items can now be **selected**, **renamed**
  (double-click / **F2**), **deleted** (**Delete**), and grown via a **"Type Here"** slot, at any depth, through
  synthetic flyouts that mirror Visual Studio. Works on **both** engines; the underlying source splices are unchanged and
  depth-agnostic, so nothing outside the edited items is touched.
- **Item → Properties, everywhere — with an Events tab.** Selecting any item — top-level, nested, context-menu,
  overflow, or an off-tree menu — loads **its own** property grid (kept separate from the control selection), and an
  **Events** tab **wires / unwires / navigates** that item's events. Right-click **Reset** works per item.
- **Component-reference property dropdowns.** A property whose type is a component reference — `Form.AcceptButton` /
  `CancelButton`, `Control.ContextMenuStrip`, `NotifyIcon.ContextMenuStrip`, `ErrorProvider.ContainerControl`, … — now
  renders as a **dropdown** of the compatible sibling components plus **(none)**, matching Visual Studio; a property that
  references the form itself offers **(this)**. Editable on **both** engines — the reference is written back as a minimal
  `this.<name>` / `this` / `null` splice.
- **`ImageIndex` / `ImageKey` dropdowns.** A control with an attached `ImageList` now picks its image from a **dropdown**
  of the list's indices / keys, matching Visual Studio. Fully on the .NET Framework compiled preview; the .NET 9 engine
  keeps the plain field when it can't populate the list (empty `ImageList`), with no regression.

### Fixed
- **Pre-commit fail-closed hardening (5 fixes).** Two independent review passes — a second-opinion model and an
  adversarial workflow — over the whole uncommitted stack, closing everything reachable before release:
  - the .NET Framework engine no longer offers an **inherited base-class private field** as a reference candidate (it
    would have saved a non-compiling `this.<baseField>` and diverged from .NET 9);
  - a concurrent-edit **TOCTOU** in the reference-edit round-trip that could commit a dangling `this.<field>` is closed by
    snapshotting the document revision before the describe round-trip;
  - the item editor now **rejects, engine-side**, a nested add under a non-dropdown item (a direct-RPC hole that emitted
    non-compiling `.DropDownItems.AddRange(...)`), so offer ⇔ accept holds on the engine, not just in the UI;
  - a **stale submenu selection** after navigating through an id-less (anonymous) parent could target the wrong item on
    **Delete** / **F2**; the selection is now dropped only when its level is actually truncated;
  - new end-to-end legs no longer **silently pass** when a sample fixture is missing (false-green guard).

## [0.8.1] — 2026-07-09

**Edit `MenuStrip` / `ToolStrip` items directly on the canvas** — add (with a Visual Studio–style **"Type Here"**
slot + a type picker), rename (double-click / **F2**), select and delete — and open a **Properties grid for a single
item** (editable on both engines). The **component tray** now matches Visual Studio by no longer listing strip items.
Plus three fixes: file nesting, third-party "Learn More" links, and DevExpress `XtraTabControl` tab-adding.

### Added
- **On-canvas item editing.** Click the trailing **"Type Here"** slot to add an item via an inline editor with a type
  picker; **double-click** or **F2** to rename a top-level item; single-click to **select** an item and **Delete** it
  (or use the item's Rename / Delete context menu). Builds on 0.8.0's on-canvas item geometry; works on **both** engines.
- **Item → Properties.** Selecting a strip item now loads **its own** property grid, kept separate from the control
  selection. Editable on **.NET 9**; on the **.NET Framework** compiled preview an item both **describes** and
  **live-edits** — the picture updates immediately, without a rebuild. A non-`Control` non-item component (e.g. a
  `Timer`) is described but never live-mutated, so a design surface never runs a component's runtime behavior.

### Changed
- **The component tray no longer lists `ToolStripItem`s** on either engine — Visual Studio never trays strip items;
  they are edited on the strip itself. Off-tree `ContextMenuStrip`s and non-visual components (`Timer`, `ToolTip`, …)
  still appear in the tray. _Known limitation:_ the full property grid of **nested / context-menu / overflow** items
  awaits on-canvas editing of those items.

### Fixed
- **File nesting no longer swallows unrelated partial-class files.** A sibling like `TestControl.Utils.cs` is no longer
  nested under `TestControl.cs`; the designer nests only `.Designer.cs` and `.resx`, matching Visual Studio.
- **"Learn More Online" works for third-party controls.** For a non-Microsoft type (e.g. DevExpress) it now opens a web
  search instead of a `learn.microsoft.com/dotnet/api` page that 404s.
- **DevExpress `XtraTabControl` "Add Tab" / "Delete Tab" now appear and work.** Tab-host detection previously broke on
  DevExpress's `new`-shadowed properties (reflection threw `AmbiguousMatchException`), so the tab menu never showed for
  an `XtraTabControl`; detection now scans the property list instead, with no change for a standard `TabControl`.

---

_Internal:_ a dedicated `selectItem` → `loadItemProps` → `itemProps` channel keeps item Properties off the control
selection; net48 resolves a `ToolStripItem` id via a `FieldNames` reverse-scan (describe + a `Control||ToolStripItem`-
gated live-edit); both `BuildTray`s skip `ToolStripItem`; a shared `FindTabProp` scan replaces the throwing
`GetProperty` at every tab-host reflection site on both engines; the "Learn More" URL builder is extracted + unit-tested.

## [0.8.0] — 2026-07-08

Draws **`MenuStrip` / `ToolStrip` item geometry on the canvas** — each top-level item plus a trailing
Visual Studio–style **"Type Here"** slot are now shown in place (the groundwork for editing items directly
on the canvas) — and fixes a **`ContextMenuStrip`** that used to appear as an invisible rectangle stealing
clicks over the menu bar: an off-tree menu strip now surfaces in the **component tray** on both engines,
matching Visual Studio.

### Added
- **On-canvas menu / toolbar item geometry.** The designer now knows each top-level `MenuStrip` /
  `ToolStrip` / `StatusStrip` item's on-surface rectangle and draws a trailing **"Type Here"** slot after
  the last item (VS-style), on **both** engines. This is the visual groundwork for editing items directly
  on the canvas; the `…` item editor remains the way to add / rename / remove items in this release.

### Fixed
- **`ContextMenuStrip` no longer paints a phantom rectangle over the menu bar.** A context-menu strip is a
  non-visual component (assigned to a control's `ContextMenuStrip`, never placed on the form), but the
  .NET 9 engine used to emit it as an invisible control rectangle in the top-left corner that **stole
  clicks** from the menu bar beneath it. It now appears where Visual Studio puts it — as a selectable chip
  in the **component tray** — on **both** engines, and the menu bar is clickable again. Editing a tray
  component's collection (e.g. a `ContextMenuStrip`'s `Items`) also no longer snaps the selection back to
  the form.

---

_Internal:_ both engines emit per-`ToolStripItem` bounds + an `IsStripHost` flag through the render→canvas
layout path; off-tree controls are partitioned into the tray (never the visual layout) under a shared
invariant; new `ContextMenuForm` sample + a `Net48CtxFixture` project; extended coverage — a
selection-retention regression and a cross-runtime net48 partition leg that compiles the sample and asserts
both engines agree.

## [0.7.1] — 2026-07-07

Adds a **Hindi (हिन्दी)** UI localization — the localized designer UI now spans **seven** languages.

### Added
- **Hindi (हिन्दी) UI localization.** The designer surface, property grid, toolbox, dialogs and status /
  notification messages can now be shown in Hindi via `winformsDesigner.language: "hi"` — bringing the
  localized UI to **seven** languages (English, Русский, 简体中文, Français, Deutsch, Español, हिन्दी).

## [0.7.0] — 2026-07-07

This preview completes **structural editing of `MenuStrip` / `ToolStrip` items**. The "Type Here"
item editor introduced in 0.6.0 (reorder + add) now also **removes** and **renames** existing items
and lets a new item **pick its type** — Visual Studio–style CRUD on a menu / toolbar item tree, on
both engines, with every untouched item preserved byte-for-byte.

### Added

#### Menu & toolbar editing
- **Remove items.** The `…` editor's ✕ now deletes an **existing** item, not just an unsaved one.
  Removing a submenu parent takes its **whole subtree** with it: the item's field declaration,
  construction, property block, event wiring and `Items` / `DropDownItems.AddRange` membership are
  all stripped, and a parent `AddRange` that loses its last element is deleted outright rather than
  left empty. Every surviving item stays byte-identical.
- **Rename items.** An existing item's caption is now editable inline — the engine rewrites its
  `Text = "…"` string literal **in place**, leaving every other property (`Image`, `ShortcutKeys`,
  `Checked`, …) untouched. Clearing the field leaves the source `Text` unchanged, so a rename can
  never silently wipe a caption.
- **Item-type picker.** A new item now chooses its type from a **context-appropriate** list keyed to
  the owner strip — menu item / combo / text box for a `MenuStrip`; button / label / separator /
  split & dropdown button for a `ToolStrip`; status label / progress bar for a `StatusStrip`.
  Choosing **Separator** drops the caption; existing items keep their concrete type.

### Safety
- The safe-save gate (`OnlyItemsChanged`, ex-`OnlyItemsAddedOrReordered`) proves a
  remove / rename / reorder / add edit touched **only** the item tree: exactly the removed fields
  were dropped and the added fields minted (the class-member count moves by that net, so no method or
  property is smuggled in or silently deleted), and no removed field name lingers anywhere — a
  dangling reference the syntax-only parse check would miss. Edits that would **reparent** an item,
  drop a hand-written comment inside a shrunk `AddRange`, remove an item still referenced by non-item
  code (e.g. `MdiWindowListItem`), or delete a field declaration sharing a physical line with a
  neighbour are **refused**, never silently applied.

---

_Internal:_ engine `SetItems` extended to REMOVE (whole-subtree, whitespace-safe whole-line splices)
and RENAME (in-place literal rewrite) behind a reparent guard; the gate renamed and hardened for
removed-id / rename canonical-form / comment fail-safes; extended end-to-end and live-webview
coverage including the adversarial refusal cases.

## [0.6.0] — 2026-07-07

This preview deepens the **collection & value editors** toward Visual Studio parity. The
`TreeView.Nodes` editor now round-trips a node's **images, check state, tooltip and visual style**;
menus and toolbars gain a **"Type Here" item editor** (reorder + add) on both engines; and the
property grid picks up a **Cursor** picker and a generic **`string[]` (`Lines`) editor**.

### Added

#### TreeView node editor
- **Node images.** A tree node's `ImageKey` / `ImageIndex` and `SelectedImageKey` /
  `SelectedImageIndex` now round-trip through the `TreeView.Nodes` editor. The key and index of a
  pair are mutually exclusive (last-write-wins, matching WinForms), so setting one clears the other.
  On the **.NET Framework** engine the node's glyph is drawn live from the form's `ImageList`.
- **Check state & tooltip.** A node's `Checked` flag and `ToolTipText` are now editable and persist
  to the `.Designer.cs`.
- **Node visual style.** A node's `ForeColor`, `BackColor` and `NodeFont` round-trip as
  property-grid–style values. A font that can't be reproduced safely (an uninstalled family that GDI+
  would substitute, a non-`Default` GDI charset, or a vertical font) stays **read-only** rather than
  being silently changed.

#### Menu & toolbar editing
- **ToolStrip / MenuStrip "Type Here" item editor.** The `…` on a `MenuStrip` / `ToolStrip` /
  `StatusStrip`'s `Items` now opens a structural editor to **reorder** items within a sibling group
  and **add** a new item — either at the top level or into a menu item's drop-down — Visual
  Studio–style. Every other item property (`Image`, `ShortcutKeys`, event wirings, …) is preserved:
  only the affected `Items.AddRange` order / membership is rewritten. Works on **both** engines (the
  .NET Framework compiled preview reflects the change on its next render).

#### Property grid
- **Cursor editor.** The `Cursor` property is now a standard-value dropdown (Default / Hand / …); the
  picked cursor round-trips as `Cursors.<Name>` via `InstanceDescriptor`. A custom / `.cur` cursor
  with no matching `Cursors.*` member stays read-only instead of being clobbered.

#### Collection editors
- **`string[]` collection editor.** String-array properties such as `TextBox.Lines` now open the same
  string-collection editor as `Items`. When `Lines` is backed by the control's `Text` in the source
  (the pattern the VS designer emits), the edit rewrites the **effective** assignment so the two stay
  in sync and no content is lost; a value that can't be represented safely (e.g. RTF-backed or
  `.resx`-backed text) stays read-only.

---

_Internal:_ new sample fixtures (`LinesForm`, `MenuForm`, `TreeImageForm`, `TreeStyleForm`), extended
engine, end-to-end and live-webview coverage for every new editor, and adversarial review passes over
the round-trip / data-loss gates.

## [0.5.0] — 2026-07-05

This preview brings **Visual Studio Collection Editors** to both engines — the `…` button now
opens a real editor for `Items`, `ListView.Columns`, `DataGridView.Columns` and (hierarchical)
`TreeView.Nodes`, including on compiled **.NET Framework / DevExpress** forms — plus a round of
**canvas & property-grid polish** (keyboard nudge, Duplicate, Reset, bold non-default properties,
a description pane), **Lock Controls**, smarter **cross-runtime routing**, and sturdier
**round-trip saving** and **load-failure** handling.

### Added

#### Collection editors
- **Visual Studio Collection Editors (`…`).** Collection properties now open a real editor instead
  of being read-only: **String collections** (`ComboBox` / `ListBox` / `CheckedListBox.Items`),
  **`ListView.Columns`**, **`DataGridView.Columns`**, and a recursive **`TreeView.Nodes`** tree
  editor. Edits reconcile the collection in place — concrete column / node types, canonical names,
  and `ISupportInitialize` blocks are preserved — and persist as `.Designer.cs` text.
- **Collection editors on compiled net48 / DevExpress forms.** All of the above also work on the
  .NET Framework engine: the editor reads and writes through the .NET 9 pure-text path (no vendor
  assembly is loaded just to edit a collection), and the compiled preview's collection or node tree
  is **rebuilt live** on the running instance, so the canvas updates immediately instead of waiting
  for a rebuild.

#### Designer surface
- **Keyboard nudge.** Move the selection one pixel with the arrow keys (resize with `Shift`),
  matching Visual Studio.
- **Duplicate (`Ctrl+D`).** Clone the selection in place with a cascade offset, without touching the
  clipboard.
- **Lock Controls.** A form-wide *Lock Controls* toggle (VS-style) freezes move / resize / nudge /
  align and shows a 🔒 glyph with no resize handles. _(Session-only for now — not yet persisted to
  the `.resx`.)_
- **Center horizontally / vertically in form** for the current selection, plus **resize snaplines**
  and a **hover-hint** outline as the pointer moves over controls.

#### Property grid
- **Right-click *Reset*.** Reset a property to its default from the grid's context menu, on **both**
  engines; a non-resettable property surfaces a partial-preview note instead of going stale.
- **Bold non-default properties** and a **description pane** at the bottom of the grid (the selected
  property's name and summary), matching Visual Studio.

### Changed
- **Cross-runtime routing.** A **multi-target** form whose vendor controls the .NET 9 engine can't
  load now offers a **one-click switch to the .NET Framework compiled preview**; the choice is
  remembered as the form's control source and survives a reload.
- **Sturdier round-trip saving.** Whole-file save now preserves constructs the serializer used to
  drop: `BeginInit` / `EndInit` blocks keep a form in the safe-save gate (the save is refused rather
  than silently stripping them), `+=` event wirings are captured verbatim and re-emitted, and
  component-reference assignments (`this.AcceptButton = this.okButton`) resolve on load.

### Fixed
- **Load-failure & partial-render feedback.** When a form only partially renders (unresolved
  controls) or fails to load, the canvas now shows a categorized banner — a *partial render* warning
  vs. an error with the last-known-good picture — instead of a misleading blank surface, with a
  non-nagging dismiss.
- **"Project Controls" toolbox no longer silently empties on .NET-Core `WinExe` projects.** The
  project resolver now prefers the managed `.dll` over the apphost `.exe`, so the dependency resolver
  no longer trips on the native launcher and the project's own controls appear in the toolbox.

---

_Internal:_ a headless **live-webview test harness** (jsdom loads the real `designer.js` /
`panel.js`) now guards the webview interaction loop in CI, alongside the existing engine and
end-to-end suites.

## [0.4.0] — 2026-07-02

This preview introduces **UI localization in six languages** and a large round of **.NET
Framework (net48) editing** — you can now add, delete, rename and switch tab pages on compiled
DevExpress / WinForms forms, drop the project's own vendor controls from the toolbox, and cut /
paste on the compiled preview — plus an on-canvas smart-tag *Tasks* flyout, persistent container
outlines, and smarter engine routing.

### Added

#### Localization
- **UI localization (6 languages).** The interactive designer UI — the canvas surface and toolbar
  tooltips (zoom / align / distribute / tab-order / ruler), most of the right-click context menu,
  the Properties / Events / Outline / Toolbox panels, the Choose Items dialog, edit hints, and the
  canvas status line — is now translatable via a new **`winformsDesigner.language`** setting:
  **English** (default), **Русский**, **简体中文**, **Français**, **Deutsch**, **Español**. The
  language is chosen **in the extension settings** (scope *window*) and does **not** follow the VS
  Code display language. Counts are pluralized per each language's CLDR rules, and any untranslated
  string falls back to English, so translations can arrive incrementally. Enum and color *values*
  stay canonical English so they remain typeable and round-trip cleanly; engine diagnostic text is
  passed through. _(A few of the newest strings — the on-canvas tab-editing menu items and the
  smart-tag flyout links — are still English-only.)_
- **Localized host dialogs, notifications and status bar.** The extension-side chrome is translated
  too — the *Select Control Assembly / Project* quick-pick and file dialogs, the control-source
  status-bar item and its tooltips, and the toast / notification messages (unresolved controls,
  add-reference prompt, assembly-path fallback warning, …).
- **Localized VS Code manifest chrome.** Static chrome rendered by VS Code — the Marketplace
  description, the custom-editor and view names, the activity-bar title, and every settings-page
  title and description — is now localized via `package.nls*.json`. _Command-palette command titles
  intentionally stay English in the runtime setting's non-English modes, because VS Code renders
  palette titles from its own Display Language (a documented platform limitation)._
- **Live language switch.** Changing `winformsDesigner.language` takes effect **immediately** in
  already-open designer and panel webviews (they are re-emitted on the spot), and a translated toast
  offers **Reload Window** so the manifest chrome (palette / settings) catches up.

#### .NET Framework (net48) engine
- **Tab-page editing on compiled DevExpress / WinForms forms.** On a net48 (Framework / DevExpress)
  form you can now **single-click a tab header to switch** the active tab, **double-click to rename**
  it, **add** a new empty tab page, and **delete** the active tab page together with its whole
  subtree (with a modal confirm). Each is a single undoable edit that persists to the `.Designer.cs`
  (via the .NET 9 text-splice) and updates the live picture. Works reflectively, so it covers both
  WinForms `TabControl` and DevExpress `XtraTabControl` with no compile-time DevExpress reference.
- **Vendor / project (DevExpress) controls in the toolbox.** The toolbox for a net48/DevExpress form
  now merges the framework controls with the **project's own custom / vendor controls** (the ones
  the .NET 9 loader can't read) under a *Project Controls* category, each shown with its 16×16
  `ToolboxBitmap` icon — so those controls can be dropped onto a compiled-preview form. Adding one
  emits a pure-text `new <Fqn>()` edit without loading the vendor assembly into the .NET 9 engine.
- **Source-set (bold) properties and wired event handlers for net48 controls.** For compiled
  net48/DevExpress controls the property grid now **bolds properties that were assigned in the
  `.Designer.cs` source**, and the **Events** tab shows which handlers are wired — matching the
  .NET 9 engine. (Previously neither was populated for the net48 engine.)

#### Designer surface
- **On-canvas smart-tag *Tasks* flyout.** A chevron glyph now appears at the top-right of the single
  selected control (VS / DevExpress-style). Clicking it opens a flyout that edits the control's
  common properties inline (*Text, Enabled, Visible, Dock, Anchor, colors, …*) through the same edit
  path as the property grid, with checkbox / dropdown / text editors, plus **All Properties…** and
  **Learn More Online** links.
- **Persistent dashed outlines around container controls.** Every control holding at least one
  visible child now gets a persistent dashed outline on the surface (VS-style layout hint), making
  panels / group boxes / table layouts visible even when not selected.

### Changed
- **Adding a project / vendor control now resolves the exact type.** When adding a control from the
  toolbox that comes from a project / vendor assembly, the **fully-qualified name** is sent as the
  add key instead of the short name. A vendor control whose short name collides with a framework
  type (e.g. a custom `Panel`), or two project controls sharing a short name, now resolve
  unambiguously in both engines. Framework controls / components are unchanged.
- **Cut and paste now work on the .NET Framework compiled preview.** Cut / paste are no longer
  blocked on a net48 form; a paste is **mirrored into the live picture** by live-instantiating each
  pasted clone (with a status note when the control assembly is unavailable and only the text / undo
  state can be updated).
- **Framework / DevExpress forms auto-route to the compiled engine.** When no control source is
  chosen, the host now detects a .NET Framework / DevExpress project and routes its form to the
  **net48 engine** instead of the .NET 9 engine drawing a near-empty form. A single-target Framework
  project that **isn't built yet** now shows a message and offers to pick a control source, rather
  than rendering a misleading empty form.
- **Removed the on-canvas "Dock:" text badge.** A docked control no longer paints a
  `⬓ Dock: <side>` label on the surface — it simply shows no anchor tethers. Dock remains editable
  via the property grid's dock glyph.
- **net48 add-control skips the project-reference prompt.** Adding a control on a net48 form no
  longer offers to add a project `<Reference>`, since a Framework form's project controls already
  live in the form's own compiled assembly.

### Fixed
- **Only the active tab's controls are hit-testable.** Controls sitting on non-active (hidden) tab
  pages are no longer in the click / hit-test map, so a control stacked under the active page can no
  longer steal a click (e.g. clicking a footer panel no longer selects a control from an inactive
  tab). Fixed in **both** engines, covering standard WinForms inactive pages as well as DevExpress
  pages that stay `Visible = true`.
- **Add-control failures report the real cause (net48).** When adding a control fails in its
  constructor, the error note now shows the **underlying exception message** (unwrapped from
  `TargetInvocationException`) instead of a generic reflection-wrapper message.
- **Control-type resolution hardened against cross-assembly short-name rebinding (net48).** A dotted,
  fully-qualified type name that fails to resolve no longer silently falls back to a same-short-name
  type in a different assembly — which a crafted paste clip could otherwise use to steer the resolved
  type. Only a bare short name uses the short-name fallback.

---

_Internal:_ a new `npm run l10n:parity` CI helper checks every locale against the English source of
truth (runtime catalog and `package.nls`), reporting missing / extra keys, `{placeholder}`
mismatches, and missing CLDR plural categories.

## [0.3.2] — 2026-07-01

Patch release. Completes the Marketplace refresh begun in 0.3.1 — whose Marketplace
publish failed on a transient network error (`ECONNRESET`), so the listing had not yet
picked up the net48 documentation — and adds discoverability keywords plus a more
resilient publish step.

### Changed
- **Discoverability** — added Marketplace keywords for the .NET Framework engine:
  `net framework`, `net48`, `devexpress`.
- **Release reliability** — the Marketplace / Open VSX publish steps now **retry** on
  transient network failures (e.g. `ECONNRESET`), so a flaky connection no longer fails a
  release.

## [0.3.1] — 2026-07-01

Documentation-only patch — no functional changes to the designer. Refreshes the
Marketplace listing and repository docs, which still described .NET Framework hosting as
*not started* after the net48 engine shipped in 0.3.0.

### Changed
- **Docs** — the READMEs (repository + Marketplace) and `CONTRIBUTING` now document the
  **.NET Framework (net48) engine**: the experimental compiled preview for `net4x` /
  DevExpress forms, its requirements, the two-engine architecture, the `engine-net48/`
  repository layout, and its status — instead of listing .NET Framework hosting as *not
  started*.

## [0.3.0] — 2026-07-01

Adds a **second rendering engine for .NET Framework projects**, so forms built on
classic WinForms component suites (e.g. **DevExpress** and other `net4x` control
libraries) that the .NET 9 engine cannot load now render — and can be edited — inside the
designer. The extension runs both engines side by side and routes each form to the right
one automatically.

### Added

#### .NET Framework (net48) engine — *experimental*
- **Compiled preview for Framework forms** — forms whose controls target .NET Framework
  (`net4x`) are rendered by a dedicated **.NET Framework 4.8** engine that **instantiates
  the compiled control types** from the project's build output and paints them, so vendor
  controls (DevExpress `XtraUserControl`, …) look pixel-accurate — the same fidelity the
  .NET 9 engine gives modern controls.
- **Automatic engine routing** — the extension now runs **two engine processes** and picks
  one per form from the resolved control assembly's runtime: a Framework assembly (no
  `.deps.json` / `.runtimeconfig.json` sidecar) → the net48 engine; everything else → the
  .NET 9 engine. Each engine starts lazily and self-heals if its process exits.
- **Live editing on the compiled preview** — the **property grid**, **drag / move / resize
  / align**, **add / remove**, and **z-order** apply **live** against the instantiated
  instance on a **best-effort basis** (a rebuild is authoritative); the change is persisted
  as `.Designer.cs` text (via the .NET 9 splice) and re-renders on the next build. A
  **compiled-preview badge** (🔒 *preview*) appears in the status bar. *Cut / paste and dropping project-specific (non-framework) controls are not
  supported on this engine yet — manual source edits appear after a rebuild.*

### Changed
- **Control-source resolution for Framework projects** — choosing a `.csproj` or browsing
  for a control source now resolves **`OutputType=Exe`** projects (a net48 WinForms app's
  `.exe`, not only a `.dll`) and picks the freshest build under `bin/`, fixing
  *"Could not resolve build output"* for Framework projects. The **Browse** dialog now
  accepts `.exe` as well as `.dll`.

### Fixed
- **Root-type detection via the sibling `.cs`** — the base type (`Form` vs `UserControl`,
  including vendor bases such as `XtraUserControl` that derive from `UserControl`) is now
  read from a form's main `.cs` when its `.Designer.cs` partial omits the base clause, so a
  `UserControl` opened through its `.Designer.cs` is no longer mis-rendered as a `Form`.
- The .NET 9 project resolver's `bin/**` search now also matches `<AssemblyName>.exe`
  (not just `.dll`), another cause of *"could not resolve build output"* on `OutputType=Exe`
  projects.

## [0.2.0] — 2026-07-01

Second preview — a large round of Visual Studio-parity work in the property grid,
image / `.resx` support, layout-panel editing and control-source selection, on top of
the 0.1.0 foundation.

### Added

#### Property grid
- **VS-style Color editor** — the Color properties (BackColor/ForeColor/…) now show a
  colour swatch plus a dropdown to a tabbed palette (**Custom / Web / System**) with
  theme-accurate swatches, alongside the existing free-text field.
- **VS-style Font editor** — Font properties are now **expandable** into sub-rows
  (Name / Size / Unit / Bold / Italic / Underline / Strikeout); the Name row suggests
  installed font families and the Unit row uses the framework's own unit list.
- **Flags-enum dropdown** — `[Flags]` enum properties (other than Anchor, which keeps
  its glyph editor) now get a checkbox dropdown to toggle individual members.
- **Anchor / Dock editors** — a visual **Anchor** editor (a frame with four toggle
  bars) and a **Dock** zone picker, replacing free-text editing of these properties.
- **Image properties** — Image / BackgroundImage / Icon properties show a thumbnail
  preview with **Import…** and **(none)** actions.

#### Images & `.resx`
- **`.resx` image pipeline** — images stored in a form's sibling `.resx` (the
  `resources.GetObject(...)` pattern the VS designer emits) are now **rendered** in the
  preview, and you can **Import** a new image or **clear** it; the change is written
  back into both the `.Designer.cs` and the `.resx`, with safety limits on file and
  pixel size.

#### Layout panels
- **TableLayoutPanel editing** — a control's cell (**Column / Row**) and the
  **Column/Row styles** (size type + value) are surfaced in the grid and editable; the
  designer now honours 3-argument `Controls.Add(child, col, row)`.
- **SplitContainer** — `SplitterDistance` is editable and reflected in the layout.
- **FlowLayoutPanel** — reorder controls (flow follows z-order).
- **Canvas anchor tethers** — the selected control shows dashed tether lines to its
  anchored edges, plus a badge when it is docked.

#### Direct manipulation
- **Reparent** — move a control into another container from the Outline or canvas.
- **Reset property** — reset a property to its default; setting Dock/Anchor now clears
  its conjugate automatically (matching VS).
- **VS-style right-click menu** on the canvas (View Code, Bring to Front / Send to
  Back, Cut / Copy / Paste / Delete, *Select `<parent>`* chain, Properties, …) with the
  form root protected from cut / delete / z-order.
- **Equal-spacing snaplines**, and **Distribute** / **Make Same Size** on the align
  toolbar.

#### Toolbox & control sources
- **Toolbox control icons** — controls now show their native `[ToolboxBitmap]` icons
  (the same ones Visual Studio uses).
- **Control Source picker** — a command and a status-bar item to choose which
  **project (`.csproj`) or assembly (`.dll`)** provides custom / third-party controls;
  the designer prompts when a form references types it cannot resolve.
- **Auto-add project reference** — dropping a control from an assembly the form's
  project does not yet reference offers to add the `<Reference>` for you.
- **Choose Toolbox Items** improvements — the dialog shows its target tab, respects
  `[DesignTimeVisible(false)]`, and pre-checks and adds browsed items.

#### Accessibility
- **Outline mirror-tree** is exposed as an ARIA tree (roles, levels, keyboard
  navigation).

### Changed
- **Discoverability** — expanded the Marketplace tags/keywords: `winforms`,
  `windows forms`, `c#`, `csharp`, `designer`, `form designer`, `ui designer`,
  `visual designer`, `gui`, `forms`, `.net`, `dotnet`, `net9`, `wysiwyg`,
  `drag and drop`.
- **Accurate compatibility** — declared `extensionKind: ["workspace"]`. The
  extension hosts a .NET process and reads the project on the machine where the
  code lives, so it is **not** a universal/web extension; the listing now reflects
  that instead of showing *Works with Universal*.
- The **CHANGELOG is now bundled** into the package, so the Marketplace shows a
  proper **Changelog** tab.

## [0.1.0] — 2026-06-30

First public preview — a Visual Studio-style WinForms designer running natively in
VS Code, backed by a headless .NET 9 rendering/editing engine.

### Designer surface
- **Live form rendering** of `.Designer.cs` — controls (including custom and
  third-party ones) are really instantiated and painted via their own `OnPaint`,
  so the preview matches runtime. Full-frame render plus fast per-control
  dirty-region patches.
- **Visual Studio-style custom editor** — opening a form's `.cs` (with a sibling
  generated `.Designer.cs`) opens the designer; **View Code** switches back to text.
- **Unsaved-buffer preview** with a dirty indicator and a toolbar **Save** button;
  live update on save and on external file changes.
- **Zoom** (toolbar, `Ctrl`+wheel, `Ctrl` `±`/`0`) and in-panel **Properties /
  Outline / Toolbox** tabs (focus with **F4**).

### Property grid
- Primitives and enums, plus complex types — `Point`, `Size`, `Color`, `Font`,
  `Padding`, `Rectangle` — converted to idiomatic C# via `InstanceDescriptor`.
- **Composite expansion** (`Size` → `Width`/`Height`, etc.), **standard-value
  dropdowns**, search, and **Properties / Events** views with sort by category or
  name.

### Toolbox
- Auto-populated from `System.Windows.Forms` (≈39 controls across Visual Studio
  categories) **plus controls discovered in your project assembly** (collectible
  load context).
- **Choose Toolbox Items** dialog and toolbox search.

### Direct manipulation & editing
- Click-to-select, move, 8-handle resize, and form resize.
- **Multi-select** (`Ctrl`/`Shift`-click and rubber-band) with group move/delete.
- **Add / remove controls**, **copy/paste controls** (clone with rename + offset,
  injection-guarded, parents into containers), and **z-order** (bring to front /
  send to back).
- **Align toolbar**, **tab-order editor**, and **snaplines**.

### Events
- Describe events; **wire / unwire / rewire** handlers via an editable combobox;
  **generate a handler stub** with the correct signature; **double-click to
  navigate** to the handler body in the code-behind.

### Save & code sync
- **Byte-minimal targeted edits** written back into `.Designer.cs`; a save-splice
  path guarded by representability and statement-diff gates; original encoding/BOM
  preserved.
- **Component tray** for non-visual components and a **Document outline** of the
  control hierarchy.

### Project & runtime
- **MSBuild design-time assembly resolution** (multi-target aware, with a
  candidate cache) and an explicit `winformsDesigner.assemblyPath` setting.
- Requires **Windows** and the **.NET 9 SDK**.

### Safety
- **Workspace Trust** gating (the engine loads and runs project control
  assemblies on preview).
- Interpreter **allowlists** (construction / static-invocation / static-read) and
  **identifier validation** to keep rendering a crafted `.Designer.cs` safe.

[Unreleased]: https://github.com/SkivHisink/winforms-designer-vscode/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/SkivHisink/winforms-designer-vscode/compare/v0.12.0...v1.0.0
[0.12.0]: https://github.com/SkivHisink/winforms-designer-vscode/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/SkivHisink/winforms-designer-vscode/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/SkivHisink/winforms-designer-vscode/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/SkivHisink/winforms-designer-vscode/compare/v0.8.1...v0.9.0
[0.8.1]: https://github.com/SkivHisink/winforms-designer-vscode/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/SkivHisink/winforms-designer-vscode/compare/v0.7.1...v0.8.0
[0.7.1]: https://github.com/SkivHisink/winforms-designer-vscode/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/SkivHisink/winforms-designer-vscode/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/SkivHisink/winforms-designer-vscode/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/SkivHisink/winforms-designer-vscode/compare/v0.4.1...v0.5.0
[0.4.0]: https://github.com/SkivHisink/winforms-designer-vscode/compare/v0.3.2...v0.4.0
[0.3.2]: https://github.com/SkivHisink/winforms-designer-vscode/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/SkivHisink/winforms-designer-vscode/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/SkivHisink/winforms-designer-vscode/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/SkivHisink/winforms-designer-vscode/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/SkivHisink/winforms-designer-vscode/releases/tag/v0.1.0
