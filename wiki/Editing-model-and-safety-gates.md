# Editing model and safety gates

Every gesture — drag, resize, property edit, add, delete, rename, reorder — becomes a **targeted source edit**
computed by the engine and applied by the host as one undoable step. Nothing regenerates `InitializeComponent`.

## What "byte-local" means

Moving a button rewrites exactly this:

```diff
- this.button1.Location = new System.Drawing.Point(12, 15);
+ this.button1.Location = new System.Drawing.Point(30, 40);
```

Not the surrounding statements, not their order, not their whitespace, not the file's line endings or BOM. A
hand-written comment two lines above survives. So does a helper call the designer does not understand.

## The gates

Each edit kind has a gate that runs **after** the new text is composed and **before** it is accepted. The gate
re-parses both versions and proves the claim:

| Gate | Proves |
|---|---|
| `OnlyTargetChanged` | exactly the target property's value changed |
| `OnlyControlAdded` | original statements intact; every added statement references the new control; exactly one new member |
| `OnlyControlRemoved` | only the target's statements and field are gone; no dangling references |
| `OnlyWiringAdded` | one event wiring added, nothing else |
| batch preflight (`SetProperties` / `ResetProperties`) | every target of a multi-selection edit resolves and splices in memory first; a duplicate, missing, inherited, unrepresentable or stale target returns no text at all, so a valid prefix can never be committed |
| exact-offset paste preflight | `Ctrl`+drag duplicate composes every clone against one immutable revision and returns without a document edit if any member cannot be represented safely |
| localizable-source gate | on a localizable form, structural source edits are refused (values route to `.resx`) |
| render gate | a form whose last render failed is read-only until it renders again |
| baseline gate | the file on disk still matches what we last read — otherwise someone else edited it |

A gate failure is not an error to be worked around; it is the feature. The gesture is refused, the status bar
says why, and your file is untouched.

## Undo

The extension implements VS Code's native custom-document undo, so `Ctrl+Z` walks designer gestures, not text
edits. When an edit also writes a `.resx` (an image import, a localized value, the localizable conversion), the
resource write joins the **same** undo entry: undo restores the previous resource bytes, or deletes a `.resx`
that the edit created.

## Saving

`.Designer.cs` is written on save, atomically: the new bytes are staged into a sibling temp file and the platform
replaces the target in place (`MoveFileEx(MOVEFILE_REPLACE_EXISTING)` on Windows). An interrupted write can never
truncate your form, and the file never disappears from the Explorer mid-save. If the target is briefly held open
by a scanner or indexer, the replace retries for a fraction of a second before surfacing an error.

Two refusals can surface on save, and both mean "someone else's data is at stake":

- **Disk conflict** — the file changed since the designer last read it (git checkout, another editor, a
  generator). Revert to adopt the external version.
- **Localizable divergence** — a dirty generated-source buffer on a localizable form, which normally can only
  come from a recovered hot-exit backup that no longer agrees with the resources.

## What the designer refuses on purpose

- Editing a form whose preview failed (you would be editing a picture that is not your form).
- Structural edits to a localizable form (adding, deleting or reparenting controls) — values are resource-driven
  there; the structure must be edited as code.
- Any splice into a designer file whose shape it cannot recognize with certainty. It appends rather than
  rearranges, and where it cannot even do that, it declines.
- Overwriting a property whose value comes from an expression the engine could not evaluate — see
  [Localization → Externally localized forms](Localization#externally-localized-forms).
