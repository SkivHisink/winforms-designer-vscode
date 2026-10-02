import type { RenderDiagItem } from './renderDiagnostics';

export type RecoveryActionId = 'retry' | 'rebuild' | 'chooseAssembly' | 'viewCode' | 'clearCache' | 'restart';
export type DesignerDiagnosticSeverity = 'info' | 'warning' | 'error';

interface ReasonDefinition {
  readonly severity: DesignerDiagnosticSeverity;
  readonly message: string;
  readonly actions: readonly RecoveryActionId[];
}

/** Messages and executable actions come from this catalogue, never from an engine exception or webview payload. */
export const DESIGNER_DIAGNOSTIC_REASONS = {
  UNKNOWN_REASON: { severity: 'warning', message: 'The designer could not classify this condition. Inspect the source before making changes.', actions: ['viewCode'] },
  MISSING_TYPE: { severity: 'error', message: 'A control type could not be resolved. Build the project or select its control assembly.', actions: ['rebuild', 'chooseAssembly', 'viewCode'] },
  CONTROL_INITIALIZATION_FAILED: { severity: 'warning', message: 'A control could not be initialized. Its preview may be incomplete.', actions: ['viewCode', 'rebuild', 'retry'] },
  UNSUPPORTED_CONSTRUCT: { severity: 'warning', message: 'A source construct cannot be represented on the canvas. Inspect its source.', actions: ['viewCode'] },
  RENDER_FAILED: { severity: 'error', message: 'The current render failed. Any retained preview may be stale.', actions: ['retry', 'viewCode'] },
  ENGINE_UNAVAILABLE: { severity: 'error', message: 'The selected design engine is unavailable. Restart it and retry the render.', actions: ['restart', 'retry'] },
  ENGINE_CRASH_LOOP: { severity: 'error', message: 'Automatic engine recovery stopped after repeated failures. Inspect the source before restarting.', actions: ['viewCode', 'restart'] },
  CACHE_CORRUPT: { severity: 'warning', message: 'The rebuildable control cache is invalid. Clear that cache and discover controls again.', actions: ['clearCache'] },
  CACHE_WRITE_FAILED: { severity: 'warning', message: 'The control cache could not be saved. Rebuild the cache to retry.', actions: ['clearCache'] },
  STATE_MIGRATION_FAILED: { severity: 'warning', message: 'Saved toolbox preferences could not be migrated. Reload the window to retry; the original preferences are retained.', actions: [] },
  PERSISTED_STATE_INVALID: { severity: 'warning', message: 'Saved designer preferences are invalid; only their valid parts are used. The saved data is kept until the designer next stores that preference.', actions: [] },
  ASSEMBLY_UNRESOLVED: { severity: 'error', message: 'The control assembly could not be resolved. Build the project or select an assembly.', actions: ['rebuild', 'chooseAssembly'] },
  COMPILED_PREVIEW: { severity: 'info', message: 'The preview comes from the last build. Rebuild to include current source changes.', actions: ['rebuild'] },
  INHERITED_PREVIEW_INCOMPLETE: { severity: 'warning', message: 'Inherited controls may be missing from this preview.', actions: ['viewCode', 'rebuild'] },
  BINARY_RESOURCE_UNSUPPORTED: { severity: 'warning', message: 'A binary resource cannot be represented by the current preview.', actions: ['viewCode'] },
  DOCUMENT_CHANGED: { severity: 'warning', message: 'The source changed while an operation was running. Render the current revision before retrying.', actions: ['retry', 'viewCode'] },
  AMBIGUOUS_OWNER: { severity: 'error', message: 'More than one candidate owns this designer document. Resolve the source ambiguity.', actions: ['viewCode'] },
  NESTED_DESIGNER_UNSUPPORTED: { severity: 'error', message: 'A nested designer class is not supported by this editor.', actions: ['viewCode'] },
  MISSING_INITIALIZE_COMPONENT: { severity: 'error', message: 'The designer initialization method could not be resolved.', actions: ['viewCode'] },
  X86_NOT_SUPPORTED: { severity: 'error', message: 'This project or dependency requires an x86 design process, which is not supported.', actions: ['viewCode', 'chooseAssembly'] },
  X86_WORKER_UNAVAILABLE: { severity: 'error', message: 'This project or dependency requires an x86 design process, which is not available.', actions: ['viewCode', 'chooseAssembly'] },
  ARCHITECTURE_UNKNOWN: { severity: 'warning', message: 'The available metadata cannot establish architecture compatibility. Successful loading is not confirmed.', actions: ['rebuild', 'viewCode'] },
  ARCHITECTURE_MISMATCH: { severity: 'error', message: 'The assembly architecture is incompatible with the selected design process.', actions: ['rebuild', 'chooseAssembly'] },
  COM_ACTIVEX_UNSUPPORTED: { severity: 'error', message: 'COM and ActiveX designer requests are not supported.', actions: ['viewCode'] },
  COM_ACTIVE_X_UNSUPPORTED: { severity: 'error', message: 'COM and ActiveX designer requests are not supported.', actions: ['viewCode'] },
  WORKSPACE_TRUST_REQUIRED: { severity: 'error', message: 'Design-time execution requires a trusted workspace. Review the project before enabling trust.', actions: ['viewCode'] },
  DEPENDENCY_ARCHITECTURE_MISMATCH: { severity: 'error', message: 'A dependency architecture is incompatible with the selected design process.', actions: ['rebuild', 'chooseAssembly'] },
  OUTPUT_ARCHITECTURE_MISMATCH: { severity: 'error', message: 'The built assembly architecture is incompatible with the selected design process.', actions: ['rebuild', 'chooseAssembly'] },
  PROJECT_ARCHITECTURE_MISMATCH: { severity: 'error', message: 'The evaluated project architecture is incompatible with the selected design process.', actions: ['viewCode', 'rebuild'] },
  OUTPUT_NOT_MANAGED: { severity: 'error', message: 'The selected output is not a managed assembly that the designer can load.', actions: ['chooseAssembly', 'rebuild'] },
  DEPENDENCY_ARCHITECTURE_UNKNOWN: { severity: 'warning', message: 'The architecture of a dependency could not be established. Successful loading is not confirmed.', actions: ['rebuild', 'viewCode'] },
  ARCHITECTURE_COMPATIBLE: { severity: 'info', message: 'The inspected architecture metadata is compatible with the selected design process.', actions: [] },
  ADAPTER_MANIFEST_MALFORMED_JSON: { severity: 'error', message: 'The adapter manifest is not valid JSON.', actions: ['viewCode'] },
  ADAPTER_MANIFEST_NOT_OBJECT: { severity: 'error', message: 'The adapter manifest must be a JSON object.', actions: ['viewCode'] },
  ADAPTER_MANIFEST_UNKNOWN_FIELD: { severity: 'error', message: 'The adapter manifest contains an unknown field.', actions: ['viewCode'] },
  ADAPTER_MANIFEST_FIELD_REQUIRED: { severity: 'error', message: 'The adapter manifest is missing a required field.', actions: ['viewCode'] },
  ADAPTER_MANIFEST_FIELD_INVALID: { severity: 'error', message: 'An adapter manifest field is invalid.', actions: ['viewCode'] },
  ADAPTER_PROTOCOL_UNSUPPORTED: { severity: 'error', message: 'The adapter protocol version is not supported.', actions: ['viewCode'] },
  ADAPTER_CAPABILITY_UNDECLARED: { severity: 'error', message: 'The adapter does not declare a required capability.', actions: ['viewCode'] },
  ADAPTER_COHORT_UNSUPPORTED: { severity: 'error', message: 'The adapter declaration does not support this product version, runtime or architecture.', actions: ['viewCode'] },
  ADAPTER_PAYLOAD_TOO_LARGE: { severity: 'error', message: 'The adapter request exceeds its declared size limit.', actions: ['viewCode'] },
  ADAPTER_PATH_OUT_OF_BOUNDS: { severity: 'error', message: 'An adapter path is outside the permitted scope.', actions: ['viewCode'] },
  ADAPTER_MUTATION_AUTHORITY_DENIED: { severity: 'error', message: 'The adapter declaration does not grant the requested editing authority.', actions: ['viewCode'] },
  ADAPTER_VENDOR_CODE_LOAD_DENIED: { severity: 'error', message: 'The adapter declaration does not authorize loading vendor code.', actions: ['viewCode'] },
  ADAPTER_MANIFEST_READ_FAILED: { severity: 'error', message: 'The adapter manifest could not be read.', actions: ['viewCode'] },
  ADAPTER_MANIFEST_FILE_TOO_LARGE: { severity: 'error', message: 'The adapter manifest exceeds the file size limit.', actions: ['viewCode'] },
  ADAPTER_IDENTITY_DUPLICATE: { severity: 'error', message: 'More than one manifest declares the same adapter identity. Resolve the duplicate declaration.', actions: ['viewCode'] },
} as const satisfies Record<string, ReasonDefinition>;

