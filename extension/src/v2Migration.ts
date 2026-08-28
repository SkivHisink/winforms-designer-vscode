import { ArtifactFingerprint, sameArtifactFingerprint, sha256Hex } from './documentStore';

/**
 * Experimental contract/harness module. Version 2.0.0 does not persist this settings-cache shape and activation does
 * not invoke these migrations. Keep repository tests as design evidence only; do not report product migration or
 * self-repair until a real cache producer/consumer is wired through activation and rollback.
 */

export const V2_SETTINGS_CACHE_KIND = 'winforms-designer-settings-cache' as const;
export const V2_SETTINGS_CACHE_CURRENT_SCHEMA_VERSION = 2 as const;
export const V2_SETTINGS_CACHE_MINIMUM_SUPPORTED_SCHEMA_VERSION = 1 as const;
export const V2_SETTINGS_CACHE_MAX_ARTIFACTS = 65 as const;
export const V2_SETTINGS_CACHE_MAX_SELECTED_TABS = 128 as const;
export const V2_SETTINGS_CACHE_MAX_IDENTIFIER_LENGTH = 128 as const;
export const V2_SETTINGS_CACHE_MAX_PATH_LENGTH = 1024 as const;
export const V2_SETTINGS_CACHE_MAX_JSON_BYTES = 262_144 as const;

export type V2SettingsCacheSchemaVersion = 1 | 2;
export type V2SettingsEngineKind = 'modern' | 'net48';
export type V2CachedArtifactRole = 'source' | 'resource';
export type V2MigrationStatus = 'current' | 'migrated';
export type V2RepairClassification =
  | 'clean'
  | 'settingsCacheMissing'
  | 'settingsCacheRollbackAvailable'
  | 'workspaceRollbackRequired'
  | 'partialWorkspaceUpdate'
  | 'workspaceDrift'
  | 'manualRepairRequired';

export type V2MigrationRefusalCode =
  | 'SETTINGS_CACHE_SCHEMA_TOO_OLD'
  | 'SETTINGS_CACHE_SCHEMA_FUTURE'
  | 'SETTINGS_CACHE_CORRUPT'
  | 'SETTINGS_CACHE_TOO_LARGE';

export interface V1SettingsCache {
  readonly schemaVersion: 1;
  readonly documentId: string;
  readonly workspaceRoot: string;
  readonly sourcePath: string;
  readonly engineKind: V2SettingsEngineKind;
  readonly sourceFingerprint: ArtifactFingerprint;
  readonly resourceFingerprints: Readonly<Record<string, ArtifactFingerprint>>;
  readonly selectedComponentId?: string | null;
  readonly selectedTabs?: Readonly<Record<string, string>>;
  readonly updatedAtUtc: string;
}

export interface V2CachedArtifact {
  readonly artifactId: string;
  readonly role: V2CachedArtifactRole;
  readonly path: string;
  readonly targetFingerprint: ArtifactFingerprint;
  readonly rollbackFingerprint: ArtifactFingerprint;
  readonly requiredForAtomicUpdate: boolean;
}

export interface V2SettingsCacheBackup {
  readonly backupId: string;
  readonly schemaVersion: V2SettingsCacheSchemaVersion;
  readonly createdAtUtc: string;
  readonly cacheSha256: string;
  readonly cacheJson: string;
}

export interface V2SettingsCache {
  readonly schemaVersion: 2;
  readonly cacheKind: typeof V2_SETTINGS_CACHE_KIND;
  readonly documentId: string;
  readonly workspaceRoot: string;
  readonly sourcePath: string;
  readonly engine: {
    readonly kind: V2SettingsEngineKind;
  };
  readonly artifacts: readonly V2CachedArtifact[];
  readonly viewState: {
    readonly selectedComponentId: string | null;
    readonly selectedTabs: Readonly<Record<string, string>>;
  };
  readonly migration: {
    readonly fromSchemaVersion: V2SettingsCacheSchemaVersion;
    readonly migratedAtUtc: string;
    readonly sourceCacheSha256: string;
    readonly backupId: string;
  };
  readonly updatedAtUtc: string;
}

