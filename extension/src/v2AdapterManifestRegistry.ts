import * as vscode from 'vscode';
import {
  V2AdapterManifest,
  V2AdapterManifestDiagnosticCode,
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

export type V2AdapterManifestRegistryDiagnosticCode = V2AdapterManifestDiagnosticCode
  | 'ADAPTER_MANIFEST_READ_FAILED'
  | 'ADAPTER_MANIFEST_FILE_TOO_LARGE';

export interface V2AdapterManifestProductStatus {
  readonly uri: string;
  readonly ok: boolean;
  readonly adapterId: string | null;
  readonly adapterVersion: string | null;
  readonly supportedProtocolVersions: readonly number[];
  readonly compatibilityCohorts: readonly {
    readonly minProductVersion: string;
    readonly maxProductVersionExclusive: string;
    readonly runtimes: readonly string[];
    readonly architectures: readonly string[];
  }[];
  readonly capabilities: readonly string[];
  readonly unsupportedFeatures: readonly string[];
  readonly diagnosticCodes: readonly V2AdapterManifestRegistryDiagnosticCode[];
  readonly manifestDeclaresVendorCodeLoad: boolean;
  readonly manifestDeclaresWorkspaceMutation: boolean;
  /** Product invariant: declaration is not execution. */
  readonly vendorCodeLoaded: false;
  /** Product invariant: discovery is read-only even when a manifest requests a source-first cohort. */
  readonly workspaceMutationAuthorityGranted: false;
}

interface RegistryDiagnostic {
  readonly code: V2AdapterManifestRegistryDiagnosticCode;
  readonly message: string;
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
      supportedProtocolVersions: [...status.supportedProtocolVersions],
      compatibilityCohorts: status.compatibilityCohorts.map((cohort) => ({
        ...cohort,
        runtimes: [...cohort.runtimes],
        architectures: [...cohort.architectures],
      })),
      capabilities: [...status.capabilities],
      unsupportedFeatures: [...status.unsupportedFeatures],
      diagnosticCodes: [...status.diagnosticCodes],
    }));
  }

  async refresh(): Promise<readonly V2AdapterManifestProductStatus[]> {
    const generation = ++this.refreshGeneration;
    const uris = await this.discoverManifestUris();
    const next: V2AdapterManifestProductStatus[] = [];
    const nextDiagnostics: { uri: vscode.Uri; diagnostics: vscode.Diagnostic[] }[] = [];

    for (const uri of uris) {
      const { status, diagnostics } = await this.evaluateUri(uri);
      next.push(status);
      nextDiagnostics.push({ uri, diagnostics: diagnostics.map(toVscodeDiagnostic) });
    }

    if (this.disposed || generation !== this.refreshGeneration) return this.snapshot();
    this.diagnostics.clear();
    for (const item of nextDiagnostics) this.diagnostics.set(item.uri, item.diagnostics);
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
      void this.refresh().catch((error) => {
        this.output.appendLine(`[adapter manifests] refresh failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, 75);
  }

  private async discoverManifestUris(): Promise<vscode.Uri[]> {
    const discovered = await vscode.workspace.findFiles(
      V2_ADAPTER_MANIFEST_WORKSPACE_GLOB,
      undefined,
      V2_ADAPTER_MANIFEST_DISCOVERY_LIMIT + 1,
    );
    const ordered = discovered
      .filter((uri) => uri.scheme === 'file')
      .sort((left, right) => left.toString().localeCompare(right.toString(), 'en'));
    if (ordered.length > V2_ADAPTER_MANIFEST_DISCOVERY_LIMIT) {
      this.output.appendLine(
        `[adapter manifests] discovery refused entries beyond ${V2_ADAPTER_MANIFEST_DISCOVERY_LIMIT}`,
      );
    }
    return ordered.slice(0, V2_ADAPTER_MANIFEST_DISCOVERY_LIMIT);
  }

  private async evaluateUri(uri: vscode.Uri): Promise<{
    status: V2AdapterManifestProductStatus;
    diagnostics: readonly RegistryDiagnostic[];
  }> {
    let bytes: Uint8Array;
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > V2_ADAPTER_MANIFEST_FILE_BYTE_LIMIT) {
        const diagnostic: RegistryDiagnostic = {
          code: 'ADAPTER_MANIFEST_FILE_TOO_LARGE',
          message: `Adapter manifest exceeds the ${V2_ADAPTER_MANIFEST_FILE_BYTE_LIMIT}-byte product discovery limit.`,
        };
        return { status: statusFrom(null, uri, [diagnostic]), diagnostics: [diagnostic] };
      }
      bytes = await vscode.workspace.fs.readFile(uri);
    } catch {
      const diagnostic: RegistryDiagnostic = {
        code: 'ADAPTER_MANIFEST_READ_FAILED',
        message: 'Adapter manifest could not be read.',
      };
      return { status: statusFrom(null, uri, [diagnostic]), diagnostics: [diagnostic] };
    }

    const evaluation = validateV2AdapterManifestJson(Buffer.from(bytes).toString('utf8'), {
      productVersion: this.productVersion,
      requiredCapabilities: [
        'adapter.manifest-v1',
        'adapter.compatibility-v1',
        'diagnostics.machine-readable',
      ],
    });
    const diagnostics: RegistryDiagnostic[] = evaluation.diagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      message: diagnostic.message,
    }));
    return {
      status: statusFrom(evaluation.manifest ?? null, uri, diagnostics, {
        declaresVendorCodeLoad: evaluation.manifestDeclaresVendorCodeLoad,
        declaresWorkspaceMutation: evaluation.manifestDeclaresWorkspaceMutation,
      }),
      diagnostics,
    };
  }
}

function statusFrom(
  manifest: V2AdapterManifest | null,
  uri: vscode.Uri,
  diagnostics: readonly RegistryDiagnostic[],
  declarations: { declaresVendorCodeLoad: boolean; declaresWorkspaceMutation: boolean } = {
    declaresVendorCodeLoad: false,
    declaresWorkspaceMutation: false,
  },
): V2AdapterManifestProductStatus {
  return {
    uri: uri.toString(),
    ok: diagnostics.length === 0 && manifest !== null,
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
    diagnosticCodes: diagnostics.map((diagnostic) => diagnostic.code),
    manifestDeclaresVendorCodeLoad: declarations.declaresVendorCodeLoad,
    manifestDeclaresWorkspaceMutation: declarations.declaresWorkspaceMutation,
    vendorCodeLoaded: false,
    workspaceMutationAuthorityGranted: false,
  };
}

function toVscodeDiagnostic(diagnostic: RegistryDiagnostic): vscode.Diagnostic {
  const item = new vscode.Diagnostic(
    new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 1)),
    diagnostic.message,
    vscode.DiagnosticSeverity.Error,
  );
  item.source = 'WinForms Designer Adapter Manifest';
  item.code = diagnostic.code;
  return item;
}
