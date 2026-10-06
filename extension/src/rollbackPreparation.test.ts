import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createJournalRecord, transitionJournal, writeJournalFile } from './transactionJournal';
import { HostMutationLedger, hostMutationAdmissionFrozen, ROLLBACK_PREPARED, setHostMutationAdmissionFrozen, settleAllHostMutations, trackHostMutation, beginHostMutation, trackUnrefusableHostMutation, rollbackInvalidationEpoch, onRollbackPreparationInvalidated } from './mutationOperation';
import { inspectDurableStateForRollback, prepareRollback, RollbackPreparationHooks } from './rollbackPreparation';

const roots: string[] = [];
afterEach(() => {
  setHostMutationAdmissionFrozen(false);
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function storage(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wfd-rollback-'));
  roots.push(root);
  return root;
}

function writeOperation(root: string, operationId: string, status: string): void {
  const directory = path.join(root, 'v2-operations', 'doc');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `${operationId}.json`), JSON.stringify({ schemaVersion: '2.2.0', operationId, status, code: 'X' }));
}

async function writeJournal(root: string, transactionId: string, states: Parameters<typeof transitionJournal>[1][]): Promise<void> {
  let record = createJournalRecord({ transactionId, patchSetId: 'patch', workspaceRoot: root,
    baseFingerprints: {}, afterFingerprints: {}, beforeBytesBase64: {}, afterBytesBase64: {} });
  for (const state of states) record = transitionJournal(record, state);
  await writeJournalFile(path.join(root, 'v2-transactions', 'ws', `${transactionId}.json`), record);
}

function hooks(root: string, overrides: Partial<RollbackPreparationHooks> = {}) {
  const log: string[] = [];
  const value: RollbackPreparationHooks = {
    storageRoot: root,
    isFrozen: () => hostMutationAdmissionFrozen(),
    freeze: () => { log.push('freeze'); setHostMutationAdmissionFrozen(true); },
    thaw: () => { log.push('thaw'); setHostMutationAdmissionFrozen(false); },
    settleInFlight: async () => { log.push('settle'); return true; },
    stopWorkers: async () => { log.push(`stop:${hostMutationAdmissionFrozen() ? 'frozen' : 'OPEN'}`); return { stopped: 2, survivors: 0 }; },
    confirmUnresolved: async () => { log.push('confirm'); return false; },
    ...overrides,
  };
  return { value, log };
}

