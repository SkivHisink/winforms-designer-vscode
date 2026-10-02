import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  clearDisposableDesignerCaches,
  DESIGNER_CONFIGURATION_KEYS,
  DesignerStateMemento,
  DISPOSABLE_DESIGNER_CACHE_KEYS,
  loadPersistedDesignerState,
  persistToolboxScanCache,
  PERSISTED_DESIGNER_STATE_INVENTORY,
  sanitizeToolboxScanCache,
  ToolboxScanCache,
  TOOLBOX_CURATION_KEYS,
} from './persistedDesignerState';

class FakeMemento implements DesignerStateMemento {
  readonly writes: Array<{ key: string; value: unknown }> = [];
  failOnceFor?: string;
  beforeWrite?: (key: string) => Promise<void>;
  constructor(readonly values: Record<string, unknown> = {}) {}
  get<T>(key: string): T | undefined { return this.values[key] as T | undefined; }
  async update(key: string, value: unknown): Promise<void> {
    this.writes.push({ key, value });
    if (this.failOnceFor === key) {
      this.failOnceFor = undefined;
      throw new Error('simulated persistence failure');
    }
    await this.beforeWrite?.(key);
    this.values[key] = structuredClone(value);
  }
}

const chosen = { name: 'Widget', fqn: 'Example.Widget', category: 'Mine', fromProject: true, assemblyPath: 'D:\\Lib\\Widgets.dll' };
const candidate = { name: 'Widget', namespace: 'Example', assemblyName: 'Widgets', version: '1.0.0.0', directory: 'D:\\Lib', fromProject: true };
const cache = (): ToolboxScanCache => ({ 'd:/lib/widgets.dll': { stamp: '100:200|', items: [{ ...candidate }] } });
const legacy = () => ({
  chosenToolboxItems: [{ ...chosen }], hiddenToolboxFqns: ['System.Windows.Forms.Button'],
  toolboxUiState: { customTabs: [{ name: 'Mine', items: ['Example.Widget'] }], listView: false, sortAlpha: true, showAll: false },
  browsedToolboxAssemblies: ['D:\\Lib\\Widgets.dll'],
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  return { promise: new Promise<void>((done) => { resolve = done; }), resolve: () => resolve() };
}

describe('shipped designer state hydration and scope migration', () => {
  test('starts with safe empty values without creating a synthetic cache/schema', async () => {
    const global = new FakeMemento();
    const workspace = new FakeMemento();
    expect(await loadPersistedDesignerState(global, workspace)).toEqual({
      chosenItems: [], hiddenFqns: [], toolboxUi: null, browsedAssemblies: [], scanCache: {},
      migration: { migratedKeys: [], retainedKeys: [], issues: [] },
    });
    expect(global.writes).toEqual([]);
    expect(workspace.writes).toEqual([]);
  });

  test('migrates released global toolbox keys, awaits persistence and preserves downgrade state', async () => {
    const originals = legacy();
    const global = new FakeMemento(structuredClone(originals));
    const workspace = new FakeMemento();
    const gate = deferred();
    workspace.beforeWrite = async () => gate.promise;
    let completed = false;
    const loading = loadPersistedDesignerState(global, workspace).then((result) => { completed = true; return result; });
    await Promise.resolve();
    expect(completed).toBe(false);
    expect(workspace.values).toEqual({});
    gate.resolve();
    const loaded = await loading;
    expect(loaded.migration).toEqual({ migratedKeys: [...TOOLBOX_CURATION_KEYS], retainedKeys: [], issues: [] });
    expect(workspace.values).toEqual(originals);
    expect(global.values).toEqual(originals);
    expect(global.writes).toEqual([]);
    expect(loaded.chosenItems).toEqual(originals.chosenToolboxItems);
    loaded.chosenItems[0].category = 'Changed in memory';
    expect(global.values).toEqual(originals);
  });

  test('treats existing workspace values, including empty arrays and null UI, as authoritative', async () => {
    const global = new FakeMemento(legacy());
    const workspaceValues = { chosenToolboxItems: [], hiddenToolboxFqns: [], toolboxUiState: null, browsedToolboxAssemblies: [] };
    const workspace = new FakeMemento(workspaceValues);
    const loaded = await loadPersistedDesignerState(global, workspace);
    expect(loaded.chosenItems).toEqual([]);
    expect(loaded.hiddenFqns).toEqual([]);
    expect(loaded.toolboxUi).toBeNull();
    expect(loaded.browsedAssemblies).toEqual([]);
    expect(loaded.migration.retainedKeys).toEqual([...TOOLBOX_CURATION_KEYS]);
    expect(workspace.writes).toEqual([]);
  });

  test('is idempotent and retries only failed keys after interrupted migration', async () => {
    const global = new FakeMemento(legacy());
    const workspace = new FakeMemento();
    workspace.failOnceFor = 'hiddenToolboxFqns';
    const first = await loadPersistedDesignerState(global, workspace);
    expect(first.hiddenFqns).toEqual(['System.Windows.Forms.Button']);
    expect(first.migration.issues).toEqual([{ key: 'hiddenToolboxFqns', scope: 'workspace', reason: 'migration-write-failed' }]);
    expect(workspace.get('hiddenToolboxFqns')).toBeUndefined();
    const second = await loadPersistedDesignerState(global, workspace);
    expect(second.migration.migratedKeys).toEqual(['hiddenToolboxFqns']);
    expect(second.migration.issues).toEqual([]);
    const writeCount = workspace.writes.length;
    expect((await loadPersistedDesignerState(global, workspace)).migration.migratedKeys).toEqual([]);
    expect(workspace.writes).toHaveLength(writeCount);
    expect(global.values).toEqual(legacy());
  });

  test('uses global curation directly on a host without workspace persistence', async () => {
    const global = new FakeMemento(legacy());
    const loaded = await loadPersistedDesignerState(global);
    expect(loaded.chosenItems).toEqual([chosen]);
    expect(loaded.migration).toEqual({ migratedKeys: [], retainedKeys: [], issues: [] });
    expect(global.writes).toEqual([]);
  });

  test('observes workspace writes that land while an earlier migration is awaited', async () => {
    const global = new FakeMemento(legacy());
    const workspace = new FakeMemento();
    workspace.beforeWrite = async (key) => {
      if (key === 'chosenToolboxItems') workspace.values.hiddenToolboxFqns = ['New.Workspace.Choice'];
    };
    const loaded = await loadPersistedDesignerState(global, workspace);
    expect(loaded.hiddenFqns).toEqual(['New.Workspace.Choice']);
    expect(workspace.writes.some((write) => write.key === 'hiddenToolboxFqns')).toBe(false);
  });

  test('isolates corrupt state without throwing or overwriting recoverable persisted values', async () => {
    const global = new FakeMemento(legacy());
    const corrupt = {
      chosenToolboxItems: [chosen, null, { name: 'Incomplete' }], hiddenToolboxFqns: 'not an array',
      toolboxUiState: 42, browsedToolboxAssemblies: ['D:\\Lib\\Widgets.dll', false],
    };
    const workspace = new FakeMemento(structuredClone(corrupt));
    const loaded = await loadPersistedDesignerState(global, workspace);
    expect(loaded.chosenItems).toEqual([chosen]);
    expect(loaded.hiddenFqns).toEqual([]);
    expect(loaded.toolboxUi).toBeNull();
    expect(loaded.browsedAssemblies).toEqual(['D:\\Lib\\Widgets.dll']);
    expect(loaded.migration.issues).toHaveLength(4);
    expect(loaded.migration.issues.every((issue) => issue.reason === 'invalid-state' && issue.scope === 'workspace')).toBe(true);
    expect(workspace.writes).toEqual([]);
    expect(workspace.values).toEqual(corrupt);
    expect(global.values).toEqual(legacy());
  });

  test('does not propagate corrupt legacy entries into an unset workspace', async () => {
    const global = new FakeMemento({ chosenToolboxItems: 'broken', hiddenToolboxFqns: [true, 'Still.Valid'] });
    const workspace = new FakeMemento();
    const loaded = await loadPersistedDesignerState(global, workspace);
    expect(loaded.chosenItems).toEqual([]);
    expect(loaded.hiddenFqns).toEqual(['Still.Valid']);
    expect(loaded.migration.issues).toHaveLength(2);
    expect(workspace.values).toEqual({});
  });

  test('does not interpret arbitrary future or experiment schemas as released settings', async () => {
    const global = new FakeMemento({
      v2Migration: { schemaVersion: 999, artifacts: [] },
      chosenToolboxItems: { schemaVersion: 999, items: [chosen] },
    });
    const workspace = new FakeMemento();
    const loaded = await loadPersistedDesignerState(global, workspace);
    expect(loaded.chosenItems).toEqual([]);
    expect(loaded.migration.issues).toEqual([{ key: 'chosenToolboxItems', scope: 'global', reason: 'invalid-state' }]);
    expect(global.values.v2Migration).toEqual({ schemaVersion: 999, artifacts: [] });
    expect(workspace.writes).toEqual([]);
  });
});

describe('disposable toolbox cache boundary', () => {
  test.each([null, false, 'broken', []])('rejects malformed cache container %j', (value) => {
    expect(sanitizeToolboxScanCache(value)).toEqual({ cache: {}, valid: false });
  });

  test('accepts released cache data and drops corrupt whole assembly entries', () => {
    const state = sanitizeToolboxScanCache({
      ...cache(), badRows: { stamp: 's', items: [candidate, {}] }, badStamp: { items: [] },
      badError: { stamp: 's', items: [], error: 7 },
      constructor: { stamp: 's', items: [] },
    });
    expect(state.cache).toEqual(cache());
    expect(state.valid).toBe(false);
  });

  test('bounds reflection rows and assembly count using the shipped limits', () => {
    const source = Object.fromEntries(Array.from({ length: 257 }, (_, i) => [String(i), {
      stamp: 's', items: Array.from({ length: i === 256 ? 2050 : 1 }, () => ({ ...candidate })),
    }]));
    const state = sanitizeToolboxScanCache(source);
    expect(Object.keys(state.cache)).toHaveLength(256);
    expect(state.cache['0']).toBeUndefined();
    expect(state.cache['256'].items).toHaveLength(2048);
  });

  test('reports corrupt cache during activation without silently rewriting storage', async () => {
    const global = new FakeMemento({ toolboxScanCache: [{ wrong: true }] });
    const state = await loadPersistedDesignerState(global);
    expect(state.scanCache).toEqual({});
    expect(state.migration.issues).toEqual([{ key: 'toolboxScanCache', scope: 'global', reason: 'invalid-state' }]);
    expect(global.writes).toEqual([]);
  });

  test('clears only the disposable key and preserves curation, settings and recovery sentinels', async () => {
    const sentinels = {
      ...legacy(), controlSources: { form: 'library' }, designerViewStates: { form: { canvas: { zoom: 2 } } },
      'v2-transactions': { schemaVersion: '2.0.0', state: 'applying', before: 'unsaved source' },
      'hot-exit-recovery-v1.json': { version: 1, entries: { form: { backupId: 'unsaved backup' } } },
      backup: 'unsaved source bytes', v2Migration: { schemaVersion: 99 },
    };
    const memento = new FakeMemento({ ...structuredClone(sentinels), toolboxScanCache: cache() });
    expect(await clearDisposableDesignerCaches(memento)).toEqual({
      clearedKeys: ['toolboxScanCache'], removedEntries: 1, discardedInvalidEntries: false,
    });
    expect(memento.values).toEqual({ ...sentinels, toolboxScanCache: {} });
    expect(memento.writes.map((write) => write.key)).toEqual(['toolboxScanCache']);
  });

  test('clears corrupt cache deterministically and reports that invalid entries were discarded', async () => {
    const memento = new FakeMemento({ toolboxScanCache: { broken: { stamp: 42 } } });
    expect(await clearDisposableDesignerCaches(memento)).toEqual({
      clearedKeys: ['toolboxScanCache'], removedEntries: 1, discardedInvalidEntries: true,
    });
    expect(memento.values.toolboxScanCache).toEqual({});
  });

  test('propagates a clear failure and permits retry without losing the stored cache', async () => {
    const memento = new FakeMemento({ toolboxScanCache: cache() });
    memento.failOnceFor = 'toolboxScanCache';
    await expect(clearDisposableDesignerCaches(memento)).rejects.toThrow('simulated persistence failure');
    expect(memento.values.toolboxScanCache).toEqual(cache());
    await expect(clearDisposableDesignerCaches(memento)).resolves.toMatchObject({ removedEntries: 1 });
    expect(memento.values.toolboxScanCache).toEqual({});
  });

  test('serializes a clear after pending cache writes and snapshots mutable input', async () => {
    const memento = new FakeMemento();
    const gate = deferred();
    const started = deferred();
    memento.beforeWrite = async () => { started.resolve(); await gate.promise; };
    const input = cache();
    const writing = persistToolboxScanCache(memento, input);
    input['d:/lib/widgets.dll'].items[0].name = 'Changed after scheduling';
    const clearing = clearDisposableDesignerCaches(memento);
    await started.promise;
    expect(memento.writes).toHaveLength(1);
    gate.resolve();
    await writing;
    expect(memento.writes[0].value).toEqual(cache());
    await expect(clearing).resolves.toMatchObject({ removedEntries: 1 });
    expect(memento.values.toolboxScanCache).toEqual({});
  });

  test('permits a fresh cache write after clear and does not poison the queue on a failed write', async () => {
    const memento = new FakeMemento();
    memento.failOnceFor = 'toolboxScanCache';
    await expect(persistToolboxScanCache(memento, cache())).rejects.toThrow();
    await clearDisposableDesignerCaches(memento);
    await persistToolboxScanCache(memento, cache());
    expect(memento.values.toolboxScanCache).toEqual(cache());
  });

  test('inventory classifies shipped backup and journal formats as non-disposable recovery', () => {
    expect(DISPOSABLE_DESIGNER_CACHE_KEYS).toEqual(['toolboxScanCache']);
    expect(PERSISTED_DESIGNER_STATE_INVENTORY.filter((entry) => entry.category === 'disposableCache').map((entry) => entry.key))
      .toEqual([...DISPOSABLE_DESIGNER_CACHE_KEYS]);
    expect(PERSISTED_DESIGNER_STATE_INVENTORY.filter((entry) => entry.category === 'unsavedRecovery').map((entry) => entry.storage))
      .toEqual(['globalStorage', 'workspaceStorage', 'hostBackup']);
    expect(new Set(PERSISTED_DESIGNER_STATE_INVENTORY.map((entry) => entry.key)).size)
      .toBe(PERSISTED_DESIGNER_STATE_INVENTORY.length);
  });

  test('configuration inventory matches the settings actually contributed by the extension', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect([...DESIGNER_CONFIGURATION_KEYS].sort()).toEqual(Object.keys(manifest.contributes.configuration.properties).sort());
  });
});