export interface V2SettingsCacheRollbackPlan {
  readonly kind: 'none' | 'restoreSettingsCacheBackup';
  readonly backupId: string | null;
  readonly expectedCurrentCacheSha256: string | null;
  readonly restoreCacheSha256: string | null;
  readonly restoreCacheJson: string | null;
  readonly mutatesWorkspace: false;
}

export type V2SettingsCacheMigrationResult =
  | {
    readonly ok: true;
    readonly status: V2MigrationStatus;
    readonly cache: V2SettingsCache;
    readonly backup: V2SettingsCacheBackup | null;
    readonly rollbackPlan: V2SettingsCacheRollbackPlan;
  }
  | {
    readonly ok: false;
    readonly code: V2MigrationRefusalCode;
    readonly message: string;
  };

export interface V2RepairActionPlan {
  readonly kind:
    | 'none'
    | 'restoreSettingsCacheBackup'
    | 'manualWorkspaceRollback'
    | 'manualWorkspaceReconcile'
    | 'manualSettingsCacheRebuild';
  readonly backupId: string | null;
  readonly artifactIds: readonly string[];
  readonly mutatesWorkspace: boolean;
  readonly automatic: boolean;
}

export interface V2SelfRepairInput {
  readonly settingsCache: unknown | null;
  readonly backup?: V2SettingsCacheBackup | null;
  readonly observedArtifacts: Readonly<Record<string, ArtifactFingerprint>>;
}

export type V2SelfRepairResult =
  | {
    readonly ok: true;
    readonly classification: V2RepairClassification;
    readonly cache: V2SettingsCache | null;
    readonly plan: V2RepairActionPlan;
    readonly details: readonly string[];
  }
  | {
    readonly ok: false;
    readonly classification: 'manualRepairRequired';
    readonly code: V2MigrationRefusalCode;
    readonly message: string;
    readonly plan: V2RepairActionPlan;
    readonly details: readonly string[];
  };

const identifierRegex = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const sha256Regex = /^[a-f0-9]{64}$/;
const isoUtcRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

const fingerprintKeys = new Set([
  'exists',
  'bom',
  'bytesSha256',
  'textSha256',
  'byteLength',
  'mtimeMs',
  'documentVersion',
]);
const v1Keys = new Set([
  'schemaVersion',
  'documentId',
  'workspaceRoot',
  'sourcePath',
  'engineKind',
  'sourceFingerprint',
  'resourceFingerprints',
  'selectedComponentId',
  'selectedTabs',
  'updatedAtUtc',
]);
const v2Keys = new Set([
  'schemaVersion',
  'cacheKind',
  'documentId',
  'workspaceRoot',
  'sourcePath',
  'engine',
  'artifacts',
  'viewState',
  'migration',
  'updatedAtUtc',
]);
const engineKeys = new Set(['kind']);
const artifactKeys = new Set([
  'artifactId',
  'role',
  'path',
  'targetFingerprint',
  'rollbackFingerprint',
  'requiredForAtomicUpdate',
]);
const viewStateKeys = new Set(['selectedComponentId', 'selectedTabs']);
const migrationKeys = new Set(['fromSchemaVersion', 'migratedAtUtc', 'sourceCacheSha256', 'backupId']);
const backupKeys = new Set(['backupId', 'schemaVersion', 'createdAtUtc', 'cacheSha256', 'cacheJson']);

