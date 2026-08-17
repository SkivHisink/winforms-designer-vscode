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
     └─ .NET Framework 4.8  renders the last COMPILED build (net4x/DevExpress)
```

The host never parses C# itself and the engine never touches VS Code APIs. They speak JSON-RPC over a named pipe;
the engine writes no files (with one deliberate exception, the `.resx`, described in
[Localization](Localization)) — it *composes* text and the host applies it as an undoable workspace edit.

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
the extension routes to the **.NET Framework 4.8 engine**, which takes the opposite approach: it instantiates the
**compiled type** from your last build and renders that. You get pixel-accurate vendor controls; the cost is that
the picture reflects the last build rather than unsaved source, which the canvas discloses in a banner.

Routing is automatic, per form, based on the owning project's target framework. Both engines answer the same RPC
surface, so the host code path is shared; where behavior genuinely differs the host asks which engine it is
talking to (`engineKind`).

One thing is deliberately NOT split: **all source rewriting happens in the modern engine's Roslyn splicer**, for
both runtimes. The net48 engine only mirrors an already-decided edit onto its live compiled instance. That keeps
one implementation of the editing rules, so a net4x form and a net9 form get byte-identical generated code.

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
- **View state** (zoom, ruler, selected tabs, chosen culture, collapsed notice) is per form and non-persistent
  beyond the session, except for the few things stored in the webview's own state.