export type DesignerDiagnosticCode = keyof typeof DESIGNER_DIAGNOSTIC_REASONS;
export interface DesignerDiagnosticContext {
  target?: unknown;
  control?: unknown;
  property?: unknown;
  assembly?: unknown;
}
export interface DesignerDiagnostic extends ReasonDefinition {
  readonly code: DesignerDiagnosticCode;
  readonly target?: string;
  readonly control?: string;
  readonly property?: string;
  readonly assembly?: string;
}

/** Local UI identity only. Paths, source statements, exception messages and assembly-qualified values are refused. */
function identity(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 160 && /^[A-Za-z_][A-Za-z0-9_.+`]*$/.test(value)
    ? value : undefined;
}

export function createDesignerDiagnostic(code: unknown, context: DesignerDiagnosticContext = {}): DesignerDiagnostic {
  const known = typeof code === 'string' && Object.prototype.hasOwnProperty.call(DESIGNER_DIAGNOSTIC_REASONS, code)
    ? code as DesignerDiagnosticCode : 'UNKNOWN_REASON';
  const definition = DESIGNER_DIAGNOSTIC_REASONS[known];
  return {
    code: known, severity: definition.severity, message: definition.message, actions: [...definition.actions],
    target: identity(context.target), control: identity(context.control),
    property: identity(context.property), assembly: identity(context.assembly),
  };
}

/** Raw statement text and exception detail deliberately do not cross into the reason catalogue. */
export function diagnosticsFromRenderItems(items: readonly RenderDiagItem[]): DesignerDiagnostic[] {
  return items.slice(0, 1_000).map((item) => createDesignerDiagnostic(
    item.category === 'missingType' ? 'MISSING_TYPE'
      : item.category === 'initError' ? 'CONTROL_INITIALIZATION_FAILED'
        : item.category === 'unsupported' ? 'UNSUPPORTED_CONSTRUCT' : 'UNKNOWN_REASON',
    { target: item.target, control: item.target?.startsWith('this.') ? item.target.slice(5) : undefined },
  ));
}

export interface DesignerDiagnosticSnapshot {
  generatedAt?: string;
  correlationId?: string;
  versions?: { extension?: string; vscode?: string; node?: string };
  platform?: string;
  architecture?: string;
  workspaceTrusted?: boolean;
  engines?: readonly {
    kind: 'modern' | 'net48'; running?: boolean; starts?: number; recentCrashes?: number;
    lastStartupMs?: number; lastExitCode?: number | null;
  }[];
  session?: {
    engineKind?: 'modern' | 'net48'; net48RenderMode?: string; renderOk?: boolean; dirty?: boolean;
    revision?: number; controlCount?: number; componentCount?: number; representable?: number;
    totalStatements?: number; roundTripSafe?: boolean;
  };
  capabilities?: { engine?: string; runtime?: string; render?: boolean; edit?: boolean; livePreviewUnsavedEdits?: boolean };
  timings?: Readonly<Record<string, number>>;
  diagnostics?: readonly DesignerDiagnostic[];
}

export interface DesignerDiagnosticBundleLimits { maxBytes?: number; maxDiagnostics?: number }
export interface DesignerDiagnosticBundle {
  schema: 'winforms-designer.diagnostics';
  schemaVersion: 1;
  privacy: {
    sourceIncluded: false; propertyValuesIncluded: false; rawErrorsIncluded: false; pathsIncluded: false;
    identities: 'pseudonymized';
  };
  generatedAt?: string;
  correlationId?: string;
  versions?: DesignerDiagnosticSnapshot['versions'];
  environment?: { platform?: string; architecture?: string; workspaceTrusted?: boolean };
  engines?: DesignerDiagnosticSnapshot['engines'];
  session?: DesignerDiagnosticSnapshot['session'];
  capabilities?: DesignerDiagnosticSnapshot['capabilities'];
  timings?: Record<string, number>;
  diagnostics: DesignerDiagnostic[];
  truncation: { truncated: boolean; omittedDiagnostics: number; omittedSections: number; invalidFields: number; maxBytes: number };
}

const DEFAULT_MAX_BYTES = 64 * 1024;
const MAX_DIAGNOSTICS = 100;
const MIN_MAX_BYTES = 1024;
const TIMING_KEYS = [
  'pingMs', 'startupMs', 'modelMs', 'captureMs', 'previewMs', 'reconciliationMs', 'totalMeasuredMs',
  'plannerMs', 'commitMs', 'reconcileMs', 'trailingPropertiesMs',
] as const;

/**
 * A structured export boundary, not a general-purpose text redactor. Only explicitly selected scalar facts are
 * copied. No source, values, logs, settings, URIs, raw reason/message/exception fields, or arbitrary nested objects
 * are serialized. Local identifiers become per-bundle labels, so even a secret disguised as a valid identifier is
 * absent. The result is bounded complete JSON; shrinking a bundle never slices a JSON string or a UTF-8 sequence.
 */
export function buildDesignerDiagnosticBundle(
  snapshot: DesignerDiagnosticSnapshot, limits: DesignerDiagnosticBundleLimits = {},
): { json: string; bundle: DesignerDiagnosticBundle; byteLength: number } {
  const maxBytes = boundedLimit(limits.maxBytes, DEFAULT_MAX_BYTES, MIN_MAX_BYTES, DEFAULT_MAX_BYTES);
  const maxDiagnostics = boundedLimit(limits.maxDiagnostics, MAX_DIAGNOSTICS, 0, MAX_DIAGNOSTICS);
  const bundle: DesignerDiagnosticBundle = {
    schema: 'winforms-designer.diagnostics', schemaVersion: 1,
    privacy: { sourceIncluded: false, propertyValuesIncluded: false, rawErrorsIncluded: false, pathsIncluded: false, identities: 'pseudonymized' },
    diagnostics: [],
    truncation: { truncated: false, omittedDiagnostics: 0, omittedSections: 0, invalidFields: 0, maxBytes },
  };
  const rejected = (): undefined => { bundle.truncation.invalidFields++; return undefined; };
  const numeric = (value: unknown, integer = false, signed = false): number | undefined => value === undefined ? undefined
    : typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER
      && (signed || value >= 0) && (!integer || Number.isInteger(value)) ? value : rejected();
  const bool = (value: unknown): boolean | undefined => value === undefined ? undefined
    : typeof value === 'boolean' ? value : rejected();
  const member = <T extends string>(value: unknown, allowed: readonly T[]): T | undefined => value === undefined ? undefined
    : typeof value === 'string' && allowed.includes(value as T) ? value as T : rejected();
  const version = (value: unknown): string | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || value.length > 64) return rejected();
    // Keep numeric release identity; arbitrary prerelease/build labels are intentionally omitted.
    const match = /^(\d{1,6}\.\d{1,6}\.\d{1,6})(?:[-+][A-Za-z0-9.-]+)?$/.exec(value);
    return match ? match[1] : rejected();
  };
  if (snapshot.generatedAt !== undefined) {
    if (typeof snapshot.generatedAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(snapshot.generatedAt)
      && Number.isFinite(Date.parse(snapshot.generatedAt))) bundle.generatedAt = snapshot.generatedAt;
    else rejected();
  }
  if (snapshot.correlationId !== undefined) {
    if (typeof snapshot.correlationId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(snapshot.correlationId))
      bundle.correlationId = snapshot.correlationId;
    else rejected();
  }
  if (snapshot.versions) bundle.versions = {
    extension: version(snapshot.versions.extension), vscode: version(snapshot.versions.vscode), node: version(snapshot.versions.node),
  };
  bundle.environment = {
    platform: member(snapshot.platform, ['win32', 'linux', 'darwin']),
    architecture: member(snapshot.architecture, ['x64', 'arm64', 'ia32']), workspaceTrusted: bool(snapshot.workspaceTrusted),
  };
  if (Array.isArray(snapshot.engines)) {
    const engines: NonNullable<DesignerDiagnosticBundle['engines']>[number][] = [];
    for (const raw of snapshot.engines.slice(0, 2)) {
      if (!raw || typeof raw !== 'object') { rejected(); continue; }
      const kind = member(raw.kind, ['modern', 'net48']);
      if (!kind || engines.some((engine) => engine.kind === kind)) { rejected(); continue; }
      engines.push({
        kind, running: bool(raw.running), starts: numeric(raw.starts, true), recentCrashes: numeric(raw.recentCrashes, true),
        lastStartupMs: numeric(raw.lastStartupMs), lastExitCode: raw.lastExitCode === null ? null : numeric(raw.lastExitCode, true, true),
      });
    }
    bundle.engines = engines;
    if (snapshot.engines.length > 2) bundle.truncation.omittedSections++;
  }
  if (snapshot.session) {
    const s = snapshot.session;
    bundle.session = {
      engineKind: member(s.engineKind, ['modern', 'net48']),
      net48RenderMode: member(s.net48RenderMode, ['interpreted', 'compiledFallback', 'compiled']),
      renderOk: bool(s.renderOk), dirty: bool(s.dirty), revision: numeric(s.revision, true),
      controlCount: numeric(s.controlCount, true), componentCount: numeric(s.componentCount, true),
      representable: numeric(s.representable, true), totalStatements: numeric(s.totalStatements, true), roundTripSafe: bool(s.roundTripSafe),
    };
  }
  if (snapshot.capabilities) {
    const c = snapshot.capabilities;
    const runtime = c.runtime === undefined ? undefined
      : typeof c.runtime === 'string' && /^\.NET(?: Framework| Core)? \d{1,6}\.\d{1,6}(?:\.\d{1,6}){0,2}$/.test(c.runtime)
        ? c.runtime : rejected();
    bundle.capabilities = {
      engine: member(c.engine, ['modern', 'net9', 'net10', 'net48', 'modern-interpreted', 'net48-compiled']), runtime,
      render: bool(c.render), edit: bool(c.edit),
      livePreviewUnsavedEdits: bool(c.livePreviewUnsavedEdits),
    };
  }
  if (snapshot.timings) {
    bundle.timings = {};
    for (const key of TIMING_KEYS) {
      const value = numeric(snapshot.timings[key]);
      if (value !== undefined) bundle.timings[key] = value;
    }
  }
  const labels = new Map<string, string>();
  const label = (kind: string, value: unknown): string | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || value.length === 0 || value.length > 1024) return rejected();
    const key = `${kind}:${value}`;
    if (!labels.has(key)) labels.set(key, `${kind}-${labels.size + 1}`);
    return labels.get(key);
  };
  const diagnostics = Array.isArray(snapshot.diagnostics) ? snapshot.diagnostics : [];
  bundle.truncation.omittedDiagnostics = Math.max(0, diagnostics.length - maxDiagnostics);
  for (const raw of diagnostics.slice(0, maxDiagnostics)) {
    if (!raw || typeof raw !== 'object') { rejected(); bundle.truncation.omittedDiagnostics++; continue; }
    // Recreate even typed input: a caller cannot smuggle an arbitrary message, action, or severity into the export.
    const safe = createDesignerDiagnostic(raw.code);
    bundle.diagnostics.push({
      ...safe, target: label('target', raw.target), control: label('control', raw.control),
      property: label('property', raw.property), assembly: label('assembly', raw.assembly),
    });
  }
  const encode = (): string => {
    bundle.truncation.truncated = bundle.truncation.omittedDiagnostics > 0 || bundle.truncation.omittedSections > 0;
    return JSON.stringify(bundle, null, 2);
  };
  let json = encode();
  while (Buffer.byteLength(json, 'utf8') > maxBytes && bundle.diagnostics.length > 0) {
    bundle.diagnostics.pop(); bundle.truncation.omittedDiagnostics++; json = encode();
  }
  for (const key of ['timings', 'engines', 'session', 'capabilities', 'versions', 'environment', 'generatedAt', 'correlationId'] as const) {
    if (Buffer.byteLength(json, 'utf8') <= maxBytes) break;
    if (bundle[key] !== undefined) { delete bundle[key]; bundle.truncation.omittedSections++; json = encode(); }
  }
  return { json, bundle, byteLength: Buffer.byteLength(json, 'utf8') };
}

function boundedLimit(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw new RangeError(`Diagnostic limit must be an integer from ${min} to ${max}.`);
  return value;
}
