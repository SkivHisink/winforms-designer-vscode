import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { sha256Hex } from './documentStore';
import { stagingPath } from './atomicFile';

/** Refusal while a rollback/downgrade is being prepared: no new operation may start (see rollbackPreparation.ts). */
export const ROLLBACK_PREPARED = 'ROLLBACK_PREPARED';
let admissionFrozen = false;
const inFlightOperations = new Set<Promise<unknown>>();

/** Stop (or resume) admitting new host mutations. Operations already running are allowed to finish. */
export function setHostMutationAdmissionFrozen(frozen: boolean): void { admissionFrozen = frozen; }
export function hostMutationAdmissionFrozen(): boolean { return admissionFrozen; }

/** Wait until every running host mutation, on every document, has settled; false when the bound elapses first. */
export async function settleAllHostMutations(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (inFlightOperations.size > 0) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled([...inFlightOperations]),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, remaining); }),
    ]);
    if (timer) clearTimeout(timer);
  }
  return true;
}

function rollbackRefusal(): Error {
  return Object.assign(new Error('a rollback is being prepared; no new designer operation is accepted'), { code: ROLLBACK_PREPARED });
}

let invalidationEpoch = 0;
let invalidationListener: (() => void) | undefined;
/** Advances whenever a step that cannot be refused cancelled a rollback preparation's freeze. */
export function rollbackInvalidationEpoch(): number { return invalidationEpoch; }
export function onRollbackPreparationInvalidated(listener: (() => void) | undefined): void { invalidationListener = listener; }

/** Run a step VS Code has already committed to in its own model (native Undo/Redo, Revert): refusing it would leave
 * the workbench's history and dirty state disagreeing with the document. While frozen it runs anyway and cancels the
 * rollback preparation instead — admission reopens and the preparation has to be repeated. Tracked like any other. */
export function trackUnrefusableHostMutation<T>(work: () => Promise<T>): Promise<T> {
  if (admissionFrozen) {
    admissionFrozen = false;
    invalidationEpoch++;
    try { invalidationListener?.(); } catch { /* notification only */ }
  }
  return trackHostMutation(work);
}

/** Admit work whose completion is signalled later (a deferred code-behind history replay): refused once frozen, and
 * counted as running until the returned callback is called. */
export function beginHostMutation(): () => void {
  if (admissionFrozen) throw rollbackRefusal();
  let settle!: () => void;
  const pending = new Promise<void>((resolve) => { settle = resolve; });
  inFlightOperations.add(pending);
  void pending.then(() => inFlightOperations.delete(pending));
  let settled = false;
  return () => { if (!settled) { settled = true; settle(); } };
}

/** Run durable work that does not pass through a ledger (native Undo/Redo of a resource transaction) under the same
 * rollback admission: refused once frozen, and awaited by settleAllHostMutations while it runs. */
export function trackHostMutation<T>(work: () => Promise<T>): Promise<T> {
  if (admissionFrozen) return Promise.reject(rollbackRefusal());
  const pending = work();
  inFlightOperations.add(pending);
  void pending.then(() => inFlightOperations.delete(pending), () => inFlightOperations.delete(pending));
  return pending;
}

export type HostMutationStatus = 'pending' | 'committed' | 'noChange' | 'refused' | 'recoveryRequired';
export interface HostMutationResult {
  operationId: string;
  status: Exclude<HostMutationStatus, 'pending'>;
  replayed: boolean;
  code?: string;
}
export interface HostMutationTarget {
  filePath: string;
  beforeSha256: string | null;
  afterSha256: string | null;
}
export interface HostMutationRecord {
  schemaVersion: '2.2.0';
  documentId: string;
  operationId: string;
  payloadFingerprint: string;
  createdAtUtc: string;
  updatedAtUtc: string;
  status: HostMutationStatus;
  baseRevision: number;
  beforeSourceSha256: string;
  sourceFilePath?: string;
  afterSourceSha256?: string;
  commitCount: number;
  targets: HostMutationTarget[];
  transactionIds: string[];
  /** VS Code owns unsaved companion buffers. A pending crash cannot infer their outcome from disk bytes. */
  companionBuffers?: HostMutationTarget[];
  externalEffectsPossible?: boolean;
  code?: string;
}
export interface HostMutationBaseline { sourceText: string; revision: number; sourceFilePath?: string; }
interface HostMutationScope { ledger: HostMutationLedger; record: HostMutationRecord; }
const mutationContext = new AsyncLocalStorage<HostMutationScope>();

