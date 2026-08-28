import * as path from 'node:path';
import {
  ArtifactFingerprint,
  ArtifactSnapshot,
  artifactFingerprint,
  sameArtifactFingerprint,
} from './documentStore';
import { PatchOperation, PatchSet, authorizePatchSetTargets } from './patchSet';
import {
  TransactionJournalRecord,
  TransactionJournalState,
  createJournalRecord,
  transitionJournal,
} from './transactionJournal';

export type TransactionCrashPoint =
  | 'createdPersisted'
  | 'preparedPersisted'
  | 'applyingPersisted'
  | 'targetWritten'
  | 'targetApplied'
  | 'appliedPersisted'
  | 'undoRegistered'
  | 'beforeCommit'
  | 'committedPersisted';

export type TransactionRunnerStatus =
  | 'committed'
  | 'aborted'
  | 'rolledBack'
  | 'recoveryRequired';

export interface TransactionTargetContext {
  readonly target: string;
  readonly operations: readonly PatchOperation[];
  readonly baseSnapshot: ArtifactSnapshot;
  readonly baseBytes: Uint8Array | null;
}

export interface PlannedTargetMutation {
  readonly target: string;
  readonly afterBytes: Uint8Array | null;
  readonly expectedAfterFingerprint: ArtifactFingerprint;
}

export interface TransactionPostconditionContext {
  readonly transactionId: string;
  readonly patchSet: PatchSet;
  readonly baseFingerprints: Readonly<Record<string, ArtifactFingerprint>>;
  readonly afterFingerprints: Readonly<Record<string, ArtifactFingerprint>>;
  readonly appliedTargets: readonly string[];
}

export interface TransactionUndoContext extends TransactionPostconditionContext {
  readonly reason: 'rollback' | 'undo';
}

export interface TransactionUndoRegistration {
  readonly transactionId: string;
  readonly patchSetId: string;
  readonly targets: readonly string[];
  undo(): Promise<TransactionRunnerResult>;
  /** Reapply the same patch as a fresh durable transaction after a successful undo. */
  redo(): Promise<TransactionRunnerResult>;
}

export interface TransactionRunnerAdapters {
  snapshot(target: string): Promise<ArtifactSnapshot>;
  read(target: string): Promise<Uint8Array | null>;
  planTargetMutation(context: TransactionTargetContext): Promise<PlannedTargetMutation>;
  write(target: string, bytes: Uint8Array): Promise<void>;
  delete(target: string): Promise<void>;
  persistJournal(record: TransactionJournalRecord): Promise<void>;
  verifyPostconditions?(context: TransactionPostconditionContext): Promise<boolean>;
  registerUndo?(registration: TransactionUndoRegistration): Promise<void>;
  crashHook?(point: TransactionCrashPoint, record: TransactionJournalRecord): Promise<void>;
}

export interface RunTransactionOptions {
  transactionId: string;
  nowUtc?: () => string;
}

export interface TransactionRunnerResult {
  status: TransactionRunnerStatus;
  journal: TransactionJournalRecord;
  error?: string;
  /** Durable rollback registration retained by the caller. Product adapters can bind this exact function to their
   * native undo unit instead of reimplementing compensation and silently dropping journal state. */
  undoRegistration?: TransactionUndoRegistration;
}

export class TransactionCrashInjectionError extends Error {
  public readonly transactionCrashInjection = true;
}

interface TargetMutationState {
  readonly target: string;
  readonly operations: readonly PatchOperation[];
  readonly baseSnapshot: ArtifactSnapshot;
  readonly baseFingerprint: ArtifactFingerprint;
  readonly baseBytes: Uint8Array | null;
  readonly afterBytes: Uint8Array | null;
  readonly expectedAfterFingerprint: ArtifactFingerprint;
}

function utcClock(options: RunTransactionOptions): () => string {
  return options.nowUtc ?? (() => new Date().toISOString());
}

function normalizeWorkspaceRoot(root: string): string {
  if (!path.isAbsolute(root)) throw new Error('workspaceRoot must be absolute');
  return path.resolve(root);
}

function normalizeRelativeTarget(root: string, absoluteTarget: string): string {
  const relative = path.relative(root, absoluteTarget);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`validated target escaped workspace root: ${absoluteTarget}`);
  }
  return relative.split(path.sep).join('/');
}

