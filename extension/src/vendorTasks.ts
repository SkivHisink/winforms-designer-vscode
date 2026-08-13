/**
 * When the vendor "Tasks" menu (the DevExpress smart-tag panel) may be asked for at all.
 *
 * Reading it needs the control's REAL compiled instance, and the net48 engine only has one when the preview itself
 * is that instance. Asking on an interpreted preview used to make the engine build one on the spot — which
 * constructs the user's actual form: their field initializers, their constructor and their `Load` handler all run,
 * and a real application's `Load` legitimately opens splash screens, docking panels and dialogs. Selecting a control
 * is not worth that, so the rule is: offer vendor tasks when a compiled instance already exists, and simply omit the
 * section when it does not.
 *
 * (Visual Studio does not have this dilemma: it never constructs the edited form at all — it instantiates the
 * declared BASE type and replays the initialization statements, so a vendor designer is always talking to components
 * the designer itself created.)
 */
export type PreviewKind = 'modern' | 'net48';

export interface PreviewState {
  engineKind: PreviewKind;
  /** The net48 engine's own render mode: 'interpreted', 'compiledFallback', or 'compiled' — which is BOTH the
   * pre-first-render placeholder AND what a live compiled operation (a property edit, a drag, a delete) leaves
   * behind when it re-renders the cached compiled instance. */
  net48RenderMode: string;
}

/**
 * True for a preview that IS a compiled instance — the disclosed fallback, and the live compiled render that follows
 * an edit on it. Deliberately an allowlist: an interpreted preview, and any mode this does not know about, fall on
 * the safe side and offer no vendor tasks rather than risking a construction of the user's form.
 *
 * `compiled` doubles as the state before the first render, when nothing is loaded yet. Allowing it costs nothing:
 * the engine answers such a query by PEEKING an instance that does not exist and returns an empty menu, and it is
 * what keeps the vendor menu from vanishing the moment the user edits a property on a compiled preview.
 */
export function vendorTasksAvailable(preview: PreviewState): boolean {
  return preview.engineKind === 'net48'
    && (preview.net48RenderMode === 'compiledFallback' || preview.net48RenderMode === 'compiled');
}
