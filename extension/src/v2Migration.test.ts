import { describe, expect, it } from 'vitest';
import { ArtifactFingerprint, sha256Hex } from './documentStore';
import {
  V1SettingsCache,
  V2SettingsCache,
  classifyV2SettingsSelfRepair,
  createV2SettingsUpdateCache,
  migrateV2SettingsCache,
} from './v2Migration';

const now = '2026-08-20T12:00:00.000Z';

function fp(seed: string, version: number | string | null = null): ArtifactFingerprint {
  return {
    exists: true,
    bom: false,
    bytesSha256: sha256Hex(`bytes:${seed}`),
    textSha256: sha256Hex(`text:${seed}`),
    byteLength: seed.length,
    mtimeMs: 1000 + seed.length,
    documentVersion: version,
  };
}

function missing(version: number | string | null = null): ArtifactFingerprint {
  return {
    exists: false,
    bom: false,
    bytesSha256: null,
    textSha256: null,
    byteLength: null,
    mtimeMs: null,
    documentVersion: version,
  };
}

function v1Cache(): V1SettingsCache {
  return {
    schemaVersion: 1,
    documentId: 'Form1.cs',
    workspaceRoot: 'D:/repo',
    sourcePath: 'Forms/Form1.Designer.cs',
    engineKind: 'modern',
    sourceFingerprint: fp('source', 7),
    resourceFingerprints: {
      'Forms/Form1.fr.resx': fp('fr'),
      'Forms/Form1.resx': fp('neutral'),
    },
    selectedComponentId: 'button1',
    selectedTabs: {
      tabControl1: 'tabPage2',
      zTabs: 'zPage',
    },
    updatedAtUtc: '2026-08-19T01:02:03.000Z',
  };
}

function migrate(cache: V1SettingsCache = v1Cache()): V2SettingsCache {
  const result = migrateV2SettingsCache(cache, { nowUtc: now, backupId: 'backup-1' });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.message);
  return result.cache;
}

describe('v2 settings-cache migration', () => {
  it('deterministically migrates the N-1 cache into a bounded v2 shape with rollback metadata', () => {
    const first = migrateV2SettingsCache(v1Cache(), { nowUtc: now, backupId: 'backup-1' });
    const second = migrateV2SettingsCache({
      ...v1Cache(),
      resourceFingerprints: {
        'Forms/Form1.resx': fp('neutral'),
        'Forms/Form1.fr.resx': fp('fr'),
      },
    }, { nowUtc: now, backupId: 'backup-1' });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(first.cache).toEqual(second.cache);
    expect(first.status).toBe('migrated');
    expect(first.cache.schemaVersion).toBe(2);
    expect(first.cache.cacheKind).toBe('winforms-designer-settings-cache');
    expect(first.cache.engine).toEqual({ kind: 'modern' });
    expect(first.cache.artifacts.map((artifact) => `${artifact.role}:${artifact.path}`)).toEqual([
      'source:Forms/Form1.Designer.cs',
      'resource:Forms/Form1.fr.resx',
      'resource:Forms/Form1.resx',
    ]);
    expect(first.cache.artifacts.every((artifact) => artifact.requiredForAtomicUpdate)).toBe(true);
    expect(first.cache.artifacts[0].targetFingerprint).toEqual(first.cache.artifacts[0].rollbackFingerprint);
    expect(first.backup?.cacheSha256).toBe(first.cache.migration.sourceCacheSha256);
    expect(first.rollbackPlan).toMatchObject({
      kind: 'restoreSettingsCacheBackup',
      backupId: 'backup-1',
      restoreCacheSha256: first.backup?.cacheSha256,
      restoreCacheJson: first.backup?.cacheJson,
      mutatesWorkspace: false,
    });
  });

  it('accepts a current v2 cache as N and does not manufacture a rollback write', () => {
    const cache = migrate();
    const result = migrateV2SettingsCache(cache, { nowUtc: '2026-08-21T00:00:00.000Z' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe('current');
    expect(result.cache).toEqual(cache);
    expect(result.backup).toBeNull();
    expect(result.rollbackPlan).toEqual({
      kind: 'none',
      backupId: null,
      expectedCurrentCacheSha256: null,
      restoreCacheSha256: null,
      restoreCacheJson: null,
      mutatesWorkspace: false,
    });
  });

  it('refuses future, old, oversized, and corrupt settings-cache inputs', () => {
    expect(migrateV2SettingsCache({ schemaVersion: 3 }, { nowUtc: now })).toMatchObject({
      ok: false,
      code: 'SETTINGS_CACHE_SCHEMA_FUTURE',
    });
    expect(migrateV2SettingsCache({ schemaVersion: 0 }, { nowUtc: now })).toMatchObject({
      ok: false,
      code: 'SETTINGS_CACHE_SCHEMA_TOO_OLD',
    });
    expect(migrateV2SettingsCache({ ...v1Cache(), extra: true }, { nowUtc: now })).toMatchObject({
      ok: false,
      code: 'SETTINGS_CACHE_CORRUPT',
    });
    expect(migrateV2SettingsCache({ ...v1Cache(), sourcePath: '../Form1.Designer.cs' }, { nowUtc: now })).toMatchObject({
      ok: false,
      code: 'SETTINGS_CACHE_CORRUPT',
    });
    expect(migrateV2SettingsCache({
      ...v1Cache(),
      selectedTabs: Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`tab${index}`, 'page'])),
    }, { nowUtc: now })).toMatchObject({
      ok: false,
      code: 'SETTINGS_CACHE_CORRUPT',
    });
  });

  it('creates a v2-to-v2 update cache with rollback fingerprints but without workspace mutation', () => {
    const current = migrate();
    const updatedSource = fp('source-after', 8);
    const update = createV2SettingsUpdateCache(current, { source: updatedSource }, {
      updatedAtUtc: '2026-08-20T13:00:00.000Z',
      backupId: 'backup-2',
    });

    expect(update.cache.artifacts.find((artifact) => artifact.artifactId === 'source')).toMatchObject({
      targetFingerprint: updatedSource,
      rollbackFingerprint: current.artifacts[0].targetFingerprint,
    });
    expect(update.backup.schemaVersion).toBe(2);
    expect(update.rollbackPlan).toMatchObject({
      kind: 'restoreSettingsCacheBackup',
      backupId: 'backup-2',
      restoreCacheJson: update.backup.cacheJson,
      mutatesWorkspace: false,
    });
    expect(() => createV2SettingsUpdateCache(current, { missing: fp('x') }, { updatedAtUtc: now }))
      .toThrow('unknown settings-cache artifact update: missing');
  });
});

