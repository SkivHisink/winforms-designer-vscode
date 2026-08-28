import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ArtifactFingerprint,
  ArtifactSnapshot,
  artifactFingerprint,
  snapshotArtifactBytes,
  snapshotMissingArtifact,
} from './documentStore';
import { PatchOperation, PatchSet } from './patchSet';
import { classifyJournalForRecovery, TransactionJournalRecord } from './transactionJournal';
import {
  PlannedTargetMutation,
  TransactionCrashInjectionError,
  TransactionCrashPoint,
  TransactionRunnerAdapters,
  TransactionUndoRegistration,
  runPatchSetTransaction,
} from './transactionRunner';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wfd-transaction-runner-'));

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const preservation = {
  beforeBom: false,
  afterBom: false,
  beforeEol: 'none' as const,
  afterEol: 'none' as const,
};

function patch(target: string): PatchOperation {
  return { kind: 'writeResourceText', target, preservation };
}

function patchSet(targets: string[]): PatchSet {
  return {
    id: 'ps1',
    lane: 'A',
    workspaceRoot: root,
    operations: targets.map(patch),
  };
}

function fingerprint(target: string, bytes: Uint8Array | null): ArtifactFingerprint {
  return artifactFingerprint(bytes === null
    ? snapshotMissingArtifact(target)
    : snapshotArtifactBytes(target, bytes));
}

class MemoryTransactionAdapters implements TransactionRunnerAdapters {
  public readonly journals: TransactionJournalRecord[] = [];
  public readonly writes: string[] = [];
  public undoRegistrations: TransactionUndoRegistration[] = [];
  public failWriteTarget: string | null = null;
  public failPersistState: TransactionJournalRecord['state'] | null = null;
  public crashAt: TransactionCrashPoint | null = null;
  public onCrashPoint: ((point: TransactionCrashPoint, record: TransactionJournalRecord) => void) | undefined;
  public verifyPostconditionsResult = true;

  public constructor(
    private readonly files: Map<string, Uint8Array | null>,
    private readonly planned: Map<string, Uint8Array | null>,
  ) {
  }

  public async snapshot(target: string): Promise<ArtifactSnapshot> {
    const bytes = this.files.has(target) ? this.files.get(target) ?? null : null;
    return bytes === null ? snapshotMissingArtifact(target) : snapshotArtifactBytes(target, bytes);
  }

  public async read(target: string): Promise<Uint8Array | null> {
    const bytes = this.files.has(target) ? this.files.get(target) ?? null : null;
    return bytes === null ? null : Buffer.from(bytes);
  }

  public async planTargetMutation({ target }: { target: string }): Promise<PlannedTargetMutation> {
    if (!this.planned.has(target)) throw new Error(`missing plan for ${target}`);
    const afterBytes = this.planned.get(target) ?? null;
    return {
      target,
      afterBytes,
      expectedAfterFingerprint: fingerprint(target, afterBytes),
    };
  }

  public async write(target: string, bytes: Uint8Array): Promise<void> {
    if (target === this.failWriteTarget) throw new Error(`forced write failure: ${target}`);
    this.files.set(target, Buffer.from(bytes));
    this.writes.push(`write:${target}:${Buffer.from(bytes).toString('utf8')}`);
  }

  public async delete(target: string): Promise<void> {
    if (target === this.failWriteTarget) throw new Error(`forced delete failure: ${target}`);
    this.files.set(target, null);
    this.writes.push(`delete:${target}`);
  }

  public async persistJournal(record: TransactionJournalRecord): Promise<void> {
    if (record.state === this.failPersistState) throw new Error(`forced journal failure: ${record.state}`);
    this.journals.push(JSON.parse(JSON.stringify(record)) as TransactionJournalRecord);
  }

  public async verifyPostconditions(): Promise<boolean> {
    return this.verifyPostconditionsResult;
  }

  public async registerUndo(registration: TransactionUndoRegistration): Promise<void> {
    this.undoRegistrations.push(registration);
  }

  public async crashHook(point: TransactionCrashPoint, record: TransactionJournalRecord): Promise<void> {
    this.onCrashPoint?.(point, record);
    if (point === this.crashAt) throw new TransactionCrashInjectionError(`crash at ${point}`);
  }
}

