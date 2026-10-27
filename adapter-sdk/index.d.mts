export declare const SDK_VERSION: '0.1.0';
export declare const PACKAGE_SCHEMA_ID: 'winforms-designer.adapter-package';
export declare const PACKAGE_SCHEMA_VERSION: 1;
export declare const PROTOCOL_ID: 'winforms-designer.adapter-stdio';
export declare const PROTOCOL_VERSION: 1;
export declare const MAX_MESSAGE_BYTES: 65536;
export declare const MAX_PACKAGE_FILES: 16;
export declare const MAX_PACKAGE_FILE_BYTES: 1048576;
export declare const MAX_PACKAGE_BYTES: 4194304;
export declare const MAX_EXECUTION_MS: 5000;
export declare const MAX_INVARIANT_BYTES: 8192;
export type PropertyType = 'System.String' | 'System.Boolean' | 'System.Int32';
export type AdapterCapability = 'action.set-property' | 'editor.scalar';
export type ServiceId = 'ContainerSiting' | 'Naming' | 'ComponentChange' | 'Selection' | 'Transactions' | 'MenuCommands' | 'ToolboxCatalog' | 'TypeResolution' | 'PropertySerialization';
export declare const PROPERTY_TYPES: readonly PropertyType[];
export declare const CAPABILITIES: readonly AdapterCapability[];
export declare const SERVICE_IDS: readonly ServiceId[];
export interface AdapterContribution { id: string; title: string; propertyName: string; propertyType: PropertyType; disabledReasonCode?: string }
export interface AdapterEditorContribution extends AdapterContribution { presentation?: 'input' | 'dropdown'; choices?: string[] }
export interface AdapterPackage {
  schemaId: typeof PACKAGE_SCHEMA_ID; schemaVersion: 1; sdkVersion: typeof SDK_VERSION;
  adapter: { id: string; version: string; displayName: string };
  cohort: { productId: 'winforms-designer-vscode'; minProductVersion: string; maxProductVersionExclusive: string;
    runtimes: ('modern' | 'net48')[]; architectures: ('x64' | 'arm64')[] };
  execution: { kind: 'node-stdio'; entrypoint: string };
  integrity: { algorithm: 'sha256'; files: { path: string; sha256: string }[] };
  provenance: { policy: 'local-development'; certification: 'none' };
  capabilities: AdapterCapability[];
  requiredServices?: ServiceId[];
  contributions: { actions: AdapterContribution[]; editors: AdapterEditorContribution[] };
}
export interface AdapterRequest {
  protocolId: typeof PROTOCOL_ID; protocolVersion: 1; id: string;
  operation: 'invokeAction' | 'editProperty'; contributionId: string;
  context: { componentId: string; propertyName: string; propertyType: PropertyType; invariantValue: string; revision: number };
  input: { invariantValue?: string; cancel?: boolean };
}
export interface SetPropertyIntent {
  kind: 'setProperty'; componentId: string; propertyName: string; propertyType: PropertyType; invariantValue: string;
}
export type AdapterOutcome = { status: 'ok'; intent: SetPropertyIntent } | { status: 'refused'; code: string } | { status: 'cancelled' };
export type AdapterResponse = { protocolId: typeof PROTOCOL_ID; protocolVersion: 1; id: string } & AdapterOutcome;
export type ValidationResult<T> = { ok: true; value: T } | { ok: false; diagnostics: { code: string; path: string }[] };
export type AdapterHandler = (request: Readonly<AdapterRequest>) => AdapterResponse | Promise<AdapterResponse>;
export declare function validateAdapterPackage(value: unknown): ValidationResult<AdapterPackage>;
export declare function validateAdapterRequest(value: unknown, contribution?: AdapterContribution | AdapterEditorContribution): ValidationResult<AdapterRequest>;
export declare function validateAdapterResponse(value: unknown, request?: AdapterRequest, contribution?: AdapterContribution | AdapterEditorContribution): ValidationResult<AdapterResponse>;
export declare function isPackagePath(value: unknown): value is string;
export declare function serveAdapter(handler: AdapterHandler, streams?: { input?: AsyncIterable<Uint8Array | string>; output?: { write(text: string): unknown } }): Promise<void>;
export declare function responseFor(request: AdapterRequest, result: AdapterOutcome): AdapterResponse;
