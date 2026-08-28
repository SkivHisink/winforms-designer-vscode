import {
  V2_PROTOCOL_CAPABILITIES,
  V2_PROTOCOL_CURRENT_VERSION,
  V2_PROTOCOL_ID,
  V2_PROTOCOL_MAX_CAPABILITIES,
  V2_PROTOCOL_MAX_PAYLOAD_BYTES,
  V2_PROTOCOL_MINIMUM_SUPPORTED_VERSION,
} from './v2Protocol';

/**
 * Strict declaration contract consumed by the read-only workspace adapter-manifest registry. A successful validation
 * is compatibility metadata only: product vendor-code loading and mutation authority remain separate certified gates.
 */

export const V2_ADAPTER_MANIFEST_SCHEMA_ID = 'winforms-designer.v2.adapter-manifest' as const;
export const V2_ADAPTER_MANIFEST_SCHEMA_VERSION = 1 as const;
export const V2_ADAPTER_MANIFEST_PRODUCT_ID = 'winforms-designer-vscode' as const;
export const V2_ADAPTER_MANIFEST_DIAGNOSTIC_FORMAT = 'v2-adapter-diagnostics' as const;
export const V2_ADAPTER_MANIFEST_MAX_COHORTS = 16 as const;
export const V2_ADAPTER_MANIFEST_MAX_PATHS = 64 as const;
export const V2_ADAPTER_MANIFEST_DEFAULT_MAX_PATH_LENGTH = 260 as const;

export const V2_ADAPTER_MANIFEST_CAPABILITIES = [
  'adapter.manifest-v1',
  'adapter.compatibility-v1',
  'diagnostics.machine-readable',
  'toolbox.discovery',
  'control.render-metadata',
  'property-grid.metadata',
  'property-editor.bounded',
  'smart-tags.readonly',
  'resource.readonly',
  'source.mutation.source-first',
  'hosted-intent.bounded'
] as const;

export const V2_ADAPTER_MANIFEST_UNSUPPORTED_FEATURES = [
  'vs-designer-sdk-rehost',
  'vendor-smart-tag-actions',
  'custom-uitypeeditor-hosting',
  'licensed-designtime-code',
  'com-activex',
  'x86-worker'
] as const;

export type V2AdapterManifestRuntime = 'modern' | 'net48';
export type V2AdapterManifestArchitecture = 'x64' | 'arm64';
export type V2AdapterManifestCapability = typeof V2_ADAPTER_MANIFEST_CAPABILITIES[number];
export type V2AdapterManifestUnsupportedFeature = typeof V2_ADAPTER_MANIFEST_UNSUPPORTED_FEATURES[number];
export type V2AdapterManifestMutationAuthority = 'none' | 'sourceFirst' | 'hostedDesignTime';
export type V2AdapterManifestSignature = 'unsigned-local' | 'signed-vendor';
export type V2AdapterManifestDiagnosticSeverity = 'error' | 'warning';

export type V2AdapterManifestDiagnosticCode =
  | 'ADAPTER_MANIFEST_MALFORMED_JSON'
  | 'ADAPTER_MANIFEST_NOT_OBJECT'
  | 'ADAPTER_MANIFEST_UNKNOWN_FIELD'
  | 'ADAPTER_MANIFEST_FIELD_REQUIRED'
  | 'ADAPTER_MANIFEST_FIELD_INVALID'
  | 'ADAPTER_PROTOCOL_UNSUPPORTED'
  | 'ADAPTER_CAPABILITY_UNDECLARED'
  | 'ADAPTER_COHORT_UNSUPPORTED'
  | 'ADAPTER_PAYLOAD_TOO_LARGE'
  | 'ADAPTER_PATH_OUT_OF_BOUNDS'
  | 'ADAPTER_MUTATION_AUTHORITY_DENIED'
  | 'ADAPTER_VENDOR_CODE_LOAD_DENIED';

export interface V2AdapterManifestDiagnostic {
  severity: V2AdapterManifestDiagnosticSeverity;
  code: V2AdapterManifestDiagnosticCode;
  path: string;
  message: string;
}

