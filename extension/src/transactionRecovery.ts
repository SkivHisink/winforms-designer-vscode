import * as fs from 'node:fs';
import * as path from 'node:path';
import { atomicWriteLocalFile, durableDeleteLocalFile } from './atomicFile';
import { HostMutationRecord, canonicalHostDocumentId, hostMutationRecordPath } from './mutationOperation';
import { sha256Hex, stripUtf8Bom } from './documentStore';
import {
  TransactionJournalRecord,
  classifyJournalForRecovery,
  readJournalFile,
  transitionJournal,
  writeJournalFile,
} from './transactionJournal';

export type TransactionRecoveryOutcome = 'rolledBack' | 'committed' | 'discarded' | 'deferred' | 'manual' | 'corrupt';

export interface TransactionRecoveryEntry {
  journalPath: string;
  transactionId?: string;
  outcome: TransactionRecoveryOutcome;
  detail: string;
}

export interface TransactionRecoverySummary {
  entries: readonly TransactionRecoveryEntry[];
  rolledBack: number;
  committed: number;
  discarded: number;
  deferred: number;
  manual: number;
  corrupt: number;
}

export interface TransactionRecoveryOptions {
  nowUtc?: () => string;
  log?: (message: string) => void;
  /** Test seam invoked after an artifact has been restored but before the next journal transition. */
  afterRestoreTarget?: (target: string, record: TransactionJournalRecord) => void | Promise<void>;
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function resolveJournalTarget(record: TransactionJournalRecord, relativeTarget: string): string {
  if (!relativeTarget || path.isAbsolute(relativeTarget)) throw new Error(`invalid absolute/empty target: ${relativeTarget}`);
  const root = path.resolve(record.workspaceRoot);
  const target = path.resolve(root, relativeTarget);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || samePath(root, target)) {
    throw new Error(`journal target escapes workspace root: ${relativeTarget}`);
  }
  if (target.split(/[\\/]/).some((part) => part.toLowerCase() === 'secrets')
    || /^\.env(?:\.|$)/i.test(path.basename(target)) || /\.(?:pfx|key|pem)$/i.test(target)) throw new Error('secret journal target');
  for (let candidate = target; ; candidate = path.dirname(candidate)) {
    try { if (fs.lstatSync(candidate).isSymbolicLink()) throw new Error('journal target traverses a link'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (!path.relative(root, candidate)) break;
    if (candidate === path.dirname(candidate)) throw new Error('journal target root cannot be reached');
  }
  return target;
}

function decodeByteImage(value: string | null): Buffer | null {
  return value === null ? null : Buffer.from(value, 'base64');
}

async function readBytes(target: string): Promise<Buffer | null> {
  try {
    return await fs.promises.readFile(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function equalBytes(left: Uint8Array | null, right: Uint8Array | null): boolean {
  if (left === null || right === null) return left === right;
  return Buffer.from(left).equals(Buffer.from(right));
}

async function restoreBytes(target: string, bytes: Buffer | null): Promise<void> {
  if (bytes === null) {
    await durableDeleteLocalFile(target);
    return;
  }
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await atomicWriteLocalFile(target, bytes);
}

async function findJournalFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await visit(candidate);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) files.push(candidate);
    }
  };
  await visit(root);
  return files.sort((left, right) => left.localeCompare(right));
}

function recoveryRequired(record: TransactionJournalRecord, error: string, nowUtc: string): TransactionJournalRecord {
  return { ...record, state: 'recoveryRequired', error, updatedAtUtc: nowUtc };
}

async function rollbackIncompleteJournal(
  journalPath: string,
  record: TransactionJournalRecord,
  options: TransactionRecoveryOptions,
): Promise<TransactionRecoveryEntry> {
  const targets = Object.keys(record.beforeBytesBase64);
  const observations: Array<{ target: string; absolute: string; before: Buffer | null; after: Buffer | null; current: Buffer | null }> = [];
  try {
    for (const target of targets) {
      const absolute = resolveJournalTarget(record, target);
      observations.push({
        target,
        absolute,
        before: decodeByteImage(record.beforeBytesBase64[target]),
        after: decodeByteImage(record.afterBytesBase64[target]),
        current: await readBytes(absolute),
      });
    }
  } catch (error) {
    const detail = `manual recovery required: ${error instanceof Error ? error.message : String(error)}`;
    const manual = recoveryRequired(record, detail, (options.nowUtc ?? (() => new Date().toISOString()))());
    await writeJournalFile(journalPath, manual);
    return { journalPath, transactionId: record.transactionId, outcome: 'manual', detail };
  }

  const unexpected = observations.find((entry) =>
    !equalBytes(entry.current, entry.before) && !equalBytes(entry.current, entry.after));
  if (unexpected) {
    const detail = `manual recovery required: ${unexpected.target} differs from both durable before and after images`;
    const manual = recoveryRequired(record, detail, (options.nowUtc ?? (() => new Date().toISOString()))());
    await writeJournalFile(journalPath, manual);
    return { journalPath, transactionId: record.transactionId, outcome: 'manual', detail };
  }

  const now = options.nowUtc ?? (() => new Date().toISOString());
  // A resource journal can reach runner-committed immediately before its host source/Undo owner commits.
  // That acknowledged gap is recoverable, even though ordinary committed journals remain terminal.
  let rollingBack = (record.state === 'committed' && record.hostOperation?.commit === 'pending') || record.sourceReconciliationRequired
    ? { ...record, state: 'rollingBack' as const, updatedAtUtc: now() }
    : record.state === 'rollingBack'
    ? record
    : transitionJournal(record, 'rollingBack', { nowUtc: now() });
  await writeJournalFile(journalPath, rollingBack);

  try {
    for (const entry of [...observations].reverse()) {
      if (equalBytes(entry.current, entry.before)) continue;
      await restoreBytes(entry.absolute, entry.before);
      if (!equalBytes(await readBytes(entry.absolute), entry.before)) {
        throw new Error(`${entry.target} did not match its baseline after restore`);
      }
      await options.afterRestoreTarget?.(entry.absolute, rollingBack);
    }
  } catch (error) {
    const detail = `manual recovery required: rollback failed: ${error instanceof Error ? error.message : String(error)}`;
    const manual = recoveryRequired(rollingBack, detail, now());
    await writeJournalFile(journalPath, manual);
    return { journalPath, transactionId: record.transactionId, outcome: 'manual', detail };
  }

  rollingBack = transitionJournal(rollingBack, 'rolledBack', { nowUtc: now() });
  await writeJournalFile(journalPath, rollingBack);
  await durableDeleteLocalFile(journalPath);
  return {
    journalPath,
    transactionId: record.transactionId,
    outcome: 'rolledBack',
    detail: `restored ${targets.length} transaction target(s) to their durable baseline`,
  };
}

const MAX_SOURCE_RECEIPTS = 4096;
const isHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function validSourceReceipt(value: unknown, documentId: string): value is HostMutationRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as HostMutationRecord;
  return record.schemaVersion === '2.2.0' && typeof record.documentId === 'string'
    && canonicalHostDocumentId(record.documentId) === canonicalHostDocumentId(documentId)
    && typeof record.operationId === 'string' && isHash(record.payloadFingerprint)
    && isHash(record.beforeSourceSha256) && isHash(record.afterSourceSha256)
    && Number.isSafeInteger(record.baseRevision) && record.baseRevision >= 0
    && typeof record.createdAtUtc === 'string' && Number.isFinite(Date.parse(record.createdAtUtc))
    && ['committed', 'noChange', 'pending', 'recoveryRequired'].includes(record.status)
    && Array.isArray(record.targets) && record.targets.every((target) => target && typeof target.filePath === 'string'
      && path.isAbsolute(target.filePath) && [target.beforeSha256, target.afterSha256].every((hash) => hash === null || isHash(hash)));
}
async function sourceReceipts(storage: string, documentId: string): Promise<HostMutationRecord[]> {
  const directory = path.dirname(hostMutationRecordPath(storage, documentId, 'unused'));
  let files: fs.Dirent[];
  try { files = await fs.promises.readdir(directory, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  if (files.length > MAX_SOURCE_RECEIPTS) throw new Error('source receipt reconciliation exceeds its bounded record limit');
  for (let candidate = directory; ; candidate = path.dirname(candidate)) {
    if ((await fs.promises.lstat(candidate)).isSymbolicLink()) throw new Error('source receipt directory traverses a link');
    if (!path.relative(path.resolve(storage), candidate)) break;
    if (candidate === path.dirname(candidate)) throw new Error('source receipt storage root cannot be reached');
  }
  const records: HostMutationRecord[] = [];
  let receiptBytes = 0; const deadline = Date.now() + 1000;
  for (const file of files) {
    if (!file.isFile() || !/^[a-f0-9]{64}\.json$/.test(file.name)) continue;
    const receiptPath = path.join(directory, file.name);
    const stat = await fs.promises.lstat(receiptPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('source receipt file is a link or not a regular file');
    const size = stat.size; receiptBytes += size;
    if (size > 1024 * 1024 || receiptBytes > 16 * 1024 * 1024 || Date.now() > deadline) throw new Error('source receipt exceeds its bounded byte/time limit');
    const value: unknown = JSON.parse(await fs.promises.readFile(receiptPath, 'utf8'));
    if (validSourceReceipt(value, documentId)) records.push(value);
  }
  return records.sort((left, right) => left.createdAtUtc.localeCompare(right.createdAtUtc)
    || left.baseRevision - right.baseRevision);
}
function sourceChain(from: string, to: string, receipts: readonly HostMutationRecord[], origin?: HostMutationRecord): HostMutationRecord[] | undefined {
  let hash = from; let createdAt = origin?.createdAtUtc ?? '';
  const chain: HostMutationRecord[] = [];
  const used = new Set<string>(origin ? [origin.operationId] : []);
  const targetHashes = new Map<string, string | null>(origin?.targets.map((target) => [
    process.platform === 'win32' ? path.resolve(target.filePath).toLowerCase() : path.resolve(target.filePath), target.afterSha256]));
  let established = from === to ? [] as HostMutationRecord[] : undefined;
  // Revisions reset on reopen. Durable timestamp order and exact source/resource adjacency prove successors.
  // Equal-source resource edits are included; tied timestamps are resolved by their causal target hashes.
  for (let step = 0; step < receipts.length; step++) {
    const receipt = receipts.find((item) => item.status === 'committed' && item.commitCount === 1
      && !item.companionBuffers?.length && !used.has(item.operationId) && item.createdAtUtc >= createdAt
      && item.beforeSourceSha256 === hash && item.targets.every((target) => {
        const key = process.platform === 'win32' ? path.resolve(target.filePath).toLowerCase() : path.resolve(target.filePath);
        return !targetHashes.has(key) || targetHashes.get(key) === target.beforeSha256;
      }));
    if (!receipt) break;
    used.add(receipt.operationId); chain.push(receipt); hash = receipt.afterSourceSha256!; createdAt = receipt.createdAtUtc;
    for (const target of receipt.targets) targetHashes.set(process.platform === 'win32'
      ? path.resolve(target.filePath).toLowerCase() : path.resolve(target.filePath), target.afterSha256);
    if (hash === to) established = [...chain];
  }
  return established;
}
async function proveResources(record: TransactionJournalRecord, successors: readonly HostMutationRecord[]): Promise<void> {
  for (const [target, image] of Object.entries(record.afterBytesBase64)) {
    const absolute = resolveJournalTarget(record, target);
    const after = decodeByteImage(image);
    let expected = after === null ? null : sha256Hex(after);
    for (const successor of successors) {
      const update = successor.targets.find((item) => samePath(path.resolve(item.filePath), absolute));
      if (!update) continue;
      if (update.beforeSha256 !== expected) throw new Error(`${target} has an unproven resource supersession gap`);
      expected = update.afterSha256;
    }
    const bytes = await readBytes(absolute);
    if ((bytes === null ? null : sha256Hex(bytes)) !== expected) throw new Error(`${target} differs from the restored source's established resource image`);
  }
}
async function diskSourceHash(record: TransactionJournalRecord, outcome: HostMutationRecord): Promise<string | undefined> {
  if (typeof outcome.sourceFilePath !== 'string') return undefined;
  const source = resolveJournalTarget(record, path.relative(record.workspaceRoot, outcome.sourceFilePath));
  if (!/\.cs$/i.test(source) || /(?:^|[\\/])secrets(?:[\\/]|$)/i.test(source)) throw new Error('invalid host source target');
  const disk = await readBytes(source);
  return disk === null ? undefined : sha256Hex(stripUtf8Bom(disk).text);
}
async function readHostOutcome(storage: string, documentId: string, operationId: string): Promise<unknown> {
  const receiptPath = hostMutationRecordPath(storage, documentId, operationId);
  for (let candidate = receiptPath; ; candidate = path.dirname(candidate)) {
    const stat = await fs.promises.lstat(candidate);
    if (stat.isSymbolicLink()) throw new Error('host outcome path traverses a link');
    if (candidate === receiptPath && (!stat.isFile() || stat.size > 1024 * 1024)) throw new Error('host outcome exceeds regular-file/byte bounds');
    if (!path.relative(path.resolve(storage), candidate)) break;
    if (candidate === path.dirname(candidate)) throw new Error('host outcome storage root cannot be reached');
  }
  return JSON.parse(await fs.promises.readFile(receiptPath, 'utf8'));
}
async function matchingOutcome(storage: string, record: TransactionJournalRecord): Promise<HostMutationRecord> {
  const identity = record.hostOperation!;
  const value = await readHostOutcome(storage, identity.documentId, identity.operationId);
  if (!validSourceReceipt(value, identity.documentId) || value.operationId !== identity.operationId
    || value.payloadFingerprint !== identity.payloadFingerprint || value.companionBuffers?.length
    || (value.externalEffectsPossible && value.status !== 'committed')) throw new Error('host source outcome is unverifiable');
  if (value.status === 'noChange' && (value.commitCount !== 0 || value.beforeSourceSha256 !== value.afterSourceSha256
    || value.targets.some((target) => target.beforeSha256 !== target.afterSha256))) throw new Error('no-change host outcome includes changed images');
  return value;
}
async function retainHostCommit(storage: string, journalPath: string, record: TransactionJournalRecord, outcome: HostMutationRecord,
  successors: readonly HostMutationRecord[]): Promise<TransactionRecoveryEntry> {
  await proveResources(record, successors);
  await writeJournalFile(journalPath, { ...record, state: 'committed', sourceReconciliationRequired: false,
    hostOperation: { ...record.hostOperation!, commit: 'committed' } });
  await durableDeleteLocalFile(journalPath);
  if (outcome.status !== 'committed' && outcome.status !== 'noChange') await atomicWriteLocalFile(
    hostMutationRecordPath(storage, outcome.documentId, outcome.operationId), Buffer.from(JSON.stringify({ ...outcome,
      status: 'committed', commitCount: 1, code: 'RECONCILED_RESTORED_SOURCE_COMMIT', updatedAtUtc: new Date().toISOString() }) + '\n'));
  return { journalPath, transactionId: record.transactionId, outcome: 'committed',
    detail: 'actual source image, established source successors and exact resource images confirm the commit' };
}
async function deferSource(journalPath: string, record: TransactionJournalRecord): Promise<TransactionRecoveryEntry> {
  const detail = 'host source reconciliation deferred until the designer opens its actual VS Code backup or disk buffer';
  await writeJournalFile(journalPath, { ...recoveryRequired(record, detail, new Date().toISOString()), sourceReconciliationRequired: true });
  return { journalPath, transactionId: record.transactionId, outcome: 'deferred', detail };
}
async function recoverJournal(journalPath: string, options: TransactionRecoveryOptions, storage: string): Promise<TransactionRecoveryEntry> {
  let record: TransactionJournalRecord;
  try {
    const parsed = await readJournalFile(journalPath);
    if (!parsed) return { journalPath, outcome: 'discarded', detail: 'journal disappeared before recovery' };
    record = parsed;
  } catch (error) { return { journalPath, outcome: 'corrupt', detail: `journal retained because it is invalid: ${String(error)}` }; }
  if ((record.state === 'committed' || record.sourceReconciliationRequired) && record.hostOperation) {
    try {
      const outcome = await matchingOutcome(storage, record);
      // Even a matching saved source can coexist with an older VS Code hot-exit backup. Changed-source
      // journals remain durable until openCustomDocument chooses and reads the actual restored image.
      if (outcome.beforeSourceSha256 !== outcome.afterSourceSha256) {
        await diskSourceHash(record, outcome); // validate the authorized source witness path without inferring survival
        return deferSource(journalPath, record);
      }
      const actual = await diskSourceHash(record, outcome);
      const receipts = await sourceReceipts(storage, outcome.documentId);
      const successors = actual === undefined ? undefined : sourceChain(outcome.afterSourceSha256!, actual, receipts, outcome);
      if (successors !== undefined) return await retainHostCommit(storage, journalPath, record, outcome, successors);
      return deferSource(journalPath, record);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && record.hostOperation.commit === 'pending') return rollbackIncompleteJournal(journalPath, record, options);
      const detail = `manual recovery required: host commit reconciliation failed: ${error instanceof Error ? error.message : String(error)}`;
      await writeJournalFile(journalPath, recoveryRequired(record, detail, new Date().toISOString()));
      return { journalPath, transactionId: record.transactionId, outcome: 'manual', detail };
    }
  }
  const classification = classifyJournalForRecovery(record);
  if (classification === 'manualResolution') return { journalPath, transactionId: record.transactionId, outcome: 'manual', detail: record.error ?? 'manual recovery required' };
  if (classification === 'terminal' && record.state === 'committed') {
    await durableDeleteLocalFile(journalPath);
    return { journalPath, transactionId: record.transactionId, outcome: 'committed', detail: 'durable commit retained; terminal journal removed' };
  }
  if (classification === 'clean' || classification === 'terminal') {
    await durableDeleteLocalFile(journalPath);
    return { journalPath, transactionId: record.transactionId, outcome: 'discarded', detail: `terminal/pre-write ${record.state} journal removed` };
  }
  return rollbackIncompleteJournal(journalPath, record, options);
}

/** VS Code's actual restored source is the witness. Retained operation receipts compose only already-established
 * forward edits; they do not reconstruct general history or infer survival from native Undo registration. */
export async function reconcileRestoredDocumentTransactions(storage: string, documentId: string,
  restoredSourceText: string): Promise<{ entries: readonly TransactionRecoveryEntry[]; requiresManual: boolean }> {
  const entries: TransactionRecoveryEntry[] = [];
  const sourceHash = sha256Hex(restoredSourceText);
  const journals: Array<{ journalPath: string; record: TransactionJournalRecord }> = [];
  for (const journalPath of await findJournalFiles(path.join(storage, 'v2-transactions'))) {
    try {
      const record = await readJournalFile(journalPath);
      if (record?.hostOperation && canonicalHostDocumentId(record.hostOperation.documentId) === canonicalHostDocumentId(documentId)) journals.push({ journalPath, record });
    } catch { /* Startup has already reported corrupt journals and retained their bytes. */ }
  }
  // A stale backup predating successive resource edits needs exact compensation in reverse commit order.
  let receipts: HostMutationRecord[];
  try { receipts = await sourceReceipts(storage, documentId); }
  catch (error) { return { entries: [{ journalPath: '', outcome: 'manual', detail: String(error) }], requiresManual: true }; }
  journals.sort((left, right) => right.record.createdAtUtc.localeCompare(left.record.createdAtUtc)
    || (receipts.find((item) => item.operationId === right.record.hostOperation?.operationId)?.baseRevision ?? 0)
      - (receipts.find((item) => item.operationId === left.record.hostOperation?.operationId)?.baseRevision ?? 0));
  for (const { journalPath, record } of journals) {
    if (!record.sourceReconciliationRequired) {
      if (record.state === 'recoveryRequired') entries.push({ journalPath, transactionId: record.transactionId,
        outcome: 'manual', detail: record.error ?? 'host transaction requires manual recovery' });
      continue;
    }
    try {
      const outcome = await matchingOutcome(storage, record);
      const successors = sourceChain(outcome.afterSourceSha256!, sourceHash, receipts, outcome);
      if (successors !== undefined) entries.push(await retainHostCommit(storage, journalPath, record, outcome, successors));
      else if (sourceChain(sourceHash, outcome.beforeSourceSha256, receipts) !== undefined) {
        // A stale dirty backup can coexist with already-saved forward source. Removing its resources would break
        // that saved baseline and native recovered Undo. Compensation requires both actual buffer and disk proof.
        const diskHash = await diskSourceHash(record, outcome);
        if (diskHash === undefined || sourceChain(diskHash, outcome.beforeSourceSha256, receipts) === undefined) {
          throw new Error('saved source baseline does not confirm resource compensation for the restored buffer');
        }
        const rollback = await rollbackIncompleteJournal(journalPath, record, {}); entries.push(rollback);
        // Native Redo journals share an existing committed receipt. Compensation must not change that receipt.
        if (rollback.outcome === 'rolledBack' && outcome.status !== 'committed') await atomicWriteLocalFile(
          hostMutationRecordPath(storage, outcome.documentId, outcome.operationId), Buffer.from(JSON.stringify({ ...outcome,
            status: 'refused', commitCount: 0, code: 'RESTORED_SOURCE_BASELINE_NO_RETRY', updatedAtUtc: new Date().toISOString() }) + '\n'));
      } else throw new Error('actual restored source has no established path to either operation image');
    } catch (error) {
      const detail = `manual recovery required: restored source reconciliation failed: ${error instanceof Error ? error.message : String(error)}`;
      await writeJournalFile(journalPath, { ...recoveryRequired(record, detail, new Date().toISOString()), sourceReconciliationRequired: true });
      entries.push({ journalPath, transactionId: record.transactionId, outcome: 'manual', detail });
    }
  }
  return { entries, requiresManual: entries.some((entry) => entry.outcome === 'manual' || entry.outcome === 'corrupt') };
}

/** Recover every v2 transaction before designer providers can open documents. Invalid/conflicting journals stay put. */
export async function recoverPendingTransactions(
  globalStoragePath: string,
  options: TransactionRecoveryOptions = {},
): Promise<TransactionRecoverySummary> {
  if (!path.isAbsolute(globalStoragePath)) throw new Error('globalStoragePath must be absolute');
  const journalFiles = await findJournalFiles(path.join(globalStoragePath, 'v2-transactions'));
  const entries: TransactionRecoveryEntry[] = [];
  for (const journalPath of journalFiles) {
    let entry: TransactionRecoveryEntry;
    try {
      entry = await recoverJournal(journalPath, options, globalStoragePath);
    } catch (error) {
      entry = {
        journalPath,
        outcome: 'manual',
        detail: `journal retained because startup recovery failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    entries.push(entry);
    options.log?.(`[transaction recovery] ${entry.outcome}: ${entry.detail}; journal=${entry.journalPath}`);
  }
  const count = (outcome: TransactionRecoveryOutcome): number => entries.filter((entry) => entry.outcome === outcome).length;
  return {
    entries,
    rolledBack: count('rolledBack'),
    committed: count('committed'),
    discarded: count('discarded'),
    deferred: count('deferred'),
    manual: count('manual'),
    corrupt: count('corrupt'),
  };
}