describe('rollback preparation (roadmap 2.2.0)', () => {
  it('freezes, settles, finds only terminal state, then stops workers while still frozen and stays frozen', async () => {
    const root = storage();
    writeOperation(root, 'done', 'committed');
    await writeJournal(root, 'tx-done', ['prepared', 'applying', 'applied', 'undoRegistered', 'committed']);
    const { value, log } = hooks(root);
    expect(await prepareRollback(value)).toEqual({ ready: true, blockers: [], acknowledged: [], stoppedWorkers: 2 });
    // Ownership is released only after admission is frozen, so no request can start a replacement worker.
    expect(log).toEqual(['freeze', 'settle', 'stop:frozen']);
    expect(hostMutationAdmissionFrozen()).toBe(true);
  });

  it('refuses and resumes the current version while an operation is still running', async () => {
    const { value, log } = hooks(storage(), { settleInFlight: async () => false });
    const result = await prepareRollback(value);
    expect(result).toMatchObject({ ready: false, blockers: [{ kind: 'operationsRunning' }], stoppedWorkers: 0 });
    expect(log).toEqual(['freeze', 'thaw']);
    expect(hostMutationAdmissionFrozen()).toBe(false);
  });

  it('refuses an interrupted operation and a journal that still needs rollback, without stopping anything', async () => {
    const root = storage();
    writeOperation(root, 'crashed', 'pending');
    await writeJournal(root, 'tx-applied', ['prepared', 'applying', 'applied']);
    const { value, log } = hooks(root);
    const result = await prepareRollback(value);
    expect(result.ready).toBe(false);
    expect(result.blockers.map((b) => `${b.kind}:${b.id}`).sort()).toEqual(['journal:tx-applied', 'operationPending:crashed']);
    expect(log).not.toContainEqual(expect.stringMatching(/^stop/));
    expect(hostMutationAdmissionFrozen()).toBe(false);
  });

  it('leaves another schema\'s journal alone but refuses a damaged journal of its own schema', async () => {
    const root = storage();
    const directory = path.join(root, 'v2-transactions', 'other');
    fs.mkdirSync(directory, { recursive: true });
    const foreign = path.join(directory, 'future.json');
    fs.writeFileSync(foreign, '{"schemaVersion":"999.0.0","state":"future"}\n');
    const before = fs.readFileSync(foreign);
    expect(await prepareRollback(hooks(root).value)).toMatchObject({ ready: true, blockers: [] });
    expect(fs.readFileSync(foreign)).toEqual(before);
    setHostMutationAdmissionFrozen(false);
    fs.writeFileSync(path.join(directory, 'own.json'), '{"schemaVersion":"2.0.0","state":"applied"}');
    fs.writeFileSync(path.join(directory, 'torn.json'), '{"schemaVersion":"2.0.');
    const refused = await prepareRollback(hooks(root).value);
    expect(refused.ready).toBe(false);
    expect(refused.blockers.map((b) => `${b.kind}:${b.id}:${b.detail}`).sort()).toEqual([
      'journal:own:transaction journal requires corrupt', 'journal:torn:transaction journal requires corrupt']);
  });

  it('runs one preparation at a time, and a refusal never thaws a freeze it does not own', async () => {
    const root = storage();
    writeOperation(root, 'unknown', 'recoveryRequired');
    let answer!: (value: boolean) => void;
    const first = prepareRollback(hooks(root, { confirmUnresolved: () => new Promise<boolean>((resolve) => { answer = resolve; }) }).value);
    await vi.waitFor(() => expect(answer).toBeDefined());
    const second = await prepareRollback(hooks(root, { confirmUnresolved: async () => false }).value);
    expect(second).toMatchObject({ ready: false, blockers: [{ kind: 'operationsRunning', id: 'preparation' }] });
    expect(hostMutationAdmissionFrozen()).toBe(true);
    answer(true);
    expect(await first).toMatchObject({ ready: true, stoppedWorkers: 2 });
    expect(hostMutationAdmissionFrozen()).toBe(true);
    // A later preparation that is refused leaves the successful one's freeze in place until the user resumes.
    expect(await prepareRollback(hooks(root).value)).toMatchObject({ ready: false, blockers: [{ kind: 'operationUnresolved' }] });
    expect(hostMutationAdmissionFrozen()).toBe(true);
  });

  it('refuses a truncated record scan instead of certifying it', async () => {
    const root = storage();
    for (const id of ['a', 'b', 'c']) writeOperation(root, id, 'committed');
    expect((await inspectDurableStateForRollback(root, 3)).blockers).toEqual([]);
    writeOperation(root, 'd', 'committed');
    // The unread fourth record could be the undecided one: the scan reports itself incomplete.
    expect((await inspectDurableStateForRollback(root, 3)).blockers).toEqual([
      { kind: 'inspectionIncomplete', id: 'v2-operations', detail: 'more than 3 operation records' }]);
  });

  it('thaws and reports a structured refusal when the storage cannot be read', async () => {
    const root = storage();
    fs.writeFileSync(path.join(root, 'v2-operations'), 'not a directory'); // enumeration fails with ENOTDIR
    const result = await prepareRollback(hooks(root).value);
    expect(result).toMatchObject({ ready: false, blockers: [{ kind: 'inspectionIncomplete', detail: expect.stringContaining('ENOTDIR') }] });
    expect(hostMutationAdmissionFrozen()).toBe(false);
  });

  it('refuses when a worker does not confirm its exit', async () => {
    const { value } = hooks(storage(), { stopWorkers: async () => ({ stopped: 1, survivors: 1 }) });
    expect(await prepareRollback(value)).toMatchObject({ ready: false, blockers: [{ kind: 'workersRunning' }], stoppedWorkers: 1 });
    expect(hostMutationAdmissionFrozen()).toBe(false);
  });

  it('refuses while auto-save would still write open files after the switch', async () => {
    const { value, log } = hooks(storage(), { unsavedAutoSaveTargets: () => 2 });
    expect(await prepareRollback(value)).toMatchObject({ ready: false, blockers: [{ kind: 'unsavedAutoSave' }] });
    expect(log).not.toContainEqual(expect.stringMatching(/^stop/));
    expect(hostMutationAdmissionFrozen()).toBe(false);
  });

  it('re-checks auto-save targets after stopping workers', async () => {
    let dirty = 0;
    const { value } = hooks(storage(), {
      unsavedAutoSaveTargets: () => dirty,
      stopWorkers: async () => { dirty = 1; return { stopped: 2, survivors: 0 }; },
    });
    expect(await prepareRollback(value)).toMatchObject({ ready: false, blockers: [{ kind: 'unsavedAutoSave' }], stoppedWorkers: 2 });
    expect(hostMutationAdmissionFrozen()).toBe(false);
  });

  it('is cancelled, not certified, when an unrefusable history step runs during preparation', async () => {
    const { value } = hooks(storage(), {
      invalidationEpoch: () => rollbackInvalidationEpoch(),
      stopWorkers: async () => { await trackUnrefusableHostMutation(async () => undefined); return { stopped: 1, survivors: 0 }; },
    });
    expect(await prepareRollback(value)).toMatchObject({ ready: false, blockers: [{ kind: 'invalidated' }], stoppedWorkers: 1 });
    expect(hostMutationAdmissionFrozen()).toBe(false);
  });

  it('proceeds past an undecided outcome only with explicit consent', async () => {
    const root = storage();
    writeOperation(root, 'unknown', 'recoveryRequired');
    const declined = hooks(root);
    expect(await prepareRollback(declined.value)).toMatchObject({ ready: false, blockers: [{ kind: 'operationUnresolved', id: 'unknown' }] });
    expect(declined.log).toEqual(['freeze', 'settle', 'confirm', 'thaw']);
    const accepted = hooks(root, { confirmUnresolved: async () => true });
    expect(await prepareRollback(accepted.value)).toMatchObject({ ready: true, acknowledged: [{ id: 'unknown' }], stoppedWorkers: 2 });
  });
});