export interface V2AdapterProductCohort {
  productId: typeof V2_ADAPTER_MANIFEST_PRODUCT_ID;
  minProductVersion: string;
  maxProductVersionExclusive: string;
  runtimes: V2AdapterManifestRuntime[];
  architectures: V2AdapterManifestArchitecture[];
}

export interface V2AdapterManifest {
  schemaId: typeof V2_ADAPTER_MANIFEST_SCHEMA_ID;
  schemaVersion: typeof V2_ADAPTER_MANIFEST_SCHEMA_VERSION;
  adapter: {
    id: string;
    version: string;
    displayName: string;
    publisher: {
      id: string;
      displayName: string;
    };
  };
  protocol: {
    id: typeof V2_PROTOCOL_ID;
    supportedVersions: number[];
    requiredCapabilities: string[];
  };
  compatibility: {
    productId: typeof V2_ADAPTER_MANIFEST_PRODUCT_ID;
    cohorts: V2AdapterProductCohort[];
  };
  capabilities: V2AdapterManifestCapability[];
  trust: {
    signature: V2AdapterManifestSignature;
    workspaceTrust: 'trusted';
    loadVendorCode: boolean;
    mutationAuthority: V2AdapterManifestMutationAuthority;
  };
  bounds: {
    maxPayloadBytes: number;
    maxPathLength: number;
    allowAbsolutePaths: false;
    allowParentDirectoryTraversal: false;
  };
  unsupportedFeatures: V2AdapterManifestUnsupportedFeature[];
  diagnostics: {
    format: typeof V2_ADAPTER_MANIFEST_DIAGNOSTIC_FORMAT;
    deterministic: true;
  };
}

export interface V2AdapterCompatibilityRequest {
  requiredCapabilities?: readonly string[];
  productVersion?: string;
  runtime?: V2AdapterManifestRuntime;
  architecture?: V2AdapterManifestArchitecture;
  payloadBytes?: number;
  paths?: readonly string[];
  mutationAuthority?: Exclude<V2AdapterManifestMutationAuthority, 'none'>;
  mayLoadVendorCode?: boolean;
}

export type V2AdapterManifestEvaluation =
  | {
      ok: true;
      manifest: V2AdapterManifest;
      diagnostics: [];
      /** Declarative manifest compatibility only; runtime loading still requires independent signature/trust verification. */
      manifestDeclaresVendorCodeLoad: boolean;
      /** Declarative manifest compatibility only; this result never grants workspace write authority. */
      manifestDeclaresWorkspaceMutation: boolean;
    }
  | {
      ok: false;
      manifest?: V2AdapterManifest;
      diagnostics: V2AdapterManifestDiagnostic[];
      manifestDeclaresVendorCodeLoad: false;
      manifestDeclaresWorkspaceMutation: false;
    };

const adapterCapabilitySet = new Set<string>(V2_ADAPTER_MANIFEST_CAPABILITIES);
const unsupportedFeatureSet = new Set<string>(V2_ADAPTER_MANIFEST_UNSUPPORTED_FEATURES);
const protocolCapabilitySet = new Set<string>(V2_PROTOCOL_CAPABILITIES);
const supportedRuntimeSet = new Set<string>(['modern', 'net48']);
const supportedArchitectureSet = new Set<string>(['x64', 'arm64']);
const mutationAuthorityRank: Record<V2AdapterManifestMutationAuthority, number> = {
  none: 0,
  sourceFirst: 1,
  hostedDesignTime: 2,
};
const semverRegex = new RegExp('^[0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?$');
const identifierRegex = new RegExp('^[a-z][a-z0-9.-]{2,95}$');
const displayNameRegex = new RegExp('^[^\\r\\n]{1,120}$');

