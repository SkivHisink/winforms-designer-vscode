import * as fs from 'node:fs';
import * as path from 'node:path';
import { atomicWriteLocalFile, durableDeleteLocalFile } from './atomicFile';
import {
  TransactionJournalRecord,
  classifyJournalForRecovery,
  readJournalFile,
  transitionJournal,
  writeJournalFile,
} from './transactionJournal';

export type TransactionRecoveryOutcome = 'rolledBack' | 'committed' | 'discarded' | 'manual' | 'corrupt';

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
  let rollingBack = record.state === 'rollingBack'
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

async function recoverJournal(
  journalPath: string,
  options: TransactionRecoveryOptions,
): Promise<TransactionRecoveryEntry> {
  let record: TransactionJournalRecord;
  try {
    const parsed = await readJournalFile(journalPath);
    if (!parsed) return { journalPath, outcome: 'discarded', detail: 'journal disappeared before recovery' };
    record = parsed;
  } catch (error) {
    return {
      journalPath,
      outcome: 'corrupt',
      detail: `journal retained because it is invalid: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const classification = classifyJournalForRecovery(record);
  if (classification === 'manualResolution') {
    return { journalPath, transactionId: record.transactionId, outcome: 'manual', detail: record.error ?? 'manual recovery required' };
  }
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
      entry = await recoverJournal(journalPath, options);
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
    manual: count('manual'),
    corrupt: count('corrupt'),
  };
}
