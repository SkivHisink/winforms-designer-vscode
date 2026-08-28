import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { randomBytes } from 'crypto';
import { designerDpiScale, displayDprChanged } from './dpiScale';
import {
  EngineHandle,
  LayoutControl,
  TrayComponent,
  ToolStripItemBounds,
  GeometryRect,
  GeometryDragStartResult,
  ComponentDesc,
  DesignerAdornerHitResult,
  HostedDesignerProbeResult,
  HostedServiceKernelProductResult,
  VendorSmartTag,
  renderWithLayout,
  applyCachedTextPropertyEdit,
  renderCompiledWithLayout,
  renderInterpretedWithLayout,
  describeCompiledComponent,
  describeInterpretedComponent,
  setCompiledPropertyLive,
  resetCompiledPropertyLive,
  setCompiledCollectionLive,
  setCompiledTreeNodesLive,
  setCompiledToolStripItemsLive,
  setCompiledStringArrayLive,
  LiveCollItem,
  applyCompiledEdits,
  applyInterpretedEditsLive,
  removeCompiledControls,
  setCompiledZOrder,
  addCompiledControl,
  selectCompiledTabAt,
  hitTestTab,
  hitTestCompiledTab,
  hitTestInterpretedTab,
  hitTestDesignerAdorner,
  CompiledEdit,
  RenderLayout,
  ColumnItem,
  GridColumnItem,
  TreeNodeItem,
  listTreeNodes,
  setTreeNodes,
  ToolStripItemModel,
  listToolStripItems,
  setToolStripItems,
  describeLayout,
  beginGeometryDrag,
  authorizeGeometryBatch,
  geometryCandidateFromWindow,
  describeComponent,
  renderControl,
  setProperty,
  setPropertyViaProvenOwnedRegion,
  applyInheritedPropertyOverride,
  removeInheritedPropertyOverride,
  authorizeInheritedGeometryOverride,
  setProperties,
  setModifier,
  convertValue,
  editSupportedUiTypeEditor,
  SupportedUiTypeEditorResult,
  editSupportedCollectionEditor,
  editCertifiedVendorCollectionEditor,
  planBoundedComponentPatch,
  setTableCell,
  listCollectionItems,
  setCollectionItems,
  listGenericListItems,
  setGenericListItems,
  listStringArray,
  setStringArray,
  listColumns,
  setColumns,
  listGridColumns,
  setGridColumns,
  BindingItem,
  BindingItems,
  listBindings,
  setBindings,
  getDataSource,
  setDataSource,
  listDataSources,
  generateDataSource,
  bindApplicationSetting,
  DataSourcesResult,
  DataSourceGenerationResult,
  setExtender,
  resetProperty,
  resetProperties,
  setImageResource,
  listProjectImageResources,
  setProjectImageResource,
  ProjectResourceCandidate,
  makeLocalizable,
  LocalizeFormResult,
  setLocalizationCulture,
  setLocalizedResources,
  setLocalizedImageResource,
  LocalizedResourceEdit,
  serializeImageList,
  deserializeImageList,
  setCompiledImageListLive,
  discardCompiledLive,
  setImageList,
  generateEventHandler,
  listHandlerCandidates,
  findEventHandlerSourceIndex,
  setEventWiring,
  addControl,
  addLocalizedControl,
  removeLocalizedComponentResources,
  addComponent,
  listToolboxItems,
  listCompiledToolboxControls,
  ToolboxItemInfo,
  getDesignerPalette,
  DesignerPaletteInfo,
  listToolboxCandidates,
  scanToolboxAssembly,
  ToolboxCandidate,
  resolveDesignerDocumentOwner,
  DesignerDocumentOwnerResolution,
  resolveAssembly,
  removeControl,
  renameComponent,
  copyControl,
  pasteControl,
  pasteControlAtOffset,
  moveZOrder,
  moveTabPage,
  listTabPages,
  setTabPageOrder,
  reparentControl,
  addTabPage,
  addCompiledTab,
  removeTabPage,
  removeCompiledTab,
  moveCompiledTab,
  listCompiledVendorSmartTags,
  inspectCertifiedHostedDesigner,
  inspectCertifiedHostedServiceKernel,
  invokeCertifiedHostedServiceAction,
} from './engineClient';
import { COMPLEX_TYPE_SET, toCSharpExpression, shortName } from './valueExpr';
import { findNearestCsproj, findOwningCsproj, projectAssemblyName, projectReferencesAssembly, addReferenceToCsproj, resolveFrameworkOutput, resolveFrameworkOnlyOutput, projectTargetFramework, isFrameworkTfm, multiTargetHasFramework } from './csprojRef';
import { t, tn, injectL10nScript } from './i18n';
import { categorizeUnrepresentable, RenderDiagItem } from './renderDiagnostics';
import {
  discoverBuildOutputAssemblies,
  discoverProjectBuildOutputRoots,
  discoverProbeAssemblies,
  discoverRegisteredAssemblies,
  filterToolboxByRuntime,
  isUserEditDocument,
  refuseTierDToolboxRequest,
  ToolboxRuntimeFilter,
  uniqueAssemblyPaths,
} from './toolboxDiscovery';

/** One entry of the vendor's declared Tasks menu as the CANVAS sees it: the vendor's label, plus the verb this
* designer runs for it (null → shown disabled, because we have no source-first equivalent). See vendorTagsFor. */
interface VendorTagView {
  label: string;
  methodName: string;
  verb: 'addTab' | 'deleteTab' | 'showProperties' | null;
  closesPanel: boolean;
}

const CERTIFIED_HOSTED_DESIGNER_COMPONENT = 'FakeVendor.CrashOnInitializeControl';
const CERTIFIED_HOSTED_DESIGNER_ID = 'repo.fakevendor.hosted-designer.v1';
const CERTIFIED_HOSTED_SERVICE_COMPONENT = 'FakeVendor.HostedServiceControl';
const CERTIFIED_HOSTED_SERVICE_ID = 'repo.fakevendor.hosted-service-kernel.v1';
const CERTIFIED_HOSTED_SERVICE_ACTION = 'applyServicePreset';
const CERTIFIED_HOSTED_SERVICE_REENTRANT_ACTION = 'cancelReentrantServiceAction';
import { atomicWriteLocalFile } from './atomicFile';
import { formSiblingsToDelete } from './formSiblings';
import { collectProjectEventSourcePaths } from './projectEventSources';
import { projectPathsFromSolutionFile } from './solutionProjects';
import { fileHasInlineInitializeComponent, mergeInlineEventEdits } from './inlineDesigner';
import { isLocalizableDesigner } from './localizable';
import { vendorTasksAvailable } from './vendorTasks';
import { chooseFormNoticeKind, FormNoticeKind } from './formNotice';
import { binaryResxCount } from './binaryResx';
import { isByteLocalEdit } from './byteLocal';
import { refuseWhileRenderFailed } from './renderGate';
import { sanitizeSelectedTabs, selectedTabsFromEntries } from './tabViewState';
import { retainSelectionId } from './selection';
import { learnMoreUrl } from './learnMore';
import {
  conventionalProjectResourcePair,
  isCanonicalProjectResourcePath,
  ProjectResourceFilePair,
  publishedProjectImagePropertyType,
  requestedProjectResourceAccessorRefusal,
} from './projectResources';
import { transitionResourceSetAtomic } from './resourceTransaction';
import { intersectMultiProperties, normalizeMultiSelection } from './multiProperty';
import {
  planWinFormsSaveAs,
  sha256Hex,
} from './documentStore';
import {
  DesignerResourceTransactionTarget,
  isPathInsideOrSame,
  runDesignerResourceTransaction,
} from './resourceTransactionCoordinator';
import { TransactionRunnerResult, TransactionUndoRegistration } from './transactionRunner';
import { TransactionJournalState } from './transactionJournal';
import { activeXControlsInDesignerSource, assemblyRequiresX86 } from './tierDCompatibility';
import { planAddFormMembership, resolveFormMembershipProject } from './formProjectMembership';

export type EngineKind = 'modern' | 'net48';
type EnsureEngine = (kind?: EngineKind) => Promise<EngineHandle>;
type AssemblyOverride = (file: string) => string | undefined;
/** 1.0.0 — give the user's build output back: release every handle the net48 engine holds on `assemblyPath`'s
* output dir (it unloads the child AppDomain that loaded it). True = a domain was actually unloaded. Registered
* at activation, because extension.ts — not the hub — owns the engine handles, and this must NEVER start an
* engine just to release: one that isn't running holds nothing. See engineClient.releaseCompiledAssembly. */
type ReleaseNet48Output = (assemblyPath: string) => Promise<boolean>;
/** Persist a form's control-source override (the per-form `controlSources` map) — the write side of
* AssemblyOverride, used by the T1.3 cross-runtime switch to remember the net48 compiled preview. */
type SetAssemblyOverride = (file: string, dll: string) => Promise<void>;

/** A .NET (Core/5+) build always emits `<name>.deps.json` (apps also `.runtimeconfig.json`) beside the
* assembly; a .NET Framework build emits neither. That sidecar's presence cleanly says which engine can load
* the control assembly: none → net48 (Framework/DevExpress compiled preview), else → modern. No assembly → modern. */
function detectEngineKind(assemblyPath: string | undefined): EngineKind {
  if (!assemblyPath) return 'modern';
  const base = assemblyPath.replace(/\.(dll|exe)$/i, '');
  try {
    if (fs.existsSync(base + '.deps.json') || fs.existsSync(base + '.runtimeconfig.json')) return 'modern';
  } catch { /* fall through to Framework */ }
  return 'net48';
}

/**
* 1.0.0 — the refcount key for a .NET Framework build output: its normalized output DIRECTORY.
*
* The engine keys its child AppDomain — and therefore every file handle it pins — on the output DIRECTORY, not on
* the assembly file: one domain serves every form built into the same bin dir, so releasing on behalf of one form
* releases them all (see DomainManager.ReleaseBinDir). The host must refcount at exactly that granularity.
* Refcounting per assembly FILE would look right and be wrong: two designers whose forms live in different dlls of
* one bin dir (an app + its control library) share ONE domain, so closing either would yank it out from under the
* other — the "released while still in use" bug, which costs the survivor a full domain + assembly reload.
*/
function net48OutputKey(assemblyPath: string): string {
  return normalize(path.dirname(assemblyPath));
}

/**
 * Localizable-form source boundary. ApplyResources-backed scalar, geometry, Color/Font, image and reset
 * operations are deliberately removed from this set and route through the selected culture's .resx.
 * Structural operations that would splice generated source or write code-behind stay refused up front:
 * they have no resource-only representation and would diverge from Visual Studio's localization model.
 * commit() is the airtight backstop for .Designer.cs (the single funnel every persisted text edit flows
 * through). This set spans BOTH message handlers: the canvas (onMessage) and the Properties panel
 * (WinFormsDesignerProvider.resolveWebviewView). Inspection-only messages (pick, select,
* copy, tabClick navigation, every list* collection read, navigate/list handler reads, viewCode,
* learnMore, showProperties, chooseItems, ready, save) are deliberately absent so inspection still
* works. Keep in sync with the mutating branches of BOTH handlers.
*/
const STALE_RENDER_BLOCKED = new Set<string>([
  // canvas (designer.js → onMessage)
  'manipulate', 'manipulateGroup', 'edit', 'alignControls', 'centerInForm', 'resizeControls',
  'dropControl', 'dropDataSource', 'removeControl', 'removeControls', 'cut', 'cutControls', 'paste', 'duplicate', 'duplicateDrag',
  'bringToFront', 'bringToFrontGroup', 'sendToBack', 'sendToBackGroup', 'tabRename',
  'stripAdd', 'stripMove', 'stripRename', 'stripRetype', 'stripDelete', 'trayRename', 'renameComponent', 'createDefaultHandler', 'addTab', 'deleteTab', 'moveTab',
  'designerActionCommand',
  // Properties panel (panel.js → resolveWebviewView). 'edit' is shared with the canvas above.
  'importImage', 'pickProjectImageResource', 'clearImage', 'resetProperty', 'setTableCell', 'setCollection', 'setStringArray',
  'setGenericList', 'uiTypeEditor', 'uiCollectionEditor',
  'setColumns', 'setTabPages', 'setGridColumns', 'setBindings', 'setDataSource', 'setExtender', 'setTreeNodes', 'setToolStripItems', 'setHandler', 'createHandler',
  'addControl', 'addComponent', 'generateDataSource', 'bindApplicationSetting', 'deleteSelected', 'outlineReparent', 'outlineMoveZOrder',
]);

// Canvas messages in this set describe geometry/selection from one concrete rendered bitmap. The browser blocks input
// while a newer image is decoding, and the host independently checks the exact generation so a delayed or forged
// message cannot act on the newer authoritative graph.
const CANVAS_GENERATION_GUARDED = new Set<string>(['pick', 'manipulate', 'manipulateGroup']);

const LOCALIZABLE_SOURCE_BLOCKED = new Set<string>(
  [...STALE_RENDER_BLOCKED].filter((type) => ![
    'edit', 'manipulate', 'manipulateGroup', 'alignControls', 'centerInForm', 'resizeControls',
    'dropControl', 'addControl',
    'removeControl', 'removeControls', 'deleteSelected',
    'outlineReparent',
    'setHandler', 'createHandler', 'createDefaultHandler',
    'importImage', 'clearImage', 'resetProperty', 'uiTypeEditor',
  ].includes(type)),
);

type PlacementSnapOverrideModifier = 'alt' | 'control' | 'shift' | 'disabled';
type LayoutMode = 'snapLines' | 'snapToGrid' | 'none';
function placementSnapOverrideModifier(resource?: vscode.Uri): PlacementSnapOverrideModifier {
  const raw = vscode.workspace.getConfiguration('winformsDesigner', resource).get<string>('placementSnapOverrideModifier', 'alt');
  return raw === 'control' || raw === 'shift' || raw === 'disabled' ? raw : 'alt';
}

interface ProjectEventSourceSnapshot {
  primaryPath: string | null;
  primaryDocument: vscode.TextDocument | null;
  paths: string[];
  documents: vscode.TextDocument[];
  versions: number[];
  texts: string[];
}
function placementLayoutMode(resource?: vscode.Uri): LayoutMode {
  const raw = vscode.workspace.getConfiguration('winformsDesigner', resource).get<string>('layoutMode', 'snapLines');
  return raw === 'snapToGrid' || raw === 'none' ? raw : 'snapLines';
}
function placementGridSize(resource?: vscode.Uri): number {
  const raw = vscode.workspace.getConfiguration('winformsDesigner', resource).get<number>('gridSize', 8);
  return Math.min(128, Math.max(2, Number.isFinite(raw) ? Math.round(raw) : 8));
}
function placementShowGrid(resource?: vscode.Uri): boolean {
  return vscode.workspace.getConfiguration('winformsDesigner', resource).get<boolean>('showGrid', false);
}
/** One row the Choose-Items dialog sends back on OK: its identity + whether the user has it checked. The host
* diffs these against the current toolbox membership to add/remove/hide items. */
type ChooseRow = {
  fqn: string; name: string; namespace?: string; assemblyName?: string;
  assemblyPath?: string; fromProject?: boolean; checked: boolean;
};

/** Per-form canvas state persisted in workspaceState. It is deliberately view-only metadata: no generated source
 * or .resx file is touched when the user locks controls or changes the zoom. */
interface DesignerCanvasState {
  zoom?: number;
  lockedIds?: string[];
  selectedTabs?: Record<string, string>;
}

/** Per-form state of the shared Properties / Outline / Toolbox / Data Sources view. Custom toolbox tabs are intentionally NOT
 * stored here: they are user-wide customization and live in globalState (ToolboxUiState below). */
interface DesignerPanelState {
  activeTab?: 'props' | 'outline' | 'toolbox' | 'data';
  toolboxCollapsed?: Record<string, boolean>;
  outlineCollapsed?: string[];
}

/** Workspace toolbox chrome. Chosen items themselves remain in DesignerHub.chosenItems; this stores the custom
 * category order plus presentation preferences so a reload reconstructs the same workspace-specific toolbox. */
interface ToolboxUiState {
  customTabs: Array<{ name: string; items: string[] }>;
  listView: boolean;
  sortAlpha: boolean;
  showAll: boolean;
}

interface DesignerViewState {
  canvas?: DesignerCanvasState;
  panel?: DesignerPanelState;
  localizationCulture?: string;
}

interface ToolboxScanCacheEntry {
  stamp: string;
  items: ToolboxCandidate[];
  error?: string;
}

/** Sentinel value of the events dropdown's "(new handler…)" option — must match the webviews. */
const NEW_HANDLER = 'new';

/** The "clear the reference" option in a component-reference dropdown (AcceptButton/CancelButton/ContextMenuStrip…).
* A fixed English token emitted by BOTH engines (DesignerDescribe.ReferenceNone / CompiledDescriber.ReferenceNone);
* the host maps a pick of it to `null`. Never a real field name (field names are valid C# identifiers). */
const REFERENCE_NONE = '(none)';

/** The synthetic "the ROOT form itself" reference option (DesignerDescribe.ReferenceThis / CompiledDescriber.ReferenceThis).
* The host maps a pick of it to a bare `this` splice (net9) / the ReferenceThis token (net48 resolves it to the live root).
* Like "(none)" it is a parenthesised token that can never be a real field name. */
const REFERENCE_THIS = '(this)';

function stringList(value: unknown, maxItems = 512): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const text = item.trim();
    if (!text || text.length > 512 || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= maxItems) break;
  }
  return out;
}

function boolMap(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, boolean> = {};
  for (const [key, flag] of Object.entries(value as Record<string, unknown>).slice(0, 128)) {
    if (key && key.length <= 256 && flag === true) out[key] = true;
  }
  return out;
}

function cultureName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (text === '') return '';
  return /^[A-Za-z]{2,8}(?:[-_][A-Za-z0-9]{1,8}){0,4}$/.test(text) ? text.replace(/_/g, '-') : undefined;
}

function isResolvedDocumentOwner(owner: DesignerDocumentOwnerResolution | undefined): boolean {
  if (!owner) return false;
  return owner.diagnosticCode === 'NONE'
    || owner.status === 'Resolved'
    || owner.status === 0;
}

function documentOwnerFailureMessage(owner: DesignerDocumentOwnerResolution | undefined): string {
  const code = owner?.diagnosticCode || 'UNKNOWN';
  if (code === 'MISSING_INITIALIZE_COMPONENT') {
    return t('designer.owner.missingInitializeComponent');
  }
  if (code === 'AMBIGUOUS_OWNER') {
    const owners = owner?.owners?.map((file) => path.basename(file)).join(', ') || 'multiple projects';
    return t('designer.owner.ambiguous', { owners });
  }
  if (code === 'NESTED_DESIGNER_UNSUPPORTED') {
    return t('designer.owner.nestedUnsupported', { type: owner?.typeName || 'nested Form' });
  }
  if (code === 'NO_PROJECT') {
    return t('designer.owner.noProject');
  }
  return t('designer.owner.failed', { code });
}

function sanitizeDesignerViewState(value: unknown): DesignerViewState {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const hasCanvas = !!raw.canvas && typeof raw.canvas === 'object';
  const hasPanel = !!raw.panel && typeof raw.panel === 'object';
  const canvasRaw = hasCanvas ? raw.canvas as Record<string, unknown> : {};
  const panelRaw = hasPanel ? raw.panel as Record<string, unknown> : {};
  const zoom = typeof canvasRaw.zoom === 'number' && Number.isFinite(canvasRaw.zoom)
    ? Math.max(0.1, Math.min(8, canvasRaw.zoom)) : undefined;
  const activeTab = panelRaw.activeTab === 'outline' || panelRaw.activeTab === 'toolbox' || panelRaw.activeTab === 'data'
    ? panelRaw.activeTab : 'props';
  return {
    canvas: hasCanvas ? {
      zoom,
      lockedIds: stringList(canvasRaw.lockedIds),
      selectedTabs: sanitizeSelectedTabs(canvasRaw.selectedTabs),
    } : undefined,
    panel: hasPanel ? {
      activeTab,
      toolboxCollapsed: Object.prototype.hasOwnProperty.call(panelRaw, 'toolboxCollapsed')
        ? boolMap(panelRaw.toolboxCollapsed) : undefined,
      outlineCollapsed: stringList(panelRaw.outlineCollapsed),
    } : undefined,
    localizationCulture: cultureName(raw.localizationCulture),
  };
}

function sanitizeToolboxUi(value: unknown): ToolboxUiState {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const customTabs: Array<{ name: string; items: string[] }> = [];
  const seen = new Set<string>();
  if (Array.isArray(raw.customTabs)) {
    for (const entry of raw.customTabs.slice(0, 64)) {
      if (!entry || typeof entry !== 'object') continue;
      const rec = entry as Record<string, unknown>;
      const name = typeof rec.name === 'string' ? rec.name.trim() : '';
      if (!name || name.length > 128 || seen.has(name)) continue;
      seen.add(name);
      customTabs.push({ name, items: stringList(rec.items, 512) });
    }
  }
  return {
    customTabs,
    listView: raw.listView !== false,
    sortAlpha: raw.sortAlpha === true,
    showAll: raw.showAll === true,
  };
}

/**
* Map a file the user opened to the .Designer.cs the engine should read — the "open Form1.cs → see the
* designer" mapping (the .Designer.cs is the generated partner, like in Visual Studio).
* Foo.cs → Foo.Designer.cs (only when that sibling exists)
* Foo.Designer.cs → itself (graceful: reopened the generated file directly)
 * Foo.cs (no sibling, inline InitializeComponent) → itself
*/
export function resolveDesignerFile(opened: string): string | null {
  if (/\.Designer\.cs$/i.test(opened)) {
    return fs.existsSync(opened) ? opened : null;
  }
  if (/\.cs$/i.test(opened)) {
    const sibling = opened.slice(0, -'.cs'.length) + '.Designer.cs';
    if (fs.existsSync(sibling)) return sibling;
    return fileHasInlineInitializeComponent(opened) ? opened : null;
  }
  return null;
}

/** True when `file` is a conventional generated pair or a conservatively-recognized inline WinForms form. */
export function hasDesignerSibling(file: string): boolean {
  return /\.cs$/i.test(file) && !/\.Designer\.cs$/i.test(file)
    && (fs.existsSync(file.slice(0, -'.cs'.length) + '.Designer.cs')
      || fileHasInlineInitializeComponent(file, true));
}

/**
* The file the "Open Designer" action should open the custom editor on.
* Foo.cs (+ sibling) → Foo.cs
* Foo.Designer.cs → Foo.cs if it exists, else Foo.Designer.cs itself
 * Foo.cs (inline InitializeComponent) → itself
*/
export function resolveOpenTarget(file: string): string | null {
  if (/\.Designer\.cs$/i.test(file)) {
    const partner = file.slice(0, -'.Designer.cs'.length) + '.cs';
    if (fs.existsSync(partner)) return partner;
    return fs.existsSync(file) ? file : null;
  }
  if (/\.cs$/i.test(file)) {
    return fs.existsSync(file.slice(0, -'.cs'.length) + '.Designer.cs')
      || fileHasInlineInitializeComponent(file) ? file : null;
  }
  return null;
}

/** True when the "Open Designer" action has somewhere to go (drives the editor-title button). */
export function canOpenDesigner(file: string): boolean {
  return resolveOpenTarget(file) !== null;
}

export interface LocalizationCultureChoice {
  cultureName: string;
  resxPath: string;
  label: string;
  description: string;
  neutral: boolean;
  exists: boolean;
}

function designerBasePath(file: string): string {
  return /\.Designer\.cs$/i.test(file) ? file.slice(0, -'.Designer.cs'.length)
    : /\.cs$/i.test(file) ? file.slice(0, -'.cs'.length) : file;
}

export function neutralResxPathForDesigner(file: string): string {
  return designerBasePath(file) + '.resx';
}

export function localizedResxPathForDesigner(file: string, culture: string): string {
  const name = cultureName(culture) ?? '';
  return name ? `${designerBasePath(file)}.${name}.resx` : neutralResxPathForDesigner(file);
}

function imageResourceAssignable(resourceType: string, targetType: string): boolean {
  const rt = resourceType.replace(/^global::/, '').replace(/\?.*$/, '');
  const tt = targetType.replace(/^global::/, '').replace(/\?.*$/, '');
  return rt === tt || (tt === 'System.Drawing.Image' && rt === 'System.Drawing.Bitmap');
}

export function discoverLocalizationCultures(file: string): LocalizationCultureChoice[] {
  const base = designerBasePath(file);
  const dir = path.dirname(base);
  const stem = path.basename(base);
  const neutral = neutralResxPathForDesigner(file);
  const choices: LocalizationCultureChoice[] = [{
    cultureName: '',
    resxPath: neutral,
    label: '$(globe) (Default)',
    description: path.basename(neutral),
    neutral: true,
    exists: fs.existsSync(neutral),
  }];
  const seen = new Set(['']);
  try {
    for (const name of fs.readdirSync(dir)) {
      const m = new RegExp('^' + escapeRegex(stem) + '\\.([A-Za-z]{2,8}(?:[-_][A-Za-z0-9]{1,8}){0,4})\\.resx$', 'i').exec(name);
      const normalized = cultureName(m?.[1]);
      if (!normalized || seen.has(normalized.toLowerCase())) continue;
      seen.add(normalized.toLowerCase());
      choices.push({
        cultureName: normalized,
        resxPath: path.join(dir, name),
        label: `$(globe) ${normalized}`,
        description: name,
        neutral: false,
        exists: true,
      });
    }
  } catch { /* no sibling directory access: keep the neutral option */ }
  return choices.sort((a, b) => Number(b.neutral) - Number(a.neutral) || a.cultureName.localeCompare(b.cultureName));
}

/**
* Coordinates the ACTIVE canvas designer (custom editor) with the two shared, dockable VS Code WebviewViews
* (Toolbox + Properties). There is one pair of side views but possibly several open designer editors; the
* views always mirror the focused one. Sessions push grid/toolbox state through here (gated to the active
* session); the view providers route user actions back to `activeSession`. Singleton.
*/
export class DesignerHub {
  private static _instance: DesignerHub | undefined;
  static get instance(): DesignerHub { return (this._instance ??= new DesignerHub()); }

  private active: DesignerSession | null = null;
  /** The single dockable WebviewView hosting BOTH the Properties and Toolbox tabs (switched at its bottom). */
  panel: vscode.Webview | null = null;
  /** extensionUri captured when the panel resolved — needed to re-emit its HTML on a live language switch. */
  private panelExtensionUri: vscode.Uri | undefined;
  /** Every open designer canvas session — so a live language switch can re-emit them all (not just the active). */
  private readonly openSessions = new Set<DesignerSession>();
  private readonly _onSessionCount = new vscode.EventEmitter<number>();
  /** Product lifecycle signal: the extension owns engine residency, while the hub owns the exact open-session count. */
  readonly onDidChangeSessionCount = this._onSessionCount.event;
  get openSessionCount(): number { return this.openSessions.size; }

  private memento: vscode.Memento | undefined;
  private workspaceMemento: vscode.Memento | undefined;
  /** The designer clipboard (Cut/Copy → Paste), shared across all open designer editors like VS. Each entry is
   * an OPAQUE engine blob (from copyControl) handed back to pasteControl; `label` is a human display name. */
  clipboard: { clips: string[]; label: string } | null = null;

  /** Items the user ADDED via "Choose Items" (each tagged with `category` = the toolbox tab it landed in).
   * Merged into the toolbox palette and persisted, so a chosen library control survives reloads. */
  chosenItems: ToolboxItemInfo[] = [];
  /** Framework palette items the user UNCHECKED in "Choose Items" — filtered out of the toolbox. */
  private hidden = new Set<string>();
  /** Workspace toolbox category/order preferences. Category collapse is per form and lives in DesignerViewState. */
  toolboxUi: ToolboxUiState = { customTabs: [], listView: true, sortAlpha: false, showAll: false };
  /** Explicit Browse… assemblies and their reflection results survive reloads. Cache entries are invalidated by the
   * exact file size+mtime stamp, so rebuilding a control library never serves stale types. */
  browsedToolboxAssemblies: string[] = [];
  private toolboxScanCache: Record<string, ToolboxScanCacheEntry> = {};

  /** The color/font palette (KnownColors + installed fonts + unit suffixes). Engine-wide static, so it's
   * fetched once by the first session and reused by all — cached here, re-pushed to the panel on refresh. */
  private palette: DesignerPaletteInfo | undefined;
  /** In-flight fetch, memoized so concurrent first-renders (two sessions, or refreshToolbox+fullRender racing)
   * issue exactly ONE GetDesignerPalette RPC instead of duplicating the round-trip. */
  private paletteFetch: Promise<DesignerPaletteInfo> | undefined;
  get hasPalette(): boolean { return this.palette !== undefined; }
  /** Fetch the palette once (engine-wide static, machine-global) and cache it. Idempotent; a failed fetch
   * clears the latch so a later call retries. */
  async ensurePalette(fetch: () => Promise<DesignerPaletteInfo>): Promise<void> {
    if (this.palette) return;
    if (!this.paletteFetch) this.paletteFetch = fetch();
    try { this.palette = await this.paletteFetch; }
    catch { this.paletteFetch = undefined; /* let a later call retry */ }
  }
  /** Push the cached palette to the panel if this session is the mirrored one (no-op until fetched). */
  pushPaletteTo(s: DesignerSession): void { if (this.palette) this.pushPanel(s, { type: 'palette', palette: this.palette }); }

  isHidden(fqn: string): boolean { return this.hidden.has(fqn); }
  get hiddenFqns(): string[] { return [...this.hidden]; }

  /** Wire up persistence (call once at activation). User-curated toolbox membership and tabs are workspace-local;
   * the metadata reflection cache stays global because its path plus size/mtime key is workspace-independent. */
  initState(memento: vscode.Memento, workspaceMemento?: vscode.Memento): void {
    this.memento = memento;
    this.workspaceMemento = workspaceMemento;
    // v1.7 and earlier stored curation globally. Seed an unset workspace key once from that legacy value so the v1.8
    // scope correction does not make an existing user's chosen/hidden controls and custom tabs appear to vanish.
    const scopedValue = <T>(key: string, fallback: T): T => {
      if (!workspaceMemento) return memento.get<T>(key, fallback);
      const current = workspaceMemento.get<T>(key);
      if (current !== undefined) return current;
      const migrated = memento.get<T>(key, fallback);
      void workspaceMemento.update(key, migrated);
      return migrated;
    };
    this.chosenItems = scopedValue<ToolboxItemInfo[]>('chosenToolboxItems', []);
    this.hidden = new Set(scopedValue<string[]>('hiddenToolboxFqns', []));
    this.toolboxUi = sanitizeToolboxUi(scopedValue<unknown>('toolboxUiState', null));
    this.browsedToolboxAssemblies = uniqueAssemblyPaths(
      scopedValue<string[]>('browsedToolboxAssemblies', []));
    const storedCache = memento.get<Record<string, ToolboxScanCacheEntry>>('toolboxScanCache', {});
    this.toolboxScanCache = storedCache && typeof storedCache === 'object' ? storedCache : {};
  }
  /** Replace the toolbox customization (added + hidden), persist it, and re-push the merged toolbox. */
  setToolboxCustomization(chosen: ToolboxItemInfo[], hidden: string[]): void {
    this.chosenItems = chosen;
    this.hidden = new Set(hidden);
    const toolboxState = this.workspaceMemento ?? this.memento;
    void toolboxState?.update('chosenToolboxItems', chosen);
    void toolboxState?.update('hiddenToolboxFqns', [...this.hidden]);
    void this.active?.refreshToolbox();
  }

  /** Persist workspace-specific custom toolbox tabs and presentation preferences reported by panel.js. */
  setToolboxUi(state: unknown): void {
    this.toolboxUi = sanitizeToolboxUi(state);
    void (this.workspaceMemento ?? this.memento)?.update('toolboxUiState', this.toolboxUi);
  }

  addBrowsedToolboxAssembly(file: string): void {
    this.browsedToolboxAssemblies = uniqueAssemblyPaths([...this.browsedToolboxAssemblies, file]);
    void (this.workspaceMemento ?? this.memento)?.update('browsedToolboxAssemblies', this.browsedToolboxAssemblies);
  }

  private assemblyStamp(file: string, probeDirectories: readonly string[] = []): string | undefined {
    try {
      const stat = fs.statSync(file);
      const probes = probeDirectories
        .map((dir) => {
          try {
            const full = path.resolve(dir);
            const dirStat = fs.statSync(full);
            return `${normalize(full)}:${dirStat.mtimeMs}`;
          } catch { return ''; }
        })
        .filter(Boolean)
        .sort();
      return `${stat.size}:${stat.mtimeMs}|${probes.join('|')}`;
    } catch { return undefined; }
  }

  cachedToolboxScan(file: string, probeDirectories: readonly string[] = []): ToolboxScanCacheEntry | undefined {
    const key = normalize(file);
    const entry = this.toolboxScanCache[key];
    const stamp = this.assemblyStamp(file, probeDirectories);
    return entry && stamp && entry.stamp === stamp ? entry : undefined;
  }

  storeToolboxScan(file: string, items: ToolboxCandidate[], error?: string, probeDirectories: readonly string[] = []): void {
    const stamp = this.assemblyStamp(file, probeDirectories);
    if (!stamp) return;
    const key = normalize(file);
    this.toolboxScanCache[key] = { stamp, items: items.slice(0, 2048), error };
    const keys = Object.keys(this.toolboxScanCache);
    for (let i = 0; i < keys.length - 256; i++) delete this.toolboxScanCache[keys[i]];
    void this.memento?.update('toolboxScanCache', this.toolboxScanCache);
  }

  /** The form-specific view state. Invalid/old entries degrade to an empty state instead of reaching the webview. */
  formViewState(file: string): DesignerViewState {
    const all = this.workspaceMemento?.get<Record<string, DesignerViewState>>('designerViewStates', {}) ?? {};
    return sanitizeDesignerViewState(all[normalize(file)]);
  }

  updateFormViewState(file: string, patch: Partial<DesignerViewState>): void {
    if (!this.workspaceMemento) return;
    const key = normalize(file);
    const all = { ...(this.workspaceMemento.get<Record<string, DesignerViewState>>('designerViewStates', {}) ?? {}) };
    const before = sanitizeDesignerViewState(all[key]);
    all[key] = sanitizeDesignerViewState({
      canvas: patch.canvas ?? before.canvas,
      panel: patch.panel ?? before.panel,
      localizationCulture: patch.localizationCulture ?? before.localizationCulture,
    });
    // Bound stale state: keep the most recently written 256 form entries. JS object insertion order is stable, so
    // delete+reinsert moves this form to the tail before pruning the oldest keys.
    const current = all[key];
    delete all[key];
    all[key] = current;
    const keys = Object.keys(all);
    for (let i = 0; i < keys.length - 256; i++) delete all[keys[i]];
    void this.workspaceMemento.update('designerViewStates', all);
  }

  get activeSession(): DesignerSession | null { return this.active; }

  /** Fires when the mirrored (focused) designer changes — the status bar reflects the active form's control source. */
  private readonly _onActive = new vscode.EventEmitter<void>();
  readonly onDidChangeActive = this._onActive.event;

  setActive(s: DesignerSession | null): void {
    this.active = s;
    if (s) s.refreshViews();
    else this.toPanel({ type: 'clear' });
    this._onActive.fire();
  }
  /** When a session closes: if it owned the panel, blank it (another focus will re-populate). */
  clearIfActive(s: DesignerSession): void { if (this.active === s) this.setActive(null); }
  /** Re-fire the active-changed signal so the status bar re-reads the active session (e.g. after a render
   * determines the engine kind / compiled-preview badge). */
  refreshStatus(): void { this._onActive.fire(); }

  toPanel(msg: unknown): void { void this.panel?.postMessage(msg); }
  /** From a session — forward to the panel only if it's the one currently mirrored. */
  pushPanel(s: DesignerSession, msg: unknown): void { if (this.active === s) this.toPanel(msg); }

  /** Called by the panel provider when its WebviewView resolves — remember the webview + its extensionUri so a
   * live language switch can re-emit the panel HTML with the new locale's injected catalog. */
  attachPanel(webview: vscode.Webview, extensionUri: vscode.Uri): void {
    this.panel = webview;
    this.panelExtensionUri = extensionUri;
  }
  registerSession(s: DesignerSession): void {
    const before = this.openSessions.size;
    this.openSessions.add(s);
    if (this.openSessions.size !== before) this._onSessionCount.fire(this.openSessions.size);
  }
  unregisterSession(s: DesignerSession): void {
    if (this.openSessions.delete(s)) this._onSessionCount.fire(this.openSessions.size);
  }
  /** Live language switch (`winformsDesigner.language` changed): re-emit the panel + every open designer canvas so
   * their injected catalog + host-built HTML pick up the new locale immediately. Each reloaded webview re-sends
   * `ready`, which rehydrates it (panel → refreshViews, canvas → fullRender). The manifest "chrome" (command
   * palette, settings page) still needs a window reload — that's what the accompanying toast offers. */
  rebuildOpenWebviews(): void {
    if (this.panel && this.panelExtensionUri) this.panel.html = panelHtml(this.panel, this.panelExtensionUri);
    for (const s of [...this.openSessions]) s.rebuildHtml();
  }

  /** Re-render sessions whose out-of-process engine exited. A null delay means the crash-loop guard paused
   * automatic restarts; those sessions remain safely read-only until the next explicit render/reload. */
  handleEngineCrash(kind: EngineKind, delayMs: number | null): void {
    for (const session of [...this.openSessions]) session.handleEngineCrash(kind, delayMs);
  }

  /** 1.0.0 — wire the "hand the build output back" doer (call once at activation; extension.ts owns the engines).
   * Unset until then, which is safe: no engine can be running before activation, so nothing is pinned. */
  private releaseNet48: ReleaseNet48Output | undefined;
  setNet48Release(release: ReleaseNet48Output): void { this.releaseNet48 = release; }
  /** Whether a net48 engine process is ALREADY running. Closing a designer hands its interpreted graph back, but that
   * must never be a reason to START an engine — there is nothing to discard in a process that does not exist, and a
   * fresh worker created at close time would race the output release that follows it. */
  private net48Running: (() => boolean) | undefined;
  setNet48RunningProbe(probe: () => boolean): void { this.net48Running = probe; }
  get isNet48EngineRunning(): boolean { return this.net48Running?.() ?? false; }

  private net48TaskDepth = 0;
  get net48TaskActive(): boolean { return this.net48TaskDepth > 0; }
  beginNet48Task(name: string): void {
    this.net48TaskDepth++;
    if (this.net48TaskDepth !== 1) return;
    for (const session of [...this.openSessions]) {
      if (session.isCompiledPreview) session.beginBuildTask(name);
    }
  }
  async endNet48Task(): Promise<void> {
    if (this.net48TaskDepth > 0) this.net48TaskDepth--;
    if (this.net48TaskDepth !== 0) return;
    const sessions = [...this.openSessions].filter((session) => session.isCompiledPreview);
    await Promise.allSettled(sessions.map((session) => session.finishBuildTask()));
  }

  /**
   * 1.0.0 — the .NET Framework build outputs the currently-open designers render from, deduplicated by output
   * DIRECTORY (see net48OutputKey — the granularity the engine pins at). Drives the release-for-rebuild command:
   * one release per distinct dir is all it takes to free every one of them.
   */
  net48OutputsInUse(): string[] {
    const byDir = new Map<string, string>();
    for (const s of this.openSessions) {
      const asm = s.isCompiledPreview ? s.controlAssembly : undefined;
      if (asm) byDir.set(net48OutputKey(asm), asm);
    }
    return [...byDir.values()];
  }

  /**
   * 1.8.0 — what the external-build watch has to look at for each pinned output: the output itself, plus the
   * directory of the .csproj that owns the FORM.
   *
   * The project directory is not derivable from the output: with a custom `OutputPath` the build output can live
   * anywhere, and the intermediate directory MSBuild compiles into (the early signal that a build is coming) is
   * `<project>\obj` regardless. Guessing it from the output path only works for a conventional `bin\<Config>[\<Tfm>]`
   * layout — and the fallback of "watch the output directory instead" cannot cover a blocked copy, because a copy
   * MSBuild is refused never changes the destination and so never raises an event.
   */
  net48BuildWatchTargets(): { output: string; projectDir?: string }[] {
    const byDir = new Map<string, { output: string; projectDir?: string }>();
    for (const s of this.openSessions) {
      const asm = s.isCompiledPreview ? s.controlAssembly : undefined;
      if (!asm) continue;
      const key = net48OutputKey(asm);
      const known = byDir.get(key);
      let projectDir: string | undefined;
      const form = s.designerFilePath;
      if (form) {
        const csproj = findOwningCsproj(path.dirname(form), vscode.workspace.getWorkspaceFolder(vscode.Uri.file(form))?.uri.fsPath);
        if (csproj) projectDir = path.dirname(csproj);
      }
      // Keep the first entry that actually resolved a project — two forms can share an output dir while only one of
      // them sits under a findable .csproj (a shared project has none of its own).
      if (!known) byDir.set(key, { output: asm, projectDir });
      else if (!known.projectDir && projectDir) byDir.set(key, { output: known.output, projectDir });
    }
    return [...byDir.values()];
  }

  /**
   * 1.0.0 — a net48 session closed: give its build output back, but ONLY if no other open designer still renders
   * from that same output dir. Two designers on forms from one project is the NORMAL case, and releasing under a
   * live one would unload the very domain it draws from, costing it a full domain + assembly reload on its next
   * render — precisely the regression this refcount exists to prevent.
   *
   * Callers pass their own assembly AFTER unregistering themselves (see DesignerSession.dispose), so the scan below
   * counts only the sessions that are genuinely still open.
   */
  releaseNet48OutputIfUnused(asm: string): void {
    const key = net48OutputKey(asm);
    for (const s of this.openSessions) {
    if (s.isCompiledPreview && s.controlAssembly && net48OutputKey(s.controlAssembly) === key) return; // still in use
    }
    // Fire-and-forget: the caller (dispose) is synchronous and this is an async RPC. The registered doer already
    // swallows + logs its own failures; this catch is the contract guard that keeps a rejection from ever becoming
    // an unhandled rejection during editor teardown. A release that fails costs only the handles staying held
    // until the next release / engine exit — never correctness.
    void this.releaseNet48?.(asm).catch(() => { /* never let a failed release escape a dispose */ });
  }
}

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/** True when `e` is a VS Code "file not found" filesystem error (a delete of an already-absent file). Used so a
* resx-undo delete treats "already gone" as success but lets a real lock/permission failure propagate. */
function isFileNotFound(e: unknown): boolean {
  return (e instanceof vscode.FileSystemError && e.code === 'FileNotFound')
    || (!!e && typeof e === 'object' && (e as NodeJS.ErrnoException).code === 'ENOENT');
}

/**
* Write `bytes` to `uri` ATOMICALLY: stage to a sibling temp file, then rename over the target. On a local
* filesystem the rename is atomic, so a crash / disk-full / power-cut mid-write can never leave the target
* TRUNCATED — the failure mode where a save destroys the very file it was persisting.
*
* 0.11.0 introduced this for the sibling .resx (which holds large binary blobs); 1.0 uses it for the .Designer.cs
* too. Guarding the resource file but writing the FORM ITSELF with a plain writeFile had it backwards: a half-written
* .resx costs an image, a half-written .Designer.cs costs the form.
*
* The temp lives in the SAME directory as the target so the rename stays on one volume; it is cleaned up if either
* step fails. The temp name is unique across sessions AND processes (module-global counter + pid), so two windows
* writing the same file can't stage onto each other's temp.
*
* A SYMLINK target is written THROUGH with a direct write (which follows the link), never temp+renamed — a rename
* would replace the link entry with a regular file and destroy the link, leaving the real target stale (VS Code's
* own disk provider declines atomic writes for symlinks for the same reason).
*/
async function atomicWrite(uri: vscode.Uri, bytes: Uint8Array): Promise<void> {
  let isSymlink = false;
  try { isSymlink = ((await vscode.workspace.fs.stat(uri)).type & vscode.FileType.SymbolicLink) !== 0; }
  catch { /* not found / unreadable → treat as a normal new file (the atomic temp+rename path) */ }
  if (isSymlink) { await vscode.workspace.fs.writeFile(uri, bytes); return; }
  // A non-local provider (remote/virtual FS) offers no replace primitive to build on — write straight through.
  if (uri.scheme !== 'file') { await vscode.workspace.fs.writeFile(uri, bytes); return; }
  // Deliberately NOT vscode.workspace.fs.rename: its overwrite deletes the target first, so every save briefly
  // removed the .Designer.cs from disk and the Explorer showed the form's designer file vanish and come back.
  await atomicWriteLocalFile(uri.fsPath, bytes);
}

/** Read a file's bytes, stripping a leading UTF-8 BOM and remembering it (so a save can re-add it). */
async function readDesignerBytesUri(uri: vscode.Uri): Promise<{ text: string; hadBom: boolean }> {
  const buf = Buffer.from(await vscode.workspace.fs.readFile(uri));
  const hadBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  return { text: hadBom ? buf.subarray(3).toString('utf8') : buf.toString('utf8'), hadBom };
}

/**
* The editable payload of the designer custom editor: the `.Designer.cs` text, held IN MEMORY (never as an
* open VS Code TextDocument). This is the key to issue #2 — applying designer edits to a `TextDocument` for
* the generated file surfaces it as a dirty editor tab; owning the text here means the VISIBLE form tab
* (Foo.cs) is the dirty/undoable thing and `.Designer.cs` is only written on save, like Visual Studio.
* One document ⇄ one DesignerSession (supportsMultipleEditorsPerDocument is false).
*/
class DesignerSourceConflictError extends Error {
  readonly code = 'STALE_SOURCE';

  constructor() {
    super(t('status.designerDiskConflict'));
    this.name = 'DesignerSourceConflictError';
  }
}

function saveAsTypeName(designerText: string, destinationStem: string): { sourceType: string; destinationType: string } {
  const sourceType = /\bpartial\s+class\s+([\p{L}_][\p{L}\p{N}_]*)/u.exec(designerText)?.[1];
  if (!sourceType || !/^[\p{L}_][\p{L}\p{N}_]*$/u.test(destinationStem)) {
    throw new Error(`Save As refused: ${destinationStem} is not a valid C# form type name`);
  }
  return { sourceType, destinationType: destinationStem };
}

function renameSavedFormType(text: string, sourceType: string, destinationType: string): string {
  if (sourceType === destinationType) return text;
  const escaped = sourceType.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(
    new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'gu'),
    destinationType,
  );
}

export class WinFormsDesignDocument implements vscode.CustomDocument {
  /** Live designer text the engine renders/edits (BOM-less, matching VS Code's getText() semantics). */
  designerText: string;
  /** The text as last written to disk — `designerText !== savedDesignerText` ⇒ the canvas "unsaved" mark. */
  savedDesignerText: string;
  /** Bumped on every text change (edit/undo/redo/revert); guards async engine round-trips against races. */
  rev = 0;
  /** The session driving this document's canvas (set in resolveCustomEditor; used by save/revert). */
  session: DesignerSession | undefined;
  /** Mutable: an external write may add/remove the BOM while we're clean — adopt it with the disk baseline. */
  private hadBom: boolean;
  private readonly _onDispose = new vscode.EventEmitter<void>();
  readonly onDidDispose = this._onDispose.event;

  /** Did the .Designer.cs actually exist when we took our baseline? A file that WAS there and is gone now was
   * deleted by someone else — an external change the save must refuse, not silently recreate. Only a file that was
   * never there is a free first write. */
  private savedExisted: boolean;

  /** True when the opening read FAILED for a reason other than "not there" (locked, permissions, provider error):
   * we hold NO trustworthy baseline — not its text, not its BOM, not even whether it exists. Every write must
   * refuse until a successful read establishes one, otherwise an unreadable EXISTING file is indistinguishable
   * from an absent one and the deletion/conflict guards are simply bypassed. */
  private _baselineUnknown: boolean;
  /** Exact dirty localizable source image authorized by the engine's bounded event-wiring gate. A recovered/manual
   * ApplyResources-backed edit has no token and remains unsavable; equality makes the capability non-transferable. */
  private authorizedLocalizableEventText: string | null = null;
  /** A hot-exit backup restores the current bytes, but VS Code cannot recreate extension-owned undo closures.
   * Register exactly one recovered edit for the frozen S003 contract (one unsaved move / one undo unit), so the
   * native stack again has the saved disk image below the recovered image instead of a permanently dirty dead end. */
  private recoveredUndoRegistered = false;

  constructor(
    readonly uri: vscode.Uri,
    readonly designerFile: string | null,
    initialText: string,
    /** The real on-disk text. Differs from initialText only for a recovered (dirty) hot-exit backup. */
    savedText: string,
    hadBom: boolean,
    savedExisted = false,
    baselineUnknown = false,
    private readonly saveWholeFormAs?: (document: WinFormsDesignDocument, destination: vscode.Uri) => Promise<void>,
    private readonly recoveredFromBackup = false,
  ) {
    this.designerText = initialText;
    this.savedDesignerText = savedText;
    this.hadBom = hadBom;
    this.savedExisted = savedExisted;
    this._baselineUnknown = baselineUnknown;
  }

  get isDirty(): boolean { return this.designerText !== this.savedDesignerText; }

  /** No trustworthy on-disk baseline (the opening read failed for something other than "not there"). Read-only. */
  get baselineUnknown(): boolean { return this._baselineUnknown; }
  /** Latch the read-only state when a read FAILS after opening (deleted / locked / provider error): from that moment
   * we no longer know what our buffer relates to. Only a successful read (adoptDiskBaseline) may clear it. */
  markBaselineUnknown(): void { this._baselineUnknown = true; }
  /** The BOM of the baseline we hold — so a clean BOM-only external change can be adopted rather than refused later. */
  get bom(): boolean { return this.hadBom; }

  /** Exact generated-source disk baseline used when the document participates as an explicit transaction target. */
  transactionBaseline(): { text: string | null; bom: boolean } {
    return { text: this.savedExisted ? this.savedDesignerText : null, bom: this.hadBom };
  }

  /** A journaled transaction has already moved the generated source on disk to this state. Keep subsequent native
   * save/undo conflict checks aligned with those bytes instead of treating our own transaction as an external writer. */
  adoptTransactionBaseline(text: string | null, bom: boolean): void {
    this.savedDesignerText = text ?? '';
    this.savedExisted = text !== null;
    this.hadBom = bom;
    this._baselineUnknown = false;
  }

  authorizeLocalizableEventText(text: string | null): void { this.authorizedLocalizableEventText = text; }
  isAuthorizedLocalizableEventText(text: string): boolean { return this.authorizedLocalizableEventText === text; }

  private bytesOf(text: string): Uint8Array {
    const body = Buffer.from(text, 'utf8');
    return this.hadBom ? Buffer.concat([UTF8_BOM, body]) : body;
  }

  /** Adopt the on-disk text as the new clean baseline (revert / external change while clean). */
  adoptDiskBaseline(text: string, hadBom: boolean): void {
    this.designerText = text; this.savedDesignerText = text; this.hadBom = hadBom; this.rev++;
    this.savedExisted = true; // we just read it off disk …
    this._baselineUnknown = false; // … so the baseline is trustworthy again
    this.authorizedLocalizableEventText = null;
  }

  /** Persist to the .Designer.cs on disk (called by VS Code's save), preserving the original BOM. */
  async save(): Promise<void> {
    if (!this.designerFile) return;
    // Snapshot the exact text we write: if an edit/undo commits during the async write, the file holds this
    // snapshot, so only mark THAT as saved (a newer edit stays dirty — no silent data loss / reload-drop).
    const snapshot = this.designerText;
    // Refuse to flush a DIRTY generated-source buffer for a localizable form. Resource-first v1.5 edits
    // never dirty .Designer.cs, so the only way this state exists is a recovered hot-exit backup that a PRE-v1.5
    // version left holding a direct `this.x.Prop = …` assignment which diverges from the .resx. This native
    // save path never calls commit(), so without this guard it would persist the exact divergence the
    // source boundary forbids. Throw so VS Code keeps the document dirty and surfaces the reason — the user
    // must revert the file (or hand-resolve the recovered content). A CLEAN localizable form is never dirty
    // (isDirty === false → this is a no-op), so this never spuriously fails an ordinary save.
    if (this.isDirty && isLocalizableDesigner(snapshot) && !this.isAuthorizedLocalizableEventText(snapshot)) {
      throw new Error(t('status.localizableSaveRefused'));
    }
    await this.flushToDisk(snapshot);
  }

  /**
   * Persist the .Designer.cs the "Add Localization" conversion just produced.
   *
   * The refusal in {@link save} rests on an invariant: a localizable form is never dirty, because resource-first
   * edits only touch the .resx. The conversion is the one legitimate generated-source edit on a form that ends up
   * localizable, and it writes the .resx in the same transaction — so it restores that invariant itself by
   * flushing immediately, exactly as the sibling .resx is written immediately. Without this, the conversion would
   * leave the buffer in the one state the save path refuses to flush, and the user could not save their form.
   */
  async persistLocalizableConversion(): Promise<void> {
    if (!this.designerFile) return;
    await this.persistLocalizableConversionText(this.designerText);
  }

  async persistLocalizableConversionText(snapshot: string): Promise<void> {
    if (!this.designerFile) return;
    await this.flushToDisk(snapshot);
  }

  /** The write itself, with the on-disk conflict guards — shared by save() and the localizable conversion. */
  private async flushToDisk(snapshot: string): Promise<void> {
    if (!this.designerFile) return;
    // Never clobber a change someone else made since our on-disk baseline. `savedDesignerText` is what WE last
    // saw on disk; if the real file no longer matches it, an external writer (git checkout, Visual Studio, a
    // generator) got there first and blindly writing `snapshot` would silently destroy their revision — exactly
    // the "drops data on save" failure this designer is supposed to be fail-closed against. reloadFromDiskIfClean
    // only adopts an external change while the buffer is CLEAN; a dirty buffer (or an event the watcher never
    // delivered) leaves the baseline stale, and this is the backstop for both. Throwing keeps the document dirty
    // and surfaces the reason, mirroring the localizable refusal above — the user resolves it by reverting (which
    // adopts the disk text) or by saving the file elsewhere. The sibling .resx write path is already
    // conflict-guarded; this closes the same gap on the primary artifact.
    // No trustworthy baseline (the opening read failed for something other than "not there") → we cannot tell an
    // external change from our own, so there is nothing to compare against and writing would be a blind overwrite.
    if (this.baselineUnknown) throw new DesignerSourceConflictError();
    let onDisk: { text: string; hadBom: boolean } | null = null;
    try {
      onDisk = await readDesignerBytesUri(vscode.Uri.file(this.designerFile));
    } catch (e) {
      // Only a genuine "not there" is benign, and only if it was NEVER there: a file that existed when we took our
      // baseline and is gone now was deleted by someone else — an external change, not permission to recreate it.
      // Any other read failure (locked, permissions, transient) must surface rather than become a blind write.
      if (!isFileNotFound(e)) throw e;
      if (this.savedExisted) throw new DesignerSourceConflictError();
    }
    // Compare the BOM too: readDesignerBytesUri strips it, so a rewrite that only added/removed the BOM has identical
    // text and would otherwise slip through — and bytesOf would then write OUR old byte form back over it.
    if (onDisk !== null && (onDisk.text !== this.savedDesignerText || onDisk.hadBom !== this.hadBom)) {
      throw new DesignerSourceConflictError();
    }
    // Atomic (temp+rename): an interrupted write must never truncate the user's form. The read→compare→write window
    // above is inherent — VS Code's FS API has no compare-and-swap — but nothing awaits between the comparison and
    // this call, so it is as small as the platform allows.
    await atomicWrite(vscode.Uri.file(this.designerFile), this.bytesOf(snapshot));
    this.savedDesignerText = snapshot;
    this.savedExisted = true;
    this.authorizedLocalizableEventText = null;
    this.session?.notifySaved();
  }
  async saveAs(dest: vscode.Uri): Promise<void> {
    // 0.10.0 trust-floor — same recovered-dirty-buffer guard as save(): don't copy a divergent localizable
    // buffer to a new file. A clean localizable form (isDirty === false) still saves-as a faithful copy.
    if (this.isDirty && isLocalizableDesigner(this.designerText)
      && !this.isAuthorizedLocalizableEventText(this.designerText)) throw new Error(t('status.localizableSaveRefused'));
    // Without a trustworthy baseline we don't know what this buffer is relative to — don't copy it anywhere.
    if (this._baselineUnknown) throw new Error(t('status.designerDiskConflict'));
    // Save As on a designer writes the GENERATED partner, not generated code into a hand-edited .cs.
    const remapped = !/\.Designer\.cs$/i.test(dest.fsPath) && /\.cs$/i.test(dest.fsPath);
    const target = /\.Designer\.cs$/i.test(dest.fsPath) ? dest
      : remapped ? vscode.Uri.file(dest.fsPath.slice(0, -'.cs'.length) + '.Designer.cs')
        : dest;
    // VS Code's overwrite prompt covered the file the USER picked (NewForm.cs). When we remap to its generated
    // partner we write a path they were never asked about — so if that sidecar already exists it belongs to another
    // form, and clobbering it would be a silent data loss the dialog implied nothing about. Create it
    // CONDITIONALLY: a stat-then-write would just move the clobber into the gap between the two calls, whereas
    // createFile(overwrite:false, ignoreIfExists:false) is the platform's own create-if-absent — applyEdit returns
    // false when the file already exists, which is exactly our refusal. (ignoreIfExists:true would be wrong: it
    // turns a conflict into a successful-looking no-op.) A user who really means to replace a known .Designer.cs
    // can pick that exact file, and VS Code's own overwrite prompt then covers it.
    if (remapped) {
      if (this.saveWholeFormAs) {
        await this.saveWholeFormAs(this, dest);
        return;
      }
      // Save As represents the whole nested form item, even though the custom document's editable payload is the
      // generated source. Check EVERY destination belonging to an existing source artifact up front so a neutral or
      // localized .resx collision cannot be discovered only after another sidecar was created. The platform dialog
      // only knows about `dest`; it cannot authorize overwriting CopyOfForm.resx/CopyOfForm.Designer.cs on the user's
      // behalf. Aggregate all collisions into one refusal, matching the catalog's fail-closed VS-style contract.
      const sourceDir = path.dirname(this.uri.fsPath);
      const sourceStem = path.basename(this.uri.fsPath).replace(/\.cs$/i, '');
      const destinationStem = path.basename(dest.fsPath).replace(/\.cs$/i, '');
      const destinationDir = path.dirname(dest.fsPath);
      let sourceEntries: string[] = [];
      try { sourceEntries = fs.readdirSync(sourceDir); } catch { /* the main/generated targets are still checked */ }
      const companionTargets = formSiblingsToDelete(this.uri.fsPath, sourceEntries)
        .map((source) => {
          const name = path.basename(source);
          const suffix = name.slice(sourceStem.length);
          return vscode.Uri.file(path.join(destinationDir, destinationStem + suffix));
        });
      const candidates = [dest, target, ...companionTargets];
      const unique = new Map<string, vscode.Uri>();
      for (const candidate of candidates) unique.set(candidate.fsPath.toLocaleLowerCase('en-US'), candidate);
      const collisions: vscode.Uri[] = [];
      for (const candidate of unique.values()) {
        try {
          await vscode.workspace.fs.stat(candidate);
          collisions.push(candidate);
        } catch (error) {
          if (!isFileNotFound(error)) throw error;
        }
      }
      if (collisions.length > 0) {
        const names = collisions.map((candidate) => path.basename(candidate.fsPath)).join(', ');
        throw new Error(`${t('status.designerDiskConflict')} (${names})`);
      }
      const create = new vscode.WorkspaceEdit();
      create.createFile(target, { overwrite: false, ignoreIfExists: false, contents: this.bytesOf(this.designerText) });
      if (!await vscode.workspace.applyEdit(create)) throw new Error(t('status.designerDiskConflict'));
      return;
    }
    await atomicWrite(target, this.bytesOf(this.designerText));
  }
  async revert(): Promise<void> {
    if (!this.designerFile) return;
    // 0.11.0 write-safety note: File → Revert discards unsaved .Designer.cs (code) edits only. It does NOT roll
    // back a sibling .resx image import — the .resx is a resource file written+saved immediately (like VS, whose
    // Revert of a form's code likewise doesn't un-write its .resx). Ctrl+Z reverts an import's resource (commit's
    // undo closure); Revert is the "discard unsaved code" gesture, so a just-imported, referenced resource stays.
    const { text, hadBom } = await readDesignerBytesUri(vscode.Uri.file(this.designerFile));
    this.adoptDiskBaseline(text, hadBom);
    await this.session?.rerenderFromDoc();
  }
  async backup(dest: vscode.Uri): Promise<vscode.CustomDocumentBackup> {
    // The backup destination's parent directory may not exist yet (per the VS Code API contract).
    try { await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(dest, '..')); } catch { /* exists */ }
    await vscode.workspace.fs.writeFile(dest, this.bytesOf(this.designerText));
    return { id: dest.toString(), delete: async () => { try { await vscode.workspace.fs.delete(dest); } catch { /* ignore */ } } };
  }

  /** Recreate the one source-only native undo unit represented by a recovered hot-exit backup.
   *
   * The backup itself remains the exact generated-source byte image for backward compatibility. The on-disk image is
   * the edit's before state, and the recovered backup is its after state. Firing this only after the real session is
   * attached lets native Undo/Redo perform the same rerender/net48 reconciliation as an ordinary live designer edit. */
  registerRecoveredUndo(
    fireEdit: (event: vscode.CustomDocumentEditEvent<WinFormsDesignDocument>) => void,
  ): void {
    if (!this.recoveredFromBackup || this.recoveredUndoRegistered || !this.isDirty) return;
    this.recoveredUndoRegistered = true;
    const before = this.savedDesignerText;
    const after = this.designerText;
    fireEdit({
      document: this,
      label: 'Restore unsaved designer changes',
      undo: async () => {
        this.rev++;
        this.designerText = before;
        this.authorizeLocalizableEventText(null);
        await this.session?.rerenderFromDoc();
      },
      redo: async () => {
        this.rev++;
        this.designerText = after;
        this.authorizeLocalizableEventText(null);
        await this.session?.rerenderFromDoc();
      },
    });
  }

  dispose(): void { this._onDispose.fire(); this._onDispose.dispose(); }
}

/**
* The unified VS-style designer: a CustomEditorProvider on *.cs that renders the form on a canvas. Its custom
* document owns the sibling .Designer.cs text IN MEMORY (WinFormsDesignDocument), so designer edits never
* surface the generated file as a dirty tab — the visible Foo.cs form tab is the dirty/undoable thing, written
* to .Designer.cs only on save (issue #2). Toolbox/Properties live in a separate dockable WebviewView
* (DesignerPanelViewProvider), wired to the active designer via DesignerHub. priority "option" keeps the C#
* text editor the default; this opens via "Open Designer" / auto-open / "Reopen Editor With…".
*/
export class WinFormsDesignerProvider implements vscode.CustomEditorProvider<WinFormsDesignDocument> {
  public static readonly viewType = 'winformsDesigner.designer';

  private readonly _onDidChangeCustomDocument =
    new vscode.EventEmitter<vscode.CustomDocumentEditEvent<WinFormsDesignDocument>>();
  readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;
  private readonly openDocuments = new Map<string, WinFormsDesignDocument>();
  /** Serializes updates from concurrent CustomDocument backups. VS Code normally persists the backup id as part of
   * its editor input; this small workspace-local index is a fallback for a host restart followed by an explicit
   * "Open Designer" when the host could not persist editor state (notably Extension Development Host test profiles). */
  private hotExitRegistryQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly ensureEngine: EnsureEngine,
    private readonly getAssemblyOverride: AssemblyOverride,
    private readonly output: vscode.OutputChannel,
    private readonly onViewCode: (uri: vscode.Uri, position?: vscode.Position) => void,
    private readonly setAssemblyOverride: SetAssemblyOverride,
  ) {}

  private documentKey(uri: vscode.Uri): string {
    return process.platform === 'win32' ? uri.fsPath.toLocaleLowerCase('en-US') : uri.toString();
  }

  private hotExitRegistryUri(): vscode.Uri | undefined {
    return this.context.storageUri
      ? vscode.Uri.joinPath(this.context.storageUri, 'hot-exit-recovery-v1.json')
      : undefined;
  }

  private async readHotExitRegistry(): Promise<{
    version: 1;
    entries: Record<string, { documentUri: string; backupId: string }>;
  }> {
    const registryUri = this.hotExitRegistryUri();
    if (!registryUri) return { version: 1, entries: {} };
    try {
      const parsed = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(registryUri)).toString('utf8')) as {
        version?: unknown;
        entries?: unknown;
      };
      if (parsed.version !== 1 || !parsed.entries || typeof parsed.entries !== 'object' || Array.isArray(parsed.entries)) {
        return { version: 1, entries: {} };
      }
      const entries: Record<string, { documentUri: string; backupId: string }> = {};
      for (const [key, candidate] of Object.entries(parsed.entries)) {
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
        const entry = candidate as { documentUri?: unknown; backupId?: unknown };
        if (typeof entry.documentUri === 'string' && typeof entry.backupId === 'string') {
          entries[key] = { documentUri: entry.documentUri, backupId: entry.backupId };
        }
      }
      return { version: 1, entries };
    } catch {
      return { version: 1, entries: {} };
    }
  }

  private async writeHotExitRegistry(registry: {
    version: 1;
    entries: Record<string, { documentUri: string; backupId: string }>;
  }): Promise<void> {
    const registryUri = this.hotExitRegistryUri();
    if (!registryUri) return;
    if (Object.keys(registry.entries).length === 0) {
      try { await vscode.workspace.fs.delete(registryUri); } catch { /* absent */ }
      return;
    }
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(registryUri, '..'));
    await atomicWrite(registryUri, Buffer.from(`${JSON.stringify(registry, null, 2)}\n`, 'utf8'));
  }

  private updateHotExitRegistry(
    update: (entries: Record<string, { documentUri: string; backupId: string }>) => void,
  ): Promise<void> {
    const operation = this.hotExitRegistryQueue.catch(() => undefined).then(async () => {
      const registry = await this.readHotExitRegistry();
      update(registry.entries);
      await this.writeHotExitRegistry(registry);
    });
    // A failed optional fallback update must not poison later VS Code-owned backup calls. The returned operation still
    // rejects so the caller can log it, while the internal serialization chain remains usable.
    this.hotExitRegistryQueue = operation.catch(() => undefined);
    return operation;
  }

  private persistHotExitBackup(documentUri: vscode.Uri, backupId: string): Promise<void> {
    const key = this.documentKey(documentUri);
    return this.updateHotExitRegistry((entries) => {
      entries[key] = { documentUri: documentUri.toString(), backupId };
    });
  }

  private removeHotExitBackup(documentUri: vscode.Uri, backupId?: string): Promise<void> {
    const key = this.documentKey(documentUri);
    return this.updateHotExitRegistry((entries) => {
      if (!backupId || entries[key]?.backupId === backupId) delete entries[key];
    });
  }

  private async takeHotExitBackup(documentUri: vscode.Uri): Promise<string | undefined> {
    await this.hotExitRegistryQueue;
    const registry = await this.readHotExitRegistry();
    const key = this.documentKey(documentUri);
    const entry = registry.entries[key];
    if (!entry || entry.documentUri !== documentUri.toString()) return undefined;
    const storageUri = this.context.storageUri;
    let backupUri: vscode.Uri;
    try { backupUri = vscode.Uri.parse(entry.backupId); } catch { return undefined; }
    // Only consume backup destinations that VS Code allocated inside this extension's current workspace storage.
    // This prevents a malformed/tampered registry from turning an explicit designer reopen into an arbitrary read.
    const storagePrefix = storageUri?.path.endsWith('/') ? storageUri.path : `${storageUri?.path ?? ''}/`;
    const localRelative = storageUri?.scheme === 'file' && backupUri.scheme === 'file'
      ? path.relative(
        storageUri.fsPath.toLocaleLowerCase('en-US'),
        backupUri.fsPath.toLocaleLowerCase('en-US'),
      )
      : undefined;
    const ownedByWorkspaceStorage = localRelative !== undefined
      ? localRelative.length > 0 && localRelative !== '..'
        && !localRelative.startsWith(`..${path.sep}`) && !path.isAbsolute(localRelative)
      : !!storageUri && backupUri.scheme === storageUri.scheme
        && backupUri.authority === storageUri.authority && backupUri.path.startsWith(storagePrefix);
    if (!ownedByWorkspaceStorage) {
      await this.removeHotExitBackup(documentUri, entry.backupId);
      return undefined;
    }
    await this.removeHotExitBackup(documentUri, entry.backupId);
    return entry.backupId;
  }

  private async clearHotExitBackupIfClean(document: WinFormsDesignDocument): Promise<void> {
    if (document.isDirty) return;
    try { await this.removeHotExitBackup(document.uri); }
    catch (error) { this.output.appendLine(`[hot-exit] Clean-document recovery index could not be cleared: ${String(error)}`); }
  }

  private fireDocumentEdit(event: vscode.CustomDocumentEditEvent<WinFormsDesignDocument>): void {
    this._onDidChangeCustomDocument.fire({
      document: event.document,
      label: event.label,
      undo: async () => {
        await event.undo();
        await this.clearHotExitBackupIfClean(event.document);
      },
      redo: async () => {
        await event.redo();
        await this.clearHotExitBackupIfClean(event.document);
      },
    });
  }

  openDocumentState(uri: vscode.Uri): {
    dirty: boolean;
    designerFile: string | null;
    designerText: string;
    /** Bumped by every text mutation (commit/undo/redo/revert). A deterministic "the history callback actually ran
     * on THIS document" signal, so a test can tell an undo that was never delivered from one that restored the
     * wrong text — the two used to be indistinguishable behind one timeout. */
    revision: number;
    /** VS Code considers this designer's webview panel the ACTIVE editor. Custom-editor Undo/Redo routing keys on
     * the active editor pane, which is a different mirror from the tab model the suite waits on; recorded so a
     * failure can say which one disagreed. */
    panelActive: boolean;
    renderReady: boolean;
    engineKind: EngineKind | null; net48RenderMode: 'interpreted' | 'compiledFallback' | 'compiled' | null;
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
    lastFullRenderTelemetry: ProductRenderTelemetry | null;
    lastHostedDesignerProbe: HostedDesignerProbeResult | null;
    lastHostedServiceKernelResult: HostedServiceKernelProductResult | null;
    renderGeneration: number;
    currentId: string;
    currentSelectionIds: readonly string[];
    controls: readonly { id: string; parentId?: string | null; ownership?: LayoutControl['ownership']; editable?: boolean }[];
    tray: readonly { id: string; name: string; type: string; isStrip?: boolean }[];
    selectedPropertyComponent: {
      id: string;
      name: string;
      type: string;
      properties: readonly { name: string; value: string | null }[];
    } | null;
  } | undefined {
    const document = this.openDocuments.get(this.documentKey(uri));
    const session = document?.session?.extensionHostTestState();
    return document ? {
      dirty: document.isDirty,
      designerFile: document.designerFile,
      designerText: document.designerText,
      revision: document.rev,
      panelActive: session?.panelActive ?? false,
      renderReady: session?.renderReady ?? false,
      engineKind: session?.engineKind ?? null, net48RenderMode: session?.net48RenderMode ?? null,
      ownerDiagnosticCode: session?.ownerDiagnosticCode ?? null,
      ownerTypeName: session?.ownerTypeName ?? null,
      ownerProjectPath: session?.ownerProjectPath ?? null,
      ownerPaths: session?.ownerPaths ?? [],
      emptyInitializeComponentSurface: session?.emptyInitializeComponentSurface ?? false,
      renderFailureCause: session?.renderFailureCause ?? null,
      renderFailureMessage: session?.renderFailureMessage ?? null,
      lastPropertyPersistenceLane: session?.lastPropertyPersistenceLane ?? null,
      lastNet48PropertyEditTelemetry: session?.lastNet48PropertyEditTelemetry ?? null,
      lastModernPropertyEditTelemetry: session?.lastModernPropertyEditTelemetry ?? null,
      lastFullRenderTelemetry: session?.lastFullRenderTelemetry ?? null,
      lastHostedDesignerProbe: session?.lastHostedDesignerProbe ?? null,
      lastHostedServiceKernelResult: session?.lastHostedServiceKernelResult ?? null,
      renderGeneration: session?.renderGeneration ?? 0,
      currentId: session?.currentId ?? 'this',
      currentSelectionIds: session?.currentSelectionIds ?? ['this'],
      controls: session?.controls ?? [],
      tray: session?.tray ?? [],
      selectedPropertyComponent: session?.selectedPropertyComponent ?? null,
    } : undefined;
  }

  /** Extension Host E2E reads the exact revision-bound metadata sent to the Properties panel. This stays separate
   * from openDocumentState so its intentionally small snapshot contract remains stable for existing lifecycle tests. */
  openDocumentProperties(uri: vscode.Uri): ComponentDesc | null | undefined {
    const document = this.openDocuments.get(this.documentKey(uri));
    return document?.session?.extensionHostTestPublishedPropertyComponent();
  }

  /** Extension Host E2E reaches the exact DataBindings popup read side. */
  async listOpenDocumentBindings(uri: vscode.Uri, id: string): Promise<BindingItems> {
    const document = this.openDocuments.get(this.documentKey(uri));
    if (!document?.session) throw new Error(`No resolved WinForms designer session for ${uri.fsPath}`);
    return document.session.extensionHostTestListBindings(id);
  }

  /** Extension Host E2E reaches the exact atomic DataBindings popup OK transaction. */
  async setOpenDocumentBindings(uri: vscode.Uri, id: string, bindings: BindingItem[]): Promise<boolean> {
    const document = this.openDocuments.get(this.documentKey(uri));
    if (!document?.session) throw new Error(`No resolved WinForms designer session for ${uri.fsPath}`);
    return document.session.extensionHostTestSetBindings(id, bindings);
  }

  /** Extension Host E2E reaches the exact parse-only Data Sources refresh used by the dedicated panel. */
  async listOpenDocumentDataSources(uri: vscode.Uri): Promise<DataSourcesResult> {
    const document = this.openDocuments.get(this.documentKey(uri));
    if (!document?.session) throw new Error(`No resolved WinForms designer session for ${uri.fsPath}`);
    return document.session.extensionHostTestListDataSources();
  }

  /** Extension Host E2E drives the same opaque-schema Data Sources drop transaction as the panel/canvas. */
  async generateOpenDocumentDataSource(
    uri: vscode.Uri,
    schemaKey: string,
    mode: 'detail' | 'grid',
    parentId: string,
    x: number,
    y: number,
    includeNavigator: boolean,
    existingBindingSourceId: string | null,
    existingGridId: string | null,
  ): Promise<DataSourceGenerationResult> {
    const document = this.openDocuments.get(this.documentKey(uri));
    if (!document?.session) throw new Error(`No resolved WinForms designer session for ${uri.fsPath}`);
    return document.session.extensionHostTestGenerateDataSource(
      schemaKey, mode, parentId, x, y, includeNavigator, existingBindingSourceId, existingGridId);
  }

  /** Extension Host E2E reaches the exact project-resource picker commit after deterministic candidate selection. */
  async setOpenDocumentProjectImageResource(uri: vscode.Uri, id: string, propertyName: string,
    accessor: string): Promise<boolean> {
    const document = this.openDocuments.get(this.documentKey(uri));
    if (!document?.session) throw new Error(`No resolved WinForms designer session for ${uri.fsPath}`);
    return document.session.extensionHostTestSetProjectImageResource(id, propertyName, accessor);
  }

  /** Extension Host security E2E receives the typed refusal produced by the same deterministic picker ingress. */
  async tryOpenDocumentProjectImageResource(uri: vscode.Uri, id: string, propertyName: string,
    accessor: string): Promise<{ applied: boolean; refusalCode: string | null; reason: string | null }> {
    const document = this.openDocuments.get(this.documentKey(uri));
    if (!document?.session) throw new Error(`No resolved WinForms designer session for ${uri.fsPath}`);
    return document.session.extensionHostTestTryProjectImageResource(id, propertyName, accessor);
  }

  async importOpenDocumentLocalImage(uri: vscode.Uri, id: string, propertyName: string,
    propertyType: string, imageUri: vscode.Uri): Promise<boolean> {
    const document = this.openDocuments.get(this.documentKey(uri));
    if (!document?.session) throw new Error(`No resolved WinForms designer session for ${uri.fsPath}`);
    return document.session.extensionHostTestImportLocalImage(id, propertyName, propertyType, imageUri);
  }

  async setOpenDocumentImageListImages(uri: vscode.Uri, id: string,
    images: readonly { image: vscode.Uri; key?: string }[]): Promise<boolean> {
    const document = this.openDocuments.get(this.documentKey(uri));
    if (!document?.session) throw new Error(`No resolved WinForms designer session for ${uri.fsPath}`);
    return document.session.extensionHostTestSetImageListImages(id, images);
  }

  async setOpenDocumentImageListWithPostconditionFailure(uri: vscode.Uri, id: string,
    images: readonly { image: vscode.Uri; key?: string }[]): Promise<{
      applied: boolean;
      failureObserved: boolean;
      refusalCode: 'POSTCONDITION_FAILED_ROLLED_BACK' | null;
    }> {
    const document = this.openDocuments.get(this.documentKey(uri));
    if (!document?.session) throw new Error(`No resolved WinForms designer session for ${uri.fsPath}`);
    return document.session.extensionHostTestSetImageListWithPostconditionFailure(id, images);
  }

  /** Extension Host E2E selects one Language through the same normalization, state, and render path as QuickPick. */
  async setOpenDocumentLocalizationCulture(uri: vscode.Uri, culture: string): Promise<boolean> {
    const document = this.openDocuments.get(this.documentKey(uri));
    if (!document?.session) throw new Error(`No resolved WinForms designer session for ${uri.fsPath}`);
    return document.session.extensionHostTestSetLocalizationCulture(culture);
  }

  /** Extension Host E2E reads the full live layout through a dedicated surface so the stable open-state snapshot
   * remains intentionally small and exact-comparison friendly. */
  openDocumentLayout(uri: vscode.Uri): readonly LayoutControl[] {
    const document = this.openDocuments.get(this.documentKey(uri));
    if (!document?.session) throw new Error(`No resolved WinForms designer session for ${uri.fsPath}`);
    return document.session.extensionHostTestLayout();
  }

  async saveOpenDocument(uri: vscode.Uri): Promise<void> {
    const document = this.openDocuments.get(this.documentKey(uri));
    if (!document) throw new Error(`No open WinForms designer document for ${uri.fsPath}`);
    const cancellation = new vscode.CancellationTokenSource();
    try { await this.saveCustomDocument(document, cancellation.token); }
    finally { cancellation.dispose(); }
  }

  async saveOpenDocumentAs(uri: vscode.Uri, destination: vscode.Uri): Promise<void> {
    const document = this.openDocuments.get(this.documentKey(uri));
    if (!document) throw new Error(`No open WinForms designer document for ${uri.fsPath}`);
    const cancellation = new vscode.CancellationTokenSource();
    try { await this.saveCustomDocumentAs(document, destination, cancellation.token); }
    finally { cancellation.dispose(); }
  }

  private async saveWholeFormAs(document: WinFormsDesignDocument, destination: vscode.Uri): Promise<void> {
    if (!document.designerFile || document.uri.scheme !== 'file' || destination.scheme !== 'file') {
      throw new Error(t('status.designerDiskConflict'));
    }
    const workspace = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!workspace || !isPathInsideOrSame(workspace.uri.fsPath, destination.fsPath)) {
      throw new Error(t('status.designerDiskConflict'));
    }
    const workspaceRoot = path.resolve(workspace.uri.fsPath);
    const storagePath = this.context.globalStorageUri.fsPath;
    if (!['file', 'vscode-userdata'].includes(this.context.globalStorageUri.scheme)
      || !path.isAbsolute(storagePath)) {
      throw new Error('durable transaction storage is unavailable');
    }

    const sourceMain = document.uri.fsPath;
    const sourceDirectory = path.dirname(sourceMain);
    const sourceStem = path.basename(sourceMain).replace(/\.cs$/i, '');
    const destinationDirectory = path.dirname(destination.fsPath);
    const destinationStem = path.basename(destination.fsPath).replace(/\.cs$/i, '');
    const typeRename = saveAsTypeName(document.designerText, destinationStem);
    let sourceEntries: string[];
    try { sourceEntries = await fs.promises.readdir(sourceDirectory); }
    catch (error) { throw new Error(`cannot enumerate form companions: ${errMsg(error)}`); }

    const sourceArtifacts = [sourceMain, ...formSiblingsToDelete(sourceMain, sourceEntries)];
    if (!sourceArtifacts.some((candidate) => normalize(candidate) === normalize(document.designerFile!))) {
      sourceArtifacts.push(document.designerFile);
    }
    const artifactPairs = sourceArtifacts.map((source) => {
      const name = path.basename(source);
      const suffix = normalize(source) === normalize(sourceMain) ? '.cs' : name.slice(sourceStem.length);
      return { source, destination: path.join(destinationDirectory, destinationStem + suffix) };
    });
    const destinationPaths = artifactPairs.map((pair) => pair.destination);

    // The picker only authorizes the main .cs name. Sidecars were not covered by an overwrite prompt, so the
    // operation is create-only and reports all collisions before the durable transaction begins.
    let destinationEntries: string[];
    try { destinationEntries = await fs.promises.readdir(destinationDirectory); }
    catch (error) {
      if (!isFileNotFound(error)) throw error;
      destinationEntries = [];
    }
    const saveAsPlan = planWinFormsSaveAs(
      destinationPaths.map((candidate) => path.basename(candidate)),
      destinationEntries,
    );
    if (!saveAsPlan.accepted) {
      throw new Error(`${t('status.designerDiskConflict')} (${saveAsPlan.collisions.join(', ')})`);
    }

    const membershipProject = resolveFormMembershipProject(destination.fsPath, workspaceRoot);
    if (!membershipProject) throw new Error('Save As refused: no unambiguous destination project membership file');
    const openProject = vscode.workspace.textDocuments.find(
      (candidate) => normalize(candidate.uri.fsPath) === normalize(membershipProject),
    );
    if (openProject?.isDirty) throw new Error('Save As refused: the destination project has unsaved changes');
    const projectBytes = await fs.promises.readFile(membershipProject);
    const projectHadBom = projectBytes.length >= 3
      && projectBytes[0] === 0xef && projectBytes[1] === 0xbb && projectBytes[2] === 0xbf;
    const projectText = projectBytes.subarray(projectHadBom ? 3 : 0).toString('utf8');
    if (openProject && openProject.getText() !== projectText) {
      throw new Error('Save As refused: the destination project changed on disk');
    }
    const projectEdit = planAddFormMembership(
      membershipProject,
      projectText,
      destination.fsPath,
      destinationPaths,
    );

    const targets: DesignerResourceTransactionTarget[] = [];
    for (const pair of artifactPairs) {
      if (normalize(pair.source) === normalize(document.designerFile)) {
        targets.push({
          filePath: pair.destination,
          before: null,
          after: renameSavedFormType(document.designerText, typeRename.sourceType, typeRename.destinationType),
          bom: document.bom,
        });
        continue;
      }
      const openSource = vscode.workspace.textDocuments.find(
        (candidate) => normalize(candidate.uri.fsPath) === normalize(pair.source),
      );
      if (openSource?.isDirty) throw new Error(`Save As refused: ${path.basename(pair.source)} has unsaved changes`);
      const source = await readDesignerBytesUri(vscode.Uri.file(pair.source));
      targets.push({
        filePath: pair.destination,
        before: null,
        after: normalize(pair.source) === normalize(sourceMain)
          ? renameSavedFormType(source.text, typeRename.sourceType, typeRename.destinationType)
          : source.text,
        bom: source.hadBom,
      });
    }
    if (projectEdit) {
      targets.push({
        filePath: membershipProject,
        before: projectEdit.before,
        after: projectEdit.after,
        bom: projectHadBom,
      });
    }

    const journalRoot = path.join(storagePath, 'v2-transactions', sha256Hex(workspaceRoot).slice(0, 16));
    const result = await runDesignerResourceTransaction({
      label: `Save As ${path.basename(destination.fsPath)}`,
      workspaceRoot,
      journalRoot,
      targets,
      readBytes: async (filePath) => {
        try { return await fs.promises.readFile(filePath); }
        catch (error) { if (isFileNotFound(error)) return null; throw error; }
      },
      writeBytes: (filePath, bytes) => atomicWrite(vscode.Uri.file(filePath), bytes),
      deleteFile: async (filePath) => {
        try { await vscode.workspace.fs.delete(vscode.Uri.file(filePath)); }
        catch (error) { if (!isFileNotFound(error)) throw error; }
      },
      registerUndo: () => true,
    });
    if (result.status !== 'committed') {
      throw new Error(result.error ?? `Save As transaction failed: ${result.status}`);
    }
    this.output.appendLine(
      `[save-as] created ${destinationPaths.length} form artifact(s); project=${membershipProject}; journal=${result.journal.transactionId}`,
    );
  }

  async moveOpenDocumentGroup(uri: vscode.Uri, ids: readonly string[], dx: number, dy: number): Promise<void> {
    const document = this.openDocuments.get(this.documentKey(uri));
    if (!document?.session) throw new Error(`No resolved WinForms designer session for ${uri.fsPath}`);
    await document.session.extensionHostTestMoveGroup(ids, dx, dy);
  }

  async editOpenDocumentProperty(
    uri: vscode.Uri,
    id: string,
    propertyName: string,
    propertyType: string,
    isEnum: boolean,
    value: string,
  ): Promise<void> {
    const document = this.openDocuments.get(this.documentKey(uri));
    if (!document?.session) throw new Error(`No resolved WinForms designer session for ${uri.fsPath}`);
    await document.session.extensionHostTestEditProperty(id, propertyName, propertyType, isEnum, value);
  }

  /** Extension Host E2E replaces only the undriveable framework modal result; metadata authorization, the normal
   * UITypeEditor ingress, conversion/source planning, CustomDocument commit, and native history stay in product code. */
  async editOpenDocumentColorUiTypeEditor(
    uri: vscode.Uri,
    id: string,
    propertyName: string,
    outcome: 'apply-blue' | 'dismiss',
  ): Promise<{
      applied: boolean;
      dismissed: boolean;
      resultConsumed: boolean;
      editorType: string | null;
      refusalCode: 'CANCELLED' | null;
    }> {
    const document = this.openDocuments.get(this.documentKey(uri));
    if (!document?.session) throw new Error(`No resolved WinForms designer session for ${uri.fsPath}`);
    return document.session.extensionHostTestColorUiTypeEditor(id, propertyName, outcome);
  }

  /** Drive the real certified vendor editor worker from live net48 metadata; no modal-result seam is injected. */
  async editOpenDocumentCertifiedVendorUiTypeEditor(
    uri: vscode.Uri,
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
    }> {
    const document = this.openDocuments.get(this.documentKey(uri));
    if (!document?.session) throw new Error(`No resolved WinForms designer session for ${uri.fsPath}`);
    return document.session.extensionHostTestCertifiedVendorUiTypeEditor(id, propertyName);
  }

  /** Drive the actual certified vendor collection worker and the bounded component-owned persistence transaction. */
  async editOpenDocumentCertifiedVendorCollectionEditor(
    uri: vscode.Uri,
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
    }> {
    const document = this.openDocuments.get(this.documentKey(uri));
    if (!document?.session) throw new Error(`No resolved WinForms designer session for ${uri.fsPath}`);
    return document.session.extensionHostTestCertifiedVendorCollectionEditor(
      id, propertyName, tamperOutsideOwnedComponent);
  }

  /** Drive the same engine-published DesignerActionList mapping used by the on-canvas smart-tag flyout. */
  async editOpenDocumentDesignerActionProperty(
    uri: vscode.Uri,
    id: string,
    displayName: string,
    value: string,
  ): Promise<{
      applied: boolean;
      displayName: string | null;
      category: string | null;
      propertyName: string | null;
      propertyType: string | null;
    }> {
    const document = this.openDocuments.get(this.documentKey(uri));
    if (!document?.session) throw new Error(`No resolved WinForms designer session for ${uri.fsPath}`);
    return document.session.extensionHostTestDesignerActionProperty(id, displayName, value);
  }

  /** Drive the same fresh-graph ControlDesigner adorner confirmation used by an on-canvas hover. */
  async hitOpenDocumentDesignerAdorner(
    uri: vscode.Uri,
    id: string,
    adornerId: string,
    x: number,
    y: number,
  ): Promise<DesignerAdornerHitResult> {
    const document = this.openDocuments.get(this.documentKey(uri));
    if (!document?.session) throw new Error(`No resolved WinForms designer session for ${uri.fsPath}`);
    return document.session.extensionHostTestDesignerAdornerHit(id, adornerId, x, y);
  }

  async editOpenDocumentPropertyWithResourceInterleave(
    uri: vscode.Uri,
    id: string,
    propertyName: string,
    propertyType: string,
    isEnum: boolean,
    value: string,
    interleave: () => Promise<void>,
  ): Promise<boolean> {
    const document = this.openDocuments.get(this.documentKey(uri));
    if (!document?.session) throw new Error(`No resolved WinForms designer session for ${uri.fsPath}`);
    return document.session.extensionHostTestEditPropertyWithResourceInterleave(
      id, propertyName, propertyType, isEnum, value, interleave);
  }

  async alignOpenDocumentControls(
    uri: vscode.Uri,
    edits: readonly { id: string; dx: number; dy: number }[],
  ): Promise<void> {
    const document = this.openDocuments.get(this.documentKey(uri));
    if (!document?.session) throw new Error(`No resolved WinForms designer session for ${uri.fsPath}`);
    await document.session.extensionHostTestAlignControls(edits);
  }

  async centerOpenDocumentControls(uri: vscode.Uri, axis: 'h' | 'v', ids: readonly string[]): Promise<void> {
    const document = this.openDocuments.get(this.documentKey(uri));
    if (!document?.session) throw new Error(`No resolved WinForms designer session for ${uri.fsPath}`);
    await document.session.extensionHostTestCenterInForm(axis, ids);
  }

  async reparentOpenDocumentControl(uri: vscode.Uri, id: string, parentId: string): Promise<string | null> {
    const document = this.openDocuments.get(this.documentKey(uri));
    if (!document?.session) throw new Error(`No resolved WinForms designer session for ${uri.fsPath}`);
    return document.session.extensionHostTestReparent(id, parentId);
  }

  async addOpenDocumentControl(uri: vscode.Uri, controlType: string, parentId: string,
    x?: number, y?: number, width?: number, height?: number): Promise<void> {
    const document = this.openDocuments.get(this.documentKey(uri));
    if (!document?.session) throw new Error(`No resolved WinForms designer session for ${uri.fsPath}`);
    await document.session.extensionHostTestAddControl(controlType, parentId, x, y, width, height);
  }

  async removeOpenDocumentControl(uri: vscode.Uri, id: string): Promise<number> {
    const document = this.openDocuments.get(this.documentKey(uri));
    if (!document?.session) throw new Error(`No resolved WinForms designer session for ${uri.fsPath}`);
    return document.session.extensionHostTestRemoveControl(id);
  }

  async renameOpenDocumentControl(uri: vscode.Uri, id: string, newName: string): Promise<void> {
    const document = this.openDocuments.get(this.documentKey(uri));
    if (!document?.session) throw new Error(`No resolved WinForms designer session for ${uri.fsPath}`);
    await document.session.extensionHostTestRenameControl(id, newName);
  }

  async selectOpenDocumentControl(uri: vscode.Uri, id: string): Promise<void> {
    const document = this.openDocuments.get(this.documentKey(uri));
    if (!document?.session) throw new Error(`No resolved WinForms designer session for ${uri.fsPath}`);
    await document.session.extensionHostTestSelectControl(id);
  }

  /** Extension Host S095 repeats the real product activation after it arms the disposable hostile fixture. */
  async probeOpenDocumentHostedDesigner(uri: vscode.Uri, id: string): Promise<HostedDesignerProbeResult> {
    const document = this.openDocuments.get(this.documentKey(uri));
    if (!document?.session) throw new Error(`No resolved WinForms designer session for ${uri.fsPath}`);
    return document.session.extensionHostTestProbeHostedDesigner(id);
  }

  /** Extension Host S089/S090 invokes the exact command currently published by the real DesignerActionList. */
  async invokeOpenDocumentHostedServiceAction(
    uri: vscode.Uri,
    id: string,
    commandId: string,
    certificationId: string,
  ): Promise<HostedServiceKernelProductResult> {
    const document = this.openDocuments.get(this.documentKey(uri));
    if (!document?.session) throw new Error(`No resolved WinForms designer session for ${uri.fsPath}`);
    return document.session.extensionHostTestInvokeHostedServiceAction(id, commandId, certificationId);
  }

  /** Begin a real product rerender; callers may intentionally leave the promise pending to race a stale canvas token. */
  async rerenderOpenDocument(uri: vscode.Uri): Promise<void> {
    const document = this.openDocuments.get(this.documentKey(uri));
    if (!document?.session) throw new Error(`No resolved WinForms designer session for ${uri.fsPath}`);
    await document.session.extensionHostTestRerender();
  }

  /** Drive one S122 logical-DPI performance leg through the same session/full-render path as a webview DPR update. */
  async setOpenDocumentDpi(uri: vscode.Uri, displayDpr: number): Promise<void> {
    const document = this.openDocuments.get(this.documentKey(uri));
    if (!document?.session) throw new Error(`No resolved WinForms designer session for ${uri.fsPath}`);
    await document.session.extensionHostTestSetDpi(displayDpr);
  }

  /** Send the generation-bound canvas intent used by the real webview after hit-testing or keyboard nudge. */
  async sendOpenDocumentCanvasInput(
    uri: vscode.Uri,
    kind: 'pick' | 'nudge',
    id: string,
    generation: number,
  ): Promise<{ accepted: boolean; refusalCode: 'STALE_CANVAS' | null; renderGeneration: number }> {
    const document = this.openDocuments.get(this.documentKey(uri));
    if (!document?.session) throw new Error(`No resolved WinForms designer session for ${uri.fsPath}`);
    return document.session.extensionHostTestCanvasInput(kind, id, generation);
  }

  /** Extension Host E2E reaches the same layout-managed canvas drop path as a real drag release. */
  async moveOpenDocumentLayoutChild(uri: vscode.Uri, id: string, dropX: number, dropY: number): Promise<boolean> {
    const document = this.openDocuments.get(this.documentKey(uri));
    if (!document?.session) throw new Error(`No resolved WinForms designer session for ${uri.fsPath}`);
    return document.session.extensionHostTestMoveLayoutChild(id, dropX, dropY);
  }

  /** Extension Host E2E reaches the exact ListView.Columns panel read side and its stale-write baseline. */
  async listOpenDocumentColumns(uri: vscode.Uri, id: string): Promise<{
    ok: boolean;
    columns: ColumnItem[];
    reason: string;
  }> {
    const document = this.openDocuments.get(this.documentKey(uri));
    if (!document?.session) throw new Error(`No resolved WinForms designer session for ${uri.fsPath}`);
    return document.session.extensionHostTestListColumns(id);
  }

  /** Extension Host E2E reaches the same atomic ListView.Columns OK path as the property panel. */
  async setOpenDocumentColumns(uri: vscode.Uri, id: string, columns: ColumnItem[]): Promise<boolean> {
    const document = this.openDocuments.get(this.documentKey(uri));
    if (!document?.session) throw new Error(`No resolved WinForms designer session for ${uri.fsPath}`);
    return document.session.extensionHostTestSetColumns(id, columns);
  }

  /** Extension Host E2E reaches the exact TabPages collection read side and its stale-write baseline. */
  async listOpenDocumentTabPages(uri: vscode.Uri, hostId: string): Promise<{
    ok: boolean;
    pages: string[];
    reason: string;
  }> {
    const document = this.openDocuments.get(this.documentKey(uri));
    if (!document?.session) throw new Error(`No resolved WinForms designer session for ${uri.fsPath}`);
    return document.session.extensionHostTestListTabPages(hostId);
  }

  /** Extension Host E2E reaches the atomic TabPages collection-editor OK path (one commit for the full order). */
  async setOpenDocumentTabPages(uri: vscode.Uri, hostId: string, pageIds: string[]): Promise<boolean> {
    const document = this.openDocuments.get(this.documentKey(uri));
    if (!document?.session) throw new Error(`No resolved WinForms designer session for ${uri.fsPath}`);
    return document.session.extensionHostTestSetTabPages(hostId, pageIds);
  }

  /** Extension Host E2E uses the same read side as the open Items editor, including its document-revision baseline. */
  async listOpenDocumentToolStripItems(uri: vscode.Uri, id: string): Promise<{
    ok: boolean;
    items: ToolStripItemModel[];
    reason: string;
  }> {
    const document = this.openDocuments.get(this.documentKey(uri));
    if (!document?.session) throw new Error(`No resolved WinForms designer session for ${uri.fsPath}`);
    return document.session.extensionHostTestListToolStripItems(id);
  }

  /** Extension Host E2E reaches the same panel write side after listOpenDocumentToolStripItems established a baseline. */
  async setOpenDocumentToolStripItems(uri: vscode.Uri, id: string, items: ToolStripItemModel[]): Promise<boolean> {
    const document = this.openDocuments.get(this.documentKey(uri));
    if (!document?.session) throw new Error(`No resolved WinForms designer session for ${uri.fsPath}`);
    return document.session.extensionHostTestSetToolStripItems(id, items);
  }

  /** Extension Host E2E reaches the same on-canvas drag/reparent ingress as a real ToolStrip/MenuStrip item drop. */
  async moveOpenDocumentToolStripItem(
    uri: vscode.Uri,
    hostId: string,
    itemId: string,
    targetParentItemId: string | null,
    targetIndex: number,
  ): Promise<{ applied: boolean; reason: string | null }> {
    const document = this.openDocuments.get(this.documentKey(uri));
    if (!document?.session) throw new Error(`No resolved WinForms designer session for ${uri.fsPath}`);
    return document.session.extensionHostTestMoveToolStripItem(hostId, itemId, targetParentItemId, targetIndex);
  }

  async copyOpenDocumentControls(uri: vscode.Uri, ids: readonly string[]): Promise<void> {
    const document = this.openDocuments.get(this.documentKey(uri));
    if (!document?.session) throw new Error(`No resolved WinForms designer session for ${uri.fsPath}`);
    await document.session.extensionHostTestCopyControls(ids);
  }

  async pasteOpenDocumentControls(uri: vscode.Uri, targetId?: string): Promise<void> {
    const document = this.openDocuments.get(this.documentKey(uri));
    if (!document?.session) throw new Error(`No resolved WinForms designer session for ${uri.fsPath}`);
    await document.session.extensionHostTestPaste(targetId);
  }

  async setOpenDocumentHandler(uri: vscode.Uri, id: string, eventName: string, handlerName: string): Promise<void> {
    const document = this.openDocuments.get(this.documentKey(uri));
    if (!document?.session) throw new Error(`No resolved WinForms designer session for ${uri.fsPath}`);
    await document.session.setHandler(id, eventName, handlerName);
  }

  async setOpenDocumentHandlerWithInterleave(
    uri: vscode.Uri,
    id: string,
    eventName: string,
    handlerName: string,
    interleave: () => Promise<void>,
  ): Promise<void> {
    const document = this.openDocuments.get(this.documentKey(uri));
    if (!document?.session) throw new Error(`No resolved WinForms designer session for ${uri.fsPath}`);
    await document.session.extensionHostTestSetHandlerWithInterleave(id, eventName, handlerName, interleave);
  }

  async createOpenDocumentHandler(uri: vscode.Uri, id: string, eventName: string): Promise<void> {
    const document = this.openDocuments.get(this.documentKey(uri));
    if (!document?.session) throw new Error(`No resolved WinForms designer session for ${uri.fsPath}`);
    await document.session.createHandler(id, eventName);
  }

  async createOpenDocumentHandlerWithInterleave(
    uri: vscode.Uri,
    id: string,
    eventName: string,
    interleave: () => Promise<void>,
  ): Promise<void> {
    const document = this.openDocuments.get(this.documentKey(uri));
    if (!document?.session) throw new Error(`No resolved WinForms designer session for ${uri.fsPath}`);
    await document.session.extensionHostTestCreateHandlerWithInterleave(id, eventName, interleave);
  }

  async createOpenDocumentDefaultHandler(uri: vscode.Uri, id: string): Promise<void> {
    const document = this.openDocuments.get(this.documentKey(uri));
    if (!document?.session) throw new Error(`No resolved WinForms designer session for ${uri.fsPath}`);
    await document.session.extensionHostTestCreateDefaultHandler(id);
  }

  async focusOpenDocument(uri: vscode.Uri): Promise<void> {
    const document = this.openDocuments.get(this.documentKey(uri));
    if (!document?.session) throw new Error(`No resolved WinForms designer session for ${uri.fsPath}`);
    document.session.extensionHostTestFocus();
  }

  async runOpenDocumentResourceRace(
    uri: vscode.Uri,
    kind: 'journaled' | 'ordinary',
    resourceUri: vscode.Uri,
    interleave: () => Promise<void>,
  ): Promise<boolean> {
    const document = this.openDocuments.get(this.documentKey(uri));
    if (!document?.session) throw new Error(`No resolved WinForms designer session for ${uri.fsPath}`);
    return document.session.extensionHostTestResourceRace(kind, resourceUri, interleave);
  }

  async makeOpenDocumentLocalizableWithJournalFailure(
    uri: vscode.Uri,
    state: 'applied' | 'undoRegistered' | 'committed',
  ): Promise<{ result: boolean; failureObserved: boolean }> {
    const document = this.openDocuments.get(this.documentKey(uri));
    if (!document?.session) throw new Error(`No resolved WinForms designer session for ${uri.fsPath}`);
    return document.session.extensionHostTestMakeLocalizableJournalFailure(state);
  }

  async resizeOpenDocumentControl(uri: vscode.Uri, id: string, width: number, height: number): Promise<void> {
    const document = this.openDocuments.get(this.documentKey(uri));
    if (!document?.session) throw new Error(`No resolved WinForms designer session for ${uri.fsPath}`);
    await document.session.extensionHostTestResizeControl(id, width, height);
  }

  async resizeOpenDocumentControls(
    uri: vscode.Uri,
    sizeEdits: readonly { id: string; width: number; height: number }[],
  ): Promise<void> {
    const document = this.openDocuments.get(this.documentKey(uri));
    if (!document?.session) throw new Error(`No resolved WinForms designer session for ${uri.fsPath}`);
    await document.session.extensionHostTestResizeControls(sizeEdits);
  }

  async openCustomDocument(
    uri: vscode.Uri,
    openContext: vscode.CustomDocumentOpenContext,
    _token: vscode.CancellationToken,
  ): Promise<WinFormsDesignDocument> {
    const designerFile = resolveDesignerFile(uri.fsPath);
    let diskText = '';
    let hadBom = false;
    let diskExisted = false; // whether our baseline came from a real file — save()'s conflict guard needs to tell
    let baselineUnknown = false; // "deleted under us" apart from "never existed"
    if (designerFile) {
      try {
        const r = await readDesignerBytesUri(vscode.Uri.file(designerFile));
        diskText = r.text; hadBom = r.hadBom; diskExisted = true;
      } catch (e) {
        // ONLY a genuine "not there" is a placeholder-and-carry-on. Any other failure (locked, permissions,
        // provider error) means the file may well exist with content we cannot see — treating that as "absent"
        // would hand save() a fake empty baseline and defeat its deletion/conflict guards outright. Open
        // the designer anyway (a read-only preview is useful), but mark the baseline untrustworthy so no write
        // proceeds until a successful read replaces it.
        if (!isFileNotFound(e)) baselineUnknown = true;
      }
    }
    // designerText = recovered hot-exit backup if present (else disk); savedDesignerText = the REAL on-disk
    // text — so a recovered backup that differs from disk is correctly DIRTY, not silently "saved". In a normal
    // workbench restore VS Code supplies backupId. If only the Extension Host restarted and the user explicitly
    // reopens the designer, consume the workspace-local fallback index written by backupCustomDocument instead.
    let text = diskText;
    const fallbackBackupId = openContext.backupId ? undefined : await this.takeHotExitBackup(uri);
    const backupId = openContext.backupId ?? fallbackBackupId;
    let recoveredFromBackup = false;
    if (backupId) {
      try {
        const r = await readDesignerBytesUri(vscode.Uri.parse(backupId));
        text = r.text;
        if (!designerFile) hadBom = r.hadBom;
        recoveredFromBackup = true;
        // A native VS Code restore can coexist with our fallback index. Consume the duplicate after a successful read
        // so a later ordinary reopen cannot resurrect the same stale dirty image.
        if (openContext.backupId) await this.removeHotExitBackup(uri, backupId);
      } catch { /* fall back to disk; a consumed fallback with an unreadable payload must not retry forever */ }
    }
    const document = new WinFormsDesignDocument(
      uri,
      designerFile,
      text,
      diskText,
      hadBom,
      diskExisted,
      baselineUnknown,
      (openDocument, destination) => this.saveWholeFormAs(openDocument, destination),
      recoveredFromBackup,
    );
    const key = this.documentKey(uri);
    this.openDocuments.set(key, document);
    document.onDidDispose(() => {
      if (this.openDocuments.get(key) === document) this.openDocuments.delete(key);
    });
    return document;
  }

  resolveCustomEditor(
    document: WinFormsDesignDocument,
    panel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): void {
    document.session = new DesignerSession(
      this.context.extensionUri, this.context.globalStorageUri, this.ensureEngine, this.getAssemblyOverride, this.output, this.onViewCode,
      document, panel, (event) => this.fireDocumentEdit(event), this.setAssemblyOverride,
    );
    document.registerRecoveredUndo((event) => this.fireDocumentEdit(event));
  }

  async saveCustomDocument(document: WinFormsDesignDocument, _c: vscode.CancellationToken): Promise<void> {
    await document.save();
    await this.clearHotExitBackupIfClean(document);
  }
  async saveCustomDocumentAs(document: WinFormsDesignDocument, dest: vscode.Uri, _c: vscode.CancellationToken): Promise<void> {
    await document.saveAs(dest);
    await this.clearHotExitBackupIfClean(document);
  }
  async revertCustomDocument(document: WinFormsDesignDocument, _c: vscode.CancellationToken): Promise<void> {
    await document.revert();
    await this.clearHotExitBackupIfClean(document);
  }
  async backupCustomDocument(
    document: WinFormsDesignDocument,
    context: vscode.CustomDocumentBackupContext,
    _c: vscode.CancellationToken,
  ): Promise<vscode.CustomDocumentBackup> {
    const backup = await document.backup(context.destination);
    try {
      // Older hosts can deliver a debounced backup callback after Save/Undo already made the document clean. The
      // VS Code-owned backup object still has to be returned, but indexing it would resurrect a completed edit on the
      // next explicit reopen. Re-check current state after the async write and only retain genuinely dirty recovery.
      if (document.isDirty) await this.persistHotExitBackup(document.uri, backup.id);
      else await this.removeHotExitBackup(document.uri);
    } catch (error) {
      // VS Code still owns and records the returned backup id; this index is only the explicit-reopen fallback.
      this.output.appendLine(`[hot-exit] Fallback recovery index could not be written: ${String(error)}`);
    }
    return {
      id: backup.id,
      delete: async () => {
        await backup.delete();
        try { await this.removeHotExitBackup(document.uri, backup.id); }
        catch (error) { this.output.appendLine(`[hot-exit] Fallback recovery index could not be cleared: ${String(error)}`); }
      },
    };
  }
}

/**
* The single dockable WinForms Designer WebviewView: hosts BOTH the Properties grid and the Toolbox palette
* as full-size panes, switched by a tab strip at the bottom of the view. One movable panel (instead of two
* stacked views that split the area). Mirrors the active designer and routes user actions back to it.
*/
export class DesignerPanelViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'winformsDesigner.panel';
  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')] };
    view.webview.html = panelHtml(view.webview, this.extensionUri);
    DesignerHub.instance.attachPanel(view.webview, this.extensionUri);
    view.webview.onDidReceiveMessage(async (m: {
      type?: string; id?: string; prop?: string; propType?: string; isEnum?: boolean; value?: string; ownerId?: string;
      providerId?: string; extenderProperty?: string;
      refEdit?: boolean; designTime?: boolean; multi?: boolean; kind?: 'none' | 'component' | 'type';
      event?: string; handler?: string | null; controlType?: string; tab?: string; cell?: string; componentType?: string;
      parentId?: string; toFront?: boolean; x?: number; y?: number; width?: number; height?: number;
      items?: string[]; columns?: ColumnItem[]; gridColumns?: GridColumnItem[]; bindings?: BindingItem[]; nodes?: TreeNodeItem[];
      pageIds?: string[];
      itemType?: string; editorType?: string;
      toolStripItems?: ToolStripItemModel[];
      schemaKey?: string; mode?: 'detail' | 'grid'; includeNavigator?: boolean;
      existingBindingSourceId?: string | null; existingGridId?: string | null; settingKey?: string;
      state?: unknown; toolboxUi?: unknown;
    }) => {
      const s = DesignerHub.instance.activeSession;
      try {
        // Localizable forms route supported property/image/reset edits through the selected .resx. Refuse only
        // structural/source operations that do not have a resource representation; reads always pass.
        if (s?.refuseLocalizableEdit(m?.type)) return;
        if (s?.refuseStaleRenderEdit(m?.type)) return; // 0.10.0 S5 — read-only while the last render failed (stale graph)
        if (m?.type === 'ready') { s?.refreshViews(); }
        else if (m?.type === 'panelViewStateChanged') { s?.updatePanelViewState(m.state, m.toolboxUi); }
        else if (m?.type === 'toolboxInteraction') { s?.noteToolboxInteraction(); }
        else if (m?.type === 'pick' && m.id) { await s?.pick(m.id); }
        else if (m?.type === 'edit' && m.id && m.prop && m.propType !== undefined) {
          // an `ownerId` marks this as a ToolStripItem edit (the grid is showing item→Properties) → route to the
          // item-edit path (targets the item field, refreshes via itemProps, keeps the canvas item highlight).
          if (m.ownerId) await s?.editItemFromGrid(m.ownerId, m.id, m.prop, m.propType, !!m.isEnum, m.value ?? '');
          else await s?.editFromGrid(m.id, m.prop, m.propType, !!m.isEnum, m.value ?? '', !!m.refEdit, !!m.designTime, !!m.multi);
        }
        else if (m?.type === 'pickProjectImageResource' && m.id && m.prop) { await s?.pickProjectImageResourceFromGrid(m.id, m.prop); }
        else if (m?.type === 'importImage' && m.id && m.prop && m.propType) { await s?.importImageFromGrid(m.id, m.prop, m.propType); }
        else if (m?.type === 'clearImage' && m.id && m.prop) { await s?.clearImageFromGrid(m.id, m.prop); }
        else if (m?.type === 'resetProperty' && m.id && m.prop) {
          // an `ownerId` marks this as a ToolStripItem reset (the grid is showing item→Properties) → route to the
          // item-reset path (targets the item field, refreshes via itemProps, keeps the canvas item highlight).
          if (m.ownerId) await s?.resetItemFromGrid(m.ownerId, m.id, m.prop);
          else await s?.resetFromGrid(m.id, m.prop, !!m.multi);
        }
        else if (m?.type === 'setTableCell' && m.id && m.cell) { await s?.tableCellFromGrid(m.id, m.cell, m.value ?? ''); }
        else if (m?.type === 'listCollection' && m.id && m.prop) { await s?.sendCollectionItems(m.id, m.prop); }
        else if (m?.type === 'setCollection' && m.id && m.prop && Array.isArray(m.items)) { await s?.collectionFromGrid(m.id, m.prop, m.items as string[]); }
        else if (m?.type === 'listGenericList' && m.id && m.prop && m.itemType) { await s?.sendGenericListItems(m.id, m.prop, m.itemType); }
        else if (m?.type === 'setGenericList' && m.id && m.prop && m.itemType && Array.isArray(m.items)) { await s?.genericListFromGrid(m.id, m.prop, m.itemType, m.items as string[]); }
        else if (m?.type === 'uiTypeEditor' && m.id && m.prop && m.propType && m.editorType) { await s?.uiTypeEditorFromGrid(m.id, m.prop, m.propType, m.editorType); }
        else if (m?.type === 'uiCollectionEditor' && m.id && m.prop && m.itemType && m.editorType) { await s?.uiCollectionEditorFromGrid(m.id, m.prop, m.itemType, m.editorType); }
        else if (m?.type === 'listStringArray' && m.id && m.prop) { await s?.sendStringArray(m.id, m.prop); }
        else if (m?.type === 'setStringArray' && m.id && m.prop && Array.isArray(m.items)) { await s?.stringArrayFromGrid(m.id, m.prop, m.items as string[]); }
        else if (m?.type === 'listColumns' && m.id) { await s?.sendColumnItems(m.id); }
        else if (m?.type === 'setColumns' && m.id && Array.isArray(m.columns)) { await s?.columnsFromGrid(m.id, m.columns as ColumnItem[]); }
        else if (m?.type === 'listTabPages' && m.id) { await s?.sendTabPages(m.id); }
        else if (m?.type === 'setTabPages' && m.id && Array.isArray(m.pageIds)) { await s?.tabPagesFromGrid(m.id, m.pageIds); }
        else if (m?.type === 'listGridColumns' && m.id) { await s?.sendGridColumnItems(m.id); }
        else if (m?.type === 'setGridColumns' && m.id && Array.isArray(m.gridColumns)) { await s?.gridColumnsFromGrid(m.id, m.gridColumns as GridColumnItem[]); }
        else if (m?.type === 'listBindings' && m.id) { await s?.sendBindingItems(m.id); }
        else if (m?.type === 'setBindings' && m.id && Array.isArray(m.bindings)) { await s?.bindingsFromGrid(m.id, m.bindings as BindingItem[]); }
        else if (m?.type === 'getDataSource' && m.id) { await s?.sendDataSourceInfo(m.id); }
        else if (m?.type === 'setDataSource' && m.id && m.kind) { await s?.dataSourceFromGrid(m.id, m.kind, m.value ?? ''); }
        else if (m?.type === 'refreshDataSources') { await s?.refreshDataSources(); }
        else if (m?.type === 'generateDataSource' && m.schemaKey && (m.mode === 'detail' || m.mode === 'grid')) {
          await s?.generateFromDataSource(m.schemaKey, m.mode, m.parentId ?? 'this', m.x, m.y,
            !!m.includeNavigator, m.existingBindingSourceId ?? null, m.existingGridId ?? null);
        }
        else if (m?.type === 'bindApplicationSetting' && m.settingKey && m.id) {
          await s?.bindSelectedApplicationSetting(m.settingKey, m.id);
        }
        else if (m?.type === 'setExtender' && m.id && m.providerId && m.extenderProperty && m.propType) {
          await s?.extenderFromGrid(m.providerId, m.id, m.extenderProperty, m.propType, m.value ?? '');
        }
        else if (m?.type === 'listTreeNodes' && m.id) { await s?.sendTreeNodes(m.id); }
        else if (m?.type === 'setTreeNodes' && m.id && Array.isArray(m.nodes)) { await s?.treeNodesFromGrid(m.id, m.nodes as TreeNodeItem[]); }
        else if (m?.type === 'listToolStripItems' && m.id) { await s?.sendToolStripItems(m.id); }
        else if (m?.type === 'setToolStripItems' && m.id && Array.isArray(m.toolStripItems)) { await s?.toolStripFromGrid(m.id, m.toolStripItems as ToolStripItemModel[]); }
        // an `ownerId` on an event message marks it as a ToolStripItem wiring (item→Properties Events tab) → the host
        // refreshes via the item channel (loadItemProps) so item mode + the canvas highlight survive the wire.
        else if (m?.type === 'setHandler' && m.id && m.event) { await s?.setHandler(m.id, m.event, m.handler ?? '', m.ownerId); }
        else if (m?.type === 'createHandler' && m.id && m.event) { await s?.createHandler(m.id, m.event, m.handler || undefined, m.ownerId); }
        else if (m?.type === 'navigateHandler' && m.id) { await s?.navigateToHandler(m.id, m.event ?? '', m.handler ?? undefined, m.ownerId); }
        else if (m?.type === 'listHandlers' && m.id) { await s?.sendCandidates(m.id); }
        else if (m?.type === 'selectToolboxControl' && m.controlType) { await s?.selectToolboxControl(m.controlType); }
        else if (m?.type === 'addControl' && m.controlType) { await s?.addControlFromToolbox(m.controlType); }
        else if (m?.type === 'outlineReparent' && m.id && m.parentId) { await s?.reparentFromOutline(m.id, m.parentId); }
        else if (m?.type === 'outlineMoveZOrder' && m.id && typeof m.toFront === 'boolean') { await s?.zOrderFromOutline(m.id, m.toFront); }
        else if (m?.type === 'renameComponent' && m.id) { await s?.promptComponentRename(m.id); }
        else if (m?.type === 'addComponent' && m.componentType) { await s?.addComponentFromToolbox(m.componentType); }
        else if (m?.type === 'deleteSelected') { s?.deleteSelectedFromPanel(); }
        else if (m?.type === 'chooseItems') { s?.openChooseItems(m.tab); }
      } catch { /* edit/handler/add failures already report on the canvas status line */ }
    });
    view.onDidDispose(() => { if (DesignerHub.instance.panel === view.webview) DesignerHub.instance.panel = null; });
  }
}

/**
* 0.11.0 write-safety — a sibling-.resx disk write bundled INTO a designer edit's undo/redo transaction.
* `before` is the resx content prior to the write (null when this edit created the .resx); `after` is what
* was written. Undo restores `before` (deleting a file this edit created); redo re-applies `after`. Both
* directions are conflict-guarded (a concurrent external change to the .resx is left alone, never clobbered),
* so a resx write and its code-behind assignment land — and revert — as one atomic unit.
*/
interface ResxTx { uri: vscode.Uri; before: string | null; after: string; bom: boolean; }
type ResourceTxSet = ResxTx | ResxTx[];

/** One ordinary source buffer that participates in a CustomDocument edit. Visual Studio treats generated-source
 * wiring and the code-behind stub as one designer transaction; VS Code has no public cross-editor undo primitive,
 * so the custom-document undo/redo callback replays this exact, conflict-guarded buffer transition itself. */
interface CompanionTextTx {
  document: vscode.TextDocument;
  before: string;
  after: string;
}

/** A .resx read: its text with any leading UTF-8 BOM stripped, plus whether that BOM was there — so every write
* back can restore it byte-for-byte instead of silently rewriting the whole file's encoding signature. */
interface ResxRead { text: string; hadBom: boolean; }

interface ProductRenderTelemetry {
  modelMs: number;
  captureMs: number;
  previewMs: number;
  reconciliationMs: number;
  totalMeasuredMs: number;
  displayDpr: number;
  captureScale: 1 | 2;
  controlCount: number;
}

/** Exact, mutation-free source proposal produced by the High-DPI advisor. The command host renders these two
 * byte images through a read-only TextDocumentContentProvider; accepting the proposal must still match this
 * revision and these bytes before the normal CustomDocument commit funnel can create one native history unit. */
export type HighDpiQuickFixPreviewResult =
  | {
    status: 'previewed';
    designerFile: string;
    before: string;
    after: string;
    beforeSha256: string;
    afterSha256: string;
    persistenceLane: 'ownedRegion' | 'sourceFirst';
  }
  | { status: 'notApplicable' | 'refused'; reason: string };

export type HighDpiQuickFixApplyResult =
  | {
    status: 'applied';
    designerFile: string;
    beforeSha256: string;
    afterSha256: string;
    persistenceLane: 'ownedRegion' | 'sourceFirst';
  }
  | { status: 'refused'; reason: string };

interface PendingHighDpiQuickFix {
  designerFile: string;
  before: string;
  after: string;
  revision: number;
  beforeSha256: string;
  afterSha256: string;
  persistenceLane: 'ownedRegion' | 'sourceFirst';
}

/** Manages one open designer editor: render, selection, property edits, and live-update. */
class DesignerSession {
  private readonly designerFile: string | null;
  private readonly disposables: vscode.Disposable[] = [];
  private currentId = 'this';
  /** Canvas control selection in deterministic order, with currentId (the primary) last. The side panel can request a
   * multi-object transaction only for this exact, revision-bound set. */
  private currentSelectionIds: string[] = ['this'];
  private selectedToolboxControl: string | null = null;
  // The strip item currently shown in the Properties panel (item→Properties), or null when a control is selected. Set by
  // the `selectItem` gesture, cleared on a control `pick`. A delayed item refresh (loadItemProps after a reset/wire/edit)
  // checks this before pushing `itemProps`, so a stale refresh for item A can't overwrite a newer selection of item B
  // (canvas dispatch isn't serialized.
  private currentSelItem: { ownerId: string; itemId: string } | null = null;
  /** Bumped by every pick(); captured by loadProps so a load whose awaits outlive its selection publishes nothing. */
  private selectionGen = 0;
  private renderSeq = 0;
  private lastCanvasInputRefusalCode: 'STALE_CANVAS' | null = null;
  /** Extension Host S016 phase telemetry; null outside a net48 property-edit attempt. */
  private lastNet48PropertyEditTelemetry: {
    plannerMs: number;
    commitMs: number;
    reconcileMs: number;
    liveMs: number;
    snapshotComponentId: string | null;
    componentInSnapshot: boolean;
    propertiesReconciled: boolean;
    trailingPropertiesMs: number;
  } | null = null;
  /** Extension Host S016 phase telemetry for the modern source-plan -> commit -> retained-graph path. */
  private lastModernPropertyEditTelemetry: {
    plannerMs: number;
    commitMs: number;
    reconcileMs: number;
    retainedApplied: boolean;
    trailingPropertiesMs: number;
  } | null = null;
  /** S122: accepted phase timings from the latest real full-render product path. Engine startup/toolbox warm-up is
   * deliberately outside these frozen steady-state phases; capture owns the engine's inseparable model+pixel RPC. */
  private lastFullRenderTelemetry: ProductRenderTelemetry | null = null;
  /** Last product-hosted ComponentDesigner activation for the current certified selection. A worker fault is kept
   * separate from renderOk: the generic form/property surface intentionally remains usable after quarantine. */
  private lastHostedDesignerProbe: HostedDesignerProbeResult | null = null;
  /** Last inspection or invocation of the exact repository-certified hosted service command for this session. */
  private lastHostedServiceKernelResult: HostedServiceKernelProductResult | null = null;
  private lastModernRetainedApplied = false;
  /** A later Data Sources refresh supersedes an older project scan; source revision is checked separately. */
  private dataSourcesSeq = 0;
  private controls: LayoutControl[] = [];
  /** Engine-authoritative non-visual component tray from the latest accepted render. Retained so selection validation
   * and Extension Host parity evidence can distinguish a real Timer/BindingSource from a forged non-control id. */
  private trayComponents: TrayComponent[] = [];
  // 0.10.0 trust-floor S5 — false = the last render FAILED (or nothing has rendered yet). A hard load/render failure
  // leaves a STALE preview on the canvas; while this is false, mutating gestures are refused fail-closed so an edit
  // can't splice against a graph the designer couldn't load. Set true only at fullRender's clean success exit; set
  // false in every failure branch. Stored (not derived from source — a parseable form can still fail to render).
  private renderOk = false;
  /** Last degraded-render report, retained host-side so Copy Diagnostics never trusts webview-supplied text. */
  private lastRenderDiagnostic?: {
    kind: 'partial' | 'failure';
    message: string;
    target: string;
    cause: string;
    items: RenderDiagItem[];
  };
  // 1.0.0 — the .NET Framework compiled preview shows the last BUILD, never the live source, and cannot prove the
  // build matches `.Designer.cs` (the user can hand-edit and not rebuild). After eight review rounds the divergence
  // LOCK that tried to infer that from instance/build identity was descoped: a lock that
  // can misclassify is less trustworthy than an honest disclosure. net48 forms stay editable; source safety comes from
  // the byte-local firewall in commit(), not from any fidelity inference. Instead composeFormNotice shows an
  // UNCONDITIONAL "this is your last build; rebuild is authoritative" banner on every net48 render. The wire fields
  // liveInstanceId / liveBuildId remain for diagnostics + the release/rebuild e2e, but grant no editing authority.
  /** Monotonic id per reloadFromDiskIfClean run; a read that resumes after a newer one started is discarded. */
  private reloadEpoch = 0;
  /** Exact forward source images currently being written by the durable source+resource transaction runner.
   * The generated-source watcher is allowed to observe one of these images before the runner registers the native
   * CustomDocument edit (notably on VS Code 1.84). Treating that self-write as an external clean-file change bumps the
   * document revision, makes the final commit fail its own stale guard, and rolls an otherwise valid transaction back.
   * Keep the comparison exact (text + BOM) and scoped to the runner lifetime; every other watcher image still follows
   * the normal external-change path. An array deliberately supports two concurrently dispatched webview commands. */
  private readonly pendingSourceTransactionImages: Array<{ text: string; bom: boolean }> = [];
  private toolStripItems: ToolStripItemBounds[] = []; // per-item geometry from the last render (on-canvas "Type Here")
  /** Live CurrentAutoScaleDimensions of the last render ("6F, 13F"), reported by whichever engine drew it. */
  private renderedAutoScale = '';
  /** Opaque modern-engine token for the exact live DesignSurface behind the accepted 1x frame. Never interpreted
   * client-side; a property edit only echoes it with exact old/new source bytes for engine-side revalidation. */
  private modernGraphToken: string | undefined;
  private rootClient: { w: number; h: number } | null = null;
  private rootFrame: { w: number; h: number } | null = null;
  /** Which engine renders THIS form — detected per render from the resolved control assembly's runtime
   * (net48 = .NET Framework/DevExpress compiled preview). Drives engine routing + edit gating + the badge. */
  private engineKind: EngineKind = 'modern';
  /** Exact clamped DPR reported by the current webview display. It is diagnostic/change-detection state only: all
   * WinForms layout, hit-testing, snapline and source coordinates remain logical pixels. */
  private displayDpr = 1;
  /** Safe integer backing capture. Every DPR above 1 uses 2x supersampling and browser downsampling; the cached net48
   * graph therefore sees only the exactly reversible 2x/0.5x path, never a cumulative fractional Scale cycle. */
  private renderScale: 1 | 2 = 1;
  private debounce?: ReturnType<typeof setTimeout>;
  private codeBehindDebounce?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private gotReady = false;
  /** Signature of the last #formNotice payload actually posted — so composeFormNotice skips a re-post identical to
   * the one already on screen (the notice was recomposed on both the early render post and the
   * trailing postDirty). Reset on webview 'ready' so a reloaded webview always re-receives the current notice. */
  private lastNoticeSig: string | undefined;
  /** Last .NET Framework "compiled preview" disclosure written to the output channel: the disclosure is log-only now
   * (not a banner). Deduped so a render/edit storm doesn't spam the channel; cleared when the render is no longer build-based. */
  private lastNet48NoticeLog?: string;
  /** Last `dirty` value actually posted — postDirty() now fires at the mutation point AND from trailing callers, so
   * dedupe the badge IPC. Reset on 'ready' so a reloaded webview re-receives its dirty state. */
  private lastDirtyPosted: boolean | undefined;
  /** The mode of the last net48 render: 'interpreted' (live source via the IR interpreter — no
   * "last build" disclosure, it IS the source), 'compiledFallback' (a form the interpreter can't cover → the compiled
   * last build WITH the disclosure + reason), or 'compiled'. Drives composeFormNotice. Ignored on the modern engine. */
  private net48RenderMode = 'compiled';
  /** 1.2.x — the exact buffer the CURRENT interpreted picture was built from, so the engine can prove its cached
   * graph still matches before re-snapshotting it instead of re-interpreting. Undefined whenever the picture is not
   * an interpretation of a known buffer (a compiled render, a live compiled op, before the first render). */
  private renderedText: string | undefined;
  /** The document revision the current interpreted picture was built from. A live edit is only allowed to claim the
   * cached graph when EXACTLY the commit it is sending has happened since — otherwise some other commit (Modifiers,
   * event wiring: source changes that deliberately do not re-render) went into the buffer without reaching the graph. */
  private renderedRev = -1;
  /** Pending post-burst re-interpretation (see scheduleInterpretedReconcile). Cleared on dispose. */
  private interpretedReconcileTimer: ReturnType<typeof setTimeout> | undefined;
  private net48FallbackReason = '';
  // transient interpreted tab view-state: tab-host field id → selected page field id. Re-supplied
  // to every interpreted render (the interpreted graph is uncached), so a tab-click's selection survives later renders. A
  // stale entry (host/page removed) is a no-op via the engine's narrow adapter.
  private selectedTabs = new Map<string, string>();
  private tabViewState(): string[] { return Array.from(this.selectedTabs, ([h, p]) => `${h}=${p}`); }

  private persistTabViewState(): void {
    if (!this.designerFile) return;
    const state = DesignerHub.instance.formViewState(this.designerFile);
    DesignerHub.instance.updateFormViewState(this.designerFile, {
      canvas: { ...(state.canvas ?? {}), selectedTabs: selectedTabsFromEntries(this.selectedTabs) },
      panel: state.panel,
      localizationCulture: state.localizationCulture,
    });
  }

  private setSelectedTab(hostId: string, pageId: string): void {
    this.selectedTabs.set(hostId, pageId);
    this.persistTabViewState();
  }

  private clearSelectedTab(hostId: string, pageId?: string): void {
    if (pageId !== undefined && this.selectedTabs.get(hostId) !== pageId) return;
    if (this.selectedTabs.delete(hostId)) this.persistTabViewState();
  }

  private pruneSelectedTabs(controls: LayoutControl[]): void {
    if (!this.selectedTabs.size) return;
    const byId = new Map(controls.map((c) => [c.id, c]));
    let changed = false;
    for (const [hostId, pageId] of this.selectedTabs) {
      const host = byId.get(hostId);
      const page = byId.get(pageId);
      if (!host?.isTabHost || page?.parentId !== hostId) {
        this.selectedTabs.delete(hostId);
        changed = true;
      }
    }
    if (changed) this.persistTabViewState();
  }
  /** Auto-populated toolbox palette — fetched once, then mirrored to the Toolbox view. */
  private toolboxItems: ToolboxItemInfo[] | undefined;
  /** Lazily discovered project/vendor controls from bounded workspace build-output roots. This stays separate from
   * the engine baseline so a truncated refresh cannot erase assemblies it did not revisit. */
  private autoToolboxItems: ToolboxItemInfo[] = [];
  private autoToolboxDiscoveryTimer: ReturnType<typeof setTimeout> | undefined;
  private autoToolboxDiscoveryGeneration = 0;
  private lastAutoDiscoveryLog = '';
  private readonly autoToolboxWatchers = new Map<string, vscode.Disposable>();
  private readonly autoToolboxRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** One-shot latch: we prompt "select a control source" at most once per form (until it renders clean or the
   * user picks one), so a form with unresolved custom controls isn't nagging on every re-render. */
  private promptedForSource = false;
  /** Control assembly auto-resolved for a .NET Framework/DevExpress project when NO explicit source is set —
   * set by the last render's routing (undefined for a .NET project, whose output the net9 engine finds itself).
   * `asm()` returns it as the effective source so the net48 render AND its live edit ops all target the same
   * compiled assembly, and only a net9 form (autoAsm undefined) keeps engine-side auto-discovery. */
  private autoAsm: string | undefined;
  /** The big "Choose Toolbox Items" window (a separate editor-area webview panel), if open. */
  private chooseItemsPanel: vscode.WebviewPanel | undefined;
  /** (project, assembly) pairs we've already offered a <Reference> for — ask at most once each per session,
   * whatever the user answered, so adding several controls from one library doesn't nag repeatedly. */
  private readonly offeredReferences = new Set<string>();
  /** The toolbox tab the open Choose-Items window targets (checked items land here); undefined = none. */
  private chooseItemsTab: string | undefined;
  /** One-shot v2 document-owner gate. A refused owner is render-failed/read-only until the document is reopened. */
  private documentOwnerChecked = false;
  private lastDocumentOwner: DesignerDocumentOwnerResolution | undefined;
  /** Visual Studio opens a proven empty Form/UserControl partial even when its generated method is absent. We render
   * the same blank surface from a transient engine-only method, but keep every mutation fail-closed until the real
   * generated method returns; no placeholder is ever written into the user's source. */
  private emptyInitializeComponentSurface = false;
  /** Product persistence lane used by the latest ordinary scalar property edit. Retained for diagnostics and the
   * real Extension Host assertion that the owned-region route is not merely an orphaned engine endpoint. */
  private lastPropertyPersistenceLane: 'ownedRegion' | 'sourceFirst' | null = null;
  /** Certified vendor collection proposals never fall back after this proof fails. Retained for the real Extension
   * Host refusal assertion and reset before every certified collection transaction. */
  private lastOwnedRegionRefusal: string | null = null;
  /** Last read-only High-DPI advisor proposal. It is deliberately session-local and revision-bound: any intervening
   * edit (including edit then Undo back to byte-identical source) makes Apply refuse instead of silently replanning. */
  private pendingHighDpiQuickFix: PendingHighDpiQuickFix | undefined;

  private readonly documentUri: vscode.Uri;
  /** The custom document whose in-memory .Designer.cs text this session renders and edits (issue #2). */
  private readonly doc: WinFormsDesignDocument;
  /** One isolated modal editor at a time per designer session. The engine broker is cancellable/fail-closed, but
   * serialising this ingress also prevents two dialogs racing to apply values against the same document revision. */
  private uiTypeEditorBusy = false;
  private extensionHostUiTypeEditorResult: SupportedUiTypeEditorResult | undefined;
  private extensionHostUiTypeEditorResultConsumed = false;
  /** Extension Host-only S072 seam. The actual vendor worker still runs; only its otherwise-valid proposed source is
   * made malicious before the product owned-region authority sees it. Undefined in normal product operation. */
  private extensionHostVendorCollectionProposalTransform: ((source: string) => string) | undefined;
  /** Last property metadata actually published to the panel. Mutating editor messages are untrusted webview input;
   * they must match this exact component/revision before an engine adapter is invoked. */
  private publishedPropertyComponent: { ids: string[]; rev: number; component: ComponentDesc | null } | undefined;
  /** Deterministic Extension Host-only interleaving points for the W0 data-loss regression. Undefined in product. */
  private extensionHostBeforeJournaledResourceCommit: (() => Promise<void>) | undefined;
  private extensionHostAfterJournaledResourceBaseline: (() => Promise<void>) | undefined;
  private extensionHostFailJournalState: TransactionJournalState | undefined;
  private extensionHostJournalFailureObserved = false;
  private extensionHostFailForwardResourcePostcondition = false;
  private extensionHostResourcePostconditionFailureObserved = false;
  /** Bridges VS Code's global ordering when a composite event Undo leaves the ordinary code editor's Redo above the
   * CustomDocument Redo. The first user Redo restores code; this bridge immediately completes the designer half. */
  private companionHistoryBridge: {
    tx: CompanionTextTx;
    phase: 'awaitingCodeRedo' | 'autoRedoingDesigner';
  } | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly globalStorageUri: vscode.Uri,
    private readonly ensureEngine: EnsureEngine,
    private readonly getAssemblyOverride: AssemblyOverride,
    private readonly output: vscode.OutputChannel,
    private readonly onViewCode: (uri: vscode.Uri, position?: vscode.Position) => void,
    document: WinFormsDesignDocument,
    private readonly panel: vscode.WebviewPanel,
    /** Register an undoable custom-document edit with VS Code (drives native Ctrl+Z/Y + dirty/save). */
    private readonly fireEdit: (e: vscode.CustomDocumentEditEvent<WinFormsDesignDocument>) => void,
    /** Persist a control-source override for this form (T1.3 cross-runtime switch → net48 compiled preview). */
    private readonly setAssemblyOverride: SetAssemblyOverride,
  ) {
    this.doc = document;
    this.documentUri = document.uri;
    this.designerFile = document.designerFile;
    if (this.designerFile) {
      const restored = DesignerHub.instance.formViewState(this.designerFile).canvas?.selectedTabs ?? {};
      this.selectedTabs = new Map(Object.entries(restored));
    }
    DesignerHub.instance.registerSession(this); // so a live language switch can re-emit this canvas too
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    this.output.appendLine(`[designer] editor opened: ${document.uri.fsPath} → designer ${this.designerFile ?? '<none>'}`);

    if (!this.designerFile) {
      panel.webview.html = placeholderHtml(panel.webview, document.uri.fsPath);
      return;
    }

    panel.webview.html = designerHtml(panel.webview, this.extensionUri);
    this.disposables.push(panel.webview.onDidReceiveMessage((m) => void this.onMessage(m)));

    // this designer owns the shared Toolbox/Properties views while it's the focused editor.
    if (panel.active) DesignerHub.instance.setActive(this);
    this.disposables.push(panel.onDidChangeViewState((e) => { if (e.webviewPanel.active) DesignerHub.instance.setActive(this); }));

    const initTimer = setTimeout(() => {
      if (!this.gotReady && !this.disposed) {
        this.output.appendLine('[designer] webview did NOT send "ready" within 6s (script blocked / failed to init)');
        void vscode.window.showErrorMessage(t('host.initTimeout'));
      }
    }, 6000);
    this.disposables.push({ dispose: () => clearTimeout(initTimer) });

    // Designer edits no longer flow through a TextDocument (the .Designer.cs is owned in-memory by `doc`), so
    // there's no onDidChange/onDidSave to watch. We DO watch the file on disk: an external change (git
    // checkout, another tool, or our own save) reloads the in-memory text when clean, or is kept-with-note
    // when the user has unsaved designer edits — see reloadFromDiskIfClean.
    const key = normalize(this.designerFile);
    const codePath = this.codeFile();
    const codeKey = codePath ? normalize(codePath) : '';
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(path.dirname(this.designerFile), '*'),
    );
    const onFs = (uri: vscode.Uri) => {
      const changed = normalize(uri.fsPath);
      if (changed === key) this.scheduleRerender();
      else if (codeKey && changed === codeKey) this.scheduleCodeBehindRerender();
    };
    watcher.onDidChange(onFs);
    watcher.onDidCreate(onFs);
    watcher.onDidDelete(onFs);
    this.disposables.push(watcher);

    // Auto-discovery is session-triggered, never activation-triggered. Yield/cancel as soon as the user starts
    // editing or leaves VS Code; returning focus schedules a fresh bounded pass after the interaction settles.
    this.disposables.push(vscode.workspace.onDidChangeTextDocument((event) => {
      this.onCompanionHistoryTextChanged(event.document);
      // Only real editing yields: this event also fires for VS Code's own output-channel documents, so an open
      // extension log would keep rescheduling discovery, whose every pass appends another line to that same log.
      if (!isUserEditDocument(event.document.uri.scheme)) return;
      this.cancelAutoToolboxDiscovery();
      this.scheduleAutoToolboxDiscovery(1200);
      if (codeKey && normalize(event.document.uri.fsPath) === codeKey) this.scheduleCodeBehindRerender();
    }));
    this.disposables.push(vscode.window.onDidChangeWindowState((state) => {
      if (!state.focused) this.cancelAutoToolboxDiscovery();
      else this.scheduleAutoToolboxDiscovery(800);
    }));

    panel.onDidDispose(() => this.dispose());
  }

  /** @vscode/test-electron cannot synthesize a canvas pointer drag. The extension's test-only activation API reaches
   * this narrow wrapper so the real session executes the same engine-authorized group transaction and emits the same
   * native CustomDocumentEditEvent as a webview drag. It is never returned by activate() outside the E2E host. */
  async extensionHostTestMoveGroup(ids: readonly string[], dx: number, dy: number): Promise<void> {
    await this.applyGroupMove([...ids], dx, dy);
  }

  /** S020: start the same render path used after source/view changes, without awaiting it in the test caller. */
  async extensionHostTestRerender(): Promise<void> {
    await this.fullRender();
  }

  /** S122 only: run the real full-render path at one catalog logical-DPI leg. This forces a capture even when two
   * adjacent logical DPRs share the same safe 2x backing, because the performance matrix records each leg. */
  async extensionHostTestSetDpi(displayDpr: number): Promise<void> {
    const dpi = designerDpiScale(displayDpr);
    this.displayDpr = dpi.displayDpr;
    this.renderScale = dpi.captureScale;
    await this.fullRender();
  }

  /** V2-FND-001-S126 — plan the same exact AutoScaleMode edit the normal Properties path would persist, but do not
   * mutate the CustomDocument. The command host displays the returned before/after bytes in a read-only VS Code diff. */
  async previewHighDpiQuickFix(): Promise<HighDpiQuickFixPreviewResult> {
    this.pendingHighDpiQuickFix = undefined;
    if (!this.designerFile || this.disposed) {
      return { status: 'notApplicable', reason: 'no active WinForms designer document' };
    }

    const before = this.doc.designerText;
    const revision = this.doc.rev;
    const component = await this.describeFor('this');
    if (this.doc.rev !== revision || this.doc.designerText !== before) {
      return { status: 'refused', reason: 'designer source changed while the advisor was inspecting it' };
    }
    const property = component?.properties.find((candidate) => candidate.name === 'AutoScaleMode');
    if (!component || component.id !== 'this' || component.editable === false
      || !property || property.type !== 'System.Windows.Forms.AutoScaleMode'
      || property.readOnly || !property.sourceExplicit) {
      return { status: 'notApplicable', reason: 'the root AutoScaleMode assignment is not an editable source value' };
    }
    if (property.value !== 'None') {
      return {
        status: 'notApplicable',
        reason: property.value === 'Font'
          ? 'AutoScaleMode is already Font'
          : `AutoScaleMode is ${property.value ?? 'unavailable'}, not None`,
      };
    }

    const planner = await this.ensureEngine('modern');
    const planned = await setPropertyViaProvenOwnedRegion(
      planner,
      this.designerFile,
      'this',
      'AutoScaleMode',
      'System.Windows.Forms.AutoScaleMode.Font',
      before,
      this.engineKind === 'modern' ? this.modernGraphToken : undefined,
    );
    if (!planned.safe || planned.text === null || planned.text === before) {
      return { status: 'refused', reason: planned.reason || 'the exact AutoScaleMode source patch was not safe' };
    }
    if (this.doc.rev !== revision || this.doc.designerText !== before) {
      return { status: 'refused', reason: 'designer source changed while the advisor was planning the patch' };
    }
    if (!this.preflightCommit(before, planned.text, 'Apply High-DPI AutoScaleMode quick fix', [], revision)) {
      return { status: 'refused', reason: 'the normal designer commit safety gates refused this source patch' };
    }

    const pending: PendingHighDpiQuickFix = {
      designerFile: this.designerFile,
      before,
      after: planned.text,
      revision,
      beforeSha256: sha256Hex(before),
      afterSha256: sha256Hex(planned.text),
      persistenceLane: planned.persistenceLane,
    };
    this.pendingHighDpiQuickFix = pending;
    return { status: 'previewed', ...pending };
  }

  /** Accept only the exact preview currently retained by this session. The ordinary commit firewall is re-run at
   * the final boundary; success therefore participates in native Undo/Redo exactly like a Properties-grid edit. */
  async applyPendingHighDpiQuickFix(): Promise<HighDpiQuickFixApplyResult> {
    const pending = this.pendingHighDpiQuickFix;
    this.pendingHighDpiQuickFix = undefined;
    if (!pending || !this.designerFile || this.disposed) {
      return { status: 'refused', reason: 'there is no current High-DPI quick-fix preview' };
    }
    if (this.designerFile !== pending.designerFile
      || this.doc.rev !== pending.revision
      || this.doc.designerText !== pending.before
      || sha256Hex(this.doc.designerText) !== pending.beforeSha256) {
      return { status: 'refused', reason: 'the High-DPI preview is stale; preview the fix again' };
    }
    if (!this.commit(
      pending.before,
      pending.after,
      'Apply High-DPI AutoScaleMode quick fix',
      undefined,
      pending.revision,
    )) {
      return { status: 'refused', reason: 'the normal designer commit safety gates refused the previewed patch' };
    }

    let propertiesReconciled = false;
    if (this.engineKind === 'net48') {
      propertiesReconciled = await this.liveEdit48('this', 'AutoScaleMode', 'Font');
    } else {
      propertiesReconciled = await this.patchOrRerender('this', 'AutoScaleMode', {
        beforeSourceText: pending.before,
        afterSourceText: pending.after,
        newValueExpr: 'System.Windows.Forms.AutoScaleMode.Font',
      });
    }
    if (!propertiesReconciled) await this.loadProps('this');
    this.postDirty();
    this.output.appendLine('[advisor] applied this.AutoScaleMode = Font (previewed exact patch, unsaved)');
    return {
      status: 'applied',
      designerFile: pending.designerFile,
      beforeSha256: pending.beforeSha256,
      afterSha256: pending.afterSha256,
      persistenceLane: pending.persistenceLane,
    };
  }

  /** S020: reach the exact onMessage generation gate with the real current layout and document session. */
  async extensionHostTestCanvasInput(
    kind: 'pick' | 'nudge',
    id: string,
    generation: number,
  ): Promise<{ accepted: boolean; refusalCode: 'STALE_CANVAS' | null; renderGeneration: number }> {
    this.lastCanvasInputRefusalCode = null;
    if (kind === 'pick') {
      await this.onMessage({ type: 'pick', id, ids: [id], gen: generation });
    } else {
      const control = this.controls.find((candidate) => candidate.id === id);
      if (!control) throw new Error(`Canvas test control is not in the current layout: ${id}`);
      await this.onMessage({
        type: 'manipulate', id, mode: 'move', gen: generation,
        x: control.x + 1, y: control.y, width: control.width, height: control.height,
      });
    }
    return {
      accepted: this.lastCanvasInputRefusalCode === null,
      refusalCode: this.lastCanvasInputRefusalCode,
      renderGeneration: this.renderSeq,
    };
  }

  /** Real Extension Host E2E reaches the same default-event discovery path as a canvas double-click. */
  async extensionHostTestCreateDefaultHandler(id: string): Promise<void> {
    await this.createDefaultHandler(id);
  }

  /** Deterministic real-host ingress for the code-behind revision race after engine validation but before commit. */
  async extensionHostTestSetHandlerWithInterleave(
    id: string,
    eventName: string,
    handlerName: string,
    interleave: () => Promise<void>,
  ): Promise<void> {
    await this.applyEventWiring(id, eventName, handlerName, undefined, interleave);
  }

  /** Deterministic real-host ingress for a code-behind change after handler generation but before either artifact. */
  async extensionHostTestCreateHandlerWithInterleave(
    id: string,
    eventName: string,
    interleave: () => Promise<void>,
  ): Promise<void> {
    await this.createHandler(id, eventName, undefined, undefined, interleave);
  }

  /** Real Extension Host E2E reaches the same per-control alignment ingress as the canvas toolbar. */
  async extensionHostTestAlignControls(
    edits: readonly { id: string; dx: number; dy: number }[],
  ): Promise<void> {
    await this.applyAlign(edits.map((edit) => ({ ...edit })));
  }

  /** Real Extension Host E2E reaches the same client-rectangle centering ingress as the canvas Format toolbar. */
  async extensionHostTestCenterInForm(axis: 'h' | 'v', ids: readonly string[]): Promise<void> {
    await this.applyCenterInForm(axis, [...ids]);
  }

  extensionHostTestFocus(): void {
    this.panel.reveal(this.panel.viewColumn, false);
  }

  async extensionHostTestEditProperty(
    id: string,
    propertyName: string,
    propertyType: string,
    isEnum: boolean,
    value: string,
  ): Promise<void> {
    await this.applyEdit(id, propertyName, propertyType, isEnum, value);
  }

  /** S045/S046: preserve the entire real Properties/UITypeEditor product path while replacing only the native modal
   * interaction with the already-validated result shape covered by the isolated broker tests. */
  async extensionHostTestColorUiTypeEditor(
    id: string,
    propertyName: string,
    outcome: 'apply-blue' | 'dismiss',
  ): Promise<{
      applied: boolean;
      dismissed: boolean;
      resultConsumed: boolean;
      editorType: string | null;
      refusalCode: 'CANCELLED' | null;
    }> {
    if (this.currentId !== id) await this.pick(id, undefined, [id]);
    const metadata = this.publishedEditableProperty(id, propertyName);
    if (!metadata || metadata.type !== 'System.Drawing.Color'
      || metadata.uiTypeEditor !== 'System.Drawing.Design.ColorEditor') {
      return {
        applied: false,
        dismissed: false,
        resultConsumed: false,
        editorType: metadata?.uiTypeEditor ?? null,
        refusalCode: null,
      };
    }
    const before = this.doc.designerText;
    this.extensionHostUiTypeEditorResultConsumed = false;
    this.extensionHostUiTypeEditorResult = outcome === 'apply-blue'
      ? { ok: true, applied: true, dismissed: false, invariantValue: 'Blue', errorCode: '', reason: '' }
      : { ok: true, applied: false, dismissed: true, invariantValue: null, errorCode: '', reason: '' };
    try {
      await this.uiTypeEditorFromGrid(id, propertyName, metadata.type, metadata.uiTypeEditor);
      return {
        applied: this.doc.designerText !== before,
        dismissed: outcome === 'dismiss' && this.doc.designerText === before,
        resultConsumed: this.extensionHostUiTypeEditorResultConsumed,
        editorType: metadata.uiTypeEditor,
        refusalCode: outcome === 'dismiss' && this.doc.designerText === before ? 'CANCELLED' : null,
      };
    } finally {
      this.extensionHostUiTypeEditorResult = undefined;
      this.extensionHostUiTypeEditorResultConsumed = false;
    }
  }

  /** S047/S048: invoke the actual broker/child worker using only the currently published certified metadata. */
  async extensionHostTestCertifiedVendorUiTypeEditor(
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
    }> {
    if (this.currentId !== id) await this.pick(id, undefined, [id]);
    const metadata = this.publishedEditableProperty(id, propertyName);
    const before = this.doc.designerText;
    if (!metadata?.uiTypeEditor || !metadata.uiTypeEditorAssemblyPath
      || !metadata.uiTypeEditorAssemblySha256 || !metadata.uiTypeEditorCertificationId) {
      return {
        applied: false,
        brokerApplied: false,
        dismissed: false,
        ok: false,
        errorCode: 'UNPUBLISHED_EDITOR',
        invariantValue: null,
        editorType: metadata?.uiTypeEditor ?? null,
        assemblyPath: metadata?.uiTypeEditorAssemblyPath ?? null,
        assemblySha256: metadata?.uiTypeEditorAssemblySha256 ?? null,
        certificationId: metadata?.uiTypeEditorCertificationId ?? null,
      };
    }
    const result = await this.uiTypeEditorFromGrid(id, propertyName, metadata.type, metadata.uiTypeEditor);
    return {
      applied: this.doc.designerText !== before,
      brokerApplied: result?.applied === true,
      dismissed: result?.dismissed === true,
      ok: result?.ok === true,
      errorCode: result?.errorCode || null,
      invariantValue: result?.invariantValue ?? null,
      editorType: metadata.uiTypeEditor,
      assemblyPath: metadata.uiTypeEditorAssemblyPath,
      assemblySha256: metadata.uiTypeEditorAssemblySha256,
      certificationId: metadata.uiTypeEditorCertificationId,
    };
  }

  /** S071/S072: invoke the actual certified vendor collection editor, then exercise the product-owned bounded source
   * transaction. The malicious variant changes one root statement after the worker returns so the same authority must
   * refuse it without a document or history mutation. */
  async extensionHostTestCertifiedVendorCollectionEditor(
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
    }> {
    if (this.currentId !== id) await this.pick(id, undefined, [id]);
    const metadata = this.publishedEditableProperty(id, propertyName);
    const before = this.doc.designerText;
    if (!metadata?.genericCollection || metadata.collectionItemType !== 'System.Int32'
      || !metadata.uiTypeEditor || !metadata.uiTypeEditorAssemblyPath
      || !metadata.uiTypeEditorAssemblySha256 || !metadata.uiTypeEditorCertificationId) {
      return {
        applied: false,
        brokerApplied: false,
        dismissed: false,
        ok: false,
        errorCode: 'UNPUBLISHED_EDITOR',
        collectionItems: [],
        editorType: metadata?.uiTypeEditor ?? null,
        assemblyPath: metadata?.uiTypeEditorAssemblyPath ?? null,
        assemblySha256: metadata?.uiTypeEditorAssemblySha256 ?? null,
        certificationId: metadata?.uiTypeEditorCertificationId ?? null,
        persistenceLane: null,
        refusalReason: null,
      };
    }

    this.extensionHostVendorCollectionProposalTransform = tamperOutsideOwnedComponent
      ? (source) => source.replace(
          'this.Text = "Vendor collection";',
          'this.Text = "Tampered outside vendorEdit1";',
        )
      : undefined;
    this.lastOwnedRegionRefusal = null;
    this.lastPropertyPersistenceLane = null;
    try {
      const result = await this.uiCollectionEditorFromGrid(
        id, propertyName, metadata.collectionItemType, metadata.uiTypeEditor);
      const refused = this.lastOwnedRegionRefusal !== null;
      const applied = this.doc.designerText !== before;
      return {
        applied,
        brokerApplied: result?.applied === true,
        dismissed: result?.dismissed === true,
        ok: result?.ok === true && !refused && applied,
        errorCode: refused ? 'OWNED_REGION_VIOLATION' : (result?.errorCode || null),
        collectionItems: Array.isArray(result?.collectionItems) ? result.collectionItems.slice() : [],
        editorType: metadata.uiTypeEditor,
        assemblyPath: metadata.uiTypeEditorAssemblyPath,
        assemblySha256: metadata.uiTypeEditorAssemblySha256,
        certificationId: metadata.uiTypeEditorCertificationId,
        persistenceLane: this.lastPropertyPersistenceLane,
        refusalReason: this.lastOwnedRegionRefusal,
      };
    } finally {
      this.extensionHostVendorCollectionProposalTransform = undefined;
    }
  }

  /** S094: use the live ComponentDesigner/DesignerActionList descriptor as the only authority for the same
   * source-first edit that the real on-canvas Tasks flyout posts. No vendor setter executes in the Extension Host. */
  async extensionHostTestDesignerActionProperty(
    id: string,
    displayName: string,
    value: string,
  ): Promise<{
      applied: boolean;
      displayName: string | null;
      category: string | null;
      propertyName: string | null;
      propertyType: string | null;
    }> {
    if (this.currentId !== id) await this.pick(id, undefined, [id]);
    const published = this.publishedPropertyComponent;
    const component = published?.ids.length === 1 && published.ids[0] === id && published.rev === this.doc.rev
      ? published.component
      : null;
    const matches = component?.designerActions?.filter((candidate) => candidate.displayName === displayName) ?? [];
    const action = matches.length === 1 ? matches[0] : undefined;
    const property = action ? this.publishedEditableProperty(id, action.propertyName) : undefined;
    if (!action || !property) {
      return {
        applied: false,
        displayName: action?.displayName ?? null,
        category: action?.category ?? null,
        propertyName: action?.propertyName ?? null,
        propertyType: property?.type ?? null,
      };
    }
    const before = this.doc.designerText;
    await this.editFromGrid(id, property.name, property.type, property.isEnum, value);
    return {
      applied: this.doc.designerText !== before,
      displayName: action.displayName,
      category: action.category,
      propertyName: property.name,
      propertyType: property.type,
    };
  }

  /** S093: confirm one displayed hosted adorner through the exact revision-bound metadata and fresh engine graph that
   * own the real canvas hover. No ControlDesigner object or callback runs in the Extension Host. */
  async extensionHostTestDesignerAdornerHit(
    id: string,
    adornerId: string,
    x: number,
    y: number,
  ): Promise<DesignerAdornerHitResult> {
    if (this.currentId !== id) await this.pick(id, undefined, [id]);
    return this.confirmDesignerAdornerHit(id, adornerId, x, y);
  }

  private designerAdornerHitRefusal(
    id: string,
    adornerId: string,
    errorCode: string,
    reason: string,
  ): DesignerAdornerHitResult {
    return {
      ok: false,
      hit: false,
      componentId: id,
      adornerId,
      componentType: '',
      designerType: '',
      errorCode,
      reason,
    };
  }

  /** Product hover authority: accept only the exact single-selection/revision descriptor already published to the
   * canvas, then ask the modern engine to rebuild the graph and let the live ControlDesigner confirm the local point. */
  private async confirmDesignerAdornerHit(
    id: string,
    adornerId: string,
    x: number,
    y: number,
  ): Promise<DesignerAdornerHitResult> {
    if (this.engineKind !== 'modern') {
      return this.designerAdornerHitRefusal(id, adornerId, 'runtime_unavailable',
        'Hosted ControlDesigner adorners are available only on the modern product route.');
    }
    if (!Number.isInteger(x) || !Number.isInteger(y) || Math.abs(x) > 16_384 || Math.abs(y) > 16_384) {
      return this.designerAdornerHitRefusal(id, adornerId, 'invalid_point',
        'The hosted adorner point is invalid.');
    }

    const published = this.publishedPropertyComponent;
    const component = published?.ids.length === 1 && published.ids[0] === id
      && published.rev === this.doc.rev && this.currentId === id
      && this.currentSelectionIds.length === 1 && this.currentSelectionIds[0] === id
      ? published.component
      : null;
    const matches = component?.designerAdorners?.filter((candidate) => candidate.id === adornerId) ?? [];
    const adorner = matches.length === 1 ? matches[0] : undefined;
    if (!component || !adorner || adorner.hitTestable !== true
      || !Number.isInteger(adorner.left) || !Number.isInteger(adorner.top)
      || !Number.isInteger(adorner.width) || !Number.isInteger(adorner.height)
      || adorner.width <= 0 || adorner.height <= 0
      || x < adorner.left || x >= adorner.left + adorner.width
      || y < adorner.top || y >= adorner.top + adorner.height) {
      return this.designerAdornerHitRefusal(id, adornerId, 'adorner_unavailable',
        'The hosted adorner is not available at this point for the current selection and source revision.');
    }

    const selectionGen = this.selectionGen;
    const sourceRev = this.doc.rev;
    const sourceText = await this.currentEngineText();
    const engine = await this.ensureEngine('modern');
    const result = await hitTestDesignerAdorner(
      engine, this.designerFile!, id, adornerId, x, y, this.asm(), sourceText);
    if (this.disposed || selectionGen !== this.selectionGen || sourceRev !== this.doc.rev
      || this.currentId !== id || this.currentSelectionIds.length !== 1 || this.currentSelectionIds[0] !== id) {
      return this.designerAdornerHitRefusal(id, adornerId, 'stale_request',
        'The hosted adorner hover was superseded by a newer selection or source revision.');
    }
    if (result.componentId !== id || result.adornerId !== adornerId) {
      return this.designerAdornerHitRefusal(id, adornerId, 'invalid_engine_response',
        'The engine returned an unrelated hosted adorner result.');
    }
    return result;
  }

  /** Pause a real Properties resource edit after its durable baseline is captured but before its first write. */
  async extensionHostTestEditPropertyWithResourceInterleave(
    id: string,
    propertyName: string,
    propertyType: string,
    isEnum: boolean,
    value: string,
    interleave: () => Promise<void>,
  ): Promise<boolean> {
    let interleaveObserved = false;
    this.extensionHostAfterJournaledResourceBaseline = async () => {
      interleaveObserved = true;
      await interleave();
    };
    try {
      await this.applyEdit(id, propertyName, propertyType, isEnum, value);
      return interleaveObserved;
    } finally {
      this.extensionHostAfterJournaledResourceBaseline = undefined;
    }
  }

  async extensionHostTestReparent(id: string, parentId: string): Promise<string | null> {
    const refusal = this.outlineReparentReason(id, parentId) || null;
    await this.applyReparent(id, parentId);
    return refusal;
  }

  async extensionHostTestAddControl(controlType: string, parentId: string,
    x?: number, y?: number, width?: number, height?: number): Promise<void> {
    await this.applyAddControl(controlType, parentId, x, y, width, height);
  }

  async extensionHostTestRemoveControl(id: string): Promise<number> {
    if (this.localizable) return this.applyLocalizedStructuralRemove([id], `Remove localized ${id}`);
    await this.applyRemoveControl(id);
    return 1;
  }

  /** Real Extension Host E2E reaches the same validated component-rename transaction as the Properties surface. */
  async extensionHostTestRenameControl(id: string, newName: string): Promise<void> {
    await this.applyComponentRename(id, newName);
  }

  /** Real Extension Host E2E selects through the same session state transition as a canvas/outline pick. */
  async extensionHostTestSelectControl(id: string): Promise<void> {
    await this.pick(id, undefined, [id]);
  }

  /** S095: repeat the exact product hosted-designer activation for the currently published certified component. The
   * test controls only the hostile fixture's marker; assembly/type/certificate authority and quarantine stay engine-owned. */
  async extensionHostTestProbeHostedDesigner(id: string): Promise<HostedDesignerProbeResult> {
    if (this.currentId !== id) await this.pick(id, undefined, [id]);
    const published = this.publishedPropertyComponent;
    const component = published?.ids.length === 1 && published.ids[0] === id
      && published.rev === this.doc.rev ? published.component : null;
    if (!component || component.type !== CERTIFIED_HOSTED_DESIGNER_COMPONENT) {
      return {
        ok: false,
        status: 'refused',
        errorCode: 'UNPUBLISHED_DESIGNER',
        reason: 'The current selection has no repository-certified hosted designer.',
        componentType: component?.type ?? '',
        designerType: '',
        certificationId: '',
        assemblySha256: '',
        mainEnginePid: 0,
        workerPid: 0,
        exitCode: 0,
        workerStarted: false,
        quarantined: false,
        privateDesktop: false,
      };
    }
    const result = await this.inspectHostedDesignerProduct(component);
    if (!result) throw new Error('The certified hosted-designer product route is unavailable.');
    this.publishHostedDesignerProbe(result);
    return result;
  }

  /** S089/S090: drive the same revision-bound product command as a click in the visible smart-tag flyout. */
  async extensionHostTestInvokeHostedServiceAction(
    id: string,
    commandId: string,
    certificationId: string,
  ): Promise<HostedServiceKernelProductResult> {
    if (this.currentId !== id) await this.pick(id, undefined, [id]);
    return this.applyHostedServiceKernelCommand(id, commandId, certificationId);
  }

  /** Return a detached copy of the exact component metadata published for the current selection and document
   * revision. Engine payloads are JSON data; cloning prevents an E2E assertion from mutating session authority. */
  extensionHostTestPublishedPropertyComponent(): ComponentDesc | null {
    const published = this.publishedPropertyComponent;
    if (!published || published.ids.length !== 1 || published.ids[0] !== this.currentId
      || published.rev !== this.doc.rev || !published.component) return null;
    return JSON.parse(JSON.stringify(published.component)) as ComponentDesc;
  }

  /** Real Extension Host E2E uses the same DataBindings read side as the open Properties popup. */
  async extensionHostTestListBindings(id: string): Promise<BindingItems> {
    return this.readBindingItems(id);
  }

  /** Real Extension Host E2E uses the same DataBindings write side as the popup's single OK action. */
  async extensionHostTestSetBindings(id: string, bindings: BindingItem[]): Promise<boolean> {
    return this.bindingsFromGrid(id, bindings.map((binding) => ({ ...binding })));
  }

  async extensionHostTestListDataSources(): Promise<DataSourcesResult> {
    return this.refreshDataSources();
  }

  async extensionHostTestGenerateDataSource(
    schemaKey: string,
    mode: 'detail' | 'grid',
    parentId: string,
    x: number,
    y: number,
    includeNavigator: boolean,
    existingBindingSourceId: string | null,
    existingGridId: string | null,
  ): Promise<DataSourceGenerationResult> {
    return this.generateFromDataSource(
      schemaKey, mode, parentId, x, y, includeNavigator, existingBindingSourceId, existingGridId);
  }

  /** Real Extension Host E2E uses the same project-resource enumeration, freshness checks, and commit as QuickPick. */
  async extensionHostTestSetProjectImageResource(id: string, propertyName: string,
    accessor: string): Promise<boolean> {
    return this.pickProjectImageResourceFromGrid(id, propertyName, accessor);
  }

  /** Real Extension Host E2E drives an untrusted picker result through the product validation boundary. */
  async extensionHostTestTryProjectImageResource(id: string, propertyName: string,
    accessor: string): Promise<{ applied: boolean; refusalCode: string | null; reason: string | null }> {
    const reason = requestedProjectResourceAccessorRefusal(accessor);
    const applied = await this.pickProjectImageResourceFromGrid(id, propertyName, accessor);
    return {
      applied,
      refusalCode: !applied && reason ? 'INVALID_RESOURCE_SYMBOL' : null,
      reason: !applied ? reason : null,
    };
  }

  /** Real Extension Host E2E bypasses only the native file picker and retains the complete Import resource path. */
  async extensionHostTestImportLocalImage(id: string, propertyName: string,
    propertyType: string, imageUri: vscode.Uri): Promise<boolean> {
    return this.importImageFromGrid(id, propertyName, propertyType, imageUri);
  }

  /** Real Extension Host E2E bypasses native pickers but retains the complete ImageList resource transaction. */
  async extensionHostTestSetImageListImages(id: string,
    images: readonly { image: vscode.Uri; key?: string }[]): Promise<boolean> {
    if (this.currentId !== id) await this.pick(id, undefined, [id]);
    return this.editImageListImages(images.map((item) => ({ imageUri: item.image, key: item.key })));
  }

  /** V2-FND-001-S118: force only the final verified forward postcondition to fail; the shipped runner must compensate. */
  async extensionHostTestSetImageListWithPostconditionFailure(id: string,
    images: readonly { image: vscode.Uri; key?: string }[]): Promise<{
      applied: boolean;
      failureObserved: boolean;
      refusalCode: 'POSTCONDITION_FAILED_ROLLED_BACK' | null;
    }> {
    if (this.currentId !== id) await this.pick(id, undefined, [id]);
    this.extensionHostFailForwardResourcePostcondition = true;
    this.extensionHostResourcePostconditionFailureObserved = false;
    try {
      const applied = await this.editImageListImages(images.map((item) => ({ imageUri: item.image, key: item.key })));
      const failureObserved = this.extensionHostResourcePostconditionFailureObserved;
      return {
        applied,
        failureObserved,
        refusalCode: !applied && failureObserved ? 'POSTCONDITION_FAILED_ROLLED_BACK' : null,
      };
    } finally {
      this.extensionHostFailForwardResourcePostcondition = false;
    }
  }

  /** Real Extension Host E2E bypasses only QuickPick and retains the product culture-selection path. */
  async extensionHostTestSetLocalizationCulture(culture: string): Promise<boolean> {
    return this.selectLocalizationCulture(culture);
  }

  /** Real Extension Host E2E reaches the exact Table/Flow canvas-drop transaction after webview hit testing. */
  async extensionHostTestMoveLayoutChild(id: string, dropX: number, dropY: number): Promise<boolean> {
    return (await this.applyManagedLayoutMove(id, dropX, dropY)) ?? false;
  }

  extensionHostTestLayout(): readonly LayoutControl[] {
    return this.controls.map((control) => ({ ...control }));
  }

  /** Real Extension Host E2E reaches the exact ListView.Columns panel read side. */
  async extensionHostTestListColumns(id: string): Promise<{
    ok: boolean;
    columns: ColumnItem[];
    reason: string;
  }> {
    return this.readColumnItems(id);
  }

  /** Real Extension Host E2E reaches the exact atomic ListView.Columns panel write side. */
  async extensionHostTestSetColumns(id: string, columns: ColumnItem[]): Promise<boolean> {
    return this.columnsFromGrid(id, columns);
  }

  /** Real Extension Host E2E reaches the exact typed TabPages collection read side. */
  async extensionHostTestListTabPages(hostId: string): Promise<{
    ok: boolean;
    pages: string[];
    reason: string;
  }> {
    return this.readTabPages(hostId);
  }

  /** Real Extension Host E2E reaches the exact atomic TabPages collection OK transaction. */
  async extensionHostTestSetTabPages(hostId: string, pageIds: string[]): Promise<boolean> {
    return this.tabPagesFromGrid(hostId, pageIds);
  }

  /** Real Extension Host E2E reaches the exact Items-editor read side and establishes its stale-write revision. */
  async extensionHostTestListToolStripItems(id: string): Promise<{
    ok: boolean;
    items: ToolStripItemModel[];
    reason: string;
  }> {
    return this.readToolStripItems(id);
  }

  /** Real Extension Host E2E reaches the exact Items-editor write side, including revision gate + native history. */
  async extensionHostTestSetToolStripItems(id: string, items: ToolStripItemModel[]): Promise<boolean> {
    return this.toolStripFromGrid(id, items);
  }

  /** Real Extension Host E2E reaches the exact on-canvas item drag/reparent transaction. */
  async extensionHostTestMoveToolStripItem(
    hostId: string,
    itemId: string,
    targetParentItemId: string | null,
    targetIndex: number,
  ): Promise<{ applied: boolean; reason: string | null }> {
    return this.applyStripMove(hostId, itemId, targetParentItemId, targetIndex);
  }

  /** Real Extension Host E2E reaches the same opaque product clipboard path as Ctrl+C. */
  async extensionHostTestCopyControls(ids: readonly string[]): Promise<void> {
    await this.applyCopy([...ids]);
  }

  /** Real Extension Host E2E reaches the same collision-safe product paste transaction as Ctrl+V. */
  async extensionHostTestPaste(targetId?: string): Promise<void> {
    await this.applyPaste(targetId);
  }

  async extensionHostTestResourceRace(
    kind: 'journaled' | 'ordinary',
    resourceUri: vscode.Uri,
    interleave: () => Promise<void>,
  ): Promise<boolean> {
    const existing = await this.readResx(resourceUri);
    const beforeResource = existing?.text ?? null;
    const afterResource = `${beforeResource ?? '<root />'}\n<!-- W0 race candidate -->\n`;
    const tx: ResxTx = {
      uri: resourceUri,
      before: beforeResource,
      after: afterResource,
      bom: existing?.hadBom ?? false,
    };
    if (kind === 'journaled') {
      let interleaveObserved = false;
      this.extensionHostBeforeJournaledResourceCommit = async () => {
        interleaveObserved = true;
        await interleave();
      };
      try {
        const beforeDesigner = this.doc.designerText;
        const expectedRevision = this.doc.rev;
        const result = await this.commitResourceSetThroughRunner(
          'W0 journaled resource race',
          [tx],
          beforeDesigner,
          beforeDesigner,
          { expectedDesignerRevision: expectedRevision },
        );
        if (!interleaveObserved) {
          throw new Error([
            `journaled race stopped before final commit: ${result?.status ?? 'unavailable'} ${result?.error ?? ''}`,
            `designer=${this.designerFile ?? '<none>'}`,
            `workspace=${this.wsRoot() ?? '<none>'}`,
            `resource=${resourceUri.fsPath}`,
            `storage=${this.globalStorageUri.toString()} fsPath=${this.globalStorageUri.fsPath} path=${this.globalStorageUri.path}`,
          ].join(' | '));
        }
        return result?.status === 'committed';
      }
      finally { this.extensionHostBeforeJournaledResourceCommit = undefined; }
    }
    const beforeDesigner = this.doc.designerText;
    const expectedRevision = this.doc.rev;
    this.extensionHostBeforeJournaledResourceCommit = interleave;
    try {
      return await this.commitOrdinaryResourceEdit(
        beforeDesigner,
        beforeDesigner,
        'W0 ordinary image resource race',
        tx,
        expectedRevision,
      );
    } finally {
      this.extensionHostBeforeJournaledResourceCommit = undefined;
    }
  }

  async extensionHostTestMakeLocalizableJournalFailure(
    state: 'applied' | 'undoRegistered' | 'committed',
  ): Promise<{ result: boolean; failureObserved: boolean }> {
    this.extensionHostFailJournalState = state;
    this.extensionHostJournalFailureObserved = false;
    try {
      const result = await this.makeFormLocalizable();
      return { result, failureObserved: this.extensionHostJournalFailureObserved };
    } finally {
      this.extensionHostFailJournalState = undefined;
    }
  }

  extensionHostTestState(): {
    renderReady: boolean;
    /** See openDocumentState.panelActive. Read through the disposed flag: WebviewPanel.active throws once the panel
     * is gone, and this getter is polled by every waitFor predicate. */
    panelActive: boolean;
    engineKind: EngineKind; net48RenderMode: 'interpreted' | 'compiledFallback' | 'compiled' | null;
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
    lastFullRenderTelemetry: ProductRenderTelemetry | null;
    lastHostedDesignerProbe: HostedDesignerProbeResult | null;
    lastHostedServiceKernelResult: HostedServiceKernelProductResult | null;
    renderGeneration: number;
    currentId: string;
    currentSelectionIds: readonly string[];
    controls: readonly { id: string; parentId?: string | null; ownership?: LayoutControl['ownership']; editable?: boolean }[];
    tray: readonly { id: string; name: string; type: string; isStrip?: boolean }[];
    selectedPropertyComponent: {
      id: string;
      name: string;
      type: string;
      properties: readonly { name: string; value: string | null }[];
    } | null;
  } {
    const published = this.publishedPropertyComponent;
    const selectedPropertyComponent = published?.ids.length === 1
      && published.ids[0] === this.currentId
      && published.rev === this.doc.rev
      ? published.component
      : null;
    return {
      renderReady: this.renderOk,
      panelActive: !this.disposed && this.panel.active,
      engineKind: this.engineKind, net48RenderMode: this.engineKind === 'net48' ? this.net48RenderMode as 'interpreted' | 'compiledFallback' | 'compiled' : null,
      ownerDiagnosticCode: this.lastDocumentOwner?.diagnosticCode ?? null,
      ownerTypeName: this.lastDocumentOwner?.typeName ?? null,
      ownerProjectPath: this.lastDocumentOwner?.projectPath ?? null,
      ownerPaths: this.lastDocumentOwner?.owners ?? [],
      emptyInitializeComponentSurface: this.emptyInitializeComponentSurface,
      renderFailureCause: this.lastRenderDiagnostic?.kind === 'failure'
        ? this.lastRenderDiagnostic.cause
        : null,
      renderFailureMessage: this.lastRenderDiagnostic?.kind === 'failure'
        ? this.lastRenderDiagnostic.message
        : null,
      lastPropertyPersistenceLane: this.lastPropertyPersistenceLane,
      lastNet48PropertyEditTelemetry: this.lastNet48PropertyEditTelemetry,
      lastModernPropertyEditTelemetry: this.lastModernPropertyEditTelemetry,
      lastFullRenderTelemetry: this.lastFullRenderTelemetry,
      lastHostedDesignerProbe: this.lastHostedDesignerProbe
        ? { ...this.lastHostedDesignerProbe }
        : null,
      lastHostedServiceKernelResult: this.lastHostedServiceKernelResult
        ? { ...this.lastHostedServiceKernelResult, capabilities: [...this.lastHostedServiceKernelResult.capabilities], edits: this.lastHostedServiceKernelResult.edits.map((edit) => ({ ...edit })) }
        : null,
      renderGeneration: this.renderSeq,
      currentId: this.currentId,
      currentSelectionIds: this.currentSelectionIds.slice(),
      controls: this.controls.map((control) => ({
        id: control.id,
        parentId: control.parentId,
        ownership: control.ownership,
        editable: control.editable,
      })),
      tray: this.trayComponents.map((component) => ({
        id: component.id,
        name: component.name,
        type: component.type,
        isStrip: component.isStrip,
      })),
      selectedPropertyComponent: selectedPropertyComponent ? {
        id: selectedPropertyComponent.id,
        name: selectedPropertyComponent.name,
        type: selectedPropertyComponent.type,
        properties: selectedPropertyComponent.properties.map((property) => ({
          name: property.name,
          value: property.value,
        })),
      } : null,
    };
  }

  private dispose(): void {
    this.disposed = true;
    this.cancelAutoToolboxDiscovery(true);
    if (this.doc.session === this) this.doc.session = undefined; // drop the back-reference on close
    this.chooseItemsPanel?.dispose();
    DesignerHub.instance.unregisterSession(this);
    DesignerHub.instance.clearIfActive(this);
    if (this.debounce) clearTimeout(this.debounce);
    if (this.codeBehindDebounce) clearTimeout(this.codeBehindDebounce);
    if (this.interpretedReconcileTimer) clearTimeout(this.interpretedReconcileTimer);
    // Hand back the interpreted graph this form left in the engine. Its off-screen Form, HWND tree, sited components
    // and any vendor timers live until something drops them, and the output-release below is deliberately suppressed
    // while a sibling designer from the same project stays open — so without this, closing forms one after another in
    // a long session accumulates whole realized control trees in the render domain.
    if (this.engineKind === 'net48' && this.designerFile && this.asm() && DesignerHub.instance.isNet48EngineRunning) {
      const file = this.designerFile;
      const asm = this.asm()!;
      void this.ensureEngine('net48')
        .then((eng) => discardCompiledLive(eng, file, asm))
        .catch(() => { /* best effort — an engine that is gone has already released everything */ });
    }
    for (const d of this.disposables.splice(0)) {
      try { d.dispose(); } catch { /* ignore */ }
    }
    // 1.0.0 — hand the user's build output back. The net48 preview loads their dlls IN PLACE and PINS them
    // (ShadowCopyFiles must stay off or delay-signed vendor assemblies fail to load), so while this session lived
    // the user's own `dotnet build` failed with MSB3027 "The file is locked by: WinFormsDesigner.Engine.Net48".
    // Nothing ever released them implicitly — closing the form is the moment we can.
  //
    // Refcounted by the hub, and deliberately AFTER unregisterSession above so this session no longer counts:
    // another designer may still render from the same bin dir, and releasing under it would force it into a full
    // domain reload. The release itself is fire-and-forget (dispose is sync, the release is an async RPC) and its
    // errors are caught in the hub — a failed release must never throw out of dispose.
    if (this.engineKind === 'net48') {
      const asm = this.asm();
      if (asm) DesignerHub.instance.releaseNet48OutputIfUnused(asm);
    }
  }

  /** Mark the current canvas stale as soon as its engine dies, then perform one bounded automatic re-render.
   * fullRender's generation check absorbs races with the rejected in-flight RPC and any newer user render. */
  handleEngineCrash(kind: EngineKind, delayMs: number | null): void {
    if (this.disposed || this.engineKind !== kind) return;
    this.renderOk = false; // a render failed → read-only until the next successful render (S5)
    this.selectionGen++; // reject in-flight describes from the lost process before stale metadata can be published
    this.publishedPropertyComponent = undefined;
    if (delayMs == null) {
      this.postRenderFailure(t('host.engineCrashLoop'), this.currentId || 'this', t('host.engineCrashLoop'));
      return;
    }
    this.post({ type: 'loading', message: t('host.loading.restarting', { ms: delayMs }) });
    setTimeout(() => {
      if (!this.disposed && this.engineKind === kind) {
        void this.fullRender().catch((error) => {
          // fullRender normally reports and returns false. Keep an outer lifecycle guard because an auxiliary RPC can
          // reject after worker loss; never leak that as VS Code's "rejected promise not handled" notification.
          if (!this.disposed) this.output.appendLine(`[designer] recovery render rejected: ${errMsg(error)}`);
        });
      }
    }, delayMs);
  }

  beginBuildTask(name: string): void {
    if (this.disposed || this.engineKind !== 'net48') return;
    ++this.renderSeq; // supersede any in-flight render before its result can recreate/pin the released AppDomain
    this.renderOk = false;
    this.postRenderFailure(
      t('host.buildTask.running', { name }),
      this.currentId || 'this',
      t('host.buildTask.cause'),
    );
  }

  async finishBuildTask(): Promise<void> {
    if (this.disposed || this.engineKind !== 'net48') return;
    await this.fullRender();
  }

  private asm(): string | undefined {
    // Explicit control source wins; otherwise the framework assembly the last render auto-resolved (net48/
    // DevExpress). A net9 form leaves autoAsm undefined → this returns undefined → engine-side auto-discovery.
    return (this.designerFile ? this.getAssemblyOverride(this.designerFile) : undefined) ?? this.autoAsm;
  }

  /** The .Designer.cs this session renders (the key the control-source override is stored under). */
  get designerFilePath(): string | null { return this.designerFile; }

  /** True when this form is rendered by the net48 engine — the picture may be a real compiled instance of the last build
   * rather than an interpretation of the text. NOT a read-only state: net48 forms are editable (net9 splices the
   * source, net48 mirrors supported edits onto the live instance). A failed render remains read-only; localizable
   * forms instead use interpreted resource overlays. Compiled net48 fallback is disclosed in the output channel. */
  get isCompiledPreview(): boolean { return this.engineKind === 'net48'; }

  /**
   * True when THIS form is [Localizable(true)] (its InitializeComponent uses
   * ComponentResourceManager.ApplyResources). v1.5 routes supported value/geometry/image edits through the selected
   * culture's .resx; source-only structural operations remain blocked. Computed FRESH from the current in-memory
   * buffer on every read — never cached — so the resource/source boundary is authoritative regardless of render
   * timing (no stale-false window before the first render,
   * no stale-true window after an external edit). Cheap: two regex tests, only on user-gesture paths.
   */
  private get localizable(): boolean { return isLocalizableDesigner(this.doc.designerText); }

  /** The control assembly currently in effect: explicit override, else the auto-resolved framework assembly
   * (net48/DevExpress) from the last render, else undefined (a net9 form → engine auto-discovery). */
  get controlAssembly(): string | undefined { return this.asm(); }

  get localizationCulture(): string {
    return this.designerFile ? (DesignerHub.instance.formViewState(this.designerFile).localizationCulture ?? '') : '';
  }

  private localizationCultureLabel(): string {
    const culture = this.localizationCulture;
    return culture || t('localization.default');
  }

  async selectLocalizationCulture(requestedCulture?: string): Promise<boolean> {
    if (!this.designerFile || this.disposed) return false;
    // A culture selects WHICH resource set the designer reads and writes, and only a localizable form has any:
    // its generated source applies properties through a ComponentResourceManager. On an ordinary form every
    // property lives in InitializeComponent, so a culture would silently change nothing and create no file —
    // exactly the dead end this refusal replaces with an explanation.
    if (!this.localizable) {
      if (requestedCulture !== undefined) return false;
      const form = path.basename(designerBasePath(this.designerFile));
      // Offer the conversion itself rather than an explanation: what the user wants from a culture picker on a
      // plain form is for the form to become localizable. Declining leaves the file untouched.
      const add = t('localization.addAction');
      const choice = await vscode.window.showWarningMessage(
        t('localization.notLocalizable', { form }), { modal: false }, add);
      if (choice !== add) return false;
      if (!await this.makeFormLocalizable()) return false;
      // Converted: fall through into the picker the user originally asked for.
    }
    let requested: string;
    if (requestedCulture !== undefined) {
      const normalizedRequest = cultureName(requestedCulture);
      const discovered = discoverLocalizationCultures(this.designerFile);
      if (normalizedRequest === undefined || !discovered.some((choice) =>
        choice.cultureName.toLowerCase() === normalizedRequest.toLowerCase())) {
        this.post({ type: 'status', message: t('status.editRejected', { reason: 'localization culture is not discovered' }) });
        return false;
      }
      requested = normalizedRequest;
    } else {
      const current = this.localizationCulture;
      const picks: Array<vscode.QuickPickItem & { cultureName?: string; create?: boolean }> =
        discoverLocalizationCultures(this.designerFile).map((choice) => ({
        label: choice.neutral ? `$(globe) ${t('localization.default')}` : choice.label,
        description: choice.description,
        detail: choice.neutral ? t('localization.defaultDetail') : choice.resxPath,
        cultureName: choice.cultureName,
        picked: choice.cultureName.toLowerCase() === current.toLowerCase(),
      }));
      picks.push({
        label: `$(add) ${t('localization.create')}`,
        detail: t('localization.createDetail'),
        create: true,
      });
      const pick = await vscode.window.showQuickPick(picks, {
        title: t('localization.pickTitle'),
        placeHolder: t('localization.pickPlaceholder'),
      });
      if (!pick) return false;
      requested = pick.cultureName ?? '';
      if (pick.create) {
        const entered = await vscode.window.showInputBox({
          title: t('localization.createTitle'),
          prompt: t('localization.createPrompt'),
          placeHolder: 'fr-FR',
          validateInput: (value) => cultureName(value) === undefined ? t('localization.invalidCulture') : null,
        });
        if (entered === undefined) return false;
        requested = entered;
      }
    }
    let normalized: string;
    try {
      normalized = await setLocalizationCulture(
        await this.ensureEngine('modern'), this.designerFile, requested);
    } catch (error) {
      this.post({ type: 'status', message: t('status.editRejected', { reason: errMsg(error) }) });
      return false;
    }
    const state = DesignerHub.instance.formViewState(this.designerFile);
    DesignerHub.instance.updateFormViewState(this.designerFile, {
      canvas: state.canvas,
      panel: state.panel,
      localizationCulture: normalized,
    });
    this.lastNoticeSig = undefined;
    this.output.appendLine(`[designer] localization culture for ${this.designerFile}: ${normalized || '(Default)'}`);
    this.post({ type: 'status', message: t('status.localizationCultureSet', { culture: normalized || t('localization.default') }) });
    // Selecting a culture never writes anything by itself (neither does Visual Studio's Language property): the
    // .resx appears with the first localized edit. Say where it will be, so an empty folder is not a mystery.
    const cultureResx = localizedResxPathForDesigner(this.designerFile, normalized);
    if (normalized && !fs.existsSync(cultureResx)) {
      void vscode.window.showInformationMessage(t('localization.resxPending', {
        culture: normalized,
        file: path.basename(cultureResx),
      }));
    }
    await this.fullRender();
    this.refreshViews();
    return true;
  }

  /** Re-render after the user changed the control source (Select Control Assembly): drop the cached toolbox so
   * Project Controls re-discover against the NEW assembly, then a full render (loads the new controls). */
  async reloadControlSource(priorNet48Output?: string): Promise<void> {
    // The prior net48 output MUST be captured by the CALLER, before it mutates the control-source
    // override; capturing it here would read the NEW override that the caller already set (this.asm() returns the new
    // value), so the old output would never be released and its project would stay locked until the engine exits.
    this.toolboxItems = undefined;
    this.promptedForSource = true; // an explicit choice was made — don't nag about this form again
    await this.fullRender(); // re-routes: this.engineKind / this.asm() may now be different
    this.refreshViews();
    // Release the prior output if nothing (including this form's NEW route) still uses it — refcount-aware, so a
    // sibling designer still on that project keeps it. The scan runs AFTER fullRender, so it sees the new route.
    if (priorNet48Output && net48OutputKey(priorNet48Output) !== net48OutputKey(this.asm() ?? ''))
      DesignerHub.instance.releaseNet48OutputIfUnused(priorNet48Output);
  }

  /** The net48 output this form currently pins (its resolved control assembly), or undefined off the net48 route.
   * Callers capture this BEFORE changing the control source, then pass it to reloadControlSource. */
  get pinnedNet48Output(): string | undefined {
    return this.engineKind === 'net48' ? this.asm() : undefined;
  }

  /** Post to THIS editor's canvas webview (render/layout/patch/select/manip/status/dirty/error/loading). */
  private post(message: unknown): void {
    if (this.disposed) return;
    try {
      // A render/describe RPC may settle after the user closes the tab. Older VS Code hosts throw synchronously when
      // the disposed webview getter is touched; newer hosts can instead reject postMessage. Closing a designer is a
      // normal lifecycle transition, so absorb both forms without leaking an unhandled Extension Host rejection.
      void this.panel.webview.postMessage(message).then(undefined, () => undefined);
    } catch {
      // The panel was disposed between the guard and the getter. No UI remains to receive this best-effort message.
    }
  }

  /** Layout goes to the canvas (hit-test/overlay + on-canvas strip-item geometry) AND the Properties view (tree
   * selector). The Properties tree has no strip geometry to draw, so only the canvas gets `toolStripItems`. */
  private postLayout(controls: LayoutControl[], toolStripItems: ToolStripItemBounds[] = []): void {
    this.post({ type: 'layout', controls, toolStripItems });
    DesignerHub.instance.pushPanel(this, { type: 'layout', controls });
  }
  /** Selection goes to the canvas (overlay) AND the Properties view (tree highlight). `token` is echoed to the canvas
   * ONLY when this select is the reply to a canvas-origin `pick` (see pick): it lets the canvas correlate the echo to
   * the exact pick it issued, so it can suppress just that one echo when an add-editor dropped its selection. All the
   * host-authoritative pushSelect callers (fullRender/refreshProperties/duplicate/partial) omit it → the canvas always
   * applies those. The Properties view never needs it. */
  private pushSelect(id: string, token?: number): void {
    const ids = id === this.currentId ? this.currentSelectionIds.slice() : [id];
    this.post({ type: 'select', id, ids, token });
    DesignerHub.instance.pushPanel(this, { type: 'select', id });
  }

  private automaticToolboxItems(): ToolboxItemInfo[] {
    const out: ToolboxItemInfo[] = [];
    const seen = new Set<string>();
    for (const item of [...(this.autoToolboxItems ?? []), ...(this.toolboxItems ?? [])]) {
      if (!item.fqn || seen.has(item.fqn)) continue;
      seen.add(item.fqn);
      out.push(item);
    }
    return out;
  }

  /** All items known to this session, including hidden entries (needed by Choose Items and Add/Reference lookup).
   * A user-chosen copy wins over an automatic copy so its custom-tab category remains authoritative. */
  private availableToolboxItems(): ToolboxItemInfo[] {
    const chosen = DesignerHub.instance.chosenItems;
    const chosenFqns = new Set(chosen.map((item) => item.fqn));
    return [...this.automaticToolboxItems().filter((item) => !chosenFqns.has(item.fqn)), ...chosen];
  }

  private visibleToolboxItems(): ToolboxItemInfo[] {
    const hub = DesignerHub.instance;
    return this.availableToolboxItems().filter((item) => !hub.isHidden(item.fqn));
  }

  private pushToolboxItems(direct = false): void {
    const message = { type: 'toolbox', items: this.visibleToolboxItems() };
    if (direct) DesignerHub.instance.toPanel(message);
    else DesignerHub.instance.pushPanel(this, message);
  }

  private autoToolboxEnabled(): boolean {
    return vscode.workspace.getConfiguration('winformsDesigner', this.documentUri)
      .get<boolean>('toolbox.autoDiscoverProjectControls', true);
  }

  private cancelAutoToolboxDiscovery(disposeWatchers = false): void {
    this.autoToolboxDiscoveryGeneration++;
    if (this.autoToolboxDiscoveryTimer) clearTimeout(this.autoToolboxDiscoveryTimer);
    this.autoToolboxDiscoveryTimer = undefined;
    for (const timer of this.autoToolboxRefreshTimers.values()) clearTimeout(timer);
    this.autoToolboxRefreshTimers.clear();
    if (disposeWatchers) {
      for (const watcher of this.autoToolboxWatchers.values()) watcher.dispose();
      this.autoToolboxWatchers.clear();
    }
  }

  private scheduleAutoToolboxDiscovery(delayMs = 400): void {
    if (this.disposed || !this.designerFile) return;
    if (!this.autoToolboxEnabled()) {
      this.cancelAutoToolboxDiscovery(true);
      if (this.autoToolboxItems.length) {
        this.autoToolboxItems = [];
        this.pushToolboxItems();
      }
      return;
    }
    if (!vscode.window.state.focused) return;
    if (this.autoToolboxDiscoveryTimer) clearTimeout(this.autoToolboxDiscoveryTimer);
    const generation = ++this.autoToolboxDiscoveryGeneration;
    this.autoToolboxDiscoveryTimer = setTimeout(() => {
      this.autoToolboxDiscoveryTimer = undefined;
      void this.runAutoToolboxDiscovery(generation);
    }, Math.max(0, delayMs));
  }

  /** Stop background toolbox discovery when the user starts typing, then retry after the interaction settles. */
  public noteToolboxInteraction(): void {
    this.cancelAutoToolboxDiscovery();
    this.scheduleAutoToolboxDiscovery(1200);
  }

  private async workspaceBuildOutputRoots(generation: number): Promise<{
    roots: string[];
    projectBudgetReached: boolean;
    projectScanSkipped: number;
    missingBuildOutputs: number;
    cancelled: boolean;
  }> {
    const folder = vscode.workspace.getWorkspaceFolder(this.documentUri);
    if (!folder || !this.designerFile || generation !== this.autoToolboxDiscoveryGeneration) {
      return { roots: [], projectBudgetReached: false, projectScanSkipped: 0, missingBuildOutputs: 0, cancelled: false };
    }
    const owningProject = findOwningCsproj(path.dirname(this.designerFile), folder.uri.fsPath);
    if (!owningProject) {
      return { roots: [], projectBudgetReached: false, projectScanSkipped: 1, missingBuildOutputs: 0, cancelled: false };
    }
    const result = await discoverProjectBuildOutputRoots(owningProject, {
      maxProjects: 64,
      yieldEveryProjects: 8,
      shouldCancel: () => this.disposed || generation !== this.autoToolboxDiscoveryGeneration
        || !vscode.window.state.focused,
    });
    return {
      roots: result.roots,
      projectBudgetReached: result.projectBudgetReached,
      projectScanSkipped: result.skippedProjects + result.skippedReferences + result.missingBuildOutputs,
      missingBuildOutputs: result.missingBuildOutputs,
      cancelled: result.cancelled,
    };
  }

  private toolboxItemFromCandidate(candidate: ToolboxCandidate, assemblyPath: string): ToolboxItemInfo | null {
    const name = typeof candidate.name === 'string' ? candidate.name.trim() : '';
    const ns = typeof candidate.namespace === 'string' ? candidate.namespace.trim() : '';
    if (!name || name.length > 512 || ns.length > 1024) return null;
    const fqn = ns ? `${ns}.${name}` : name;
    return {
      name,
      fqn,
      category: 'Project Controls',
      fromProject: true,
      assemblyPath,
    };
  }

  private autoDiscoverySkippedCount(skipped: object): number {
    let total = 0;
    for (const value of Object.values(skipped)) if (typeof value === 'number' && Number.isFinite(value)) total += value;
    return total;
  }

  /**
   * Report one auto-discovery pass, suppressing a verbatim repeat of the previous one. Discovery re-runs after
   * every edit and every window focus, and on a settled workspace each pass reaches the same conclusion — logging
   * it each time buries the entries that did change.
   */
  private logAutoDiscovery(...lines: string[]): void {
    const signature = lines.join('\n');
    if (signature === this.lastAutoDiscoveryLog) return;
    this.lastAutoDiscoveryLog = signature;
    for (const line of lines) this.output.appendLine(line);
  }

  private async runAutoToolboxDiscovery(generation: number): Promise<void> {
    if (this.disposed || !this.designerFile || !this.autoToolboxEnabled()
      || !vscode.window.state.focused || generation !== this.autoToolboxDiscoveryGeneration) return;

    let rootsInfo: {
      roots: string[]; projectBudgetReached: boolean; projectScanSkipped: number;
      missingBuildOutputs: number; cancelled: boolean;
    };
    try { rootsInfo = await this.workspaceBuildOutputRoots(generation); }
    catch (error) {
      this.logAutoDiscovery(`[toolbox auto-discovery] project enumeration failed: ${errMsg(error)}`);
      return;
    }
    if (rootsInfo.cancelled || generation !== this.autoToolboxDiscoveryGeneration) return;
    if (!rootsInfo.roots.length) {
      // An unbuilt project is the ordinary reason, and it is actionable — say so instead of only counting it.
      const cause = rootsInfo.missingBuildOutputs
        ? `; ${rootsInfo.missingBuildOutputs} project(s) have no build output yet — build them to populate Project Controls`
        : '';
      this.logAutoDiscovery(`[toolbox auto-discovery] no related build-output roots; skipped=${rootsInfo.projectScanSkipped}${cause}`);
      return;
    }

    const discovery = await discoverBuildOutputAssemblies(rootsInfo.roots, {
      maxFiles: 96,
      maxDirectories: 128,
      maxDepth: 3,
      maxMilliseconds: 500,
      yieldEveryDirectories: 8,
      shouldCancel: () => this.disposed || generation !== this.autoToolboxDiscoveryGeneration
        || !vscode.window.state.focused,
    });
    if (discovery.cancelled || generation !== this.autoToolboxDiscoveryGeneration) return;

    const reflectionStarted = Date.now();
    const reflectionLimit = 24;
    const refreshedFiles = new Set<string>();
    const newItems: ToolboxItemInfo[] = [];
    let reflected = 0;
    let reflectionSkipped = 0;
    let reflectionErrors = 0;
    for (const candidate of discovery.assemblies) {
      if (generation !== this.autoToolboxDiscoveryGeneration || !vscode.window.state.focused) return;
      if (reflected >= reflectionLimit || Date.now() - reflectionStarted >= 5000) {
        reflectionSkipped++;
        continue;
      }
      reflected++;
      try {
        const result = await this.withTimeout(
          this.scanCandidateAssembly(candidate.path),
          1600,
          `toolbox metadata scan timed out: ${path.basename(candidate.path)}`,
        );
        if (generation !== this.autoToolboxDiscoveryGeneration) return;
        if (result.error && !result.items.length) {
          reflectionErrors++;
          continue;
        }
        refreshedFiles.add(normalize(candidate.path));
        for (const item of result.items) {
          const mapped = this.toolboxItemFromCandidate(item, candidate.path);
          if (mapped) newItems.push(mapped);
        }
      } catch {
        reflectionErrors++;
      }
    }

    // Replace results only for assemblies successfully revisited; a time/file budget or transient load failure must
    // not erase still-valid controls from a prior scan. Duplicate FQNs are collapsed by automaticToolboxItems().
    const retained = this.autoToolboxItems.filter((item) => {
      const source = item.assemblyPath;
      return !source || !refreshedFiles.has(normalize(source));
    });
    this.autoToolboxItems = [...retained, ...newItems];
    this.syncAutoToolboxWatchers(this.autoToolboxItems
      .map((item) => item.assemblyPath ? path.dirname(item.assemblyPath) : '')
      .filter(Boolean));
    this.pushToolboxItems();

    const skipped = this.autoDiscoverySkippedCount(discovery.skipped)
      + reflectionSkipped + reflectionErrors + rootsInfo.projectScanSkipped + (rootsInfo.projectBudgetReached ? 1 : 0);
    const truncated = discovery.truncated || reflectionSkipped > 0 || rootsInfo.projectBudgetReached;
    this.logAutoDiscovery(
      `[toolbox auto-discovery] roots=${rootsInfo.roots.length}; directories=${discovery.scannedDirectories.length}; `
      + `assemblies=${discovery.assemblies.length}; reflected=${reflected}; controls=${this.autoToolboxItems.length}; `
      + `skipped=${skipped}; truncated=${truncated}; cancelled=false`,
      `[toolbox auto-discovery] scanned directories: ${discovery.scannedDirectories.join('; ') || '<none>'}`,
      ...(skipped ? [
        `[toolbox auto-discovery] skipped detail: ${JSON.stringify({ ...discovery.skipped, reflectionSkipped, reflectionErrors, projectScanSkipped: rootsInfo.projectScanSkipped, projectBudgetReached: rootsInfo.projectBudgetReached })}`,
      ] : []),
    );
    this.post({
      type: 'status',
      message: t('status.toolboxDiscovery', {
        controls: this.autoToolboxItems.length,
        directories: discovery.scannedDirectories.length,
        skipped,
        limit: truncated ? t('status.toolboxDiscoveryBudget') : '',
      }),
    });
  }

  private syncAutoToolboxWatchers(directories: string[]): void {
    const desired = new Map<string, string>();
    for (const directory of directories) {
      const key = normalize(directory);
      if (!key || desired.has(key) || desired.size >= 32 || !fs.existsSync(directory)) continue;
      desired.set(key, directory);
    }
    for (const [key, watcher] of [...this.autoToolboxWatchers]) {
      if (desired.has(key)) continue;
      watcher.dispose();
      this.autoToolboxWatchers.delete(key);
    }
    for (const [key, directory] of desired) {
      if (this.autoToolboxWatchers.has(key)) continue;
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(directory, '*.dll'));
      const enqueue = (uri: vscode.Uri) => this.scheduleAutoToolboxAssemblyRefresh(uri.fsPath);
      const composite = vscode.Disposable.from(
        watcher,
        watcher.onDidCreate(enqueue),
        watcher.onDidChange(enqueue),
        watcher.onDidDelete(enqueue),
      );
      this.autoToolboxWatchers.set(key, composite);
    }
  }

  private scheduleAutoToolboxAssemblyRefresh(file: string): void {
    if (this.disposed || !this.autoToolboxEnabled() || !vscode.window.state.focused || !/\.dll$/i.test(file)) return;
    const key = normalize(file);
    const prior = this.autoToolboxRefreshTimers.get(key);
    if (prior) clearTimeout(prior);
    const timer = setTimeout(() => {
      this.autoToolboxRefreshTimers.delete(key);
      const generation = ++this.autoToolboxDiscoveryGeneration; // cancel a concurrent full traversal
      if (this.autoToolboxDiscoveryTimer) clearTimeout(this.autoToolboxDiscoveryTimer);
      this.autoToolboxDiscoveryTimer = undefined;
      void this.refreshAutoToolboxAssembly(file, generation);
    }, 250);
    this.autoToolboxRefreshTimers.set(key, timer);
  }

  private async refreshAutoToolboxAssembly(file: string, generation: number): Promise<void> {
    const key = normalize(file);
    if (this.disposed || !this.autoToolboxEnabled() || !vscode.window.state.focused
      || generation !== this.autoToolboxDiscoveryGeneration) return;
    if (!fs.existsSync(file)) {
      this.autoToolboxItems = this.autoToolboxItems.filter((item) => !item.assemblyPath || normalize(item.assemblyPath) !== key);
      this.syncAutoToolboxWatchers(this.autoToolboxItems
        .map((item) => item.assemblyPath ? path.dirname(item.assemblyPath) : '').filter(Boolean));
      this.pushToolboxItems();
      this.output.appendLine(`[toolbox auto-discovery] removed deleted assembly: ${file}`);
      return;
    }
    try {
      const result = await this.withTimeout(this.scanCandidateAssembly(file), 2000,
        `toolbox metadata refresh timed out: ${path.basename(file)}`);
      if (this.disposed || generation !== this.autoToolboxDiscoveryGeneration) return;
      if (result.error && !result.items.length) {
        this.output.appendLine(`[toolbox auto-discovery] refresh kept prior items for ${file}: ${result.error}`);
        return;
      }
      const replacements = result.items
        .map((item) => this.toolboxItemFromCandidate(item, file))
        .filter((item): item is ToolboxItemInfo => item !== null);
      this.autoToolboxItems = [
        ...this.autoToolboxItems.filter((item) => !item.assemblyPath || normalize(item.assemblyPath) !== key),
        ...replacements,
      ];
      this.syncAutoToolboxWatchers(this.autoToolboxItems
        .map((item) => item.assemblyPath ? path.dirname(item.assemblyPath) : '').filter(Boolean));
      this.pushToolboxItems();
      this.output.appendLine(`[toolbox auto-discovery] incrementally refreshed ${path.basename(file)}: ${replacements.length} controls`);
    } catch (error) {
      this.output.appendLine(`[toolbox auto-discovery] refresh kept prior items for ${file}: ${errMsg(error)}`);
    }
  }

  /** Populate `toolboxItems` once. net9: framework + project controls in one enumeration. net48: framework controls
   * from the net9 enumerator (same FQNs → droppable on a net48 form) MERGED with the project/vendor (DevExpress)
   * controls from the net48 engine — the ones the net9 ALC can't load (DevExpress-add). Best-effort: a framework
   * failure leaves it undefined (retry later); a project-enumeration failure degrades to framework-only. */
  private async loadToolboxItems(): Promise<void> {
    if (this.toolboxItems || !this.designerFile) return;
    // Capture the kind: the pre-render refreshViews (ctor setActive) runs while engineKind is still the default
    // 'modern', but the first fullRender flips it to 'net48' for a compiled form. A load started under one kind must
    // NOT assign after the kind flipped — else a stale framework-only net9 result would poison the net48 cache and
    // the project/vendor controls would never appear (fullRender also clears the cache on the transition).
    const kind = this.engineKind;
    if (kind === 'net48') {
      let framework: ToolboxItemInfo[];
      try { framework = await listToolboxItems(await this.ensureEngine('modern'), this.designerFile, undefined); }
      catch { return; } // leave undefined so a later refresh retries
      let project: ToolboxItemInfo[] = [];
      const asm = this.asm();
      if (asm) {
        try { project = await listCompiledToolboxControls(await this.ensureEngine('net48'), asm); } catch { /* project best-effort */ }
      }
      if (this.disposed || this.engineKind !== kind || this.toolboxItems) return; // kind flipped / already loaded under us
      this.toolboxItems = filterToolboxByRuntime([...framework, ...project], kind, this.toolboxRuntimeFilter());
    } else {
      let items: ToolboxItemInfo[];
      try { items = await listToolboxItems(await this.ensureEngine('modern'), this.designerFile, this.asm()); } catch { return; }
      if (this.disposed || this.engineKind !== kind || this.toolboxItems) return;
      this.toolboxItems = filterToolboxByRuntime(items, kind, this.toolboxRuntimeFilter());
    }
  }

  /** `winformsDesigner.toolbox.runtimeFilter` — which runtime's controls the palette offers. Read per load so a
   * settings change takes effect on the next palette refresh rather than needing a window reload. */
  private toolboxRuntimeFilter(): ToolboxRuntimeFilter {
    const raw = vscode.workspace.getConfiguration('winformsDesigner').get<string>('toolbox.runtimeFilter', 'auto');
    return raw === 'all' || raw === 'modern' || raw === 'net48' ? raw : 'auto';
  }

  // ----- view refresh (when this session becomes the focused one, or a view (re)opens) -----
  async refreshToolbox(): Promise<void> {
    if (this.disposed || !this.designerFile) return;
    await this.loadToolboxItems();
    this.pushToolboxItems();
    this.scheduleAutoToolboxDiscovery();
    await this.refreshPalette();
  }

  /** Fetch the color/font palette once (engine-wide static, cached on the hub) and push it to the panel so
   * the Color dropdown + Font editor have their swatches / font families / unit suffixes. Best-effort:
   * a fetch failure just leaves those editors on their text-input fallback. */
  private async refreshPalette(): Promise<void> {
    if (this.disposed || !this.designerFile) return;
    const hub = DesignerHub.instance;
    if (!hub.hasPalette) {
      try { const eng = await this.ensureEngine(); await hub.ensurePalette(() => getDesignerPalette(eng)); } catch { /* palette optional */ }
    }
    hub.pushPaletteTo(this);
  }
  refreshProperties(): void {
    if (this.controls.length) {
      DesignerHub.instance.pushPanel(this, { type: 'layout', controls: this.controls });
      DesignerHub.instance.pushPanel(this, { type: 'select', id: this.currentId });
      void this.loadProps(this.currentId).catch((error) => {
        if (!this.disposed) this.output.appendLine(`[designer] background property refresh failed: ${errMsg(error)}`);
      });
    } else {
      DesignerHub.instance.pushPanel(this, { type: 'clear' }); // not rendered yet → blank until fullRender
    }
  }
  private pushPersistedViewState(): void {
    if (!this.designerFile) return;
    const state = DesignerHub.instance.formViewState(this.designerFile);
    this.post({ type: 'canvasViewState', state: state.canvas ?? {} });
    DesignerHub.instance.pushPanel(this, {
      type: 'panelViewState',
      state: state.panel ?? {},
      toolboxUi: DesignerHub.instance.toolboxUi,
    });
  }

  updateCanvasViewState(value: unknown): void {
    if (!this.designerFile || this.disposed) return;
    const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
    const current = DesignerHub.instance.formViewState(this.designerFile);
    const fromWebview = sanitizeDesignerViewState({ canvas: raw }).canvas;
    DesignerHub.instance.updateFormViewState(this.designerFile, {
      // The webview owns zoom/locks only; its debounced payload must not erase host-owned tab selection.
      canvas: { ...(fromWebview ?? {}), selectedTabs: current.canvas?.selectedTabs },
      panel: current.panel,
      localizationCulture: current.localizationCulture,
    });
  }

  updatePanelViewState(value: unknown, toolboxUi: unknown): void {
    if (!this.designerFile || this.disposed) return;
    const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
    const current = DesignerHub.instance.formViewState(this.designerFile);
    DesignerHub.instance.updateFormViewState(this.designerFile, {
      canvas: current.canvas,
      panel: sanitizeDesignerViewState({ panel: raw }).panel,
    });
    DesignerHub.instance.setToolboxUi(toolboxUi);
  }

  refreshViews(): void {
    this.refreshPlacementSettings();
    this.pushPersistedViewState();
    void this.refreshToolbox().catch((error) => {
      if (!this.disposed) this.output.appendLine(`[designer] background toolbox refresh failed: ${errMsg(error)}`);
    });
    this.refreshProperties();
    this.pushClipboardState();
  }

  public refreshPlacementSettings(): void {
    if (!this.disposed) this.post({
      type: 'placementSettings',
      snapOverrideModifier: placementSnapOverrideModifier(this.documentUri),
      layoutMode: placementLayoutMode(this.documentUri),
      gridSize: placementGridSize(this.documentUri),
      showGrid: placementShowGrid(this.documentUri),
    });
  }

  /** Re-emit this canvas's HTML with the current locale's injected catalog (live language switch). Reloading the
   * webview makes it re-send `ready`, which triggers a full re-render / rehydrate through the normal path. */
  rebuildHtml(): void {
    if (this.disposed) return;
    this.gotReady = false;
    this.panel.webview.html = this.designerFile
      ? designerHtml(this.panel.webview, this.extensionUri)
      : placeholderHtml(this.panel.webview, this.documentUri.fsPath);
  }

  /** Debounced reaction to a file-system change of the .Designer.cs (coalesces change+create events). */
  private scheduleRerender(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = undefined;
      if (this.disposed) return;
      void this.reloadFromDiskIfClean();
    }, 120);
  }

  /**
   * An external write to the .Designer.cs reached disk. If we have NO unsaved designer edits, adopt the disk
   * text and re-render; if the user has unsaved edits, keep them and just note the conflict. Our own save
   * lands here too, but disk == in-memory then, so it's a no-op.
   */
  private async reloadFromDiskIfClean(): Promise<void> {
    if (this.disposed || !this.designerFile) return;
    // Serialize overlapping watcher deliveries: two debounced reloads can be in flight, and an OLDER read resuming
    // after a newer one already adopted would re-adopt superseded text and re-render it. Newest wins.
    const epoch = ++this.reloadEpoch;
    let onDisk: { text: string; hadBom: boolean };
    try {
      onDisk = await readDesignerBytesUri(vscode.Uri.file(this.designerFile));
    } catch {
      // The file was DELETED, locked, or the provider failed — after we had a baseline. Swallowing this left the old
      // canvas on screen, still editable, against a source that no longer exists: the .resx paths would even
      // keep writing. Latch the same read-only state an unreadable file gets at open; a later successful read clears
      // it. renderOk is dropped too so commit()'s backstop refuses regardless of which gate a caller passed.
      if (epoch !== this.reloadEpoch || this.disposed) return;
      this.doc.markBaselineUnknown();
      this.renderOk = false;
      this.post({ type: 'status', message: t('status.designerDiskConflict') });
      return;
    }
    if (epoch !== this.reloadEpoch || this.disposed) return; // a newer reload superseded this read
    // A journaled source+resource transaction writes the generated source before it can register the native custom
    // document edit. Older VS Code hosts can deliver that watcher read inside the narrow gap. The transaction runner
    // owns this exact byte image and verifies it again before reporting success, so it is neither an external change
    // nor a new document revision. After the runner leaves this scope, an identical watcher delivery is a no-op because
    // applyPreflightedCommit has already adopted the same source baseline and in-memory text.
    if (this.pendingSourceTransactionImages.some((image) =>
      image.text === onDisk.text && image.bom === onDisk.hadBom)) return;
    // Decide what actually changed BEFORE touching the document: adopting first would make the text comparison
    // trivially true and skip the re-render, leaving the canvas showing the OLD source while the buffer holds the
    // new one — an edit would then be spliced into text the user never saw.
    const textChanged = onDisk.text !== this.doc.designerText;
    if (this.doc.isDirty) {
      if (textChanged) this.post({ type: 'status', message: t('status.diskChanged') });
    return; // keep the user's unsaved edits; save()'s guard catches the conflict
    }
    // Clean buffer. This read SUCCEEDED, so a baseline is knowable again — adopt it even when only the BOM moved, or
    // when nothing moved but our baseline was untrustworthy: otherwise a document whose opening read failed stays
    // permanently unsavable (only a manual Revert would clear it), and a clean BOM-only external change would cause
    // a later save refusal the user can't explain.
    const bomChanged = onDisk.hadBom !== this.doc.bom;
    if (!textChanged && !bomChanged && !this.doc.baselineUnknown) return; // our own save, or a genuine no-op
    // Adopting new source makes the canvas stale the instant it lands, but fullRender only re-asserts renderOk at its
    // END — so without dropping it here the old visual model stays actionable for the whole render, and a click/drag
    // aimed at it would splice into the freshly adopted text. Lock first, adopt, then render.
    if (textChanged) this.renderOk = false;
    this.doc.adoptDiskBaseline(onDisk.text, onDisk.hadBom);
  if (textChanged) await this.fullRender(); // the canvas must never keep showing superseded source
  }

  /**
   * Commit a new full .Designer.cs text as ONE undoable custom-document edit. The visible form (Foo.cs) tab
   * becomes dirty (not the generated file), and Ctrl+Z/Y restore the previous/next text through these
   * closures. Callers live-update the canvas (patch or full render) AFTER this; undo/redo do a full render.
   */
  // Returns TRUE when the edit was applied (or was a no-op) and the caller may run its success follow-up; FALSE when a
  // fail-closed gate (byte-local / render-failed / localizable source edit) REFUSED it — the caller must then skip its success
  // status + live-preview mutation so a refused edit never shows as applied was void, callers diverged).
  //
  // 0.11.0 write-safety — an optional `resx` transaction ties a sibling-.resx disk write to THIS undoable edit: the
  // caller writes the new .resx to disk atomically BEFORE calling commit(); we then thread the resx before/after into
  // the undo/redo closures so Ctrl+Z reverts the resource too (deleting a resx this edit created, or restoring its
  // prior bytes) and Ctrl+Y re-applies it. If a fail-closed gate REFUSES here, no edit is fired — the caller then
  // rolls the resx back (revertResx) so neither half lands. The gates run before anything is mutated, so a refusal
  // never leaves a half-applied transaction.
  private commit(
    before: string,
    after: string,
    label: string,
    resx?: ResourceTxSet,
    expectedRevision?: number,
    durableUndo?: TransactionUndoRegistration,
    localizableSourceCapability?: 'event',
    companionText?: CompanionTextTx,
  ): boolean {
    const resxList = Array.isArray(resx) ? resx : resx ? [resx] : [];
    const companionChanged = !!companionText && companionText.before !== companionText.after;
    if (!this.preflightCommit(
      before, after, label, resxList, expectedRevision, localizableSourceCapability, companionChanged,
    )) return false;
    return this.applyPreflightedCommit(
      before, after, label, resxList, expectedRevision, durableUndo, localizableSourceCapability, companionText);
  }

  private commitPreconditionMatches(before: string, expectedRevision: number | undefined, label: string): boolean {
    if (this.doc.designerText === before
      && (expectedRevision === undefined || this.doc.rev === expectedRevision)) return true;
    this.output.appendLine(`[designer] edit refused — document changed while ${label} was awaiting I/O`);
    this.post({ type: 'status', message: t('status.docChanged') });
    return false;
  }

  private preflightCommit(
    before: string,
    after: string,
    label: string,
    resxList: ResxTx[],
    expectedRevision?: number,
    localizableSourceCapability?: 'event',
    companionChanged = false,
  ): boolean {
    if (this.emptyInitializeComponentSurface) {
      this.output.appendLine('[designer] edit refused — empty InitializeComponent compatibility surface is read-only (' + label + ')');
      this.post({ type: 'status', message: t('designer.owner.emptyInitializeComponentReadOnly') });
      return false;
    }
    // No-op edit → nothing to persist. But if a resx transaction is attached whose bytes actually CHANGED (a
    // re-import of a new image into a property whose `resources.GetObject("key")` assignment is byte-identical —
    // designer text unchanged, base64 payload different), we must still fire an undo entry so Ctrl+Z reverts the
    // resource. Fall through in that case.
    const resxChanged = resxList.some((tx) => tx.before !== tx.after);
    if (after === before && !resxChanged && !companionChanged) return true;
    // W0.1/W0.2 — every async mutation must still own the exact document snapshot it started from at the FINAL
    // commit boundary. Text catches an ordinary intervening drag/property edit; revision also catches edit→undo back
    // to byte-identical text. Without both, a stale resource operation could write its old snapshot over newer work.
    if (!this.commitPreconditionMatches(before, expectedRevision, label)) return false;
    // 0.10.0 trust-floor S4 — byte-local firewall. Every persisted edit is a targeted net9 splice of `before`, which
    // preserves the file outside the edited span by construction (net48 never writes source — it persists the SAME
    // net9 splice). If `after` is NOT a confined edit of `before`, a non-splice path reached this funnel (a future
    // refactor, a whole-file regenerate/reflow/EOL-normalize, or a recovered arbitrary buffer). Refuse it fail-closed:
    // don't mutate designerText, don't fire an undo entry. COARSE by design (the tight per-statement confinement is
    // already the engine's minimal/OnlyTargetChanged gate); this is the broad whole-file-catastrophe net.
    if (!isByteLocalEdit(before, after)) {
      this.output.appendLine('[designer] edit refused — byte-local invariant violated (' + label + ')');
      this.post({ type: 'status', message: t('status.byteLocalRefused') });
      return false;
    }
    // 0.10.0 trust-floor S5 — refuse to persist while the last render FAILED (stale/absent graph). Airtight backstop
    // for any mutating edit that slipped past the refuseStaleRenderEdit dispatch gate (a non-gated ingress, or a
    // render that failed AFTER the edit dispatched). undo/redo set designerText directly (below), NOT via commit(),
    // so reverting still works; a later successful render flips renderOk true and re-enables editing.
    if (!this.renderOk) {
      this.output.appendLine('[designer] edit refused — last render failed / not fully rendered (' + label + ')');
      this.post({ type: 'status', message: t('status.renderFailedReadonly') });
      return false;
    }
    // No trustworthy on-disk baseline (the opening read failed for something other than "not there"). A recovered
    // hot-exit backup still renders, so renderOk above says nothing about it — without this the buffer would be
    // freely editable against a file we have never successfully read, and the save-time guard would only object at
    // the very end. Refuse here so the read-only state is real, not just a save-time surprise.
    if (this.doc.baselineUnknown) {
      this.output.appendLine('[designer] edit refused — no trustworthy on-disk baseline (' + label + ')');
      this.post({ type: 'status', message: t('status.designerDiskConflict') });
      return false;
    }
    // Airtight localizable-source backstop. A resource-only edit has identical before/after designer text. The one
    // structural exception is a journaled source+resource edit whose exact source target and at least one distinct
    // .resx target are both in the transaction (currently toolbox add). Anything else can diverge from ApplyResources.
    // Classified FRESH from the buffer (the getter), so it is correct even during a render race — the
    // firewall never trusts a stale render-populated flag. (undo/redo set designerText directly, NOT via
    // commit, so reverting a pre-lock edit still works.)
    const persistedSource = this.designerFile
      ? resxList.find((tx) => normalize(tx.uri.fsPath) === normalize(this.designerFile!))
      : undefined;
    const hasDistinctResourceTarget = resxList.some((tx) =>
      !this.designerFile || normalize(tx.uri.fsPath) !== normalize(this.designerFile));
    const journaledLocalizedStructure = !!persistedSource && persistedSource.after === after && hasDistinctResourceTarget;
    const boundedLocalizedEvent = localizableSourceCapability === 'event';
    if (this.localizable && !(after === before && resxChanged)
      && !journaledLocalizedStructure && !boundedLocalizedEvent) {
      this.output.appendLine('[designer] edit refused — generated-source mutation is unsupported for a localizable form (' + label + ')');
      return false;
    }
    return true;
  }

  private applyPreflightedCommit(
    before: string,
    after: string,
    label: string,
    resxList: ResxTx[],
    expectedRevision?: number,
    durableUndo?: TransactionUndoRegistration,
    localizableSourceCapability?: 'event',
    companionText?: CompanionTextTx,
  ): boolean {
    const resxChanged = resxList.some((tx) => tx.before !== tx.after);
    const companionChanged = !!companionText && companionText.before !== companionText.after;
    if (after === before && !resxChanged && !companionChanged) return true;
    // Recheck even though ordinary commit() calls preflight synchronously. Journal-backed paths used to await a
    // generated-source flush between these two functions; retaining the second gate makes that entire class of race
    // fail closed if a future adapter introduces another await.
    if (!this.commitPreconditionMatches(before, expectedRevision, label)) return false;
    const persistedDesigner = this.designerFile
      ? resxList.find((tx) => normalize(tx.uri.fsPath) === normalize(this.designerFile!))
      : undefined;
    const beforeEventAuthorized = this.doc.isAuthorizedLocalizableEventText(before);
    const afterEventAuthorized = localizableSourceCapability === 'event' && isLocalizableDesigner(after);
    this.doc.rev++;
    this.doc.designerText = after;
    this.doc.authorizeLocalizableEventText(afterEventAuthorized ? after : null);
    if (persistedDesigner) this.doc.adoptTransactionBaseline(persistedDesigner.after, persistedDesigner.bom);
    // 1.0.0 — reflect the new dirty state in the net48 "last build" banner IMMEDIATELY, at
    // the mutation point, before the caller's awaited loadProps / render. Those can stall or reject (a nonvisual
    // Modifiers edit hydrates via loadProps, whose rejection is caught without reaching the trailing postDirty), which
    // would otherwise leave the banner showing the stale clean wording over a now-dirty source. Idempotent — the notice
    // is deduped, so the caller's later postDirty is a no-op when nothing changed.
    this.postDirty();
    let durableRegistration = durableUndo;
    this.fireEdit({
      document: this.doc,
      label,
      // Do the resx disk op FIRST (it can fail — a locked/permission-denied file): if it throws, the in-memory
      // designerText is left untouched and the undo/redo promise rejects, so the two halves never split (
      // mutating text before a fallible resx op leaves the code reverted while the resource didn't move).
      undo: async () => {
        const companionTransition = companionText
          ? await this.prepareCompanionTextHistory(companionText, 'undo')
          : undefined;
        if (durableRegistration) {
          const result = await durableRegistration.undo();
          if (result.status !== 'rolledBack') throw new Error(result.error ?? `durable undo failed: ${result.status}`);
        } else {
          await this.transitionResourceSet(resxList, 'undo');
        }
        if (persistedDesigner) this.doc.adoptTransactionBaseline(persistedDesigner.before, persistedDesigner.bom);
        this.doc.rev++; this.doc.designerText = before;
        this.doc.authorizeLocalizableEventText(beforeEventAuthorized ? before : null);
        await this.rerenderFromDoc();
        companionTransition?.();
      },
      redo: async () => {
        const companionTransition = companionText
          ? await this.prepareCompanionTextHistory(companionText, 'redo')
          : undefined;
        if (durableRegistration) {
          const result = await durableRegistration.redo();
          if (result.status !== 'committed' || !result.undoRegistration) {
            throw new Error(result.error ?? `durable redo failed: ${result.status}`);
          }
          durableRegistration = result.undoRegistration;
        } else {
          await this.transitionResourceSet(resxList, 'redo');
        }
        if (persistedDesigner) this.doc.adoptTransactionBaseline(persistedDesigner.after, persistedDesigner.bom);
        this.doc.rev++; this.doc.designerText = after;
        this.doc.authorizeLocalizableEventText(afterEventAuthorized ? after : null);
        await this.rerenderFromDoc();
        companionTransition?.();
      },
    });
    return true;
  }

  /** Re-render the canvas from the current in-memory text (used by undo/redo and revert). */
  async rerenderFromDoc(): Promise<void> {
    if (this.disposed) return;
    // 1.0.0 — undo/redo/revert have ALL reassigned designerText by the time they call this
    // (the commit undo/redo closures and revert→adoptDiskBaseline), so sync the net48 banner's clean/dirty wording NOW,
    // before the stallable net48 discard RPC and fullRender below. Otherwise an undo-to-clean or redo-to-dirty leaves
    // the previous wording until those awaits resolve — and a stuck discard/render never updates it at all.
    this.postDirty();
    // invalidate any in-flight render BEFORE the stallable net48 discard await below, so a render
    // that started before this undo/redo/revert can't complete during the wait and install the now-undone picture
    // The trailing fullRender bumps the sequence again; both leave an earlier render's captured seq stale.
    this.renderSeq++;
    // 0.11.0 net48 undo reconcile — a text-level revert (undo/redo/revert) makes the cached compiled instance STALE:
    // net48 renders the live compiled INSTANCE (not the text), and that instance still carries the reverted edit's
    // live mutation, so reusing it would keep showing the undone change. Drop it so the next render re-instantiates
    // from the compiled baseline. (net9 interprets the text directly, so it needs no such reconcile.)
    if (this.engineKind === 'net48') {
      const asm = this.asm();
      if (asm && this.designerFile) {
        try { await discardCompiledLive(await this.ensureEngine('net48'), this.designerFile, asm); }
        catch { /* best effort — a failed discard just leaves the (pre-existing) staleness, never corrupts */ }
      }
    // The discard makes the next render re-instantiate from the compiled baseline, so an undone/reverted live edit
    // no longer lingers in the preview. (There is no divergence lock to update — it was descoped; net48 shows the
    // last build and says so, editable throughout.)
    }
    await this.fullRender();
  }

  /** Called by the provider after a successful save: clear the canvas "unsaved" mark. */
  notifySaved(): void {
    if (this.disposed) return;
    this.post({ type: 'status', message: t('status.saved') });
    this.postDirty();
  }

  /**
   * Resource/source boundary for a [Localizable(true)] form. Returns true (and shows the status) when this form is
   * localizable AND `type` is a structural/source-mutating message with no safe resource representation; the caller
   * returns without dispatching. Public because BOTH webview message handlers gate through it: the
   * canvas (onMessage) and the Properties panel (WinFormsDesignerProvider.resolveWebviewView), which
   * also carries direct code-behind writes that never reach commit().
   */
  public refuseLocalizableEdit(type: string | undefined): boolean {
    if (!type || !LOCALIZABLE_SOURCE_BLOCKED.has(type) || !this.localizable) return false;
    this.post({ type: 'status', message: t('status.localizableSourceBlocked') });
    return true;
  }

  /**
   * Method-level guard for operations that still mutate generated source or code-behind on a localizable form.
   * Supported resource edits use applyLocalizedResourceEdits instead; this defense-in-depth guard covers operations
   * such as ImageList structural rewrites and createHandler that do not yet have a resource-only representation.
   */
  private refuseLocalizableMutation(): boolean {
    if (!this.localizable) return false;
    this.post({ type: 'status', message: t('status.localizableSourceBlocked') });
    return true;
  }

  /**
   * The stale-render counterpart of {@link refuseLocalizableMutation}, for a direct-file-write op that reaches
   * persistence WITHOUT going through commit()'s backstop. commit() refuses while `renderOk` is false, but
   * createHandler writes the code-behind stub via applyEdit FIRST and only then commits the wiring — so on a
   * failed-render form the refusal used to arrive after the stub had already landed, leaving an orphan handler
   * in the user's .cs. Callers that write a file themselves must gate up front.
   */
  private refuseStaleRenderMutation(): boolean {
    if (this.emptyInitializeComponentSurface) {
      this.post({ type: 'status', message: t('designer.owner.emptyInitializeComponentReadOnly') });
      return true;
    }
    if (this.renderOk) return false;
    this.post({ type: 'status', message: t('status.renderFailedReadonly') });
    return true;
  }

  /** The unknown-baseline counterpart, for the direct-file-write ops that never reach commit()'s backstop. */
  private refuseUnknownBaselineMutation(): boolean {
    if (!this.doc.baselineUnknown) return false;
    this.post({ type: 'status', message: t('status.designerDiskConflict') });
    return true;
  }

  /**
   * 0.10.0 trust-floor S5 — read-only gate while the last render FAILED (or nothing has rendered yet). A hard
   * load/render failure leaves a STALE preview on the canvas; refuse every mutating gesture so an edit can't
   * splice against a graph the designer couldn't load. Reuses LOCALIZABLE_BLOCKED (the identical mutation surface);
   * reads (pick/save/ready/list*) pass — `ready` is NOT in the set, so the FIRST render is never blocked. commit()
   * backstops persistence. A subsequent successful render flips renderOk true and re-enables editing.
   */
  public refuseStaleRenderEdit(type: string | undefined): boolean {
    if (this.emptyInitializeComponentSurface && !!type && STALE_RENDER_BLOCKED.has(type)) {
      this.post({ type: 'status', message: t('designer.owner.emptyInitializeComponentReadOnly') });
      return true;
    }
    if (!refuseWhileRenderFailed(type, STALE_RENDER_BLOCKED, this.renderOk)) return false;
    this.post({ type: 'status', message: t('status.renderFailedReadonly') });
    return true;
  }

  /** Host-authoritative counterpart of designer.js' pending-image gate. */
  private refuseStaleCanvasGeneration(type: string | undefined, generation: number | undefined): boolean {
    if (!type || !CANVAS_GENERATION_GUARDED.has(type)) return false;
    this.lastCanvasInputRefusalCode = null;
    if (Number.isInteger(generation) && generation === this.renderSeq) return false;
    this.lastCanvasInputRefusalCode = 'STALE_CANVAS';
    this.post({ type: 'status', message: 'STALE_CANVAS' });
    return true;
  }

  private async onMessage(m: {
    type: string; id?: string; mode?: string; x?: number; y?: number; width?: number; height?: number;
    ids?: string[]; dx?: number; dy?: number; prop?: string; propType?: string; isEnum?: boolean; value?: string;
    edits?: Array<{ id: string; dx: number; dy: number }>; controlType?: string; hitId?: string; typeName?: string;
    sizeEdits?: Array<{ id: string; width: number; height: number }>; hostId?: string; pageId?: string;
    axis?: 'h' | 'v'; direction?: 'left' | 'right'; itemType?: string; text?: string; itemId?: string; parentItemId?: string; targetParentItemId?: string | null; targetIndex?: number; token?: number; reopenToken?: number;
    schemaKey?: string; includeNavigator?: boolean; existingBindingSourceId?: string | null;
    commandId?: string; certificationId?: string;
    dpr?: number; newName?: string; state?: unknown; action?: 'retry' | 'rebuild' | 'chooseAssembly' | 'copy';
    dropX?: number; dropY?: number; adornerId?: string; gen?: number;
  }): Promise<void> {
    try {
      if (this.refuseStaleCanvasGeneration(m.type, m.gen)) return;
      // Route supported localizable value edits later in the handler; refuse only structural/source gestures
      // up front so they cannot diverge from ApplyResources. commit() backstops persistence.
      if (this.refuseLocalizableEdit(m.type)) return;
      // 0.10.0 trust-floor S5 — if the last render failed, the canvas is a stale preview of a form that didn't
      // load; refuse mutating gestures so an edit can't target a graph the designer couldn't build.
      if (this.refuseStaleRenderEdit(m.type)) return;
      if (m.type === 'ready') {
        this.gotReady = true;
        const dpi = designerDpiScale(m.dpr);
        this.displayDpr = dpi.displayDpr;
        this.renderScale = dpi.captureScale;
        // A fresh/reloaded webview cleared its DOM. Drop the notice cache so fullRender re-sends it, and post the dirty
        // badge SYNCHRONOUSLY now — before the awaited fullRender, which posts dirty only after loadProps and may return
        // early (unbuilt output / engine or render failure) or stall in hydration. Without this, a recovered/pre-existing
        // dirty document would show a clean badge on reload until a render eventually succeeds. A
        // badge-only post (not postDirty) avoids recomposing the net48 notice with the pre-render engineKind; a following
        // successful fullRender then suppresses its identical trailing dirty via lastDirtyPosted.
        this.lastNoticeSig = undefined;
        this.lastDirtyPosted = this.doc.isDirty;
        this.post({ type: 'dirty', dirty: this.doc.isDirty });
        this.refreshPlacementSettings();
        this.pushPersistedViewState();
        this.output.appendLine('[designer] webview ready: ' + this.designerFile);
        await this.fullRender();
      } else if (m.type === 'toolboxInteraction') {
        this.noteToolboxInteraction();
      } else if (m.type === 'dprChanged') {
        const dpi = designerDpiScale(m.dpr);
        if (!displayDprChanged(this.displayDpr, dpi.displayDpr)) return;
        const captureChanged = this.renderScale !== dpi.captureScale;
        this.displayDpr = dpi.displayDpr;
        this.renderScale = dpi.captureScale;
        this.output.appendLine(`[designer] display DPR changed: ${dpi.displayDpr} (capture ${dpi.captureScale}x)`);
        // Chromium automatically remaps an existing 2x backing when only the fractional display grid changes. Re-render
        // only when the engine capture itself changes (100% <-> any supported high-DPI ratio).
        if (captureChanged) await this.fullRender();
      } else if (m.type === 'canvasViewStateChanged') {
        this.updateCanvasViewState(m.state);
      } else if (m.type === 'diagnosticAction' && m.action) {
        await this.handleDiagnosticAction(m.action);
      } else if (m.type === 'pick' && m.id) {
        // thread the canvas-origin pick's correlation token so the echoed `select` can be matched to THIS exact pick
        // (the canvas suppresses only the echo of a pick whose selection an add-editor deliberately dropped.
        await this.pick(m.id, m.token, m.ids);
      } else if (m.type === 'designerAdornerHit' && m.id && m.adornerId) {
        const result = await this.confirmDesignerAdornerHit(m.id, m.adornerId, m.x ?? NaN, m.y ?? NaN);
        this.post({ type: 'designerAdornerHit', id: m.id, token: m.token, ...result });
      } else if (m.type === 'manipulate' && m.id && m.mode) {
        await this.applyManipulate(
          m.id, m.mode, m.x ?? 0, m.y ?? 0, m.width ?? 0, m.height ?? 0, m.dropX, m.dropY,
        );
      } else if (m.type === 'manipulateGroup' && Array.isArray(m.ids)) {
        await this.applyGroupMove(m.ids, m.dx ?? 0, m.dy ?? 0);
      } else if (m.type === 'designerActionCommand' && m.id && m.commandId && m.certificationId) {
        await this.applyHostedServiceKernelCommand(m.id, m.commandId, m.certificationId);
      } else if (m.type === 'edit' && m.id && m.prop) {
        // tab-order editing (Phase 2) commits a TabIndex from the canvas through the proven grid-edit path
        await this.editFromGrid(m.id, m.prop, m.propType ?? '', !!m.isEnum, m.value ?? '');
      } else if (m.type === 'alignControls' && Array.isArray(m.edits)) {
        await this.applyAlign(m.edits);
      } else if (m.type === 'centerInForm' && (m.axis === 'h' || m.axis === 'v') && Array.isArray(m.ids)) {
        await this.applyCenterInForm(m.axis, m.ids);
      } else if (m.type === 'resizeControls' && Array.isArray(m.sizeEdits)) {
        await this.applyResize(m.sizeEdits);
      } else if (m.type === 'dropControl' && m.controlType) {
        // toolbox drag → canvas drop: place into the container under the cursor (or the form) at the drop point
        await this.applyAddControl(m.controlType, this.containerParentFor(m.hitId ?? 'this'), m.x, m.y, m.width, m.height);
      } else if (m.type === 'dropDataSource' && m.schemaKey && (m.mode === 'detail' || m.mode === 'grid')) {
        await this.generateFromDataSource(m.schemaKey, m.mode, this.containerParentFor(m.hitId ?? 'this'),
          m.x, m.y, !!m.includeNavigator, m.existingBindingSourceId ?? null, null);
      } else if (m.type === 'cancelToolboxSelection') {
        this.setToolboxSelection(null);
      } else if (m.type === 'save') {
        await this.saveDesigner();
      } else if (m.type === 'removeControl' && m.id) {
        await this.applyRemoveControl(m.id);
      } else if (m.type === 'removeControls' && Array.isArray(m.ids)) {
        await this.applyGroupRemove(m.ids);
      } else if (m.type === 'viewCode') {
        this.onViewCode(this.documentUri);
      } else if (m.type === 'renameComponent' && m.id) {
        await this.promptComponentRename(m.id);
      } else if (m.type === 'createDefaultHandler' && m.id) {
        await this.createDefaultHandler(m.id);
      } else if (m.type === 'copy' && m.id) {
        await this.applyCopy([m.id]);
      } else if (m.type === 'copyControls' && Array.isArray(m.ids)) {
        await this.applyCopy(m.ids);
      } else if (m.type === 'cut' && m.id) {
        await this.applyCut([m.id]);
      } else if (m.type === 'cutControls' && Array.isArray(m.ids)) {
        await this.applyCut(m.ids);
      } else if (m.type === 'paste') {
        await this.applyPaste(m.id);
      } else if (m.type === 'duplicate' && Array.isArray(m.ids)) {
        await this.applyDuplicate(m.ids);
      } else if (m.type === 'duplicateDrag' && Array.isArray(m.ids)) {
        await this.applyDuplicateDrag(m.ids, m.dx ?? 0, m.dy ?? 0);
      } else if (m.type === 'bringToFront' && m.id) {
        await this.applyZOrder([m.id], true);
      } else if (m.type === 'bringToFrontGroup' && Array.isArray(m.ids)) {
        await this.applyZOrder(m.ids, true);
      } else if (m.type === 'sendToBack' && m.id) {
        await this.applyZOrder([m.id], false);
      } else if (m.type === 'sendToBackGroup' && Array.isArray(m.ids)) {
        await this.applyZOrder(m.ids, false);
      } else if (m.type === 'tabClick' && m.hostId) {
        await this.applyTabClick(m.hostId, m.x ?? 0, m.y ?? 0);
      } else if (m.type === 'tabRename' && m.hostId) {
        await this.applyTabRename(m.hostId, m.x ?? 0, m.y ?? 0);
      } else if (m.type === 'stripAdd' && m.hostId) {
        await this.applyStripAdd(m.hostId, typeof m.itemType === 'string' ? m.itemType : '', typeof m.text === 'string' ? m.text : '', typeof m.parentItemId === 'string' ? m.parentItemId : undefined, typeof m.reopenToken === 'number' ? m.reopenToken : undefined);
      } else if (m.type === 'stripMove' && m.hostId && m.itemId) {
        await this.applyStripMove(m.hostId, m.itemId, typeof m.targetParentItemId === 'string' ? m.targetParentItemId : null, typeof m.targetIndex === 'number' ? m.targetIndex : NaN);
      } else if (m.type === 'stripRename' && m.hostId && m.itemId) {
        await this.applyStripRename(m.hostId, m.itemId, typeof m.text === 'string' ? m.text : '');
      } else if (m.type === 'stripRetype' && m.hostId && m.itemId && m.itemType) {
        await this.applyStripRetype(m.hostId, m.itemId, m.itemType, typeof m.text === 'string' ? m.text : '');
      } else if (m.type === 'stripDelete' && m.hostId && m.itemId) {
        await this.applyStripDelete(m.hostId, m.itemId);
      } else if (m.type === 'trayRename' && m.id && m.newName) {
        await this.applyComponentRename(m.id, m.newName);
      } else if (m.type === 'selectItem' && m.hostId && m.itemId) {
        // a top-level strip item was clicked on the canvas → describe THAT item into the Properties panel via a
        // dedicated channel that leaves the control selection (currentId / manip / smart-tag) untouched. Record it as
        // the current item selection so a later stale refresh for a previous item can't overwrite this one.
        this.currentSelItem = { ownerId: m.hostId, itemId: m.itemId };
        await this.loadItemProps(m.hostId, m.itemId);
      } else if (m.type === 'addTab' && m.hostId) {
        await this.applyAddTab(m.hostId);
      } else if (m.type === 'deleteTab' && m.hostId && m.pageId) {
        await this.applyDeleteTab(m.hostId, m.pageId);
      } else if (m.type === 'moveTab' && m.hostId && m.pageId && (m.direction === 'left' || m.direction === 'right')) {
        await this.applyMoveTab(m.hostId, m.pageId, m.direction === 'left');
      } else if (m.type === 'learnMore') {
        await this.openLearnMore(m.typeName);
      } else if (m.type === 'showProperties') {
        await vscode.commands.executeCommand('winformsDesigner.showProperties');
      }
    } catch (err) {
      this.post({ type: 'error', message: errMsg(err) });
    }
  }

  /** Select a component (from a canvas click or the Properties tree): move the overlay + load its grid. `token` is the
   * canvas-origin pick's correlation id (undefined for a Properties-tree pick) — echoed back on `select` so the canvas
   * can match the reply to its exact pick. */
  async pick(id: string, token?: number, selectedIds?: string[]): Promise<void> {
    if (this.disposed) return;
    this.currentId = id;
    this.currentSelectionIds = normalizeMultiSelection(id, selectedIds, this.controls.map((control) => control.id));
    // Any load still in flight for the PREVIOUS pick is now stale: its awaits can resolve after this one's and would
    // otherwise publish the old control's grid/tasks over the new selection. Bumping the generation here (before the
    // awaits below) lets loadProps drop such a load. Ids alone can't do this — select A, B, A again would let the
    // first A's late reply pass an id check.
    this.selectionGen++;
    this.currentSelItem = null; // a control selection supersedes any item→Properties selection (drops the item-refresh guard)
    this.pushSelect(id, token);
    await this.loadProps(id);
  }

  /** A dirty/saved sibling partial can change the form's base without touching .Designer.cs. Re-render from the
   * combined current snapshot so stale compiled inheritance is disclosed immediately, including unsaved edits. */
  private scheduleCodeBehindRerender(): void {
    // The modern renderer consumes only .Designer.cs. A delayed create/change notification for the code-behind
    // can arrive just after a newly-created form opens; invalidating the modern render here made that first picture
    // lose its sequence gate, while the timer below deliberately scheduled no replacement for modern sessions.
    if (this.disposed || this.engineKind !== 'net48') return;
    // Invalidate authority immediately, not after the debounce: an in-flight render/describe was based on the previous
    // partial and must never publish a stale inherited capability during the 120 ms coalescing window.
    this.renderSeq++;
    this.selectionGen++;
    this.publishedPropertyComponent = undefined;
    this.renderOk = false;
    if (this.codeBehindDebounce) clearTimeout(this.codeBehindDebounce);
    this.codeBehindDebounce = setTimeout(() => {
      this.codeBehindDebounce = undefined;
      if (this.disposed) return;
      void this.fullRender(true).catch(() => { /* fullRender reports its own failure */ });
    }, 120);
  }

  /** A refresh for the selected primary describes the full multi-set; a background refresh of any other id remains
   * strictly single-target so it cannot overwrite the panel with an unrelated synthetic selection. */
  private propertySelectionIds(id: string): string[] {
    return id === this.currentId && this.currentSelectionIds.includes(id)
      ? this.currentSelectionIds.slice()
      : [id];
  }

  /**
   * Delete the canvas's current selection — invoked when Delete is pressed while the side panel is focused
   * (e.g. the user is on the Toolbox tab). The canvas (a separate webview) owns the single/multi selection,
   * so route the request back to it; it runs the same proven delete path as its local Delete key.
   */
  deleteSelectedFromPanel(): void {
    if (this.disposed) return;
    this.post({ type: 'requestDelete' });
  }

  /**
   * Open (or reveal) the big "Choose Toolbox Items" window — a separate editor-area webview panel with the
   * VS-style tabs / table / filter. The .NET tab merges engine/project controls with configured probe directories,
   * previously browsed assemblies and registered third-party assemblies through the bounded persistent scan cache.
   */
  openChooseItems(tab?: string): void {
    if (this.disposed) return;
    this.chooseItemsTab = tab;
    // show the target tab right in the editor-tab title so it's unmistakable which toolbox tab items land in.
    const title = 'Choose Toolbox Items' + (tab ? ' → ' + tab : '');
    if (this.chooseItemsPanel) { this.chooseItemsPanel.title = title; this.chooseItemsPanel.reveal(); void this.pushCandidates(this.chooseItemsPanel); return; }
    const panel = vscode.window.createWebviewPanel(
      'winformsDesigner.chooseItems', title, vscode.ViewColumn.Active,
      { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')] },
    );
    this.chooseItemsPanel = panel;
    panel.webview.html = chooseItemsHtml(panel.webview, this.extensionUri);
    panel.webview.onDidReceiveMessage(async (m: { type?: string; scope?: string; tab?: string | null; rows?: ChooseRow[] }) => {
      if (m?.type === 'ready') await this.pushCandidates(panel);
      else if (m?.type === 'browse' && m.scope === 'net') await this.browseChooseItems(panel);
      else if (m?.type === 'applyChooseItems' && m.scope === 'net') { this.applyChosen(m.tab ?? undefined, m.rows ?? []); panel.dispose(); }
      else if (m?.type === 'close') panel.dispose();
    });
    panel.onDidDispose(() => { if (this.chooseItemsPanel === panel) this.chooseItemsPanel = undefined; });
  }

  private toolboxProbeDirectories(): string[] {
    const raw = vscode.workspace.getConfiguration('winformsDesigner').get<string[]>('net48.probeDirectories', []);
    const base = this.wsRoot() ?? (this.designerFile ? path.dirname(this.designerFile) : process.cwd());
    return [...new Set((Array.isArray(raw) ? raw : [])
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .map((value) => {
        let resolved = value.trim();
        const home = process.env.USERPROFILE;
        if (home && (resolved === '~' || resolved.startsWith('~/') || resolved.startsWith('~\\')))
          resolved = path.join(home, resolved.slice(1));
        return path.isAbsolute(resolved) ? path.normalize(resolved) : path.resolve(base, resolved);
      })
      .filter((value) => fs.existsSync(value)))];
  }

  /** Project output + configured probe directories + explicitly browsed libraries + machine GAC registrations.
   * The actual reflection results are cached by path/size/mtime in DesignerHub, so reopening the dialog normally
   * performs only bounded directory enumeration and no engine round-trips. */
  private toolboxAssemblyPaths(): string[] {
    const hub = DesignerHub.instance;
    const probes = this.toolboxProbeDirectories();
    return uniqueAssemblyPaths([
      this.asm(),
      ...hub.browsedToolboxAssemblies,
      ...discoverProbeAssemblies(probes),
      ...discoverRegisteredAssemblies(),
    ]);
  }

  private async scanCandidateAssembly(file: string): Promise<ToolboxScanCacheEntry> {
    const hub = DesignerHub.instance;
    const probes = this.toolboxProbeDirectories();
    const cached = hub.cachedToolboxScan(file, probes);
    if (cached) return cached;
    const gac = /[\\/]Microsoft\.NET[\\/]assembly[\\/]/i.test(file);
    const currentFrameworkOutput = this.engineKind === 'net48'
      && !!this.asm() && normalize(this.asm()!) === normalize(file);
    let items: ToolboxCandidate[] = [];
    let error: string | undefined;

    const scanWith = async (kind: EngineKind): Promise<void> => {
      const result = await scanToolboxAssembly(await this.ensureEngine(kind), file, probes);
      items = (result.items ?? []).map((item) => ({
        ...item,
        fromProject: true,
        assemblyPath: item.assemblyPath || file,
        directory: item.directory || path.dirname(file),
      }));
      error = result.error ?? undefined;
    };

    try {
      if (gac || currentFrameworkOutput) {
        await scanWith('net48');
      } else {
        await scanWith('modern');
        // A .NET Framework library cannot load in the modern ALC. The net48 scanner runs in a disposable AppDomain,
        // so fallback reflection is compatible without leaving this library pinned.
        if (!items.length) {
          try { await scanWith('net48'); } catch { /* keep the modern reason */ }
        }
      }
    } catch (err) {
      error = errMsg(err);
    }
    const entry = { items, error, stamp: '' };
    hub.storeToolboxScan(file, items, error, probes);
    return hub.cachedToolboxScan(file, probes) ?? entry;
  }

  private async discoveredCandidates(): Promise<ToolboxCandidate[]> {
    const files = this.toolboxAssemblyPaths();
    const out: ToolboxCandidate[] = [];
    // Four concurrent reflection domains keep a large registered/probe set responsive without flooding the engine.
    for (let i = 0; i < files.length; i += 4) {
      const batch = await Promise.all(files.slice(i, i + 4).map((file) => this.scanCandidateAssembly(file)));
      for (const result of batch) out.push(...result.items);
    }
    return out;
  }

  /** Fetch the Choose-Items rows (framework + project + browsed .dlls) → the dialog, with the target tab and
   * which of its items are currently in the toolbox (so the checkboxes start in the right state). */
  private async pushCandidates(panel: vscode.WebviewPanel, autoCheck?: string[]): Promise<void> {
    const hub = DesignerHub.instance;
    const tab = this.chooseItemsTab ?? null;
    // "chosen" sent to the dialog = the fqns CURRENTLY in the toolbox (framework-not-hidden + added) → so the
    // checkboxes start checked for everything already in the toolbox (matching VS), not all-off.
    const inToolbox = (): string[] => [
      ...this.visibleToolboxItems().map((c) => c.fqn),
    ];
    // `check` = fqns to auto-tick this round (a just-browsed assembly's items) so the user doesn't have to hand-
    // check every row after loading a library — like VS, which checks a browsed assembly's items on add.
    const check = autoCheck ?? [];
    if (this.disposed || !this.designerFile) { void panel.webview.postMessage({ type: 'items', items: [], tab, chosen: inToolbox(), check }); return; }
    try {
      const eng = await this.ensureEngine('modern');
      await this.loadToolboxItems(); // baseline "already in toolbox" set (incl. net48 project controls)
      const base = await listToolboxCandidates(
        eng,
        this.designerFile,
        this.engineKind === 'modern' ? this.asm() : undefined,
      );
      const discovered = await this.discoveredCandidates();
      // Auto-discovered entries must also appear in Choose Items. That dialog is the add/remove surface; omitting
      // these rows would make a workspace control impossible to hide or restore after automatic discovery.
      const autoDiscovered = this.autoToolboxItems.map((item): ToolboxCandidate => {
        const split = item.fqn.lastIndexOf('.');
        const assemblyPath = item.assemblyPath;
        return {
          name: item.name,
          namespace: split >= 0 ? item.fqn.slice(0, split) : '',
          assemblyName: assemblyPath ? path.basename(assemblyPath, path.extname(assemblyPath)) : '',
          version: '',
          directory: assemblyPath ? path.dirname(assemblyPath) : '',
          fromProject: true,
          assemblyPath,
        };
      });
      const seen = new Set<string>();
      const items = [...base, ...autoDiscovered, ...discovered].filter((item) => {
        const fqn = item.namespace ? item.namespace + '.' + item.name : item.name;
        const key = fqn + '|' + item.assemblyName;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      void panel.webview.postMessage({ type: 'items', items, tab, chosen: inToolbox(), check });
    } catch (err) {
      void panel.webview.postMessage({ type: 'items', items: [], tab, chosen: inToolbox(), check });
      this.output.appendLine('choose-items enumeration failed: ' + errMsg(err));
    }
  }

  /**
   * Apply OK: diff the dialog's checkbox state against the CURRENT toolbox membership. A newly-checked item is
   * added (a framework item is un-hidden; a library/component item is added to the target tab); a newly-
   * unchecked item is removed (a framework item is hidden; a previously-added item is dropped). Rows the dialog
   * didn't show are left untouched. Persisted + re-pushed so the Toolbox reflects it immediately.
   */
  private applyChosen(tab: string | undefined, rows: ChooseRow[]): void {
    const cat = tab || 'My Controls';
    const hub = DesignerHub.instance;
    const automatic = new Set(this.automaticToolboxItems().map((c) => c.fqn));
    const hidden = new Set(hub.hiddenFqns);
    let chosen = hub.chosenItems.slice();
    for (const r of rows) {
      if (!r.fqn) continue;
      const isAutomatic = automatic.has(r.fqn);
      const inChosen = chosen.some((c) => c.fqn === r.fqn);
      const inToolbox = !hidden.has(r.fqn) && (isAutomatic || inChosen);
      if (r.checked && !inToolbox) {
        hidden.delete(r.fqn);
        if (!isAutomatic && !inChosen) chosen.push({
          name: r.name,
          fqn: r.fqn,
          category: cat,
          fromProject: !!r.fromProject,
          assemblyPath: r.assemblyPath,
        });
      } else if (!r.checked && inToolbox) {
        if (isAutomatic) hidden.add(r.fqn);
        else chosen = chosen.filter((c) => c.fqn !== r.fqn);
      }
    }
    hub.setToolboxCustomization(chosen, [...hidden]);
    // setToolboxCustomization re-pushes via the ACTIVE session, but the Choose-Items dialog holds editor focus, so
    // that gated push can be dropped → the added items wouldn't show until a refocus. Push the merged toolbox
    // DIRECTLY (ungated) so they appear in the palette immediately, which is exactly the point of clicking OK.
    this.pushToolboxItems(true);
    this.post({ type: 'status', message: t('status.toolboxUpdated', { added: chosen.length, hidden: hidden.size }) });
  }

  /**
   * Browse… → pick ONE OR MORE .dlls, scan each in the engine, and merge their toolbox types into the dialog.
   * Reports a per-assembly summary back to the dialog (added N / no components / could-not-load reason) so the
   * user isn't left guessing when a non-control or .NET-Framework assembly yields nothing.
   */
  private async browseChooseItems(panel: vscode.WebviewPanel): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: true, openLabel: 'Add',
      title: 'Choose .NET assemblies (.dll) to scan for toolbox items',
      filters: { Assemblies: ['dll'] },
    });
    if (!picked || !picked.length) { await this.pushCandidates(panel); return; } // cancel → just clear "loading"
    const notes: string[] = [];
    const scannedFqns: string[] = []; // fqns from the just-browsed assemblies → auto-checked in the dialog
    let added = 0;
    let okCount = 0;
    for (const u of picked) {
      const base = path.basename(u.fsPath);
      try {
        const res = await this.scanCandidateAssembly(u.fsPath);
        if (res.items.length) {
          added += res.items.length; okCount++;
          for (const c of res.items) scannedFqns.push(c.namespace ? c.namespace + '.' + c.name : c.name);
          DesignerHub.instance.addBrowsedToolboxAssembly(u.fsPath);
        } else {
          notes.push(`${base}: ${res.error || t('status.browseNoToolbox')}`);
        }
      } catch (e) {
        notes.push(`${base}: ${errMsg(e)}`);
      }
    }
    // re-post the merged list WITH the just-scanned fqns pre-checked, so the loaded library's items are ready to
    // add on OK (VS auto-checks a browsed assembly's items) instead of appearing as an unchecked list expansion.
    await this.pushCandidates(panel, scannedFqns);
    const parts: string[] = [];
    if (added) parts.push(t('status.browseLoaded', { items: tn('unit.items', added), asm: tn('unit.assemblies', okCount) }));
    if (notes.length) parts.push(notes.join('; '));
    void panel.webview.postMessage({ type: 'browseResult', message: parts.join(' — ') || t('status.browseNoComponents') });
  }

  private postRenderDiagnostics(items: RenderDiagItem[]): void {
    if (items.length) {
      this.lastRenderDiagnostic = {
        kind: 'partial',
        message: t('designer.diag.partialCause'),
        target: items[0].target,
        cause: items.map((item) => item.detail || item.text).join('; '),
        items,
      };
    } else {
      this.lastRenderDiagnostic = undefined;
    }
    this.post({ type: 'renderDiag', items });
  }

  private postRenderFailure(message: string, target = 'this', cause = message): void {
    this.renderOk = false;
    this.lastRenderDiagnostic = { kind: 'failure', message, target, cause, items: [] };
    // renderFailure:true distinguishes a real render failure (canvas is stale → persistent last-good banner)
    // from a failed user action (canvas intact → footer status only).
    this.post({ type: 'error', message, renderFailure: true, target, cause });
  }

  private async handleDiagnosticAction(action: 'retry' | 'rebuild' | 'chooseAssembly' | 'copy'): Promise<void> {
    if (action === 'retry') {
      await this.fullRender();
      return;
    }
    if (action === 'rebuild') {
      await vscode.commands.executeCommand('winformsDesigner.runBuildTask');
      return;
    }
    if (action === 'chooseAssembly') {
      await vscode.commands.executeCommand('winformsDesigner.selectControlAssembly');
      return;
    }
    const diag = this.lastRenderDiagnostic;
    const lines = [
      'WinForms Designer diagnostics',
      `Form: ${this.designerFile ?? this.documentUri.fsPath}`,
      `Engine: ${this.engineKind}${this.engineKind === 'net48' ? ` (${this.net48RenderMode})` : ''}`,
      `Target: ${diag?.target ?? this.currentId ?? 'this'}`,
      `Cause: ${diag?.cause || diag?.message || t('designer.diag.noDetails')}`,
    ];
    for (const item of diag?.items ?? []) {
      lines.push('', `[${item.category}] ${item.target}`, `Statement: ${item.text}`);
      if (item.detail) lines.push(`Detail: ${item.detail}`);
    }
    await vscode.env.clipboard.writeText(lines.join('\n'));
    this.post({ type: 'status', message: t('status.diagnosticsCopied') });
  }

  private fail(err: unknown): void {
    const msg = errMsg(err);
    this.postRenderFailure(msg, this.currentId || 'this', msg);
    this.output.appendLine('designer render failed: ' + msg);
    void vscode.window.showErrorMessage(t('host.error', { msg }));
  }

  private withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`${label} (no response after ${Math.round(ms / 1000)}s)`)), ms);
      p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
    });
  }

  /** Full re-render: PNG + layout → canvas + views, keep/repair selection, refresh the property panel.
   * `skipReselect` suppresses the trailing pushSelect(currentId) AND the trailing loadProps(currentId): used after an
   * on-canvas strip-item op (rename/add/delete) or an item→Properties edit so the canvas keeps its item highlight and
   * the panel keeps showing the ITEM instead of snapping to the stale container control — matching the net48 live path
   * (show48 posts no select). Callers that need props reloaded after a skipReselect render do it themselves
   * (applyToolStripItems → loadProps(strip); applyItemEdit → loadItemProps(item)). */
  // Returns true iff it posted a FRESH render→layout→tray (the canvas has a current forest). Any early exit — no file /
  // disposed, framework-unbuilt, engine-start failure, a superseded sequence, a render error — returns false so the
  // on-canvas ADD auto-reopen (applyStripAdd → stripAddDone) doesn't draw a stale forest. Other
  // callers ignore the return.
  private async fullRender(skipReselect = false): Promise<boolean> {
    if (!this.designerFile || this.disposed) return false;
    const seq = ++this.renderSeq;
    this.output.appendLine(`[designer] render #${seq} starting: ${this.designerFile}`);
    this.post({ type: 'loading', message: t('host.loading.starting') });
    try {
      if (!await this.ensureDocumentOwnerBeforeRender()) return false;
    } catch (err) {
      if (seq === this.renderSeq && !this.disposed) this.fail(err);
      return false;
    }
    if (seq !== this.renderSeq || this.disposed) return false;

    const activeXControls = activeXControlsInDesignerSource(this.doc.designerText);
    if (activeXControls.length > 0) {
      const refusal = refuseTierDToolboxRequest('registered-activex');
      const named = activeXControls.slice(0, 3).map(({ control, type }) => `${control} (${type})`).join(', ')
        + (activeXControls.length > 3 ? ', …' : '');
      const message = t('host.tierD.activeXRefused', { controls: named });
      this.output.appendLine(`[designer] ${refusal.reasonCode}: ${message}`);
      this.postRenderFailure(message, activeXControls[0].control, refusal.reasonCode);
      return false;
    }

    // Route by the control assembly's runtime: a Framework/DevExpress assembly (no .deps.json sidecar) renders
    // on the net48 compiled-preview engine; everything else on net9. When no control source is chosen we
    // auto-detect this from the project so a net48/DevExpress form isn't sent to net9 (which can't load it →
    // a near-empty "empty form"). See resolveRouting.
    const explicit = this.designerFile ? this.getAssemblyOverride(this.designerFile) : undefined;
    const route = this.resolveRouting(explicit);
    // Remember an AUTO-resolved framework assembly (not the explicit override) so this session's net48 edit ops
    // reuse it via asm(); a net9 form / explicit source leaves it undefined so nothing stale leaks into asm().
    this.autoAsm = explicit ? undefined : route.asm;
    const asm = route.asm;
    if (asm && assemblyRequiresX86(asm)) {
      const refusal = refuseTierDToolboxRequest('registered-activex');
      const message = t('host.tierD.x86Refused', { assembly: path.basename(asm) });
      this.output.appendLine(`[designer] ${refusal.reasonCode}: ${message}`);
      this.postRenderFailure(message, path.basename(asm), refusal.reasonCode);
      return false;
    }
    const prevKind = this.engineKind;
    this.engineKind = route.kind;
    if (this.engineKind !== prevKind) {
      // the pre-render toolbox load may have cached a framework-only list under the old kind — drop it so the
      // toolbox re-enumerates on the correct engine (net48 → framework + project/vendor controls). See loadToolboxItems.
      this.toolboxItems = undefined;
      DesignerHub.instance.refreshStatus();
    }

    if (this.engineKind === 'net48' && DesignerHub.instance.net48TaskActive) {
      this.postRenderFailure(
        t('host.buildTask.running', { name: t('host.buildTask.generic') }),
        this.currentId || 'this',
        t('host.buildTask.cause'),
      );
      return false;
    }

    // A .NET Framework project with nothing built can't be rendered by either engine (net9 can't load a net4x
    // assembly; net48 needs the compiled output). Don't draw a misleading empty form — tell the user and offer
    // to point the designer at a built control source.
    if (route.frameworkUnbuilt) {
      this.output.appendLine(`[designer] render #${seq}: .NET Framework project not built — prompting for control source`);
      this.postRenderFailure(t('host.frameworkUnbuilt'), 'this', t('host.frameworkUnbuilt'));
      this.promptControlSource(t('host.frameworkUnbuilt'));
      return false;
    }

    let eng: EngineHandle;
    try {
      eng = await this.withTimeout(this.ensureEngine(this.engineKind), 12000, 'engine did not start (is the .NET SDK / dotnet on PATH?)');
    } catch (err) {
      if (seq === this.renderSeq && !this.disposed) this.fail(err);
      return false;
    }
    if (seq !== this.renderSeq || this.disposed) return false;
    try {
      await this.applyEngineLocalizationCulture(eng);
    } catch (err) {
      if (seq === this.renderSeq && !this.disposed) this.fail(err);
      return false;
    }
    // Toolbox: net9 shows framework + project controls (one enumeration); net48 merges net9 framework controls
    // with the project/vendor (DevExpress) controls the net48 engine enumerates (the net9 ALC can't load them).
    await this.loadToolboxItems();
    this.pushToolboxItems();
    this.scheduleAutoToolboxDiscovery();
    void this.refreshPalette();
    this.post({ type: 'loading', message: t('host.loading.rendering') });
    // A full render IS the reconciliation, so drop any pending one. Left running, it fired mid-render, bumped the
    // sequence, and made THIS render lose its own freshness gate — repainting the same source while suppressing the
    // selection/property refresh the original render was doing.
    if (this.interpretedReconcileTimer) { clearTimeout(this.interpretedReconcileTimer); this.interpretedReconcileTimer = undefined; }
    const renderRev = this.doc.rev; // the buffer revision this picture will represent (see renderedRev)
    // The engine builds its object graph and captures pixels in one indivisible RPC, so the frozen capture phase owns
    // both. The model phase is the real host-side source/model preparation immediately before that RPC.
    const modelStartedAt = Date.now();
    const text = await this.currentEngineText();
    const codeBehindText = this.engineKind === 'net48' ? await this.currentCodeText() : undefined;
    const modelMs = Date.now() - modelStartedAt;
    // LAST gate before the RPC leaves the host. The engine-kind/task check above happens BEFORE several awaits
    // (engine start, localization, toolbox, buffer read), and a build can start inside that window: the release
    // unloads the net48 domains, and this render — already past the earlier gate — would immediately recreate one and
    // RE-PIN the output MSBuild is about to overwrite. The post-RPC sequence gate only discards the stale picture; by
    // then the file is held again. Nothing awaits between here and the send, so this closes the window.
    if (seq !== this.renderSeq || this.disposed) return false;
    if (this.engineKind === 'net48' && DesignerHub.instance.net48TaskActive) {
      this.postRenderFailure(
        t('host.buildTask.running', { name: t('host.buildTask.generic') }),
        this.currentId || 'this',
        t('host.buildTask.cause'),
      );
      return false;
    }
    let result: Awaited<ReturnType<typeof renderWithLayout>>;
    const captureStartedAt = Date.now();
    try {
      if (this.engineKind === 'net48') {
        // Render the LIVE .Designer.cs source through the IR interpreter (VS model — instantiate
        // the base type, replay the parsed statements onto it). Forms the interpreter can't fully cover fall back to
        // the compiled last build WITH a named reason. `renderMode` drives the banner below (interpreted = no
        // disclosure, it IS your source; compiledFallback = the "last build" disclosure). The compiled describe/live-
        // edit RPCs are unchanged — for an interpreted, unedited form they read the same build, so selection/props line
        // up; unifying edits onto the interpreted picture is a later step.
        const ir = await this.withTimeout(
          renderInterpretedWithLayout(eng, this.designerFile, asm as string, text ?? '', undefined, undefined,
            0, 0, this.tabViewState(), this.renderScale, codeBehindText),
          20000, 'engine render timed out — it may be stuck (first-run)');
        result = ir;
      } else {
        result = await this.withTimeout(
            renderWithLayout(eng, this.designerFile, asm, text, this.renderScale, this.tabViewState()),
            20000, 'engine render timed out — it may be stuck (first-run / MSBuild)');
      }
    } catch (err) {
      if (seq === this.renderSeq && !this.disposed) this.fail(err);
      return false;
    }
    const captureMs = Date.now() - captureStartedAt;
    if (seq !== this.renderSeq || this.disposed) return false;
    const previewStartedAt = Date.now();
    // Persist the net48 render mode ONLY after the sequence gate — mirroring how all other shared state below is
    // mutated post-gate. Assigning it earlier (inside the try) let a SUPERSEDED interpreted render resolve last,
    // overwrite this.net48RenderMode with its stale mode, then bail at the gate without recomposing the banner —
    // leaving the mode field out of sync with the on-screen picture.
    if (this.engineKind === 'net48') {
      const ir = result as typeof result & { renderMode: string; fallbackReason: string };
      this.net48RenderMode = ir.renderMode;
      this.net48FallbackReason = ir.fallbackReason;
      // Record which buffer this picture IS, but only when it is genuinely an interpretation of one — a compiled
      // fallback is a picture of the last build, and pretending otherwise would let a later live edit re-snapshot a
      // graph that never carried these edits.
      this.renderedText = ir.renderMode === 'interpreted' ? (text ?? '') : undefined;
      this.renderedRev = ir.renderMode === 'interpreted' ? renderRev : -1;
    }
    this.modernGraphToken = this.engineKind === 'modern' && result.graphToken
      ? result.graphToken
      : undefined;
    this.output.appendLine(`[designer] render #${seq} ok: ${result.png.length}B, ${result.controls.length} controls`);

    const emptySurfaceReason = t('designer.owner.emptyInitializeComponentReadOnly');
    this.controls = this.emptyInitializeComponentSurface
      ? result.controls.map((control) => ({
          ...control,
          editable: false,
          readOnlyReason: emptySurfaceReason,
        }))
      : result.controls;
    // Kept from the LIVE render so a first control drop can persist the pair this runtime actually scales by —
    // 6,13 on .NET Framework, 7,15 on modern .NET. See addControl's autoScaleDimensions.
    this.renderedAutoScale = result.autoScaleDimensions ?? '';
    if (this.engineKind === 'modern' || this.net48RenderMode === 'interpreted') this.pruneSelectedTabs(this.controls);
    this.toolStripItems = result.toolStripItems ?? [];
    this.rootClient = { w: result.clientWidth, h: result.clientHeight };
    this.rootFrame = { w: result.width, h: result.height };
    this.post({ type: 'render', png: result.png.toString('base64'), width: result.width, height: result.height, gen: seq });
    this.postLayout(this.controls, this.toolStripItems);
    this.trayComponents = result.tray.slice();
    this.post({ type: 'tray', items: result.tray }); // component tray (canvas strip)
    // 1.0.0 — post the persistent notice SYNCHRONOUSLY here, right after the render/layout/
    // tray posts and BEFORE the awaited loadProps below. Composing it only after loadProps let a clean net48 first
    // open (or a modern→net48 excursion) present an editable, build-based canvas with NO "last build" disclosure if
    // loadProps stalled or rejected — the exact silent state the descope exists to prevent. Everything the banner
    // needs (engineKind, localizable, and the modern inheritedBase/binaryResx flags on `result`) is available now, and
    // we are already past the sequence gate above, so this is the freshest render.
    this.composeFormNotice(result);
    // 0.10.0 S5 — the canvas now faithfully reflects this render → edits allowed. Set HERE (right after the render/
    // layout/tray posts, BEFORE the awaited loadProps) so a loadProps rejection can't leave a visibly-rendered form
    // read-only (false-refuse). GUARDED by the generation check so a SUPERSEDED render (whose newer sibling may have
    // already fail()'d → renderOk=false) can never resurrect true — an old fullRender resuming past its await
    // must not overwrite a newer failure.
    if (seq === this.renderSeq && !this.disposed) {
    this.renderOk = true; // the canvas faithfully reflects this render → edits allowed (net48 disclosure aside)
    }
    const previewMs = Date.now() - previewStartedAt;
    // Keep the selection across a full re-render only if it still exists — as a visual control OR a tray component
    // (a ContextMenuStrip, Timer, …); otherwise fall back to the root form. Consulting the tray too matters after
    // editing a tray component's collection (e.g. a ContextMenuStrip's Items commits via this net9 fullRender):
    // without it the selection would snap to the form. See retainSelectionId (unit-tested in e2e.ts).
    const reconciliationStartedAt = Date.now();
    this.currentId = retainSelectionId(this.currentId, result.controls, result.tray);
    const liveSelectionIds = new Set<string>([
      'this',
      ...this.controls.map((control) => control.id),
      ...result.tray.map((component) => component.id),
    ]);
    this.currentSelectionIds = this.currentSelectionIds.filter((id) => liveSelectionIds.has(id) && id !== this.currentId);
    this.currentSelectionIds.push(this.currentId);
    // an on-canvas strip-item op / item edit keeps the canvas item highlight authoritative — do not snap the selection
    // back to the (stale) container control (which would lose the highlight + make a follow-up Delete target the wrong
    // thing) NOR reload the control's props over the item grid. The caller reloads the right props (strip or item).
    if (!skipReselect) {
      this.pushSelect(this.currentId);
      await this.loadProps(this.currentId);
    }
    await this.postDirty();
    this.pushClipboardState();
    // 1.0.0 — re-check the generation before the notice posts below. The awaits above (loadProps does real engine
    // RPCs) let a NEWER render finish first and install the correct banner/lock; this older call resuming afterwards
    // would then overwrite or hide it with its own stale view. The authoritative gates already sit on the newer
    // state, so this was UI dishonesty rather than an edit bypass — but a banner that says the wrong thing about
    // read-only-ness is exactly what 1.0 cannot ship.
    if (seq !== this.renderSeq || this.disposed) return true;
    const reconciliationMs = Date.now() - reconciliationStartedAt;
    this.lastFullRenderTelemetry = {
      modelMs,
      captureMs,
      previewMs,
      reconciliationMs,
      totalMeasuredMs: modelMs + captureMs + previewMs + reconciliationMs,
      displayDpr: this.displayDpr,
      captureScale: this.renderScale,
      controlCount: result.controls.length,
    };
    this.maybePromptForControlSource(result.unrepresentable, asm);
    // T2.2: surface WHAT the (partial) render skipped — controls whose ctor threw, unresolved types, unsupported
    // constructs — as a dismissible canvas banner. The engine already renders resiliently and records each dropped
    // statement + reason in `unrepresentable`; categorize it host-side (pure) and hand the canvas a compact set.
    // Empty items hide any stale banner. A net48 interpreter fallback is also a degraded render: the canvas is usable
    // but build-based, so expose its named reason through the same target/cause/actions surface as modern partials.
    const diagnostics = categorizeUnrepresentable(result.unrepresentable);
    if (this.emptyInitializeComponentSurface) {
      diagnostics.unshift({
        category: 'unsupported',
        target: 'this',
        text: t('designer.owner.emptyInitializeComponentReadOnly'),
        detail: '',
      });
    }
    if (this.engineKind === 'net48' && this.net48RenderMode === 'compiledFallback') {
      diagnostics.unshift({
        category: 'unsupported',
        target: 'this',
        text: t('designer.diag.compiledFallback'),
        detail: this.net48FallbackReason || t('designer.diag.noDetails'),
      });
    }
    this.postRenderDiagnostics(diagnostics);
  // composeFormNotice(result) was already posted synchronously right after the render/layout/tray posts above, so a
  // stalled loadProps can never leave the canvas without its persistent notice.
    return true; // a fresh render→layout→tray was posted → the canvas forest is current
  }

  /**
   * 0.10.0 / 1.0.0 — post the single-slot persistent #formNotice. The one place that composes the banner, so every
   * render path stays consistent. A clean modern render posts `kind:null` (hides the banner).
   *
   * Visible banner producers:
   * - localizable resource-editing context — 🌐;
   * - binary/ImageStream resx (S3) and inherited/unresolved base (S2) — ⚠️ disclosures on an editable modern form
   * (its targeted splices preserve what the preview couldn't draw); modern-engine only.
   *
   * The .NET Framework compiled-preview disclosure (net48 renders the last BUILD, never the live source, and cannot
   * prove they match) is NOT a banner — it goes to the output channel, so the fact stays on record without occupying
   * the canvas. It is not a lock either: net48 stays editable and the source is protected by the byte-local firewall.
   */
  private composeFormNotice(res: { inheritedBase?: boolean; unrenderableResxCount?: number; baseTypeName?: string }): void {
    if (this.disposed) return;
    const inheritedModern = this.engineKind === 'modern' && res.inheritedBase === true;
    const binaryResx = this.engineKind === 'modern' && (res.unrenderableResxCount ?? 0) > 0;
    // The .NET Framework compiled-preview canvas is BUILD-based (the last build, not the live source) when it did not
    // interpret; that fact goes to the OUTPUT CHANNEL, not a banner (it was previously an always-visible strip). An
    // interpreted net48 render IS the live source (VS model), like the modern engine, so there is nothing to disclose.
    const net48Preview = this.engineKind === 'net48' && this.net48RenderMode !== 'interpreted';
    if (net48Preview) {
      // Log-only, deduped so a render/edit storm doesn't spam the channel.
      const note = this.doc.isDirty ? t('designer.notice.compiledPreviewDirty') : t('designer.notice.compiledPreview');
      if (note !== this.lastNet48NoticeLog) { this.output.appendLine(note); this.lastNet48NoticeLog = note; }
    } else {
      this.lastNet48NoticeLog = undefined;
    }
    // The visible banner covers modern-engine disclosures (⚠️ binaryResx / inheritedBase) and the active localizable
    // resource context (🌐). net48Preview is deliberately NOT passed — it no longer drives a banner (see above).
    const kind = chooseFormNoticeKind(this.localizable, inheritedModern, binaryResx);
    let payload: { type: 'formNotice'; kind: FormNoticeKind; icon?: string; text?: string };
    if (kind === null) {
    payload = { type: 'formNotice', kind: null }; // clean render → hide
    } else {
      const parts: string[] = [];
      if (this.localizable) parts.push(t('designer.notice.localizationEditable', { culture: this.localizationCultureLabel() }));
      if (binaryResx) parts.push(t('designer.notice.binaryResx', { n: res.unrenderableResxCount ?? 0 }));
      if (inheritedModern) parts.push(t('designer.notice.inheritedBase', { base: res.baseTypeName ?? '' }));
      const icon = this.localizable ? '🌐' : '⚠️';
      payload = { type: 'formNotice', kind, icon, text: parts.join(' ') };
    }
    // Skip a re-post byte-identical to the one already on screen: the notice is composed on the
    // early render post AND recomposed on the trailing postDirty, and #6 now also syncs it at every mutation point, so
    // most calls are no-ops. Deduping keeps that free of redundant webview IPC without suppressing any real change (a
    // clean→dirty/kind change alters the signature). Reset on 'ready' so a reloaded webview still gets a fresh notice.
    const sig = JSON.stringify(payload);
    if (sig === this.lastNoticeSig) return;
    this.lastNoticeSig = sig;
    this.post(payload);
  }

  /** If the form references controls the engine couldn't resolve (no assembly holds their type) AND no control
   * source is set yet, prompt the user ONCE to point the designer at the project/assembly that provides them —
   * the "you must specify a project to use your controls" guidance. Silent when a source is already chosen. */
  private maybePromptForControlSource(unrepresentable: string[] | undefined, asm: string | undefined): void {
    if (this.promptedForSource || asm) return; // already chose a source (or was told) → don't nag
    const unresolved = (unrepresentable ?? [])
      .map((u) => /unresolved type\)?\s+([\w.]+)/.exec(u)?.[1])
      .filter((t): t is string => !!t);
    if (!unresolved.length) return;
    // T1.3 cross-runtime fallback: a multi-target (net48;net9) project whose vendor controls the net9 engine
    // can't load → offer the net48 compiled preview (which instantiates the REAL controls) instead of the
    // generic "select a control source" prompt. Only when we auto-routed to net9 (asm undefined, checked above).
    if (this.engineKind === 'modern' && this.maybeOfferFrameworkPreview(unresolved)) return;
    const uniq = [...new Set(unresolved)];
    const shown = uniq.slice(0, 3).join(', ') + (uniq.length > 3 ? ', …' : '');
    this.promptControlSource(t('host.unresolved', { names: shown }));
  }

  /**
   * T1.3: when this form lives in a multi-target project that also targets .NET Framework and the net9 render
   * came back with unresolved vendor controls, offer to switch to the net48 compiled preview (the engine that
   * can load them). Returns true when it handled the situation (an offer/notice was shown) so the caller skips
   * the generic control-source prompt. One-shot per form (latches `promptedForSource`, like promptControlSource).
   */
  private maybeOfferFrameworkPreview(unresolved: string[]): boolean {
    if (!this.designerFile) return false;
    const csproj = isResolvedDocumentOwner(this.lastDocumentOwner) && this.lastDocumentOwner?.projectPath
      ? this.lastDocumentOwner.projectPath
      : findOwningCsproj(path.dirname(this.designerFile), this.wsRoot());
    if (!csproj) return false;
    let text = '';
    try { text = fs.readFileSync(csproj, 'utf8'); } catch { return false; }
    if (!multiTargetHasFramework(text)) return false;
    this.promptedForSource = true; // latch: offer/notice at most once per form (matches promptControlSource)
    const uniq = [...new Set(unresolved)];
    const names = uniq.slice(0, 3).join(', ') + (uniq.length > 3 ? ', …' : '');
    const net48Out = resolveFrameworkOnlyOutput(csproj);
    if (net48Out) {
      void vscode.window.showWarningMessage(t('host.crossRuntime.offer', { names }), t('host.crossRuntime.switch'))
        .then((pick) => { if (pick) void this.switchToFrameworkPreview(net48Out, names); });
    } else {
      this.frameworkUnbuiltNotice(names);
    }
    return true;
  }

  /** The .NET Framework target isn't built (only the net9 output exists) — neither engine can render the vendor
   * controls until it is. Tell the user to build it, or point at a control source manually. */
  private frameworkUnbuiltNotice(names: string): void {
    void vscode.window.showWarningMessage(t('host.crossRuntime.unbuilt', { names }), t('host.unresolved.button'))
      .then((pick) => { if (pick) void vscode.commands.executeCommand('winformsDesigner.selectControlAssembly'); });
  }

  /** Persist the net48 build output as this form's control source (survives reload → routes to the compiled
   * preview) and re-render on the net48 engine. VS-parity one-click of the Select-Control-Assembly flow. */
  private async switchToFrameworkPreview(net48Out: string, names: string): Promise<void> {
    if (!this.designerFile || this.disposed) return;
    // The net48 output can be cleaned/rebuilt away between showing the offer and this click — getControlSource
    // drops a non-existent path on read, so persisting it would silently re-render the same near-empty net9 form
    // with no feedback (unlike selectControlAssembly, which re-checks existence). Guard + tell the user instead.
    if (!fs.existsSync(net48Out)) { this.frameworkUnbuiltNotice(names); return; }
    this.output.appendLine(`[designer] cross-runtime: switching to net48 compiled preview → ${net48Out}`);
    const priorNet48Output = this.pinnedNet48Output; // usually undefined here (switching FROM modern), captured for symmetry
    await this.setAssemblyOverride(this.designerFile, net48Out);
  await this.reloadControlSource(priorNet48Output); // drops the cached toolbox + full-renders; routing now sees the net48 asm
    if (!this.disposed) DesignerHub.instance.refreshStatus(); // parity with selectControlAssembly's status refresh
  }

  /** Show the one-shot "point the designer at a control source" prompt — latched (`promptedForSource`) so a
   * form asks at most once per session. Clicking the action opens the Select-Control-Assembly picker. */
  private promptControlSource(message: string): void {
    if (this.promptedForSource) return;
    this.promptedForSource = true;
    void vscode.window.showWarningMessage(message, t('host.unresolved.button'))
      .then((pick) => { if (pick) void vscode.commands.executeCommand('winformsDesigner.selectControlAssembly'); });
  }

  /**
   * Choose the engine (and control assembly) for this render. An explicit control source wins. Otherwise
   * auto-detect a .NET Framework/DevExpress project — which ONLY the net48 compiled-preview engine can load
   * (net9 can't, so it would draw a near-empty form): if its build output exists we route to net48 with it;
   * if it's a single-target Framework project not built yet we flag it (`frameworkUnbuilt`) so the caller
   * prompts instead of rendering garbage. Anything else stays net9 with engine-side auto-discovery (unchanged).
   */
  /** The workspace folder holding this form — the bounded root for the shared-project importer search. */
  private wsRoot(): string | undefined {
    if (!this.designerFile) return undefined;
    return vscode.workspace.getWorkspaceFolder(vscode.Uri.file(this.designerFile))?.uri.fsPath;
  }

  private async ensureDocumentOwnerBeforeRender(): Promise<boolean> {
    if (this.documentOwnerChecked || !this.designerFile) return true;
    const [projects, solutions, solutionXml] = await Promise.all([
      vscode.workspace.findFiles('**/*.csproj', '**/{bin,obj,node_modules}/**', 200),
      vscode.workspace.findFiles('**/*.sln', '**/{bin,obj,node_modules}/**', 50),
      vscode.workspace.findFiles('**/*.slnx', '**/{bin,obj,node_modules}/**', 50),
    ]);
    const projectPaths: string[] = [];
    const seenProjects = new Set<string>();
    const addProject = (projectPath: string): void => {
      const key = normalize(projectPath);
      if (!seenProjects.has(key) && projectPaths.length < 512) {
        seenProjects.add(key);
        projectPaths.push(projectPath);
      }
    };
    projects.forEach((project) => addProject(project.fsPath));
    for (const solution of [...solutions, ...solutionXml])
      projectPathsFromSolutionFile(solution.fsPath).forEach(addProject);
    const eng = await this.withTimeout(
      this.ensureEngine('modern'),
      12000,
      'engine did not start for designer document ownership validation',
    );
    const sourceText = await this.currentText();
    const codeBehindSourceText = await this.currentCodeText();
    const owner = await this.withTimeout(
      resolveDesignerDocumentOwner(
        eng,
        this.designerFile,
        projectPaths,
        sourceText ?? this.doc.designerText,
        codeBehindSourceText,
      ),
      12000,
      'designer document ownership validation timed out',
    );
    this.lastDocumentOwner = owner;
    if (isResolvedDocumentOwner(owner)) {
      this.documentOwnerChecked = true;
      this.emptyInitializeComponentSurface = owner.emptyInitializeComponentSurface === true;
      this.output.appendLine(
        `[designer] document owner resolved: ${this.designerFile} → ${owner.projectPath || owner.owners?.[0] || '<unknown>'}`,
      );
      return true;
    }
    const message = documentOwnerFailureMessage(owner);
    this.output.appendLine(`[designer] document owner refused: ${this.designerFile}: ${message}`);
    this.postRenderFailure(message, 'this', owner?.diagnosticCode || message);
    return false;
  }

  private resolveRouting(explicitAsm: string | undefined): { kind: EngineKind; asm: string | undefined; frameworkUnbuilt: boolean } {
    if (explicitAsm) return { kind: detectEngineKind(explicitAsm), asm: explicitAsm, frameworkUnbuilt: false };
    // findOwningCsproj, not findNearestCsproj: a form living in a SHARED PROJECT (.shproj/.projitems) has no .csproj
    // above it, so the walk returned null and everything below — the net48 routing AND every "pick an assembly"
    // offer — was skipped. The form then went to the .NET 9 renderer with no assembly and came back empty.
    const csproj = isResolvedDocumentOwner(this.lastDocumentOwner) && this.lastDocumentOwner?.projectPath
      ? this.lastDocumentOwner.projectPath
      : this.designerFile ? findOwningCsproj(path.dirname(this.designerFile), this.wsRoot()) : null;
    if (csproj) {
      // A discovered Framework output (no .deps.json sidecar) is definitive — a net4x assembly can only load
      // on the net48 host. A .NET (Core) output has the sidecar, so detectEngineKind returns net9 and we fall
      // through to the unchanged net9 path (engine-side auto-discovery, incl. MSBuild eval for custom output).
      const out = resolveFrameworkOutput(csproj);
      if (out && detectEngineKind(out) === 'net48') return { kind: 'net48', asm: out, frameworkUnbuilt: false };
      if (!out) {
        let text = '';
        try { text = fs.readFileSync(csproj, 'utf8'); } catch { /* unreadable → treat as net9 default */ }
        // Single-target net4x with nothing built: net48 needs the compiled assembly and net9 can't load it,
        // so neither can render. (Multi-target projects also build a net9 output — leave those to net9.)
        if (text && !/<TargetFrameworks>/i.test(text) && isFrameworkTfm(projectTargetFramework(text))) {
          return { kind: 'net48', asm: undefined, frameworkUnbuilt: true };
        }
      }
    }
    return { kind: 'modern', asm: undefined, frameworkUnbuilt: false };
  }

  /**
   * Activate the exact repository-certified net48 ComponentDesigner through the product broker. This is an optional
   * fidelity layer over a component the generic compiled/interpreted surface has already described: any refusal,
   * exception, or OS-process crash is diagnostic state only and must never revoke the ordinary source-first editor.
   */
  private async inspectHostedDesignerProduct(
    component: ComponentDesc,
    engine?: EngineHandle,
  ): Promise<HostedDesignerProbeResult | null> {
    const asm = this.asm();
    if (this.engineKind !== 'net48' || !asm
      || component.type !== CERTIFIED_HOSTED_DESIGNER_COMPONENT) return null;
    try {
      const result = await inspectCertifiedHostedDesigner(
        engine ?? await this.ensureEngine('net48'),
        asm,
        component.type,
        CERTIFIED_HOSTED_DESIGNER_ID,
      );
      this.output.appendLine(
        `[hosted-designer] ${component.id} ${result.status}; code=${result.errorCode || 'none'}; `
        + `main=${result.mainEnginePid}; worker=${result.workerPid}; started=${result.workerStarted}; `
        + `quarantined=${result.quarantined}; privateDesktop=${result.privateDesktop}`,
      );
      return result;
    } catch (error) {
      const reason = errMsg(error);
      this.output.appendLine(`[hosted-designer] ${component.id} RPC failed: ${reason}`);
      return {
        ok: false,
        status: 'refused',
        errorCode: 'WORKER_UNAVAILABLE',
        reason,
        componentType: component.type,
        designerType: '',
        certificationId: CERTIFIED_HOSTED_DESIGNER_ID,
        assemblySha256: '',
        mainEnginePid: 0,
        workerPid: 0,
        exitCode: 0,
        workerStarted: false,
        quarantined: false,
        privateDesktop: false,
      };
    }
  }

  private publishHostedDesignerProbe(result: HostedDesignerProbeResult | null): void {
    this.lastHostedDesignerProbe = result;
    if (!result || result.ok) return;
    const reason = result.errorCode === 'DESIGNER_QUARANTINED'
      ? 'The vendor designer is quarantined for this build; generic Properties and source-first editing remain available.'
      : result.errorCode === 'DESIGNER_CRASH'
        ? 'The vendor designer crashed in its isolated worker and was quarantined; generic Properties and source-first editing remain available.'
        : result.reason;
    this.post({ type: 'status', message: t('status.editRejected', { reason }) });
  }

  private hostedServiceKernelRefusal(
    errorCode: string,
    reason: string,
    componentType = '',
    assemblySha256 = '',
  ): HostedServiceKernelProductResult {
    return {
      ok: false,
      status: 'refused',
      errorCode,
      reason,
      componentType,
      designerType: '',
      certificationId: CERTIFIED_HOSTED_SERVICE_ID,
      assemblySha256,
      apartmentState: '',
      capabilities: [],
      completeHostAdvertised: false,
      incompleteHostWithheld: false,
      incompleteHostReason: '',
      unsupportedServiceRefused: false,
      unsupportedServiceReason: '',
      actionId: '',
      actionInvoked: false,
      transactionsOpened: 0,
      transactionsCommitted: 0,
      transactionsCancelled: 0,
      changeEvents: 0,
      edits: [],
    };
  }

  private hasCertifiedHostedServiceAction(
    component: ComponentDesc,
    commandId = CERTIFIED_HOSTED_SERVICE_ACTION,
  ): boolean {
    return component.type === CERTIFIED_HOSTED_SERVICE_COMPONENT
      && component.designerActions?.some((action) =>
        action.commandId === commandId
        && action.certificationId === CERTIFIED_HOSTED_SERVICE_ID) === true;
  }

  private hostedServiceKernelIdentityIsComplete(result: HostedServiceKernelProductResult): boolean {
    const requiredCapabilities = [
      'ContainerSiting', 'Naming', 'ComponentChange', 'Selection', 'Transactions', 'MenuCommands',
    ];
    return result.componentType === CERTIFIED_HOSTED_SERVICE_COMPONENT
      && result.designerType === 'FakeVendor.HostedServiceControlDesigner'
      && result.certificationId === CERTIFIED_HOSTED_SERVICE_ID
      && /^[0-9a-f]{64}$/i.test(result.assemblySha256)
      && result.apartmentState === 'STA'
      && result.capabilities.length === requiredCapabilities.length
      && requiredCapabilities.every((capability) => result.capabilities.includes(capability))
      && result.completeHostAdvertised
      && result.incompleteHostWithheld
      && result.incompleteHostReason.includes('Selection')
      && result.unsupportedServiceRefused
      && result.unsupportedServiceReason.length > 0;
  }

  private hostedServiceKernelContractIsComplete(result: HostedServiceKernelProductResult): boolean {
    return result.ok && this.hostedServiceKernelIdentityIsComplete(result);
  }

  /** Inspect the product service contract only after the engine has published the exact certified action metadata. */
  private async inspectHostedServiceKernelProduct(
    component: ComponentDesc,
    engine: EngineHandle,
  ): Promise<HostedServiceKernelProductResult | null> {
    if ((this.engineKind !== 'modern' && this.engineKind !== 'net48')
      || component.type !== CERTIFIED_HOSTED_SERVICE_COMPONENT) return null;
    const asm = this.asm()
      ?? (this.designerFile ? await resolveAssembly(engine, this.designerFile) ?? undefined : undefined);
    if (!asm || !this.hasCertifiedHostedServiceAction(component)) {
      return this.hostedServiceKernelRefusal(
        'UNPUBLISHED_COMMAND',
        'The current component does not publish the repository-certified hosted service command.',
        component.type,
      );
    }
    try {
      const result = await inspectCertifiedHostedServiceKernel(
        engine, asm, component.type, CERTIFIED_HOSTED_SERVICE_ID);
      this.output.appendLine(
        `[hosted-service] ${component.id} ${result.status}; complete=${result.completeHostAdvertised}; `
        + `incompleteWithheld=${result.incompleteHostWithheld}; unsupportedRefused=${result.unsupportedServiceRefused}`,
      );
      return this.hostedServiceKernelContractIsComplete(result)
        && result.status === 'ready'
        && result.actionId === ''
        && result.actionInvoked === false
        && result.transactionsOpened === 0
        && result.transactionsCommitted === 0
        && result.transactionsCancelled === 0
        && result.changeEvents === 0
        && result.edits.length === 0
        ? result
        : this.hostedServiceKernelRefusal(
          'INVALID_PRODUCT_RESULT',
          result.ok ? 'The hosted service inspection returned an overbroad or incomplete contract.' : result.reason,
          component.type,
          result.assemblySha256,
        );
    } catch (error) {
      return this.hostedServiceKernelRefusal(
        'WORKER_UNAVAILABLE', errMsg(error), component.type);
    }
  }

  private publishHostedServiceKernelResult(result: HostedServiceKernelProductResult | null): void {
    this.lastHostedServiceKernelResult = result;
    if (result && !result.ok)
      this.post({ type: 'status', message: t('status.editRejected', { reason: result.reason }) });
  }

  /** Run one exact hosted DesignerAction against a disposable component graph. The preset result is independently
   * source-planned as one native Undo unit; the reentrant-cancellation result must carry no proposal or mutation. */
  private async applyHostedServiceKernelCommand(
    id: string,
    commandId: string,
    certificationId: string,
  ): Promise<HostedServiceKernelProductResult> {
    const refuse = (code: string, reason: string, componentType = '', sha = '') => {
      const result = this.hostedServiceKernelRefusal(code, reason, componentType, sha);
      this.publishHostedServiceKernelResult(result);
      return result;
    };
    if (!this.designerFile || this.disposed)
      return refuse('DOCUMENT_UNAVAILABLE', 'The designer document is unavailable.');
    if (this.engineKind !== 'modern' && this.engineKind !== 'net48')
      return refuse('UNSUPPORTED_RUNTIME', 'The certified hosted service command is unavailable for this runtime.');
    if (this.localizable)
      return refuse('LOCALIZABLE_SOURCE_REFUSED', 'The certified command has no resource-only representation.');
    if (!this.renderOk || this.emptyInitializeComponentSurface)
      return refuse('RENDER_UNAVAILABLE', 'The current designer surface is not authorized for source mutation.');
    if ((commandId !== CERTIFIED_HOSTED_SERVICE_ACTION
        && commandId !== CERTIFIED_HOSTED_SERVICE_REENTRANT_ACTION)
      || certificationId !== CERTIFIED_HOSTED_SERVICE_ID)
      return refuse('CERTIFIED_COMMAND_MISMATCH', 'The hosted service command identity is not allowlisted.');

    const published = this.publishedPropertyComponent;
    const component = published?.ids.length === 1
      && published.ids[0] === id
      && this.currentId === id
      && this.currentSelectionIds.length === 1
      && this.currentSelectionIds[0] === id
      && published.rev === this.doc.rev
      ? published.component
      : null;
    if (!component || component.id !== id || component.editable === false
      || !this.hasCertifiedHostedServiceAction(component, commandId)) {
      return refuse(
        'UNPUBLISHED_COMMAND',
        'The current revision-bound selection does not publish the certified hosted service command.',
        component?.type ?? '',
      );
    }
    const before = this.doc.designerText;
    const revBefore = this.doc.rev;
    try {
      const hostedEngine = await this.ensureEngine(this.engineKind);
      const asm = this.asm()
        ?? await resolveAssembly(hostedEngine, this.designerFile) ?? undefined;
      if (!asm)
        return refuse('CERTIFIED_ASSEMBLY_MISSING', 'The certified component assembly is unavailable.', component.type);
      const result = await invokeCertifiedHostedServiceAction(
        hostedEngine, asm, component.type, certificationId, commandId);
      if (commandId === CERTIFIED_HOSTED_SERVICE_REENTRANT_ACTION) {
        const cancelledExactly = this.hostedServiceKernelIdentityIsComplete(result)
          && !result.ok
          && result.status === 'cancelled'
          && result.errorCode === 'REENTRANT_CANCELLED'
          && result.actionId === commandId
          && result.actionInvoked
          && result.transactionsOpened === 1
          && result.transactionsCommitted === 0
          && result.transactionsCancelled === 1
          && result.changeEvents === 4
          && result.edits.length === 0;
        if (!cancelledExactly) {
          return refuse(
            'INVALID_PRODUCT_RESULT',
            result.reason || 'The reentrant hosted action did not return an exact cancellation result.',
            component.type,
            result.assemblySha256,
          );
        }
        if (this.doc.rev !== revBefore || this.doc.designerText !== before)
          return refuse('DOCUMENT_CHANGED', t('status.docChanged'), component.type, result.assemblySha256);
        this.output.appendLine(
          `[hosted-service] cancelled ${id}.${commandId}: nested transaction refused; no source proposal`,
        );
        this.publishHostedServiceKernelResult(result);
        return result;
      }
      const editsAreExact = result.edits.length === 2
        && result.edits[0].propertyName === 'Text'
        && result.edits[0].propertyType === 'System.String'
        && result.edits[0].invariantValue === 'Hosted service preset'
        && result.edits[1].propertyName === 'Size'
        && result.edits[1].propertyType === 'System.Drawing.Size'
        && result.edits[1].invariantValue === '180, 42';
      if (!this.hostedServiceKernelContractIsComplete(result)
        || result.status !== 'applied'
        || result.actionId !== commandId
        || !result.actionInvoked
        || result.transactionsOpened !== 1
        || result.transactionsCommitted !== 1
        || result.transactionsCancelled !== 0
        || result.changeEvents !== 4
        || !editsAreExact) {
        return refuse(
          'INVALID_PRODUCT_RESULT',
          result.ok ? 'The hosted action returned an overbroad or incomplete transaction result.' : result.reason,
          component.type,
          result.assemblySha256,
        );
      }
      if (this.doc.rev !== revBefore)
        return refuse('DOCUMENT_CHANGED', t('status.docChanged'), component.type, result.assemblySha256);

      const plannerEngine = this.engineKind === 'modern'
        ? hostedEngine
        : await this.ensureEngine('modern');
      let text = before;
      for (const edit of result.edits) {
        const expression = COMPLEX_TYPE_SET.has(edit.propertyType)
          ? await convertValue(plannerEngine, edit.propertyType, edit.invariantValue)
          : toCSharpExpression(edit.propertyType, false, edit.invariantValue);
        if (expression === null)
          return refuse('SOURCE_PLAN_REFUSED', `Cannot serialize ${edit.propertyName}.`, component.type, result.assemblySha256);
        const preview = await setProperty(
          plannerEngine, this.designerFile, id, edit.propertyName, expression, text);
        if (!preview.safe || preview.text === null)
          return refuse('SOURCE_PLAN_REFUSED', preview.reason || 'The source planner refused the command.', component.type, result.assemblySha256);
        text = preview.text;
      }
      if (this.doc.rev !== revBefore)
        return refuse('DOCUMENT_CHANGED', t('status.docChanged'), component.type, result.assemblySha256);
      if (!this.commit(before, text, `Apply ${component.name} service preset`))
        return refuse('SOURCE_COMMIT_REFUSED', 'The source transaction produced no authorized change.', component.type, result.assemblySha256);

      this.output.appendLine(
        `[hosted-service] applied ${id}.${commandId}: Text+Size in one source transaction (unsaved)`,
      );
      await this.fullRender();
      await this.postDirty();
      this.publishHostedServiceKernelResult(result);
      this.post({ type: 'status', message: t('status.propSet', { id, prop: 'Text + Size' }) });
      return result;
    } catch (error) {
      return refuse('HOSTED_SERVICE_FAILED', errMsg(error), component.type);
    }
  }

  /** Describe the selected component → push its grid to the Properties view + its manipulability to the canvas. */
  private async loadProps(id: string): Promise<void> {
    if (!this.designerFile || this.disposed) return;
    const selectionIds = this.propertySelectionIds(id);
    // Snapshot the selection generation: if a newer pick() lands while the describe is in flight, this load's replies
    // are stale and must publish nothing — otherwise the late reply repaints the PREVIOUS control's grid and tasks over
    // the current selection. Callers that refresh a non-selected id (e.g. a strip host after an item edit) are
    // unaffected: without an intervening pick the generation doesn't move.
    const gen = this.selectionGen;
    // Also bind the SOURCE revision, not just the selection: a describe reads the live source buffer, so a newer edit
    // (commit / undo / reload bumps doc.rev) makes an in-flight describe's values stale even for the SAME selection.
    // doc.rev is used (NOT renderSeq) so a transient VIEW-STATE render — e.g. a tab-header click's skipReselect
    // fullRender — never over-rejects a describe whose source is still current. Captured right BEFORE the source is
    // sampled, with no await between, so rev + text are one consistent snapshot: currentText() is async, so a capture
    // AFTER its await could bind a newer rev (an edit committed while suspended) to the older text and accept a stale describe.
    let srcRev = this.doc.rev;
    if (this.engineKind === 'net48') { // compiled preview: describe the LIVE instance, not the net9 graph
      const asm48 = this.asm();
      let comp: ComponentDesc | null = null;
      let panelComp: ComponentDesc | null = null;
      let vendorTags: VendorTagView[] = [];
      let net48Engine: EngineHandle | null = null;
      let hostedDesignerProbe: HostedDesignerProbeResult | null = null;
      let hostedServiceKernelResult: HostedServiceKernelProductResult | null = null;
      if (asm48) {
        // pass the UNSAVED buffer so the net48 source-metadata pass (bold / wired-handler) reflects an unsaved reset /
        // wiring on a CONTROL too (parity with the item path — the same pre-existing disk-staleness, closed here).
        // …and the vendor's own declared Tasks menu (DevExpress "Add Tab Page"…), if this control's compiled type
        // ships one — net48 only, since reading it needs the real type the net9 engine can't load. Fetched CONCURRENTLY
        // with the describe on purpose: a second sequential await would widen the window in which a newer selection's
        // `tasks` post can be overtaken by this older one. Both are best-effort — a failure degrades to no vendor menu.
        srcRev = this.doc.rev; // bind the SOURCE revision (bumps on edit/undo/load, not a view render) BEFORE the sync text sample
        const text = await this.currentText();
        const codeBehindText = await this.currentCodeText();
      const eng48 = await this.ensureEngine('net48');
      net48Engine = eng48;
      await this.applyEngineLocalizationCulture(eng48);
        // when the net48 CANVAS is interpreted (live source), describe the SAME interpreted
        // instance so the panel matches the canvas on an unsaved edit; a null (unknown/inherited/non-interpreted) leaves
        // the panel UNAVAILABLE — it must NEVER fall back to compiled values under an interpreted canvas. Only a
        // compiled/fallback canvas describes the cached compiled instance.
        const interpreted = this.net48RenderMode === 'interpreted';
        const descriptionsP = Promise.all(selectionIds.map((selectionId) => interpreted
          ? describeInterpretedComponent(eng48, this.designerFile!, asm48, text ?? '', selectionId,
            undefined, undefined, undefined, undefined, codeBehindText).catch(() => null)
          : describeCompiledComponent(eng48, this.designerFile!, asm48, selectionId,
            undefined, undefined, text, codeBehindText).catch(() => null)));
        const [descriptions, v] = await Promise.all([descriptionsP, this.vendorTagsFor(id)]);
        comp = descriptions.find((description) => description?.id === id) ?? null;
        panelComp = selectionIds.length > 1
          ? (descriptions.every((description): description is ComponentDesc => description !== null)
            ? intersectMultiProperties(descriptions, id)
            : null)
          : comp;
        vendorTags = v;
        if (selectionIds.length === 1 && comp?.type === CERTIFIED_HOSTED_DESIGNER_COMPONENT)
          hostedDesignerProbe = await this.inspectHostedDesignerProduct(comp, eng48);
        if (selectionIds.length === 1 && comp)
          hostedServiceKernelResult = await this.inspectHostedServiceKernelProduct(comp, eng48);
      }
      if (this.disposed || gen !== this.selectionGen || srcRev !== this.doc.rev) return; // a newer pick OR SOURCE edit superseded this load
      this.publishHostedDesignerProbe(hostedDesignerProbe);
      this.publishHostedServiceKernelResult(hostedServiceKernelResult);
      this.publishedPropertyComponent = { ids: selectionIds, rev: srcRev, component: panelComp };
      DesignerHub.instance.pushPanel(this, { type: 'props', id, component: panelComp });
      this.post({ type: 'tasks', id, component: comp, vendorTags }); // canvas smart-tag flyout data
      // A null describe under an INTERPRETED canvas means the selection is unavailable — disable move/resize too.
      // An inherited component is the other narrow exception: ordinary component editability remains false, and the
      // canvas receives an affordance only when layout + describe agree on the same engine-issued token AND the net48
      // authority revalidates the live compiled base's geometry gate. Commit repeats this authorization.
      let manip = (comp === null && this.net48RenderMode === 'interpreted')
        ? { move: false, resize: false }
      : this.manipFor(id, comp); // single drag/resize is live (net9 splices Location/Size, net48 mutates)
      if (comp?.ownership === 'inherited') {
        manip = { move: false, resize: false };
        const layout = this.controls.find((candidate) => candidate.id === id);
        const token = comp.baseIdentityToken ?? '';
        if (net48Engine && asm48 && comp.inheritedOverrideEditable === true
          && layout?.ownership === 'inherited' && layout.inheritedGeometryOverrideEditable === true
          && token.length > 0 && layout.baseIdentityToken === token) {
          try {
            const authorization = await authorizeInheritedGeometryOverride(
              net48Engine, this.designerFile!, id, token, asm48);
            if (authorization.safe && authorization.baseIdentityToken === token)
              manip = this.manipFor(id, comp);
            else
              this.output.appendLine(`[designer] inherited geometry unavailable for ${id}: ${authorization.reason || 'invalid engine response'}`);
          } catch (e) {
            this.output.appendLine(`[designer] inherited geometry authorization failed for ${id}: ${(e as Error).message}`);
          }
        }
      }
      if (this.disposed || gen !== this.selectionGen || srcRev !== this.doc.rev) return;
      this.post({ type: 'manip', id, move: manip.move, resize: manip.resize });
      return;
    }
    const eng = await this.ensureEngine();
    srcRev = this.doc.rev; // bind the SOURCE revision BEFORE the sync text sample — see the net48 path above
    const text9 = await this.currentEngineText();
    const descriptions = await Promise.all(selectionIds.map((selectionId) =>
      describeComponent(eng, this.designerFile!, selectionId, this.asm(), text9).catch(() => null)));
    const describedComponent = descriptions.find((description) => description?.id === id) ?? null;
    const component = describedComponent && this.emptyInitializeComponentSurface
      ? { ...describedComponent, editable: false, readOnlyReason: t('designer.owner.emptyInitializeComponentReadOnly') }
      : describedComponent;
    const panelComponent = selectionIds.length > 1
      ? (descriptions.every((description): description is ComponentDesc => description !== null)
        ? intersectMultiProperties(descriptions, id)
        : null)
      : component;
    const hostedServiceKernelResult = selectionIds.length === 1 && component
      ? await this.inspectHostedServiceKernelProduct(component, eng)
      : null;
    if (this.disposed || gen !== this.selectionGen || srcRev !== this.doc.rev) return; // a newer pick OR SOURCE edit superseded this load
    this.publishHostedServiceKernelResult(hostedServiceKernelResult);
    this.publishedPropertyComponent = { ids: selectionIds, rev: srcRev, component: panelComponent };
    DesignerHub.instance.pushPanel(this, { type: 'props', id, component: panelComponent });
    // No vendor tags on net9: reading them needs the real compiled vendor type, which this engine can't load (a form
    // that uses vendor controls doesn't render here at all). Sent explicitly so the canvas clears a stale net48 menu.
    this.post({ type: 'tasks', id, component, vendorTags: [] }); // canvas smart-tag flyout data
    // Modern direct manipulation is permitted only by the live engine graph. If the RPC is absent, fails, resolves
    // another component, or reports a layout/inheritance/custom-control refusal, publish no canvas affordance. The
    // commit path repeats authorization against the then-current source, so this probe is UX metadata, not a stale grant.
    let manip = this.emptyInitializeComponentSurface
      ? { move: false, resize: false }
      : (id === 'this' || this.controls.find((c) => c.id === id)?.isRoot)
      ? this.manipFor(id, component)
      : { move: false, resize: false };
    if (!this.emptyInitializeComponentSurface && id !== 'this' && !this.controls.find((c) => c.id === id)?.isRoot) {
      try {
        const geometry = await beginGeometryDrag(eng, this.designerFile, id, this.asm(), text9);
        if (this.disposed || gen !== this.selectionGen || srcRev !== this.doc.rev) return;
        if (geometry.ok && geometry.componentId === id && geometry.logicalBounds && geometry.windowBounds) {
          manip = { move: geometry.canMove, resize: geometry.canResize };
        } else {
          this.output.appendLine(`[designer] geometry unavailable for ${id}: ${geometry.reason || 'invalid engine response'}`);
        }
      } catch (e) {
        this.output.appendLine(`[designer] geometry authorization failed for ${id}: ${(e as Error).message}`);
      }
    }
    this.post({ type: 'manip', id, move: manip.move, resize: manip.resize });
  }

  /**
   * The vendor's DECLARED Tasks menu for one control (DevExpress "XtraTabControl Tasks"), each entry tagged with
   * the verb THIS designer runs for it — or null when we have none, which the canvas shows disabled.
   *
   * The labels are the vendor's, verbatim; the actions are ours. We deliberately never invoke the vendor's own action:
   * it mutates the live component graph through a design host and nothing would carry that into .Designer.cs, so the
   * edit would silently vanish on the next rebuild — and its "Tab Pages" verb opens a modal dialog that would hang the
   * engine. Each verb below is an existing source-first path (text splice → commit → live re-render), the same one the
   * canvas context menu uses, so the vendor menu adds a faithful presentation, not a second way to mutate code.
   */
  private static readonly VENDOR_VERBS: Readonly<Record<string, 'addTab' | 'deleteTab' | 'showProperties'>> = {
    AddTabPage: 'addTab',
    RemoveTabPage: 'deleteTab',
  TabPages: 'showProperties', // the vendor opens a modal collection dialog; we open the same collection in the grid
    };

  private async vendorTagsFor(id: string): Promise<VendorTagView[]> {
    const asm = this.asm();
    if (!asm || !this.designerFile) return [];
    // Never make SELECTING a control the reason the user's real form gets constructed and realized: on an
    // interpreted preview no compiled instance exists, and asking for this optional menu used to build one — running
    // their constructor and Load. See vendorTasksAvailable; the engine peeks rather than builds as well, so this gate
    // and that one have to fail in the same direction.
    if (!vendorTasksAvailable({ engineKind: this.engineKind, net48RenderMode: this.net48RenderMode })) return [];
    let tags: VendorSmartTag[] = [];
    try {
      tags = await listCompiledVendorSmartTags(await this.ensureEngine('net48'), this.designerFile, asm, id);
    } catch { return []; } // a vendor-less control / engine hiccup → no vendor section, flyout unchanged
    return tags.map((t) => ({
      label: t.displayName,
      methodName: t.methodName,
      verb: DesignerSession.VENDOR_VERBS[t.methodName] ?? null,
      closesPanel: t.closesPanel,
    }));
  }

  /** Describe a ToolStripItem (a Component, resolved by field id) into the Properties panel via a DEDICATED `itemProps`
   * message — NOT `loadProps`. This is the item→Properties channel: it deliberately does NOT set `this.currentId`, nor
   * post `select` / `tasks` / `manip`, so the control selection (and everything it drives — manipFor, smart-tag, the
   * generic Delete/Cut/z-order target) stays on the last control. net9 resolves the item by Site.Name and renders an
   * editable grid. net48 describes the compiled item too and edits it live, so it is editable
   * whenever the item resolved; when the assembly isn't built yet describe returns null → the panel shows the
   * compiled-preview placeholder (editable=false is moot for a null component — the grid isn't rendered). */
  private async loadItemProps(ownerId: string, itemId: string): Promise<void> {
    if (!this.designerFile || this.disposed) return;
    let component: ComponentDesc | null = null;
    // Bind the SOURCE revision (parity with loadProps): a newer edit (doc.rev, NOT renderSeq — a view-state render
    // must not over-reject) supersedes an in-flight item describe whose source is now stale, even when the SAME item
    // stays selected. Captured right BEFORE the source is sampled (no await between) so rev + text are one snapshot.
    let srcRev = this.doc.rev;
    if (this.engineKind === 'net48') {
      const asm48 = this.asm();
      if (asm48) {
        // pass the UNSAVED buffer so the net48 source-metadata pass (bold / wired-handler) reflects an item's just-wired
        // event or just-reset property immediately — not the stale on-disk file. When the canvas is
        // interpreted, describe the item off the interpreted instance so it matches the interpreted canvas.
        try {
          srcRev = this.doc.rev; // bind the SOURCE revision BEFORE the sync text sample (atomic rev/text snapshot)
          const text48 = await this.currentText();
          const codeBehindText48 = await this.currentCodeText();
          const eng48i = await this.ensureEngine('net48');
          component = this.net48RenderMode === 'interpreted'
            ? await describeInterpretedComponent(eng48i, this.designerFile, asm48, text48 ?? '', itemId,
              undefined, undefined, undefined, undefined, codeBehindText48)
            : await describeCompiledComponent(eng48i, this.designerFile, asm48, itemId,
              undefined, undefined, text48, codeBehindText48);
        }
        catch { component = null; }
      }
    } else {
      const eng = await this.ensureEngine();
      try {
        srcRev = this.doc.rev; // bind the SOURCE revision BEFORE the sync text sample (atomic rev/text snapshot)
        const t9 = await this.currentText();
        component = await describeComponent(eng, this.designerFile, itemId, this.asm(), t9);
      }
      catch { component = null; }
    }
    if (this.disposed || srcRev !== this.doc.rev) return; // a newer SOURCE edit superseded this item load
    // Drop a STALE refresh: if the current item selection moved to a different item (or to a control) while this describe
    // was in flight, pushing itemProps now would silently revert the panel to the old item behind a newer selection
    // (canvas dispatch isn't serialized. The fresh selectItem sets currentSelItem to THIS item first, so
    // it always passes; only a delayed reset/wire/edit refresh for a superseded item is dropped.
    if (!this.currentSelItem || this.currentSelItem.ownerId !== ownerId || this.currentSelItem.itemId !== itemId) return;
    // Both engines edit a resolved item now (the net48 live-edit primitive was widened to a non-Control
    // component). A net48 describe miss (assembly not built) → null → placeholder; editable is moot there.
    const editable = component != null;
    DesignerHub.instance.pushPanel(this, { type: 'itemProps', id: itemId, ownerId, component, editable });
  }

  /**
   * Host-side manipulability (was computed in the webview; the canvas now just receives booleans): the FORM
   * resizes (ClientSize) but can't move; a normal child moves + resizes when author-positioned; a Docked /
   * layout-panel child does neither; an AutoSize child moves but doesn't resize.
   */
  private manipFor(id: string, component: ComponentDesc | null): { move: boolean; resize: boolean } {
    const c = this.controls.find((x) => x.id === id);
    if (id === 'this' || c?.isRoot) return { move: false, resize: true };
    const props = component?.properties ?? [];
    const val = (n: string): string | null => { const p = props.find((q) => q.name === n); return p ? (p.value ?? null) : null; };
    const dock = val('Dock');
    if (dock && dock !== 'None') {
      return { move: false, resize: dock !== 'Fill' && String(val('AutoSize')) !== 'True' };
    }
    if (c?.parentId) {
      const par = this.controls.find((x) => x.id === c.parentId);
      if (par && /TableLayoutPanel/.test(par.type)) {
        const liveGrid = this.engineKind === 'modern'
          && (par.tableColumnWidths?.length ?? 0) > 0 && (par.tableRowHeights?.length ?? 0) > 0;
        return { move: liveGrid, resize: false };
      }
      if (par && /FlowLayoutPanel/.test(par.type)) {
        return { move: this.engineKind === 'modern' && !!par.flowDirection, resize: false };
      }
    }
    return { move: true, resize: String(val('AutoSize')) !== 'True' };
  }

  /**
   * Commit one net48 canvas geometry transaction into source. Current-source controls keep the existing Roslyn
   * SetProperty path. Inherited controls instead require matching describe/layout capabilities, a fresh compiled-base
   * authorization, and the dedicated derived-source override writer. Every edit is prepared against a local text
   * snapshot first, so a refusal or stale document publishes no partial source.
   */
  private async applyNet48GeometryEdits(
    label: string,
    edits: Array<{ id: string; prop: 'Location' | 'Size'; propType: 'System.Drawing.Point' | 'System.Drawing.Size'; value: string }>,
  ): Promise<boolean> {
    if (!this.designerFile || this.disposed || this.engineKind !== 'net48' || !edits.length) return false;
    if (this.localizable) {
      this.post({ type: 'status', message: t('status.editRejected', { reason: 'localized inherited geometry overrides are not supported' }) });
      await this.loadProps(this.currentId);
      return false;
    }
    const assemblyPath = this.asm();
    if (!assemblyPath) {
      this.post({ type: 'status', message: t('status.editRejected', { reason: 'control assembly not found' }) });
      return false;
    }

    const before = this.doc.designerText;
    const rev = this.doc.rev;
    const codeBehindBefore = await this.currentCodeText();
    const converter = await this.ensureEngine('modern');
    const authority = await this.ensureEngine('net48');
    let text = before;
    let hasInherited = false;
    const liveEdits: CompiledEdit[] = [];
    const authorizedInherited = new Set<string>();

    const refuse = async (reason: string): Promise<boolean> => {
      this.post({ type: 'status', message: t('status.editRejected', { reason }) });
      await this.loadProps(this.currentId);
      return false;
    };

    for (const edit of edits) {
      const component = await this.describeFor(edit.id);
      if (this.doc.rev !== rev) {
        this.post({ type: 'status', message: t('status.docChanged') });
        await this.loadProps(this.currentId);
        return false;
      }
      const property = component?.properties.find((candidate) => candidate.name === edit.prop) ?? null;
      if (!component || !property || property.type !== edit.propType || property.readOnly)
        return refuse(`${edit.id}.${edit.prop} is not editable in the current net48 description`);

      const expression = await convertValue(converter, edit.propType, edit.value);
      if (expression === null)
        return refuse(`cannot convert ${edit.id}.${edit.prop} to ${edit.propType}`);

      if (component.ownership === 'inherited') {
        const layout = this.controls.find((candidate) => candidate.id === edit.id);
        const token = component.baseIdentityToken ?? '';
        const metadataSafe = component.editable === false && component.inheritedOverrideEditable === true
          && property.inheritedOverrideEditable === true
          && layout?.ownership === 'inherited' && layout.inheritedGeometryOverrideEditable === true
          && token.length > 0 && layout.baseIdentityToken === token;
        if (!metadataSafe)
          return refuse(`stale or incompatible inherited geometry metadata for ${edit.id}`);

        if (!authorizedInherited.has(edit.id)) {
          const authorization = await authorizeInheritedGeometryOverride(
            authority, this.designerFile, edit.id, token, assemblyPath);
          if (!authorization.safe || authorization.baseIdentityToken !== token)
            return refuse(authorization.reason || `inherited geometry authorization failed for ${edit.id}`);
          authorizedInherited.add(edit.id);
        }

        const result = await applyInheritedPropertyOverride(
          authority, this.designerFile, edit.id, edit.prop, expression, token, assemblyPath, text,
          codeBehindBefore);
        if (!result.safe || result.text === null)
          return refuse(result.reason || `unsafe inherited override for ${edit.id}.${edit.prop}`);
        text = result.text;
        hasInherited = true;
        continue;
      }

      if (component.ownership !== 'currentSource' || component.editable === false)
        return refuse(`${edit.id} is not a current-source editable control`);
      const result = await setProperty(converter, this.designerFile, edit.id, edit.prop, expression, text);
      if (!result.safe || result.text === null)
        return refuse(result.reason || `unsafe geometry edit for ${edit.id}.${edit.prop}`);
      text = result.text;
      liveEdits.push({ componentId: edit.id, propName: edit.prop, rawValue: edit.value });
    }

    if (this.doc.rev !== rev) {
      this.post({ type: 'status', message: t('status.docChanged') });
      await this.loadProps(this.currentId);
      return false;
    }
    if (await this.currentCodeText() !== codeBehindBefore)
      return refuse('the code-behind changed while inherited geometry was being authorized');
    if (text === before) {
      await this.loadProps(this.currentId);
      return false;
    }
    if (!this.commit(before, text, label)) return false;
    if (hasInherited) await this.fullRender();
    else await this.live48((engine) => applyCompiledEdits(
      engine, this.designerFile!, assemblyPath, liveEdits), true, { skipReselect: true, edits: liveEdits });
    await this.loadProps(this.currentId);
    await this.postDirty();
    return true;
  }

  /** The container a toolbox-added control should go into: the selected Panel/GroupBox/… or the form. */
  private containerParentFor(id: string): string {
    let c = id ? this.controls.find((x) => x.id === id) : null;
    while (c) {
      if (c.id === 'this' || c.isRoot) return 'this';
      if (/Panel|GroupBox|TabPage|FlowLayoutPanel|TableLayoutPanel/.test(c.type)) return c.id;
      c = c.parentId ? this.controls.find((x) => x.id === c?.parentId) ?? null : null;
    }
    return 'this';
  }

  public async reparentFromOutline(id: string, parentId: string): Promise<void> {
    await this.applyReparent(id, parentId);
  }

  public async zOrderFromOutline(id: string, toFront: boolean): Promise<void> {
    await this.applyZOrder([id], toFront);
  }

  private outlineFlagged(c: LayoutControl): boolean {
    const flags = c as LayoutControl & { readOnly?: boolean; inherited?: boolean; isInherited?: boolean };
    return !!(flags.readOnly || flags.inherited || flags.isInherited || c.editable === false
      || c.ownership === 'inherited' || c.ownership === 'unresolved');
  }

  private outlineSupportedContainer(c: LayoutControl): boolean {
    return c.isRoot || /Panel|GroupBox|TabPage|FlowLayoutPanel|TableLayoutPanel/.test(c.type);
  }

  private outlineHasChildren(id: string): boolean {
    return this.controls.some((c) => c.parentId === id);
  }

  private outlineIsAncestor(ancestorId: string, id: string): boolean {
    let cur = this.controls.find((c) => c.id === id);
    while (cur?.parentId) {
      if (cur.parentId === ancestorId) return true;
      cur = this.controls.find((c) => c.id === cur?.parentId);
    }
    return false;
  }

  private outlineReparentReason(id: string, parentId: string): string {
    const child = this.controls.find((c) => c.id === id);
    const parent = this.controls.find((c) => c.id === parentId);
    if (!child || !parent) return 'layout changed';
    if (child.isRoot || id === 'this' || this.outlineFlagged(child)) return 'control cannot be moved';
    if (this.outlineFlagged(parent)) return 'target cannot accept moved controls';
    if (id === parentId) return 'cannot move a control into itself';
    if (this.outlineIsAncestor(id, parentId)) return 'cannot move a control into its own child';
    if (this.outlineHasChildren(id)) return 'move child controls first';
    if (!this.outlineSupportedContainer(parent)) return 'target is not a supported container';
    return '';
  }

  private async applyReparent(id: string, parentId: string): Promise<void> {
    if (!this.designerFile || this.disposed) return;
    if (this.localizable && this.localizationCulture !== '') {
      this.post({ type: 'status', message: t('status.editRejected', { reason: 'switch Language to (Default) before reparenting controls' }) });
      return;
    }
    const reason = this.outlineReparentReason(id, parentId);
    if (reason) { this.post({ type: 'status', message: t('status.editRejected', { reason }) }); return; }
    const eng = await this.ensureEngine();
    await this.applyEngineLocalizationCulture(eng);
    const before = this.doc.designerText;
    const rev = this.doc.rev;
    // VS preserves the control's full-frame position when it moves between containers, which means the serialized
    // Location must be rebased to the destination's client origin. The outline only sends the two identities; the
    // current engine layout is the authority for geometry, never a client-authored source value.
    const child = this.controls.find((control) => control.id === id)!;
    const parent = this.controls.find((control) => control.id === parentId)!;
    const locX = Math.round(child.x - (parent.clientX ?? parent.x));
    const locY = Math.round(child.y - (parent.clientY ?? parent.y));
    // A Localizable=true form has no direct Location assignment to rewrite: VS keeps the membership change in
    // generated source and the rebased point in the neutral resource set. Ask the source engine for membership-only
    // reparenting in that lane; ordinary forms keep the existing atomic membership+Location source edit.
    const res = this.localizable
      ? await reparentControl(eng, this.designerFile, id, parentId, before)
      : await reparentControl(eng, this.designerFile, id, parentId, before, locX, locY);
    if (!res.safe || res.newText === null) {
      this.post({ type: 'status', message: t('status.editRejected', { reason: res.reason || 'unsafe reparent' }) });
      return;
    }
    if (res.newText === before) { this.post({ type: 'status', message: t('status.editRejected', { reason: 'already in that container' }) }); return; }
    if (this.doc.rev !== rev) { this.post({ type: 'status', message: t('status.docChanged') }); return; }
    if (this.localizable) {
      const localizedSource = res.newText;
      if (new RegExp('\\bthis\\.' + escapeRegex(id) + '\\.Location\\s*=').test(localizedSource)) {
        this.post({ type: 'status', message: t('status.editRejected', { reason: 'localized Location remained in generated source' }) });
        return;
      }
      const resxUri = this.localizedResxUri('');
      const resxRead = await this.readResx(resxUri);
      if (resxRead == null) {
        this.post({ type: 'status', message: t('status.editRejected', { reason: 'neutral resource file is unavailable' }) });
        return;
      }
      const resource = await setLocalizedResources(eng, this.designerFile, '', resxRead.text, [{
        componentId: id,
        propertyName: 'Location',
        propertyTypeName: 'System.Drawing.Point',
        invariantValue: `${locX}, ${locY}`,
      }]);
      if (!resource.safe || resource.resxText == null) {
        this.post({ type: 'status', message: t('status.editRejected', { reason: resource.reason || 'localized Location update was refused' }) });
        return;
      }
      if (this.doc.rev !== rev || this.localizationCulture !== '' || !this.localizable) {
        this.post({ type: 'status', message: t('status.docChanged') });
        return;
      }
      const tx: ResxTx = { uri: resxUri, before: resxRead.text, after: resource.resxText, bom: resxRead.hadBom };
      try {
        const committed = await this.commitResourceSetThroughRunner(`Reparent localized ${id}`, [tx], before, localizedSource, {
          persistDesignerTextBeforeCommit: true,
          expectedDesignerRevision: rev,
        });
        if (!committed || committed.status !== 'committed')
          throw new Error(committed?.error ?? committed?.status ?? 'journal unavailable');
      } catch (error) {
        this.output.appendLine('[designer] localized reparent refused: ' + errMsg(error));
        this.post({ type: 'status', message: t('status.editRejected', { reason: errMsg(error) }) });
        return;
      }
      this.currentId = id;
      this.currentSelectionIds = [id];
      this.output.appendLine(`reparented localized ${id} to ${parentId}; Location=${locX},${locY}`);
      await this.fullRender();
      this.post({ type: 'status', message: `Moved ${id}` });
      return;
    }
    if (!this.commit(before, res.newText, `Reparent ${id}`)) return;
    this.currentId = id;
    this.currentSelectionIds = [id];
    this.output.appendLine(`reparented ${id} to ${parentId} (unsaved)`);
    await this.fullRender();
    this.post({ type: 'status', message: `Moved ${id}` });
  }

  /**
   * Apply one or more modern-engine geometry intents as a single source transaction. Every component is authorized
   * and committed against the evolving, still-local text; one refusal rejects the whole batch before commit(), so a
   * multi-selection can never land partially. The client preview only supplies an intent/candidate. The only text
   * allowed into commit() is GeometryCommitResult.designerText returned for the engine-corrected live bounds.
   */
  private async applyModernGeometryTransaction(
    label: string,
    intents: Array<{
      id: string;
      mode: 'move' | 'resize';
      candidate: (start: GeometryDragStartResult) => GeometryRect | null;
    }>,
  ): Promise<number | null> {
    if (!this.designerFile || this.disposed || this.engineKind !== 'modern' || !intents.length) return null;
    const eng = await this.ensureEngine('modern');
    await this.applyEngineLocalizationCulture(eng);
    const before = this.doc.designerText;
    const rev = this.doc.rev;

    const reject = async (id: string, reason: string): Promise<null> => {
      const why = reason || 'engine did not authorize the geometry edit';
      this.output.appendLine(`[designer] geometry edit refused for ${id}: ${why}`);
      this.post({ type: 'status', message: t('status.editRejected', { reason: why }) });
      // Keyboard nudges mutate the webview's local layout while mouse gestures move selection overlays. A fresh render
      // is therefore part of fail-closed rejection: it restores the last authoritative graph instead of leaving a
      // client preview that looks committed.
      await this.fullRender();
      return null;
    };

    let authorized: Awaited<ReturnType<typeof authorizeGeometryBatch>>;
    try {
      authorized = await authorizeGeometryBatch(eng, this.designerFile, intents, this.asm(), before);
      if (!authorized.ok) return await reject(authorized.failedId ?? intents[0]?.id ?? '', authorized.reason);
    } catch (e) {
      // Modern geometry has deliberately no setProperty/client-authored fallback. An engine/RPC failure is a refusal.
      return await reject(intents[0]?.id ?? '', (e as Error).message || 'geometry RPC failed');
    }

    if (this.doc.rev !== rev) {
      this.post({ type: 'status', message: t('status.docChanged') });
      await this.fullRender();
      return null;
    }
    if (this.localizable) {
      const values = authorized.sourceValues ?? [];
      if (values.some((value) => !value.propertyTypeName || value.invariantValue === undefined)) {
        return await reject(intents[0]?.id ?? '', 'engine did not return typed localized geometry values');
      }
      if (!values.length) {
        await this.fullRender();
        return 0;
      }
      const ok = await this.applyLocalizedResourceEdits(label, values.map((value) => ({
        componentId: value.componentId,
        propertyName: value.propertyName,
        propertyTypeName: value.propertyTypeName!,
        invariantValue: value.invariantValue!,
      })), rev);
      if (!ok) {
        await this.fullRender();
        return null;
      }
      return authorized.appliedCount;
    }
    if (authorized.designerText === null) {
      await this.fullRender();
      return 0;
    }
    if (!this.commit(before, authorized.designerText, label)) {
      await this.fullRender();
      return null;
    }
    await this.fullRender(); // renders engine-corrected bounds from the authoritative returned source
    return authorized.appliedCount;
  }

  private async applyManipulate(
    id: string,
    mode: string,
    winX: number,
    winY: number,
    w: number,
    h: number,
    dropX?: number,
    dropY?: number,
  ): Promise<void> {
    if (!this.designerFile || this.disposed) return;
    const old = this.controls.find((c) => c.id === id);
    if (!old) return;
    // Root resizing is a ClientSize transaction, not a child Bounds transaction. The geometry RPC intentionally
    // refuses root direct manipulation, so preserve the proven engine-converted ClientSize route on both engines.
    if (id === 'this' || old.isRoot) {
      if (mode !== 'resize' || !this.rootClient) return;
      const nw = Math.max(1, this.rootClient.w + Math.round(w - old.width));
      const nh = Math.max(1, this.rootClient.h + Math.round(h - old.height));
      await this.applyEdit(id, 'ClientSize', 'System.Drawing.Size', false, `${nw}, ${nh}`);
      return;
    }
    if (mode === 'move' && this.engineKind === 'modern') {
      const managed = await this.applyManagedLayoutMove(
        id,
        Number.isFinite(dropX) ? dropX! : winX + w / 2,
        Number.isFinite(dropY) ? dropY! : winY + h / 2,
      );
      if (managed !== null) return;
    }
    if (this.engineKind === 'modern') {
      if (mode !== 'move' && mode !== 'resize') return;
      const windowCandidate = { x: Math.round(winX), y: Math.round(winY), width: Math.round(w), height: Math.round(h) };
      const applied = await this.applyModernGeometryTransaction(
        `${mode === 'resize' ? 'Resize' : 'Move'} ${id}`,
        [{ id, mode, candidate: (start) => geometryCandidateFromWindow(start, windowCandidate) }],
      );
      if (applied && applied > 0) {
        this.output.appendLine(`${mode === 'resize' ? 'resized' : 'moved'} ${id} with engine-authoritative bounds (unsaved)`);
        this.post({ type: 'status', message: mode === 'resize' ? tn('status.resized', 1) : tn('status.moved', 1) });
      }
      return;
    }
    if (old.ownership === 'inherited' && this.localizable) {
      this.post({ type: 'status', message: t('status.editRejected', { reason: 'localized inherited geometry overrides are not supported' }) });
      await this.loadProps(id);
      return;
    }
    if (mode === 'resize') {
      const resizeComponent = await this.describeFor(id);
      const dock = resizeComponent?.properties?.find((p) => p.name === 'Dock')?.value ?? 'None';
      // WinForms keeps one author-sized dimension for docked controls. Mirror the modern engine's live correction on
      // net48: Left/Right persist Width, Top/Bottom persist Height, while layout-owned position/other axis stay intact.
      if (dock === 'Left' || dock === 'Right') {
        winX = old.x; winY = old.y; h = old.height;
      } else if (dock === 'Top' || dock === 'Bottom') {
        winX = old.x; winY = old.y; w = old.width;
      } else if (dock === 'Fill') {
        return;
      }
      const movedTopLeft = Math.round(winX) !== Math.round(old.x) || Math.round(winY) !== Math.round(old.y);
      if (movedTopLeft) {
        const comp = await this.describeFor(id);
        const loc = parsePair(comp?.properties?.find((p) => p.name === 'Location')?.value);
        if (loc) {
          const nx = loc[0] + Math.round(winX - old.x);
          const ny = loc[1] + Math.round(winY - old.y);
          if (this.localizable) {
            await this.applyEdits(id, [
              { prop: 'Location', propType: 'System.Drawing.Point', value: `${nx}, ${ny}` },
              { prop: 'Size', propType: 'System.Drawing.Size', value: `${Math.round(w)}, ${Math.round(h)}` },
            ]);
          } else {
            const applied = await this.applyNet48GeometryEdits(`Resize ${id}`, [
              { id, prop: 'Location', propType: 'System.Drawing.Point', value: `${nx}, ${ny}` },
              { id, prop: 'Size', propType: 'System.Drawing.Size', value: `${Math.round(w)}, ${Math.round(h)}` },
            ]);
            if (applied) {
              this.output.appendLine(`resized ${id} through token-checked net48 source geometry (unsaved)`);
              this.post({ type: 'status', message: tn('status.resized', 1) });
            }
          }
          return;
        }
      }
      if (this.localizable)
        await this.applyEdit(id, 'Size', 'System.Drawing.Size', false, `${Math.round(w)}, ${Math.round(h)}`);
      else if (await this.applyNet48GeometryEdits(`Resize ${id}`, [
        { id, prop: 'Size', propType: 'System.Drawing.Size', value: `${Math.round(w)}, ${Math.round(h)}` },
      ])) {
        this.output.appendLine(`resized ${id} through token-checked net48 source geometry (unsaved)`);
        this.post({ type: 'status', message: tn('status.resized', 1) });
      }
    } else {
      const comp = await this.describeFor(id);
      const loc = parsePair(comp?.properties?.find((p) => p.name === 'Location')?.value);
      if (!loc) return;
      const nx = loc[0] + Math.round(winX - old.x);
      const ny = loc[1] + Math.round(winY - old.y);
      if (this.localizable)
        await this.applyEdit(id, 'Location', 'System.Drawing.Point', false, `${nx}, ${ny}`);
      else if (await this.applyNet48GeometryEdits(`Move ${id}`, [
        { id, prop: 'Location', propType: 'System.Drawing.Point', value: `${nx}, ${ny}` },
      ])) {
        this.output.appendLine(`moved ${id} through token-checked net48 source geometry (unsaved)`);
        this.post({ type: 'status', message: tn('status.moved', 1) });
      }
    }
  }

  /**
   * Move several controls together (multi-select group drag): each control's Location += the window-space
   * delta (its parent's origin is constant during a drag), chained into ONE undoable edit + a single
   * re-render. Modern authorizes every member and rejects the whole batch when one is layout-managed; net48 keeps
   * its established best-effort behavior for controls without a representable Location.
   */
  private async applyGroupMove(ids: string[], dx: number, dy: number): Promise<void> {
    if (!this.designerFile || this.disposed) return;
    const movable = ids.filter((id) => id && id !== 'this');
    if (!movable.length || (Math.round(dx) === 0 && Math.round(dy) === 0)) return;
    if (this.engineKind === 'modern') {
      const mx = Math.round(dx), my = Math.round(dy);
      const applied = await this.applyModernGeometryTransaction(
        `Move ${movable.length} control${movable.length > 1 ? 's' : ''}`,
        movable.map((id) => ({
          id,
          mode: 'move' as const,
          candidate: (start: GeometryDragStartResult): GeometryRect | null => start.logicalBounds ? {
            x: start.logicalBounds.x + mx,
            y: start.logicalBounds.y + my,
            width: start.logicalBounds.width,
            height: start.logicalBounds.height,
          } : null,
        })),
      );
      if (applied && applied > 0) {
        this.output.appendLine(`moved ${applied} controls by (${mx}, ${my}) with engine-authoritative bounds (unsaved)`);
        this.post({ type: 'status', message: tn('status.moved', applied) });
      } else if (applied === 0) {
        this.post({ type: 'status', message: t('status.nothingMoved') });
      }
      return;
    }
    if (this.localizable) {
      if (movable.some((id) => this.controls.find((control) => control.id === id)?.ownership === 'inherited')) {
        this.post({ type: 'status', message: t('status.editRejected', { reason: 'localized inherited geometry overrides are not supported' }) });
        return;
      }
      const revBefore = this.doc.rev;
      const localized: LocalizedResourceEdit[] = [];
      for (const id of movable) {
        const comp = await this.describeFor(id);
        const loc = parsePair(comp?.properties?.find((p) => p.name === 'Location')?.value);
        if (!loc) continue;
        localized.push({
          componentId: id,
          propertyName: 'Location',
          propertyTypeName: 'System.Drawing.Point',
          invariantValue: `${loc[0] + Math.round(dx)}, ${loc[1] + Math.round(dy)}`,
        });
      }
      if (!localized.length) { this.post({ type: 'status', message: t('status.nothingMoved') }); return; }
      if (await this.applyLocalizedResourceEdits(`Move ${localized.length} localized controls`, localized, revBefore)) {
        this.output.appendLine(`moved ${localized.length} localized controls by (${Math.round(dx)}, ${Math.round(dy)})`);
        this.post({ type: 'status', message: tn('status.moved', localized.length) });
      }
      return;
    }
    const sourceEdits: Array<{ id: string; prop: 'Location'; propType: 'System.Drawing.Point'; value: string }> = [];
    for (const id of movable) {
      const comp = await this.describeFor(id);
      const loc = parsePair(comp?.properties?.find((p) => p.name === 'Location')?.value);
      if (!loc) continue; // layout-managed / no representable Location → skip
      const value = `${loc[0] + Math.round(dx)}, ${loc[1] + Math.round(dy)}`;
      sourceEdits.push({ id, prop: 'Location', propType: 'System.Drawing.Point', value });
    }
    const applied = sourceEdits.length;
    if (!applied) { this.post({ type: 'status', message: t('status.nothingMoved') }); await this.loadProps(this.currentId); return; }
    if (!await this.applyNet48GeometryEdits(`Move ${applied} control${applied > 1 ? 's' : ''}`, sourceEdits)) return;
    this.output.appendLine(`moved ${applied} controls by (${Math.round(dx)}, ${Math.round(dy)}) through token-checked net48 source geometry (unsaved)`);
    this.post({ type: 'status', message: tn('status.moved', applied) });
  }

  /**
   * Center-in-form (VS Format → Center Horizontally / Vertically): shift the selection's bounding box to the
   * center of its container's CLIENT area along one axis, preserving relative offsets (the same window-space
   * delta for every selected control → reuses applyAlign for the actual Location edits, so it's one undo,
   * cross-runtime, and layout-managed controls are skipped). The engine supplies exact client rectangles for the
   * root and every nested container, so captions, borders, DPI and nesting do not enter the browser calculation.
   */
  private async applyCenterInForm(axis: 'h' | 'v', ids: string[]): Promise<void> {
    if (!this.designerFile || this.disposed) return;
    const sel = ids
      .map((id) => this.controls.find((c) => c.id === id))
      .filter((c): c is LayoutControl => !!c && !c.isRoot && c.id !== 'this');
    if (!sel.length) return;
    // container reference rect in window space
    const primary = sel.find((c) => c.id === this.currentId) ?? sel[0];
    const parentId = primary.parentId ?? 'this';
    if (sel.some((c) => (c.parentId ?? 'this') !== parentId)) return;
    const cont = this.controls.find((c) => c.id === (parentId || 'this'));
    if (!cont) return;
    // Visual Studio's Format.CenterHorizontally/Vertically uses the parent's complete ClientRectangle. Padding
    // constrains layout engines and DisplayRectangle, but does not offset or shrink these explicit Format commands.
    // The actual VS 18.7 S031 trace proves a 241px Panel and 80px Button center at X=80 even with asymmetric
    // Padding(10,0,20,0): floor((241 - 80) / 2), not the former padding-adjusted X=76 hypothesis.
    const cx = cont.clientX ?? cont.x;
    const cy = cont.clientY ?? cont.y;
    const cw = Math.max(0, cont.clientWidth ?? cont.width);
    const ch = Math.max(0, cont.clientHeight ?? cont.height);
    // bounding box of the selection (window space) → the single delta that centers it in the container
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const c of sel) { minX = Math.min(minX, c.x); minY = Math.min(minY, c.y); maxX = Math.max(maxX, c.x + c.width); maxY = Math.max(maxY, c.y + c.height); }
    const edits: Array<{ id: string; dx: number; dy: number }> = [];
    if (axis === 'h') {
      // WinForms rectangle arithmetic is integer arithmetic: an odd remainder is truncated toward zero (80.5 -> 80),
      // not rounded away from zero as JavaScript Math.round would do.
      const dx = Math.round(cx + Math.trunc((cw - (maxX - minX)) / 2) - minX);
      if (dx !== 0) for (const c of sel) edits.push({ id: c.id, dx, dy: 0 });
    } else {
      const dy = Math.round(cy + Math.trunc((ch - (maxY - minY)) / 2) - minY);
      if (dy !== 0) for (const c of sel) edits.push({ id: c.id, dx: 0, dy });
    }
    if (edits.length) await this.applyAlign(edits);
  }

  /**
   * Align (Phase 2): apply a PER-CONTROL window-space delta to each control's Location (its parent origin is
   * constant), chained into ONE undoable edit + a single re-render — like applyGroupMove but with distinct
   * deltas. Modern rejects an unauthorized member atomically; net48 keeps its established best-effort skip behavior.
   */
  private async applyAlign(edits: Array<{ id: string; dx: number; dy: number }>): Promise<void> {
    if (!this.designerFile || this.disposed) return;
    const wanted = edits.filter((e) => e.id && e.id !== 'this' && (Math.round(e.dx) !== 0 || Math.round(e.dy) !== 0));
    if (!wanted.length) return;
    if (this.engineKind === 'modern') {
      const applied = await this.applyModernGeometryTransaction(
        `Align ${wanted.length} control${wanted.length > 1 ? 's' : ''}`,
        wanted.map((e) => ({
          id: e.id,
          mode: 'move' as const,
          candidate: (start: GeometryDragStartResult): GeometryRect | null => start.logicalBounds ? {
            x: start.logicalBounds.x + Math.round(e.dx),
            y: start.logicalBounds.y + Math.round(e.dy),
            width: start.logicalBounds.width,
            height: start.logicalBounds.height,
          } : null,
        })),
      );
      if (applied && applied > 0) {
        this.output.appendLine(`aligned ${applied} controls with engine-authoritative bounds (unsaved)`);
        this.post({ type: 'status', message: tn('status.aligned', applied) });
      } else if (applied === 0) {
        this.post({ type: 'status', message: t('status.nothingAligned') });
      }
      return;
    }
    if (this.localizable) {
      if (wanted.some((edit) => this.controls.find((control) => control.id === edit.id)?.ownership === 'inherited')) {
        this.post({ type: 'status', message: t('status.editRejected', { reason: 'localized inherited geometry overrides are not supported' }) });
        return;
      }
      const revBefore = this.doc.rev;
      const localized: LocalizedResourceEdit[] = [];
      for (const edit of wanted) {
        const comp = await this.describeFor(edit.id);
        const loc = parsePair(comp?.properties?.find((p) => p.name === 'Location')?.value);
        if (!loc) continue;
        localized.push({
          componentId: edit.id,
          propertyName: 'Location',
          propertyTypeName: 'System.Drawing.Point',
          invariantValue: `${loc[0] + Math.round(edit.dx)}, ${loc[1] + Math.round(edit.dy)}`,
        });
      }
      if (!localized.length) { this.post({ type: 'status', message: t('status.nothingAligned') }); return; }
      if (await this.applyLocalizedResourceEdits(`Align ${localized.length} localized controls`, localized, revBefore)) {
        this.output.appendLine(`aligned ${localized.length} localized controls`);
        this.post({ type: 'status', message: tn('status.aligned', localized.length) });
      }
      return;
    }
    const sourceEdits: Array<{ id: string; prop: 'Location'; propType: 'System.Drawing.Point'; value: string }> = [];
    for (const e of wanted) {
      const comp = await this.describeFor(e.id);
      const loc = parsePair(comp?.properties?.find((p) => p.name === 'Location')?.value);
      if (!loc) continue; // layout-managed / no representable Location → skip
      const value = `${loc[0] + Math.round(e.dx)}, ${loc[1] + Math.round(e.dy)}`;
      sourceEdits.push({ id: e.id, prop: 'Location', propType: 'System.Drawing.Point', value });
    }
    const applied = sourceEdits.length;
    if (!applied) { this.post({ type: 'status', message: t('status.nothingAligned') }); await this.loadProps(this.currentId); return; }
    if (!await this.applyNet48GeometryEdits(`Align ${applied} control${applied > 1 ? 's' : ''}`, sourceEdits)) return;
    this.output.appendLine(`aligned ${applied} controls through token-checked net48 source geometry (unsaved)`);
    this.post({ type: 'status', message: tn('status.aligned', applied) });
  }

  /**
   * Make-same-size (Phase 2): apply a target Size to each control, chained into ONE undoable edit + a single
   * re-render — like applyAlign but writing Size instead of Location. Modern rejects an unauthorized member
   * atomically; net48 retains the existing targeted-edit behavior.
   */
  private async applyResize(edits: Array<{ id: string; width: number; height: number }>): Promise<void> {
    if (!this.designerFile || this.disposed) return;
    const wanted = edits.filter((e) => e.id && e.id !== 'this' && Math.round(e.width) > 0 && Math.round(e.height) > 0);
    if (!wanted.length) return;
    if (this.engineKind === 'modern') {
      const applied = await this.applyModernGeometryTransaction(
        `Resize ${wanted.length} control${wanted.length > 1 ? 's' : ''}`,
        wanted.map((e) => ({
          id: e.id,
          mode: 'resize' as const,
          candidate: (start: GeometryDragStartResult): GeometryRect | null => start.logicalBounds ? {
            x: start.logicalBounds.x,
            y: start.logicalBounds.y,
            width: Math.round(e.width),
            height: Math.round(e.height),
          } : null,
        })),
      );
      if (applied && applied > 0) {
        this.output.appendLine(`resized ${applied} controls with engine-authoritative bounds (unsaved)`);
        this.post({ type: 'status', message: tn('status.resized', applied) });
      } else if (applied === 0) {
        this.post({ type: 'status', message: t('status.nothingResized') });
      }
      return;
    }
    if (this.localizable) {
      if (wanted.some((edit) => this.controls.find((control) => control.id === edit.id)?.ownership === 'inherited')) {
        this.post({ type: 'status', message: t('status.editRejected', { reason: 'localized inherited geometry overrides are not supported' }) });
        return;
      }
      const revBefore = this.doc.rev;
      const localized = wanted.map((edit): LocalizedResourceEdit => ({
        componentId: edit.id,
        propertyName: 'Size',
        propertyTypeName: 'System.Drawing.Size',
        invariantValue: `${Math.round(edit.width)}, ${Math.round(edit.height)}`,
      }));
      if (await this.applyLocalizedResourceEdits(`Resize ${localized.length} localized controls`, localized, revBefore)) {
        this.output.appendLine(`resized ${localized.length} localized controls`);
        this.post({ type: 'status', message: tn('status.resized', localized.length) });
      }
      return;
    }
    const sourceEdits = wanted.map((edit) => ({
      id: edit.id,
      prop: 'Size' as const,
      propType: 'System.Drawing.Size' as const,
      value: `${Math.round(edit.width)}, ${Math.round(edit.height)}`,
    }));
    const applied = sourceEdits.length;
    if (!await this.applyNet48GeometryEdits(`Resize ${applied} control${applied > 1 ? 's' : ''}`, sourceEdits)) return;
    this.output.appendLine(`resized ${applied} controls through token-checked net48 source geometry (unsaved)`);
    this.post({ type: 'status', message: tn('status.resized', applied) });
  }

  /**
   * Remove several controls (multi-select group delete): chain removeControl over the evolving text; controls
   * the engine refuses (a container with children, or referenced elsewhere) are skipped. One undoable edit.
   */
  private async applyGroupRemove(ids: string[]): Promise<void> {
    if (!this.designerFile || this.disposed) return;
    const removable = ids.filter((id) => id && id !== 'this');
    if (!removable.length) return;
    if (this.localizable) {
      await this.applyLocalizedStructuralRemove(removable, `Remove ${removable.length} localized controls`);
      return;
    }
    const eng = await this.ensureEngine();
    const before = this.doc.designerText;
    const rev = this.doc.rev;
    let text = before;
    const removed: string[] = [];
    for (const id of removable) {
      const res = await removeControl(eng, this.designerFile, id, text);
      if (res.safe && res.newText !== null) { text = res.newText; removed.push(id); }
    }
    const applied = removed.length;
    if (!applied) { this.post({ type: 'status', message: t('status.removeRejectedNothing') }); return; }
    if (this.doc.rev !== rev) { this.post({ type: 'status', message: t('status.docChanged') }); return; }
    if (!this.commit(before, text, `Remove ${applied} control${applied > 1 ? 's' : ''}`)) return;
    this.currentId = 'this';
    this.currentSelectionIds = ['this'];
    this.output.appendLine(`removed ${applied} controls (unsaved)`);
    if (this.engineKind === 'net48') await this.live48((e) => removeCompiledControls(e, this.designerFile!, this.asm()!, removed), true, {});
    else await this.fullRender();
    this.post({ type: 'status', message: tn('status.removed', applied) });
  }

  /** Grid edit from the Properties view, with its own error/restore handling. */
  async editFromGrid(id: string, prop: string, propType: string, isEnum: boolean, value: string,
    refEdit = false, designTime = false, multi = false): Promise<void> {
    try {
      if (multi) {
        const published = this.publishedMultiProperty(id, prop);
        if (!published || published.property.type !== propType || !!published.property.isEnum !== isEnum || refEdit || designTime) {
          this.post({ type: 'status', message: t('status.editRejected', { reason: 'stale or incompatible multi-object property metadata' }) });
          await this.loadProps(id);
          return;
        }
        await this.applyMultiEdit(published.ids, prop, propType, isEnum, value);
        return;
      }
      await this.applyEdit(id, prop, propType, isEnum, value, refEdit, designTime);
    } catch (err) {
      this.post({ type: 'status', message: errMsg(err) });
      try { await this.loadProps(id); } catch { /* best effort */ }
    }
  }

  private async applyEdit(id: string, prop: string, propType: string, isEnum: boolean, raw: string, refEdit = false, designTime = false): Promise<void> {
    if (!this.designerFile) return;

    if (COMPLEX_TYPE_SET.has(propType) && raw.trim() === '') {
      this.post({ type: 'status', message: t('status.enterValue', { type: shortName(propType) }) });
      await this.loadProps(id);
      return;
    }

    // Snapshot the buffer + revision BEFORE any await that could straddle a concurrent external edit (ensureEngine, and
    // especially the refEdit `describeFor` round-trip below): a reference pick is validated against the candidate list
    // the engine describes NOW, then spliced VERBATIM — if the user edited the .Designer.cs text (e.g. deleted the target
    // field) DURING that describe, a snapshot taken AFTERWARDS would miss the change and commit a dangling `this.<field>`
    // (non-compiling save). Capturing here makes the rev-check below catch any edit during describe/convert/splice.
    const before = this.doc.designerText;
    const revBefore = this.doc.rev;
    const codeBehindBefore = this.engineKind === 'net48' ? await this.currentCodeText() : undefined;

    // An inherited row is the one deliberately narrow exception to component-level read-only. Its capability and
    // opaque base token must come from the exact describe payload published for this source revision; the webview may
    // not invent either one. All other inherited messages fail here instead of falling through to SetProperty.
    const publishedInheritedComponent = this.publishedPropertyComponent?.ids.length === 1
      && this.publishedPropertyComponent.ids[0] === id
      && this.publishedPropertyComponent.rev === revBefore
      && this.publishedPropertyComponent.component?.ownership === 'inherited'
      ? this.publishedPropertyComponent.component : null;
    const inheritedProperty = publishedInheritedComponent?.properties.find((candidate) => candidate.name === prop) ?? null;
    if (publishedInheritedComponent) {
      const token = publishedInheritedComponent.baseIdentityToken ?? '';
      const authorized = publishedInheritedComponent.inheritedOverrideEditable === true
        && inheritedProperty?.inheritedOverrideEditable === true && !inheritedProperty.readOnly
        && inheritedProperty.type === propType && !!inheritedProperty.isEnum === isEnum
        && !refEdit && !designTime && token.length > 0;
      if (!authorized) {
        this.post({ type: 'status', message: t('status.editRejected', { reason: 'stale or incompatible inherited override metadata' }) });
        await this.loadProps(id);
        return;
      }
      if (this.localizable) {
        this.post({ type: 'status', message: t('status.editRejected', { reason: 'localized inherited overrides are not supported' }) });
        await this.loadProps(id);
        return;
      }

      const converter = await this.ensureEngine('modern');
      const inheritedExpr = COMPLEX_TYPE_SET.has(propType)
        ? await convertValue(converter, propType, raw)
        : toCSharpExpression(propType, isEnum, raw);
      if (inheritedExpr === null) {
        this.post({ type: 'status', message: t('status.cannotSet', { prop, value: raw }) });
        await this.loadProps(id);
        return;
      }
      const authority = await this.ensureEngine(this.engineKind);
      const res = await applyInheritedPropertyOverride(
        authority, this.designerFile, id, prop, inheritedExpr, token, this.asm(), before, codeBehindBefore);
      if (!res.safe || res.text === null) {
        this.post({ type: 'status', message: t('status.editRejected', { reason: res.reason || 'unsafe inherited override' }) });
        await this.loadProps(id);
        return;
      }
      if (this.doc.rev !== revBefore) {
        this.post({ type: 'status', message: t('status.docChanged') });
        await this.loadProps(id);
        return;
      }
      if (this.engineKind === 'net48' && await this.currentCodeText() !== codeBehindBefore) {
        this.post({ type: 'status', message: t('status.docChanged') });
        await this.loadProps(id);
        return;
      }
      if (res.text !== before && !this.commit(before, res.text, `Override inherited ${id}.${prop}`)) return;
      this.output.appendLine(`overrode inherited ${id}.${prop} = ${inheritedExpr} (${res.mode}, unsaved)`);
      this.post({ type: 'status', message: t('status.propSet', { id, prop }) });
      await this.fullRender();
      await this.loadProps(id);
      await this.postDirty();
      return;
    }

    if (designTime && prop === '(Name)') {
      if (this.refuseLocalizableMutation()) return;
      await this.applyComponentRename(id, raw);
      return;
    }

    // v1.5.0: ApplyResources-backed properties live in the selected culture's .resx. Keep structural/reference and
    // design-time pseudo-properties source-locked, but route ordinary scalar edits entirely through the lossless
    // resource editor. Dock/Anchor remain mutually exclusive by removing the conjugate override in the same batch.
    if (this.localizable) {
      if (refEdit || designTime) {
        this.post({ type: 'status', message: t('status.localizableSourceBlocked') });
        await this.loadProps(id);
        return;
      }
      const edits: LocalizedResourceEdit[] = [{
        componentId: id,
        propertyName: prop,
        propertyTypeName: propType,
        invariantValue: raw,
      }];
      const conjugate = prop === 'Dock' ? 'Anchor' : prop === 'Anchor' ? 'Dock' : null;
      const clearConjugate = prop === 'Anchor' || (prop === 'Dock' && raw.trim() !== '' && raw.trim() !== 'None');
      if (conjugate && clearConjugate) edits.push({
        componentId: id,
        propertyName: conjugate,
        propertyTypeName: 'System.String',
        invariantValue: '',
        removeOverride: true,
      });
      if (await this.applyLocalizedResourceEdits(`Set ${id}.${prop} (${this.localizationCultureLabel()})`, edits, revBefore)) {
        this.output.appendLine(`set localized ${id}.${prop} = ${raw} (${this.localizationCultureLabel()})`);
        this.post({ type: 'status', message: t('status.propSet', { id, prop }) });
        await this.loadProps(id);
      }
      return;
    }

    const eng = await this.ensureEngine();

    // Modifiers (design-time pseudo-property, 0.12.0): a byte-local field-declaration access-keyword splice, NOT a
    // normal InitializeComponent property edit. It has no visual effect, so we commit + refresh the grid without a
    // re-render. Safe on every form (even ones the whole-file serializer refuses — it never regenerates). Routed
    // through the net9 engine: SetModifier is pure Roslyn text surgery (it never LOADS the form), so it works for a
    // net48/DevExpress buffer too — only the modern engine hosts the source splice, while both describe paths surface
    // the pseudo-property. Gated on the engine's designTime flag (NOT the name) so a real control
    // property that happens to be named "Modifiers" stays on the normal setProperty path.
    if (designTime && prop === 'Modifiers') {
      const modEng = await this.ensureEngine('modern');
      const mr = await setModifier(modEng, this.designerFile, id, raw, before);
      if (!mr.safe || mr.text === null) {
        this.post({ type: 'status', message: t('status.editRejected', { reason: mr.reason || 'unsafe' }) });
        await this.loadProps(id);
        return;
      }
      if (this.doc.rev !== revBefore) {
        this.post({ type: 'status', message: t('status.docChanged') });
        await this.loadProps(id);
        return;
      }
      if (!this.commit(before, mr.text, `Set ${id}.Modifiers`)) return;
      this.output.appendLine(`set ${id}.Modifiers = ${raw} (unsaved)`);
      this.post({ type: 'status', message: t('status.propSet', { id, prop }) });
      await this.loadProps(id);
      await this.postDirty();
      return;
    }

    let expr: string | null;
    let liveRaw = raw; // what the net48 live path receives (canonicalized for a reference clear)
    // A component-reference edit (AcceptButton/CancelButton/ContextMenuStrip…): the panel sent the picked sibling field
    // name, or "(none)" to clear. Write it as a reference expression, NOT a literal — `this.<field>` (or `null`).
    if (refEdit) {
      // The reference RHS is spliced VERBATIM (`this.<raw>`), so NEVER trust the message's refEdit bit or raw value:
      // re-derive the property's authoritative candidate set from the engine and require raw to be the exact clear
      // sentinel, the exact root token, or an EXACT listed sibling field. This rejects a forged refEdit on a
      // non-reference property, an arbitrary-expression RHS (`okButton.Text.Trim()` — never a candidate), a
      // whitespace/garbage "clear", and a wrong/incompatible field — none of which the normal <select> can produce
      //. The normal control-grid path always sends the exact sentinel or an engine-emitted field
      // name (incl. the "(this)" token when the engine offered it), so it is unaffected.
      const isClear = raw === REFERENCE_NONE;
      const isRoot = raw === REFERENCE_THIS;
      const refProp = (await this.describeFor(id))?.properties?.find((p) => p.name === prop);
      // "(none)"/"(this)" are engine-emitted standardValues entries, so includes(raw) already validates them; the
      // isClear shortcut just avoids depending on the clear token being listed. A root pick is accepted ONLY because
      // the engine OFFERED "(this)" for this property (root assignable) — a forged "(this)" on a non-root-assignable
      // reference is not in standardValues and is rejected here.
      const okRef = !!refProp && refProp.referenceValues === true && (isClear || (refProp.standardValues ?? []).includes(raw));
      if (!okRef) {
        this.post({ type: 'status', message: t('status.editRejected', { reason: 'invalid reference' }) });
        await this.loadProps(id);
        return;
      }
      // A root reference splices a bare `this` (not `this.(this)`); net48 gets the "(this)" token verbatim and resolves
      // it to the live root. A clear splices `null`. Otherwise `this.<field>`.
      expr = isClear ? 'null' : isRoot ? 'this' : 'this.' + raw;
      liveRaw = isClear ? REFERENCE_NONE : raw; // net48 clears on "(none)" / resolves "(this)" / else the field name
    } else if (COMPLEX_TYPE_SET.has(propType)) {
      expr = await convertValue(eng, propType, raw);
      if (expr === null) {
        this.post({ type: 'status', message: t('status.invalidValue', { raw, type: shortName(propType) }) });
        await this.loadProps(id);
        return;
      }
    } else {
      expr = toCSharpExpression(propType, isEnum, raw);
      if (expr === null) {
        this.post({ type: 'status', message: t('status.cannotEditType', { type: propType }) });
        return;
      }
    }

    // Modern scalar edits, plus the one fixed-contract certified vendor scalar, use the independently proven
    // InitializeComponent-owned region when it is byte-for-byte equivalent to Lane A. The certified net48 property is
    // planned by the modern source-only engine after its live metadata has authorized the exact assembly/hash/editor;
    // arbitrary net48 properties remain source-first. Any unsupported shape falls back to the minimal source splice.
    let res;
    const certifiedVendorScalar = !!this.publishedEditableProperty(id, prop)?.uiTypeEditorCertificationId;
    const plannerStartedAt = Date.now();
    if (this.engineKind === 'modern' || certifiedVendorScalar) {
      const planner = this.engineKind === 'modern' ? eng : await this.ensureEngine('modern');
      const planned = await setPropertyViaProvenOwnedRegion(
        planner, this.designerFile, id, prop, expr, before,
        this.engineKind === 'modern' ? this.modernGraphToken : undefined);
      this.lastPropertyPersistenceLane = planned.persistenceLane;
      res = planned;
    } else {
      res = await setProperty(eng, this.designerFile, id, prop, expr, before);
      this.lastPropertyPersistenceLane = 'sourceFirst';
    }
    const propertyPlannerMs = Date.now() - plannerStartedAt;
    if (!res.safe || res.text === null) {
      this.post({ type: 'status', message: t('status.editRejected', { reason: res.reason || 'unsafe' }) });
      await this.loadProps(id);
      return;
    }
    let finalText = res.text;
    // VS layout mutual-exclusivity: Dock and Anchor override each other. Setting a non-None Dock (or any Anchor)
    // clears the stale conjugate assignment so the grid + serialized source reflect the effective layout. The
    // reset is folded into the SAME commit (one undo step). engine ResetProperty is safe-save-gated and no-op-safe:
    // when the conjugate has no assignment it returns safe with text === null → we keep finalText unchanged.
    const conjugate = prop === 'Dock' ? 'Anchor' : prop === 'Anchor' ? 'Dock' : null;
    const clearConjugate = prop === 'Anchor' || (prop === 'Dock' && raw.trim() !== '' && raw.trim() !== 'None');
    if (conjugate && clearConjugate) {
      const cleared = await resetProperty(eng, this.designerFile, id, conjugate, finalText);
      // a no-op reset (conjugate had no assignment) is `safe` with a null/undefined text (C# null → TS undefined) —
      // use loose `!= null` so we only replace finalText on a real removal, never with undefined.
      if (cleared.safe && cleared.text != null) {
        finalText = cleared.text;
        this.output.appendLine(`cleared ${id}.${conjugate} (mutually exclusive with ${prop})`);
      }
    }

    if (this.doc.rev !== revBefore) {
      this.post({ type: 'status', message: t('status.docChanged') });
      await this.loadProps(id);
      return;
    }

    const commitStartedAt = Date.now();
    if (!this.commit(before, finalText, `Set ${id}.${prop}`)) return;
    const commitMs = Date.now() - commitStartedAt;
    const persistenceLane = 'persistenceLane' in res ? `, ${res.persistenceLane}` : '';
    this.output.appendLine(`set ${id}.${prop} = ${expr} (${res.mode}${persistenceLane}, unsaved)`);
    this.post({ type: 'status', message: t('status.propSet', { id, prop }) });

    // net9 re-renders the interpreted graph from the edited text; net48 can't (it renders the compiled assembly),
    // so it mutates the LIVE instance for an immediate picture — the text edit above is what persists on save.
    let propertiesReconciled = false;
    const reconcileStartedAt = Date.now();
    if (this.engineKind === 'net48') {
      propertiesReconciled = await this.liveEdit48(id, prop, liveRaw);
    } else {
      propertiesReconciled = await this.patchOrRerender(id, prop, {
        beforeSourceText: before,
        afterSourceText: finalText,
        newValueExpr: expr,
      });
    }
    const reconcileMs = Date.now() - reconcileStartedAt;
    if (this.engineKind === 'modern') {
      this.lastModernPropertyEditTelemetry = {
        plannerMs: propertyPlannerMs,
        commitMs,
        reconcileMs,
        retainedApplied: this.lastModernRetainedApplied,
        trailingPropertiesMs: propertiesReconciled ? 0 : -1,
      };
    }
    if (this.engineKind === 'net48' && this.lastNet48PropertyEditTelemetry) {
      this.lastNet48PropertyEditTelemetry.plannerMs = propertyPlannerMs;
      this.lastNet48PropertyEditTelemetry.commitMs = commitMs;
      this.lastNet48PropertyEditTelemetry.reconcileMs = reconcileMs;
    }
    if (!propertiesReconciled) {
      const propertiesStartedAt = Date.now();
      await this.loadProps(id);
      if (this.engineKind === 'net48' && this.lastNet48PropertyEditTelemetry) {
        this.lastNet48PropertyEditTelemetry.trailingPropertiesMs = Date.now() - propertiesStartedAt;
      }
      if (this.engineKind === 'modern' && this.lastModernPropertyEditTelemetry) {
        this.lastModernPropertyEditTelemetry.trailingPropertiesMs = Date.now() - propertiesStartedAt;
      }
    }
    await this.postDirty();
  }

  /** Delete current-source controls from an ApplyResources-backed form and remove every id.* resource from neutral
   * and discovered satellite files. Source and all resource snapshots are one durable transaction/undo unit. */
  private async applyLocalizedStructuralRemove(ids: string[], label: string): Promise<number> {
    if (!this.designerFile || this.disposed || !ids.length) return 0;
    if (this.localizationCulture !== '') {
      this.post({ type: 'status', message: t('status.editRejected', { reason: 'switch Language to (Default) before deleting controls' }) });
      return 0;
    }
    const eng = await this.ensureEngine('modern');
    const before = this.doc.designerText;
    const rev = this.doc.rev;
    let text = before;
    const removed: string[] = [];
    for (const id of ids) {
      const result = await removeControl(eng, this.designerFile, id, text);
      if (result.safe && result.newText !== null) {
        text = result.newText;
        removed.push(id);
      }
    }
    if (!removed.length) {
      this.post({ type: 'status', message: t('status.removeRejectedNothing') });
      return 0;
    }
    if (this.doc.rev !== rev || this.localizationCulture !== '' || !this.localizable) {
      this.post({ type: 'status', message: t('status.docChanged') });
      return 0;
    }

    const txs: ResxTx[] = [];
    const seen = new Set<string>();
    for (const choice of discoverLocalizationCultures(this.designerFile)) {
      const key = normalize(choice.resxPath);
      if (seen.has(key)) continue;
      seen.add(key);
      if (choice.exists) {
        try {
          if (fs.lstatSync(choice.resxPath).isSymbolicLink())
            throw new Error('localized resource symlinks are not editable');
        } catch (error) {
          this.post({ type: 'status', message: t('status.removeRejected', { reason: errMsg(error) }) });
          return 0;
        }
      }
      const uri = vscode.Uri.file(choice.resxPath);
      const current = await this.readResx(uri);
      if (current == null) continue;
      const resourceEdit = await removeLocalizedComponentResources(eng, current?.text ?? null, removed);
      if (!resourceEdit.ok || resourceEdit.resxText == null) {
        this.post({ type: 'status', message: t('status.removeRejected', { reason: resourceEdit.reason || 'unsafe resource cleanup' }) });
        return 0;
      }
      txs.push({ uri, before: current?.text ?? null, after: resourceEdit.resxText, bom: current?.hadBom ?? false });
    }
    if (!txs.length) {
      this.post({ type: 'status', message: t('status.removeRejected', { reason: 'neutral resource target is unavailable' }) });
      return 0;
    }
    try {
      const committed = await this.commitResourceSetThroughRunner(label, txs, before, text, {
        persistDesignerTextBeforeCommit: true,
        expectedDesignerRevision: rev,
      });
      if (!committed || committed.status !== 'committed')
        throw new Error(committed?.error ?? committed?.status ?? 'journal unavailable');
    } catch (error) {
      this.output.appendLine('[designer] localized structural remove refused: ' + errMsg(error));
      this.post({ type: 'status', message: t('status.removeRejected', { reason: errMsg(error) }) });
      return 0;
    }
    this.currentId = 'this';
    this.currentSelectionIds = ['this'];
    this.output.appendLine(`removed ${removed.length} localized control(s) and their neutral/satellite resource keys`);
    if (this.engineKind === 'net48')
      await this.live48((engine) => removeCompiledControls(engine, this.designerFile!, this.asm()!, removed), true, {});
    else await this.fullRender();
    this.post({ type: 'status', message: tn('status.removed', removed.length) });
    return removed.length;
  }

  /** Apply one scalar value across the exact revision-bound selection published to the panel. The modern source
   * engine returns no text unless every target passes ownership/expression/minimal-diff preflight; the host then makes
   * exactly one commit/undo unit. net48 mirrors that committed batch into its live picture in one snapshot. */
  private async applyMultiEdit(ids: string[], prop: string, propType: string, isEnum: boolean, raw: string): Promise<void> {
    if (!this.designerFile || ids.length < 2) return;
    if (COMPLEX_TYPE_SET.has(propType) && raw.trim() === '') {
      this.post({ type: 'status', message: t('status.enterValue', { type: shortName(propType) }) });
      await this.loadProps(this.currentId);
      return;
    }

    const before = this.doc.designerText;
    const revBefore = this.doc.rev;

    const conjugate = prop === 'Dock' ? 'Anchor' : prop === 'Anchor' ? 'Dock' : null;
    const clearConjugate = prop === 'Anchor' || (prop === 'Dock' && raw.trim() !== '' && raw.trim() !== 'None');

    if (this.localizable) {
      const edits: LocalizedResourceEdit[] = ids.map((componentId) => ({
        componentId,
        propertyName: prop,
        propertyTypeName: propType,
        invariantValue: raw,
      }));
      if (conjugate && clearConjugate) {
        for (const componentId of ids) edits.push({
          componentId,
          propertyName: conjugate,
          propertyTypeName: 'System.String',
          invariantValue: '',
          removeOverride: true,
        });
      }
      if (await this.applyLocalizedResourceEdits(
        `Set ${prop} on ${ids.length} localized controls`, edits, revBefore)) {
        this.output.appendLine(`set localized ${prop} on ${ids.length} controls (${this.localizationCultureLabel()})`);
        this.post({ type: 'status', message: tn('status.multiPropSet', ids.length, { prop }) });
        await this.loadProps(this.currentId);
      }
      return;
    }

    const eng = await this.ensureEngine('modern');
    const expr = COMPLEX_TYPE_SET.has(propType)
      ? await convertValue(eng, propType, raw)
      : toCSharpExpression(propType, isEnum, raw);
    if (expr === null) {
      this.post({ type: 'status', message: t('status.invalidValue', { raw, type: shortName(propType) }) });
      await this.loadProps(this.currentId);
      return;
    }

    const result = await setProperties(eng, this.designerFile, ids, prop, expr, before);
    if (!result.safe || result.text === null) {
      this.post({ type: 'status', message: t('status.editRejected', { reason: result.reason || 'unsafe' }) });
      await this.loadProps(this.currentId);
      return;
    }
    let finalText = result.text;
    if (conjugate && clearConjugate) {
      const reset = await resetProperties(eng, this.designerFile, ids, conjugate, finalText);
      if (!reset.safe) {
        this.post({ type: 'status', message: t('status.editRejected', { reason: reset.reason || 'unsafe conjugate reset' }) });
        await this.loadProps(this.currentId);
        return;
      }
      if (reset.text != null) finalText = reset.text;
    }
    if (this.doc.rev !== revBefore) {
      this.post({ type: 'status', message: t('status.docChanged') });
      await this.loadProps(this.currentId);
      return;
    }
    if (!this.commit(before, finalText, `Set ${prop} on ${ids.length} controls`)) return;

    const liveEdits: CompiledEdit[] = ids.map((componentId) => ({ componentId, propName: prop, rawValue: raw }));
    if (conjugate && clearConjugate) {
      for (const componentId of ids) liveEdits.push({ componentId, propName: conjugate, rawValue: '', reset: true });
    }
    this.output.appendLine(`set ${prop} on ${ids.length} controls (${result.mode}, one undo unit, unsaved)`);
    this.post({ type: 'status', message: tn('status.multiPropSet', ids.length, { prop }) });
    if (this.engineKind === 'net48') {
      await this.live48((engine) => applyCompiledEdits(engine, this.designerFile!, this.asm()!, liveEdits), true,
        { skipReselect: true, edits: liveEdits });
      await this.loadProps(this.currentId);
    } else {
      await this.fullRender();
    }
    await this.postDirty();
  }

  /** Grid edit of a ToolStripItem property (item→Properties). Mirrors editFromGrid's error/restore handling but
   * refreshes via the item channel (loadItemProps) so a failure re-renders the item grid, not the control's. */
  async editItemFromGrid(ownerId: string, itemId: string, prop: string, propType: string, isEnum: boolean, value: string): Promise<void> {
    try {
      await this.applyItemEdit(ownerId, itemId, prop, propType, isEnum, value);
    } catch (err) {
      this.post({ type: 'status', message: errMsg(err) });
      try { await this.loadItemProps(ownerId, itemId); } catch { /* best effort */ }
    }
  }

  /** Apply ONE property edit to a ToolStripItem field. The engine splice (setProperty) is field-agnostic — it rewrites
   * `this.<itemField>.<prop> = <expr>` exactly like a control — so the commit path is the proven grid-edit one. The
   * differences from applyEdit: (1) no Dock/Anchor conjugate reset (items have neither); (2) the re-render uses
   * fullRender(skipReselect) so the canvas keeps the item highlight and the panel is NOT snapped back to the control;
   * (3) the grid refresh goes through loadItemProps (the itemProps channel bypasses the control-props gate). net48
   * can't re-interpret its compiled assembly, so it mutates the LIVE item in place (liveEdit48 → the widened
   * TryApply) for the picture; the committed text is what persists on save either way. */
  private async applyItemEdit(ownerId: string, itemId: string, prop: string, propType: string, isEnum: boolean, raw: string): Promise<void> {
    if (!this.designerFile) return;

    if (COMPLEX_TYPE_SET.has(propType) && raw.trim() === '') {
      this.post({ type: 'status', message: t('status.enterValue', { type: shortName(propType) }) });
      await this.loadItemProps(ownerId, itemId);
      return;
    }

    if (this.localizable) {
      if (await this.applyLocalizedResourceEdits(`Set localized ${itemId}.${prop}`, [{
        componentId: itemId,
        propertyName: prop,
        propertyTypeName: propType,
        invariantValue: raw,
      }])) {
        this.output.appendLine(`set localized ${itemId}.${prop} = ${raw} (${this.localizationCultureLabel()})`);
        this.post({ type: 'status', message: t('status.propSet', { id: itemId, prop }) });
        await this.loadItemProps(ownerId, itemId);
      }
      return;
    }

    const eng = await this.ensureEngine();

    let expr: string | null;
    if (COMPLEX_TYPE_SET.has(propType)) {
      expr = await convertValue(eng, propType, raw);
      if (expr === null) {
        this.post({ type: 'status', message: t('status.invalidValue', { raw, type: shortName(propType) }) });
        await this.loadItemProps(ownerId, itemId);
        return;
      }
    } else {
      expr = toCSharpExpression(propType, isEnum, raw);
      if (expr === null) {
        this.post({ type: 'status', message: t('status.cannotEditType', { type: propType }) });
        return;
      }
    }

    const before = this.doc.designerText;
    const revBefore = this.doc.rev;

    const res = await setProperty(eng, this.designerFile, itemId, prop, expr, before);
    if (!res.safe || res.text === null) {
      this.post({ type: 'status', message: t('status.editRejected', { reason: res.reason || 'unsafe' }) });
      await this.loadItemProps(ownerId, itemId);
      return;
    }
    if (this.doc.rev !== revBefore) {
      this.post({ type: 'status', message: t('status.docChanged') });
      await this.loadItemProps(ownerId, itemId);
      return;
    }

    if (!this.commit(before, res.text, `Set ${itemId}.${prop}`)) return;
    this.output.appendLine(`set ${itemId}.${prop} = ${expr} (${res.mode}, unsaved)`);
    this.post({ type: 'status', message: t('status.propSet', { id: itemId, prop }) });

    // net9 re-renders the interpreted graph from the edited source (skipReselect keeps the item highlight and does
    // NOT snap the panel back to the control); net48 mutates the live item on the compiled instance instead —
    // liveEdit48 → setCompiledPropertyLive resolves the item via the widened TryApply, and live48/show48 posts
    // render+layout+tray but no control select, so the item highlight survives there too.
    if (this.engineKind === 'net48') {
    await this.liveEdit48(itemId, prop, raw); // liveEdit48 always skipReselects (keeps the on-canvas item highlight)
    } else {
      await this.fullRender(true);
    }
    await this.loadItemProps(ownerId, itemId); // refresh the item grid via the itemProps channel
    await this.postDirty();
  }

  /** net48 compiled preview: after the text edit is committed, mutate the live instance so the picture updates
   * immediately (the net9 interpreter path can't render this DevExpress/Framework control). Best-effort — an
   * unconvertible/read-only value leaves the picture on the built value with a note; the committed text still
   * renders after a rebuild. */
  private async liveEdit48(id: string, prop: string, raw: string): Promise<boolean> {
    const asm = this.asm();
    if (!asm || !this.designerFile) return false;
    // a property edit IS a committed source-backed edit, so opt into interpreted re-render: under
    // an interpreted canvas re-interpret the committed source (fullRender) instead of mutating the compiled instance.
    // ALWAYS skipReselect: this matches the earlier net48 `show48`, which posted NO host control selection — so the
    // webview keeps its current selection and the trailing loadProps(id)/loadItemProps restores the grid. Posting a fresh
    // control select instead breaks a visibility-changing edit (Visible=false leaves the control out of the layout →
    // selection snaps to the form → the hidden control's grid is dropped and can't be set back) and clears an item/nested
    // highlight — both are visibility contracts (CONTROL-visibility + ITEM-highlight).
    let propertiesReconciled = false;
    let componentInSnapshot = false;
    let snapshotComponentId: string | null = null;
    const liveStartedAt = Date.now();
    await this.live48((eng) => setCompiledPropertyLive(eng, this.designerFile!, asm, id, prop, raw), true,
      {
        skipReselect: true,
        edits: [{ componentId: id, propName: prop, rawValue: raw }],
        onInterpretedSnapshot: (res) => {
          const component = res.component;
          snapshotComponentId = component?.id ?? null;
          componentInSnapshot = component?.id === id;
          if (component?.id !== id || this.currentId !== id
            || this.currentSelectionIds.length !== 1 || this.currentSelectionIds[0] !== id) return;
          this.publishedPropertyComponent = { ids: [id], rev: this.doc.rev, component };
          DesignerHub.instance.pushPanel(this, { type: 'props', id, component });
          propertiesReconciled = true;
        },
      });
    this.lastNet48PropertyEditTelemetry = {
      plannerMs: 0,
      commitMs: 0,
      reconcileMs: Date.now() - liveStartedAt,
      liveMs: Date.now() - liveStartedAt,
      snapshotComponentId,
      componentInSnapshot,
      propertiesReconciled,
      trailingPropertiesMs: propertiesReconciled ? 0 : -1,
    };
    return propertiesReconciled;
  }

  /** net48 compiled preview for a typed "…" collection edit: after the text edit is committed, reconstruct the
   * collection (string Items / ListView.Columns / DataGridView.Columns) on the live instance so the canvas updates
   * immediately (T1.1b) instead of showing the built collection until a rebuild. Best-effort — a bound/unsupported
   * collection leaves the picture on the built value with a note (show48's previewPartial); the committed text still
   * renders after a rebuild. */
  private async liveCollection48(id: string, prop: string, itemType: string, items: LiveCollItem[]): Promise<void> {
    const asm = this.asm();
    if (!asm || !this.designerFile) return;
    await this.live48((eng) => setCompiledCollectionLive(eng, this.designerFile!, asm, id, prop, itemType, items), true, { skipReselect: true });
  }

  /** net48 compiled preview for a generic string[] "…" edit (TextBox/RichTextBox.Lines): after the net9 text commit,
   * set the string[] on the live instance so the canvas updates immediately (mirror of liveCollection48). Best-effort
   * — a non-string[]/read-only property leaves the picture on the built value with a note; the committed text still
   * renders after a rebuild. */
  private async liveStringArray48(id: string, prop: string, items: string[]): Promise<void> {
    const asm = this.asm();
    if (!asm || !this.designerFile) return;
    await this.live48((eng) => setCompiledStringArrayLive(eng, this.designerFile!, asm, id, prop, items), true, { skipReselect: true });
  }

  /** net48 compiled preview for the hierarchical TreeView.Nodes edit: after the net9 text commit, reconstruct the
   * node forest on the live instance so the canvas updates immediately (the TreeView analogue of liveCollection48).
   * Best-effort — a non-TreeNodeCollection Nodes (a DevExpress TreeList) leaves the picture on the built tree with a
   * note (show48's previewPartial); the committed text still renders after a rebuild. */
  private async liveTreeNodes48(id: string, prop: string, nodes: TreeNodeItem[]): Promise<void> {
    const asm = this.asm();
    if (!asm || !this.designerFile) return;
    await this.live48((eng) => setCompiledTreeNodesLive(eng, this.designerFile!, asm, id, prop, nodes), true, { skipReselect: true });
  }

  /** Push a net48 live-op's render result to the canvas (shared by property edit / drag / remove / z-order). Returns
   * true iff it posted a fresh render→layout→tray whose forest REFLECTS the edit: false if superseded/disposed (nothing
   * posted) OR the live op reported `applied === false` (posted, but the picture is the stale built strip — the ADD
   * auto-reopen must not draw from it). A plain render (applied undefined) counts as fresh. */
  private show48(res: RenderLayout, seq: number, notifyOnNotApplied = true): boolean {
    // Only the freshest, non-disposed render paints. There is no fidelity state to update (the divergence lock was
    // descoped); net48 editing is always allowed, and the persistent "last build" disclosure is
    // posted by composeFormNotice below, unconditionally per net48 route.
    if (seq !== this.renderSeq || this.disposed) return false;
    // Every show48 render is a COMPILED live-instance (build-based) render — live edits/drags/removes route through
    // live48→show48 and never re-interpret the source. So the render mode reverts to 'compiled' here: after a form
    // rendered 'interpreted', a subsequent live op flips the canvas back to the build, and composeFormNotice must
    // re-show the "last build" disclosure. Leaving the stale 'interpreted' flag hid it.
    this.net48RenderMode = 'compiled';
    this.renderedText = undefined; // this picture is the build, not an interpretation of any buffer
    this.renderedRev = -1;
    this.controls = res.controls;
    this.toolStripItems = res.toolStripItems ?? [];
    this.rootClient = { w: res.clientWidth, h: res.clientHeight };
    this.rootFrame = { w: res.width, h: res.height };
    this.post({ type: 'render', png: res.png.toString('base64'), width: res.width, height: res.height, gen: seq });
    this.postLayout(res.controls, this.toolStripItems);
    this.post({ type: 'tray', items: res.tray });
    this.composeFormNotice(res); // net48 "last build" disclosure (+ any modern-engine notices)
    if (res.applied === false && notifyOnNotApplied) {
      // Honest diagnostic — the source committed but the live instance didn't reflect it (an unconvertible value, or a
      // component the preview won't mutate, or a reconcile miss). NOT a false "done"; the edit is in the source and
      // appears after a rebuild. Navigation ops pass notifyOnNotApplied=false (their applied:false is an ordinary no-op).
      this.post({ type: 'status', message: t('status.previewPartial', { diag: res.diagnostics || t('designer.notice.liveNotReflected') }) });
    }
    return res.applied !== false;
  }

  /** Run a net48 live-op (already text-committed by net9) with the session's net48 engine and render its result.
   * Returns show48's freshness result (false on bail / a swallowed engine error).
   *
   * WRITE PARITY for interpreted forms is OPT-IN per call site, NOT a blanket "if interpreted →
   * fullRender" guard (an independent review proved that too broad: it breaks tab navigation, ToolStrip item
   * selection, and mid-batch paste). A caller passes `interp` ONLY when it is a committed SOURCE-backed edit whose net9
   * counterpart is a full render — then, under an interpreted canvas, the compiled mutation is skipped and the committed
   * source is re-interpreted (fullRender), so the canvas stays interpreted instead of flipping to the build. Callers
   * that do NOT opt in (tab navigation = transient view state; ToolStrip items = need skipReselect; paste/duplicate =
   * per-control loop that ends in its own fullRender) keep the compiled live-mirror path — the honest earlier behavior,
   * never a NEW break. `interp.skipReselect` threads through to fullRender for callers that must preserve a non-control
   * selection. */
  private async live48(op: (eng: EngineHandle) => Promise<RenderLayout>, notifyOnNotApplied = true,
    interp?: {
      skipReselect?: boolean;
      edits?: CompiledEdit[];
      onInterpretedSnapshot?: (result: RenderLayout) => void;
    }): Promise<boolean> {
    if (!this.designerFile || !this.asm()) return false;
    if (interp && this.net48RenderMode === 'interpreted') {
      // 1.2.x — the same edits the compiled path would apply, applied to the cached INTERPRETED graph instead. That
      // keeps the canvas interpreted (this is still the live source) at the cost of a snapshot rather than a full
      // re-interpretation, which is what makes a drag land immediately on a vendor form. Anything the engine will not
      // certify falls through to the re-interpretation below, which is always correct.
      // Dock/Anchor commits are NOT fully described by the property they send: setting one deletes its conjugate
      // assignment from the source in the same commit, so the live batch would carry half the change and the
      // provisional picture (and any burst edit chained from it) would show a form the buffer no longer describes.
      const fullyDescribed = !interp.edits?.some((e) => e.propName === 'Dock' || e.propName === 'Anchor');
      if (fullyDescribed && interp.edits?.length
        && await this.liveInterpreted48(interp.edits, interp.onInterpretedSnapshot)) return true;
      return this.fullRender(interp.skipReselect ?? false);
    }
    const seq = ++this.renderSeq;
    try {
      const res = await op(await this.ensureEngine('net48'));
      return this.show48(res, seq, notifyOnNotApplied);
    } catch (err) {
      // The live op threw (RPC error, timeout, a dead engine) after its text edit committed. The source is safe (the
      // net9 splice already landed); the picture just didn't update, which the persistent net48 disclosure already
      // covers. Surface the error as a status, do NOT block further editing.
      this.post({ type: 'status', message: errMsg(err) });
      return false;
    }
  }

  /**
   * 1.2.x — the interpreted fast path behind {@link live48}: hand the engine the edits plus BOTH buffers (the one the
   * current picture was interpreted from and the one just committed) and let it re-snapshot its cached graph.
   *
   * Returns false — caller re-interprets — whenever anything is unproven: no picture-buffer on record, the buffer
   * cannot be read, the engine has no cached graph for this form, its graph is keyed to a different buffer, the
   * assembly was rebuilt under it, or an edit did not apply. The engine drops its cache in that last case, so the
   * fallback render starts from source.
   */
  private async liveInterpreted48(
    edits: CompiledEdit[],
    onSnapshot?: (result: RenderLayout) => void,
  ): Promise<boolean> {
    const before = this.renderedText;
    if (before === undefined || !this.designerFile || !this.asm()) return false;
    const rev = this.doc.rev;
    // EXACTLY the commit being sent must separate the picture from the buffer. Commits that deliberately change
    // source without re-rendering — Modifiers, event wiring, a conjugate Dock/Anchor delete — would otherwise ride
    // along invisibly: the engine would apply only the edits in this batch and then certify the whole buffer.
    if (rev !== this.renderedRev + 1) {
      this.output.appendLine(`[designer] interpreted live edit skipped: picture is rev ${this.renderedRev}, buffer is rev ${rev}`);
      return false;
    }
    const after = await this.currentText();
    if (after === undefined || after === null) return false;
    const codeBehindText = await this.currentCodeText();
    const seq = ++this.renderSeq;
    try {
      const eng = await this.ensureEngine('net48');
      const res = await applyInterpretedEditsLive(eng, this.designerFile, this.asm()!, edits, before, after,
        undefined, undefined, this.tabViewState(), this.renderScale, codeBehindText);
      // Either source half moved WHILE the edit was in flight. The engine has now keyed its graph to a document that
      // also carries that other change, which the graph never received — drop it before any later reuse.
      if (this.doc.rev !== rev || await this.currentCodeText() !== codeBehindText) {
        this.renderedText = undefined;
        try { await discardCompiledLive(await this.ensureEngine('net48'), this.designerFile, this.asm()!); }
        catch { /* best effort: the stamp mismatch on the next render is the backstop */ }
        this.output.appendLine('[designer] designer/code-behind buffer changed during an interpreted live edit — dropping the cached graph');
        return false;
      }
      if (res.applied === false) {
        this.output.appendLine('[designer] interpreted live edit not applied (' + (res.diagnostics || 'no reason') + ') — re-interpreting');
        return false;
      }
      if (seq !== this.renderSeq || this.disposed) return true; // superseded by a newer render; it owns the picture
      this.renderedText = after; // the picture now corresponds to the committed buffer
      this.renderedRev = rev;
      if (!res.layoutUnchanged) {
        this.controls = res.controls;
        this.toolStripItems = res.toolStripItems ?? [];
        this.rootClient = { w: res.clientWidth, h: res.clientHeight };
        this.rootFrame = { w: res.width, h: res.height };
      }
      if (res.isPatch && (res.patchWidth ?? 0) > 0 && (res.patchHeight ?? 0) > 0) {
        this.post({
          type: 'patch', png: res.png.toString('base64'),
          x: res.patchX ?? 0, y: res.patchY ?? 0,
          width: res.patchWidth ?? 0, height: res.patchHeight ?? 0, gen: seq,
        });
      } else {
        this.post({ type: 'render', png: res.png.toString('base64'), width: res.width, height: res.height, gen: seq });
      }
      if (!res.layoutUnchanged) {
        this.postLayout(res.controls, this.toolStripItems);
        this.post({ type: 'tray', items: res.tray });
      }
      onSnapshot?.(res);
      // Deliberately NOT show48: that flips the canvas to 'compiled' (it exists for build-based live ops). This
      // picture is still the interpreted live source, so the mode — and the absence of the "last build" disclosure —
      // must stay exactly as it was.
      this.composeFormNotice({});
      this.scheduleInterpretedReconcile();
      return true;
    } catch (err) {
      this.output.appendLine('[designer] interpreted live edit failed (' + errMsg(err) + ') — re-interpreting');
      return false;
    }
  }

  /**
   * 1.2.x — after a burst of live edits, re-interpret the committed buffer once, off the critical path.
   *
   * A live edit sets the value through the control's TypeConverter, while a full interpretation materializes the
   * expression the splice wrote. Those agree for the geometry and simple values a designer produces, but the product
   * rule is that the picture is the SOURCE — so rather than trust the agreement forever, the canvas is brought back
   * to a genuine interpretation once the user stops. The user never waits for it: it runs after a quiet period and
   * repaints identically when (as expected) nothing differs.
   */
  private scheduleInterpretedReconcile(): void {
    if (this.interpretedReconcileTimer) clearTimeout(this.interpretedReconcileTimer);
    this.interpretedReconcileTimer = setTimeout(() => {
      this.interpretedReconcileTimer = undefined;
      if (this.disposed || this.engineKind !== 'net48' || this.net48RenderMode !== 'interpreted') return;
      void this.fullRender(true).catch(() => { /* a failed reconcile leaves the live picture, which fullRender itself reports */ });
    }, 700);
  }

  /** Describe a component from the engine that owns this session (net48 live instance, or the net9 graph). */
  private async describeFor(id: string): Promise<ComponentDesc | null> {
    if (!this.designerFile) return null;
    const asm = this.asm();
    if (this.engineKind === 'net48') {
      if (!asm) return null;
      // mirror the net9 branch below (pass the unsaved buffer) so source-metadata reflects the dirty edit on net48 too;
      // route to the interpreted describe when the canvas is interpreted so reference-write revalidation validates against
      // the SAME identity model the canvas + panel use.
      try {
        const textR = await this.currentText();
        const codeBehindTextR = await this.currentCodeText();
        const eng48r = await this.ensureEngine('net48');
        await this.applyEngineLocalizationCulture(eng48r);
        return this.net48RenderMode === 'interpreted'
          ? await describeInterpretedComponent(eng48r, this.designerFile, asm, textR ?? '', id,
            undefined, undefined, undefined, undefined, codeBehindTextR)
          : await describeCompiledComponent(eng48r, this.designerFile, asm, id,
            undefined, undefined, textR, codeBehindTextR);
      }
      catch { return null; }
    }
    const eng = await this.ensureEngine();
    await this.applyEngineLocalizationCulture(eng);
    return describeComponent(eng, this.designerFile, id, asm, await this.currentText());
  }

  /** The sibling .resx for the current designer file (Foo.Designer.cs / Foo.cs → Foo.resx). */
  private resxUri(): vscode.Uri {
    return vscode.Uri.file(neutralResxPathForDesigner(this.designerFile!));
  }

  private async projectResourcePairs(): Promise<ProjectResourceFilePair[]> {
    if (!this.designerFile) return [];
    const root = this.wsRoot();
    const owning = findOwningCsproj(path.dirname(this.designerFile), root);
    if (!owning) return []; // never scan a whole workspace and guess ownership
    const projectRoot = path.dirname(owning);
    const maxFiles = 128;
    const found = await vscode.workspace.findFiles(
      new vscode.RelativePattern(projectRoot, '**/*.resx'),
      '**/{bin,obj,node_modules,.git,.vs,packages,artifacts}/**',
      maxFiles + 1,
    );
    if (found.length > maxFiles) throw new Error(`project has more than ${maxFiles} resource files`);
    const lexicalPairs = found
      .map((uri) => conventionalProjectResourcePair(projectRoot, uri.fsPath, this.designerFile!))
      .filter((pair): pair is ProjectResourceFilePair => pair !== null)
      .sort((a, b) => a.resxPath.localeCompare(b.resxPath));
    const checked = await Promise.all(lexicalPairs.map(async (pair) =>
      await isCanonicalProjectResourcePath(projectRoot, pair.resxPath)
        && await isCanonicalProjectResourcePath(projectRoot, pair.designerPath)
        ? pair
        : null));
    return checked.filter((pair): pair is ProjectResourceFilePair => pair !== null);
  }

  private localizedResxUri(culture = this.localizationCulture): vscode.Uri {
    return vscode.Uri.file(localizedResxPathForDesigner(this.designerFile!, culture));
  }

  /**
   * Read a .resx: its text (BOM stripped, but reported), or null ONLY for a genuine "file not found" — every other
   * read failure is RETHROWN.
   *
   * The distinction is the whole point. The forward path used to swallow EVERY error into null (its comment even
   * claimed that was fail-closed), so `null` meant both "there is definitely no .resx" and "there is one and I could
   * not look at it". An unreadable-but-writable .resx (permissions, a remote/virtual provider, a transient failure)
   * therefore: read as absent → the engine synthesized a fresh file → the second read failed to null too, so the
   * "did it change on disk?" guard compared null to null and PASSED → binaryResxCount(null) is 0, so the
   * binary-resource drop guard was disabled → the atomic rename replaced the user's real resource file with the
   * synthesized one. Rethrowing surfaces it as an import failure instead.
   *
   * Undo/redo use this too: a lock/permission read must reject the closure so commit's undo/redo leaves the designer
   * text unmoved, rather than being mistaken for "content changed → skip revert" while the text still rewinds — that
   * would recreate the split state.
   */
  private async readResx(uri: vscode.Uri): Promise<ResxRead | null> {
    try {
      return this.stripBom(await vscode.workspace.fs.readFile(uri));
    } catch (e) {
      if (isFileNotFound(e)) return null; // no .resx yet — the engine creates one from a skeleton
      throw e;
    }
  }

  private stripBom(b: Uint8Array): ResxRead {
    let s = Buffer.from(b).toString('utf8');
    const hadBom = s.charCodeAt(0) === 0xFEFF;
    if (hadBom) s = s.slice(1); // strip a leading BOM so the XML parser is happy
    return { text: s, hadBom };
  }

  /** Project-resource picker input boundary: ordinary local UTF-8 files only, no symlink escape and no unbounded read. */
  private async readProjectResourceText(uri: vscode.Uri, projectRoot: string): Promise<string> {
    const maxBytes = 64 * 1024 * 1024;
    if (!await isCanonicalProjectResourcePath(projectRoot, uri.fsPath))
      throw new Error('project resource input escapes its canonical project root');
    const stat = await vscode.workspace.fs.stat(uri);
    if ((stat.type & vscode.FileType.SymbolicLink) !== 0 || (stat.type & vscode.FileType.File) === 0)
      throw new Error('project resource input is not a regular file');
    if (stat.size > maxBytes) throw new Error('project resource input is too large');
    const bytes = Buffer.from(await vscode.workspace.fs.readFile(uri));
    if (bytes.length > maxBytes) throw new Error('project resource input is too large');
    if (!await isCanonicalProjectResourcePath(projectRoot, uri.fsPath))
      throw new Error('project resource input changed canonical identity while being read');
    if (bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)))
      throw new Error('project resource input must be UTF-8');
    const text = this.stripBom(bytes).text;
    if (text.includes('\ufffd')) throw new Error('project resource input is not valid UTF-8');
    return text;
  }

  /** Re-attach the BOM the .resx came with. VS writes .resx files WITH a UTF-8 BOM, and the engine round-trips the
   * stripped text — so writing back plain UTF-8 quietly dropped the BOM, turning an image import into a whole-file
   * diff in the user's history (and a "changed" file for anything comparing bytes). A .resx we CREATE has no BOM;
   * we preserve what was there rather than invent one. */
  private resxBytesOf(text: string, hadBom: boolean): Buffer {
    const body = Buffer.from(text, 'utf8');
    return hadBom ? Buffer.concat([UTF8_BOM, body]) : body;
  }

  /** 0.11.0 write-safety — the .resx write. See {@link atomicWrite}, which the .Designer.cs save shares. */
  private atomicWriteFile(uri: vscode.Uri, bytes: Uint8Array): Promise<void> {
    return atomicWrite(uri, bytes);
  }

  /**
   * 0.11.0 write-safety — undo half of a resx transaction: restore the .resx to its pre-edit state. CONFLICT-GUARDED:
   * only reverts when the file on disk is still EXACTLY what this edit wrote (`afterText`); if something else changed
   * it since (VS, git, a manual edit), it is left untouched — never clobber a concurrent change. When there was no
   * prior .resx (`beforeText === null`) the file this edit created is deleted; otherwise its prior bytes are
   * atomically restored. Errors OTHER than "already gone" propagate so the caller (commit's undo closure) leaves the
   * in-memory designer text unmoved — the two halves never split. (TOCTOU note: the read→write window is inherent to
   * the VS Code FS API, which offers no compare-and-swap; the equality guard keeps it as small as the forward path's.)
   */
  private async revertResx(uri: vscode.Uri, beforeText: string | null, afterText: string, bom: boolean): Promise<void> {
    const current = await this.readResx(uri); // throws on lock/permission → undo rejects (no split), not "skip"
    // The BOM is part of "still exactly what this edit wrote" — the forward guard already treats a BOM-only external
    // rewrite as a conflict, and comparing text alone here would let undo restore our old signature over it.
    if (current?.text !== afterText || current.hadBom !== bom) { this.output.appendLine('[designer] resx undo skipped: .resx changed on disk since the edit'); return; }
    if (beforeText === null) {
      try { await vscode.workspace.fs.delete(uri); }
      catch (e) { if (!isFileNotFound(e)) throw e; } // already gone = done; a lock/permission failure must reject the undo
    } else {
    await this.atomicWriteFile(uri, this.resxBytesOf(beforeText, bom)); // restore its ORIGINAL BOM, not just its text
    }
  }

  /**
   * 0.11.0 write-safety — redo half of a resx transaction: re-apply the written .resx atomically. CONFLICT-GUARDED
   * symmetrically to revertResx — only re-applies when the file on disk is still the pre-import state this redo
   * transitions FROM (`beforeText`, restored by the matching undo); if an external change landed in between it is
   * left alone. A skipped redo re-render still reflects
   * the (unchanged) designer text; the resource simply stays as the external editor left it.
   */
  private async reapplyResx(uri: vscode.Uri, beforeText: string | null, afterText: string, bom: boolean): Promise<void> {
    const current = await this.readResx(uri); // throws on lock/permission → redo rejects (no split), not "skip"
    // Same BOM condition as revertResx: redo must transition FROM exactly the state its undo restored, signature
    // included, or an external BOM-only rewrite gets silently overwritten.
    if ((current?.text ?? null) !== beforeText || (current !== null && current.hadBom !== bom)) {
      this.output.appendLine('[designer] resx redo skipped: .resx changed on disk since undo'); return;
    }
    await this.atomicWriteFile(uri, this.resxBytesOf(afterText, bom));
  }

  /** Write one side of a resource transition. A null side means the transaction owns creation/deletion of the file. */
  private async writeResxState(uri: vscode.Uri, text: string | null, bom: boolean): Promise<void> {
    if (text !== null) {
      await this.atomicWriteFile(uri, this.resxBytesOf(text, bom));
      return;
    }
    try { await vscode.workspace.fs.delete(uri); }
    catch (error) { if (!isFileNotFound(error)) throw error; }
  }

  private async readResxBytes(uri: vscode.Uri): Promise<Uint8Array | null> {
    try {
      return Buffer.from(await vscode.workspace.fs.readFile(uri));
    } catch (error) {
      if (isFileNotFound(error)) return null;
      throw error;
    }
  }

  /** Shared final boundary for ordinary Image/ImageList writes. The resource reaches disk first because the engine
   * renders it from there; the exact document revision is then revalidated after that await. A concurrent canvas or
   * property edit wins, while this stale operation compensates its resource bytes and reports refusal. */
  private async commitOrdinaryResourceEdit(
    beforeDesignerText: string,
    afterDesignerText: string,
    label: string,
    tx: ResxTx,
    expectedDesignerRevision: number,
  ): Promise<boolean> {
    const result = await this.commitResourceSetThroughRunner(
      label,
      [tx],
      beforeDesignerText,
      afterDesignerText,
      { expectedDesignerRevision },
    );
    return result?.status === 'committed';
  }

  /**
   * Atomically-at-the-set-level transition every .resx in an edit. VS Code exposes no filesystem transaction, so
   * this uses the strongest available protocol: preflight ALL exact source states, write sequentially, and on a
   * failure compensate only files that still contain the bytes just written by this transition. Each target is checked
   * again immediately before its write; detected external edits fail closed, and incomplete compensation is surfaced.
   */
  private async transitionResourceSet(txs: ResxTx[], direction: 'forward' | 'undo' | 'redo'): Promise<void> {
    await transitionResourceSetAtomic(txs.map((tx) => ({
      target: tx,
      before: { text: tx.before, bom: tx.bom },
      after: { text: tx.after, bom: tx.bom },
    })), direction, {
      read: async (tx) => {
        const current = await this.readResx(tx.uri);
        return { text: current?.text ?? null, bom: current?.hadBom ?? false };
      },
      write: (tx, state) => this.writeResxState(tx.uri, state.text, state.bom),
      describe: (tx) => path.normalize(tx.uri.fsPath),
    });
  }

  /** Move an ordinary code-behind buffer between the exact two images owned by a designer transaction. After the exact
   * source-image check, apply only the single common-prefix/suffix-confined span (normally the generated method insert
   * or its inverse), never a whole-document replace. A later edit outside that span therefore survives even in the
   * narrow applyEdit race; the exact postcondition then reports the conflict instead of wiring over it. */
  private async transitionCompanionText(tx: CompanionTextTx, direction: 'undo' | 'redo'): Promise<void> {
    const source = direction === 'undo' ? tx.after : tx.before;
    const target = direction === 'undo' ? tx.before : tx.after;
    const document = tx.document.isClosed
      ? await vscode.workspace.openTextDocument(tx.document.uri)
      : tx.document;
    if (document.getText() !== source) {
      throw new Error(`code-behind transaction conflict: ${document.uri.fsPath} changed before ${direction}`);
    }
    let prefix = 0;
    while (prefix < source.length && prefix < target.length && source[prefix] === target[prefix]) prefix++;
    let suffix = 0;
    while (suffix < source.length - prefix && suffix < target.length - prefix
      && source[source.length - 1 - suffix] === target[target.length - 1 - suffix]) suffix++;
    const sourceEnd = source.length - suffix;
    const targetEnd = target.length - suffix;
    // TextEditor.edit gives the code buffer its own native undo entry. A WorkspaceEdit is registered as a bulk edit
    // and cannot reliably be replayed by the ordinary editor's Undo command on VS Code 1.84.
    // Mark this as an explicit code-view transition before revealing it; otherwise the extension's VS-style auto-open
    // listener can immediately redirect Foo.cs back into the designer and steal the edit target.
    this.onViewCode(document.uri);
    const editor = await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
    const applied = await editor.edit((edit) => edit.replace(
      new vscode.Range(document.positionAt(prefix), document.positionAt(sourceEnd)),
      target.slice(prefix, targetEnd),
    ), { undoStopBefore: true, undoStopAfter: true });
    if (!applied || document.getText() !== target) {
      throw new Error(`code-behind transaction failed: ${document.uri.fsPath} did not reach the ${direction} image`);
    }
  }

  /** Prepare replay of the ordinary editor's own history after the CustomDocument callback returns. VS Code 1.84
   * suppresses a re-entrant `undo` command while it is already awaiting a custom editor's undo callback, whereas a
   * fresh WorkspaceEdit would clear the redo branch. Validate synchronously with the callback, then enqueue the native
   * code-editor history command for the next turn and re-check both images around it. */
  private async prepareCompanionTextHistory(
    tx: CompanionTextTx,
    direction: 'undo' | 'redo',
  ): Promise<() => void> {
    const source = direction === 'undo' ? tx.after : tx.before;
    const target = direction === 'undo' ? tx.before : tx.after;
    const document = tx.document.isClosed
      ? await vscode.workspace.openTextDocument(tx.document.uri)
      : tx.document;
    const bridge = this.companionHistoryBridge;
    if (direction === 'redo'
      && bridge?.phase === 'autoRedoingDesigner'
      && normalize(bridge.tx.document.uri.fsPath) === normalize(document.uri.fsPath)
      && document.getText() === target) {
      return () => { if (this.companionHistoryBridge === bridge) this.companionHistoryBridge = undefined; };
    }
    if (document.getText() !== source) {
      throw new Error(`code-behind transaction conflict: ${document.uri.fsPath} changed before ${direction}`);
    }
    return () => {
      setTimeout(() => {
        void (async () => {
          const liveDocument = document.isClosed
            ? await vscode.workspace.openTextDocument(document.uri)
            : document;
          if (liveDocument.getText() !== source) {
            throw new Error(`code-behind transaction conflict: ${liveDocument.uri.fsPath} changed before deferred ${direction}`);
          }
          this.onViewCode(liveDocument.uri);
          await vscode.window.showTextDocument(liveDocument, { preview: false, preserveFocus: false });
          await vscode.commands.executeCommand(direction);
          if (liveDocument.getText() !== target) {
            throw new Error(`code-behind native ${direction} did not restore the expected transaction image: ${liveDocument.uri.fsPath}`);
          }
          if (direction === 'undo') {
            this.companionHistoryBridge = { tx, phase: 'awaitingCodeRedo' };
          } else {
            this.companionHistoryBridge = undefined;
          }
          this.panel.reveal(this.panel.viewColumn, false);
        })().catch((error) => {
          this.output.appendLine(`[designer] composite event ${direction} failed: ${errMsg(error)}`);
          this.post({ type: 'status', message: t('status.docChanged') });
        });
      }, 50);
    };
  }

  private onCompanionHistoryTextChanged(document: vscode.TextDocument): void {
    const bridge = this.companionHistoryBridge;
    if (!bridge || normalize(bridge.tx.document.uri.fsPath) !== normalize(document.uri.fsPath)) return;
    const text = document.getText();
    if (text === bridge.tx.before) return;
    if (text !== bridge.tx.after) {
      this.companionHistoryBridge = undefined;
      this.output.appendLine('[designer] composite event Redo bridge cancelled: code-behind changed independently');
      return;
    }
    if (bridge.phase !== 'awaitingCodeRedo') return;
    bridge.phase = 'autoRedoingDesigner';
    setTimeout(() => {
      void (async () => {
        if (this.disposed || this.companionHistoryBridge !== bridge) return;
        this.panel.reveal(this.panel.viewColumn, false);
        await vscode.commands.executeCommand('redo');
        if (this.companionHistoryBridge === bridge) {
          throw new Error('the CustomDocument Redo did not consume the code-behind bridge');
        }
      })().catch((error) => {
        this.output.appendLine('[designer] composite event Redo bridge failed: ' + errMsg(error));
        this.post({ type: 'status', message: t('status.docChanged') });
      });
    }, 75);
  }

  private resourceTransactionWorkspaceRoot(txs: ResxTx[]): string | null {
    if (!this.designerFile || txs.some((tx) => tx.uri.scheme !== 'file')) return null;
    const root = this.wsRoot() ?? path.dirname(this.designerFile);
    if (!path.isAbsolute(root)) return null;
    const normalizedRoot = path.resolve(root);
    return txs.every((tx) => isPathInsideOrSame(normalizedRoot, tx.uri.fsPath)) ? normalizedRoot : null;
  }

  private resourceTransactionJournalRoot(workspaceRoot: string): string | null {
    // VS Code 1.84 exposes the extension's on-disk global storage through the `vscode-userdata` scheme, while newer
    // hosts may expose a normal `file` URI. Both carry a real absolute fsPath; rejecting the former silently disabled
    // every durable resource transaction on the oldest supported host.
    if (!['file', 'vscode-userdata'].includes(this.globalStorageUri.scheme)) return null;
    const storagePath = this.globalStorageUri.fsPath;
    if (!path.isAbsolute(storagePath)) return null;
    return path.join(storagePath, 'v2-transactions', sha256Hex(path.resolve(workspaceRoot)).slice(0, 16));
  }

  private async commitResourceSetThroughRunner(
    label: string,
    txs: ResxTx[],
    beforeDesignerText: string,
    afterDesignerText: string = beforeDesignerText,
    options: { persistDesignerTextBeforeCommit?: boolean; expectedDesignerRevision?: number } = {},
  ): Promise<TransactionRunnerResult | null> {
    const sourceBaseline = options.persistDesignerTextBeforeCommit && this.designerFile
      ? this.doc.transactionBaseline()
      : null;
    // W0.4 — Make Localizable's generated source is a first-class journal target. It must never be written as a
    // side effect of undo registration: a later journal failure then knows how to compensate BOTH source and resx.
    const sourceTx: ResxTx | null = sourceBaseline && this.designerFile
      ? {
        uri: vscode.Uri.file(this.designerFile),
        before: sourceBaseline.text,
        after: afterDesignerText,
        bom: sourceBaseline.bom,
      }
      : null;
    const transactionTxs = sourceTx ? [...txs, sourceTx] : txs;
    const workspaceRoot = this.resourceTransactionWorkspaceRoot(transactionTxs);
    const journalRoot = workspaceRoot ? this.resourceTransactionJournalRoot(workspaceRoot) : null;
    if (!workspaceRoot || !journalRoot) return null;
    const pendingImage = sourceTx ? { text: sourceTx.after, bom: sourceTx.bom } : null;
    // The runner invokes this adapter again when replaying its durable registration. That replay is already owned by
    // the existing CustomDocument history entry and revalidates every resource baseline/postcondition itself; applying
    // the original document revision here would make every legitimate Redo refuse after Undo incremented the revision.
    // Only the first forward transaction authorizes creation of the native history entry.
    let initialUndoRegistrationAuthorized = false;
    if (pendingImage) this.pendingSourceTransactionImages.push(pendingImage);
    try {
      const result = await runDesignerResourceTransaction({
        label,
        workspaceRoot,
        journalRoot,
        targets: transactionTxs.map((tx) => ({
          filePath: tx.uri.fsPath,
          before: tx.before,
          after: tx.after,
          bom: tx.bom,
        })),
        readBytes: (filePath) => this.readResxBytes(vscode.Uri.file(filePath)),
        writeBytes: (filePath, bytes) => this.atomicWriteFile(vscode.Uri.file(filePath), bytes),
        deleteFile: async (filePath) => {
          try { await vscode.workspace.fs.delete(vscode.Uri.file(filePath)); }
          catch (error) { if (!isFileNotFound(error)) throw error; }
        },
        beforePersistJournal: async (record) => {
          if (record.state === 'prepared' && this.extensionHostAfterJournaledResourceBaseline) {
            const interleave = this.extensionHostAfterJournaledResourceBaseline;
            this.extensionHostAfterJournaledResourceBaseline = undefined;
            await interleave();
          }
          if (record.state !== this.extensionHostFailJournalState) return;
          this.extensionHostJournalFailureObserved = true;
          throw new Error(`forced Extension Host journal failure: ${record.state}`);
        },
        afterVerifiedPostconditions: this.extensionHostFailForwardResourcePostcondition
          ? (phase) => {
            if (phase !== 'forward') return true;
            this.extensionHostResourcePostconditionFailureObserved = true;
            return false;
          }
          : undefined,
        registerUndo: async () => {
          if (initialUndoRegistrationAuthorized) return true;
          await this.extensionHostBeforeJournaledResourceCommit?.();
          const authorized = this.preflightCommit(
            beforeDesignerText,
            afterDesignerText,
            label,
            transactionTxs,
            options.expectedDesignerRevision,
          );
          if (authorized) initialUndoRegistrationAuthorized = true;
          return authorized;
        },
      });
      if (result.status !== 'committed') {
        if (result.status === 'rolledBack' && sourceTx) {
          await this.reconcileRolledBackSourceTransaction(sourceTx, beforeDesignerText, afterDesignerText);
        }
        return result;
      }

      // Register the native CustomDocument edit only AFTER every journal state is durable. A late journal failure can
      // therefore compensate source/resources without leaving a phantom dirty tab or an undo item for a refused edit.
      // Recheck the exact text+revision once more; if another command won after authorization, use the runner's own
      // journal-backed rollback rather than overwriting that newer command.
      if (!this.commit(
        beforeDesignerText,
        afterDesignerText,
        label,
        transactionTxs,
        options.expectedDesignerRevision,
        result.undoRegistration,
      )) {
        const rollback = await result.undoRegistration?.undo();
        if (!rollback) throw new Error('journaled resource commit lost its rollback registration');
        if (rollback.status === 'rolledBack' && sourceTx) {
          await this.reconcileRolledBackSourceTransaction(sourceTx, beforeDesignerText, afterDesignerText);
        }
        return rollback;
      }
      return result;
    } finally {
      if (pendingImage) {
        const index = this.pendingSourceTransactionImages.indexOf(pendingImage);
        if (index >= 0) this.pendingSourceTransactionImages.splice(index, 1);
      }
    }
  }

  private async reconcileRolledBackSourceTransaction(
    sourceTx: ResxTx,
    beforeDesignerText: string,
    afterDesignerText: string,
  ): Promise<void> {
    if (!this.designerFile || normalize(sourceTx.uri.fsPath) !== normalize(this.designerFile)) return;

    // The transaction runner has already verified the restored fingerprint. Verify the host-visible byte image too
    // before touching CustomDocument state: this closes the short watcher race where the forward source write was
    // adopted as a clean external edit just before the runner compensated it on disk.
    let restored = false;
    if (sourceTx.before === null) {
      try { await vscode.workspace.fs.stat(sourceTx.uri); }
      catch (error) { restored = isFileNotFound(error); }
    } else {
      try {
        const disk = await readDesignerBytesUri(sourceTx.uri);
        restored = disk.text === sourceTx.before && disk.hadBom === sourceTx.bom;
      } catch { /* runner result remains authoritative; do not rewrite an unverifiable document */ }
    }
    if (!restored) return;

    // Invalidate an in-flight read of the transient forward image and cancel a queued one. A later watcher delivery
    // will observe the same restored baseline and become a no-op (or preserve a genuinely newer dirty edit).
    if (this.debounce) { clearTimeout(this.debounce); this.debounce = undefined; }
    this.reloadEpoch++;
    const hostOwnedImage = this.doc.designerText === beforeDesignerText
      || this.doc.designerText === afterDesignerText;
    this.doc.adoptTransactionBaseline(sourceTx.before, sourceTx.bom);
    const transientForwardImage = this.doc.designerText === afterDesignerText;
    if (transientForwardImage) {
      this.doc.designerText = beforeDesignerText;
      this.doc.rev++;
    }
    this.postDirty();

    // The forward image may already have completed a render and set Localizable/Language state even if the compensating
    // watcher replaced its text first. Re-render whenever the buffer is still one of this transaction's exact images;
    // a genuinely newer dirty edit is neither and is deliberately left alone. No native edit is fired on refusal.
    if (hostOwnedImage) await this.rerenderFromDoc();
  }

  private async commitResourceSet(label: string, txs: ResxTx[], statusTarget?: string): Promise<boolean> {
    if (!this.designerFile || !txs.length) return false;
    const before = this.doc.designerText;
    const expectedRevision = this.doc.rev;
    for (const tx of txs) {
      const fresh = await this.readResx(tx.uri);
      if ((fresh?.text ?? null) !== tx.before || (fresh?.hadBom ?? false) !== tx.bom) {
        this.post({ type: 'status', message: t('status.docChangedImport') });
        return false;
      }
      const droppedN = binaryResxCount(tx.before) - binaryResxCount(tx.after);
      if (droppedN > 0) {
        this.post({ type: 'status', message: t('status.binaryResxRegenRefused', { n: droppedN }) });
        return false;
      }
    }
    try {
      const result = await this.commitResourceSetThroughRunner(label, txs, before, before, {
        expectedDesignerRevision: expectedRevision,
      });
      if (!result || result.status !== 'committed') {
        const reason = result?.error ?? result?.status ?? 'journal unavailable';
        this.output.appendLine(`[designer] localized resource transaction refused: ${reason}`);
        this.post({ type: 'status', message: t('status.docChangedImport') });
        return false;
      }
    } catch (error) {
      this.output.appendLine(`[designer] localized resource transaction refused: ${errMsg(error)}`);
      this.post({ type: 'status', message: t('status.docChangedImport') });
      return false;
    }
    if (statusTarget) this.output.appendLine(`${label} -> ${statusTarget} (.resx written)`);
    await this.fullRender();
    await this.loadProps(this.currentId);
    await this.postDirty();
    return true;
  }

  /**
   * Make this form localizable — Visual Studio's Localizable = true. The engine composes both halves (the
   * resource-driven `.Designer.cs` and the neutral `.resx`); they are applied as ONE undoable edit, so Ctrl+Z
   * takes the form back to plain generated code and removes the .resx this created.
   */
  async makeFormLocalizable(): Promise<boolean> {
    if (!this.designerFile || this.disposed || this.localizable) return false;
    if (this.refuseUnknownBaselineMutation()) return false;
    if (this.refuseStaleRenderMutation()) return false;

    const before = this.doc.designerText;
    const rev = this.doc.rev;
    const resxUri = this.localizedResxUri(''); // the conversion always writes the NEUTRAL resource set
    const resxRead = await this.readResx(resxUri);
    let res: LocalizeFormResult;
    try {
      res = await makeLocalizable(
        await this.ensureEngine('modern'), this.designerFile, this.asm(), before, resxRead?.text ?? undefined);
    } catch (error) {
      void vscode.window.showErrorMessage(t('status.localizeRejected', { reason: errMsg(error) }));
      return false;
    }
    if (!res.safe || res.newText === null || res.resxText === null) {
      void vscode.window.showWarningMessage(t('status.localizeRejected', { reason: res.reason || 'unsafe' }));
      return false;
    }
    if (this.doc.rev !== rev) { this.post({ type: 'status', message: t('status.docChanged') }); return false; }

    const tx: ResxTx = {
      uri: resxUri, before: resxRead?.text ?? null, after: res.resxText, bom: resxRead?.hadBom ?? false,
    };
    try {
      const result = await this.commitResourceSetThroughRunner('Make localizable', [tx], before, res.newText, {
        persistDesignerTextBeforeCommit: true,
        expectedDesignerRevision: rev,
      });
      if (!result || result.status !== 'committed') {
        throw new Error(result?.error ?? result?.status ?? 'journal unavailable');
      }
    } catch (error) {
      this.output.appendLine(`[designer] localizable conversion refused: ${errMsg(error)}`);
      void vscode.window.showWarningMessage(t('status.localizeRejected', { reason: errMsg(error) }));
      return false;
    }
    // Both generated source and neutral resources were explicit journal targets. Any late failure compensates both
    // before this method can claim success.
    this.lastNoticeSig = undefined;
    this.output.appendLine(`[designer] made localizable: ${this.designerFile} (${res.keys.length} resource(s))`);
    await this.fullRender();
    await this.loadProps(this.currentId);
    await this.postDirty();
    this.post({ type: 'status', message: t('status.localizeDone', { count: res.keys.length }) });
    return true;
  }

  private async applyLocalizedResourceEdits(
    label: string,
    edits: LocalizedResourceEdit[],
    expectedDesignerRev = this.doc.rev,
  ): Promise<boolean> {
    if (!this.designerFile || !edits.length) return false;
    if (this.refuseUnknownBaselineMutation()) return false;
    if (this.refuseStaleRenderMutation()) return false;
    const culture = this.localizationCulture;
    const eng = await this.ensureEngine('modern');
    const resxUri = this.localizedResxUri(culture);
    const resxRead = await this.readResx(resxUri);
    const resxText = resxRead?.text ?? null;
    const res = await setLocalizedResources(eng, this.designerFile, culture, resxText, edits);
    if (!res.safe || res.resxText === null) {
      this.post({ type: 'status', message: t('status.editRejected', { reason: res.reason || 'unsafe' }) });
      return false;
    }
    if (this.doc.rev !== expectedDesignerRev || this.localizationCulture !== culture) {
      this.post({ type: 'status', message: t('status.docChanged') });
      return false;
    }
    const tx: ResxTx = { uri: resxUri, before: resxText, after: res.resxText, bom: resxRead?.hadBom ?? false };
    const ok = await this.commitResourceSet(label, [tx], res.resxKey);
    if (ok) this.post({ type: 'status', message: t('status.localizedResourceSet', { culture: culture || t('localization.default') }) });
    return ok;
  }

  private async removeLocalizedOverride(id: string, prop: string, label: string): Promise<boolean> {
    return this.applyLocalizedResourceEdits(label, [{
      componentId: id,
      propertyName: prop,
      propertyTypeName: 'System.String',
      invariantValue: '',
      removeOverride: true,
    }]);
  }

  /** Bind an image/icon property to an existing strongly typed project resource. Discovery is bounded to conventional
   * project-local `.resx` + adjacent `.Designer.cs` pairs. The engine cross-checks both texts and is the final authority
   * for what is losslessly representable; neither resource file is written. The chosen inputs and form revision are
   * revalidated after the user-length picker and after the engine round-trip before the one source-only commit. */
  async pickProjectImageResourceFromGrid(id: string, prop: string, requestedAccessor?: string): Promise<boolean> {
    if (!this.designerFile || this.disposed) return false;
    if (this.refuseLocalizableMutation() || this.refuseUnknownBaselineMutation() || this.refuseStaleRenderMutation()) return false;

    // postMessage is untrusted. Re-resolve the property against engine metadata published for this exact component and
    // document revision; never use the webview-supplied propType as authorization for an arbitrary source assignment.
    const published = this.publishedEditableProperty(id, prop);
    const propType = publishedProjectImagePropertyType(prop, published);
    if (!propType) {
      this.post({ type: 'status', message: t('status.editRejected', { reason: 'property metadata changed' }) });
      await this.loadProps(id);
      return false;
    }

    // V2-FND-001-S076: a picker result is untrusted even after real engine metadata authorized the target property.
    if (requestedAccessor !== undefined) {
      const reason = requestedProjectResourceAccessorRefusal(requestedAccessor);
      if (reason) {
        this.post({ type: 'status', message: t('status.editRejected', { reason }) });
        await this.loadProps(id);
        return false;
      }
    }

    try {
      const revAtStart = this.doc.rev;
      const pairs = await this.projectResourcePairs();
      if (!pairs.length) {
        this.post({ type: 'status', message: t('status.projectResourcesNone') });
        await this.loadProps(id);
        return false;
      }

      const eng = await this.ensureEngine('modern');
      const picks: Array<vscode.QuickPickItem & {
        candidate: ProjectResourceCandidate;
        pair: ProjectResourceFilePair;
        resxUri: vscode.Uri;
        designerUri: vscode.Uri;
        resxText: string;
        resourcesDesignerSource: string;
      }> = [];
      for (const pair of pairs) {
        const resxUri = vscode.Uri.file(pair.resxPath);
        const designerUri = vscode.Uri.file(pair.designerPath);
        try {
          const [resxText, resourcesDesignerSource] = await Promise.all([
            this.readProjectResourceText(resxUri, pair.projectRoot),
            this.readProjectResourceText(designerUri, pair.projectRoot),
          ]);
          const listed = await listProjectImageResources(eng, resxText, resourcesDesignerSource);
          if (!listed.ok) {
            this.output.appendLine(`[designer] project resource picker skipped ${pair.label}: ${listed.reason || 'unsafe'}`);
            continue;
          }
          for (const candidate of listed.candidates) {
            if (!imageResourceAssignable(candidate.valueTypeName, propType)) continue;
            picks.push({
              label: '$(symbol-property) ' + candidate.propertyName,
              description: candidate.resourceClassFullName,
              detail: `${candidate.valueTypeName} | ${candidate.storageKind} | ${pair.label}`,
              candidate,
              pair,
              resxUri,
              designerUri,
              resxText,
              resourcesDesignerSource,
            });
          }
        } catch (error) {
          this.output.appendLine(`[designer] project resource picker skipped ${pair.label}: ${errMsg(error)}`);
        }
      }

      // A duplicate fully-qualified accessor is not a valid tie-break by file order: omit every occurrence.
      const counts = new Map<string, number>();
      for (const choice of picks) {
        const key = `${choice.candidate.resourceClassFullName}.${choice.candidate.propertyName}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      const unique = picks.filter((choice) =>
        counts.get(`${choice.candidate.resourceClassFullName}.${choice.candidate.propertyName}`) === 1);
      if (!unique.length) {
        this.post({ type: 'status', message: t('status.projectResourcesNone') });
        await this.loadProps(id);
        return false;
      }
      if (this.doc.rev !== revAtStart) {
        this.post({ type: 'status', message: t('status.docChangedShort') });
        return false;
      }

      const picked = requestedAccessor
        ? unique.find((choice) => `${choice.candidate.resourceClassFullName}.${choice.candidate.propertyName}`
          === requestedAccessor)
        : await vscode.window.showQuickPick(unique, {
          title: t('panel.image.projectTip'),
          placeHolder: `${id}.${prop}`,
          matchOnDescription: true,
          matchOnDetail: true,
        });
      if (!picked) return false;

      // User-length picker TOCTOU close: the exact files that authorized this accessor must still be unchanged.
      const [freshResx, freshDesigner] = await Promise.all([
        this.readProjectResourceText(picked.resxUri, picked.pair.projectRoot),
        this.readProjectResourceText(picked.designerUri, picked.pair.projectRoot),
      ]);
      if (freshResx !== picked.resxText || freshDesigner !== picked.resourcesDesignerSource
        || this.doc.rev !== revAtStart || this.refuseLocalizableMutation()
        || this.refuseUnknownBaselineMutation() || this.refuseStaleRenderMutation()) {
        this.post({ type: 'status', message: t('status.docChangedImport') });
        return false;
      }

      const before = this.doc.designerText;
      const result = await setProjectImageResource(
        eng,
        this.designerFile,
        id,
        prop,
        propType,
        freshResx,
        freshDesigner,
        picked.candidate.resourceClassFullName,
        picked.candidate.propertyName,
        before);
      if (!result.safe || result.text === null) {
        this.post({ type: 'status', message: t('status.editRejected', { reason: result.reason || 'unsafe' }) });
        await this.loadProps(id);
        return false;
      }

      const [commitResx, commitDesigner] = await Promise.all([
        this.readProjectResourceText(picked.resxUri, picked.pair.projectRoot),
        this.readProjectResourceText(picked.designerUri, picked.pair.projectRoot),
      ]);
      if (commitResx !== freshResx || commitDesigner !== freshDesigner || this.doc.rev !== revAtStart
        || this.refuseLocalizableMutation() || this.refuseUnknownBaselineMutation() || this.refuseStaleRenderMutation()) {
        this.post({ type: 'status', message: t('status.docChangedImport') });
        await this.loadProps(id);
        return false;
      }
      if (result.text === before) { await this.loadProps(id); return false; }
      if (!this.commit(before, result.text, `Set ${id}.${prop} project resource`)) return false;
      this.output.appendLine(`assigned ${id}.${prop} -> ${picked.candidate.resourceClassFullName}.${picked.candidate.propertyName} (${picked.pair.label}; project resources unchanged)`);
      this.post({ type: 'status', message: t('status.projectResourceSet', { id, prop }) });
      await this.fullRender();
      await this.loadProps(id);
      await this.postDirty();
      return true;
    } catch (error) {
      this.post({ type: 'status', message: t('status.editRejected', { reason: errMsg(error) }) });
      try { await this.loadProps(id); } catch { /* best effort */ }
      return false;
    }
  }

  /**
   * Import an image into a resx-backed image/icon property ("Import…"): pick a file, embed it into the form's
   * sibling .resx and write the `resources.GetObject` assignment. The .resx is written to disk immediately (a
   * resource file, like VS), atomically (temp+rename); the .Designer.cs edit is the undoable in-memory thing.
   * 0.11.0 write-safety — the resx write is bundled into the SAME undoable transaction (via commit's `resx` arg),
   * so Ctrl+Z reverts BOTH the assignment and the resource (deleting a .resx this import created, or restoring
   * its prior bytes), and Ctrl+Y re-applies both. The resx revert is conflict-guarded (a concurrent external
   * change is left alone). Existing forward guards stay: localizable re-check, on-disk .resx conflict, binary-node drop.
   */
  async importImageFromGrid(id: string, prop: string, propType: string, requestedImage?: vscode.Uri): Promise<boolean> {
    if (!this.designerFile) return false;
    if (this.refuseUnknownBaselineMutation()) return false; // no trustworthy baseline → no file write
    const isIcon = propType === 'System.Drawing.Icon';
    const picked = requestedImage ? [requestedImage] : await vscode.window.showOpenDialog({
        canSelectMany: false, openLabel: 'Import',
        title: `Import ${isIcon ? 'an icon' : 'an image'} for ${id}.${prop}`,
        filters: isIcon ? { Icons: ['ico'] } : { Images: ['png', 'jpg', 'jpeg', 'bmp', 'gif'] },
      });
    if (!picked || !picked.length) return false; // cancelled
    try {
      const bytes = await vscode.workspace.fs.readFile(picked[0]);
      if (bytes.byteLength > 16 * 1024 * 1024) { this.post({ type: 'status', message: t('status.imageTooLarge') }); return false; }
      const imageBase64 = Buffer.from(bytes).toString('base64');
      if (this.localizable) {
        const revBefore = this.doc.rev;
        const culture = this.localizationCulture;
        const resxUri = this.localizedResxUri(culture);
        const resxRead = await this.readResx(resxUri);
        const resxText = resxRead?.text ?? null;
        const localized = await setLocalizedImageResource(
          await this.ensureEngine('modern'), this.designerFile, culture, resxText,
          id, prop, propType, imageBase64);
        if (!localized.safe || localized.resxText === null) {
          this.post({ type: 'status', message: t('status.importRejected', { reason: localized.reason || 'unsafe' }) });
          await this.loadProps(id);
          return false;
        }
        if (this.doc.rev !== revBefore || this.localizationCulture !== culture
          || this.refuseUnknownBaselineMutation() || this.refuseStaleRenderMutation()) {
          await this.loadProps(id);
          return false;
        }
        const tx: ResxTx = {
          uri: resxUri,
          before: resxText,
          after: localized.resxText,
          bom: resxRead?.hadBom ?? false,
        };
        if (await this.commitResourceSet(`Import localized ${id}.${prop} image`, [tx], localized.resxKey)) {
          this.output.appendLine(`imported localized image into ${id}.${prop} -> ${localized.resxKey} (${culture || '(Default)'})`);
          this.post({ type: 'status', message: t('status.imageImported', { id, prop }) });
          await this.loadProps(id);
          return true;
        }
        return false;
      }
      const eng = await this.ensureEngine();
      const resxUri = this.resxUri();
      const resxRead = await this.readResx(resxUri);
      const resxText = resxRead?.text ?? null;
      const resxBom = resxRead?.hadBom ?? false; // preserve the file's own BOM; a .resx we create gets none
      const before = this.doc.designerText;
      const revBefore = this.doc.rev;

      const res = await setImageResource(eng, this.designerFile, id, prop, propType, imageBase64, resxText, before);
      if (!res.safe || res.designerText === null || res.resxText === null) {
        this.post({ type: 'status', message: t('status.importRejected', { reason: res.reason || 'unsafe' }) });
        await this.loadProps(id);
        return false;
      }
      if (this.doc.rev !== revBefore) {
        this.post({ type: 'status', message: t('status.docChangedImport') });
        await this.loadProps(id);
        return false;
      }

      // 0.10.0 trust-floor TOCTOU close: the form could have turned localizable DURING the file picker /
      // engine round-trip above (the entry guard ran before them). Re-check FRESH immediately before the
      // irreversible ordinary-form .resx write, so a form that became localizable mid-operation must reroute instead.
      // The render can equally have FAILED, or the baseline gone unknown, across that same (user-length!) window:
      // commit() would then refuse and revertResx would roll the file back, so this was never a lost write — but
      // refusing here means the user's .resx is never written-then-unwritten at all.
      if (this.refuseLocalizableMutation()) { await this.loadProps(id); return false; }
      if (this.refuseUnknownBaselineMutation()) { await this.loadProps(id); return false; }
      if (this.refuseStaleRenderMutation()) { await this.loadProps(id); return false; }
      // 0.10.0 S3 fail-closed regenerate guard — two checks at the write boundary (the engine transformed the
      // `resxText` SNAPSHOT read before the file-picker/engine round-trip):
      // (1) CONCURRENCY: re-read the .resx FRESH; if it changed on disk since the snapshot (VS, git, another
      // extension), the engine's output is STALE and writing it would clobber that change → refuse (the .resx
      // analogue of the doc-rev check). This also makes the write atomic w.r.t. binary-node identity/bytes, not
      // just count.
      // (2) UPSERT REGRESSION: with the snapshot matching disk, verify the engine's output didn't DROP a binary
      // resource (count-based → robust to attribute quoting/order/malformed XML). A no-op on the normal path.
      // The BOM counts as content here (as it does for the .Designer.cs save guard): an external rewrite that only
      // changed the encoding signature still means our snapshot is stale, and we'd write the old signature back.
      const freshResx = await this.readResx(resxUri);
      if ((freshResx?.text ?? null) !== resxText || (freshResx?.hadBom ?? false) !== resxBom) {
        this.output.appendLine('import refused: the .resx changed on disk during the import (stale engine output would clobber it)');
        this.post({ type: 'status', message: t('status.docChangedImport') });
        await this.loadProps(id);
        return false; // never write a .resx built from a now-stale snapshot
      }
      const droppedN = binaryResxCount(resxText) - binaryResxCount(res.resxText);
      if (droppedN > 0) {
        this.output.appendLine(`import refused: it would drop ${droppedN} binary resx resource(s)`);
        this.post({ type: 'status', message: t('status.binaryResxRegenRefused', { n: droppedN }) });
        await this.loadProps(id);
        return false; // never write a .resx that dropped a binary node
      }
      // 0.11.0 write-safety — write the .resx to disk ATOMICALLY (temp+rename; the engine reads it from disk on the
      // render below), then commit the designer edit as ONE undoable transaction. The resx before/after is threaded
      // into commit() so Ctrl+Z reverts the resource too (deleting a .resx this import created, or restoring its
      // prior bytes) rather than leaving a permanent orphan. If a fail-closed gate refuses the designer edit AFTER
      // the resx hit disk, roll the resx back so neither half lands (never a resx entry with no assignment).
      const resxTx: ResxTx = { uri: resxUri, before: resxText, after: res.resxText, bom: resxBom };
      if (!await this.commitOrdinaryResourceEdit(
        before,
        res.designerText,
        `Import ${id}.${prop} image`,
        resxTx,
        revBefore,
      )) {
        await this.loadProps(id);
        return false;
      }
      this.output.appendLine(`imported image into ${id}.${prop} → ${res.resxKey} (${res.mode}; .resx written, designer unsaved)`);
      this.post({ type: 'status', message: t('status.imageImported', { id, prop }) });

      await this.fullRender(); // a new resx image + assignment → full re-render (not a single-control patch)
      await this.loadProps(id);
      await this.postDirty();
      return true;
    } catch (err) {
      this.post({ type: 'status', message: t('status.importFailed', { error: errMsg(err) }) });
      try { await this.loadProps(id); } catch { /* best effort */ }
      return false;
    }
  }

  /** Clear an image property ("(none)"): delete its assignment via the safe-save-gated ResetProperty. The .resx
   * entry is left as a harmless orphan (mirrors VS, which also doesn't prune unused resources on clear). */
  async clearImageFromGrid(id: string, prop: string): Promise<void> {
    if (!this.designerFile) return;
    if (this.localizable) {
      if (await this.removeLocalizedOverride(id, prop, `Reset localized ${id}.${prop} image`)) {
        this.post({ type: 'status', message: t('status.imageCleared', { id, prop }) });
        await this.loadProps(id);
      }
      return;
    }
    if (this.refuseLocalizableMutation()) return; // read-only lock: no source mutation on a localizable form (this path resets the .cs assignment; it does NOT write the .resx, so no binary-resx regenerate risk)
    if (this.refuseUnknownBaselineMutation()) return; // no trustworthy baseline → no file write
    try {
      const eng = await this.ensureEngine();
      const before = this.doc.designerText;
      const revBefore = this.doc.rev;
      const res = await resetProperty(eng, this.designerFile, id, prop, before);
      if (!res.safe) { this.post({ type: 'status', message: t('status.clearRejected', { reason: res.reason || 'unsafe' }) }); await this.loadProps(id); return; }
      if (res.text == null) { this.post({ type: 'status', message: t('status.alreadyNone', { id, prop }) }); await this.loadProps(id); return; }
      if (this.doc.rev !== revBefore) { this.post({ type: 'status', message: t('status.docChangedShort') }); await this.loadProps(id); return; }
      if (!this.commit(before, res.text, `Clear ${id}.${prop} image`)) return;
      this.output.appendLine(`cleared image ${id}.${prop} (resx entry left as an orphan — harmless)`);
      this.post({ type: 'status', message: t('status.imageCleared', { id, prop }) });
      await this.fullRender();
      await this.loadProps(id);
      await this.postDirty();
    } catch (err) {
      this.post({ type: 'status', message: t('status.clearFailed', { error: errMsg(err) }) });
      try { await this.loadProps(id); } catch { /* best effort */ }
    }
  }

  /**
   * 0.11.0 ImageList editor — edit the SELECTED ImageList's images (add / remove), then serialize the full set into
   * the ImageStream binary resource (net48, the one op needing the .NET Framework runtime) and rewrite the designer
   * (net9 SetImageList: ImageStream assignment + SetKeyName, in-code Images.Add removed), persisting BOTH texts
   * atomically + undoably (reuses the write-safety machinery + the S3 conflict/binary-drop guards). Reads the
   * CURRENT images by deserializing the existing .resx ImageStream blob (net48) and pairing them by index with the
   * keys parsed from the designer. Works for ANY project — the bundled net48 engine owns the binary (de)serialization.
   */
  async editImageListImages(
    requestedImages?: readonly { imageUri: vscode.Uri; key?: string }[],
  ): Promise<boolean> {
    if (!this.designerFile) return false;
    if (this.refuseLocalizableMutation()) return false; // writes the .resx (irreversible pre-commit) — guard up front
    if (this.refuseUnknownBaselineMutation()) return false; // no trustworthy baseline → no file write
    if (!this.renderOk) { this.post({ type: 'status', message: t('status.renderFailedReadonly') }); return false; }
    const id = this.currentId;
    if (!id || id === 'this') { this.post({ type: 'status', message: t('status.selectImageListFirst') }); return false; }
    try {
      const eng9 = await this.ensureEngine('modern');
      const asm = this.asm();
      // confirm the current selection really is an ImageList (else the SetKeyName/ImageStream rewrite is meaningless).
      const desc = this.engineKind === 'net48' && asm
        ? await describeCompiledComponent(await this.ensureEngine('net48'), this.designerFile, asm, id,
          undefined, undefined, this.doc.designerText, await this.currentCodeText())
        : await describeComponent(eng9, this.designerFile, id, asm, this.doc.designerText);
      if (!desc || !/(^|\.)ImageList$/.test(desc.type)) { this.post({ type: 'status', message: t('status.selectImageListFirst') }); return false; }

      // read the CURRENT images: deserialize the existing .resx ImageStream blob (net48), pair with designer keys.
      const resxUri = this.resxUri();
      const resxRead = await this.readResx(resxUri);
      const resxText = resxRead?.text ?? null;
      const resxBom = resxRead?.hadBom ?? false; // preserve the file's own BOM; a .resx we create gets none
      const blob = extractResxBinaryValue(resxText, id + '.ImageStream');
      const eng48 = await this.ensureEngine('net48');
      let images: Array<{ dataBase64: string; key: string; originalIndex: number | null }> = [];
      let width = 16, height = 16, colorDepth = 'Depth32Bit', transparentColor = 'Transparent';
      if (blob) {
        const read = await deserializeImageList(eng48, blob);
        if (read.ok) {
          const keys = parseImageListKeys(this.doc.designerText, id);
          images = read.images.map((im, i) => ({
            dataBase64: im.dataBase64,
            key: keys[i] ?? '',
            originalIndex: i,
          }));
          width = read.width || 16; height = read.height || 16;
          colorDepth = read.colorDepth || colorDepth; transparentColor = read.transparentColor || transparentColor;
        }
      }
      // DATA-LOSS GUARD (fail-closed): saving REPLACES the whole image set. If this ImageList already HAS images we
      // couldn't read back — a binary ImageStream node we failed to parse/deserialize, or an in-code `Images.Add`
      // whose bytes this editor doesn't materialize — starting from an empty set would silently drop them on save.
      // Refuse instead. A fresh/empty ImageList (no blob, no in-code Add) correctly proceeds so the user can add.
      const hasInCodeImages = new RegExp('\\bthis\\.' + escapeRegex(id) + '\\.Images\\.Add\\(').test(this.doc.designerText);
      // The `blob !== null` arm trusts a name-keyed scan, and binaryResx.ts documents why that scan can MISS a node
      // (odd quoting/spacing, char-refs). A miss reads as "no images" — the very state that lets the save through —
      // so ALSO refuse whenever the .resx demonstrably holds binary resources yet we resolved no blob for this id:
      // ambiguity must fail closed, not default to "replace everything". (The count comes from the mimetype scanner,
      // which is robust to all of the above.)
      const unresolvedBinary = blob === null && binaryResxCount(resxText) > 0;
      if (images.length === 0 && (blob !== null || hasInCodeImages || unresolvedBinary)) {
        this.post({ type: 'status', message: t('status.imageListUnreadable', { id }) });
        return false;
      }

      const edited = requestedImages
        ? await this.loadRequestedImageListImages(images, requestedImages)
        : await this.manageImagesUi(id, images);
      if (!edited) return false; // cancelled, invalid, or unchanged
      const oldKeys = images.map((image) => image.key);
      const oldIndexForNew = edited.map((image) => image.originalIndex ?? -1);

      // serialize the full set (net48) → VS-format ImageStream blob (+ validated round-trip count).
      const ser = await serializeImageList(eng48, { images: edited, width, height, colorDepth, transparentColor });
      if (!ser.ok) { this.post({ type: 'status', message: t('status.importRejected', { reason: ser.reason || 'unsafe' }) }); return false; }

      // rewrite the designer + embed the blob (net9) — returns both new texts.
      const before = this.doc.designerText;
      const revBefore = this.doc.rev;
      const set = await setImageList(
        eng9, this.designerFile, id, ser.base64, ser.keys, resxText, before, oldKeys, oldIndexForNew);
      if (!set.safe || set.designerText === null || set.resxText === null) { this.post({ type: 'status', message: t('status.importRejected', { reason: set.reason || 'unsafe' }) }); return false; }
      if (this.doc.rev !== revBefore) { this.post({ type: 'status', message: t('status.docChangedImport') }); return false; }
      // TOCTOU close + S3 fail-closed guards, identical to importImageFromGrid (the .resx write is irreversible).
      if (this.refuseLocalizableMutation()) return false;
      if (this.refuseUnknownBaselineMutation()) return false; // no trustworthy baseline → no file write
      if (this.refuseStaleRenderMutation()) return false; // a render that failed across the images dialog → no file write
      const freshResx = await this.readResx(resxUri);
      if ((freshResx?.text ?? null) !== resxText || (freshResx?.hadBom ?? false) !== resxBom) { this.post({ type: 'status', message: t('status.docChangedImport') }); return false; }
      const droppedN = binaryResxCount(resxText) - binaryResxCount(set.resxText);
      if (droppedN > 0) { this.post({ type: 'status', message: t('status.binaryResxRegenRefused', { n: droppedN }) }); return false; }

      // atomic + undoable write: .resx to disk (temp+rename), designer as one undoable transaction.
      const resxTx: ResxTx = { uri: resxUri, before: resxText, after: set.resxText, bom: resxBom };
      if (!await this.commitOrdinaryResourceEdit(
        before,
        set.designerText,
        `Edit ${id} images`,
        resxTx,
        revBefore,
      )) return false;
      this.output.appendLine(`edited ImageList ${id} → ${ser.count} image(s) (.resx written, designer unsaved)`);
      this.post({ type: 'status', message: t('status.imageListSaved', { id, n: ser.count }) });
      if (this.engineKind === 'net48' && asm) {
        await this.live48((engine) => setCompiledImageListLive(
          engine, this.designerFile!, asm, id, ser.base64, ser.keys), true, { skipReselect: true });
      } else {
        await this.fullRender();
      }
      await this.loadProps(id);
      await this.postDirty();
      return true;
    } catch (err) {
      this.post({ type: 'status', message: t('status.importFailed', { error: errMsg(err) }) });
      return false;
    }
  }

  /** Deterministic file-dialog substitute for the Extension Host suite. It deliberately shares the user path's
   * byte limits, key rules, engine serialization, source/resource planner, and commit boundary. */
  private async loadRequestedImageListImages(
    images: Array<{ dataBase64: string; key: string; originalIndex: number | null }>,
    requested: readonly { imageUri: vscode.Uri; key?: string }[],
  ): Promise<Array<{ dataBase64: string; key: string; originalIndex: number | null }> | null> {
    if (!requested.length) return null;
    const cur = images.slice();
    for (const item of requested) {
      let bytes: Uint8Array;
      try { bytes = await vscode.workspace.fs.readFile(item.imageUri); }
      catch { return null; }
      if (bytes.byteLength > 16 * 1024 * 1024) return null;
      const requestedKey = item.key?.trim();
      if (item.key !== undefined && (!requestedKey || requestedKey.length > 256
        || cur.some((image) => image.key === requestedKey))) return null;
      const key = requestedKey
        ?? uniqueImageKey(path.basename(item.imageUri.fsPath).replace(/\.[^.]+$/, ''), cur);
      cur.push({ dataBase64: Buffer.from(bytes).toString('base64'), key, originalIndex: null });
    }
    return cur;
  }

  /** Native ImageList manage loop. Every add/remove/reorder/key rename stays in memory until Done, then the caller
   * serializes resources + reconciles references + commits one .Designer.cs/.resx undo transaction. originalIndex
   * follows an image through moves/renames so ImageIndex/ImageKey users can keep their logical target. */
  private async manageImagesUi(
    id: string,
    images: Array<{ dataBase64: string; key: string; originalIndex: number | null }>,
  ): Promise<Array<{ dataBase64: string; key: string; originalIndex: number | null }> | null> {
    const cur = images.slice();
    let changed = false;
    for (; ;) {
      const menu: Array<vscode.QuickPickItem & { action: string }> = [
        { label: '$(add) ' + t('imageList.add'), action: 'add' },
      ];
      if (cur.length) menu.push({ label: '$(trash) ' + t('imageList.remove'), action: 'remove' });
      if (cur.length) menu.push({ label: '$(edit) ' + t('imageList.rename'), action: 'rename' });
      if (cur.length > 1) {
        menu.push({ label: '$(arrow-up) ' + t('imageList.moveUp'), action: 'up' });
        menu.push({ label: '$(arrow-down) ' + t('imageList.moveDown'), action: 'down' });
      }
      menu.push({ label: '$(check) ' + t('imageList.done'), action: 'done' });
      const pick = await vscode.window.showQuickPick(menu, {
        title: t('imageList.title', { id }),
        placeHolder: tn('imageList.count', cur.length, { n: cur.length }),
      });
      if (!pick || pick.action === 'done') break;
      if (pick.action === 'add') {
        const files = await vscode.window.showOpenDialog({
          canSelectMany: true, openLabel: t('imageList.add'),
          filters: { Images: ['png', 'jpg', 'jpeg', 'bmp', 'gif', 'ico'] },
        });
        for (const f of files ?? []) {
          try {
            const bytes = await vscode.workspace.fs.readFile(f);
            if (bytes.byteLength > 16 * 1024 * 1024) continue; // per-image bound (engine also enforces)
            const key = uniqueImageKey(path.basename(f.fsPath).replace(/\.[^.]+$/, ''), cur);
            cur.push({ dataBase64: Buffer.from(bytes).toString('base64'), key, originalIndex: null });
            changed = true;
          } catch { /* skip an unreadable file */ }
        }
      } else if (pick.action === 'remove') {
        const rmPicks = await vscode.window.showQuickPick(
          cur.map((im, i) => ({ label: im.key || `#${i}`, description: `#${i}`, idx: i })),
          { canPickMany: true, title: t('imageList.remove') },
        );
        if (rmPicks && rmPicks.length) {
          const rm = new Set(rmPicks.map((r) => r.idx));
          for (let i = cur.length - 1; i >= 0; i--) if (rm.has(i)) cur.splice(i, 1);
          changed = true;
        }
      } else if (pick.action === 'rename') {
        const target = await vscode.window.showQuickPick(
          cur.map((im, i) => ({ label: im.key || `#${i}`, description: `#${i}`, idx: i })),
          { title: t('imageList.rename') },
        );
        if (!target) continue;
        const next = await vscode.window.showInputBox({
          title: t('imageList.renameTitle', { index: target.idx }),
          value: cur[target.idx].key,
          prompt: t('imageList.renamePrompt'),
          validateInput: (value) => {
            const key = value.trim();
            if (!key) return t('imageList.keyRequired');
            if (key.length > 256) return t('imageList.keyTooLong');
            if (cur.some((image, index) => index !== target.idx && image.key === key))
              return t('imageList.keyDuplicate');
            return null;
          },
        });
        if (next !== undefined) {
          const key = next.trim();
          if (key && key !== cur[target.idx].key) {
            cur[target.idx] = { ...cur[target.idx], key };
            changed = true;
          }
        }
      } else if (pick.action === 'up' || pick.action === 'down') {
        const delta = pick.action === 'up' ? -1 : 1;
        const movable = cur
          .map((im, i) => ({ label: im.key || `#${i}`, description: `#${i}`, idx: i }))
          .filter((item) => item.idx + delta >= 0 && item.idx + delta < cur.length);
        const target = await vscode.window.showQuickPick(movable, {
          title: pick.action === 'up' ? t('imageList.moveUp') : t('imageList.moveDown'),
        });
        if (target) {
          const other = target.idx + delta;
          [cur[target.idx], cur[other]] = [cur[other], cur[target.idx]];
          changed = true;
        }
      }
    }
    return changed ? cur : null;
  }

  /** Per-property Reset (VS grid right-click → "Reset"): delete the property's source assignment via the
   * safe-save-gated, no-op-safe ResetProperty (a pure net9 text splice, engine-agnostic), then refresh the picture.
   * net9 re-renders the interpreted graph from the edited text; net48 renders the COMPILED assembly (stale after a
   * text-only edit), so it resets the LIVE instance (pd.ResetValue) for an immediate, matching picture. */
  async resetFromGrid(id: string, prop: string, multi = false): Promise<void> {
    if (!this.designerFile) return;
    try {
      if (multi) {
        const published = this.publishedMultiProperty(id, prop);
        if (!published || !published.property.multiResettable) {
          this.post({ type: 'status', message: t('status.resetRejected', { reason: 'stale or non-resettable multi-object property metadata' }) });
          await this.loadProps(id);
          return;
        }
        await this.applyMultiReset(published.ids, prop);
        return;
      }
      const before = this.doc.designerText;
      const revBefore = this.doc.rev;
      const codeBehindBefore = this.engineKind === 'net48' ? await this.currentCodeText() : undefined;
      const publishedComponent = this.publishedPropertyComponent?.ids.length === 1
        && this.publishedPropertyComponent.ids[0] === id
        && this.publishedPropertyComponent.rev === revBefore
        ? this.publishedPropertyComponent.component : null;
      if (publishedComponent?.ownership === 'inherited') {
        const property = publishedComponent.properties.find((candidate) => candidate.name === prop) ?? null;
        const token = publishedComponent.baseIdentityToken ?? '';
        const resettable = publishedComponent.inheritedOverrideEditable === true
          && property?.inheritedOverrideResettable === true && property.sourceExplicit === true
          && token.length > 0;
        if (!resettable) {
          this.post({ type: 'status', message: t('status.resetRejected', { reason: 'stale or non-resettable inherited override metadata' }) });
          await this.loadProps(id);
          return;
        }
        if (this.localizable) {
          this.post({ type: 'status', message: t('status.resetRejected', { reason: 'localized inherited overrides are not supported' }) });
          await this.loadProps(id);
          return;
        }

        const authority = await this.ensureEngine(this.engineKind);
        const res = await removeInheritedPropertyOverride(
          authority, this.designerFile, id, prop, token, this.asm(), before, codeBehindBefore);
        if (!res.safe || res.text === null) {
          this.post({ type: 'status', message: t('status.resetRejected', { reason: res.reason || 'unsafe inherited reset' }) });
          await this.loadProps(id);
          return;
        }
        if (this.doc.rev !== revBefore) {
          this.post({ type: 'status', message: t('status.docChangedShort') });
          await this.loadProps(id);
          return;
        }
        if (this.engineKind === 'net48' && await this.currentCodeText() !== codeBehindBefore) {
          this.post({ type: 'status', message: t('status.docChangedShort') });
          await this.loadProps(id);
          return;
        }
        if (res.text === before) {
          this.post({ type: 'status', message: t('status.alreadyDefault', { id, prop }) });
          await this.loadProps(id);
          return;
        }
        if (!this.commit(before, res.text, `Reset inherited ${id}.${prop}`)) return;
        this.output.appendLine(`removed derived override ${id}.${prop} → inherited base value (unsaved)`);
        this.post({ type: 'status', message: t('status.propReset', { id, prop }) });
        await this.fullRender();
        await this.loadProps(id);
        await this.postDirty();
        return;
      }
      if (this.localizable) {
        if (await this.removeLocalizedOverride(id, prop, `Reset localized ${id}.${prop}`)) {
          this.output.appendLine(`reset localized ${id}.${prop} -> culture fallback (${this.localizationCultureLabel()})`);
          this.post({ type: 'status', message: t('status.propReset', { id, prop }) });
          await this.loadProps(id);
        }
        return;
      }
      const eng = await this.ensureEngine();
      const res = await resetProperty(eng, this.designerFile, id, prop, before);
      if (!res.safe) { this.post({ type: 'status', message: t('status.resetRejected', { reason: res.reason || 'unsafe' }) }); await this.loadProps(id); return; }
      if (res.text == null) { this.post({ type: 'status', message: t('status.alreadyDefault', { id, prop }) }); await this.loadProps(id); return; }
      if (this.doc.rev !== revBefore) { this.post({ type: 'status', message: t('status.docChangedShort') }); await this.loadProps(id); return; }
      if (!this.commit(before, res.text, `Reset ${id}.${prop}`)) return;
      this.output.appendLine(`reset ${id}.${prop} → default (unsaved)`);
      this.post({ type: 'status', message: t('status.propReset', { id, prop }) });
      if (this.engineKind === 'net48') {
        await this.liveReset48(id, prop);
      } else {
        await this.patchOrRerender(id, prop);
      }
      await this.loadProps(id);
      await this.postDirty();
    } catch (err) {
      this.post({ type: 'status', message: t('status.resetFailed', { error: errMsg(err) }) });
      try { await this.loadProps(id); } catch { /* best effort */ }
    }
  }

  /** Reset a shared scalar property to its default across the exact published selection. Source and localized-resource
   * adapters both return a complete batch or no change, and the custom document receives one undo record. */
  private async applyMultiReset(ids: string[], prop: string): Promise<void> {
    if (!this.designerFile || ids.length < 2) return;
    const revBefore = this.doc.rev;

    if (this.localizable) {
      const edits: LocalizedResourceEdit[] = ids.map((componentId) => ({
        componentId,
        propertyName: prop,
        propertyTypeName: 'System.String',
        invariantValue: '',
        removeOverride: true,
      }));
      if (await this.applyLocalizedResourceEdits(`Reset ${prop} on ${ids.length} localized controls`, edits, revBefore)) {
        this.output.appendLine(`reset localized ${prop} on ${ids.length} controls (${this.localizationCultureLabel()})`);
        this.post({ type: 'status', message: tn('status.multiPropReset', ids.length, { prop }) });
        await this.loadProps(this.currentId);
      }
      return;
    }

    const eng = await this.ensureEngine('modern');
    const before = this.doc.designerText;
    const result = await resetProperties(eng, this.designerFile, ids, prop, before);
    if (!result.safe) {
      this.post({ type: 'status', message: t('status.resetRejected', { reason: result.reason || 'unsafe' }) });
      await this.loadProps(this.currentId);
      return;
    }
    if (result.text == null) {
      this.post({ type: 'status', message: t('status.alreadyDefault', { id: `${ids.length} controls`, prop }) });
      await this.loadProps(this.currentId);
      return;
    }
    if (this.doc.rev !== revBefore) {
      this.post({ type: 'status', message: t('status.docChangedShort') });
      await this.loadProps(this.currentId);
      return;
    }
    if (!this.commit(before, result.text, `Reset ${prop} on ${ids.length} controls`)) return;

    const liveEdits: CompiledEdit[] = ids.map((componentId) => ({
      componentId,
      propName: prop,
      rawValue: '',
      reset: true,
    }));
    this.output.appendLine(`reset ${prop} on ${ids.length} controls (one undo unit, unsaved)`);
    this.post({ type: 'status', message: tn('status.multiPropReset', ids.length, { prop }) });
    if (this.engineKind === 'net48') {
      await this.live48((engine) => applyCompiledEdits(engine, this.designerFile!, this.asm()!, liveEdits), true,
        { skipReselect: true, edits: liveEdits });
      await this.loadProps(this.currentId);
    } else {
      await this.fullRender();
    }
    await this.postDirty();
  }

  /** Reset a ToolStrip item property to its default — the item-aware sibling of resetFromGrid (routed here when the
   * grid message carries an `ownerId`, i.e. item→Properties is shown). The text splice (resetProperty) is field-agnostic
   * so it targets the item field directly; the picture-refresh mirrors applyItemEdit: net9 fullRender(skipReselect) to
   * keep the item highlight (not patchOrRerender, which reselects the control), net48 liveReset48 (the SAME live-reset
   * primitive controls use — TryReset already resolves a ToolStripItem via ResolveLiveEditTarget). Refreshes the item
   * grid via the itemProps channel (loadItemProps), never the control props (loadProps). */
  async resetItemFromGrid(ownerId: string, itemId: string, prop: string): Promise<void> {
    if (!this.designerFile) return;
    try {
      if (this.localizable) {
        if (await this.removeLocalizedOverride(itemId, prop, `Reset localized ${itemId}.${prop}`)) {
          this.post({ type: 'status', message: t('status.propReset', { id: itemId, prop }) });
          await this.loadItemProps(ownerId, itemId);
        }
        return;
      }
      const eng = await this.ensureEngine();
      const before = this.doc.designerText;
      const revBefore = this.doc.rev;
      const res = await resetProperty(eng, this.designerFile, itemId, prop, before);
      if (!res.safe) { this.post({ type: 'status', message: t('status.resetRejected', { reason: res.reason || 'unsafe' }) }); await this.loadItemProps(ownerId, itemId); return; }
      if (res.text == null) { this.post({ type: 'status', message: t('status.alreadyDefault', { id: itemId, prop }) }); await this.loadItemProps(ownerId, itemId); return; }
      if (this.doc.rev !== revBefore) { this.post({ type: 'status', message: t('status.docChangedShort') }); await this.loadItemProps(ownerId, itemId); return; }
      if (!this.commit(before, res.text, `Reset ${itemId}.${prop}`)) return;
      this.output.appendLine(`reset ${itemId}.${prop} → default (unsaved)`);
      this.post({ type: 'status', message: t('status.propReset', { id: itemId, prop }) });
      if (this.engineKind === 'net48') {
        await this.liveReset48(itemId, prop);
      } else {
        await this.fullRender(true);
      }
      await this.loadItemProps(ownerId, itemId);
      await this.postDirty();
    } catch (err) {
      this.post({ type: 'status', message: t('status.resetFailed', { error: errMsg(err) }) });
      try { await this.loadItemProps(ownerId, itemId); } catch { /* best effort */ }
    }
  }

  /** net48 compiled preview after a Reset commit: reset the property on the LIVE instance (pd.ResetValue) so the
   * picture matches the now-default value. Re-rendering the compiled assembly would show the stale built value
   * (the bug clearImageFromGrid's fullRender exhibits); the committed text is what persists after a rebuild.
   * Best-effort — a non-resettable prop leaves the picture unchanged with a note. */
  private async liveReset48(id: string, prop: string): Promise<void> {
    const asm = this.asm();
    if (!asm || !this.designerFile) return;
    await this.live48((eng) => resetCompiledPropertyLive(eng, this.designerFile!, asm, id, prop), true, { skipReselect: true });
  }

  /** Grid edit of a TableLayoutPanel child's Column/Row — routed here (not applyEdit) because the cell lives in
   * the 3-arg Controls.Add, not a property assignment. Mirrors editFromGrid's error/restore handling. */
  async tableCellFromGrid(id: string, cell: string, value: string): Promise<void> {
    try {
      await this.applyTableCell(id, cell, value);
    } catch (err) {
      this.post({ type: 'status', message: errMsg(err) });
      try { await this.loadProps(id); } catch { /* best effort */ }
    }
  }

  private async applyTableCell(id: string, cell: string, raw: string): Promise<void> {
    if (!this.designerFile) return;
    const n = Number.parseInt(String(raw).trim(), 10);
    if (!Number.isInteger(n) || n < 0) {
      this.post({ type: 'status', message: t('status.cellInteger', { cell }) });
      await this.loadProps(id);
      return;
    }
    await this.applyTableCellPosition(
      id,
      cell === 'Column' ? n : null,
      cell === 'Row' ? n : null,
      `Set ${id}.${cell}`,
      `set ${id}.${cell} = ${n} (table cell, unsaved)`,
    );
  }

  /** Commit one or both TableLayoutPanel extender coordinates from one authoritative source snapshot. The grid uses
   * one nullable axis; a canvas drop supplies both so moving to a different cell is one native Undo unit. */
  private async applyTableCellPosition(
    id: string,
    column: number | null,
    row: number | null,
    label: string,
    outputLine: string,
  ): Promise<boolean> {
    if (!this.designerFile || (column === null && row === null)) return false;
    const eng = await this.ensureEngine();
    const before = this.doc.designerText;
    const revBefore = this.doc.rev;
    const res = await setTableCell(eng, this.designerFile, id, column, row, before);
    if (!res.safe || res.text === null) {
      this.post({ type: 'status', message: t('status.cellEditRejected', { reason: res.reason || 'unsafe' }) });
      await this.loadProps(id);
      return false;
    }
    if (this.doc.rev !== revBefore) {
      this.post({ type: 'status', message: t('status.docChanged') });
      await this.loadProps(id);
      return false;
    }
    if (res.text === before) return false;
    if (!this.commit(before, res.text, label)) return false;
    this.output.appendLine(outputLine);
    this.post({ type: 'status', message: column !== null && row !== null
      ? `Moved ${id} to table cell ${column}, ${row}`
      : t('status.cellSet', { id, cell: column !== null ? 'Column' : 'Row' }) });

    // a cell move repositions the control and can re-flow its siblings → full re-render, not a single-control patch
    await this.fullRender();
    await this.loadProps(id);
    await this.postDirty();
    return true;
  }

  /** Route a move gesture for a layout-owned child. `null` means the child is not managed by a supported layout and
   * ordinary geometry handling should continue; a boolean means the layout gesture was fully handled. */
  private async applyManagedLayoutMove(id: string, dropX: number, dropY: number): Promise<boolean | null> {
    const child = this.controls.find((control) => control.id === id);
    const parent = child?.parentId
      ? this.controls.find((control) => control.id === child.parentId) ?? null
      : null;
    if (!child || !parent) return null;
    if (/TableLayoutPanel$/.test(parent.type)) {
      const columns = parent.tableColumnWidths ?? [];
      const rows = parent.tableRowHeights ?? [];
      if (!columns.length || !rows.length) {
        this.post({ type: 'status', message: t('status.editRejected', { reason: 'live table cell geometry is unavailable' }) });
        await this.fullRender();
        return false;
      }
      const axisIndex = (value: number, sizes: readonly number[]): number => {
        if (!Number.isFinite(value) || value < 0) return -1;
        let edge = 0;
        for (let index = 0; index < sizes.length; index++) {
          edge += Math.max(0, sizes[index] ?? 0);
          if (value < edge || (index === sizes.length - 1 && value <= edge)) return index;
        }
        return -1;
      };
      const column = axisIndex(dropX - (parent.clientX ?? parent.x), columns);
      const row = axisIndex(dropY - (parent.clientY ?? parent.y), rows);
      if (column < 0 || row < 0) {
        this.post({ type: 'status', message: t('status.editRejected', { reason: 'drop point is outside the live table grid' }) });
        await this.fullRender();
        return false;
      }
      return this.applyTableCellPosition(
        id,
        column,
        row,
        `Move ${id} to table cell ${column},${row}`,
        `moved ${id} to TableLayoutPanel cell ${column},${row} (unsaved)`,
      );
    }
    if (/FlowLayoutPanel$/.test(parent.type)) {
      return this.applyFlowLayoutDrop(parent, id, dropX, dropY);
    }
    return null;
  }

  /** Convert a FlowLayoutPanel drop point into a complete visual sibling order, then realize that order against a
   * still-local source snapshot. Each engine MoveZOrder step is only a planner operation; commit() runs once. */
  private async applyFlowLayoutDrop(parent: LayoutControl, id: string, dropX: number, dropY: number): Promise<boolean> {
    if (!this.designerFile) return false;
    const direction = parent.flowDirection ?? '';
    if (!['LeftToRight', 'RightToLeft', 'TopDown', 'BottomUp'].includes(direction)) {
      this.post({ type: 'status', message: t('status.editRejected', { reason: 'live flow direction is unavailable' }) });
      await this.fullRender();
      return false;
    }
    const centerX = (control: LayoutControl): number => control.x + control.width / 2;
    const centerY = (control: LayoutControl): number => control.y + control.height / 2;
    const visualCompare = (left: LayoutControl, right: LayoutControl): number => {
      if (direction === 'LeftToRight' || direction === 'RightToLeft') {
        const row = centerY(left) - centerY(right);
        if (Math.abs(row) > 1) return row;
        return direction === 'LeftToRight' ? centerX(left) - centerX(right) : centerX(right) - centerX(left);
      }
      const column = centerX(left) - centerX(right);
      if (Math.abs(column) > 1) return column;
      return direction === 'TopDown' ? centerY(left) - centerY(right) : centerY(right) - centerY(left);
    };
    const siblings = this.controls
      .filter((control) => control.parentId === parent.id)
      .sort(visualCompare);
    const dragged = siblings.find((control) => control.id === id);
    if (!dragged || siblings.length < 2) return false;
    const remaining = siblings.filter((control) => control.id !== id);
    let nearestIndex = 0;
    let nearestDistance = Number.POSITIVE_INFINITY;
    remaining.forEach((control, index) => {
      const dx = dropX - centerX(control);
      const dy = dropY - centerY(control);
      const distance = dx * dx + dy * dy;
      if (distance < nearestDistance) { nearestDistance = distance; nearestIndex = index; }
    });
    const nearest = remaining[nearestIndex];
    const before = direction === 'LeftToRight' ? dropX < centerX(nearest)
      : direction === 'RightToLeft' ? dropX > centerX(nearest)
        : direction === 'TopDown' ? dropY < centerY(nearest)
          : dropY > centerY(nearest);
    remaining.splice(nearestIndex + (before ? 0 : 1), 0, dragged);
    const currentOrder = siblings.map((control) => control.id);
    const desiredOrder = remaining.map((control) => control.id);
    if (desiredOrder.every((controlId, index) => controlId === currentOrder[index])) {
      await this.fullRender();
      return false;
    }

    const eng = await this.ensureEngine('modern');
    const beforeText = this.doc.designerText;
    const rev = this.doc.rev;
    let text = beforeText;
    for (const controlId of desiredOrder) {
      const result = await moveZOrder(eng, this.designerFile, controlId, false, text);
      if (!result.safe || result.newText === null) {
        this.post({ type: 'status', message: t('status.editRejected', { reason: result.reason || 'unsafe flow reorder' }) });
        await this.fullRender();
        return false;
      }
      text = result.newText;
    }
    if (this.doc.rev !== rev) {
      this.post({ type: 'status', message: t('status.docChanged') });
      await this.fullRender();
      return false;
    }
    if (text === beforeText || !this.commit(beforeText, text, `Reorder ${parent.id}`)) {
      await this.fullRender();
      return false;
    }
    this.output.appendLine(`reordered ${id} in ${parent.id}: ${desiredOrder.join(', ')} (unsaved)`);
    await this.fullRender();
    await this.loadProps(id);
    await this.postDirty();
    this.post({ type: 'status', message: `Reordered ${id}` });
    return true;
  }

  /** Read side of the string-collection editor: send the "…"-opened collection's current items to the webview.
   * Parses the unsaved buffer (so it reflects pending edits). PURE-TEXT Roslyn parse → routed to the net9 engine
   * even for a net48 form (the compiled engine can't parse literal Add/AddRange; the text is framework-agnostic). */
  async sendCollectionItems(id: string, prop: string): Promise<void> {
    if (!this.designerFile) {
      this.post({ type: 'collectionItems', id, prop, ok: false, items: [], reason: 'not available' });
      return;
    }
    try {
      const eng = await this.ensureEngine('modern');
      const res = await listCollectionItems(eng, this.designerFile, id, prop, this.doc.designerText);
      this.post({ type: 'collectionItems', id, prop, ok: res.ok, items: res.items ?? [], reason: res.reason });
    } catch (err) {
      this.post({ type: 'collectionItems', id, prop, ok: false, items: [], reason: errMsg(err) });
    }
  }

  /** Resolve an editor request only against metadata that this session actually published for the current source
   * revision. Webview messages are untrusted, so neither an item type nor a modal editor type can be invented by a
   * forged postMessage. */
  private publishedEditableProperty(id: string, prop: string): ComponentDesc['properties'][number] | null {
    const published = this.publishedPropertyComponent;
    if (!published || published.ids.length !== 1 || published.ids[0] !== id || published.rev !== this.doc.rev) return null;
    const component = published.component;
    if (!component) return null;
    const property = component.properties.find((p) => p.name === prop) ?? null;
    if (!property || property.readOnly) return null;
    if (component.editable !== false) return property;
    return component.ownership === 'inherited' && component.inheritedOverrideEditable === true
      && property.inheritedOverrideEditable === true && !!component.baseIdentityToken
      ? property : null;
  }

  /** Resolve an explicit panel multi-object request only against the exact synthetic intersection most recently
   * published for the current source revision and the still-current canvas selection. */
  private publishedMultiProperty(id: string, prop: string): { ids: string[]; property: ComponentDesc['properties'][number] } | null {
    const published = this.publishedPropertyComponent;
    if (!published || published.ids.length < 2 || published.rev !== this.doc.rev) return null;
    if (published.ids[published.ids.length - 1] !== id || published.ids.length !== this.currentSelectionIds.length) return null;
    for (let i = 0; i < published.ids.length; i++) if (published.ids[i] !== this.currentSelectionIds[i]) return null;
    const component = published.component;
    if (!component || component.editable === false || component.multiCount !== published.ids.length) return null;
    const property = component.properties.find((candidate) => candidate.name === prop) ?? null;
    return property && property.multi === true && !property.readOnly
      ? { ids: published.ids.slice(), property }
      : null;
  }

  /** Read side of the bounded generic IList/IList<T> source adapter. Like every source collection reader, this is
   * deliberately routed through the modern Roslyn engine even when the picture is a net48 compiled/interpreted form. */
  async sendGenericListItems(id: string, prop: string, itemType: string): Promise<void> {
    if (!this.designerFile) {
      this.post({ type: 'genericListItems', id, prop, itemType, ok: false, items: [], reason: 'not available' });
      return;
    }
    const metadata = this.publishedEditableProperty(id, prop);
    if (!metadata?.genericCollection || metadata.collectionItemType !== itemType) {
      this.post({ type: 'genericListItems', id, prop, itemType, ok: false, items: [], reason: 'property metadata changed' });
      return;
    }
    try {
      const eng = await this.ensureEngine('modern');
      const res = await listGenericListItems(eng, this.designerFile, id, prop, itemType, this.doc.designerText);
      // The shared popup is deliberately line-based. A scalar string/char item containing a physical newline cannot
      // be represented losslessly there (it would be mistaken for two items), so refuse the read instead of opening
      // an editor that could silently rewrite the collection on OK.
      const multilineItem = res.ok && (res.items ?? []).some((item) => /[\r\n]/.test(item));
      this.post({
        type: 'genericListItems', id, prop, itemType: res.itemTypeName || itemType,
        ok: multilineItem ? false : res.ok,
        items: multilineItem ? [] : (res.items ?? []),
        reason: multilineItem ? 'an item contains a newline and cannot be edited losslessly in the line editor' : res.reason,
      });
    } catch (err) {
      this.post({ type: 'genericListItems', id, prop, itemType, ok: false, items: [], reason: errMsg(err) });
    }
  }

  async genericListFromGrid(id: string, prop: string, itemType: string, items: string[]): Promise<void> {
    try {
      await this.applyGenericList(id, prop, itemType, items);
    } catch (err) {
      this.post({ type: 'status', message: errMsg(err) });
      try { await this.loadProps(id); } catch { /* best effort */ }
    }
  }

  private async applyGenericList(id: string, prop: string, itemType: string, items: string[]): Promise<void> {
    if (!this.designerFile) return;
    const metadata = this.publishedEditableProperty(id, prop);
    if (!metadata?.genericCollection || metadata.collectionItemType !== itemType) {
      this.post({ type: 'status', message: t('status.editRejected', { reason: 'property metadata changed' }) });
      await this.loadProps(id);
      return;
    }

    const before = this.doc.designerText;
    const revBefore = this.doc.rev;
    const eng = await this.ensureEngine('modern');
    const res = await setGenericListItems(eng, this.designerFile, id, prop, itemType, items, before);
    if (!res.safe || res.text === null) {
      this.post({ type: 'status', message: t('status.editRejected', { reason: res.reason || 'unsafe' }) });
      await this.loadProps(id);
      return;
    }
    const certifiedVendorCollection = !!metadata.uiTypeEditor
      && !!metadata.uiTypeEditorAssemblyPath
      && !!metadata.uiTypeEditorAssemblySha256
      && !!metadata.uiTypeEditorCertificationId;
    let proposedText = res.text;
    if (certifiedVendorCollection) {
      this.lastPropertyPersistenceLane = null;
      this.lastOwnedRegionRefusal = null;
      if (this.extensionHostVendorCollectionProposalTransform) {
        proposedText = this.extensionHostVendorCollectionProposalTransform(proposedText);
      }
      const bounded = await planBoundedComponentPatch(
        eng,
        before,
        sha256Hex(before),
        proposedText,
        id,
        `${id}.${prop}`,
      );
      if (!bounded.safe || !bounded.semanticEquivalence || !bounded.outsideRegionPreserved
        || !bounded.plannedSourceText || bounded.plannedSourceText !== proposedText) {
        this.lastOwnedRegionRefusal = bounded.reason || 'owned-region component proof was incomplete';
        this.post({ type: 'status', message: t('status.editRejected', { reason: this.lastOwnedRegionRefusal }) });
        await this.loadProps(id);
        return;
      }
      proposedText = bounded.plannedSourceText;
      this.lastPropertyPersistenceLane = 'ownedRegion';
    } else {
      this.lastPropertyPersistenceLane = 'sourceFirst';
      this.lastOwnedRegionRefusal = null;
    }
    if (this.doc.rev !== revBefore) {
      this.post({ type: 'status', message: t('status.docChanged') });
      await this.loadProps(id);
      return;
    }
    if (!this.commit(before, proposedText, `Set ${id}.${prop}`)) return;
    this.output.appendLine(`set ${id}.${prop} = ${itemType}[${items.length}] (generic source collection, unsaved)`);
    this.post({ type: 'status', message: t('status.propSet', { id, prop }) });
    // No broad live-mutation adapter exists for arbitrary vendor IList values. A full render is the only safe visual
    // follow-up: modern/net48-interpreted re-materialise the source, while net48 compiled fallback honestly remains
    // the last build under its existing disclosure instead of mutating an unknown runtime collection.
    await this.fullRender();
    await this.loadProps(id);
    await this.postDirty();
  }

  /** Invoke one allowlisted framework or certified vendor UITypeEditor in the engine's isolated worker, then feed the
   * returned invariant value through the existing scalar transaction (source-first on ordinary forms, selected .resx
   * on localizable forms). The worker never writes files and a dismissal is a true no-op. */
  async uiTypeEditorFromGrid(
    id: string,
    prop: string,
    propType: string,
    editorType: string,
  ): Promise<SupportedUiTypeEditorResult | null> {
    if (this.uiTypeEditorBusy) {
      this.post({ type: 'status', message: 'A property editor is already open.' });
      return null;
    }
    const metadata = this.publishedEditableProperty(id, prop);
    if (!metadata || metadata.type !== propType || metadata.uiTypeEditor !== editorType) {
      this.post({ type: 'status', message: t('status.editRejected', { reason: 'property metadata changed' }) });
      return null;
    }

    const revBefore = this.doc.rev;
    this.uiTypeEditorBusy = true;
    try {
      const eng = await this.ensureEngine('modern');
      if (this.doc.rev !== revBefore) {
        this.post({ type: 'status', message: t('status.docChanged') });
        return null;
      }
      const result = this.extensionHostUiTypeEditorResult ?? await editSupportedUiTypeEditor(
          eng,
          `ui-${randomBytes(16).toString('hex')}`,
          editorType,
          propType,
          metadata.value ?? '',
          metadata.uiTypeEditorAssemblyPath ?? null,
          metadata.uiTypeEditorAssemblySha256 ?? null,
          metadata.uiTypeEditorCertificationId ?? null,
        );
      if (this.extensionHostUiTypeEditorResult) this.extensionHostUiTypeEditorResultConsumed = true;
      if (this.doc.rev !== revBefore) {
        this.post({ type: 'status', message: t('status.docChanged') });
        await this.loadProps(id);
        return result;
      }
      if (result.dismissed || !result.applied) {
        if (!result.ok && !result.dismissed) {
          this.post({ type: 'status', message: t('status.editRejected', { reason: result.reason || result.errorCode || 'editor failed' }) });
        }
        return result;
      }
      if (!result.ok || result.invariantValue == null) {
        this.post({ type: 'status', message: t('status.editRejected', { reason: result.reason || result.errorCode || 'editor returned no value' }) });
        return result;
      }
      // editFromGrid re-runs normal conversion/minimality/revision checks and creates exactly one undo entry. Calling
      // it (rather than committing broker output) keeps the source transaction authoritative.
      await this.editFromGrid(id, prop, propType, metadata.isEnum, result.invariantValue);
      return result;
    } catch (err) {
      this.post({ type: 'status', message: errMsg(err) });
      return null;
    } finally {
      this.uiTypeEditorBusy = false;
    }
  }

  /** Write side of the string-collection editor (VS "String Collection Editor"): rewrite the owner's Add/AddRange
   * calls to exactly `items`. Mirrors tableCellFromGrid's error/restore + single-undo commit. */
  async collectionFromGrid(id: string, prop: string, items: string[]): Promise<void> {
    try {
      await this.applyCollection(id, prop, items);
    } catch (err) {
      this.post({ type: 'status', message: errMsg(err) });
      try { await this.loadProps(id); } catch { /* best effort */ }
    }
  }

  private async applyCollection(id: string, prop: string, items: string[]): Promise<void> {
    if (!this.designerFile) return;
    // PURE-TEXT splice — route to net9 even on a net48 form (the compiled engine can't splice; the text is truth).
    const eng = await this.ensureEngine('modern');
    const before = this.doc.designerText;
    const revBefore = this.doc.rev;

    const res = await setCollectionItems(eng, this.designerFile, id, prop, items, before);
    if (!res.safe || res.text === null) {
      this.post({ type: 'status', message: t('status.editRejected', { reason: res.reason || 'unsafe' }) });
      await this.loadProps(id);
      return;
    }
    if (this.doc.rev !== revBefore) {
      this.post({ type: 'status', message: t('status.docChanged') });
      await this.loadProps(id);
      return;
    }

    if (!this.commit(before, res.text, `Set ${id}.${prop}`)) return;
    this.output.appendLine(`set ${id}.${prop} = ${items.length} item(s) (collection, unsaved)`);
    this.post({ type: 'status', message: t('status.propSet', { id, prop }) });
    if (this.engineKind === 'net48') {
      // net48 renders the compiled assembly; reconstruct the string Items on the live instance for an immediate
      // picture (T1.1b). The committed text is what persists on save / re-renders after a rebuild.
      await this.liveCollection48(id, prop, 'System.String', items.map((s) => ({ text: s })));
    } else {
      // items can change a ListBox/CheckedListBox's rendered content → full re-render, not a single-control patch
      await this.fullRender();
    }
    await this.loadProps(id);
    await this.postDirty();
  }

  /** Read side of the generic string[] editor (TextBox/RichTextBox.Lines): send the "…"-opened property's current
   * items to the webview. Parses the unsaved buffer. PURE-TEXT → routed to the net9 engine even for a net48 form. */
  async sendStringArray(id: string, prop: string): Promise<void> {
    if (!this.designerFile) {
      this.post({ type: 'stringArrayItems', id, prop, ok: false, items: [], reason: 'not available' });
      return;
    }
    try {
      const eng = await this.ensureEngine('modern');
      const res = await listStringArray(eng, this.designerFile, id, prop, this.doc.designerText);
      this.post({ type: 'stringArrayItems', id, prop, ok: res.ok, items: res.items ?? [], reason: res.reason });
    } catch (err) {
      this.post({ type: 'stringArrayItems', id, prop, ok: false, items: [], reason: errMsg(err) });
    }
  }

  /** Write side of the generic string[] editor: rewrite the property to the single assignment
   * `owner.prop = new string[] { … }`. Mirrors collectionFromGrid's error/restore + single-undo commit. */
  async stringArrayFromGrid(id: string, prop: string, items: string[]): Promise<void> {
    try {
      await this.applyStringArray(id, prop, items);
    } catch (err) {
      this.post({ type: 'status', message: errMsg(err) });
      try { await this.loadProps(id); } catch { /* best effort */ }
    }
  }

  private async applyStringArray(id: string, prop: string, items: string[]): Promise<void> {
    if (!this.designerFile) return;
    // PURE-TEXT splice — route to net9 even on a net48 form (the compiled engine can't splice; the text is truth).
    const eng = await this.ensureEngine('modern');
    const before = this.doc.designerText;
    const revBefore = this.doc.rev;

    const res = await setStringArray(eng, this.designerFile, id, prop, items, before);
    if (!res.safe || res.text === null) {
      this.post({ type: 'status', message: t('status.editRejected', { reason: res.reason || 'unsafe' }) });
      await this.loadProps(id);
      return;
    }
    if (this.doc.rev !== revBefore) {
      this.post({ type: 'status', message: t('status.docChanged') });
      await this.loadProps(id);
      return;
    }

    if (!this.commit(before, res.text, `Set ${id}.${prop}`)) return;
    this.output.appendLine(`set ${id}.${prop} = string[${items.length}] (unsaved)`);
    this.post({ type: 'status', message: t('status.propSet', { id, prop }) });
    if (this.engineKind === 'net48') {
      // net48 renders the compiled assembly; set the string[] on the live instance for an immediate picture. The
      // committed text is what persists on save / re-renders after a rebuild.
      await this.liveStringArray48(id, prop, items);
    } else {
      // Lines changes the TextBox's rendered content → full re-render, not a single-control patch
      await this.fullRender();
    }
    await this.loadProps(id);
    await this.postDirty();
  }

  /** Revision at which each ListView.Columns forest was handed to the panel. A delayed OK must never splice a stale
   * column list over an intervening canvas/property/undo edit. */
  private columnReadRev = new Map<string, number>();

  /** Shared read side of the typed ListView.Columns editor. Parses the unsaved buffer and records the exact revision
   * represented by the returned rows. PURE-TEXT → routed to net9 even for a net48 form. */
  private async readColumnItems(id: string): Promise<{
    ok: boolean;
    columns: ColumnItem[];
    reason: string;
  }> {
    if (!this.designerFile) {
      this.columnReadRev.delete(id);
      return { ok: false, columns: [], reason: 'not available' };
    }
    try {
      const eng = await this.ensureEngine('modern');
      const revAtRead = this.doc.rev;
      const res = await listColumns(eng, this.designerFile, id, this.doc.designerText);
      if (res.ok) this.columnReadRev.set(id, revAtRead);
      else this.columnReadRev.delete(id);
      return { ok: res.ok, columns: res.columns ?? [], reason: res.reason };
    } catch (err) {
      this.columnReadRev.delete(id);
      return { ok: false, columns: [], reason: errMsg(err) };
    }
  }

  /** Webview transport for the shared ListView.Columns read side. */
  async sendColumnItems(id: string): Promise<void> {
    this.post({ type: 'columnItems', id, ...(await this.readColumnItems(id)) });
  }

  /** Write side of the typed ListView.Columns editor (VS "Collection Editor"). Mirrors collectionFromGrid's
   * error/restore + single-undo commit. */
  async columnsFromGrid(id: string, columns: ColumnItem[]): Promise<boolean> {
    try {
      return await this.applyColumns(id, columns, this.columnReadRev.get(id));
    } catch (err) {
      this.post({ type: 'status', message: errMsg(err) });
      try { await this.loadProps(id); } catch { /* best effort */ }
      return false;
    }
  }

  private async applyColumns(id: string, columns: ColumnItem[], revAtRead?: number): Promise<boolean> {
    if (!this.designerFile) return false;
    const eng = await this.ensureEngine('modern'); // PURE-TEXT splice — modern engine even on a net48 form
    const before = this.doc.designerText;
    const revBefore = revAtRead ?? this.doc.rev;

    const res = await setColumns(eng, this.designerFile, id, columns, before);
    if (!res.safe || res.text === null) {
      this.post({ type: 'status', message: t('status.editRejected', { reason: res.reason || 'unsafe' }) });
      await this.loadProps(id);
      return false;
    }
    if (this.doc.rev !== revBefore) {
      this.post({ type: 'status', message: t('status.docChanged') });
      await this.loadProps(id);
      return false;
    }

    if (!this.commit(before, res.text, `Set ${id}.Columns`)) return false;
    this.output.appendLine(`set ${id}.Columns = ${columns.length} column(s) (collection, unsaved)`);
    this.post({ type: 'status', message: t('status.propSet', { id, prop: 'Columns' }) });
    if (this.engineKind === 'net48') {
      // reconstruct the ListView.Columns on the live instance for an immediate net48 picture (T1.1b)
      await this.liveCollection48(id, 'Columns', 'System.Windows.Forms.ColumnHeader',
        columns.map((c) => ({ id: c.id, text: c.text, width: c.width, align: c.textAlign })));
    } else {
      // columns change the ListView's rendered header → full re-render, not a single-control patch
      await this.fullRender();
    }
    await this.loadProps(id);
    await this.postDirty();
    return true;
  }

  /** Read side of the hierarchical TreeView.Nodes editor. Parses the unsaved buffer. PURE-TEXT → net9 even on net48. */
  async sendTreeNodes(id: string): Promise<void> {
    if (!this.designerFile) {
      this.post({ type: 'treeNodeItems', id, ok: false, nodes: [], reason: 'not available' });
      return;
    }
    try {
      const eng = await this.ensureEngine('modern');
      const res = await listTreeNodes(eng, this.designerFile, id, this.doc.designerText);
      this.post({ type: 'treeNodeItems', id, ok: res.ok, nodes: res.nodes ?? [], reason: res.reason });
    } catch (err) {
      this.post({ type: 'treeNodeItems', id, ok: false, nodes: [], reason: errMsg(err) });
    }
  }

  /** Write side of the TreeView.Nodes editor (VS "TreeNode Editor"). Mirrors columnsFromGrid's error/restore. */
  async treeNodesFromGrid(id: string, nodes: TreeNodeItem[]): Promise<void> {
    try {
      await this.applyTreeNodes(id, nodes);
    } catch (err) {
      this.post({ type: 'status', message: errMsg(err) });
      try { await this.loadProps(id); } catch { /* best effort */ }
    }
  }

  private async applyTreeNodes(id: string, nodes: TreeNodeItem[]): Promise<void> {
    if (!this.designerFile) return;
    const eng = await this.ensureEngine('modern'); // PURE-TEXT splice — modern engine even on a net48 form
    const before = this.doc.designerText;
    const revBefore = this.doc.rev;

    const res = await setTreeNodes(eng, this.designerFile, id, nodes, before);
    if (!res.safe || res.text === null) {
      this.post({ type: 'status', message: t('status.editRejected', { reason: res.reason || 'unsafe' }) });
      await this.loadProps(id);
      return;
    }
    if (this.doc.rev !== revBefore) {
      this.post({ type: 'status', message: t('status.docChanged') });
      await this.loadProps(id);
      return;
    }

    if (!this.commit(before, res.text, `Set ${id}.Nodes`)) return;
    this.output.appendLine(`set ${id}.Nodes (tree, unsaved)`);
    this.post({ type: 'status', message: t('status.propSet', { id, prop: 'Nodes' }) });
    if (this.engineKind === 'net48') {
      // reconstruct the TreeView.Nodes on the live compiled instance for an immediate net48 picture (mirrors T1.1b
      // for the flat collections); a non-TreeNodeCollection Nodes falls back to previewPartial (renders on rebuild)
      await this.liveTreeNodes48(id, 'Nodes', nodes);
    } else {
      // nodes change the rendered tree → full re-render (the interpreter renders TreeNode locals + Nodes.AddRange)
      await this.fullRender();
    }
    await this.loadProps(id);
    await this.postDirty();
  }

  /** The document revision the item forest last handed to the PANEL was read at, per strip id. The panel edits a
   * copy of that forest and submits it later, so the read and the write straddle an arbitrary amount of time; the
   * submitted forest is only meaningful against the revision it was read from. Without this, a canvas edit / undo
   * landing in between made the panel's stale forest splice cleanly over the newer text — silently dropping an item
   * the panel never saw (or resurrecting one it still did). The canvas paths pass their own revAtRead. */
  private stripReadRev = new Map<string, number>();

  /** Shared read side of the ToolStrip/MenuStrip item editor. Parses the unsaved buffer and records the revision the
   * returned forest belongs to. PURE-TEXT → net9 even on net48. */
  private async readToolStripItems(id: string): Promise<{
    ok: boolean;
    items: ToolStripItemModel[];
    reason: string;
  }> {
    if (!this.designerFile) {
      this.stripReadRev.delete(id);
      return { ok: false, items: [], reason: 'not available' };
    }
    try {
      const eng = await this.ensureEngine('modern');
      const revAtRead = this.doc.rev; // against the very text handed to the reader on the next line
      const res = await listToolStripItems(eng, this.designerFile, id, this.doc.designerText);
      if (res.ok) this.stripReadRev.set(id, revAtRead);
      else this.stripReadRev.delete(id);
      return { ok: res.ok, items: res.items ?? [], reason: res.reason ?? '' };
    } catch (err) {
      this.stripReadRev.delete(id);
      return { ok: false, items: [], reason: errMsg(err) };
    }
  }

  /** Webview transport for the shared Items-editor read side. */
  async sendToolStripItems(id: string): Promise<void> {
    const result = await this.readToolStripItems(id);
    this.post({ type: 'toolStripItems', id, ...result });
  }

  /** Write side of the ToolStrip/MenuStrip item editor (reorder / add / remove). Mirrors treeNodesFromGrid's error/restore. */
  async toolStripFromGrid(id: string, items: ToolStripItemModel[]): Promise<boolean> {
    try {
      // Gate on the revision the panel's forest was READ at, not on "now" — see stripReadRev.
      return await this.applyToolStripItems(id, items, false, this.stripReadRev.get(id));
    } catch (err) {
      this.post({ type: 'status', message: errMsg(err) });
      try { await this.loadProps(id); } catch { /* best effort */ }
      return false;
    }
  }

  /** Returns true iff the edit committed + rendered; false on any rejection (unsafe splice / doc changed / no file).
   * The on-canvas ADD path uses this to correlate a flyout auto-reopen with the operation's ACTUAL outcome (see
   * applyStripAdd → stripAddDone) — a rejected add must NOT arm a stale reopen. Other callers ignore the return. */
  private async applyToolStripItems(id: string, items: ToolStripItemModel[], fromCanvasItemOp = false, revAtRead?: number): Promise<boolean> {
    if (!this.designerFile) return false;
    const eng = await this.ensureEngine('modern'); // PURE-TEXT splice — modern engine even on a net48 form
    const before = this.doc.designerText;
    // `revAtRead` is the caller's revision from BEFORE it read the item forest it is handing us. The on-canvas ops
    // list the forest first, so snapshotting here would leave that round-trip unguarded: an undo/redo or a
    // concurrent commit landing during the list makes `items` describe text that no longer exists, and
    // setToolStripItems reconciles by field id — so e.g. an item the undo removed gets resurrected. Same rule
    // applyEdit already follows ("snapshot the buffer + revision BEFORE any await that could straddle a concurrent
    // external edit"). Panel-driven callers pass nothing and keep the old entry-time snapshot.
    const revBefore = revAtRead ?? this.doc.rev;

    const res = await setToolStripItems(eng, this.designerFile, id, items, before);
    if (!res.safe || res.text === null) {
      this.post({ type: 'status', message: t('status.editRejected', { reason: res.reason || 'unsafe' }) });
      await this.loadProps(id);
      return false;
    }
    if (this.doc.rev !== revBefore) {
      this.post({ type: 'status', message: t('status.docChanged') });
      await this.loadProps(id);
      return false;
    }

    if (!this.commit(before, res.text, `Edit ${id}.Items`)) return false; // refused → no fresh render reached the canvas
    // A PANEL-originated edit submits the whole forest, so once it commits, the panel's copy matches the document
    // again — re-baseline its read revision or the user's next edit from the same open editor would be refused as
    // stale. A CANVAS op (fromCanvasItemOp) deliberately does NOT: it must leave the panel's baseline behind so the
    // panel's now-stale forest is caught rather than spliced over this edit.
    if (!fromCanvasItemOp) this.stripReadRev.set(id, this.doc.rev);
    this.output.appendLine(`edit ${id}.Items (toolstrip add/remove/rename/reorder, unsaved)`);
    this.post({ type: 'status', message: t('status.propSet', { id, prop: 'Items' }) });
    // `rendered` = did a FRESH render→layout→tray reflecting this edit reach the canvas? net9 fullRender is true unless it
    // early-exits; net48 liveToolStrip48 is false on a previewPartial (source committed but the live picture is stale). The
    // ADD auto-reopen keys on this so it never re-opens a flyout drawn from a stale forest.
    let rendered: boolean;
    if (this.engineKind === 'net48') {
      rendered = await this.liveToolStrip48(id, res.text); // net48 live path posts no select → item highlight already survives
    } else {
      rendered = await this.fullRender(fromCanvasItemOp); // net9: skip the trailing reselect for on-canvas item ops (keep highlight)
    }
    // The panel refresh + dirty flag are POST-render side-effects: the edit already committed AND (if `rendered`) posted a
    // fresh forest. A failure here (e.g. the engine dies during the props RPC) must NOT propagate to applyStripAdd's catch
    // and flip the ADD completion to false — that would suppress a legitimate flyout reopen even though the fresh forest is
    // already on the canvas. Best-effort: log, keep the render result authoritative.
    try {
      await this.loadProps(id);
      await this.postDirty();
    } catch (e) {
      this.output.appendLine(`applyToolStripItems: post-render refresh failed (edit committed): ${errMsg(e)}`);
    }
    return rendered;
  }

  /** net48 compiled preview after a ToolStrip/MenuStrip item edit: reconcile the strip's items (add/remove/rename/
   * reorder) on the live instance so the canvas updates immediately (the ToolStrip analogue of liveTreeNodes48).
   * Re-renders the compiled assembly would show the stale built strip; this mutates the live Items instead. The items
   * are re-read from the just-committed source so new "Type Here" items carry their minted field ids — the live
   * reconcile keys on the field id, so it needs the resolved forest, not the raw popup input (which sends empty ids
   * for adds). Best-effort — a non-ToolStrip owner or an unresolvable new item type leaves the picture on the built
   * strip with a note (show48's previewPartial); the committed text still renders after a rebuild.
   * Returns true iff a fresh render reflecting the edit reached the canvas (false on any bail / previewPartial), so the
   * ADD auto-reopen keys on a CURRENT forest, not the stale built strip. */
  private async liveToolStrip48(id: string, committedText: string): Promise<boolean> {
    const asm = this.asm();
    if (!asm || !this.designerFile) return false;
    // under an INTERPRETED canvas the strip's structural edit is already committed to source, so
    // re-interpret the committed buffer (fullRender) rather than resolving field ids + reconciling the compiled instance
    // (which would flip the canvas to the build; the pre-live listToolStripItems could also bail before live48 ever ran)
    // skipReselect keeps the on-canvas item highlight; the returned boolean lets the ADD auto-reopen key on the
    // fresh interpreted forest.
    if (this.net48RenderMode === 'interpreted') {
      const rendered = await this.fullRender(true);
      // Arm the ADD auto-reopen ONLY if the render STAYED interpreted — its fresh forest then actually holds the new
      // item. If the add cost the form its coverage (a fallback to the compiled build), the new item is in the source
      // but NOT in the compiled forest, so a reopen would draw a stale strip; return false to clear the arm — the "last
      // build" disclosure already explains why the picture didn't change.
      return rendered && this.net48RenderMode === 'interpreted';
    }
    // Re-read the committed buffer (net9 pure-text parse) to resolve every field id, then reconcile the live instance.
    const resolved = await listToolStripItems(await this.ensureEngine('modern'), this.designerFile, id, committedText);
    if (!resolved.ok) {
      // Source committed but the pre-live reconcile didn't resolve → the picture still shows the last build. The
      // persistent net48 disclosure banner already says so; add a transient detail line with the engine's reason.
      this.post({ type: 'status', message: t('status.previewPartial', { diag: resolved.reason || t('designer.notice.stripItemsAwaitingRebuild') }) });
      return false; // source committed but no fresh live render → the canvas forest is STALE (missing the new item)
    }
    return await this.live48((eng) => setCompiledToolStripItemsLive(eng, this.designerFile!, asm, id, resolved.items));
  }

  /**
   * On-canvas "Type Here" ADD: append ONE new top-level item to a ToolStrip/MenuStrip/StatusStrip. Reads the current
   * forest from the unsaved buffer (pure-text → net9 even on a net48 form), appends a new node with an EMPTY id (the
   * engine mints the field name on commit), then reuses the shared commit seam `applyToolStripItems` (net9 fullRender /
   * net48 live reconcile). The item type is the one chosen on the canvas, defaulted from the owner strip when absent; a
   * separator carries no text. Best-effort: a non-editable / non-strip owner is a no-op with a status.
   *
   * When `parentItemId` is given (a nested "Type Here" inside a submenu flyout), the new item is appended into THAT
   * item's DropDownItems instead of the strip's top level. `hostId` is still the top-level strip (the splice key); the
   * engine grows the owner item's existing AddRange surgically — the same depth-agnostic seam rename/delete use. In the
   * reachable UI case the flyout only opens for a submenu that already has ≥1 child, so this GROWs an existing AddRange;
   * a childless or non-AddRange owner (e.g. a stale read) degrades via the engine (a first-child CREATE or a graceful
   * refusal), never a crash. A parent id that has vanished (edited away between render and commit) is a no-op with a status.
   */
  private async applyStripAdd(hostId: string, itemType: string, text: string, parentItemId?: string, reopenToken?: number): Promise<void> {
    // The canvas may arm a flyout auto-reopen for a ROOT "Type Here" add; it consumes that arm ONLY on the matching
    // stripAddDone (token-correlated with the add's real outcome), NEVER on the ambient `tray` message — a rejected or
    // superseded add must not resurrect a stale flyout, and overlapping adds must not consume each other's arm.
    // Post exactly one stripAddDone per token: ok=false on every rejection path, ok=<render result> on the commit path.
    const done = (ok: boolean): void => { if (reopenToken != null) this.post({ type: 'stripAddDone', token: reopenToken, ok }); };
    if (this.disposed || !this.designerFile) { done(false); return; }
    // Wrap every awaited step so an ENGINE/RPC EXCEPTION (ensureEngine / listToolStripItems / applyToolStripItems throwing,
    // not a graceful rejection) still emits a stripAddDone — else the canvas's armed reopen would leak forever and a later
    // unrelated render could resurrect it. done()
    // is idempotent from the canvas's side (a duplicate token is a no-op once the arm is consumed), so a throw AFTER an
    // explicit done() can't double-fire in practice (a throw only happens at an await, before that path's done()).
    try {
    const eng = await this.ensureEngine('modern'); // read + splice are pure-text → modern engine even on a net48 form
    const revAtRead = this.doc.rev; // captured against the very text we hand the reader (after engine acquisition)
    const cur = await listToolStripItems(eng, this.designerFile, hostId, this.doc.designerText);
      if (!cur.ok) {
        this.post({ type: 'status', message: t('status.editRejected', { reason: cur.reason || 'items not editable' }) });
        done(false);
        return;
      }
      const type = itemType || (parentItemId ? 'ToolStripMenuItem' : this.defaultStripItemType(hostId));
      const isSep = /Separator$/.test(type);
      const node: ToolStripItemModel = { id: '', text: isSep ? '' : text, name: '', itemType: type, children: [] };
      const forest: ToolStripItemModel[] = cur.items.slice(); // shallow — existing item/subtree nodes shared (mutated below)
      if (parentItemId) {
        const parent = findToolStripItem(forest, parentItemId); // recurse to the submenu owner at any depth
        if (!parent) {
          this.post({ type: 'status', message: t('status.editRejected', { reason: 'submenu owner not found' }) });
          done(false);
          return;
        }
        (parent.children ??= []).push(node); // append into the owner's DropDownItems (engine grows its AddRange)
      } else {
        forest.push(node); // top-level append — existing items/subtrees untouched
      }
      // applyToolStripItems returns true ONLY when it committed AND posted a fresh render→layout→tray (both engines) BEFORE
      // resolving, so by stripAddDone the canvas has the fresh forest → the reopen draws the new item. A net48 previewPartial
      // (no fresh render) or any rejection returns false → ok:false → clear the arm, no stale-forest reopen.
      done(await this.applyToolStripItems(hostId, forest, true, revAtRead));
    } catch (e) {
      done(false); // an engine/RPC error must not leave a permanently-armed reopen
    throw e; // preserve the existing onMessage error handling
    }
  }

  /** Default new-item type for a strip, mirroring the webview's toolStripNewTypes(ownerType)[0]. */
  private defaultStripItemType(hostId: string): string {
    const ot = this.controls.find((c) => c.id === hostId)?.type || '';
    if (ot.includes('StatusStrip')) return 'ToolStripStatusLabel';
    if (ot.includes('MenuStrip')) return 'ToolStripMenuItem';
    // An off-tree strip (a ContextMenuStrip / ToolStripDropDown) isn't in controls[] — it's a tray chip — so ot is ''.
    // It holds menu items, not toolbar buttons. (The canvas always sends an explicit itemType, so this is a fallback.)
    if (ot === '') return 'ToolStripMenuItem';
    return 'ToolStripButton';
  }

  /** Read a canonical source-backed generic list, run either the allowlisted framework CollectionEditor or the exact
   * certified vendor editor in the isolated STA worker, then route validated invariant items through the source
   * transaction. Certified vendor output additionally requires the component-owned patch proof before commit. */
  async uiCollectionEditorFromGrid(
    id: string,
    prop: string,
    itemType: string,
    editorType: string,
  ): Promise<SupportedUiTypeEditorResult | null> {
    if (this.uiTypeEditorBusy) {
      this.post({ type: 'status', message: 'A property editor is already open.' });
      return null;
    }
    if (!this.designerFile) return null;
    const metadata = this.publishedEditableProperty(id, prop);
    const frameworkCollectionEditor = editorType === 'System.ComponentModel.Design.CollectionEditor';
    const certifiedVendorCollection = !!metadata?.uiTypeEditorAssemblyPath
      && !!metadata.uiTypeEditorAssemblySha256
      && !!metadata.uiTypeEditorCertificationId;
    if (!metadata?.genericCollection || metadata.collectionItemType !== itemType
        || metadata.uiTypeEditor !== editorType
        || (!frameworkCollectionEditor && !certifiedVendorCollection)) {
      this.post({ type: 'status', message: t('status.editRejected', { reason: 'property metadata changed' }) });
      return null;
    }

    const revBefore = this.doc.rev;
    this.uiTypeEditorBusy = true;
    try {
      const eng = await this.ensureEngine('modern');
      const listed = await listGenericListItems(eng, this.designerFile, id, prop, itemType, this.doc.designerText);
      if (!listed.ok || listed.itemTypeName !== itemType) {
        this.post({ type: 'status', message: t('status.editRejected', { reason: listed.reason || 'collection is not source-representable' }) });
        return null;
      }
      if (this.doc.rev !== revBefore) {
        this.post({ type: 'status', message: t('status.docChanged') });
        return null;
      }
      const requestId = `collection-${randomBytes(16).toString('hex')}`;
      const result = certifiedVendorCollection
        ? await editCertifiedVendorCollectionEditor(
            eng,
            requestId,
            editorType,
            itemType,
            listed.items ?? [],
            metadata.uiTypeEditorAssemblyPath!,
            metadata.uiTypeEditorAssemblySha256!,
            metadata.uiTypeEditorCertificationId!,
          )
        : await editSupportedCollectionEditor(
            eng,
            requestId,
            itemType,
            listed.items ?? [],
          );
      if (this.doc.rev !== revBefore) {
        this.post({ type: 'status', message: t('status.docChanged') });
        await this.loadProps(id);
        return result;
      }
      if (result.dismissed || !result.applied) {
        if (!result.ok && !result.dismissed) {
          this.post({ type: 'status', message: t('status.editRejected', { reason: result.reason || result.errorCode || 'collection editor failed' }) });
        }
        return result;
      }
      if (!result.ok || !Array.isArray(result.collectionItems)) {
        this.post({ type: 'status', message: t('status.editRejected', { reason: result.reason || result.errorCode || 'collection editor returned no items' }) });
        return result;
      }
      await this.applyGenericList(id, prop, itemType, result.collectionItems);
      return result;
    } catch (err) {
      this.post({ type: 'status', message: errMsg(err) });
      return null;
    } finally {
      this.uiTypeEditorBusy = false;
    }
  }

  /**
   * On-canvas MOVE: reorder a field-backed existing ToolStrip/MenuStrip item within its current Items/DropDownItems
   * collection, or reparent it into another dropdown's DropDownItems. The canvas sends only the owner strip id, source
   * item id, target parent id (null = strip root) and target index; the host re-reads the current forest from the
   * current unsaved buffer and applies one atomic setToolStripItems edit guarded by the same revision seam as add/delete.
   */
  private async applyStripMove(
    hostId: string,
    itemId: string,
    targetParentItemId: string | null,
    targetIndex: number,
  ): Promise<{ applied: boolean; reason: string | null }> {
    if (this.disposed || !this.designerFile) return { applied: false, reason: 'not available' };
    if (!hostId || !itemId || !Number.isFinite(targetIndex) || targetIndex < 0) {
      const reason = 'invalid strip move target';
      this.post({ type: 'status', message: t('status.editRejected', { reason }) });
      return { applied: false, reason };
    }
    const insertAt = Math.floor(targetIndex);
    const eng = await this.ensureEngine('modern'); // read + splice are pure-text → modern engine even on a net48 form
    const revAtRead = this.doc.rev; // stale-guard the forest we are about to mutate
    const cur = await listToolStripItems(eng, this.designerFile, hostId, this.doc.designerText);
    if (!cur.ok) {
      const reason = cur.reason || 'items not editable';
      this.post({ type: 'status', message: t('status.editRejected', { reason }) });
      return { applied: false, reason };
    }
    const forest = cur.items.slice();
    const source = findToolStripItemEntry(forest, itemId);
    if (!source) {
      const reason = 'strip item not found';
      this.post({ type: 'status', message: t('status.editRejected', { reason }) });
      return { applied: false, reason };
    }
    if (targetParentItemId && (targetParentItemId === itemId || containsToolStripItem(source.item, targetParentItemId))) {
      const reason = 'cannot move an item into its own submenu';
      this.post({ type: 'status', message: t('status.editRejected', { reason }) });
      return { applied: false, reason };
    }
    const targetParent = targetParentItemId ? findToolStripItemEntry(forest, targetParentItemId) : null;
    if (targetParentItemId) {
      if (!targetParent) {
        const reason = 'move target parent not found';
        this.post({ type: 'status', message: t('status.editRejected', { reason }) });
        return { applied: false, reason };
      }
      if (!isDropDownStripItemType(targetParent.item.itemType)) {
        const reason = `${targetParent.item.id} has no DropDownItems collection`;
        this.post({ type: 'status', message: t('status.editRejected', { reason }) });
        return { applied: false, reason };
      }
    }

    const sameParent = (source.parent?.id ?? null) === (targetParent?.item.id ?? null);
    const originalIndex = source.index;
    source.siblings.splice(source.index, 1);
    const targetSiblings = targetParent ? (targetParent.item.children ??= []) : forest;
    let adjustedIndex = Math.max(0, Math.min(insertAt, targetSiblings.length));
    if (sameParent && originalIndex < insertAt) adjustedIndex = Math.max(0, adjustedIndex - 1);
    if (sameParent && adjustedIndex === originalIndex) return { applied: false, reason: null }; // dropped back to the same slot
    targetSiblings.splice(adjustedIndex, 0, source.item);

    this.currentSelItem = { ownerId: hostId, itemId };
    const applied = await this.applyToolStripItems(hostId, forest, true, revAtRead);
    return { applied, reason: applied ? null : 'strip item edit did not reach a fresh render' };
  }

  /**
   * On-canvas RENAME: set one existing top-level item's Text. Reads the current forest from the unsaved buffer
   * (pure-text → net9 even on a net48 form), finds the item by its field id, changes ONLY its Text, and reuses the
   * shared commit seam `applyToolStripItems` — the engine renames surgically (only the changed-Text literal is
   * rewritten; every unmanaged property of the item is preserved). An empty caption or a no-op (same text) does
   * nothing; a vanished item id (edited away between render and commit) is a silent no-op.
   */
  private async applyStripRename(hostId: string, itemId: string, text: string): Promise<void> {
    if (this.disposed || !this.designerFile) return;
    const newText = text.trim();
    if (newText === '') return; // empty caption = keep the old text (the engine rejects a blank Text literal anyway)
    const eng = await this.ensureEngine('modern'); // read + splice are pure-text → modern engine even on a net48 form
    const revAtRead = this.doc.rev; // captured against the very text we hand the reader (after engine acquisition)
    const cur = await listToolStripItems(eng, this.designerFile, hostId, this.doc.designerText);
    if (!cur.ok) {
      this.post({ type: 'status', message: t('status.editRejected', { reason: cur.reason || 'items not editable' }) });
      return;
    }
    const forest = cur.items.slice(); // mutate the target node's Text in the freshly-parsed forest; all else untouched
    const target = findToolStripItem(forest, itemId);
    if (!target || target.text === newText) return; // item gone, or nothing changed → no commit
    target.text = newText;
    await this.applyToolStripItems(hostId, forest, true, revAtRead);
  }

  /**
   * On-canvas RETYPE: change a top-level item's .NET type (e.g. ToolStripMenuItem → ToolStripButton). Implemented as
   * REMOVE + ADD — re-mint the forest node as a NEW item (empty id) of the requested type at the SAME position, carrying
   * only its Text: the engine computes `removedIds` for the old field AND constructs the new one in a single commit, so
   * type-specific props (Image / ShortcutKeys / …) reset. Hence "data-loss aware". Refused for an item with a submenu
   * (the engine can't add a submenu under a new item — the canvas already hides the picker there, this is defence in
   * depth). Reuses the shared ToolStrip commit seam; net9 splices text, net48 reconciles the live picture (dispose old +
   * construct new). A vanished / already-matching id is a graceful no-op.
   */
  private async applyStripRetype(hostId: string, itemId: string, newType: string, text: string): Promise<void> {
    if (this.disposed || !this.designerFile) return;
    const eng = await this.ensureEngine('modern'); // read + splice are pure-text → modern engine even on a net48 form
    const revAtRead = this.doc.rev; // captured against the very text we hand the reader (after engine acquisition)
    const cur = await listToolStripItems(eng, this.designerFile, hostId, this.doc.designerText);
    if (!cur.ok) {
      this.post({ type: 'status', message: t('status.editRejected', { reason: cur.reason || 'items not editable' }) });
      return;
    }
    const forest = cur.items.slice();
    // TOP-LEVEL only: retype is advertised for top-level items (the canvas hides the picker for nested ones). Use a
    // top-level `forest.find` — NOT the recursive findToolStripItem — so a crafted message can't re-mint a NESTED item
    // (data-destructive: it drops the field + type-specific state). An overflow item is still a root in the parsed
    // forest (overflow is a runtime placement, not a source structure) → it stays supported.
    const target = forest.find((it) => it.id === itemId) ?? null;
    if (!target || target.itemType === newType) return; // item gone / not top-level / same type → no commit
    if (target.children && target.children.length) {
      this.post({ type: 'status', message: t('status.editRejected', { reason: 'cannot retype an item that has a submenu' }) });
      return;
    }
    const isSep = /Separator$/.test(newType);
    target.id = ''; // empty id → the engine treats it as a NEW item (mints a fresh field of the new type)
    target.name = '';
    target.itemType = newType;
    target.text = isSep ? '' : text; // carry the caption VERBATIM (no trim) — the retype contract is "carry Text"
    this.currentSelItem = null; // the shown item is being re-minted (new id) → drop the item-refresh guard
    await this.applyToolStripItems(hostId, forest, true, revAtRead);
    // A retype is a REMOVE+re-mint: the old itemId is gone, so — exactly like applyStripDelete — the Properties panel would
    // linger on the now-removed item if item→Properties was showing it and a DIFFERENT control is the selection (currentId
    // ≠ strip, so applyToolStripItems' loadProps(hostId) was dropped by the panel props gate). Restore the selected control's
    // props → the panel exits item mode. (Skip when currentId IS the strip: applyToolStripItems already reloaded it.)
    if (this.currentId !== hostId) await this.loadProps(this.currentId);
  }

  /**
   * On-canvas DELETE: remove one top-level item (and its whole subtree) from a ToolStrip/MenuStrip/StatusStrip. Reads
   * the current forest from the unsaved buffer (pure-text → net9 even on a net48 form), omits the target node, and
   * reuses the shared commit seam `applyToolStripItems` — the engine computes `removedIds` (the node + its descendants)
   * and strips their field/ctor/Text/AddRange membership (and disposes on the net48 live preview). A vanished item id
   * (edited away between render and commit) or an id absent from the forest is a silent no-op.
   */
  private async applyStripDelete(hostId: string, itemId: string): Promise<void> {
    if (this.disposed || !this.designerFile) return;
    const eng = await this.ensureEngine('modern'); // read + splice are pure-text → modern engine even on a net48 form
    const revAtRead = this.doc.rev; // captured against the very text we hand the reader (after engine acquisition)
    const cur = await listToolStripItems(eng, this.designerFile, hostId, this.doc.designerText);
    if (!cur.ok) {
      this.post({ type: 'status', message: t('status.editRejected', { reason: cur.reason || 'items not editable' }) });
      return;
    }
    if (!findToolStripItem(cur.items, itemId)) return; // id not present (vanished / already gone) → silent no-op
    const pruned = removeToolStripItem(cur.items, itemId); // omit the node (+subtree) from the freshly-parsed forest
    this.currentSelItem = null; // the shown item is being removed → drop the item-refresh guard
    await this.applyToolStripItems(hostId, pruned, true, revAtRead);
    // The deleted item may have been shown in the Properties panel (item→Properties). applyToolStripItems reloaded the
    // STRIP's props only; if a DIFFERENT control was the selection (currentId ≠ strip), its props were never re-pushed,
    // so the panel would linger on the now-deleted item. Restore the selected control's props —
    // the panel's `props` handler then exits item mode and shows the control. (Skip when currentId IS the strip:
    // applyToolStripItems already reloaded it via loadProps(hostId).)
    if (this.currentId !== hostId) await this.loadProps(this.currentId);
  }

  /** Read side of the typed DataGridView.Columns editor. Parses the unsaved buffer. PURE-TEXT → net9 even on net48. */
  async sendGridColumnItems(id: string): Promise<void> {
    if (!this.designerFile) {
      this.post({ type: 'gridColumnItems', id, ok: false, columns: [], reason: 'not available' });
      return;
    }
    try {
      const eng = await this.ensureEngine('modern');
      const res = await listGridColumns(eng, this.designerFile, id, this.doc.designerText);
      this.post({ type: 'gridColumnItems', id, ok: res.ok, columns: res.columns ?? [], reason: res.reason });
    } catch (err) {
      this.post({ type: 'gridColumnItems', id, ok: false, columns: [], reason: errMsg(err) });
    }
  }

  /** Write side of the typed DataGridView.Columns editor. Mirrors columnsFromGrid. */
  async gridColumnsFromGrid(id: string, columns: GridColumnItem[]): Promise<void> {
    try {
      await this.applyGridColumns(id, columns);
    } catch (err) {
      this.post({ type: 'status', message: errMsg(err) });
      try { await this.loadProps(id); } catch { /* best effort */ }
    }
  }

  private async applyGridColumns(id: string, columns: GridColumnItem[]): Promise<void> {
    if (!this.designerFile) return;
    const eng = await this.ensureEngine('modern'); // PURE-TEXT splice — modern engine even on a net48 form
    const before = this.doc.designerText;
    const revBefore = this.doc.rev;

    const res = await setGridColumns(eng, this.designerFile, id, columns, before);
    if (!res.safe || res.text === null) {
      this.post({ type: 'status', message: t('status.editRejected', { reason: res.reason || 'unsafe' }) });
      await this.loadProps(id);
      return;
    }
    if (this.doc.rev !== revBefore) {
      this.post({ type: 'status', message: t('status.docChanged') });
      await this.loadProps(id);
      return;
    }

    if (!this.commit(before, res.text, `Set ${id}.Columns`)) return;
    this.output.appendLine(`set ${id}.Columns = ${columns.length} column(s) (grid collection, unsaved)`);
    this.post({ type: 'status', message: t('status.propSet', { id, prop: 'Columns' }) });
    if (this.engineKind === 'net48') {
      // reconstruct the DataGridView.Columns on the live instance for an immediate net48 picture (T1.1b)
      await this.liveCollection48(id, 'Columns', 'System.Windows.Forms.DataGridViewColumn',
        columns.map((c) => ({
          id: c.id,
          text: c.headerText,
          width: c.width,
          readOnly: c.readOnly,
          visible: c.visible,
          dataPropertyName: c.dataPropertyName,
          format: c.format,
          alignment: c.alignment,
          nullValue: c.nullValue,
        })));
    } else {
      await this.fullRender();
    }
    await this.loadProps(id);
    await this.postDirty();
  }

  /** Read one control's canonical DataBindings from the unsaved buffer. Pure text, including for net48 forms. */
  private async readBindingItems(id: string): Promise<BindingItems> {
    if (!this.designerFile) return { ok: false, bindings: [], sources: [], reason: 'not available' };
    try {
      const eng = await this.ensureEngine('modern');
      return await listBindings(eng, this.designerFile, id, this.doc.designerText);
    } catch (err) {
      return { ok: false, bindings: [], sources: [], reason: errMsg(err) };
    }
  }

  async sendBindingItems(id: string): Promise<void> {
    const res = await this.readBindingItems(id);
    this.post({
      type: 'bindingItems',
      id,
      ok: res.ok,
      bindings: res.bindings ?? [],
      sources: res.sources ?? [],
      reason: res.reason,
    });
  }

  /** Commit the DataBindings popup atomically, then rebuild the picture from the edited source. */
  async bindingsFromGrid(id: string, bindings: BindingItem[]): Promise<boolean> {
    if (!this.designerFile) return false;
    try {
      const eng = await this.ensureEngine('modern');
      const before = this.doc.designerText;
      const revBefore = this.doc.rev;
      const res = await setBindings(eng, this.designerFile, id, bindings, before);
      if (!res.safe || res.text === null) {
        this.post({ type: 'status', message: t('status.editRejected', { reason: res.reason || 'unsafe' }) });
        await this.loadProps(id);
        return false;
      }
      if (this.doc.rev !== revBefore) {
        this.post({ type: 'status', message: t('status.docChanged') });
        await this.loadProps(id);
        return false;
      }
      if (!this.commit(before, res.text, `Set ${id}.DataBindings`)) return false;
      this.output.appendLine(`set ${id}.DataBindings = ${bindings.length} binding(s) (unsaved)`);
      this.post({ type: 'status', message: t('status.propSet', { id, prop: 'DataBindings' }) });
      await this.fullRender();
      await this.loadProps(id);
      await this.postDirty();
      return true;
    } catch (err) {
      this.post({ type: 'status', message: errMsg(err) });
      try { await this.loadProps(id); } catch { /* best effort */ }
      return false;
    }
  }

  async sendDataSourceInfo(id: string): Promise<void> {
    if (!this.designerFile) {
      this.post({ type: 'dataSourceInfo', id, ok: false, kind: 'none', value: '', components: [], reason: 'not available' });
      return;
    }
    try {
      const eng = await this.ensureEngine('modern');
      const res = await getDataSource(eng, this.designerFile, id, this.doc.designerText);
      this.post({
        type: 'dataSourceInfo',
        id,
        ok: res.ok,
        kind: res.kind,
        value: res.value,
        components: res.components ?? [],
        reason: res.reason,
      });
    } catch (err) {
      this.post({ type: 'dataSourceInfo', id, ok: false, kind: 'none', value: '', components: [], reason: errMsg(err) });
    }
  }

  async dataSourceFromGrid(id: string, kind: 'none' | 'component' | 'type', value: string): Promise<void> {
    if (!this.designerFile) return;
    try {
      const eng = await this.ensureEngine('modern');
      const before = this.doc.designerText;
      const revBefore = this.doc.rev;
      const res = await setDataSource(eng, this.designerFile, id, kind, value, before);
      if (!res.safe || res.text === null) {
        this.post({ type: 'status', message: t('status.editRejected', { reason: res.reason || 'unsafe' }) });
        await this.loadProps(id);
        return;
      }
      if (this.doc.rev !== revBefore) {
        this.post({ type: 'status', message: t('status.docChanged') });
        await this.loadProps(id);
        return;
      }
      if (!this.commit(before, res.text, `Set ${id}.DataSource`)) return;
      this.output.appendLine(`set ${id}.DataSource = ${kind}:${value} (unsaved)`);
      this.post({ type: 'status', message: t('status.propSet', { id, prop: 'DataSource' }) });
      await this.fullRender();
      await this.loadProps(id);
      await this.postDirty();
    } catch (err) {
      this.post({ type: 'status', message: errMsg(err) });
      try { await this.loadProps(id); } catch { /* best effort */ }
    }
  }

  /** Refresh the bounded project DTO/settings catalog shown by the dedicated Data Sources pane. Discovery is
   * parse-only in the modern engine and consumes the current unsaved designer buffer for existing BindingSources. */
  async refreshDataSources(): Promise<DataSourcesResult> {
    if (!this.designerFile || this.disposed) {
      const unavailable: DataSourcesResult = {
        ok: false, schemas: [], settings: [], reason: 'not available', refusalCode: 'NOT_AVAILABLE',
      };
      DesignerHub.instance.pushPanel(this, { type: 'dataSources', ...unavailable });
      return unavailable;
    }
    const seq = ++this.dataSourcesSeq;
    const rev = this.doc.rev;
    try {
      const eng = await this.ensureEngine('modern');
      const result: DataSourcesResult = await listDataSources(eng, this.designerFile, this.doc.designerText);
      if (this.disposed || seq !== this.dataSourcesSeq || rev !== this.doc.rev) return result;
      DesignerHub.instance.pushPanel(this, { type: 'dataSources', ...result });
      return result;
    } catch (error) {
      const failed: DataSourcesResult = {
        ok: false, schemas: [], settings: [], reason: errMsg(error), refusalCode: 'ENGINE_ERROR',
      };
      if (this.disposed || seq !== this.dataSourcesSeq || rev !== this.doc.rev) return failed;
      DesignerHub.instance.pushPanel(this, { type: 'dataSources', ...failed });
      return failed;
    }
  }

  /** Apply one Data Sources generation plan as a single custom-document edit. The webview supplies only an opaque
   * schema key and a gesture; the engine re-discovers the schema and owns every emitted type/member expression. */
  async generateFromDataSource(
    schemaKey: string,
    mode: 'detail' | 'grid',
    requestedParentId: string,
    dropX: number | undefined,
    dropY: number | undefined,
    includeNavigator: boolean,
    existingBindingSourceId: string | null,
    existingGridId: string | null,
  ): Promise<DataSourceGenerationResult> {
    if (!this.designerFile || this.disposed) {
      return {
        safe: false, reason: 'not available', newText: null, createdIds: [], refusalCode: 'NOT_AVAILABLE',
      };
    }
    const parentId = this.containerParentFor(requestedParentId || 'this');
    let x = 13;
    let y = 13;
    if (Number.isFinite(dropX) && Number.isFinite(dropY)) {
      const parent = this.controls.find((control) => control.id === parentId);
      const clientX = parent?.clientX ?? parent?.x ?? 0;
      const clientY = parent?.clientY ?? parent?.y ?? 0;
      x = Math.max(0, Math.round((dropX as number) - clientX));
      y = Math.max(0, Math.round((dropY as number) - clientY));
    }
    const before = this.doc.designerText;
    const rev = this.doc.rev;
    try {
      const eng = await this.ensureEngine('modern');
      const result = await generateDataSource(
        eng, this.designerFile, schemaKey, mode, parentId, x, y, includeNavigator,
        existingBindingSourceId, existingGridId, before);
      const text = result.newText ?? result.text ?? null;
      if (!result.safe || text === null) {
        this.post({ type: 'status', message: t('status.editRejected', { reason: result.reason || 'unsafe data-source generation' }) });
        await this.refreshDataSources();
        return result;
      }
      if (this.doc.rev !== rev) {
        this.post({ type: 'status', message: t('status.docChanged') });
        await this.refreshDataSources();
        return {
          safe: false, reason: 'document changed', newText: null, createdIds: [], refusalCode: 'DOCUMENT_CHANGED',
        };
      }
      if (!this.commit(before, text, `Generate ${mode} data source`)) {
        return {
          safe: false, reason: 'document commit refused', newText: null, createdIds: [], refusalCode: 'COMMIT_REFUSED',
        };
      }
      const created = Array.isArray(result.createdIds) ? result.createdIds.filter((id) => typeof id === 'string' && id) : [];
      const selected = created[created.length - 1] ?? existingGridId;
      if (selected) {
        this.currentId = selected;
        this.currentSelectionIds = [selected];
      }
      this.output.appendLine(`generated ${mode} data source (${created.join(', ') || 'updated existing grid'}) (unsaved)`);
      await this.fullRender();
      await this.refreshDataSources();
      return result;
    } catch (error) {
      const reason = errMsg(error);
      this.post({ type: 'status', message: t('status.editRejected', { reason }) });
      await this.refreshDataSources();
      return { safe: false, reason, newText: null, createdIds: [], refusalCode: 'ENGINE_ERROR' };
    }
  }

  /** Bind one engine-discovered conventional application setting to the selected current-source control. */
  async bindSelectedApplicationSetting(settingKey: string, targetId: string): Promise<void> {
    if (!this.designerFile || this.disposed) return;
    const before = this.doc.designerText;
    const rev = this.doc.rev;
    try {
      const eng = await this.ensureEngine('modern');
      const result = await bindApplicationSetting(eng, this.designerFile, settingKey, targetId, before);
      const text = result.newText ?? result.text ?? null;
      if (!result.safe || text === null) {
        this.post({ type: 'status', message: t('status.editRejected', { reason: result.reason || 'unsupported setting binding' }) });
        return;
      }
      if (this.doc.rev !== rev) {
        this.post({ type: 'status', message: t('status.docChanged') });
        return;
      }
      if (!this.commit(before, text, `Bind ${targetId} to application setting`)) return;
      this.currentId = targetId;
      this.currentSelectionIds = [targetId];
      this.output.appendLine(`bound ${targetId}.${result.boundProperty ?? '?'} to application setting (unsaved)`);
      await this.fullRender();
      await this.refreshDataSources();
    } catch (error) {
      this.post({ type: 'status', message: t('status.editRejected', { reason: errMsg(error) }) });
    }
  }

  async extenderFromGrid(providerId: string, targetId: string, propertyName: string,
    propertyType: string, value: string): Promise<void> {
    if (!this.designerFile) return;
    try {
      const eng = await this.ensureEngine('modern');
      const before = this.doc.designerText;
      const revBefore = this.doc.rev;
      const res = await setExtender(
        eng, this.designerFile, providerId, targetId, propertyName, propertyType, value, before);
      if (!res.safe || res.text === null) {
        this.post({ type: 'status', message: t('status.editRejected', { reason: res.reason || 'unsafe' }) });
        await this.loadProps(targetId);
        return;
      }
      if (this.doc.rev !== revBefore) {
        this.post({ type: 'status', message: t('status.docChanged') });
        await this.loadProps(targetId);
        return;
      }
      if (!this.commit(before, res.text, `Set ${providerId}.${propertyName}(${targetId})`)) return;
      this.output.appendLine(`set extender ${providerId}.${propertyName}(${targetId}) = ${value} (unsaved)`);
      this.post({ type: 'status', message: t('status.propSet', { id: targetId, prop: propertyName }) });
      await this.fullRender();
      await this.loadProps(targetId);
      await this.postDirty();
    } catch (err) {
      this.post({ type: 'status', message: errMsg(err) });
      try { await this.loadProps(targetId); } catch { /* best effort */ }
    }
  }

  private async applyEdits(id: string, edits: Array<{ prop: string; propType: string; value: string }>): Promise<void> {
    if (!this.designerFile || !edits.length) return;
    if (this.localizable) {
      const revBefore = this.doc.rev;
      const localized = edits.map((edit) => ({
        componentId: id,
        propertyName: edit.prop,
        propertyTypeName: edit.propType,
        invariantValue: edit.value,
      }));
      if (await this.applyLocalizedResourceEdits(
        `Set ${id} (${edits.length} localized properties)`, localized, revBefore)) {
        this.output.appendLine(`set localized ${id} ${edits.map((e) => e.prop).join('+')} (${this.localizationCultureLabel()})`);
        await this.loadProps(id);
      }
      return;
    }
    const eng = await this.ensureEngine();
    const before = this.doc.designerText;
    const revBefore = this.doc.rev;

    let text = before;
    for (const e of edits) {
      const expr = COMPLEX_TYPE_SET.has(e.propType)
        ? await convertValue(eng, e.propType, e.value)
        : toCSharpExpression(e.propType, false, e.value);
      if (expr === null) {
        this.post({ type: 'status', message: t('status.cannotSet', { prop: e.prop, value: e.value }) });
        await this.loadProps(id);
        return;
      }
      const res = await setProperty(eng, this.designerFile, id, e.prop, expr, text);
      if (!res.safe || res.text === null) {
        this.post({ type: 'status', message: t('status.editRejected', { reason: res.reason || 'unsafe' }) });
        await this.loadProps(id);
        return;
      }
      text = res.text;
    }

    if (this.doc.rev !== revBefore) {
      this.post({ type: 'status', message: t('status.docChanged') });
      await this.loadProps(id);
      return;
    }
    if (!this.commit(before, text, `Set ${id} (${edits.length} properties)`)) return;
    this.output.appendLine(`set ${id} ${edits.map((e) => e.prop).join('+')} (${edits.length} edits, unsaved)`);
    if (this.engineKind === 'net48') {
      // a multi-property control edit (e.g. an N/W/NW/NE/SW resize = Location+Size) is a committed
      // source-backed edit; opt into interpreted re-render. skipReselect (like liveEdit48) so the trailing loadProps(id)
      // keeps the grid and a visibility-changing property can't strand the selection.
      // The batch is threaded into `interp` too: a corner resize commits Location AND Size together, and without it
      // the interpreted branch fell back to a full re-interpretation — so N/W/NW/NE/SW resizes kept paying the whole
      // rebuild while E/S ones were instant.
      const liveBatch = edits.map((ed) => ({ componentId: id, propName: ed.prop, rawValue: ed.value }));
      await this.live48((e) => applyCompiledEdits(e, this.designerFile!, this.asm()!, liveBatch), true,
        { skipReselect: true, edits: liveBatch });
    } else {
      await this.patchOrRerender(id, edits[edits.length - 1].prop);
    }
    await this.loadProps(id);
    await this.postDirty();
  }

  /** The live designer text — the custom document's in-memory payload (engine renders/edits from this). */
  private async currentText(): Promise<string | undefined> {
    return this.designerFile ? this.doc.designerText : undefined;
  }

  /** Engine-only source for Visual Studio's empty-surface behavior. The owner gate already proved that the actual
   * designer file is one empty partial and the matching code-behind directly derives from Form/UserControl. Keeping
   * this synthetic method out of WinFormsDesignDocument is the invariant: render/describe may consume it; every
   * persistence operation continues to receive the exact original buffer and is independently refused. */
  private async currentEngineText(): Promise<string | undefined> {
    const text = await this.currentText();
    if (!this.emptyInitializeComponentSurface) return text;
    const identity = this.lastDocumentOwner?.typeName?.trim() ?? '';
    const segments = identity.split('.');
    if (segments.length === 0 || segments.some((segment) =>
      !/^[_\p{L}\p{Nl}][_\p{L}\p{Nl}\p{Nd}\p{Pc}\p{Mn}\p{Mc}\p{Cf}]*$/u.test(segment)))
      return text;
    const typeName = segments.pop()!;
    const namespaceName = segments.map((segment) => `@${segment}`).join('.');
    const member = `partial class @${typeName}\n{\n    private void InitializeComponent() { }\n}\n`;
    return namespaceName ? `namespace ${namespaceName}\n{\n${member}}\n` : member;
  }

  /** Current sibling partial text from VS Code's in-memory document, including unsaved base-clause edits. */
  private async currentCodeText(): Promise<string | undefined> {
    const codePath = this.codeFile();
    if (!codePath) return undefined;
    try { return (await vscode.workspace.openTextDocument(codePath)).getText(); }
    catch { return ''; } // file exists but its current snapshot is unavailable: force engine-side fail-closed validation
  }

  private async applyEngineLocalizationCulture(engine: EngineHandle): Promise<void> {
    if (!this.designerFile) return;
    await setLocalizationCulture(engine, this.designerFile, this.localizationCulture);
  }

  private async saveDesigner(): Promise<void> {
    if (!this.designerFile || !this.doc.isDirty) return;
    // Route through VS Code's Save so the custom editor's NATIVE dirty state clears (→ saveCustomDocument,
    // which writes the .Designer.cs). The canvas webview is part of the active editor, so this targets it.
    try { await vscode.commands.executeCommand('workbench.action.files.save'); }
    catch (err) { this.post({ type: 'status', message: t('status.saveFailed', { error: errMsg(err) }) }); }
  }

  private codeFile(): string | null {
    if (!this.designerFile) return null;
    // Inline InitializeComponent owns both generated wiring and handler body. createHandler detects this identity and
    // merges the engine's two non-overlapping insertions into one CustomDocument edit instead of writing twice.
    if (!/\.Designer\.cs$/i.test(this.designerFile)) return this.designerFile;
    const m = /\.Designer\.cs$/i.exec(this.designerFile);
    const partner = m ? this.designerFile.slice(0, m.index) + '.cs' : this.designerFile;
    return fs.existsSync(partner) ? partner : null;
  }

  /** Snapshot every bounded C# source candidate in the owning project. The engine filters these by the exact partial
   * form identity; keeping the TextDocuments here also gives the mutation path a version precondition across all
   * partials, not only the conventional sibling Form1.cs. */
  private async projectEventSourceSnapshot(): Promise<ProjectEventSourceSnapshot> {
    const primaryPath = this.codeFile();
    // A deterministic pick among co-owning projects is inert for the RENDER, but not here: this walks the owner
    // project's whole .cs tree to discover and generate event handlers, and it version-preconditions a MUTATION.
    // Scanning an arbitrarily chosen contender's tree is not the same as scanning the form's own project, so fall
    // back to findOwningCsproj — which deliberately returns null for more than one importer — in that case.
    const pickedAmongEquivalents = this.lastDocumentOwner?.selectedAmongEquivalentOwners === true;
    const ownerProject = isResolvedDocumentOwner(this.lastDocumentOwner)
      && this.lastDocumentOwner?.projectPath && !pickedAmongEquivalents
      ? this.lastDocumentOwner.projectPath
      : this.designerFile ? findOwningCsproj(path.dirname(this.designerFile), this.wsRoot()) : null;
    const candidates = collectProjectEventSourcePaths(ownerProject, primaryPath);
    const paths: string[] = [];
    const documents: vscode.TextDocument[] = [];
    const versions: number[] = [];
    const texts: string[] = [];
    for (const candidate of candidates) {
      try {
        const document = await vscode.workspace.openTextDocument(candidate);
        paths.push(candidate);
        documents.push(document);
        versions.push(document.version);
        texts.push(document.getText());
      } catch {
        // One unreadable project file must not hide handlers from every other valid partial.
      }
    }
    const primaryIndex = primaryPath
      ? paths.findIndex((candidate) => normalize(candidate) === normalize(primaryPath))
      : -1;
    return {
      primaryPath,
      primaryDocument: primaryIndex >= 0 ? documents[primaryIndex] : null,
      paths,
      documents,
      versions,
      texts,
    };
  }

  private projectEventSnapshotUnchanged(snapshot: ProjectEventSourceSnapshot): boolean {
    return snapshot.documents.every((document, index) => document.version === snapshot.versions[index]);
  }

  private async openProjectHandlerAt(handler: string, snapshot?: ProjectEventSourceSnapshot): Promise<void> {
    if (!this.designerFile) return;
    const sources = snapshot ?? await this.projectEventSourceSnapshot();
    if (sources.texts.length === 0) {
      this.post({ type: 'status', message: t('status.noCodeBehindNav') });
      return;
    }
    try {
      const engine = await this.ensureEngine();
      const index = await findEventHandlerSourceIndex(
        engine,
        this.designerFile,
        handler,
        sources.texts,
        (await this.currentText()) ?? null,
        this.asm() ?? null,
      );
      if (index < 0 || index >= sources.paths.length) {
        this.post({ type: 'status', message: t('status.handlerNotFound', { handler, file: path.basename(sources.primaryPath ?? this.designerFile) }) });
        return;
      }
      await this.openHandlerAt(sources.paths[index], handler);
    } catch (error) {
      this.output.appendLine('[designer] project-wide handler navigation failed: ' + errMsg(error));
      this.post({ type: 'status', message: t('status.handlerNotFound', { handler, file: path.basename(sources.primaryPath ?? this.designerFile) }) });
    }
  }

  async navigateToHandler(id: string, eventName: string, handler: string | undefined, ownerId?: string): Promise<void> {
    if (this.disposed || !this.designerFile) return;
    if (handler) { await this.openProjectHandlerAt(handler); return; }
    await this.createHandler(id, eventName, undefined, ownerId);
  }

  /** Refresh the property/event grid after an event-wiring commit — via the ITEM channel (loadItemProps) when the grid
   * is showing a ToolStrip item (ownerId set), else the CONTROL channel (loadProps). Mirrors resetItemFromGrid: the item
   * channel keeps item→Properties mode + the canvas highlight; loadProps(itemId) would be dropped by the panel's props
   * gate (itemId !== currentId, the strip) and silently exit item mode. */
  private async refreshAfterWiring(id: string, ownerId?: string): Promise<void> {
    if (ownerId) await this.loadItemProps(ownerId, id);
    else await this.loadProps(id);
  }

  async createHandler(
    id: string,
    eventName: string,
    handlerName?: string,
    ownerId?: string,
    interleaveAfterGeneration?: () => Promise<void>,
  ): Promise<void> {
    if (!this.designerFile) return;
    // Event wiring is structural metadata, not a localizable value. Both ordinary and ApplyResources-backed forms use
    // the same engine-verified wiring + signature gates, so localizable forms deliberately remain supported here.
    if (this.refuseUnknownBaselineMutation()) return; // no trustworthy baseline → no file write
    // Same reasoning for the render gate: navigateHandler is not a LOCALIZABLE_BLOCKED message, so nothing stopped
    // this path on a failed-render form — the .cs stub was written and only the wiring was refused by commit(),
    // leaving an orphan handler behind. Navigating to an EXISTING handler is unaffected (that branch never gets here).
    if (this.refuseStaleRenderMutation()) return;
    const eventSources = await this.projectEventSourceSnapshot();
    const codePath = eventSources.primaryPath;
    const codeDoc = eventSources.primaryDocument;
    const eng = await this.ensureEngine();

    const designerBefore = this.doc.designerText;
    const designerRev = this.doc.rev;
    const inlineDocument = !!codePath && normalize(codePath) === normalize(this.designerFile);
    const codeBefore = inlineDocument ? designerBefore : codeDoc?.getText() ?? null;
    const codeVer = codeDoc?.version ?? -1;
    const projectTexts = eventSources.texts.map((text, index) =>
      inlineDocument && normalize(eventSources.paths[index]) === normalize(this.designerFile!) ? designerBefore : text);

    const gen = await generateEventHandler(
      eng, this.designerFile, id, eventName, handlerName ?? null, designerBefore, codeBefore,
      this.asm() ?? null, projectTexts,
    );
    if (!gen.safe) { this.post({ type: 'status', message: t('status.createHandlerRejected', { reason: gen.reason || 'unsafe' }) }); return; }
    if (this.disposed) return;
    if (interleaveAfterGeneration) await interleaveAfterGeneration();

    if (this.doc.rev !== designerRev || (codeDoc && codeDoc.version !== codeVer)
      || !this.projectEventSnapshotUnchanged(eventSources)) {
      this.post({ type: 'status', message: t('status.docChanged') });
      return;
    }

    if (this.refuseUnknownBaselineMutation()) return; // no trustworthy baseline → no file write
    // Same for the render gate: a concurrent fullRender can FAIL during the engine round-trip above without moving
    // doc.rev (a control-source reload, a webview reinit), so the rev check misses it. Without this fresh look the
    // stub still lands and only commit() refuses the wiring — recreating the orphan handler the entry guard exists
    // to prevent.
    if (this.refuseStaleRenderMutation()) return;
    if (inlineDocument && gen.codeText != null) {
      if (!codePath || codeBefore == null || gen.designerText == null
        || gen.codeInsertText == null || gen.codeInsertOffset < 0) {
        this.post({ type: 'status', message: t('status.couldNotWriteStub') });
        return;
      }
      const combined = mergeInlineEventEdits(
        designerBefore, gen.designerText, gen.codeInsertOffset, gen.codeInsertText, gen.codeText,
      );
      if (combined == null) {
        this.post({ type: 'status', message: t('status.createHandlerRejected', { reason: 'inline wiring and handler edits overlap' }) });
        return;
      }
      const combinedProjectTexts = eventSources.texts.map((text, index) =>
        normalize(eventSources.paths[index]) === normalize(this.designerFile!) ? combined : text);
      const validation = await setEventWiring(
        eng, this.designerFile, id, eventName, gen.handlerName, combined, combined,
        this.asm() ?? null, combinedProjectTexts,
      );
      if (!validation.safe || validation.designerText !== combined) {
        this.post({ type: 'status', message: t('status.createHandlerRejected', { reason: validation.reason || 'combined inline event edit did not revalidate' }) });
        return;
      }
      if (this.doc.rev !== designerRev || !this.projectEventSnapshotUnchanged(eventSources)) {
        this.post({ type: 'status', message: t('status.docChanged') });
        return;
      }
      if (!this.commit(designerBefore, combined, `Create inline handler ${id}.${eventName}`,
        undefined, undefined, undefined, 'event')) return;
      this.output.appendLine(`created inline handler ${gen.handlerName} for ${id}.${eventName} in one document edit (unsaved)`);
      await this.refreshAfterWiring(id, ownerId);
      await this.postDirty();
      this.post({ type: 'status', message: t('status.wired', { event: eventName, handler: gen.handlerName }) });
      return;
    }
    // Apply the code-behind .cs stub FIRST (a real unsaved text edit the user reads/writes); only then commit the
    // in-memory .Designer.cs wiring. The exact before/after buffer pair is attached to that CustomDocument edit below,
    // so one designer Undo/Redo transitions BOTH artifacts instead of leaving the code stub in a separate history.
    let companionText: CompanionTextTx | undefined;
    if (gen.codeText != null) {
      if (!codeDoc || !codePath || codeBefore == null) {
        this.post({ type: 'status', message: t('status.noCodeBehindHandler') });
        return;
      }
      if (gen.codeInsertText == null || gen.codeInsertOffset < 0) {
        // No minimal form offered (shouldn't happen — the engine always emits one for a stub); refuse rather than
        // fall back to overwriting the file wholesale.
        this.post({ type: 'status', message: t('status.couldNotWriteStub') });
        return;
      }
      // Revalidate the engine's minimal insert before handing its exact whole-buffer image to the transaction. This
      // catches a malformed/misaligned engine result without applying anything to the user's document.
      if (codeBefore.slice(0, gen.codeInsertOffset) + gen.codeInsertText + codeBefore.slice(gen.codeInsertOffset)
        !== gen.codeText) {
        this.output.appendLine('[designer] handler wiring refused: the engine returned an inconsistent code-behind insert');
        this.post({ type: 'status', message: t('status.couldNotWriteStub') });
        return;
      }
      companionText = { document: codeDoc, before: codeBefore, after: gen.codeText };
      try {
        await this.transitionCompanionText(companionText, 'redo');
      } catch (error) {
        this.output.appendLine('[designer] handler wiring refused: ' + errMsg(error));
        this.post({ type: 'status', message: t('status.docChanged') });
        return;
      }
      // The gates above were fresh immediately before this write, but applyEdit is itself awaited: a concurrent render
      // can FAIL (or the form turn localizable, or the baseline go unknown) WHILE the stub is landing. Re-check, so the
      // WIRING is refused with the real reason rather than by commit()'s generic backstop.
  //
      // A gate can still flip while the code edit is being applied. The final commit below compensates this exact
      // buffer image if it refuses; an intervening edit makes that compensation fail closed instead of overwriting it.
      const gateRefused = this.refuseUnknownBaselineMutation() || this.refuseStaleRenderMutation();
      const revisionChanged = this.doc.rev !== designerRev;
      if (revisionChanged) this.post({ type: 'status', message: t('status.docChanged') });
      if (gateRefused || revisionChanged) {
        try { await this.transitionCompanionText(companionText, 'undo'); }
        catch (error) { this.output.appendLine('[designer] handler stub compensation failed: ' + errMsg(error)); }
        return;
      }
    }
    // Even when the designer text is already wired, a newly generated stub still needs a native composite undo unit.
    // If the final designer gate refuses, remove the exact stub image immediately; conflict leaves the user's newer
    // code untouched and is surfaced in the output channel.
    if (!this.commit(designerBefore, gen.designerText ?? designerBefore, `Wire ${id}.${eventName}`,
      undefined, undefined, undefined, 'event', companionText)) {
      if (companionText) {
        try { await this.transitionCompanionText(companionText, 'undo'); }
        catch (error) { this.output.appendLine('[designer] handler stub compensation failed: ' + errMsg(error)); }
      }
      return;
    }

    this.output.appendLine(`created handler ${gen.handlerName} for ${id}.${eventName}${gen.alreadyWired ? ' (already wired)' : ''} (unsaved)`);
    await this.refreshAfterWiring(id, ownerId);
    await this.postDirty();
    await this.openProjectHandlerAt(gen.handlerName);
  }

  private async createDefaultHandler(id: string): Promise<void> {
    const component = await this.describeFor(id);
    if (!component || component.editable === false || component.ownership === 'inherited' || component.ownership === 'unresolved') {
      this.post({ type: 'status', message: t('status.editRejected', { reason: component?.readOnlyReason || 'component is read-only' }) });
      return;
    }
    const eventName = component?.defaultEvent;
    if (!eventName) {
      this.post({ type: 'status', message: t('status.noDefaultEvent', { id }) });
      return;
    }
    await this.createHandler(id, eventName);
  }

  private async openHandlerAt(codePath: string | null, handler: string): Promise<void> {
    if (!codePath) { this.post({ type: 'status', message: t('status.noCodeBehindNav') }); return; }
    let doc: vscode.TextDocument;
    try { doc = await vscode.workspace.openTextDocument(codePath); }
    catch { this.post({ type: 'status', message: t('status.cannotOpen', { file: path.basename(codePath) }) }); return; }

    const re = new RegExp('(?:^|[^\\w.])' + escapeRegex(handler) + '\\s*\\([^)]*\\)\\s*\\{');
    const text = doc.getText();
    const mm = re.exec(text);
    if (!mm) { this.post({ type: 'status', message: t('status.handlerNotFound', { handler, file: path.basename(codePath) }) }); return; }
    const brace = mm.index + mm[0].length - 1;

    const braceLine = doc.positionAt(brace).line;
    const bodyLine = Math.min(braceLine + 1, doc.lineCount - 1);
    const lineText = doc.lineAt(bodyLine).text;
    const col = lineText.trim().length === 0 ? lineText.length : doc.lineAt(bodyLine).firstNonWhitespaceCharacterIndex;
    const pos = new vscode.Position(bodyLine, col);
    this.onViewCode(vscode.Uri.file(codePath), pos);
    this.post({ type: 'status', message: t('status.navigateHandler', { handler }) });
  }

  /** Events dropdown candidates → the Properties view (lazy: only when the Events tab asks). */
  async sendCandidates(id: string): Promise<void> {
    if (!this.designerFile || this.disposed) return;
    try {
      const sources = await this.projectEventSourceSnapshot();
      if (sources.texts.length === 0) { DesignerHub.instance.pushPanel(this, { type: 'candidates', id, map: {} }); return; }
      const eng = await this.ensureEngine();
      const codeText = sources.primaryDocument?.getText() ?? null;
      const map = await listHandlerCandidates(
        eng, this.designerFile, id, (await this.currentText()) ?? null, codeText,
        this.asm() ?? null, sources.texts,
      );
      if (this.disposed) return;
      DesignerHub.instance.pushPanel(this, { type: 'candidates', id, map });
    } catch {
      DesignerHub.instance.pushPanel(this, { type: 'candidates', id, map: {} });
    }
  }

  async setHandler(id: string, event: string, value: string, ownerId?: string): Promise<void> {
    if (value === NEW_HANDLER) { await this.createHandler(id, event, undefined, ownerId); return; }
    await this.applyEventWiring(id, event, value === '' ? null : value, ownerId);
  }

  private async applyEventWiring(
    id: string,
    event: string,
    handler: string | null,
    ownerId?: string,
    interleaveAfterValidation?: () => Promise<void>,
  ): Promise<void> {
    if (!this.designerFile || this.disposed) return;
    const eng = await this.ensureEngine();
    // Keep every project-partial DOCUMENT, not just its text: the engine validates the handler against this snapshot,
    // so the wiring is sound only if none of those partials changed before commit.
    const eventSources = await this.projectEventSourceSnapshot();
    const codeText = eventSources.primaryDocument?.getText() ?? null;

    const before = this.doc.designerText;
    const rev = this.doc.rev;

    const res = await setEventWiring(
      eng, this.designerFile, id, event, handler, before, codeText,
      this.asm() ?? null, eventSources.texts,
    );
    if (!res.safe || res.designerText == null) {
      this.post({ type: 'status', message: t('status.wiringRejected', { reason: res.reason || 'unsafe' }) });
      await this.refreshAfterWiring(id, ownerId);
      return;
    }
    if (interleaveAfterValidation) await interleaveAfterValidation();
    // The .Designer.cs revision was always checked here; the CODE-BEHIND was not checked at all. The engine had just
    // confirmed the handler exists in the snapshot above — but if it was renamed or deleted during the round-trip,
    // this committed `Click += new EventHandler(this.button1_Click)` against a method that no longer exists, and said
    // it wired successfully. createHandler guarded its own write and this sibling path stayed fail-open.
    if (this.doc.rev !== rev || !this.projectEventSnapshotUnchanged(eventSources)) {
      this.post({ type: 'status', message: t('status.docChanged') });
      await this.refreshAfterWiring(id, ownerId);
      return;
    }
    if (!this.commit(before, res.designerText, `${handler ? 'Wire' : 'Unwire'} ${id}.${event}`,
      undefined, undefined, undefined, 'event')) return;
    this.output.appendLine(`${handler ? 'wired' : 'unwired'} ${id}.${event}${handler ? ' → ' + handler : ''} (unsaved)`);
    this.post({ type: 'status', message: handler ? t('status.wired', { event, handler }) : t('status.unwired', { event }) });
    await this.refreshAfterWiring(id, ownerId);
    await this.postDirty();
  }

  /** Toolbox click: add a control into the active session's selected container (or the form). */
  async addControlFromToolbox(controlType: string): Promise<void> {
    await this.applyAddControl(controlType, this.containerParentFor(this.currentId));
  }

  async selectToolboxControl(controlType: string): Promise<void> {
    const item = this.toolboxItemFor(controlType);
    if (!item) {
      this.setToolboxSelection(null);
      this.post({ type: 'status', message: t('status.addRejected', { reason: 'unknown toolbox item: ' + controlType }) });
      return;
    }
    this.setToolboxSelection(item.fromProject ? item.fqn : item.name);
  }

  private setToolboxSelection(controlType: string | null): void {
    this.selectedToolboxControl = controlType;
    this.post({ type: 'toolboxSelection', controlType });
    DesignerHub.instance.pushPanel(this, { type: 'toolboxSelection', controlType });
  }

  private toolboxItemFor(controlType: string): ToolboxItemInfo | null {
    return this.availableToolboxItems()
      .find((item) => !item.isComponent && (item.fqn === controlType || item.name === controlType)) ?? null;
  }

  private async applyAddControl(controlType: string, parentId: string, dropX?: number, dropY?: number, width?: number, height?: number): Promise<boolean> {
    if (!this.designerFile || this.disposed) return false;
    const eng = await this.ensureEngine();
    const before = this.doc.designerText;
    const rev = this.doc.rev;
    let locX: number | undefined;
    let locY: number | undefined;
    if (dropX !== undefined && dropY !== undefined) {
      const par = this.controls.find((c) => c.id === (parentId || 'this'));
      const clientX = par?.clientX ?? par?.x ?? 0;
      const clientY = par?.clientY ?? par?.y ?? 0;
      locX = Math.max(0, Math.round(dropX - clientX));
      locY = Math.max(0, Math.round(dropY - clientY));
    }
    const sizeProvided = width !== undefined || height !== undefined;
    if (sizeProvided && (!Number.isFinite(width) || !Number.isFinite(height)
      || !Number.isInteger(width) || !Number.isInteger(height)
      || (width as number) <= 0 || (height as number) <= 0)) {
      this.post({ type: 'status', message: t('status.addRejected', { reason: 'invalid placement size' }) });
      return false;
    }
    const sizeW = sizeProvided ? width as number : undefined;
    const sizeH = sizeProvided ? height as number : undefined;
    const asm = this.asm();
    const toolboxItem = this.toolboxItemFor(controlType);
    if (!toolboxItem) {
      this.post({ type: 'status', message: t('status.addRejected', { reason: 'unknown toolbox item: ' + controlType }) });
      return false;
    }
    const addKey = toolboxItem.fromProject ? toolboxItem.fqn : toolboxItem.name;
    const sourceAssembly = toolboxItem?.assemblyPath && fs.existsSync(toolboxItem.assemblyPath)
      ? toolboxItem.assemblyPath : undefined;
    // The Roslyn text splice runs on net9. For a net48 form net9 can't load the vendor (DevExpress/net4x)
    // assembly, so instead of an asm-based enumeration we hand it the FQNs the net48 engine enumerated —
    // the pure-text splice emits `new <Fqn>()` and the net48 engine live-instantiates the control below.
    const addAsm = this.engineKind === 'net48' ? undefined : (sourceAssembly ?? asm);
    const projectFqns = this.engineKind === 'net48'
      ? this.availableToolboxItems()
        .filter((it) => it.fromProject).map((it) => it.fqn)
      : undefined;
    if (this.localizable) {
      // Visual Studio permits structural editing only in the Default language. A satellite-culture view owns value
      // overrides, not component identity; adding there would create a control absent from the neutral form graph.
      if (this.localizationCulture !== '') {
        this.post({ type: 'status', message: t('status.editRejected', { reason: 'switch Language to (Default) before adding controls' }) });
        return false;
      }
      const resxUri = this.localizedResxUri('');
      const resxRead = await this.readResx(resxUri);
      const localized = await addLocalizedControl(
        eng, this.designerFile, parentId || 'this', addKey, before, resxRead?.text ?? null,
        locX, locY, addAsm, projectFqns, this.renderedAutoScale, sizeW, sizeH,
      );
      if (!localized.safe || localized.newText === null || localized.resxText == null) {
        this.post({ type: 'status', message: t('status.addRejected', { reason: localized.reason || 'unsafe localized add' }) });
        return false;
      }
      if (this.doc.rev !== rev || this.localizationCulture !== '' || !this.localizable) {
        this.post({ type: 'status', message: t('status.docChanged') });
        return false;
      }
      if (binaryResxCount(resxRead?.text ?? null) > binaryResxCount(localized.resxText)) {
        this.post({ type: 'status', message: t('status.binaryResxRegenRefused', { n: binaryResxCount(resxRead?.text ?? null) - binaryResxCount(localized.resxText) }) });
        return false;
      }
      const tx: ResxTx = {
        uri: resxUri,
        before: resxRead?.text ?? null,
        after: localized.resxText,
        bom: resxRead?.hadBom ?? false,
      };
      try {
        const committed = await this.commitResourceSetThroughRunner(`Add localized ${addKey}`, [tx], before, localized.newText, {
          persistDesignerTextBeforeCommit: true,
          expectedDesignerRevision: rev,
        });
        if (!committed || committed.status !== 'committed')
          throw new Error(committed?.error ?? committed?.status ?? 'journal unavailable');
      } catch (error) {
        this.output.appendLine('[designer] localized structural add refused: ' + errMsg(error));
        this.post({ type: 'status', message: t('status.addRejected', { reason: errMsg(error) }) });
        return false;
      }
      this.currentId = localized.name;
      this.currentSelectionIds = [localized.name];
      this.setToolboxSelection(null);
      this.output.appendLine(`added localized ${addKey} → ${localized.name} (${localized.resourceKeys?.length ?? 0} resource values)`);
      if (this.engineKind === 'net48') {
        await this.live48((e) => addCompiledControl(e, this.designerFile!, asm!, parentId || 'this', addKey,
          localized.name, locX, locY, undefined, undefined, sizeW, sizeH), true, {});
      } else {
        await this.fullRender();
      }
      this.post({ type: 'status', message: t('status.added', { name: localized.name }) });
      if (this.engineKind !== 'net48' || (sourceAssembly && normalize(sourceAssembly) !== normalize(asm ?? '')))
        await this.maybeOfferProjectReference(addKey, sourceAssembly ?? asm);
      return true;
    }

    const res = await addControl(eng, this.designerFile, parentId || 'this', addKey, before, locX, locY, addAsm, projectFqns, this.renderedAutoScale, sizeW, sizeH);
    if (!res.safe || res.newText === null) { this.post({ type: 'status', message: t('status.addRejected', { reason: res.reason || 'unsafe' }) }); return false; }
    if (this.doc.rev !== rev) { this.post({ type: 'status', message: t('status.docChanged') }); return false; }
    if (!this.commit(before, res.newText, `Add ${addKey}`)) return false;
    this.currentId = res.name;
    this.currentSelectionIds = [res.name];
    this.setToolboxSelection(null);
    this.output.appendLine(`added ${addKey} → ${res.name} (unsaved)`);
    if (this.engineKind === 'net48') await this.live48((e) => addCompiledControl(e, this.designerFile!, asm!, parentId || 'this', addKey, res.name, locX, locY, undefined, undefined, sizeW, sizeH), true, {});
    else await this.fullRender();
    this.post({ type: 'status', message: t('status.added', { name: res.name }) });
    // A control from the chosen control-source assembly won't compile until the project references it — offer to add
    // one. net48-only skip: its project controls live in the form's OWN compiled assembly, so no <Reference> is needed.
    if (this.engineKind !== 'net48' || (sourceAssembly && normalize(sourceAssembly) !== normalize(asm ?? '')))
      await this.maybeOfferProjectReference(addKey, sourceAssembly ?? asm);
    return true;
  }

  /**
   * After adding a control that came from the chosen control-source assembly (a browsed .dll, or a resolved
   * project other than the form's own), the generated `new Ns.Foo()` won't compile until the form's project
   * references that assembly — Visual Studio adds a <Reference> in this situation, so we offer to as well.
   * Skips framework controls, the form's own project output, and assemblies already referenced. Best-effort:
   * a probe failure just means no offer (never blocks or breaks the add). Asked at most once per (project,
   * assembly) per session.
   */
  private async maybeOfferProjectReference(controlType: string, asm: string | undefined): Promise<void> {
    try {
      if (!asm || !this.designerFile || !fs.existsSync(asm)) return;
      // Only controls that came FROM the override assembly (the "Project Controls") need a reference; a
      // framework control (fromProject false) is always resolvable, and an unknown key is nothing we added.
      const item = this.availableToolboxItems()
        .find((it) => it.name === controlType || it.fqn === controlType);
      if (!item?.fromProject) return;

      const wsFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(this.designerFile))?.uri.fsPath;
      const csproj = findNearestCsproj(path.dirname(this.designerFile), wsFolder);
      if (!csproj) return;
      const asmName = path.basename(asm).replace(/\.dll$/i, '');
      if (!asmName) return;
      const latchKey = normalize(csproj) + '|' + asmName.toLowerCase();
      if (this.offeredReferences.has(latchKey)) return;

      let text: string;
      try { text = fs.readFileSync(csproj, 'utf8'); } catch { return; }
      // The form's own project builds these controls → no self-reference; already referenced (incl. via a
      // <ProjectReference> whose target <AssemblyName> matches) → nothing to do.
      if (projectAssemblyName(text, csproj).toLowerCase() === asmName.toLowerCase()) return;
      if (projectReferencesAssembly(text, csproj, asmName)) return;

      this.offeredReferences.add(latchKey); // count the offer whatever the answer, so we ask only once
      const projBase = path.basename(csproj);
      const addRefLabel = t('host.addReference.yes');
      const pick = await vscode.window.showInformationMessage(
        t('host.addReference', { asm: asmName, proj: projBase }),
        addRefLabel, t('host.addReference.no'),
      );
      if (pick !== addRefLabel) return;
      await this.addProjectReference(csproj, asmName, asm);
    } catch (e) {
      this.output.appendLine('offer project reference failed: ' + errMsg(e));
    }
  }

  /** Insert a `<Reference Include="name"><HintPath>…dll</HintPath></Reference>` into the .csproj as an
   * undoable edit (a HintPath relative to the project, like VS's "Add Reference → Browse"). Saves the file
   * only when it wasn't already dirty — so the reference takes effect without flushing the user's unrelated
   * in-progress .csproj edits to disk. */
  private async addProjectReference(csproj: string, includeName: string, dll: string): Promise<void> {
    let doc: vscode.TextDocument;
    try { doc = await vscode.workspace.openTextDocument(csproj); }
    catch { this.post({ type: 'status', message: t('status.cannotOpen', { file: path.basename(csproj) }) }); return; }
    const before = doc.getText();
    if (projectReferencesAssembly(before, csproj, includeName)) return; // added by something else since we checked
    // MSBuild accepts native separators; path.relative gives backslashes on Windows (matching VS-authored .csproj).
    const hintPath = path.relative(path.dirname(csproj), dll) || dll;
    const after = addReferenceToCsproj(before, includeName, hintPath);
    if (!projectReferencesAssembly(after, csproj, includeName)) { // defensive: the snippet must actually register
      this.post({ type: 'status', message: t('status.couldNotAddRef', { file: path.basename(csproj) }) });
      return;
    }
    const wasDirty = doc.isDirty;
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(before.length)), after);
    if (!(await vscode.workspace.applyEdit(edit))) { this.post({ type: 'status', message: t('status.couldNotUpdate', { file: path.basename(csproj) }) }); return; }
    // Don't force-save over the user's own unsaved .csproj edits — if it was already dirty, leave saving to them.
    if (!wasDirty) { try { await doc.save(); } catch { /* leave it dirty for the user to save manually */ } }
    this.output.appendLine(`added <Reference Include="${includeName}"> (HintPath ${hintPath}) → ${path.basename(csproj)}${wasDirty ? ' (unsaved)' : ''}`);
    this.post({ type: 'status', message: t('status.referenced', { name: includeName, file: path.basename(csproj) }) + (wasDirty ? t('status.referencedReview') : '') });
  }

  /** Toolbox add for a non-visual component (Timer/ToolTip/dialog…) — a bare `new T()` that lands in the tray.
   * No parent/position (unlike a control); mirrors applyAddControl's commit/rerender. */
  async addComponentFromToolbox(componentType: string): Promise<void> {
    if (!this.designerFile || this.disposed) return;
    // A component click supersedes any armed visual toolbox item. Clear the host-owned state before awaiting the
    // engine so the canvas cannot place the stale control while the component transaction is in flight or fails.
    this.setToolboxSelection(null);
    const eng = await this.ensureEngine();
    const before = this.doc.designerText;
    const rev = this.doc.rev;
    const res = await addComponent(eng, this.designerFile, componentType, before);
    if (!res.safe || res.newText === null) { this.post({ type: 'status', message: t('status.addRejected', { reason: res.reason || 'unsafe' }) }); return; }
    if (this.doc.rev !== rev) { this.post({ type: 'status', message: t('status.docChanged') }); return; }
    if (!this.commit(before, res.newText, `Add ${componentType}`)) return;
    this.currentId = res.name;
    this.currentSelectionIds = [res.name];
    this.output.appendLine(`added component ${componentType} → ${res.name} (unsaved)`);
    await this.fullRender();
    this.post({ type: 'status', message: t('status.addedTray', { name: res.name }) });
  }

  /** The base name of the code-behind partial when it references `id`, else null. The engine only ever sees the
   * .Designer.cs buffer, so a component the user's own code calls (`timer1.Start()`, `errorProvider1.SetError(…)`)
   * would keep compiling in the designer and break at the next build — long after we reported success. A whole-word
   * scan is deliberately conservative: a mention in a comment also blocks the rename, which fails closed. */
  private async codeBehindReference(id: string): Promise<string | null> {
    const codePath = this.codeFile();
    if (!codePath || !id) return null;
    let text: string;
    try { text = (await vscode.workspace.openTextDocument(codePath)).getText(); }
    catch { return null; }
    // C# identifiers may be non-ASCII (the engine validates with SyntaxFacts.IsValidIdentifier), and JS `\b` is
    // ASCII-only — a Unicode field name would have matched nothing and let the rename through, failing OPEN. Use
    // Unicode-aware boundaries, and escape the id so it can never be read as a pattern.
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // The boundary class mirrors what C# allows in an identifier PART — letters, digits, underscore/connectors,
    // combining marks and format characters — so `timer` is not "found" inside a longer identifier that merely
    // continues with a combining mark. (Verbatim `@name` and \uXXXX-escaped identifiers are still matched only in
    // their plain spelling; that direction fails closed for the escape form only, which no designer emits.)
    const part = '\\p{L}\\p{N}_\\p{M}\\p{Pc}\\p{Cf}';
    const word = new RegExp(`(?<![${part}])${escaped}(?![${part}])`, 'u');
    return word.test(text) ? path.basename(codePath) : null;
  }

  async promptComponentRename(id: string): Promise<void> {
    if (!this.designerFile || this.disposed || id === 'this') return;
    const component = await this.describeFor(id);
    if (!component || component.editable === false || component.ownership === 'inherited' || component.ownership === 'unresolved') {
      this.post({ type: 'status', message: t('status.editRejected', { reason: component?.readOnlyReason || 'component is read-only' }) });
      return;
    }
    const next = await vscode.window.showInputBox({
      value: id,
      valueSelection: [0, id.length],
      prompt: t('host.renameComponent.prompt', { old: id }),
      ignoreFocusOut: true,
    });
    if (next === undefined || next === id) return;
    await this.applyComponentRename(id, next);
  }

  private async applyComponentRename(oldId: string, newId: string): Promise<void> {
    if (!this.designerFile || this.disposed || oldId === 'this') return;
    const referencedIn = await this.codeBehindReference(oldId);
    if (referencedIn) {
      this.post({ type: 'status', message: t('status.trayRenameCodeBehind', { old: oldId, file: referencedIn }) });
      await this.fullRender();
      return;
    }
    const eng = await this.ensureEngine('modern');
    const before = this.doc.designerText;
    const rev = this.doc.rev;
    const res = await renameComponent(eng, this.designerFile, oldId, newId, before);
    if (!res.safe || res.newText === null) {
      this.post({ type: 'status', message: t('status.editRejected', { reason: res.reason || 'unsafe rename' }) });
      await this.fullRender();
      return;
    }
    if (this.doc.rev !== rev) {
      this.post({ type: 'status', message: t('status.docChanged') });
      await this.fullRender();
      return;
    }
    // Re-check the code-behind immediately before committing. doc.rev only tracks the .Designer.cs custom document,
    // so a reference typed into the sibling partial while the engine RPC was in flight would otherwise be missed —
    // and this rename cannot rewrite it.
    const referencedNow = await this.codeBehindReference(oldId);
    if (referencedNow) {
      this.post({ type: 'status', message: t('status.trayRenameCodeBehind', { old: oldId, file: referencedNow }) });
      await this.fullRender();
      return;
    }
    if (this.doc.rev !== rev) {
      this.post({ type: 'status', message: t('status.docChanged') });
      await this.fullRender();
      return;
    }
    if (!this.commit(before, res.newText, `Rename ${oldId} to ${res.name}`)) return;
    // Only follow the rename with the selection if the user is still ON it. A selection-only pick does not bump
    // doc.rev, so the revision check above cannot see it: without this guard a rename that lands after the user
    // clicked another control snaps the selection back and re-arms Delete on a target they no longer chose.
    if (this.currentId === oldId) this.currentId = res.name;
    this.currentSelectionIds = this.currentSelectionIds.map((id) => id === oldId ? res.name : id);
    this.output.appendLine(`renamed component ${oldId} -> ${res.name} (unsaved)`);
    await this.fullRender();
    this.post({ type: 'status', message: t('status.trayRenamed', { old: oldId, new: res.name }) });
  }

  private async applyRemoveControl(id: string): Promise<void> {
    if (!this.designerFile || this.disposed || id === 'this') return;
    if (this.localizable) {
      await this.applyLocalizedStructuralRemove([id], `Remove localized ${id}`);
      return;
    }
    const eng = await this.ensureEngine();
    const before = this.doc.designerText;
    const rev = this.doc.rev;
    const res = await removeControl(eng, this.designerFile, id, before);
    if (!res.safe || res.newText === null) { this.post({ type: 'status', message: t('status.removeRejected', { reason: res.reason || 'unsafe' }) }); return; }
    if (this.doc.rev !== rev) { this.post({ type: 'status', message: t('status.docChanged') }); return; }
    if (!this.commit(before, res.newText, `Remove ${id}`)) return;
    this.currentId = 'this';
    this.currentSelectionIds = ['this'];
    this.output.appendLine(`removed ${id} (unsaved)`);
    if (this.engineKind === 'net48') await this.live48((e) => removeCompiledControls(e, this.designerFile!, this.asm()!, [id]), true, {});
    else await this.fullRender();
    this.post({ type: 'status', message: t('status.removedComponent', { id }) });
  }

  /** Tell the canvas whether the clipboard has something to paste (enables/disables the Paste menu item). */
  private pushClipboardState(): void {
    this.post({ type: 'clipboard', has: !!DesignerHub.instance.clipboard });
  }

  /**
   * Copy the given controls (Cut/Copy) to the shared designer clipboard. Each control is serialized by the
   * engine to an opaque blob (refused for the root / a container with children / an entangled control). No
   * document change — copying never edits the .Designer.cs.
   */
  private async applyCopy(ids: string[]): Promise<void> {
    if (!this.designerFile || this.disposed) return;
    const copyable = ids.filter((id) => id && id !== 'this');
    if (!copyable.length) return;
    const eng = await this.ensureEngine();
    const text = await this.currentText();
    const clips: string[] = [];
    const names: string[] = [];
    let refused = 0;
    for (const id of copyable) {
      const res = await copyControl(eng, this.designerFile, id, text);
      if (res.safe && res.clip) { clips.push(res.clip); names.push(id); } else refused++;
    }
    if (!clips.length) { this.post({ type: 'status', message: t('status.nothingCopied') }); return; }
    DesignerHub.instance.clipboard = { clips, label: names.join(', ') };
    this.pushClipboardState();
    const note = refused ? tn('status.copiedSkipped', refused) : '';
    this.post({ type: 'status', message: tn('status.copied', clips.length) + note });
  }

  /** Cut = copy to the clipboard, then delete (one undoable removal). Copy never edits the document, so the
   * resulting undo entry is just the removal. Controls the engine refuses to copy are not deleted either. */
  private async applyCut(ids: string[]): Promise<void> {
    if (!this.designerFile || this.disposed) return;
    const cutable = ids.filter((id) => id && id !== 'this');
    if (!cutable.length) return;
    const before = DesignerHub.instance.clipboard;
    await this.applyCopy(cutable);
    if (DesignerHub.instance.clipboard === before) return; // copy refused everything → nothing to cut
    // delete only what actually made it onto the clipboard (its label lists the copied ids)
    const copied = (DesignerHub.instance.clipboard?.label ?? '').split(', ').filter(Boolean);
    if (copied.length > 1) await this.applyGroupRemove(copied);
    else await this.applyRemoveControl(copied[0]);
  }

  /**
   * Paste the clipboard's controls into the target container (the selected Panel/GroupBox/… or the form),
   * chained into ONE undoable edit. Each clone gets a fresh unique name; the last pasted control is selected.
   */
  private async applyPaste(targetId?: string): Promise<void> {
    if (!this.designerFile || this.disposed) return;
    const clip = DesignerHub.instance.clipboard;
    if (!clip || !clip.clips.length) { this.post({ type: 'status', message: t('status.clipboardEmpty') }); return; }
    const parent = this.containerParentFor(targetId ?? this.currentId);
    const eng = await this.ensureEngine();
    const before = this.doc.designerText;
    const rev = this.doc.rev;
    let text = before;
    let last = '';
    let applied = 0;
    const unavailable = new Set<string>();
    // For the net48 compiled preview, mirror each accepted paste by live-instantiating the clone (the net9 text
    // splice below isn't in the compiled instance). It comes up default-styled at the pasted Location, exactly like
    // Add; a project rebuild reconciles the copied property values (net48's text-is-truth / picture-best-effort).
    const live48Adds: { typeName: string; name: string; x: number; y: number }[] = [];
    for (const c of clip.clips) {
      const res = await pasteControl(eng, this.designerFile, c, parent, text);
      if (res.safe && res.newText !== null) {
        text = res.newText; last = res.name; applied++;
        if (this.engineKind === 'net48' && res.typeName) live48Adds.push({ typeName: res.typeName, name: res.name, x: res.x, y: res.y });
      } else {
        for (const dependency of res.missingDependencies ?? []) unavailable.add(dependency);
      }
    }
    if (!applied) {
      const detail = unavailable.size ? ` Missing dependencies: ${[...unavailable].join(', ')}.` : '';
      this.post({ type: 'status', message: t('status.pasteRejected') + detail });
      return;
    }
    if (this.doc.rev !== rev) { this.post({ type: 'status', message: t('status.docChanged') }); return; }
    if (!this.commit(before, text, `Paste ${applied} control${applied > 1 ? 's' : ''}`)) return;
    this.currentId = last || this.currentId;
    this.currentSelectionIds = [this.currentId];
    this.output.appendLine(`pasted ${applied} control(s) into ${parent} (unsaved)`);
    let net48Stale = false;
    if (this.engineKind === 'net48') {
      if (this.net48RenderMode === 'interpreted') {
        // interpreted canvas: the whole paste is committed to source, so re-interpret ONCE. The per-control
        // compiled adds would flip the canvas to the build mid-batch (show48 sets mode='compiled') and can't reach a
        // source-only parent, leaving a partial/wrong mirror.
        await this.fullRender();
      } else if (live48Adds.length && !this.asm()) {
      // If the control assembly went away mid-session the live picture can't be updated — the text/undo state is
        // still truthful (net48's text-is-truth contract), so say so instead of a plain "unsaved".
        net48Stale = true;
      } else {
        for (const a of live48Adds) {
        await this.live48((e) => addCompiledControl(e, this.designerFile!, this.asm()!, parent, a.typeName, a.name, a.x >= 0 ? a.x : undefined, a.y >= 0 ? a.y : undefined));
        }
      }
    } else {
      await this.fullRender();
    }
    this.post({ type: 'status', message: net48Stale ? tn('status.pastedStale', applied) : tn('status.pasted', applied) });
  }

  /**
   * Duplicate (Ctrl+D): clone each selected control in place WITHOUT touching the shared Cut/Copy clipboard
   * (VS's Duplicate leaves the clipboard alone). Each source is copied to a temporary blob and pasted into its
   * OWN parent (a sibling, offset by the engine's paste nudge), chained into ONE undoable edit; the last clone
   * is selected so a repeated Ctrl+D cascades. Controls the engine refuses to copy (root / container with
   * children / entangled) are skipped — the same constraint as Copy.
   */
  private async applyDuplicate(ids: string[]): Promise<void> {
    if (!this.designerFile || this.disposed) return;
    const dupable = ids.filter((id) => id && id !== 'this');
    if (!dupable.length) return;
    const eng = await this.ensureEngine();
    const before = this.doc.designerText;
    const rev = this.doc.rev;
    // 1) copy each source to a LOCAL blob paired with its own parent — the shared clipboard is untouched
    const blobs: { clip: string; parent: string }[] = [];
    let refused = 0;
    for (const id of dupable) {
      const res = await copyControl(eng, this.designerFile, id, before);
      if (res.safe && res.clip) {
        const src = this.controls.find((c) => c.id === id);
        blobs.push({ clip: res.clip, parent: src?.parentId ?? 'this' });
      } else refused++;
    }
    if (!blobs.length) { this.post({ type: 'status', message: t('status.nothingDuplicated') }); return; }
    // 2) paste each clone into its own parent, chained into one edit (mirrors applyPaste's net48 live mirror)
    let text = before;
    let last = '';
    let applied = 0;
    const live48Adds: { typeName: string; name: string; x: number; y: number; parent: string }[] = [];
    for (const b of blobs) {
      const res = await pasteControl(eng, this.designerFile, b.clip, b.parent, text);
      if (res.safe && res.newText !== null) {
        text = res.newText; last = res.name; applied++;
        if (this.engineKind === 'net48' && res.typeName) live48Adds.push({ typeName: res.typeName, name: res.name, x: res.x, y: res.y, parent: b.parent });
      }
    }
    if (!applied) { this.post({ type: 'status', message: t('status.duplicateRejected') }); return; }
    if (this.doc.rev !== rev) { this.post({ type: 'status', message: t('status.docChanged') }); return; }
    if (!this.commit(before, text, `Duplicate ${applied} control${applied > 1 ? 's' : ''}`)) return;
    this.currentId = last || this.currentId;
    this.currentSelectionIds = [this.currentId];
    this.output.appendLine(`duplicated ${applied} control(s) (unsaved)`);
    let net48Stale = false;
    if (this.engineKind === 'net48') {
      if (this.net48RenderMode === 'interpreted') {
        // interpreted: re-interpret the committed batch ONCE; fullRender re-selects currentId (= the last
        // clone), so a repeated Ctrl+D still cascades. Skips the mid-batch-flipping per-control compiled adds.
        await this.fullRender();
      } else if (live48Adds.length && !this.asm()) {
        net48Stale = true;
      } else {
        for (const a of live48Adds) {
          await this.live48((e) => addCompiledControl(e, this.designerFile!, this.asm()!, a.parent, a.typeName, a.name, a.x >= 0 ? a.x : undefined, a.y >= 0 ? a.y : undefined));
        }
        // show48 posts layout/render but no selection; select the last clone so a repeated Ctrl+D cascades
        // (the net9 branch gets this for free from fullRender's trailing pushSelect)
        this.pushSelect(this.currentId);
      }
    } else {
      await this.fullRender();
    }
    const skipped = refused ? tn('status.copiedSkipped', refused) : '';
    this.post({ type: 'status', message: (net48Stale ? tn('status.duplicatedStale', applied) : tn('status.duplicated', applied)) + skipped });
  }

  /** Ctrl+drag: copy every selected source and paste all clones at the exact preview delta in one transaction.
   * Unlike Ctrl+D this path is all-or-nothing: a partial clone set would silently change the dragged group. */
  private async applyDuplicateDrag(ids: string[], rawDx: number, rawDy: number): Promise<void> {
    if (!this.designerFile || this.disposed) return;
    const targets = [...new Set(ids)].filter((id) => id && id !== 'this');
    const dx = Math.max(-100000, Math.min(100000, Math.round(rawDx)));
    const dy = Math.max(-100000, Math.min(100000, Math.round(rawDy)));
    if (!targets.length || !Number.isFinite(rawDx) || !Number.isFinite(rawDy)) return;
    const eng = await this.ensureEngine();
    const before = this.doc.designerText;
    const rev = this.doc.rev;
    const blobs: { clip: string; parent: string }[] = [];
    for (const id of targets) {
      const copied = await copyControl(eng, this.designerFile, id, before);
      const source = this.controls.find((c) => c.id === id);
      if (!copied.safe || !copied.clip || !source) {
        this.post({ type: 'status', message: t('status.duplicateRejected') });
        return;
      }
      blobs.push({ clip: copied.clip, parent: source.parentId ?? 'this' });
    }

    let text = before;
    const cloneIds: string[] = [];
    const live48Adds: { typeName: string; name: string; x: number; y: number; parent: string }[] = [];
    for (const blob of blobs) {
      const pasted = await pasteControlAtOffset(eng, this.designerFile, blob.clip, blob.parent, dx, dy, text);
      if (!pasted.safe || pasted.newText === null) {
        this.post({ type: 'status', message: t('status.duplicateRejected') });
        return;
      }
      text = pasted.newText;
      cloneIds.push(pasted.name);
      if (this.engineKind === 'net48' && pasted.typeName) {
        live48Adds.push({ typeName: pasted.typeName, name: pasted.name, x: pasted.x, y: pasted.y, parent: blob.parent });
      }
    }
    if (this.doc.rev !== rev) { this.post({ type: 'status', message: t('status.docChanged') }); return; }
    if (!this.commit(before, text, `Ctrl+drag duplicate ${cloneIds.length} control${cloneIds.length === 1 ? '' : 's'}`)) return;
    this.currentId = cloneIds[cloneIds.length - 1];
    this.currentSelectionIds = cloneIds;
    this.output.appendLine(`Ctrl+drag duplicated ${cloneIds.length} control(s) by ${dx},${dy} (unsaved)`);

    let net48Stale = false;
    if (this.engineKind === 'net48') {
      if (this.net48RenderMode === 'interpreted') {
        await this.fullRender();
      } else if (live48Adds.length && !this.asm()) {
        net48Stale = true;
      } else {
        for (const a of live48Adds) {
          await this.live48((e) => addCompiledControl(
            e, this.designerFile!, this.asm()!, a.parent, a.typeName, a.name,
            a.x >= 0 ? a.x : undefined, a.y >= 0 ? a.y : undefined,
          ));
        }
        this.pushSelect(this.currentId);
      }
    } else {
      await this.fullRender();
    }
    this.post({ type: 'status', message: net48Stale ? tn('status.duplicatedStale', cloneIds.length) : tn('status.duplicated', cloneIds.length) });
  }

  /**
   * Bring to Front / Send to Back: relocate each control's Controls.Add among its siblings (z-order), chained
   * into ONE undoable edit. A control already at the requested end is a no-op (skipped). Layout / unparented
   * controls the engine can't reorder are skipped.
   */
  private async applyZOrder(ids: string[], toFront: boolean): Promise<void> {
    if (!this.designerFile || this.disposed) return;
    const targets = ids.filter((id) => id && id !== 'this');
    if (!targets.length) return;
    const eng = await this.ensureEngine();
    const before = this.doc.designerText;
    const rev = this.doc.rev;
    let text = before;
    let applied = 0;
    // Bring-to-Front moves each control before the CURRENT first sibling, so processing the selection forward would
    // reverse the group's internal order; iterate it in reverse so the relative order is preserved (VS behavior).
    // Send-to-Back appends after the last sibling, so forward order already preserves it.
    const ordered = toFront ? [...targets].reverse() : targets;
    for (const id of ordered) {
      const res = await moveZOrder(eng, this.designerFile, id, toFront, text);
      if (res.safe && res.newText !== null && res.newText !== text) { text = res.newText; applied++; }
    }
    if (!applied) { this.post({ type: 'status', message: toFront ? t('status.alreadyFront') : t('status.alreadyBack') }); return; }
    if (this.doc.rev !== rev) { this.post({ type: 'status', message: t('status.docChanged') }); return; }
    if (!this.commit(before, text, toFront ? 'Bring to Front' : 'Send to Back')) return;
    this.output.appendLine(`${toFront ? 'brought to front' : 'sent to back'} ${applied} control(s) (unsaved)`);
    if (this.engineKind === 'net48') await this.live48((e) => setCompiledZOrder(e, this.designerFile!, this.asm()!, targets, toFront), true, {});
    else await this.fullRender();
    this.post({ type: 'status', message: toFront ? t('status.broughtFront') : t('status.sentBack') });
  }

  /** Switch the standard tab page whose real header contains (x,y). Modern and net48 live-source canvases persist
   * only bounded view state; compiled net48 also updates its cached instance and records the hit for a later
   * live-source route. No source/resource edit is produced, and an off-header point is a harmless no-op. */
  private async applyTabClick(hostId: string, x: number, y: number): Promise<void> {
    if (this.disposed || !this.designerFile) return;
    if (this.engineKind === 'modern') {
      let hit;
      try {
        hit = await hitTestTab(await this.ensureEngine('modern'), this.designerFile, hostId,
          Math.round(x), Math.round(y), this.asm(), (await this.currentText()) ?? '', this.tabViewState());
      } catch { return; }
      if (hit.pageId) {
        this.setSelectedTab(hostId, hit.pageId);
        await this.fullRender(true);
      }
      return;
    }
    const asm = this.asm();
    if (!asm) return;
    if (this.net48RenderMode === 'interpreted') {
      // under an interpreted canvas, tab navigation is TRANSIENT VIEW STATE (not a source edit):
      // resolve the clicked page on the interpreted geometry, record it, and re-render interpreted with that page
      // selected — the canvas stays interpreted (no compiled mutation, no flip to the build). Off a header → no-op.
    let hit;
      try { hit = await hitTestInterpretedTab(await this.ensureEngine('net48'), this.designerFile!, asm, (await this.currentText()) ?? '', hostId, Math.round(x), Math.round(y), this.tabViewState()); }
    catch { return; }
      if (hit.pageId) { this.setSelectedTab(hostId, hit.pageId); await this.fullRender(true); }
      return;
    }
    // notifyOnNotApplied=false — this is NAVIGATION, not an edit: it persists no source, and its ordinary
    // `applied===false` (the point wasn't on another tab's header — the active tab or the page body) is a plain no-op,
    // so it must not post a "changes aren't reflected" status.
    // Persist the field-backed hit as well as mutating the cached compiled picture. A later live-source route keeps
    // the same page; the disclosed compiled fallback remains build-derived after restart. Off-header stays a no-op.
    try {
      const hit = await hitTestCompiledTab(await this.ensureEngine('net48'), this.designerFile, asm, hostId, Math.round(x), Math.round(y));
      if (hit.pageId) this.setSelectedTab(hostId, hit.pageId);
    } catch { /* the live select below remains the compatibility path */ }
    await this.live48((e) => selectCompiledTabAt(e, this.designerFile!, asm, hostId, Math.round(x), Math.round(y)), false);
  }

  /**
   * Double-click a field-backed tab header on either engine, prompt for a new caption,
   * and rename it by editing that page's Text through the normal edit path (net9 splices `this.<page>.Text = "…"`,
   * net48 updates the live picture). A no-op if the point wasn't on a field-backed tab header.
   */
  private async applyTabRename(hostId: string, x: number, y: number): Promise<void> {
    if (this.disposed || !this.designerFile) return;
    const asm = this.asm();
    if (this.engineKind === 'net48' && !asm) return;
    let hit;
    // hit-test against the geometry the user actually sees: interpreted when the canvas is interpreted
    // (else the compiled build's tab-header rects, which can differ after a live move.
    try {
      hit = this.engineKind === 'modern'
        ? await hitTestTab(await this.ensureEngine('modern'), this.designerFile, hostId, Math.round(x), Math.round(y),
          asm, (await this.currentText()) ?? '', this.tabViewState())
        : this.net48RenderMode === 'interpreted'
          ? await hitTestInterpretedTab(await this.ensureEngine('net48'), this.designerFile, asm!, (await this.currentText()) ?? '', hostId, Math.round(x), Math.round(y), this.tabViewState())
          : await hitTestCompiledTab(await this.ensureEngine('net48'), this.designerFile, asm!, hostId, Math.round(x), Math.round(y));
    }
    catch { return; }
    if (!hit || !hit.pageId) return; // not on a tab header (or the page has no .Designer.cs field)
    const next = await vscode.window.showInputBox({
      prompt: `Rename tab "${hit.pageId}"`,
      value: hit.text,
      validateInput: (v) => (v.trim() === '' ? 'Enter a tab caption' : undefined),
    });
    if (next === undefined) return; // cancelled
    const val = next.trim();
    if (val === hit.text) return; // unchanged
    await this.applyEdit(hit.pageId, 'Text', 'System.String', false, val);
  }

  /**
   * Add a new empty tab page on either engine. The modern engine splices the field + `TabPages.Add`
   * (the page type is derived from an existing page in the layout), then net48 live-adds the page and makes it
   * active. Undoable in one commit. Persisted text keeps the tab even before a rebuild.
   */
  private async applyAddTab(hostId: string): Promise<void> {
    if (this.disposed) return;
    const asm = this.asm();
    if (this.engineKind === 'net48' && !asm) return;
    const pageType = this.controls.find((c) => c.parentId === hostId)?.type;
    if (!pageType) { this.post({ type: 'status', message: 'add tab: could not determine the tab page type' }); return; }
    const eng = await this.ensureEngine(); // net9 for the text splice
    const before = this.doc.designerText;
    const rev = this.doc.rev;
    const res = await addTabPage(eng, this.designerFile!, hostId, pageType, before);
    if (!res.safe || res.newText === null) { this.post({ type: 'status', message: 'add tab rejected: ' + (res.reason || 'unsafe') }); return; }
    if (this.doc.rev !== rev) { this.post({ type: 'status', message: 'document changed during edit — try again' }); return; }
    if (!this.commit(before, res.newText, `Add tab ${res.name}`)) return;
    this.currentId = res.name;
    this.currentSelectionIds = [res.name];
    // The newly-added page must be visible on the very next source render. Persist before either modern or
    // interpreted-net48 re-renders; compiled net48 also records the state for a later interpreted render.
    this.setSelectedTab(hostId, res.name);
    this.output.appendLine(`added tab ${res.name} to ${hostId} (unsaved)`);
    // Adding a tab is a committed source-backed edit: opt into interpreted re-render (like delete-tab) so an interpreted
    // net48 canvas re-interprets the new source rather than mutating the compiled instance and flipping to the last build.
    // A compiled-fallback canvas keeps the live addCompiledTab path.
    if (this.engineKind === 'modern') await this.fullRender();
    else await this.live48((e) => addCompiledTab(e, this.designerFile!, asm!, hostId, pageType, res.name), true, {});
    this.post({ type: 'status', message: `added tab ${res.name} — unsaved` });
  }

  /** Revision + order represented by the last TabPages collection handed to the panel. The atomic OK transaction is
   * accepted only against this exact baseline, matching the stale-write rule used by other structural editors. */
  private tabPageReadBaseline = new Map<string, { rev: number; pages: string[] }>();

  /** Shared read side for the typed TabPages collection editor. */
  private async readTabPages(hostId: string): Promise<{ ok: boolean; pages: string[]; reason: string }> {
    if (!this.designerFile) {
      this.tabPageReadBaseline.delete(hostId);
      return { ok: false, pages: [], reason: 'not available' };
    }
    try {
      const eng = await this.ensureEngine('modern');
      const revAtRead = this.doc.rev;
      const result = await listTabPages(eng, this.designerFile, hostId, this.doc.designerText);
      const pages = result.pages ?? [];
      if (result.ok) this.tabPageReadBaseline.set(hostId, { rev: revAtRead, pages: pages.slice() });
      else this.tabPageReadBaseline.delete(hostId);
      return { ok: result.ok, pages, reason: result.reason };
    } catch (error) {
      this.tabPageReadBaseline.delete(hostId);
      return { ok: false, pages: [], reason: errMsg(error) };
    }
  }

  /** Webview transport for the shared TabPages collection read side. */
  async sendTabPages(hostId: string): Promise<void> {
    this.post({ type: 'tabPageItems', id: hostId, ...(await this.readTabPages(hostId)) });
  }

  /** Atomic OK path for the typed TabPages collection editor. */
  async tabPagesFromGrid(hostId: string, pageIds: string[]): Promise<boolean> {
    try {
      const baseline = this.tabPageReadBaseline.get(hostId);
      return await this.applyTabPageOrder(hostId, pageIds, baseline?.rev, baseline?.pages);
    } catch (error) {
      this.post({ type: 'status', message: errMsg(error) });
      try { await this.loadProps(hostId); } catch { /* best effort */ }
      return false;
    }
  }

  /** Apply a complete TabPages permutation as one source commit / one native Undo unit. On a net48 compiled canvas,
   * mirror that one committed permutation with the existing adjacent live primitive; interpreted/modern canvases
   * replay the committed source. */
  private async applyTabPageOrder(
    hostId: string,
    pageIds: string[],
    revAtRead?: number,
    pagesAtRead?: string[],
  ): Promise<boolean> {
    if (this.disposed || !this.designerFile) return false;
    const eng = await this.ensureEngine('modern');
    const before = this.doc.designerText;
    const revBefore = revAtRead ?? this.doc.rev;
    const result = await setTabPageOrder(eng, this.designerFile, hostId, pageIds, before);
    if (!result.safe || result.newText === null) {
      this.post({ type: 'status', message: 'tab page order rejected: ' + (result.reason || 'unsafe') });
      return false;
    }
    if (this.doc.rev !== revBefore) {
      this.post({ type: 'status', message: t('status.docChanged') });
      await this.loadProps(hostId);
      return false;
    }
    if (result.newText === before) return true;
    if (!this.commit(before, result.newText, `Set ${hostId}.TabPages order`)) return false;

    const current = (pagesAtRead ?? []).slice();
    if (this.engineKind === 'modern') {
      await this.fullRender();
    } else {
      const asm = this.asm();
      if (asm && current.length === pageIds.length) {
        for (let target = 0; target < pageIds.length; target++) {
          let at = current.indexOf(pageIds[target]);
          while (at > target) {
            const pageId = current[at];
            await this.live48((engine) => moveCompiledTab(engine, this.designerFile!, asm, hostId, pageId, true), true, {});
            [current[at - 1], current[at]] = [current[at], current[at - 1]];
            at--;
          }
        }
      } else {
        await this.fullRender();
      }
    }
    this.output.appendLine(`set ${hostId}.TabPages order = [${pageIds.join(', ')}] (collection, unsaved)`);
    this.post({ type: 'status', message: `reordered ${hostId}.TabPages - unsaved` });
    await this.loadProps(hostId);
    await this.postDirty();
    return true;
  }

  /** Move the active field-backed page one position left/right in the canonical source collection order. The engine
   * swaps only adjacent Add/AddRange page references and proves the exact permutation before this one undoable commit.
   * Modern/net48 interpreted canvases replay the new source; a compiled fallback mirrors it on the live collection. */
  private async applyMoveTab(hostId: string, pageId: string, left: boolean): Promise<void> {
    if (this.disposed || !this.designerFile) return;
    const asm = this.asm();
    if (this.engineKind === 'net48' && !asm) return;
    const eng = await this.ensureEngine();
    const before = this.doc.designerText;
    const rev = this.doc.rev;
    const res = await moveTabPage(eng, this.designerFile, hostId, pageId, left, before);
    if (!res.safe || res.newText === null) {
      this.post({ type: 'status', message: 'move tab rejected: ' + (res.reason || 'unsafe') });
      return;
    }
    if (res.newText === before) {
      this.post({ type: 'status', message: `tab ${pageId} is already ${left ? 'first' : 'last'}` });
      return;
    }
    if (this.doc.rev !== rev) { this.post({ type: 'status', message: 'document changed during edit — try again' }); return; }
    if (!this.commit(before, res.newText, `Move tab ${pageId} ${left ? 'left' : 'right'}`)) return;
    this.currentId = pageId;
    this.currentSelectionIds = [pageId];
    this.setSelectedTab(hostId, pageId);
    this.output.appendLine(`moved tab ${pageId} ${left ? 'left' : 'right'} in ${hostId} (unsaved)`);
    if (this.engineKind === 'modern') await this.fullRender();
    else await this.live48((e) => moveCompiledTab(e, this.designerFile!, asm!, hostId, pageId, left), true, {});
    this.post({ type: 'status', message: `moved tab ${pageId} ${left ? 'left' : 'right'} — unsaved` });
  }

  /**
   * Delete a whole tab page (the page + its entire subtree) on either engine. The modern engine removes
   * the subtree's fields/statements and detaches the page from the host's tab collection (whole Controls.Add /
   * TabPages.Add, or a trimmed TabPages.AddRange element); net48 live-removes the page from the picture. Undoable in
   * one commit. Declines (with a status) when the page's subtree is referenced from outside it. The page id is the
   * host's currently-active tab (the visible one), so the user deletes what they see. Confirmed first (destructive).
   */
  private async applyDeleteTab(hostId: string, pageId: string): Promise<void> {
    if (this.disposed) return;
    const asm = this.asm();
    if (this.engineKind === 'net48' && !asm) return;
    const pick = await vscode.window.showWarningMessage(
      `Delete tab "${pageId}" and all controls on it? This cannot be undone except via Undo.`,
      { modal: true },
      'Delete Tab',
    );
    if (pick !== 'Delete Tab') return; // cancelled
    const eng = await this.ensureEngine(); // net9 for the text edit
    const before = this.doc.designerText;
    const rev = this.doc.rev;
    const res = await removeTabPage(eng, this.designerFile!, hostId, pageId, before);
    if (!res.safe || res.newText === null) { this.post({ type: 'status', message: 'delete tab rejected: ' + (res.reason || 'unsafe') }); return; }
    if (this.doc.rev !== rev) { this.post({ type: 'status', message: 'document changed during edit — try again' }); return; }
    if (!this.commit(before, res.newText, `Delete tab ${pageId}`)) return;
    if (this.currentId === pageId || this.currentSelectionIds.includes(pageId)) this.currentId = hostId;
    this.currentSelectionIds = [this.currentId];
    this.clearSelectedTab(hostId, pageId);
    this.output.appendLine(`deleted tab ${pageId} from ${hostId} (unsaved)`);
    // A deleted tab is a committed source-backed edit: opt into interpreted re-render (like a multi-property edit) so an
    // interpreted net48 canvas re-interprets the new source (the page is gone) instead of running the compiled-instance
    // mutation and flipping the picture to the last build. A compiled-fallback canvas keeps the live removeCompiledTab path.
    if (this.engineKind === 'modern') await this.fullRender();
    else await this.live48((e) => removeCompiledTab(e, this.designerFile!, asm!, hostId, pageId), true, {});
    this.post({ type: 'status', message: `deleted tab ${pageId} — unsaved` });
  }

  /** "Learn More Online": open the selected control type's .NET API docs; a third-party type (DevExpress, …) routes to
   * a web search instead of a 404'ing /dotnet/api page; an unknown type falls back to the WinForms hub. */
  private async openLearnMore(typeName?: string): Promise<void> {
    await vscode.env.openExternal(vscode.Uri.parse(learnMoreUrl(typeName)));
  }

  private postDirty(): void {
    if (!this.designerFile || this.disposed) return;
    // Dedupe the dirty badge: postDirty() is now called at the mutation point (commit/undo/redo/revert) AND by trailing
    // callers, so most invocations carry an unchanged value. Post only on a real change; the DOM
    // badge is otherwise re-set identically. Reset on 'ready' so a reloaded webview still gets its current state.
    if (this.doc.isDirty !== this.lastDirtyPosted) {
      this.lastDirtyPosted = this.doc.isDirty;
    this.post({ type: 'dirty', dirty: this.doc.isDirty });
    }
    // Keep the net48 "last build" disclosure's clean/dirty wording in step with the document even for changes that do
    // NOT re-render — a nonvisual Modifiers edit, a successful Save, undo/redo. Only net48:
    // composeFormNotice({}) carries no modern render result, so calling it on a modern form would wipe a real S2/S3
    // (inheritedBase / binaryResx) banner.
    if (this.engineKind === 'net48') this.composeFormNotice({});
  }

  private async patchOrRerender(
    id: string,
    prop: string,
    edit?: Readonly<{ beforeSourceText: string; afterSourceText: string; newValueExpr: string }>,
  ): Promise<boolean> {
    this.lastModernRetainedApplied = false;
    if (!this.designerFile || this.disposed) return false;
    const eng = await this.ensureEngine();
    await this.applyEngineLocalizationCulture(eng);
    const asm = this.asm();
    const text = await this.currentText();
    const seq = ++this.renderSeq;

    // A retained dirty-region patch carries the full frame's 1x/2x capture scale while its placement stays in logical
    // form pixels; the webview maps it into the current backing store. Never even PROBE for a patch when the edit is
    // one that moves or resizes the control. The probe is a
    // whole extra graph build in the engine (~53 ms on a small form, the dominant cost of a render), and the patch it
    // is probing for is refused a moment later anyway: a control that changed geometry leaves a hole at its old rect
    // that a single-control patch cannot repaint, so `geometryUnchanged` below always sends these to the full frame.
    // Measured on a plain form: a drag went from probe+frame (~127 ms) to frame (~74 ms).
    // A TabPage.Text edit repaints the PARENT host header, not the page's own client bitmap. Force one full frame for
    // both property-grid and header-double-click renames; otherwise the dirty patch leaves the old caption visible.
    const tabHeaderText = prop === 'Text' && this.controls.some((page) => page.id === id
      && this.controls.some((host) => host.id === page.parentId && host.isTabHost));
    const patchPossible = id !== 'this' && prop !== 'Checked' && prop !== 'CheckState' && !tabHeaderText
      && !GeometryProps.has(prop);
    if (patchPossible) {
      // Visual Studio keeps one live designer host and applies a property-grid edit to that graph. Do the same for the
      // bounded modern Text path: the engine-issued token, exact old bytes and independently-proven new bytes must all
      // agree before the retained DesignSurface is touched. The reply carries pixels, full layout, exact property
      // metadata and geometry authority from ONE post-edit graph. A refusal falls through to the established rebuild.
      const retainedToken = this.modernGraphToken;
      if (prop === 'Text' && edit && retainedToken
        && this.currentSelectionIds.length === 1 && this.currentSelectionIds[0] === id) {
        try {
          const retained = await applyCachedTextPropertyEdit(
            eng, retainedToken, this.designerFile, id, prop, edit.newValueExpr,
            edit.beforeSourceText, edit.afterSourceText,
          );
          if (seq !== this.renderSeq || this.disposed) return false;
          if (retained.applied && retained.graphToken && retained.component?.id === id
            && retained.geometry?.componentId === id) {
            this.modernGraphToken = retained.graphToken;
            if (!retained.layoutUnchanged) {
              this.controls = retained.controls;
              this.toolStripItems = retained.toolStripItems ?? [];
              this.rootClient = { w: retained.clientWidth, h: retained.clientHeight };
              this.rootFrame = { w: retained.frameWidth, h: retained.frameHeight };
            }
            if (retained.fullFrame) {
              this.post({
                type: 'render', png: retained.png.toString('base64'),
                width: retained.frameWidth, height: retained.frameHeight, gen: seq,
              });
            } else {
              this.post({
                type: 'patch', png: retained.png.toString('base64'),
                x: retained.x, y: retained.y, width: retained.width, height: retained.height, gen: seq,
              });
            }
            if (!retained.layoutUnchanged) this.postLayout(this.controls, this.toolStripItems);
            const component = this.emptyInitializeComponentSurface
              ? { ...retained.component, editable: false, readOnlyReason: t('designer.owner.emptyInitializeComponentReadOnly') }
              : retained.component;
            this.publishedPropertyComponent = { ids: [id], rev: this.doc.rev, component };
            DesignerHub.instance.pushPanel(this, { type: 'props', id, component });
            this.post({ type: 'tasks', id, component, vendorTags: [] });
            const geometry = retained.geometry;
            const manip = geometry.ok && geometry.logicalBounds && geometry.windowBounds
              ? { move: geometry.canMove, resize: geometry.canResize }
              : { move: false, resize: false };
            this.post({ type: 'manip', id, move: manip.move, resize: manip.resize });
            this.renderOk = true;
            this.lastModernRetainedApplied = true;
            return true;
          }
          this.output.appendLine(`[designer] retained Text edit refused for ${id}: ${retained.reason || 'incomplete snapshot'}`);
        } catch (error) {
          this.output.appendLine(`[designer] retained Text edit unavailable for ${id}: ${errMsg(error)}`);
        }
      }
      // Any non-retained property edit advances the source beyond the token's graph. A following full frame installs a
      // fresh token; a successful legacy dirty patch deliberately leaves this undefined instead of reusing stale state.
      this.modernGraphToken = undefined;
      let layout: Awaited<ReturnType<typeof describeLayout>>;
      try {
        layout = await describeLayout(eng, this.designerFile, asm, text);
      } catch {
        if (seq === this.renderSeq && !this.disposed) this.renderOk = false; // S5: current source didn't render → read-only
        return false;
      }
      if (seq !== this.renderSeq || this.disposed) return false;

      const geometryUnchanged = sameLayout(this.controls, layout.controls);
      this.controls = layout.controls;
      this.toolStripItems = layout.toolStripItems ?? [];
      this.rootClient = { w: layout.clientWidth, h: layout.clientHeight };
      this.postLayout(layout.controls, this.toolStripItems);

      const hasChildren = layout.controls.some((c) => c.parentId === id);
      if (geometryUnchanged && !hasChildren) {
        // 1.0.0 fail-closed — the dirty-region capture paints the real control (DrawToBitmap runs a custom control's
        // own paint code), so it can THROW where describeLayout succeeded. Unguarded, that exception unwound to the
        // caller's generic catch, which posted a status and left `renderOk` TRUE: the source held the committed edit
        // while the canvas kept the pre-edit pixels and the form stayed writable — a silent mis-render. A
        // per-control paint throw doesn't kill the engine either, so the crash handler is no backstop. Fall through
        // to the full-frame path instead; its own catch drops renderOk if that fails too.
        let patch: Awaited<ReturnType<typeof renderControl>> | undefined;
        try {
          patch = await renderControl(eng, this.designerFile, id, asm, text);
        } catch {
        patch = undefined; // fall through to the full-frame render below
        }
        if (seq !== this.renderSeq || this.disposed) return false;
        if (patch?.found) {
          this.post({
            type: 'patch', png: patch.png.toString('base64'),
            x: patch.x, y: patch.y, width: patch.width, height: patch.height, gen: seq,
          });
          return false;
        }
      }
    }

    this.modernGraphToken = undefined;
    let frame: Awaited<ReturnType<typeof renderWithLayout>>;
    try {
      frame = await renderWithLayout(eng, this.designerFile, asm, text, this.renderScale, this.tabViewState());
    } catch (err) {
      // S5: the full re-render of the current source FAILED → the form isn't renderable right now → read-only
      // (fail-closed; self-recovers when a later render — e.g. after Undo restores a renderable buffer — succeeds).
      if (seq === this.renderSeq && !this.disposed) {
        const message = t('status.renderFailed', { error: errMsg(err) });
        this.postRenderFailure(message, this.currentId || 'this', errMsg(err));
      }
      return false;
    }
    if (seq !== this.renderSeq || this.disposed) return false;
    this.modernGraphToken = frame.graphToken || undefined;
    this.controls = frame.controls;
    this.pruneSelectedTabs(frame.controls);
    this.toolStripItems = frame.toolStripItems ?? [];
    this.rootClient = { w: frame.clientWidth, h: frame.clientHeight };
    this.rootFrame = { w: frame.width, h: frame.height };
    this.post({ type: 'render', png: frame.png.toString('base64'), width: frame.width, height: frame.height, gen: seq });
    this.postLayout(frame.controls, this.toolStripItems);
    this.pushSelect(this.currentId);
    // keep the partial-render banner in lockstep with this whole-frame re-render (a value edit rarely changes which
    // constructs are unrepresentable, but if it does — e.g. fixing/breaking a control — refresh rather than go stale).
    this.postRenderDiagnostics(categorizeUnrepresentable(frame.unrepresentable));
    return false;
  }

  /** Real Extension Host E2E reaches the same engine-authorized single-control resize ingress as the canvas. */
  async extensionHostTestResizeControl(id: string, width: number, height: number): Promise<void> {
    const control = this.controls.find((candidate) => candidate.id === id);
    if (!control) throw new Error(`Unknown rendered control: ${id}`);
    await this.applyManipulate(id, 'resize', control.x, control.y, width, height);
  }

  /** Real Extension Host E2E reaches the same multi-control size transaction as the canvas layout toolbar. */
  async extensionHostTestResizeControls(
    sizeEdits: readonly { id: string; width: number; height: number }[],
  ): Promise<void> {
    await this.applyResize(sizeEdits.map((edit) => ({ ...edit })));
  }
}

/** Parse an invariant "x, y" / "w, h" pair to [n, n], or null if malformed. */
function parsePair(s?: string | null): [number, number] | null {
  if (!s) return null;
  const parts = s.split(',').map((n) => parseInt(n.trim(), 10));
  return parts.length === 2 && parts.every((n) => Number.isFinite(n)) ? [parts[0], parts[1]] : null;
}

/** Depth-first search for a ToolStrip/MenuStrip item node by its field id, across the whole forest (incl. submenus).
* Used by the on-canvas rename to locate the target in the freshly-parsed forest. Empty id never matches. */
function findToolStripItem(forest: ToolStripItemModel[], id: string): ToolStripItemModel | null {
  if (!id) return null;
  for (const it of forest) {
    if (it.id === id) return it;
    const hit = findToolStripItem(it.children ?? [], id);
    if (hit) return hit;
  }
  return null;
}

type ToolStripItemEntry = {
  item: ToolStripItemModel;
  parent: ToolStripItemModel | null;
  siblings: ToolStripItemModel[];
  index: number;
};

/** Locate an item plus the concrete sibling array that owns it so a move can detach/reinsert exactly one node. */
function findToolStripItemEntry(forest: ToolStripItemModel[], id: string, parent: ToolStripItemModel | null = null): ToolStripItemEntry | null {
  if (!id) return null;
  for (let i = 0; i < forest.length; i++) {
    const it = forest[i];
    if (it.id === id) return { item: it, parent, siblings: forest, index: i };
    const hit = findToolStripItemEntry(it.children ?? [], id, it);
    if (hit) return hit;
  }
  return null;
}

/** True when `item` contains `id` anywhere below it; used to reject cycle-creating reparent moves host-side. */
function containsToolStripItem(item: ToolStripItemModel, id: string): boolean {
  if (!id) return false;
  for (const child of item.children ?? []) {
    if (child.id === id || containsToolStripItem(child, id)) return true;
  }
  return false;
}

/** The item types that expose DropDownItems and may therefore be a nested move target. */
function isDropDownStripItemType(itemType: string): boolean {
  return /(?:^|\.)ToolStrip(?:MenuItem|DropDownButton|SplitButton)$/.test(itemType || '');
}

/** Return a new forest with the node whose field id is `id` (and its whole subtree) omitted, at any depth. Non-matching
* branches are rebuilt recursively so a submenu can lose one child without disturbing its siblings. Empty id ⇒ the
* forest is returned unchanged (never matches). Used by the on-canvas DELETE: the engine derives removedIds from the
* omission. */
function removeToolStripItem(forest: ToolStripItemModel[], id: string): ToolStripItemModel[] {
  if (!id) return forest;
  const out: ToolStripItemModel[] = [];
  for (const it of forest) {
    if (it.id === id) continue; // drop this node and its whole subtree
    out.push(it.children && it.children.length ? { ...it, children: removeToolStripItem(it.children, id) } : it);
  }
  return out;
}

/**
 * Properties whose edit MOVES or RESIZES something, so a dirty-region patch can never apply (the control leaves a
 * hole at its old rect, and layout-affecting values reflow siblings). Used to skip the layout probe entirely for
 * these edits — the probe is a full extra graph build whose only outcome would be "patch refused".
 */
const GeometryProps = new Set<string>([
  'Location', 'Size', 'Bounds', 'ClientSize', 'Left', 'Top', 'Width', 'Height',
  'Dock', 'Anchor', 'Padding', 'Margin', 'AutoSize', 'AutoSizeMode', 'Visible', 'TabIndex',
]);

/** Two layouts describe the same placement geometry and snap metadata — patch-safety gate. */
function sameLayout(a: LayoutControl[], b: LayoutControl[]): boolean {
  if (a.length !== b.length) return false;
  const key = (c: LayoutControl) => [
    c.id, c.parentId, c.x, c.y, c.width, c.height,
    c.clientX, c.clientY, c.clientWidth, c.clientHeight,
    c.margin?.left, c.margin?.top, c.margin?.right, c.margin?.bottom,
    c.padding?.left, c.padding?.top, c.padding?.right, c.padding?.bottom,
    c.textBaseline,
  ].join('|');
  const set = new Set(a.map(key));
  return b.every((c) => set.has(key(c)));
}

function normalize(fsPath: string): string {
  const p = path.normalize(fsPath);
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 0.11.0 ImageList editor — pull the whitespace-stripped base64 <value> of a binary resx <data> node by name
* (e.g. "imageList1.ImageStream"), or null if absent. The payload is base64 (no XML-special chars), so a focused
* regex is safe and avoids an XML dependency; whitespace inside <value> is stripped to a clean base64 blob. */
function extractResxBinaryValue(resxText: string | null, key: string): string | null {
  if (!resxText) return null;
  // Tolerate single quotes and whitespace around '=' exactly like the binaryResx scanner does: a `.resx` written by
  // hand or round-tripped through a third-party tool can spell the attribute `name='x.ImageStream'` or
  // `name = "x.ImageStream"`. Missing the node here is not a read miss — editImageListImages' data-loss guard keys
  // on this value, so a miss looked like "this ImageList has no images" and the save replaced the real set.
  const dataRe = new RegExp('<data\\b[^>]*\\bname\\s*=\\s*["\']' + escapeRegex(key) + '["\'][^>]*>([\\s\\S]*?)</data>', 'i');
  const dm = dataRe.exec(resxText);
  if (!dm) return null;
  const vm = /<value>([\s\S]*?)<\/value>/i.exec(dm[1]);
  if (!vm) return null;
  const b64 = vm[1].replace(/\s+/g, '');
  return b64.length ? b64 : null;
}

/** 0.11.0 ImageList editor — parse the index→key map for an ImageList from the designer text: primarily the
* `this.<comp>.Images.SetKeyName(i, "key")` calls (the serialized form), falling back to `this.<comp>.Images.Add("key", …)`
* order (the in-code form). Keys are C#-unescaped. Used to pair the (keyless) deserialized image bytes back to keys. */
function parseImageListKeys(designer: string, comp: string): string[] {
  const keys: string[] = [];
  const c = escapeRegex(comp);
  const setRe = new RegExp('\\bthis\\.' + c + '\\.Images\\.SetKeyName\\(\\s*(\\d+)\\s*,\\s*"((?:[^"\\\\]|\\\\.)*)"\\s*\\)', 'g');
  let m: RegExpExecArray | null; let any = false;
  while ((m = setRe.exec(designer)) !== null) { any = true; keys[parseInt(m[1], 10)] = unescapeCsString(m[2]); }
  if (any) return keys;
  const addRe = new RegExp('\\bthis\\.' + c + '\\.Images\\.Add\\(\\s*"((?:[^"\\\\]|\\\\.)*)"', 'g');
  while ((m = addRe.exec(designer)) !== null) keys.push(unescapeCsString(m[1]));
  return keys;
}

/** Minimal C# string-literal unescape for the common escapes that appear in image keys. */
function unescapeCsString(s: string): string {
  return s.replace(/\\(["\\'nrt0])/g, (_m, c) => (c === 'n' ? '\n' : c === 'r' ? '\r' : c === 't' ? '\t' : c === '0' ? '\0' : c));
}

/** A key not already used by any image in `existing` — the file base name, else name+N. */
function uniqueImageKey(base: string, existing: { key: string }[]): string {
  const used = new Set(existing.map((e) => e.key));
  const b = base || 'image';
  if (base && !used.has(base)) return base;
  for (let i = 1; ; i++) { const k = b + i; if (!used.has(k)) return k; }
}

/** Placeholder shown when a .cs has no .Designer.cs partner (nothing to render). */
function placeholderHtml(webview: vscode.Webview, file: string): string {
  const nonce = randomBytes(16).toString('hex');
  const name = path.basename(file);
  const base = name.replace(/\.cs$/i, '');
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}';">
<style nonce="${nonce}">
  body { font: 13px var(--vscode-font-family, sans-serif); color: var(--vscode-foreground); padding: 24px; }
  code { background: var(--vscode-textCodeBlock-background, #222); padding: 1px 4px; border-radius: 3px; }
  .muted { color: var(--vscode-descriptionForeground); }
</style></head>
<body>
  <h3>${t('placeholder.noDesigner', { name: escapeHtml(name) })}</h3>
  <p class="muted">${t('placeholder.needsDesignerCs', { base: escapeHtml(base) })}</p>
  <p class="muted">${t('placeholder.openAsCode')}</p>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
}

/** Common CSP + nonce header for a scripted webview that shows data: images and the codicon font. */
function cspMeta(webview: vscode.Webview, nonce: string): string {
  return `<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">`;
}

/**
* The big "Choose Toolbox Items" window (a separate editor-area webview panel): VS-style tabs (.NET / COM /
* WPF), a Name/Namespace/Assembly table, a filter, a details strip, and OK/Cancel/Reset. Its .NET rows come from the
* complete cached discovery pipeline; COM/WPF remain explicit non-.NET tabs rather than pretending to be supported.
*/
function chooseItemsHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = randomBytes(16).toString('hex');
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'chooseItems.js'));
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
${cspMeta(webview, nonce)}
<style nonce="${nonce}">
  /* VS Code injects a default body padding (0 20px) into every webview it hosts, so a surface that resets only the
     margin still renders inside a frame of dead space — most visible in the narrow side panel, where it comes
     straight out of the value column. Extensions that look edge-to-edge are the ones that zero this explicitly. */
  html, body { height: 100%; margin: 0; padding: 0; }
  body { font: 12px var(--vscode-font-family, sans-serif); color: var(--vscode-foreground); display: flex; flex-direction: column; }
  #ciTabs { flex: 0 0 auto; display: flex; gap: 2px; padding: 8px 10px 0; border-bottom: 1px solid var(--vscode-panel-border, #333); }
  #ciTabs .t { padding: 5px 12px; border: 1px solid var(--vscode-panel-border, #333); border-bottom: none; border-radius: 5px 5px 0 0;
    cursor: pointer; background: var(--vscode-tab-inactiveBackground, rgba(255,255,255,.04)); color: var(--vscode-descriptionForeground); }
  #ciTabs .t.active { background: var(--vscode-tab-activeBackground, rgba(255,255,255,.10)); color: var(--vscode-foreground); font-weight: bold; }
  #ciMain { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: 10px; gap: 8px; }
  #ciArea { flex: 1; min-height: 0; border: 1px solid var(--vscode-panel-border, #333); display: flex; flex-direction: column; }
  #ciLoading { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; color: var(--vscode-descriptionForeground); }
  .bar { width: 240px; height: 14px; border: 1px solid var(--vscode-panel-border, #333); border-radius: 2px; overflow: hidden; background: var(--vscode-input-background); }
  .bar > div { height: 100%; width: 30%; background: var(--vscode-progressBar-background, #0e70c0); animation: ind 1.1s linear infinite; }
  @keyframes ind { 0% { margin-left: -30%; } 100% { margin-left: 100%; } }
  #ciTable { flex: 1; min-height: 0; overflow: auto; }
  table { width: 100%; border-collapse: collapse; }
  th { position: sticky; top: 0; background: var(--vscode-sideBarSectionHeader-background, #2a2a2a); text-align: left; font-weight: normal;
    padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border, #333); }
  th.sortable { cursor: pointer; user-select: none; }
  th.sortable:hover { background: var(--vscode-list-hoverBackground, #2a2d2e); }
  th.sortable:focus-visible { outline: 1px solid var(--vscode-focusBorder, #0e70c0); outline-offset: -1px; }
  th.sorted { color: var(--vscode-list-activeSelectionForeground, #fff); }
  .sortmark { opacity: 0.8; }
  td { padding: 3px 8px; border-bottom: 1px solid var(--vscode-panel-border, #2b2b2b); white-space: nowrap; }
  tr:hover td { background: var(--vscode-list-hoverBackground, #2a2d2e); }
  tr.sel td { background: var(--vscode-list-activeSelectionBackground, #094771); color: var(--vscode-list-activeSelectionForeground, #fff); }
  td.chk { width: 26px; text-align: center; }
  .empty { padding: 22px; color: var(--vscode-descriptionForeground); }
  #ciFilterRow { flex: 0 0 auto; display: flex; gap: 8px; align-items: center; }
  #ciFilter { flex: 1; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, #555); padding: 4px; }
  #ciDetails { flex: 0 0 auto; border: 1px solid var(--vscode-panel-border, #333); padding: 8px; min-height: 40px; color: var(--vscode-descriptionForeground); }
  #ciDetails b { color: var(--vscode-foreground); }
  #ciFoot { flex: 0 0 auto; display: flex; justify-content: flex-end; gap: 8px; padding: 10px; border-top: 1px solid var(--vscode-panel-border, #333); }
  #ciStatus { margin-right: auto; align-self: center; color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  button { font: inherit; padding: 4px 16px; cursor: pointer; border: none; border-radius: 2px;
    background: var(--vscode-button-secondaryBackground, #3a3d41); color: var(--vscode-button-secondaryForeground, #fff); }
  button.primary { background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #fff); }
  button:disabled { opacity: .5; cursor: default; }
</style></head>
<body>
  <div id="ciTabs">
    <div class="t active" data-tab="net">${t('chooseItems.tab.net')}</div>
    <div class="t" data-tab="com">${t('chooseItems.tab.com')}</div>
    <div class="t" data-tab="wpf">${t('chooseItems.tab.wpf')}</div>
  </div>
  <div id="ciMain">
    <div id="ciArea">
      <div id="ciLoading"><div>${t('chooseItems.loading')}</div><div class="bar"><div></div></div><div id="ciLoadName">${t('chooseItems.scanning')}</div></div>
      <div id="ciTable"></div>
    </div>
    <div id="ciFilterRow"><span>${t('chooseItems.filter')}</span><input id="ciFilter" type="text"><button id="ciClear">${t('common.clear')}</button><button id="ciBrowse">${t('chooseItems.browse')}</button></div>
    <div id="ciDetails">${t('chooseItems.selectHint')}</div>
  </div>
  <div id="ciFoot"><span id="ciStatus"></span><button id="ciReset" disabled>${t('common.reset')}</button><button id="ciCancel">${t('common.cancel')}</button><button id="ciOk" class="primary">${t('common.ok')}</button></div>
${injectL10nScript(nonce)}
<script nonce="${nonce}" src="${scriptUri}"></script>
</body></html>`;
}

/**
* The canvas designer webview: a canvas-backed preview (so a dirty-region patch can be composited in place)
* with an absolute selection overlay + a zoom toolbar. The Toolbox/Properties are separate WebviewViews.
*/
function designerHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = randomBytes(16).toString('hex');
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'designer.js'));
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
${cspMeta(webview, nonce)}
<style nonce="${nonce}">
  /* VS Code injects a default body padding (0 20px) into every webview it hosts, so a surface that resets only the
     margin still renders inside a frame of dead space — most visible in the narrow side panel, where it comes
     straight out of the value column. Extensions that look edge-to-edge are the ones that zero this explicitly. */
  html, body { height: 100%; margin: 0; padding: 0; }
  body { font: 12px var(--vscode-font-family, sans-serif); color: var(--vscode-foreground); display: flex; flex-direction: column; }
  #toolbar { display: flex; align-items: center; gap: 8px; padding: 4px 8px; border-top: 1px solid var(--vscode-panel-border, #333); flex: 0 0 auto; }
  #toolbar .sel { color: var(--vscode-descriptionForeground); }
  #toolbar .spacer { flex: 1; }
  #toolbar .dirty { color: var(--vscode-gitDecoration-modifiedResourceForeground, #e2c08d); font-size: 11px; }
  .zoomgrp { display: flex; align-items: center; gap: 2px; }
  .zoomgrp button { padding: 1px 7px; }
  #toolbar button.active { background: var(--vscode-toolbar-activeBackground, rgba(255,255,255,.16)); box-shadow: inset 0 0 0 1px var(--vscode-focusBorder, #4ea1ff); }
  /* tab-order overlay badges */
  .tabBadge { position: absolute; min-width: 14px; height: 16px; padding: 0 3px; box-sizing: border-box;
    background: #c75; color: #fff; border: 1px solid #fff; border-radius: 3px; font-size: 11px; line-height: 14px;
    text-align: center; pointer-events: none; z-index: 7; }
  #zoomLabel { min-width: 46px; text-align: center; font-variant-numeric: tabular-nums; }
  button:disabled { opacity: 0.5; cursor: default; }
  button { font: inherit; background: var(--vscode-button-secondaryBackground, #3a3d41); color: var(--vscode-button-secondaryForeground, #fff); border: none; padding: 2px 8px; cursor: pointer; border-radius: 2px; }
  button:hover { background: var(--vscode-button-secondaryHoverBackground, #45494e); }
  #stage { flex: 1; min-width: 0; overflow: auto; background: #2b2b2b; padding: 16px; position: relative; }
  #overlay { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; text-align: center; padding: 24px; color: var(--vscode-descriptionForeground); white-space: pre-wrap; font-size: 13px; }
  #overlay.err { color: var(--vscode-errorForeground, #f48771); }
  /* T2.2 partial-render / failure diagnostics banner (top strip; .warn = constructs skipped, .err = stale last-known-good preview) */
  #diag { flex: 0 0 auto; max-height: 42%; overflow: auto; font-size: 12px; border-bottom: 1px solid var(--vscode-panel-border, #333); }
  #diag.warn { background: var(--vscode-inputValidation-warningBackground, #352a05); color: var(--vscode-inputValidation-warningForeground, inherit); border-bottom-color: var(--vscode-inputValidation-warningBorder, #b89500); }
  #diag.err { background: var(--vscode-inputValidation-errorBackground, #5a1d1d); color: var(--vscode-inputValidation-errorForeground, inherit); border-bottom-color: var(--vscode-inputValidation-errorBorder, #be1100); }
  /* 0.10.0 trust-floor — persistent (non-dismissible) read-only / fidelity notice strip. Distinct from #diag. */
  #formNotice { flex: 0 0 auto; display: flex; align-items: flex-start; gap: 8px; padding: 4px 8px; font-size: 12px;
    background: var(--vscode-inputValidation-infoBackground, #063b49); color: var(--vscode-inputValidation-infoForeground, inherit);
    border-bottom: 1px solid var(--vscode-inputValidation-infoBorder, #1c78c0); }
  #formNoticeIcon { flex: 0 0 auto; }
  /* Cap the always-on disclosure at two lines so a long notice can't eat the canvas on a narrow or high-DPI pane; the
     full text stays reachable via the element's title (hover) tooltip, set alongside its text in designer.js. */
  #formNoticeMsg { flex: 1; min-width: 0; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2;
    line-clamp: 2; overflow: hidden; }
  /* Collapsing keeps the disclosure ON SCREEN but out of the way: the strip shrinks to its icon, which still
     carries the full text as its tooltip and expands again on click. The notice is never removed — a form whose
     edits are resource-routed or whose preview is a stale build must not look like an ordinary one. */
  #formNoticeCollapse { flex: 0 0 auto; background: transparent; border: none; color: inherit; cursor: pointer;
    font-size: 11px; line-height: 1; padding: 0 4px; opacity: .75; }
  #formNoticeCollapse:hover { opacity: 1; }
  #formNotice.collapsed { padding: 2px 8px; cursor: pointer; }
  #formNotice.collapsed #formNoticeMsg { display: none; }
  #formNotice.collapsed #formNoticeCollapse { margin-left: auto; }
  #diagHead { display: flex; align-items: center; gap: 8px; padding: 4px 8px; }
  #diagIcon { flex: 0 0 auto; }
  #diagToggle { cursor: pointer; text-decoration: underline; color: var(--vscode-textLink-foreground, #4ea1ff); }
  #diagSpacer { flex: 1; }
  #diagDismiss { flex: 0 0 auto; background: transparent; border: none; color: inherit; cursor: pointer; font-size: 14px; line-height: 1; padding: 0 4px; opacity: .8; }
  #diagDismiss:hover { opacity: 1; }
  #diagList { margin: 0; padding: 0 8px 6px 8px; list-style: none; }
  #diagList li { padding: 2px 0 2px 18px; text-indent: -18px; white-space: pre-wrap; word-break: break-word; }
  #diagList li .diagTarget { display: inline-block; margin-right: 8px; padding: 0 4px; text-indent: 0;
    border: 1px solid currentColor; border-radius: 2px; opacity: .9; font-family: var(--vscode-editor-font-family, monospace); }
  #diagList li .diagCat { margin-right: 6px; opacity: .9; font-weight: 600; }
  #diagList li .diagDetail { opacity: .8; }
  #diagActions { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 8px 7px 8px; }
  #diagActions button { padding: 2px 7px; }
  #surfaceWrap { position: relative; box-shadow: 0 4px 24px rgba(0,0,0,.5); }
  #surface { display: block; image-rendering: pixelated; }
  #designerGrid { position: absolute; z-index: 1; pointer-events: none; display: none; box-sizing: border-box;
    overflow: hidden; background-image: radial-gradient(circle, rgba(30,30,30,.48) 1px, transparent 1px); background-position: 0 0; }
  #sel { position: absolute; z-index: 7; border: 1px solid #4ea1ff; box-shadow: 0 0 0 1px rgba(0,0,0,.5); pointer-events: none; display: none; }
  #sel .handle { position: absolute; width: 8px; height: 8px; background: #4ea1ff; border: 1px solid #fff; box-sizing: border-box; pointer-events: auto; }
  #sel .h-nw { left: -4px; top: -4px; cursor: nwse-resize; }
  #sel .h-n  { left: 50%; top: -4px; margin-left: -4px; cursor: ns-resize; }
  #sel .h-ne { right: -4px; top: -4px; cursor: nesw-resize; }
  #sel .h-w  { left: -4px; top: 50%; margin-top: -4px; cursor: ew-resize; }
  #sel .h-e  { right: -4px; top: 50%; margin-top: -4px; cursor: ew-resize; }
  #sel .h-sw { left: -4px; bottom: -4px; cursor: nesw-resize; }
  #sel .h-s  { left: 50%; bottom: -4px; margin-left: -4px; cursor: ns-resize; }
  #sel .h-se { right: -4px; bottom: -4px; cursor: nwse-resize; }
  /* Lock Controls: a locked control shows a muted dashed selection box with no grab handles + a lock glyph */
  #sel.locked { border: 1px dashed #b0b0b0; }
  .lockbadge { position: absolute; z-index: 8; font-size: 11px; line-height: 13px; padding: 0 1px; pointer-events: none;
    background: rgba(43,43,43,.75); border-radius: 2px; user-select: none; }
  /* multi-select: outline boxes for the non-primary selected controls */
  .selsec { position: absolute; z-index: 7; border: 1px dashed #4ea1ff; box-shadow: 0 0 0 1px rgba(0,0,0,.4); box-sizing: border-box; pointer-events: none; }
  /* snaplines (alignment guides while dragging) */
  .snapguide { position: absolute; pointer-events: none; z-index: 6; }
  .snapguide.vert { border-left: 1px solid #ff4d9d; }
  .snapguide.horz { border-top: 1px solid #ff4d9d; }
  /* equal-spacing guides — distinct (teal, dashed) from the magenta alignment snaplines */
  .snapguide.equal.vert { border-left: 1px dashed #25c2c2; }
  .snapguide.equal.horz { border-top: 1px dashed #25c2c2; }
  /* anchor tethers (Phase 2): dashed orange lines from a selected control's anchored edges to the parent */
  .anchortether { position: absolute; pointer-events: none; z-index: 6; }
  .anchortether.vert { border-left: 1px dashed #ffa033; }
  .anchortether.horz { border-top: 1px dashed #ffa033; }
  /* persistent dashed boundary around container controls (a control that holds children), VS-style — sits BELOW
     the selection boxes so it hints the layout region without obscuring the active selection */
  .containeroutline { position: absolute; box-sizing: border-box; pointer-events: none; z-index: 2; border: 1px dashed rgba(160,160,160,.55); }
  /* hover pre-selection hint — a thin outline over the control a click would select (sits above container
     outlines but below the active selection boxes so it never masks the current selection) */
  .hoverhint { position: absolute; box-sizing: border-box; pointer-events: none; z-index: 3; border: 1px solid rgba(78,161,255,.55); background: rgba(78,161,255,.06); }
  /* S093 hosted ControlDesigner adorner: the descriptor rectangle is visible on the selected control; hover first
     enters a pending state and becomes solid only after the fresh engine graph confirms the point. */
  .designeradorner { position: absolute; box-sizing: border-box; z-index: 6; pointer-events: auto; cursor: help;
    align-items: center; justify-content: flex-end; padding: 0 3px; overflow: hidden; color: rgba(78,161,255,.95);
    border: 1px dashed rgba(78,161,255,.85); background: rgba(78,161,255,.06); font-size: 8px; line-height: 1; }
  .designeradorner.pending { border-style: dotted; background: rgba(255,186,84,.10); color: rgba(255,186,84,.95); }
  .designeradorner.hit { border-style: solid; background: rgba(78,161,255,.18); box-shadow: inset 0 0 0 1px rgba(255,255,255,.22); }
  .toolboxdroptarget { position: absolute; box-sizing: border-box; pointer-events: none; z-index: 8; border: 2px solid var(--vscode-focusBorder, #4ea1ff); background: rgba(78,161,255,.14); box-shadow: inset 0 0 0 1px rgba(255,255,255,.35); }
  .toolboxdroplabel { position: absolute; left: 4px; top: 4px; max-width: calc(100% - 8px); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 2px 5px; border-radius: 2px; color: var(--vscode-badge-foreground, #fff); background: var(--vscode-badge-background, #3a78b5); font: 11px var(--vscode-font-family); }
  /* on-canvas "Type Here" add-slot at the end of a ToolStrip/MenuStrip/StatusStrip — a dashed placeholder cell that
     hints where a new item lands; clicking it opens the inline add-editor (.slotedit) */
  .typehereslot { position: absolute; box-sizing: border-box; pointer-events: auto; cursor: text; z-index: 4; border: 1px dashed rgba(78,161,255,.75);
    background: rgba(78,161,255,.09); color: rgba(150,195,255,.95); font-size: 9px; line-height: 1; display: flex;
    align-items: center; justify-content: center; overflow: hidden; white-space: nowrap; padding: 0 2px; }
  .typehereslot:hover { background: rgba(78,161,255,.18); }
  /* on-canvas selected strip item: a solid highlight box over the clicked top-level ToolStrip/MenuStrip item
     marking the Delete / F2-rename target. Sits above the container/hover outlines but below the inline editor; never
     intercepts pointer events so a second click / double-click still reaches the item. */
  .stripitemsel { position: absolute; box-sizing: border-box; pointer-events: none; z-index: 5; border: 1px solid rgba(78,161,255,.95);
    background: rgba(78,161,255,.12); }
  /* deterministic insertion/reparent feedback while dragging an existing ToolStrip/MenuStrip item. */
  .stripdropindicator { position: absolute; box-sizing: border-box; pointer-events: none; z-index: 8; border-color: rgba(255,186,84,.95);
    background: rgba(255,186,84,.12); box-shadow: 0 0 0 1px rgba(0,0,0,.35); }
  .stripdropindicator.vline { border-left: 2px solid rgba(255,186,84,.95); }
  .stripdropindicator.hline { border-top: 2px solid rgba(255,186,84,.95); }
  .stripdropindicator.append { border: 1px dashed rgba(255,186,84,.95); }
  /* synthetic submenu flyout: a client-side dropdown for a top-level menu item's nested DropDownItems (a closed dropdown
     isn't painted on the surface). Clicking a row loads that nested item's Properties. One box per open submenu level. */
  .stripflyout { position: absolute; box-sizing: border-box; z-index: 6; padding: 2px 0; font-size: 11px; white-space: nowrap;
    background: var(--vscode-menu-background, #252526); color: var(--vscode-menu-foreground, #cccccc);
    border: 1px solid var(--vscode-menu-border, rgba(78,161,255,.5)); box-shadow: 0 2px 8px rgba(0,0,0,.5); }
  .stripflyout .stripflyoutrow { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 0 10px;
    cursor: pointer; overflow: hidden; }
  .stripflyout .stripflyoutrow:not(.inert):hover { background: var(--vscode-menu-selectionBackground, rgba(78,161,255,.35));
    color: var(--vscode-menu-selectionForeground, #ffffff); }
  /* a dead row — an item with no field id AND no children (a hand-authored Items.Add("Foo")): can't select/rename/delete
     or navigate, so render it non-interactive (dimmed, no pointer/hover) rather than a live-looking-but-dead click */
  .stripflyout .stripflyoutrow.inert { cursor: default; opacity: .5; }
  .stripflyout .stripflyoutrow.sel { background: rgba(78,161,255,.28); outline: 1px solid rgba(78,161,255,.9); outline-offset: -1px; }
  .stripflyout .stripflyoutcap { overflow: hidden; text-overflow: ellipsis; }
  .stripflyout .stripflyoutarrow { opacity: .8; font-size: 9px; }
  .stripflyout .stripflyoutsep { height: 0; border-top: 1px solid var(--vscode-menu-separatorBackground, #454545); margin: 3px 8px; }
  /* trailing "Type Here" add-slot inside a submenu level: clicking it opens the inline add-editor to append a new item
     to that submenu's DropDownItems (the nested analogue of the top-level .typehereslot). A ghosted italic row. */
  .stripflyout .stripflyouttypehere { display: flex; align-items: center; gap: 10px; padding: 0 10px; cursor: text;
    color: rgba(150,195,255,.9); font-style: italic; opacity: .8; border-top: 1px dashed var(--vscode-menu-separatorBackground, #454545); }
  .stripflyout .stripflyouttypehere:hover { background: var(--vscode-menu-selectionBackground, rgba(78,161,255,.25)); opacity: 1; }
  /* inline "Type Here" add-editor: a small floating popup (item-type <select> + text <input>) anchored at the clicked
     add-slot. Enter commits (posts stripAdd), Escape / click-away cancels. Sits above every canvas overlay. */
  .slotedit { position: absolute; z-index: 7; display: flex; gap: 3px; align-items: center; padding: 2px 3px;
    background: var(--vscode-editor-background, #1e1e1e); border: 1px solid rgba(78,161,255,.9); border-radius: 3px;
    box-shadow: 0 2px 6px rgba(0,0,0,.45); }
  .slotedit select.slotEditType { font-size: 11px; color: var(--vscode-input-foreground); background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent); }
  .slotedit input.slotEditInput { font-size: 11px; min-width: 96px; color: var(--vscode-input-foreground);
    background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); padding: 1px 3px; }
  /* small visual separator between toolbar button groups */
  .tbsep { display: inline-block; width: 1px; align-self: stretch; margin: 1px 4px; background: var(--vscode-panel-border, #444); }
  /* rubber-band selection rectangle */
  .rubberband { position: absolute; border: 1px dashed #4ea1ff; background: rgba(78,161,255,.12); pointer-events: none; z-index: 6; box-sizing: border-box; }
  .rubberband.toolboxplace { border-style: solid; background: rgba(78,161,255,.18); }
  #status { padding: 4px 8px; min-height: 1em; color: var(--vscode-descriptionForeground); border-top: 1px solid var(--vscode-panel-border, #333); }
  /* component tray — non-visual components below the surface */
  #tray { flex: 0 0 auto; display: flex; flex-wrap: wrap; gap: 4px; padding: 4px 8px; border-top: 1px solid var(--vscode-panel-border, #333); background: var(--vscode-editorWidget-background, #252526); max-height: 88px; overflow: auto; }
  .trayItem { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; padding: 3px 8px; border-radius: 2px; cursor: pointer; user-select: none; white-space: nowrap;
    background: var(--vscode-button-secondaryBackground, #3a3d41); color: var(--vscode-button-secondaryForeground, #fff); }
  .trayItem:hover { background: var(--vscode-button-secondaryHoverBackground, #45494e); }
  .trayItem.sel { outline: 1px solid #4ea1ff; }
  .trayIcon { width: 16px; height: 16px; object-fit: contain; image-rendering: auto; }
  .trayRename { width: 120px; color: var(--vscode-input-foreground); background: var(--vscode-input-background);
    border: 1px solid var(--vscode-focusBorder, #007fd4); border-radius: 2px; padding: 1px 3px; font-size: 12px; }
  /* pixel ruler around the form surface (toggled by the toolbar button) */
  .ruler { position: absolute; background: var(--vscode-editorWidget-background, #252526); z-index: 8; pointer-events: none; overflow: hidden; color: var(--vscode-descriptionForeground, #999); }
  .rulerH { top: -22px; left: 0; height: 18px; border-bottom: 1px solid var(--vscode-panel-border, #555); }
  .rulerV { left: -28px; top: 0; width: 24px; border-right: 1px solid var(--vscode-panel-border, #555); }
  .ruler .tick { position: absolute; background: var(--vscode-descriptionForeground, #888); }
  .rulerH .tick { bottom: 0; width: 1px; height: 4px; }
  .rulerH .tick.maj { height: 9px; }
  .rulerV .tick { right: 0; height: 1px; width: 4px; }
  .rulerV .tick.maj { width: 9px; }
  .ruler .lab { position: absolute; font-size: 8px; line-height: 1; }
  .rulerH .lab { top: 1px; }
  .rulerV .lab { left: 1px; }
  /* object-bounds markers on the rulers: a highlighted band spanning the selected/dragging control's extent,
     with dashed edges at its boundaries — so the ruler shows where the object is (and follows it while moving) */
  .rulerMark { position: absolute; z-index: 9; pointer-events: none; box-sizing: border-box; background: rgba(78, 161, 255, .20); }
  .rulerMarkH { top: -22px; height: 18px; border-left: 1px dashed var(--vscode-focusBorder, #4ea1ff); border-right: 1px dashed var(--vscode-focusBorder, #4ea1ff); }
  .rulerMarkV { left: -28px; width: 24px; border-top: 1px dashed var(--vscode-focusBorder, #4ea1ff); border-bottom: 1px dashed var(--vscode-focusBorder, #4ea1ff); }
  /* right-click context menu (HTML; native VS Code menus aren't reachable inside a webview) */
  .ctxmenu { display: none; position: fixed; z-index: 50; min-width: 200px; padding: 4px 0; background: var(--vscode-menu-background, #252526);
    color: var(--vscode-menu-foreground, #ccc); border: 1px solid var(--vscode-menu-border, #454545); border-radius: 4px; box-shadow: 0 2px 8px rgba(0,0,0,.4); font-size: 12px; user-select: none; }
  .ctxmenu.open { display: block; }
  .ctxmenu .mi { padding: 4px 22px 4px 14px; cursor: pointer; white-space: nowrap; display: flex; justify-content: space-between; gap: 18px; }
  .ctxmenu .mi:hover { background: var(--vscode-menu-selectionBackground, #04395e); color: var(--vscode-menu-selectionForeground, #fff); }
  .ctxmenu .mi.disabled { opacity: .4; pointer-events: none; }
  .ctxmenu .mi .acc { color: var(--vscode-descriptionForeground); }
  .ctxmenu .mi:hover .acc { color: inherit; }
  .ctxmenu .sep { height: 1px; margin: 4px 0; background: var(--vscode-menu-separatorBackground, #454545); }
  /* on-canvas smart-tag (VS/DevExpress-style): a chevron glyph at the selected control's top-right corner that
     opens the Tasks flyout — the point being it lives ON THE CANVAS, not in the property grid */
  .smarttag { position: absolute; width: 15px; height: 15px; box-sizing: border-box; z-index: 8; cursor: pointer;
    background: #fff; color: #1e1e1e; border: 1px solid #4ea1ff; border-radius: 2px; font-size: 10px; line-height: 13px;
    text-align: center; pointer-events: auto; box-shadow: 0 1px 3px rgba(0,0,0,.55); display: none; }
  .smarttag:hover { background: #d7e9ff; }
  .taskfly { position: fixed; z-index: 51; min-width: 232px; max-width: 340px; font-size: 12px;
    background: var(--vscode-menu-background, #252526); color: var(--vscode-menu-foreground, #ccc);
    border: 1px solid var(--vscode-menu-border, #454545); border-radius: 4px; box-shadow: 0 3px 12px rgba(0,0,0,.5); user-select: none; }
  .taskfly .tfTitle { padding: 6px 10px; font-weight: 600; border-bottom: 1px solid var(--vscode-menu-separatorBackground, #454545);
    background: var(--vscode-sideBarSectionHeader-background, #2d2d2d); }
  .taskfly .tfRow { display: flex; align-items: center; gap: 8px; padding: 3px 10px; }
  .taskfly .tfLabel { color: var(--vscode-descriptionForeground); white-space: nowrap; min-width: 96px; }
  .taskfly .tfRow.tfCheck { gap: 6px; cursor: pointer; }
  .taskfly .tfRow.tfCheck .tfLabel { color: var(--vscode-menu-foreground, #ccc); min-width: 0; }
  .taskfly select, .taskfly input.tfText { flex: 1; min-width: 0; font: inherit; padding: 1px 3px; border-radius: 2px;
    background: var(--vscode-input-background, #3c3c3c); color: var(--vscode-input-foreground, #ccc); border: 1px solid var(--vscode-input-border, #555); }
  .taskfly .tfNote { padding: 4px 10px; color: var(--vscode-descriptionForeground); font-style: italic; }
     /* vendor-declared verbs (DevExpress "Add Tab Page"…): command rows, above the property rows. A verb we have no
     source-first equivalent for stays visible but inert — the menu is the vendor's, the actions are ours. */
  .taskfly .tfVerb { display: block; padding: 4px 10px; cursor: pointer; color: var(--vscode-menu-foreground, #ccc); }
  .taskfly .tfVerb:hover { background: var(--vscode-menu-selectionBackground, #04395e); color: #fff; }
  .taskfly .tfVerb.tfDisabled { color: var(--vscode-disabledForeground, #888); cursor: default; }
  .taskfly .tfVerb.tfDisabled:hover { background: none; color: var(--vscode-disabledForeground, #888); }
  .taskfly .tfVerbs { padding: 3px 0; }
  .taskfly .tfVerbs + .tfProps { border-top: 1px solid var(--vscode-menu-separatorBackground, #454545); padding-top: 3px; }
  .taskfly .tfLinks { border-top: 1px solid var(--vscode-menu-separatorBackground, #454545); padding: 3px 0; margin-top: 3px; }
  .taskfly .tfLink { display: block; padding: 4px 10px; cursor: pointer; color: var(--vscode-textLink-foreground, #4ea1ff); }
  .taskfly .tfLink:hover { background: var(--vscode-menu-selectionBackground, #04395e); color: #fff; }
</style></head>
<body>
  <div id="formNotice" style="display:none"><span id="formNoticeIcon">🔒</span><span id="formNoticeMsg"></span><button id="formNoticeCollapse" type="button" title=""></button></div>
  <div id="diag" style="display:none">
    <div id="diagHead"><span id="diagIcon">⚠</span><span id="diagMsg"></span><span id="diagToggle"></span><span id="diagSpacer"></span><button id="diagDismiss" title="${t('designer.diag.dismiss')}">×</button></div>
    <ul id="diagList" style="display:none"></ul>
    <div id="diagActions">
      <button id="diagRetry">${t('designer.diag.retry')}</button>
      <button id="diagRebuild">${t('designer.diag.rebuild')}</button>
      <button id="diagChooseAssembly">${t('designer.diag.chooseAssembly')}</button>
      <button id="diagCopy">${t('designer.diag.copy')}</button>
    </div>
  </div>
  <div id="stage"><div id="overlay">${t('designer.overlay.loading')}<noscript>${t('designer.overlay.noscript')}</noscript></div><div id="surfaceWrap"><canvas id="surface" width="1" height="1"></canvas><div id="designerGrid"></div><div id="sel"></div></div></div>
  <div id="tray" style="display:none"></div>
  <div id="status"></div>
  <div id="toolbar">
    <span id="selName" class="sel">—</span>
    <span class="spacer"></span>
    <span id="zoom" class="zoomgrp">
      <button id="zoomOut" title="${t('designer.zoom.out')}">−</button>
      <button id="zoomLabel" title="${t('designer.zoom.reset')}">100%</button>
      <button id="zoomIn" title="${t('designer.zoom.in')}">+</button>
      <button id="zoomFit" title="${t('designer.zoom.fit')}">${t('designer.zoom.fitBtn')}</button>
    </span>
    <span id="align" class="zoomgrp" style="display:none" title="${t('designer.align.group')}">
      <button id="alignLeft" title="${t('designer.align.left')}">⊢</button>
      <button id="alignRight" title="${t('designer.align.right')}">⊣</button>
      <button id="alignTop" title="${t('designer.align.top')}">⊤</button>
      <button id="alignBottom" title="${t('designer.align.bottom')}">⊥</button>
      <button id="alignCenterH" title="${t('designer.align.centerH')}">↔</button>
      <button id="alignCenterV" title="${t('designer.align.centerV')}">↕</button>
      <span class="tbsep"></span>
      <button id="distH" title="${t('designer.distribute.h')}">⇆</button>
      <button id="distV" title="${t('designer.distribute.v')}">⇅</button>
      <button id="spaceHInc" title="${t('designer.spacing.hIncrease')}">H+</button>
      <button id="spaceHDec" title="${t('designer.spacing.hDecrease')}">H−</button>
      <button id="spaceHRemove" title="${t('designer.spacing.hRemove')}">H0</button>
      <button id="spaceVInc" title="${t('designer.spacing.vIncrease')}">V+</button>
      <button id="spaceVDec" title="${t('designer.spacing.vDecrease')}">V−</button>
      <button id="spaceVRemove" title="${t('designer.spacing.vRemove')}">V0</button>
      <span class="tbsep"></span>
      <button id="sameW" title="${t('designer.same.width')}">=W</button>
      <button id="sameH" title="${t('designer.same.height')}">=H</button>
      <button id="sameWH" title="${t('designer.same.size')}">=□</button>
    </span>
    <span id="centerForm" class="zoomgrp" style="display:none" title="${t('designer.center.group')}">
      <button id="centerFormH" title="${t('designer.center.h')}">[↔]</button>
      <button id="centerFormV" title="${t('designer.center.v')}">[↕]</button>
    </span>
    <button id="tabOrder" title="${t('designer.tabOrder.tip')}">${t('designer.tabOrder.btn')}</button>
    <button id="rulerToggle" title="${t('designer.ruler.tip')}">${t('designer.ruler.show')}</button>
    <span id="dirty" class="dirty" title="${t('designer.dirty.tip')}"></span>
  </div>
  <div id="ctxMenu" class="ctxmenu"></div>
${injectL10nScript(nonce)}
<script nonce="${nonce}" src="${scriptUri}"></script>
</body></html>`;
}

/**
* The single dockable designer panel: full-size Properties, Outline, Toolbox, and Data Sources panes switched by a
* tab strip at the BOTTOM of the view.
*/
function panelHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = randomBytes(16).toString('hex');
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'panel.js'));
  const codiconUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'codicon.ttf'));
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
${cspMeta(webview, nonce)}
<style nonce="${nonce}">
  @font-face { font-family: "codicon"; src: url("${codiconUri}") format("truetype"); }
  .codicon { font-family: "codicon"; font-size: 15px; line-height: 1; display: inline-block; }
  .ico-cat::before { content: "\\eb86"; }
  .ico-alpha::before { content: "\\eab1"; }
  .ico-props::before { content: "\\eb65"; }
  .ico-events::before { content: "\\ea86"; }
  /* VS Code injects a default body padding (0 20px) into every webview it hosts, so a surface that resets only the
     margin still renders inside a frame of dead space — most visible in the narrow side panel, where it comes
     straight out of the value column. Extensions that look edge-to-edge are the ones that zero this explicitly. */
  html, body { height: 100%; margin: 0; padding: 0; }
  body { font: 12px var(--vscode-font-family, sans-serif); color: var(--vscode-foreground); display: flex; flex-direction: column; }
  /* the full-size panes share #content; the bottom tab strip switches between them */
  #content { flex: 1; min-height: 0; position: relative; }
  .pane { position: absolute; inset: 0; display: flex; flex-direction: column; }
  .paneEmpty { padding: 10px 12px; color: var(--vscode-descriptionForeground); }
  #bottomTabs { flex: 0 0 auto; display: flex; border-top: 1px solid var(--vscode-panel-border, #333); }
  /* min-width:0 is load-bearing: a flex item defaults to min-width:auto, which floors it at min-content, so these
     four labels refuse to shrink. Below that floor they wrap to two lines (English "Data Sources" does this at any
     panel under ~360px) and, once their sum exceeds the panel, the document itself overflows sideways — which grows
     a root scrollbar and, because html/body are height:100%, leaves a dead strip under the tab row that reads as
     bottom padding. Ellipsis instead; the full label stays available as a tooltip. */
  #bottomTabs button { flex: 1 1 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; border: none; border-right: 1px solid var(--vscode-panel-border, #333); background: transparent; color: var(--vscode-descriptionForeground); padding: 5px 8px; cursor: pointer; font: inherit; }
  #bottomTabs button:last-child { border-right: none; }
  #bottomTabs button:hover { background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,.08)); }
  #bottomTabs button.active { color: var(--vscode-foreground); background: var(--vscode-tab-activeBackground, rgba(255,255,255,.10)); box-shadow: inset 0 2px 0 var(--vscode-focusBorder, #4ea1ff); }
  /* properties pane */
  #propsBody { display: flex; flex-direction: column; height: 100%; }
  #sideHeader { flex: 0 0 auto; padding: 8px 8px 4px; background: var(--vscode-sideBar-background, var(--vscode-editor-background, #1e1e1e)); border-bottom: 1px solid var(--vscode-panel-border, #333); }
  #grid { flex: 1; min-height: 0; overflow: auto; }
  /* The grid runs edge to edge, like VS Code's own tree views and the Visual Studio property window: the row's own
     cell padding supplies the text inset. An extra container inset cost 16px of a panel that is often ~250px wide,
     and it came straight out of the value column, which is exactly where values truncate. */
  #props, #events { padding: 0; }
  /* VS-style description pane pinned to the bottom of the Properties view: bold name + summary of the active row */
  #propDesc { flex: 0 0 auto; border-top: 1px solid var(--vscode-panel-border, #333); padding: 6px 8px; min-height: 32px;
              max-height: 30%; overflow: auto; background: var(--vscode-sideBar-background, var(--vscode-editor-background, #1e1e1e)); }
  #propDesc .pdName { font-weight: bold; color: var(--vscode-foreground); }
  #propDesc .pdText { color: var(--vscode-descriptionForeground); font-size: 11px; margin-top: 2px; white-space: normal; }
  button { font: inherit; background: var(--vscode-button-secondaryBackground, #3a3d41); color: var(--vscode-button-secondaryForeground, #fff); border: none; padding: 2px 8px; cursor: pointer; border-radius: 2px; }
  select { width: 100%; margin-bottom: 8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, #555); padding: 3px; }
  #tabs { display: flex; gap: 2px; align-items: center; margin-bottom: 6px; }
  #tabs button { flex: 0 0 auto; padding: 3px 5px; border-radius: 3px; border: 1px solid transparent; background: transparent; color: var(--vscode-icon-foreground, #c5c5c5); display: inline-flex; align-items: center; }
  #tabs button:hover { background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,.10)); }
  #tabs button.active { background: var(--vscode-toolbar-activeBackground, rgba(255,255,255,.16)); border-color: var(--vscode-focusBorder, #4ea1ff); color: var(--vscode-foreground); }
  #tabs .tabgap { flex: 0 0 auto; width: 1px; align-self: stretch; margin: 1px 5px; background: var(--vscode-panel-border, #444); }
  #search { width: 100%; margin-bottom: 0; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, #555); padding: 3px; }
  /* VS-style property grid: 2 columns, a full-height draggable divider, grid lines, row hover, in-cell editors */
  table { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 12px; }
  td { padding: 1px 5px; border-bottom: 1px solid var(--vscode-panel-border, #2b2b2b); vertical-align: middle; height: 20px; }
  tr:hover td { background: var(--vscode-list-hoverBackground, #2a2d2e); }
  tr.sel td { background: var(--vscode-list-inactiveSelectionBackground, rgba(255,255,255,.07)); }
  td.name { position: relative; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
            border-right: 1px solid var(--vscode-panel-border, #2b2b2b); color: var(--vscode-foreground); }
  td.name.set { font-weight: bold; }
  td.name.sub { padding-left: 22px; font-weight: normal; color: var(--vscode-descriptionForeground); }
  span.tw { cursor: pointer; user-select: none; color: var(--vscode-descriptionForeground); margin-right: 2px; }
  /* the column divider: a full-height grab strip sitting on the name/value border (stacked cells form one line) */
  .colsplit { position: absolute; top: 0; right: -4px; width: 8px; height: 100%; cursor: col-resize; z-index: 3; }
  .colsplit:hover { background: var(--vscode-focusBorder, #4ea1ff); opacity: .6; }
  td.ro { color: var(--vscode-descriptionForeground, #999); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding-left: 5px; }
  td.val { padding: 0; }
  /* in-cell editors: borderless until hover/focus (VS feel), fill the value cell edge-to-edge */
  td.val input, td.val select { width: 100%; box-sizing: border-box; background: transparent; color: var(--vscode-foreground);
            border: 1px solid transparent; padding: 1px 4px; border-radius: 0; height: 20px; }
  td.val input:hover, td.val select:hover { background: var(--vscode-input-background); }
  td.val input:focus, td.val select:focus { background: var(--vscode-input-background); border-color: var(--vscode-focusBorder, #4ea1ff); outline: none; }
  input { width: 100%; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, #555); }
  td select { width: 100%; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, #555); }
  .evtwrap { display: block; }
  input.evt { margin-bottom: 0; padding: 1px 3px; width: 100%; box-sizing: border-box; }
  /* Anchor glyph editor (Phase 2): a frame with 4 toggle bars tethering the inner box to each edge */
  .anchorEd { padding: 3px 4px; }
  .anchorBox { position: relative; width: 48px; height: 34px; border: 1px solid var(--vscode-panel-border, #555); background: var(--vscode-input-background); }
  .aCenter { position: absolute; left: 50%; top: 50%; width: 14px; height: 10px; transform: translate(-50%, -50%); background: var(--vscode-descriptionForeground, #888); }
  .aBar { position: absolute; background: var(--vscode-panel-border, #777); cursor: pointer; }
  .aBar:hover { background: var(--vscode-list-hoverBackground, #5a5d5e); }
  .aBar.on { background: var(--vscode-focusBorder, #4ea1ff); }
  .aTop { left: 50%; top: 1px; width: 4px; height: 9px; transform: translateX(-50%); }
  .aBottom { left: 50%; bottom: 1px; width: 4px; height: 9px; transform: translateX(-50%); }
  .aLeft { top: 50%; left: 1px; height: 4px; width: 11px; transform: translateY(-50%); }
  .aRight { top: 50%; right: 1px; height: 4px; width: 11px; transform: translateY(-50%); }
  /* Dock zone picker (Phase 2): 4 edge zones + a center Fill, plus an explicit None */
  .dockEd { padding: 3px 4px; display: flex; align-items: center; gap: 6px; }
  .dockBox { position: relative; width: 40px; height: 40px; border: 1px solid var(--vscode-panel-border, #555); background: var(--vscode-input-background); flex: 0 0 auto; }
  .dZone { position: absolute; background: var(--vscode-panel-border, #777); cursor: pointer; }
  .dZone:hover { background: var(--vscode-list-hoverBackground, #5a5d5e); }
  .dZone.on { background: var(--vscode-focusBorder, #4ea1ff); }
  .dTop { top: 1px; left: 9px; right: 9px; height: 8px; }
  .dBottom { bottom: 1px; left: 9px; right: 9px; height: 8px; }
  .dLeft { left: 1px; top: 9px; bottom: 9px; width: 7px; }
  .dRight { right: 1px; top: 9px; bottom: 9px; width: 7px; }
  .dFill { left: 9px; right: 9px; top: 10px; bottom: 10px; }
  .dNone { padding: 1px 6px; font-size: 11px; flex: 0 0 auto; }
  .dNone.on { background: var(--vscode-focusBorder, #4ea1ff); color: #fff; }
  /* Color editor: swatch + free-text input + dropdown button (opens the tabbed palette popup) */
  .colorEd { display: flex; align-items: center; height: 20px; }
  .colorEd .colorInp { flex: 1 1 auto; min-width: 0; background: transparent; color: var(--vscode-foreground);
    border: 1px solid transparent; padding: 1px 4px; height: 20px; box-sizing: border-box; }
  .colorEd .colorInp:hover { background: var(--vscode-input-background); }
  .colorEd .colorInp:focus { background: var(--vscode-input-background); border-color: var(--vscode-focusBorder, #4ea1ff); outline: none; }
  .swatch { flex: 0 0 auto; width: 13px; height: 13px; margin: 0 4px; border: 1px solid var(--vscode-panel-border, #555); box-sizing: border-box; }
  .swatch.none { background: repeating-conic-gradient(#888 0% 25%, #ccc 0% 50%) 50% / 8px 8px; }
  /* dropdown button shared by the Color + Flags editors */
  .ddBtn { flex: 0 0 auto; width: 16px; text-align: center; cursor: pointer; color: var(--vscode-descriptionForeground);
    user-select: none; font-size: 10px; line-height: 20px; }
  .ddBtn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,.12)); color: var(--vscode-foreground); }
  /* Flags-enum editor: read-only summary + dropdown of member checkboxes */
  .flagsEd { display: flex; align-items: center; height: 20px; }
  .flagsEd .flagsInp { flex: 1 1 auto; min-width: 0; background: transparent; color: var(--vscode-foreground);
    border: 1px solid transparent; padding: 1px 4px; height: 20px; box-sizing: border-box; cursor: default; }
  /* Image/Icon editor: preview swatch + label + Import…/(none) buttons (resx-backed) */
  .imageEd { display: flex; align-items: center; height: 20px; gap: 4px; }
  .imgSwatch { flex: 0 0 auto; width: 16px; height: 16px; border: 1px solid var(--vscode-panel-border, #555);
    box-sizing: border-box; display: flex; align-items: center; justify-content: center; overflow: hidden; }
  .imgSwatch.none { background: repeating-conic-gradient(#888 0% 25%, #ccc 0% 50%) 50% / 8px 8px; }
  .imgThumb { max-width: 16px; max-height: 16px; display: block; }
  .imgLabel { flex: 1 1 auto; min-width: 0; color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .imgBtn { flex: 0 0 auto; background: transparent; color: var(--vscode-textLink-foreground, #4ea1ff); border: none;
    padding: 0 4px; cursor: pointer; font-size: 11px; line-height: 20px; }
  .imgBtn:hover { text-decoration: underline; }
  /* string-collection editor: "(Collection)" label + "…" button in the grid cell, and its popup (VS String Collection Editor) */
  .collectionEd { display: flex; align-items: center; height: 20px; gap: 4px; }
  .collectionLabel { flex: 1 1 auto; min-width: 0; color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .collectionBtn { flex: 0 0 auto; width: 22px; background: transparent; color: var(--vscode-foreground); cursor: pointer;
    border: 1px solid var(--vscode-widget-border, #454545); border-radius: 3px; line-height: 16px; padding: 0; }
  .collectionBtn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,.12)); }
  .propPopup .collectionTitle { padding: 5px 8px; font-weight: 600; border-bottom: 1px solid var(--vscode-widget-border, #454545); }
  .propPopup .collectionNote { padding: 6px 8px; max-width: 260px; color: var(--vscode-descriptionForeground); }
  .collectionTa { display: block; margin: 6px; min-width: 240px; box-sizing: border-box; resize: both; font-family: var(--vscode-editor-font-family, monospace);
    font-size: 12px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, #3c3c3c); }
  .collectionBar { display: flex; justify-content: flex-end; gap: 6px; padding: 0 6px 6px; }
  .collectionBar button { padding: 2px 12px; cursor: pointer; color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    background: var(--vscode-button-secondaryBackground, rgba(255,255,255,.08)); border: 1px solid var(--vscode-widget-border, #454545); border-radius: 3px; }
  .collectionBar .collectionOk { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border-color: var(--vscode-button-background); }
  .collectionBar button:hover { filter: brightness(1.15); }
  /* typed collection editor (ListView.Columns): a small grid of rows with reorder / remove */
  .columnsPop .columnsList { margin: 6px; max-height: 260px; overflow-y: auto; min-width: 300px; }
  .columnsPop .columnsEmpty { padding: 8px; color: var(--vscode-descriptionForeground); }
  .columnsRow { display: flex; align-items: center; gap: 4px; margin-bottom: 4px; }
  .columnsRow .colText { flex: 1 1 auto; min-width: 60px; }
  .columnsRow .colWidth { flex: 0 0 58px; width: 58px; }
  .columnsRow .colAlign { flex: 0 0 auto; }
  .columnsRow input, .columnsRow select { color: var(--vscode-input-foreground); background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, #3c3c3c); border-radius: 2px; padding: 1px 3px; font-size: 12px; box-sizing: border-box; }
  .colMini { flex: 0 0 auto; width: 20px; padding: 0; line-height: 16px; cursor: pointer; color: var(--vscode-foreground);
    background: transparent; border: 1px solid var(--vscode-widget-border, #454545); border-radius: 3px; }
  .colMini:hover { background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,.12)); }
  .colMini:disabled { opacity: .4; cursor: default; }
  .colDel:hover { color: var(--vscode-errorForeground, #f14c4c); }
  .columnsAdd { margin: 0 6px 6px; padding: 2px 10px; cursor: pointer; color: var(--vscode-foreground);
    background: var(--vscode-button-secondaryBackground, rgba(255,255,255,.08)); border: 1px solid var(--vscode-widget-border, #454545); border-radius: 3px; }
  .columnsAdd:hover { filter: brightness(1.15); }
  .tabPagesPop .columnsList { min-width: 260px; }
  .tabPageName { flex: 1 1 auto; min-width: 80px; padding: 2px 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .gridColumnsPop .columnsList { min-width: 560px; }
  .gridColumnCard { padding: 4px; margin-bottom: 5px; border: 1px solid var(--vscode-widget-border, #454545); border-radius: 3px; }
  .gridColumnCard .columnsRow:last-child { margin-bottom: 0; }
  .gridStyleRow .gridFmt, .gridStyleRow .gridNull { flex: 0 1 90px; min-width: 65px; }
  .colChkLbl { flex: 0 0 auto; display: inline-flex; align-items: center; gap: 2px; font-size: 11px; color: var(--vscode-descriptionForeground); }
  .colChk { margin: 0; }
  .bindingsPop .bindingList { margin: 6px; max-height: 310px; min-width: 390px; overflow-y: auto; }
  .bindingRow { padding: 5px; margin-bottom: 5px; border: 1px solid var(--vscode-widget-border, #454545); border-radius: 3px; }
  .bindingLine { display: flex; align-items: center; gap: 5px; margin-bottom: 4px; }
  .bindingLine:last-child { margin-bottom: 0; }
  .bindingLine input[type="text"], .bindingLine select { flex: 1 1 0; min-width: 80px; color: var(--vscode-input-foreground);
    background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, #3c3c3c);
    border-radius: 2px; padding: 2px 4px; font-size: 12px; box-sizing: border-box; }
  .bindingCheck { flex: 0 0 auto; display: inline-flex; align-items: center; gap: 3px; color: var(--vscode-descriptionForeground); }
  .bindingCheck input { margin: 0; }
  .dataSourceBody { display: flex; gap: 5px; min-width: 330px; padding: 7px; }
  .dataSourceBody select, .dataSourceBody input { flex: 1 1 0; min-width: 90px; color: var(--vscode-input-foreground);
    background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, #3c3c3c);
    border-radius: 2px; padding: 2px 4px; font-size: 12px; box-sizing: border-box; }
  /* floating popup surface (color picker / flags checkboxes) — on <body>, position:fixed so #grid can't clip it */
  .propPopup { position: fixed; z-index: 70; background: var(--vscode-editorWidget-background, #252526); color: var(--vscode-foreground);
    border: 1px solid var(--vscode-widget-border, #454545); border-radius: 4px; box-shadow: 0 4px 16px rgba(0,0,0,.5); font-size: 12px; }
  /* smart-tag "Tasks" flyout: the button bar above the grid + the popup's title/note/all-properties link */
  .tasksbar { padding: 4px 4px 2px; }
  .tasksbtn { width: 100%; text-align: left; padding: 3px 8px; cursor: pointer; font-size: 12px; border-radius: 3px;
    color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,.06));
    border: 1px solid var(--vscode-widget-border, #454545); }
  .tasksbtn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,.14)); }
  .propPopup .tasksTitle { padding: 5px 8px; font-weight: 600; border-bottom: 1px solid var(--vscode-widget-border, #454545); }
  .propPopup .tasksNote { padding: 6px 8px; color: var(--vscode-descriptionForeground); }
  .propPopup .tasksAll { display: block; width: 100%; text-align: left; padding: 5px 8px; cursor: pointer; background: none;
    border: none; border-top: 1px solid var(--vscode-widget-border, #454545); color: var(--vscode-textLink-foreground, #4ea1ff); }
  .propPopup .tasksAll:hover { background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,.1)); }
  .propPopup .grid { min-width: 260px; }
  .propsMsg { padding: 6px 8px; color: var(--vscode-descriptionForeground); }
  .popTabs { display: flex; border-bottom: 1px solid var(--vscode-widget-border, #454545); }
  .popTab { flex: 1 1 0; text-align: center; padding: 4px 10px; cursor: pointer; color: var(--vscode-descriptionForeground);
    user-select: none; border-right: 1px solid var(--vscode-widget-border, #454545); }
  .popTab:last-child { border-right: none; }
  .popTab:hover { background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,.08)); }
  .popTab.active { color: var(--vscode-foreground); box-shadow: inset 0 -2px 0 var(--vscode-focusBorder, #4ea1ff); }
  .popBody { padding: 6px; }
  .colorPop { width: 220px; }
  .swGrid { display: grid; grid-template-columns: repeat(8, 1fr); gap: 3px; }
  .swCell { width: 100%; padding-top: 100%; border: 1px solid var(--vscode-panel-border, #555); box-sizing: border-box; cursor: pointer; }
  .swCell.none { background: repeating-conic-gradient(#888 0% 25%, #ccc 0% 50%) 50% / 8px 8px; }
  .swCell:hover { outline: 1px solid var(--vscode-focusBorder, #4ea1ff); }
  .swCell.sel { outline: 2px solid var(--vscode-focusBorder, #4ea1ff); }
  .swList { max-height: 262px; overflow: auto; }
  .swRow { display: flex; align-items: center; gap: 6px; padding: 2px 4px; cursor: pointer; white-space: nowrap; }
  .swRow:hover { background: var(--vscode-list-hoverBackground, #2a2d2e); }
  .swRow.sel { background: var(--vscode-list-activeSelectionBackground, #094771); color: var(--vscode-list-activeSelectionForeground, #fff); }
  .swRow .swatch { margin: 0; }
  .swName { overflow: hidden; text-overflow: ellipsis; }
  .flagsPop { min-width: 150px; padding: 4px 0; }
  .flagRow { display: flex; align-items: center; gap: 6px; padding: 3px 12px; cursor: pointer; white-space: nowrap; }
  .flagRow:hover { background: var(--vscode-list-hoverBackground, #2a2d2e); }
  .flagRow input { width: auto; }
  td.cat { font-weight: bold; color: var(--vscode-foreground); cursor: pointer; user-select: none;
           background: var(--vscode-sideBarSectionHeader-background, rgba(255,255,255,.045)); padding: 3px 5px; }
  td.cat:hover { color: var(--vscode-foreground); }
  /* outline pane (Document outline) */
  #outlineTree { flex: 1; min-height: 0; overflow: auto; padding: 4px; font-size: 12px; }
  .treeNode { white-space: nowrap; cursor: pointer; user-select: none; padding: 1px 2px; border-radius: 2px; overflow: hidden; text-overflow: ellipsis; }
  .outlineStatus { flex: 0 0 auto; min-height: 16px; padding: 3px 8px; border-bottom: 1px solid var(--vscode-panel-border, #333); color: var(--vscode-descriptionForeground, #999); font-size: 11px; }
  .treeNode[draggable="true"] { cursor: grab; }
  .treeNode[draggable="true"]:active { cursor: grabbing; }
  .treeNode:hover { background: var(--vscode-list-hoverBackground, #2a2d2e); }
  .treeNode.sel { background: var(--vscode-list-activeSelectionBackground, #094771); color: var(--vscode-list-activeSelectionForeground, #fff); }
  .treeNode.dragging { opacity: .55; }
  .treeNode.drop-ok { outline: 1px solid var(--vscode-focusBorder, #007acc); background: var(--vscode-list-hoverBackground, #2a2d2e); }
  .treeNode.drop-bad { outline: 1px solid var(--vscode-errorForeground, #f48771); }
  /* 1.15 Data Sources pane — bounded project schemas/settings, with click or drag generation actions. */
  #dataPane { overflow: hidden; }
  #dataToolbar { flex: 0 0 auto; display: flex; gap: 6px; align-items: center; padding: 6px 8px;
    border-bottom: 1px solid var(--vscode-panel-border, #333); }
  #dataToolbar .dsNav { display: inline-flex; align-items: center; gap: 4px; color: var(--vscode-descriptionForeground); }
  #dataToolbar input { width: auto; }
  #dataStatus { flex: 0 0 auto; min-height: 16px; padding: 3px 8px; color: var(--vscode-descriptionForeground); }
  #dataList { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 4px 7px 9px; }
  .dsCard { margin-bottom: 7px; padding: 7px; border: 1px solid var(--vscode-panel-border, #444); border-radius: 4px;
    background: var(--vscode-sideBar-background, var(--vscode-editor-background)); }
  .dsHead { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dsProps { margin: 3px 0 6px; color: var(--vscode-descriptionForeground); font-size: 11px; line-height: 1.35;
    max-height: 3em; overflow: hidden; }
  .dsSource { margin: 0 0 6px; padding: 2px 4px; }
  .dsActions { display: flex; flex-wrap: wrap; gap: 4px; }
  .dsAction[draggable="true"] { cursor: grab; }
  .dsAction[draggable="true"]:active { cursor: grabbing; }
  .dsSection { margin: 10px 0 4px; padding-bottom: 3px; font-weight: 600;
    border-bottom: 1px solid var(--vscode-panel-border, #444); }
  .settingRow { display: flex; align-items: center; gap: 6px; padding: 4px 2px; }
  .settingName { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .settingRow button { flex: 0 0 auto; }
  .settingRow button:disabled { opacity: .5; cursor: default; }
  .treeNode .tw { white-space: pre; }
  /* toolbox pane — VS-style: vertical stack of collapsible category "tabs", right-click menu, custom tabs */
  #tbBody { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  #tbHeader { flex: 0 0 auto; padding: 4px; }
  #tbSearch { width: 100%; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, #555); }
  /* a plain block scroll container — NOT a flex column: as a flex column, an overflow:hidden header (.tbCat,
     min-height:auto → 0) gets shrunk to a thin textless strip when every category is expanded and the content
     overflows. display:block keeps each child at its natural height and lets overflow:auto scroll instead. */
  #tbList { flex: 1 1 auto; min-height: 0; overflow: auto; display: block; padding: 2px 0; }
  .tbCat { font-weight: bold; color: var(--vscode-foreground); cursor: pointer; user-select: none; padding: 4px 6px;
    background: var(--vscode-sideBarSectionHeader-background, rgba(255,255,255,.045)); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tbCat:hover { background: var(--vscode-list-hoverBackground, #2a2d2e); }
  .tbCat .tw { display: inline-block; width: 12px; color: var(--vscode-descriptionForeground); }
  .tbCat .cnt { color: var(--vscode-descriptionForeground); font-weight: normal; }
  .tbCat.custom { font-style: italic; }
  .tbItems { display: flex; flex-direction: column; gap: 1px; padding: 2px 4px 4px; }
  .tbItems.icons { flex-direction: row; flex-wrap: wrap; gap: 3px; }
  .tbItem { font-size: 12px; padding: 3px 8px 3px 20px; position: relative; border-radius: 2px; cursor: pointer; user-select: none;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--vscode-foreground); }
  .tbItem::before { content: "\\25aa"; position: absolute; left: 7px; top: 50%; transform: translateY(-50%); color: var(--vscode-icon-foreground, #8a8a8a); }
  /* real [ToolboxBitmap] icon (16×16) replaces the generic ::before glyph for items that carry one */
  .tbItem.ic::before { display: none; }
  .tbItem .tbIcon { position: absolute; left: 3px; top: 50%; transform: translateY(-50%); width: 16px; height: 16px; image-rendering: pixelated; pointer-events: none; }
  .tbItem:hover { background: var(--vscode-list-hoverBackground, #2a2d2e); }
  .tbItem.selected { background: var(--vscode-list-activeSelectionBackground, #094771); color: var(--vscode-list-activeSelectionForeground, #fff); outline: 1px solid var(--vscode-focusBorder, #4ea1ff); outline-offset: -1px; }
  .tbItems.icons .tbItem { padding: 3px 6px 3px 18px; }
  .tbItems.icons .tbItem .tbIcon { left: 2px; }
  /* throwaway drag image for a toolbox item — a clean single-name chip (kept off-screen until the drag uses it) */
  .tbDragImage { position: absolute; top: -1000px; left: -1000px; padding: 2px 8px; font-size: 12px; white-space: nowrap;
    background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #fff); border-radius: 3px; }
  .tbEmptyCat { color: var(--vscode-descriptionForeground); font-style: italic; padding: 2px 10px 5px 20px; font-size: 11px; }
  /* right-click context menu (HTML; native VS Code menus aren't reachable inside a webview) */
  .ctxmenu { display: none; position: fixed; z-index: 50; min-width: 190px; padding: 4px 0; background: var(--vscode-menu-background, #252526);
    color: var(--vscode-menu-foreground, #ccc); border: 1px solid var(--vscode-menu-border, #454545); border-radius: 4px; box-shadow: 0 2px 8px rgba(0,0,0,.4); font-size: 12px; }
  .ctxmenu.open { display: block; }
  .ctxmenu .mi { padding: 4px 22px 4px 14px; cursor: pointer; white-space: nowrap; display: flex; justify-content: space-between; gap: 18px; }
  .ctxmenu .mi:hover { background: var(--vscode-menu-selectionBackground, #04395e); color: var(--vscode-menu-selectionForeground, #fff); }
  .ctxmenu .mi.disabled { opacity: .4; pointer-events: none; }
  .ctxmenu .mi .acc { color: var(--vscode-descriptionForeground); }
  .ctxmenu .mi:hover .acc { color: inherit; }
  .ctxmenu .sep { height: 1px; margin: 4px 0; background: var(--vscode-menu-separatorBackground, #454545); }
  /* modal (Choose Items stub + tab-name prompt) */
  .modal { display: none; position: fixed; inset: 0; z-index: 60; background: rgba(0,0,0,.45); align-items: center; justify-content: center; }
  .modal.open { display: flex; }
  .modalBox { background: var(--vscode-editorWidget-background, #252526); color: var(--vscode-foreground); border: 1px solid var(--vscode-widget-border, #454545);
    border-radius: 6px; min-width: 300px; max-width: 92%; max-height: 86%; display: flex; flex-direction: column; box-shadow: 0 4px 16px rgba(0,0,0,.5); }
  .modalBox.small { min-width: 240px; }
  .modalHead { font-weight: bold; padding: 10px 12px; border-bottom: 1px solid var(--vscode-widget-border, #454545); }
  .modalBody { padding: 12px; overflow: auto; }
  .modalBody input.full { width: 100%; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, #555); padding: 4px; }
  .modalFoot { padding: 10px 12px; border-top: 1px solid var(--vscode-widget-border, #454545); display: flex; justify-content: flex-end; gap: 8px; }
  .modalFoot button { padding: 4px 14px; }
  .modalFoot button.primary { background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #fff); }
  .ciTabs { display: flex; gap: 4px; margin-bottom: 10px; flex-wrap: wrap; }
  .ciTabs .ciTab { padding: 3px 8px; border: 1px solid var(--vscode-panel-border, #444); border-radius: 3px; cursor: pointer; }
  .ciTabs .ciTab.active { background: var(--vscode-toolbar-activeBackground, rgba(255,255,255,.16)); border-color: var(--vscode-focusBorder, #4ea1ff); }
  .ciList { max-height: 260px; overflow: auto; border: 1px solid var(--vscode-panel-border, #444); border-radius: 3px; }
  .ciRow { display: flex; gap: 8px; padding: 3px 8px; align-items: center; }
  .ciRow:hover { background: var(--vscode-list-hoverBackground, #2a2d2e); }
  .ciRow .ciCat { margin-left: auto; color: var(--vscode-descriptionForeground); font-size: 11px; }
  .ciNote { color: var(--vscode-descriptionForeground); font-size: 11px; margin-top: 10px; }
</style></head>
<body>
  <div id="content">
    <div id="propsPane" class="pane">
      <div id="propsEmpty" class="paneEmpty">${t('panel.props.empty')}</div>
      <div id="propsBody" style="display:none">
        <div id="sideHeader">
          <select id="tree"></select>
          <div id="tabs">
            <button id="sortCat" class="active" title="${t('panel.sort.categorized')}"><span class="codicon ico-cat"></span></button>
            <button id="sortAlpha" title="${t('panel.sort.alphabetical')}"><span class="codicon ico-alpha"></span></button>
            <span class="tabgap"></span>
            <button id="tabProps" class="active" title="${t('panel.tab.props')}"><span class="codicon ico-props"></span></button>
            <button id="tabEvents" title="${t('panel.tab.events')}"><span class="codicon ico-events"></span></button>
          </div>
          <input id="search" type="text" placeholder="${t('panel.search')}">
        </div>
        <div id="grid">
          <div id="props"></div><div id="events" style="display:none"></div>
        </div>
        <div id="propDesc"></div>
      </div>
    </div>
    <div id="outlinePane" class="pane" style="display:none">
      <div id="outlineTree"></div>
    </div>
    <div id="toolboxPane" class="pane" style="display:none">
      <div id="tbEmpty" class="paneEmpty">${t('panel.toolbox.empty')}</div>
      <div id="tbBody" style="display:none">
        <div id="tbHeader"><input id="tbSearch" type="text" placeholder="${t('panel.toolbox.search')}"></div>
        <div id="tbList"></div>
      </div>
    </div>
    <div id="dataPane" class="pane" style="display:none">
      <div id="dataToolbar">
        <button id="dataRefresh" type="button">${t('panel.data.refresh')}</button>
        <label class="dsNav"><input id="dataNavigator" type="checkbox">${t('panel.data.navigator')}</label>
      </div>
      <div id="dataStatus">${t('panel.data.loading')}</div>
      <div id="dataList"></div>
    </div>
  </div>
  <div id="bottomTabs">
    <button id="mainTabProps" class="active" title="${t('panel.mainTab.props')}">${t('panel.mainTab.props')}</button>
    <button id="mainTabOutline" title="${t('panel.mainTab.outline')}">${t('panel.mainTab.outline')}</button>
    <button id="mainTabToolbox" title="${t('panel.mainTab.toolbox')}">${t('panel.mainTab.toolbox')}</button>
    <button id="mainTabData" title="${t('panel.mainTab.data')}">${t('panel.mainTab.data')}</button>
  </div>
  <div id="tbMenu" class="ctxmenu" style="display:none"></div>
  <div id="tbPrompt" class="modal" style="display:none">
    <div class="modalBox small">
      <div class="modalHead" id="tbPromptTitle">${t('panel.tbPrompt.title')}</div>
      <div class="modalBody"><input id="tbPromptInput" class="full" type="text" placeholder="${t('panel.tbPrompt.input')}"></div>
      <div class="modalFoot"><button id="tbPromptCancel">${t('common.cancel')}</button><button id="tbPromptOk" class="primary">${t('common.ok')}</button></div>
    </div>
  </div>
${injectL10nScript(nonce)}
<script nonce="${nonce}" src="${scriptUri}"></script>
</body></html>`;
}
