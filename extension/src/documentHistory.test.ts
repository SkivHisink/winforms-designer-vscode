import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DocumentHistory, DOCUMENT_HISTORY_LIMIT, DOCUMENT_HISTORY_MAX_BYTES, DOCUMENT_HISTORY_EDITOR_MAX_BYTES, validDocumentHistoryTarget } from './documentHistory';

const root = path.resolve('history-fixture');
const id = path.join(root, 'Form.cs');
const resource = path.join(root, 'Form.resx');
const create = () => new DocumentHistory(id, root, 'source-0');
const step = (history: DocumentHistory, index: number) => history.record({ label: `Edit ${index}`,
  before: `source-${index - 1}`, after: `source-${index}`, linkedArtifacts: [] });
const sign = (value: Record<string, unknown>) => {
  const { sha256: _old, ...rest } = value;
  return { ...rest, sha256: createHash('sha256').update(JSON.stringify(rest)).digest('hex') };
};

describe('serialized custom document history', () => {
  it('restores several applied operations with exact source and linked artifact images', () => {
    const history = create();
    step(history, 1);
    const resourceId = history.record({ label: 'Import image', before: 'source-1', after: 'source-2',
      linkedArtifacts: [{ target: resource, before: null, after: '\ufeff<root>image</root>\r\n', bom: true, storage: 'disk' }] });
    step(history, 3);
    const restored = DocumentHistory.restore(history.serialize('source-3', 'source-0'), id, root, 'source-3', 'source-0');
    expect(restored.state).toEqual({ length: 3, activeIndex: 3, checkpointIndex: 0, retainedRedoCount: 0 });
    expect(restored.appliedUnits[1].linkedArtifacts[0]).toEqual({ target: resource, before: null,
      after: '\ufeff<root>image</root>\r\n', bom: true, storage: 'disk' });
    expect(restored.appliedUnits[1].id).toBe(resourceId);
    for (const unit of [...restored.appliedUnits].reverse()) restored.moved(unit.id, 'undo');
    expect(restored.currentSource).toBe('source-0');
    expect(restored.dirty).toBe(false);
  });

  it('preserves an already-existing redo branch as data, while new Undo can be redone', () => {
    const history = create();
    const one = step(history, 1); const two = step(history, 2); const three = step(history, 3);
    history.moved(three, 'undo');
    const restored = DocumentHistory.restore(history.serialize('source-2', 'source-0'), id, root, 'source-2');
    expect(restored.state.retainedRedoCount).toBe(1);
    expect(restored.recoverableUnits('source-0').map((unit) => unit.id)).toEqual([one, two]);
    restored.moved(two, 'undo');
    expect(restored.currentSource).toBe('source-1');
    restored.moved(two, 'redo');
    expect(restored.currentSource).toBe('source-2');
    expect(restored.state.retainedRedoCount).toBe(1);
  });

  it('keeps a saved checkpoint in the retained redo branch distinct from the restored native base', () => {
    const history = create(); step(history, 1); step(history, 2); const third = step(history, 3);
    history.checkpoint('source-3'); history.moved(third, 'undo');
    const restored = DocumentHistory.restore(history.serialize('source-2', 'source-3'), id, root, 'source-2', 'source-3');
    expect(restored.state).toMatchObject({ activeIndex: 2, checkpointIndex: 3, retainedRedoCount: 1 });
    for (const unit of [...restored.recoverableUnits('source-3')].reverse()) restored.moved(unit.id, 'undo');
    expect(restored.currentSource).toBe('source-0');
    expect(restored.dirty).toBe(true);
    expect(restored.state.checkpointIndex).toBe(3);
  });

  it('branches after Undo and discards only the abandoned redo branch', () => {
    const history = create();
    step(history, 1); const second = step(history, 2);
    history.moved(second, 'undo');
    history.record({ label: 'New branch', before: 'source-1', after: 'branch', linkedArtifacts: [] });
    expect(history.state).toMatchObject({ length: 2, activeIndex: 2, retainedRedoCount: 0 });
    expect(history.currentSource).toBe('branch');
  });

  it('recreates only the native suffix after Save, Save All or auto-save checkpoint', () => {
    const history = create();
    step(history, 1); step(history, 2);
    history.checkpoint('source-2');
    const third = step(history, 3); const fourth = step(history, 4);
    const restored = DocumentHistory.restore(history.serialize('source-4', 'source-2'), id, root, 'source-4');
    expect(restored.recoverableUnits('source-2').map((unit) => unit.id)).toEqual([third, fourth]);
    restored.moved(fourth, 'undo'); restored.moved(third, 'undo');
    expect(restored.currentSource).toBe('source-2');
    expect(restored.dirty).toBe(false);
    expect(restored.state.length).toBe(4);
  });

  it('keeps a clean checkpoint and resource-only dirty history separate from source equality', () => {
    const history = create();
    const resourceId = history.record({ label: 'Resource only', before: 'source-0', after: 'source-0',
      linkedArtifacts: [{ target: resource, before: 'before', after: 'after', bom: false, storage: 'disk' }] });
    expect(history.currentSource).toBe('source-0'); expect(history.dirty).toBe(true);
    history.checkpoint('source-0'); expect(history.dirty).toBe(false);
    history.moved(resourceId, 'undo'); expect(history.dirty).toBe(true);
    const restored = DocumentHistory.restore(history.serialize('source-0', 'source-0'), id, root, 'source-0');
    expect(restored.state).toMatchObject({ activeIndex: 0, checkpointIndex: 1, retainedRedoCount: 1 });
  });

  it('does not treat an earlier asynchronous save snapshot as the current checkpoint', () => {
    const history = create();
    step(history, 1); const token = history.checkpointToken;
    step(history, 2); history.checkpoint('source-1', token);
    expect(history.state.checkpointIndex).toBe(1);
    expect(history.dirty).toBe(true);
  });

  it('keeps live native callbacks and backup source coherent when Undo crosses the serialized limit', () => {
    const history = create(); const ids: string[] = [];
    for (let index = 1; index <= 21; index++) ids.push(step(history, index));
    for (let index = 21; index > 0; index--) history.alignAfterNativeMove(ids[index - 1], 'undo', `source-${index - 1}`);
    expect(history.currentSource).toBe('source-0');
    expect(history.state).toMatchObject({ length: 0, activeIndex: 0, checkpointIndex: null });
    expect(() => history.serialize('source-0', 'source-0')).not.toThrow();
    for (let index = 1; index <= 21; index++) history.alignAfterNativeMove(ids[index - 1], 'redo', `source-${index}`);
    expect(history.currentSource).toBe('source-21');
    expect(() => history.serialize('source-21', 'source-0')).not.toThrow();
    history.checkpoint('source-21');
    expect(history.dirty).toBe(false);
  });

  it('allows the provider to acknowledge a data transition already moved before a preview failure', () => {
    const history = create(); const first = step(history, 1);
    history.alignAfterNativeMove(first, 'undo', 'source-0');
    history.alignAfterNativeMove(first, 'undo', 'source-0');
    expect(history.state.activeIndex).toBe(0);
    expect(() => history.serialize('source-0', 'source-0')).not.toThrow();
  });

  it('keeps a concurrent resource-only edit dirty after an older source save finishes', () => {
    const history = create();
    step(history, 1); const token = history.checkpointToken;
    history.record({ label: 'Resource edit during Save', before: 'source-1', after: 'source-1',
      linkedArtifacts: [{ target: resource, before: 'before', after: 'after', bom: false, storage: 'disk' }] });
    history.checkpoint('source-1', token);
    expect(history.state.checkpointIndex).toBe(1);
    expect(history.state.activeIndex).toBe(2);
    expect(history.dirty).toBe(true);
  });

  it('caps serialized operations at 20 while retaining the current image and an honest missing checkpoint', () => {
    const history = create();
    for (let index = 1; index <= 25; index++) step(history, index);
    expect(history.state).toEqual({ length: DOCUMENT_HISTORY_LIMIT, activeIndex: DOCUMENT_HISTORY_LIMIT,
      checkpointIndex: null, retainedRedoCount: 0 });
    const restored = DocumentHistory.restore(history.serialize('source-25', 'source-0'), id, root, 'source-25');
    expect(restored.appliedUnits[0].before).toBe('source-5');
    for (const unit of [...restored.appliedUnits].reverse()) restored.moved(unit.id, 'undo');
    expect(restored.currentSource).toBe('source-5');
    expect(restored.dirty).toBe(true);
  });

  it('preserves a source image even when its single operation exceeds the serialized history byte budget', () => {
    const history = create(); const huge = 'x'.repeat(DOCUMENT_HISTORY_MAX_BYTES + 1);
    const id = history.record({ label: 'Oversized operation', before: 'source-0', after: huge, linkedArtifacts: [] });
    expect(history.state).toMatchObject({ length: 0, activeIndex: 0, checkpointIndex: null });
    expect(history.currentSource).toBe(huge);
    history.alignAfterNativeMove(id, 'undo', 'source-0');
    expect(() => history.serialize('source-0', 'source-0')).not.toThrow();
    history.alignAfterNativeMove(id, 'redo', huge);
    expect(history.currentSource).toBe(huge);
  });

  it('rejects corruption, a different raw backup, another document and an external saved-source edit', () => {
    const history = create(); step(history, 1);
    const serialized = history.serialize('source-1', 'source-0');
    expect(() => DocumentHistory.restore(serialized.replace('Edit 1', 'Edit X'), id, root, 'source-1')).toThrow('corrupt');
    expect(() => DocumentHistory.restore(serialized, id, root, 'different')).toThrow('corrupt');
    expect(() => DocumentHistory.restore(serialized, id + '.other', root, 'source-1')).toThrow('corrupt');
    expect(() => DocumentHistory.restore(serialized, id, root, 'source-1', 'manual edit')).toThrow('corrupt');
  });

  it('rejects forged cursors, discontinuous operations and duplicate IDs even with recomputed outer hashes', () => {
    const history = create(); step(history, 1); step(history, 2);
    const original = JSON.parse(history.serialize('source-2', 'source-0'));
    expect(() => DocumentHistory.restore(JSON.stringify(sign({ ...original, activeIndex: 50 })), id, root, 'source-2')).toThrow('corrupt');
    const discontinuous = structuredClone(original);
    discontinuous.units[1] = sign({ ...discontinuous.units[1], before: 'wrong predecessor' });
    expect(() => DocumentHistory.restore(JSON.stringify(sign(discontinuous)), id, root, 'source-2')).toThrow('operation');
    const duplicate = structuredClone(original);
    duplicate.units[1] = sign({ ...duplicate.units[1], id: duplicate.units[0].id });
    expect(() => DocumentHistory.restore(JSON.stringify(sign(duplicate)), id, root, 'source-2')).toThrow('operation');
  });

  it('refuses out-of-order native replay without moving the durable cursor', () => {
    const history = create(); const first = step(history, 1); step(history, 2);
    expect(() => history.moved(first, 'undo')).toThrow('order');
    expect(history.state.activeIndex).toBe(2);
  });

  it('restricts recovery targets to the owned root and supported artifact kinds', () => {
    expect(validDocumentHistoryTarget(root, resource)).toBe(true);
    expect(validDocumentHistoryTarget(root, path.join(root, 'secrets', 'hidden.cs'))).toBe(false);
    expect(validDocumentHistoryTarget(root, path.resolve(root, '..', 'elsewhere.cs'))).toBe(false);
    expect(validDocumentHistoryTarget(root, path.join(root, '.env'))).toBe(false);
    const history = create();
    expect(() => history.record({ label: 'Outside', before: 'source-0', after: 'source-1',
      linkedArtifacts: [{ target: path.resolve(root, '..', 'other.resx'), before: '', after: '', bom: false, storage: 'disk' }] })).toThrow('boundary');
    expect(history.state.length).toBe(0);
  });

  it('rejects recomputed sidecar hashes that redirect a genuine operation into another form or project', () => {
    const history = create();
    history.record({ label: 'Import image', before: 'source-0', after: 'source-1',
      linkedArtifacts: [{ target: resource, before: 'before', after: 'after', bom: false, storage: 'disk' }] });
    const original = JSON.parse(history.serialize('source-1', 'source-0'));
    for (const [target, storage] of [[path.join(root, 'ProjectB', 'Build.targets'), 'disk'],
      [path.join(root, 'ProjectB', 'Other.cs'), 'editor'], [path.join(root, 'Other.resx'), 'disk']]) {
      const forged = structuredClone(original);
      forged.units[0].linkedArtifacts[0] = { ...forged.units[0].linkedArtifacts[0], target, storage };
      forged.units[0] = sign(forged.units[0]);
      expect(() => DocumentHistory.restore(JSON.stringify(sign(forged)), id, root, 'source-1')).toThrow('artifact');
    }
  });

  it('does not accept a forged on-disk source capability without its exact generated artifact', () => {
    const history = create(); step(history, 1);
    const forged = JSON.parse(history.serialize('source-1', 'source-0'));
    forged.units[0] = sign({ ...forged.units[0], sourceOnDisk: true });
    expect(() => DocumentHistory.restore(JSON.stringify(sign(forged)), id, root, 'source-1')).toThrow('ownership');
  });

  it('stores editor buffers separately and resets history on an explicit disk revert', () => {
    const history = create();
    history.record({ label: 'Create handler', before: 'source-0', after: 'source-1',
      linkedArtifacts: [{ target: id, before: 'class F {}', after: 'class F { void Click() {} }', bom: false, storage: 'editor' }] });
    const restored = DocumentHistory.restore(history.serialize('source-1', 'source-0'), id, root, 'source-1');
    expect(restored.appliedUnits[0].linkedArtifacts[0].storage).toBe('editor');
    restored.reset('disk');
    expect(restored.state).toEqual({ length: 0, activeIndex: 0, checkpointIndex: 0, retainedRedoCount: 0 });
    expect(restored.dirty).toBe(false);
  });

  it('retains a current unsaved editor checkpoint after its event unit was evicted by later geometry', () => {
    const history = create();
    history.record({ label: 'Create handler', before: 'source-0', after: 'source-1',
      linkedArtifacts: [{ target: id, before: 'class F {}', after: 'class F { void Click() {} }', bom: false, storage: 'editor' }] });
    for (let index = 2; index <= 22; index++) step(history, index);
    const serialized = history.serialize('source-22', 'source-0');
    const restored = DocumentHistory.restore(serialized, id, root, 'source-22');
    expect(restored.state.length).toBe(20);
    expect(restored.appliedUnits.every((unit) => unit.linkedArtifacts.length === 0)).toBe(true);
    expect(restored.editorImages).toEqual([{ target: id, before: 'class F {}', after: 'class F { void Click() {} }', bom: false, storage: 'editor' }]);
  });

  it('refuses to silently omit a current editor checkpoint above its separate byte budget', () => {
    const history = create();
    const huge = 'x'.repeat(DOCUMENT_HISTORY_EDITOR_MAX_BYTES + 1);
    history.record({ label: 'Large handler buffer', before: 'source-0', after: 'source-1',
      linkedArtifacts: [{ target: id, before: '', after: huge, bom: false, storage: 'editor' }] });
    expect(() => history.serialize('source-1', 'source-0')).toThrow('code-buffer checkpoints');
    expect(history.editorImages[0].after).toBe(huge);
  });

  it('validates checkpoint ownership even if its creating operation is no longer retained', () => {
    const history = create(); step(history, 1);
    const forged = JSON.parse(history.serialize('source-1', 'source-0'));
    forged.editorCheckpoints = [{ target: path.join(root, 'Other.cs'), before: '', after: 'injected', bom: false, storage: 'editor' }];
    expect(() => DocumentHistory.restore(JSON.stringify(sign(forged)), id, root, 'source-1')).toThrow('checkpoint');
  });

  it('rejects omitted or mismatched checkpoints for retained editor operations even with recomputed hashes', () => {
    const history = create();
    const event = history.record({ label: 'Handler', before: 'source-0', after: 'source-1',
      linkedArtifacts: [{ target: id, before: 'before body', after: 'after body', bom: false, storage: 'editor' }] });
    const state = JSON.parse(history.serialize('source-1', 'source-0'));
    expect(() => DocumentHistory.restore(JSON.stringify(sign({ ...state, editorCheckpoints: [] })), id, root, 'source-1')).toThrow('coverage');
    state.editorCheckpoints[0].after = 'wrong current body';
    expect(() => DocumentHistory.restore(JSON.stringify(sign(state)), id, root, 'source-1')).toThrow('current image');
    history.moved(event, 'undo');
    const undone = JSON.parse(history.serialize('source-0', 'source-0'));
    expect(undone.editorCheckpoints[0].after).toBe('before body');
    undone.editorCheckpoints[0].after = 'after body';
    expect(() => DocumentHistory.restore(JSON.stringify(sign(undone)), id, root, 'source-0')).toThrow('current image');
  });
});
