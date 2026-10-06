import type { ToolboxCandidate, ToolboxItemInfo } from './engineClient';

/** The actual VS Code memento contract, kept independent of the extension host for focused tests. */
export interface DesignerStateMemento {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

export const TOOLBOX_CURATION_KEYS = [
  'chosenToolboxItems', 'hiddenToolboxFqns', 'toolboxUiState', 'browsedToolboxAssemblies',
] as const;
export const DISPOSABLE_DESIGNER_CACHE_KEYS = ['toolboxScanCache'] as const;
export const DESIGNER_CONFIGURATION_KEYS = [
  'winformsDesigner.autoOpenDesigner', 'winformsDesigner.assemblyPath', 'winformsDesigner.layoutMode',
  'winformsDesigner.gridSize', 'winformsDesigner.showGrid', 'winformsDesigner.placementSnapOverrideModifier',
  'winformsDesigner.toolbox.autoDiscoverProjectControls', 'winformsDesigner.toolbox.runtimeFilter',
  'winformsDesigner.net48.probeDirectories', 'winformsDesigner.net48.releaseOnFocusLoss',
  'winformsDesigner.deleteFormSiblings', 'winformsDesigner.net48.isolateRenderWindows',
  'winformsDesigner.net48.releaseOnExternalBuild', 'winformsDesigner.language',
  'winformsDesigner.workers.maximumResidentProcesses',
] as const;

export interface PersistedDesignerStateDescriptor {
  key: string;
  storage: 'configuration' | 'workspaceMemento' | 'globalMemento' | 'globalStorage' | 'workspaceStorage' | 'hostBackup';
  legacyStorage?: 'globalMemento';
  category: 'settings' | 'viewState' | 'disposableCache' | 'unsavedRecovery';
  producer: string;
  consumer: string;
  format: string;
  lifecycle: string;
}

/** Inventory of shipped state, not a new persisted schema. Recovery data is never a cache-clear target. */
export const PERSISTED_DESIGNER_STATE_INVENTORY: readonly PersistedDesignerStateDescriptor[] = [
  {
    key: 'winformsDesigner.*', storage: 'configuration', category: 'settings',
    producer: 'extension/package.json configuration and VS Code Settings',
    consumer: 'extension.ts, designerEditor.ts, i18n/index.ts', format: 'VS Code configuration; existing per-setting types',
    lifecycle: 'User/workspace settings remain owned by VS Code; no 2.1 format migration.',
  },
  ...TOOLBOX_CURATION_KEYS.map((key): PersistedDesignerStateDescriptor => ({
    key, storage: 'workspaceMemento', legacyStorage: 'globalMemento', category: 'settings',
    producer: 'DesignerHub.setToolboxCustomization/setToolboxUi/addBrowsedToolboxAssembly',
    consumer: 'DesignerHub.initState', format: 'Existing unversioned JSON array/object',
    lifecycle: 'Seed absent workspace values from legacy global state; preserve global originals for downgrade.',
  })),
  {
    key: 'toolboxScanCache', storage: 'globalMemento', category: 'disposableCache',
    producer: 'DesignerHub.storeToolboxScan', consumer: 'DesignerHub.cachedToolboxScan',
    format: 'Path -> { stamp, items, error? }; unversioned',
    lifecycle: 'At most 256 assemblies/2048 rows per assembly; file/probe stamp invalidation; safe to rebuild.',
  },
  {
    key: 'designerViewStates', storage: 'workspaceMemento', category: 'viewState',
    producer: 'DesignerHub.updateFormViewState', consumer: 'DesignerHub.formViewState',
    format: 'Form path -> canvas/panel/localizationCulture; unversioned',
    lifecycle: 'At most 256 forms; zoom, locks, selected tabs, panel and culture survive cache clear.',
  },
  {
    key: 'controlSources', storage: 'workspaceMemento', category: 'settings',
    producer: 'extension.ts setControlSource', consumer: 'extension.ts controlSourceMap/getControlSource',
    format: 'Form path -> assembly path; unversioned',
    lifecycle: 'Explicit per-form assembly overrides survive reload and cache clear.',
  },
  {
    key: 'v2-transactions/<workspace-hash>/*.json', storage: 'globalStorage', category: 'unsavedRecovery',
    producer: 'transactionJournal.writeJournalFile', consumer: 'transactionRecovery.recoverPendingTransactions',
    format: 'TransactionJournalRecord schemaVersion 2.0.0',
    lifecycle: 'Durable before/after images; startup recovery removes terminal records and retains invalid/conflicting records.',
  },
  {
    key: 'v2-operations/<document-hash>/*.json', storage: 'globalStorage', category: 'unsavedRecovery',
    producer: 'HostMutationLedger.run', consumer: 'HostMutationLedger and transactionRecovery',
    format: 'HostMutationRecord schemaVersion 2.2.0; stable operation identity and host commit outcome',
    lifecycle: 'No automatic expiry through revision, Undo, close or restart; clearing extension storage ends the retry boundary.',
  },
  {
    key: 'hot-exit-recovery-v1.json', storage: 'workspaceStorage', category: 'unsavedRecovery',
    producer: 'WinFormsDesignerProvider.persistHotExitBackup', consumer: 'WinFormsDesignerProvider.takeHotExitBackup',
    format: '{ version: 1, entries: { documentKey: { documentUri, backupId } } }',
    lifecycle: 'Fallback index of dirty designer backups; consumed on reopen or removed when the owning backup is deleted.',
  },
  {
    key: 'CustomDocumentBackupContext.destination', storage: 'hostBackup', category: 'unsavedRecovery',
    producer: 'WinFormsDesignDocument.backup', consumer: 'WinFormsDesignerProvider.openCustomDocument',
    format: 'Exact generated-source bytes, including original UTF-8 BOM; no JSON envelope',
    lifecycle: 'Owned by VS Code CustomDocument backup lifecycle; preserves unsaved source across host restarts.',
  },
];

export interface ToolboxScanCacheEntry {
  stamp: string;
  items: ToolboxCandidate[];
  error?: string;
}
export type ToolboxScanCache = Record<string, ToolboxScanCacheEntry>;

export interface DesignerStateIssue {
  key: string;
  scope: 'global' | 'workspace';
  reason: 'invalid-state' | 'migration-write-failed';
}

export interface PersistedDesignerState {
  chosenItems: ToolboxItemInfo[];
  hiddenFqns: string[];
  toolboxUi: unknown;
  browsedAssemblies: string[];
  scanCache: ToolboxScanCache;
  migration: {
    migratedKeys: string[];
    retainedKeys: string[];
    issues: DesignerStateIssue[];
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === 'string';
}

function optional(value: unknown, guard: (item: unknown) => boolean): boolean {
  return value === undefined || guard(value);
}

function toolboxItem(value: unknown): value is ToolboxItemInfo {
  return record(value) && text(value.name) && !!value.name && text(value.fqn) && !!value.fqn
    && text(value.category) && typeof value.fromProject === 'boolean'
    && optional(value.assemblyPath, text)
    && optional(value.iconPng, (item) => item === null || text(item))
    && optional(value.frameworkOnly, (item) => typeof item === 'boolean')
    && optional(value.isComponent, (item) => typeof item === 'boolean');
}

function toolboxCandidate(value: unknown): value is ToolboxCandidate {
  return record(value) && text(value.name) && !!value.name && text(value.namespace)
    && text(value.assemblyName) && text(value.version) && text(value.directory)
    && typeof value.fromProject === 'boolean' && optional(value.assemblyPath, text);
}

function toolboxUi(value: unknown): boolean {
  // Released defaults included null before any toolbox customization had been made.
  if (value === null) return true;
  return record(value)
    && optional(value.customTabs, (tabs) => Array.isArray(tabs) && tabs.every((tab) => record(tab)
      && text(tab.name) && Array.isArray(tab.items) && tab.items.every(text)))
    && ['listView', 'sortAlpha', 'showAll'].every((key) => optional(value[key], (item) => typeof item === 'boolean'));
}

function curationValue(key: typeof TOOLBOX_CURATION_KEYS[number], value: unknown): { value: unknown; valid: boolean } {
  if (key === 'toolboxUiState') return { value: record(value) ? value : null, valid: toolboxUi(value) };
  const guard = key === 'chosenToolboxItems' ? toolboxItem : text;
  return {
    value: Array.isArray(value) ? value.filter(guard).map((item) => record(item) ? { ...item } : item) : [],
    valid: Array.isArray(value) && value.every(guard),
  };
}

/** Reject malformed entries at the persistence boundary, before consumers iterate reflection rows. */
export function sanitizeToolboxScanCache(value: unknown): { cache: ToolboxScanCache; valid: boolean } {
  const cache: ToolboxScanCache = {};
  if (!record(value)) return { cache, valid: value === undefined };
  let valid = true;
  for (const [key, entry] of Object.entries(value)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)
      || !record(entry) || !text(entry.stamp) || !entry.stamp
      || !Array.isArray(entry.items) || !entry.items.every(toolboxCandidate)
      || !optional(entry.error, text)) {
      valid = false;
      continue;
    }
    cache[key] = {
      stamp: entry.stamp,
      items: entry.items.slice(0, 2048).map((item) => ({ ...item })),
      ...(entry.error === undefined ? {} : { error: entry.error as string }),
    };
  }
  const keys = Object.keys(cache);
  for (const key of keys.slice(0, Math.max(0, keys.length - 256))) delete cache[key];
  return { cache, valid };
}

