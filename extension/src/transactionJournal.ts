import * as fs from 'node:fs';
import * as path from 'node:path';
import { atomicWriteLocalFile } from './atomicFile';
import { ArtifactFingerprint, snapshotArtifactBytes } from './documentStore';

export type TransactionJournalState =
  | 'created'
  | 'prepared'
  | 'applying'
  | 'applied'
  | 'undoRegistered'
  | 'committed'
  | 'rollingBack'
  | 'rolledBack'
  | 'recoveryRequired'
  | 'aborted';

export type RecoveryClassification =
  | 'clean'
  | 'resumeApply'
  | 'verifyCommit'
  | 'rollbackRequired'
  | 'resumeRollback'
  | 'manualResolution'
  | 'terminal'
  | 'corrupt';

export interface TransactionJournalRecord {
  schemaVersion: '2.0.0';
  transactionId: string;
  patchSetId: string;
  /** Absolute root used to resolve every journal target. Recovery refuses paths that escape it. */
  workspaceRoot: string;
  state: TransactionJournalState;
  createdAtUtc: string;
  updatedAtUtc: string;
  baseFingerprints: Record<string, ArtifactFingerprint>;
  afterFingerprints: Record<string, ArtifactFingerprint>;
  /** Exact durable rollback images. `null` means the artifact did not exist. */
  beforeBytesBase64: Record<string, string | null>;
  /** Exact durable forward images, used to identify writes that landed before the process died. */
  afterBytesBase64: Record<string, string | null>;
  appliedTargets: string[];
  error?: string;
}

export interface CreateJournalRecordOptions {
  transactionId: string;
  patchSetId: string;
  workspaceRoot: string;
  baseFingerprints: Record<string, ArtifactFingerprint>;
  afterFingerprints: Record<string, ArtifactFingerprint>;
  beforeBytesBase64: Record<string, string | null>;
  afterBytesBase64: Record<string, string | null>;
  nowUtc?: string;
}

const transitions: Record<TransactionJournalState, readonly TransactionJournalState[]> = {
  created: ['prepared', 'aborted'],
  prepared: ['applying', 'rollingBack', 'aborted'],
  applying: ['applied', 'rollingBack'],
  applied: ['undoRegistered', 'rollingBack', 'recoveryRequired'],
  undoRegistered: ['committed', 'rollingBack', 'recoveryRequired'],
  committed: [],
  rollingBack: ['rolledBack', 'aborted'],
  rolledBack: [],
  recoveryRequired: [],
  aborted: [],
};

export function createJournalRecord(options: CreateJournalRecordOptions): TransactionJournalRecord {
  const nowUtc = options.nowUtc ?? new Date().toISOString();
  return {
    schemaVersion: '2.0.0',
    transactionId: options.transactionId,
    patchSetId: options.patchSetId,
    workspaceRoot: path.resolve(options.workspaceRoot),
    state: 'created',
    createdAtUtc: nowUtc,
    updatedAtUtc: nowUtc,
    baseFingerprints: { ...options.baseFingerprints },
    afterFingerprints: { ...options.afterFingerprints },
    beforeBytesBase64: { ...options.beforeBytesBase64 },
    afterBytesBase64: { ...options.afterBytesBase64 },
    appliedTargets: [],
  };
}

export function canTransitionJournal(
  from: TransactionJournalState,
  to: TransactionJournalState,
): boolean {
  return transitions[from].includes(to);
}

export function transitionJournal(
  record: TransactionJournalRecord,
  state: TransactionJournalState,
  options: { nowUtc?: string; appliedTarget?: string; error?: string } = {},
): TransactionJournalRecord {
  if (!canTransitionJournal(record.state, state)) {
    throw new Error(`invalid journal transition: ${record.state} -> ${state}`);
  }
  return {
    ...record,
    state,
    updatedAtUtc: options.nowUtc ?? new Date().toISOString(),
    appliedTargets: options.appliedTarget
      ? [...record.appliedTargets, options.appliedTarget]
      : [...record.appliedTargets],
    error: options.error ?? record.error,
  };
}

export function classifyJournalForRecovery(record: TransactionJournalRecord | null): RecoveryClassification {
  if (!record) return 'clean';
  if (record.schemaVersion !== '2.0.0' || !record.transactionId || !record.patchSetId) return 'corrupt';
  switch (record.state) {
    case 'created':
    case 'prepared':
      return 'clean';
    case 'applying':
      // A process can die after replacing a target but before appliedTargets is persisted. Durable byte images,
      // not that advisory list, decide whether rollback has work to do.
      return 'rollbackRequired';
    case 'applied':
    case 'undoRegistered':
      return 'rollbackRequired';
    case 'rollingBack':
      return 'resumeRollback';
    case 'recoveryRequired':
      return 'manualResolution';
    case 'committed':
    case 'rolledBack':
    case 'aborted':
      return 'terminal';
    default:
      return 'corrupt';
  }
}