const rootKeys = new Set([
  'schemaId',
  'schemaVersion',
  'adapter',
  'protocol',
  'compatibility',
  'capabilities',
  'trust',
  'bounds',
  'unsupportedFeatures',
  'diagnostics'
]);
const adapterKeys = new Set(['id', 'version', 'displayName', 'publisher']);
const publisherKeys = new Set(['id', 'displayName']);
const protocolKeys = new Set(['id', 'supportedVersions', 'requiredCapabilities']);
const compatibilityKeys = new Set(['productId', 'cohorts']);
const cohortKeys = new Set(['productId', 'minProductVersion', 'maxProductVersionExclusive', 'runtimes', 'architectures']);
const trustKeys = new Set(['signature', 'workspaceTrust', 'loadVendorCode', 'mutationAuthority']);
const boundsKeys = new Set(['maxPayloadBytes', 'maxPathLength', 'allowAbsolutePaths', 'allowParentDirectoryTraversal']);
const diagnosticsKeys = new Set(['format', 'deterministic']);

export function validateV2AdapterManifestJson(
  manifestJson: string,
  request: V2AdapterCompatibilityRequest = {},
): V2AdapterManifestEvaluation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestJson);
  } catch {
    return fail([diagnostic(
      'ADAPTER_MANIFEST_MALFORMED_JSON',
      '$',
      'Adapter manifest is not valid JSON.',
    )]);
  }

  return evaluateV2AdapterManifest(parsed, request);
}

export function evaluateV2AdapterManifest(
  value: unknown,
  request: V2AdapterCompatibilityRequest = {},
): V2AdapterManifestEvaluation {
  const diagnostics: V2AdapterManifestDiagnostic[] = [];
  const manifest = validateManifestShape(value, diagnostics);

  if (manifest) {
    validateCompatibilityRequest(manifest, request, diagnostics);
  }

  if (diagnostics.length > 0) {
    return {
      ok: false,
      manifest: manifest ?? undefined,
      diagnostics,
      manifestDeclaresVendorCodeLoad: false,
      manifestDeclaresWorkspaceMutation: false,
    };
  }

  return {
    ok: true,
    manifest: manifest!,
    diagnostics: [],
    manifestDeclaresVendorCodeLoad: request.mayLoadVendorCode === true && manifest!.trust.loadVendorCode,
    manifestDeclaresWorkspaceMutation: manifest!.trust.mutationAuthority !== 'none',
  };
}