/**
 * Await the real pre-1.8 global -> workspace scope migration before exposing designer providers.
 * Each successful key is its own retry checkpoint. Existing workspace values always win, including corrupt
 * values, whose safe in-memory fallback is reported without overwriting potentially recoverable user state.
 * No new schema or synthetic v2Migration cache is introduced; 2.0 and 2.1 read the same persisted formats.
 */
export async function loadPersistedDesignerState(
  global: DesignerStateMemento,
  workspace?: DesignerStateMemento,
): Promise<PersistedDesignerState> {
  const migration: PersistedDesignerState['migration'] = { migratedKeys: [], retainedKeys: [], issues: [] };
  const loaded: Record<string, unknown> = {};
  for (const key of TOOLBOX_CURATION_KEYS) {
    const current = workspace?.get<unknown>(key);
    const scope = current !== undefined ? 'workspace' : 'global';
    const source = current !== undefined ? current : global.get<unknown>(key);
    const parsed = curationValue(key, source);
    loaded[key] = parsed.value;
    if (current !== undefined) migration.retainedKeys.push(key);
    if (source === undefined) continue;
    if (!parsed.valid) {
      migration.issues.push({ key, scope, reason: 'invalid-state' });
      continue;
    }
    if (!workspace || current !== undefined) continue;
    // Check again immediately before the write: an earlier awaited migration may have allowed another
    // activation participant to set this key. Activation must await this loader before registering writers.
    const updated = workspace.get<unknown>(key);
    if (updated !== undefined) {
      const existing = curationValue(key, updated);
      loaded[key] = existing.value;
      migration.retainedKeys.push(key);
      if (!existing.valid) migration.issues.push({ key, scope: 'workspace', reason: 'invalid-state' });
      continue;
    }
    try {
      await workspace.update(key, source);
      migration.migratedKeys.push(key);
    } catch {
      migration.issues.push({ key, scope: 'workspace', reason: 'migration-write-failed' });
    }
  }
  const scan = sanitizeToolboxScanCache(global.get<unknown>('toolboxScanCache'));
  if (!scan.valid) migration.issues.push({ key: 'toolboxScanCache', scope: 'global', reason: 'invalid-state' });
  return {
    chosenItems: loaded.chosenToolboxItems as ToolboxItemInfo[],
    hiddenFqns: loaded.hiddenToolboxFqns as string[],
    toolboxUi: loaded.toolboxUiState,
    browsedAssemblies: loaded.browsedToolboxAssemblies as string[],
    scanCache: scan.cache,
    migration,
  };
}

