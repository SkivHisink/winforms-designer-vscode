import * as fs from 'node:fs';
import * as path from 'node:path';
import { classifyJournalForRecovery, readJournalFile } from './transactionJournal';
import type { HostMutationRecord } from './mutationOperation';

/**
 * Preparing a rollback or downgrade (roadmap 2.2.0, "Откат"): stop admitting new work, let running operations
 * finish, refuse while any durable outcome is undecided, release worker ownership, and only then let the user restart
 * the Extension Host on the previous version. Dirty documents are never closed or discarded here — their unsaved
 * images stay in VS Code's own backups, which the previous version restores.
 *
 * The order matters: workers are stopped only after admission is frozen, so a concurrent request cannot start a
 * replacement process, and only after the journals are proven terminal, so no second commit owner can appear.
 */

export type RollbackBlockerKind = 'operationsRunning' | 'operationPending' | 'operationUnresolved' | 'journal'
  | 'inspectionIncomplete' | 'workersRunning' | 'unsavedAutoSave' | 'invalidated';

export interface RollbackBlocker {
  kind: RollbackBlockerKind;
  /** Stable, non-sensitive identity: an operation ID or a journal transaction ID — never a path or source text. */
  id: string;
  detail: string;
}

export interface RollbackPreparationResult {
  ready: boolean;
  /** Conditions that stopped the preparation (empty when ready). */
  blockers: RollbackBlocker[];
  /** Undecided operation outcomes the user explicitly accepted before the switch. */
  acknowledged: RollbackBlocker[];
  stoppedWorkers: number;
}

export interface RollbackPreparationHooks {
  storageRoot: string;
  /** Whether admission is already frozen — by an earlier successful preparation that this call must not undo. */
  isFrozen(): boolean;
  freeze(): void;
  thaw(): void;
  settleInFlight(timeoutMs: number): Promise<boolean>;
  /** Advances when a step that cannot be refused (native Undo/Redo, Revert) cancelled the freeze. */
  invalidationEpoch?(): number;
  /** Open files with unsaved changes that auto-save would write after the switch was certified. */
  unsavedAutoSaveTargets?(): number;
  /** Stop every worker; `survivors` counts processes whose exit could not be confirmed. */
  stopWorkers(): Promise<{ stopped: number; survivors: number }>;
  /** Asked only for operations whose outcome is recorded as undecided; false keeps the current version running. */
  confirmUnresolved(items: readonly RollbackBlocker[]): Promise<boolean>;
}

export const ROLLBACK_SETTLE_TIMEOUT_MS = 30_000;
const MAX_RECORDS = 10_000;

/** Every record file below `root`, or `truncated` when there are more than the bound: an unread record could be the
 * undecided one, so a partial enumeration must never certify the switch. */
