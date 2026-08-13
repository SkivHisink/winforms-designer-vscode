import { describe, expect, it } from 'vitest';
import { vendorTasksAvailable } from './vendorTasks';

describe('vendorTasksAvailable', () => {
  it('offers vendor tasks when the preview IS the compiled instance', () => {
    expect(vendorTasksAvailable({ engineKind: 'net48', net48RenderMode: 'compiledFallback' })).toBe(true);
  });

  it('never asks on an interpreted preview — selecting a control must not construct the user\'s real form', () => {
    expect(vendorTasksAvailable({ engineKind: 'net48', net48RenderMode: 'interpreted' })).toBe(false);
  });

  // 'compiled' is what a LIVE compiled operation (property edit, drag, delete) leaves behind after re-rendering the
  // cached instance — the menu must not vanish the moment the user edits something on a compiled preview. It is also
  // the pre-first-render placeholder, where the engine's peek simply finds nothing and answers with an empty menu.
  it('keeps offering vendor tasks after a live compiled render', () => {
    expect(vendorTasksAvailable({ engineKind: 'net48', net48RenderMode: 'compiled' })).toBe(true);
  });

  it('does not ask for a mode it does not know', () => {
    expect(vendorTasksAvailable({ engineKind: 'net48', net48RenderMode: '' })).toBe(false);
  });

  it('treats an unknown future mode as "no vendor tasks" rather than risking a build', () => {
    expect(vendorTasksAvailable({ engineKind: 'net48', net48RenderMode: 'somethingNew' })).toBe(false);
  });

  it('never applies to the modern engine, which has no compiled instance at all', () => {
    expect(vendorTasksAvailable({ engineKind: 'modern', net48RenderMode: 'compiledFallback' })).toBe(false);
    expect(vendorTasksAvailable({ engineKind: 'modern', net48RenderMode: 'interpreted' })).toBe(false);
  });
});