function validateManifestShape(value: unknown, diagnostics: V2AdapterManifestDiagnostic[]): V2AdapterManifest | null {
  const root = requireRecord(value, '$', rootKeys, [...rootKeys], diagnostics);
  if (!root) return null;

  if (root.schemaId !== V2_ADAPTER_MANIFEST_SCHEMA_ID) {
    pushInvalid(diagnostics, '$.schemaId', 'Adapter manifest schema identity is invalid.');
  }
  if (root.schemaVersion !== V2_ADAPTER_MANIFEST_SCHEMA_VERSION) {
    pushInvalid(diagnostics, '$.schemaVersion', 'Adapter manifest schema version is unsupported.');
  }

  const adapter = requireRecord(root.adapter, '$.adapter', adapterKeys, [...adapterKeys], diagnostics);
  const publisher = adapter ? requireRecord(adapter.publisher, '$.adapter.publisher', publisherKeys, [...publisherKeys], diagnostics) : null;
  if (adapter) {
    validateIdentifier(adapter.id, '$.adapter.id', diagnostics);
    validateSemver(adapter.version, '$.adapter.version', diagnostics);
    validateDisplayName(adapter.displayName, '$.adapter.displayName', diagnostics);
  }
  if (publisher) {
    validateIdentifier(publisher.id, '$.adapter.publisher.id', diagnostics);
    validateDisplayName(publisher.displayName, '$.adapter.publisher.displayName', diagnostics);
  }

  const protocol = requireRecord(root.protocol, '$.protocol', protocolKeys, [...protocolKeys], diagnostics);
  if (protocol) {
    if (protocol.id !== V2_PROTOCOL_ID) {
      diagnostics.push(diagnostic('ADAPTER_PROTOCOL_UNSUPPORTED', '$.protocol.id', 'Adapter protocol id is unsupported.'));
    }
    validateProtocolVersions(protocol.supportedVersions, diagnostics);
    validateStringSet(protocol.requiredCapabilities, '$.protocol.requiredCapabilities', protocolCapabilitySet, 'ADAPTER_MANIFEST_FIELD_INVALID', diagnostics);
  }

  const compatibility = requireRecord(root.compatibility, '$.compatibility', compatibilityKeys, [...compatibilityKeys], diagnostics);
  if (compatibility) {
    if (compatibility.productId !== V2_ADAPTER_MANIFEST_PRODUCT_ID) {
      pushInvalid(diagnostics, '$.compatibility.productId', 'Adapter compatibility product id is invalid.');
    }
    validateCohorts(compatibility.cohorts, diagnostics);
  }

  validateStringSet(root.capabilities, '$.capabilities', adapterCapabilitySet, 'ADAPTER_CAPABILITY_UNDECLARED', diagnostics);
  if (Array.isArray(root.capabilities)) {
    for (const required of ['adapter.manifest-v1', 'adapter.compatibility-v1', 'diagnostics.machine-readable']) {
      if (!root.capabilities.includes(required)) {
        diagnostics.push(diagnostic(
          'ADAPTER_CAPABILITY_UNDECLARED',
          '$.capabilities',
          `Adapter manifest must declare required capability '${required}'.`,
        ));
      }
    }
  }

  const trust = requireRecord(root.trust, '$.trust', trustKeys, [...trustKeys], diagnostics);
  if (trust) {
    if (trust.signature !== 'unsigned-local' && trust.signature !== 'signed-vendor') {
      pushInvalid(diagnostics, '$.trust.signature', 'Adapter signature policy is invalid.');
    }
    if (trust.workspaceTrust !== 'trusted') {
      pushInvalid(diagnostics, '$.trust.workspaceTrust', 'Adapters are only evaluated in trusted workspaces.');
    }
    if (typeof trust.loadVendorCode !== 'boolean') {
      pushInvalid(diagnostics, '$.trust.loadVendorCode', 'Vendor code load declaration must be boolean.');
    }
    if (trust.mutationAuthority !== 'none' && trust.mutationAuthority !== 'sourceFirst' && trust.mutationAuthority !== 'hostedDesignTime') {
      pushInvalid(diagnostics, '$.trust.mutationAuthority', 'Mutation authority declaration is invalid.');
    }
    if (trust.loadVendorCode === true && trust.signature !== 'signed-vendor') {
      diagnostics.push(diagnostic(
        'ADAPTER_VENDOR_CODE_LOAD_DENIED',
        '$.trust',
        'Adapter may not load vendor code without a signed-vendor trust declaration.',
      ));
    }
  }

  const bounds = requireRecord(root.bounds, '$.bounds', boundsKeys, [...boundsKeys], diagnostics);
  if (bounds) validateBounds(bounds, diagnostics);

  validateStringSet(root.unsupportedFeatures, '$.unsupportedFeatures', unsupportedFeatureSet, 'ADAPTER_MANIFEST_FIELD_INVALID', diagnostics);

  const machineDiagnostics = requireRecord(root.diagnostics, '$.diagnostics', diagnosticsKeys, [...diagnosticsKeys], diagnostics);
  if (machineDiagnostics) {
    if (machineDiagnostics.format !== V2_ADAPTER_MANIFEST_DIAGNOSTIC_FORMAT) {
      pushInvalid(diagnostics, '$.diagnostics.format', 'Adapter diagnostics format is invalid.');
    }
    if (machineDiagnostics.deterministic !== true) {
      pushInvalid(diagnostics, '$.diagnostics.deterministic', 'Adapter diagnostics must be deterministic.');
    }
  }

  return diagnostics.length === 0 ? root as unknown as V2AdapterManifest : null;
}