/** Canonical intent fingerprint: object key order and attempt IDs cannot change a stable operation's identity. */
export function mutationPayloadFingerprint(payload: unknown): string {
  const canonical = (value: unknown, outer = false): unknown => {
    if (Array.isArray(value)) return value.map((item) => canonical(item));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
      .filter(([key, item]) => item !== undefined && (!outer || (key !== 'operationId' && key !== 'requestAttemptId')))
      .sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)]));
    return value;
  };
  return sha256Hex(JSON.stringify(canonical(payload, true)) ?? 'null');
}

export function currentHostMutationOperationId(): string | undefined { return mutationContext.getStore()?.record.operationId; }
export function currentHostMutationIdentity(): { documentId: string; operationId: string; payloadFingerprint: string } | undefined {
  const record = mutationContext.getStore()?.record;
  return record ? { documentId: record.documentId, operationId: record.operationId, payloadFingerprint: record.payloadFingerprint } : undefined;
}

function result(record: HostMutationRecord, replayed: boolean): HostMutationResult {
  return { operationId: record.operationId, status: record.status === 'pending' ? 'recoveryRequired' : record.status,
    replayed, ...(record.code ? { code: record.code } : {}) };
}

/** Each file is published after flushing its staging bytes. As with atomicFile, Windows directory durability is
 * limited by Node's directory-handle API; this guarantees process-crash recovery, not stronger power-loss claims. */
function persistRecord(filePath: string, record: HostMutationRecord): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const staged = stagingPath(filePath);
  let fd: number | undefined;
  try {
    fd = fs.openSync(staged, 'wx');
    fs.writeFileSync(fd, JSON.stringify(record) + '\n', 'utf8');
    fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(staged, filePath);
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(staged); } catch { /* no published record was changed */ }
    throw error;
  }
}

export function hostMutationRecordPath(storageRoot: string, documentId: string, operationId: string): string {
  return path.join(storageRoot, 'v2-operations', sha256Hex(canonicalHostDocumentId(documentId)), `${sha256Hex(operationId)}.json`);
}

export function canonicalHostDocumentId(documentId: string): string {
  return process.platform === 'win32' ? path.resolve(documentId).toLocaleLowerCase('en-US') : documentId;
}
function mayHaveExternalEffects(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const intent = payload as { type?: unknown; method?: unknown; callback?: unknown };
  return ['uiTypeEditor', 'uiCollectionEditor', 'designerActionCommand'].includes(String(intent.type))
    || /Hosted|Vendor|UiTypeEditor|CollectionEditor/.test(String(intent.method)) || intent.callback !== undefined;
}
export function knownTransportCancellationCode(error: unknown): string | undefined {
  const code = error && typeof error === 'object' ? (error as { code?: unknown; message?: unknown }).code
    ?? (error as { message?: unknown }).message : undefined;
  return typeof code === 'string' && ['REQUEST_CANCELLED', 'REQUEST_DEADLINE_EXCEEDED', 'STALE_WORKER_GENERATION',
    'STALE_WORKER_REPLY', 'WORKER_SUPERVISOR_DISPOSED'].includes(code) ? code : undefined;
}

/** Sole host commit owner. Records are retained without automatic expiration, including after Undo, revision
 * changes, close and restart. Clearing extension storage ends the retry boundary; old IDs must then be abandoned.
 * Native Undo closures are session-local; durable outcomes never recreate a second native history entry. */
