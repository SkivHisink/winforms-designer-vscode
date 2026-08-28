# Development

Building, prerequisites, the dev loop, coding conventions and the release ritual live in
**[CONTRIBUTING.md](https://github.com/SkivHisink/winforms-designer-vscode/blob/master/CONTRIBUTING.md)** — this
page does not repeat them. What follows is the orientation a maintainer needs *before* changing behavior.

## The test suites, and what each one is for

| Suite | Runs | Catches |
|---|---|---|
| `dotnet test tests/Engine.UnitTests` | engine logic, no VS Code | splicer output, gates, resx writing, culture rules |
| `dotnet test tests/Engine.Net48.UnitTests` | the Framework engine | net4x-specific describe/edit behavior |
| `npm test` (vitest) | pure host helpers | project parsing, scaffolding, atomic writes, discovery |
| `npm run e2e` | the **real engine** over JSON-RPC | rendering, editing, round-trips, cross-runtime parity |
| `npm run webview-e2e` | canvas + panel in jsdom | selection, drag, context menus, grid behavior |
| `npm run extension-host-e2e` | a real Extension Host | activation, commands, menu registration |

A behavior change is not done until the suite that owns it asserts the new behavior. When a change is about
*what the user's file looks like*, the assertion belongs in `Engine.UnitTests` (byte-exact) **and** in `e2e` (the
engine really renders/edits it).

## Invariants that must not be broken

These are load-bearing. If a change appears to require breaking one, that is the design discussion, not a detail.

1. **No wholesale regeneration.** Nothing rewrites `InitializeComponent` as a unit. Every edit is a splice
   guarded by a gate that proves it changed only its target.
2. **A gate is not advisory.** When it cannot prove the claim, the gesture is refused and the file is untouched.
   Widening a gate means naming the exact statements that may pass, not loosening the check.
3. **The engine writes no files.** It returns composed text — including the new `.resx` XML — and the host performs
   every disk write, bundling the resource write into the same undo entry as the source edit.
4. **The user's code never executes on open.** No constructor, no field initializers, no `Load`, no calls into
   project code to resolve values. The `net4x` compiled path is the explicit, disclosed exception.
5. **Disclosure over silence.** A partial render, a stale compiled preview, a resource-routed edit — each is
   surfaced in the canvas rather than smoothed over.
6. **Both runtimes get identical generated code.** All source rewriting happens in the modern engine's splicer;
   the Framework engine only mirrors decided edits onto its live instance.
7. **Saves are atomic and conflict-checked.** Staged write plus in-place replace; never overwrite a file that
   changed under us.

## Where the interesting code is

| Concern | File |
|---|---|
| Splicing controls in/out, VS-shaped emit | `engine/DesignerControlEditor.cs` |
| Property edits and their gate | `engine/DesignerPropertyEditor.cs` |
| Source → IR → live surface | `engine/DesignerIrBuilder.cs`, `DesignerIrExecutor.cs` |
| Render + hit-test in one pass | `engine/DesignerRenderer.cs` |
| Localizable conversion | `engine/DesignerLocalizeForm.cs` |
| Resource writing | `engine/DesignerLocalizedResxEditor.cs` |
| Custom document, undo, all gestures | `extension/src/designerEditor.ts` |
| Explorer `Add` scaffolding | `extension/src/scaffolding.ts` |
| Atomic file replacement | `extension/src/atomicFile.ts` |

## Adding a language

Runtime strings live in `extension/src/i18n/` (`en.ts` is the source of truth, others are JSON with the same
keys); VS Code manifest strings live in `package.nls*.json`. `npm run l10n:parity -- --strict` must pass: same
keys, same `{placeholder}` slots, required plural categories present.
