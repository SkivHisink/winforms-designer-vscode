// 0.10.0 trust-floor S5 — pure predicate for the "last render failed → read-only" gate.
//
// When the last render FAILED (or nothing has rendered yet), the canvas holds a STALE preview of a form the designer
// couldn't load. A mutating gesture against that stale graph must be refused fail-closed, so an edit can't splice
// against a graph that isn't real. A read (pick/save/ready/list*) still passes — inspection and saving survive a
// failed render, and `ready` (the first-render trigger) is not a mutation, so the gate can never deadlock the initial
// render. Pure (no vscode / no i18n) so the truth-table is unit-testable; the session wraps it with a status post.

/** True iff `type` is a mutating message (in `blocked`) AND the last render did NOT succeed. */
export function refuseWhileRenderFailed(
  type: string | undefined, blocked: ReadonlySet<string>, renderOk: boolean): boolean {
  return !!type && !renderOk && blocked.has(type);
}
