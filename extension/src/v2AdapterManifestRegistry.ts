import * as vscode from 'vscode';
import {
  V2AdapterManifest,
  V2AdapterManifestArchitecture,
  V2AdapterManifestDiagnosticCode,
  V2AdapterManifestRuntime,
  validateV2AdapterManifestCompatibilityCohort,
  validateV2AdapterManifestJson,
} from './v2AdapterManifest';

/**
 * Product discovery is deliberately manifest-only. A discovered declaration can contribute compatibility
 * diagnostics, but this registry never loads an adapter assembly, invokes vendor code, grants mutation authority,
 * or writes a workspace file. Those capabilities require separate, explicitly certified product routes.
 */
export const V2_ADAPTER_MANIFEST_WORKSPACE_GLOB = '**/.winforms-designer/adapter-manifest.json';
export const V2_ADAPTER_MANIFEST_DISCOVERY_LIMIT = 64;
export const V2_ADAPTER_MANIFEST_FILE_BYTE_LIMIT = 256 * 1024;
export const V2_ADAPTER_MANIFEST_DIAGNOSTIC_LIMIT = 32;
export const V2_ADAPTER_MANIFEST_DIAGNOSTIC_MESSAGE_LIMIT = 1024;

export type V2AdapterManifestRegistryDiagnosticCode = V2AdapterManifestDiagnosticCode
  | 'ADAPTER_MANIFEST_READ_FAILED'
  | 'ADAPTER_MANIFEST_FILE_TOO_LARGE'
  | 'ADAPTER_IDENTITY_DUPLICATE';

export interface V2AdapterManifestInspectionContext {
  readonly runtime?: V2AdapterManifestRuntime;
  readonly architecture?: V2AdapterManifestArchitecture;
}

export interface V2AdapterManifestRegistryDiagnostic {
  readonly code: V2AdapterManifestRegistryDiagnosticCode;
  readonly message: string;
  readonly path?: string;
}

export interface V2AdapterManifestProductStatus {
  readonly uri: string;
  readonly ok: boolean;
  /** Static schema validity is independent of the inspected runtime and architecture. */
  readonly manifestValid: boolean;
  readonly compatibilityState: 'compatible' | 'incompatible' | 'invalid' | 'duplicate';
  readonly compatibilityContext: V2AdapterManifestInspectionContext & { readonly productVersion: string };
  readonly adapterId: string | null;
  readonly adapterVersion: string | null;
  readonly supportedProtocolVersions: readonly number[];
  readonly compatibilityCohorts: readonly {
    readonly minProductVersion: string;
    readonly maxProductVersionExclusive: string;
    readonly runtimes: readonly V2AdapterManifestRuntime[];
    readonly architectures: readonly V2AdapterManifestArchitecture[];
  }[];
  readonly capabilities: readonly string[];
  readonly unsupportedFeatures: readonly string[];
  readonly diagnosticCodes: readonly V2AdapterManifestRegistryDiagnosticCode[];
  readonly diagnostics: readonly V2AdapterManifestRegistryDiagnostic[];
  readonly diagnosticsTruncated: boolean;
  readonly manifestDeclaresVendorCodeLoad: boolean;
  readonly manifestDeclaresWorkspaceMutation: boolean;
  /** Product invariant: declaration is not execution. */
  readonly vendorCodeLoaded: false;
  /** Product invariant: discovery is read-only even when a manifest requests a source-first cohort. */
  readonly workspaceMutationAuthorityGranted: false;
}

export class V2AdapterManifestRegistry implements vscode.Disposable {
  private readonly diagnostics = vscode.languages.createDiagnosticCollection('winformsDesigner.adapterManifests');
  private readonly watcher: vscode.FileSystemWatcher;
  private readonly disposables: vscode.Disposable[] = [];
  private latest: readonly V2AdapterManifestProductStatus[] = [];
  private refreshGeneration = 0;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(
    private readonly productVersion: string,
    private readonly output: vscode.OutputChannel,
  ) {
    this.watcher = vscode.workspace.createFileSystemWatcher(V2_ADAPTER_MANIFEST_WORKSPACE_GLOB);
    this.disposables.push(
      this.watcher,
      this.watcher.onDidCreate(() => this.scheduleRefresh()),
      this.watcher.onDidChange(() => this.scheduleRefresh()),
      this.watcher.onDidDelete(() => this.scheduleRefresh()),
    );
  }

  snapshot(): readonly V2AdapterManifestProductStatus[] {
    return this.latest.map((status) => ({
      ...status,
      compatibilityContext: { ...status.compatibilityContext },
      supportedProtocolVersions: [...status.supportedProtocolVersions],
      compatibilityCohorts: status.compatibilityCohorts.map((cohort) => ({
        ...cohort,
        runtimes: [...cohort.runtimes],
        architectures: [...cohort.architectures],
      })),
      capabilities: [...status.capabilities],
      unsupportedFeatures: [...status.unsupportedFeatures],
      diagnosticCodes: [...status.diagnosticCodes],
      diagnostics: status.diagnostics.map((item) => ({ ...item })),
    }));
  }