export class HostMutationLedger {
  private readonly flights = new Map<string, Promise<HostMutationResult>>();
  constructor(private readonly storageRoot: string, readonly documentId: string,
    private readonly baseline: () => HostMutationBaseline,
    private readonly authorizedRoots: () => readonly string[] = () => [path.dirname(documentId)]) {
    if (!path.isAbsolute(storageRoot)) throw new Error('operation storage must be absolute');
    this.documentId = canonicalHostDocumentId(documentId);
  }
  private authorizeTarget(target: HostMutationTarget): void {
    if (!target || typeof target.filePath !== 'string' || !path.isAbsolute(target.filePath)
      || !/\.(?:cs|resx|csproj|projitems)$/i.test(target.filePath)
      || target.filePath.split(/[\\/]/).some((part) => part.toLowerCase() === 'secrets')
      || ![target.beforeSha256, target.afterSha256].every((hash) => hash === null || (typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash)))) {
      throw new Error('invalid operation target');
    }
    const absolute = path.resolve(target.filePath);
    const root = this.authorizedRoots().map((candidate) => path.resolve(candidate)).find((candidate) => {
      const relative = path.relative(candidate, absolute);
      return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
    });
    if (!root) throw new Error('operation target is outside the owning project');
    // Refuse links at every existing path segment before reading any recorded target.
    for (let candidate = absolute; ; candidate = path.dirname(candidate)) {
      try { if (fs.lstatSync(candidate).isSymbolicLink()) throw new Error('operation target traverses a link'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (!path.relative(root, candidate)) break;
      if (candidate === path.dirname(candidate)) throw new Error('operation target root cannot be reached');
    }
  }
  private recordPath(operationId: string): string {
    if (!operationId || operationId.length > 256) throw new Error('invalid operation ID');
    return hostMutationRecordPath(this.storageRoot, this.documentId, operationId);
  }
  observe(operationId: string): HostMutationRecord | undefined {
    try {
      const record = JSON.parse(fs.readFileSync(this.recordPath(operationId), 'utf8')) as HostMutationRecord;
      if (record.schemaVersion !== '2.2.0' || record.documentId !== this.documentId || record.operationId !== operationId
        || !/^[a-f0-9]{64}$/.test(record.payloadFingerprint) || !/^[a-f0-9]{64}$/.test(record.beforeSourceSha256)
        || !['pending', 'committed', 'noChange', 'refused', 'recoveryRequired'].includes(record.status)
        || !Array.isArray(record.targets) || !Array.isArray(record.transactionIds)
        || (record.companionBuffers !== undefined && !Array.isArray(record.companionBuffers))
        || (record.afterSourceSha256 !== undefined && !/^[a-f0-9]{64}$/.test(record.afterSourceSha256))
        || !Number.isSafeInteger(record.commitCount) || record.commitCount < 0) throw new Error('invalid operation record');
      for (const target of [...record.targets, ...(record.companionBuffers ?? [])]) this.authorizeTarget(target);
      if (record.sourceFilePath !== undefined) this.authorizeTarget({ filePath: record.sourceFilePath,
        beforeSha256: record.beforeSourceSha256, afterSha256: record.afterSourceSha256 ?? null });
      return record;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }
  private save(record: HostMutationRecord): void {
    record.updatedAtUtc = new Date().toISOString();
    persistRecord(this.recordPath(record.operationId), record);
  }
  private reconcile(record: HostMutationRecord): HostMutationRecord {
    const actualSource = sha256Hex(this.baseline().sourceText);
    const actualTargets = record.targets.map((target) => {
      try { return sha256Hex(fs.readFileSync(target.filePath)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    });
    const before = actualSource === record.beforeSourceSha256
      && record.targets.every((target, index) => actualTargets[index] === target.beforeSha256);
    const after = !!record.afterSourceSha256 && actualSource === record.afterSourceSha256
      && record.targets.every((target, index) => actualTargets[index] === target.afterSha256);
    // A landed forward buffer/backup plus every exact journal target proves the source outcome. A baseline proves
    // absence of workspace effects, but vendor callbacks are never rerun automatically after an unknown outcome.
    const companionUnknown = !!record.companionBuffers?.length;
    const changed = record.afterSourceSha256 !== record.beforeSourceSha256
      || record.targets.some((target) => target.beforeSha256 !== target.afterSha256);
    record.status = companionUnknown ? 'recoveryRequired' : after ? changed ? 'committed' : 'noChange' : before ? 'refused' : 'recoveryRequired';
    record.commitCount = after && changed && !companionUnknown ? 1 : 0;
    record.code = companionUnknown ? 'COMPANION_BUFFER_OUTCOME_UNKNOWN' : after ? changed ? 'RECONCILED_COMMIT' : 'RECONCILED_NO_CHANGE' : before ? 'RECONCILED_BASELINE_NO_RETRY' : 'OPERATION_OUTCOME_UNKNOWN';
    this.save(record);
    return record;
  }
  /** Direct commands and test ingress also reach the same owner even if no canvas/panel intent was present. */
  commit(payload: unknown, action: () => boolean): boolean {
    if (mutationContext.getStore()?.ledger === this) return action();
    if (admissionFrozen) return false; // a rollback is being prepared: refuse before recording or applying anything
    const baseline = this.baseline();
    const now = new Date().toISOString();
    const record: HostMutationRecord = { schemaVersion: '2.2.0', documentId: this.documentId,
      operationId: `operation-${randomUUID()}`, payloadFingerprint: mutationPayloadFingerprint(payload),
      createdAtUtc: now, updatedAtUtc: now, status: 'pending', baseRevision: baseline.revision,
      beforeSourceSha256: sha256Hex(baseline.sourceText), commitCount: 0, targets: [], transactionIds: [] };
    record.sourceFilePath = baseline.sourceFilePath;
    record.externalEffectsPossible = mayHaveExternalEffects(payload);
    this.save(record);
    return mutationContext.run({ ledger: this, record }, action);
  }
  run(payload: unknown, action: () => Promise<void>, operationId = `operation-${randomUUID()}`): Promise<HostMutationResult> {
    const fingerprint = mutationPayloadFingerprint(payload);
    const existing = this.observe(operationId);
    if (existing && existing.payloadFingerprint !== fingerprint) {
      const error = Object.assign(new Error('operation ID was already used with a different payload'), { code: 'OPERATION_PAYLOAD_MISMATCH' });
      return Promise.reject(error);
    }
    const flight = this.flights.get(operationId);
    if (flight) return flight.then((established) => ({ ...established, replayed: true }));
    if (existing) return Promise.resolve(result(existing.status === 'pending' ? this.reconcile(existing) : existing, true));
    if (admissionFrozen) return Promise.reject(rollbackRefusal()); // established outcomes above may still be read
    const baseline = this.baseline();
    const now = new Date().toISOString();
    const record: HostMutationRecord = { schemaVersion: '2.2.0', documentId: this.documentId, operationId,
      payloadFingerprint: fingerprint, createdAtUtc: now, updatedAtUtc: now, status: 'pending',
      baseRevision: baseline.revision, beforeSourceSha256: sha256Hex(baseline.sourceText), commitCount: 0,
      targets: [], transactionIds: [] };
    record.sourceFilePath = baseline.sourceFilePath;
    record.externalEffectsPossible = mayHaveExternalEffects(payload);
    this.save(record);
    const pending = mutationContext.run({ ledger: this, record }, async () => {
      try {
        await action();
        if (record.status === 'pending') {
          // A staged companion buffer (a code-behind stub) whose outcome nobody settled may still hold the edit:
          // never call that "no change".
          if (record.companionBuffers?.length) { record.status = 'recoveryRequired'; record.code = 'COMPANION_BUFFER_OUTCOME_UNKNOWN'; }
          else record.status = 'noChange';
          this.save(record);
        }
        return result(record, false);
      } catch (error) {
        if (record.status === 'pending') {
          this.finishRequestFailure(error);
        }
        throw error;
      } finally { this.flights.delete(operationId); }
    });
    this.flights.set(operationId, pending);
    inFlightOperations.add(pending);
    void pending.then(() => inFlightOperations.delete(pending), () => inFlightOperations.delete(pending));
    return pending;
  }
  /** Called before any resource write, and again at the synchronous final source/Undo boundary. */
  stageCommit(afterSource: string, targets: HostMutationTarget[] = [], transactionId?: string): void {
    const scope = mutationContext.getStore();
    if (!scope || scope.ledger !== this) return;
    if (scope.record.status !== 'pending') throw new Error('operation already has an established commit outcome');
    targets.forEach((target) => this.authorizeTarget(target));
    scope.record.afterSourceSha256 = sha256Hex(afterSource);
    if (targets.length) scope.record.targets = targets;
    if (transactionId && !scope.record.transactionIds.includes(transactionId)) scope.record.transactionIds.push(transactionId);
    this.save(scope.record);
  }
  establishedCommitOutcome(): boolean | undefined {
    const scope = mutationContext.getStore();
    if (!scope || scope.ledger !== this || scope.record.status === 'pending') return undefined;
    return scope.record.status === 'committed' || scope.record.status === 'noChange';
  }
  stageCompanionBuffer(filePath: string, before: string, after: string): void {
    const scope = mutationContext.getStore();
    if (!scope || scope.ledger !== this) return;
    const target = { filePath, beforeSha256: sha256Hex(before), afterSha256: sha256Hex(after) };
    this.authorizeTarget(target);
    scope.record.companionBuffers = [target];
    this.save(scope.record);
  }
  /** The session's verdict on a staged companion buffer after the source commit did NOT establish the operation:
   * back at its before-image (the stub was compensated) → refused with no effect; anything else → recovery required.
   * Also corrects a refusal recorded before a compensation that then failed, which would otherwise read as final. */
  settleCompanion(restored: boolean): void {
    const scope = mutationContext.getStore();
    if (!scope || scope.ledger !== this || !scope.record.companionBuffers?.length) return;
    if (scope.record.status !== 'pending' && scope.record.status !== 'refused') return;
    scope.record.status = restored ? 'refused' : 'recoveryRequired';
    scope.record.code = restored ? 'COMPANION_COMPENSATED' : 'COMPANION_BUFFER_OUTCOME_UNKNOWN';
    scope.record.commitCount = 0;
    this.save(scope.record);
  }
  finishCommit(accepted: boolean, changed: boolean): void {
    const scope = mutationContext.getStore();
    if (!scope || scope.ledger !== this) return;
    scope.record.status = accepted ? changed ? 'committed' : 'noChange' : 'refused';
    scope.record.commitCount = accepted && changed ? 1 : 0;
    this.save(scope.record);
  }
  finishResourceFailure(unknown: boolean, code: string): void {
    const scope = mutationContext.getStore();
    if (!scope || scope.ledger !== this || scope.record.status !== 'pending') return;
    scope.record.status = unknown ? 'recoveryRequired' : 'refused';
    scope.record.code = code;
    this.save(scope.record);
  }
  finishRequestFailure(error: unknown): void {
    const scope = mutationContext.getStore();
    if (!scope || scope.ledger !== this || scope.record.status !== 'pending') return;
    const cancellation = knownTransportCancellationCode(error);
    if (cancellation && !scope.record.externalEffectsPossible && !scope.record.companionBuffers?.length) {
      const reconciled: HostMutationRecord = this.reconcile(scope.record);
      if (reconciled.status === 'refused' || reconciled.status === 'noChange') {
        scope.record.code = `${cancellation}_BASELINE_NO_RETRY`; this.save(scope.record);
      }
    } else this.finishResourceFailure(true, 'OPERATION_OUTCOME_UNKNOWN');
  }
}