export function migrateV2SettingsCache(
  value: unknown,
  options: { readonly nowUtc: string; readonly backupId?: string },
): V2SettingsCacheMigrationResult {
  const size = jsonByteLength(value);
  if (size > V2_SETTINGS_CACHE_MAX_JSON_BYTES) {
    return refusal('SETTINGS_CACHE_TOO_LARGE', `Settings cache is ${size} bytes; limit is ${V2_SETTINGS_CACHE_MAX_JSON_BYTES}.`);
  }

  const schema = schemaVersionOf(value);
  if (schema === null) return refusal('SETTINGS_CACHE_CORRUPT', 'Settings cache schemaVersion is missing or invalid.');
  if (schema < V2_SETTINGS_CACHE_MINIMUM_SUPPORTED_SCHEMA_VERSION) {
    return refusal('SETTINGS_CACHE_SCHEMA_TOO_OLD', `Settings cache schemaVersion ${schema} is no longer supported.`);
  }
  if (schema > V2_SETTINGS_CACHE_CURRENT_SCHEMA_VERSION) {
    return refusal('SETTINGS_CACHE_SCHEMA_FUTURE', `Settings cache schemaVersion ${schema} is newer than this extension supports.`);
  }

  if (schema === V2_SETTINGS_CACHE_CURRENT_SCHEMA_VERSION) {
    const current = validateV2SettingsCache(value);
    if (!current.ok) return refusal('SETTINGS_CACHE_CORRUPT', current.error);
    return {
      ok: true,
      status: 'current',
      cache: current.cache,
      backup: null,
      rollbackPlan: noRollbackPlan(),
    };
  }

  const previous = validateV1SettingsCache(value);
  if (!previous.ok) return refusal('SETTINGS_CACHE_CORRUPT', previous.error);

  const sourceCacheJson = canonicalJson(previous.cache);
  const sourceCacheSha256 = sha256Hex(sourceCacheJson);
  const backupId = options.backupId ?? `v1-${sourceCacheSha256.slice(0, 16)}`;
  const backup: V2SettingsCacheBackup = {
    backupId,
    schemaVersion: 1,
    createdAtUtc: options.nowUtc,
    cacheSha256: sourceCacheSha256,
    cacheJson: sourceCacheJson,
  };
  const cache: V2SettingsCache = {
    schemaVersion: 2,
    cacheKind: V2_SETTINGS_CACHE_KIND,
    documentId: previous.cache.documentId,
    workspaceRoot: previous.cache.workspaceRoot,
    sourcePath: previous.cache.sourcePath,
    engine: { kind: previous.cache.engineKind },
    artifacts: migrateArtifacts(previous.cache),
    viewState: {
      selectedComponentId: previous.cache.selectedComponentId ?? null,
      selectedTabs: sortStringRecord(previous.cache.selectedTabs ?? {}),
    },
    migration: {
      fromSchemaVersion: 1,
      migratedAtUtc: options.nowUtc,
      sourceCacheSha256,
      backupId,
    },
    updatedAtUtc: options.nowUtc,
  };
  const currentCacheSha256 = sha256Hex(canonicalJson(cache));
  return {
    ok: true,
    status: 'migrated',
    cache,
    backup,
    rollbackPlan: {
      kind: 'restoreSettingsCacheBackup',
      backupId,
      expectedCurrentCacheSha256: currentCacheSha256,
      restoreCacheSha256: sourceCacheSha256,
      restoreCacheJson: sourceCacheJson,
      mutatesWorkspace: false,
    },
  };
}

