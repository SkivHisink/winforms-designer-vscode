// Pure selection helpers for the designer host. Extracted so the exact rules are unit-testable in e2e.ts (the
// designer editor class itself is F5-only), mirroring the other extracted host helpers (csprojRef, renderDiagnostics).

/** Whether to keep the current selection across a full re-render: retained only if the id still exists — as a
 *  visual control OR a tray component (a ContextMenuStrip / Timer / …). Otherwise the selection falls back to the
 *  root form ('this'). This is the host-authoritative rule (the host pushes the result via pushSelect, which
 *  overrides the canvas); the canvas prunes the same way via findControl(id) || findTray(id). Consulting the tray
 *  matters after editing a tray component's collection (e.g. a ContextMenuStrip's Items commits via a net9
 *  fullRender) — without it the selection would snap to the form. */
export function retainSelectionId(
  currentId: string,
  controls: readonly { id: string }[],
  tray: readonly { id: string }[],
): string {
  if (controls.some((c) => c.id === currentId)) return currentId;
  if (tray.some((t) => t.id === currentId)) return currentId;
  return 'this';
}
