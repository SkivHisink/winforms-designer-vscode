import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  ArtifactSnapshot,
  artifactFingerprint,
  detectEol,
  sameArtifactFingerprint,
  snapshotArtifactBytes,
  snapshotMissingArtifact,
} from './documentStore';
import { PatchOperation, PatchSet } from './patchSet';
import { TransactionJournalRecord, writeJournalFile } from './transactionJournal';
import {
  PlannedTargetMutation,
  TransactionCrashPoint,
  TransactionPostconditionContext,
  TransactionRunnerAdapters,
  TransactionRunnerResult,
  runPatchSetTransaction,
} from './transactionRunner';

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

export interface DesignerResourceTransactionTarget {
  filePath: string;
  before: string | null;
  after: string;
  bom: boolean;
}

export interface DesignerResourceTransactionOptions {
  label: string;
  workspaceRoot: string;
  journalRoot: string;
  targets: readonly DesignerResourceTransactionTarget[];
  transactionId?: string;
  nowUtc?: () => string;
  readBytes(filePath: string): Promise<Uint8Array | null>;
  writeBytes(filePath: string, bytes: Uint8Array): Promise<void>;
  deleteFile(filePath: string): Promise<void>;
  registerUndo(): boolean | Promise<boolean>;
  /** Test/fault-injection seam before the atomic journal replacement. Normal product callers omit it. */
  beforePersistJournal?(record: TransactionJournalRecord): void | Promise<void>;
  /** Process-crash test seam. Throw TransactionCrashInjectionError to leave the durable journal incomplete. */
  crashHook?(point: TransactionCrashPoint, record: TransactionJournalRecord): void | Promise<void>;
  /** Test/fault-injection seam after the real byte fingerprints passed. Returning false exercises the runner's normal
   * postcondition-failure compensation; production callers omit it and cannot turn a failed real check into success. */
  afterVerifiedPostconditions?(
    phase: 'forward' | 'rollback' | 'undo',
    context: TransactionPostconditionContext,
  ): boolean | Promise<boolean>;
}

function resourceTextBytes(text: string | null, bom: boolean): Uint8Array | null {
  if (text === null) return null;
  const body = Buffer.from(text, 'utf8');
  return bom ? Buffer.concat([UTF8_BOM, body]) : body;
}

export function normalizeTransactionRoot(root: string): string {
  if (!path.isAbsolute(root)) throw new Error('workspaceRoot must be absolute');
  return path.resolve(root);
}

export function isPathInsideOrSame(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resourceTransactionRelativeTarget(root: string, filePath: string): string {
  const normalizedRoot = normalizeTransactionRoot(root);
  const absolute = path.resolve(filePath);
  if (!isPathInsideOrSame(normalizedRoot, absolute)) {
    throw new Error(`resource transaction target escapes workspace root: ${filePath}`);
  }
  const relative = path.relative(normalizedRoot, absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`resource transaction target escapes workspace root: ${filePath}`);
  }
  return relative.split(path.sep).join('/');
}

function resourceTransactionTargetKey(target: string): string {
  return process.platform === 'win32' ? target.toLowerCase() : target;
}

export function createDesignerResourceTransactionId(): string {
  return `resx-${Date.now().toString(36)}-${randomBytes(8).toString('hex')}`;
}

export function createDesignerResourcePatchSet(
  id: string,
  workspaceRoot: string,
  targets: readonly DesignerResourceTransactionTarget[],
): PatchSet {
  const root = normalizeTransactionRoot(workspaceRoot);
  const operations: PatchOperation[] = targets.map((target) => {
    const beforeEol = detectEol(target.before ?? '');
    const afterEol = detectEol(target.after);
    const beforeBom = target.before !== null && target.bom;
    const afterBom = target.bom;
    return {
      kind: 'writeResourceText',
      target: resourceTransactionRelativeTarget(root, target.filePath),
      preservation: {
        beforeBom,
        afterBom,
        beforeEol,
        afterEol,
        allowBomChange: beforeBom !== afterBom,
        allowEolChange: beforeEol !== afterEol,
      },
    };
  });
  return {
    id,
    lane: 'A',
    workspaceRoot: root,
    operations,
  };
}