async function replaceFileAtomic(target: string, bytes: Uint8Array): Promise<void> {
  const dir = path.dirname(target);
  await fs.promises.mkdir(dir, { recursive: true });
  await atomicWriteLocalFile(target, bytes);
}

export async function writeJournalFile(target: string, record: TransactionJournalRecord): Promise<void> {
  const json = `${JSON.stringify(record, null, 2)}\n`;
  await replaceFileAtomic(target, Buffer.from(json, 'utf8'));
}

export async function readJournalFile(target: string): Promise<TransactionJournalRecord | null> {
  try {
    const value: unknown = JSON.parse(await fs.promises.readFile(target, 'utf8'));
    if (!isTransactionJournalRecord(value)) throw new Error(`invalid transaction journal: ${target}`);
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function isFingerprint(value: unknown): value is ArtifactFingerprint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Partial<ArtifactFingerprint>;
  if (typeof v.exists !== 'boolean' || typeof v.bom !== 'boolean') return false;
  if (!validNullableFiniteNumber(v.mtimeMs) || !validDocumentVersion(v.documentVersion)) return false;
  if (!v.exists) {
    return v.bom === false
      && v.bytesSha256 === null
      && v.textSha256 === null
      && v.byteLength === null;
  }
  return isSha256(v.bytesSha256)
    && isSha256(v.textSha256)
    && typeof v.byteLength === 'number'
    && Number.isSafeInteger(v.byteLength)
    && v.byteLength >= 0;
}

function isFingerprintMap(value: unknown): value is Record<string, ArtifactFingerprint> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.entries(value as Record<string, unknown>)
      .every(([target, fingerprint]) => target.length > 0 && isFingerprint(fingerprint));
}

function isCanonicalBase64(value: string): boolean {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return false;
  return Buffer.from(value, 'base64').toString('base64') === value;
}

function isByteImageMap(value: unknown): value is Record<string, string | null> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.entries(value as Record<string, unknown>)
      .every(([target, bytes]) => target.length > 0
        && (bytes === null || (typeof bytes === 'string' && isCanonicalBase64(bytes))));
}

function sameKeys(...maps: readonly Record<string, unknown>[]): boolean {
  if (maps.length < 2) return true;
  const expected = Object.keys(maps[0]).sort();
  return maps.slice(1).every((map) => {
    const actual = Object.keys(map).sort();
    return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
  });
}

function byteImageMatchesFingerprint(bytesBase64: string | null, fingerprint: ArtifactFingerprint): boolean {
  if (bytesBase64 === null) return !fingerprint.exists;
  const snapshot = snapshotArtifactBytes('journal-target', Buffer.from(bytesBase64, 'base64'));
  return fingerprint.exists
    && snapshot.bom === fingerprint.bom
    && snapshot.bytesSha256 === fingerprint.bytesSha256
    && snapshot.textSha256 === fingerprint.textSha256
    && snapshot.byteLength === fingerprint.byteLength;
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function validNullableFiniteNumber(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
}

function validDocumentVersion(value: unknown): value is string | number | null {
  return value === null
    || (typeof value === 'string' && value.length > 0)
    || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
}

function isTransactionJournalRecord(value: unknown): value is TransactionJournalRecord {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<TransactionJournalRecord>;
  return v.schemaVersion === '2.0.0'
    && typeof v.transactionId === 'string' && v.transactionId.length > 0
    && typeof v.patchSetId === 'string' && v.patchSetId.length > 0
    && typeof v.workspaceRoot === 'string' && path.isAbsolute(v.workspaceRoot)
    && typeof v.state === 'string' && Object.prototype.hasOwnProperty.call(transitions, v.state)
    && typeof v.createdAtUtc === 'string'
    && typeof v.updatedAtUtc === 'string'
    && isFingerprintMap(v.baseFingerprints)
    && isFingerprintMap(v.afterFingerprints)
    && isByteImageMap(v.beforeBytesBase64)
    && isByteImageMap(v.afterBytesBase64)
    && sameKeys(v.baseFingerprints, v.afterFingerprints, v.beforeBytesBase64, v.afterBytesBase64)
    && Object.entries(v.beforeBytesBase64).every(([target, bytes]) =>
      byteImageMatchesFingerprint(bytes, v.baseFingerprints?.[target] as ArtifactFingerprint))
    && Object.entries(v.afterBytesBase64).every(([target, bytes]) =>
      byteImageMatchesFingerprint(bytes, v.afterFingerprints?.[target] as ArtifactFingerprint))
    && Array.isArray(v.appliedTargets)
    && v.appliedTargets.every((target) => typeof target === 'string'
      && Object.prototype.hasOwnProperty.call(v.baseFingerprints, target));
}