export function classifyV2SettingsSelfRepair(input: V2SelfRepairInput): V2SelfRepairResult {
  if (input.settingsCache === null) {
    return {
      ok: true,
      classification: 'settingsCacheMissing',
      cache: null,
      plan: {
        kind: input.backup ? 'restoreSettingsCacheBackup' : 'manualSettingsCacheRebuild',
        backupId: input.backup?.backupId ?? null,
        artifactIds: [],
        mutatesWorkspace: false,
        automatic: !!input.backup,
      },
      details: input.backup ? ['settings cache is missing and a backup can restore it'] : ['settings cache is missing and no backup was supplied'],
    };
  }

  const migrated = migrateV2SettingsCache(input.settingsCache, {
    nowUtc: '1970-01-01T00:00:00.000Z',
  });
  if (!migrated.ok) {
    return {
      ok: false,
      classification: 'manualRepairRequired',
      code: migrated.code,
      message: migrated.message,
      plan: {
        kind: 'manualSettingsCacheRebuild',
        backupId: input.backup?.backupId ?? null,
        artifactIds: [],
        mutatesWorkspace: false,
        automatic: false,
      },
      details: [migrated.message],
    };
  }

  const cache = migrated.cache;
  const artifactResults = cache.artifacts.map((artifact) => {
    const unchanged = sameArtifactFingerprint(artifact.targetFingerprint, artifact.rollbackFingerprint);
    const observed = input.observedArtifacts[artifact.artifactId];
    if (!observed) return { artifact, state: 'missing' as const };
    if (unchanged && sameArtifactFingerprint(observed, artifact.targetFingerprint)) return { artifact, state: 'unchanged' as const };
    if (sameArtifactFingerprint(observed, artifact.targetFingerprint)) return { artifact, state: 'target' as const };
    if (sameArtifactFingerprint(observed, artifact.rollbackFingerprint)) return { artifact, state: 'rollback' as const };
    if (!observed.exists && (artifact.targetFingerprint.exists || artifact.rollbackFingerprint.exists)) return { artifact, state: 'missing' as const };
    return { artifact, state: 'drift' as const };
  });
  const target = artifactResults.filter((result) => result.state === 'target').map((result) => result.artifact.artifactId);
  const rollback = artifactResults.filter((result) => result.state === 'rollback').map((result) => result.artifact.artifactId);
  const unchanged = artifactResults.filter((result) => result.state === 'unchanged').map((result) => result.artifact.artifactId);
  const drift = artifactResults.filter((result) => result.state === 'drift').map((result) => result.artifact.artifactId);
  const missing = artifactResults.filter((result) => result.state === 'missing').map((result) => result.artifact.artifactId);

  const targetCompatibleCount = target.length + unchanged.length;
  const rollbackCompatibleCount = rollback.length + unchanged.length;

  if (targetCompatibleCount === cache.artifacts.length) {
    return repairResult('clean', cache, noRepairAction(), ['all observed artifact fingerprints match the v2 cache']);
  }

  if (rollbackCompatibleCount === cache.artifacts.length && rollback.length > 0 && input.backup && validBackup(input.backup)) {
    return repairResult('settingsCacheRollbackAvailable', cache, {
      kind: 'restoreSettingsCacheBackup',
      backupId: input.backup.backupId,
      artifactIds: [...rollback, ...unchanged].sort(compareOrdinal),
      mutatesWorkspace: false,
      automatic: true,
    }, ['workspace artifacts are already at rollback fingerprints; settings cache can be restored from backup']);
  }

  if (rollbackCompatibleCount === cache.artifacts.length && rollback.length > 0) {
    return repairResult('manualRepairRequired', cache, {
      kind: 'manualSettingsCacheRebuild',
      backupId: null,
      artifactIds: [...rollback, ...unchanged].sort(compareOrdinal),
      mutatesWorkspace: false,
      automatic: false,
    }, ['workspace artifacts are rolled back but no valid settings-cache backup was supplied']);
  }

  if (target.length > 0 && rollback.length > 0 && drift.length === 0 && missing.length === 0) {
    return repairResult('partialWorkspaceUpdate', cache, {
      kind: 'manualWorkspaceReconcile',
      backupId: input.backup?.backupId ?? null,
      artifactIds: [...target, ...rollback, ...unchanged].sort(compareOrdinal),
      mutatesWorkspace: true,
      automatic: false,
    }, ['some artifacts match target fingerprints and others match rollback fingerprints']);
  }

  if (target.length === 0 && rollbackCompatibleCount > 0 && drift.length === 0 && missing.length > 0) {
    return repairResult('workspaceRollbackRequired', cache, {
      kind: 'manualWorkspaceRollback',
      backupId: input.backup?.backupId ?? null,
      artifactIds: [...rollback, ...unchanged, ...missing].sort(compareOrdinal),
      mutatesWorkspace: true,
      automatic: false,
    }, ['rollback is incomplete because at least one required artifact is missing']);
  }

  return repairResult('workspaceDrift', cache, {
    kind: 'manualWorkspaceReconcile',
    backupId: input.backup?.backupId ?? null,
    artifactIds: [...drift, ...missing].sort(compareOrdinal),
    mutatesWorkspace: true,
    automatic: false,
  }, [
    ...drift.map((artifactId) => `${artifactId} matches neither target nor rollback fingerprint`),
    ...missing.map((artifactId) => `${artifactId} has no observed fingerprint`),
  ]);
}

