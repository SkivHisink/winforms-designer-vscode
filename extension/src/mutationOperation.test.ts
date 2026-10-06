import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sha256Hex } from './documentStore';
import { HostMutationLedger, hostMutationRecordPath, mutationPayloadFingerprint } from './mutationOperation';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wfd-operation-'));
  directories.push(root);
  const documentId = path.join(root, 'Form1.cs');
  const state = { sourceText: 'before', revision: 0 };
  const ledger = new HostMutationLedger(root, documentId, () => state);
  return { root, documentId, state, ledger };
}
function leavePending(root: string, documentId: string, id: string, changes: Record<string, unknown> = {}) {
  const file = hostMutationRecordPath(root, documentId, id);
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...record, ...changes, status: 'pending' }));
}

describe('sole host mutation commit owner', () => {
  it('characterizes stable intent fingerprints independently from request attempts and object key order', () => {
    expect(mutationPayloadFingerprint({ type: 'edit', operationId: 'op', requestAttemptId: 'one', value: 'X', prop: 'Text' }))
      .toBe(mutationPayloadFingerprint({ prop: 'Text', value: 'X', type: 'edit', requestAttemptId: 'two', operationId: 'op' }));
    expect(mutationPayloadFingerprint({ value: { operationId: 'semantic-a' } }))
      .not.toBe(mutationPayloadFingerprint({ value: { operationId: 'semantic-b' } }));
  });
  it('returns an established result with one diff and one Undo unit across retries, Undo and a new revision', async () => {
    const { ledger, state, root, documentId } = fixture();
    let nativeUndoUnits = 0;
    const action = async () => {
      ledger.stageCommit('after'); state.sourceText = 'after'; state.revision++; nativeUndoUnits++;
      ledger.finishCommit(true, true);
    };
    expect(await ledger.run({ type: 'edit', prop: 'Text', value: 'after' }, action, 'op')).toEqual({ operationId: 'op', status: 'committed', replayed: false });
    state.sourceText = 'before'; state.revision++; // Existing native Undo, not another operation.
    const reopened = new HostMutationLedger(root, documentId, () => state);
    expect(await reopened.run({ type: 'edit', prop: 'Text', value: 'after' }, action, 'op')).toEqual({ operationId: 'op', status: 'committed', replayed: true });
    expect(state.sourceText).toBe('before'); expect(state.revision).toBe(2); expect(nativeUndoUnits).toBe(1);
    expect(reopened.observe('op')?.commitCount).toBe(1);
  });
  // A generated event handler writes a code-behind stub (a companion buffer) before the designer commit. When that
  // commit does not land, the operation's outcome depends on whether the stub was really taken back.
  it('never records an unsettled staged companion buffer as no change', async () => {
    const { ledger, root } = fixture();
    const code = path.join(root, 'Form1.cs');
    const outcome = await ledger.run({ type: 'createHandler' }, async () => {
      ledger.stageCompanionBuffer(code, 'class Form1 {}', 'class Form1 { void Click() {} }');
    }, 'op');
    expect(outcome).toMatchObject({ status: 'recoveryRequired', replayed: false });
    expect(ledger.observe('op')?.code).toBe('COMPANION_BUFFER_OUTCOME_UNKNOWN');
  });
  it('settles a compensated companion as refused and a failed compensation as recovery required, even after a refusal', async () => {
    const { ledger, root } = fixture();
    const code = path.join(root, 'Form1.cs');
    expect(await ledger.run({ type: 'createHandler', n: 1 }, async () => {
      ledger.stageCompanionBuffer(code, 'a', 'b');
      ledger.finishCommit(false, false);
      ledger.settleCompanion(true);
    }, 'restored')).toMatchObject({ status: 'refused' });
    expect(ledger.observe('restored')?.code).toBe('COMPANION_COMPENSATED');
    expect(await ledger.run({ type: 'createHandler', n: 2 }, async () => {
      ledger.stageCompanionBuffer(code, 'a', 'b');
      ledger.finishCommit(false, false); // the designer commit was refused…
      ledger.settleCompanion(false);     // …and taking the stub back failed: the refusal is not final
    }, 'stuck')).toMatchObject({ status: 'recoveryRequired' });
    expect(ledger.observe('stuck')?.commitCount).toBe(0);
  });
  it('coalesces a repeated in-flight mutation and rejects reuse with another payload before action', async () => {
    const { ledger } = fixture();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const first = ledger.run({ value: 1 }, async () => { calls++; await held; ledger.finishCommit(true, true); }, 'op');
    const repeat = ledger.run({ value: 1 }, async () => { calls++; }, 'op');
    await expect(ledger.run({ value: 2 }, async () => { calls++; }, 'op')).rejects.toMatchObject({ code: 'OPERATION_PAYLOAD_MISMATCH' });
    release();
    expect((await first).replayed).toBe(false); expect((await repeat).replayed).toBe(true); expect(calls).toBe(1);
  });
  it('reconciles pending crash against an exact recovered source image without running the proposal again', async () => {
    const { root, documentId, ledger, state } = fixture();
    await ledger.run({ value: 'after' }, async () => { ledger.stageCommit('after'); }, 'op');
    leavePending(root, documentId, 'op'); state.sourceText = 'after'; state.revision = 9;
    const restarted = new HostMutationLedger(root, documentId, () => state);
    let calls = 0;
    expect(await restarted.run({ value: 'after' }, async () => { calls++; }, 'op'))
      .toMatchObject({ status: 'committed', replayed: true, code: 'RECONCILED_COMMIT' });
    expect(calls).toBe(0); expect(state.revision).toBe(9);
  });
  it('resolves a baseline crash as refused and does not repeat a vendor callback with unknown external effects', async () => {
    const { root, documentId, ledger, state } = fixture();
    await ledger.run({ callback: 'vendor' }, async () => { ledger.stageCommit('after'); }, 'op');
    leavePending(root, documentId, 'op');
    let callbacks = 0;
    expect(await new HostMutationLedger(root, documentId, () => state).run({ callback: 'vendor' }, async () => { callbacks++; }, 'op'))
      .toMatchObject({ status: 'refused', replayed: true, code: 'RECONCILED_BASELINE_NO_RETRY' });
    expect(callbacks).toBe(0);
  });
  it('refuses unknown mixed resource/source outcomes and preserves unrelated bytes', async () => {
    const { root, documentId, ledger, state } = fixture();
    const resource = path.join(root, 'Form1.resx'); fs.writeFileSync(resource, 'external');
    await ledger.run({ resource: 'image' }, async () => {
      ledger.stageCommit('after', [{ filePath: resource, beforeSha256: sha256Hex('resource-before'), afterSha256: sha256Hex('resource-after') }], 'tx');
    }, 'op');
    leavePending(root, documentId, 'op'); state.sourceText = 'after';
    expect(await new HostMutationLedger(root, documentId, () => state).run({ resource: 'image' }, async () => { throw new Error('must not replay'); }, 'op'))
      .toMatchObject({ status: 'recoveryRequired', replayed: true, code: 'OPERATION_OUTCOME_UNKNOWN' });
    expect(fs.readFileSync(resource, 'utf8')).toBe('external');
  });
  it('retains refused byte/revision gate outcomes without generating an Undo unit on retry', async () => {
    const { ledger } = fixture(); let actions = 0;
    await ledger.run({ type: 'geometry', x: 12 }, async () => { actions++; ledger.stageCommit('bad'); ledger.finishCommit(false, false); }, 'op');
    expect(await ledger.run({ type: 'geometry', x: 12 }, async () => { actions++; }, 'op')).toMatchObject({ status: 'refused', replayed: true });
    expect(actions).toBe(1); expect(ledger.observe('op')?.commitCount).toBe(0);
  });
  it('fails closed for corrupt records before executing a callback', async () => {
    const { root, documentId, ledger } = fixture();
    await ledger.run({ value: 'a' }, async () => {}, 'op');
    const file = hostMutationRecordPath(root, documentId, 'op'); fs.writeFileSync(file, '{}');
    expect(() => ledger.run({ value: 'a' }, async () => { throw new Error('must not run'); }, 'op')).toThrow('invalid operation record');
  });
  it('keeps a pending companion edit unknown even when source and on-disk baseline appear untouched', async () => {
    const { root, documentId, ledger, state } = fixture();
    await ledger.run({ type: 'createHandler' }, async () => {
      ledger.stageCompanionBuffer(path.join(root, 'Form1.cs'), 'before-stub', 'after-stub');
      ledger.stageCommit('after');
    }, 'op');
    leavePending(root, documentId, 'op');
    expect(await new HostMutationLedger(root, documentId, () => state).run({ type: 'createHandler' }, async () => {
      throw new Error('must not write another stub');
    }, 'op')).toMatchObject({ status: 'recoveryRequired', code: 'COMPANION_BUFFER_OUTCOME_UNKNOWN', replayed: true });
  });
  it('rejects a recorded outside-project or secret target before reading it', async () => {
    const { root, documentId, ledger } = fixture();
    await ledger.run({ type: 'resource' }, async () => {}, 'op');
    const file = hostMutationRecordPath(root, documentId, 'op');
    const original = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...original, targets: [{ filePath: path.join(path.dirname(root), 'outside.resx'), beforeSha256: null, afterSha256: sha256Hex('after') }] }));
    expect(() => ledger.observe('op')).toThrow('outside the owning project');
    fs.writeFileSync(file, JSON.stringify({ ...original, targets: [{ filePath: path.join(root, 'secrets', 'Form1.cs'), beforeSha256: null, afterSha256: sha256Hex('after') }] }));
    expect(() => ledger.observe('op')).toThrow('invalid operation target');
  });
  it('refuses an existing linked target before read or write', async () => {
    const { root, ledger } = fixture();
    const actual = path.join(root, 'actual'); fs.mkdirSync(actual);
    const linked = path.join(root, 'linked'); fs.symlinkSync(actual, linked, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(ledger.run({ type: 'resource' }, async () => {
      ledger.stageCommit('after', [{ filePath: path.join(linked, 'Form1.resx'), beforeSha256: null, afterSha256: sha256Hex('after') }]);
    }, 'op')).rejects.toThrow('traverses a link');
  });
  it('allows one native commit and exposes the established outcome to a second commit in the same scope', async () => {
    const { ledger } = fixture();
    await ledger.run({ type: 'edit' }, async () => {
      expect(ledger.establishedCommitOutcome()).toBeUndefined();
      ledger.stageCommit('after'); ledger.finishCommit(true, true);
      expect(ledger.establishedCommitOutcome()).toBe(true);
      expect(() => ledger.stageCommit('another')).toThrow('already has an established');
    }, 'op');
    expect(ledger.observe('op')?.commitCount).toBe(1);
  });
  it.skipIf(process.platform !== 'win32')('authorizes Windows project and target paths with different letter casing without blocking', async () => {
    const { root, documentId, state } = fixture();
    const ledger = new HostMutationLedger(root, documentId, () => state, () => [root.toLowerCase()]);
    await ledger.run({ type: 'resource' }, async () => {
      ledger.stageCommit('after', [{ filePath: path.join(root.toUpperCase(), 'Form1.resx'), beforeSha256: null, afterSha256: sha256Hex('resource') }]);
      ledger.finishCommit(false, false);
    }, 'case-op');
    expect(ledger.observe('case-op')?.status).toBe('refused');
  });
  it.each(['REQUEST_CANCELLED', 'REQUEST_DEADLINE_EXCEEDED', 'STALE_WORKER_GENERATION', 'STALE_WORKER_REPLY', 'WORKER_SUPERVISOR_DISPOSED'])(
    'establishes a terminal baseline refusal for known %s without running another mutation', async (code) => {
      const { ledger, state } = fixture(); let executions = 0;
      await expect(ledger.run({ type: 'edit', value: 'after' }, async () => {
        executions++; throw Object.assign(new Error(code), { code });
      }, 'cancelled')).rejects.toMatchObject({ code });
      expect(ledger.observe('cancelled')).toMatchObject({ status: 'refused', commitCount: 0, code: `${code}_BASELINE_NO_RETRY` });
      expect(await ledger.run({ type: 'edit', value: 'after' }, async () => { executions++; }, 'cancelled'))
        .toMatchObject({ status: 'refused', replayed: true });
      expect(executions).toBe(1); expect(state).toEqual({ sourceText: 'before', revision: 0 });
    });
  it('keeps a cancelled vendor callback unknown even when its workspace source is untouched', async () => {
    const { ledger } = fixture();
    await expect(ledger.run({ type: 'uiTypeEditor', callback: 'vendor' }, async () => {
      throw Object.assign(new Error('REQUEST_CANCELLED'), { code: 'REQUEST_CANCELLED' });
    }, 'vendor')).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
    expect(ledger.observe('vendor')).toMatchObject({ status: 'recoveryRequired', commitCount: 0 });
  });
  it.skipIf(process.platform !== 'win32')('replays one physical document operation after close/restart through a differently cased path', async () => {
    const { root, documentId, state, ledger } = fixture(); let commits = 0;
    await ledger.run({ value: 'after' }, async () => {
      ledger.stageCommit('after'); state.sourceText = 'after'; state.revision++; commits++; ledger.finishCommit(true, true);
    }, 'case-op');
    const reopened = new HostMutationLedger(root, documentId.toUpperCase(), () => state);
    expect(await reopened.run({ value: 'after' }, async () => { commits++; }, 'case-op')).toMatchObject({ status: 'committed', replayed: true });
    expect(commits).toBe(1); expect(state.revision).toBe(1);
  });
});