const cacheWrites = new WeakMap<DesignerStateMemento, Promise<unknown>>();

function queueCacheWrite<T>(memento: DesignerStateMemento, write: () => Promise<T>): Promise<T> {
  const previous = cacheWrites.get(memento) ?? Promise.resolve();
  const operation = previous.catch(() => undefined).then(write);
  cacheWrites.set(memento, operation);
  return operation;
}

/** Snapshot mutable hub state now, and serialize persistence with explicit cache clearing. */
export function persistToolboxScanCache(memento: DesignerStateMemento, value: ToolboxScanCache): Promise<void> {
  const snapshot = sanitizeToolboxScanCache(value).cache;
  return queueCacheWrite(memento, async () => { await memento.update('toolboxScanCache', snapshot); });
}

export interface DesignerCacheClearResult {
  clearedKeys: readonly ['toolboxScanCache'];
  removedEntries: number;
  discardedInvalidEntries: boolean;
}

/** Clear only the disposable reflection cache. This operation has no filesystem/recovery/settings access. */
export function clearDisposableDesignerCaches(memento: DesignerStateMemento): Promise<DesignerCacheClearResult> {
  return queueCacheWrite(memento, async () => {
    const before = memento.get<unknown>('toolboxScanCache');
    const checked = sanitizeToolboxScanCache(before);
    await memento.update('toolboxScanCache', {});
    return {
      clearedKeys: ['toolboxScanCache'],
      removedEntries: record(before) ? Object.keys(before).length : 0,
      discardedInvalidEntries: !checked.valid,
    };
  });
}