export function createV2SettingsUpdateCache(
  current: V2SettingsCache,
  updates: Readonly<Record<string, ArtifactFingerprint>>,
  options: { readonly updatedAtUtc: string; readonly backupId?: string } = { updatedAtUtc: new Date(0).toISOString() },
): { readonly cache: V2SettingsCache; readonly backup: V2SettingsCacheBackup; readonly rollbackPlan: V2SettingsCacheRollbackPlan } {
  const validated = validateV2SettingsCache(current);
  if (!validated.ok) throw new Error(validated.error);
  const unknown = Object.keys(updates).filter((artifactId) => !current.artifacts.some((artifact) => artifact.artifactId === artifactId));
  if (unknown.length > 0) throw new Error(`unknown settings-cache artifact update: ${unknown.sort(compareOrdinal).join(', ')}`);

  const cacheJson = canonicalJson(current);
  const cacheSha256 = sha256Hex(cacheJson);
  const backupId = options.backupId ?? `v2-${cacheSha256.slice(0, 16)}`;
  const backup: V2SettingsCacheBackup = {
    backupId,
    schemaVersion: 2,
    createdAtUtc: options.updatedAtUtc,
    cacheSha256,
    cacheJson,
  };
  const cache: V2SettingsCache = {
    ...current,
    artifacts: current.artifacts.map((artifact) => {
      const next = updates[artifact.artifactId];
      return next
        ? { ...artifact, rollbackFingerprint: artifact.targetFingerprint, targetFingerprint: next }
        : artifact;
    }),
    migration: {
      ...current.migration,
      fromSchemaVersion: 2,
      migratedAtUtc: options.updatedAtUtc,
      sourceCacheSha256: cacheSha256,
      backupId,
    },
    updatedAtUtc: options.updatedAtUtc,
  };
  return {
    cache,
    backup,
    rollbackPlan: {
      kind: 'restoreSettingsCacheBackup',
      backupId,
      expectedCurrentCacheSha256: sha256Hex(canonicalJson(cache)),
      restoreCacheSha256: cacheSha256,
      restoreCacheJson: cacheJson,
      mutatesWorkspace: false,
    },
  };
}

function migrateArtifacts(cache: V1SettingsCache): V2CachedArtifact[] {
  const resources = Object.keys(cache.resourceFingerprints).sort(compareOrdinal).map((resourcePath) => ({
    artifactId: artifactIdForPath(resourcePath),
    role: 'resource' as const,
    path: resourcePath,
    targetFingerprint: cache.resourceFingerprints[resourcePath],
    rollbackFingerprint: cache.resourceFingerprints[resourcePath],
    requiredForAtomicUpdate: true,
  }));
  return [{
    artifactId: 'source',
    role: 'source',
    path: cache.sourcePath,
    targetFingerprint: cache.sourceFingerprint,
    rollbackFingerprint: cache.sourceFingerprint,
    requiredForAtomicUpdate: true,
  }, ...resources];
}

function artifactIdForPath(value: string): string {
  const normalized = normalizeRelativePath(value);
  const ascii = normalized.replace(/[^A-Za-z0-9._:-]+/g, '-').replace(/^-+|-+$/g, '');
  return ascii.length === 0 ? `resource-${sha256Hex(normalized).slice(0, 16)}` : ascii.slice(0, V2_SETTINGS_CACHE_MAX_IDENTIFIER_LENGTH);
}

function validateV1SettingsCache(value: unknown): { ok: true; cache: V1SettingsCache } | { ok: false; error: string } {
  if (!isRecord(value) || !hasOnlyKeys(value, v1Keys)) return invalid('v1 settings cache has unknown or missing fields');
  if (value.schemaVersion !== 1) return invalid('v1 settings cache schemaVersion is invalid');
  if (!validIdentifier(value.documentId)) return invalid('v1 documentId is invalid');
  if (!validRoot(value.workspaceRoot) || !validRelativePath(value.sourcePath)) return invalid('v1 paths are invalid');
  if (value.engineKind !== 'modern' && value.engineKind !== 'net48') return invalid('v1 engineKind is invalid');
  if (!isFingerprint(value.sourceFingerprint)) return invalid('v1 source fingerprint is invalid');
  if (!isResourceFingerprintRecord(value.resourceFingerprints)) return invalid('v1 resource fingerprints are invalid');
  if (!validOptionalIdentifier(value.selectedComponentId)) return invalid('v1 selectedComponentId is invalid');
  if (!isStringRecord(value.selectedTabs ?? {}, V2_SETTINGS_CACHE_MAX_SELECTED_TABS)) return invalid('v1 selectedTabs are invalid');
  if (!validIsoUtc(value.updatedAtUtc)) return invalid('v1 updatedAtUtc is invalid');
  return { ok: true, cache: value as unknown as V1SettingsCache };
}