describe('transaction runner', () => {
  it('refuses before the first write when any baseline changes after prepare', async () => {
    const adapters = new MemoryTransactionAdapters(
      new Map([['Form1.resx', Buffer.from('old', 'utf8')]]),
      new Map([['Form1.resx', Buffer.from('new', 'utf8')]]),
    );
    adapters.onCrashPoint = (point) => {
      if (point === 'preparedPersisted') adapters.write('Form1.resx', Buffer.from('external', 'utf8'));
    };

    const result = await runPatchSetTransaction(patchSet(['Form1.resx']), adapters, { transactionId: 'tx1' });

    expect(result.status).toBe('aborted');
    expect(result.error).toContain('changed after baseline capture');
    expect(Buffer.from((await adapters.read('Form1.resx'))!).toString('utf8')).toBe('external');
    expect(adapters.writes).toEqual(['write:Form1.resx:external']);
    expect(adapters.journals.at(-1)?.state).toBe('aborted');
  });

  it('compensates the first target when the second write fails', async () => {
    const adapters = new MemoryTransactionAdapters(
      new Map([
        ['A.resx', Buffer.from('old-a', 'utf8')],
        ['B.resx', Buffer.from('old-b', 'utf8')],
      ]),
      new Map([
        ['A.resx', Buffer.from('new-a', 'utf8')],
        ['B.resx', Buffer.from('new-b', 'utf8')],
      ]),
    );
    adapters.failWriteTarget = 'B.resx';

    const result = await runPatchSetTransaction(patchSet(['A.resx', 'B.resx']), adapters, { transactionId: 'tx2' });

    expect(result.status).toBe('rolledBack');
    expect(result.error).toContain('forced write failure');
    expect(Buffer.from((await adapters.read('A.resx'))!).toString('utf8')).toBe('old-a');
    expect(Buffer.from((await adapters.read('B.resx'))!).toString('utf8')).toBe('old-b');
    expect(adapters.journals.at(-1)?.state).toBe('rolledBack');
    expect(adapters.journals.find((j) => j.state === 'rollingBack')?.appliedTargets).toEqual(['A.resx']);
  });

  it.each(['applied', 'undoRegistered', 'committed'] as const)(
    'W0.3 compensates source and resource when persisting %s fails',
    async (failedState) => {
      const adapters = new MemoryTransactionAdapters(
        new Map([
          ['Form1.Designer.cs', Buffer.from('old-source', 'utf8')],
          ['Form1.resx', Buffer.from('old-resource', 'utf8')],
        ]),
        new Map([
          ['Form1.Designer.cs', Buffer.from('new-source', 'utf8')],
          ['Form1.resx', Buffer.from('new-resource', 'utf8')],
        ]),
      );
      adapters.failPersistState = failedState;

      const result = await runPatchSetTransaction(
        patchSet(['Form1.Designer.cs', 'Form1.resx']),
        adapters,
        { transactionId: `tx-journal-${failedState}` },
      );

      expect(result.status).toBe('rolledBack');
      expect(result.error).toContain(`forced journal failure: ${failedState}`);
      expect(Buffer.from((await adapters.read('Form1.Designer.cs'))!).toString('utf8')).toBe('old-source');
      expect(Buffer.from((await adapters.read('Form1.resx'))!).toString('utf8')).toBe('old-resource');
      expect(adapters.journals.at(-1)?.state).toBe('rolledBack');
    },
  );

  it('records recoveryRequired instead of compensating over an external edit', async () => {
    const adapters = new MemoryTransactionAdapters(
      new Map([
        ['A.resx', Buffer.from('old-a', 'utf8')],
        ['B.resx', Buffer.from('old-b', 'utf8')],
      ]),
      new Map([
        ['A.resx', Buffer.from('new-a', 'utf8')],
        ['B.resx', Buffer.from('new-b', 'utf8')],
      ]),
    );
    adapters.failWriteTarget = 'B.resx';
    adapters.onCrashPoint = (point, record) => {
      if (point === 'targetApplied' && record.appliedTargets.includes('A.resx')) {
        adapters.write('A.resx', Buffer.from('external-a', 'utf8'));
      }
    };

    const result = await runPatchSetTransaction(patchSet(['A.resx', 'B.resx']), adapters, { transactionId: 'tx3' });

    expect(result.status).toBe('recoveryRequired');
    expect(result.error).toContain('expected post-write fingerprint');
    expect(Buffer.from((await adapters.read('A.resx'))!).toString('utf8')).toBe('external-a');
    expect(adapters.journals.at(-1)?.state).toBe('recoveryRequired');
  });

  it('leaves atomically replaced applying progress for restart classification when crash injection fires', async () => {
    const adapters = new MemoryTransactionAdapters(
      new Map([['Form1.resx', Buffer.from('old', 'utf8')]]),
      new Map([['Form1.resx', Buffer.from('new', 'utf8')]]),
    );
    adapters.crashAt = 'targetApplied';

    await expect(runPatchSetTransaction(patchSet(['Form1.resx']), adapters, { transactionId: 'tx4' }))
      .rejects.toThrow('crash at targetApplied');

    const last = adapters.journals.at(-1)!;
    expect(last.state).toBe('applying');
    expect(last.appliedTargets).toEqual(['Form1.resx']);
    expect(classifyJournalForRecovery(last)).toBe('rollbackRequired');
  });

  it('commits only after one undo unit is registered and that undo restores every target', async () => {
    const adapters = new MemoryTransactionAdapters(
      new Map([
        ['A.resx', Buffer.from('old-a', 'utf8')],
        ['B.resx', Buffer.from('old-b', 'utf8')],
      ]),
      new Map([
        ['A.resx', Buffer.from('new-a', 'utf8')],
        ['B.resx', Buffer.from('new-b', 'utf8')],
      ]),
    );

    const result = await runPatchSetTransaction(patchSet(['A.resx', 'B.resx']), adapters, { transactionId: 'tx5' });

    expect(result.status).toBe('committed');
    expect(adapters.undoRegistrations).toHaveLength(1);
    expect(adapters.journals.at(-1)?.state).toBe('committed');
    expect(adapters.journals.findIndex((j) => j.state === 'undoRegistered'))
      .toBeLessThan(adapters.journals.findIndex((j) => j.state === 'committed'));
    expect(Buffer.from((await adapters.read('A.resx'))!).toString('utf8')).toBe('new-a');

    const undo = await adapters.undoRegistrations[0].undo();

    expect(undo.status).toBe('rolledBack');
    expect(Buffer.from((await adapters.read('A.resx'))!).toString('utf8')).toBe('old-a');
    expect(Buffer.from((await adapters.read('B.resx'))!).toString('utf8')).toBe('old-b');
  });
});
