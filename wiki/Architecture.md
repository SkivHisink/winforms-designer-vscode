# Architecture

## The parts

```
VS Code
 ├─ Extension host (TypeScript)         extension/src/
 │   ├─ designerEditor.ts   custom editor: document, undo stack, all gestures
 │   ├─ engineClient.ts     typed JSON-RPC client
 │   └─ extension.ts        commands, Explorer "Add", toolbox, activation
 ├─ Webviews (plain JS, no framework)   extension/media/
 │   ├─ designer.js         the canvas: selection, drag, resize, snap lines
 │   └─ panel.js            Properties + Toolbox side panel
 └─ Engines (C#)                        engine/  and  engine-net48/
     ├─ .NET 10 engine      interprets the LIVE source and renders it
     └─ .NET Framework 4.8  interprets the LIVE source onto COMPILED net4x/DevExpress
                            controls (disclosed compiled-build fallback)
```

The host never parses C# itself and the engine never touches VS Code APIs. They speak JSON-RPC over a named pipe;
the engine writes no files at all — it *composes* text (both the `.Designer.cs` splice and the new `.resx` XML) and
the host applies it as an undoable workspace edit, with the resource write bundled into the same undo entry. See
[Localization](Localization).

## How a form becomes a picture

The modern engine follows the Visual Studio model, not the "run the user's app" model:

1. **Parse** `.Designer.cs` with Roslyn and locate `InitializeComponent`.
2. **Lower** its statements into an IR — a small, closed set of operations (construct a control, set a property,
   add to a collection, wire an event, apply resources…).
3. **Execute** the IR against a real `DesignSurface`, producing genuine WinForms controls.
4. **Render** the surface to a PNG and harvest the hit-test map (bounds of every control) in the same pass.

Two consequences follow, and both are intentional:

- **Your form's constructor never runs.** Neither do field initializers or `Load`. Opening a designer cannot
  start timers, hit a database, or show a window — exactly as Visual Studio behaves.
- **Only what the IR models is reproduced.** A statement outside that set — a call into your own code, an
  unusual expression — is reported as *unrepresentable*, and the canvas shows an honest "N constructs skipped"
  banner instead of pretending. See [Troubleshooting](Troubleshooting).

## Why there are two engines

A `net4x` project's controls (DevExpress and friends) cannot be loaded by a .NET 10 process. For those projects
the extension routes to the **.NET Framework 4.8 engine**, which follows the same Visual Studio model on a runtime
that can load those controls: it parses `InitializeComponent`, instantiates the form's **declared base type**, and
replays the statements onto the *compiled* vendor controls. You get pixel-accurate DevExpress controls drawn from
your live, unsaved source. A construct the interpreter cannot reproduce falls back to a compiled render of your
last build with a named, disclosed reason (`unrepresentableStatements`, `unsafeBinaryResource`, `baseTypeChanged`,
…), never a silent mismatch.

Routing is automatic and per form: an explicit control source (a per-form override, or
`winformsDesigner.assemblyPath`) wins; otherwise the owning `.csproj`'s build output decides — an output with no
`.deps.json` sidecar is a .NET Framework build and goes to the net48 engine, and a single-target `net4x` project
that has not been built yet prompts for an assembly instead of rendering. Both engines answer the same RPC surface,
so the host code path is shared; where behavior genuinely differs the host asks which engine it is talking to
(`engineKind`).

One thing is deliberately NOT split: **all source rewriting happens in the modern engine's Roslyn splicer**, for
both runtimes. The net48 engine only mirrors an already-decided edit onto its live compiled instance. That keeps
one implementation of the editing rules, so a net4x form and a net9 form get byte-identical generated code.

## v2.0.0 runtime boundary

The v2.0.0 architecture keeps the managed GA baseline to modern `win-x64` / `win-arm64` workers plus a .NET
Framework 4.8 x64 compatibility payload. It does not claim native ARM64 .NET Framework, x86, COM, or ActiveX support.
Those Tier D cases are excluded by name from v2.0.0 GA and must refuse before mutation with stable diagnostics such as
`X86_WORKER_UNAVAILABLE` or `COM_ACTIVE_X_UNSUPPORTED`.

## The design surface is real

Property values, standard values (dropdowns), type converters, extender properties, and the component tray all
come from `TypeDescriptor` against real component instances — not from a hand-written table. That is why vendor
controls expose their real properties, and why a property's editor (color picker, font dialog, collection editor)
matches what the type actually declares.

## Where state lives

- **`.Designer.cs` text** lives in the custom document, in memory, and is written on save. It is deliberately not
  an open `TextDocument`, so the generated file does not show up as a dirty editor tab — the form tab is the
  dirty, undoable thing.
- **`.resx`** is written to disk immediately (it is a resource file, as in Visual Studio) but is bundled into the
  same undo transaction, so one Ctrl+Z reverts both halves of an edit.
- **View state** is per form and **persisted in VS Code's `workspaceState`** (`designerViewStates`): zoom, Lock
  Controls, the selected page of each TabControl, the chosen localization culture, the active panel tab, and the
  toolbox/outline collapse state all survive closing and reopening a form without touching any project file. Only
  the ruler toggle and the collapsed-notice choice live in the webview's own state.