function validateCompatibilityRequest(
  manifest: V2AdapterManifest,
  request: V2AdapterCompatibilityRequest,
  diagnostics: V2AdapterManifestDiagnostic[],
): void {
  for (const capability of request.requiredCapabilities ?? []) {
    if (!adapterCapabilitySet.has(capability) || !manifest.capabilities.includes(capability as V2AdapterManifestCapability)) {
      diagnostics.push(diagnostic(
        'ADAPTER_CAPABILITY_UNDECLARED',
        '$.capabilities',
        `Required adapter capability is not declared: ${capability}`,
      ));
    }
  }

  if (request.productVersion || request.runtime || request.architecture) {
    const productVersion = request.productVersion ?? manifest.compatibility.cohorts[0]?.minProductVersion;
    const runtime = request.runtime ?? manifest.compatibility.cohorts[0]?.runtimes[0];
    const architecture = request.architecture ?? manifest.compatibility.cohorts[0]?.architectures[0];
    const cohort = manifest.compatibility.cohorts.find((candidate) =>
      candidate.productId === V2_ADAPTER_MANIFEST_PRODUCT_ID
      && runtime !== undefined
      && architecture !== undefined
      && candidate.runtimes.includes(runtime)
      && candidate.architectures.includes(architecture)
      && typeof productVersion === 'string'
      && semverSatisfies(productVersion, candidate.minProductVersion, candidate.maxProductVersionExclusive));
    if (!cohort) {
      diagnostics.push(diagnostic(
        'ADAPTER_COHORT_UNSUPPORTED',
        '$.compatibility.cohorts',
        'No adapter compatibility cohort matches the requested product/runtime/architecture.',
      ));
    }
  }

  if (request.payloadBytes !== undefined) {
    if (!Number.isSafeInteger(request.payloadBytes) || request.payloadBytes < 0 || request.payloadBytes > manifest.bounds.maxPayloadBytes) {
      diagnostics.push(diagnostic(
        'ADAPTER_PAYLOAD_TOO_LARGE',
        '$.bounds.maxPayloadBytes',
        'Requested adapter payload exceeds the declared payload bound.',
      ));
    }
  }

  if ((request.paths?.length ?? 0) > V2_ADAPTER_MANIFEST_MAX_PATHS) {
    diagnostics.push(diagnostic(
      'ADAPTER_PATH_OUT_OF_BOUNDS',
      '$.paths',
      'Requested adapter path list exceeds the maximum bounded path count.',
    ));
  }
  for (const candidatePath of request.paths ?? []) {
    if (!pathWithinBounds(candidatePath, manifest.bounds)) {
      diagnostics.push(diagnostic(
        'ADAPTER_PATH_OUT_OF_BOUNDS',
        '$.paths',
        'Adapter path is outside declared bounds; the rejected value is omitted from diagnostics.',
      ));
    }
  }

  if (request.mutationAuthority !== undefined
    && mutationAuthorityRank[manifest.trust.mutationAuthority] < mutationAuthorityRank[request.mutationAuthority]) {
    diagnostics.push(diagnostic(
      'ADAPTER_MUTATION_AUTHORITY_DENIED',
      '$.trust.mutationAuthority',
      'Adapter mutation authority is lower than the requested operation requires.',
    ));
  }

  if (request.mayLoadVendorCode === true && !manifest.trust.loadVendorCode) {
    diagnostics.push(diagnostic(
      'ADAPTER_VENDOR_CODE_LOAD_DENIED',
      '$.trust.loadVendorCode',
      'Adapter did not declare permission to load vendor code.',
    ));
  }
}

function validateProtocolVersions(value: unknown, diagnostics: V2AdapterManifestDiagnostic[]): void {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8) {
    pushInvalid(diagnostics, '$.protocol.supportedVersions', 'Protocol supportedVersions must be a bounded non-empty array.');
    return;
  }

  const seen = new Set<number>();
  for (const version of value) {
    if (!Number.isInteger(version) || version < V2_PROTOCOL_MINIMUM_SUPPORTED_VERSION || version > V2_PROTOCOL_CURRENT_VERSION || seen.has(version)) {
      diagnostics.push(diagnostic(
        'ADAPTER_PROTOCOL_UNSUPPORTED',
        '$.protocol.supportedVersions',
        'Adapter declares an unsupported or duplicate protocol version.',
      ));
      return;
    }
    seen.add(version);
  }

  for (const requiredVersion of requiredProtocolVersions()) {
    if (!seen.has(requiredVersion)) {
      diagnostics.push(diagnostic(
        'ADAPTER_PROTOCOL_UNSUPPORTED',
        '$.protocol.supportedVersions',
        `Adapter must support protocol N/N-1 version ${requiredVersion}.`,
      ));
    }
  }
}