  /** Inspect a form without changing the workspace snapshot or global Problems diagnostics. */
  snapshotForContext(context: V2AdapterManifestInspectionContext): readonly V2AdapterManifestProductStatus[] {
    return this.snapshot().map((status) => {
      const compatibilityContext = {
        productVersion: this.productVersion,
        runtime: context.runtime,
        architecture: context.architecture,
      };
      if (!status.manifestValid) return { ...status, compatibilityContext };
      const diagnostics = [
        ...status.diagnostics.filter((item) => item.code !== 'ADAPTER_COHORT_UNSUPPORTED'),
        ...validateV2AdapterManifestCompatibilityCohort({
          productId: 'winforms-designer-vscode',
          cohorts: status.compatibilityCohorts.map((cohort) => ({
            ...cohort,
            productId: 'winforms-designer-vscode',
            runtimes: [...cohort.runtimes],
            architectures: [...cohort.architectures],
          })),
        }, compatibilityContext),
      ];
      return withDiagnostics({ ...status, compatibilityContext }, diagnostics);
    });
  }

  async refresh(): Promise<readonly V2AdapterManifestProductStatus[]> {
    if (this.disposed) return this.snapshot();
    const generation = ++this.refreshGeneration;
    const uris = await this.discoverManifestUris();
    if (this.disposed || generation !== this.refreshGeneration) return this.snapshot();
    const entries: { uri: vscode.Uri; status: V2AdapterManifestProductStatus }[] = [];

    for (const uri of uris) {
      const status = await this.evaluateUri(uri);
      if (this.disposed || generation !== this.refreshGeneration) return this.snapshot();
      entries.push({ uri, status });
    }

    const identityCounts = new Map<string, number>();
    for (const { status } of entries) {
      if (status.adapterId) identityCounts.set(status.adapterId, (identityCounts.get(status.adapterId) ?? 0) + 1);
    }
    const next = entries.map(({ status }) => {
      const count = status.adapterId ? identityCounts.get(status.adapterId) ?? 0 : 0;
      return count < 2 ? status : withDiagnostics(status, [...status.diagnostics, {
        code: 'ADAPTER_IDENTITY_DUPLICATE',
        path: '$.adapter.id',
        message: `Adapter identity '${status.adapterId}' is declared by ${count} discovered manifests. Keep one declaration for this identity or assign distinct adapter IDs; no duplicate is accepted.`,
      }]);
    });

    if (this.disposed || generation !== this.refreshGeneration) return this.snapshot();
    this.diagnostics.clear();
    entries.forEach((entry, index) => this.diagnostics.set(entry.uri, next[index].diagnostics.map(toVscodeDiagnostic)));
    this.latest = next;
    const accepted = next.filter((status) => status.ok).length;
    const refused = next.length - accepted;
    this.output.appendLine(
      `[adapter manifests] discovered=${next.length}; accepted=${accepted}; refused=${refused}; vendorCodeLoaded=false; mutationAuthorityGranted=false`,
    );
    return this.snapshot();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.refreshGeneration++;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
    this.diagnostics.dispose();
    this.latest = [];
  }

  private scheduleRefresh(): void {
    if (this.disposed) return;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh().catch(() => {
        // Filesystem/provider errors may contain private workspace paths or arbitrary content.
        this.output.appendLine('[adapter manifests] refresh failed; retry manifest discovery after checking workspace access.');
      });
    }, 75);
  }

  private async discoverManifestUris(): Promise<vscode.Uri[]> {
    const discovered = await vscode.workspace.findFiles(
      V2_ADAPTER_MANIFEST_WORKSPACE_GLOB,
      undefined,
      V2_ADAPTER_MANIFEST_DISCOVERY_LIMIT + 1,
    );
    const unique = new Map(discovered.map((uri) => [uri.toString(), uri]));
    const ordered = [...unique.values()]
      .filter((uri) => uri.scheme === 'file')
      .sort((left, right) => left.toString().localeCompare(right.toString(), 'en'));
    if (ordered.length > V2_ADAPTER_MANIFEST_DISCOVERY_LIMIT) {
      this.output.appendLine(
        `[adapter manifests] discovery refused entries beyond ${V2_ADAPTER_MANIFEST_DISCOVERY_LIMIT}`,
      );
    }
    return ordered.slice(0, V2_ADAPTER_MANIFEST_DISCOVERY_LIMIT);
  }

  private async evaluateUri(uri: vscode.Uri): Promise<V2AdapterManifestProductStatus> {
    let bytes: Uint8Array;
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > V2_ADAPTER_MANIFEST_FILE_BYTE_LIMIT) {
        const diagnostic: V2AdapterManifestRegistryDiagnostic = {
          code: 'ADAPTER_MANIFEST_FILE_TOO_LARGE',
          message: `Adapter manifest exceeds the ${V2_ADAPTER_MANIFEST_FILE_BYTE_LIMIT}-byte product discovery limit. Reduce the manifest size and retry discovery.`,
        };
        return statusFrom(null, uri, this.productVersion, [diagnostic]);
      }
      bytes = await vscode.workspace.fs.readFile(uri);
      // Recheck the actual bytes: a file may grow between stat and readFile.
      if (bytes.byteLength > V2_ADAPTER_MANIFEST_FILE_BYTE_LIMIT) {
        return statusFrom(null, uri, this.productVersion, [{
          code: 'ADAPTER_MANIFEST_FILE_TOO_LARGE',
          message: `Adapter manifest exceeds the ${V2_ADAPTER_MANIFEST_FILE_BYTE_LIMIT}-byte product discovery limit. Reduce the manifest size and retry discovery.`,
        }]);
      }
    } catch {
      const diagnostic: V2AdapterManifestRegistryDiagnostic = {
        code: 'ADAPTER_MANIFEST_READ_FAILED',
        message: 'Adapter manifest could not be read. Check file permissions and retry discovery.',
      };
      return statusFrom(null, uri, this.productVersion, [diagnostic]);
    }

    const evaluation = validateV2AdapterManifestJson(Buffer.from(bytes).toString('utf8'), {
      productVersion: this.productVersion,
      requiredCapabilities: [
        'adapter.manifest-v1',
        'adapter.compatibility-v1',
        'diagnostics.machine-readable',
      ],
    });
    const diagnostics: V2AdapterManifestRegistryDiagnostic[] = evaluation.diagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      message: diagnostic.message,
      path: diagnostic.path,
    }));
    return statusFrom(evaluation.manifest ?? null, uri, this.productVersion, diagnostics);
  }
}