function validateV2SettingsCache(value: unknown): { ok: true; cache: V2SettingsCache } | { ok: false; error: string } {
  if (!isRecord(value) || !hasOnlyKeys(value, v2Keys)) return invalid('v2 settings cache has unknown or missing fields');
  if (value.schemaVersion !== 2 || value.cacheKind !== V2_SETTINGS_CACHE_KIND) return invalid('v2 settings cache identity is invalid');
  if (!validIdentifier(value.documentId)) return invalid('v2 documentId is invalid');
  if (!validRoot(value.workspaceRoot) || !validRelativePath(value.sourcePath)) return invalid('v2 paths are invalid');
  if (!isRecord(value.engine) || !hasOnlyKeys(value.engine, engineKeys) || (value.engine.kind !== 'modern' && value.engine.kind !== 'net48')) {
    return invalid('v2 engine is invalid');
  }
  if (!Array.isArray(value.artifacts) || value.artifacts.length === 0 || value.artifacts.length > V2_SETTINGS_CACHE_MAX_ARTIFACTS) {
    return invalid('v2 artifact list is invalid');
  }
  const artifactIds = new Set<string>();
  let sourceCount = 0;
  for (const artifact of value.artifacts) {
    if (!isArtifact(artifact)) return invalid('v2 artifact entry is invalid');
    if (artifactIds.has(artifact.artifactId)) return invalid(`v2 duplicate artifactId '${artifact.artifactId}'`);
    artifactIds.add(artifact.artifactId);
    if (artifact.role === 'source') sourceCount++;
  }
  if (sourceCount !== 1 || !value.artifacts.some((artifact) => artifact.role === 'source' && artifact.path === value.sourcePath)) {
    return invalid('v2 source artifact is missing or inconsistent');
  }
  if (!isRecord(value.viewState) || !hasOnlyKeys(value.viewState, viewStateKeys)) return invalid('v2 viewState is invalid');
  if (!validOptionalIdentifier(value.viewState.selectedComponentId) || !isStringRecord(value.viewState.selectedTabs, V2_SETTINGS_CACHE_MAX_SELECTED_TABS)) {
    return invalid('v2 viewState values are invalid');
  }
  if (!isRecord(value.migration) || !hasOnlyKeys(value.migration, migrationKeys)) return invalid('v2 migration metadata is invalid');
  if ((value.migration.fromSchemaVersion !== 1 && value.migration.fromSchemaVersion !== 2)
    || !validIsoUtc(value.migration.migratedAtUtc)
    || !validSha256(value.migration.sourceCacheSha256)
    || !validIdentifier(value.migration.backupId)) {
    return invalid('v2 migration metadata values are invalid');
  }
  if (!validIsoUtc(value.updatedAtUtc)) return invalid('v2 updatedAtUtc is invalid');
  return { ok: true, cache: value as unknown as V2SettingsCache };
}

function isArtifact(value: unknown): value is V2CachedArtifact {
  if (!isRecord(value) || !hasOnlyKeys(value, artifactKeys)) return false;
  return validIdentifier(value.artifactId)
    && (value.role === 'source' || value.role === 'resource')
    && validRelativePath(value.path)
    && isFingerprint(value.targetFingerprint)
    && isFingerprint(value.rollbackFingerprint)
    && typeof value.requiredForAtomicUpdate === 'boolean';
}

function isFingerprint(value: unknown): value is ArtifactFingerprint {
  if (!isRecord(value) || !hasOnlyKeys(value, fingerprintKeys)) return false;
  if (typeof value.exists !== 'boolean' || typeof value.bom !== 'boolean') return false;
  if (!validNullableSha256(value.bytesSha256) || !validNullableSha256(value.textSha256)) return false;
  if (!validNullableNonNegativeInteger(value.byteLength) || !validNullableNonNegativeNumber(value.mtimeMs)) return false;
  return value.documentVersion === null || typeof value.documentVersion === 'string' || Number.isSafeInteger(value.documentVersion);
}

