import * as nodeAssert from 'node:assert';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  V2Phase0CorpusId,
  V2Phase0DpiLeg,
  V2Phase0PerformanceReport,
  runV2Phase0PerformanceSpike,
  validateV2Phase0PerformanceReport,
} from './v2Phase0Performance';
import { runV2HeadlessValidation } from './v2HeadlessValidate';
import { createEvidenceAssert, ScenarioEvidenceRecorder } from './scenarioEvidence';

const extensionId = 'skivhisink.winforms-designer-vscode';
const designerViewType = 'winformsDesigner.designer';
const scenarioEvidence = new ScenarioEvidenceRecorder({
  suite: 'extension-host',
  invocation: `vscode=${process.env.VSCODE_TEST_VERSION ?? 'stable'}`,
});
const assert: typeof nodeAssert = createEvidenceAssert(nodeAssert, scenarioEvidence);

interface ToolStripItemModel {
  id: string;
  text: string;
  name: string;
  itemType: string;
  children: ToolStripItemModel[];
}

interface ColumnItem {
  id: string;
  text: string;
  width: number;
  textAlign: string;
}

interface V2AdapterManifestProductStatus {
  uri: string;
  ok: boolean;
  adapterId: string | null;
  adapterVersion: string | null;
  supportedProtocolVersions: readonly number[];
  compatibilityCohorts: readonly {
    minProductVersion: string;
    maxProductVersionExclusive: string;
    runtimes: readonly string[];
    architectures: readonly string[];
  }[];
  capabilities: readonly string[];
  unsupportedFeatures: readonly string[];
  diagnosticCodes: readonly string[];
  manifestDeclaresVendorCodeLoad: boolean;
  manifestDeclaresWorkspaceMutation: boolean;
  vendorCodeLoaded: false;
  workspaceMutationAuthorityGranted: false;
}

interface PublishedPropertyComponent {
  id: string;
  name: string;
  type: string;
  ownership?: 'root' | 'currentSource' | 'inherited' | 'unresolved';
  editable?: boolean;
  readOnlyReason?: string | null;
  inheritedOverrideEditable?: boolean;
  baseIdentityToken?: string;
  designerActions?: readonly {
    propertyName: string;
    commandId?: string;
    certificationId?: string;
    displayName: string;
    category: string;
    description?: string | null;
  }[];
  designerAdorners?: readonly {
    id: string;
    displayName: string;
    left: number;
    top: number;
    width: number;
    height: number;
    hitTestable: boolean;
  }[];
  properties: readonly {
    name: string;
    type: string;
    value: string | null;
    readOnly: boolean;
    isEnum: boolean;
    category: string;
    standardValues?: string[] | null;
    standardValuesExclusive?: boolean;
    inheritedOverrideEditable?: boolean;
    genericCollection?: boolean;
    collectionItemType?: string | null;
    uiTypeEditor?: string | null;
    uiTypeEditorAssemblyPath?: string | null;
    uiTypeEditorAssemblySha256?: string | null;
    uiTypeEditorCertificationId?: string | null;
  }[];
}

interface HostedDesignerProbeResult {
  ok: boolean;
  status: 'ready' | 'crashed' | 'quarantined' | 'refused';
  errorCode: string;
  reason: string;
  componentType: string;
  designerType: string;
  certificationId: string;
  assemblySha256: string;
  mainEnginePid: number;
  workerPid: number;
  exitCode: number;
  workerStarted: boolean;
  quarantined: boolean;
  privateDesktop: boolean;
}

interface HostedServiceKernelProductResult {
  ok: boolean;
  status: 'ready' | 'applied' | 'cancelled' | 'refused';
  errorCode: string;
  reason: string;
  componentType: string;
  designerType: string;
  certificationId: string;
  assemblySha256: string;
  apartmentState: string;
  capabilities: string[];
  completeHostAdvertised: boolean;
  incompleteHostWithheld: boolean;
  incompleteHostReason: string;
  unsupportedServiceRefused: boolean;
  unsupportedServiceReason: string;
  actionId: string;
  actionInvoked: boolean;
  transactionsOpened: number;
  transactionsCommitted: number;
  transactionsCancelled: number;
  changeEvents: number;
  edits: { propertyName: string; propertyType: string; invariantValue: string }[];
}

interface BindingItem {
  propertyName: string;
  dataSourceId: string;
  dataMember: string;
  formattingEnabled: boolean;
  updateMode: 'Never' | 'OnPropertyChanged' | 'OnValidation';
  formatString: string;
}

interface BindingItems {
  ok: boolean;
  bindings: BindingItem[];
  sources: { id: string; typeName: string }[];
  reason: string;
}

interface DataSourcesResult {
  ok: boolean;
  schemas: {
    key: string;
    name: string;
    typeName: string;
    sourceKind: 'object' | 'typedDataSetTable';
    dataMember: string;
    properties: { name: string; typeName: string; kind: string; readOnly: boolean }[];
    existingBindingSources: string[];
  }[];
  settings: { key: string; name: string; typeName: string; scope: string }[];
  reason: string;
  refusalCode: string | null;
}

interface DataSourceGenerationResult {
  safe: boolean;
  reason: string;
  newText: string | null;
  text?: string | null;
  createdIds: string[];
  boundProperty?: string;
  refusalCode: string | null;
}

interface ExtensionHostTestApi {
  adapterManifestRegistryState(): readonly V2AdapterManifestProductStatus[];
  refreshAdapterManifests(): Promise<readonly V2AdapterManifestProductStatus[]>;
  engineLifecycleState(): { openDesignerSessions: number; mappedEngines: readonly { kind: 'modern' | 'net48'; pid: number; running: boolean }[]; liveProcessPids: readonly number[]; idleRecycleScheduled: boolean; idleRecycleInFlight: boolean; idleRecycleBudgetMs: number }; armNextIdleEngineRecycle(delayMs: number): void;
  crashMappedEngineForRecoveryTest(kind: 'modern' | 'net48'): { pid: number; signaled: boolean };
  saveOpenDesigner(source: vscode.Uri): Promise<void>;
  saveOpenDesignerAs(source: vscode.Uri, destination: vscode.Uri): Promise<void>;
  openDesignerState(source: vscode.Uri): {
    dirty: boolean;
    designerFile: string | null;
    designerText: string;
    /** Bumped by every text mutation — lets an assertion separate "the history command was never delivered to this
     * document" from "it was delivered and restored the wrong text". */
    revision: number;
    /** VS Code considers this designer's panel the active editor — the mirror custom-editor Undo/Redo routing keys
     * on, as opposed to the tab model this suite waits on. Recorded in failures so the two can be compared. */
    panelActive: boolean;
    renderReady: boolean;
    engineKind: 'modern' | 'net48' | null; net48RenderMode: 'interpreted' | 'compiledFallback' | 'compiled' | null;
    ownerDiagnosticCode: string | null;
    ownerTypeName: string | null;
    ownerProjectPath: string | null;
    ownerPaths: readonly string[];
    emptyInitializeComponentSurface: boolean;
    renderFailureCause: string | null;
    renderFailureMessage: string | null;
    lastPropertyPersistenceLane: 'ownedRegion' | 'sourceFirst' | null;
    lastNet48PropertyEditTelemetry: {
      plannerMs: number;
      commitMs: number;
      reconcileMs: number;
      liveMs: number;
      snapshotComponentId: string | null;
      componentInSnapshot: boolean;
      propertiesReconciled: boolean;
      trailingPropertiesMs: number;
    } | null;
    lastModernPropertyEditTelemetry: {
      plannerMs: number;
      commitMs: number;
      reconcileMs: number;
      retainedApplied: boolean;
      trailingPropertiesMs: number;
    } | null;
    lastFullRenderTelemetry: {
      modelMs: number;
      captureMs: number;
      previewMs: number;
      reconciliationMs: number;
      totalMeasuredMs: number;
      displayDpr: number;
      captureScale: 1 | 2;
      controlCount: number;
    } | null;
    lastHostedDesignerProbe: HostedDesignerProbeResult | null;
    lastHostedServiceKernelResult: HostedServiceKernelProductResult | null;
    renderGeneration: number;
    currentId: string;
    currentSelectionIds: readonly string[];
    controls: readonly { id: string; parentId?: string | null; ownership?: 'root' | 'currentSource' | 'inherited' | 'unresolved'; editable?: boolean }[];
    tray: readonly { id: string; name: string; type: string; isStrip?: boolean }[];
    selectedPropertyComponent: {
      id: string;
      name: string;
      type: string;
      properties: readonly { name: string; value: string | null }[];
    } | null;
  } | undefined;
  openDesignerProperties(source: vscode.Uri): PublishedPropertyComponent | null | undefined;
  listOpenDesignerBindings(source: vscode.Uri, id: string): Promise<BindingItems>;
  setOpenDesignerBindings(source: vscode.Uri, id: string, bindings: BindingItem[]): Promise<boolean>;
  listOpenDesignerDataSources(source: vscode.Uri): Promise<DataSourcesResult>;
  generateOpenDesignerDataSource(
    source: vscode.Uri,
    schemaKey: string,
    mode: 'detail' | 'grid',
    parentId: string,
    x: number,
    y: number,
    includeNavigator: boolean,
    existingBindingSourceId: string | null,
    existingGridId: string | null,
  ): Promise<DataSourceGenerationResult>;
  setOpenDesignerProjectImageResource(source: vscode.Uri, id: string, propertyName: string,
    accessor: string): Promise<boolean>;
  tryOpenDesignerProjectImageResource(source: vscode.Uri, id: string, propertyName: string,
    accessor: string): Promise<{ applied: boolean; refusalCode: string | null; reason: string | null }>;
  importOpenDesignerLocalImage(source: vscode.Uri, id: string, propertyName: string,
    propertyType: string, image: vscode.Uri): Promise<boolean>;
  setOpenDesignerImageListImages(source: vscode.Uri, id: string,
    images: readonly { image: vscode.Uri; key?: string }[]): Promise<boolean>;
  setOpenDesignerImageListWithPostconditionFailure(source: vscode.Uri, id: string,
    images: readonly { image: vscode.Uri; key?: string }[]): Promise<{
      applied: boolean;
      failureObserved: boolean;
      refusalCode: 'POSTCONDITION_FAILED_ROLLED_BACK' | null;
    }>;
  setOpenDesignerLocalizationCulture(source: vscode.Uri, culture: string): Promise<boolean>;
  openDesignerLayout(source: vscode.Uri): readonly {
    id: string; type: string; parentId: string | null; x: number; y: number; width: number; height: number;
    clientX?: number; clientY?: number; tableColumnWidths?: number[]; tableRowHeights?: number[]; flowDirection?: string;
  }[];
  moveOpenDesignerGroup(source: vscode.Uri, ids: readonly string[], dx: number, dy: number): Promise<void>;
  alignOpenDesignerControls(
    source: vscode.Uri,
    edits: readonly { id: string; dx: number; dy: number }[],
  ): Promise<void>;
  centerOpenDesignerControls(source: vscode.Uri, axis: 'h' | 'v', ids: readonly string[]): Promise<void>;
  resizeOpenDesignerControls(
    source: vscode.Uri,
    sizeEdits: readonly { id: string; width: number; height: number }[],
  ): Promise<void>;
  resizeOpenDesignerControl(source: vscode.Uri, id: string, width: number, height: number): Promise<void>;
  editOpenDesignerProperty(
    source: vscode.Uri,
    id: string,
    propertyName: string,
    propertyType: string,
    isEnum: boolean,
    value: string,
  ): Promise<void>;
  editOpenDesignerColorUiTypeEditor(
    source: vscode.Uri,
    id: string,
    propertyName: string,
    outcome: 'apply-blue' | 'dismiss',
  ): Promise<{
      applied: boolean;
      dismissed: boolean;
      resultConsumed: boolean;
      editorType: string | null;
      refusalCode: 'CANCELLED' | null;
    }>;
  editOpenDesignerCertifiedVendorUiTypeEditor(
    source: vscode.Uri,
    id: string,
    propertyName: string,
  ): Promise<{
      applied: boolean;
      brokerApplied: boolean;
      dismissed: boolean;
      ok: boolean;
      errorCode: string | null;
      invariantValue: string | null;
      editorType: string | null;
      assemblyPath: string | null;
      assemblySha256: string | null;
      certificationId: string | null;
    }>;
  editOpenDesignerCertifiedVendorCollectionEditor(
    source: vscode.Uri,
    id: string,
    propertyName: string,
    tamperOutsideOwnedComponent: boolean,
  ): Promise<{
      applied: boolean;
      brokerApplied: boolean;
      dismissed: boolean;
      ok: boolean;
      errorCode: string | null;
      collectionItems: string[];
      editorType: string | null;
      assemblyPath: string | null;
      assemblySha256: string | null;
      certificationId: string | null;
      persistenceLane: 'ownedRegion' | 'sourceFirst' | null;
      refusalReason: string | null;
    }>;
  editOpenDesignerActionProperty(
    source: vscode.Uri,
    id: string,
    displayName: string,
    value: string,
  ): Promise<{
      applied: boolean;
      displayName: string | null;
      category: string | null;
      propertyName: string | null;
      propertyType: string | null;
    }>;
  hitOpenDesignerAdorner(
    source: vscode.Uri,
    id: string,
    adornerId: string,
    x: number,
    y: number,
  ): Promise<{
      ok: boolean;
      hit: boolean;
      componentId: string;
      adornerId: string;
      componentType: string;
      designerType: string;
      errorCode: string;
      reason: string;
    }>;
  editOpenDesignerPropertyWithResourceInterleave(
    source: vscode.Uri,
    id: string,
    propertyName: string,
    propertyType: string,
    isEnum: boolean,
    value: string,
    interleave: () => Promise<void>,
  ): Promise<boolean>;
  reparentOpenDesignerControl(source: vscode.Uri, id: string, parentId: string): Promise<string | null>;
  addOpenDesignerControl(source: vscode.Uri, controlType: string, parentId: string,
    x?: number, y?: number, width?: number, height?: number): Promise<void>;
  removeOpenDesignerControl(source: vscode.Uri, id: string): Promise<number>;
  renameOpenDesignerControl(source: vscode.Uri, id: string, newName: string): Promise<void>;
  selectOpenDesignerControl(source: vscode.Uri, id: string): Promise<void>;
  probeOpenDesignerHostedDesigner(source: vscode.Uri, id: string): Promise<HostedDesignerProbeResult>;
  invokeOpenDesignerHostedServiceAction(
    source: vscode.Uri,
    id: string,
    commandId: string,
    certificationId: string,
  ): Promise<HostedServiceKernelProductResult>;
  rerenderOpenDesigner(source: vscode.Uri): Promise<void>;
  setOpenDesignerDpi(source: vscode.Uri, displayDpr: number): Promise<void>;
  sendOpenDesignerCanvasInput(
    source: vscode.Uri,
    kind: 'pick' | 'nudge',
    id: string,
    generation: number,
  ): Promise<{ accepted: boolean; refusalCode: 'STALE_CANVAS' | null; renderGeneration: number }>;
  moveOpenDesignerLayoutChild(source: vscode.Uri, id: string, dropX: number, dropY: number): Promise<boolean>;
  listOpenDesignerColumns(source: vscode.Uri, id: string): Promise<{
    ok: boolean;
    columns: ColumnItem[];
    reason: string;
  }>;
  setOpenDesignerColumns(source: vscode.Uri, id: string, columns: ColumnItem[]): Promise<boolean>;
  listOpenDesignerTabPages(source: vscode.Uri, hostId: string): Promise<{
    ok: boolean;
    pages: string[];
    reason: string;
  }>;
  setOpenDesignerTabPages(source: vscode.Uri, hostId: string, pageIds: string[]): Promise<boolean>;
  listOpenDesignerToolStripItems(source: vscode.Uri, id: string): Promise<{
    ok: boolean;
    items: ToolStripItemModel[];
    reason: string;
  }>;
  setOpenDesignerToolStripItems(source: vscode.Uri, id: string, items: ToolStripItemModel[]): Promise<boolean>;
  moveOpenDesignerToolStripItem(
    source: vscode.Uri,
    hostId: string,
    itemId: string,
    targetParentItemId: string | null,
    targetIndex: number,
  ): Promise<{ applied: boolean; reason: string | null }>;
  copyOpenDesignerControls(source: vscode.Uri, ids: readonly string[]): Promise<void>;
  pasteOpenDesignerControls(source: vscode.Uri, targetId?: string): Promise<void>;
  setOpenDesignerHandler(source: vscode.Uri, id: string, eventName: string, handlerName: string): Promise<void>;
  setOpenDesignerHandlerWithInterleave(
    source: vscode.Uri,
    id: string,
    eventName: string,
    handlerName: string,
    interleave: () => Promise<void>,
  ): Promise<void>;
  createOpenDesignerHandler(source: vscode.Uri, id: string, eventName: string): Promise<void>;
  createOpenDesignerHandlerWithInterleave(
    source: vscode.Uri,
    id: string,
    eventName: string,
    interleave: () => Promise<void>,
  ): Promise<void>;
  createOpenDesignerDefaultHandler(source: vscode.Uri, id: string): Promise<void>;
  focusOpenDesigner(source: vscode.Uri): Promise<void>;
  runOpenDesignerResourceRace(
    source: vscode.Uri,
    kind: 'journaled' | 'ordinary',
    resource: vscode.Uri,
    interleave: () => Promise<void>,
  ): Promise<boolean>;
  makeOpenDesignerLocalizableWithJournalFailure(
    source: vscode.Uri,
    state: 'applied' | 'undoRegistered' | 'committed',
  ): Promise<{ result: boolean; failureObserved: boolean }>;
  addScaffoldWithInjectedWriteFailure(
    kind: 'form' | 'userControl' | 'component' | 'class',
    resource: vscode.Uri,
    name: string,
    failWriteFileName: string,
  ): Promise<ScaffoldCommandResult>;
}

interface ScaffoldCommandResult {
  status: 'created' | 'cancelled' | 'refused';
  kind: 'form' | 'userControl' | 'component' | 'class';
  typeName?: string;
  createdFiles?: readonly string[];
  projectUpdated?: boolean;
  errorCode?: string;
}

async function waitFor(
  predicate: () => boolean,
  /** A thunk lets the caller snapshot live state at the moment of failure instead of at call time. */
  failure: string | (() => string),
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(typeof failure === 'function' ? failure() : failure);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** One row per catalog scenario id, written to `.wfd-scenario-results.json` for the runner to gate on. */
const scenarioResults: { scenarioId: string; passed: boolean; error: string | null }[] = [];

/**
 * Run one extracted tail scenario in isolation. This suite is a single linear run, so before this a lone assertion
 * failure skipped every scenario after it — a run that died early reached 6 of 79 scenario markers while the catalog
 * still claimed the whole tail as evidence. A failure is still a failure (the runner exits non-zero if any row
 * failed), but the remaining scenarios now execute and report.
 *
 * Read the ledger as "the first FAIL is the signal": a failed scenario can leave an open dirty editor or a modified
 * fixture behind, so later FAIL rows may be fallout rather than independent regressions. Absence from the ledger
 * means UNKNOWN, not passed — only the extracted tail scenarios are wrapped; the linear body above is not.
 */
async function section(scenarioIds: readonly string[], body: () => Promise<void>): Promise<void> {
  const label = scenarioIds.join(',');
  try {
    await body();
    for (const scenarioId of scenarioIds) scenarioResults.push({ scenarioId, passed: true, error: null });
    console.log(`SCENARIO ${label} PASS`);
  } catch (error) {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    for (const scenarioId of scenarioIds) scenarioResults.push({ scenarioId, passed: false, error: detail });
    console.log(`SCENARIO ${label} FAIL - ${detail.split('\n')[0]}`);
    // Best effort only: give the next scenario a clean editor surface so one failure cascades as little as possible.
    try { await vscode.commands.executeCommand('workbench.action.closeAllEditors'); } catch { /* ignore */ }
  }
}

function writeScenarioLedger(root: string): void {
  const failed = scenarioResults.filter((result) => !result.passed).length;
  fs.writeFileSync(
    path.join(root, '.wfd-scenario-results.json'),
    `${JSON.stringify({ failed, results: scenarioResults }, null, 2)}\n`,
    'utf8',
  );
  // S003 is not complete until the runner launches the second VS Code process and verifies hot-exit restoration.
  // This setup process writes before that second leg, so it must not earn catalog PASS evidence for S003.
  scenarioEvidence.excludeScenario('V2-FND-001-S003');
  scenarioEvidence.complete(failed === 0);
  scenarioEvidence.writeFromEnvironment();
  console.log(`SCENARIO-SUMMARY ${scenarioResults.length - failed}/${scenarioResults.length} passed`);
}

function activeCustomTab(uri: vscode.Uri): vscode.Tab | undefined {
  const tab = vscode.window.tabGroups.activeTabGroup?.activeTab;
  if (!tab || !(tab.input instanceof vscode.TabInputCustom)) return undefined;
  return tab.input.viewType === designerViewType && tab.input.uri.toString() === uri.toString() ? tab : undefined;
}

async function runDesignerHistoryCommand(
  testApi: ExtensionHostTestApi,
  uri: vscode.Uri,
  command: 'undo' | 'redo',
): Promise<{ revisionMoved: boolean }> {
  // VS Code routes the global Undo/Redo command to the focused editor. Product operations may open or reveal an
  // ordinary text document (for example an event handler) without changing which CustomDocument owns the history
  // entry, so make the intended WinForms tab explicit before exercising the native custom-editor history callback.
  await testApi.focusOpenDesigner(uri);
  await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
  await waitFor(() => activeCustomTab(uri) !== undefined && vscode.window.activeTextEditor === undefined, [
    `${command} target did not acquire the WinForms custom-editor command context: ${uri.fsPath}`,
    `activeTab=${String(activeCustomTab(uri)?.label ?? '<none>')}`,
    `activeTextEditor=${String(vscode.window.activeTextEditor?.document.uri.toString() ?? '<none>')}`,
    `panelActive=${String(testApi.openDesignerState(uri)?.panelActive ?? '<none>')}`,
  ].join('; '));
  // The workbench AWAITS our history callback before resolving the command (MainThreadCustomEditorModel.undo awaits
  // the extension-host $undo round-trip), so by the time this returns the document text is already final — a later
  // wait can never rescue a command that missed. The revision therefore decides delivery: it moves if and only if
  // the callback ran on THIS document. Callers that intentionally issue a no-op history command (proving no phantom
  // entry exists) rely on this being reported rather than asserted here.
  const before = testApi.openDesignerState(uri)?.revision ?? -1;
  await vscode.commands.executeCommand(command);
  const after = testApi.openDesignerState(uri)?.revision ?? -1;
  return { revisionMoved: after !== before };
}

function sha256File(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

interface ArchivedRoundTripManifest {
  scenarioId: string;
  status: 'PASS';
  beforeSha256: Record<string, string>;
  afterSha256: Record<string, string>;
  byteIdentical: boolean;
}

function latestArchivedRoundTrip(scenarioId: 'V2-FND-001-S100' | 'V2-FND-001-S108'): {
  directory: string;
  manifest: ArchivedRoundTripManifest;
} {
  const root = path.resolve(__dirname, '..', '..', 'docs', 'v2', 'reference-traces');
  const candidates = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name, scenarioId))
    .filter((directory) => fs.existsSync(path.join(directory, 'manifest.json')))
    .sort((left, right) => right.localeCompare(left));
  for (const directory of candidates) {
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8')) as
      Partial<ArchivedRoundTripManifest>;
    if (manifest.scenarioId === scenarioId && manifest.status === 'PASS' && manifest.byteIdentical === true
        && manifest.beforeSha256 && manifest.afterSha256) {
      return { directory, manifest: manifest as ArchivedRoundTripManifest };
    }
  }
  throw new Error(`${scenarioId} has no archived PASS Visual Studio round-trip trace`);
}

export async function run(): Promise<void> {
  assert.strictEqual(process.platform, 'win32', 'the WinForms designer Extension Host suite must run on Windows');

  const extension = vscode.extensions.all.find((candidate) => candidate.id.toLowerCase() === extensionId);
  assert.ok(extension, `extension ${extensionId} was not loaded by the Extension Host`);
  // Version-agnostic: assert a real semver rather than a hardcoded literal (which failed the whole release on every
  // version bump — 1.0.0 → 1.0.1). The diagnostics cross-check below ties the reported version to THIS manifest value,
  // which is a stronger check than a fixed string ever was.
  const version = extension.packageJSON.version as string;
  assert.match(version, /^\d+\.\d+\.\d+$/, `manifest version is not semver: ${version}`);
  assert.strictEqual(extension.packageJSON.preview, false);
  assert.strictEqual(extension.packageJSON.capabilities?.untrustedWorkspaces?.supported, false);
  assert.strictEqual(extension.packageJSON.capabilities?.virtualWorkspaces?.supported, false);

  const testApi = await extension.activate() as ExtensionHostTestApi | undefined;
  assert.strictEqual(extension.isActive, true, 'extension did not activate');
  assert.ok(testApi, 'Extension Host E2E API was not exposed; WFD_EXTENSION_HOST_E2E was not inherited');
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(workspaceFolder, 'the Extension Host suite needs one disposable workspace folder');
  const workspaceRoot = path.join(workspaceFolder.uri.fsPath, 'DemoApp');
  assert.ok(fs.existsSync(path.join(workspaceRoot, 'DemoApp.csproj')), 'disposable DemoApp workspace copy is missing');

  if (process.env.WFD_EXTENSION_HOST_S122_ONLY === '1') {
    await runS122ProductPerformanceValidationScenario(testApi);
    return;
  }
  if (process.env.WFD_EXTENSION_HOST_S016_ONLY === '1') {
    await runS016DenseProductPerformanceScenario(testApi);
    return;
  }
  if (process.env.WFD_EXTENSION_HOST_S126_ONLY === '1') {
    await runS126HighDpiAdvisorScenario(testApi);
    return;
  }
  if (process.env.WFD_EXTENSION_HOST_S124_ONLY === '1') {
    await runS124ProductWorkerCrashContinuation(testApi);
    return;
  }
  if (process.env.WFD_EXTENSION_HOST_S095_ONLY === '1') {
    await runS095HostedDesignerQuarantineScenario(testApi);
    return;
  }
  if (process.env.WFD_EXTENSION_HOST_S097_ONLY === '1') {
    await runS097S099AdapterManifestRegistryScenario(testApi);
    return;
  }
  if (process.env.WFD_EXTENSION_HOST_S100_S108_ONLY === '1') {
    await runS097S099AdapterManifestRegistryScenario(testApi);
    await runS100S108VisualStudioRoundTripScenario(testApi);
    return;
  }
  if (process.env.WFD_EXTENSION_HOST_S089_ONLY === '1') {
    await runS089S090HostedServiceKernelScenario(testApi);
    return;
  }
  if (process.env.WFD_EXTENSION_HOST_S091_ONLY === '1') {
    await runS091S092HostedServiceCancellationScenario(testApi);
    return;
  }

  if (process.env.WFD_HOT_EXIT_PHASE === 'restore') {
    // V2-FND-001-S003 — this is the SECOND real VS Code process. The first one exited with one unsaved move in a
    // modern CustomEditor and one in a compiled-net48 CustomEditor. The product must reopen the exact VS Code-owned
    // backup bytes and reconstruct exactly one native Undo/Redo unit without touching either disk image.
    const evidencePath = path.join(workspaceFolder.uri.fsPath, '.wfd-s003-hot-exit.json');
    assert.ok(fs.existsSync(evidencePath), 'S003 setup process did not persist its expected backup images');
    const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8')) as {
      documents: {
        label: string;
        engineKind: 'modern' | 'net48';
        sourceRelative: string;
        designerRelative: string;
        before: string;
        after: string;
        sourceHash: string;
        designerHash: string;
      }[];
    };
    assert.deepStrictEqual(evidence.documents.map((document) => document.engineKind), ['modern', 'net48']);
    for (const expected of evidence.documents) {
      const source = path.join(workspaceFolder.uri.fsPath, expected.sourceRelative);
      const designer = path.join(workspaceFolder.uri.fsPath, expected.designerRelative);
      const uri = vscode.Uri.file(source);
      // Extension Development Host keeps its editor-service database in memory, so unlike an ordinary installed VS
      // Code window it cannot recreate editor inputs across these two OS processes. Exercise the frozen S003 action
      // literally: restart the host, then explicitly reopen the designer. The provider must consume the real backup
      // destination VS Code created during the first process; no provider seam or synthetic backup id is injected.
      await vscode.commands.executeCommand('vscode.openWith', uri, designerViewType);
      await waitFor(
        () => testApi.openDesignerState(uri)?.renderReady === true
          && testApi.openDesignerState(uri)?.designerText === expected.after,
        `S003 ${expected.label} hot-exit backup was not reopened: ${JSON.stringify(testApi.openDesignerState(uri))}`,
        90_000,
      );
      assert.strictEqual(testApi.openDesignerState(uri)?.engineKind, expected.engineKind);
      assert.strictEqual(testApi.openDesignerState(uri)?.dirty, true);
      assert.strictEqual(activeCustomTab(uri)?.isDirty, true);
      assert.strictEqual(sha256File(source), expected.sourceHash);
      assert.strictEqual(sha256File(designer), expected.designerHash);

      await runDesignerHistoryCommand(testApi, uri, 'undo');
      await waitFor(
        () => testApi.openDesignerState(uri)?.designerText === expected.before
          && testApi.openDesignerState(uri)?.dirty === false
          && activeCustomTab(uri)?.isDirty === false,
        `S003 ${expected.label} recovered native Undo did not restore the exact clean baseline`,
        60_000,
      );
      assert.strictEqual(sha256File(source), expected.sourceHash);
      assert.strictEqual(sha256File(designer), expected.designerHash);

      await runDesignerHistoryCommand(testApi, uri, 'redo');
      await waitFor(
        () => testApi.openDesignerState(uri)?.designerText === expected.after
          && testApi.openDesignerState(uri)?.dirty === true,
        `S003 ${expected.label} recovered native Redo did not restore the hot-exit buffer`,
        60_000,
      );
      assert.strictEqual(sha256File(source), expected.sourceHash);
      assert.strictEqual(sha256File(designer), expected.designerHash);

      await runDesignerHistoryCommand(testApi, uri, 'undo');
      await waitFor(
        () => testApi.openDesignerState(uri)?.designerText === expected.before
          && activeCustomTab(uri)?.isDirty === false,
        `S003 ${expected.label} final recovered Undo did not return to the clean baseline`,
        60_000,
      );
    }
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    scenarioEvidence.complete(true);
    scenarioEvidence.writeFromEnvironment();
    return;
  }

  const commands = new Set(await vscode.commands.getCommands(true));
  for (const command of [
    'winformsDesigner.open',
    'winformsDesigner.viewCode',
    'winformsDesigner.addForm',
    'winformsDesigner.addUserControl',
    'winformsDesigner.addComponent',
    'winformsDesigner.addClass',
    'winformsDesigner.showProperties',
    'winformsDesigner.exportDiagnostics',
    'winformsDesigner.selectControlAssembly',
    'winformsDesigner.editImageListImages',
    'winformsDesigner.releaseAssembly',
    'winformsDesigner.runBuildTask',
    'winformsDesigner.runTestTask',
    'winformsDesigner.stopEngines',
    'winformsDesigner.restartEngines',
    'winformsDesigner.previewHighDpiQuickFix',
  ]) {
    assert.ok(commands.has(command), `command ${command} was not registered`);
  }
  const contributions = extension.packageJSON.contributes as {
    submenus?: { id?: string }[];
    menus?: Record<string, { command?: string; submenu?: string }[]>;
  };
  assert.ok(
    contributions.submenus?.some((submenu) => submenu.id === 'winformsDesigner.add'),
    'the Explorer Add submenu was not contributed',
  );
  assert.ok(
    contributions.menus?.['explorer/context']?.some((item) => item.submenu === 'winformsDesigner.add'),
    'the Explorer context menu does not expose the Add submenu',
  );
  assert.deepStrictEqual(
    contributions.menus?.['winformsDesigner.add']?.map((item) => item.command),
    [
      'winformsDesigner.addForm',
      'winformsDesigner.addUserControl',
      'winformsDesigner.addComponent',
      'winformsDesigner.addClass',
    ],
    'the Add submenu should expose Form, User Control, Component, and Class in that order',
  );

  // This drives a real extension command through the real Extension Host and starts the bundled/development
  // .NET engine. It catches activation/API-floor regressions as well as broken engine path/apphost logic.
  await vscode.commands.executeCommand('winformsDesigner.exportDiagnostics');
  const diagnostics = vscode.window.activeTextEditor?.document;
  assert.ok(diagnostics, 'Export Designer Diagnostics did not open a document');
  assert.strictEqual(diagnostics.languageId, 'markdown');
  const text = diagnostics.getText();
  assert.match(text, /# WinForms Designer .* Diagnostics/);
  assert.match(text, /- Platform: win32 /);
  assert.match(text, /- Engine: winforms-engine ok \/ \.NET 10\./,
    `the .NET 10 engine did not start successfully:\n${text}`);
  assert.ok(text.includes(`- Extension: ${version}`), `diagnostics should report the manifest version ${version}:\n${text}`);
  assert.match(text, /- Extension Host memory: \d+ MiB RSS/);
  assert.match(text, /- Engine ping: \d+(?:\.\d+)? ms/);
  assert.match(text, /- Engine PID: \d+/);
  assert.match(text, /- Engine capabilities: .*edit=/);
  assert.match(text, /## Engine lifecycle/);
  assert.match(text, /- modern: running \(pid \d+\); starts=1; lastStartup=\d+ ms; recentCrashes=0; lastExit=n\/a/);
  assert.match(text, /- net48: stopped; starts=0; lastStartup=n\/a; recentCrashes=0; lastExit=n\/a/);

  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

  // Opening a DIFF of a form must NOT be hijacked by the designer's auto-open. This has to run in a real Extension
  // Host: the fix depends on VS Code's tab model already reporting the diff tab when onDidChangeActiveTextEditor
  // fires for the modified side, which no headless tier can observe.
  const repoRoot = path.resolve(__dirname, '..', '..');
  const formCs = vscode.Uri.file(path.join(repoRoot, 'engine', 'samples', 'EventForm.cs'));
  const designerCs = vscode.Uri.file(path.join(repoRoot, 'engine', 'samples', 'EventForm.Designer.cs'));
  assert.ok(fs.existsSync(formCs.fsPath), `fixture missing: ${formCs.fsPath}`);
  assert.ok(fs.existsSync(designerCs.fsPath), `fixture missing: ${designerCs.fsPath}`);
  assert.strictEqual(
    vscode.workspace.getConfiguration('winformsDesigner', formCs).get('autoOpenDesigner', true), true,
    'this check is only meaningful while auto-open is enabled');

  await vscode.commands.executeCommand('vscode.diff', designerCs, formCs, 'EventForm diff');
  // Let any auto-open reaction run: it is fired from an event handler and would replace the tab asynchronously.
  await new Promise((resolve) => setTimeout(resolve, 1500));

  const tab = vscode.window.tabGroups.activeTabGroup?.activeTab;
  assert.ok(tab, 'the diff did not open a tab');
  assert.ok(
    tab.input instanceof vscode.TabInputTextDiff,
    `viewing a diff must stay a diff, but the active tab became ${tab.input?.constructor?.name}`);
  assert.strictEqual(
    (tab.input as vscode.TabInputTextDiff).modified.toString(), formCs.toString(),
    'the diff should still be showing the form .cs as its modified side');

  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

  // V2-FND-001-S001 — exercise the real CustomEditorProvider lifecycle, not the documentStore helper. Opening and
  // saving a clean form must leave the visible custom tab clean and must not rewrite any nested form artifact.
  const lifecycleDir = path.join(workspaceRoot, 'V2Lifecycle');
  fs.mkdirSync(lifecycleDir, { recursive: true });
  const lifecycleSource = path.join(lifecycleDir, 'LifecycleForm.cs');
  const lifecycleDesigner = path.join(lifecycleDir, 'LifecycleForm.Designer.cs');
  const lifecycleResx = path.join(lifecycleDir, 'LifecycleForm.resx');
  const lifecycleCultureResx = path.join(lifecycleDir, 'LifecycleForm.fr-FR.resx');
  fs.writeFileSync(lifecycleSource, [
    'using System.Windows.Forms;',
    'namespace DemoApp;',
    'public partial class LifecycleForm : Form',
    '{',
    '    public LifecycleForm() => InitializeComponent();',
    '}',
    '',
  ].join('\r\n'), 'utf8');
  fs.writeFileSync(lifecycleDesigner, [
    'namespace DemoApp;',
    'partial class LifecycleForm',
    '{',
    '    private System.ComponentModel.IContainer? components = null;',
    '    private void InitializeComponent()',
    '    {',
    '        this.SuspendLayout();',
    '        this.Name = "LifecycleForm";',
    '        this.ResumeLayout(false);',
    '    }',
    '}',
    '',
  ].join('\r\n'), 'utf8');
  fs.writeFileSync(lifecycleResx, '<root />\r\n', 'utf8');
  fs.writeFileSync(lifecycleCultureResx, '<root><!-- français --></root>\r\n', 'utf8');
  const lifecycleUris = [lifecycleSource, lifecycleDesigner, lifecycleResx, lifecycleCultureResx]
    .map((file) => vscode.Uri.file(file));
  const lifecycleBefore = lifecycleUris.map((uri) => Buffer.from(fs.readFileSync(uri.fsPath)));
  const lifecycleUri = lifecycleUris[0];

  await vscode.commands.executeCommand('vscode.openWith', lifecycleUri, designerViewType);
  await waitFor(() => Boolean(activeCustomTab(lifecycleUri)), 'LifecycleForm did not open in the WinForms custom editor');
  const lifecycleState = testApi.openDesignerState(lifecycleUri);
  assert.strictEqual(lifecycleState?.dirty, false);
  assert.strictEqual(lifecycleState?.designerFile, lifecycleDesigner);
  assert.strictEqual(lifecycleState?.designerText, fs.readFileSync(lifecycleDesigner, 'utf8'));
  assert.strictEqual(activeCustomTab(lifecycleUri)?.isDirty, false, 'a freshly opened form should be clean');
  await vscode.commands.executeCommand('workbench.action.files.save');
  await waitFor(() => activeCustomTab(lifecycleUri)?.isDirty === false, 'save-without-edit left the custom editor dirty');
  lifecycleUris.forEach((uri, index) => {
    assert.deepStrictEqual(
      Buffer.from(fs.readFileSync(uri.fsPath)),
      lifecycleBefore[index],
      `save-without-edit rewrote ${path.basename(uri.fsPath)}`,
    );
  });

  // W1.5 — successful Save As is the complete nested form, not a lone generated-source orphan. On this SDK
  // project default items provide membership, so the project must remain byte-identical while code-behind,
  // generated source, neutral resources, and a culture resource are created by one durable transaction.
  const successfulCopy = path.join(lifecycleDir, 'SavedLifecycleForm.cs');
  const sdkProjectBeforeSaveAs = fs.readFileSync(path.join(workspaceRoot, 'DemoApp.csproj'));
  await testApi.saveOpenDesignerAs(lifecycleUri, vscode.Uri.file(successfulCopy));
  for (const suffix of ['.cs', '.Designer.cs', '.resx', '.fr-FR.resx']) {
    const destination = path.join(lifecycleDir, `SavedLifecycleForm${suffix}`);
    assert.ok(fs.existsSync(destination), `successful SDK Save As did not create ${path.basename(destination)}`);
  }
  assert.deepStrictEqual(
    fs.readFileSync(path.join(workspaceRoot, 'DemoApp.csproj')),
    sdkProjectBeforeSaveAs,
    'SDK Save As rewrote implicit project membership',
  );
  assert.match(fs.readFileSync(successfulCopy, 'utf8'), /partial class SavedLifecycleForm/);
  assert.match(fs.readFileSync(path.join(lifecycleDir, 'SavedLifecycleForm.Designer.cs'), 'utf8'), /partial class SavedLifecycleForm/);

  // V2-FND-001-S004 — drive the registered provider's Save As callback against an OPEN custom document. The native
  // dialog only knows the selected .cs destination; the provider must aggregate hidden .Designer.cs/.resx collisions
  // before any write and name every conflict in the refusal.
  const copySource = path.join(lifecycleDir, 'CopyOfLifecycleForm.cs');
  const copyResx = path.join(lifecycleDir, 'CopyOfLifecycleForm.resx');
  fs.writeFileSync(copySource, '// existing source must survive\r\n', 'utf8');
  fs.writeFileSync(copyResx, '<root><!-- existing resource must survive --></root>\r\n', 'utf8');
  const copySourceBefore = fs.readFileSync(copySource);
  const copyResxBefore = fs.readFileSync(copyResx);
  await assert.rejects(
    () => testApi.saveOpenDesignerAs(lifecycleUri, vscode.Uri.file(copySource)),
    (error: Error) => error.message.includes('CopyOfLifecycleForm.cs')
      && error.message.includes('CopyOfLifecycleForm.resx'),
    'Save As collision should name both the visible source and hidden resource target',
  );
  assert.deepStrictEqual(fs.readFileSync(copySource), copySourceBefore, 'Save As overwrote the existing source');
  assert.deepStrictEqual(fs.readFileSync(copyResx), copyResxBefore, 'Save As overwrote the existing resource');
  assert.ok(
    !fs.existsSync(path.join(lifecycleDir, 'CopyOfLifecycleForm.Designer.cs')),
    'Save As created a generated sidecar before reporting the aggregate collision',
  );
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  await waitFor(
    () => testApi.openDesignerState(lifecycleUri) === undefined,
    'LifecycleForm custom document was not disposed before the next product open',
  );

  // V2-FND-001-S021 — execute the real DesignerSession group-move ingress against an open modern form. The engine
  // authorizes both controls as one evolving source transaction; VS Code receives one CustomDocumentEditEvent, so a
  // single native Undo restores both assignments and Redo reapplies both.
  const groupSource = path.join(lifecycleDir, 'GroupMoveForm.cs');
  const groupDesigner = path.join(lifecycleDir, 'GroupMoveForm.Designer.cs');
  fs.writeFileSync(groupSource, [
    'using System.Windows.Forms;',
    'namespace DemoApp;',
    'public partial class GroupMoveForm : Form',
    '{',
    '    public GroupMoveForm() => InitializeComponent();',
    '}',
    '',
  ].join('\r\n'), 'utf8');
  fs.writeFileSync(groupDesigner, [
    'namespace DemoApp;',
    'partial class GroupMoveForm',
    '{',
    '    private System.Windows.Forms.Button button1;',
    '    private System.Windows.Forms.Button button2;',
    '    private void InitializeComponent()',
    '    {',
    '        this.button1 = new System.Windows.Forms.Button();',
    '        this.button2 = new System.Windows.Forms.Button();',
    '        this.SuspendLayout();',
    '        this.button1.Location = new System.Drawing.Point(10, 20);',
    '        this.button1.Name = "button1";',
    '        this.button2.Location = new System.Drawing.Point(50, 60);',
    '        this.button2.Name = "button2";',
    '        this.Controls.Add(this.button2);',
    '        this.Controls.Add(this.button1);',
    '        this.Name = "GroupMoveForm";',
    '        this.ResumeLayout(false);',
    '    }',
    '}',
    '',
  ].join('\r\n'), 'utf8');
  const groupUri = vscode.Uri.file(groupSource);
  await vscode.commands.executeCommand('vscode.openWith', groupUri, designerViewType);
  try {
    await waitFor(
      () => testApi.openDesignerState(groupUri)?.renderReady === true,
      'GroupMoveForm never reached a successful product render',
      60_000,
    );
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}; state=${JSON.stringify(testApi.openDesignerState(groupUri))}`);
  }
  assert.strictEqual(testApi.openDesignerState(groupUri)?.engineKind, 'modern');
  const groupBefore = testApi.openDesignerState(groupUri)?.designerText;
  assert.ok(groupBefore, 'GroupMoveForm custom document text is unavailable');
  await testApi.editOpenDesignerProperty(
    groupUri, 'button1', 'Text', 'System.String', false, 'Owned region product route');
  await waitFor(
    () => (testApi.openDesignerState(groupUri)?.designerText ?? '').includes(
      'this.button1.Text = "Owned region product route";'),
    'ordinary scalar property edit did not reach the product custom document',
  );
  assert.strictEqual(
    testApi.openDesignerState(groupUri)?.lastPropertyPersistenceLane,
    'ownedRegion',
    'proven InitializeComponent form did not use the product owned-region persistence lane',
  );
  await waitFor(
    () => activeCustomTab(groupUri)?.isDirty === true,
    'owned-region edit reached the CustomDocument before VS Code registered its native history entry',
  );
  const ownedRegionUndo = await runDesignerHistoryCommand(testApi, groupUri, 'undo');
  // This site has flaked. Separate the two failures the single timeout used to conflate: a command that never
  // reached this CustomDocument is decidable immediately, and reporting it as "Undo did not restore the text"
  // sent every previous investigation after the wrong mechanism. Record both editor mirrors when it happens —
  // routing keys on the active editor pane (panelActive), while this suite waits on the tab model.
  assert.ok(ownedRegionUndo.revisionMoved, [
    'native Undo was never delivered to the owned-region CustomDocument',
    `panelActive=${String(testApi.openDesignerState(groupUri)?.panelActive)}`,
    `activeTab=${String(activeCustomTab(groupUri)?.label ?? '<none>')}`,
  ].join('; '));
  await waitFor(
    () => testApi.openDesignerState(groupUri)?.designerText === groupBefore,
    'native Undo did not restore the product owned-region property edit',
  );
  await testApi.moveOpenDesignerGroup(groupUri, ['button1', 'button2'], 17, 9);
  await waitFor(() => testApi.openDesignerState(groupUri)?.dirty === true, 'group move did not dirty the custom editor');
  const groupMoved = testApi.openDesignerState(groupUri)?.designerText ?? '';
  assert.strictEqual((groupMoved.match(/button1\.Location = new System\.Drawing\.Point\(27, 29\)/g) ?? []).length, 1);
  assert.strictEqual((groupMoved.match(/button2\.Location = new System\.Drawing\.Point\(67, 69\)/g) ?? []).length, 1);
  assert.strictEqual(activeCustomTab(groupUri)?.isDirty, true, 'group move did not mark the visible form tab dirty');

  await runDesignerHistoryCommand(testApi, groupUri, 'undo');
  await waitFor(
    () => testApi.openDesignerState(groupUri)?.designerText === groupBefore,
    'one native Undo did not restore both group-move assignments',
  );
  assert.strictEqual(testApi.openDesignerState(groupUri)?.dirty, false, 'Undo back to the disk baseline stayed dirty');
  await runDesignerHistoryCommand(testApi, groupUri, 'redo');
  await waitFor(
    () => testApi.openDesignerState(groupUri)?.designerText === groupMoved,
    'one native Redo did not reapply both group-move assignments',
  );
  await runDesignerHistoryCommand(testApi, groupUri, 'undo');
  await waitFor(() => testApi.openDesignerState(groupUri)?.dirty === false, 'final Undo did not restore clean state');
  assert.deepStrictEqual(fs.readFileSync(groupDesigner, 'utf8'), groupBefore, 'unsaved group move touched disk');

  // V2-FND-001-S120 — every real Extension Host regression performs and saves the exact extension-side move whose
  // archived Visual Studio trace proves byte-identical after Save All. An optional output path only copies that already
  // validated product result for a new DTE capture; it no longer decides whether the repository scenario executes.
  const visualStudioTraceOutput = process.env.WFD_VS_TRACE_OUTPUT?.trim();
  const s120SourceHash = sha256File(groupSource);
  await testApi.moveOpenDesignerGroup(groupUri, ['button1'], 11, 7);
  await waitFor(
    () => (testApi.openDesignerState(groupUri)?.designerText ?? '').includes(
      'button1.Location = new System.Drawing.Point(21, 27)'),
    'S120 extension leg did not move button1 to the expected location',
  );
  await testApi.saveOpenDesigner(groupUri);
  await waitFor(() => testApi.openDesignerState(groupUri)?.dirty === false,
    'S120 extension leg did not save the generated source');
  assert.strictEqual(sha256File(groupSource), s120SourceHash,
    'S120 bounded Designer move rewrote the code-behind artifact');
  assert.strictEqual(
    fs.readFileSync(groupDesigner, 'utf8'),
    testApi.openDesignerState(groupUri)?.designerText,
    'S120 saved Designer bytes differ from the product CustomDocument snapshot',
  );

  if (visualStudioTraceOutput) {
    fs.mkdirSync(visualStudioTraceOutput, { recursive: true });
    const archivedSource = path.join(visualStudioTraceOutput, 'GroupMoveForm.cs');
    const archivedDesigner = path.join(visualStudioTraceOutput, 'GroupMoveForm.Designer.cs');
    fs.copyFileSync(groupSource, archivedSource);
    fs.copyFileSync(groupDesigner, archivedDesigner);
    fs.writeFileSync(path.join(visualStudioTraceOutput, 'extension-leg.json'), `${JSON.stringify({
      schemaVersion: 1,
      scenarioId: 'V2-FND-001-S120',
      producer: 'WinForms Designer for VS Code CustomEditor Extension Host',
      extensionVersion: version,
      vscodeVersion: vscode.version,
      action: {
        kind: 'move',
        componentId: 'button1',
        delta: { x: 11, y: 7 },
        resultingLocation: { x: 21, y: 27 },
      },
      artifacts: {
        'GroupMoveForm.cs': sha256File(archivedSource),
        'GroupMoveForm.Designer.cs': sha256File(archivedDesigner),
      },
    }, null, 2)}\n`, 'utf8');

  }

  // Restore the disposable suite's exact original disk baseline so later race scenarios retain their preconditions.
  // When export is enabled, the copied artifact above remains the extension-edited input consumed by Visual Studio.
  await runDesignerHistoryCommand(testApi, groupUri, 'undo');
  await waitFor(() => testApi.openDesignerState(groupUri)?.designerText === groupBefore,
    'S120 native Undo did not restore the original product buffer');
  await testApi.saveOpenDesigner(groupUri);
  await waitFor(() => testApi.openDesignerState(groupUri)?.dirty === false,
    'S120 cleanup did not restore a clean product document');
  assert.strictEqual(fs.readFileSync(groupDesigner, 'utf8'), groupBefore,
    'S120 cleanup did not restore the exact Designer disk baseline');

  // real-parity W0.1/W0.2 — pause each real resource path AFTER its resource write, commit a canvas move through the
  // product session, then resume the stale operation. The newer move must survive and the stale resource bytes must
  // be compensated. This deterministically covers the data-loss window that a structural catalog validator missed.
  const raceResource = path.join(lifecycleDir, 'ConcurrentResource.resx');
  fs.writeFileSync(raceResource, '<root />\r\n', 'utf8');
  const raceResourceBefore = Buffer.from(fs.readFileSync(raceResource));
  const raceResourceUri = vscode.Uri.file(raceResource);

  let journaledInterleaveCalled = false;
  const journaledRaceCommitted = await testApi.runOpenDesignerResourceRace(
    groupUri,
    'journaled',
    raceResourceUri,
    async () => {
      journaledInterleaveCalled = true;
      await testApi.moveOpenDesignerGroup(groupUri, ['button1', 'button2'], 3, 4);
    },
  );
  assert.strictEqual(journaledInterleaveCalled, true, 'journaled race did not reach the final commit boundary');
  assert.strictEqual(journaledRaceCommitted, false, 'stale journaled resource operation overwrote a newer canvas move');
  const journaledRaceText = testApi.openDesignerState(groupUri)?.designerText ?? '';
  assert.match(
    journaledRaceText,
    /this\.button1\.Location = new System\.Drawing\.Point\(13, 24\);/,
    `newer canvas move was lost when the journaled resource operation resumed: ${JSON.stringify(
      journaledRaceText.match(/button1\.Location[^;]*;/)?.[0] ?? '<missing>',
    )}`,
  );
  assert.deepStrictEqual(fs.readFileSync(raceResource), raceResourceBefore, 'journaled race did not compensate resx');
  await runDesignerHistoryCommand(testApi, groupUri, 'undo');
  await waitFor(
    () => testApi.openDesignerState(groupUri)?.designerText === groupBefore,
    'Undo did not restore the journaled-race canvas move',
  );

  const ordinaryRaceCommitted = await testApi.runOpenDesignerResourceRace(
    groupUri,
    'ordinary',
    raceResourceUri,
    () => testApi.moveOpenDesignerGroup(groupUri, ['button1', 'button2'], 5, 6),
  );
  assert.strictEqual(ordinaryRaceCommitted, false, 'stale Image/ImageList resource operation overwrote a newer edit');
  const ordinaryRaceText = testApi.openDesignerState(groupUri)?.designerText ?? '';
  assert.match(
    ordinaryRaceText,
    /this\.button2\.Location = new System\.Drawing\.Point\(55, 66\);/,
    `newer property/canvas edit was lost when the ordinary resource write resumed: ${JSON.stringify(
      ordinaryRaceText.match(/button2\.Location[^;]*;/)?.[0] ?? '<missing>',
    )}`,
  );
  assert.deepStrictEqual(fs.readFileSync(raceResource), raceResourceBefore, 'ordinary race did not compensate resx');
  await runDesignerHistoryCommand(testApi, groupUri, 'undo');
  await waitFor(
    () => testApi.openDesignerState(groupUri)?.designerText === groupBefore,
    'Undo did not restore the ordinary-resource-race edit',
  );
  assert.strictEqual(testApi.openDesignerState(groupUri)?.dirty, false, 'W0 races left the document dirty after Undo');

  // real-parity W0.3/W0.4 — Make Localizable writes generated source and neutral resx as explicit runner targets.
  // Fail each late journal state after the writes and prove that both disk artifacts plus the open CustomDocument stay
  // at the exact pre-operation state. No native undo/dirty entry may be published for the refused conversion.
  const localizableResx = path.join(lifecycleDir, 'GroupMoveForm.resx');
  assert.strictEqual(fs.existsSync(localizableResx), false, 'W0 localizable fixture unexpectedly has a neutral resx');
  for (const failedState of ['applied', 'undoRegistered', 'committed'] as const) {
    const failedConversion = await testApi.makeOpenDesignerLocalizableWithJournalFailure(groupUri, failedState);
    assert.deepStrictEqual(
      failedConversion,
      { result: false, failureObserved: true },
      `Make Localizable did not reach the forced ${failedState} journal failure`,
    );
    assert.strictEqual(testApi.openDesignerState(groupUri)?.designerText, groupBefore,
      `${failedState} failure left a transient generated-source image in the CustomDocument`);
    assert.strictEqual(testApi.openDesignerState(groupUri)?.dirty, false);
    assert.strictEqual(activeCustomTab(groupUri)?.isDirty, false, `${failedState} failure left a phantom dirty tab`);
    assert.strictEqual(fs.readFileSync(groupDesigner, 'utf8'), groupBefore, `${failedState} failure left converted source`);
    assert.strictEqual(fs.existsSync(localizableResx), false, `${failedState} failure left a neutral resx`);
  }

  // V2-FND-001-S002 — an external writer wins after the product captured its source baseline. Invoke a real geometry
  // edit before the 120 ms watcher reload, then invoke the registered save callback: the exact disk comparison must
  // return STALE_SOURCE, keep the custom document dirty, and preserve the external bytes.
  const groupExternal = groupBefore.replace(
    '        this.button2.Name = "button2";',
    '        this.button2.Name = "button2"; // external writer',
  );
  assert.notStrictEqual(groupExternal, groupBefore);
  fs.writeFileSync(groupDesigner, groupExternal, 'utf8');
  await testApi.moveOpenDesignerGroup(groupUri, ['button1'], 3, 4);
  if (testApi.openDesignerState(groupUri)?.dirty !== true) {
    // On a fast watcher delivery the external source is safely adopted and the stale canvas edit is refused. Wait
    // for that replacement render, then create a normal dirty edit; the second external write below deterministically
    // exercises the same save-time stale guard without depending on a 120 ms scheduler race.
    await waitFor(
      () => testApi.openDesignerState(groupUri)?.renderReady === true,
      'external generated-source adoption did not finish rendering',
    );
    await testApi.moveOpenDesignerGroup(groupUri, ['button1'], 3, 4);
  }
  assert.strictEqual(testApi.openDesignerState(groupUri)?.dirty, true, 'stale-baseline geometry edit did not become dirty');
  const groupExternalWhileDirty = groupExternal.replace('// external writer', '// external writer while dirty');
  fs.writeFileSync(groupDesigner, groupExternalWhileDirty, 'utf8');
  await new Promise((resolve) => setTimeout(resolve, 300));
  await assert.rejects(
    () => testApi.saveOpenDesigner(groupUri),
    (error: Error & { code?: string }) => error.code === 'STALE_SOURCE',
    'saving after an external generated-source change must return STALE_SOURCE',
  );
  assert.strictEqual(testApi.openDesignerState(groupUri)?.dirty, true, 'stale-source refusal cleared the dirty state');
  assert.strictEqual(
    fs.readFileSync(groupDesigner, 'utf8'),
    groupExternalWhileDirty,
    'stale-source refusal overwrote external bytes',
  );
  await runDesignerHistoryCommand(testApi, groupUri, 'undo');
  await waitFor(() => testApi.openDesignerState(groupUri)?.dirty === false, 'Undo did not clear the refused stale edit');
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  await waitFor(
    () => testApi.openDesignerState(groupUri) === undefined,
    'GroupMoveForm custom document was not disposed before the next product open',
  );

  // V2-FND-001-S005/S007 — invoke the same public Explorer Add command that the context menu uses, with its optional
  // automation name. SDK form creation is a three-file transaction, opens the real custom editor, and an unsafe name
  // is refused by the product command without creating anything.
  const sdkAddDir = path.join(workspaceRoot, 'SdkCatalogAdd');
  fs.mkdirSync(sdkAddDir, { recursive: true });
  const sdkProject = path.join(workspaceRoot, 'DemoApp.csproj');
  const sdkProjectBefore = fs.readFileSync(sdkProject);
  const sdkResult = await vscode.commands.executeCommand<ScaffoldCommandResult>(
    'winformsDesigner.addForm',
    vscode.Uri.file(sdkAddDir),
    { name: 'CatalogForm' },
  );
  assert.deepStrictEqual(
    { status: sdkResult?.status, kind: sdkResult?.kind, typeName: sdkResult?.typeName, projectUpdated: sdkResult?.projectUpdated },
    { status: 'created', kind: 'form', typeName: 'CatalogForm', projectUpdated: false },
  );
  for (const name of ['CatalogForm.cs', 'CatalogForm.Designer.cs', 'CatalogForm.resx']) {
    assert.ok(fs.existsSync(path.join(sdkAddDir, name)), `SDK Add command did not create ${name}`);
  }
  const sdkFormUri = vscode.Uri.file(path.join(sdkAddDir, 'CatalogForm.cs'));
  await waitFor(() => Boolean(activeCustomTab(sdkFormUri)), 'SDK Add command did not open CatalogForm in the custom editor');
  assert.strictEqual(testApi.openDesignerState(sdkFormUri)?.dirty, false, 'new SDK form opened dirty');
  assert.deepStrictEqual(fs.readFileSync(sdkProject), sdkProjectBefore, 'SDK implicit item Add rewrote the project file');
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

  // V2-FND-001-S007 — drive the registered public Explorer Add Component command with a traversal name. The product
  // must return its typed invalid-name refusal before creating any source, generated source, resource, or project edit.
  const sdkEntriesBeforeRefusal = fs.readdirSync(sdkAddDir).sort();
  const unsafeResult = await vscode.commands.executeCommand<ScaffoldCommandResult>(
    'winformsDesigner.addComponent',
    vscode.Uri.file(sdkAddDir),
    { name: '..\\Injected' },
  );
  assert.deepStrictEqual(
    { status: unsafeResult?.status, errorCode: unsafeResult?.errorCode },
    { status: 'refused', errorCode: 'invalidName' },
  );
  assert.deepStrictEqual(fs.readdirSync(sdkAddDir).sort(), sdkEntriesBeforeRefusal, 'unsafe Add changed the directory');

  // V2-FND-001-S008 — inject the filesystem failure at the third artifact of the SAME product orchestration used by
  // Explorer Add. The atomic scaffold wrapper must compensate the already-created source and generated source while
  // leaving the implicit SDK project byte-identical.
  const sdkEntriesBeforeRollback = fs.readdirSync(sdkAddDir).sort();
  const sdkProjectBeforeRollback = fs.readFileSync(sdkProject);
  const rollbackResult = await testApi.addScaffoldWithInjectedWriteFailure(
    'form',
    vscode.Uri.file(sdkAddDir),
    'PartialRollback',
    'PartialRollback.resx',
  );
  assert.deepStrictEqual(
    { status: rollbackResult.status, errorCode: rollbackResult.errorCode },
    { status: 'refused', errorCode: 'applyFailed' },
  );
  assert.deepStrictEqual(fs.readdirSync(sdkAddDir).sort(), sdkEntriesBeforeRollback, 'failed Add left partial artifacts');
  assert.deepStrictEqual(fs.readFileSync(sdkProject), sdkProjectBeforeRollback, 'failed Add rewrote the SDK project');

  // V2-FND-001-S006 — classic projects need explicit dependent items. The product command now persists the project
  // atomically instead of leaving an unnoticed dirty .csproj editor, then opens the created UserControl designer.
  const classicDir = path.join(workspaceRoot, 'ClassicCatalogAdd');
  fs.mkdirSync(classicDir, { recursive: true });
  const classicProject = path.join(classicDir, 'ClassicCatalogAdd.csproj');
  fs.writeFileSync(classicProject, [
    '<Project ToolsVersion="15.0" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">',
    '  <PropertyGroup>',
    '    <RootNamespace>ClassicCatalogAdd</RootNamespace>',
    '    <TargetFrameworkVersion>v4.8</TargetFrameworkVersion>',
    '  </PropertyGroup>',
    '  <ItemGroup>',
    '    <Reference Include="System" />',
    '    <Reference Include="System.Windows.Forms" />',
    '  </ItemGroup>',
    '</Project>',
    '',
  ].join('\r\n'), 'utf8');
  const classicResult = await vscode.commands.executeCommand<ScaffoldCommandResult>(
    'winformsDesigner.addUserControl',
    vscode.Uri.file(classicProject),
    { name: 'CatalogControl' },
  );
  assert.deepStrictEqual(
    { status: classicResult?.status, kind: classicResult?.kind, typeName: classicResult?.typeName, projectUpdated: classicResult?.projectUpdated },
    { status: 'created', kind: 'userControl', typeName: 'CatalogControl', projectUpdated: true },
  );
  for (const [name, expected] of [['CatalogControl.cs', true], ['CatalogControl.Designer.cs', true], ['CatalogControl.resx', false]] as const) {
    assert.strictEqual(fs.existsSync(path.join(classicDir, name)), expected, `classic UserControl template state differs for ${name}`);
  }
  const classicProjectText = fs.readFileSync(classicProject, 'utf8');
  assert.match(classicProjectText, /<Compile Include="CatalogControl\.cs">\s*<SubType>UserControl<\/SubType>/);
  assert.match(classicProjectText, /<Compile Include="CatalogControl\.Designer\.cs">\s*<DependentUpon>CatalogControl\.cs<\/DependentUpon>/);
  assert.doesNotMatch(classicProjectText, /<EmbeddedResource Include="CatalogControl\.resx">/);
  const classicDocument = vscode.workspace.textDocuments.find((document) => document.uri.fsPath === classicProject);
  assert.strictEqual(classicDocument, undefined, 'classic Add opened a hidden project document');
  const classicControlUri = vscode.Uri.file(path.join(classicDir, 'CatalogControl.cs'));
  await waitFor(() => Boolean(activeCustomTab(classicControlUri)), 'classic Add did not open CatalogControl in the custom editor');
  for (const [name, text] of [['CatalogControl.resx', '<root><!-- neutral --></root>\r\n'], ['CatalogControl.ru.resx', '<root><!-- ru --></root>\r\n']] as const) fs.writeFileSync(path.join(classicDir, name), text, 'utf8');
  const classicSuccessfulCopy = path.join(classicDir, 'SavedCatalogControl.cs');
  await testApi.saveOpenDesignerAs(classicControlUri, vscode.Uri.file(classicSuccessfulCopy));
  for (const suffix of ['.cs', '.Designer.cs', '.resx', '.ru.resx']) {
    const destination = path.join(classicDir, `SavedCatalogControl${suffix}`);
    assert.ok(fs.existsSync(destination), `successful classic Save As did not create ${path.basename(destination)}`);
  }
  const classicAfterSaveAs = fs.readFileSync(classicProject, 'utf8');
  assert.match(classicAfterSaveAs, /<Compile Include="SavedCatalogControl\.cs">\s*<SubType>Form<\/SubType>/);
  assert.match(classicAfterSaveAs, /<Compile Include="SavedCatalogControl\.Designer\.cs">\s*<DependentUpon>SavedCatalogControl\.cs<\/DependentUpon>/);
  assert.match(classicAfterSaveAs, /<EmbeddedResource Include="SavedCatalogControl\.resx">\s*<DependentUpon>SavedCatalogControl\.cs<\/DependentUpon>/);
  assert.match(classicAfterSaveAs, /<EmbeddedResource Include="SavedCatalogControl\.ru\.resx">\s*<DependentUpon>SavedCatalogControl\.cs<\/DependentUpon>/);
  assert.match(fs.readFileSync(classicSuccessfulCopy, 'utf8'), /partial class SavedCatalogControl/);
  assert.match(fs.readFileSync(path.join(classicDir, 'SavedCatalogControl.Designer.cs'), 'utf8'), /partial class SavedCatalogControl/);
  const classicCopySource = path.join(classicDir, 'CopyOfCatalogControl.cs');
  const classicCopyResx = path.join(classicDir, 'CopyOfCatalogControl.resx');
  fs.writeFileSync(classicCopySource, '// existing classic source\r\n', 'utf8');
  fs.writeFileSync(classicCopyResx, '<root><!-- existing classic resource --></root>\r\n', 'utf8');
  await assert.rejects(
    () => testApi.saveOpenDesignerAs(classicControlUri, vscode.Uri.file(classicCopySource)),
    (error: Error) => error.message.includes('CopyOfCatalogControl.cs')
      && error.message.includes('CopyOfCatalogControl.resx'),
    'classic-project Save As should aggregate visible and hidden destination collisions',
  );
  assert.ok(
    !fs.existsSync(path.join(classicDir, 'CopyOfCatalogControl.Designer.cs')),
    'classic-project Save As wrote a sidecar before refusing destination collisions',
  );
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

  // V2-FND-001-S009 — actual Visual Studio 18.7 refuses a Form nested in another type. The product must refuse at
  // the mandatory pre-render gate too, preserving both partials and the project instead of drawing a plausible but
  // incompatible canvas from the syntax-only engine.
  const ownerNestedDir = path.join(workspaceRoot, 'OwnerNested');
  fs.mkdirSync(ownerNestedDir, { recursive: true });
  const nestedSource = path.join(ownerNestedDir, 'NestedForm.cs');
  const nestedDesigner = path.join(ownerNestedDir, 'NestedForm.Designer.cs');
  fs.writeFileSync(nestedSource, [
    'using System.Windows.Forms;',
    'namespace DemoApp;',
    'public partial class OwnerOuter',
    '{',
    '    public partial class InnerForm : Form',
    '    {',
    '        public InnerForm() => InitializeComponent();',
    '    }',
    '}',
    '',
  ].join('\r\n'), 'utf8');
  fs.writeFileSync(nestedDesigner, [
    'namespace DemoApp;',
    'public partial class OwnerOuter',
    '{',
    '    public partial class InnerForm',
    '    {',
    '        private void InitializeComponent()',
    '        {',
    '            this.Name = "InnerForm";',
    '        }',
    '    }',
    '}',
    '',
  ].join('\r\n'), 'utf8');
  const nestedSourceBefore = fs.readFileSync(nestedSource);
  const nestedDesignerBefore = fs.readFileSync(nestedDesigner);
  const nestedProjectBefore = fs.readFileSync(sdkProject);
  const nestedUri = vscode.Uri.file(nestedSource);
  await vscode.commands.executeCommand('vscode.openWith', nestedUri, designerViewType);
  await waitFor(
    () => testApi.openDesignerState(nestedUri)?.ownerDiagnosticCode === 'NESTED_DESIGNER_UNSUPPORTED',
    'nested partial did not reach the Visual Studio-compatible refusal',
    30_000,
  );
  const nestedState = testApi.openDesignerState(nestedUri);
  assert.strictEqual(nestedState?.ownerDiagnosticCode, 'NESTED_DESIGNER_UNSUPPORTED');
  assert.strictEqual(nestedState?.ownerTypeName, 'DemoApp.OwnerOuter+InnerForm');
  assert.strictEqual(nestedState?.renderReady, false);
  assert.strictEqual(nestedState?.renderFailureCause, 'NESTED_DESIGNER_UNSUPPORTED');
  assert.match(nestedState?.renderFailureMessage ?? '', /Visual Studio/i);
  assert.deepStrictEqual(fs.readFileSync(nestedSource), nestedSourceBefore);
  assert.deepStrictEqual(fs.readFileSync(nestedDesigner), nestedDesignerBefore);
  assert.deepStrictEqual(fs.readFileSync(sdkProject), nestedProjectBefore);
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

  // W5 project-wide Events parity: a compatible handler in a non-sibling partial is offered/accepted by the actual
  // product session. The primary Form.cs must not receive a duplicate stub; only the designer wiring becomes dirty.
  const projectEventsDir = path.join(workspaceRoot, 'ProjectEvents');
  const projectEventsPartsDir = path.join(projectEventsDir, 'Parts');
  fs.mkdirSync(projectEventsPartsDir, { recursive: true });
  const projectEventsSource = path.join(projectEventsDir, 'ProjectEventsForm.cs');
  const projectEventsDesigner = path.join(projectEventsDir, 'ProjectEventsForm.Designer.cs');
  const projectEventsPartial = path.join(projectEventsPartsDir, 'ProjectEventsForm.Events.cs');
  const projectEventsSourceText = [
    'namespace DemoApp;',
    'public partial class ProjectEventsForm : System.Windows.Forms.Form',
    '{',
    '    public ProjectEventsForm() => InitializeComponent();',
    '}',
    '',
  ].join('\r\n');
  const projectEventsDesignerText = [
    'namespace DemoApp;',
    'partial class ProjectEventsForm',
    '{',
    '    private System.Windows.Forms.Button button1;',
    '    private void InitializeComponent()',
    '    {',
    '        this.button1 = new System.Windows.Forms.Button();',
    '        this.button1.Name = "button1";',
    '        this.Controls.Add(this.button1);',
    '    }',
    '}',
    '',
  ].join('\r\n');
  const projectEventsPartialText = [
    'namespace DemoApp;',
    'public partial class ProjectEventsForm',
    '{',
    '    private void ProjectWideClick(object sender, System.EventArgs e)',
    '    {',
    '    }',
    '}',
    '',
  ].join('\r\n');
  fs.writeFileSync(projectEventsSource, projectEventsSourceText, 'utf8');
  fs.writeFileSync(projectEventsDesigner, projectEventsDesignerText, 'utf8');
  fs.writeFileSync(projectEventsPartial, projectEventsPartialText, 'utf8');
  const projectEventsUri = vscode.Uri.file(projectEventsSource);
  await vscode.commands.executeCommand('vscode.openWith', projectEventsUri, designerViewType);
  await waitFor(
    () => testApi.openDesignerState(projectEventsUri)?.renderReady === true,
    `project-wide event form did not render: ${JSON.stringify(testApi.openDesignerState(projectEventsUri))}`,
    30_000,
  );
  await testApi.setOpenDesignerHandler(projectEventsUri, 'button1', 'Click', 'ProjectWideClick');
  const projectEventsState = testApi.openDesignerState(projectEventsUri);
  assert.strictEqual(projectEventsState?.dirty, true, 'project-wide handler selection did not dirty the designer document');
  assert.match(projectEventsState?.designerText ?? '', /this\.button1\.Click \+= new System\.EventHandler\(this\.ProjectWideClick\);/);
  assert.strictEqual(fs.readFileSync(projectEventsSource, 'utf8'), projectEventsSourceText,
    'project-wide handler selection inserted a duplicate stub into the primary code-behind');
  assert.strictEqual(fs.readFileSync(projectEventsPartial, 'utf8'), projectEventsPartialText,
    'project-wide handler selection mutated the existing partial handler file');
  await testApi.saveOpenDesigner(projectEventsUri);
  assert.match(fs.readFileSync(projectEventsDesigner, 'utf8'), /this\.button1\.Click \+= new System\.EventHandler\(this\.ProjectWideClick\);/);
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

  // W5 inline InitializeComponent: the source file itself is the CustomDocument. A normal property edit must remain
  // byte-local in that file, save through the real provider, and never manufacture a sibling .Designer.cs.
  const inlineDir = path.join(workspaceRoot, 'InlineDesigner');
  fs.mkdirSync(inlineDir, { recursive: true });
  const inlineSource = path.join(inlineDir, 'InlineForm.cs');
  const inlineDesignerSibling = path.join(inlineDir, 'InlineForm.Designer.cs');
  fs.writeFileSync(inlineSource, [
    'namespace DemoApp;',
    'public partial class InlineForm : System.Windows.Forms.Form',
    '{',
    '    private System.Windows.Forms.Button button1;',
    '    public InlineForm() => InitializeComponent();',
    '    private void InitializeComponent()',
    '    {',
    '        this.button1 = new System.Windows.Forms.Button();',
    '        this.button1.Name = "button1";',
    '        this.button1.Text = "Before";',
    '        this.Controls.Add(this.button1);',
    '    }',
    '}',
    '',
  ].join('\r\n'), 'utf8');
  const inlineUri = vscode.Uri.file(inlineSource);
  await vscode.commands.executeCommand('vscode.openWith', inlineUri, designerViewType);
  await waitFor(
    () => testApi.openDesignerState(inlineUri)?.renderReady === true,
    `inline InitializeComponent form did not render: ${JSON.stringify(testApi.openDesignerState(inlineUri))}`,
    30_000,
  );
  assert.strictEqual(path.normalize(testApi.openDesignerState(inlineUri)?.designerFile ?? ''), path.normalize(inlineSource));
  await testApi.editOpenDesignerProperty(inlineUri, 'button1', 'Text', 'System.String', false, 'After');
  assert.match(testApi.openDesignerState(inlineUri)?.designerText ?? '', /this\.button1\.Text = "After";/);
  await testApi.createOpenDesignerHandler(inlineUri, 'button1', 'Click');
  assert.match(testApi.openDesignerState(inlineUri)?.designerText ?? '', /this\.button1\.Click \+= new System\.EventHandler\(this\.button1_Click\);/);
  assert.match(testApi.openDesignerState(inlineUri)?.designerText ?? '', /void button1_Click\(object sender, System\.EventArgs e\)/);
  await testApi.saveOpenDesigner(inlineUri);
  assert.match(fs.readFileSync(inlineSource, 'utf8'), /this\.button1\.Text = "After";/);
  assert.match(fs.readFileSync(inlineSource, 'utf8'), /this\.button1\.Click \+= new System\.EventHandler\(this\.button1_Click\);/);
  assert.match(fs.readFileSync(inlineSource, 'utf8'), /void button1_Click\(object sender, System\.EventArgs e\)/);
  assert.match(fs.readFileSync(inlineSource, 'utf8'), /public InlineForm\(\) => InitializeComponent\(\);/);
  assert.strictEqual(fs.existsSync(inlineDesignerSibling), false, 'inline designer created an unexpected .Designer.cs sibling');
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

  // W5 localizable structure: a toolbox add in Language=(Default) is a real source+neutral-resx transaction. The
  // product host must render the new control, persist both halves, and native Undo must compensate both byte-for-byte.
  const localizedStructureDir = path.join(workspaceRoot, 'LocalizedStructure');
  fs.mkdirSync(localizedStructureDir, { recursive: true });
  const localizedStructureSource = path.join(localizedStructureDir, 'LocalizableForm.cs');
  const localizedStructureDesigner = path.join(localizedStructureDir, 'LocalizableForm.Designer.cs');
  const localizedStructureResx = path.join(localizedStructureDir, 'LocalizableForm.resx');
  fs.writeFileSync(localizedStructureSource, [
    'namespace SampleApp',
    '{',
    '    public partial class LocalizableForm : System.Windows.Forms.Form',
    '    {',
    '        public LocalizableForm() => InitializeComponent();',
    '    }',
    '}',
    '',
  ].join('\r\n'), 'utf8');
  fs.copyFileSync(path.join(repoRoot, 'engine', 'samples', 'LocalizableForm.Designer.cs'), localizedStructureDesigner);
  fs.copyFileSync(path.join(repoRoot, 'engine', 'samples', 'LocalizableForm.resx'), localizedStructureResx);
  const localizedSourceBefore = fs.readFileSync(localizedStructureDesigner, 'utf8');
  const localizedResxBefore = fs.readFileSync(localizedStructureResx, 'utf8');
  const localizedUri = vscode.Uri.file(localizedStructureSource);
  await vscode.commands.executeCommand('vscode.openWith', localizedUri, designerViewType);
  await waitFor(
    () => testApi.openDesignerState(localizedUri)?.renderReady === true,
    `localizable structure form did not render: ${JSON.stringify(testApi.openDesignerState(localizedUri))}`,
    30_000,
  );
  const localizedIdsBefore = new Set(testApi.openDesignerState(localizedUri)?.controls.map((control) => control.id) ?? []);
  await testApi.addOpenDesignerControl(localizedUri, 'Button', 'this', 33, 44);
  await waitFor(
    () => (testApi.openDesignerState(localizedUri)?.controls ?? []).some((control) => !localizedIdsBefore.has(control.id)),
    `localized toolbox add did not reach the rendered product graph: ${JSON.stringify(testApi.openDesignerState(localizedUri))}`,
    30_000,
  );
  const localizedAdded = (testApi.openDesignerState(localizedUri)?.controls ?? [])
    .find((control) => !localizedIdsBefore.has(control.id));
  assert.ok(localizedAdded, 'localized toolbox add did not expose a new control identity');
  const localizedSourceAfter = fs.readFileSync(localizedStructureDesigner, 'utf8');
  const localizedResxAfter = fs.readFileSync(localizedStructureResx, 'utf8');
  assert.match(localizedSourceAfter, new RegExp(`resources\\.ApplyResources\\(this\\.${localizedAdded.id}, "${localizedAdded.id}"\\);`));
  assert.ok(!localizedSourceAfter.includes(`this.${localizedAdded.id}.Location =`),
    'localized toolbox add left a visual property assignment in generated source');
  assert.ok(localizedResxAfter.includes(`name="${localizedAdded.id}.Location"`),
    'localized toolbox add did not persist Location in the neutral resx');
  const localizedRemoved = await testApi.removeOpenDesignerControl(localizedUri, localizedAdded.id);
  assert.strictEqual(localizedRemoved, 1, `localized structural delete was refused; state=${JSON.stringify(
    testApi.openDesignerState(localizedUri))}; source=${fs.readFileSync(localizedStructureDesigner, 'utf8')}; resx=${
    fs.readFileSync(localizedStructureResx, 'utf8')}`);
  await waitFor(
    () => !(testApi.openDesignerState(localizedUri)?.controls ?? []).some((control) => control.id === localizedAdded.id),
    'localized structural delete did not remove the control from the rendered graph',
    30_000,
  );
  assert.ok(!fs.readFileSync(localizedStructureDesigner, 'utf8').includes(`this.${localizedAdded.id}`),
    'localized structural delete left source references to the removed control');
  assert.ok(!fs.readFileSync(localizedStructureResx, 'utf8').includes(`name="${localizedAdded.id}.`),
    'localized structural delete left neutral resource keys for the removed control');
  await runDesignerHistoryCommand(testApi, localizedUri, 'undo');
  await waitFor(
    () => fs.readFileSync(localizedStructureDesigner, 'utf8') === localizedSourceAfter
      && fs.readFileSync(localizedStructureResx, 'utf8') === localizedResxAfter,
    'Undo did not restore the localized structural delete as one source/resource unit',
    30_000,
  );
  await runDesignerHistoryCommand(testApi, localizedUri, 'undo');
  await waitFor(
    () => fs.readFileSync(localizedStructureDesigner, 'utf8') === localizedSourceBefore
      && fs.readFileSync(localizedStructureResx, 'utf8') === localizedResxBefore,
    'Undo did not compensate both localizable source and neutral resx',
    30_000,
  );
  const reparentBaselineIds = new Set(testApi.openDesignerState(localizedUri)?.controls.map((control) => control.id) ?? []);
  await testApi.addOpenDesignerControl(localizedUri, 'Panel', 'this', 90, 90, 180, 100);
  await waitFor(
    () => (testApi.openDesignerState(localizedUri)?.controls ?? []).some((control) => !reparentBaselineIds.has(control.id)),
    'localized reparent setup did not add its Panel',
    30_000,
  );
  const localizedPanel = (testApi.openDesignerState(localizedUri)?.controls ?? [])
    .find((control) => !reparentBaselineIds.has(control.id));
  assert.ok(localizedPanel, 'localized reparent setup Panel has no product identity');
  const localizedPanelOnlySource = fs.readFileSync(localizedStructureDesigner, 'utf8');
  const localizedPanelOnlyResx = fs.readFileSync(localizedStructureResx, 'utf8');
  const beforeButtonIds = new Set(testApi.openDesignerState(localizedUri)?.controls.map((control) => control.id) ?? []);
  await testApi.addOpenDesignerControl(localizedUri, 'Button', 'this', 20, 20);
  await waitFor(
    () => (testApi.openDesignerState(localizedUri)?.controls ?? []).some((control) => !beforeButtonIds.has(control.id)),
    'localized reparent setup did not add its Button',
    30_000,
  );
  const localizedReparentButton = (testApi.openDesignerState(localizedUri)?.controls ?? [])
    .find((control) => !beforeButtonIds.has(control.id));
  assert.ok(localizedReparentButton, 'localized reparent setup Button has no product identity');
  const localizedBeforeReparentSource = fs.readFileSync(localizedStructureDesigner, 'utf8');
  const localizedBeforeReparentResx = fs.readFileSync(localizedStructureResx, 'utf8');
  await testApi.reparentOpenDesignerControl(localizedUri, localizedReparentButton.id, localizedPanel.id);
  await waitFor(
    () => fs.readFileSync(localizedStructureDesigner, 'utf8')
      .includes(`this.${localizedPanel.id}.Controls.Add(this.${localizedReparentButton.id});`),
    'localized reparent did not persist the destination Controls.Add',
    30_000,
  );
  const localizedReparentSource = fs.readFileSync(localizedStructureDesigner, 'utf8');
  assert.ok(!localizedReparentSource.includes(`this.${localizedReparentButton.id}.Location =`),
    'localized reparent leaked rebased Location into generated source');
  assert.ok(fs.readFileSync(localizedStructureResx, 'utf8').includes(`name="${localizedReparentButton.id}.Location"`),
    'localized reparent did not preserve rebased Location in neutral resources');
  await runDesignerHistoryCommand(testApi, localizedUri, 'undo');
  await waitFor(
    () => fs.readFileSync(localizedStructureDesigner, 'utf8') === localizedBeforeReparentSource
      && fs.readFileSync(localizedStructureResx, 'utf8') === localizedBeforeReparentResx,
    'Undo did not restore localized reparent source/resources',
    30_000,
  );
  await runDesignerHistoryCommand(testApi, localizedUri, 'undo');
  await waitFor(
    () => fs.readFileSync(localizedStructureDesigner, 'utf8') === localizedPanelOnlySource
      && fs.readFileSync(localizedStructureResx, 'utf8') === localizedPanelOnlyResx,
    'localized reparent Button add did not undo cleanly',
    30_000,
  );
  await runDesignerHistoryCommand(testApi, localizedUri, 'undo');
  await waitFor(
    () => fs.readFileSync(localizedStructureDesigner, 'utf8') === localizedSourceBefore
      && fs.readFileSync(localizedStructureResx, 'utf8') === localizedResxBefore,
    'localized reparent setup controls did not undo back to the original form',
    30_000,
  );
  await testApi.createOpenDesignerHandler(localizedUri, 'button1', 'Click');
  await waitFor(
    () => /this\.button1\.Click \+= new System\.EventHandler\(this\.button1_Click\);/
      .test(testApi.openDesignerState(localizedUri)?.designerText ?? ''),
    'localizable form did not accept an engine-verified event wiring',
    30_000,
  );
  const localizedCodeDocument = vscode.workspace.textDocuments.find(
    (document) => document.uri.scheme === 'file' && path.normalize(document.uri.fsPath) === path.normalize(localizedStructureSource),
  );
  assert.ok(localizedCodeDocument, 'localizable handler code document was not opened');
  assert.match(localizedCodeDocument.getText(), /void button1_Click\(object sender, System\.EventArgs e\)/);
  await testApi.saveOpenDesigner(localizedUri);
  assert.strictEqual(await localizedCodeDocument.save(), true, 'localizable handler code-behind did not save');
  assert.match(fs.readFileSync(localizedStructureDesigner, 'utf8'), /this\.button1\.Click \+= new System\.EventHandler\(this\.button1_Click\);/);
  assert.match(fs.readFileSync(localizedStructureSource, 'utf8'), /void button1_Click\(object sender, System\.EventArgs e\)/);
  assert.strictEqual(fs.readFileSync(localizedStructureResx, 'utf8'), localizedResxBefore,
    'event creation on a localizable form unexpectedly rewrote neutral resources');
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');

  // real-parity W0.1 — a form owned through a .shproj/.projitems import is a normal Visual Studio topology. The
  // product owner gate must follow the static import and render it through the one importing project.
  const sharedDir = path.join(workspaceFolder.uri.fsPath, 'SharedTopology');
  const sharedConsumerDir = path.join(workspaceFolder.uri.fsPath, 'SharedConsumer');
  fs.mkdirSync(sharedDir, { recursive: true });
  fs.mkdirSync(sharedConsumerDir, { recursive: true });
  const sharedSource = path.join(sharedDir, 'SharedTopologyForm.cs');
  const sharedDesigner = path.join(sharedDir, 'SharedTopologyForm.Designer.cs');
  const sharedProjitems = path.join(sharedDir, 'SharedTopology.projitems');
  const sharedShproj = path.join(sharedDir, 'SharedTopology.shproj');
  const sharedConsumerProject = path.join(sharedConsumerDir, 'SharedConsumer.csproj');
  fs.writeFileSync(sharedSource,
    'namespace SharedTopology; public partial class SharedTopologyForm : System.Windows.Forms.Form { public SharedTopologyForm() => InitializeComponent(); }\r\n',
    'utf8');
  fs.writeFileSync(sharedDesigner,
    'namespace SharedTopology; partial class SharedTopologyForm { private void InitializeComponent() { this.Name = "SharedTopologyForm"; } }\r\n',
    'utf8');
  fs.writeFileSync(sharedProjitems, [
    '<Project>',
    '  <ItemGroup>',
    '    <Compile Include="$(MSBuildThisFileDirectory)SharedTopologyForm.cs" />',
    '    <Compile Include="$(MSBuildThisFileDirectory)SharedTopologyForm.Designer.cs" />',
    '  </ItemGroup>',
    '</Project>',
    '',
  ].join('\r\n'), 'utf8');
  fs.writeFileSync(sharedShproj,
    '<Project><Import Project="SharedTopology.projitems" Label="Shared" /></Project>\r\n', 'utf8');
  fs.writeFileSync(sharedConsumerProject, [
    '<Project Sdk="Microsoft.NET.Sdk">',
    '  <PropertyGroup><TargetFramework>net10.0-windows</TargetFramework><UseWindowsForms>true</UseWindowsForms></PropertyGroup>',
    '  <Import Project="..\\SharedTopology\\SharedTopology.projitems" Label="Shared" />',
    '</Project>',
    '',
  ].join('\r\n'), 'utf8');
  execFileSync('dotnet', ['build', sharedConsumerProject, '--nologo', '-v:q'], {
    cwd: sharedConsumerDir,
    env: process.env,
    stdio: 'pipe',
  });
  const sharedDiscoveredProjects = await vscode.workspace.findFiles('**/*.csproj', '**/{bin,obj,node_modules}/**', 200);
  assert.ok(
    sharedDiscoveredProjects.some((project) => path.normalize(project.fsPath) === path.normalize(sharedConsumerProject)),
    `workspace.findFiles did not discover the shared importer: ${sharedDiscoveredProjects.map((project) => project.fsPath).join(', ')}`,
  );
  const sharedUri = vscode.Uri.file(sharedSource);
  await vscode.commands.executeCommand('vscode.openWith', sharedUri, designerViewType);
  await waitFor(
    () => testApi.openDesignerState(sharedUri)?.ownerDiagnosticCode !== null,
    'shared .projitems owner resolution did not complete',
    30_000,
  );
  assert.strictEqual(
    testApi.openDesignerState(sharedUri)?.ownerDiagnosticCode,
    'NONE',
    `shared .projitems owner refused: ${JSON.stringify(testApi.openDesignerState(sharedUri))}`,
  );
  await waitFor(
    () => testApi.openDesignerState(sharedUri)?.renderReady === true,
    `shared .projitems form did not render through its importing project: ${JSON.stringify(testApi.openDesignerState(sharedUri))}`,
    30_000,
  );
  assert.strictEqual(
    path.normalize(testApi.openDesignerState(sharedUri)?.ownerProjectPath ?? ''),
    path.normalize(sharedConsumerProject),
  );
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

  // real-parity W0.1 — an inner SDK project owns its implicit sources; the outer SDK default glob must stop at the
  // nested project boundary instead of manufacturing an ambiguous two-project owner.
  const nestedProjectDir = path.join(workspaceRoot, 'NestedSdkApp');
  fs.mkdirSync(nestedProjectDir, { recursive: true });
  const nestedProject = path.join(nestedProjectDir, 'NestedSdkApp.csproj');
  const nestedProjectSource = path.join(nestedProjectDir, 'NestedProjectForm.cs');
  const nestedProjectDesigner = path.join(nestedProjectDir, 'NestedProjectForm.Designer.cs');
  fs.writeFileSync(nestedProject,
    '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0-windows</TargetFramework><UseWindowsForms>true</UseWindowsForms></PropertyGroup></Project>\r\n',
    'utf8');
  fs.writeFileSync(nestedProjectSource,
    'namespace NestedSdkApp; public partial class NestedProjectForm : System.Windows.Forms.Form { public NestedProjectForm() => InitializeComponent(); }\r\n',
    'utf8');
  fs.writeFileSync(nestedProjectDesigner,
    'namespace NestedSdkApp; partial class NestedProjectForm { private void InitializeComponent() { this.Name = "NestedProjectForm"; } }\r\n',
    'utf8');
  execFileSync('dotnet', ['build', nestedProject, '--nologo', '-v:q'], {
    cwd: nestedProjectDir,
    env: process.env,
    stdio: 'pipe',
  });
  const nestedProjectUri = vscode.Uri.file(nestedProjectSource);
  await vscode.commands.executeCommand('vscode.openWith', nestedProjectUri, designerViewType);
  await waitFor(
    () => testApi.openDesignerState(nestedProjectUri)?.ownerDiagnosticCode !== null,
    'nested SDK project owner resolution did not complete',
    30_000,
  );
  assert.strictEqual(
    testApi.openDesignerState(nestedProjectUri)?.ownerDiagnosticCode,
    'NONE',
    `nested SDK owner refused: ${JSON.stringify(testApi.openDesignerState(nestedProjectUri))}`,
  );
  await waitFor(
    () => testApi.openDesignerState(nestedProjectUri)?.renderReady === true,
    `nested SDK project form did not render through the inner owner: ${JSON.stringify(testApi.openDesignerState(nestedProjectUri))}`,
    30_000,
  );
  assert.strictEqual(
    path.normalize(testApi.openDesignerState(nestedProjectUri)?.ownerProjectPath ?? ''),
    path.normalize(nestedProject),
  );
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

  // W5 solution topology: a trusted SLNX may explicitly reference a C# project outside the opened workspace folder.
  // The product owner gate must include that solution project instead of reporting NO_PROJECT for its linked form.
  const solutionLinkedDir = path.join(workspaceRoot, 'SolutionLinked');
  fs.mkdirSync(solutionLinkedDir, { recursive: true });
  const solutionLinkedSource = path.join(solutionLinkedDir, 'SolutionLinkedForm.cs');
  const solutionLinkedDesigner = path.join(solutionLinkedDir, 'SolutionLinkedForm.Designer.cs');
  fs.writeFileSync(solutionLinkedSource,
    'namespace SolutionLinked; public partial class SolutionLinkedForm : System.Windows.Forms.Form { public SolutionLinkedForm() => InitializeComponent(); }\r\n',
    'utf8');
  fs.writeFileSync(solutionLinkedDesigner,
    'namespace SolutionLinked; partial class SolutionLinkedForm { private void InitializeComponent() { this.Name = "SolutionLinkedForm"; } }\r\n',
    'utf8');
  const rootBeforeSolutionLink = fs.readFileSync(sdkProject, 'utf8');
  fs.writeFileSync(sdkProject, rootBeforeSolutionLink.replace(
    '</Project>',
    '  <ItemGroup>\r\n    <Compile Remove="SolutionLinked/SolutionLinkedForm.cs" />\r\n    <Compile Remove="SolutionLinked/SolutionLinkedForm.Designer.cs" />\r\n  </ItemGroup>\r\n</Project>'),
  'utf8');
  const externalSolutionProjectDir = path.join(path.dirname(workspaceFolder.uri.fsPath), `WfdSolutionExternal-${process.pid}`);
  fs.mkdirSync(externalSolutionProjectDir, { recursive: true });
  const externalSolutionProject = path.join(externalSolutionProjectDir, 'ExternalOwner.csproj');
  const relativeLinkedSource = path.relative(externalSolutionProjectDir, solutionLinkedSource).replace(/\\/g, '/');
  const relativeLinkedDesigner = path.relative(externalSolutionProjectDir, solutionLinkedDesigner).replace(/\\/g, '/');
  fs.writeFileSync(externalSolutionProject, [
    '<Project Sdk="Microsoft.NET.Sdk">',
    '  <PropertyGroup><TargetFramework>net10.0-windows</TargetFramework><UseWindowsForms>true</UseWindowsForms><EnableDefaultCompileItems>false</EnableDefaultCompileItems></PropertyGroup>',
    '  <ItemGroup>',
    `    <Compile Include="${relativeLinkedSource}" Link="SolutionLinkedForm.cs" />`,
    `    <Compile Include="${relativeLinkedDesigner}" Link="SolutionLinkedForm.Designer.cs" />`,
    '  </ItemGroup>',
    '</Project>',
    '',
  ].join('\r\n'), 'utf8');
  const slnxPath = path.join(workspaceFolder.uri.fsPath, 'ExternalOwner.slnx');
  const relativeExternalProject = path.relative(path.dirname(slnxPath), externalSolutionProject).replace(/\\/g, '/');
  fs.writeFileSync(slnxPath, `<Solution><Project Path="${relativeExternalProject}" /></Solution>\r\n`, 'utf8');
  const solutionLinkedUri = vscode.Uri.file(solutionLinkedSource);
  await vscode.commands.executeCommand('vscode.openWith', solutionLinkedUri, designerViewType);
  await waitFor(
    () => testApi.openDesignerState(solutionLinkedUri)?.ownerDiagnosticCode !== null,
    'SLNX-linked project owner resolution did not complete',
    30_000,
  );
  assert.strictEqual(
    testApi.openDesignerState(solutionLinkedUri)?.ownerDiagnosticCode,
    'NONE',
    `SLNX project owner refused: ${JSON.stringify(testApi.openDesignerState(solutionLinkedUri))}`,
  );
  assert.strictEqual(
    path.normalize(testApi.openDesignerState(solutionLinkedUri)?.ownerProjectPath ?? ''),
    path.normalize(externalSolutionProject),
  );
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  fs.rmSync(externalSolutionProjectDir, { recursive: true, force: true });
  fs.rmSync(slnxPath, { force: true });

  // V2-FND-001-S010 — two explicit projects own one shared partial. Remove that folder from the disposable root SDK
  // project's implicit glob so the gate sees exactly the two real contenders. Both halves are proved below: two
  // MODERN co-owners resolve to a deterministic ordinal-first pick and render (the owner never reaches the renderer
  // there), while a modern + classic pair stays fail-closed AMBIGUOUS_OWNER because the owner would select which
  // compiled binary the form is instantiated from. Neither half mutates a byte.
  const ambiguousDir = path.join(workspaceRoot, 'OwnerAmbiguous');
  const appOneDir = path.join(ambiguousDir, 'AppOne');
  const appTwoDir = path.join(ambiguousDir, 'AppTwo');
  fs.mkdirSync(appOneDir, { recursive: true });
  fs.mkdirSync(appTwoDir, { recursive: true });
  const rootProjectText = fs.readFileSync(sdkProject, 'utf8');
  assert.ok(rootProjectText.includes('</Project>'));
  fs.writeFileSync(
    sdkProject,
    rootProjectText.replace(
      '</Project>',
      '  <ItemGroup>\r\n    <Compile Remove="OwnerAmbiguous/SharedForm.cs" />\r\n    <Compile Remove="OwnerAmbiguous/SharedForm.Designer.cs" />\r\n  </ItemGroup>\r\n\r\n</Project>',
    ),
    'utf8',
  );
  const ambiguousSource = path.join(ambiguousDir, 'SharedForm.cs');
  const ambiguousDesigner = path.join(ambiguousDir, 'SharedForm.Designer.cs');
  const ambiguousSourceText = 'namespace DemoApp; public partial class SharedForm : System.Windows.Forms.Form { public SharedForm() => InitializeComponent(); }\r\n';
  const ambiguousDesignerText = 'namespace DemoApp; partial class SharedForm { private void InitializeComponent() { this.Name = "SharedForm"; } }\r\n';
  fs.writeFileSync(ambiguousSource, ambiguousSourceText, 'utf8');
  fs.writeFileSync(ambiguousDesigner, ambiguousDesignerText, 'utf8');
  const explicitSharedProject = (name: string) => [
    '<Project Sdk="Microsoft.NET.Sdk">',
    '  <PropertyGroup><TargetFramework>net10.0-windows</TargetFramework><UseWindowsForms>true</UseWindowsForms></PropertyGroup>',
    '  <ItemGroup>',
    `    <Compile Include="..\\SharedForm.cs" Link="${name}.cs" />`,
    `    <Compile Include="..\\SharedForm.Designer.cs" Link="${name}.Designer.cs" />`,
    '  </ItemGroup>',
    '</Project>',
    '',
  ].join('\r\n');
  const appOneProject = path.join(appOneDir, 'AppOne.csproj');
  const appTwoProject = path.join(appTwoDir, 'AppTwo.csproj');
  fs.writeFileSync(appOneProject, explicitSharedProject('AppOneSharedForm'), 'utf8');
  fs.writeFileSync(appTwoProject, explicitSharedProject('AppTwoSharedForm'), 'utf8');
  const ambiguousBefore = [ambiguousSource, ambiguousDesigner, appOneProject, appTwoProject]
    .map((file) => Buffer.from(fs.readFileSync(file)));
  const ambiguousUri = vscode.Uri.file(ambiguousSource);
  await vscode.commands.executeCommand('vscode.openWith', ambiguousUri, designerViewType);
  // Both contenders are modern SDK projects, so neither can influence the render: the host passes no assembly and
  // the engine finds its own project by walking up from the designer file. Refusing this layout made every linked
  // file and every shared project unrenderable — worse than the previous release. The owner is now the ordinal-first
  // contender, deterministically, and BOTH are still reported so nothing about the topology is hidden.
  await waitFor(
    () => testApi.openDesignerState(ambiguousUri)?.renderReady === true,
    () => 'two modern co-owners did not render after the deterministic owner pick: '
      + JSON.stringify(testApi.openDesignerState(ambiguousUri)),
    30_000,
  );
  const sharedState = testApi.openDesignerState(ambiguousUri);
  assert.strictEqual(sharedState?.renderFailureCause, null,
    'a resolved co-owner pick still published a render failure');
  assert.strictEqual(
    path.normalize(sharedState?.ownerProjectPath ?? ''),
    path.normalize([appOneProject, appTwoProject].sort()[0]),
    'the co-owner pick is not the ordinal-first contender',
  );
  assert.deepStrictEqual(
    [...(sharedState?.ownerPaths ?? [])].map(path.normalize).sort(),
    [appOneProject, appTwoProject].map(path.normalize).sort(),
  );
  [ambiguousSource, ambiguousDesigner, appOneProject, appTwoProject].forEach((file, index) => {
    assert.deepStrictEqual(fs.readFileSync(file), ambiguousBefore[index], `shared-owner open mutated ${path.basename(file)}`);
  });
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

  // The refusal itself is NOT gone — it is now scoped to contenders that CAN change the render. Make AppTwo a
  // classic .NET Framework project: the host would instantiate the form from one specific project's compiled
  // binary, so picking between them could render the wrong build, and the gate must stay fail-closed.
  fs.writeFileSync(appTwoProject, [
    '<Project ToolsVersion="15.0">',
    '  <PropertyGroup><TargetFrameworkVersion>v4.8</TargetFrameworkVersion></PropertyGroup>',
    '  <ItemGroup>',
    '    <Compile Include="..\\SharedForm.cs" Link="AppTwoSharedForm.cs" />',
    '    <Compile Include="..\\SharedForm.Designer.cs" Link="AppTwoSharedForm.Designer.cs" />',
    '  </ItemGroup>',
    '</Project>',
    '',
  ].join('\r\n'), 'utf8');
  const mixedBefore = [ambiguousSource, ambiguousDesigner, appOneProject, appTwoProject]
    .map((file) => Buffer.from(fs.readFileSync(file)));
  await vscode.commands.executeCommand('vscode.openWith', ambiguousUri, designerViewType);
  await waitFor(
    () => testApi.openDesignerState(ambiguousUri)?.ownerDiagnosticCode === 'AMBIGUOUS_OWNER',
    'ambiguous owner refusal did not reach the product open gate',
    30_000,
  );
  const ambiguousState = testApi.openDesignerState(ambiguousUri);
  assert.strictEqual(ambiguousState?.renderReady, false);
  assert.strictEqual(ambiguousState?.renderFailureCause, 'AMBIGUOUS_OWNER');
  assert.deepStrictEqual(
    [...(ambiguousState?.ownerPaths ?? [])].map(path.normalize).sort(),
    [appOneProject, appTwoProject].map(path.normalize).sort(),
  );
  [ambiguousSource, ambiguousDesigner, appOneProject, appTwoProject].forEach((file, index) => {
    assert.deepStrictEqual(fs.readFileSync(file), mixedBefore[index], `ambiguous open mutated ${path.basename(file)}`);
  });
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

  // V2-FND-001-S012 — Visual Studio 18.7 opens a proven empty partial as a blank surface even without
  // InitializeComponent. Match that bounded OPEN behavior without synthesizing source: the product surface is
  // explicitly read-only until the generated method returns and, unlike VS Save All, does not create a neutral resx.
  const missingDir = path.join(workspaceRoot, 'OwnerMissingInit');
  fs.mkdirSync(missingDir, { recursive: true });
  const missingSource = path.join(missingDir, 'MissingInit.cs');
  const missingDesigner = path.join(missingDir, 'MissingInit.Designer.cs');
  const missingProject = path.join(missingDir, 'MissingInit.csproj');
  const missingResource = path.join(missingDir, 'MissingInit.resx');
  const missingSourceText = 'namespace DemoApp; public partial class MissingInit : System.Windows.Forms.Form { }\r\n';
  const missingDesignerText = 'namespace DemoApp; partial class MissingInit { }\r\n';
  const missingProjectText = [
    '<Project Sdk="Microsoft.NET.Sdk">',
    '  <PropertyGroup><TargetFramework>net10.0-windows</TargetFramework><UseWindowsForms>true</UseWindowsForms></PropertyGroup>',
    '</Project>',
    '',
  ].join('\r\n');
  fs.writeFileSync(missingSource, missingSourceText, 'utf8');
  fs.writeFileSync(missingDesigner, missingDesignerText, 'utf8');
  fs.writeFileSync(missingProject, missingProjectText, 'utf8');
  const missingUri = vscode.Uri.file(missingSource);
  await vscode.commands.executeCommand('vscode.openWith', missingUri, designerViewType);
  await waitFor(
    () => {
      const state = testApi.openDesignerState(missingUri);
      return state?.renderReady === true && state.emptyInitializeComponentSurface === true;
    },
    'missing InitializeComponent form did not reach the bounded empty product surface',
    60_000,
  );
  const missingState = testApi.openDesignerState(missingUri);
  assert.strictEqual(missingState?.ownerDiagnosticCode, 'NONE');
  assert.strictEqual(missingState?.ownerTypeName, 'DemoApp.MissingInit');
  assert.strictEqual(path.normalize(missingState?.ownerProjectPath ?? ''), path.normalize(missingProject));
  assert.strictEqual(missingState?.renderFailureCause, null);
  assert.strictEqual(missingState?.controls.some((control) => control.id === 'this' && control.editable === false), true);
  await testApi.editOpenDesignerProperty(
    missingUri, 'this', 'Text', 'System.String', false, 'must not persist');
  assert.strictEqual(testApi.openDesignerState(missingUri)?.dirty, false);
  assert.strictEqual(fs.readFileSync(missingSource, 'utf8'), missingSourceText);
  assert.strictEqual(fs.readFileSync(missingDesigner, 'utf8'), missingDesignerText);
  assert.strictEqual(fs.readFileSync(missingProject, 'utf8'), missingProjectText);
  assert.strictEqual(fs.existsSync(missingResource), false, 'bounded empty surface unexpectedly created a resx');
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

  // real-parity W0.8 — never turn an AxInterop field into a near-empty successful canvas. The permanent failure
  // names the exact control/type and uses the same real Tier-D refusal code exposed by worker/toolbox selection.
  const activeXDir = path.join(workspaceRoot, 'TierDActiveX');
  fs.mkdirSync(activeXDir, { recursive: true });
  const activeXSource = path.join(activeXDir, 'ActiveXForm.cs');
  const activeXDesigner = path.join(activeXDir, 'ActiveXForm.Designer.cs');
  fs.writeFileSync(activeXSource,
    'namespace DemoApp; public partial class ActiveXForm : System.Windows.Forms.Form { public ActiveXForm() => InitializeComponent(); }\r\n',
    'utf8');
  fs.writeFileSync(activeXDesigner, [
    'namespace DemoApp;',
    'partial class ActiveXForm',
    '{',
    '    private AxWMPLib.AxWindowsMediaPlayer mediaPlayer;',
    '    private void InitializeComponent() { this.Name = "ActiveXForm"; }',
    '}',
    '',
  ].join('\r\n'), 'utf8');
  const activeXUri = vscode.Uri.file(activeXSource);
  await vscode.commands.executeCommand('vscode.openWith', activeXUri, designerViewType);
  await waitFor(
    () => testApi.openDesignerState(activeXUri)?.renderFailureCause === 'X86_WORKER_UNAVAILABLE',
    'ActiveX open did not reach the named Tier-D refusal',
    30_000,
  );
  const activeXState = testApi.openDesignerState(activeXUri);
  assert.strictEqual(activeXState?.renderReady, false);
  assert.match(activeXState?.renderFailureMessage ?? '', /mediaPlayer \(AxWMPLib\.AxWindowsMediaPlayer\)/);
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

  // V2-FND-001-S020 — exercise the host-authoritative generation gate behind the real CustomEditor. The browser has
  // its own pending-image guard; this product proof deliberately bypasses only that DOM guard and sends revision N
  // after a real fullRender has already advanced the session to N+1. Both click-selection and keyboard-nudge intents
  // must receive STALE_CANVAS without selection/source/history/disk mutation, then a fresh N+1 pick must work.
  const exerciseStaleCanvasGeneration = async (
    source: string,
    designer: string,
    expectedEngine: 'modern' | 'net48',
    alreadyOpen = false,
  ): Promise<void> => {
    const uri = vscode.Uri.file(source);
    const sourceHash = sha256File(source);
    const designerHash = sha256File(designer);
    const designerBaseline = fs.readFileSync(designer, 'utf8');
    if (!alreadyOpen) await vscode.commands.executeCommand('vscode.openWith', uri, designerViewType);
    await waitFor(
      () => testApi.openDesignerState(uri)?.renderReady === true,
      `S020 ${expectedEngine} form did not reach a successful product render`,
      60_000,
    );
    assert.strictEqual(testApi.openDesignerState(uri)?.engineKind, expectedEngine);
    const firstGeneration = testApi.openDesignerState(uri)?.renderGeneration ?? 0;
    assert.ok(firstGeneration > 0, `S020 ${expectedEngine} did not publish a positive render generation`);
    const initialPick = await testApi.sendOpenDesignerCanvasInput(uri, 'pick', 'button1', firstGeneration);
    assert.deepStrictEqual(initialPick, {
      accepted: true, refusalCode: null, renderGeneration: firstGeneration,
    });
    assert.strictEqual(testApi.openDesignerState(uri)?.currentId, 'button1');

    const pendingRender = testApi.rerenderOpenDesigner(uri);
    await waitFor(
      () => (testApi.openDesignerState(uri)?.renderGeneration ?? 0) > firstGeneration,
      `S020 ${expectedEngine} rerender did not advance the authoritative generation`,
    );
    const newerGeneration = testApi.openDesignerState(uri)?.renderGeneration ?? 0;
    const stalePick = await testApi.sendOpenDesignerCanvasInput(uri, 'pick', 'this', firstGeneration);
    assert.deepStrictEqual(stalePick, {
      accepted: false, refusalCode: 'STALE_CANVAS', renderGeneration: newerGeneration,
    });
    const staleNudge = await testApi.sendOpenDesignerCanvasInput(uri, 'nudge', 'button1', firstGeneration);
    assert.deepStrictEqual(staleNudge, {
      accepted: false, refusalCode: 'STALE_CANVAS', renderGeneration: newerGeneration,
    });
    assert.strictEqual(testApi.openDesignerState(uri)?.currentId, 'button1',
      `S020 ${expectedEngine} stale click changed selection`);
    assert.strictEqual(testApi.openDesignerState(uri)?.designerText, designerBaseline,
      `S020 ${expectedEngine} stale nudge changed Designer text`);
    assert.strictEqual(testApi.openDesignerState(uri)?.dirty, false,
      `S020 ${expectedEngine} stale input created a native history entry`);
    assert.strictEqual(sha256File(source), sourceHash, `S020 ${expectedEngine} stale input changed code-behind disk`);
    assert.strictEqual(sha256File(designer), designerHash, `S020 ${expectedEngine} stale input changed Designer disk`);
    await runDesignerHistoryCommand(testApi, uri, 'undo');
    assert.strictEqual(testApi.openDesignerState(uri)?.designerText, designerBaseline,
      `S020 ${expectedEngine} Undo found a phantom stale-input history entry`);
    assert.strictEqual(testApi.openDesignerState(uri)?.dirty, false);

    await pendingRender;
    await waitFor(() => testApi.openDesignerState(uri)?.renderReady === true,
      `S020 ${expectedEngine} rerender did not finish`);
    const freshGeneration = testApi.openDesignerState(uri)?.renderGeneration ?? 0;
    const freshPick = await testApi.sendOpenDesignerCanvasInput(uri, 'pick', 'this', freshGeneration);
    assert.deepStrictEqual(freshPick, {
      accepted: true, refusalCode: null, renderGeneration: freshGeneration,
    });
    assert.strictEqual(testApi.openDesignerState(uri)?.currentId, 'this',
      `S020 ${expectedEngine} did not resume selection on the visible generation`);
    assert.strictEqual(sha256File(source), sourceHash);
    assert.strictEqual(sha256File(designer), designerHash);
  };

  const staleCanvasSource = path.join(lifecycleDir, 'S020StaleCanvasForm.cs');
  const staleCanvasDesigner = path.join(lifecycleDir, 'S020StaleCanvasForm.Designer.cs');
  fs.writeFileSync(staleCanvasSource, [
    'using System.Windows.Forms;',
    'namespace DemoApp;',
    'public partial class S020StaleCanvasForm : Form',
    '{',
    '    public S020StaleCanvasForm() => InitializeComponent();',
    '}',
    '',
  ].join('\r\n'), 'utf8');
  fs.writeFileSync(staleCanvasDesigner, [
    'namespace DemoApp;',
    'partial class S020StaleCanvasForm',
    '{',
    '    private System.Windows.Forms.Button button1;',
    '    private void InitializeComponent()',
    '    {',
    '        this.button1 = new System.Windows.Forms.Button();',
    '        this.button1.Location = new System.Drawing.Point(24, 24);',
    '        this.button1.Name = "button1";',
    '        this.button1.Size = new System.Drawing.Size(100, 30);',
    '        this.Controls.Add(this.button1);',
    '        this.Name = "S020StaleCanvasForm";',
    '        this.ClientSize = new System.Drawing.Size(320, 180);',
    '    }',
    '}',
    '',
  ].join('\r\n'), 'utf8');
  await exerciseStaleCanvasGeneration(staleCanvasSource, staleCanvasDesigner, 'modern');
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

  // V2-FND-001-S023 / V2-FND-001-S063 — open the freshly built disposable net48 fixture from the single test workspace in its real
  // CustomEditor, then use the same outline reparent ingress as the Properties tree. The live layout rebases the
  // button's full-frame position to GroupBox-relative (10,15), and one native undo unit restores membership+geometry.
  const net48FixtureRoot = path.join(workspaceFolder.uri.fsPath, 'fixtures', 'Net48CtxFixture');
  const net48Source = path.join(net48FixtureRoot, 'ReparentForm.cs');
  const net48Designer = path.join(net48FixtureRoot, 'ReparentForm.Designer.cs');
  assert.ok(fs.existsSync(net48Source) && fs.existsSync(net48Designer), 'net48 reparent fixture is missing');
  const net48Uri = vscode.Uri.file(net48Source);
  assert.strictEqual(
    vscode.workspace.getWorkspaceFolder(net48Uri)?.uri.fsPath,
    workspaceFolder.uri.fsPath,
    'net48 fixture must remain inside the single disposable workspace',
  );
  const net48Before = fs.readFileSync(net48Designer, 'utf8');
  const net48SourceHash = sha256File(net48Source);
  const net48DesignerHash = sha256File(net48Designer);
  await vscode.commands.executeCommand('vscode.openWith', net48Uri, designerViewType);
  await waitFor(
    () => testApi.openDesignerState(net48Uri)?.renderReady === true,
    'net48 ReparentForm did not reach a successful product render',
    30_000,
  );
  assert.strictEqual(testApi.openDesignerState(net48Uri)?.engineKind, 'net48');

  // V2-FND-001-S064 — use the same outline ingress before S063's valid move, but try to place panel1 under its own
  // descendant button1. The product's current rendered tree must reject the cycle before engine mutation/history.
  const containmentRefusal = await testApi.reparentOpenDesignerControl(net48Uri, 'panel1', 'button1');
  assert.strictEqual(containmentRefusal, 'cannot move a control into its own child');
  assert.strictEqual(testApi.openDesignerState(net48Uri)?.designerText, net48Before,
    'S064 containment-cycle refusal changed Designer source');
  assert.strictEqual(testApi.openDesignerState(net48Uri)?.dirty, false,
    'S064 containment-cycle refusal created a native history entry');
  assert.strictEqual(sha256File(net48Source), net48SourceHash,
    'S064 containment-cycle refusal changed code-behind disk');
  assert.strictEqual(sha256File(net48Designer), net48DesignerHash,
    'S064 containment-cycle refusal changed Designer disk');

  await testApi.reparentOpenDesignerControl(net48Uri, 'button1', 'groupBox1');
  const net48Reparented = testApi.openDesignerState(net48Uri)?.designerText ?? '';
  assert.strictEqual(testApi.openDesignerState(net48Uri)?.dirty, true);
  assert.match(net48Reparented, /this\.groupBox1\.Controls\.Add\(this\.button1\);/);
  assert.doesNotMatch(net48Reparented, /this\.panel1\.Controls\.Add\(this\.button1\);/);
  assert.match(net48Reparented, /this\.button1\.Location = new System\.Drawing\.Point\(10, 15\);/);
  await runDesignerHistoryCommand(testApi, net48Uri, 'undo');
  await waitFor(
    () => testApi.openDesignerState(net48Uri)?.designerText === net48Before,
    'one native Undo did not restore net48 reparent membership and Location',
  );
  assert.strictEqual(testApi.openDesignerState(net48Uri)?.dirty, false);
  await runDesignerHistoryCommand(testApi, net48Uri, 'redo');
  await waitFor(
    () => testApi.openDesignerState(net48Uri)?.designerText === net48Reparented,
    'one native Redo did not reapply net48 reparent membership and Location',
  );
  await runDesignerHistoryCommand(testApi, net48Uri, 'undo');
  await waitFor(() => testApi.openDesignerState(net48Uri)?.dirty === false, 'final net48 reparent Undo stayed dirty');
  assert.strictEqual(fs.readFileSync(net48Designer, 'utf8'), net48Before, 'unsaved net48 reparent touched disk');
  await exerciseStaleCanvasGeneration(net48Source, net48Designer, 'net48', true);
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

  // V2-FND-001-S035 — exercise TabPage ownership through the real compiled-net48 CustomEditor. The second page is
  // selected, and reparent uses the same engine-authorized ingress as an outline/canvas drop: form-client (300,80)
  // becomes the live selected-page client (276,38), exactly one Controls.Add owner survives, and one native history unit owns
  // both membership and Location.
  const tabReparentSource = path.join(net48FixtureRoot, 'S035TabPageReparentForm.cs');
  const tabReparentDesigner = path.join(net48FixtureRoot, 'S035TabPageReparentForm.Designer.cs');
  const tabReparentBefore = fs.readFileSync(tabReparentDesigner, 'utf8');
  const tabReparentSourceHash = sha256File(tabReparentSource);
  const tabReparentDesignerHash = sha256File(tabReparentDesigner);
  const tabReparentUri = vscode.Uri.file(tabReparentSource);
  await vscode.commands.executeCommand('vscode.openWith', tabReparentUri, designerViewType);
  await waitFor(() => testApi.openDesignerState(tabReparentUri)?.renderReady === true,
    `S035 net48 TabPage form did not render: ${JSON.stringify(testApi.openDesignerState(tabReparentUri))}`, 60_000);
  assert.strictEqual(testApi.openDesignerState(tabReparentUri)?.engineKind, 'net48');
  await testApi.reparentOpenDesignerControl(tabReparentUri, 'textBox1', 'tabPage2');
  const tabReparentAfter = testApi.openDesignerState(tabReparentUri)?.designerText ?? '';
  assert.match(tabReparentAfter, /this\.tabPage2\.Controls\.Add\(this\.textBox1\);/,
    'S035 did not move TextBox ownership to the selected second TabPage');
  assert.doesNotMatch(tabReparentAfter, /this\.Controls\.Add\(this\.textBox1\);/,
    'S035 retained the old Form ownership');
  assert.match(tabReparentAfter,
    /this\.textBox1\.Location = new System\.Drawing\.Point\(276, 38\);/,
    `S035 did not convert Form-client Location to selected-TabPage client coordinates: ${
      JSON.stringify(/this\.textBox1\.Location[^;]+;/.exec(tabReparentAfter)?.[0] ?? '<missing>')}`);
  assert.strictEqual(testApi.openDesignerState(tabReparentUri)?.dirty, true,
    'S035 TabPage reparent did not dirty the CustomDocument');
  assert.strictEqual(sha256File(tabReparentSource), tabReparentSourceHash, 'S035 changed code-behind disk');
  assert.strictEqual(sha256File(tabReparentDesigner), tabReparentDesignerHash,
    'S035 wrote Designer disk before Save');
  await runDesignerHistoryCommand(testApi, tabReparentUri, 'undo');
  await waitFor(() => testApi.openDesignerState(tabReparentUri)?.designerText === tabReparentBefore,
    'S035 one native Undo did not restore Form ownership and Location');
  assert.strictEqual(testApi.openDesignerState(tabReparentUri)?.dirty, false,
    'S035 Undo did not restore the clean baseline');
  await runDesignerHistoryCommand(testApi, tabReparentUri, 'redo');
  await waitFor(() => testApi.openDesignerState(tabReparentUri)?.designerText === tabReparentAfter,
    'S035 one native Redo did not reapply TabPage ownership and Location');
  await runDesignerHistoryCommand(testApi, tabReparentUri, 'undo');
  await waitFor(() => testApi.openDesignerState(tabReparentUri)?.dirty === false,
    'S035 final Undo stayed dirty');
  assert.strictEqual(sha256File(tabReparentDesigner), tabReparentDesignerHash,
    'S035 Undo/Redo touched Designer disk');
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

  // V2-FND-001-S036 — make the canvas/outline target genuinely stale: first rename the SplitContainer through the
  // product, then send the formerly published Panel2 identity through the same reparent ingress. A refusal must add
  // no second history entry, so one native Undo restores the container rename. Run both runtime lanes.
  const exerciseS036StaleSplitTarget = async (
    sourcePath: string,
    designerPath: string,
    expectedEngine: 'modern' | 'net48',
  ): Promise<void> => {
    const sourceHash = sha256File(sourcePath);
    const designerHash = sha256File(designerPath);
    const designerBefore = fs.readFileSync(designerPath, 'utf8');
    const uri = vscode.Uri.file(sourcePath);
    await vscode.commands.executeCommand('vscode.openWith', uri, designerViewType);
    await waitFor(() => testApi.openDesignerState(uri)?.renderReady === true,
      `S036 ${expectedEngine} SplitContainer form did not render: ${JSON.stringify(testApi.openDesignerState(uri))}`,
      60_000);
    assert.strictEqual(testApi.openDesignerState(uri)?.engineKind, expectedEngine);
    await testApi.renameOpenDesignerControl(uri, 'splitContainer1', 'renamedSplitContainer');
    const afterRename = testApi.openDesignerState(uri)?.designerText ?? '';
    assert.match(afterRename, /this\.renamedSplitContainer =/,
      `S036 ${expectedEngine} setup did not rename the SplitContainer target`);
    assert.doesNotMatch(afterRename, /this\.splitContainer1 =/,
      `S036 ${expectedEngine} setup retained the stale SplitContainer identity`);
    assert.strictEqual(testApi.openDesignerState(uri)?.dirty, true,
      `S036 ${expectedEngine} setup did not create the one expected rename history entry`);
    await testApi.reparentOpenDesignerControl(uri, 'button1', 'splitContainer1.Panel2');
    assert.strictEqual(testApi.openDesignerState(uri)?.designerText, afterRename,
      `S036 ${expectedEngine} mutated source for missing SplitContainer.Panel2`);
    assert.strictEqual(sha256File(sourcePath), sourceHash,
      `S036 ${expectedEngine} stale target changed code-behind disk`);
    assert.strictEqual(sha256File(designerPath), designerHash,
      `S036 ${expectedEngine} stale target changed Designer disk`);
    await runDesignerHistoryCommand(testApi, uri, 'undo');
    await waitFor(() => testApi.openDesignerState(uri)?.designerText === designerBefore,
      `S036 ${expectedEngine} refusal added a history entry ahead of the setup rename`);
    assert.strictEqual(testApi.openDesignerState(uri)?.dirty, false,
      `S036 ${expectedEngine} one Undo did not restore the exact clean baseline`);
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  };

  const staleSplitNet48Source = path.join(net48FixtureRoot, 'S036StaleSplitTargetForm.cs');
  const staleSplitNet48Designer = path.join(net48FixtureRoot, 'S036StaleSplitTargetForm.Designer.cs');
  await exerciseS036StaleSplitTarget(staleSplitNet48Source, staleSplitNet48Designer, 'net48');

  const staleSplitModernSource = path.join(lifecycleDir, 'S036ModernStaleSplitTargetForm.cs');
  const staleSplitModernDesigner = path.join(lifecycleDir, 'S036ModernStaleSplitTargetForm.Designer.cs');
  fs.writeFileSync(staleSplitModernSource, [
    'using System.Windows.Forms;',
    'namespace DemoApp;',
    'public partial class S036ModernStaleSplitTargetForm : Form',
    '{',
    '    public S036ModernStaleSplitTargetForm() => InitializeComponent();',
    '}',
    '',
  ].join('\r\n'), 'utf8');
  fs.writeFileSync(staleSplitModernDesigner, [
    'namespace DemoApp;',
    'partial class S036ModernStaleSplitTargetForm',
    '{',
    '    private System.Windows.Forms.SplitContainer splitContainer1;',
    '    private System.Windows.Forms.Button button1;',
    '    private void InitializeComponent()',
    '    {',
    '        this.splitContainer1 = new System.Windows.Forms.SplitContainer();',
    '        this.button1 = new System.Windows.Forms.Button();',
    '        this.splitContainer1.Location = new System.Drawing.Point(20, 20);',
    '        this.splitContainer1.Name = "splitContainer1";',
    '        this.splitContainer1.Size = new System.Drawing.Size(240, 140);',
    '        this.button1.Location = new System.Drawing.Point(300, 80);',
    '        this.button1.Name = "button1";',
    '        this.button1.Size = new System.Drawing.Size(100, 30);',
    '        this.ClientSize = new System.Drawing.Size(440, 200);',
    '        this.Controls.Add(this.button1);',
    '        this.Controls.Add(this.splitContainer1);',
    '        this.Name = "S036ModernStaleSplitTargetForm";',
    '    }',
    '}',
    '',
  ].join('\r\n'), 'utf8');
  await exerciseS036StaleSplitTarget(staleSplitModernSource, staleSplitModernDesigner, 'modern');

  // V2-FND-001-S061 — select button1 through the real session pick used by canvas/outline, then rename it through the
  // same product transaction as Document Outline/Name editing. The selected identity follows the rename, every C#
  // reference and the Name literal changes exactly once, unrelated text remains byte-exact, and native history owns
  // the whole source transformation as one edit.
  const outlineRenameSource = path.join(lifecycleDir, 'S061OutlineRenameForm.cs');
  const outlineRenameDesigner = path.join(lifecycleDir, 'S061OutlineRenameForm.Designer.cs');
  const outlineRenameSourceText = [
    'using System.Windows.Forms;',
    'namespace DemoApp;',
    'public partial class S061OutlineRenameForm : Form',
    '{',
    '    public S061OutlineRenameForm() => InitializeComponent();',
    '}',
    '',
  ].join('\r\n');
  const outlineRenameBefore = [
    'namespace DemoApp;',
    'partial class S061OutlineRenameForm',
    '{',
    '    private System.Windows.Forms.Button button1;',
    '    private System.Windows.Forms.TextBox textBox1;',
    '    private void InitializeComponent()',
    '    {',
    '        this.button1 = new System.Windows.Forms.Button();',
    '        this.textBox1 = new System.Windows.Forms.TextBox();',
    '        this.button1.Location = new System.Drawing.Point(20, 20);',
    '        this.button1.Name = "button1";',
    '        this.button1.Size = new System.Drawing.Size(110, 30);',
    '        this.button1.Text = "button1";',
    '        this.textBox1.Location = new System.Drawing.Point(20, 70);',
    '        this.textBox1.Name = "textBox1";',
    '        this.textBox1.Size = new System.Drawing.Size(160, 23);',
    '        this.ClientSize = new System.Drawing.Size(320, 150);',
    '        this.Controls.Add(this.textBox1);',
    '        this.Controls.Add(this.button1);',
    '        this.Name = "S061OutlineRenameForm";',
    '    }',
    '}',
    '',
  ].join('\r\n');
  fs.writeFileSync(outlineRenameSource, outlineRenameSourceText, 'utf8');
  fs.writeFileSync(outlineRenameDesigner, outlineRenameBefore, 'utf8');
  const outlineRenameSourceHash = sha256File(outlineRenameSource);
  const outlineRenameDesignerHash = sha256File(outlineRenameDesigner);
  const outlineRenameUri = vscode.Uri.file(outlineRenameSource);
  await vscode.commands.executeCommand('vscode.openWith', outlineRenameUri, designerViewType);
  await waitFor(() => testApi.openDesignerState(outlineRenameUri)?.renderReady === true,
    `S061 modern outline-rename form did not render: ${JSON.stringify(testApi.openDesignerState(outlineRenameUri))}`,
    60_000);
  assert.strictEqual(testApi.openDesignerState(outlineRenameUri)?.engineKind, 'modern');
  assert.ok(testApi.openDesignerState(outlineRenameUri)?.controls.some((control) =>
    control.id === 'button1' && control.ownership === 'currentSource' && control.editable !== false),
  'S061 button1 was not published as an editable current-source control');
  await testApi.selectOpenDesignerControl(outlineRenameUri, 'button1');
  assert.strictEqual(testApi.openDesignerState(outlineRenameUri)?.currentId, 'button1');
  assert.deepStrictEqual(testApi.openDesignerState(outlineRenameUri)?.currentSelectionIds, ['button1']);
  await testApi.renameOpenDesignerControl(outlineRenameUri, 'button1', 'submitButton');
  const outlineRenameAfter = testApi.openDesignerState(outlineRenameUri)?.designerText ?? '';
  const outlineRenameExpected = outlineRenameBefore
    .replace('System.Windows.Forms.Button button1;', 'System.Windows.Forms.Button submitButton;')
    .split('this.button1').join('this.submitButton')
    .replace('this.submitButton.Name = "button1";', 'this.submitButton.Name = "submitButton";');
  assert.strictEqual(outlineRenameAfter, outlineRenameExpected,
    'S061 product rename changed more than the selected component identity and Name literal');
  assert.strictEqual((outlineRenameAfter.match(/this\.submitButton/g) ?? []).length, 6,
    'S061 did not rewrite every selected-component reference exactly once');
  assert.doesNotMatch(outlineRenameAfter, /this\.button1\b/,
    'S061 retained an old selected-component reference');
  assert.match(outlineRenameAfter, /this\.submitButton\.Text = "button1";/,
    'S061 incorrectly treated unrelated Text content as a component identity');
  assert.match(outlineRenameAfter, /this\.textBox1\.Name = "textBox1";/,
    'S061 changed an unrelated component');
  assert.strictEqual(testApi.openDesignerState(outlineRenameUri)?.currentId, 'submitButton',
    'S061 selected identity did not follow the product rename');
  assert.deepStrictEqual(testApi.openDesignerState(outlineRenameUri)?.currentSelectionIds, ['submitButton']);
  assert.ok(testApi.openDesignerState(outlineRenameUri)?.controls.some((control) =>
    control.id === 'submitButton' && control.ownership === 'currentSource'),
  'S061 render did not publish the renamed control identity');
  assert.ok(!testApi.openDesignerState(outlineRenameUri)?.controls.some((control) => control.id === 'button1'),
    'S061 render retained the old control identity');
  assert.strictEqual(testApi.openDesignerState(outlineRenameUri)?.dirty, true,
    'S061 rename did not dirty the CustomDocument');
  assert.strictEqual(sha256File(outlineRenameSource), outlineRenameSourceHash,
    'S061 unsaved rename changed code-behind disk');
  assert.strictEqual(sha256File(outlineRenameDesigner), outlineRenameDesignerHash,
    'S061 unsaved rename changed Designer disk');
  await runDesignerHistoryCommand(testApi, outlineRenameUri, 'undo');
  await waitFor(() => testApi.openDesignerState(outlineRenameUri)?.designerText === outlineRenameBefore,
    'S061 one native Undo did not restore the exact Designer baseline');
  assert.strictEqual(testApi.openDesignerState(outlineRenameUri)?.dirty, false,
    'S061 Undo did not restore the clean baseline');
  await runDesignerHistoryCommand(testApi, outlineRenameUri, 'redo');
  await waitFor(() => testApi.openDesignerState(outlineRenameUri)?.designerText === outlineRenameAfter,
    'S061 one native Redo did not reapply the complete rename');
  await runDesignerHistoryCommand(testApi, outlineRenameUri, 'undo');
  await waitFor(() => testApi.openDesignerState(outlineRenameUri)?.dirty === false,
    'S061 final Undo stayed dirty');
  assert.strictEqual(sha256File(outlineRenameSource), outlineRenameSourceHash,
    'S061 history touched code-behind disk');
  assert.strictEqual(sha256File(outlineRenameDesigner), outlineRenameDesignerHash,
    'S061 history touched Designer disk');
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

  // V2-FND-001-S062 — open a real modern CustomEditor whose engine render owns a non-visual Timer tray item. A tray
  // click and an outline pick share the same product `pick` ingress, so drive that state transition and prove the real
  // Properties describe publishes Timer metadata without manufacturing a visual control or any source/history edit.
  const trayTimerSource = path.join(lifecycleDir, 'S062TrayTimerForm.cs');
  const trayTimerDesigner = path.join(lifecycleDir, 'S062TrayTimerForm.Designer.cs');
  fs.writeFileSync(trayTimerSource, [
    'using System.Windows.Forms;',
    'namespace DemoApp;',
    'public partial class S062TrayTimerForm : Form',
    '{',
    '    public S062TrayTimerForm() => InitializeComponent();',
    '}',
    '',
  ].join('\r\n'), 'utf8');
  fs.writeFileSync(trayTimerDesigner, [
    'namespace DemoApp;',
    'partial class S062TrayTimerForm',
    '{',
    '    private System.ComponentModel.IContainer? components = null;',
    '    private System.Windows.Forms.Timer timer1;',
    '    private void InitializeComponent()',
    '    {',
    '        this.components = new System.ComponentModel.Container();',
    '        this.timer1 = new System.Windows.Forms.Timer(this.components);',
    '        this.timer1.Enabled = false;',
    '        this.timer1.Interval = 250;',
    '        this.ClientSize = new System.Drawing.Size(320, 180);',
    '        this.Name = "S062TrayTimerForm";',
    '    }',
    '}',
    '',
  ].join('\r\n'), 'utf8');
  const trayTimerSourceHash = sha256File(trayTimerSource);
  const trayTimerDesignerHash = sha256File(trayTimerDesigner);
  const trayTimerBefore = fs.readFileSync(trayTimerDesigner, 'utf8');
  const trayTimerUri = vscode.Uri.file(trayTimerSource);
  await vscode.commands.executeCommand('vscode.openWith', trayTimerUri, designerViewType);
  await waitFor(() => testApi.openDesignerState(trayTimerUri)?.renderReady === true,
    `S062 Timer form did not render: ${JSON.stringify(testApi.openDesignerState(trayTimerUri))}`, 60_000);
  const trayBeforePick = testApi.openDesignerState(trayTimerUri);
  assert.strictEqual(trayBeforePick?.engineKind, 'modern');
  assert.ok(trayBeforePick?.tray.some((component) =>
    component.id === 'timer1' && component.name === 'timer1' && /(?:^|\.)Timer$/.test(component.type)
      && component.isStrip !== true),
  `S062 engine render did not publish timer1 as a non-strip tray component: ${JSON.stringify(trayBeforePick?.tray)}`);
  assert.ok(!trayBeforePick?.controls.some((control) => control.id === 'timer1'),
    'S062 incorrectly published timer1 as a visual control');
  assert.strictEqual(trayBeforePick?.dirty, false);
  assert.strictEqual(trayBeforePick?.designerText, trayTimerBefore);
  await testApi.selectOpenDesignerControl(trayTimerUri, 'timer1');
  const trayAfterPick = testApi.openDesignerState(trayTimerUri);
  assert.strictEqual(trayAfterPick?.currentId, 'timer1');
  assert.deepStrictEqual(trayAfterPick?.currentSelectionIds, ['timer1']);
  assert.strictEqual(trayAfterPick?.selectedPropertyComponent?.id, 'timer1');
  assert.match(trayAfterPick?.selectedPropertyComponent?.type ?? '', /(?:^|\.)Timer$/);
  assert.strictEqual(
    trayAfterPick?.selectedPropertyComponent?.properties.find((property) => property.name === 'Interval')?.value,
    '250',
    'S062 Timer Properties did not publish the live Interval value',
  );
  assert.match(
    trayAfterPick?.selectedPropertyComponent?.properties.find((property) => property.name === 'Enabled')?.value ?? '',
    /^false$/i,
    'S062 Timer Properties did not publish the live Enabled value',
  );
  assert.strictEqual(trayAfterPick?.designerText, trayTimerBefore,
    'S062 selection-only tray click changed Designer source');
  assert.strictEqual(trayAfterPick?.dirty, false,
    'S062 selection-only tray click created a native history entry');
  assert.strictEqual(sha256File(trayTimerSource), trayTimerSourceHash,
    'S062 selection-only tray click changed code-behind disk');
  assert.strictEqual(sha256File(trayTimerDesigner), trayTimerDesignerHash,
    'S062 selection-only tray click changed Designer disk');
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

  // V2-FND-001-S065 — drive the exact read/write halves used by the Properties Items editor. The payload is the
  // full standard MenuStrip skeleton emitted by panel.js (including nested items and separators), not a reduced
  // engine-only proxy. The product must mint every field atomically and own the whole change as one native undo unit.
  const standardNode = (
    text: string,
    itemType = 'ToolStripMenuItem',
    children: ToolStripItemModel[] = [],
  ): ToolStripItemModel => ({ id: '', text, name: '', itemType, children });
  const standardMenuItem = (text: string): ToolStripItemModel => standardNode(text);
  const standardSeparator = (): ToolStripItemModel => standardNode('', 'ToolStripSeparator');
  const standardMenuItems: ToolStripItemModel[] = [
    standardNode('File', 'ToolStripMenuItem', [
      standardMenuItem('New'), standardMenuItem('Open'), standardMenuItem('Save'), standardMenuItem('Save As'),
      standardSeparator(), standardMenuItem('Print'), standardMenuItem('Print Preview'), standardSeparator(),
      standardMenuItem('Exit'),
    ]),
    standardNode('Edit', 'ToolStripMenuItem', [
      standardMenuItem('Undo'), standardMenuItem('Redo'), standardSeparator(), standardMenuItem('Cut'),
      standardMenuItem('Copy'), standardMenuItem('Paste'), standardSeparator(), standardMenuItem('Select All'),
    ]),
    standardNode('Tools', 'ToolStripMenuItem', [standardMenuItem('Customize'), standardMenuItem('Options')]),
    standardNode('Help', 'ToolStripMenuItem', [
      standardMenuItem('Contents'), standardMenuItem('Index'), standardMenuItem('Search'), standardSeparator(),
      standardMenuItem('About'),
    ]),
  ];
  const standardMenuSource = path.join(lifecycleDir, 'S065StandardMenuForm.cs');
  const standardMenuDesigner = path.join(lifecycleDir, 'S065StandardMenuForm.Designer.cs');
  fs.writeFileSync(standardMenuSource, [
    'using System.Windows.Forms;',
    'namespace DemoApp;',
    'public partial class S065StandardMenuForm : Form',
    '{',
    '    public S065StandardMenuForm() => InitializeComponent();',
    '}',
    '',
  ].join('\r\n'), 'utf8');
  fs.writeFileSync(standardMenuDesigner, [
    'namespace DemoApp;',
    'partial class S065StandardMenuForm',
    '{',
    '    private System.Windows.Forms.MenuStrip menuStrip1;',
    '    private void InitializeComponent()',
    '    {',
    '        this.menuStrip1 = new System.Windows.Forms.MenuStrip();',
    '        this.menuStrip1.Name = "menuStrip1";',
    '        this.Controls.Add(this.menuStrip1);',
    '        this.MainMenuStrip = this.menuStrip1;',
    '        this.ClientSize = new System.Drawing.Size(420, 220);',
    '        this.Name = "S065StandardMenuForm";',
    '    }',
    '}',
    '',
  ].join('\r\n'), 'utf8');
  const standardMenuBefore = fs.readFileSync(standardMenuDesigner, 'utf8');
  const standardMenuSourceHash = sha256File(standardMenuSource);
  const standardMenuDesignerHash = sha256File(standardMenuDesigner);
  const standardMenuUri = vscode.Uri.file(standardMenuSource);
  await vscode.commands.executeCommand('vscode.openWith', standardMenuUri, designerViewType);
  await waitFor(() => testApi.openDesignerState(standardMenuUri)?.renderReady === true,
    `S065 modern MenuStrip form did not render: ${JSON.stringify(testApi.openDesignerState(standardMenuUri))}`,
    60_000);
  assert.strictEqual(testApi.openDesignerState(standardMenuUri)?.engineKind, 'modern');
  const emptyMenuRead = await testApi.listOpenDesignerToolStripItems(standardMenuUri, 'menuStrip1');
  assert.strictEqual(emptyMenuRead.ok, true, `S065 Items editor read refused: ${emptyMenuRead.reason}`);
  assert.deepStrictEqual(emptyMenuRead.items, [], 'S065 fixture did not expose an empty MenuStrip');
  assert.strictEqual(
    await testApi.setOpenDesignerToolStripItems(standardMenuUri, 'menuStrip1', standardMenuItems),
    true,
    'S065 product Items editor did not commit and render the standard MenuStrip skeleton',
  );
  const standardMenuAfter = testApi.openDesignerState(standardMenuUri)?.designerText ?? '';
  const standardMenuRead = await testApi.listOpenDesignerToolStripItems(standardMenuUri, 'menuStrip1');
  assert.strictEqual(standardMenuRead.ok, true, `S065 committed standard menu was not readable: ${standardMenuRead.reason}`);
  assert.deepStrictEqual(standardMenuRead.items.map((item) => item.text), ['File', 'Edit', 'Tools', 'Help']);
  assert.deepStrictEqual(standardMenuRead.items[0]?.children.map((item) => item.text),
    ['New', 'Open', 'Save', 'Save As', '', 'Print', 'Print Preview', '', 'Exit']);
  assert.deepStrictEqual(standardMenuRead.items[1]?.children.map((item) => item.text),
    ['Undo', 'Redo', '', 'Cut', 'Copy', 'Paste', '', 'Select All']);
  assert.deepStrictEqual(standardMenuRead.items[2]?.children.map((item) => item.text), ['Customize', 'Options']);
  assert.deepStrictEqual(standardMenuRead.items[3]?.children.map((item) => item.text),
    ['Contents', 'Index', 'Search', '', 'About']);
  assert.ok(standardMenuRead.items.every((item) => item.id.length > 0),
    'S065 product transaction did not mint top-level field identities');
  assert.ok(standardMenuRead.items.flatMap((item) => item.children).every((item) => item.id.length > 0),
    'S065 product transaction did not mint nested field identities');
  assert.match(standardMenuAfter, /this\.menuStrip1\.Items\.AddRange\(new System\.Windows\.Forms\.ToolStripItem\[\]/);
  assert.strictEqual(testApi.openDesignerState(standardMenuUri)?.dirty, true,
    'S065 Items edit did not dirty the CustomDocument');
  assert.strictEqual(sha256File(standardMenuSource), standardMenuSourceHash,
    'S065 unsaved Items edit changed code-behind disk');
  assert.strictEqual(sha256File(standardMenuDesigner), standardMenuDesignerHash,
    'S065 unsaved Items edit changed Designer disk');
  await runDesignerHistoryCommand(testApi, standardMenuUri, 'undo');
  await waitFor(() => testApi.openDesignerState(standardMenuUri)?.designerText === standardMenuBefore,
    'S065 one native Undo did not restore the empty MenuStrip baseline');
  assert.strictEqual(testApi.openDesignerState(standardMenuUri)?.dirty, false,
    'S065 Undo did not restore the clean baseline');
  await runDesignerHistoryCommand(testApi, standardMenuUri, 'redo');
  await waitFor(() => testApi.openDesignerState(standardMenuUri)?.designerText === standardMenuAfter,
    'S065 one native Redo did not reapply the standard MenuStrip skeleton');
  await runDesignerHistoryCommand(testApi, standardMenuUri, 'undo');
  await waitFor(() => testApi.openDesignerState(standardMenuUri)?.dirty === false,
    'S065 final Undo stayed dirty');
  assert.strictEqual(sha256File(standardMenuSource), standardMenuSourceHash, 'S065 history changed code-behind disk');
  assert.strictEqual(sha256File(standardMenuDesigner), standardMenuDesignerHash, 'S065 history changed Designer disk');
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

  // V2-FND-001-S066 / V2-FND-001-S068 (modern leg) — a canvas item drag first attempts an ineligible parent and must refuse
  // before history/source mutation, then moves Open to root index 0 through the same atomic move transaction.
  const modernStripSource = path.join(lifecycleDir, 'S066ToolStripMoveForm.cs');
  const modernStripDesigner = path.join(lifecycleDir, 'S066ToolStripMoveForm.Designer.cs');
  fs.writeFileSync(modernStripSource, [
    'using System.Windows.Forms;',
    'namespace DemoApp;',
    'public partial class S066ToolStripMoveForm : Form',
    '{',
    '    public S066ToolStripMoveForm() => InitializeComponent();',
    '}',
    '',
  ].join('\r\n'), 'utf8');
  fs.writeFileSync(modernStripDesigner, [
    'namespace DemoApp;',
    'partial class S066ToolStripMoveForm',
    '{',
    '    private System.Windows.Forms.ToolStrip toolStrip1;',
    '    private System.Windows.Forms.ToolStripButton newButton;',
    '    private System.Windows.Forms.ToolStripButton saveButton;',
    '    private System.Windows.Forms.ToolStripButton openButton;',
    '    private void InitializeComponent()',
    '    {',
    '        this.toolStrip1 = new System.Windows.Forms.ToolStrip();',
    '        this.newButton = new System.Windows.Forms.ToolStripButton();',
    '        this.saveButton = new System.Windows.Forms.ToolStripButton();',
    '        this.openButton = new System.Windows.Forms.ToolStripButton();',
    '        this.toolStrip1.Items.AddRange(new System.Windows.Forms.ToolStripItem[] {',
    '            this.newButton,',
    '            this.saveButton,',
    '            this.openButton});',
    '        this.newButton.Name = "newButton";',
    '        this.newButton.Text = "New";',
    '        this.saveButton.Name = "saveButton";',
    '        this.saveButton.Text = "Save";',
    '        this.saveButton.ToolTipText = "Preserve this metadata";',
    '        this.openButton.Name = "openButton";',
    '        this.openButton.Text = "Open";',
    '        this.toolStrip1.Name = "toolStrip1";',
    '        this.Controls.Add(this.toolStrip1);',
    '        this.ClientSize = new System.Drawing.Size(420, 220);',
    '        this.Name = "S066ToolStripMoveForm";',
    '    }',
    '}',
    '',
  ].join('\r\n'), 'utf8');
  const modernStripBefore = fs.readFileSync(modernStripDesigner, 'utf8');
  const modernStripSourceHash = sha256File(modernStripSource);
  const modernStripDesignerHash = sha256File(modernStripDesigner);
  const modernStripUri = vscode.Uri.file(modernStripSource);
  await vscode.commands.executeCommand('vscode.openWith', modernStripUri, designerViewType);
  await waitFor(() => testApi.openDesignerState(modernStripUri)?.renderReady === true,
    `S066 modern ToolStrip form did not render: ${JSON.stringify(testApi.openDesignerState(modernStripUri))}`,
    60_000);
  assert.strictEqual(testApi.openDesignerState(modernStripUri)?.engineKind, 'modern');
  const modernRefusal = await testApi.moveOpenDesignerToolStripItem(
    modernStripUri, 'toolStrip1', 'openButton', 'newButton', 0,
  );
  assert.deepStrictEqual(modernRefusal, { applied: false, reason: 'newButton has no DropDownItems collection' });
  assert.strictEqual(testApi.openDesignerState(modernStripUri)?.designerText, modernStripBefore,
    'S068 modern refusal changed Designer source');
  assert.strictEqual(testApi.openDesignerState(modernStripUri)?.dirty, false,
    'S068 modern refusal created native history');
  assert.strictEqual(sha256File(modernStripSource), modernStripSourceHash,
    'S068 modern refusal changed code-behind disk');
  assert.strictEqual(sha256File(modernStripDesigner), modernStripDesignerHash,
    'S068 modern refusal changed Designer disk');
  const modernMove = await testApi.moveOpenDesignerToolStripItem(
    modernStripUri, 'toolStrip1', 'openButton', null, 0,
  );
  assert.deepStrictEqual(modernMove, { applied: true, reason: null });
  const modernStripAfter = testApi.openDesignerState(modernStripUri)?.designerText ?? '';
  const modernStripRead = await testApi.listOpenDesignerToolStripItems(modernStripUri, 'toolStrip1');
  assert.strictEqual(modernStripRead.ok, true, `S066 moved ToolStrip was not readable: ${modernStripRead.reason}`);
  assert.deepStrictEqual(modernStripRead.items.map((item) => item.id), ['openButton', 'newButton', 'saveButton']);
  assert.match(modernStripAfter, /this\.saveButton\.ToolTipText = "Preserve this metadata";/,
    'S066 deterministic reorder lost unmanaged item metadata');
  assert.strictEqual(testApi.openDesignerState(modernStripUri)?.dirty, true,
    'S066 item drag did not dirty the CustomDocument');
  assert.strictEqual(sha256File(modernStripSource), modernStripSourceHash,
    'S066 unsaved reorder changed code-behind disk');
  assert.strictEqual(sha256File(modernStripDesigner), modernStripDesignerHash,
    'S066 unsaved reorder changed Designer disk');
  await runDesignerHistoryCommand(testApi, modernStripUri, 'undo');
  await waitFor(() => testApi.openDesignerState(modernStripUri)?.designerText === modernStripBefore,
    'S066 one native Undo did not restore New/Save/Open');
  assert.strictEqual(testApi.openDesignerState(modernStripUri)?.dirty, false);
  await runDesignerHistoryCommand(testApi, modernStripUri, 'redo');
  await waitFor(() => testApi.openDesignerState(modernStripUri)?.designerText === modernStripAfter,
    'S066 one native Redo did not restore Open/New/Save');
  await runDesignerHistoryCommand(testApi, modernStripUri, 'undo');
  await waitFor(() => testApi.openDesignerState(modernStripUri)?.dirty === false,
    'S066 final Undo stayed dirty');
  assert.strictEqual(sha256File(modernStripSource), modernStripSourceHash, 'S066 history changed code-behind disk');
  assert.strictEqual(sha256File(modernStripDesigner), modernStripDesignerHash, 'S066 history changed Designer disk');
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

  // V2-FND-001-S067 / V2-FND-001-S068 (compiled-net48 leg) — prove the same move/refusal contracts against the real compiled
  // instance. Help moves from the MenuStrip root into Tools.DropDownItems and one native undo unit owns the change.
  const net48MenuSource = path.join(net48FixtureRoot, 'S067MenuToolStripForm.cs');
  const net48MenuDesigner = path.join(net48FixtureRoot, 'S067MenuToolStripForm.Designer.cs');
  assert.ok(fs.existsSync(net48MenuSource) && fs.existsSync(net48MenuDesigner),
    'S067 compiled-net48 MenuStrip fixture is missing');
  const net48MenuBefore = fs.readFileSync(net48MenuDesigner, 'utf8');
  const net48MenuSourceHash = sha256File(net48MenuSource);
  const net48MenuDesignerHash = sha256File(net48MenuDesigner);
  const net48MenuUri = vscode.Uri.file(net48MenuSource);
  await vscode.commands.executeCommand('vscode.openWith', net48MenuUri, designerViewType);
  await waitFor(() => testApi.openDesignerState(net48MenuUri)?.renderReady === true,
    `S067 compiled-net48 MenuStrip form did not render: ${JSON.stringify(testApi.openDesignerState(net48MenuUri))}`,
    60_000);
  assert.strictEqual(testApi.openDesignerState(net48MenuUri)?.engineKind, 'net48');
  const net48Refusal = await testApi.moveOpenDesignerToolStripItem(
    net48MenuUri, 'toolStrip1', 'openButton', 'newButton', 0,
  );
  assert.deepStrictEqual(net48Refusal, { applied: false, reason: 'newButton has no DropDownItems collection' });
  assert.strictEqual(testApi.openDesignerState(net48MenuUri)?.designerText, net48MenuBefore,
    'S068 net48 refusal changed Designer source');
  assert.strictEqual(testApi.openDesignerState(net48MenuUri)?.dirty, false,
    'S068 net48 refusal created native history');
  assert.strictEqual(sha256File(net48MenuSource), net48MenuSourceHash,
    'S068 net48 refusal changed code-behind disk');
  assert.strictEqual(sha256File(net48MenuDesigner), net48MenuDesignerHash,
    'S068 net48 refusal changed Designer disk');
  const net48MenuMove = await testApi.moveOpenDesignerToolStripItem(
    net48MenuUri, 'menuStrip1', 'helpMenu', 'toolsMenu', 0,
  );
  assert.deepStrictEqual(net48MenuMove, { applied: true, reason: null });
  const net48MenuAfter = testApi.openDesignerState(net48MenuUri)?.designerText ?? '';
  const net48MenuRead = await testApi.listOpenDesignerToolStripItems(net48MenuUri, 'menuStrip1');
  assert.strictEqual(net48MenuRead.ok, true, `S067 moved MenuStrip was not readable: ${net48MenuRead.reason}`);
  assert.deepStrictEqual(net48MenuRead.items.map((item) => item.id), ['fileMenu', 'toolsMenu']);
  assert.deepStrictEqual(net48MenuRead.items.find((item) => item.id === 'toolsMenu')?.children.map((item) => item.id),
    ['helpMenu']);
  assert.match(net48MenuAfter,
    /this\.toolsMenu\.DropDownItems\.AddRange\(new System\.Windows\.Forms\.ToolStripItem\[\] \{ this\.helpMenu \}\);/,
    'S067 did not synthesize the Tools.DropDownItems ownership');
  assert.strictEqual(testApi.openDesignerState(net48MenuUri)?.dirty, true,
    'S067 menu item reparent did not dirty the CustomDocument');
  assert.strictEqual(sha256File(net48MenuSource), net48MenuSourceHash,
    'S067 unsaved reparent changed code-behind disk');
  assert.strictEqual(sha256File(net48MenuDesigner), net48MenuDesignerHash,
    'S067 unsaved reparent changed Designer disk');
  await runDesignerHistoryCommand(testApi, net48MenuUri, 'undo');
  await waitFor(() => testApi.openDesignerState(net48MenuUri)?.designerText === net48MenuBefore,
    'S067 one native Undo did not restore Help to the MenuStrip root');
  assert.strictEqual(testApi.openDesignerState(net48MenuUri)?.dirty, false);
  await runDesignerHistoryCommand(testApi, net48MenuUri, 'redo');
  await waitFor(() => testApi.openDesignerState(net48MenuUri)?.designerText === net48MenuAfter,
    'S067 one native Redo did not restore Help under Tools');
  await runDesignerHistoryCommand(testApi, net48MenuUri, 'undo');
  await waitFor(() => testApi.openDesignerState(net48MenuUri)?.dirty === false,
    'S067 final Undo stayed dirty');
  assert.strictEqual(sha256File(net48MenuSource), net48MenuSourceHash, 'S067 history changed code-behind disk');
  assert.strictEqual(sha256File(net48MenuDesigner), net48MenuDesignerHash, 'S067 history changed Designer disk');
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

  // V2-FND-001-S069 - open an empty modern ListView through the real CustomEditor, then drive the exact typed
  // Columns read/OK path used by panel.js. The engine mints one ColumnHeader field, the canvas re-renders, and one
  // native Undo owns the complete collection transaction without writing either project file.
  const listColumnSource = path.join(lifecycleDir, 'S069ListColumnForm.cs');
  const listColumnDesigner = path.join(lifecycleDir, 'S069ListColumnForm.Designer.cs');
  fs.writeFileSync(listColumnSource, [
    'using System.Windows.Forms;',
    'namespace DemoApp;',
    'public partial class S069ListColumnForm : Form',
    '{',
    '    public S069ListColumnForm() => InitializeComponent();',
    '}',
    '',
  ].join('\r\n'), 'utf8');
  fs.writeFileSync(listColumnDesigner, [
    'namespace DemoApp;',
    'partial class S069ListColumnForm',
    '{',
    '    private System.Windows.Forms.ListView listView1;',
    '    private void InitializeComponent()',
    '    {',
    '        this.listView1 = new System.Windows.Forms.ListView();',
    '        this.listView1.Location = new System.Drawing.Point(16, 16);',
    '        this.listView1.Name = "listView1";',
    '        this.listView1.Size = new System.Drawing.Size(320, 160);',
    '        this.listView1.View = System.Windows.Forms.View.Details;',
    '        this.Controls.Add(this.listView1);',
    '        this.ClientSize = new System.Drawing.Size(360, 200);',
    '        this.Name = "S069ListColumnForm";',
    '    }',
    '}',
    '',
  ].join('\r\n'), 'utf8');
  const listColumnBefore = fs.readFileSync(listColumnDesigner, 'utf8');
  const listColumnSourceHash = sha256File(listColumnSource);
  const listColumnDesignerHash = sha256File(listColumnDesigner);
  const listColumnUri = vscode.Uri.file(listColumnSource);
  await vscode.commands.executeCommand('vscode.openWith', listColumnUri, designerViewType);
  await waitFor(() => testApi.openDesignerState(listColumnUri)?.renderReady === true,
    `S069 modern ListView form did not render: ${JSON.stringify(testApi.openDesignerState(listColumnUri))}`, 60_000);
  assert.strictEqual(testApi.openDesignerState(listColumnUri)?.engineKind, 'modern');
  const emptyColumns = await testApi.listOpenDesignerColumns(listColumnUri, 'listView1');
  assert.strictEqual(emptyColumns.ok, true, `S069 Columns editor read refused: ${emptyColumns.reason}`);
  assert.deepStrictEqual(emptyColumns.columns, [], 'S069 fixture did not expose an empty Columns collection');
  assert.strictEqual(await testApi.setOpenDesignerColumns(listColumnUri, 'listView1', [
    { id: '', text: 'Name', width: 180, textAlign: 'Left' },
  ]), true, 'S069 product Columns editor did not commit/render the new column');
  const listColumnAfter = testApi.openDesignerState(listColumnUri)?.designerText ?? '';
  const committedColumns = await testApi.listOpenDesignerColumns(listColumnUri, 'listView1');
  assert.strictEqual(committedColumns.ok, true, `S069 committed Columns collection was not readable: ${committedColumns.reason}`);
  assert.deepStrictEqual(committedColumns.columns, [
    { id: 'columnHeader1', text: 'Name', width: 180, textAlign: 'Left' },
  ]);
  assert.match(listColumnAfter, /private System\.Windows\.Forms\.ColumnHeader columnHeader1;/);
  assert.match(listColumnAfter, /this\.listView1\.Columns\.AddRange\(new System\.Windows\.Forms\.ColumnHeader\[\]/);
  assert.match(listColumnAfter, /this\.columnHeader1\.Text = "Name";/);
  assert.match(listColumnAfter, /this\.columnHeader1\.Width = 180;/);
  assert.strictEqual(testApi.openDesignerState(listColumnUri)?.dirty, true,
    'S069 Columns edit did not dirty the CustomDocument');
  assert.strictEqual(sha256File(listColumnSource), listColumnSourceHash, 'S069 unsaved edit changed code-behind disk');
  assert.strictEqual(sha256File(listColumnDesigner), listColumnDesignerHash, 'S069 unsaved edit changed Designer disk');
  await runDesignerHistoryCommand(testApi, listColumnUri, 'undo');
  await waitFor(() => testApi.openDesignerState(listColumnUri)?.designerText === listColumnBefore,
    'S069 one native Undo did not restore the empty Columns collection');
  assert.strictEqual(testApi.openDesignerState(listColumnUri)?.dirty, false);
  await runDesignerHistoryCommand(testApi, listColumnUri, 'redo');
  await waitFor(() => testApi.openDesignerState(listColumnUri)?.designerText === listColumnAfter,
    'S069 one native Redo did not restore the ColumnHeader');
  await runDesignerHistoryCommand(testApi, listColumnUri, 'undo');
  await waitFor(() => testApi.openDesignerState(listColumnUri)?.dirty === false, 'S069 final Undo stayed dirty');
  assert.strictEqual(sha256File(listColumnSource), listColumnSourceHash, 'S069 history changed code-behind disk');
  assert.strictEqual(sha256File(listColumnDesigner), listColumnDesignerHash, 'S069 history changed Designer disk');
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

  // V2-FND-001-S070 - the new typed TabPages collection editor submits the whole C,A,B order once. This is deliberately
  // not two context-menu moves: the source permutation and rendered TabPages order must belong to one native undo unit.
  const tabOrderSource = path.join(lifecycleDir, 'S070TabOrderForm.cs');
  const tabOrderDesigner = path.join(lifecycleDir, 'S070TabOrderForm.Designer.cs');
  fs.writeFileSync(tabOrderSource, [
    'using System.Windows.Forms;',
    'namespace DemoApp;',
    'public partial class S070TabOrderForm : Form',
    '{',
    '    public S070TabOrderForm() => InitializeComponent();',
    '}',
    '',
  ].join('\r\n'), 'utf8');
  fs.writeFileSync(tabOrderDesigner, [
    'namespace DemoApp;',
    'partial class S070TabOrderForm',
    '{',
    '    private System.Windows.Forms.TabControl tabs;',
    '    private System.Windows.Forms.TabPage pageA;',
    '    private System.Windows.Forms.TabPage pageB;',
    '    private System.Windows.Forms.TabPage pageC;',
    '    private void InitializeComponent()',
    '    {',
    '        this.tabs = new System.Windows.Forms.TabControl();',
    '        this.pageA = new System.Windows.Forms.TabPage();',
    '        this.pageB = new System.Windows.Forms.TabPage();',
    '        this.pageC = new System.Windows.Forms.TabPage();',
    '        this.tabs.TabPages.AddRange(new System.Windows.Forms.TabPage[] {',
    '            this.pageA,',
    '            this.pageB,',
    '            this.pageC});',
    '        this.tabs.Location = new System.Drawing.Point(12, 12);',
    '        this.tabs.Name = "tabs";',
    '        this.tabs.Size = new System.Drawing.Size(320, 180);',
    '        this.pageA.Name = "pageA";',
    '        this.pageA.Text = "A";',
    '        this.pageB.Name = "pageB";',
    '        this.pageB.Text = "B";',
    '        this.pageC.Name = "pageC";',
    '        this.pageC.Text = "C";',
    '        this.Controls.Add(this.tabs);',
    '        this.ClientSize = new System.Drawing.Size(350, 210);',
    '        this.Name = "S070TabOrderForm";',
    '    }',
    '}',
    '',
  ].join('\r\n'), 'utf8');
  const tabOrderBefore = fs.readFileSync(tabOrderDesigner, 'utf8');
  const tabOrderSourceHash = sha256File(tabOrderSource);
  const tabOrderDesignerHash = sha256File(tabOrderDesigner);
  const tabOrderUri = vscode.Uri.file(tabOrderSource);
  await vscode.commands.executeCommand('vscode.openWith', tabOrderUri, designerViewType);
  await waitFor(() => testApi.openDesignerState(tabOrderUri)?.renderReady === true,
    `S070 modern TabControl form did not render: ${JSON.stringify(testApi.openDesignerState(tabOrderUri))}`, 60_000);
  assert.strictEqual(testApi.openDesignerState(tabOrderUri)?.engineKind, 'modern');
  const initialTabPages = await testApi.listOpenDesignerTabPages(tabOrderUri, 'tabs');
  assert.strictEqual(initialTabPages.ok, true, `S070 TabPages editor read refused: ${initialTabPages.reason}`);
  assert.deepStrictEqual(initialTabPages.pages, ['pageA', 'pageB', 'pageC']);
  assert.strictEqual(await testApi.setOpenDesignerTabPages(tabOrderUri, 'tabs', ['pageC', 'pageA', 'pageB']), true,
    'S070 product TabPages editor did not commit/render the full permutation');
  const tabOrderAfter = testApi.openDesignerState(tabOrderUri)?.designerText ?? '';
  const committedTabPages = await testApi.listOpenDesignerTabPages(tabOrderUri, 'tabs');
  assert.strictEqual(committedTabPages.ok, true, `S070 committed TabPages collection was not readable: ${committedTabPages.reason}`);
  assert.deepStrictEqual(committedTabPages.pages, ['pageC', 'pageA', 'pageB']);
  const renderedTabPages = (testApi.openDesignerState(tabOrderUri)?.controls ?? [])
    .filter((control) => control.parentId === 'tabs')
    .map((control) => control.id);
  // The layout intentionally publishes only the selected page (hidden-page hit-test firewall). With no explicit
  // SelectedIndex, the first page in the newly committed collection must therefore be the sole visible pageC.
  assert.deepStrictEqual(renderedTabPages, ['pageC'],
    `S070 rendered first/visible TabPage did not follow C,A,B source order: ${JSON.stringify(renderedTabPages)}`);
  assert.ok(tabOrderAfter.indexOf('this.pageC,') < tabOrderAfter.indexOf('this.pageA,'));
  assert.ok(tabOrderAfter.indexOf('this.pageA,') < tabOrderAfter.indexOf('this.pageB}'));
  assert.strictEqual(testApi.openDesignerState(tabOrderUri)?.dirty, true,
    'S070 TabPages edit did not dirty the CustomDocument');
  assert.strictEqual(sha256File(tabOrderSource), tabOrderSourceHash, 'S070 unsaved edit changed code-behind disk');
  assert.strictEqual(sha256File(tabOrderDesigner), tabOrderDesignerHash, 'S070 unsaved edit changed Designer disk');
  await runDesignerHistoryCommand(testApi, tabOrderUri, 'undo');
  await waitFor(() => testApi.openDesignerState(tabOrderUri)?.designerText === tabOrderBefore,
    'S070 one native Undo did not restore the original A,B,C order');
  assert.strictEqual(testApi.openDesignerState(tabOrderUri)?.dirty, false,
    'S070 one native Undo did not restore the clean baseline');
  await runDesignerHistoryCommand(testApi, tabOrderUri, 'redo');
  await waitFor(() => testApi.openDesignerState(tabOrderUri)?.designerText === tabOrderAfter,
    'S070 one native Redo did not restore the atomic C,A,B order');
  await runDesignerHistoryCommand(testApi, tabOrderUri, 'undo');
  await waitFor(() => testApi.openDesignerState(tabOrderUri)?.dirty === false, 'S070 final Undo stayed dirty');
  assert.strictEqual(sha256File(tabOrderSource), tabOrderSourceHash, 'S070 history changed code-behind disk');
  assert.strictEqual(sha256File(tabOrderDesigner), tabOrderDesignerHash, 'S070 history changed Designer disk');
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

  // V2-FND-001-S024 — use the real shared designer clipboard and Ctrl+C/Ctrl+V product transactions. The form already
  // owns submitButton, so a copied submitButton must be renamed to the VS-style type base button1 before source is
  // committed. Copy itself is a no-op; Paste is one native history unit. Run both runtime lanes.
  const exerciseS024PasteCollision = async (
    sourcePath: string,
    designerPath: string,
    expectedEngine: 'modern' | 'net48',
  ): Promise<void> => {
    const sourceHash = sha256File(sourcePath);
    const designerHash = sha256File(designerPath);
    const designerBefore = fs.readFileSync(designerPath, 'utf8');
    const uri = vscode.Uri.file(sourcePath);
    await vscode.commands.executeCommand('vscode.openWith', uri, designerViewType);
    await waitFor(() => testApi.openDesignerState(uri)?.renderReady === true,
      `S024 ${expectedEngine} paste-collision form did not render: ${JSON.stringify(testApi.openDesignerState(uri))}`,
      60_000);
    assert.strictEqual(testApi.openDesignerState(uri)?.engineKind, expectedEngine);
    assert.ok(testApi.openDesignerState(uri)?.controls.some((control) =>
      control.id === 'submitButton' && control.ownership === 'currentSource'),
    `S024 ${expectedEngine} original submitButton was not published`);
    await testApi.copyOpenDesignerControls(uri, ['submitButton']);
    assert.strictEqual(testApi.openDesignerState(uri)?.designerText, designerBefore,
      `S024 ${expectedEngine} Copy mutated the Designer buffer`);
    assert.strictEqual(testApi.openDesignerState(uri)?.dirty, false,
      `S024 ${expectedEngine} Copy dirtied the CustomDocument`);
    await testApi.pasteOpenDesignerControls(uri, 'this');
    const afterPaste = testApi.openDesignerState(uri)?.designerText ?? '';
    assert.strictEqual((afterPaste.match(/System\.Windows\.Forms\.Button submitButton;/g) ?? []).length, 1,
      `S024 ${expectedEngine} duplicated the occupied field name`);
    assert.strictEqual((afterPaste.match(/System\.Windows\.Forms\.Button button1;/g) ?? []).length, 1,
      `S024 ${expectedEngine} did not generate exactly one non-colliding field name`);
    assert.strictEqual((afterPaste.match(/this\.submitButton\.Name = "submitButton";/g) ?? []).length, 1,
      `S024 ${expectedEngine} changed or duplicated the original Name assignment`);
    assert.strictEqual((afterPaste.match(/this\.button1\.Name = "button1";/g) ?? []).length, 1,
      `S024 ${expectedEngine} did not rewrite the pasted Name assignment`);
    assert.match(afterPaste, /this\.submitButton\.Location = new System\.Drawing\.Point\(20, 20\);/,
      `S024 ${expectedEngine} moved the original control`);
    assert.match(afterPaste, /this\.button1\.Location = new System\.Drawing\.Point\(28, 28\);/,
      `S024 ${expectedEngine} did not apply the bounded VS-style paste nudge`);
    assert.match(afterPaste, /this\.button1\.Text = "Submit";/,
      `S024 ${expectedEngine} lost copied property content`);
    assert.strictEqual((afterPaste.match(/this\.Controls\.Add\(this\.submitButton\);/g) ?? []).length, 1,
      `S024 ${expectedEngine} changed the original owner`);
    assert.strictEqual((afterPaste.match(/this\.Controls\.Add\(this\.button1\);/g) ?? []).length, 1,
      `S024 ${expectedEngine} did not add exactly one generated owner`);
    assert.strictEqual(testApi.openDesignerState(uri)?.currentId, 'button1',
      `S024 ${expectedEngine} did not select the generated control`);
    assert.deepStrictEqual(testApi.openDesignerState(uri)?.currentSelectionIds, ['button1']);
    assert.ok(testApi.openDesignerState(uri)?.controls.some((control) => control.id === 'button1'),
      `S024 ${expectedEngine} render did not publish the generated control`);
    assert.strictEqual(testApi.openDesignerState(uri)?.dirty, true,
      `S024 ${expectedEngine} Paste did not dirty the CustomDocument`);
    assert.strictEqual(sha256File(sourcePath), sourceHash,
      `S024 ${expectedEngine} Paste changed code-behind disk before Save`);
    assert.strictEqual(sha256File(designerPath), designerHash,
      `S024 ${expectedEngine} Paste changed Designer disk before Save`);
    await runDesignerHistoryCommand(testApi, uri, 'undo');
    await waitFor(() => testApi.openDesignerState(uri)?.designerText === designerBefore,
      `S024 ${expectedEngine} one native Undo did not restore the exact collision baseline`);
    assert.strictEqual(testApi.openDesignerState(uri)?.dirty, false,
      `S024 ${expectedEngine} Undo did not restore the clean baseline`);
    await runDesignerHistoryCommand(testApi, uri, 'redo');
    await waitFor(() => testApi.openDesignerState(uri)?.designerText === afterPaste,
      `S024 ${expectedEngine} one native Redo did not reapply the collision-safe Paste`);
    await runDesignerHistoryCommand(testApi, uri, 'undo');
    await waitFor(() => testApi.openDesignerState(uri)?.dirty === false,
      `S024 ${expectedEngine} final Undo stayed dirty`);
    assert.strictEqual(sha256File(sourcePath), sourceHash,
      `S024 ${expectedEngine} history touched code-behind disk`);
    assert.strictEqual(sha256File(designerPath), designerHash,
      `S024 ${expectedEngine} history touched Designer disk`);
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  };

  const pasteCollisionNet48Source = path.join(net48FixtureRoot, 'S024PasteCollisionForm.cs');
  const pasteCollisionNet48Designer = path.join(net48FixtureRoot, 'S024PasteCollisionForm.Designer.cs');
  await exerciseS024PasteCollision(pasteCollisionNet48Source, pasteCollisionNet48Designer, 'net48');

  const pasteCollisionModernSource = path.join(lifecycleDir, 'S024ModernPasteCollisionForm.cs');
  const pasteCollisionModernDesigner = path.join(lifecycleDir, 'S024ModernPasteCollisionForm.Designer.cs');
  fs.writeFileSync(pasteCollisionModernSource, [
    'using System.Windows.Forms;',
    'namespace DemoApp;',
    'public partial class S024ModernPasteCollisionForm : Form',
    '{',
    '    public S024ModernPasteCollisionForm() => InitializeComponent();',
    '}',
    '',
  ].join('\r\n'), 'utf8');
  fs.writeFileSync(pasteCollisionModernDesigner, [
    'namespace DemoApp;',
    'partial class S024ModernPasteCollisionForm',
    '{',
    '    private System.Windows.Forms.Button submitButton;',
    '    private void InitializeComponent()',
    '    {',
    '        this.submitButton = new System.Windows.Forms.Button();',
    '        this.submitButton.Location = new System.Drawing.Point(20, 20);',
    '        this.submitButton.Name = "submitButton";',
    '        this.submitButton.Size = new System.Drawing.Size(120, 30);',
    '        this.submitButton.Text = "Submit";',
    '        this.ClientSize = new System.Drawing.Size(320, 160);',
    '        this.Controls.Add(this.submitButton);',
    '        this.Name = "S024ModernPasteCollisionForm";',
    '    }',
    '}',
    '',
  ].join('\r\n'), 'utf8');
  await exerciseS024PasteCollision(pasteCollisionModernSource, pasteCollisionModernDesigner, 'modern');

  // V2-FND-001-S051 — prove the product's dual revision gate, not just the engine primitive. The engine validates a
  // signature-compatible replacement handler against one code snapshot; a deterministic real TextDocument edit then
  // renames that handler before commit. The CustomEditor must refuse the Designer patch, preserve disk, and remain
  // clean. With stable revisions, the same rewire is one ordinary native Undo/Redo unit.
  const revisionSource = path.join(net48FixtureRoot, 'S051EventRevisionForm.cs');
  const revisionDesigner = path.join(net48FixtureRoot, 'S051EventRevisionForm.Designer.cs');
  const revisionSourceBefore = fs.readFileSync(revisionSource, 'utf8');
  const revisionDesignerBefore = fs.readFileSync(revisionDesigner, 'utf8');
  const revisionSourceHash = sha256File(revisionSource);
  const revisionDesignerHash = sha256File(revisionDesigner);
  const revisionUri = vscode.Uri.file(revisionSource);
  await vscode.commands.executeCommand('vscode.openWith', revisionUri, designerViewType);
  await waitFor(() => testApi.openDesignerState(revisionUri)?.renderReady === true,
    `S051 net48 form did not render: ${JSON.stringify(testApi.openDesignerState(revisionUri))}`, 60_000);
  assert.strictEqual(testApi.openDesignerState(revisionUri)?.engineKind, 'net48');
  const revisionCodeDocument = await vscode.workspace.openTextDocument(revisionUri);
  assert.strictEqual(revisionCodeDocument.getText(), revisionSourceBefore);
  let s051InterleaveApplied = false;
  await testApi.setOpenDesignerHandlerWithInterleave(
    revisionUri,
    'textBox1',
    'TextChanged',
    'textBox1_TextChanged_Renamed',
    async () => {
      const current = revisionCodeDocument.getText();
      const handlerName = 'textBox1_TextChanged_Renamed';
      const start = current.indexOf(handlerName);
      assert.ok(start >= 0, 'S051 interleave could not find the validated handler');
      const edit = new vscode.WorkspaceEdit();
      edit.replace(revisionUri,
        new vscode.Range(revisionCodeDocument.positionAt(start), revisionCodeDocument.positionAt(start + handlerName.length)),
        'textBox1_TextChanged_Moved');
      assert.strictEqual(await vscode.workspace.applyEdit(edit), true, 'S051 code-behind interleave was not applied');
      s051InterleaveApplied = true;
    },
  );
  assert.strictEqual(s051InterleaveApplied, true, 'S051 did not execute the post-validation interleave');
  assert.strictEqual(testApi.openDesignerState(revisionUri)?.designerText, revisionDesignerBefore,
    'S051 committed Designer wiring against a changed code-behind revision');
  assert.strictEqual(testApi.openDesignerState(revisionUri)?.dirty, false,
    'S051 revision refusal dirtied the Designer document');
  assert.match(revisionCodeDocument.getText(), /textBox1_TextChanged_Moved/);
  assert.strictEqual(revisionCodeDocument.isDirty, true, 'S051 interleaved code edit was not retained');
  assert.strictEqual(sha256File(revisionSource), revisionSourceHash, 'S051 wrote the interleaved code edit to disk');
  assert.strictEqual(sha256File(revisionDesigner), revisionDesignerHash, 'S051 revision refusal changed Designer disk');

  await testApi.focusOpenDesigner(revisionUri);
  await vscode.commands.executeCommand('winformsDesigner.viewCode');
  await waitFor(() => path.normalize(vscode.window.activeTextEditor?.document.uri.fsPath ?? '')
    === path.normalize(revisionSource), 'S051 View Code did not focus the interleaved document');
  await vscode.commands.executeCommand('workbench.action.files.revert');
  await waitFor(() => revisionCodeDocument.getText() === revisionSourceBefore && !revisionCodeDocument.isDirty,
    'S051 could not revert the test actor code edit to the exact disk baseline');
  // A net48 code-behind change immediately invalidates the compiled render and schedules a debounced replacement.
  // Wait for that replacement to become authoritative before issuing the stable product mutation; otherwise the
  // test itself races the safety refresh that the first interleave intentionally caused.
  await waitFor(() => testApi.openDesignerState(revisionUri)?.renderReady === true,
    `S051 render did not recover after reverting the code-behind race: ${JSON.stringify(testApi.openDesignerState(revisionUri))}`,
    60_000);

  await testApi.setOpenDesignerHandler(revisionUri, 'textBox1', 'TextChanged', 'textBox1_TextChanged_Renamed');
  const revisionDesignerAfter = testApi.openDesignerState(revisionUri)?.designerText ?? '';
  assert.match(revisionDesignerAfter,
    /this\.textBox1\.TextChanged \+= new System\.EventHandler\(this\.textBox1_TextChanged_Renamed\);/);
  assert.strictEqual((revisionDesignerAfter.match(/\.TextChanged \+=/g) ?? []).length, 1,
    'S051 stable rewire did not retain exactly one subscription');
  assert.strictEqual(testApi.openDesignerState(revisionUri)?.dirty, true,
    'S051 stable rewire did not dirty the Designer document');
  assert.strictEqual(revisionCodeDocument.getText(), revisionSourceBefore, 'S051 stable rewire changed code-behind');
  assert.strictEqual(sha256File(revisionSource), revisionSourceHash, 'S051 stable rewire changed code-behind disk');
  assert.strictEqual(sha256File(revisionDesigner), revisionDesignerHash, 'S051 stable rewire touched Designer disk before Save');
  await runDesignerHistoryCommand(testApi, revisionUri, 'undo');
  await waitFor(() => testApi.openDesignerState(revisionUri)?.designerText === revisionDesignerBefore,
    'S051 Undo did not restore the original event subscription');
  await runDesignerHistoryCommand(testApi, revisionUri, 'redo');
  await waitFor(() => testApi.openDesignerState(revisionUri)?.designerText === revisionDesignerAfter,
    'S051 Redo did not reapply the stable event subscription');
  await runDesignerHistoryCommand(testApi, revisionUri, 'undo');
  await waitFor(() => testApi.openDesignerState(revisionUri)?.dirty === false,
    'S051 final Undo did not restore a clean Designer document');
  assert.strictEqual(sha256File(revisionDesigner), revisionDesignerHash, 'S051 Undo/Redo touched Designer disk');

  // V2-FND-001-S052 — the generation sibling of S051 must apply neither half of its composite transaction when the
  // code-behind snapshot changes after the engine returns a valid stub. Exercise both real runtime lanes: this net48
  // form and a modern SDK form below. The actor's independent edit remains visible; Designer and both disks stay exact.
  const s052Net48Marker = '// S052 net48 independent edit\n';
  const s052Net48CodeDocument = await vscode.workspace.openTextDocument(revisionUri);
  assert.strictEqual(s052Net48CodeDocument.getText(), revisionSourceBefore,
    'S052 net48 did not start from the exact code-behind baseline');
  let s052Net48InterleaveApplied = false;
  await testApi.createOpenDesignerHandlerWithInterleave(revisionUri, 'textBox1', 'Click', async () => {
    const edit = new vscode.WorkspaceEdit();
    edit.insert(revisionUri, new vscode.Position(0, 0), s052Net48Marker);
    assert.strictEqual(await vscode.workspace.applyEdit(edit), true, 'S052 net48 code interleave was not applied');
    s052Net48InterleaveApplied = true;
  });
  assert.strictEqual(s052Net48InterleaveApplied, true, 'S052 net48 did not execute its post-generation interleave');
  assert.strictEqual(testApi.openDesignerState(revisionUri)?.designerText, revisionDesignerBefore,
    'S052 net48 committed Designer wiring against stale code-behind');
  assert.strictEqual(testApi.openDesignerState(revisionUri)?.dirty, false,
    'S052 net48 refusal dirtied the Designer document');
  assert.ok(s052Net48CodeDocument.getText().startsWith(s052Net48Marker.trimEnd()),
    `S052 net48 hid the independent code edit: ${JSON.stringify(s052Net48CodeDocument.getText())}`);
  assert.doesNotMatch(s052Net48CodeDocument.getText(), /textBox1_Click/,
    'S052 net48 inserted an orphan handler stub');
  assert.doesNotMatch(testApi.openDesignerState(revisionUri)?.designerText ?? '', /\.Click \+=/,
    'S052 net48 inserted an orphan event subscription');
  assert.strictEqual(sha256File(revisionSource), revisionSourceHash, 'S052 net48 changed code-behind disk');
  assert.strictEqual(sha256File(revisionDesigner), revisionDesignerHash, 'S052 net48 changed Designer disk');
  await vscode.window.showTextDocument(s052Net48CodeDocument, { preview: false, preserveFocus: false });
  await waitFor(() => path.normalize(vscode.window.activeTextEditor?.document.uri.fsPath ?? '')
    === path.normalize(revisionSource), 'S052 net48 could not focus the interleaved document for test cleanup');
  await vscode.commands.executeCommand('workbench.action.files.revert');
  await waitFor(() => s052Net48CodeDocument.getText() === revisionSourceBefore && !s052Net48CodeDocument.isDirty,
    'S052 net48 could not revert its test-actor edit');
  await waitFor(() => testApi.openDesignerState(revisionUri)?.renderReady === true,
    `S052 net48 render did not recover after revert: ${JSON.stringify(testApi.openDesignerState(revisionUri))}`,
    60_000);
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

  const s052ModernSource = path.join(lifecycleDir, 'S052ModernStaleHandlerForm.cs');
  const s052ModernDesigner = path.join(lifecycleDir, 'S052ModernStaleHandlerForm.Designer.cs');
  const s052ModernSourceBefore = [
    'using System;',
    'using System.Windows.Forms;',
    'namespace DemoApp;',
    'public partial class S052ModernStaleHandlerForm : Form',
    '{',
    '    public S052ModernStaleHandlerForm() => InitializeComponent();',
    '}',
    '',
  ].join('\r\n');
  const s052ModernDesignerBefore = [
    'namespace DemoApp;',
    'partial class S052ModernStaleHandlerForm',
    '{',
    '    private System.Windows.Forms.Button button1;',
    '    private void InitializeComponent()',
    '    {',
    '        this.button1 = new System.Windows.Forms.Button();',
    '        this.button1.Location = new System.Drawing.Point(24, 32);',
    '        this.button1.Name = "button1";',
    '        this.button1.Size = new System.Drawing.Size(120, 30);',
    '        this.Controls.Add(this.button1);',
    '        this.Name = "S052ModernStaleHandlerForm";',
    '    }',
    '}',
    '',
  ].join('\r\n');
  fs.writeFileSync(s052ModernSource, s052ModernSourceBefore, 'utf8');
  fs.writeFileSync(s052ModernDesigner, s052ModernDesignerBefore, 'utf8');
  const s052ModernSourceHash = sha256File(s052ModernSource);
  const s052ModernDesignerHash = sha256File(s052ModernDesigner);
  const s052ModernUri = vscode.Uri.file(s052ModernSource);
  await vscode.commands.executeCommand('vscode.openWith', s052ModernUri, designerViewType);
  await waitFor(() => testApi.openDesignerState(s052ModernUri)?.renderReady === true,
    `S052 modern form did not render: ${JSON.stringify(testApi.openDesignerState(s052ModernUri))}`, 60_000);
  assert.strictEqual(testApi.openDesignerState(s052ModernUri)?.engineKind, 'modern');
  const s052ModernCodeDocument = await vscode.workspace.openTextDocument(s052ModernUri);
  const s052ModernMarker = '// S052 modern independent edit\n';
  let s052ModernInterleaveApplied = false;
  await testApi.createOpenDesignerHandlerWithInterleave(s052ModernUri, 'button1', 'Click', async () => {
    const edit = new vscode.WorkspaceEdit();
    edit.insert(s052ModernUri, new vscode.Position(0, 0), s052ModernMarker);
    assert.strictEqual(await vscode.workspace.applyEdit(edit), true, 'S052 modern code interleave was not applied');
    s052ModernInterleaveApplied = true;
  });
  assert.strictEqual(s052ModernInterleaveApplied, true, 'S052 modern did not execute its post-generation interleave');
  assert.strictEqual(testApi.openDesignerState(s052ModernUri)?.designerText, s052ModernDesignerBefore,
    'S052 modern committed Designer wiring against stale code-behind');
  assert.strictEqual(testApi.openDesignerState(s052ModernUri)?.dirty, false,
    'S052 modern refusal dirtied the Designer document');
  assert.ok(s052ModernCodeDocument.getText().startsWith(s052ModernMarker.trimEnd()),
    `S052 modern hid the independent code edit: ${JSON.stringify(s052ModernCodeDocument.getText())}`);
  assert.doesNotMatch(s052ModernCodeDocument.getText(), /button1_Click/,
    'S052 modern inserted an orphan handler stub');
  assert.doesNotMatch(testApi.openDesignerState(s052ModernUri)?.designerText ?? '', /\.Click \+=/,
    'S052 modern inserted an orphan event subscription');
  assert.strictEqual(sha256File(s052ModernSource), s052ModernSourceHash, 'S052 modern changed code-behind disk');
  assert.strictEqual(sha256File(s052ModernDesigner), s052ModernDesignerHash, 'S052 modern changed Designer disk');
  const s052ModernBaselineStart = s052ModernCodeDocument.getText().indexOf('using System;');
  assert.ok(s052ModernBaselineStart > 0, 'S052 modern cleanup could not find the exact baseline start');
  const s052ModernCleanup = new vscode.WorkspaceEdit();
  s052ModernCleanup.delete(s052ModernUri, new vscode.Range(
    s052ModernCodeDocument.positionAt(0),
    s052ModernCodeDocument.positionAt(s052ModernBaselineStart),
  ));
  assert.strictEqual(await vscode.workspace.applyEdit(s052ModernCleanup), true,
    'S052 modern could not remove only its test-actor prefix');
  assert.strictEqual(s052ModernCodeDocument.getText(), s052ModernSourceBefore,
    'S052 modern cleanup did not restore the exact temporary baseline');
  assert.strictEqual(await s052ModernCodeDocument.save(), true, 'S052 modern cleanup could not save its baseline');
  assert.strictEqual(sha256File(s052ModernSource), s052ModernSourceHash,
    'S052 modern cleanup changed its temporary baseline bytes');

  // V2-FND-001-S031 repository leg — exercise the actual host-side center calculation against a compiled net48
  // Panel with asymmetric Padding and an odd client width. The browser sends only axis/ids; the CustomEditor must
  // consume engine client rectangles, produce the exact one-Location patch, and publish one native undo unit.
  // Actual Visual Studio 18.7 proves that Format.CenterHorizontally uses the complete ClientRectangle and therefore
  // ignores Padding for this explicit command: floor((241 - 80) / 2) = 80.
  const centerSource = path.join(net48FixtureRoot, 'S031CenterPanelForm.cs');
  const centerDesigner = path.join(net48FixtureRoot, 'S031CenterPanelForm.Designer.cs');
  const centerBefore = fs.readFileSync(centerDesigner, 'utf8');
  const centerAfter = centerBefore.replace(
    'this.button1.Location = new System.Drawing.Point(15, 40);',
    'this.button1.Location = new System.Drawing.Point(80, 40);',
  );
  assert.notStrictEqual(centerAfter, centerBefore, 'S031 baseline Location assignment is missing');
  const centerUri = vscode.Uri.file(centerSource);
  await vscode.commands.executeCommand('vscode.openWith', centerUri, designerViewType);
  await waitFor(
    () => testApi.openDesignerState(centerUri)?.renderReady === true,
    `S031 net48 center form did not render: ${JSON.stringify(testApi.openDesignerState(centerUri))}`,
    60_000,
  );
  assert.strictEqual(testApi.openDesignerState(centerUri)?.engineKind, 'net48');
  await testApi.centerOpenDesignerControls(centerUri, 'h', ['button1']);
  await waitFor(
    () => testApi.openDesignerState(centerUri)?.designerText === centerAfter,
    `S031 centering produced an unexpected source patch: ${testApi.openDesignerState(centerUri)?.designerText}`,
  );
  assert.strictEqual(testApi.openDesignerState(centerUri)?.dirty, true);
  assert.strictEqual(fs.readFileSync(centerDesigner, 'utf8'), centerBefore, 'unsaved S031 centering touched disk');
  await runDesignerHistoryCommand(testApi, centerUri, 'undo');
  await waitFor(() => testApi.openDesignerState(centerUri)?.designerText === centerBefore,
    'one native Undo did not restore the S031 Location baseline');
  assert.strictEqual(testApi.openDesignerState(centerUri)?.dirty, false);
  await runDesignerHistoryCommand(testApi, centerUri, 'redo');
  await waitFor(() => testApi.openDesignerState(centerUri)?.designerText === centerAfter,
    'one native Redo did not reapply the S031 Location patch');
  await runDesignerHistoryCommand(testApi, centerUri, 'undo');
  await waitFor(() => testApi.openDesignerState(centerUri)?.dirty === false,
    'final S031 Undo did not restore a clean document');
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

  // V2-FND-001-S011 — a concrete Framework form whose base is GenericBaseForm<int> must route to the real net48
  // product session, retain the compiled inherited control as read-only metadata, and expose its own designer control
  // as current-source/editable. This is the VS visual-inheritance boundary, not a source-only resolver assertion.
  const genericSource = path.join(net48FixtureRoot, 'GenericDerivedForm.cs');
  const genericDesigner = path.join(net48FixtureRoot, 'GenericDerivedForm.Designer.cs');
  const genericBefore = fs.readFileSync(genericDesigner, 'utf8');
  const genericUri = vscode.Uri.file(genericSource);
  await vscode.commands.executeCommand('vscode.openWith', genericUri, designerViewType);
  await waitFor(
    () => testApi.openDesignerState(genericUri)?.renderReady === true,
    'generic-base net48 form did not reach a successful product render',
    30_000,
  );
  const genericState = testApi.openDesignerState(genericUri);
  assert.strictEqual(genericState?.engineKind, 'net48');
  assert.strictEqual(genericState?.ownerDiagnosticCode, 'NONE');
  assert.strictEqual(genericState?.ownerTypeName, 'SampleApp.GenericDerivedForm');
  assert.deepStrictEqual(
    genericState?.controls.find((control) => control.id === 'baseButton'),
    { id: 'baseButton', parentId: 'this', ownership: 'inherited', editable: false },
  );
  assert.deepStrictEqual(
    genericState?.controls.find((control) => control.id === 'derivedButton'),
    { id: 'derivedButton', parentId: 'this', ownership: 'currentSource', editable: true },
  );
  assert.strictEqual(testApi.openDesignerState(genericUri)?.dirty, false);
  assert.strictEqual(fs.readFileSync(genericDesigner, 'utf8'), genericBefore);
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

  // V2-FND-001-S085 / V2-FND-001-S086 / V2-FND-001-S088 — use a source-identical fixture built only for net10 so the product must select the
  // modern engine. The real CustomEditor may write a protected inherited override into the derived source, but a
  // private inherited Label/Button remains selectable/readable and refuses both a scalar edit and geometry mutation.
  const modernInheritanceRoot = path.join(workspaceFolder.uri.fsPath, 'fixtures', 'Net48CtxFixtureModern');
  const modernInheritanceSource = path.join(modernInheritanceRoot, 'GenericDerivedForm.cs');
  const modernInheritanceDesigner = path.join(modernInheritanceRoot, 'GenericDerivedForm.Designer.cs');
  const modernInheritanceBase = path.join(modernInheritanceRoot, 'GenericBaseForm.cs');
  const modernInheritanceBefore = fs.readFileSync(modernInheritanceDesigner, 'utf8');
  const modernInheritanceSourceHash = sha256File(modernInheritanceSource);
  const modernInheritanceDesignerHash = sha256File(modernInheritanceDesigner);
  const modernInheritanceBaseHash = sha256File(modernInheritanceBase);
  const modernInheritanceUri = vscode.Uri.file(modernInheritanceSource);
  await vscode.commands.executeCommand('vscode.openWith', modernInheritanceUri, designerViewType);
  await waitFor(() => testApi.openDesignerState(modernInheritanceUri)?.renderReady === true,
    `S085 modern inherited form did not render: ${JSON.stringify(testApi.openDesignerState(modernInheritanceUri))}`,
    60_000);
  assert.strictEqual(testApi.openDesignerState(modernInheritanceUri)?.engineKind, 'modern');
  assert.deepStrictEqual(
    testApi.openDesignerState(modernInheritanceUri)?.controls.find((control) => control.id === 'baseButton'),
    { id: 'baseButton', parentId: 'this', ownership: 'inherited', editable: false },
    'S085 protected base Button did not reach the real modern CustomEditor as inherited metadata',
  );
  await testApi.selectOpenDesignerControl(modernInheritanceUri, 'baseButton');
  const protectedInheritedProperties = testApi.openDesignerProperties(modernInheritanceUri);
  assert.strictEqual(protectedInheritedProperties?.ownership, 'inherited');
  assert.strictEqual(protectedInheritedProperties?.editable, false);
  assert.strictEqual(protectedInheritedProperties?.inheritedOverrideEditable, true);
  assert.match(protectedInheritedProperties?.baseIdentityToken ?? '', /^sha256:/,
    'S085 protected inherited metadata did not carry a compiled-base identity token');
  const inheritedTextProperty = protectedInheritedProperties?.properties.find((property) => property.name === 'Text');
  assert.strictEqual(inheritedTextProperty?.readOnly, false);
  assert.strictEqual(inheritedTextProperty?.inheritedOverrideEditable, true);
  await testApi.editOpenDesignerProperty(
    modernInheritanceUri, 'baseButton', 'Text', 'System.String', false, 'Derived caption');
  const modernInheritanceNewLine = modernInheritanceBefore.includes('\r\n') ? '\r\n' : '\n';
  const modernInheritanceAfter = modernInheritanceBefore.replace(
    '            this.Name = "GenericDerivedForm";',
    `            this.Name = "GenericDerivedForm";${modernInheritanceNewLine}            this.baseButton.Text = "Derived caption";`,
  );
  assert.notStrictEqual(modernInheritanceAfter, modernInheritanceBefore,
    'S085 derived fixture insertion anchor is missing');
  await waitFor(() => testApi.openDesignerState(modernInheritanceUri)?.designerText === modernInheritanceAfter,
    `S085 inherited override produced an unexpected derived source: ${testApi.openDesignerState(modernInheritanceUri)?.designerText}`);
  assert.strictEqual(testApi.openDesignerState(modernInheritanceUri)?.dirty, true);
  assert.strictEqual(sha256File(modernInheritanceSource), modernInheritanceSourceHash,
    'S085 unsaved override changed derived code-behind disk');
  assert.strictEqual(sha256File(modernInheritanceDesigner), modernInheritanceDesignerHash,
    'S085 unsaved override changed derived Designer disk');
  assert.strictEqual(sha256File(modernInheritanceBase), modernInheritanceBaseHash,
    'S085 inherited override changed base source');
  await runDesignerHistoryCommand(testApi, modernInheritanceUri, 'undo');
  await waitFor(() => testApi.openDesignerState(modernInheritanceUri)?.designerText === modernInheritanceBefore
    && testApi.openDesignerState(modernInheritanceUri)?.dirty === false,
  'S085 one native Undo did not restore the exact clean derived source');
  await runDesignerHistoryCommand(testApi, modernInheritanceUri, 'redo');
  await waitFor(() => testApi.openDesignerState(modernInheritanceUri)?.designerText === modernInheritanceAfter,
    'S085 one native Redo did not reapply the protected inherited override');
  await runDesignerHistoryCommand(testApi, modernInheritanceUri, 'undo');
  await waitFor(() => testApi.openDesignerState(modernInheritanceUri)?.designerText === modernInheritanceBefore
    && testApi.openDesignerState(modernInheritanceUri)?.dirty === false,
  'S085 final Undo did not restore the exact clean fixture');

  await testApi.selectOpenDesignerControl(modernInheritanceUri, 'privateInheritedLabel');
  const privateInheritedLabel = testApi.openDesignerState(modernInheritanceUri)?.controls.find(
    (control) => control.id === 'privateInheritedLabel');
  assert.deepStrictEqual(privateInheritedLabel,
    { id: 'privateInheritedLabel', parentId: 'this', ownership: 'inherited', editable: false },
    'S086 private inherited Label was not selectable as a locked inherited control');
  assert.strictEqual(testApi.openDesignerState(modernInheritanceUri)?.currentId, 'privateInheritedLabel');
  const privateLabelProperties = testApi.openDesignerProperties(modernInheritanceUri);
  assert.strictEqual(privateLabelProperties?.ownership, 'inherited');
  assert.strictEqual(privateLabelProperties?.editable, false);
  assert.strictEqual(privateLabelProperties?.inheritedOverrideEditable, false);
  assert.match(privateLabelProperties?.readOnlyReason ?? '', /base type|not public or protected/i,
    'S086 private inherited Label did not disclose its locked reason');
  assert.strictEqual(privateLabelProperties?.properties.find((property) => property.name === 'Text')?.readOnly, true,
    'S086 private inherited Label exposed an editable Text row');
  await testApi.editOpenDesignerProperty(
    modernInheritanceUri, 'privateInheritedLabel', 'Text', 'System.String', false, 'Must not apply');
  assert.strictEqual(testApi.openDesignerState(modernInheritanceUri)?.designerText, modernInheritanceBefore,
    'S086 direct Properties ingress changed a private inherited Label');
  assert.strictEqual(testApi.openDesignerState(modernInheritanceUri)?.dirty, false,
    'S086 read-only selection dirtied the CustomDocument');

  await testApi.selectOpenDesignerControl(modernInheritanceUri, 'privateInheritedButton');
  const modernPrivateButtonProperties = testApi.openDesignerProperties(modernInheritanceUri);
  assert.strictEqual(modernPrivateButtonProperties?.ownership, 'inherited');
  assert.strictEqual(modernPrivateButtonProperties?.inheritedOverrideEditable, false);
  assert.match(modernPrivateButtonProperties?.readOnlyReason ?? '', /base type|not public or protected/i);
  await testApi.moveOpenDesignerGroup(modernInheritanceUri, ['privateInheritedButton'], 7, 9);
  assert.strictEqual(testApi.openDesignerState(modernInheritanceUri)?.designerText, modernInheritanceBefore,
    'S088 modern move ingress changed a private inherited Button');
  assert.strictEqual(testApi.openDesignerState(modernInheritanceUri)?.dirty, false,
    'S088 modern refusal created a dirty CustomDocument');
  await runDesignerHistoryCommand(testApi, modernInheritanceUri, 'undo');
  assert.strictEqual(testApi.openDesignerState(modernInheritanceUri)?.designerText, modernInheritanceBefore,
    'S088 modern refusal created a phantom native history entry');
  assert.strictEqual(sha256File(modernInheritanceBase), modernInheritanceBaseHash,
    'S086/S088 modern read-only paths changed base source');
  assert.strictEqual(sha256File(modernInheritanceDesigner), modernInheritanceDesignerHash,
    'S086/S088 modern read-only paths changed derived Designer disk');
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

  // V2-FND-001-S087 / V2-FND-001-S088 — repeat the derived-only Add and private-inherited move boundary in the real compiled-net48
  // CustomEditor. The new Button belongs solely to the derived Designer buffer and one native history unit; the base
  // Panel/Button/Label source is an immutable compiled authority throughout.
  const net48InheritanceBase = path.join(net48FixtureRoot, 'GenericBaseForm.cs');
  const net48InheritanceSourceHash = sha256File(genericSource);
  const net48InheritanceDesignerHash = sha256File(genericDesigner);
  const net48InheritanceBaseHash = sha256File(net48InheritanceBase);
  await vscode.commands.executeCommand('vscode.openWith', genericUri, designerViewType);
  await waitFor(() => testApi.openDesignerState(genericUri)?.renderReady === true,
    `S087 net48 inherited form did not render: ${JSON.stringify(testApi.openDesignerState(genericUri))}`,
    60_000);
  assert.strictEqual(testApi.openDesignerState(genericUri)?.engineKind, 'net48');
  assert.deepStrictEqual(
    testApi.openDesignerState(genericUri)?.controls.find((control) => control.id === 'basePanel'),
    { id: 'basePanel', parentId: 'this', ownership: 'inherited', editable: false },
    'S087 compiled base Panel did not reach the real net48 CustomEditor',
  );
  await testApi.selectOpenDesignerControl(genericUri, 'privateInheritedButton');
  const net48PrivateButtonProperties = testApi.openDesignerProperties(genericUri);
  assert.strictEqual(net48PrivateButtonProperties?.ownership, 'inherited');
  assert.strictEqual(net48PrivateButtonProperties?.inheritedOverrideEditable, false);
  assert.match(net48PrivateButtonProperties?.readOnlyReason ?? '', /base type|not public or protected/i);
  await testApi.moveOpenDesignerGroup(genericUri, ['privateInheritedButton'], 11, 13);
  assert.strictEqual(testApi.openDesignerState(genericUri)?.designerText, genericBefore,
    'S088 compiled-net48 move ingress changed a private inherited Button');
  assert.strictEqual(testApi.openDesignerState(genericUri)?.dirty, false,
    'S088 compiled-net48 refusal created a dirty CustomDocument');
  await runDesignerHistoryCommand(testApi, genericUri, 'undo');
  assert.strictEqual(testApi.openDesignerState(genericUri)?.designerText, genericBefore,
    'S088 compiled-net48 refusal created a phantom native history entry');

  await testApi.addOpenDesignerControl(genericUri, 'Button', 'this', 18, 24);
  await waitFor(() => testApi.openDesignerState(genericUri)?.controls.some((control) =>
    control.id === 'button1' && control.ownership === 'currentSource' && control.editable === true) === true,
  `S087 net48 derived-only Button did not render: ${JSON.stringify(testApi.openDesignerState(genericUri))}`);
  const net48InheritanceAfter = testApi.openDesignerState(genericUri)?.designerText ?? '';
  assert.match(net48InheritanceAfter, /private System\.Windows\.Forms\.Button button1;/,
    'S087 did not add a derived-only field declaration');
  assert.match(net48InheritanceAfter, /this\.Controls\.Add\(this\.button1\);/,
    'S087 did not add the new Button to the derived root surface');
  assert.ok(!net48InheritanceAfter.includes('privateInheritedButton'),
    'S087 leaked a private base field into derived source');
  assert.strictEqual(testApi.openDesignerState(genericUri)?.dirty, true);
  assert.strictEqual(sha256File(genericSource), net48InheritanceSourceHash,
    'S087 unsaved Add changed derived code-behind disk');
  assert.strictEqual(sha256File(genericDesigner), net48InheritanceDesignerHash,
    'S087 unsaved Add changed derived Designer disk');
  assert.strictEqual(sha256File(net48InheritanceBase), net48InheritanceBaseHash,
    'S087 unsaved Add changed compiled base source');
  await runDesignerHistoryCommand(testApi, genericUri, 'undo');
  await waitFor(() => testApi.openDesignerState(genericUri)?.designerText === genericBefore
    && testApi.openDesignerState(genericUri)?.dirty === false,
  'S087 one native Undo did not restore the exact clean derived source');
  await runDesignerHistoryCommand(testApi, genericUri, 'redo');
  await waitFor(() => testApi.openDesignerState(genericUri)?.designerText === net48InheritanceAfter,
    'S087 one native Redo did not reapply the exact derived-only Button');
  await runDesignerHistoryCommand(testApi, genericUri, 'undo');
  await waitFor(() => testApi.openDesignerState(genericUri)?.designerText === genericBefore
    && testApi.openDesignerState(genericUri)?.dirty === false,
  'S087 final Undo did not restore the exact clean fixture');
  assert.strictEqual(sha256File(net48InheritanceBase), net48InheritanceBaseHash,
    'S087/S088 net48 paths changed compiled base source');
  assert.strictEqual(sha256File(genericDesigner), net48InheritanceDesignerHash,
    'S087/S088 net48 paths changed derived Designer disk');
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

  // W1.6 — VS removes explicit classic project items in the same delete operation. Use an SDK project with
  // default items disabled so the membership is truly explicit while the before/after build remains executable.
  const deleteClassicDir = path.join(workspaceRoot, 'DeleteClassic');
  fs.mkdirSync(deleteClassicDir, { recursive: true });
  const deleteClassicProject = path.join(deleteClassicDir, 'DeleteClassic.csproj');
  const deleteClassicSource = path.join(deleteClassicDir, 'DeleteClassicForm.cs');
  const deleteClassicDesigner = path.join(deleteClassicDir, 'DeleteClassicForm.Designer.cs');
  const deleteClassicResx = path.join(deleteClassicDir, 'DeleteClassicForm.resx');
  fs.writeFileSync(deleteClassicProject, [
    '<Project Sdk="Microsoft.NET.Sdk">',
    '  <PropertyGroup>',
    '    <TargetFramework>net10.0-windows</TargetFramework>',
    '    <UseWindowsForms>true</UseWindowsForms>',
    '    <EnableDefaultItems>false</EnableDefaultItems>',
    '  </PropertyGroup>',
    '  <ItemGroup>',
    '    <Compile Include="DeleteClassicForm.cs"><SubType>Form</SubType></Compile>',
    '    <Compile Include="DeleteClassicForm.Designer.cs"><DependentUpon>DeleteClassicForm.cs</DependentUpon></Compile>',
    '    <EmbeddedResource Include="DeleteClassicForm.resx"><DependentUpon>DeleteClassicForm.cs</DependentUpon></EmbeddedResource>',
    '  </ItemGroup>',
    '</Project>',
    '',
  ].join('\r\n'), 'utf8');
  fs.writeFileSync(deleteClassicSource, [
    'namespace DeleteClassic;',
    'public partial class DeleteClassicForm : System.Windows.Forms.Form',
    '{',
    '    public DeleteClassicForm() => InitializeComponent();',
    '}',
    '',
  ].join('\r\n'), 'utf8');
  fs.writeFileSync(deleteClassicDesigner, [
    'namespace DeleteClassic;',
    'partial class DeleteClassicForm',
    '{',
    '    private void InitializeComponent() { }',
    '}',
    '',
  ].join('\r\n'), 'utf8');
  fs.writeFileSync(deleteClassicResx, '<root />\r\n', 'utf8');
  execFileSync('dotnet', ['build', deleteClassicProject, '--nologo', '--verbosity', 'quiet'], { stdio: 'pipe' });
  const classicDelete = new vscode.WorkspaceEdit();
  classicDelete.deleteFile(vscode.Uri.file(deleteClassicSource), { ignoreIfNotExists: false });
  assert.ok(await vscode.workspace.applyEdit(classicDelete), 'classic form delete did not apply');
  try {
    await waitFor(
      () => !fs.existsSync(deleteClassicSource)
        && !fs.existsSync(deleteClassicDesigner)
        && !fs.existsSync(deleteClassicResx)
        && !fs.readFileSync(deleteClassicProject, 'utf8').includes('DeleteClassicForm'),
      'classic delete did not remove files and explicit project membership',
    );
  } catch (error) {
    const projectDocument = vscode.workspace.textDocuments.find(
      (document) => document.uri.fsPath.toLocaleLowerCase('en-US') === deleteClassicProject.toLocaleLowerCase('en-US'),
    );
    throw new Error([
      error instanceof Error ? error.message : String(error),
      `source=${fs.existsSync(deleteClassicSource)}`,
      `designer=${fs.existsSync(deleteClassicDesigner)}`,
      `resx=${fs.existsSync(deleteClassicResx)}`,
      `diskHasItems=${fs.readFileSync(deleteClassicProject, 'utf8').includes('DeleteClassicForm')}`,
      `docOpen=${Boolean(projectDocument)}`,
      `docDirty=${projectDocument?.isDirty ?? false}`,
      `docHasItems=${projectDocument?.getText().includes('DeleteClassicForm') ?? false}`,
    ].join('; '));
  }
  execFileSync('dotnet', ['build', deleteClassicProject, '--nologo', '--verbosity', 'quiet'], { stdio: 'pipe' });

  // Deleting a form deletes the whole form (issue #3). This has to run in a real Extension Host too: the behaviour is
  // contributed to VS Code's own delete operation through onWillDeleteFiles, so nothing headless can prove that the
  // generated files actually go with it — or, just as important, that a file which merely looks similar stays.
  const scratch = path.join(os.tmpdir(), 'wfd-delete-form-' + Date.now());
  fs.mkdirSync(scratch, { recursive: true });
  const written = (name: string, body: string): string => {
    const file = path.join(scratch, name);
    fs.writeFileSync(file, body, 'utf8');
    return file;
  };
  const form = written('DeleteMe.cs', 'namespace S { public partial class DeleteMe : System.Windows.Forms.Form { } }');
  const generated = written('DeleteMe.Designer.cs', 'namespace S { partial class DeleteMe { private void InitializeComponent() { } } }');
  const resx = written('DeleteMe.resx', '<root />');
  const localized = written('DeleteMe.ru.resx', '<root />');
  const bystander = written('DeleteMe.Backup.resx', '<root />');   // not culture-shaped: not ours to delete
  const otherForm = written('DeleteMe2.cs', 'namespace S { }');    // shares the prefix, different form

  // A workbench delete — what the Explorer and any refactoring do. (`workspace.fs.delete` deliberately does NOT
  // raise the file-operation events, so it could never exercise this.)
  const deletion = new vscode.WorkspaceEdit();
  deletion.deleteFile(vscode.Uri.file(form), { ignoreIfNotExists: false });
  assert.ok(await vscode.workspace.applyEdit(deletion), 'the form delete itself did not apply');
  await new Promise((resolve) => setTimeout(resolve, 1000)); // the contributed edit applies with the operation

  for (const gone of [form, generated, resx, localized]) {
    assert.ok(!fs.existsSync(gone), `deleting the form should have taken ${path.basename(gone)} with it`);
  }
  for (const kept of [bystander, otherForm]) {
    assert.ok(fs.existsSync(kept), `deleting the form must NOT touch ${path.basename(kept)}`);
  }
  fs.rmSync(scratch, { recursive: true, force: true });

  // V2-FND-001-S022 — the real CustomEditor single-control resize ingress must match Visual Studio's anchored
  // east-handle result: only Size changes from 120x30 to 160x30; the Top|Left|Right Anchor and Location survive.
  const anchoredSource = path.join(lifecycleDir, 'AnchoredResizeForm.cs');
  const anchoredDesigner = path.join(lifecycleDir, 'AnchoredResizeForm.Designer.cs');
  fs.writeFileSync(anchoredSource, [
    'using System.Windows.Forms;',
    'namespace DemoApp;',
    'public partial class AnchoredResizeForm : Form',
    '{',
    '    public AnchoredResizeForm() => InitializeComponent();',
    '}',
    '',
  ].join('\r\n'), 'utf8');
  fs.writeFileSync(anchoredDesigner, [
    'namespace DemoApp;',
    'partial class AnchoredResizeForm',
    '{',
    '    private System.Windows.Forms.Button anchoredButton;',
    '    private void InitializeComponent()',
    '    {',
    '        this.anchoredButton = new System.Windows.Forms.Button();',
    '        this.anchoredButton.Anchor = System.Windows.Forms.AnchorStyles.Top | System.Windows.Forms.AnchorStyles.Left | System.Windows.Forms.AnchorStyles.Right;',
    '        this.anchoredButton.Location = new System.Drawing.Point(24, 48);',
    '        this.anchoredButton.Name = "anchoredButton";',
    '        this.anchoredButton.Size = new System.Drawing.Size(120, 30);',
    '        this.anchoredButton.Text = "Anchored button";',
    '        this.Controls.Add(this.anchoredButton);',
    '        this.ClientSize = new System.Drawing.Size(360, 180);',
    '        this.Name = "AnchoredResizeForm";',
    '    }',
    '}',
    '',
  ].join('\r\n'), 'utf8');
  const anchoredUri = vscode.Uri.file(anchoredSource);
  await vscode.commands.executeCommand('vscode.openWith', anchoredUri, designerViewType);
  await waitFor(
    () => testApi.openDesignerState(anchoredUri)?.renderReady === true,
    `anchored resize form did not render: ${JSON.stringify(testApi.openDesignerState(anchoredUri))}`,
    60_000,
  );
  assert.strictEqual(testApi.openDesignerState(anchoredUri)?.engineKind, 'modern');
  const anchoredBefore = testApi.openDesignerState(anchoredUri)?.designerText ?? '';
  const anchoredAfter = anchoredBefore.replace(
    'this.anchoredButton.Size = new System.Drawing.Size(120, 30);',
    'this.anchoredButton.Size = new System.Drawing.Size(160, 30);',
  );
  assert.notStrictEqual(anchoredAfter, anchoredBefore, 'S022 baseline Size assignment is missing');
  await testApi.resizeOpenDesignerControl(anchoredUri, 'anchoredButton', 160, 30);
  await waitFor(
    () => testApi.openDesignerState(anchoredUri)?.designerText === anchoredAfter,
    `anchored resize produced an unexpected source patch: ${testApi.openDesignerState(anchoredUri)?.designerText}`,
  );
  assert.match(anchoredAfter, /anchoredButton\.Anchor = System\.Windows\.Forms\.AnchorStyles\.Top \| System\.Windows\.Forms\.AnchorStyles\.Left \| System\.Windows\.Forms\.AnchorStyles\.Right;/);
  assert.match(anchoredAfter, /anchoredButton\.Location = new System\.Drawing\.Point\(24, 48\);/);
  assert.strictEqual(testApi.openDesignerState(anchoredUri)?.dirty, true);
  assert.deepStrictEqual(fs.readFileSync(anchoredDesigner, 'utf8'), anchoredBefore, 'unsaved anchored resize touched disk');
  await runDesignerHistoryCommand(testApi, anchoredUri, 'undo');
  await waitFor(() => testApi.openDesignerState(anchoredUri)?.designerText === anchoredBefore,
    'one native Undo did not restore the anchored resize baseline');
  await runDesignerHistoryCommand(testApi, anchoredUri, 'redo');
  await waitFor(() => testApi.openDesignerState(anchoredUri)?.designerText === anchoredAfter,
    'one native Redo did not restore the anchored resize');
  await runDesignerHistoryCommand(testApi, anchoredUri, 'undo');
  await waitFor(() => testApi.openDesignerState(anchoredUri)?.dirty === false,
    'final anchored resize Undo did not restore a clean document');
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

  // V2-FND-001-S029 — execute the same per-control alignment transaction posted by the canvas toolbar. The
  // actual-Visual-Studio fixture establishes button1 (X=12) as the primary after Select All; the product must change
  // only button2/button3 X, publish one native undo unit, and leave disk untouched until an explicit save.
  const alignSource = path.join(lifecycleDir, 'S029AlignLeftForm.cs');
  const alignDesigner = path.join(lifecycleDir, 'S029AlignLeftForm.Designer.cs');
  fs.writeFileSync(alignSource, [
    'using System.Windows.Forms;',
    'namespace DemoApp;',
    'public partial class S029AlignLeftForm : Form',
    '{',
    '    public S029AlignLeftForm() => InitializeComponent();',
    '}',
    '',
  ].join('\r\n'), 'utf8');
  fs.writeFileSync(alignDesigner, [
    'namespace DemoApp;',
    'partial class S029AlignLeftForm',
    '{',
    '    private System.Windows.Forms.Button button1;',
    '    private System.Windows.Forms.Button button2;',
    '    private System.Windows.Forms.Button button3;',
    '    private void InitializeComponent()',
    '    {',
    '        this.button1 = new System.Windows.Forms.Button();',
    '        this.button2 = new System.Windows.Forms.Button();',
    '        this.button3 = new System.Windows.Forms.Button();',
    '        this.SuspendLayout();',
    '        this.button1.Location = new System.Drawing.Point(12, 10);',
    '        this.button1.Name = "button1";',
    '        this.button1.Size = new System.Drawing.Size(100, 30);',
    '        this.button2.Location = new System.Drawing.Point(42, 55);',
    '        this.button2.Name = "button2";',
    '        this.button2.Size = new System.Drawing.Size(100, 30);',
    '        this.button3.Location = new System.Drawing.Point(77, 100);',
    '        this.button3.Name = "button3";',
    '        this.button3.Size = new System.Drawing.Size(100, 30);',
    '        this.Controls.Add(this.button3);',
    '        this.Controls.Add(this.button2);',
    '        this.Controls.Add(this.button1);',
    '        this.ClientSize = new System.Drawing.Size(320, 180);',
    '        this.Name = "S029AlignLeftForm";',
    '    }',
    '}',
    '',
  ].join('\r\n'), 'utf8');
  const alignUri = vscode.Uri.file(alignSource);
  await vscode.commands.executeCommand('vscode.openWith', alignUri, designerViewType);
  await waitFor(
    () => testApi.openDesignerState(alignUri)?.renderReady === true,
    `S029 align form did not render: ${JSON.stringify(testApi.openDesignerState(alignUri))}`,
    60_000,
  );
  assert.strictEqual(testApi.openDesignerState(alignUri)?.engineKind, 'modern');
  const alignBefore = testApi.openDesignerState(alignUri)?.designerText ?? '';
  const alignAfter = alignBefore
    .replace(
      'this.button2.Location = new System.Drawing.Point(42, 55);',
      'this.button2.Location = new System.Drawing.Point(12, 55);',
    )
    .replace(
      'this.button3.Location = new System.Drawing.Point(77, 100);',
      'this.button3.Location = new System.Drawing.Point(12, 100);',
    );
  assert.notStrictEqual(alignAfter, alignBefore, 'S029 baseline locations are missing');
  await testApi.alignOpenDesignerControls(alignUri, [
    { id: 'button2', dx: -30, dy: 0 },
    { id: 'button3', dx: -65, dy: 0 },
  ]);
  await waitFor(
    () => testApi.openDesignerState(alignUri)?.designerText === alignAfter,
    `S029 alignment produced an unexpected source patch: ${testApi.openDesignerState(alignUri)?.designerText}`,
  );
  assert.strictEqual(testApi.openDesignerState(alignUri)?.dirty, true);
  assert.deepStrictEqual(fs.readFileSync(alignDesigner, 'utf8'), alignBefore, 'unsaved S029 alignment touched disk');
  await runDesignerHistoryCommand(testApi, alignUri, 'undo');
  await waitFor(() => testApi.openDesignerState(alignUri)?.designerText === alignBefore,
    'one native Undo did not restore both S029 locations');
  assert.strictEqual(testApi.openDesignerState(alignUri)?.dirty, false);
  await runDesignerHistoryCommand(testApi, alignUri, 'redo');
  await waitFor(() => testApi.openDesignerState(alignUri)?.designerText === alignAfter,
    'one native Redo did not reapply both S029 locations');
  await runDesignerHistoryCommand(testApi, alignUri, 'undo');
  await waitFor(() => testApi.openDesignerState(alignUri)?.dirty === false,
    'final S029 Undo did not restore a clean document');
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

  // V2-FND-001-S030 — mirror Visual Studio's Format.MakeSameWidth result through the real multi-control
  // applyResize ingress. Only button2/button3 widths change to the primary button1 width; each height remains exact,
  // both edits form one native undo unit, and the backing Designer.cs stays untouched until an explicit save.
  const sameWidthSource = path.join(lifecycleDir, 'S030SameWidthForm.cs');
  const sameWidthDesigner = path.join(lifecycleDir, 'S030SameWidthForm.Designer.cs');
  fs.writeFileSync(sameWidthSource, [
    'using System.Windows.Forms;',
    'namespace DemoApp;',
    'public partial class S030SameWidthForm : Form',
    '{',
    '    public S030SameWidthForm() => InitializeComponent();',
    '}',
    '',
  ].join('\r\n'), 'utf8');
  fs.writeFileSync(sameWidthDesigner, [
    'namespace DemoApp;',
    'partial class S030SameWidthForm',
    '{',
    '    private System.Windows.Forms.Button button1;',
    '    private System.Windows.Forms.Button button2;',
    '    private System.Windows.Forms.Button button3;',
    '    private void InitializeComponent()',
    '    {',
    '        this.button1 = new System.Windows.Forms.Button();',
    '        this.button2 = new System.Windows.Forms.Button();',
    '        this.button3 = new System.Windows.Forms.Button();',
    '        this.SuspendLayout();',
    '        this.button1.Location = new System.Drawing.Point(12, 10);',
    '        this.button1.Name = "button1";',
    '        this.button1.Size = new System.Drawing.Size(120, 30);',
    '        this.button2.Location = new System.Drawing.Point(42, 55);',
    '        this.button2.Name = "button2";',
    '        this.button2.Size = new System.Drawing.Size(60, 24);',
    '        this.button3.Location = new System.Drawing.Point(77, 100);',
    '        this.button3.Name = "button3";',
    '        this.button3.Size = new System.Drawing.Size(90, 36);',
    '        this.Controls.Add(this.button3);',
    '        this.Controls.Add(this.button2);',
    '        this.Controls.Add(this.button1);',
    '        this.ClientSize = new System.Drawing.Size(320, 180);',
    '        this.Name = "S030SameWidthForm";',
    '    }',
    '}',
    '',
  ].join('\r\n'), 'utf8');
  const sameWidthUri = vscode.Uri.file(sameWidthSource);
  await vscode.commands.executeCommand('vscode.openWith', sameWidthUri, designerViewType);
  await waitFor(
    () => testApi.openDesignerState(sameWidthUri)?.renderReady === true,
    `S030 same-width form did not render: ${JSON.stringify(testApi.openDesignerState(sameWidthUri))}`,
    60_000,
  );
  assert.strictEqual(testApi.openDesignerState(sameWidthUri)?.engineKind, 'modern');
  const sameWidthBefore = testApi.openDesignerState(sameWidthUri)?.designerText ?? '';
  const sameWidthAfter = sameWidthBefore
    .replace(
      'this.button2.Size = new System.Drawing.Size(60, 24);',
      'this.button2.Size = new System.Drawing.Size(120, 24);',
    )
    .replace(
      'this.button3.Size = new System.Drawing.Size(90, 36);',
      'this.button3.Size = new System.Drawing.Size(120, 36);',
    );
  assert.notStrictEqual(sameWidthAfter, sameWidthBefore, 'S030 baseline Size assignments are missing');
  await testApi.resizeOpenDesignerControls(sameWidthUri, [
    { id: 'button2', width: 120, height: 24 },
    { id: 'button3', width: 120, height: 36 },
  ]);
  await waitFor(
    () => testApi.openDesignerState(sameWidthUri)?.designerText === sameWidthAfter,
    `S030 same-width operation produced an unexpected source patch: ${testApi.openDesignerState(sameWidthUri)?.designerText}`,
  );
  assert.strictEqual(testApi.openDesignerState(sameWidthUri)?.dirty, true);
  assert.deepStrictEqual(
    fs.readFileSync(sameWidthDesigner, 'utf8'),
    sameWidthBefore,
    'unsaved S030 same-width operation touched disk',
  );
  await runDesignerHistoryCommand(testApi, sameWidthUri, 'undo');
  await waitFor(() => testApi.openDesignerState(sameWidthUri)?.designerText === sameWidthBefore,
    'one native Undo did not restore both S030 widths');
  assert.strictEqual(testApi.openDesignerState(sameWidthUri)?.dirty, false);
  await runDesignerHistoryCommand(testApi, sameWidthUri, 'redo');
  await waitFor(() => testApi.openDesignerState(sameWidthUri)?.designerText === sameWidthAfter,
    'one native Redo did not reapply both S030 widths');
  await runDesignerHistoryCommand(testApi, sameWidthUri, 'undo');
  await waitFor(() => testApi.openDesignerState(sameWidthUri)?.dirty === false,
    'final S030 Undo did not restore a clean document');
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

  // V2-FND-001-S049 — canvas double-click resolves Button.DefaultEvent (Click), generates the signature-aware stub,
  // wires Designer.cs, and navigates into the body. Exercise the exact host default-event ingress, then prove the two
  // unsaved buffers are one native CustomDocument Undo/Redo unit before Save persists either artifact.
  const defaultEventSource = path.join(lifecycleDir, 'S049DefaultEventForm.cs');
  const defaultEventDesigner = path.join(lifecycleDir, 'S049DefaultEventForm.Designer.cs');
  const defaultEventSourceBefore = [
    'using System.Windows.Forms;',
    'namespace DemoApp;',
    'public partial class S049DefaultEventForm : Form',
    '{',
    '    public S049DefaultEventForm() => InitializeComponent();',
    '}',
    '',
  ].join('\r\n');
  const defaultEventDesignerBefore = [
    'namespace DemoApp;',
    'partial class S049DefaultEventForm',
    '{',
    '    private System.Windows.Forms.Button button1;',
    '    private void InitializeComponent()',
    '    {',
    '        this.button1 = new System.Windows.Forms.Button();',
    '        this.SuspendLayout();',
    '        this.button1.Location = new System.Drawing.Point(24, 32);',
    '        this.button1.Name = "button1";',
    '        this.button1.Size = new System.Drawing.Size(120, 32);',
    '        this.button1.Text = "Create Click";',
    '        this.Controls.Add(this.button1);',
    '        this.ClientSize = new System.Drawing.Size(280, 140);',
    '        this.Name = "S049DefaultEventForm";',
    '    }',
    '}',
    '',
  ].join('\r\n');
  fs.writeFileSync(defaultEventSource, defaultEventSourceBefore, 'utf8');
  fs.writeFileSync(defaultEventDesigner, defaultEventDesignerBefore, 'utf8');
  const defaultEventUri = vscode.Uri.file(defaultEventSource);
  await vscode.commands.executeCommand('vscode.openWith', defaultEventUri, designerViewType);
  await waitFor(
    () => testApi.openDesignerState(defaultEventUri)?.renderReady === true,
    `S049 default-event form did not render: ${JSON.stringify(testApi.openDesignerState(defaultEventUri))}`,
    60_000,
  );
  assert.strictEqual(testApi.openDesignerState(defaultEventUri)?.engineKind, 'modern');
  await testApi.createOpenDesignerDefaultHandler(defaultEventUri, 'button1');
  const clickWiring = 'this.button1.Click += new System.EventHandler(this.button1_Click);';
  await waitFor(
    () => (testApi.openDesignerState(defaultEventUri)?.designerText ?? '').includes(clickWiring)
      && vscode.workspace.textDocuments.some((document) => path.normalize(document.uri.fsPath) === path.normalize(defaultEventSource)
        && /void button1_Click\(object sender, System\.EventArgs e\)/.test(document.getText()))
      && path.normalize(vscode.window.activeTextEditor?.document.uri.fsPath ?? '') === path.normalize(defaultEventSource),
    'S049 default Click generation did not update both buffers and navigate to code',
    30_000,
  );
  const defaultEventStateAfter = testApi.openDesignerState(defaultEventUri);
  const defaultEventDesignerAfter = defaultEventStateAfter?.designerText ?? '';
  const defaultEventCodeDocument = vscode.workspace.textDocuments.find(
    (document) => path.normalize(document.uri.fsPath) === path.normalize(defaultEventSource),
  );
  assert.ok(defaultEventCodeDocument, 'S049 code-behind buffer was not opened');
  const defaultEventSourceAfter = defaultEventCodeDocument.getText();
  assert.strictEqual(defaultEventStateAfter?.dirty, true, 'S049 generated-source wiring did not dirty the form tab');
  assert.strictEqual(defaultEventCodeDocument.isDirty, true, 'S049 handler stub was not an unsaved code edit');
  assert.strictEqual((defaultEventDesignerAfter.match(/\.Click \+=/g) ?? []).length, 1,
    'S049 generated more than one Click subscription');
  assert.strictEqual((defaultEventSourceAfter.match(/void button1_Click\(/g) ?? []).length, 1,
    'S049 generated more than one handler method');
  assert.strictEqual(fs.readFileSync(defaultEventDesigner, 'utf8'), defaultEventDesignerBefore,
    'S049 touched generated source on disk before Save');
  assert.strictEqual(fs.readFileSync(defaultEventSource, 'utf8'), defaultEventSourceBefore,
    'S049 touched code-behind on disk before Save');
  await waitFor(() => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || path.normalize(editor.document.uri.fsPath) !== path.normalize(defaultEventSource)) return false;
    const text = editor.document.getText();
    const start = text.indexOf('void button1_Click');
    const end = text.indexOf('\r\n    }', start);
    const offset = editor.document.offsetAt(editor.selection.active);
    return start >= 0 && offset > start && offset <= end;
  }, 'S049 cursor did not navigate inside button1_Click', 30_000);
  const activeCodeEditor = vscode.window.activeTextEditor;
  assert.ok(activeCodeEditor, 'S049 did not open the code editor');
  const handlerStart = defaultEventSourceAfter.indexOf('void button1_Click');
  const handlerEnd = defaultEventSourceAfter.indexOf('\r\n    }', handlerStart);
  const cursorOffset = defaultEventCodeDocument.offsetAt(activeCodeEditor.selection.active);
  assert.ok(handlerStart >= 0 && cursorOffset > handlerStart && cursorOffset <= handlerEnd,
    `S049 cursor did not navigate inside button1_Click: offset=${cursorOffset}, handler=${handlerStart}..${handlerEnd}`);

  await runDesignerHistoryCommand(testApi, defaultEventUri, 'undo');
  await waitFor(
    () => testApi.openDesignerState(defaultEventUri)?.designerText === defaultEventDesignerBefore
      && defaultEventCodeDocument.getText() === defaultEventSourceBefore,
    'one native S049 Undo did not restore both Designer.cs and code-behind',
  );
  assert.strictEqual(testApi.openDesignerState(defaultEventUri)?.dirty, false,
    'S049 Undo did not restore the generated-source baseline');
  await runDesignerHistoryCommand(testApi, defaultEventUri, 'redo');
  await waitFor(
    () => testApi.openDesignerState(defaultEventUri)?.designerText === defaultEventDesignerAfter
      && defaultEventCodeDocument.getText() === defaultEventSourceAfter,
    'one native S049 Redo did not reapply both Designer.cs and code-behind',
  );
  await testApi.saveOpenDesigner(defaultEventUri);
  assert.strictEqual(await defaultEventCodeDocument.save(), true, 'S049 code-behind did not save');
  assert.strictEqual(fs.readFileSync(defaultEventDesigner, 'utf8'), defaultEventDesignerAfter,
    'S049 Save did not persist the exact generated-source wiring');
  assert.strictEqual(fs.readFileSync(defaultEventSource, 'utf8'), defaultEventSourceAfter,
    'S049 Save did not persist the exact handler stub');

  // A normal code edit after a fresh composite Undo must invalidate the narrow Redo bridge. Use a second form so
  // this assertion covers that one conflict boundary rather than assuming a second Undo ordering after Undo→Redo.
  const conflictSource = path.join(lifecycleDir, 'S049DefaultEventConflictForm.cs');
  const conflictDesigner = path.join(lifecycleDir, 'S049DefaultEventConflictForm.Designer.cs');
  const conflictSourceBefore = defaultEventSourceBefore.replace(/S049DefaultEventForm/g, 'S049DefaultEventConflictForm');
  const conflictDesignerBefore = defaultEventDesignerBefore.replace(/S049DefaultEventForm/g, 'S049DefaultEventConflictForm');
  fs.writeFileSync(conflictSource, conflictSourceBefore, 'utf8');
  fs.writeFileSync(conflictDesigner, conflictDesignerBefore, 'utf8');
  const conflictUri = vscode.Uri.file(conflictSource);
  await vscode.commands.executeCommand('vscode.openWith', conflictUri, designerViewType);
  await waitFor(() => testApi.openDesignerState(conflictUri)?.renderReady === true,
    `S049 conflict form did not render: ${JSON.stringify(testApi.openDesignerState(conflictUri))}`, 60_000);
  await testApi.createOpenDesignerDefaultHandler(conflictUri, 'button1');
  const conflictCodeDocument = await vscode.workspace.openTextDocument(conflictUri);
  await waitFor(() => /void button1_Click\(object sender, System\.EventArgs e\)/.test(conflictCodeDocument.getText())
    && (testApi.openDesignerState(conflictUri)?.designerText ?? '').includes(clickWiring),
  'S049 conflict form did not create both event artifacts');
  const conflictSourceAfter = conflictCodeDocument.getText();
  const conflictDesignerAfter = testApi.openDesignerState(conflictUri)?.designerText ?? '';
  await runDesignerHistoryCommand(testApi, conflictUri, 'undo');
  await waitFor(() => conflictCodeDocument.getText() === conflictSourceBefore
    && testApi.openDesignerState(conflictUri)?.designerText === conflictDesignerBefore,
  'S049 conflict form Undo did not restore both artifacts');

  await vscode.commands.executeCommand('winformsDesigner.viewCode');
  await waitFor(() => path.normalize(vscode.window.activeTextEditor?.document.uri.fsPath ?? '')
    === path.normalize(conflictSource), 'S049 View Code did not focus the conflict code-behind editor');
  const independentEditor = vscode.window.activeTextEditor;
  assert.ok(independentEditor, 'S049 View Code did not expose an active code editor');
  const independentMarker = '// S049 independent code edit\r\n';
  assert.strictEqual(await independentEditor.edit((edit) => edit.insert(new vscode.Position(0, 0), independentMarker),
    { undoStopBefore: true, undoStopAfter: true }), true, 'S049 independent code edit was not applied');
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.ok(conflictCodeDocument.getText().startsWith(independentMarker),
    'S049 independent code edit did not remain in the buffer');
  assert.strictEqual(testApi.openDesignerState(conflictUri)?.designerText, conflictDesignerBefore,
    'S049 Redo bridge reapplied Designer wiring after an independent code edit');

  await vscode.commands.executeCommand('undo');
  await waitFor(() => conflictCodeDocument.getText() === conflictSourceBefore
    && testApi.openDesignerState(conflictUri)?.designerText === conflictDesignerBefore,
  'S049 independent edit Undo did not leave the cancelled composite transaction at its baseline');
  await testApi.createOpenDesignerDefaultHandler(conflictUri, 'button1');
  await waitFor(() => conflictCodeDocument.getText() === conflictSourceAfter
    && testApi.openDesignerState(conflictUri)?.designerText === conflictDesignerAfter,
  'S049 could not create the default handler again after cancelling the stale Redo bridge');
  await testApi.saveOpenDesigner(conflictUri);
  assert.strictEqual(await conflictCodeDocument.save(), true, 'S049 conflict recovery code-behind did not save');
  assert.strictEqual(fs.readFileSync(conflictDesigner, 'utf8'), conflictDesignerAfter,
    'S049 conflict recovery did not restore the exact generated-source wiring');
  assert.strictEqual(fs.readFileSync(conflictSource, 'utf8'), conflictSourceAfter,
    'S049 conflict recovery did not restore the exact handler stub');

  // V2-FND-001-S050 — the Events dropdown chooses the already-selected, signature-compatible Click handler through
  // the real CustomEditor setHandler ingress. The operation is a true no-op: no duplicate wiring, no duplicate method,
  // no dirty document and no disk write.
  const s050SourceHash = sha256File(conflictSource);
  const s050DesignerHash = sha256File(conflictDesigner);
  const s050CodeText = conflictCodeDocument.getText();
  const s050DesignerText = testApi.openDesignerState(conflictUri)?.designerText ?? '';
  await testApi.setOpenDesignerHandler(conflictUri, 'button1', 'Click', 'button1_Click');
  await waitFor(() => testApi.openDesignerState(conflictUri)?.designerText === s050DesignerText
    && conflictCodeDocument.getText() === s050CodeText,
  'S050 selecting the existing Click handler changed a product buffer');
  assert.strictEqual(testApi.openDesignerState(conflictUri)?.dirty, false,
    'S050 selecting the existing handler dirtied the Designer document');
  assert.strictEqual(conflictCodeDocument.isDirty, false,
    'S050 selecting the existing handler dirtied code-behind');
  assert.strictEqual((s050DesignerText.match(/\.Click \+=/g) ?? []).length, 1,
    'S050 did not retain exactly one Click subscription');
  assert.strictEqual((s050CodeText.match(/void button1_Click\(/g) ?? []).length, 1,
    'S050 did not retain exactly one handler method');
  assert.strictEqual(sha256File(conflictDesigner), s050DesignerHash,
    'S050 selecting the existing handler changed generated source on disk');
  assert.strictEqual(sha256File(conflictSource), s050SourceHash,
    'S050 selecting the existing handler changed code-behind on disk');

  // V2-FND-001-S033 — a real modern CustomEditor exposes exact live TableLayoutPanel row/column widths, then the
  // same canvas-release route used by designer.js moves button1 from cell 0,0 to 1,1 as one source/history transaction.
  const tableDragSource = path.join(lifecycleDir, 'S033TableDragForm.cs');
  const tableDragDesigner = path.join(lifecycleDir, 'S033TableDragForm.Designer.cs');
  fs.writeFileSync(tableDragSource, [
    'using System.Windows.Forms;',
    'namespace DemoApp;',
    'public partial class S033TableDragForm : Form',
    '{',
    '    public S033TableDragForm() => InitializeComponent();',
    '}',
    '',
  ].join('\r\n'), 'utf8');
  fs.writeFileSync(tableDragDesigner, [
    'namespace DemoApp;',
    'partial class S033TableDragForm',
    '{',
    '    private System.Windows.Forms.TableLayoutPanel tableLayoutPanel1;',
    '    private System.Windows.Forms.Button button1;',
    '    private void InitializeComponent()',
    '    {',
    '        this.tableLayoutPanel1 = new System.Windows.Forms.TableLayoutPanel();',
    '        this.button1 = new System.Windows.Forms.Button();',
    '        this.tableLayoutPanel1.ColumnCount = 2;',
    '        this.tableLayoutPanel1.RowCount = 2;',
    '        this.tableLayoutPanel1.Location = new System.Drawing.Point(12, 12);',
    '        this.tableLayoutPanel1.Name = "tableLayoutPanel1";',
    '        this.tableLayoutPanel1.Size = new System.Drawing.Size(240, 120);',
    '        this.tableLayoutPanel1.Controls.Add(this.button1, 0, 0);',
    '        this.button1.Name = "button1";',
    '        this.button1.Size = new System.Drawing.Size(80, 24);',
    '        this.button1.Text = "Move me";',
    '        this.Controls.Add(this.tableLayoutPanel1);',
    '        this.ClientSize = new System.Drawing.Size(280, 160);',
    '        this.Name = "S033TableDragForm";',
    '    }',
    '}',
    '',
  ].join('\r\n'), 'utf8');
  const tableDragBefore = fs.readFileSync(tableDragDesigner, 'utf8');
  const tableDragSourceHash = sha256File(tableDragSource);
  const tableDragDesignerHash = sha256File(tableDragDesigner);
  const tableDragUri = vscode.Uri.file(tableDragSource);
  await vscode.commands.executeCommand('vscode.openWith', tableDragUri, designerViewType);
  await waitFor(() => testApi.openDesignerState(tableDragUri)?.renderReady === true,
    `S033 TableLayoutPanel form did not render: ${JSON.stringify(testApi.openDesignerState(tableDragUri))}`, 60_000);
  const tableBeforeState = testApi.openDesignerState(tableDragUri)!;
  assert.strictEqual(tableBeforeState.engineKind, 'modern');
  const tableBeforeLayout = testApi.openDesignerLayout(tableDragUri);
  const tableLayout = tableBeforeLayout.find((control) => control.id === 'tableLayoutPanel1');
  const tableButtonBefore = tableBeforeLayout.find((control) => control.id === 'button1');
  assert.ok(tableLayout && tableButtonBefore, 'S033 live layout did not publish the table and child');
  assert.strictEqual(tableLayout.tableColumnWidths?.length, 2, 'S033 table did not publish two live column widths');
  assert.strictEqual(tableLayout.tableRowHeights?.length, 2, 'S033 table did not publish two live row heights');
  const tableDropX = (tableLayout.clientX ?? tableLayout.x)
    + tableLayout.tableColumnWidths![0] + tableLayout.tableColumnWidths![1] / 2;
  const tableDropY = (tableLayout.clientY ?? tableLayout.y)
    + tableLayout.tableRowHeights![0] + tableLayout.tableRowHeights![1] / 2;
  assert.strictEqual(await testApi.moveOpenDesignerLayoutChild(tableDragUri, 'button1', tableDropX, tableDropY), true,
    'S033 product canvas drop did not commit cell 1,1');
  const tableDragAfter = testApi.openDesignerState(tableDragUri)?.designerText ?? '';
  assert.match(tableDragAfter, /Controls\.Add\(this\.button1, 1, 1\);/,
    'S033 source did not contain the exact target cell');
  assert.doesNotMatch(tableDragAfter, /this\.button1\.Location\s*=/,
    'S033 layout drag must not synthesize a free Location assignment');
  const tableButtonAfter = testApi.openDesignerLayout(tableDragUri).find((control) => control.id === 'button1');
  assert.ok(tableButtonAfter && tableButtonAfter.x > tableButtonBefore.x && tableButtonAfter.y > tableButtonBefore.y,
    `S033 rendered button did not move to the lower-right cell: before=${JSON.stringify(tableButtonBefore)} after=${JSON.stringify(tableButtonAfter)}`);
  assert.strictEqual(testApi.openDesignerState(tableDragUri)?.dirty, true, 'S033 cell move did not dirty the document');
  assert.strictEqual(sha256File(tableDragSource), tableDragSourceHash, 'S033 unsaved drag changed code-behind disk');
  assert.strictEqual(sha256File(tableDragDesigner), tableDragDesignerHash, 'S033 unsaved drag changed Designer disk');
  await runDesignerHistoryCommand(testApi, tableDragUri, 'undo');
  await waitFor(() => testApi.openDesignerState(tableDragUri)?.designerText === tableDragBefore,
    'S033 one native Undo did not restore cell 0,0');
  assert.strictEqual(testApi.openDesignerState(tableDragUri)?.dirty, false);
  await runDesignerHistoryCommand(testApi, tableDragUri, 'redo');
  await waitFor(() => testApi.openDesignerState(tableDragUri)?.designerText === tableDragAfter,
    'S033 one native Redo did not restore cell 1,1');
  await runDesignerHistoryCommand(testApi, tableDragUri, 'undo');
  await waitFor(() => testApi.openDesignerState(tableDragUri)?.dirty === false, 'S033 final Undo stayed dirty');
  assert.strictEqual(sha256File(tableDragSource), tableDragSourceHash, 'S033 history changed code-behind disk');
  assert.strictEqual(sha256File(tableDragDesigner), tableDragDesignerHash, 'S033 history changed Designer disk');

  // V2-FND-001-S041 — selecting button1 publishes the exact real-engine TypeConverter standard values consumed by
  // the Properties panel. Opening this VS-style closed dropdown is inspection-only and must preserve S033's Redo.
  const s041SourceBefore = fs.readFileSync(tableDragSource, 'utf8');
  const s041DesignerBefore = testApi.openDesignerState(tableDragUri)?.designerText ?? '';
  const s041SourceHash = sha256File(tableDragSource);
  const s041DesignerHash = sha256File(tableDragDesigner);
  await testApi.selectOpenDesignerControl(tableDragUri, 'button1');
  await waitFor(() => testApi.openDesignerProperties(tableDragUri)?.id === 'button1',
    `S041 button metadata was not published: ${JSON.stringify(testApi.openDesignerProperties(tableDragUri))}`);
  const s041Component = testApi.openDesignerProperties(tableDragUri)!;
  // V2-FND-001-S040 — the keyboard-search UI receives this exact live property set. The shipped webview test types
  // `flatstyle` (the shorter `flat` also correctly matches FlatAppearance), leaves only FlatStyle, and moves focus from
  // search to its editor without posting a mutation.
  assert.deepStrictEqual(
    s041Component.properties.filter((property) => property.name.toLowerCase().includes('flatstyle'))
      .map((property) => property.name),
    ['FlatStyle'],
    'S040 live Button property metadata did not produce the exact filtered row set',
  );
  assert.strictEqual(testApi.openDesignerState(tableDragUri)?.dirty, false,
    'S040 reading/filtering the live Properties model dirtied the Designer document');
  assert.strictEqual(sha256File(tableDragSource), s041SourceHash, 'S040 property search changed code-behind disk');
  assert.strictEqual(sha256File(tableDragDesigner), s041DesignerHash, 'S040 property search changed Designer disk');
  const flatStyle = s041Component.properties.find((property) => property.name === 'FlatStyle');
  assert.ok(flatStyle, 'S041 live Button metadata omitted FlatStyle');
  assert.deepStrictEqual({
    type: flatStyle.type,
    value: flatStyle.value,
    readOnly: flatStyle.readOnly,
    isEnum: flatStyle.isEnum,
    category: flatStyle.category,
    standardValues: flatStyle.standardValues,
    standardValuesExclusive: flatStyle.standardValuesExclusive,
  }, {
    type: 'System.Windows.Forms.FlatStyle',
    value: 'Standard',
    readOnly: false,
    isEnum: true,
    category: 'Appearance',
    standardValues: ['Flat', 'Popup', 'Standard', 'System'],
    standardValuesExclusive: true,
  }, 'S041 FlatStyle closed-list metadata did not match the exact VS-compatible order and display text');
  assert.strictEqual(testApi.openDesignerState(tableDragUri)?.designerText, s041DesignerBefore,
    'S041 opening the standard-values dropdown changed generated source');
  assert.strictEqual(testApi.openDesignerState(tableDragUri)?.dirty, false,
    'S041 opening the standard-values dropdown dirtied the Designer document');
  assert.strictEqual(fs.readFileSync(tableDragSource, 'utf8'), s041SourceBefore,
    'S041 opening the standard-values dropdown changed code-behind');
  assert.strictEqual(sha256File(tableDragSource), s041SourceHash,
    'S041 opening the standard-values dropdown changed code-behind on disk');
  assert.strictEqual(sha256File(tableDragDesigner), s041DesignerHash,
    'S041 opening the standard-values dropdown changed Designer source on disk');
  await runDesignerHistoryCommand(testApi, tableDragUri, 'redo');
  await waitFor(() => testApi.openDesignerState(tableDragUri)?.designerText === tableDragAfter,
    'S041 metadata inspection consumed or invalidated the existing S033 Redo unit');
  await runDesignerHistoryCommand(testApi, tableDragUri, 'undo');
  await waitFor(() => testApi.openDesignerState(tableDragUri)?.designerText === s041DesignerBefore
    && testApi.openDesignerState(tableDragUri)?.dirty === false,
  'S041 history probe did not restore the exact clean Designer baseline');
  assert.strictEqual(sha256File(tableDragSource), s041SourceHash, 'S041 history probe changed code-behind disk');
  assert.strictEqual(sha256File(tableDragDesigner), s041DesignerHash, 'S041 history probe changed Designer disk');

  // V2-FND-001-S034 — the same single drag intent reorders a real FlowLayoutPanel by Controls.Add order. The host
  // plans the complete C,A,B permutation locally and commits once; no meaningless child Location edit is emitted.
  const flowDragSource = path.join(lifecycleDir, 'S034FlowDragForm.cs');
  const flowDragDesigner = path.join(lifecycleDir, 'S034FlowDragForm.Designer.cs');
  fs.writeFileSync(flowDragSource, [
    'using System.Windows.Forms;',
    'namespace DemoApp;',
    'public partial class S034FlowDragForm : Form',
    '{',
    '    public S034FlowDragForm() => InitializeComponent();',
    '}',
    '',
  ].join('\r\n'), 'utf8');
  fs.writeFileSync(flowDragDesigner, [
    'namespace DemoApp;',
    'partial class S034FlowDragForm',
    '{',
    '    private System.Windows.Forms.FlowLayoutPanel flowLayoutPanel1;',
    '    private System.Windows.Forms.Button buttonA;',
    '    private System.Windows.Forms.Button buttonB;',
    '    private System.Windows.Forms.Button buttonC;',
    '    private void InitializeComponent()',
    '    {',
    '        this.flowLayoutPanel1 = new System.Windows.Forms.FlowLayoutPanel();',
    '        this.buttonA = new System.Windows.Forms.Button();',
    '        this.buttonB = new System.Windows.Forms.Button();',
    '        this.buttonC = new System.Windows.Forms.Button();',
    '        this.flowLayoutPanel1.FlowDirection = System.Windows.Forms.FlowDirection.LeftToRight;',
    '        this.flowLayoutPanel1.WrapContents = false;',
    '        this.flowLayoutPanel1.Location = new System.Drawing.Point(12, 12);',
    '        this.flowLayoutPanel1.Name = "flowLayoutPanel1";',
    '        this.flowLayoutPanel1.Size = new System.Drawing.Size(280, 60);',
    '        this.flowLayoutPanel1.Controls.Add(this.buttonA);',
    '        this.flowLayoutPanel1.Controls.Add(this.buttonB);',
    '        this.flowLayoutPanel1.Controls.Add(this.buttonC);',
    '        this.buttonA.Name = "buttonA";',
    '        this.buttonA.Size = new System.Drawing.Size(60, 24);',
    '        this.buttonA.Text = "A";',
    '        this.buttonB.Name = "buttonB";',
    '        this.buttonB.Size = new System.Drawing.Size(60, 24);',
    '        this.buttonB.Text = "B";',
    '        this.buttonC.Name = "buttonC";',
    '        this.buttonC.Size = new System.Drawing.Size(60, 24);',
    '        this.buttonC.Text = "C";',
    '        this.Controls.Add(this.flowLayoutPanel1);',
    '        this.ClientSize = new System.Drawing.Size(310, 100);',
    '        this.Name = "S034FlowDragForm";',
    '    }',
    '}',
    '',
  ].join('\r\n'), 'utf8');
  const flowDragBefore = fs.readFileSync(flowDragDesigner, 'utf8');
  const flowDragSourceHash = sha256File(flowDragSource);
  const flowDragDesignerHash = sha256File(flowDragDesigner);
  const flowDragUri = vscode.Uri.file(flowDragSource);
  await vscode.commands.executeCommand('vscode.openWith', flowDragUri, designerViewType);
  await waitFor(() => testApi.openDesignerState(flowDragUri)?.renderReady === true,
    `S034 FlowLayoutPanel form did not render: ${JSON.stringify(testApi.openDesignerState(flowDragUri))}`, 60_000);
  const flowBeforeState = testApi.openDesignerState(flowDragUri)!;
  assert.strictEqual(flowBeforeState.engineKind, 'modern');
  const flowBeforeLayout = testApi.openDesignerLayout(flowDragUri);
  const flowLayout = flowBeforeLayout.find((control) => control.id === 'flowLayoutPanel1');
  const flowA = flowBeforeLayout.find((control) => control.id === 'buttonA');
  const flowC = flowBeforeLayout.find((control) => control.id === 'buttonC');
  assert.ok(flowLayout && flowA && flowC, 'S034 live layout did not publish the flow container and children');
  assert.strictEqual(flowLayout.flowDirection, 'LeftToRight', 'S034 live flow direction was not published');
  assert.ok(flowA.x < flowC.x, 'S034 baseline did not render A before C');
  assert.strictEqual(await testApi.moveOpenDesignerLayoutChild(
    flowDragUri, 'buttonC', flowA.x, flowA.y + flowA.height / 2,
  ), true, 'S034 product canvas drop did not reorder C before A');
  const flowDragAfter = testApi.openDesignerState(flowDragUri)?.designerText ?? '';
  const addC = flowDragAfter.indexOf('this.flowLayoutPanel1.Controls.Add(this.buttonC);');
  const addA = flowDragAfter.indexOf('this.flowLayoutPanel1.Controls.Add(this.buttonA);');
  const addB = flowDragAfter.indexOf('this.flowLayoutPanel1.Controls.Add(this.buttonB);');
  assert.ok(addC >= 0 && addC < addA && addA < addB, 'S034 source order is not C,A,B');
  assert.doesNotMatch(flowDragAfter, /this\.button[ABC]\.Location\s*=/,
    'S034 flow reorder must not synthesize coordinate assignments');
  const flowAfterLayout = testApi.openDesignerLayout(flowDragUri);
  const flowCAfter = flowAfterLayout.find((control) => control.id === 'buttonC');
  const flowAAfter = flowAfterLayout.find((control) => control.id === 'buttonA');
  assert.ok(flowCAfter && flowAAfter && flowCAfter.x < flowAAfter.x,
    `S034 rendered flow did not put C before A: ${JSON.stringify(flowAfterLayout)}`);
  assert.strictEqual(testApi.openDesignerState(flowDragUri)?.dirty, true, 'S034 flow reorder did not dirty the document');
  assert.strictEqual(sha256File(flowDragSource), flowDragSourceHash, 'S034 unsaved drag changed code-behind disk');
  assert.strictEqual(sha256File(flowDragDesigner), flowDragDesignerHash, 'S034 unsaved drag changed Designer disk');
  await runDesignerHistoryCommand(testApi, flowDragUri, 'undo');
  await waitFor(() => testApi.openDesignerState(flowDragUri)?.designerText === flowDragBefore,
    'S034 one native Undo did not restore A,B,C');
  assert.strictEqual(testApi.openDesignerState(flowDragUri)?.dirty, false);
  await runDesignerHistoryCommand(testApi, flowDragUri, 'redo');
  await waitFor(() => testApi.openDesignerState(flowDragUri)?.designerText === flowDragAfter,
    'S034 one native Redo did not restore C,A,B');
  await runDesignerHistoryCommand(testApi, flowDragUri, 'undo');
  await waitFor(() => testApi.openDesignerState(flowDragUri)?.dirty === false, 'S034 final Undo stayed dirty');
  assert.strictEqual(sha256File(flowDragSource), flowDragSourceHash, 'S034 history changed code-behind disk');
  assert.strictEqual(sha256File(flowDragDesigner), flowDragDesignerHash, 'S034 history changed Designer disk');

  // V2-FND-001-S083 — use a real compiled-net48 CustomEditor and the exact Properties DataBindings read/OK seams.
  // Binding Text to Customer.Name is one minimal generated-source edit, one native history unit, and no pre-save disk IO.
  const bindingSource = path.join(net48FixtureRoot, 'S083BindingForm.cs');
  const bindingDesigner = path.join(net48FixtureRoot, 'S083BindingForm.Designer.cs');
  assert.ok(fs.existsSync(bindingSource) && fs.existsSync(bindingDesigner), 'S083 net48 binding fixture is missing');
  const bindingBefore = fs.readFileSync(bindingDesigner, 'utf8');
  const bindingSourceHash = sha256File(bindingSource);
  const bindingDesignerHash = sha256File(bindingDesigner);
  const bindingUri = vscode.Uri.file(bindingSource);
  await vscode.commands.executeCommand('vscode.openWith', bindingUri, designerViewType);
  await waitFor(() => testApi.openDesignerState(bindingUri)?.renderReady === true,
    `S083 net48 binding form did not render: ${JSON.stringify(testApi.openDesignerState(bindingUri))}`, 60_000);
  assert.strictEqual(testApi.openDesignerState(bindingUri)?.engineKind, 'net48');
  const bindingListBefore = await testApi.listOpenDesignerBindings(bindingUri, 'nameTextBox');
  assert.deepStrictEqual(bindingListBefore, {
    ok: true,
    bindings: [],
    sources: [{ id: 'customerBindingSource', typeName: 'System.Windows.Forms.BindingSource' }],
    reason: '',
  }, 'S083 Properties DataBindings read did not expose the exact live BindingSource baseline');
  const requestedBinding: BindingItem = {
    propertyName: 'Text',
    dataSourceId: 'customerBindingSource',
    dataMember: 'Name',
    formattingEnabled: true,
    updateMode: 'OnValidation',
    formatString: '',
  };
  assert.strictEqual(await testApi.setOpenDesignerBindings(bindingUri, 'nameTextBox', [requestedBinding]), true,
    'S083 Properties DataBindings OK did not commit');
  const bindingAfter = testApi.openDesignerState(bindingUri)?.designerText ?? '';
  const bindingStatement = 'this.nameTextBox.DataBindings.Add(new System.Windows.Forms.Binding("Text", '
    + 'this.customerBindingSource, "Name", true));';
  assert.strictEqual((bindingAfter.match(/this\.nameTextBox\.DataBindings\.Add\(/g) ?? []).length, 1,
    'S083 did not generate exactly one nameTextBox binding');
  assert.ok(bindingAfter.includes(bindingStatement), 'S083 generated binding statement is not canonical');
  const bindingListAfter = await testApi.listOpenDesignerBindings(bindingUri, 'nameTextBox');
  assert.deepStrictEqual(bindingListAfter.bindings, [requestedBinding], 'S083 product readback did not match the edit');
  assert.strictEqual(testApi.openDesignerState(bindingUri)?.dirty, true, 'S083 binding edit did not dirty the document');
  assert.strictEqual(sha256File(bindingSource), bindingSourceHash, 'S083 unsaved edit changed code-behind disk');
  assert.strictEqual(sha256File(bindingDesigner), bindingDesignerHash, 'S083 unsaved edit changed Designer disk');
  await runDesignerHistoryCommand(testApi, bindingUri, 'undo');
  await waitFor(() => testApi.openDesignerState(bindingUri)?.designerText === bindingBefore
    && testApi.openDesignerState(bindingUri)?.dirty === false,
  'S083 one native Undo did not restore the exact clean binding baseline');
  await runDesignerHistoryCommand(testApi, bindingUri, 'redo');
  await waitFor(() => testApi.openDesignerState(bindingUri)?.designerText === bindingAfter,
    'S083 one native Redo did not restore the canonical binding');
  await runDesignerHistoryCommand(testApi, bindingUri, 'undo');
  await waitFor(() => testApi.openDesignerState(bindingUri)?.designerText === bindingBefore
    && testApi.openDesignerState(bindingUri)?.dirty === false,
  'S083 final Undo did not restore the exact clean binding baseline');
  assert.strictEqual(sha256File(bindingSource), bindingSourceHash, 'S083 history changed code-behind disk');
  assert.strictEqual(sha256File(bindingDesigner), bindingDesignerHash, 'S083 history changed Designer disk');

  // V2-FND-001-S073 — open a real modern CustomEditor and drive the exact Properties Project… image-resource path.
  // The product must reference the existing strongly typed resource, never copy its bytes into a form resx or rewrite
  // either project-resource authority file, and must own the source-only assignment as one native history unit.
  const projectImageSource = path.join(workspaceRoot, 'ProjectImageForm.cs');
  const projectImageDesigner = path.join(workspaceRoot, 'ProjectImageForm.Designer.cs');
  const projectResourcesResx = path.join(workspaceRoot, 'Properties', 'Resources.resx');
  const projectResourcesDesigner = path.join(workspaceRoot, 'Properties', 'Resources.Designer.cs');
  const formImageResx = path.join(workspaceRoot, 'ProjectImageForm.resx');
  for (const required of [projectImageSource, projectImageDesigner, projectResourcesResx, projectResourcesDesigner]) {
    assert.ok(fs.existsSync(required), `S073 project-resource fixture is missing: ${required}`);
  }
  assert.strictEqual(fs.existsSync(formImageResx), false, 'S073 fixture unexpectedly starts with a form resx');
  const projectImageBefore = fs.readFileSync(projectImageDesigner, 'utf8');
  const projectImageSourceHash = sha256File(projectImageSource);
  const projectImageDesignerHash = sha256File(projectImageDesigner);
  const projectResourcesResxHash = sha256File(projectResourcesResx);
  const projectResourcesDesignerHash = sha256File(projectResourcesDesigner);
  const projectImageUri = vscode.Uri.file(projectImageSource);
  await vscode.commands.executeCommand('vscode.openWith', projectImageUri, designerViewType);
  await waitFor(() => testApi.openDesignerState(projectImageUri)?.renderReady === true,
    `S073 modern project-image form did not render: ${JSON.stringify(testApi.openDesignerState(projectImageUri))}`,
    60_000);
  assert.strictEqual(testApi.openDesignerState(projectImageUri)?.engineKind, 'modern');
  await testApi.selectOpenDesignerControl(projectImageUri, 'imageButton');
  await waitFor(() => testApi.openDesignerProperties(projectImageUri)?.id === 'imageButton',
    'S073 imageButton metadata was not published to Properties');
  assert.strictEqual(await testApi.setOpenDesignerProjectImageResource(
    projectImageUri, 'imageButton', 'Image', 'DemoApp.Properties.Resources.Logo'), true,
  'S073 Properties Project resource selection did not commit');
  const projectImageAfter = testApi.openDesignerState(projectImageUri)?.designerText ?? '';
  const projectImageStatement = 'this.imageButton.Image = global::DemoApp.Properties.Resources.Logo;';
  assert.strictEqual((projectImageAfter.match(/this\.imageButton\.Image\s*=/g) ?? []).length, 1,
    'S073 did not generate exactly one imageButton.Image assignment');
  assert.ok(projectImageAfter.includes(projectImageStatement), 'S073 strongly typed resource assignment is not canonical');
  assert.ok(!projectImageAfter.includes('resources.GetObject') && !projectImageAfter.includes('iVBORw0KGgo'),
    'S073 copied the project image into form-local resource syntax');
  assert.strictEqual(testApi.openDesignerState(projectImageUri)?.dirty, true, 'S073 assignment did not dirty the Designer');
  assert.strictEqual(fs.existsSync(formImageResx), false, 'S073 created a form resx instead of referencing the project resource');
  assert.strictEqual(sha256File(projectImageSource), projectImageSourceHash, 'S073 changed code-behind disk');
  assert.strictEqual(sha256File(projectImageDesigner), projectImageDesignerHash, 'S073 changed Designer disk before Save');
  assert.strictEqual(sha256File(projectResourcesResx), projectResourcesResxHash, 'S073 rewrote project Resources.resx');
  assert.strictEqual(sha256File(projectResourcesDesigner), projectResourcesDesignerHash,
    'S073 rewrote project Resources.Designer.cs');
  await runDesignerHistoryCommand(testApi, projectImageUri, 'undo');
  await waitFor(() => testApi.openDesignerState(projectImageUri)?.designerText === projectImageBefore
    && testApi.openDesignerState(projectImageUri)?.dirty === false,
  'S073 one native Undo did not restore the exact clean source baseline');
  await runDesignerHistoryCommand(testApi, projectImageUri, 'redo');
  await waitFor(() => testApi.openDesignerState(projectImageUri)?.designerText === projectImageAfter,
    'S073 one native Redo did not restore the strongly typed resource assignment');
  await runDesignerHistoryCommand(testApi, projectImageUri, 'undo');
  await waitFor(() => testApi.openDesignerState(projectImageUri)?.designerText === projectImageBefore
    && testApi.openDesignerState(projectImageUri)?.dirty === false,
  'S073 final Undo did not restore the clean baseline');
  assert.strictEqual(sha256File(projectResourcesResx), projectResourcesResxHash, 'S073 history changed project Resources.resx');
  assert.strictEqual(sha256File(projectResourcesDesigner), projectResourcesDesignerHash,
    'S073 history changed project Resources.Designer.cs');

  // V2-FND-001-S077 / V2-FND-001-S078 — the real modern CustomEditor mirrors Visual Studio's Language-scoped resource editing:
  // Default writes only the neutral layer, fr-FR writes only its overlay, and each resource-only commit is one native
  // history unit. Generated source stays the ApplyResources authority and is never rewritten for either scalar edit.
  const localizedPropertySource = path.join(workspaceRoot, 'S077LocalizedForm.cs');
  const localizedPropertyDesigner = path.join(workspaceRoot, 'S077LocalizedForm.Designer.cs');
  const localizedPropertyNeutral = path.join(workspaceRoot, 'S077LocalizedForm.resx');
  const localizedPropertyFrench = path.join(workspaceRoot, 'S077LocalizedForm.fr-FR.resx');
  for (const required of [localizedPropertySource, localizedPropertyDesigner,
    localizedPropertyNeutral, localizedPropertyFrench]) {
    assert.ok(fs.existsSync(required), `S077/S078 localizable fixture is missing: ${required}`);
  }
  const localizedPropertyDesignerBefore = fs.readFileSync(localizedPropertyDesigner, 'utf8');
  const localizedPropertyNeutralBefore = fs.readFileSync(localizedPropertyNeutral, 'utf8');
  const localizedPropertyFrenchBefore = fs.readFileSync(localizedPropertyFrench, 'utf8');
  const localizedPropertyNeutralAfter = localizedPropertyNeutralBefore.replace(
    '<value>Neutral caption</value>', '<value>Neutral updated</value>');
  const localizedPropertyFrenchAfter = localizedPropertyFrenchBefore.replace(
    '<value>Légende française</value>', '<value>Légende mise à jour</value>');
  assert.notStrictEqual(localizedPropertyNeutralAfter, localizedPropertyNeutralBefore,
    'S077 neutral fixture does not contain its exact edit target');
  assert.notStrictEqual(localizedPropertyFrenchAfter, localizedPropertyFrenchBefore,
    'S078 culture fixture does not contain its exact edit target');
  const localizedPropertySourceHash = sha256File(localizedPropertySource);
  const localizedPropertyDesignerHash = sha256File(localizedPropertyDesigner);
  const localizedPropertyUri = vscode.Uri.file(localizedPropertySource);
  await vscode.commands.executeCommand('vscode.openWith', localizedPropertyUri, designerViewType);
  await waitFor(() => testApi.openDesignerState(localizedPropertyUri)?.renderReady === true,
    `S077/S078 modern localizable form did not render: ${JSON.stringify(testApi.openDesignerState(localizedPropertyUri))}`,
    60_000);
  assert.strictEqual(testApi.openDesignerState(localizedPropertyUri)?.engineKind, 'modern');
  await testApi.selectOpenDesignerControl(localizedPropertyUri, 'label1');
  await waitFor(() => testApi.openDesignerProperties(localizedPropertyUri)?.id === 'label1'
    && testApi.openDesignerProperties(localizedPropertyUri)?.properties.some((property) =>
      property.name === 'Text' && property.value === 'Neutral caption') === true,
  'S077 neutral label metadata was not published to Properties');

  await testApi.editOpenDesignerProperty(localizedPropertyUri, 'label1', 'Text', 'System.String', false, 'Neutral updated');
  await waitFor(() => fs.readFileSync(localizedPropertyNeutral, 'utf8') === localizedPropertyNeutralAfter
    && activeCustomTab(localizedPropertyUri)?.isDirty === true,
  `S077 neutral Text edit did not commit as the exact resource-only native history unit; state=${JSON.stringify(
    testApi.openDesignerState(localizedPropertyUri))}; actual=${JSON.stringify(fs.readFileSync(localizedPropertyNeutral, 'utf8'))}; expected=${JSON.stringify(localizedPropertyNeutralAfter)}`);
  assert.strictEqual(testApi.openDesignerState(localizedPropertyUri)?.dirty, false,
    'S077 resource-only edit dirtied generated source');
  assert.strictEqual(fs.readFileSync(localizedPropertyFrench, 'utf8'), localizedPropertyFrenchBefore,
    'S077 neutral edit changed the fr-FR overlay');
  assert.strictEqual(testApi.openDesignerState(localizedPropertyUri)?.designerText, localizedPropertyDesignerBefore,
    'S077 neutral edit changed generated source instead of the neutral resource');
  assert.strictEqual(sha256File(localizedPropertySource), localizedPropertySourceHash, 'S077 changed code-behind disk');
  assert.strictEqual(sha256File(localizedPropertyDesigner), localizedPropertyDesignerHash, 'S077 changed Designer disk');
  await runDesignerHistoryCommand(testApi, localizedPropertyUri, 'undo');
  await waitFor(() => fs.readFileSync(localizedPropertyNeutral, 'utf8') === localizedPropertyNeutralBefore
    && activeCustomTab(localizedPropertyUri)?.isDirty === false,
  'S077 native Undo did not restore the exact neutral resource baseline');
  await runDesignerHistoryCommand(testApi, localizedPropertyUri, 'redo');
  await waitFor(() => fs.readFileSync(localizedPropertyNeutral, 'utf8') === localizedPropertyNeutralAfter
    && activeCustomTab(localizedPropertyUri)?.isDirty === true,
  'S077 native Redo did not reapply the exact neutral resource edit');
  await runDesignerHistoryCommand(testApi, localizedPropertyUri, 'undo');
  await waitFor(() => fs.readFileSync(localizedPropertyNeutral, 'utf8') === localizedPropertyNeutralBefore
    && activeCustomTab(localizedPropertyUri)?.isDirty === false,
  'S077 final Undo did not restore the exact clean neutral baseline');

  assert.strictEqual(await testApi.setOpenDesignerLocalizationCulture(localizedPropertyUri, 'fr-FR'), true,
    'S078 product Language selection did not accept the discovered fr-FR resource');
  assert.strictEqual(fs.readFileSync(localizedPropertyNeutral, 'utf8'), localizedPropertyNeutralBefore,
    'S078 Language selection changed the neutral resource');
  assert.strictEqual(fs.readFileSync(localizedPropertyFrench, 'utf8'), localizedPropertyFrenchBefore,
    'S078 Language selection wrote the culture resource before an edit');
  assert.strictEqual(testApi.openDesignerState(localizedPropertyUri)?.dirty, false,
    'S078 Language selection created a history or dirty-state mutation');
  await waitFor(() => testApi.openDesignerProperties(localizedPropertyUri)?.id === 'label1'
    && testApi.openDesignerProperties(localizedPropertyUri)?.properties.some((property) =>
      property.name === 'Text' && property.value === 'Légende française') === true,
  'S078 fr-FR fallback chain was not published to Properties');
  await testApi.editOpenDesignerProperty(localizedPropertyUri, 'label1', 'Text', 'System.String', false, 'Légende mise à jour');
  await waitFor(() => fs.readFileSync(localizedPropertyFrench, 'utf8') === localizedPropertyFrenchAfter
    && activeCustomTab(localizedPropertyUri)?.isDirty === true,
  `S078 culture Text edit did not commit as the exact resource-only native history unit; state=${JSON.stringify(
    testApi.openDesignerState(localizedPropertyUri))}; actual=${JSON.stringify(fs.readFileSync(localizedPropertyFrench, 'utf8'))}; expected=${JSON.stringify(localizedPropertyFrenchAfter)}`);
  assert.strictEqual(testApi.openDesignerState(localizedPropertyUri)?.dirty, false,
    'S078 resource-only edit dirtied generated source');
  assert.strictEqual(fs.readFileSync(localizedPropertyNeutral, 'utf8'), localizedPropertyNeutralBefore,
    'S078 culture edit changed the neutral fallback');
  assert.strictEqual(testApi.openDesignerState(localizedPropertyUri)?.designerText, localizedPropertyDesignerBefore,
    'S078 culture edit changed generated source instead of the fr-FR resource');
  assert.strictEqual(sha256File(localizedPropertySource), localizedPropertySourceHash, 'S078 changed code-behind disk');
  assert.strictEqual(sha256File(localizedPropertyDesigner), localizedPropertyDesignerHash, 'S078 changed Designer disk');
  await runDesignerHistoryCommand(testApi, localizedPropertyUri, 'undo');
  await waitFor(() => fs.readFileSync(localizedPropertyFrench, 'utf8') === localizedPropertyFrenchBefore
    && activeCustomTab(localizedPropertyUri)?.isDirty === false,
  'S078 native Undo did not restore the exact culture resource baseline');
  await runDesignerHistoryCommand(testApi, localizedPropertyUri, 'redo');
  await waitFor(() => fs.readFileSync(localizedPropertyFrench, 'utf8') === localizedPropertyFrenchAfter
    && activeCustomTab(localizedPropertyUri)?.isDirty === true,
  'S078 native Redo did not reapply the exact culture resource edit');
  await runDesignerHistoryCommand(testApi, localizedPropertyUri, 'undo');
  await waitFor(() => fs.readFileSync(localizedPropertyFrench, 'utf8') === localizedPropertyFrenchBefore
    && activeCustomTab(localizedPropertyUri)?.isDirty === false,
  'S078 final Undo did not restore the exact clean culture baseline');
  assert.strictEqual(fs.readFileSync(localizedPropertyNeutral, 'utf8'), localizedPropertyNeutralBefore,
    'S077/S078 history changed the neutral layer after final Undo');
  assert.strictEqual(sha256File(localizedPropertySource), localizedPropertySourceHash,
    'S077/S078 history changed code-behind disk');
  assert.strictEqual(sha256File(localizedPropertyDesigner), localizedPropertyDesignerHash,
    'S077/S078 history changed Designer disk');
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');

  // V2-FND-001-S080 — after the product captures the exact fr-FR baseline, an external writer wins before the first
  // resource write. The transaction must refuse without overwriting that edit or registering a native history unit.
  const localizedPropertyFrenchExternal = localizedPropertyFrenchBefore.replace(
    '<value>Légende française</value>', '<value>Légende externe</value>');
  assert.notStrictEqual(localizedPropertyFrenchExternal, localizedPropertyFrenchBefore,
    'S080 culture fixture does not contain its exact external-edit target');
  try {
    await vscode.commands.executeCommand('vscode.openWith', localizedPropertyUri, designerViewType);
    await waitFor(() => testApi.openDesignerState(localizedPropertyUri)?.renderReady === true,
      `S080 modern localizable form did not render: ${JSON.stringify(testApi.openDesignerState(localizedPropertyUri))}`,
      60_000);
    await testApi.selectOpenDesignerControl(localizedPropertyUri, 'label1');
    assert.strictEqual(await testApi.setOpenDesignerLocalizationCulture(localizedPropertyUri, 'fr-FR'), true,
      'S080 product Language selection did not accept the discovered fr-FR resource');
    await waitFor(() => testApi.openDesignerProperties(localizedPropertyUri)?.properties.some((property) =>
      property.name === 'Text' && property.value === 'Légende française') === true,
    'S080 fr-FR baseline was not published to Properties');

    const staleInterleaveObserved = await testApi.editOpenDesignerPropertyWithResourceInterleave(
      localizedPropertyUri, 'label1', 'Text', 'System.String', false, 'Légende refusée', async () => {
        fs.writeFileSync(localizedPropertyFrench, localizedPropertyFrenchExternal, 'utf8');
      });
    assert.strictEqual(staleInterleaveObserved, true,
      'S080 did not reach the product boundary after resource-baseline capture');
    assert.strictEqual(fs.readFileSync(localizedPropertyFrench, 'utf8'), localizedPropertyFrenchExternal,
      'S080 stale localized transaction overwrote or compensated the newer external fr-FR edit');
    assert.strictEqual(fs.readFileSync(localizedPropertyNeutral, 'utf8'), localizedPropertyNeutralBefore,
      'S080 stale localized transaction changed the neutral fallback');
    assert.strictEqual(testApi.openDesignerState(localizedPropertyUri)?.designerText, localizedPropertyDesignerBefore,
      'S080 stale localized transaction changed generated source');
    assert.strictEqual(testApi.openDesignerState(localizedPropertyUri)?.dirty, false,
      'S080 stale localized transaction dirtied generated source');
    assert.strictEqual(activeCustomTab(localizedPropertyUri)?.isDirty, false,
      'S080 stale localized transaction registered a native history unit');
    assert.strictEqual(sha256File(localizedPropertySource), localizedPropertySourceHash,
      'S080 stale localized transaction changed code-behind disk');
    assert.strictEqual(sha256File(localizedPropertyDesigner), localizedPropertyDesignerHash,
      'S080 stale localized transaction changed Designer disk');
    await runDesignerHistoryCommand(testApi, localizedPropertyUri, 'undo');
    assert.strictEqual(fs.readFileSync(localizedPropertyFrench, 'utf8'), localizedPropertyFrenchExternal,
      'S080 native Undo changed the external resource despite the refused transaction');
    assert.strictEqual(activeCustomTab(localizedPropertyUri)?.isDirty, false,
      'S080 native Undo exposed a phantom history entry');
  } finally {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    fs.writeFileSync(localizedPropertyFrench, localizedPropertyFrenchBefore, 'utf8');
  }
  assert.strictEqual(fs.readFileSync(localizedPropertyFrench, 'utf8'), localizedPropertyFrenchBefore,
    'S080 fixture cleanup did not restore the exact fr-FR baseline');

  // V2-FND-001-S074 — a real modern CustomEditor imports a local .ico through the shipped Properties Import path.
  // The file chooser alone is deterministic; engine validation, resx upsert, source assignment and history are real.
  const iconImportSource = path.join(workspaceRoot, 'S074IconForm.cs');
  const iconImportDesigner = path.join(workspaceRoot, 'S074IconForm.Designer.cs');
  const iconImportResx = path.join(workspaceRoot, 'S074IconForm.resx');
  for (const required of [iconImportSource, iconImportDesigner, iconImportResx]) {
    assert.ok(fs.existsSync(required), `S074 icon-import fixture is missing: ${required}`);
  }
  const iconImportDesignerBefore = fs.readFileSync(iconImportDesigner, 'utf8');
  const iconImportResxBefore = fs.readFileSync(iconImportResx, 'utf8');
  const iconImportOpaqueNode = '<data name="opaque.Payload" xml:space="preserve"><value>keep-this-exactly</value></data>';
  assert.ok(iconImportResxBefore.includes(iconImportOpaqueNode), 'S074 opaque authority node is missing');
  const iconImportSourceHash = sha256File(iconImportSource);
  const iconImportDesignerHash = sha256File(iconImportDesigner);
  const iconImportUri = vscode.Uri.file(iconImportSource);
  const localIconPath = path.join(workspaceRoot, '.wfd-s074-local-icon.ico');
  const iconPng = fs.readFileSync(path.join(repoRoot, 'extension', 'media', 'icon.png'));
  assert.strictEqual(iconPng.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'S074 icon source is not PNG');
  const iconWidth = iconPng.readUInt32BE(16);
  const iconHeight = iconPng.readUInt32BE(20);
  assert.ok(iconWidth > 0 && iconWidth <= 256 && iconHeight > 0 && iconHeight <= 256,
    `S074 icon source dimensions are not ICO-representable: ${iconWidth}x${iconHeight}`);
  const iconContainer = Buffer.alloc(22 + iconPng.length);
  iconContainer.writeUInt16LE(0, 0);
  iconContainer.writeUInt16LE(1, 2);
  iconContainer.writeUInt16LE(1, 4);
  iconContainer[6] = iconWidth === 256 ? 0 : iconWidth;
  iconContainer[7] = iconHeight === 256 ? 0 : iconHeight;
  iconContainer.writeUInt16LE(1, 10);
  iconContainer.writeUInt16LE(32, 12);
  iconContainer.writeUInt32LE(iconPng.length, 14);
  iconContainer.writeUInt32LE(22, 18);
  iconPng.copy(iconContainer, 22);
  fs.writeFileSync(localIconPath, iconContainer);
  try {
    await vscode.commands.executeCommand('vscode.openWith', iconImportUri, designerViewType);
    await waitFor(() => testApi.openDesignerState(iconImportUri)?.renderReady === true,
      `S074 modern icon form did not render: ${JSON.stringify(testApi.openDesignerState(iconImportUri))}`,
      60_000);
    assert.strictEqual(testApi.openDesignerState(iconImportUri)?.engineKind, 'modern');
    await testApi.selectOpenDesignerControl(iconImportUri, 'this');
    await waitFor(() => testApi.openDesignerProperties(iconImportUri)?.id === 'this'
      && testApi.openDesignerProperties(iconImportUri)?.properties.some((property) =>
        property.name === 'Icon' && property.type === 'System.Drawing.Icon') === true,
    'S074 root Icon metadata was not published to Properties');
    assert.strictEqual(await testApi.importOpenDesignerLocalImage(
      iconImportUri, 'this', 'Icon', 'System.Drawing.Icon', vscode.Uri.file(localIconPath)), true,
    'S074 shipped local-icon Import path refused a valid ICO');
    await waitFor(() => activeCustomTab(iconImportUri)?.isDirty === true
      && fs.readFileSync(iconImportResx, 'utf8') !== iconImportResxBefore,
    'S074 local icon did not commit as one source+resource native history unit');
    const iconImportDesignerAfter = testApi.openDesignerState(iconImportUri)?.designerText ?? '';
    const iconImportResxAfter = fs.readFileSync(iconImportResx, 'utf8');
    assert.match(iconImportDesignerAfter,
      /this\.Icon\s*=\s*\(\(System\.Drawing\.Icon\)\(resources\.GetObject\("\$this\.Icon"\)\)\);/,
      'S074 did not emit the canonical resources.GetObject Icon assignment');
    const preservedOpaqueNodes = iconImportResxAfter.match(
      /<data\b[^>]*\bname="opaque\.Payload"[^>]*>[\s\S]*?<\/data>/g) ?? [];
    assert.strictEqual(preservedOpaqueNodes.length, 1,
      'S074 local icon import dropped or duplicated the opaque resource node');
    assert.match(preservedOpaqueNodes[0], /xml:space="preserve"/,
      'S074 local icon import changed opaque resource metadata');
    assert.match(preservedOpaqueNodes[0], /<value>keep-this-exactly<\/value>/,
      'S074 local icon import changed the opaque resource payload');
    assert.match(iconImportResxAfter, /<data name="\$this\.Icon"[^>]*type="System\.Drawing\.Icon/,
      'S074 local icon import did not add the typed $this.Icon resource');
    assert.strictEqual(sha256File(iconImportSource), iconImportSourceHash, 'S074 changed code-behind disk');
    assert.strictEqual(sha256File(iconImportDesigner), iconImportDesignerHash, 'S074 changed Designer disk before Save');
    await runDesignerHistoryCommand(testApi, iconImportUri, 'undo');
    await waitFor(() => testApi.openDesignerState(iconImportUri)?.designerText === iconImportDesignerBefore
      && fs.readFileSync(iconImportResx, 'utf8') === iconImportResxBefore
      && activeCustomTab(iconImportUri)?.isDirty === false,
    'S074 native Undo did not restore exact Designer/resource baselines');
    await runDesignerHistoryCommand(testApi, iconImportUri, 'redo');
    await waitFor(() => testApi.openDesignerState(iconImportUri)?.designerText === iconImportDesignerAfter
      && fs.readFileSync(iconImportResx, 'utf8') === iconImportResxAfter
      && activeCustomTab(iconImportUri)?.isDirty === true,
    'S074 native Redo did not reapply the exact icon import');
    await runDesignerHistoryCommand(testApi, iconImportUri, 'undo');
    await waitFor(() => testApi.openDesignerState(iconImportUri)?.designerText === iconImportDesignerBefore
      && fs.readFileSync(iconImportResx, 'utf8') === iconImportResxBefore
      && activeCustomTab(iconImportUri)?.isDirty === false,
    'S074 final Undo did not restore the clean fixture');
  } finally {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    fs.writeFileSync(iconImportResx, iconImportResxBefore, 'utf8');
    if (fs.existsSync(localIconPath)) fs.unlinkSync(localIconPath);
  }

  // V2-FND-001-S075 — a real compiled-net48 CustomEditor adds two PNGs through the shipped ImageList transaction.
  // Only QuickPick/OpenDialog are deterministic: ImageListStreamer serialization, source/resx planning, live reconcile,
  // resource persistence, native history, and all fail-closed boundaries remain the production implementation.
  const imageListSource = path.join(net48FixtureRoot, 'S075ImageListForm.cs');
  const imageListDesigner = path.join(net48FixtureRoot, 'S075ImageListForm.Designer.cs');
  const imageListResx = path.join(net48FixtureRoot, 'S075ImageListForm.resx');
  for (const required of [imageListSource, imageListDesigner, imageListResx]) {
    assert.ok(fs.existsSync(required), `S075 ImageList fixture is missing: ${required}`);
  }
  const imageListDesignerBefore = fs.readFileSync(imageListDesigner, 'utf8');
  const imageListResxBefore = fs.readFileSync(imageListResx, 'utf8');
  const imageListSourceHash = sha256File(imageListSource);
  const imageListDesignerHash = sha256File(imageListDesigner);
  const imageListUri = vscode.Uri.file(imageListSource);
  const imageListRedPath = path.join(workspaceRoot, '.wfd-s075-red.png');
  const imageListBluePath = path.join(workspaceRoot, '.wfd-s075-blue.png');
  const imageListRed = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAAdSURBVDhPY/jPwPCfEsyALkAqHjVg1IBRAwaLAQAwxP4Q7zYsrwAAAABJRU5ErkJggg==';
  const imageListBlue = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAAzSURBVDhPpcihEQAwEASh67/pTwGrmAgM2+7+JFRCJVRCJVRCJVRCJVRCJVRCJVRCJcwDMqb+ELsBUIUAAAAASUVORK5CYII=';
  fs.writeFileSync(imageListRedPath, Buffer.from(imageListRed, 'base64'));
  fs.writeFileSync(imageListBluePath, Buffer.from(imageListBlue, 'base64'));
  try {
    await vscode.commands.executeCommand('vscode.openWith', imageListUri, designerViewType);
    await waitFor(() => testApi.openDesignerState(imageListUri)?.renderReady === true,
      `S075 net48 ImageList form did not render: ${JSON.stringify(testApi.openDesignerState(imageListUri))}`,
      60_000);
    assert.strictEqual(testApi.openDesignerState(imageListUri)?.engineKind, 'net48');
    await waitFor(() => testApi.openDesignerState(imageListUri)?.tray.some((item) => item.id === 'imageList1') === true,
      'S075 compiled ImageList was not published in the component tray');
    await testApi.selectOpenDesignerControl(imageListUri, 'imageList1');
    await waitFor(() => testApi.openDesignerProperties(imageListUri)?.id === 'imageList1'
      && /(^|\.)ImageList$/.test(testApi.openDesignerProperties(imageListUri)?.type ?? ''),
    'S075 ImageList selection did not publish real component Properties metadata');
    assert.strictEqual(await testApi.setOpenDesignerImageListImages(imageListUri, 'imageList1', [
      { image: vscode.Uri.file(imageListRedPath), key: 'red' },
      { image: vscode.Uri.file(imageListBluePath), key: 'blue' },
    ]), true, 'S075 shipped ImageList transaction refused two valid PNGs');
    await waitFor(() => activeCustomTab(imageListUri)?.isDirty === true
      && fs.readFileSync(imageListResx, 'utf8') !== imageListResxBefore,
    'S075 ImageList edit did not commit as one source+resource native history unit');
    const imageListDesignerAfter = testApi.openDesignerState(imageListUri)?.designerText ?? '';
    const imageListResxAfter = fs.readFileSync(imageListResx, 'utf8');
    assert.match(imageListDesignerAfter,
      /this\.imageList1\.ImageStream\s*=\s*\(\(System\.Windows\.Forms\.ImageListStreamer\)\(resources\.GetObject\("imageList1\.ImageStream"\)\)\);/,
      'S075 did not emit the canonical ImageStream resources.GetObject assignment');
    assert.match(imageListDesignerAfter, /this\.imageList1\.Images\.SetKeyName\(0, "red"\);/,
      'S075 did not emit the first image key');
    assert.match(imageListDesignerAfter, /this\.imageList1\.Images\.SetKeyName\(1, "blue"\);/,
      'S075 did not emit the second image key');
    assert.doesNotMatch(imageListDesignerAfter, /this\.imageList1\.Images\.Add\s*\(/,
      'S075 left a competing in-code Images.Add statement');
    assert.match(imageListResxAfter,
      /<data name="imageList1\.ImageStream"[^>]*mimetype="application\/x-microsoft\.net\.object\.binary\.base64"/,
      'S075 did not persist a typed binary ImageStream resource');
    assert.match(imageListResxAfter, /<data\b[^>]*\bname="s075\.Note"[^>]*>[\s\S]*?<value>preserve this neutral resource<\/value>[\s\S]*?<\/data>/,
      'S075 changed or dropped the unrelated neutral resource');
    assert.strictEqual(sha256File(imageListSource), imageListSourceHash, 'S075 changed code-behind disk');
    assert.strictEqual(sha256File(imageListDesigner), imageListDesignerHash, 'S075 changed Designer disk before Save');
    await runDesignerHistoryCommand(testApi, imageListUri, 'undo');
    await waitFor(() => testApi.openDesignerState(imageListUri)?.designerText === imageListDesignerBefore
      && fs.readFileSync(imageListResx, 'utf8') === imageListResxBefore
      && activeCustomTab(imageListUri)?.isDirty === false,
    'S075 native Undo did not restore exact Designer/resource baselines');
    await runDesignerHistoryCommand(testApi, imageListUri, 'redo');
    await waitFor(() => testApi.openDesignerState(imageListUri)?.designerText === imageListDesignerAfter
      && fs.readFileSync(imageListResx, 'utf8') === imageListResxAfter
      && activeCustomTab(imageListUri)?.isDirty === true,
    'S075 native Redo did not reapply the exact ImageList transaction');
    await runDesignerHistoryCommand(testApi, imageListUri, 'undo');
    await waitFor(() => testApi.openDesignerState(imageListUri)?.designerText === imageListDesignerBefore
      && fs.readFileSync(imageListResx, 'utf8') === imageListResxBefore
      && activeCustomTab(imageListUri)?.isDirty === false,
    'S075 final Undo did not restore the clean fixture');
  } finally {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    fs.writeFileSync(imageListResx, imageListResxBefore, 'utf8');
    if (fs.existsSync(imageListRedPath)) fs.unlinkSync(imageListRedPath);
    if (fs.existsSync(imageListBluePath)) fs.unlinkSync(imageListBluePath);
  }

  // V2-FND-001-S076 — a compromised/deterministic Project… picker returns a property-chain injection accessor.
  // Both runtime lanes must reject it at the shipped product ingress before resource discovery, engine source planning,
  // native history, or any source/resource write. The real Properties metadata remains the authorization boundary.
  const unsafeProjectResourceAccessor = 'DemoApp.Properties.Resources;this.evil.Logo';
  const unsafeResourceTargets = [
    {
      label: 'modern', uri: projectImageUri, controlId: 'imageButton',
      designerPath: projectImageDesigner, designerBefore: projectImageBefore,
      sourcePath: projectImageSource, sourceHash: projectImageSourceHash,
      resourcePath: projectResourcesResx, resourceHash: projectResourcesResxHash,
    },
    {
      label: 'net48', uri: imageListUri, controlId: 'button1',
      designerPath: imageListDesigner, designerBefore: imageListDesignerBefore,
      sourcePath: imageListSource, sourceHash: imageListSourceHash,
      resourcePath: imageListResx, resourceHash: sha256File(imageListResx),
    },
  ] as const;
  for (const target of unsafeResourceTargets) {
    const designerHash = sha256File(target.designerPath);
    await vscode.commands.executeCommand('vscode.openWith', target.uri, designerViewType);
    await waitFor(() => testApi.openDesignerState(target.uri)?.renderReady === true,
      `S076 ${target.label} unsafe-resource form did not render: ${JSON.stringify(testApi.openDesignerState(target.uri))}`,
      60_000);
    assert.strictEqual(testApi.openDesignerState(target.uri)?.engineKind, target.label);
    await testApi.selectOpenDesignerControl(target.uri, target.controlId);
    await waitFor(() => testApi.openDesignerProperties(target.uri)?.id === target.controlId
      && testApi.openDesignerProperties(target.uri)?.properties.some((property) =>
        property.name === 'Image' && property.type === 'System.Drawing.Image') === true,
    `S076 ${target.label} Button.Image metadata was not published to Properties`);
    const refusal = await testApi.tryOpenDesignerProjectImageResource(
      target.uri, target.controlId, 'Image', unsafeProjectResourceAccessor);
    assert.deepStrictEqual(refusal, {
      applied: false,
      refusalCode: 'INVALID_RESOURCE_SYMBOL',
      reason: 'invalid resource class name: DemoApp.Properties.Resources;this.evil',
    }, `S076 ${target.label} did not return the exact typed unsafe-symbol refusal`);
    assert.strictEqual(testApi.openDesignerState(target.uri)?.designerText, target.designerBefore,
      `S076 ${target.label} refusal changed the in-memory Designer source`);
    assert.strictEqual(testApi.openDesignerState(target.uri)?.dirty, false,
      `S076 ${target.label} refusal dirtied the Designer`);
    assert.strictEqual(activeCustomTab(target.uri)?.isDirty, false,
      `S076 ${target.label} refusal registered native history`);
    assert.strictEqual(sha256File(target.sourcePath), target.sourceHash,
      `S076 ${target.label} refusal changed code-behind disk`);
    assert.strictEqual(sha256File(target.designerPath), designerHash,
      `S076 ${target.label} refusal changed Designer disk`);
    assert.strictEqual(sha256File(target.resourcePath), target.resourceHash,
      `S076 ${target.label} refusal changed resource authority`);
    await runDesignerHistoryCommand(testApi, target.uri, 'undo');
    assert.strictEqual(testApi.openDesignerState(target.uri)?.designerText, target.designerBefore,
      `S076 ${target.label} native Undo exposed a phantom history entry`);
    assert.strictEqual(activeCustomTab(target.uri)?.isDirty, false,
      `S076 ${target.label} native Undo dirtied the refused document`);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  }

  // V2-FND-001-S118 — the real modern ImageList resource transaction writes its planned resx image, then its final
  // verified forward postcondition is fault-injected to fail. The shipped journal runner must compensate the exact
  // bytes before returning, without publishing Designer text or registering a native CustomDocument history unit.
  const rollbackImageSource = path.join(workspaceRoot, 'S118ImageListRollbackForm.cs');
  const rollbackImageDesigner = path.join(workspaceRoot, 'S118ImageListRollbackForm.Designer.cs');
  const rollbackImageResx = path.join(workspaceRoot, 'S118ImageListRollbackForm.resx');
  for (const required of [rollbackImageSource, rollbackImageDesigner, rollbackImageResx]) {
    assert.ok(fs.existsSync(required), `S118 ImageList rollback fixture is missing: ${required}`);
  }
  const rollbackImageDesignerBefore = fs.readFileSync(rollbackImageDesigner, 'utf8');
  const rollbackImageResxBefore = fs.readFileSync(rollbackImageResx, 'utf8');
  const rollbackImageSourceHash = sha256File(rollbackImageSource);
  const rollbackImageDesignerHash = sha256File(rollbackImageDesigner);
  const rollbackImageResxHash = sha256File(rollbackImageResx);
  const rollbackImageUri = vscode.Uri.file(rollbackImageSource);
  const rollbackImagePath = path.join(workspaceRoot, '.wfd-s118-red.png');
  fs.writeFileSync(rollbackImagePath, Buffer.from(imageListRed, 'base64'));
  try {
    await vscode.commands.executeCommand('vscode.openWith', rollbackImageUri, designerViewType);
    await waitFor(() => testApi.openDesignerState(rollbackImageUri)?.renderReady === true,
      `S118 modern ImageList rollback form did not render: ${JSON.stringify(testApi.openDesignerState(rollbackImageUri))}`,
      60_000);
    assert.strictEqual(testApi.openDesignerState(rollbackImageUri)?.engineKind, 'modern');
    await waitFor(() => testApi.openDesignerState(rollbackImageUri)?.tray.some((item) => item.id === 'imageList1') === true,
      'S118 modern ImageList was not published in the component tray');
    await testApi.selectOpenDesignerControl(rollbackImageUri, 'imageList1');
    await waitFor(() => testApi.openDesignerProperties(rollbackImageUri)?.id === 'imageList1',
      'S118 ImageList selection did not publish real Properties metadata');
    const rollback = await testApi.setOpenDesignerImageListWithPostconditionFailure(
      rollbackImageUri, 'imageList1', [{ image: vscode.Uri.file(rollbackImagePath), key: 'red' }]);
    assert.deepStrictEqual(rollback, {
      applied: false,
      failureObserved: true,
      refusalCode: 'POSTCONDITION_FAILED_ROLLED_BACK',
    }, 'S118 did not surface the exact postcondition-failure rollback result');
    assert.strictEqual(testApi.openDesignerState(rollbackImageUri)?.designerText, rollbackImageDesignerBefore,
      'S118 rollback published transient Designer text');
    assert.strictEqual(testApi.openDesignerState(rollbackImageUri)?.dirty, false,
      'S118 rollback dirtied the Designer');
    assert.strictEqual(activeCustomTab(rollbackImageUri)?.isDirty, false,
      'S118 rollback registered a native history unit');
    assert.strictEqual(fs.readFileSync(rollbackImageResx, 'utf8'), rollbackImageResxBefore,
      'S118 rollback did not restore exact resx text');
    assert.strictEqual(sha256File(rollbackImageSource), rollbackImageSourceHash,
      'S118 rollback changed code-behind disk');
    assert.strictEqual(sha256File(rollbackImageDesigner), rollbackImageDesignerHash,
      'S118 rollback changed Designer disk');
    assert.strictEqual(sha256File(rollbackImageResx), rollbackImageResxHash,
      'S118 rollback changed resx disk bytes');
    await runDesignerHistoryCommand(testApi, rollbackImageUri, 'undo');
    assert.strictEqual(testApi.openDesignerState(rollbackImageUri)?.designerText, rollbackImageDesignerBefore,
      'S118 native Undo exposed a phantom refused transaction');
    assert.strictEqual(activeCustomTab(rollbackImageUri)?.isDirty, false,
      'S118 native Undo dirtied the compensated document');
  } finally {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    fs.writeFileSync(rollbackImageResx, rollbackImageResxBefore, 'utf8');
    if (fs.existsSync(rollbackImagePath)) fs.unlinkSync(rollbackImagePath);
  }

  // V2-FND-001-S045 and V2-FND-001-S046 — use a real modern CustomEditor and live ColorEditor metadata. The deterministic API
  // replaces only the native modal choice/dismissal; the product still owns metadata authorization, the shared
  // UITypeEditor ingress, engine conversion/source planning, CustomDocument commit, and native Undo/Redo history.
  const colorEditorSource = path.join(workspaceRoot, 'S045ColorEditorForm.cs');
  const colorEditorDesigner = path.join(workspaceRoot, 'S045ColorEditorForm.Designer.cs');
  for (const required of [colorEditorSource, colorEditorDesigner]) {
    assert.ok(fs.existsSync(required), `S045/S046 ColorEditor fixture is missing: ${required}`);
  }
  const colorEditorDesignerBefore = fs.readFileSync(colorEditorDesigner, 'utf8');
  const colorEditorSourceHash = sha256File(colorEditorSource);
  const colorEditorDesignerHash = sha256File(colorEditorDesigner);
  const colorEditorUri = vscode.Uri.file(colorEditorSource);
  try {
    await vscode.commands.executeCommand('vscode.openWith', colorEditorUri, designerViewType);
    await waitFor(() => testApi.openDesignerState(colorEditorUri)?.renderReady === true,
      `S045/S046 modern ColorEditor form did not render: ${JSON.stringify(testApi.openDesignerState(colorEditorUri))}`,
      60_000);
    assert.strictEqual(testApi.openDesignerState(colorEditorUri)?.engineKind, 'modern');
    await testApi.selectOpenDesignerControl(colorEditorUri, 'colorButton');
    await waitFor(() => {
      const component = testApi.openDesignerProperties(colorEditorUri);
      const property = component?.properties.find((candidate) => candidate.name === 'BackColor');
      return component?.id === 'colorButton'
        && property?.type === 'System.Drawing.Color'
        && property.value === 'Red'
        && property.uiTypeEditor === 'System.Drawing.Design.ColorEditor';
    }, 'S045/S046 live BackColor ColorEditor metadata was not published');

    const dismissed = await testApi.editOpenDesignerColorUiTypeEditor(
      colorEditorUri, 'colorButton', 'BackColor', 'dismiss');
    assert.deepStrictEqual(dismissed, {
      applied: false,
      dismissed: true,
      resultConsumed: true,
      editorType: 'System.Drawing.Design.ColorEditor',
      refusalCode: 'CANCELLED',
    }, 'S046 did not pass the deterministic dismissal through the real UITypeEditor ingress');
    assert.strictEqual(testApi.openDesignerState(colorEditorUri)?.designerText, colorEditorDesignerBefore,
      'S046 dismissal changed Designer text');
    assert.strictEqual(testApi.openDesignerState(colorEditorUri)?.dirty, false,
      'S046 dismissal dirtied the Designer');
    assert.strictEqual(activeCustomTab(colorEditorUri)?.isDirty, false,
      'S046 dismissal registered native history');
    assert.strictEqual(sha256File(colorEditorSource), colorEditorSourceHash,
      'S046 dismissal changed code-behind disk');
    assert.strictEqual(sha256File(colorEditorDesigner), colorEditorDesignerHash,
      'S046 dismissal changed Designer disk');
    await runDesignerHistoryCommand(testApi, colorEditorUri, 'undo');
    assert.strictEqual(testApi.openDesignerState(colorEditorUri)?.designerText, colorEditorDesignerBefore,
      'S046 native Undo exposed a phantom dismissed-editor entry');

    const applied = await testApi.editOpenDesignerColorUiTypeEditor(
      colorEditorUri, 'colorButton', 'BackColor', 'apply-blue');
    assert.deepStrictEqual(applied, {
      applied: true,
      dismissed: false,
      resultConsumed: true,
      editorType: 'System.Drawing.Design.ColorEditor',
      refusalCode: null,
    }, 'S045 did not pass the deterministic Blue selection through the real UITypeEditor ingress');
    const colorEditorDesignerAfter = testApi.openDesignerState(colorEditorUri)?.designerText ?? '';
    assert.notStrictEqual(colorEditorDesignerAfter, colorEditorDesignerBefore,
      'S045 selected Color did not change Designer text');
    assert.ok(colorEditorDesignerAfter.includes(
      'this.colorButton.BackColor = System.Drawing.Color.Blue;'),
    'S045 did not persist the selected Color as the canonical Color.Blue expression');
    assert.ok(!colorEditorDesignerAfter.includes(
      'this.colorButton.BackColor = System.Drawing.Color.Red;'),
    'S045 retained the old Color.Red assignment');
    assert.strictEqual(testApi.openDesignerState(colorEditorUri)?.dirty, true,
      'S045 selected Color did not dirty the Designer');
    assert.strictEqual(activeCustomTab(colorEditorUri)?.isDirty, true,
      'S045 selected Color did not register native history');
    assert.strictEqual(sha256File(colorEditorSource), colorEditorSourceHash,
      'S045 selected Color changed code-behind disk before Save');
    assert.strictEqual(sha256File(colorEditorDesigner), colorEditorDesignerHash,
      'S045 selected Color changed Designer disk before Save');
    await runDesignerHistoryCommand(testApi, colorEditorUri, 'undo');
    assert.strictEqual(testApi.openDesignerState(colorEditorUri)?.designerText, colorEditorDesignerBefore,
      'S045 native Undo did not restore Color.Red exactly');
    assert.strictEqual(activeCustomTab(colorEditorUri)?.isDirty, false,
      'S045 native Undo did not restore a clean tab');
    await runDesignerHistoryCommand(testApi, colorEditorUri, 'redo');
    assert.strictEqual(testApi.openDesignerState(colorEditorUri)?.designerText, colorEditorDesignerAfter,
      'S045 native Redo did not reapply Color.Blue exactly');
    assert.strictEqual(activeCustomTab(colorEditorUri)?.isDirty, true,
      'S045 native Redo did not restore dirty state');
    await runDesignerHistoryCommand(testApi, colorEditorUri, 'undo');
    assert.strictEqual(testApi.openDesignerState(colorEditorUri)?.designerText, colorEditorDesignerBefore,
      'S045 final native Undo did not restore the exact baseline');
    assert.strictEqual(activeCustomTab(colorEditorUri)?.isDirty, false,
      'S045 final native Undo did not restore a clean tab');
  } finally {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    fs.writeFileSync(colorEditorDesigner, colorEditorDesignerBefore, 'utf8');
  }

  // V2-FND-001-S093/S094 — a real modern CustomEditor reads the in-repo custom ComponentDesigner's bounded adorner
  // and live ActionLists. S093 confirms an on-canvas local hover against a freshly rebuilt graph without mutation;
  // S094 authorizes Caption -> Text and commits through the same source-first path as the canvas smart-tag flyout.
  // The fixture is synthetic MIT evidence; actual licensed-vendor/VS/ARM64 gates remain external.
  const fakeVendorRoot = path.join(workspaceFolder.uri.fsPath, 'fixtures', 'FakeVendor');
  const smartTagSource = path.join(fakeVendorRoot, 'FakeVendorForm.cs');
  const smartTagDesigner = path.join(fakeVendorRoot, 'FakeVendorForm.Designer.cs');
  const smartTagAssembly = path.join(fakeVendorRoot, 'bin', 'Release', 'net10.0-windows', 'FakeVendor.dll');
  for (const required of [smartTagSource, smartTagDesigner, smartTagAssembly]) {
    assert.ok(fs.existsSync(required), `S093/S094 FakeVendor designer fixture is missing: ${required}`);
  }
  const smartTagDesignerBefore = fs.readFileSync(smartTagDesigner, 'utf8');
  const smartTagSourceHash = sha256File(smartTagSource);
  const smartTagDesignerHash = sha256File(smartTagDesigner);
  const smartTagUri = vscode.Uri.file(smartTagSource);
  try {
    await vscode.commands.executeCommand('vscode.openWith', smartTagUri, designerViewType);
    await waitFor(() => testApi.openDesignerState(smartTagUri)?.renderReady === true,
      `S094 modern FakeVendor form did not render: ${JSON.stringify(testApi.openDesignerState(smartTagUri))}`,
      60_000);
    assert.strictEqual(testApi.openDesignerState(smartTagUri)?.engineKind, 'modern');
    await testApi.selectOpenDesignerControl(smartTagUri, 'fancyButton1');
    await waitFor(() => {
      const component = testApi.openDesignerProperties(smartTagUri);
      const text = component?.properties.find((candidate) => candidate.name === 'Text');
      const caption = component?.designerActions?.find((candidate) => candidate.displayName === 'Caption');
      const adorner = component?.designerAdorners?.find((candidate) => candidate.id === 'fakevendor.caption');
      return component?.id === 'fancyButton1'
        && component.type === 'FakeVendor.FancyButton'
        && text?.type === 'System.String'
        && text.value === 'Fancy'
        && caption?.propertyName === 'Text'
        && caption.category === 'FakeVendor'
        && adorner?.displayName === 'Caption adorner'
        && adorner.left === 0 && adorner.top === 0
        && adorner.width === 96 && adorner.height === 18
        && adorner.hitTestable === true;
    }, 'S093/S094 live ComponentDesigner metadata was not published', 60_000);

    const adornerHit = await testApi.hitOpenDesignerAdorner(
      smartTagUri, 'fancyButton1', 'fakevendor.caption', 5, 5);
    assert.deepStrictEqual(adornerHit, {
      ok: true,
      hit: true,
      componentId: 'fancyButton1',
      adornerId: 'fakevendor.caption',
      componentType: 'FakeVendor.FancyButton',
      designerType: 'FakeVendor.FancyButtonDesigner',
      errorCode: '',
      reason: '',
    }, 'S093 did not route the selected on-canvas adorner hover through the fresh hosted designer graph');
    assert.strictEqual(testApi.openDesignerState(smartTagUri)?.designerText, smartTagDesignerBefore,
      'S093 adorner hover changed the Designer source buffer');
    assert.strictEqual(activeCustomTab(smartTagUri)?.isDirty, false,
      'S093 adorner hover registered a native edit');
    assert.strictEqual(sha256File(smartTagSource), smartTagSourceHash,
      'S093 adorner hover changed code-behind disk');
    assert.strictEqual(sha256File(smartTagDesigner), smartTagDesignerHash,
      'S093 adorner hover changed Designer disk');

    const action = await testApi.editOpenDesignerActionProperty(
      smartTagUri, 'fancyButton1', 'Caption', 'Hosted caption');
    assert.deepStrictEqual(action, {
      applied: true,
      displayName: 'Caption',
      category: 'FakeVendor',
      propertyName: 'Text',
      propertyType: 'System.String',
    }, 'S094 did not authorize the live Caption action as the source Text property');
    const smartTagDesignerAfter = testApi.openDesignerState(smartTagUri)?.designerText ?? '';
    assert.ok(smartTagDesignerAfter.includes('this.fancyButton1.Text = "Hosted caption";'),
      'S094 did not persist the smart-tag value as the canonical Text assignment');
    assert.ok(!smartTagDesignerAfter.includes('this.fancyButton1.Text = "Fancy";'),
      'S094 retained the old Fancy Text assignment');
    assert.strictEqual(testApi.openDesignerState(smartTagUri)?.dirty, true,
      'S094 smart-tag property action did not dirty the Designer');
    assert.strictEqual(activeCustomTab(smartTagUri)?.isDirty, true,
      'S094 smart-tag property action did not register native history');
    assert.strictEqual(sha256File(smartTagSource), smartTagSourceHash,
      'S094 smart-tag property action changed code-behind disk before Save');
    assert.strictEqual(sha256File(smartTagDesigner), smartTagDesignerHash,
      'S094 smart-tag property action changed Designer disk before Save');
    await runDesignerHistoryCommand(testApi, smartTagUri, 'undo');
    assert.strictEqual(testApi.openDesignerState(smartTagUri)?.designerText, smartTagDesignerBefore,
      'S094 native Undo did not restore the exact Fancy baseline');
    assert.strictEqual(activeCustomTab(smartTagUri)?.isDirty, false,
      'S094 native Undo did not restore a clean tab');
    await runDesignerHistoryCommand(testApi, smartTagUri, 'redo');
    assert.strictEqual(testApi.openDesignerState(smartTagUri)?.designerText, smartTagDesignerAfter,
      'S094 native Redo did not reapply the exact Hosted caption edit');
    assert.strictEqual(activeCustomTab(smartTagUri)?.isDirty, true,
      'S094 native Redo did not restore dirty state');
    await runDesignerHistoryCommand(testApi, smartTagUri, 'undo');
    assert.strictEqual(testApi.openDesignerState(smartTagUri)?.designerText, smartTagDesignerBefore,
      'S094 final native Undo did not restore the exact baseline');
    assert.strictEqual(activeCustomTab(smartTagUri)?.isDirty, false,
      'S094 final native Undo did not restore a clean tab');

    // S048 also proves the modern runtime leg. The actual certified worker receives a deterministic wrong-type result
    // from the fixture and must leave the dirty setup baseline untouched and add no native-history entry.
    await testApi.selectOpenDesignerControl(smartTagUri, 'vendorEdit1');
    await waitFor(() => {
      const property = testApi.openDesignerProperties(smartTagUri)?.properties
        .find((candidate) => candidate.name === 'ComplexValue');
      return property?.uiTypeEditor === 'FakeVendor.VendorComplexValueEditor'
        && property.uiTypeEditorAssemblyPath === smartTagAssembly
        && property.uiTypeEditorAssemblySha256 === sha256File(smartTagAssembly)
        && property.uiTypeEditorCertificationId === 'repo.fakevendor.complex-value.v1';
    }, `S048 modern certified vendor editor metadata was not published: ${JSON.stringify(
      testApi.openDesignerProperties(smartTagUri))}`);
    await testApi.editOpenDesignerProperty(
      smartTagUri, 'vendorEdit1', 'ComplexValue', 'System.String', false, '__invalid_object__');
    await waitFor(() => testApi.openDesignerProperties(smartTagUri)?.properties
      .find((candidate) => candidate.name === 'ComplexValue')?.value === '__invalid_object__',
    'S048 modern invalid-result setup value was not published');
    const modernInvalidBaseline = testApi.openDesignerState(smartTagUri)?.designerText ?? '';
    const modernInvalid = await testApi.editOpenDesignerCertifiedVendorUiTypeEditor(
      smartTagUri, 'vendorEdit1', 'ComplexValue');
    assert.strictEqual(modernInvalid.applied, false, 'S048 modern invalid result changed source');
    assert.strictEqual(modernInvalid.brokerApplied, false, 'S048 modern broker accepted the wrong result type');
    assert.strictEqual(modernInvalid.ok, false, 'S048 modern invalid result was reported as successful');
    assert.strictEqual(modernInvalid.errorCode, 'INVALID_EDITOR_RESULT',
      'S048 modern path did not preserve the typed refusal');
    assert.strictEqual(testApi.openDesignerState(smartTagUri)?.designerText, modernInvalidBaseline,
      'S048 modern invalid result changed the dirty setup baseline');
    assert.strictEqual(sha256File(smartTagSource), smartTagSourceHash,
      'S048 modern invalid result changed code-behind disk');
    assert.strictEqual(sha256File(smartTagDesigner), smartTagDesignerHash,
      'S048 modern invalid result changed Designer disk');
    await runDesignerHistoryCommand(testApi, smartTagUri, 'undo');
    assert.strictEqual(testApi.openDesignerState(smartTagUri)?.designerText, smartTagDesignerBefore,
      'S048 modern invalid result created a phantom history entry');
    assert.strictEqual(activeCustomTab(smartTagUri)?.isDirty, false,
      'S048 modern single native Undo did not restore the clean baseline');
  } finally {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    fs.writeFileSync(smartTagDesigner, smartTagDesignerBefore, 'utf8');
  }

  // V2-FND-001-S071/S072 — modern live metadata opens the actual certified vendor collection editor. Its validated
  // Int32 result is only a proposal: S071 proves one component-bounded CustomDocument transaction with native history;
  // S072 tampers with a root statement after that same worker succeeds and must be refused without text/history/disk.
  const modernVendorEditorSource = path.join(fakeVendorRoot, 'VendorEditorForm.cs');
  const modernVendorEditorDesigner = path.join(fakeVendorRoot, 'VendorEditorForm.Designer.cs');
  for (const required of [modernVendorEditorSource, modernVendorEditorDesigner, smartTagAssembly]) {
    assert.ok(fs.existsSync(required), `S071/S072 modern FakeVendor collection fixture is missing: ${required}`);
  }
  const modernVendorEditorDesignerBefore = fs.readFileSync(modernVendorEditorDesigner, 'utf8');
  const modernVendorEditorSourceHash = sha256File(modernVendorEditorSource);
  const modernVendorEditorDesignerHash = sha256File(modernVendorEditorDesigner);
  const modernVendorEditorAssemblyHash = sha256File(smartTagAssembly);
  const modernVendorEditorUri = vscode.Uri.file(modernVendorEditorSource);
  try {
    await vscode.commands.executeCommand('vscode.openWith', modernVendorEditorUri, designerViewType);
    await waitFor(() => testApi.openDesignerState(modernVendorEditorUri)?.renderReady === true,
      `S071/S072 modern vendor collection form did not render: ${JSON.stringify(
        testApi.openDesignerState(modernVendorEditorUri))}`,
      60_000);
    assert.strictEqual(testApi.openDesignerState(modernVendorEditorUri)?.engineKind, 'modern',
      'S071 modern collection scenario did not use the modern runtime lane');
    await testApi.selectOpenDesignerControl(modernVendorEditorUri, 'vendorEdit1');
    await waitFor(() => {
      const component = testApi.openDesignerProperties(modernVendorEditorUri);
      const property = component?.properties.find((candidate) => candidate.name === 'Thresholds');
      return component?.id === 'vendorEdit1'
        && component.type === 'FakeVendor.VendorEdit'
        && property?.genericCollection === true
        && property.collectionItemType === 'System.Int32'
        && property.readOnly === false
        && property.uiTypeEditor === 'FakeVendor.VendorThresholdsEditor'
        && property.uiTypeEditorAssemblyPath === smartTagAssembly
        && property.uiTypeEditorAssemblySha256 === modernVendorEditorAssemblyHash
        && property.uiTypeEditorCertificationId === 'repo.fakevendor.thresholds.v1';
    }, 'S071 modern certified vendor collection metadata was not published', 60_000);

    const modernCollectionApplied = await testApi.editOpenDesignerCertifiedVendorCollectionEditor(
      modernVendorEditorUri, 'vendorEdit1', 'Thresholds', false);
    assert.deepStrictEqual(modernCollectionApplied, {
      applied: true,
      brokerApplied: true,
      dismissed: false,
      ok: true,
      errorCode: null,
      collectionItems: ['3', '5'],
      editorType: 'FakeVendor.VendorThresholdsEditor',
      assemblyPath: smartTagAssembly,
      assemblySha256: modernVendorEditorAssemblyHash,
      certificationId: 'repo.fakevendor.thresholds.v1',
      persistenceLane: 'ownedRegion',
      refusalReason: null,
    }, 'S071 modern path did not apply the actual vendor collection result through the bounded transaction');
    const modernVendorEditorDesignerAfter = testApi.openDesignerState(modernVendorEditorUri)?.designerText ?? '';
    assert.ok(modernVendorEditorDesignerAfter.includes('this.vendorEdit1.Thresholds.Add(3);'),
      'S071 modern collection transaction did not serialize item 3');
    assert.ok(modernVendorEditorDesignerAfter.includes('this.vendorEdit1.Thresholds.Add(5);'),
      'S071 modern collection transaction did not serialize item 5');
    assert.ok(!modernVendorEditorDesignerAfter.includes('this.vendorEdit1.Thresholds.Add(1);')
      && !modernVendorEditorDesignerAfter.includes('this.vendorEdit1.Thresholds.Add(2);'),
    'S071 modern collection transaction retained stale items');
    assert.strictEqual(activeCustomTab(modernVendorEditorUri)?.isDirty, true,
      'S071 modern collection transaction did not register native history');
    assert.strictEqual(sha256File(modernVendorEditorSource), modernVendorEditorSourceHash,
      'S071 modern collection transaction changed code-behind disk before Save');
    assert.strictEqual(sha256File(modernVendorEditorDesigner), modernVendorEditorDesignerHash,
      'S071 modern collection transaction changed Designer disk before Save');
    await runDesignerHistoryCommand(testApi, modernVendorEditorUri, 'undo');
    assert.strictEqual(testApi.openDesignerState(modernVendorEditorUri)?.designerText, modernVendorEditorDesignerBefore,
      'S071 modern native Undo did not restore the exact [1,2] collection baseline');
    assert.strictEqual(activeCustomTab(modernVendorEditorUri)?.isDirty, false,
      'S071 modern native Undo did not restore a clean tab');
    await runDesignerHistoryCommand(testApi, modernVendorEditorUri, 'redo');
    assert.strictEqual(testApi.openDesignerState(modernVendorEditorUri)?.designerText, modernVendorEditorDesignerAfter,
      'S071 modern native Redo did not reapply [3,5] exactly');
    await runDesignerHistoryCommand(testApi, modernVendorEditorUri, 'undo');
    assert.strictEqual(testApi.openDesignerState(modernVendorEditorUri)?.designerText, modernVendorEditorDesignerBefore,
      'S071 modern final native Undo did not restore the exact baseline');

    // V2-FND-001-S072 — the actual worker succeeds; the product authority alone refuses the cross-component proposal.
    const modernCollectionRefused = await testApi.editOpenDesignerCertifiedVendorCollectionEditor(
      modernVendorEditorUri, 'vendorEdit1', 'Thresholds', true);
    assert.strictEqual(modernCollectionRefused.applied, false,
      'S072 modern malicious collection proposal changed source');
    assert.strictEqual(modernCollectionRefused.brokerApplied, true,
      'S072 modern scenario did not first run the actual successful vendor worker');
    assert.strictEqual(modernCollectionRefused.ok, false,
      'S072 modern malicious collection proposal was reported as successful');
    assert.strictEqual(modernCollectionRefused.errorCode, 'OWNED_REGION_VIOLATION',
      'S072 modern refusal did not expose the stable owned-region error code');
    assert.deepStrictEqual(modernCollectionRefused.collectionItems, ['3', '5'],
      'S072 modern refusal lost the actual worker result evidence');
    assert.strictEqual(modernCollectionRefused.persistenceLane, null,
      'S072 modern refusal incorrectly claimed a persistence lane');
    assert.match(modernCollectionRefused.refusalReason ?? '', /owned-region violation/i,
      'S072 modern refusal did not retain the engine-owned diagnostic');
    assert.strictEqual(testApi.openDesignerState(modernVendorEditorUri)?.designerText, modernVendorEditorDesignerBefore,
      'S072 modern refusal changed the exact Designer baseline');
    assert.strictEqual(activeCustomTab(modernVendorEditorUri)?.isDirty, false,
      'S072 modern refusal registered a native history entry');
    assert.strictEqual(sha256File(modernVendorEditorSource), modernVendorEditorSourceHash,
      'S072 modern refusal changed code-behind disk');
    assert.strictEqual(sha256File(modernVendorEditorDesigner), modernVendorEditorDesignerHash,
      'S072 modern refusal changed Designer disk');
    await runDesignerHistoryCommand(testApi, modernVendorEditorUri, 'undo');
    assert.strictEqual(testApi.openDesignerState(modernVendorEditorUri)?.designerText, modernVendorEditorDesignerBefore,
      'S072 modern refusal created a phantom native history entry');
    assert.strictEqual(activeCustomTab(modernVendorEditorUri)?.isDirty, false,
      'S072 modern no-op Undo disturbed clean state');
  } finally {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    fs.writeFileSync(modernVendorEditorDesigner, modernVendorEditorDesignerBefore, 'utf8');
  }

  // V2-FND-001-S047/S048 — the disposable net48 copy publishes the certified FakeVendor dropdown from the live
  // compiled component. Unlike the framework ColorEditor proof above, no result seam is injected: the actual modern
  // broker starts its child worker, verifies the net48 assembly path/hash/certification, and validates the returned
  // string/object before the ordinary owned-region planner and native CustomDocument history can run.
  const fakeVendorNet48Root = path.join(workspaceFolder.uri.fsPath, 'fixtures', 'FakeVendorNet48');
  const vendorEditorSource = path.join(fakeVendorNet48Root, 'VendorEditorForm.cs');
  const vendorEditorDesigner = path.join(fakeVendorNet48Root, 'VendorEditorForm.Designer.cs');
  const vendorEditorAssembly = path.join(fakeVendorNet48Root, 'bin', 'Release', 'net48', 'FakeVendor.dll');
  for (const required of [vendorEditorSource, vendorEditorDesigner, vendorEditorAssembly]) {
    assert.ok(fs.existsSync(required), `S047/S048 net48 FakeVendor fixture is missing: ${required}`);
  }
  const vendorEditorDesignerBefore = fs.readFileSync(vendorEditorDesigner, 'utf8');
  const vendorEditorSourceHash = sha256File(vendorEditorSource);
  const vendorEditorDesignerHash = sha256File(vendorEditorDesigner);
  const vendorEditorAssemblyHash = sha256File(vendorEditorAssembly);
  const vendorEditorUri = vscode.Uri.file(vendorEditorSource);
  try {
    await vscode.commands.executeCommand('vscode.openWith', vendorEditorUri, designerViewType);
    await waitFor(() => testApi.openDesignerState(vendorEditorUri)?.renderReady === true,
      `S047/S048 net48 FakeVendor form did not render: ${JSON.stringify(testApi.openDesignerState(vendorEditorUri))}`,
      60_000);
    assert.strictEqual(testApi.openDesignerState(vendorEditorUri)?.engineKind, 'net48',
      'S047 did not exercise the compiled-net48 metadata lane');
    await testApi.selectOpenDesignerControl(vendorEditorUri, 'vendorEdit1');
    await waitFor(() => {
      const component = testApi.openDesignerProperties(vendorEditorUri);
      const property = component?.properties.find((candidate) => candidate.name === 'ComplexValue');
      return component?.id === 'vendorEdit1'
        && component.type === 'FakeVendor.VendorEdit'
        && property?.type === 'System.String'
        && property.value === 'Vendor Alpha'
        && property.readOnly === false
        && property.uiTypeEditor === 'FakeVendor.VendorComplexValueEditor'
        && property.uiTypeEditorAssemblyPath === vendorEditorAssembly
        && property.uiTypeEditorAssemblySha256 === vendorEditorAssemblyHash
        && property.uiTypeEditorCertificationId === 'repo.fakevendor.complex-value.v1';
    }, 'S047 live net48 certified vendor editor metadata was not published', 60_000);

    const appliedVendorEditor = await testApi.editOpenDesignerCertifiedVendorUiTypeEditor(
      vendorEditorUri, 'vendorEdit1', 'ComplexValue');
    assert.deepStrictEqual(appliedVendorEditor, {
      applied: true,
      brokerApplied: true,
      dismissed: false,
      ok: true,
      errorCode: null,
      invariantValue: 'Vendor Beta',
      editorType: 'FakeVendor.VendorComplexValueEditor',
      assemblyPath: vendorEditorAssembly,
      assemblySha256: vendorEditorAssemblyHash,
      certificationId: 'repo.fakevendor.complex-value.v1',
    }, 'S047 did not pass the actual certified editor result through the broker and source transaction');
    const vendorEditorDesignerAfter = testApi.openDesignerState(vendorEditorUri)?.designerText ?? '';
    assert.ok(vendorEditorDesignerAfter.includes('this.vendorEdit1.ComplexValue = "Vendor Beta";'),
      'S047 did not persist the bounded vendor result as one canonical assignment');
    assert.strictEqual(testApi.openDesignerState(vendorEditorUri)?.lastPropertyPersistenceLane, 'ownedRegion',
      'S047 did not use the catalogued LaneB owned-region planner');
    assert.strictEqual(activeCustomTab(vendorEditorUri)?.isDirty, true,
      'S047 vendor edit did not register native history');
    assert.strictEqual(sha256File(vendorEditorSource), vendorEditorSourceHash,
      'S047 vendor edit changed code-behind disk before Save');
    assert.strictEqual(sha256File(vendorEditorDesigner), vendorEditorDesignerHash,
      'S047 vendor edit changed Designer disk before Save');
    await runDesignerHistoryCommand(testApi, vendorEditorUri, 'undo');
    assert.strictEqual(testApi.openDesignerState(vendorEditorUri)?.designerText, vendorEditorDesignerBefore,
      'S047 native Undo did not restore the exact Vendor Alpha baseline');
    assert.strictEqual(activeCustomTab(vendorEditorUri)?.isDirty, false,
      'S047 native Undo did not restore a clean tab');
    await runDesignerHistoryCommand(testApi, vendorEditorUri, 'redo');
    assert.strictEqual(testApi.openDesignerState(vendorEditorUri)?.designerText, vendorEditorDesignerAfter,
      'S047 native Redo did not reapply Vendor Beta exactly');
    await runDesignerHistoryCommand(testApi, vendorEditorUri, 'undo');
    assert.strictEqual(testApi.openDesignerState(vendorEditorUri)?.designerText, vendorEditorDesignerBefore,
      'S047 final native Undo did not restore the exact baseline');

    // Set up the certified editor's deterministic wrong-type result through an ordinary product edit. S048 begins at
    // this dirty baseline and must add neither text nor history; one native Undo must therefore remove the setup edit.
    await testApi.editOpenDesignerProperty(
      vendorEditorUri, 'vendorEdit1', 'ComplexValue', 'System.String', false, '__invalid_object__');
    await waitFor(() => testApi.openDesignerProperties(vendorEditorUri)?.properties
      .find((candidate) => candidate.name === 'ComplexValue')?.value === '__invalid_object__',
    'S048 invalid-result setup value was not published');
    const invalidResultBaseline = testApi.openDesignerState(vendorEditorUri)?.designerText ?? '';
    assert.strictEqual(testApi.openDesignerState(vendorEditorUri)?.lastPropertyPersistenceLane, 'ownedRegion',
      'S048 setup did not retain the certified owned-region lane');
    const invalidVendorEditor = await testApi.editOpenDesignerCertifiedVendorUiTypeEditor(
      vendorEditorUri, 'vendorEdit1', 'ComplexValue');
    assert.deepStrictEqual(invalidVendorEditor, {
      applied: false,
      brokerApplied: false,
      dismissed: false,
      ok: false,
      errorCode: 'INVALID_EDITOR_RESULT',
      invariantValue: null,
      editorType: 'FakeVendor.VendorComplexValueEditor',
      assemblyPath: vendorEditorAssembly,
      assemblySha256: vendorEditorAssemblyHash,
      certificationId: 'repo.fakevendor.complex-value.v1',
    }, 'S048 did not reject the certified editor wrong-type result before mutation');
    assert.strictEqual(testApi.openDesignerState(vendorEditorUri)?.designerText, invalidResultBaseline,
      'S048 invalid editor result changed Designer text');
    assert.strictEqual(activeCustomTab(vendorEditorUri)?.isDirty, true,
      'S048 invalid result disturbed the pre-existing dirty state');
    assert.strictEqual(sha256File(vendorEditorSource), vendorEditorSourceHash,
      'S048 invalid editor result changed code-behind disk');
    assert.strictEqual(sha256File(vendorEditorDesigner), vendorEditorDesignerHash,
      'S048 invalid editor result changed Designer disk');
    await runDesignerHistoryCommand(testApi, vendorEditorUri, 'undo');
    assert.strictEqual(testApi.openDesignerState(vendorEditorUri)?.designerText, vendorEditorDesignerBefore,
      'S048 created a phantom history entry before the setup edit');
    assert.strictEqual(activeCustomTab(vendorEditorUri)?.isDirty, false,
      'S048 single native Undo did not restore the clean pre-setup baseline');

    await testApi.selectOpenDesignerControl(vendorEditorUri, 'vendorEdit1');
    await waitFor(() => {
      const component = testApi.openDesignerProperties(vendorEditorUri);
      const property = component?.properties.find((candidate) => candidate.name === 'Thresholds');
      return component?.id === 'vendorEdit1'
        && component.type === 'FakeVendor.VendorEdit'
        && property?.genericCollection === true
        && property.collectionItemType === 'System.Int32'
        && property.readOnly === false
        && property.uiTypeEditor === 'FakeVendor.VendorThresholdsEditor'
        && property.uiTypeEditorAssemblyPath === vendorEditorAssembly
        && property.uiTypeEditorAssemblySha256 === vendorEditorAssemblyHash
        && property.uiTypeEditorCertificationId === 'repo.fakevendor.thresholds.v1';
    }, 'S071 net48 certified vendor collection metadata was not published', 60_000);

    const net48CollectionApplied = await testApi.editOpenDesignerCertifiedVendorCollectionEditor(
      vendorEditorUri, 'vendorEdit1', 'Thresholds', false);
    assert.deepStrictEqual(net48CollectionApplied, {
      applied: true,
      brokerApplied: true,
      dismissed: false,
      ok: true,
      errorCode: null,
      collectionItems: ['3', '5'],
      editorType: 'FakeVendor.VendorThresholdsEditor',
      assemblyPath: vendorEditorAssembly,
      assemblySha256: vendorEditorAssemblyHash,
      certificationId: 'repo.fakevendor.thresholds.v1',
      persistenceLane: 'ownedRegion',
      refusalReason: null,
    }, 'S071 net48 path did not apply the actual vendor collection result through the bounded transaction');
    const net48CollectionAfter = testApi.openDesignerState(vendorEditorUri)?.designerText ?? '';
    assert.ok(net48CollectionAfter.includes('this.vendorEdit1.Thresholds.Add(3);')
      && net48CollectionAfter.includes('this.vendorEdit1.Thresholds.Add(5);'),
    'S071 net48 collection transaction did not serialize [3,5]');
    assert.ok(!net48CollectionAfter.includes('this.vendorEdit1.Thresholds.Add(1);')
      && !net48CollectionAfter.includes('this.vendorEdit1.Thresholds.Add(2);'),
    'S071 net48 collection transaction retained stale items');
    assert.strictEqual(activeCustomTab(vendorEditorUri)?.isDirty, true,
      'S071 net48 collection transaction did not register native history');
    assert.strictEqual(sha256File(vendorEditorSource), vendorEditorSourceHash,
      'S071 net48 collection transaction changed code-behind disk before Save');
    assert.strictEqual(sha256File(vendorEditorDesigner), vendorEditorDesignerHash,
      'S071 net48 collection transaction changed Designer disk before Save');
    await runDesignerHistoryCommand(testApi, vendorEditorUri, 'undo');
    assert.strictEqual(testApi.openDesignerState(vendorEditorUri)?.designerText, vendorEditorDesignerBefore,
      'S071 net48 native Undo did not restore the exact [1,2] baseline');
    assert.strictEqual(activeCustomTab(vendorEditorUri)?.isDirty, false,
      'S071 net48 native Undo did not restore a clean tab');
    await runDesignerHistoryCommand(testApi, vendorEditorUri, 'redo');
    assert.strictEqual(testApi.openDesignerState(vendorEditorUri)?.designerText, net48CollectionAfter,
      'S071 net48 native Redo did not reapply [3,5] exactly');
    await runDesignerHistoryCommand(testApi, vendorEditorUri, 'undo');
    assert.strictEqual(testApi.openDesignerState(vendorEditorUri)?.designerText, vendorEditorDesignerBefore,
      'S071 net48 final native Undo did not restore the exact baseline');

    const net48CollectionRefused = await testApi.editOpenDesignerCertifiedVendorCollectionEditor(
      vendorEditorUri, 'vendorEdit1', 'Thresholds', true);
    assert.strictEqual(net48CollectionRefused.applied, false,
      'S072 net48 malicious collection proposal changed source');
    assert.strictEqual(net48CollectionRefused.brokerApplied, true,
      'S072 net48 scenario did not first run the actual successful vendor worker');
    assert.strictEqual(net48CollectionRefused.ok, false,
      'S072 net48 malicious collection proposal was reported as successful');
    assert.strictEqual(net48CollectionRefused.errorCode, 'OWNED_REGION_VIOLATION',
      'S072 net48 refusal did not expose the stable owned-region error code');
    assert.deepStrictEqual(net48CollectionRefused.collectionItems, ['3', '5'],
      'S072 net48 refusal lost the actual worker result evidence');
    assert.strictEqual(net48CollectionRefused.persistenceLane, null,
      'S072 net48 refusal incorrectly claimed a persistence lane');
    assert.match(net48CollectionRefused.refusalReason ?? '', /owned-region violation/i,
      'S072 net48 refusal did not retain the engine-owned diagnostic');
    assert.strictEqual(testApi.openDesignerState(vendorEditorUri)?.designerText, vendorEditorDesignerBefore,
      'S072 net48 refusal changed the exact Designer baseline');
    assert.strictEqual(activeCustomTab(vendorEditorUri)?.isDirty, false,
      'S072 net48 refusal registered a native history entry');
    assert.strictEqual(sha256File(vendorEditorSource), vendorEditorSourceHash,
      'S072 net48 refusal changed code-behind disk');
    assert.strictEqual(sha256File(vendorEditorDesigner), vendorEditorDesignerHash,
      'S072 net48 refusal changed Designer disk');
    await runDesignerHistoryCommand(testApi, vendorEditorUri, 'undo');
    assert.strictEqual(testApi.openDesignerState(vendorEditorUri)?.designerText, vendorEditorDesignerBefore,
      'S072 net48 refusal created a phantom native history entry');
    assert.strictEqual(activeCustomTab(vendorEditorUri)?.isDirty, false,
      'S072 net48 no-op Undo disturbed clean state');
  } finally {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    fs.writeFileSync(vendorEditorDesigner, vendorEditorDesignerBefore, 'utf8');
  }

  const writeDataSourcesProject = (
    projectRoot: string,
    namespaceName: string,
    formName: string,
    modelFileName: string,
    modelSource: string,
    targetFramework = 'net10.0-windows',
  ): { source: string; designer: string; project: string; model: string } => {
    fs.mkdirSync(projectRoot, { recursive: true });
    const project = path.join(projectRoot, `${formName}.csproj`);
    const source = path.join(projectRoot, `${formName}.cs`);
    const designer = path.join(projectRoot, `${formName}.Designer.cs`);
    const model = path.join(projectRoot, modelFileName);
    fs.writeFileSync(project, [
      '<Project Sdk="Microsoft.NET.Sdk">',
      '  <PropertyGroup>',
      '    <OutputType>Library</OutputType>',
      `    <TargetFramework>${targetFramework}</TargetFramework>`,
      '    <UseWindowsForms>true</UseWindowsForms>',
      '    <LangVersion>latest</LangVersion>',
      '    <ImplicitUsings>disable</ImplicitUsings>',
      '    <EnableDefaultCompileItems>false</EnableDefaultCompileItems>',
      `    <RootNamespace>${namespaceName}</RootNamespace>`,
      '  </PropertyGroup>',
      '  <ItemGroup>',
      `    <Compile Include="${formName}.cs" />`,
      `    <Compile Include="${formName}.Designer.cs" />`,
      `    <Compile Include="${modelFileName}" />`,
      '  </ItemGroup>',
      '</Project>',
      '',
    ].join('\r\n'), 'utf8');
    fs.writeFileSync(source, [
      `namespace ${namespaceName};`,
      `public partial class ${formName} : System.Windows.Forms.Form`,
      '{',
      `    public ${formName}() => InitializeComponent();`,
      '}',
      '',
    ].join('\r\n'), 'utf8');
    fs.writeFileSync(designer, [
      `namespace ${namespaceName};`,
      `partial class ${formName}`,
      '{',
      '    private System.ComponentModel.IContainer components;',
      '    private void InitializeComponent()',
      '    {',
      '        this.components = new System.ComponentModel.Container();',
      '        this.AutoScaleMode = System.Windows.Forms.AutoScaleMode.Font;',
      '        this.ClientSize = new System.Drawing.Size(640, 420);',
      `        this.Name = "${formName}";`,
      `        this.Text = "${formName}";`,
      '    }',
      '}',
      '',
    ].join('\r\n'), 'utf8');
    fs.writeFileSync(model, modelSource, 'utf8');
    return { source, designer, project, model };
  };

  // V2-FND-001-S082 — open a standalone modern project in the real CustomEditor, refresh the dedicated Data Sources
  // pane from its opaque Customer schema, then drive the same grid-with-navigator drop transaction as the canvas.
  // The complete generated object graph is one unsaved native history unit and every project file stays byte-exact.
  const s082 = writeDataSourcesProject(
    path.join(workspaceFolder.uri.fsPath, 'S082DataSources'),
    'S082DataSources',
    'S082DataSourceForm',
    'Customer.cs',
    [
      'namespace S082DataSources.Models;',
      'public sealed class Customer',
      '{',
      '    public int Id { get; set; }',
      '    public string Name { get; set; } = "";',
      '    public string Email { get; set; } = "";',
      '}',
      '',
    ].join('\r\n'),
  );
  const s082DesignerBefore = fs.readFileSync(s082.designer, 'utf8');
  const s082Hashes = [s082.source, s082.designer, s082.project, s082.model].map(sha256File);
  const s082Uri = vscode.Uri.file(s082.source);
  await vscode.commands.executeCommand('vscode.openWith', s082Uri, designerViewType);
  await waitFor(() => testApi.openDesignerState(s082Uri)?.renderReady === true,
    `S082 modern Data Sources form did not render: ${JSON.stringify(testApi.openDesignerState(s082Uri))}`, 60_000);
  assert.strictEqual(testApi.openDesignerState(s082Uri)?.engineKind, 'modern');
  const s082Catalog = await testApi.listOpenDesignerDataSources(s082Uri);
  assert.strictEqual(s082Catalog.ok, true, `S082 Data Sources refresh refused: ${s082Catalog.reason}`);
  assert.strictEqual(s082Catalog.refusalCode, null);
  const s082Schema = s082Catalog.schemas.find((schema) => schema.typeName === 'S082DataSources.Models.Customer');
  assert.ok(s082Schema, `S082 Customer schema was not published: ${JSON.stringify(s082Catalog.schemas)}`);
  assert.deepStrictEqual(s082Schema.properties.map((property) => property.name), ['Id', 'Name', 'Email']);
  const s082Generated = await testApi.generateOpenDesignerDataSource(
    s082Uri, s082Schema.key, 'grid', 'this', 36, 78, true, null, null);
  assert.strictEqual(s082Generated.safe, true, `S082 grid/navigator generation refused: ${s082Generated.reason}`);
  assert.strictEqual(s082Generated.refusalCode, null);
  assert.deepStrictEqual(new Set(s082Generated.createdIds), new Set([
    'customerBindingSource1', 'customerDataGridView1', 'idColumn1', 'nameColumn1', 'emailColumn1', 'bindingNavigator1',
  ]));
  const s082DesignerAfter = testApi.openDesignerState(s082Uri)?.designerText ?? '';
  assert.ok(s082DesignerAfter.includes(
    'this.customerBindingSource1.DataSource = typeof(S082DataSources.Models.Customer);'));
  assert.ok(s082DesignerAfter.includes(
    'this.customerDataGridView1.Columns.AddRange(new System.Windows.Forms.DataGridViewColumn[] { this.idColumn1, this.nameColumn1, this.emailColumn1 });'));
  for (const propertyName of ['Id', 'Name', 'Email']) {
    assert.ok(s082DesignerAfter.includes(`.DataPropertyName = "${propertyName}";`),
      `S082 omitted the ${propertyName} grid column`);
  }
  assert.ok(s082DesignerAfter.includes(
    'this.bindingNavigator1.BindingSource = this.customerBindingSource1;'));
  assert.ok(testApi.openDesignerState(s082Uri)?.controls.some((control) => control.id === 'customerDataGridView1'));
  assert.ok(testApi.openDesignerState(s082Uri)?.controls.some((control) => control.id === 'bindingNavigator1'));
  assert.ok(testApi.openDesignerState(s082Uri)?.tray.some((component) => component.id === 'customerBindingSource1'));
  assert.strictEqual(testApi.openDesignerState(s082Uri)?.dirty, true);
  [s082.source, s082.designer, s082.project, s082.model].forEach((file, index) => {
    assert.strictEqual(sha256File(file), s082Hashes[index], `S082 unsaved transaction changed ${path.basename(file)} disk`);
  });
  await runDesignerHistoryCommand(testApi, s082Uri, 'undo');
  await waitFor(() => testApi.openDesignerState(s082Uri)?.designerText === s082DesignerBefore
    && testApi.openDesignerState(s082Uri)?.dirty === false,
  'S082 one native Undo did not restore the exact clean Designer baseline');
  await runDesignerHistoryCommand(testApi, s082Uri, 'redo');
  await waitFor(() => testApi.openDesignerState(s082Uri)?.designerText === s082DesignerAfter,
    'S082 one native Redo did not restore the complete grid/navigator graph');
  await runDesignerHistoryCommand(testApi, s082Uri, 'undo');
  await waitFor(() => testApi.openDesignerState(s082Uri)?.designerText === s082DesignerBefore
    && testApi.openDesignerState(s082Uri)?.dirty === false,
  'S082 final native Undo did not restore the exact clean baseline');
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');

  // V2-FND-001-S084 — an EF-shaped provider is discovered only as unsupported. The real panel refresh publishes a
  // typed diagnostic and the real canvas-generation ingress returns the same refusal before source/history/disk edits.
  const s084 = writeDataSourcesProject(
    path.join(workspaceFolder.uri.fsPath, 'S084UnsupportedProvider'),
    'S084UnsupportedProvider',
    'S084ProviderForm',
    'CustomerContext.cs',
    [
      'namespace S084UnsupportedProvider.Data;',
      'public sealed class CustomerContext',
      '{',
      '    public Microsoft.EntityFrameworkCore.DbSet<Customer> Customers { get; set; }',
      '}',
      'public sealed class Customer',
      '{',
      '    public object Payload { get; set; } = new object();',
      '}',
      '',
    ].join('\r\n'),
  );
  const s084DesignerBefore = fs.readFileSync(s084.designer, 'utf8');
  const s084Hashes = [s084.source, s084.designer, s084.project, s084.model].map(sha256File);
  const s084Uri = vscode.Uri.file(s084.source);
  await vscode.commands.executeCommand('vscode.openWith', s084Uri, designerViewType);
  await waitFor(() => testApi.openDesignerState(s084Uri)?.renderReady === true,
    `S084 modern unsupported-provider form did not render: ${JSON.stringify(testApi.openDesignerState(s084Uri))}`,
    60_000);
  assert.strictEqual(testApi.openDesignerState(s084Uri)?.engineKind, 'modern');
  const s084Catalog = await testApi.listOpenDesignerDataSources(s084Uri);
  assert.strictEqual(s084Catalog.ok, false, 'S084 exposed an unsupported provider as a schema');
  assert.strictEqual(s084Catalog.refusalCode, 'UNSUPPORTED_DATA_PROVIDER');
  assert.match(s084Catalog.reason, /unsupported data provider: S084UnsupportedProvider\.Data\.CustomerContext/);
  assert.deepStrictEqual(s084Catalog.schemas, []);
  const s084Refused = await testApi.generateOpenDesignerDataSource(
    s084Uri, 'schema:S084UnsupportedProvider.Data.CustomerContext', 'grid', 'this', 36, 78, false, null, null);
  assert.strictEqual(s084Refused.safe, false);
  assert.strictEqual(s084Refused.refusalCode, 'UNSUPPORTED_DATA_PROVIDER');
  assert.match(s084Refused.reason, /unsupported data provider/);
  assert.strictEqual(s084Refused.newText, null);
  assert.deepStrictEqual(s084Refused.createdIds, []);
  assert.strictEqual(testApi.openDesignerState(s084Uri)?.designerText, s084DesignerBefore);
  assert.strictEqual(testApi.openDesignerState(s084Uri)?.dirty, false);
  assert.strictEqual(activeCustomTab(s084Uri)?.isDirty, false);
  [s084.source, s084.designer, s084.project, s084.model].forEach((file, index) => {
    assert.strictEqual(sha256File(file), s084Hashes[index], `S084 refusal changed ${path.basename(file)} disk`);
  });
  await runDesignerHistoryCommand(testApi, s084Uri, 'undo');
  assert.strictEqual(testApi.openDesignerState(s084Uri)?.designerText, s084DesignerBefore,
    'S084 refusal created a phantom native history entry');
  assert.strictEqual(activeCustomTab(s084Uri)?.isDirty, false);
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');

  const s084Net48 = writeDataSourcesProject(
    path.join(workspaceFolder.uri.fsPath, 'S084UnsupportedProviderNet48'),
    'S084UnsupportedProviderNet48',
    'S084ProviderNet48Form',
    'CustomerContext.cs',
    [
      'namespace S084UnsupportedProviderNet48.Data;',
      'public sealed class CustomerContext',
      '{',
      '    public void Query() { }',
      '}',
      '',
    ].join('\r\n'),
    'net48',
  );
  try {
    execFileSync(
      process.platform === 'win32' ? 'dotnet.exe' : 'dotnet',
      ['build', s084Net48.project, '-c', 'Release', '-p:PlatformTarget=x64', '--nologo', '-v:q'],
      { cwd: workspaceFolder.uri.fsPath, stdio: 'pipe' },
    );
  } catch (error) {
    const failure = error as { message?: string; stdout?: Buffer | string; stderr?: Buffer | string };
    throw new Error([
      `S084 net48 fixture build failed: ${failure.message ?? String(error)}`,
      `stdout: ${failure.stdout?.toString() ?? ''}`,
      `stderr: ${failure.stderr?.toString() ?? ''}`,
    ].join('\n'));
  }
  const s084Net48DesignerBefore = fs.readFileSync(s084Net48.designer, 'utf8');
  const s084Net48Hashes = [s084Net48.source, s084Net48.designer, s084Net48.project, s084Net48.model].map(sha256File);
  const s084Net48Uri = vscode.Uri.file(s084Net48.source);
  await vscode.commands.executeCommand('vscode.openWith', s084Net48Uri, designerViewType);
  await waitFor(() => testApi.openDesignerState(s084Net48Uri)?.renderReady === true,
    `S084 net48 unsupported-provider form did not render: ${JSON.stringify(testApi.openDesignerState(s084Net48Uri))}`,
    60_000);
  assert.strictEqual(testApi.openDesignerState(s084Net48Uri)?.engineKind, 'net48');
  const s084Net48Catalog = await testApi.listOpenDesignerDataSources(s084Net48Uri);
  assert.strictEqual(s084Net48Catalog.ok, false);
  assert.strictEqual(s084Net48Catalog.refusalCode, 'UNSUPPORTED_DATA_PROVIDER');
  assert.match(s084Net48Catalog.reason,
    /unsupported data provider: S084UnsupportedProviderNet48\.Data\.CustomerContext/);
  const s084Net48Refused = await testApi.generateOpenDesignerDataSource(
    s084Net48Uri, 'schema:S084UnsupportedProviderNet48.Data.CustomerContext',
    'grid', 'this', 36, 78, false, null, null);
  assert.strictEqual(s084Net48Refused.safe, false);
  assert.strictEqual(s084Net48Refused.refusalCode, 'UNSUPPORTED_DATA_PROVIDER');
  assert.strictEqual(s084Net48Refused.newText, null);
  assert.deepStrictEqual(s084Net48Refused.createdIds, []);
  assert.strictEqual(testApi.openDesignerState(s084Net48Uri)?.designerText, s084Net48DesignerBefore);
  assert.strictEqual(testApi.openDesignerState(s084Net48Uri)?.dirty, false);
  assert.strictEqual(activeCustomTab(s084Net48Uri)?.isDirty, false);
  [s084Net48.source, s084Net48.designer, s084Net48.project, s084Net48.model].forEach((file, index) => {
    assert.strictEqual(sha256File(file), s084Net48Hashes[index],
      `S084 net48 refusal changed ${path.basename(file)} disk`);
  });
  await runDesignerHistoryCommand(testApi, s084Net48Uri, 'undo');
  assert.strictEqual(testApi.openDesignerState(s084Net48Uri)?.designerText, s084Net48DesignerBefore,
    'S084 net48 refusal created a phantom native history entry');
  assert.strictEqual(activeCustomTab(s084Net48Uri)?.isDirty, false);
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  // Isolated so one failing tail scenario no longer skips the rest — including the S003 setup below, whose evidence
  // the runner requires. See section().
  await section(['V2-FND-001-S104'], () => runS104IdleRecycleScenario(testApi, groupUri, net48Uri));
  await section(['V2-FND-001-S079', 'V2-FND-001-S101', 'V2-FND-001-S105'],
    () => runS079S101S105ProductScenarios(testApi, net48Uri));
  await section(['V2-FND-001-S095'], () => runS095HostedDesignerQuarantineScenario(testApi));
  await section(['V2-FND-001-S089', 'V2-FND-001-S090'], () => runS089S090HostedServiceKernelScenario(testApi));
  await section(['V2-FND-001-S091', 'V2-FND-001-S092'], () => runS091S092HostedServiceCancellationScenario(testApi));
  await section(['V2-FND-001-S097', 'V2-FND-001-S099'], () => runS097S099AdapterManifestRegistryScenario(testApi));
  await section(['V2-FND-001-S100', 'V2-FND-001-S108'], () => runS100S108VisualStudioRoundTripScenario(testApi));
  await section(['V2-FND-001-S016'], () => runS016DenseProductPerformanceScenario(testApi));
  await section(['V2-FND-001-S122'], () => runS122ProductPerformanceValidationScenario(testApi));
  await section(['V2-FND-001-S126', 'V2-FND-001-S128'], () => runS126HighDpiAdvisorScenario(testApi));
  await section(['V2-FND-001-S124'], () => runS124ProductWorkerCrashContinuation(testApi));
  // V2-FND-001-S003 setup half — leave exactly one unsaved move / one native undo unit in a real modern document and
  // one compiled-net48 document. The runner now terminates this VS Code process normally, preserves its user-data and
  // workspace, and launches the restore-only process above. No direct provider seam or synthetic backup id is used.
  const s003Documents: {
    label: string;
    engineKind: 'modern' | 'net48';
    sourceRelative: string;
    designerRelative: string;
    before: string;
    after: string;
    sourceHash: string;
    designerHash: string;
  }[] = [];
  for (const target of [
    { label: 'modern', engineKind: 'modern' as const, uri: groupUri, source: groupSource, designer: groupDesigner, dx: 13, dy: 7 },
    { label: 'compiled-net48', engineKind: 'net48' as const, uri: net48Uri, source: net48Source, designer: net48Designer, dx: 11, dy: 6 },
  ]) {
    const before = fs.readFileSync(target.designer, 'utf8');
    const sourceHash = sha256File(target.source);
    const designerHash = sha256File(target.designer);
    await vscode.commands.executeCommand('vscode.openWith', target.uri, designerViewType);
    await waitFor(
      () => testApi.openDesignerState(target.uri)?.renderReady === true,
      `S003 ${target.label} setup form did not render`,
      60_000,
    );
    assert.strictEqual(testApi.openDesignerState(target.uri)?.engineKind, target.engineKind);
    assert.strictEqual(testApi.openDesignerState(target.uri)?.designerText, before);
    await testApi.moveOpenDesignerGroup(target.uri, ['button1'], target.dx, target.dy);
    await waitFor(
      () => testApi.openDesignerState(target.uri)?.dirty === true
        && testApi.openDesignerState(target.uri)?.designerText !== before
        && activeCustomTab(target.uri)?.isDirty === true,
      `S003 ${target.label} setup move did not create one dirty native history unit`,
      60_000,
    );
    const after = testApi.openDesignerState(target.uri)?.designerText ?? '';
    assert.notStrictEqual(after, before);
    assert.strictEqual(sha256File(target.source), sourceHash);
    assert.strictEqual(sha256File(target.designer), designerHash);
    s003Documents.push({
      label: target.label,
      engineKind: target.engineKind,
      sourceRelative: path.relative(workspaceFolder.uri.fsPath, target.source),
      designerRelative: path.relative(workspaceFolder.uri.fsPath, target.designer),
      before,
      after,
      sourceHash,
      designerHash,
    });
  }
  fs.writeFileSync(
    path.join(workspaceFolder.uri.fsPath, '.wfd-s003-hot-exit.json'),
    `${JSON.stringify({ scenarioId: 'V2-FND-001-S003', documents: s003Documents }, null, 2)}\n`,
    'utf8',
  );
  // After the S003 evidence, so a ledger-write failure can never cost S003 its artifact, and before the terminal
  // quit, which stops run() from ever resolving.
  writeScenarioLedger(workspaceFolder.uri.fsPath);
  // Let VS Code's ordinary hot-exit debounce observe both dirty documents, then close the workbench through its real
  // quit command. Merely returning from extensionTestsPath makes @vscode/test-electron tear down the test host and can
  // bypass editor-session persistence; S003 specifically requires the same shutdown path a user invokes in the IDE.
  await new Promise((resolve) => setTimeout(resolve, 2_500));
  await vscode.commands.executeCommand('workbench.action.quit');
  // Do not let the extension-test runner race the workbench shutdown by treating the suite as completed. The main
  // process exits this host after it has persisted CustomDocument backups and editor state, resolving runTests itself.
  await new Promise<never>(() => undefined);
}

async function runS104IdleRecycleScenario(
  testApi: ExtensionHostTestApi,
  modernUri: vscode.Uri,
  net48Uri: vscode.Uri,
): Promise<void> {
  // V2-FND-001-S104 — exercise the product's last-session idle timer, not the diagnostics-only supervisor. Repeated
  // clean reopen/close cycles must reuse the warm pair; the armed final close uses the same timer/zero-session/stop
  // path with only its delay shortened, then proves both OS processes and every host-owned process registration exit.
  await waitFor(
    () => testApi.engineLifecycleState().openDesignerSessions === 0,
    'S104 precondition: previous CustomEditor sessions did not close',
    30_000,
  );

  const openPair = async (label: string) => {
    await vscode.commands.executeCommand('vscode.openWith', modernUri, designerViewType);
    await waitFor(
      () => testApi.openDesignerState(modernUri)?.renderReady === true
        && testApi.openDesignerState(modernUri)?.engineKind === 'modern',
      `S104 ${label}: modern CustomEditor did not render`,
      60_000,
    );
    await vscode.commands.executeCommand('vscode.openWith', net48Uri, designerViewType);
    await waitFor(
      () => testApi.openDesignerState(net48Uri)?.renderReady === true
        && testApi.openDesignerState(net48Uri)?.engineKind === 'net48',
      `S104 ${label}: compiled-net48 CustomEditor did not render`,
      60_000,
    );
    const state = testApi.engineLifecycleState();
    assert.strictEqual(state.openDesignerSessions, 2, `S104 ${label}: expected exactly two open product sessions`);
    assert.deepStrictEqual(state.mappedEngines.map((engine) => engine.kind), ['modern', 'net48']);
    assert.ok(state.mappedEngines.every((engine) => engine.running && engine.pid > 0));
    assert.strictEqual(state.liveProcessPids.length, 2, `S104 ${label}: leaked an unowned engine process`);
    assert.strictEqual(state.idleRecycleBudgetMs, 30_000);
    return {
      modern: state.mappedEngines.find((engine) => engine.kind === 'modern')!.pid,
      net48: state.mappedEngines.find((engine) => engine.kind === 'net48')!.pid,
    };
  };

  let residentPids = await openPair('cycle 1');
  for (let cycle = 2; cycle <= 3; cycle++) {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await waitFor(
      () => testApi.engineLifecycleState().openDesignerSessions === 0,
      `S104 cycle ${cycle - 1}: sessions did not close`,
      30_000,
    );
    const nextPids = await openPair(`cycle ${cycle}`);
    assert.strictEqual(nextPids.modern, residentPids.modern,
      `S104 cycle ${cycle}: healthy modern warm worker was not reused`);
    if (nextPids.net48 !== residentPids.net48) {
      // Closing the last framework form deliberately unloads its AppDomain so the user's build output is writable.
      // If that unload fails, the fail-closed product path replaces the whole net48 worker; replacement is correct
      // only when the old process is gone and the two-process residency budget above still holds exactly.
      const replacedPid = residentPids.net48;
      await waitFor(() => {
        try { process.kill(replacedPid, 0); return false; } catch { return true; }
      }, `S104 cycle ${cycle}: replaced net48 PID ${replacedPid} still exists`, 10_000);
    }
    residentPids = nextPids;
  }

  testApi.armNextIdleEngineRecycle(100);
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await waitFor(
    () => {
      const state = testApi.engineLifecycleState();
      return state.openDesignerSessions === 0 && state.mappedEngines.length === 0
        && state.liveProcessPids.length === 0 && !state.idleRecycleScheduled && !state.idleRecycleInFlight;
    },
    `S104 idle recycle did not return to the zero-process budget: ${JSON.stringify(testApi.engineLifecycleState())}`,
    30_000,
  );
  for (const pid of Object.values(residentPids)) {
    let alive = true;
    try { process.kill(pid, 0); } catch { alive = false; }
    assert.strictEqual(alive, false, `S104 engine PID ${pid} still exists after idle recycle`);
  }

  const freshPids = await openPair('fresh restart');
  const exitedPids = Object.values(residentPids);
  assert.ok(Object.values(freshPids).every((pid) => !exitedPids.includes(pid)),
    `S104 fresh designer reused an exited worker PID: ${Object.values(freshPids).join(', ')}`);
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await waitFor(
    () => testApi.engineLifecycleState().openDesignerSessions === 0,
    'S104 fresh-restart sessions did not close',
    30_000,
  );
}

async function runS079S101S105ProductScenarios(testApi: ExtensionHostTestApi, net48Uri: vscode.Uri): Promise<void> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(workspaceFolder, 'S079/S101/S105 require the disposable Extension Host workspace');
  assert.strictEqual(process.arch, 'x64', 'S079/S101/S105 x64 catalog legs must run in an x64 Extension Host');
  const workspaceRoot = workspaceFolder.uri.fsPath;

  // V2-FND-001-S101 — use an actual nested SDK project targeting the advertised net8.0-windows floor. The registered
  // CustomEditor must resolve that exact project and route its live source to the real modern worker, not merely return
  // the same choice from the isolated workerSelection helper.
  const net8Root = path.join(workspaceRoot, 'fixtures', 'S101Net8');
  fs.mkdirSync(net8Root, { recursive: true });
  const net8Project = path.join(net8Root, 'S101Net8.csproj');
  const net8Source = path.join(net8Root, 'Net8Form.cs');
  const net8Designer = path.join(net8Root, 'Net8Form.Designer.cs');
  fs.writeFileSync(net8Project, [
    '<Project Sdk="Microsoft.NET.Sdk">',
    '  <PropertyGroup><TargetFramework>net8.0-windows</TargetFramework><UseWindowsForms>true</UseWindowsForms></PropertyGroup>',
    '</Project>',
    '',
  ].join('\r\n'), 'utf8');
  fs.writeFileSync(net8Source,
    'namespace S101Net8; public partial class Net8Form : System.Windows.Forms.Form { public Net8Form() => InitializeComponent(); }\r\n',
    'utf8');
  fs.writeFileSync(net8Designer, [
    'namespace S101Net8;',
    'partial class Net8Form',
    '{',
    '    private System.Windows.Forms.Button button1;',
    '    private void InitializeComponent()',
    '    {',
    '        this.button1 = new System.Windows.Forms.Button();',
    '        this.button1.Location = new System.Drawing.Point(24, 32);',
    '        this.button1.Name = "button1";',
    '        this.Controls.Add(this.button1);',
    '        this.Name = "Net8Form";',
    '    }',
    '}',
    '',
  ].join('\r\n'), 'utf8');
  const net8Uri = vscode.Uri.file(net8Source);
  await vscode.commands.executeCommand('vscode.openWith', net8Uri, designerViewType);
  await waitFor(() => testApi.openDesignerState(net8Uri)?.renderReady === true,
    `S101 net8.0-windows product form did not render: ${JSON.stringify(testApi.openDesignerState(net8Uri))}`, 60_000);
  const net8State = testApi.openDesignerState(net8Uri);
  assert.strictEqual(net8State?.engineKind, 'modern');
  assert.strictEqual(path.resolve(net8State?.ownerProjectPath ?? '').toLowerCase(), path.resolve(net8Project).toLowerCase(),
    'S101 product ownership did not resolve the exact net8.0-windows project');
  assert.ok(testApi.engineLifecycleState().mappedEngines.some((engine) => engine.kind === 'modern' && engine.running),
    'S101 product render did not own a live modern worker');
  assert.strictEqual(net8State?.dirty, false, 'S101 read-only runtime selection dirtied the form');
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

  // V2-FND-001-S105 — reopen a real source member of the freshly built net48 multi-target fixture. The product owner
  // and output resolver must choose the compiled-net48 x64 worker and publish a successful CustomEditor render.
  await vscode.commands.executeCommand('vscode.openWith', net48Uri, designerViewType);
  await waitFor(() => testApi.openDesignerState(net48Uri)?.renderReady === true,
    `S105 net48 product form did not render: ${JSON.stringify(testApi.openDesignerState(net48Uri))}`, 60_000);
  const net48State = testApi.openDesignerState(net48Uri);
  assert.strictEqual(net48State?.engineKind, 'net48');
  assert.strictEqual(net48State?.net48RenderMode, 'interpreted',
    'S105 net48 product route did not publish live-source interpreted authority');
  assert.strictEqual(path.basename(net48State?.ownerProjectPath ?? ''), 'Net48CtxFixture.csproj',
    'S105 product ownership did not resolve the framework fixture project');
  assert.match(fs.readFileSync(net48State?.ownerProjectPath ?? '', 'utf8'), /<TargetFrameworks>net48;net10\.0-windows<\/TargetFrameworks>/,
    'S105 resolved project does not advertise the required net48 target');
  assert.ok(testApi.engineLifecycleState().mappedEngines.some((engine) => engine.kind === 'net48' && engine.running),
    'S105 product render did not own a live compiled-net48 worker');
  assert.strictEqual(net48State?.dirty, false, 'S105 read-only runtime selection dirtied the form');
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

  // V2-FND-001-S079 — select ar-SA through the real Language product path on a compiled-net48 form. The next captured
  // window-space layout must mirror both child rectangles exactly around the form frame while keeping Y/size stable.
  const rtlRoot = path.join(workspaceRoot, 'fixtures', 'Net48CtxFixture');
  const rtlSource = path.join(rtlRoot, 'LocalizableForm.cs');
  const rtlArtifacts = [rtlSource, path.join(rtlRoot, 'LocalizableForm.Designer.cs'),
    path.join(rtlRoot, 'LocalizableForm.resx'), path.join(rtlRoot, 'LocalizableForm.ar-SA.resx')];
  rtlArtifacts.forEach((file) => assert.ok(fs.existsSync(file), `S079 fixture is missing: ${file}`));
  const rtlHashes = rtlArtifacts.map(sha256File);
  const rtlUri = vscode.Uri.file(rtlSource);
  await vscode.commands.executeCommand('vscode.openWith', rtlUri, designerViewType);
  await waitFor(() => testApi.openDesignerState(rtlUri)?.renderReady === true,
    `S079 neutral net48 form did not render: ${JSON.stringify(testApi.openDesignerState(rtlUri))}`, 60_000);
  assert.strictEqual(testApi.openDesignerState(rtlUri)?.engineKind, 'net48');
  const neutralGeneration = testApi.openDesignerState(rtlUri)?.renderGeneration ?? -1;
  const neutralLayout = testApi.openDesignerLayout(rtlUri);
  const neutralRoot = neutralLayout.find((entry) => entry.id === 'this');
  const neutralButton = neutralLayout.find((entry) => entry.id === 'button1');
  const neutralLabel = neutralLayout.find((entry) => entry.id === 'label1');
  assert.ok(neutralRoot && neutralButton && neutralLabel, `S079 neutral layout is incomplete: ${JSON.stringify(neutralLayout)}`);
  assert.strictEqual(await testApi.setOpenDesignerLocalizationCulture(rtlUri, 'ar-SA'), true,
    'S079 product Language selector did not accept the discovered ar-SA resource');
  await waitFor(() => (testApi.openDesignerState(rtlUri)?.renderGeneration ?? -1) > neutralGeneration
    && testApi.openDesignerLayout(rtlUri).some((entry) => entry.id === 'button1'
      && entry.x === neutralRoot.width - neutralButton.x - neutralButton.width),
  `S079 ar-SA product render did not publish the mirrored window-space layout: ${JSON.stringify(testApi.openDesignerLayout(rtlUri))}`,
  60_000);
  const rtlLayout = testApi.openDesignerLayout(rtlUri);
  for (const neutral of [neutralButton, neutralLabel]) {
    const mirrored = rtlLayout.find((entry) => entry.id === neutral.id);
    assert.ok(mirrored, `S079 mirrored layout lost ${neutral.id}`);
    assert.strictEqual(mirrored.x, neutralRoot.width - neutral.x - neutral.width, `S079 ${neutral.id} X was not mirrored`);
    assert.strictEqual(mirrored.y, neutral.y, `S079 ${neutral.id} Y changed during RTL mirroring`);
    assert.strictEqual(mirrored.width, neutral.width, `S079 ${neutral.id} width changed during RTL mirroring`);
    assert.strictEqual(mirrored.height, neutral.height, `S079 ${neutral.id} height changed during RTL mirroring`);
  }
  await testApi.selectOpenDesignerControl(rtlUri, 'button1');
  await waitFor(() => testApi.openDesignerProperties(rtlUri)?.properties.some((property) =>
    property.name === 'Text' && property.value === 'اضغط هنا') === true,
  'S079 ar-SA compiled property metadata did not follow the exact resource overlay');
  assert.strictEqual(testApi.openDesignerState(rtlUri)?.dirty, false,
    'S079 Language selection and RTL render created a native history mutation');
  rtlArtifacts.forEach((file, index) => assert.strictEqual(sha256File(file), rtlHashes[index],
    `S079 read-only RTL scenario changed ${path.basename(file)} on disk`));
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await waitFor(() => testApi.engineLifecycleState().openDesignerSessions === 0,
    'S079/S101/S105 product sessions did not close', 30_000);
}

async function runS016DenseProductPerformanceScenario(testApi: ExtensionHostTestApi): Promise<void> { // V2-FND-001-S016
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(workspaceFolder, 'S016 requires the disposable Extension Host workspace');
  assert.strictEqual(process.arch, 'x64', 'S016 catalog x64 leg must run in an x64 Extension Host');
  const workspaceRoot = workspaceFolder.uri.fsPath;
  const initialInteractiveBudgetMs = 5_000;
  const commitAndReconciliationBudgetMs = 500;

  const exercise = async (
    fixtureName: 'Net48CtxFixtureModern' | 'Net48CtxFixture',
    expectedEngine: 'modern' | 'net48',
  ): Promise<void> => {
    const root = path.join(workspaceRoot, 'fixtures', fixtureName);
    const source = path.join(root, 'S016DenseForm.cs');
    const designer = path.join(root, 'S016DenseForm.Designer.cs');
    const project = path.join(root, 'Net48CtxFixture.csproj');
    const artifacts = [source, designer, project];
    artifacts.forEach((file) => assert.ok(fs.existsSync(file), `S016 fixture is missing: ${file}`));
    const hashes = artifacts.map(sha256File);
    const baseline = fs.readFileSync(designer, 'utf8');
    const uri = vscode.Uri.file(source);

    const openedAt = Date.now();
    await vscode.commands.executeCommand('vscode.openWith', uri, designerViewType);
    await waitFor(
      () => testApi.openDesignerState(uri)?.renderReady === true
        && testApi.openDesignerLayout(uri).length === 301,
      `S016 ${expectedEngine} 300-control product form did not publish 301 layout nodes: ${JSON.stringify(testApi.openDesignerState(uri))}`,
      60_000,
    );
    const initialInteractiveMs = Date.now() - openedAt;
    const openedState = testApi.openDesignerState(uri);
    assert.strictEqual(openedState?.engineKind, expectedEngine);
    assert.strictEqual(openedState?.controls.length, 301,
      `S016 ${expectedEngine} product state lost controls from the 300-control graph`);
    assert.strictEqual(path.resolve(openedState?.ownerProjectPath ?? '').toLowerCase(), path.resolve(project).toLowerCase(),
      `S016 ${expectedEngine} product ownership did not resolve the exact dense-form project`);
    assert.ok(initialInteractiveMs <= initialInteractiveBudgetMs,
      `S016 ${expectedEngine} initial model/capture/preview ${initialInteractiveMs}ms > ${initialInteractiveBudgetMs}ms`);
    assert.strictEqual(openedState?.dirty, false);

    // Selection is its own VS interaction (hit-test -> Properties/geometry hydration), not part of the frozen
    // property-commit budget. Exercise it through the real product selection path and wait for the exact Text row
    // before starting the commit clock; otherwise this assertion accidentally measures two interactions together.
    await testApi.selectOpenDesignerControl(uri, 'button000');
    await waitFor(
      () => testApi.openDesignerState(uri)?.currentId === 'button000'
        && testApi.openDesignerState(uri)?.selectedPropertyComponent?.properties.some(
          (property) => property.name === 'Text' && property.value === 'Button 000') === true,
      `S016 ${expectedEngine} dense button selection did not hydrate its real Properties metadata`,
      60_000,
    );

    const generation = testApi.openDesignerState(uri)?.renderGeneration ?? 0;
    const committedAt = Date.now();
    await testApi.editOpenDesignerProperty(uri, 'button000', 'Text', 'System.String', false, 'Timed commit');
    await waitFor(
      () => (testApi.openDesignerState(uri)?.renderGeneration ?? 0) > generation
        && testApi.openDesignerState(uri)?.renderReady === true
        && testApi.openDesignerLayout(uri).length === 301,
      `S016 ${expectedEngine} property commit did not reconcile the complete 300-control graph`,
      60_000,
    );
    const commitAndReconciliationMs = Date.now() - committedAt;
    const committedState = testApi.openDesignerState(uri);
    if (expectedEngine === 'net48') {
      assert.strictEqual(committedState?.lastNet48PropertyEditTelemetry?.snapshotComponentId, 'button000',
        'S016 net48 dirty snapshot did not carry exact same-instance button000 metadata');
      assert.strictEqual(committedState?.lastNet48PropertyEditTelemetry?.componentInSnapshot, true,
        'S016 net48 dirty snapshot metadata was not accepted for the selected component');
      assert.strictEqual(committedState?.lastNet48PropertyEditTelemetry?.propertiesReconciled, true,
        'S016 net48 Properties panel required a second describe instead of same-snapshot reconciliation');
      assert.strictEqual(committedState?.lastNet48PropertyEditTelemetry?.trailingPropertiesMs, 0,
        'S016 net48 same-snapshot reconciliation unexpectedly issued a trailing Properties load');
    } else {
      assert.strictEqual(committedState?.lastModernPropertyEditTelemetry?.retainedApplied, true,
        'S016 modern commit rebuilt the graph instead of reconciling the retained DesignSurface');
      assert.strictEqual(committedState?.lastModernPropertyEditTelemetry?.trailingPropertiesMs, 0,
        'S016 modern retained snapshot unexpectedly issued a trailing Properties load');
    }
    assert.ok(commitAndReconciliationMs <= commitAndReconciliationBudgetMs,
      `S016 ${expectedEngine} commit/reconciliation ${commitAndReconciliationMs}ms > ${commitAndReconciliationBudgetMs}ms; phases=${JSON.stringify(expectedEngine === 'net48'
        ? committedState?.lastNet48PropertyEditTelemetry
        : committedState?.lastModernPropertyEditTelemetry)}`);
    assert.strictEqual(committedState?.dirty, true,
      `S016 ${expectedEngine} property commit did not create one native CustomDocument history unit`);
    assert.match(committedState?.designerText ?? '', /this\.button000\.Text = "Timed commit";/);
    artifacts.forEach((file, index) => assert.strictEqual(sha256File(file), hashes[index],
      `S016 ${expectedEngine} unsaved product transaction changed ${path.basename(file)} on disk`));
    console.log(`S016 ${expectedEngine}: initial ${initialInteractiveMs}ms; selected Text commit/reconciliation ${commitAndReconciliationMs}ms; 301 layout nodes; disk byte-exact`);

    await runDesignerHistoryCommand(testApi, uri, 'undo');
    await waitFor(() => testApi.openDesignerState(uri)?.dirty === false
      && testApi.openDesignerState(uri)?.designerText === baseline,
    `S016 ${expectedEngine} native Undo did not restore the exact 300-control baseline`, 30_000);
    artifacts.forEach((file, index) => assert.strictEqual(sha256File(file), hashes[index],
      `S016 ${expectedEngine} Undo changed ${path.basename(file)} on disk`));
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  };

  const engineFilter = process.env.WFD_S016_ENGINE?.trim();
  if (!engineFilter || engineFilter === 'modern') await exercise('Net48CtxFixtureModern', 'modern');
  if (!engineFilter || engineFilter === 'net48') await exercise('Net48CtxFixture', 'net48');
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await waitFor(() => testApi.engineLifecycleState().openDesignerSessions === 0,
    'S016 dense product sessions did not close', 30_000);
}

interface S122ProductTarget {
  readonly label: string;
  readonly uri: vscode.Uri;
  readonly designer: string;
  readonly project: string;
  readonly expectedEngine: 'modern' | 'net48';
  readonly expectedControlCount: number;
  readonly selectedId: string;
  readonly baselinePropertyText: string;
  readonly artifacts: readonly string[];
  readonly hashes: readonly string[];
  readonly baselineDesignerText: string;
}

interface S122RenderObservation {
  readonly modelMs: number;
  readonly captureMs: number;
  readonly previewMs: number;
  readonly reconciliationMs: number;
}

interface S122EditObservation {
  readonly plannerMs: number;
  readonly commitMs: number;
  readonly reconciliationMs: number;
}

/** V2-FND-001-S122 — the headless budget classifier consumes timings captured only from real CustomEditor sessions.
 * Each frozen logical-DPI leg forces the product render path over the canonical 50-control, 300-control (modern and
 * net48), and 180-control/96-FakeVendor corpora, then performs one real Text commit plus native Undo per target. */
async function runS122ProductPerformanceValidationScenario(testApi: ExtensionHostTestApi): Promise<void> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(workspaceFolder, 'S122 requires the disposable Extension Host workspace');
  assert.strictEqual(process.arch, 'x64', 'S122 repository performance evidence is the catalog x64 leg');
  const workspaceRoot = workspaceFolder.uri.fsPath;

  const target = (
    label: string,
    root: string,
    className: string,
    expectedEngine: 'modern' | 'net48',
    expectedControlCount: number,
    selectedId: string,
    baselinePropertyText: string,
  ): S122ProductTarget => {
    const source = path.join(root, `${className}.cs`);
    const designer = path.join(root, `${className}.Designer.cs`);
    const project = path.join(root, path.basename(root).startsWith('FakeVendor') ? 'FakeVendor.csproj' : 'Net48CtxFixture.csproj');
    const artifacts = [source, designer, project];
    artifacts.forEach((file) => assert.ok(fs.existsSync(file), `S122 ${label} fixture is missing: ${file}`));
    return {
      label,
      uri: vscode.Uri.file(source),
      designer,
      project,
      expectedEngine,
      expectedControlCount,
      selectedId,
      baselinePropertyText,
      artifacts,
      hashes: artifacts.map(sha256File),
      baselineDesignerText: fs.readFileSync(designer, 'utf8'),
    };
  };

  const standard50 = target(
    'standard-50/modern',
    path.join(workspaceRoot, 'fixtures', 'Net48CtxFixtureModern'),
    'S122Standard50Form',
    'modern',
    50,
    'control001',
    'Control 1',
  );
  const standard300Modern = target(
    'standard-300/modern',
    path.join(workspaceRoot, 'fixtures', 'Net48CtxFixtureModern'),
    'S016DenseForm',
    'modern',
    300,
    'button000',
    'Button 000',
  );
  const standard300Net48 = target(
    'standard-300/net48',
    path.join(workspaceRoot, 'fixtures', 'Net48CtxFixture'),
    'S016DenseForm',
    'net48',
    300,
    'button000',
    'Button 000',
  );
  const vendorHeavy = target(
    'vendor-heavy/net48',
    path.join(workspaceRoot, 'fixtures', 'FakeVendorNet48'),
    'S122VendorHeavyForm',
    'net48',
    180,
    'control001',
    'Vendor 1',
  );
  const targetsByCorpus: Readonly<Record<V2Phase0CorpusId, readonly S122ProductTarget[]>> = {
    'standard-50': [standard50],
    'standard-300': [standard300Modern, standard300Net48],
    'vendor-heavy': [vendorHeavy],
  };
  const allTargets = Object.values(targetsByCorpus).flat();

  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  for (const item of allTargets) {
    await vscode.commands.executeCommand('vscode.openWith', item.uri, designerViewType);
    await waitFor(
      () => testApi.openDesignerState(item.uri)?.renderReady === true
        && testApi.openDesignerState(item.uri)?.engineKind === item.expectedEngine
        && testApi.openDesignerLayout(item.uri).length === item.expectedControlCount + 1,
      `S122 ${item.label} did not warm the real product graph: ${JSON.stringify(testApi.openDesignerState(item.uri))}`,
      90_000,
    );
    const state = testApi.openDesignerState(item.uri);
    assert.strictEqual(state?.controls.length, item.expectedControlCount + 1,
      `S122 ${item.label} did not publish its exact root + control count`);
    assert.strictEqual(path.resolve(state?.ownerProjectPath ?? '').toLowerCase(), path.resolve(item.project).toLowerCase(),
      `S122 ${item.label} did not resolve its exact product project`);
    assert.strictEqual(state?.dirty, false);
  }

  const renderObservations = new Map<string, readonly S122RenderObservation[]>();
  const editObservations = new Map<string, readonly S122EditObservation[]>();
  const observationKey = (corpusId: V2Phase0CorpusId, dpi: V2Phase0DpiLeg): string =>
    `${corpusId}/${dpi.id}`;
  const requireRenderObservations = (corpusId: V2Phase0CorpusId, dpi: V2Phase0DpiLeg): readonly S122RenderObservation[] => {
    const observations = renderObservations.get(observationKey(corpusId, dpi));
    assert.ok(observations, `S122 ${observationKey(corpusId, dpi)} render telemetry is missing`);
    return observations;
  };
  const requireEditObservations = (corpusId: V2Phase0CorpusId, dpi: V2Phase0DpiLeg): readonly S122EditObservation[] => {
    const observations = editObservations.get(observationKey(corpusId, dpi));
    assert.ok(observations, `S122 ${observationKey(corpusId, dpi)} edit telemetry is missing`);
    return observations;
  };
  const maximum = (values: readonly number[]): number => Math.max(...values);

  const observedAtUtc = new Date().toISOString();
  const performanceReport: V2Phase0PerformanceReport = await runV2Phase0PerformanceSpike({
    model: async ({ corpus, dpi }) => {
      const observations: S122RenderObservation[] = [];
      for (const item of targetsByCorpus[corpus.id]) {
        // Establish a fresh graph for this measured leg without weakening the net48 interpreter's 10-second
        // autonomous-state safety TTL. Crossing the 1x/2x capture boundary changes the engine picture stamp and
        // forces an exact replay; only the following target-DPI render contributes telemetry to the report.
        const warmDpr = dpi.captureScale === 1 ? 1.25 : 1;
        await testApi.setOpenDesignerDpi(item.uri, warmDpr);
        await testApi.setOpenDesignerDpi(item.uri, dpi.displayDpr);
        const state = testApi.openDesignerState(item.uri);
        const telemetry = state?.lastFullRenderTelemetry;
        assert.ok(telemetry, `S122 ${item.label}/${dpi.id} did not publish full-render telemetry`);
        assert.strictEqual(telemetry.displayDpr, dpi.displayDpr);
        assert.strictEqual(telemetry.captureScale, dpi.captureScale);
        assert.strictEqual(telemetry.controlCount, item.expectedControlCount + 1);
        assert.strictEqual(state?.renderReady, true);
        observations.push({
          modelMs: telemetry.modelMs,
          captureMs: telemetry.captureMs,
          previewMs: telemetry.previewMs,
          reconciliationMs: telemetry.reconciliationMs,
        });
      }
      renderObservations.set(observationKey(corpus.id, dpi), observations);
      return {
        durationMs: maximum(observations.map((entry) => entry.modelMs)),
        source: 'product-telemetry',
        artifact: observations,
      };
    },
    capture: ({ corpus, dpi }) => ({
      durationMs: maximum(requireRenderObservations(corpus.id, dpi).map((entry) => entry.captureMs)),
      source: 'product-telemetry',
    }),
    preview: ({ corpus, dpi }) => ({
      durationMs: maximum(requireRenderObservations(corpus.id, dpi).map((entry) => entry.previewMs)),
      source: 'product-telemetry',
    }),
    commit: async ({ corpus, dpi }) => {
      const observations: S122EditObservation[] = [];
      for (const item of targetsByCorpus[corpus.id]) {
        await testApi.selectOpenDesignerControl(item.uri, item.selectedId);
        await waitFor(
          () => testApi.openDesignerState(item.uri)?.currentId === item.selectedId
            && testApi.openDesignerState(item.uri)?.selectedPropertyComponent?.properties.some(
              (property) => property.name === 'Text' && property.value === item.baselinePropertyText) === true,
          `S122 ${item.label}/${dpi.id} did not hydrate the exact Text property`,
          60_000,
        );
        const generation = testApi.openDesignerState(item.uri)?.renderGeneration ?? 0;
        const value = `S122 ${dpi.percent}%`;
        await testApi.editOpenDesignerProperty(item.uri, item.selectedId, 'Text', 'System.String', false, value);
        await waitFor(
          () => testApi.openDesignerState(item.uri)?.dirty === true
            && (testApi.openDesignerState(item.uri)?.renderGeneration ?? 0) > generation
            && (testApi.openDesignerState(item.uri)?.designerText ?? '').includes(`Text = "${value}";`),
          `S122 ${item.label}/${dpi.id} did not commit and reconcile the real product edit`,
          90_000,
        );
        const state = testApi.openDesignerState(item.uri);
        const telemetry = item.expectedEngine === 'modern'
          ? state?.lastModernPropertyEditTelemetry
          : state?.lastNet48PropertyEditTelemetry;
        assert.ok(telemetry, `S122 ${item.label}/${dpi.id} did not publish property-edit telemetry`);
        observations.push({
          plannerMs: telemetry.plannerMs,
          commitMs: telemetry.commitMs,
          reconciliationMs: telemetry.reconcileMs + telemetry.trailingPropertiesMs,
        });
        console.log(`S122 ${item.label}/${dpi.id}: plan ${telemetry.plannerMs}ms; commit ${telemetry.commitMs}ms; reconcile ${telemetry.reconcileMs + telemetry.trailingPropertiesMs}ms; sameSnapshot=${'propertiesReconciled' in telemetry ? telemetry.propertiesReconciled : telemetry.retainedApplied}`);
        item.artifacts.forEach((file, index) => assert.strictEqual(sha256File(file), item.hashes[index],
          `S122 ${item.label}/${dpi.id} unsaved transaction changed ${path.basename(file)} on disk`));
      }
      editObservations.set(observationKey(corpus.id, dpi), observations);
      for (const item of targetsByCorpus[corpus.id]) {
        await runDesignerHistoryCommand(testApi, item.uri, 'undo');
        await waitFor(
          () => testApi.openDesignerState(item.uri)?.dirty === false
            && testApi.openDesignerState(item.uri)?.designerText === item.baselineDesignerText,
          `S122 ${item.label}/${dpi.id} native Undo did not restore the exact product baseline`,
          60_000,
        );
        item.artifacts.forEach((file, index) => assert.strictEqual(sha256File(file), item.hashes[index],
          `S122 ${item.label}/${dpi.id} Undo changed ${path.basename(file)} on disk`));
      }
      return {
        durationMs: maximum(observations.map((entry) => entry.plannerMs + entry.commitMs)),
        source: 'product-telemetry',
      };
    },
    reconciliation: ({ corpus, dpi }) => ({
      durationMs: maximum(requireEditObservations(corpus.id, dpi).map((entry) => entry.reconciliationMs)),
      source: 'product-telemetry',
    }),
  }, {
    executionMode: 'real-product-path',
    productRunEvidence: {
      schemaVersion: '2.0.0-product-performance-evidence.1',
      scenarioId: 'V2-FND-001-S122',
      hostKind: 'vscode-extension-host',
      hostVersion: vscode.version,
      hostArchitecture: 'x64',
      processId: process.pid,
      observedAtUtc,
    },
  });

  const performanceValidation = validateV2Phase0PerformanceReport(performanceReport);
  assert.deepStrictEqual(performanceValidation.failures, [],
    `S122 real product performance report failed:\n${performanceValidation.failures.join('\n')}`);
  assert.strictEqual(performanceValidation.status, 'PASS');
  assert.strictEqual(performanceReport.status, 'PASS');
  assert.strictEqual(performanceReport.measurements.length, 12);
  assert.ok(performanceReport.measurements.every((measurement) =>
    measurement.phases.every((phase) => phase.source === 'product-telemetry')));

  const headlessReport = runV2HeadlessValidation([{
    id: 'V2-FND-001-S122',
    runtime: 'headless',
    requiresVendorArtifact: true,
    renderMode: 'interpreted',
    performanceReport,
  }], { generatedAtUtc: observedAtUtc });
  const performanceFinding = headlessReport.findings.find((finding) =>
    finding.scenarioId === 'V2-FND-001-S122' && finding.code === 'PERFORMANCE_REPORT_VALIDATED');
  assert.ok(performanceFinding, 'S122 headless validation did not publish its performance finding');
  assert.strictEqual(performanceFinding.status, 'PASS');
  assert.deepStrictEqual(performanceFinding.evidence, {
    executionMode: 'real-product-path',
    performanceStatus: 'PASS',
    failures: [],
    measurementCount: 12,
  });

  const outputPath = process.env.WFD_S122_PERFORMANCE_OUTPUT?.trim();
  if (outputPath) {
    const resolvedOutput = path.resolve(outputPath);
    fs.mkdirSync(path.dirname(resolvedOutput), { recursive: true });
    fs.writeFileSync(resolvedOutput, `${JSON.stringify({ performanceReport, headlessReport }, null, 2)}\n`, 'utf8');
  }
  console.log(`S122 real product performance/headless PASS: ${performanceReport.measurements.map((measurement) =>
    `${measurement.corpusId}/${measurement.dpiLegId}=${measurement.interactiveConservativeBoundMs}ms`).join('; ')}`);

  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await waitFor(() => testApi.engineLifecycleState().openDesignerSessions === 0,
    'S122 performance product sessions did not close', 30_000);
}

/** V2-FND-001-S089/S090 — the real modern CustomEditor discovers one certified DesignerActionMethodItem through
 * ordinary selection, proves complete/incomplete/unsupported service advertisement on the engine STA, invokes the
 * vendor callback in its disposable graph, and persists its two bounded proposals as one native Undo unit. */
async function runS089S090HostedServiceKernelScenario(testApi: ExtensionHostTestApi): Promise<void> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(workspaceFolder, 'S089/S090 require the disposable Extension Host workspace');
  assert.strictEqual(process.arch, 'x64', 'S089 catalog x64 leg must run in an x64 Extension Host');
  const root = path.join(workspaceFolder.uri.fsPath, 'fixtures', 'FakeVendor');
  const source = path.join(root, 'HostedServiceKernelForm.cs');
  const designer = path.join(root, 'HostedServiceKernelForm.Designer.cs');
  const project = path.join(root, 'FakeVendor.csproj');
  const assembly = path.join(root, 'bin', 'Release', 'net10.0-windows', 'FakeVendor.dll');
  const artifacts = [source, designer, project, assembly];
  artifacts.forEach((file) => assert.ok(fs.existsSync(file), `S089 fixture is missing: ${file}`));
  const hashes = artifacts.map(sha256File);
  const baseline = fs.readFileSync(designer, 'utf8');
  const uri = vscode.Uri.file(source);

  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await vscode.commands.executeCommand('vscode.openWith', uri, designerViewType);
  await waitFor(
    () => testApi.openDesignerState(uri)?.renderReady === true
      && testApi.openDesignerState(uri)?.engineKind === 'modern'
      && testApi.openDesignerState(uri)?.controls.some(
        (control) => control.id === 'hostedServiceControl1') === true,
    `S089 hosted-service fixture did not render: ${JSON.stringify(testApi.openDesignerState(uri))}`,
    60_000,
  );
  assert.strictEqual(testApi.openDesignerState(uri)?.dirty, false);
  assert.strictEqual(activeCustomTab(uri)?.isDirty, false);

  // Selection is the product ingress. The real component description must carry the exact opaque command and
  // certificate before the optional hosted kernel is even inspected.
  await testApi.selectOpenDesignerControl(uri, 'hostedServiceControl1');
  await waitFor(() => {
    const state = testApi.openDesignerState(uri);
    const component = testApi.openDesignerProperties(uri);
    return component?.id === 'hostedServiceControl1'
      && component.type === 'FakeVendor.HostedServiceControl'
      && component.designerActions?.some((action) =>
        action.displayName === 'Apply Service Preset'
        && action.commandId === 'applyServicePreset'
        && action.certificationId === 'repo.fakevendor.hosted-service-kernel.v1') === true
      && state?.lastHostedServiceKernelResult?.status === 'ready';
  }, `S089 product selection did not publish the certified service command: ${JSON.stringify({
    state: testApi.openDesignerState(uri), component: testApi.openDesignerProperties(uri),
  })}`,
  60_000);

  const ready = testApi.openDesignerState(uri)?.lastHostedServiceKernelResult;
  assert.ok(ready?.ok);
  assert.strictEqual(ready?.componentType, 'FakeVendor.HostedServiceControl');
  assert.strictEqual(ready?.designerType, 'FakeVendor.HostedServiceControlDesigner');
  assert.strictEqual(ready?.certificationId, 'repo.fakevendor.hosted-service-kernel.v1');
  assert.strictEqual(ready?.assemblySha256, sha256File(assembly));
  assert.strictEqual(ready?.apartmentState, 'STA');
  assert.deepStrictEqual(new Set(ready?.capabilities), new Set([
    'ContainerSiting', 'Naming', 'ComponentChange', 'Selection', 'Transactions', 'MenuCommands',
  ]));
  assert.strictEqual(ready?.completeHostAdvertised, true);
  assert.strictEqual(ready?.incompleteHostWithheld, true);
  assert.match(ready?.incompleteHostReason ?? '', /Selection/);
  assert.strictEqual(ready?.unsupportedServiceRefused, true);
  assert.ok((ready?.unsupportedServiceReason.length ?? 0) > 0);
  assert.strictEqual(ready?.actionInvoked, false);
  assert.deepStrictEqual(ready?.edits, []);

  // Caller identity is never enough: a forged certificate is refused against the current revision-bound metadata,
  // creates no source change, no dirty flag, and touches no disk artifact.
  const forged = await testApi.invokeOpenDesignerHostedServiceAction(
    uri, 'hostedServiceControl1', 'applyServicePreset', 'repo.fakevendor.forged.v1');
  assert.strictEqual(forged.ok, false);
  assert.strictEqual(forged.status, 'refused');
  assert.strictEqual(forged.errorCode, 'CERTIFIED_COMMAND_MISMATCH');
  assert.strictEqual(testApi.openDesignerState(uri)?.designerText, baseline);
  assert.strictEqual(testApi.openDesignerState(uri)?.dirty, false);
  assert.strictEqual(activeCustomTab(uri)?.isDirty, false);
  artifacts.forEach((file, index) => assert.strictEqual(sha256File(file), hashes[index],
    `S089 forged command changed ${path.basename(file)} on disk`));

  const applied = await testApi.invokeOpenDesignerHostedServiceAction(
    uri, 'hostedServiceControl1', 'applyServicePreset', 'repo.fakevendor.hosted-service-kernel.v1');
  assert.ok(applied.ok);
  assert.strictEqual(applied.status, 'applied');
  assert.strictEqual(applied.actionId, 'applyServicePreset');
  assert.strictEqual(applied.actionInvoked, true);
  assert.strictEqual(applied.transactionsOpened, 1);
  assert.strictEqual(applied.transactionsCommitted, 1);
  assert.strictEqual(applied.transactionsCancelled, 0);
  assert.strictEqual(applied.changeEvents, 4);
  assert.deepStrictEqual(applied.edits, [
    { propertyName: 'Text', propertyType: 'System.String', invariantValue: 'Hosted service preset' },
    { propertyName: 'Size', propertyType: 'System.Drawing.Size', invariantValue: '180, 42' },
  ]);
  await waitFor(() => {
    const state = testApi.openDesignerState(uri);
    return state?.dirty === true
      && activeCustomTab(uri)?.isDirty === true
      && state.designerText.includes('this.hostedServiceControl1.Text = "Hosted service preset";')
      && state.designerText.includes('this.hostedServiceControl1.Size = new System.Drawing.Size(180, 42);')
      && state.lastHostedServiceKernelResult?.status === 'applied';
  }, `S090 hosted action did not reach one unsaved source transaction: ${JSON.stringify(testApi.openDesignerState(uri))}`,
  30_000);
  const edited = testApi.openDesignerState(uri)?.designerText ?? '';
  assert.notStrictEqual(edited, baseline);
  assert.strictEqual((edited.match(/Hosted service preset/g) ?? []).length, 1);
  assert.strictEqual((edited.match(/new System\.Drawing\.Size\(180, 42\)/g) ?? []).length, 1);
  artifacts.forEach((file, index) => assert.strictEqual(sha256File(file), hashes[index],
    `S090 unsaved hosted action changed ${path.basename(file)} on disk`));

  await runDesignerHistoryCommand(testApi, uri, 'undo');
  await waitFor(() => testApi.openDesignerState(uri)?.designerText === baseline
    && testApi.openDesignerState(uri)?.dirty === false
    && activeCustomTab(uri)?.isDirty === false,
  'S090 one native Undo did not restore the byte-exact baseline', 30_000);
  await runDesignerHistoryCommand(testApi, uri, 'redo');
  await waitFor(() => testApi.openDesignerState(uri)?.designerText === edited
    && testApi.openDesignerState(uri)?.dirty === true,
  'S090 one native Redo did not restore both hosted proposals together', 30_000);
  await runDesignerHistoryCommand(testApi, uri, 'undo');
  await waitFor(() => testApi.openDesignerState(uri)?.designerText === baseline
    && testApi.openDesignerState(uri)?.dirty === false,
  'S090 final native Undo did not return to the clean baseline', 30_000);
  artifacts.forEach((file, index) => assert.strictEqual(sha256File(file), hashes[index],
    `S090 history changed ${path.basename(file)} on disk`));

  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await waitFor(() => testApi.engineLifecycleState().openDesignerSessions === 0,
    'S089/S090 product session did not close', 30_000);
}

/** V2-FND-001-S091/S092 — a real compiled-net48 CustomEditor publishes the same bounded service registry as modern,
 * executes a nested-transaction intent only in a disposable child, and receives an exact controlled cancellation with
 * no source proposal, native-history unit, dirty state, or disk mutation. */
async function runS091S092HostedServiceCancellationScenario(testApi: ExtensionHostTestApi): Promise<void> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(workspaceFolder, 'S091/S092 require the disposable Extension Host workspace');
  assert.strictEqual(process.arch, 'x64', 'S091 net48 catalog leg must run in an x64 Extension Host');
  const root = path.join(workspaceFolder.uri.fsPath, 'fixtures', 'FakeVendorNet48');
  const source = path.join(root, 'HostedServiceKernelForm.cs');
  const designer = path.join(root, 'HostedServiceKernelForm.Designer.cs');
  const project = path.join(root, 'FakeVendor.csproj');
  const assembly = path.join(root, 'bin', 'Release', 'net48', 'FakeVendor.dll');
  const artifacts = [source, designer, project, assembly];
  artifacts.forEach((file) => assert.ok(fs.existsSync(file), `S091 fixture is missing: ${file}`));
  const hashes = artifacts.map(sha256File);
  const baseline = fs.readFileSync(designer, 'utf8');
  const uri = vscode.Uri.file(source);

  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await vscode.commands.executeCommand('vscode.openWith', uri, designerViewType);
  await waitFor(
    () => testApi.openDesignerState(uri)?.renderReady === true
      && testApi.openDesignerState(uri)?.engineKind === 'net48'
      && testApi.openDesignerState(uri)?.controls.some(
        (control) => control.id === 'hostedServiceControl1') === true,
    `S091 compiled-net48 hosted-service fixture did not render: ${JSON.stringify(testApi.openDesignerState(uri))}`,
    60_000,
  );
  assert.strictEqual(testApi.openDesignerState(uri)?.dirty, false);
  assert.strictEqual(activeCustomTab(uri)?.isDirty, false);

  await testApi.selectOpenDesignerControl(uri, 'hostedServiceControl1');
  await waitFor(() => {
    const state = testApi.openDesignerState(uri);
    const component = testApi.openDesignerProperties(uri);
    return component?.id === 'hostedServiceControl1'
      && component.type === 'FakeVendor.HostedServiceControl'
      && component.designerActions?.some((action) =>
        action.commandId === 'applyServicePreset'
        && action.certificationId === 'repo.fakevendor.hosted-service-kernel.v1') === true
      && component.designerActions?.some((action) =>
        action.commandId === 'cancelReentrantServiceAction'
        && action.certificationId === 'repo.fakevendor.hosted-service-kernel.v1') === true
      && state?.lastHostedServiceKernelResult?.status === 'ready';
  }, `S091/S092 net48 selection did not publish the two certified service commands: ${JSON.stringify({
    state: testApi.openDesignerState(uri), component: testApi.openDesignerProperties(uri),
  })}`, 60_000);

  const ready = testApi.openDesignerState(uri)?.lastHostedServiceKernelResult;
  assert.ok(ready?.ok);
  assert.strictEqual(ready?.componentType, 'FakeVendor.HostedServiceControl');
  assert.strictEqual(ready?.designerType, 'FakeVendor.HostedServiceControlDesigner');
  assert.strictEqual(ready?.certificationId, 'repo.fakevendor.hosted-service-kernel.v1');
  assert.strictEqual(ready?.assemblySha256, sha256File(assembly));
  assert.strictEqual(ready?.apartmentState, 'STA');
  assert.deepStrictEqual(new Set(ready?.capabilities), new Set([
    'ContainerSiting', 'Naming', 'ComponentChange', 'Selection', 'Transactions', 'MenuCommands',
  ]));
  assert.strictEqual(ready?.completeHostAdvertised, true);
  assert.strictEqual(ready?.incompleteHostWithheld, true);
  assert.match(ready?.incompleteHostReason ?? '', /Selection/);
  assert.strictEqual(ready?.unsupportedServiceRefused, true);
  assert.match(ready?.unsupportedServiceReason ?? '', /IDesignerSerializationService/);
  assert.deepStrictEqual(ready?.edits, []);

  const cancelled = await testApi.invokeOpenDesignerHostedServiceAction(
    uri,
    'hostedServiceControl1',
    'cancelReentrantServiceAction',
    'repo.fakevendor.hosted-service-kernel.v1',
  );
  assert.strictEqual(cancelled.ok, false);
  assert.strictEqual(cancelled.status, 'cancelled');
  assert.strictEqual(cancelled.errorCode, 'REENTRANT_CANCELLED');
  assert.strictEqual(cancelled.actionId, 'cancelReentrantServiceAction');
  assert.strictEqual(cancelled.actionInvoked, true);
  assert.strictEqual(cancelled.transactionsOpened, 1);
  assert.strictEqual(cancelled.transactionsCommitted, 0);
  assert.strictEqual(cancelled.transactionsCancelled, 1);
  assert.strictEqual(cancelled.changeEvents, 4);
  assert.deepStrictEqual(cancelled.edits, []);
  assert.match(cancelled.reason, /Nested designer transactions/);
  assert.strictEqual(testApi.openDesignerState(uri)?.lastHostedServiceKernelResult?.errorCode,
    'REENTRANT_CANCELLED');
  assert.strictEqual(testApi.openDesignerState(uri)?.designerText, baseline);
  assert.strictEqual(testApi.openDesignerState(uri)?.dirty, false);
  assert.strictEqual(activeCustomTab(uri)?.isDirty, false);
  artifacts.forEach((file, index) => assert.strictEqual(sha256File(file), hashes[index],
    `S091 controlled cancellation changed ${path.basename(file)} on disk`));

  await runDesignerHistoryCommand(testApi, uri, 'undo');
  assert.strictEqual(testApi.openDesignerState(uri)?.designerText, baseline,
    'S091 controlled cancellation created a phantom native history entry');
  assert.strictEqual(testApi.openDesignerState(uri)?.dirty, false);
  assert.strictEqual(activeCustomTab(uri)?.isDirty, false);
  artifacts.forEach((file, index) => assert.strictEqual(sha256File(file), hashes[index],
    `S091 no-op Undo changed ${path.basename(file)} on disk`));

  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await waitFor(() => testApi.engineLifecycleState().openDesignerSessions === 0,
    'S091/S092 product session did not close', 30_000);
}

/** V2-FND-001-S097, V2-FND-001-S098, V2-FND-001-S099 — product activation discovers workspace adapter declarations,
 * validates the exact SDK sample and its versioned cohort, and refuses a missing N-1 protocol before starting any
 * engine or loading code. */
async function runS097S099AdapterManifestRegistryScenario(testApi: ExtensionHostTestApi): Promise<void> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(workspaceFolder, 'S097-S099 require the disposable Extension Host workspace');
  const mappedEnginesBefore = testApi.engineLifecycleState().mappedEngines;
  const samplePath = path.resolve(__dirname, '..', '..', 'docs', 'v2', 'adapter-manifest.sample.json');
  assert.ok(fs.existsSync(samplePath), `S097 committed adapter manifest sample is missing: ${samplePath}`);
  const sample = fs.readFileSync(samplePath, 'utf8');
  const invalid = JSON.parse(sample) as { protocol: { supportedVersions: number[] } };
  invalid.protocol.supportedVersions = [2];

  const validPath = path.join(
    workspaceFolder.uri.fsPath, 'DemoApp', 'S100Adapter', '.winforms-designer', 'adapter-manifest.json');
  const invalidPath = path.join(
    workspaceFolder.uri.fsPath, 'S099Adapter', '.winforms-designer', 'adapter-manifest.json');
  fs.mkdirSync(path.dirname(validPath), { recursive: true });
  fs.mkdirSync(path.dirname(invalidPath), { recursive: true });
  fs.writeFileSync(validPath, sample, 'utf8');
  fs.writeFileSync(invalidPath, `${JSON.stringify(invalid, null, 2)}\n`, 'utf8');
  const hashes = [sha256File(validPath), sha256File(invalidPath)];

  await waitFor(
    () => testApi.adapterManifestRegistryState().length === 2,
    `S097 product file watcher did not discover both manifests: ${JSON.stringify(testApi.adapterManifestRegistryState())}`,
    15_000,
  );
  const statuses = await vscode.commands.executeCommand<readonly V2AdapterManifestProductStatus[]>(
    'winformsDesigner.refreshAdapterManifests');
  assert.ok(statuses, 'S097 product refresh command did not return the adapter registry snapshot');
  assert.strictEqual(statuses.length, 2);

  const accepted = statuses.find((status) => status.uri === vscode.Uri.file(validPath).toString());
  assert.ok(accepted?.ok, `S097 committed SDK sample was not accepted: ${JSON.stringify(accepted)}`);
  assert.strictEqual(accepted.adapterId, 'acme.winforms.adapter');
  assert.strictEqual(accepted.adapterVersion, '2.0.0');
  assert.deepStrictEqual(accepted.supportedProtocolVersions, [1, 2]);
  assert.deepStrictEqual(accepted.diagnosticCodes, []);
  assert.ok(accepted.capabilities.includes('adapter.manifest-v1'));
  assert.ok(accepted.capabilities.includes('diagnostics.machine-readable'));
  assert.strictEqual(accepted.compatibilityCohorts.length, 1);
  assert.strictEqual(accepted.compatibilityCohorts[0].minProductVersion, '2.0.0');
  assert.strictEqual(accepted.compatibilityCohorts[0].maxProductVersionExclusive, '3.0.0');
  assert.deepStrictEqual(accepted.compatibilityCohorts[0].runtimes, ['modern', 'net48']);
  assert.deepStrictEqual(accepted.compatibilityCohorts[0].architectures, ['x64', 'arm64']);
  assert.ok(accepted.unsupportedFeatures.includes('licensed-designtime-code'));
  assert.strictEqual(accepted.manifestDeclaresVendorCodeLoad, false);
  assert.strictEqual(accepted.manifestDeclaresWorkspaceMutation, true);
  assert.strictEqual(accepted.vendorCodeLoaded, false);
  assert.strictEqual(accepted.workspaceMutationAuthorityGranted, false);

  const refused = statuses.find((status) => status.uri === vscode.Uri.file(invalidPath).toString());
  assert.ok(refused && !refused.ok, `S099 missing N-1 protocol was not refused: ${JSON.stringify(refused)}`);
  assert.strictEqual(refused.adapterId, null,
    'S099 invalid manifest identity escaped the fail-closed validation boundary');
  assert.deepStrictEqual(refused.supportedProtocolVersions, []);
  assert.deepStrictEqual(refused.diagnosticCodes, ['ADAPTER_PROTOCOL_UNSUPPORTED']);
  assert.strictEqual(refused.vendorCodeLoaded, false);
  assert.strictEqual(refused.workspaceMutationAuthorityGranted, false);
  const diagnostics = vscode.languages.getDiagnostics(vscode.Uri.file(invalidPath));
  assert.deepStrictEqual(diagnostics.map((diagnostic) => diagnostic.code), ['ADAPTER_PROTOCOL_UNSUPPORTED']);
  assert.deepStrictEqual(testApi.engineLifecycleState().mappedEngines, mappedEnginesBefore,
    'S097-S099 manifest-only discovery changed the product engine set or started a vendor-code worker');
  [validPath, invalidPath].forEach((file, index) => assert.strictEqual(sha256File(file), hashes[index],
    `S097-S099 read-only registry changed ${path.basename(path.dirname(path.dirname(file)))} manifest bytes`));
}

/** V2-FND-001-S100 / V2-FND-001-S108 — execute both extension-side edits through real modern/net48 CustomEditors,
 * export their exact saved artifacts for an actual Visual Studio Save All capture, and on ordinary regressions reopen
 * the newest archived VS output through the same product lanes. The archive is evidence, never a proposed source edit. */
async function runS100S108VisualStudioRoundTripScenario(testApi: ExtensionHostTestApi): Promise<void> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(workspaceFolder, 'S100/S108 require the disposable Extension Host workspace');
  const traceOutput = process.env.WFD_VS_TRACE_OUTPUT?.trim();
  const workspaceRoot = workspaceFolder.uri.fsPath;

  const adapterRoot = path.join(workspaceRoot, 'DemoApp', 'S100Adapter');
  const adapterManifest = path.join(adapterRoot, '.winforms-designer', 'adapter-manifest.json');
  const adapterStatus = testApi.adapterManifestRegistryState().find(
    (status) => status.uri === vscode.Uri.file(adapterManifest).toString());
  assert.ok(adapterStatus?.ok, `S100 accepted adapter sample is unavailable: ${JSON.stringify(adapterStatus)}`);
  assert.strictEqual(adapterStatus.vendorCodeLoaded, false);
  assert.strictEqual(adapterStatus.workspaceMutationAuthorityGranted, false);

  const modernSource = path.join(adapterRoot, 'S100AdapterRoundTripForm.cs');
  const modernDesigner = path.join(adapterRoot, 'S100AdapterRoundTripForm.Designer.cs');
  const modernSourceBefore = Buffer.from([
    'using System.Windows.Forms;',
    'namespace DemoApp;',
    'public partial class S100AdapterRoundTripForm : Form',
    '{',
    '    public S100AdapterRoundTripForm() => InitializeComponent();',
    '}',
    '',
  ].join('\r\n'), 'utf8');
  const modernDesignerBefore = Buffer.from([
    'namespace DemoApp;',
    'partial class S100AdapterRoundTripForm',
    '{',
    '    private System.Windows.Forms.Button button1;',
    '    private void InitializeComponent()',
    '    {',
    '        this.button1 = new System.Windows.Forms.Button();',
    '        this.button1.Location = new System.Drawing.Point(24, 28);',
    '        this.button1.Name = "button1";',
    '        this.button1.Size = new System.Drawing.Size(148, 32);',
    '        this.button1.Text = "Before adapter round-trip";',
    '        this.Controls.Add(this.button1);',
    '        this.ClientSize = new System.Drawing.Size(360, 180);',
    '        this.Name = "S100AdapterRoundTripForm";',
    '        this.Text = "S100 adapter sample";',
    '    }',
    '}',
    '',
  ].join('\r\n'), 'utf8');
  fs.mkdirSync(adapterRoot, { recursive: true });
  fs.writeFileSync(modernSource, modernSourceBefore);
  fs.writeFileSync(modernDesigner, modernDesignerBefore);
  const modernUri = vscode.Uri.file(modernSource);
  await vscode.commands.executeCommand('vscode.openWith', modernUri, designerViewType);
  await waitFor(() => testApi.openDesignerState(modernUri)?.renderReady === true,
    `S100 adapter form did not render: ${JSON.stringify(testApi.openDesignerState(modernUri))}`, 60_000);
  assert.strictEqual(testApi.openDesignerState(modernUri)?.engineKind, 'modern');
  await testApi.editOpenDesignerProperty(
    modernUri, 'button1', 'Text', 'System.String', false, 'Extension + Visual Studio round-trip');
  await waitFor(() => (testApi.openDesignerState(modernUri)?.designerText ?? '').includes(
    'this.button1.Text = "Extension + Visual Studio round-trip";'),
  'S100 extension leg did not commit the adapter sample Text edit');
  await testApi.saveOpenDesigner(modernUri);
  await waitFor(() => testApi.openDesignerState(modernUri)?.dirty === false, 'S100 extension save stayed dirty');
  const modernExtensionDesigner = fs.readFileSync(modernDesigner, 'utf8');
  assert.strictEqual(testApi.openDesignerState(modernUri)?.designerText, modernExtensionDesigner);
  assert.deepStrictEqual(fs.readFileSync(modernSource), modernSourceBefore,
    'S100 extension leg changed code-behind');

  if (traceOutput) {
    const directory = path.join(traceOutput, 'S100AdapterRoundTrip');
    fs.mkdirSync(directory, { recursive: true });
    for (const file of [modernSource, modernDesigner, adapterManifest]) {
      fs.copyFileSync(file, path.join(directory, path.basename(file)));
    }
    fs.writeFileSync(path.join(directory, 'extension-leg.json'), `${JSON.stringify({
      schemaVersion: 1,
      scenarioId: 'V2-FND-001-S100',
      producer: 'WinForms Designer for VS Code CustomEditor Extension Host',
      vscodeVersion: vscode.version,
      adapter: { id: adapterStatus.adapterId, version: adapterStatus.adapterVersion, vendorCodeLoaded: false },
      action: { kind: 'property', componentId: 'button1', propertyName: 'Text', value: 'Extension + Visual Studio round-trip' },
      artifacts: {
        'S100AdapterRoundTripForm.cs': sha256File(modernSource),
        'S100AdapterRoundTripForm.Designer.cs': sha256File(modernDesigner),
        'adapter-manifest.json': sha256File(adapterManifest),
      },
    }, null, 2)}\n`, 'utf8');
  }
  await runDesignerHistoryCommand(testApi, modernUri, 'undo');
  await waitFor(() => testApi.openDesignerState(modernUri)?.designerText === modernDesignerBefore.toString('utf8'),
    'S100 native Undo did not restore the pre-round-trip adapter form');
  await testApi.saveOpenDesigner(modernUri);
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  await waitFor(() => testApi.openDesignerState(modernUri) === undefined, 'S100 extension input did not close');

  if (!traceOutput) {
    const archived = latestArchivedRoundTrip('V2-FND-001-S100');
    for (const file of ['S100AdapterRoundTripForm.cs', 'S100AdapterRoundTripForm.Designer.cs']) {
      const archivedFile = path.join(archived.directory, file);
      assert.strictEqual(sha256File(archivedFile), archived.manifest.afterSha256[file],
        `S100 archived ${file} hash does not match its Visual Studio manifest`);
      fs.copyFileSync(archivedFile, path.join(adapterRoot, file));
    }
    assert.strictEqual(sha256File(path.join(archived.directory, 'adapter-manifest.json')),
      archived.manifest.afterSha256['adapter-manifest.json']);
    assert.strictEqual(sha256File(adapterManifest), archived.manifest.afterSha256['adapter-manifest.json']);
    await vscode.commands.executeCommand('vscode.openWith', modernUri, designerViewType);
    await waitFor(() => testApi.openDesignerState(modernUri)?.renderReady === true,
      `S100 Visual Studio output did not reopen: ${JSON.stringify(testApi.openDesignerState(modernUri))}`, 60_000);
    assert.strictEqual(testApi.openDesignerState(modernUri)?.engineKind, 'modern');
    assert.strictEqual(testApi.openDesignerState(modernUri)?.designerText, fs.readFileSync(modernDesigner, 'utf8'));
    assert.match(testApi.openDesignerState(modernUri)?.designerText ?? '',
      /this\.button1\.Text = "Extension \+ Visual Studio round-trip";/);
    assert.strictEqual(testApi.openDesignerState(modernUri)?.dirty, false);
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    await waitFor(() => testApi.openDesignerState(modernUri) === undefined, 'S100 archived output did not close');
    fs.writeFileSync(modernSource, modernSourceBefore);
    fs.writeFileSync(modernDesigner, modernDesignerBefore);
  }

  const net48Root = path.join(workspaceRoot, 'fixtures', 'Net48CtxFixture');
  const net48Source = path.join(net48Root, 'ReparentForm.cs');
  const net48Designer = path.join(net48Root, 'ReparentForm.Designer.cs');
  const net48SourceBefore = fs.readFileSync(net48Source);
  const net48DesignerBefore = fs.readFileSync(net48Designer);
  const net48Uri = vscode.Uri.file(net48Source);
  await vscode.commands.executeCommand('vscode.openWith', net48Uri, designerViewType);
  await waitFor(() => testApi.openDesignerState(net48Uri)?.renderReady === true,
    `S108 net48 input did not render: ${JSON.stringify(testApi.openDesignerState(net48Uri))}`, 60_000);
  assert.strictEqual(testApi.openDesignerState(net48Uri)?.engineKind, 'net48');
  await testApi.editOpenDesignerProperty(
    net48Uri, 'button1', 'Text', 'System.String', false, 'Extension + VS net48 round-trip');
  await waitFor(() => (testApi.openDesignerState(net48Uri)?.designerText ?? '').includes(
    'this.button1.Text = "Extension + VS net48 round-trip";'),
  'S108 extension leg did not commit the net48 Text edit');
  await testApi.saveOpenDesigner(net48Uri);
  await waitFor(() => testApi.openDesignerState(net48Uri)?.dirty === false, 'S108 extension save stayed dirty');
  assert.deepStrictEqual(fs.readFileSync(net48Source), net48SourceBefore, 'S108 extension leg changed code-behind');
  assert.strictEqual(testApi.openDesignerState(net48Uri)?.designerText, fs.readFileSync(net48Designer, 'utf8'));

  if (traceOutput) {
    const directory = path.join(traceOutput, 'S108Net48RoundTrip');
    fs.mkdirSync(directory, { recursive: true });
    for (const file of [net48Source, net48Designer]) {
      fs.copyFileSync(file, path.join(directory, path.basename(file)));
    }
    fs.writeFileSync(path.join(directory, 'extension-leg.json'), `${JSON.stringify({
      schemaVersion: 1,
      scenarioId: 'V2-FND-001-S108',
      producer: 'WinForms Designer for VS Code compiled-net48 CustomEditor Extension Host',
      vscodeVersion: vscode.version,
      action: { kind: 'property', componentId: 'button1', propertyName: 'Text', value: 'Extension + VS net48 round-trip' },
      artifacts: {
        'ReparentForm.cs': sha256File(net48Source),
        'ReparentForm.Designer.cs': sha256File(net48Designer),
      },
    }, null, 2)}\n`, 'utf8');
  }
  await runDesignerHistoryCommand(testApi, net48Uri, 'undo');
  await waitFor(() => testApi.openDesignerState(net48Uri)?.designerText === net48DesignerBefore.toString('utf8'),
    'S108 native Undo did not restore the pre-round-trip net48 form');
  await testApi.saveOpenDesigner(net48Uri);
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  await waitFor(() => testApi.openDesignerState(net48Uri) === undefined, 'S108 extension input did not close');

  if (!traceOutput) {
    const archived = latestArchivedRoundTrip('V2-FND-001-S108');
    for (const file of ['ReparentForm.cs', 'ReparentForm.Designer.cs']) {
      const archivedFile = path.join(archived.directory, file);
      assert.strictEqual(sha256File(archivedFile), archived.manifest.afterSha256[file],
        `S108 archived ${file} hash does not match its Visual Studio manifest`);
      fs.copyFileSync(archivedFile, path.join(net48Root, file));
    }
    await vscode.commands.executeCommand('vscode.openWith', net48Uri, designerViewType);
    await waitFor(() => testApi.openDesignerState(net48Uri)?.renderReady === true,
      `S108 Visual Studio output did not reopen: ${JSON.stringify(testApi.openDesignerState(net48Uri))}`, 60_000);
    assert.strictEqual(testApi.openDesignerState(net48Uri)?.engineKind, 'net48');
    assert.strictEqual(testApi.openDesignerState(net48Uri)?.designerText, fs.readFileSync(net48Designer, 'utf8'));
    assert.match(testApi.openDesignerState(net48Uri)?.designerText ?? '',
      /this\.button1\.Text = "Extension \+ VS net48 round-trip";/);
    assert.strictEqual(testApi.openDesignerState(net48Uri)?.dirty, false);
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    await waitFor(() => testApi.openDesignerState(net48Uri) === undefined, 'S108 archived output did not close');
    fs.writeFileSync(net48Source, net48SourceBefore);
    fs.writeFileSync(net48Designer, net48DesignerBefore);
  }
}

/** V2-FND-001-S095 — the real net48 CustomEditor selects a repository-certified hostile control. Its
 * ComponentDesigner is activated only in the net48 child broker. The fixture then crashes that exact child from
 * Initialize; the product must retain the main engine, generic Properties, source-first editing, and native history,
 * while refusing a second worker launch for the quarantined assembly-content/type identity. */
async function runS095HostedDesignerQuarantineScenario(testApi: ExtensionHostTestApi): Promise<void> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(workspaceFolder, 'S095 requires the disposable Extension Host workspace');
  assert.strictEqual(process.arch, 'x64', 'S095 catalog x64 leg must run in an x64 Extension Host');
  const root = path.join(workspaceFolder.uri.fsPath, 'fixtures', 'FakeVendorNet48');
  const source = path.join(root, 'HostedDesignerCrashForm.cs');
  const designer = path.join(root, 'HostedDesignerCrashForm.Designer.cs');
  const project = path.join(root, 'FakeVendor.csproj');
  const assembly = path.join(root, 'bin', 'Release', 'net48', 'FakeVendor.dll');
  // Keep the hostile marker OUTSIDE bin/: the product deliberately treats every output-directory write as a possible
  // external build and would correctly release/re-render the form. The fixture derives the same temp path from the
  // assembly bytes, so the marker changes with a rebuild and remains scoped to this disposable run.
  const marker = path.join(os.tmpdir(), `wfd-s095-${sha256File(assembly)}.crash`);
  const artifacts = [source, designer, project, assembly];
  artifacts.forEach((file) => assert.ok(fs.existsSync(file), `S095 fixture is missing: ${file}`));
  const hashes = artifacts.map(sha256File);
  const baseline = fs.readFileSync(designer, 'utf8');
  const uri = vscode.Uri.file(source);
  fs.rmSync(marker, { force: true });

  try {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.commands.executeCommand('vscode.openWith', uri, designerViewType);
    await waitFor(
      () => testApi.openDesignerState(uri)?.renderReady === true
        && testApi.openDesignerState(uri)?.engineKind === 'net48'
        && testApi.openDesignerState(uri)?.controls.some((control) => control.id === 'crashControl1') === true,
      `S095 generic net48 form did not render before hosted activation: ${JSON.stringify(testApi.openDesignerState(uri))}`,
      60_000,
    );
    assert.strictEqual(testApi.openDesignerState(uri)?.dirty, false);
    assert.strictEqual(activeCustomTab(uri)?.isDirty, false);

    // Ordinary selection is the product ingress: loadProps describes the generic control first, then probes the
    // optional certified fidelity layer. No E2E-only command is needed for this safe activation.
    await testApi.selectOpenDesignerControl(uri, 'crashControl1');
    await waitFor(() => {
      const state = testApi.openDesignerState(uri);
      const component = testApi.openDesignerProperties(uri);
      return component?.id === 'crashControl1'
        && component.type === 'FakeVendor.CrashOnInitializeControl'
        && component.properties.some((property) => property.name === 'Text'
          && property.value === 'Generic control remains usable')
        && state?.lastHostedDesignerProbe?.status === 'ready';
    }, `S095 safe hosted designer did not activate from ordinary selection: ${JSON.stringify(testApi.openDesignerState(uri))}`,
    60_000);
    const ready = testApi.openDesignerState(uri)?.lastHostedDesignerProbe;
    assert.ok(ready?.ok);
    assert.strictEqual(ready?.designerType, 'FakeVendor.CrashOnInitializeDesigner');
    assert.strictEqual(ready?.certificationId, 'repo.fakevendor.hosted-designer.v1');
    assert.strictEqual(ready?.assemblySha256, sha256File(assembly));
    assert.ok((ready?.mainEnginePid ?? 0) > 0);
    assert.ok((ready?.workerPid ?? 0) > 0 && ready?.workerPid !== ready?.mainEnginePid);
    assert.strictEqual(ready?.workerStarted, true);
    assert.strictEqual(ready?.privateDesktop, true,
      'S095 hosted designer did not inherit the net48 engine private desktop');

    // This marker is the sole hostile test action. The next call still resolves the assembly, type, SHA and
    // certification exclusively from the currently published product component and engine-side allowlist.
    fs.writeFileSync(marker, 'V2-FND-001-S095 intentional ComponentDesigner.Initialize crash\n', 'utf8');
    const crashed = await testApi.probeOpenDesignerHostedDesigner(uri, 'crashControl1');
    assert.strictEqual(crashed.ok, false);
    assert.strictEqual(crashed.status, 'crashed');
    assert.strictEqual(crashed.errorCode, 'DESIGNER_CRASH');
    assert.strictEqual(crashed.quarantined, true);
    assert.strictEqual(crashed.workerStarted, true);
    assert.strictEqual(crashed.mainEnginePid, ready?.mainEnginePid,
      'S095 main net48 JSON-RPC engine changed when only the hosted designer child crashed');
    assert.ok(crashed.workerPid > 0 && crashed.workerPid !== crashed.mainEnginePid);
    assert.notStrictEqual(crashed.exitCode, 0,
      'S095 hostile Initialize did not produce a real worker-process exit');
    assert.strictEqual(crashed.privateDesktop, true);
    let crashedWorkerAlive = true;
    try { process.kill(crashed.workerPid, 0); } catch { crashedWorkerAlive = false; }
    assert.strictEqual(crashedWorkerAlive, false,
      `S095 hosted designer worker PID ${crashed.workerPid} survived its reported crash`);

    // A second product activation is refused from parent-owned quarantine without starting another child. The
    // original crash PID remains diagnostic evidence; no caller-supplied crash/quarantine id participates.
    const quarantined = await testApi.probeOpenDesignerHostedDesigner(uri, 'crashControl1');
    assert.strictEqual(quarantined.ok, false);
    assert.strictEqual(quarantined.status, 'quarantined');
    assert.strictEqual(quarantined.errorCode, 'DESIGNER_QUARANTINED');
    assert.strictEqual(quarantined.quarantined, true);
    assert.strictEqual(quarantined.workerStarted, false);
    assert.strictEqual(quarantined.workerPid, crashed.workerPid);
    assert.strictEqual(quarantined.mainEnginePid, crashed.mainEnginePid);
    assert.strictEqual(quarantined.assemblySha256, crashed.assemblySha256);

    // The visible generic surface remains live: render authority is still green, published Properties are editable,
    // and one normal source-first edit gets one native Undo/Redo unit while every disk artifact remains byte-exact.
    assert.strictEqual(testApi.openDesignerState(uri)?.renderReady, true,
      'S095 designer quarantine revoked the generic form render');
    assert.strictEqual(testApi.openDesignerState(uri)?.engineKind, 'net48');
    assert.strictEqual(testApi.openDesignerState(uri)?.designerText, baseline);
    const textProperty = testApi.openDesignerProperties(uri)?.properties
      .find((property) => property.name === 'Text');
    assert.ok(textProperty && textProperty.readOnly === false,
      'S095 generic Text property became read-only after designer quarantine');

    await testApi.editOpenDesignerProperty(
      uri, 'crashControl1', 'Text', 'System.String', false, 'Still usable after designer crash',
    );
    await waitFor(() => testApi.openDesignerState(uri)?.designerText.includes(
      'this.crashControl1.Text = "Still usable after designer crash";') === true
      && testApi.openDesignerState(uri)?.dirty === true
      && activeCustomTab(uri)?.isDirty === true,
    'S095 generic source-first edit did not remain usable after hosted designer quarantine', 30_000);
    const edited = testApi.openDesignerState(uri)?.designerText ?? '';
    await runDesignerHistoryCommand(testApi, uri, 'undo');
    await waitFor(() => testApi.openDesignerState(uri)?.designerText === baseline
      && testApi.openDesignerState(uri)?.dirty === false,
    'S095 native Undo did not restore the byte-exact generic baseline', 30_000);
    await runDesignerHistoryCommand(testApi, uri, 'redo');
    await waitFor(() => testApi.openDesignerState(uri)?.designerText === edited
      && testApi.openDesignerState(uri)?.dirty === true,
    'S095 native Redo did not restore the generic post-crash edit', 30_000);
    await runDesignerHistoryCommand(testApi, uri, 'undo');
    await waitFor(() => testApi.openDesignerState(uri)?.designerText === baseline
      && testApi.openDesignerState(uri)?.dirty === false,
    'S095 final native Undo did not return to the clean baseline', 30_000);
    artifacts.forEach((file, index) => assert.strictEqual(sha256File(file), hashes[index],
      `S095 quarantine/edit/history changed ${path.basename(file)} on disk`));
  } finally {
    fs.rmSync(marker, { force: true });
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  }
  await waitFor(() => testApi.engineLifecycleState().openDesignerSessions === 0,
    'S095 product session did not close', 30_000);
}

/** V2-FND-001-S124 — kill the actual mapped modern worker while a real CustomEditor is open. Product exit handling
 * must revoke edit authority, record the crash, restart after its bounded backoff, re-render the unchanged document,
 * accept a normal edit/Undo, and then render/edit a later form through the recovered shared process. */
async function runS124ProductWorkerCrashContinuation(testApi: ExtensionHostTestApi): Promise<void> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(workspaceFolder, 'S124 requires the disposable Extension Host workspace');
  const projectRoot = path.join(workspaceFolder.uri.fsPath, 'DemoApp');
  const fixtureRoot = path.join(projectRoot, 'S124WorkerCrash');
  fs.mkdirSync(fixtureRoot, { recursive: true });

  const writeForm = (typeName: string, caption: string) => {
    const source = path.join(fixtureRoot, `${typeName}.cs`);
    const designer = path.join(fixtureRoot, `${typeName}.Designer.cs`);
    const sourceText = [
      'using System.Windows.Forms;',
      'namespace DemoApp;',
      `public partial class ${typeName} : Form`,
      '{',
      `    public ${typeName}() => InitializeComponent();`,
      '}',
      '',
    ].join('\r\n');
    const designerText = [
      'namespace DemoApp;',
      `partial class ${typeName}`,
      '{',
      '    private System.Windows.Forms.Button button1;',
      '    private void InitializeComponent()',
      '    {',
      '        this.button1 = new System.Windows.Forms.Button();',
      '        this.SuspendLayout();',
      '        this.button1.Location = new System.Drawing.Point(24, 24);',
      '        this.button1.Name = "button1";',
      '        this.button1.Size = new System.Drawing.Size(180, 32);',
      `        this.button1.Text = "${caption}";`,
      '        this.Controls.Add(this.button1);',
      '        this.ClientSize = new System.Drawing.Size(360, 180);',
      `        this.Name = "${typeName}";`,
      `        this.Text = "${typeName}";`,
      '        this.ResumeLayout(false);',
      '    }',
      '}',
      '',
    ].join('\r\n');
    fs.writeFileSync(source, sourceText, 'utf8');
    fs.writeFileSync(designer, designerText, 'utf8');
    return { source, designer, sourceText, designerText, uri: vscode.Uri.file(source) };
  };

  const beforeCrash = writeForm('WorkerCrashBeforeForm', 'Before worker crash');
  const afterCrash = writeForm('WorkerCrashAfterForm', 'After worker crash');
  const project = path.join(projectRoot, 'DemoApp.csproj');
  const artifacts = [beforeCrash.source, beforeCrash.designer, afterCrash.source, afterCrash.designer, project];
  const hashes = artifacts.map(sha256File);

  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await vscode.commands.executeCommand('vscode.openWith', beforeCrash.uri, designerViewType);
  await waitFor(
    () => testApi.openDesignerState(beforeCrash.uri)?.renderReady === true
      && testApi.openDesignerState(beforeCrash.uri)?.engineKind === 'modern',
    `S124 pre-crash form did not render: ${JSON.stringify(testApi.openDesignerState(beforeCrash.uri))}`,
    60_000,
  );
  const beforeState = testApi.openDesignerState(beforeCrash.uri)!;
  assert.strictEqual(beforeState.designerText, beforeCrash.designerText);
  assert.strictEqual(beforeState.dirty, false);
  assert.strictEqual(activeCustomTab(beforeCrash.uri)?.isDirty, false);
  assert.ok(beforeState.controls.some((control) => control.id === 'button1'),
    'S124 pre-crash render did not publish the standard control');
  const preCrashEngine = testApi.engineLifecycleState().mappedEngines.find((engine) => engine.kind === 'modern');
  assert.ok(preCrashEngine?.running && preCrashEngine.pid > 0, 'S124 has no running mapped modern product worker');

  // This is the sole injected action. It only sends SIGKILL to the actual child; the test API does not alter engine
  // maps, crash counters, sessions, documents, or timers. Everything observed below is normal product recovery.
  const crash = testApi.crashMappedEngineForRecoveryTest('modern');
  assert.deepStrictEqual(crash, { pid: preCrashEngine.pid, signaled: true });
  await waitFor(
    () => testApi.openDesignerState(beforeCrash.uri)?.renderReady === false,
    'S124 product session did not revoke render/edit authority after worker exit',
    10_000,
  );
  assert.strictEqual(testApi.openDesignerState(beforeCrash.uri)?.designerText, beforeCrash.designerText,
    'S124 authority revocation changed the in-memory source snapshot');
  assert.strictEqual(testApi.openDesignerState(beforeCrash.uri)?.dirty, false,
    'S124 worker exit created a phantom CustomDocument history unit');
  artifacts.forEach((file, index) => assert.strictEqual(sha256File(file), hashes[index],
    `S124 worker exit changed ${path.basename(file)} on disk`));

  await waitFor(() => {
    const state = testApi.openDesignerState(beforeCrash.uri);
    const engine = testApi.engineLifecycleState().mappedEngines.find((candidate) => candidate.kind === 'modern');
    return state?.renderReady === true && state.engineKind === 'modern'
      && (state.renderGeneration ?? 0) > beforeState.renderGeneration
      && !!engine?.running && engine.pid > 0 && engine.pid !== crash.pid;
  }, `S124 product recovery did not publish a fresh worker/render: ${JSON.stringify(testApi.engineLifecycleState())}`,
  60_000);
  const recoveredEngine = testApi.engineLifecycleState().mappedEngines.find((engine) => engine.kind === 'modern')!;
  let oldAlive = true;
  try { process.kill(crash.pid, 0); } catch { oldAlive = false; }
  assert.strictEqual(oldAlive, false, `S124 crashed worker PID ${crash.pid} still exists after replacement`);
  assert.strictEqual(testApi.openDesignerState(beforeCrash.uri)?.designerText, beforeCrash.designerText);
  assert.strictEqual(testApi.openDesignerState(beforeCrash.uri)?.dirty, false);
  assert.strictEqual(activeCustomTab(beforeCrash.uri)?.isDirty, false);

  // Product diagnostics must expose the crash rather than silently presenting the replacement as the original worker.
  await vscode.commands.executeCommand('winformsDesigner.exportDiagnostics');
  const diagnostics = vscode.window.activeTextEditor?.document.getText() ?? '';
  assert.match(diagnostics, new RegExp(
    `- modern: running \\(pid ${recoveredEngine.pid}\\); starts=\\d+; lastStartup=\\d+ ms; recentCrashes=1; lastExit=.*(?:process exit|RPC connection closed)`,
  ), `S124 recovery was not disclosed in product diagnostics:\n${diagnostics}`);
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  await testApi.focusOpenDesigner(beforeCrash.uri);

  await testApi.editOpenDesignerProperty(
    beforeCrash.uri, 'button1', 'Text', 'System.String', false, 'Recovered worker',
  );
  await waitFor(
    () => testApi.openDesignerState(beforeCrash.uri)?.designerText.includes(
      'this.button1.Text = "Recovered worker";') === true
      && testApi.openDesignerState(beforeCrash.uri)?.dirty === true,
    'S124 recovered form did not accept an ordinary product property transaction',
    30_000,
  );
  await runDesignerHistoryCommand(testApi, beforeCrash.uri, 'undo');
  await waitFor(
    () => testApi.openDesignerState(beforeCrash.uri)?.designerText === beforeCrash.designerText
      && testApi.openDesignerState(beforeCrash.uri)?.dirty === false,
    'S124 native Undo after recovery did not restore the byte-exact clean baseline',
    30_000,
  );

  // The later standard form is the continuation leg: it must use the recovered shared worker, not stop the corpus at
  // the crashing entry, and its first ordinary transaction must keep the same exact native history semantics.
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await waitFor(() => testApi.engineLifecycleState().openDesignerSessions === 0,
    'S124 pre-crash form did not close before the continuation leg', 30_000);
  await vscode.commands.executeCommand('vscode.openWith', afterCrash.uri, designerViewType);
  await waitFor(
    () => testApi.openDesignerState(afterCrash.uri)?.renderReady === true
      && testApi.openDesignerState(afterCrash.uri)?.engineKind === 'modern',
    `S124 later form did not continue after worker recovery: ${JSON.stringify(testApi.openDesignerState(afterCrash.uri))}`,
    60_000,
  );
  assert.strictEqual(
    testApi.engineLifecycleState().mappedEngines.find((engine) => engine.kind === 'modern')?.pid,
    recoveredEngine.pid,
    'S124 later form did not reuse the healthy recovered product worker',
  );
  assert.strictEqual(testApi.openDesignerState(afterCrash.uri)?.designerText, afterCrash.designerText);
  await testApi.editOpenDesignerProperty(
    afterCrash.uri, 'button1', 'Text', 'System.String', false, 'Later form continued',
  );
  await waitFor(
    () => testApi.openDesignerState(afterCrash.uri)?.designerText.includes(
      'this.button1.Text = "Later form continued";') === true
      && testApi.openDesignerState(afterCrash.uri)?.dirty === true,
    'S124 later form did not accept an ordinary product property transaction',
    30_000,
  );
  await runDesignerHistoryCommand(testApi, afterCrash.uri, 'undo');
  await waitFor(
    () => testApi.openDesignerState(afterCrash.uri)?.designerText === afterCrash.designerText
      && testApi.openDesignerState(afterCrash.uri)?.dirty === false,
    'S124 later-form Undo did not restore its byte-exact clean baseline',
    30_000,
  );
  artifacts.forEach((file, index) => assert.strictEqual(sha256File(file), hashes[index],
    `S124 recovery/continuation changed ${path.basename(file)} on disk`));
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await waitFor(() => testApi.engineLifecycleState().openDesignerSessions === 0,
    'S124 recovery sessions did not close', 30_000);
}

interface HighDpiPreviewCommandResult {
  status: 'previewed' | 'notApplicable' | 'refused';
  reason?: string;
  designerFile?: string;
  before?: string;
  after?: string;
  beforeSha256?: string;
  afterSha256?: string;
  persistenceLane?: 'ownedRegion' | 'sourceFirst';
  originalUri?: vscode.Uri;
  modifiedUri?: vscode.Uri;
  title?: string;
}

/** V2-FND-001-S126 — exercise the visible Advisor command against a real modern CustomEditor. The preview must be a
 * clean read-only VS Code diff of the exact planner bytes; Apply must use that retained proposal as one native history
 * unit, and the S128 stale-baseline guard must refuse without replacing the intervening edit. */
async function runS126HighDpiAdvisorScenario(testApi: ExtensionHostTestApi): Promise<void> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(workspaceFolder, 'S126 requires the disposable Extension Host workspace');
  const projectRoot = path.join(workspaceFolder.uri.fsPath, 'DemoApp');
  const fixtureRoot = path.join(projectRoot, 'S126HighDpi');
  fs.mkdirSync(fixtureRoot, { recursive: true });
  const source = path.join(fixtureRoot, 'HighDpiAdvisorForm.cs');
  const designer = path.join(fixtureRoot, 'HighDpiAdvisorForm.Designer.cs');
  const project = path.join(projectRoot, 'DemoApp.csproj');
  fs.writeFileSync(source, [
    'using System.Windows.Forms;',
    'namespace DemoApp;',
    'public partial class HighDpiAdvisorForm : Form',
    '{',
    '    public HighDpiAdvisorForm() => InitializeComponent();',
    '}',
    '',
  ].join('\r\n'), 'utf8');
  const baseline = [
    'namespace DemoApp;',
    'partial class HighDpiAdvisorForm',
    '{',
    '    private void InitializeComponent()',
    '    {',
    '        this.AutoScaleDimensions = new System.Drawing.SizeF(6F, 13F);',
    '        this.AutoScaleMode = System.Windows.Forms.AutoScaleMode.None;',
    '        this.ClientSize = new System.Drawing.Size(360, 180);',
    '        this.Name = "HighDpiAdvisorForm";',
    '        this.Text = "High DPI advisor";',
    '    }',
    '}',
    '',
  ].join('\r\n');
  fs.writeFileSync(designer, baseline, 'utf8');
  const expected = baseline.replace(
    'this.AutoScaleMode = System.Windows.Forms.AutoScaleMode.None;',
    'this.AutoScaleMode = System.Windows.Forms.AutoScaleMode.Font;',
  );
  assert.notStrictEqual(expected, baseline, 'S126 fixture did not contain the one expected AutoScaleMode.None assignment');
  assert.strictEqual((baseline.match(/AutoScaleMode\.None/g) ?? []).length, 1);
  const artifacts = [source, designer, project];
  const hashes = artifacts.map(sha256File);
  const hashText = (text: string) => createHash('sha256').update(text).digest('hex');
  const uri = vscode.Uri.file(source);

  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await vscode.commands.executeCommand('vscode.openWith', uri, designerViewType);
  await waitFor(
    () => testApi.openDesignerState(uri)?.renderReady === true
      && testApi.openDesignerState(uri)?.engineKind === 'modern',
    `S126 modern advisor form did not render: ${JSON.stringify(testApi.openDesignerState(uri))}`,
    60_000,
  );
  await testApi.selectOpenDesignerControl(uri, 'this');
  await waitFor(
    () => testApi.openDesignerProperties(uri)?.properties.some((property) =>
      property.name === 'AutoScaleMode' && property.value === 'None') === true,
    'S126 root Properties metadata did not expose the source AutoScaleMode.None value',
    30_000,
  );

  const preview = await vscode.commands.executeCommand<HighDpiPreviewCommandResult>(
    'winformsDesigner.previewHighDpiQuickFix',
  );
  assert.ok(preview, 'S126 visible Advisor command returned no result');
  assert.strictEqual(preview.status, 'previewed', `S126 preview refused: ${preview.reason ?? '<none>'}`);
  assert.strictEqual(preview.designerFile, designer);
  assert.strictEqual(preview.before, baseline);
  assert.strictEqual(preview.after, expected);
  assert.strictEqual(preview.beforeSha256, hashText(baseline));
  assert.strictEqual(preview.afterSha256, hashText(expected));
  assert.ok(preview.persistenceLane === 'ownedRegion' || preview.persistenceLane === 'sourceFirst');
  assert.ok(preview.originalUri && preview.modifiedUri, 'S126 preview did not return its read-only diff documents');
  assert.strictEqual(preview.originalUri.scheme, 'winforms-designer-advisor');
  assert.strictEqual(preview.modifiedUri.scheme, 'winforms-designer-advisor');

  const originalDocument = await vscode.workspace.openTextDocument(preview.originalUri);
  const modifiedDocument = await vscode.workspace.openTextDocument(preview.modifiedUri);
  assert.strictEqual(originalDocument.getText(), baseline, 'S126 read-only original diff did not preserve exact baseline bytes');
  assert.strictEqual(modifiedDocument.getText(), expected, 'S126 read-only modified diff did not expose exact planned bytes');
  assert.strictEqual(originalDocument.isDirty, false);
  assert.strictEqual(modifiedDocument.isDirty, false);
  const diffTab = vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .find((candidate) => candidate.input instanceof vscode.TabInputTextDiff
      && candidate.input.original.toString() === preview.originalUri?.toString()
      && candidate.input.modified.toString() === preview.modifiedUri?.toString());
  assert.ok(diffTab, 'S126 visible command did not open the exact read-only VS Code diff tab');
  assert.strictEqual(diffTab.isDirty, false);
  assert.strictEqual(testApi.openDesignerState(uri)?.designerText, baseline,
    'S126 preview mutated the CustomDocument before acceptance');
  assert.strictEqual(testApi.openDesignerState(uri)?.dirty, false,
    'S126 preview created a native history unit before acceptance');
  assert.strictEqual(activeCustomTab(uri)?.isDirty ?? false, false);
  artifacts.forEach((file, index) => assert.strictEqual(sha256File(file), hashes[index],
    `S126 preview changed ${path.basename(file)} on disk`));

  await testApi.focusOpenDesigner(uri);
  const generation = testApi.openDesignerState(uri)?.renderGeneration ?? 0;
  const applied = await vscode.commands.executeCommand<{
    status: 'applied' | 'refused'; reason?: string; afterSha256?: string;
  }>('winformsDesigner.applyPendingHighDpiQuickFix');
  assert.strictEqual(applied?.status, 'applied', `S126 Apply refused: ${applied?.reason ?? '<none>'}`);
  assert.strictEqual(applied?.afterSha256, hashText(expected));
  await waitFor(
    () => testApi.openDesignerState(uri)?.designerText === expected
      && testApi.openDesignerState(uri)?.dirty === true
      && activeCustomTab(uri)?.isDirty === true
      && (testApi.openDesignerState(uri)?.renderGeneration ?? 0) > generation,
    'S126 Apply did not create one rendered native CustomDocument history unit',
    60_000,
  );
  assert.strictEqual((testApi.openDesignerState(uri)?.designerText.match(/AutoScaleMode\.Font/g) ?? []).length, 1);
  artifacts.forEach((file, index) => assert.strictEqual(sha256File(file), hashes[index],
    `S126 unsaved Apply changed ${path.basename(file)} on disk`));

  await runDesignerHistoryCommand(testApi, uri, 'undo');
  await waitFor(() => testApi.openDesignerState(uri)?.designerText === baseline
    && testApi.openDesignerState(uri)?.dirty === false
    && activeCustomTab(uri)?.isDirty === false,
  'S126 native Undo did not restore the byte-exact clean baseline', 30_000);
  await runDesignerHistoryCommand(testApi, uri, 'redo');
  await waitFor(() => testApi.openDesignerState(uri)?.designerText === expected
    && testApi.openDesignerState(uri)?.dirty === true,
  'S126 native Redo did not restore the exact previewed patch', 30_000);
  await runDesignerHistoryCommand(testApi, uri, 'undo');
  await waitFor(() => testApi.openDesignerState(uri)?.designerText === baseline
    && testApi.openDesignerState(uri)?.dirty === false,
  'S126 final native Undo did not return to the clean baseline', 30_000);

  // V2-FND-001-S128 product guard: preview against the clean baseline, make a separate ordinary source edit, then prove the
  // retained advisor proposal refuses without replacing that newer edit or creating another history entry.
  const stalePreview = await vscode.commands.executeCommand<HighDpiPreviewCommandResult>(
    'winformsDesigner.previewHighDpiQuickFix',
  );
  assert.strictEqual(stalePreview?.status, 'previewed', `S128 product preview refused: ${stalePreview?.reason ?? '<none>'}`);
  await testApi.focusOpenDesigner(uri);
  await testApi.editOpenDesignerProperty(uri, 'this', 'Text', 'System.String', false, 'Newer ordinary edit');
  await waitFor(() => testApi.openDesignerState(uri)?.dirty === true
    && testApi.openDesignerState(uri)?.designerText.includes('this.Text = "Newer ordinary edit";') === true,
  'S128 interleaving edit did not reach the normal CustomDocument transaction');
  const newerText = testApi.openDesignerState(uri)?.designerText ?? '';
  const staleApply = await vscode.commands.executeCommand<{ status: 'applied' | 'refused'; reason?: string }>(
    'winformsDesigner.applyPendingHighDpiQuickFix',
  );
  assert.strictEqual(staleApply?.status, 'refused', 'S128 accepted a stale High-DPI advisor baseline');
  assert.match(staleApply?.reason ?? '', /stale/i);
  assert.strictEqual(testApi.openDesignerState(uri)?.designerText, newerText,
    'S128 stale refusal replaced the intervening source edit');
  await runDesignerHistoryCommand(testApi, uri, 'undo');
  await waitFor(() => testApi.openDesignerState(uri)?.designerText === baseline
    && testApi.openDesignerState(uri)?.dirty === false,
  'S128 cleanup Undo did not restore the clean baseline');

  artifacts.forEach((file, index) => assert.strictEqual(sha256File(file), hashes[index],
    `S126/S128 history changed ${path.basename(file)} on disk`));
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await waitFor(() => testApi.engineLifecycleState().openDesignerSessions === 0,
    'S126/S128 advisor sessions did not close', 30_000);
}