export async function runDesignerResourceTransaction(
  options: DesignerResourceTransactionOptions,
): Promise<TransactionRunnerResult> {
  const transactionId = options.transactionId ?? createDesignerResourceTransactionId();
  const patchSet = createDesignerResourcePatchSet(`${transactionId}-patch`, options.workspaceRoot, options.targets);
  const root = normalizeTransactionRoot(options.workspaceRoot);
  const byTarget = new Map<string, DesignerResourceTransactionTarget>();
  for (const target of options.targets) {
    byTarget.set(resourceTransactionTargetKey(resourceTransactionRelativeTarget(root, target.filePath)), target);
  }
  const pendingSnapshotBytes = new Map<string, Uint8Array | null>();
  const journalPath = path.join(options.journalRoot, `${transactionId.replace(/[^A-Za-z0-9_.-]/g, '_')}.json`);

  const targetSpec = (target: string): DesignerResourceTransactionTarget => {
    const spec = byTarget.get(resourceTransactionTargetKey(target));
    if (!spec) throw new Error(`resource transaction target is not planned: ${target}`);
    return spec;
  };
  const snapshotOf = (target: string, bytes: Uint8Array | null): ArtifactSnapshot =>
    bytes === null ? snapshotMissingArtifact(target) : snapshotArtifactBytes(target, bytes);

  const adapters: TransactionRunnerAdapters = {
    snapshot: async (target) => {
      const bytes = await options.readBytes(targetSpec(target).filePath);
      const copy = bytes === null ? null : Buffer.from(bytes);
      pendingSnapshotBytes.set(resourceTransactionTargetKey(target), copy);
      return snapshotOf(target, copy);
    },
    read: async (target) => {
      const key = resourceTransactionTargetKey(target);
      if (pendingSnapshotBytes.has(key)) {
        const bytes = pendingSnapshotBytes.get(key) ?? null;
        pendingSnapshotBytes.delete(key);
        return bytes === null ? null : Buffer.from(bytes);
      }
      const bytes = await options.readBytes(targetSpec(target).filePath);
      return bytes === null ? null : Buffer.from(bytes);
    },
    planTargetMutation: async ({ target, baseBytes }): Promise<PlannedTargetMutation> => {
      const spec = targetSpec(target);
      const declaredBefore = resourceTextBytes(spec.before, spec.bom);
      const baselineMatches = declaredBefore === null || baseBytes === null
        ? declaredBefore === baseBytes
        : Buffer.from(declaredBefore).equals(Buffer.from(baseBytes));
      if (!baselineMatches) throw new Error(`resource transaction baseline is stale: ${target}`);
      const afterBytes = resourceTextBytes(spec.after, spec.bom);
      if (afterBytes === null) throw new Error(`resource transaction has no forward bytes: ${target}`);
      return {
        target,
        afterBytes,
        expectedAfterFingerprint: artifactFingerprint(snapshotOf(target, afterBytes)),
      };
    },
    write: (target, bytes) => options.writeBytes(targetSpec(target).filePath, bytes),
    delete: (target) => options.deleteFile(targetSpec(target).filePath),
    persistJournal: async (record) => {
      await options.beforePersistJournal?.(record);
      await writeJournalFile(journalPath, record);
    },
    crashHook: options.crashHook
      ? async (point, record) => { await options.crashHook?.(point, record); }
      : undefined,
    verifyPostconditions: async (context) => {
      const reason = (context as { reason?: 'rollback' | 'undo' }).reason;
      const expectedFingerprints = reason === 'rollback' || reason === 'undo'
        ? context.baseFingerprints
        : context.afterFingerprints;
      for (const target of context.appliedTargets) {
        const expected = expectedFingerprints[target];
        if (!expected) return false;
        const bytes = await options.readBytes(targetSpec(target).filePath);
        if (!sameArtifactFingerprint(artifactFingerprint(snapshotOf(target, bytes)), expected)) return false;
      }
      return options.afterVerifiedPostconditions
        ? options.afterVerifiedPostconditions(reason ?? 'forward', context)
        : true;
    },
    registerUndo: async () => {
      if (!await options.registerUndo()) throw new Error('resource transaction undo registration refused');
    },
  };

  return runPatchSetTransaction(patchSet, adapters, { transactionId, nowUtc: options.nowUtc });
}
