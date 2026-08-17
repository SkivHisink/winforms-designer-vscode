# .NET Framework and DevExpress (`net4x`)

Forms in a `net4x` project are rendered by a bundled **.NET Framework 4.8 engine**, because a .NET 10 process
cannot load .NET Framework vendor controls. Routing is automatic and per form.

## What is different

| | Modern engine (net9/net10) | Framework engine (net4x) |
|---|---|---|
| Source of the picture | your **live source**, interpreted | your **last compiled build**, instantiated |
| Vendor controls (DevExpress…) | not loadable | pixel-accurate |
| Unsaved changes | reflected immediately | mirrored live where supported; otherwise after a rebuild |
| Your form's constructor | never runs | never runs — the interpreted path replays designer statements onto the declared base type |

The canvas always discloses which one you are looking at. When the Framework engine falls back to the compiled
build, the banner says so and names the reason.

## The interpreted path

Since 1.8 the Framework engine takes the Visual Studio route for real `net4x` forms: the **declared base type**
plus the replayed designer statements, instead of constructing your own class. Supported edits are mirrored onto
that live instance, so the picture follows your typing. A construct the interpreter cannot reproduce degrades —
honestly and visibly — to a disclosed compiled render of the last build.

## Build interaction

The engine does not hold your build output open. Rendering a form and enumerating its project's controls both
release their assemblies, so a `Rebuild` from your IDE or CLI succeeds while the designer is open (this is
covered by an end-to-end test that runs a real MSBuild rebuild).

Windows the preview realizes are confined to a desktop that is never displayed — a `net4x` form cannot flash
onto your screen because you opened its designer.

## Known limits

- The compiled preview can only be as fresh as your last successful build.
- Vendor smart tags are listed, but commands that only mutate the vendor's own preview are declined — they would
  change the picture without changing your code.
- Some vendor collection shapes stay read-only. They are shown as such rather than silently half-edited.
- The Framework engine is **experimental**: it is the part most likely to change between minor versions.