function validateCohorts(value: unknown, diagnostics: V2AdapterManifestDiagnostic[]): void {
  if (!Array.isArray(value) || value.length === 0 || value.length > V2_ADAPTER_MANIFEST_MAX_COHORTS) {
    pushInvalid(diagnostics, '$.compatibility.cohorts', 'Compatibility cohorts must be a bounded non-empty array.');
    return;
  }

  value.forEach((item, index) => {
    const path = `$.compatibility.cohorts[${index}]`;
    const cohort = requireRecord(item, path, cohortKeys, [...cohortKeys], diagnostics);
    if (!cohort) return;
    if (cohort.productId !== V2_ADAPTER_MANIFEST_PRODUCT_ID) {
      pushInvalid(diagnostics, `${path}.productId`, 'Cohort product id is invalid.');
    }
    validateSemver(cohort.minProductVersion, `${path}.minProductVersion`, diagnostics);
    validateSemver(cohort.maxProductVersionExclusive, `${path}.maxProductVersionExclusive`, diagnostics);
    if (typeof cohort.minProductVersion === 'string'
      && typeof cohort.maxProductVersionExclusive === 'string'
      && compareSemver(cohort.minProductVersion, cohort.maxProductVersionExclusive) >= 0) {
      pushInvalid(diagnostics, path, 'Cohort minProductVersion must be lower than maxProductVersionExclusive.');
    }
    validateStringSet(cohort.runtimes, `${path}.runtimes`, supportedRuntimeSet, 'ADAPTER_MANIFEST_FIELD_INVALID', diagnostics);
    validateStringSet(cohort.architectures, `${path}.architectures`, supportedArchitectureSet, 'ADAPTER_MANIFEST_FIELD_INVALID', diagnostics);
  });
}

function validateBounds(value: Record<string, unknown>, diagnostics: V2AdapterManifestDiagnostic[]): void {
  const maxPayloadBytes = value.maxPayloadBytes;
  const maxPathLength = value.maxPathLength;

  if (typeof maxPayloadBytes !== 'number'
    || !Number.isSafeInteger(maxPayloadBytes)
    || maxPayloadBytes < 1
    || maxPayloadBytes > V2_PROTOCOL_MAX_PAYLOAD_BYTES) {
    pushInvalid(diagnostics, '$.bounds.maxPayloadBytes', 'Payload bound must fit inside the v2 protocol byte limit.');
  }
  if (typeof maxPathLength !== 'number'
    || !Number.isSafeInteger(maxPathLength)
    || maxPathLength < 1
    || maxPathLength > 4096) {
    pushInvalid(diagnostics, '$.bounds.maxPathLength', 'Path length bound is invalid.');
  }
  if (value.allowAbsolutePaths !== false) {
    pushInvalid(diagnostics, '$.bounds.allowAbsolutePaths', 'Adapter manifests must reject absolute paths.');
  }
  if (value.allowParentDirectoryTraversal !== false) {
    pushInvalid(diagnostics, '$.bounds.allowParentDirectoryTraversal', 'Adapter manifests must reject parent directory traversal.');
  }
}

function validateStringSet(
  value: unknown,
  path: string,
  allowed: ReadonlySet<string>,
  code: V2AdapterManifestDiagnosticCode,
  diagnostics: V2AdapterManifestDiagnostic[],
): void {
  if (!Array.isArray(value) || value.length === 0 || value.length > V2_PROTOCOL_MAX_CAPABILITIES) {
    diagnostics.push(diagnostic(code, path, 'Field must be a bounded non-empty string array.'));
    return;
  }

  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string' || !allowed.has(item) || seen.has(item)) {
      diagnostics.push(diagnostic(code, path, `Unsupported or duplicate value '${String(item)}'.`));
      return;
    }
    seen.add(item);
  }
}

function validateIdentifier(value: unknown, path: string, diagnostics: V2AdapterManifestDiagnostic[]): void {
  if (typeof value !== 'string' || !identifierRegex.test(value) || value.includes('..')) {
    pushInvalid(diagnostics, path, 'Identifier must be lower-case DNS-style text.');
  }
}

function validateDisplayName(value: unknown, path: string, diagnostics: V2AdapterManifestDiagnostic[]): void {
  if (typeof value !== 'string' || !displayNameRegex.test(value)) {
    pushInvalid(diagnostics, path, 'Display name must be bounded single-line text.');
  }
}

