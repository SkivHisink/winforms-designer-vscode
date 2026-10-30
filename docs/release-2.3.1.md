# Release 2.3.1: an explicit project context survives a concurrent render

Date: 2026-10-30  
Status: **PREPARED — windowless checks pass on the final tree; the Extension Host suites run in CI on the release commit**

Patch release over 2.3.0 (tag `v2.3.0`, commit `17766cd`). Under the maintenance rule
[R20-04](roadmap-2.0.0-to-3.0.0.md#200--20x--fix-the-baseline-and-maintain-it), a patch release carries fixes for
breakage of existing workflows. This one restores opening a form that several projects compile, and it fixes a
.NET Framework describe defect that its acceptance exposed. No capability, protocol or dependency changed.

## Defect

A form in a shared project imported by two .NET Framework projects was refused with *Designer open refused: the
generated source is compiled by more than one project*. Choosing a project context did not clear the refusal. There
were three causes.

1. **An unrelated render discarded the choice.** The choice compared the render generation before and after each of its
   own waits. Any render started meanwhile, such as Retry, a control-source reload or engine recovery, made the choice
   return without effect. Before the project list appeared, the list then never opened; after it, only a status line
   reported the discard. None of these exits was logged.
2. **The preview banner offered actions that cannot help.** For this refusal it offered Choose Control Assembly and
   Rebuild. Neither changes which project owns the file: ownership comes from the Compile items of the project files.
   The project-context choice itself was offered only in the command palette and in a notification shown once per
   session.
3. **A project chosen as the control source did not name the owner.** Select Control Assembly / Project → Project set
   only the assembly override, which the ownership gate does not read.

## Change

- Only a change of the designer source invalidates a project-context choice in progress. The pick is still proven by
  a fresh engine membership resolution against the current project files and source, and the reload that follows it
  supersedes the concurrent render. Every outcome (set, refused, cancelled, discarded, already in progress) is written
  to the WinForms Designer output.
- For `AMBIGUOUS_OWNER` and `STALE_PROJECT_CONTEXT` the banner offers Choose Project Context… together with Retry and
  Copy; Choose Control Assembly and Rebuild are withheld. Other failures keep their existing actions.
- While the form is refused for an ambiguous or stale owner, a project picked as the control source that compiles the
  form also becomes its project context, after the same membership proof. A refused or failed proof leaves only the
  control source applied, as before.

Unchanged: membership is proven on every resolution, a stale choice refuses the preview, and no fallback owner is
chosen. The interpreter allowlists, the edit-minimality gates and identifier validation are untouched.

## Defect found during acceptance

The first acceptance attempt with processes limited to four logical processors, the size of the hosted runner, failed
the .NET Framework engine suite: `RenderWorkerNestedPropertyTests.LiveEdit_AppliesANestedEnum_AndTheNextDescribeShowsIt`
found no sub-properties under `Appearance`. The engine and the test were unchanged since 2.3.0, and the same step had
passed 20 minutes earlier.

The .NET Framework describe runs every third-party converter query under a 200 ms bound. The compiled describe has
used a dedicated converter thread for that since the S043 correction, because a thread-pool task queued behind a busy
pool can spend its whole bound waiting to start. The expansion of sub-properties still used thread-pool tasks. Under
the four-processor limit, while the suite's test classes ran in parallel, the `GetProperties` query timed out before
it started, and the property was described without children: fail-closed, but the user loses those rows.

Both paths now share the dedicated converter thread; the bound and the fail-closed result are unchanged. Under the
same limit, the unchanged suite failed **6 of 10** runs before the change, always in this test, and passed **10 of 10**
after it.

## Acceptance-suite changes

The next attempt passed 29 of 45 CI steps and failed the stable-host smoke in `V2-FND-001-S122`. VS Code stable had
moved from 1.143.1, the 2.3.0 acceptance host, to 1.144.0. Focused S122 runs under the four-processor limit then
isolated three failure kinds, none of them specific to that version or to this release:

| Comparison (S122 alone, interleaved) | Failed runs |
|---|---|
| VS Code 1.143.1 / 1.144.0, same 2.3.1 build | 2 of 6 / 2 of 6 |
| Dedicated converter thread / the 2.3.0 thread-pool path, VS Code 1.144.0 | 2 of 6 / 3 of 6 |
| Logical processors 0–3 / 12–15, VS Code 1.144.0 | 1 of 7 / 1 of 7 |

**Isolated timing outliers.** Typical values stayed far below the fixed budgets, but single samples exceeded them:
first-use reconciliation of the 300-control .NET Framework form up to 1083 ms against 750 ms, the commit p95 of a DPI
leg up to 974 ms against 250 ms, and a preview p95 of 38 ms against 32 ms. The describe after a slow first use showed
no converter timeouts. By maintainer decision of 30 October 2026, the gates that were exceeded were widened from the
measured maxima:

| S122 gate | 2.3.0 | 2.3.1 | Largest observed sample |
|---|---:|---:|---:|
| First-use edit, plan+commit and reconciliation | 750 ms | 1500 ms | 1083 ms |
| Preview p95, every corpus | 32 ms | 64 ms | 38 ms |
| Commit p95, 300-control and vendor-heavy corpora | 250 ms | 1500 ms | 974 ms |

Model, capture and reconciliation budgets, the 50-control commit budget, the interactive bounds and the S016 budgets
did not fail and are unchanged. The calibration targets of the roadmap (R26) are unchanged as targets; the CI gate no
longer enforces those three values.

**A native Undo that did not reach the designer.** In about one run in fifteen, the first S122 Undo left the document
unchanged: the revision had not moved, the edit was still present, and the designer tab was the active editor. VS Code
gives a focused code editor or text input precedence over a custom editor for the global Undo command, and a chat input
initializes in the test window around that moment. S122 now re-focuses the designer and issues the command again, at
most three times in all, only when the revision provably did not move, so a second history step cannot be applied. Each
miss is logged. Failure messages for both S122 Undo checks and the first-use budget now report the delivery state and
the describe facts.

## Verification

On the final tree, without opening VS Code windows:

- .NET Framework engine suite under the four-processor limit: **10 of 10** runs pass (89/89 each).
- Extension unit tests **931/931**, webview **1047 checks across 219 tests**, headless end-to-end, performance
  baseline, static scenario catalogue, strict localization and mojibake scan: PASS.
- `npm run release:preflight -- --metadata-only` passes for v2.3.1; clean tree and tag identity are checked by CI on
  the release commit.

Extension Host evidence taken during preparation:

- The R23-09 owner fixture, including the new concurrent-render step and both built .NET Framework owners, passed on
  VS Code 1.84.0 and stable before the converter change.
- The last complete-order attempt passed steps 1–29 of 45: engine builds and suites, reference renders, coverage,
  dependency install and audit, extension tests, headless and webview end-to-end, and the full 1.84.0 smoke.

Not executed on the final tree, by maintainer decision: the full local run of all 45 CI steps, including both hosts'
Extension Host suites, VSIX packaging and isolation, and the installed upgrade/downgrade. CI on the release commit runs
them. No VSIX hash is bound here; the release workflow builds and publishes both packages from the tagged commit.

Local environment note: this network resets TLS handshakes to the npm registry that offer the post-quantum hybrid key
share. Local runs limited only the four registry-contacting steps to classic TLS 1.3 key-exchange groups; CI is
unaffected.

## Publication

1. Commit the release tree and push it; CI must pass every step.
2. Tag `v2.3.1` on that commit and push the tag. The release workflow checks the tag against the version, builds both
   VSIX packages, and publishes them with the `2.3.1` changelog section as release notes.

## Verification

- The R23-09 Extension Host owner fixture gained a step in which a render starts while the choice is being proven.
  With the 2.3.0 comparison restored, the step fails with *a render started during the choice discarded the explicit
  project context*. With 2.3.1 the whole fixture passes on VS Code 1.84.0 and stable, including both built .NET
  Framework owners.
- Webview acceptance checks that an owner refusal shows Choose Project Context and Retry, hides Choose Control Assembly
  and Rebuild, and that any other failure restores them.