describe('v2 settings-cache self repair classification', () => {
  it('classifies a fully matching cache as clean', () => {
    const cache = migrate();
    const result = classifyV2SettingsSelfRepair({
      settingsCache: cache,
      observedArtifacts: Object.fromEntries(cache.artifacts.map((artifact) => [artifact.artifactId, artifact.targetFingerprint])),
    });

    expect(result).toMatchObject({
      ok: true,
      classification: 'clean',
      plan: { kind: 'none', mutatesWorkspace: false, automatic: true },
    });
  });

  it('detects a partial workspace update and returns only a manual repair plan', () => {
    const current = migrate();
    const updated = createV2SettingsUpdateCache(current, {
      source: fp('source-after'),
      'Forms-Form1.resx': fp('neutral-after'),
    }, { updatedAtUtc: '2026-08-20T13:00:00.000Z', backupId: 'backup-2' }).cache;

    const observed = Object.fromEntries(updated.artifacts.map((artifact) => [artifact.artifactId, artifact.targetFingerprint]));
    observed.source = updated.artifacts.find((artifact) => artifact.artifactId === 'source')!.rollbackFingerprint;

    const result = classifyV2SettingsSelfRepair({ settingsCache: updated, observedArtifacts: observed });

    expect(result).toMatchObject({
      ok: true,
      classification: 'partialWorkspaceUpdate',
      plan: {
        kind: 'manualWorkspaceReconcile',
        mutatesWorkspace: true,
        automatic: false,
      },
    });
    if (result.ok) {
      expect(result.plan.artifactIds).toEqual([
        'Forms-Form1.fr.resx',
        'Forms-Form1.resx',
        'source',
      ]);
      expect(result.details).toEqual(['some artifacts match target fingerprints and others match rollback fingerprints']);
    }
  });

  it('uses a valid backup to classify settings-cache rollback when the workspace is already rolled back', () => {
    const current = migrate();
    const update = createV2SettingsUpdateCache(current, {
      source: fp('source-after'),
      'Forms-Form1.resx': fp('neutral-after'),
    }, { updatedAtUtc: '2026-08-20T13:00:00.000Z', backupId: 'backup-2' });
    const observed = Object.fromEntries(update.cache.artifacts.map((artifact) => [artifact.artifactId, artifact.rollbackFingerprint]));

    const result = classifyV2SettingsSelfRepair({
      settingsCache: update.cache,
      backup: update.backup,
      observedArtifacts: observed,
    });

    expect(result).toMatchObject({
      ok: true,
      classification: 'settingsCacheRollbackAvailable',
      plan: {
        kind: 'restoreSettingsCacheBackup',
        backupId: 'backup-2',
        mutatesWorkspace: false,
        automatic: true,
      },
    });
  });

  it('fails closed on drift, missing observations, missing settings cache, and corrupt current cache', () => {
    const cache = migrate();
    expect(classifyV2SettingsSelfRepair({
      settingsCache: cache,
      observedArtifacts: { source: fp('external-edit') },
    })).toMatchObject({
      ok: true,
      classification: 'workspaceDrift',
      plan: { kind: 'manualWorkspaceReconcile', mutatesWorkspace: true, automatic: false },
    });

    expect(classifyV2SettingsSelfRepair({ settingsCache: null, observedArtifacts: {} })).toMatchObject({
      ok: true,
      classification: 'settingsCacheMissing',
      plan: { kind: 'manualSettingsCacheRebuild', mutatesWorkspace: false, automatic: false },
    });

    expect(classifyV2SettingsSelfRepair({
      settingsCache: { ...cache, artifacts: [{ ...cache.artifacts[0], extra: true }] },
      observedArtifacts: {},
    })).toMatchObject({
      ok: false,
      classification: 'manualRepairRequired',
      code: 'SETTINGS_CACHE_CORRUPT',
      plan: { kind: 'manualSettingsCacheRebuild', mutatesWorkspace: false, automatic: false },
    });
  });

  it('classifies incomplete rollback separately from arbitrary drift', () => {
    const current = migrate();
    const update = createV2SettingsUpdateCache(current, {
      source: fp('source-after'),
    }, { updatedAtUtc: '2026-08-20T13:00:00.000Z', backupId: 'backup-2' }).cache;
    const observed = Object.fromEntries(update.artifacts.map((artifact) => [artifact.artifactId, artifact.rollbackFingerprint]));
    observed.source = missing();

    expect(classifyV2SettingsSelfRepair({ settingsCache: update, observedArtifacts: observed })).toMatchObject({
      ok: true,
      classification: 'workspaceRollbackRequired',
      plan: { kind: 'manualWorkspaceRollback', mutatesWorkspace: true, automatic: false },
    });
  });
});
