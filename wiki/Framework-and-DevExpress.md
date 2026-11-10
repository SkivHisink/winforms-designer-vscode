# .NET Framework and DevExpress (`net4x`)

Forms in a `net4x` project are rendered by a bundled **.NET Framework 4.8 engine**, because a .NET 10 process
cannot load .NET Framework vendor controls. Routing is automatic and per form.

The v2.0.0 runtime boundary preserves this as x64 compatibility only. Modern projects use `win-x64` or `win-arm64`
workers, while `net4x` remains the x64 .NET Framework compatibility payload. x86, COM, and ActiveX are excluded from
v2.0.0 GA; unsupported requests fail before mutation with `X86_WORKER_UNAVAILABLE` or
`COM_ACTIVE_X_UNSUPPORTED`.

## What is different

| | Modern engine (net8 / net9 / net10 projects) | Framework engine (net4x) |
|---|---|---|
| Source of the picture | your **live source**, interpreted | your **live source**, interpreted onto the *compiled* net4x/DevExpress controls; a **disclosed compiled fallback** to the last build for constructs the interpreter cannot reproduce; a **partial preview** of the source when even the last build cannot be constructed |
| Vendor controls (DevExpress…) | not loadable | pixel-accurate |
| Unsaved changes | reflected immediately | reflected immediately on the interpreted path and in a partial preview — the unsaved buffer is what gets interpreted; on the compiled fallback, mirrored live where supported and otherwise after a rebuild |
| Your form's constructor | never runs | never runs on the interpreted path or in a partial preview (the declared base type is instantiated and the designer statements replayed); on the **compiled fallback** the real type is realized, so its constructor, field initializers and `Load`/`Shown` code do run |

An interpreted render *is* your live source, so there is nothing to disclose. When the Framework engine falls back
to the compiled build, that is surfaced as a dismissible render-diagnostics entry — *".NET Framework preview fell
back to the last compiled build."* with the named reason under **Show details** — and as a line in the **WinForms
Designer** output channel. There is no permanent engine badge on the canvas.

## The interpreted path

Since 1.8 the Framework engine takes the Visual Studio route for real `net4x` forms: the **declared base type**
plus the replayed designer statements, instead of constructing your own class. Supported edits are mirrored onto
that live instance, so the picture follows your typing. A construct the interpreter cannot reproduce degrades —
honestly and visibly — to a disclosed compiled render of the last build.

Values of vendor types, such as an editor's button
(`Properties.Buttons.AddRange(new EditorButton[] { new EditorButton(ButtonPredefines.Combo) })`), are not on the
interpreter's own list of what it constructs. Since 2.3.4 such a value is constructed when your **build makes exactly
that construction**: the form's compiled `InitializeComponent` calls the same constructor with the same constant
arguments. An argument you changed since the last build, another constructor, an argument your build chooses with a
condition, or a construction your build makes only elsewhere is not run; that whole statement stays unrepresented —
none of its values is constructed — until you build again.

## Partial preview

Since 2.3.4, a form that the interpreter cannot fully reproduce **and** whose last build cannot be constructed — its
constructor, or a child control's, needs services that only the running application provides — is drawn the way
Visual Studio's *Ignore and Continue* does:

- every control that could be built is drawn from your live source;
- a control whose constructor throws is a hatched, read-only placeholder where the source puts it, labelled with
  its name, declared type and exception;
- the statements that use it, and the ones the interpreter cannot represent, are not applied and are listed under
  **Show details**;
- a persistent notice marks the canvas as partial.

The other controls keep targeted edits, and each edit renders the source again. Save writes your source exactly as
it is; nothing is regenerated from the partial picture. A placeholder cannot be moved, resized, deleted, copied or
used as a parent. The failed constructor is not run again for every edit: that the build cannot be constructed is
remembered until you build again, close the form, or press **Retry**. A form that already has a full or last-build
preview never switches to a partial one.

## Build interaction

The Framework engine must load your assemblies **in place** — shadow-copying would break delay-signed vendor
graphs — so it pins your build output while a preview is loaded. That is coordinated rather than left to fail:

- A build started **outside** VS Code (Visual Studio, an external `msbuild`) is detected as it compiles and the
  output is handed back before MSBuild needs it, so it does not fail with `MSB3027`
  (`winformsDesigner.net48.releaseOnExternalBuild`, default `true`). Previews go view-only until the build lands,
  then re-render from it.
- Inside VS Code use **WinForms: Run Build Task (Release Preview First)** or **WinForms: Run Test Task (Release
  Preview First)** — `Ctrl+Shift+B` is routed there while a designer is active — and
  **WinForms: Release .NET Framework Assembly (for Rebuild)** as the manual recovery.

The modern engine is different: it loads from a private in-memory copy and never pins your managed output. The one
exception is a project-local **native** dll a control actually P/Invokes, which Windows maps in place — replacing
that file still needs **WinForms: Restart the Designer Preview Engine**.

Windows the preview realizes are confined to a desktop that is never displayed
(`winformsDesigner.net48.isolateRenderWindows`, default `true`), so a `net4x` form cannot flash onto your screen
because you opened its designer. If that desktop cannot be created (a locked-down window station) the engine says
so in the output channel and previews behave as before. This is containment, not a sandbox: a compiled preview
still runs your form's own code with your own permissions.

## Known limits

- The compiled fallback can only be as fresh as your last successful build.
- A partial preview shows nothing of what its placeholders stand for — not their contents, properties or events —
  and a child control that only a failed parent could hold is listed rather than drawn.
- Vendor smart tags appear only when the canvas **is** a compiled instance (the disclosed fallback, or the live
  compiled render after an edit on it). On an interpreted preview the vendor section is simply absent — reading it
  would require constructing your real form and running its constructor and `Load`. Commands that would only mutate
  the vendor's own preview are declined even where they are listed, because they change the picture without
  changing your code.
- Some vendor collection shapes stay read-only. They are shown as such rather than silently half-edited.
- The interpreted path's coverage grows between minor versions: a construct that falls back today may interpret
  after an update. The fallback itself is always disclosed with a named reason, never silent.