function statusFrom(
  manifest: V2AdapterManifest | null,
  uri: vscode.Uri,
  productVersion: string,
  diagnostics: readonly V2AdapterManifestRegistryDiagnostic[],
): V2AdapterManifestProductStatus {
  return withDiagnostics({
    uri: uri.toString(),
    ok: diagnostics.length === 0 && manifest !== null,
    manifestValid: manifest !== null,
    compatibilityState: manifest === null ? 'invalid' : 'compatible',
    compatibilityContext: { productVersion },
    adapterId: manifest?.adapter.id ?? null,
    adapterVersion: manifest?.adapter.version ?? null,
    supportedProtocolVersions: [...(manifest?.protocol.supportedVersions ?? [])],
    compatibilityCohorts: (manifest?.compatibility.cohorts ?? []).map((cohort) => ({
      minProductVersion: cohort.minProductVersion,
      maxProductVersionExclusive: cohort.maxProductVersionExclusive,
      runtimes: [...cohort.runtimes],
      architectures: [...cohort.architectures],
    })),
    capabilities: [...(manifest?.capabilities ?? [])],
    unsupportedFeatures: [...(manifest?.unsupportedFeatures ?? [])],
    diagnosticCodes: [],
    diagnostics: [],
    diagnosticsTruncated: false,
    manifestDeclaresVendorCodeLoad: manifest?.trust.loadVendorCode ?? false,
    manifestDeclaresWorkspaceMutation: manifest !== null && manifest.trust.mutationAuthority !== 'none',
    vendorCodeLoaded: false,
    workspaceMutationAuthorityGranted: false,
  }, diagnostics);
}

function withDiagnostics(
  status: V2AdapterManifestProductStatus,
  diagnostics: readonly V2AdapterManifestRegistryDiagnostic[],
): V2AdapterManifestProductStatus {
  const bounded = diagnostics.slice(0, V2_ADAPTER_MANIFEST_DIAGNOSTIC_LIMIT).map((item) => ({
    ...item,
    message: item.message.slice(0, V2_ADAPTER_MANIFEST_DIAGNOSTIC_MESSAGE_LIMIT),
    path: item.path?.slice(0, 256),
  }));
  return {
    ...status,
    ok: status.manifestValid && diagnostics.length === 0,
    compatibilityState: !status.manifestValid ? 'invalid'
      : diagnostics.some((item) => item.code === 'ADAPTER_IDENTITY_DUPLICATE') ? 'duplicate'
      : diagnostics.length > 0 ? 'incompatible' : 'compatible',
    diagnostics: bounded,
    diagnosticCodes: bounded.map((item) => item.code),
    diagnosticsTruncated: status.diagnosticsTruncated || diagnostics.length > bounded.length
      || diagnostics.some((item) => item.message.length > V2_ADAPTER_MANIFEST_DIAGNOSTIC_MESSAGE_LIMIT || (item.path?.length ?? 0) > 256),
  };
}

function toVscodeDiagnostic(diagnostic: V2AdapterManifestRegistryDiagnostic): vscode.Diagnostic {
  const item = new vscode.Diagnostic(
    new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 1)),
    `${diagnostic.path ? `${diagnostic.path}: ` : ''}${diagnostic.message}`,
    vscode.DiagnosticSeverity.Error,
  );
  item.source = 'WinForms Designer Adapter Manifest';
  item.code = diagnostic.code;
  return item;
}