function jsonFiles(root: string, maxRecords: number): { files: string[]; truncated: boolean } {
  const files: string[] = [];
  let directories: fs.Dirent[];
  try { directories = fs.readdirSync(root, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { files, truncated: false }; throw error; }
  for (const directory of directories) {
    if (!directory.isDirectory()) continue;
    for (const entry of fs.readdirSync(path.join(root, directory.name), { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      if (files.length >= maxRecords) return { files, truncated: true };
      files.push(path.join(root, directory.name, entry.name));
    }
  }
  return { files, truncated: false };
}

/** Read the durable operation ledger and transaction journals. `blockers` must be resolved before any switch;
 * `unresolved` (recorded as needing a human decision) may proceed only with explicit consent. */
export async function inspectDurableStateForRollback(storageRoot: string, maxRecords = MAX_RECORDS): Promise<{ blockers: RollbackBlocker[]; unresolved: RollbackBlocker[] }> {
  const blockers: RollbackBlocker[] = [];
  const unresolved: RollbackBlocker[] = [];
  const operations = jsonFiles(path.join(storageRoot, 'v2-operations'), maxRecords);
  if (operations.truncated) blockers.push({ kind: 'inspectionIncomplete', id: 'v2-operations', detail: `more than ${maxRecords} operation records` });
  for (const file of operations.files) {
    let record: Partial<HostMutationRecord>;
    try { record = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<HostMutationRecord>; }
    catch { blockers.push({ kind: 'operationPending', id: path.basename(file, '.json'), detail: 'unreadable operation record' }); continue; }
    if (record.schemaVersion !== '2.2.0') continue;
    const id = String(record.operationId ?? path.basename(file, '.json'));
    if (record.status === 'pending') blockers.push({ kind: 'operationPending', id, detail: 'an operation was interrupted before its outcome was recorded' });
    else if (record.status === 'recoveryRequired') unresolved.push({ kind: 'operationUnresolved', id, detail: String(record.code ?? 'OPERATION_OUTCOME_UNKNOWN') });
  }
  const journals = jsonFiles(path.join(storageRoot, 'v2-transactions'), maxRecords);
  if (journals.truncated) blockers.push({ kind: 'inspectionIncomplete', id: 'v2-transactions', detail: `more than ${maxRecords} transaction journals` });
  for (const file of journals.files) {
    let classification: ReturnType<typeof classifyJournalForRecovery>;
    let id = path.basename(file, '.json');
    try {
      // A journal written under another schema belongs to a different product version: neither this version nor the
      // rollback target interprets it, recovery preserves its bytes, so it cannot block the switch (as with operations).
      const raw = JSON.parse(await fs.promises.readFile(file, 'utf8')) as { schemaVersion?: unknown } | null;
      if (raw && typeof raw === 'object' && typeof raw.schemaVersion === 'string' && raw.schemaVersion !== '2.0.0') continue;
      const record = await readJournalFile(file);
      if (record?.transactionId) id = record.transactionId;
      classification = classifyJournalForRecovery(record);
    } catch { classification = 'corrupt'; }
    if (classification !== 'clean' && classification !== 'terminal') {
      blockers.push({ kind: 'journal', id, detail: `transaction journal requires ${classification}` });
    }
  }
  return { blockers, unresolved };
}

let preparing = false;

export async function prepareRollback(hooks: RollbackPreparationHooks): Promise<RollbackPreparationResult> {
  // One preparation at a time: a concurrent refusal must not thaw the freeze another preparation is relying on.
  if (preparing) {
    return { ready: false, blockers: [{ kind: 'operationsRunning', id: 'preparation', detail: 'a rollback preparation is already running' }],
      acknowledged: [], stoppedWorkers: 0 };
  }
  preparing = true;
  // A freeze left by an earlier successful preparation belongs to that preparation (until the user resumes).
  const ownsFreeze = !hooks.isFrozen();
  hooks.freeze();
  const epoch = hooks.invalidationEpoch?.();
  const refuse = (blockers: RollbackBlocker[], stoppedWorkers = 0): RollbackPreparationResult => {
    if (ownsFreeze) hooks.thaw(); // nothing was switched: the user keeps working on the current version
    return { ready: false, blockers, acknowledged: [], stoppedWorkers };
  };
  try {
    if (!await hooks.settleInFlight(ROLLBACK_SETTLE_TIMEOUT_MS)) {
      return refuse([{ kind: 'operationsRunning', id: 'in-flight', detail: 'designer operations are still running' }]);
    }
    const autoSaves = hooks.unsavedAutoSaveTargets?.() ?? 0;
    if (autoSaves > 0) {
      return refuse([{ kind: 'unsavedAutoSave', id: 'documents',
        detail: `${autoSaves} open file(s) with unsaved changes would be auto-saved; save or revert them first` }]);
    }
    const { blockers, unresolved } = await inspectDurableStateForRollback(hooks.storageRoot);
    if (blockers.length) return refuse(blockers);
    if (unresolved.length && !await hooks.confirmUnresolved(unresolved)) return refuse(unresolved);
    // Still frozen: no request can start a replacement worker between this stop and the Extension Host restart.
    const { stopped, survivors } = await hooks.stopWorkers();
    if (survivors > 0) {
      return refuse([{ kind: 'workersRunning', id: 'workers', detail: `${survivors} worker process(es) did not confirm exit` }], stopped);
    }
    // Files can become dirty while the steps above were awaited (a restored backup, an edit in a text editor).
    const lateAutoSaves = hooks.unsavedAutoSaveTargets?.() ?? 0;
    if (lateAutoSaves > 0) {
      return refuse([{ kind: 'unsavedAutoSave', id: 'documents',
        detail: `${lateAutoSaves} open file(s) with unsaved changes would be auto-saved; save or revert them first` }], stopped);
    }
    if (hooks.invalidationEpoch?.() !== epoch) {
      return refuse([{ kind: 'invalidated', id: 'history', detail: 'a form changed while the rollback was being prepared' }], stopped);
    }
    return { ready: true, blockers: [], acknowledged: unresolved, stoppedWorkers: stopped };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return refuse([{ kind: 'inspectionIncomplete', id: 'storage', detail: `durable state could not be inspected${code ? ` (${code})` : ''}` }]);
  } finally {
    preparing = false;
  }
}
