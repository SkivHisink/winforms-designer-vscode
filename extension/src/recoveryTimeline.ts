import * as fs from 'node:fs';
import * as path from 'node:path';
import { sha256Hex } from './documentStore';
import { canonicalHostDocumentId } from './mutationOperation';
import { readJournalFile } from './transactionJournal';

/** Deliberately excludes source images, raw errors, payloads and private workspace roots. */
export interface RecoveryTimelineEntry {
  id: string;
  timeUtc: string;
  state: string;
  affectedFiles: string[];
  restorePoint: boolean;
  failure: boolean;
}

const MAX_RECORDS = 4096;
const safeTime = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));

async function jsonFiles(directory: string, descend: boolean): Promise<string[]> {
  let entries: fs.Dirent[];
  try { entries = await fs.promises.readdir(directory, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  if (entries.length > MAX_RECORDS) throw new Error('recovery timeline record limit exceeded');
  const result: string[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const candidate = path.join(directory, entry.name);
    if (entry.isFile() && entry.name.endsWith('.json')) result.push(candidate);
    else if (descend && entry.isDirectory()) result.push(...await jsonFiles(candidate, false));
    if (result.length > MAX_RECORDS) throw new Error('recovery timeline record limit exceeded');
  }
  return result;
}

/** A bounded, read-only projection. Recovery decisions continue to use validated byte images in their own module. */
export async function readRecoveryTimeline(storageRoot: string, documentId: string,
  sourceFile: string | null): Promise<RecoveryTimelineEntry[]> {
  const identity = canonicalHostDocumentId(documentId);
  const entries = new Map<string, RecoveryTimelineEntry>();
  const receipts = await jsonFiles(path.join(storageRoot, 'v2-operations', sha256Hex(identity)), false);
  for (const file of receipts) {
    try {
      const record = JSON.parse(await fs.promises.readFile(file, 'utf8')) as Record<string, unknown>;
      if (record.schemaVersion !== '2.2.0' || typeof record.documentId !== 'string'
        || canonicalHostDocumentId(record.documentId) !== identity || typeof record.operationId !== 'string'
        || !safeTime(record.updatedAtUtc) || !['pending', 'committed', 'noChange', 'refused', 'recoveryRequired'].includes(String(record.status))) continue;
      const names = Array.isArray(record.targets) ? record.targets.flatMap((target) =>
        target && typeof target.filePath === 'string' && path.isAbsolute(target.filePath) ? [path.basename(target.filePath)] : []) : [];
      entries.set(record.operationId, { id: record.operationId, timeUtc: record.updatedAtUtc,
        state: String(record.status), affectedFiles: [...new Set(names)], restorePoint: false,
        failure: record.status === 'refused' || record.status === 'recoveryRequired' });
    } catch { /* Invalid records never become an instruction or a source-bearing error in the UI. */ }
  }
  for (const file of await jsonFiles(path.join(storageRoot, 'v2-transactions'), true)) {
    try {
      const record = await readJournalFile(file);
      if (!record || !safeTime(record.updatedAtUtc)) continue;
      const targets = Object.keys(record.beforeBytesBase64);
      const ownsSource = sourceFile && targets.some((target) => canonicalHostDocumentId(path.resolve(record.workspaceRoot, target))
        === canonicalHostDocumentId(sourceFile));
      if ((!record.hostOperation || canonicalHostDocumentId(record.hostOperation.documentId) !== identity) && !ownsSource) continue;
      const id = record.hostOperation?.operationId ?? record.transactionId;
      entries.set(id, { id, timeUtc: record.updatedAtUtc, state: record.state,
        affectedFiles: targets.map((target) => path.basename(target)),
        restorePoint: targets.length > 0, failure: record.state === 'recoveryRequired' || !!record.error });
    } catch { /* Startup recovery retains and reports corrupt journals separately. */ }
  }
  return [...entries.values()].sort((left, right) => right.timeUtc.localeCompare(left.timeUtc)).slice(0, 20);
}