function sameTarget(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function operationsForTarget(root: string, target: string, patchSet: PatchSet): PatchOperation[] {
  return patchSet.operations.filter((operation) => {
    const absolute = path.resolve(root, operation.target);
    return sameTarget(normalizeRelativeTarget(root, absolute), target);
  });
}

function targetMap<T>(targets: readonly TargetMutationState[], select: (target: TargetMutationState) => T): Record<string, T> {
  const result: Record<string, T> = {};
  for (const target of targets) result[target.target] = select(target);
  return result;
}

function byteImage(bytes: Uint8Array | null): string | null {
  return bytes === null ? null : Buffer.from(bytes).toString('base64');
}

function withState(
  record: TransactionJournalRecord,
  state: TransactionJournalState,
  nowUtc: string,
  extras: Partial<TransactionJournalRecord> = {},
): TransactionJournalRecord {
  return {
    ...record,
    ...extras,
    state,
    updatedAtUtc: nowUtc,
  };
}

async function persist(
  adapters: TransactionRunnerAdapters,
  point: TransactionCrashPoint,
  record: TransactionJournalRecord,
): Promise<void> {
  await adapters.persistJournal(record);
  await adapters.crashHook?.(point, record);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function writeTarget(adapters: TransactionRunnerAdapters, target: TargetMutationState, bytes: Uint8Array | null): Promise<void> {
  if (bytes === null) await adapters.delete(target.target);
  else await adapters.write(target.target, bytes);
}

async function verifyFingerprint(
  adapters: TransactionRunnerAdapters,
  target: string,
  expected: ArtifactFingerprint,
): Promise<boolean> {
  const current = artifactFingerprint(await adapters.snapshot(target));
  return sameArtifactFingerprint(current, expected);
}

async function compensateTargets(
  adapters: TransactionRunnerAdapters,
  patchSet: PatchSet,
  targets: readonly TargetMutationState[],
  appliedTargets: readonly string[],
  journal: TransactionJournalRecord,
  now: () => string,
  reason: 'rollback' | 'undo',
): Promise<TransactionRunnerResult> {
  let record = journal;
  const applied = new Set(appliedTargets);
  const reverse = [...targets].filter((target) => applied.has(target.target)).reverse();

  for (const target of reverse) {
    const current = artifactFingerprint(await adapters.snapshot(target.target));
    if (!sameArtifactFingerprint(current, target.expectedAfterFingerprint)) {
      const message = `${reason} refused: ${target.target} no longer matches the expected post-write fingerprint`;
      record = withState(record, 'recoveryRequired', now(), { error: message });
      await adapters.persistJournal(record);
      return { status: 'recoveryRequired', journal: record, error: message };
    }

    try {
      await writeTarget(adapters, target, target.baseBytes);
    } catch (error) {
      const message = `${reason} failed while restoring ${target.target}: ${errorMessage(error)}`;
      record = withState(record, 'recoveryRequired', now(), { error: message });
      await adapters.persistJournal(record);
      return { status: 'recoveryRequired', journal: record, error: message };
    }

    const restored = await verifyFingerprint(adapters, target.target, target.baseFingerprint);
    if (!restored) {
      const message = `${reason} restored ${target.target}, but the baseline fingerprint did not match`;
      record = withState(record, 'recoveryRequired', now(), { error: message });
      await adapters.persistJournal(record);
      return { status: 'recoveryRequired', journal: record, error: message };
    }
  }

  if (adapters.verifyPostconditions) {
    const ok = await adapters.verifyPostconditions({
      transactionId: record.transactionId,
      patchSet,
      baseFingerprints: record.baseFingerprints,
      afterFingerprints: record.afterFingerprints,
      appliedTargets,
      reason,
    } as TransactionUndoContext);
    if (!ok) {
      const message = `${reason} postcondition verification failed`;
      record = withState(record, 'recoveryRequired', now(), { error: message });
      await adapters.persistJournal(record);
      return { status: 'recoveryRequired', journal: record, error: message };
    }
  }

  return { status: 'rolledBack', journal: record };
}

function isCrashInjection(error: unknown): boolean {
  return error instanceof TransactionCrashInjectionError
    || (!!error && typeof error === 'object' && (error as { transactionCrashInjection?: boolean }).transactionCrashInjection === true);
}

export async function runPatchSetTransaction(
  patchSet: PatchSet,
  adapters: TransactionRunnerAdapters,
  options: RunTransactionOptions,
): Promise<TransactionRunnerResult> {
  const now = utcClock(options);
  const validation = await authorizePatchSetTargets(patchSet);
  if (!validation.ok) throw new Error(validation.errors.join('; '));

  const root = normalizeWorkspaceRoot(patchSet.workspaceRoot);
  const relativeTargets = validation.normalizedTargets.map((target) => normalizeRelativeTarget(root, target));
  const targets: TargetMutationState[] = [];

  for (const target of relativeTargets) {
    const baseSnapshot = await adapters.snapshot(target);
    const baseBytes = await adapters.read(target);
    if (baseSnapshot.exists !== (baseBytes !== null)) {
      throw new Error(`snapshot/read existence mismatch: ${target}`);
    }
    const context: TransactionTargetContext = {
      target,
      operations: operationsForTarget(root, target, patchSet),
      baseSnapshot,
      baseBytes: baseBytes === null ? null : Buffer.from(baseBytes),
    };
    const planned = await adapters.planTargetMutation(context);
    if (planned.target !== target) throw new Error(`planned mutation target mismatch: ${planned.target}`);
    targets.push({
      ...context,
      baseFingerprint: artifactFingerprint(baseSnapshot),
      baseBytes: context.baseBytes,
      afterBytes: planned.afterBytes === null ? null : Buffer.from(planned.afterBytes),
      expectedAfterFingerprint: planned.expectedAfterFingerprint,
    });
  }

  let record = createJournalRecord({
    transactionId: options.transactionId,
    patchSetId: patchSet.id,
    workspaceRoot: root,
    baseFingerprints: targetMap(targets, (target) => target.baseFingerprint),
    afterFingerprints: targetMap(targets, (target) => target.expectedAfterFingerprint),
    beforeBytesBase64: targetMap(targets, (target) => byteImage(target.baseBytes)),
    afterBytesBase64: targetMap(targets, (target) => byteImage(target.afterBytes)),
    nowUtc: now(),
  });
  await persist(adapters, 'createdPersisted', record);

  record = transitionJournal(record, 'prepared', { nowUtc: now() });
  await persist(adapters, 'preparedPersisted', record);

  for (const target of targets) {
    const current = artifactFingerprint(await adapters.snapshot(target.target));
    if (!sameArtifactFingerprint(current, target.baseFingerprint)) {
      const message = `transaction refused before first write: ${target.target} changed after baseline capture`;
      record = transitionJournal(record, 'aborted', { nowUtc: now(), error: message });
      await adapters.persistJournal(record);
      return { status: 'aborted', journal: record, error: message };
    }
  }

  record = transitionJournal(record, 'applying', { nowUtc: now() });
  await persist(adapters, 'applyingPersisted', record);

  try {
    for (const target of targets) {
      const current = artifactFingerprint(await adapters.snapshot(target.target));
      if (!sameArtifactFingerprint(current, target.baseFingerprint)) {
        throw new Error(`${target.target} changed before write`);
      }

      await writeTarget(adapters, target, target.afterBytes);

      const written = await verifyFingerprint(adapters, target.target, target.expectedAfterFingerprint);
      if (!written) throw new Error(`${target.target} did not match the expected post-write fingerprint`);

      // Deliberately observable before appliedTargets is persisted. A real process can die in this exact gap;
      // startup recovery must identify the landed bytes from the durable before/after images, not trust the list.
      await adapters.crashHook?.('targetWritten', record);

      record = withState(record, 'applying', now(), {
        appliedTargets: [...record.appliedTargets, target.target],
      });
      await persist(adapters, 'targetApplied', record);
    }

    record = transitionJournal(record, 'applied', { nowUtc: now() });
    await persist(adapters, 'appliedPersisted', record);

    const postconditionsOk = await adapters.verifyPostconditions?.({
      transactionId: options.transactionId,
      patchSet,
      baseFingerprints: record.baseFingerprints,
      afterFingerprints: record.afterFingerprints,
      appliedTargets: record.appliedTargets,
    });
    if (postconditionsOk === false) throw new Error('transaction postcondition verification failed');

    const undoRegistration: TransactionUndoRegistration = {
      transactionId: options.transactionId,
      patchSetId: patchSet.id,
      targets: relativeTargets,
      undo: async () => {
        const undoRecord = withState(record, 'rollingBack', now());
        await adapters.persistJournal(undoRecord);
        const undo = await compensateTargets(adapters, patchSet, targets, relativeTargets, undoRecord, now, 'undo');
        if (undo.status === 'recoveryRequired') return undo;
        const rolledBack = withState(undo.journal, 'rolledBack', now());
        await adapters.persistJournal(rolledBack);
        return { status: 'rolledBack', journal: rolledBack };
      },
      redo: async () => runPatchSetTransaction(patchSet, adapters, {
        transactionId: `${options.transactionId}-redo-${Date.now().toString(36)}`,
        nowUtc: options.nowUtc,
      }),
    };
    await adapters.registerUndo?.(undoRegistration);

    // Do not advance the in-memory state until the durable journal write succeeds. If the write of
    // undoRegistered fails, the catch path must still see `applied` so it can legally enter rollingBack and
    // compensate every written target. Advancing first made a late journal failure depend on an entry that was
    // never durable and, at the final state below, attempted the impossible committed -> rollingBack transition.
    const undoRegisteredRecord = transitionJournal(record, 'undoRegistered', { nowUtc: now() });
    await persist(adapters, 'undoRegistered', undoRegisteredRecord);
    record = undoRegisteredRecord;
    await adapters.crashHook?.('beforeCommit', record);

    // `committed` is terminal only after its journal image is durable. Keep `record` at undoRegistered while the
    // final write is in flight so an ordinary I/O failure can compensate instead of throwing from the state machine.
    const committedRecord = transitionJournal(record, 'committed', { nowUtc: now() });
    await persist(adapters, 'committedPersisted', committedRecord);
    record = committedRecord;
    return { status: 'committed', journal: record, undoRegistration };
  } catch (error) {
    if (isCrashInjection(error)) throw error;
    const message = errorMessage(error);
    record = transitionJournal(record, 'rollingBack', { nowUtc: now(), error: message });
    await adapters.persistJournal(record);

    const rollback = await compensateTargets(adapters, patchSet, targets, record.appliedTargets, record, now, 'rollback');
    if (rollback.status === 'recoveryRequired') return rollback;

    record = transitionJournal(rollback.journal, 'rolledBack', { nowUtc: now(), error: message });
    await adapters.persistJournal(record);
    return { status: 'rolledBack', journal: record, error: message };
  }
}