function validateSemver(value: unknown, path: string, diagnostics: V2AdapterManifestDiagnostic[]): void {
  if (typeof value !== 'string' || !semverRegex.test(value)) {
    pushInvalid(diagnostics, path, 'Version must be semantic version text.');
  }
}

function requireRecord(
  value: unknown,
  path: string,
  allowedKeys: ReadonlySet<string>,
  requiredKeys: readonly string[],
  diagnostics: V2AdapterManifestDiagnostic[],
): Record<string, unknown> | null {
  if (!isRecord(value)) {
    diagnostics.push(diagnostic('ADAPTER_MANIFEST_NOT_OBJECT', path, 'Field must be an object.'));
    return null;
  }

  for (const key of Object.keys(value).sort()) {
    if (!allowedKeys.has(key)) {
      diagnostics.push(diagnostic('ADAPTER_MANIFEST_UNKNOWN_FIELD', `${path}.${key}`, 'Adapter manifest field is not allowed.'));
    }
  }
  for (const key of requiredKeys) {
    if (!(key in value)) {
      diagnostics.push(diagnostic('ADAPTER_MANIFEST_FIELD_REQUIRED', `${path}.${key}`, 'Adapter manifest field is required.'));
    }
  }

  return value;
}

function pathWithinBounds(candidatePath: string, bounds: V2AdapterManifest['bounds']): boolean {
  if (typeof candidatePath !== 'string' || candidatePath.length === 0) return false;
  if (Buffer.byteLength(candidatePath, 'utf8') > bounds.maxPathLength) return false;
  if (!bounds.allowAbsolutePaths && isAbsolutePathLike(candidatePath)) return false;
  // Adapter paths are portable workspace-relative identifiers, not native Windows path syntax. Reject drive-relative
  // forms and NTFS alternate-stream syntax as well as ambiguous empty/current-directory segments before any caller can
  // resolve the value against a workspace root.
  if (candidatePath.includes(':')) return false;
  const segments = candidatePath.split(/[\\/]/);
  if (segments.some((segment) => segment.length === 0 || segment === '.')) return false;
  if (!bounds.allowParentDirectoryTraversal && segments.includes('..')) return false;
  return true;
}

function isAbsolutePathLike(candidatePath: string): boolean {
  return candidatePath.startsWith('/')
    || candidatePath.startsWith('\\')
    || /^[A-Za-z]:[\\/]/.test(candidatePath)
    || candidatePath.startsWith('\\\\');
}

function semverSatisfies(version: string, minimum: string, maximumExclusive: string): boolean {
  return semverRegex.test(version)
    && semverRegex.test(minimum)
    && semverRegex.test(maximumExclusive)
    && compareSemver(version, minimum) >= 0
    && compareSemver(version, maximumExclusive) < 0;
}

function compareSemver(left: string, right: string): number {
  const leftParts = left.split('-', 1)[0].split('.').map((part) => Number(part));
  const rightParts = right.split('-', 1)[0].split('.').map((part) => Number(part));
  for (let index = 0; index < 3; index++) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

function requiredProtocolVersions(): number[] {
  return Array.from(new Set([
    Math.max(V2_PROTOCOL_MINIMUM_SUPPORTED_VERSION, V2_PROTOCOL_CURRENT_VERSION - 1),
    V2_PROTOCOL_CURRENT_VERSION,
  ]));
}

function pushInvalid(diagnostics: V2AdapterManifestDiagnostic[], path: string, message: string): void {
  diagnostics.push(diagnostic('ADAPTER_MANIFEST_FIELD_INVALID', path, message));
}

function diagnostic(code: V2AdapterManifestDiagnosticCode, path: string, message: string): V2AdapterManifestDiagnostic {
  return { severity: 'error', code, path, message };
}

function fail(diagnostics: V2AdapterManifestDiagnostic[]): V2AdapterManifestEvaluation {
  return {
    ok: false,
    diagnostics,
    manifestDeclaresVendorCodeLoad: false,
    manifestDeclaresWorkspaceMutation: false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