function isResourceFingerprintRecord(value: unknown): value is Readonly<Record<string, ArtifactFingerprint>> {
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  if (entries.length > V2_SETTINGS_CACHE_MAX_ARTIFACTS - 1) return false;
  const artifactIds = new Set<string>();
  for (const [key, fingerprint] of entries) {
    if (!validRelativePath(key) || !isFingerprint(fingerprint)) return false;
    const artifactId = artifactIdForPath(key);
    if (artifactIds.has(artifactId)) return false;
    artifactIds.add(artifactId);
  }
  return true;
}

function validBackup(value: V2SettingsCacheBackup): boolean {
  return isRecord(value)
    && hasOnlyKeys(value, backupKeys)
    && validIdentifier(value.backupId)
    && (value.schemaVersion === 1 || value.schemaVersion === 2)
    && validIsoUtc(value.createdAtUtc)
    && validSha256(value.cacheSha256)
    && typeof value.cacheJson === 'string'
    && Buffer.byteLength(value.cacheJson, 'utf8') <= V2_SETTINGS_CACHE_MAX_JSON_BYTES
    && sha256Hex(value.cacheJson) === value.cacheSha256;
}

function schemaVersionOf(value: unknown): number | null {
  if (!isRecord(value) || !Number.isSafeInteger(value.schemaVersion)) return null;
  return value.schemaVersion as number;
}

function jsonByteLength(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortCanonical(value));
}

function sortCanonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortCanonical);
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort(compareOrdinal)) {
    const entry = value[key];
    if (entry !== undefined) result[key] = sortCanonical(entry);
  }
  return result;
}

function sortStringRecord(value: Readonly<Record<string, string>>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of Object.keys(value).sort(compareOrdinal)) result[key] = value[key];
  return result;
}

function isStringRecord(value: unknown, maxEntries: number): value is Readonly<Record<string, string>> {
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  if (entries.length > maxEntries) return false;
  return entries.every(([key, entry]) => validIdentifier(key) && typeof entry === 'string' && entry.length <= V2_SETTINGS_CACHE_MAX_IDENTIFIER_LENGTH);
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function validIdentifier(value: unknown): value is string {
  return typeof value === 'string' && identifierRegex.test(value);
}

function validOptionalIdentifier(value: unknown): boolean {
  return value === undefined || value === null || validIdentifier(value);
}

function validRoot(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= V2_SETTINGS_CACHE_MAX_PATH_LENGTH
    && !value.includes('\0');
}

function validRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > V2_SETTINGS_CACHE_MAX_PATH_LENGTH || value.includes('\0')) {
    return false;
  }
  const normalized = normalizeRelativePath(value);
  return normalized.length > 0
    && !normalized.startsWith('/')
    && !/^[A-Za-z]:\//.test(normalized)
    && !normalized.split('/').some((part) => part === '' || part === '.' || part === '..');
}

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, '/');
}

function validIsoUtc(value: unknown): value is string {
  return typeof value === 'string' && isoUtcRegex.test(value) && !Number.isNaN(Date.parse(value));
}

function validSha256(value: unknown): value is string {
  return typeof value === 'string' && sha256Regex.test(value);
}

function validNullableSha256(value: unknown): boolean {
  return value === null || validSha256(value);
}

function validNullableNonNegativeInteger(value: unknown): boolean {
  return value === null || (Number.isSafeInteger(value) && (value as number) >= 0);
}

function validNullableNonNegativeNumber(value: unknown): boolean {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
}

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function noRollbackPlan(): V2SettingsCacheRollbackPlan {
  return {
    kind: 'none',
    backupId: null,
    expectedCurrentCacheSha256: null,
    restoreCacheSha256: null,
    restoreCacheJson: null,
    mutatesWorkspace: false,
  };
}

function noRepairAction(): V2RepairActionPlan {
  return {
    kind: 'none',
    backupId: null,
    artifactIds: [],
    mutatesWorkspace: false,
    automatic: true,
  };
}

function repairResult(
  classification: V2RepairClassification,
  cache: V2SettingsCache,
  plan: V2RepairActionPlan,
  details: readonly string[],
): V2SelfRepairResult {
  return { ok: true, classification, cache, plan, details };
}

function refusal(code: V2MigrationRefusalCode, message: string): V2SettingsCacheMigrationResult {
  return { ok: false, code, message };
}

function invalid(error: string): { ok: false; error: string } {
  return { ok: false, error };
}