describe('host mutation admission freeze', () => {
  it('refuses new operations before recording anything, still answers established ones, and lets running ones finish', async () => {
    const root = storage();
    const state = { sourceText: 'before', revision: 0 };
    const ledger = new HostMutationLedger(root, path.join(root, 'Form1.cs'), () => state);
    expect(await ledger.run({ value: 1 }, async () => { ledger.finishCommit(true, true); }, 'done')).toMatchObject({ status: 'committed' });
    let release!: () => void;
    const running = ledger.run({ value: 2 }, () => new Promise<void>((resolve) => { release = resolve; }), 'running');
    setHostMutationAdmissionFrozen(true);
    await expect(ledger.run({ value: 3 }, async () => undefined, 'new')).rejects.toMatchObject({ code: ROLLBACK_PREPARED });
    expect(ledger.observe('new')).toBeUndefined();
    expect(ledger.commit({ value: 4 }, () => true)).toBe(false);
    expect(await ledger.run({ value: 1 }, async () => undefined, 'done')).toMatchObject({ status: 'committed', replayed: true });
    const settled = settleAllHostMutations(5_000);
    release();
    expect(await settled).toBe(true);
    expect(await running).toMatchObject({ status: 'noChange' });
  });

  it('holds native resource history to the same admission: refused once frozen, awaited while running', async () => {
    let release!: () => void;
    let ran = 0;
    const running = trackHostMutation(() => new Promise<void>((resolve) => { ran++; release = resolve; }));
    setHostMutationAdmissionFrozen(true);
    await expect(trackHostMutation(async () => { ran++; })).rejects.toMatchObject({ code: ROLLBACK_PREPARED });
    expect(ran).toBe(1);
    let settled = false;
    const settling = settleAllHostMutations(5_000).then((value) => { settled = value; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    release();
    await running;
    await settling;
    expect(settled).toBe(true);
  });

  it('counts a deferred replay as running until it signals completion, and refuses one once frozen', async () => {
    const settle = beginHostMutation();
    setHostMutationAdmissionFrozen(true);
    expect(() => beginHostMutation()).toThrow(expect.objectContaining({ code: ROLLBACK_PREPARED }));
    let settled = false;
    const settling = settleAllHostMutations(5_000).then((value) => { settled = value; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    settle();
    settle(); // idempotent
    await settling;
    expect(settled).toBe(true);
  });

  it('runs a native history step even while frozen, reopening admission and announcing the cancellation', async () => {
    let announced = 0;
    onRollbackPreparationInvalidated(() => { announced++; });
    try {
      setHostMutationAdmissionFrozen(true);
      const before = rollbackInvalidationEpoch();
      let ran = false;
      await trackUnrefusableHostMutation(async () => { ran = true; });
      expect(ran).toBe(true);
      expect(hostMutationAdmissionFrozen()).toBe(false);
      expect(rollbackInvalidationEpoch()).toBe(before + 1);
      expect(announced).toBe(1);
      await trackUnrefusableHostMutation(async () => undefined); // not frozen: no second cancellation
      expect(announced).toBe(1);
    } finally { onRollbackPreparationInvalidated(undefined); }
  });

  it('reports a running operation that outlives the settle bound', async () => {
    vi.useFakeTimers();
    try {
      const root = storage();
      const ledger = new HostMutationLedger(root, path.join(root, 'Form1.cs'), () => ({ sourceText: 's', revision: 0 }));
      void ledger.run({ value: 1 }, () => new Promise<void>(() => undefined), 'stuck');
      const settled = settleAllHostMutations(1_000);
      await vi.advanceTimersByTimeAsync(1_001);
      expect(await settled).toBe(false);
    } finally { vi.useRealTimers(); }
  });
});
