import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { randomBytes } from 'crypto';
import {
  EngineHandle,
  LayoutControl,
  ComponentDesc,
  renderWithLayout,
  renderCompiledWithLayout,
  describeCompiledComponent,
  setCompiledPropertyLive,
  resetCompiledPropertyLive,
  setCompiledCollectionLive,
  setCompiledTreeNodesLive,
  LiveCollItem,
  applyCompiledEdits,
  removeCompiledControls,
  setCompiledZOrder,
  addCompiledControl,
  selectCompiledTabAt,
  hitTestCompiledTab,
  CompiledEdit,
  RenderLayout,
  ColumnItem,
  GridColumnItem,
  TreeNodeItem,
  listTreeNodes,
  setTreeNodes,
  describeLayout,
  describeComponent,
  renderControl,
  setProperty,
  convertValue,
  setTableCell,
  listCollectionItems,
  setCollectionItems,
  listColumns,
  setColumns,
  listGridColumns,
  setGridColumns,
  resetProperty,
  setImageResource,
  generateEventHandler,
  listHandlerCandidates,
  setEventWiring,
  addControl,
  addComponent,
  listToolboxItems,
  listCompiledToolboxControls,
  ToolboxItemInfo,
  getDesignerPalette,
  DesignerPaletteInfo,
  listToolboxCandidates,
  scanToolboxAssembly,
  removeControl,
  copyControl,
  pasteControl,
  moveZOrder,
  addTabPage,
  addCompiledTab,
  removeTabPage,
  removeCompiledTab,
} from './engineClient';
import { COMPLEX_TYPE_SET, toCSharpExpression, shortName } from './valueExpr';
import { findNearestCsproj, projectAssemblyName, projectReferencesAssembly, addReferenceToCsproj, resolveFrameworkOutput, resolveFrameworkOnlyOutput, projectTargetFramework, isFrameworkTfm, multiTargetHasFramework } from './csprojRef';
import { t, tn, injectL10nScript } from './i18n';
import { categorizeUnrepresentable } from './renderDiagnostics';

export type EngineKind = 'net9' | 'net48';
type EnsureEngine = (kind?: EngineKind) => Promise<EngineHandle>;
type AssemblyOverride = (file: string) => string | undefined;
/** Persist a form's control-source override (the per-form `controlSources` map) — the write side of
 *  AssemblyOverride, used by the T1.3 cross-runtime switch to remember the net48 compiled preview. */
type SetAssemblyOverride = (file: string, dll: string) => Promise<void>;

/** A .NET (Core/5+) build always emits `<name>.deps.json` (apps also `.runtimeconfig.json`) beside the
 *  assembly; a .NET Framework build emits neither. That sidecar's presence cleanly says which engine can load
 *  the control assembly: none → net48 (Framework/DevExpress compiled preview), else → net9. No assembly → net9. */
function detectEngineKind(assemblyPath: string | undefined): EngineKind {
  if (!assemblyPath) return 'net9';
  const base = assemblyPath.replace(/\.(dll|exe)$/i, '');
  try {
    if (fs.existsSync(base + '.deps.json') || fs.existsSync(base + '.runtimeconfig.json')) return 'net9';
  } catch { /* fall through to Framework */ }
  return 'net48';
}

/** Canvas messages the net48 compiled preview doesn't support (kept for future ops that can't be mirrored on the
 *  live compiled instance). Currently EMPTY: every edit — property grid, drag/resize, add, remove, z-order, and
 *  now cut/paste — is mirrored (net9 splices the text; net48 mutates the live instance for the picture). 'save'
 *  just flushes the committed .Designer.cs text. */
const NET48_READONLY_BLOCKED = new Set<string>([]);
/** One row the Choose-Items dialog sends back on OK: its identity + whether the user has it checked. The host
 *  diffs these against the current toolbox membership to add/remove/hide items. */
type ChooseRow = { fqn: string; name: string; namespace?: string; assemblyName?: string; fromProject?: boolean; checked: boolean };

/** Sentinel value of the events dropdown's "(new handler…)" option — must match the webviews. */
const NEW_HANDLER = 'new';

/**
 * Map a file the user opened to the .Designer.cs the engine should read — the "open Form1.cs → see the
 * designer" mapping (the .Designer.cs is the generated partner, like in Visual Studio).
 *   Foo.cs            → Foo.Designer.cs  (only when that sibling exists)
 *   Foo.Designer.cs   → itself           (graceful: reopened the generated file directly)
 *   Foo.cs (no sibling)→ null
 */
export function resolveDesignerFile(opened: string): string | null {
  if (/\.Designer\.cs$/i.test(opened)) {
    return fs.existsSync(opened) ? opened : null;
  }
  if (/\.cs$/i.test(opened)) {
    const sibling = opened.slice(0, -'.cs'.length) + '.Designer.cs';
    return fs.existsSync(sibling) ? sibling : null;
  }
  return null;
}

/** True when `file` is a .cs that has a sibling .Designer.cs — the gate for AUTO-opening the designer. */
export function hasDesignerSibling(file: string): boolean {
  return /\.cs$/i.test(file) && !/\.Designer\.cs$/i.test(file)
    && fs.existsSync(file.slice(0, -'.cs'.length) + '.Designer.cs');
}

/**
 * The file the "Open Designer" action should open the custom editor on.
 *   Foo.cs (+ sibling)  → Foo.cs
 *   Foo.Designer.cs     → Foo.cs if it exists, else Foo.Designer.cs itself
 *   Foo.cs (no sibling) → null
 */
export function resolveOpenTarget(file: string): string | null {
  if (/\.Designer\.cs$/i.test(file)) {
    const partner = file.slice(0, -'.Designer.cs'.length) + '.cs';
    if (fs.existsSync(partner)) return partner;
    return fs.existsSync(file) ? file : null;
  }
  if (/\.cs$/i.test(file)) {
    return fs.existsSync(file.slice(0, -'.cs'.length) + '.Designer.cs') ? file : null;
  }
  return null;
}

/** True when the "Open Designer" action has somewhere to go (drives the editor-title button). */
export function canOpenDesigner(file: string): boolean {
  return resolveOpenTarget(file) !== null;
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

  private memento: vscode.Memento | undefined;
  /** The designer clipboard (Cut/Copy → Paste), shared across all open designer editors like VS. Each entry is
   *  an OPAQUE engine blob (from copyControl) handed back to pasteControl; `label` is a human display name. */
  clipboard: { clips: string[]; label: string } | null = null;

  /** Items the user ADDED via "Choose Items" (each tagged with `category` = the toolbox tab it landed in).
   *  Merged into the toolbox palette and persisted, so a chosen library control survives reloads. */
  chosenItems: ToolboxItemInfo[] = [];
  /** Framework palette items the user UNCHECKED in "Choose Items" — filtered out of the toolbox. */
  private hidden = new Set<string>();

  /** The color/font palette (KnownColors + installed fonts + unit suffixes). Engine-wide static, so it's
   *  fetched once by the first session and reused by all — cached here, re-pushed to the panel on refresh. */
  private palette: DesignerPaletteInfo | undefined;
  /** In-flight fetch, memoized so concurrent first-renders (two sessions, or refreshToolbox+fullRender racing)
   *  issue exactly ONE GetDesignerPalette RPC instead of duplicating the round-trip. */
  private paletteFetch: Promise<DesignerPaletteInfo> | undefined;
  get hasPalette(): boolean { return this.palette !== undefined; }
  /** Fetch the palette once (engine-wide static, machine-global) and cache it. Idempotent; a failed fetch
   *  clears the latch so a later call retries. */
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

  /** Wire up persistence (call once at activation). */
  initState(memento: vscode.Memento): void {
    this.memento = memento;
    this.chosenItems = memento.get<ToolboxItemInfo[]>('chosenToolboxItems', []);
    this.hidden = new Set(memento.get<string[]>('hiddenToolboxFqns', []));
  }
  /** Replace the toolbox customization (added + hidden), persist it, and re-push the merged toolbox. */
  setToolboxCustomization(chosen: ToolboxItemInfo[], hidden: string[]): void {
    this.chosenItems = chosen;
    this.hidden = new Set(hidden);
    void this.memento?.update('chosenToolboxItems', chosen);
    void this.memento?.update('hiddenToolboxFqns', [...this.hidden]);
    void this.active?.refreshToolbox();
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
   *  determines the engine kind / compiled-preview badge). */
  refreshStatus(): void { this._onActive.fire(); }

  toPanel(msg: unknown): void { void this.panel?.postMessage(msg); }
  /** From a session — forward to the panel only if it's the one currently mirrored. */
  pushPanel(s: DesignerSession, msg: unknown): void { if (this.active === s) this.toPanel(msg); }

  /** Called by the panel provider when its WebviewView resolves — remember the webview + its extensionUri so a
   *  live language switch can re-emit the panel HTML with the new locale's injected catalog. */
  attachPanel(webview: vscode.Webview, extensionUri: vscode.Uri): void {
    this.panel = webview;
    this.panelExtensionUri = extensionUri;
  }
  registerSession(s: DesignerSession): void { this.openSessions.add(s); }
  unregisterSession(s: DesignerSession): void { this.openSessions.delete(s); }
  /** Live language switch (`winformsDesigner.language` changed): re-emit the panel + every open designer canvas so
   *  their injected catalog + host-built HTML pick up the new locale immediately. Each reloaded webview re-sends
   *  `ready`, which rehydrates it (panel → refreshViews, canvas → fullRender). The manifest "chrome" (command
   *  palette, settings page) still needs a window reload — that's what the accompanying toast offers. */
  rebuildOpenWebviews(): void {
    if (this.panel && this.panelExtensionUri) this.panel.html = panelHtml(this.panel, this.panelExtensionUri);
    for (const s of [...this.openSessions]) s.rebuildHtml();
  }
}

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

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

  constructor(
    readonly uri: vscode.Uri,
    readonly designerFile: string | null,
    initialText: string,
    /** The real on-disk text. Differs from initialText only for a recovered (dirty) hot-exit backup. */
    savedText: string,
    hadBom: boolean,
  ) {
    this.designerText = initialText;
    this.savedDesignerText = savedText;
    this.hadBom = hadBom;
  }

  get isDirty(): boolean { return this.designerText !== this.savedDesignerText; }

  private bytesOf(text: string): Uint8Array {
    const body = Buffer.from(text, 'utf8');
    return this.hadBom ? Buffer.concat([UTF8_BOM, body]) : body;
  }

  /** Adopt the on-disk text as the new clean baseline (revert / external change while clean). */
  adoptDiskBaseline(text: string, hadBom: boolean): void {
    this.designerText = text; this.savedDesignerText = text; this.hadBom = hadBom; this.rev++;
  }

  /** Persist to the .Designer.cs on disk (called by VS Code's save), preserving the original BOM. */
  async save(): Promise<void> {
    if (!this.designerFile) return;
    // Snapshot the exact text we write: if an edit/undo commits during the async write, the file holds this
    // snapshot, so only mark THAT as saved (a newer edit stays dirty — no silent data loss / reload-drop).
    const snapshot = this.designerText;
    await vscode.workspace.fs.writeFile(vscode.Uri.file(this.designerFile), this.bytesOf(snapshot));
    this.savedDesignerText = snapshot;
    this.session?.notifySaved();
  }
  async saveAs(dest: vscode.Uri): Promise<void> {
    // Save As on a designer writes the GENERATED partner, not generated code into a hand-edited .cs.
    const target = /\.Designer\.cs$/i.test(dest.fsPath) ? dest
      : /\.cs$/i.test(dest.fsPath) ? vscode.Uri.file(dest.fsPath.slice(0, -'.cs'.length) + '.Designer.cs')
        : dest;
    await vscode.workspace.fs.writeFile(target, this.bytesOf(this.designerText));
  }
  async revert(): Promise<void> {
    if (!this.designerFile) return;
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

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly ensureEngine: EnsureEngine,
    private readonly getAssemblyOverride: AssemblyOverride,
    private readonly output: vscode.OutputChannel,
    private readonly onViewCode: (uri: vscode.Uri, position?: vscode.Position) => void,
    private readonly setAssemblyOverride: SetAssemblyOverride,
  ) {}

  async openCustomDocument(
    uri: vscode.Uri,
    openContext: vscode.CustomDocumentOpenContext,
    _token: vscode.CancellationToken,
  ): Promise<WinFormsDesignDocument> {
    const designerFile = resolveDesignerFile(uri.fsPath);
    let diskText = '';
    let hadBom = false;
    if (designerFile) {
      try { const r = await readDesignerBytesUri(vscode.Uri.file(designerFile)); diskText = r.text; hadBom = r.hadBom; } catch { /* missing → empty (placeholder) */ }
    }
    // designerText = recovered hot-exit backup if present (else disk); savedDesignerText = the REAL on-disk
    // text — so a recovered backup that differs from disk is correctly DIRTY, not silently "saved".
    let text = diskText;
    if (openContext.backupId) {
      try { const r = await readDesignerBytesUri(vscode.Uri.parse(openContext.backupId)); text = r.text; if (!designerFile) hadBom = r.hadBom; } catch { /* fall back to disk */ }
    }
    return new WinFormsDesignDocument(uri, designerFile, text, diskText, hadBom);
  }

  resolveCustomEditor(
    document: WinFormsDesignDocument,
    panel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): void {
    document.session = new DesignerSession(
      this.context.extensionUri, this.ensureEngine, this.getAssemblyOverride, this.output, this.onViewCode,
      document, panel, (e) => this._onDidChangeCustomDocument.fire(e), this.setAssemblyOverride,
    );
  }

  saveCustomDocument(document: WinFormsDesignDocument, _c: vscode.CancellationToken): Thenable<void> { return document.save(); }
  saveCustomDocumentAs(document: WinFormsDesignDocument, dest: vscode.Uri, _c: vscode.CancellationToken): Thenable<void> { return document.saveAs(dest); }
  revertCustomDocument(document: WinFormsDesignDocument, _c: vscode.CancellationToken): Thenable<void> { return document.revert(); }
  backupCustomDocument(document: WinFormsDesignDocument, context: vscode.CustomDocumentBackupContext, _c: vscode.CancellationToken): Thenable<vscode.CustomDocumentBackup> { return document.backup(context.destination); }
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
      type?: string; id?: string; prop?: string; propType?: string; isEnum?: boolean; value?: string;
      event?: string; handler?: string | null; controlType?: string; tab?: string; cell?: string; componentType?: string;
      items?: string[]; columns?: ColumnItem[]; gridColumns?: GridColumnItem[]; nodes?: TreeNodeItem[];
    }) => {
      const s = DesignerHub.instance.activeSession;
      try {
        if (m?.type === 'ready') { s?.refreshViews(); }
        else if (m?.type === 'pick' && m.id) { await s?.pick(m.id); }
        else if (m?.type === 'edit' && m.id && m.prop && m.propType !== undefined) { await s?.editFromGrid(m.id, m.prop, m.propType, !!m.isEnum, m.value ?? ''); }
        else if (m?.type === 'importImage' && m.id && m.prop && m.propType) { await s?.importImageFromGrid(m.id, m.prop, m.propType); }
        else if (m?.type === 'clearImage' && m.id && m.prop) { await s?.clearImageFromGrid(m.id, m.prop); }
        else if (m?.type === 'resetProperty' && m.id && m.prop) { await s?.resetFromGrid(m.id, m.prop); }
        else if (m?.type === 'setTableCell' && m.id && m.cell) { await s?.tableCellFromGrid(m.id, m.cell, m.value ?? ''); }
        else if (m?.type === 'listCollection' && m.id && m.prop) { await s?.sendCollectionItems(m.id, m.prop); }
        else if (m?.type === 'setCollection' && m.id && m.prop && Array.isArray(m.items)) { await s?.collectionFromGrid(m.id, m.prop, m.items as string[]); }
        else if (m?.type === 'listColumns' && m.id) { await s?.sendColumnItems(m.id); }
        else if (m?.type === 'setColumns' && m.id && Array.isArray(m.columns)) { await s?.columnsFromGrid(m.id, m.columns as ColumnItem[]); }
        else if (m?.type === 'listGridColumns' && m.id) { await s?.sendGridColumnItems(m.id); }
        else if (m?.type === 'setGridColumns' && m.id && Array.isArray(m.gridColumns)) { await s?.gridColumnsFromGrid(m.id, m.gridColumns as GridColumnItem[]); }
        else if (m?.type === 'listTreeNodes' && m.id) { await s?.sendTreeNodes(m.id); }
        else if (m?.type === 'setTreeNodes' && m.id && Array.isArray(m.nodes)) { await s?.treeNodesFromGrid(m.id, m.nodes as TreeNodeItem[]); }
        else if (m?.type === 'setHandler' && m.id && m.event) { await s?.setHandler(m.id, m.event, m.handler ?? ''); }
        else if (m?.type === 'createHandler' && m.id && m.event) { await s?.createHandler(m.id, m.event, m.handler || undefined); }
        else if (m?.type === 'navigateHandler' && m.id) { await s?.navigateToHandler(m.id, m.event ?? '', m.handler ?? undefined); }
        else if (m?.type === 'listHandlers' && m.id) { await s?.sendCandidates(m.id); }
        else if (m?.type === 'addControl' && m.controlType) { await s?.addControlFromToolbox(m.controlType); }
        else if (m?.type === 'addComponent' && m.componentType) { await s?.addComponentFromToolbox(m.componentType); }
        else if (m?.type === 'deleteSelected') { s?.deleteSelectedFromPanel(); }
        else if (m?.type === 'chooseItems') { s?.openChooseItems(m.tab); }
      } catch { /* edit/handler/add failures already report on the canvas status line */ }
    });
    view.onDidDispose(() => { if (DesignerHub.instance.panel === view.webview) DesignerHub.instance.panel = null; });
  }
}

/** Manages one open designer editor: render, selection, property edits, and live-update. */
class DesignerSession {
  private readonly designerFile: string | null;
  private readonly disposables: vscode.Disposable[] = [];
  private currentId = 'this';
  private renderSeq = 0;
  private controls: LayoutControl[] = [];
  private rootClient: { w: number; h: number } | null = null;
  private rootFrame: { w: number; h: number } | null = null;
  /** Which engine renders THIS form — detected per render from the resolved control assembly's runtime
   *  (net48 = .NET Framework/DevExpress compiled preview). Drives engine routing + edit gating + the badge. */
  private engineKind: EngineKind = 'net9';
  private debounce?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private gotReady = false;
  /** Auto-populated toolbox palette — fetched once, then mirrored to the Toolbox view. */
  private toolboxItems: ToolboxItemInfo[] | undefined;
  /** One-shot latch: we prompt "select a control source" at most once per form (until it renders clean or the
   *  user picks one), so a form with unresolved custom controls isn't nagging on every re-render. */
  private promptedForSource = false;
  /** Control assembly auto-resolved for a .NET Framework/DevExpress project when NO explicit source is set —
   *  set by the last render's routing (undefined for a .NET project, whose output the net9 engine finds itself).
   *  `asm()` returns it as the effective source so the net48 render AND its live edit ops all target the same
   *  compiled assembly, and only a net9 form (autoAsm undefined) keeps engine-side auto-discovery. */
  private autoAsm: string | undefined;
  /** The big "Choose Toolbox Items" window (a separate editor-area webview panel), if open. */
  private chooseItemsPanel: vscode.WebviewPanel | undefined;
  /** Assemblies the user added via the Choose-Items "Browse…" button (accumulated across clicks). */
  private browsedDlls: string[] = [];
  /** (project, assembly) pairs we've already offered a <Reference> for — ask at most once each per session,
   *  whatever the user answered, so adding several controls from one library doesn't nag repeatedly. */
  private readonly offeredReferences = new Set<string>();
  /** The toolbox tab the open Choose-Items window targets (checked items land here); undefined = none. */
  private chooseItemsTab: string | undefined;

  private readonly documentUri: vscode.Uri;
  /** The custom document whose in-memory .Designer.cs text this session renders and edits (issue #2). */
  private readonly doc: WinFormsDesignDocument;

  constructor(
    private readonly extensionUri: vscode.Uri,
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
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(path.dirname(this.designerFile), '*'),
    );
    const onFs = (uri: vscode.Uri) => { if (normalize(uri.fsPath) === key) this.scheduleRerender(); };
    watcher.onDidChange(onFs);
    watcher.onDidCreate(onFs);
    watcher.onDidDelete(onFs);
    this.disposables.push(watcher);

    panel.onDidDispose(() => this.dispose());
  }

  private dispose(): void {
    this.disposed = true;
    if (this.doc.session === this) this.doc.session = undefined; // drop the back-reference on close
    this.chooseItemsPanel?.dispose();
    DesignerHub.instance.unregisterSession(this);
    DesignerHub.instance.clearIfActive(this);
    if (this.debounce) clearTimeout(this.debounce);
    for (const d of this.disposables.splice(0)) {
      try { d.dispose(); } catch { /* ignore */ }
    }
  }

  private asm(): string | undefined {
    // Explicit control source wins; otherwise the framework assembly the last render auto-resolved (net48/
    // DevExpress). A net9 form leaves autoAsm undefined → this returns undefined → engine-side auto-discovery.
    return (this.designerFile ? this.getAssemblyOverride(this.designerFile) : undefined) ?? this.autoAsm;
  }

  /** The .Designer.cs this session renders (the key the control-source override is stored under). */
  get designerFilePath(): string | null { return this.designerFile; }

  /** True when this form is rendered by the net48 engine — a read-only compiled preview. */
  get isCompiledPreview(): boolean { return this.engineKind === 'net48'; }

  /** The control assembly currently in effect: explicit override, else the auto-resolved framework assembly
   *  (net48/DevExpress) from the last render, else undefined (a net9 form → engine auto-discovery). */
  get controlAssembly(): string | undefined { return this.asm(); }

  /** Re-render after the user changed the control source (Select Control Assembly): drop the cached toolbox so
   *  Project Controls re-discover against the NEW assembly, then a full render (loads the new controls). */
  async reloadControlSource(): Promise<void> {
    this.toolboxItems = undefined;
    this.promptedForSource = true; // an explicit choice was made — don't nag about this form again
    await this.fullRender();
    this.refreshViews();
  }

  /** Post to THIS editor's canvas webview (render/layout/patch/select/manip/status/dirty/error/loading). */
  private post(message: unknown): void {
    void this.panel.webview.postMessage(message);
  }

  /** Layout goes to the canvas (hit-test/overlay) AND the Properties view (tree selector). */
  private postLayout(controls: LayoutControl[]): void {
    this.post({ type: 'layout', controls });
    DesignerHub.instance.pushPanel(this, { type: 'layout', controls });
  }
  /** Selection goes to the canvas (overlay) AND the Properties view (tree highlight). */
  private pushSelect(id: string): void {
    this.post({ type: 'select', id });
    DesignerHub.instance.pushPanel(this, { type: 'select', id });
  }

  /** Populate `toolboxItems` once. net9: framework + project controls in one enumeration. net48: framework controls
   *  from the net9 enumerator (same FQNs → droppable on a net48 form) MERGED with the project/vendor (DevExpress)
   *  controls from the net48 engine — the ones the net9 ALC can't load (DevExpress-add). Best-effort: a framework
   *  failure leaves it undefined (retry later); a project-enumeration failure degrades to framework-only. */
  private async loadToolboxItems(): Promise<void> {
    if (this.toolboxItems || !this.designerFile) return;
    // Capture the kind: the pre-render refreshViews (ctor setActive) runs while engineKind is still the default
    // 'net9', but the first fullRender flips it to 'net48' for a compiled form. A load started under one kind must
    // NOT assign after the kind flipped — else a stale framework-only net9 result would poison the net48 cache and
    // the project/vendor controls would never appear (fullRender also clears the cache on the transition).
    const kind = this.engineKind;
    if (kind === 'net48') {
      let framework: ToolboxItemInfo[];
      try { framework = await listToolboxItems(await this.ensureEngine('net9'), this.designerFile, undefined); }
      catch { return; } // leave undefined so a later refresh retries
      let project: ToolboxItemInfo[] = [];
      const asm = this.asm();
      if (asm) {
        try { project = await listCompiledToolboxControls(await this.ensureEngine('net48'), asm); } catch { /* project best-effort */ }
      }
      if (this.disposed || this.engineKind !== kind || this.toolboxItems) return; // kind flipped / already loaded under us
      this.toolboxItems = [...framework, ...project];
    } else {
      let items: ToolboxItemInfo[];
      try { items = await listToolboxItems(await this.ensureEngine('net9'), this.designerFile, this.asm()); } catch { return; }
      if (this.disposed || this.engineKind !== kind || this.toolboxItems) return;
      this.toolboxItems = items;
    }
  }

  // ----- view refresh (when this session becomes the focused one, or a view (re)opens) -----
  async refreshToolbox(): Promise<void> {
    if (this.disposed || !this.designerFile) return;
    await this.loadToolboxItems();
    DesignerHub.instance.pushPanel(this, { type: 'toolbox', items: [...(this.toolboxItems ?? []).filter((it) => !DesignerHub.instance.isHidden(it.fqn)), ...DesignerHub.instance.chosenItems] });
    await this.refreshPalette();
  }

  /** Fetch the color/font palette once (engine-wide static, cached on the hub) and push it to the panel so
   *  the Color dropdown + Font editor have their swatches / font families / unit suffixes. Best-effort:
   *  a fetch failure just leaves those editors on their text-input fallback. */
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
      void this.loadProps(this.currentId);
    } else {
      DesignerHub.instance.pushPanel(this, { type: 'clear' }); // not rendered yet → blank until fullRender
    }
  }
  refreshViews(): void { void this.refreshToolbox(); this.refreshProperties(); this.pushClipboardState(); }

  /** Re-emit this canvas's HTML with the current locale's injected catalog (live language switch). Reloading the
   *  webview makes it re-send `ready`, which triggers a full re-render / rehydrate through the normal path. */
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
    let onDisk: { text: string; hadBom: boolean };
    try { onDisk = await readDesignerBytesUri(vscode.Uri.file(this.designerFile)); } catch { return; }
    if (onDisk.text === this.doc.designerText) return; // our own save, or a no-op change
    if (this.doc.isDirty) {
      this.post({ type: 'status', message: t('status.diskChanged') });
      return;
    }
    this.doc.adoptDiskBaseline(onDisk.text, onDisk.hadBom);
    await this.fullRender();
  }

  /**
   * Commit a new full .Designer.cs text as ONE undoable custom-document edit. The visible form (Foo.cs) tab
   * becomes dirty (not the generated file), and Ctrl+Z/Y restore the previous/next text through these
   * closures. Callers live-update the canvas (patch or full render) AFTER this; undo/redo do a full render.
   */
  private commit(before: string, after: string, label: string): void {
    if (after === before) return; // no-op edit → no dirty mark / no undo entry (don't desync VS Code dirty)
    this.doc.rev++;
    this.doc.designerText = after;
    this.fireEdit({
      document: this.doc,
      label,
      undo: async () => { this.doc.rev++; this.doc.designerText = before; await this.rerenderFromDoc(); },
      redo: async () => { this.doc.rev++; this.doc.designerText = after; await this.rerenderFromDoc(); },
    });
  }

  /** Re-render the canvas from the current in-memory text (used by undo/redo and revert). */
  async rerenderFromDoc(): Promise<void> {
    if (this.disposed) return;
    await this.fullRender();
  }

  /** Called by the provider after a successful save: clear the canvas "unsaved" mark. */
  notifySaved(): void {
    if (this.disposed) return;
    this.post({ type: 'status', message: t('status.saved') });
    this.postDirty();
  }

  private async onMessage(m: {
    type: string; id?: string; mode?: string; x?: number; y?: number; width?: number; height?: number;
    ids?: string[]; dx?: number; dy?: number; prop?: string; propType?: string; isEnum?: boolean; value?: string;
    edits?: Array<{ id: string; dx: number; dy: number }>; controlType?: string; hitId?: string; typeName?: string;
    sizeEdits?: Array<{ id: string; width: number; height: number }>; hostId?: string; pageId?: string;
    axis?: 'h' | 'v';
  }): Promise<void> {
    try {
      if (this.engineKind === 'net48' && NET48_READONLY_BLOCKED.has(m.type)) {
        this.post({ type: 'status', message: t('status.net48Unsupported') });
        return;
      }
      if (m.type === 'ready') {
        this.gotReady = true;
        this.output.appendLine('[designer] webview ready: ' + this.designerFile);
        await this.fullRender();
      } else if (m.type === 'pick' && m.id) {
        await this.pick(m.id);
      } else if (m.type === 'manipulate' && m.id && m.mode) {
        await this.applyManipulate(m.id, m.mode, m.x ?? 0, m.y ?? 0, m.width ?? 0, m.height ?? 0);
      } else if (m.type === 'manipulateGroup' && Array.isArray(m.ids)) {
        await this.applyGroupMove(m.ids, m.dx ?? 0, m.dy ?? 0);
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
        await this.applyAddControl(m.controlType, this.containerParentFor(m.hitId ?? 'this'), m.x, m.y);
      } else if (m.type === 'save') {
        await this.saveDesigner();
      } else if (m.type === 'removeControl' && m.id) {
        await this.applyRemoveControl(m.id);
      } else if (m.type === 'removeControls' && Array.isArray(m.ids)) {
        await this.applyGroupRemove(m.ids);
      } else if (m.type === 'viewCode') {
        this.onViewCode(this.documentUri);
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
      } else if (m.type === 'addTab' && m.hostId) {
        await this.applyAddTab(m.hostId);
      } else if (m.type === 'deleteTab' && m.hostId && m.pageId) {
        await this.applyDeleteTab(m.hostId, m.pageId);
      } else if (m.type === 'learnMore') {
        await this.openLearnMore(m.typeName);
      } else if (m.type === 'showProperties') {
        await vscode.commands.executeCommand('winformsDesigner.showProperties');
      }
    } catch (err) {
      this.post({ type: 'error', message: errMsg(err) });
    }
  }

  /** Select a component (from a canvas click or the Properties tree): move the overlay + load its grid. */
  async pick(id: string): Promise<void> {
    if (this.disposed) return;
    this.currentId = id;
    this.pushSelect(id);
    await this.loadProps(id);
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
   * VS-style tabs / table / filter. The actual DLL scan-cache-load is a later increment; for now the .NET tab
   * lists the controls the toolbox already discovered, so the window shape is real and reviewable.
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
    panel.webview.onDidReceiveMessage(async (m: { type?: string; tab?: string | null; rows?: ChooseRow[] }) => {
      if (m?.type === 'ready') await this.pushCandidates(panel);
      else if (m?.type === 'browse') await this.browseChooseItems(panel);
      else if (m?.type === 'applyChooseItems') { this.applyChosen(m.tab ?? undefined, m.rows ?? []); panel.dispose(); }
      else if (m?.type === 'close') panel.dispose();
    });
    panel.onDidDispose(() => { if (this.chooseItemsPanel === panel) this.chooseItemsPanel = undefined; });
  }

  /** Fetch the Choose-Items rows (framework + project + browsed .dlls) → the dialog, with the target tab and
   *  which of its items are currently in the toolbox (so the checkboxes start in the right state). */
  private async pushCandidates(panel: vscode.WebviewPanel, autoCheck?: string[]): Promise<void> {
    const hub = DesignerHub.instance;
    const tab = this.chooseItemsTab ?? null;
    // "chosen" sent to the dialog = the fqns CURRENTLY in the toolbox (framework-not-hidden + added) → so the
    // checkboxes start checked for everything already in the toolbox (matching VS), not all-off.
    const inToolbox = (): string[] => [
      ...(this.toolboxItems ?? []).filter((c) => !hub.isHidden(c.fqn)).map((c) => c.fqn),
      ...hub.chosenItems.map((c) => c.fqn),
    ];
    // `check` = fqns to auto-tick this round (a just-browsed assembly's items) so the user doesn't have to hand-
    // check every row after loading a library — like VS, which checks a browsed assembly's items on add.
    const check = autoCheck ?? [];
    if (this.disposed || !this.designerFile) { void panel.webview.postMessage({ type: 'items', items: [], tab, chosen: inToolbox(), check }); return; }
    try {
      const eng = await this.ensureEngine();
      await this.loadToolboxItems(); // baseline "already in toolbox" set (incl. net48 project controls)
      const items = await listToolboxCandidates(eng, this.designerFile, this.asm(), this.browsedDlls.length ? this.browsedDlls : undefined);
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
    const baseline = new Set((this.toolboxItems ?? []).map((c) => c.fqn));
    const hidden = new Set(hub.hiddenFqns);
    let chosen = hub.chosenItems.slice();
    for (const r of rows) {
      if (!r.fqn) continue;
      const isFramework = baseline.has(r.fqn);
      const inChosen = chosen.some((c) => c.fqn === r.fqn);
      const inToolbox = (isFramework && !hidden.has(r.fqn)) || inChosen;
      if (r.checked && !inToolbox) {
        if (isFramework) hidden.delete(r.fqn);
        else chosen.push({ name: r.name, fqn: r.fqn, category: cat, fromProject: !!r.fromProject });
      } else if (!r.checked && inToolbox) {
        if (isFramework) hidden.add(r.fqn);
        else chosen = chosen.filter((c) => c.fqn !== r.fqn);
      }
    }
    hub.setToolboxCustomization(chosen, [...hidden]);
    // setToolboxCustomization re-pushes via the ACTIVE session, but the Choose-Items dialog holds editor focus, so
    // that gated push can be dropped → the added items wouldn't show until a refocus. Push the merged toolbox
    // DIRECTLY (ungated) so they appear in the palette immediately, which is exactly the point of clicking OK.
    hub.toPanel({ type: 'toolbox', items: [...(this.toolboxItems ?? []).filter((it) => !hub.isHidden(it.fqn)), ...hub.chosenItems] });
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
    const eng = await this.ensureEngine();
    const notes: string[] = [];
    const scannedFqns: string[] = []; // fqns from the just-browsed assemblies → auto-checked in the dialog
    let added = 0;
    let okCount = 0;
    for (const u of picked) {
      const base = path.basename(u.fsPath);
      try {
        const res = await scanToolboxAssembly(eng, u.fsPath);
        if (res.items.length) {
          added += res.items.length; okCount++;
          for (const c of res.items) scannedFqns.push(c.namespace ? c.namespace + '.' + c.name : c.name);
          if (!this.browsedDlls.includes(u.fsPath)) this.browsedDlls.push(u.fsPath);
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

  private fail(err: unknown): void {
    const msg = errMsg(err);
    // renderFailure:true distinguishes a real render failure (canvas is stale → the webview shows the persistent
    // "last successful preview" banner) from a failed user action routed through the generic onMessage catch
    // (canvas intact → the webview shows an unobtrusive footer status instead).
    this.post({ type: 'error', message: msg, renderFailure: true });
    this.output.appendLine('designer render failed: ' + msg);
    void vscode.window.showErrorMessage(t('host.error', { msg }));
  }

  private withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`${label} (no response after ${Math.round(ms / 1000)}s)`)), ms);
      p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
    });
  }

  /** Full re-render: PNG + layout → canvas + views, keep/repair selection, refresh the property panel. */
  private async fullRender(): Promise<void> {
    if (!this.designerFile || this.disposed) return;
    const seq = ++this.renderSeq;
    this.output.appendLine(`[designer] render #${seq} starting: ${this.designerFile}`);
    this.post({ type: 'loading', message: t('host.loading.starting') });

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
    const prevKind = this.engineKind;
    this.engineKind = route.kind;
    if (this.engineKind !== prevKind) {
      // the pre-render toolbox load may have cached a framework-only list under the old kind — drop it so the
      // toolbox re-enumerates on the correct engine (net48 → framework + project/vendor controls). See loadToolboxItems.
      this.toolboxItems = undefined;
      DesignerHub.instance.refreshStatus();
    }

    // A .NET Framework project with nothing built can't be rendered by either engine (net9 can't load a net4x
    // assembly; net48 needs the compiled output). Don't draw a misleading empty form — tell the user and offer
    // to point the designer at a built control source.
    if (route.frameworkUnbuilt) {
      this.output.appendLine(`[designer] render #${seq}: .NET Framework project not built — prompting for control source`);
      this.post({ type: 'error', message: t('host.frameworkUnbuilt'), renderFailure: true });
      this.promptControlSource(t('host.frameworkUnbuilt'));
      return;
    }

    let eng: EngineHandle;
    try {
      eng = await this.withTimeout(this.ensureEngine(this.engineKind), 12000, 'engine did not start (is the .NET SDK / dotnet on PATH?)');
    } catch (err) {
      if (seq === this.renderSeq && !this.disposed) this.fail(err);
      return;
    }
    if (seq !== this.renderSeq || this.disposed) return;
    // Toolbox: net9 shows framework + project controls (one enumeration); net48 merges net9 framework controls
    // with the project/vendor (DevExpress) controls the net48 engine enumerates (the net9 ALC can't load them).
    await this.loadToolboxItems();
    DesignerHub.instance.pushPanel(this, { type: 'toolbox', items: [...(this.toolboxItems ?? []).filter((it) => !DesignerHub.instance.isHidden(it.fqn)), ...DesignerHub.instance.chosenItems] });
    void this.refreshPalette();
    this.post({ type: 'loading', message: t('host.loading.rendering') });
    const text = await this.currentText();
    let result: Awaited<ReturnType<typeof renderWithLayout>>;
    try {
      result = this.engineKind === 'net48'
        ? await this.withTimeout(
            renderCompiledWithLayout(eng, this.designerFile, asm as string),
            20000, 'engine render timed out — it may be stuck (first-run)')
        : await this.withTimeout(
            renderWithLayout(eng, this.designerFile, asm, text),
            20000, 'engine render timed out — it may be stuck (first-run / MSBuild)');
    } catch (err) {
      if (seq === this.renderSeq && !this.disposed) this.fail(err);
      return;
    }
    if (seq !== this.renderSeq || this.disposed) return;
    this.output.appendLine(`[designer] render #${seq} ok: ${result.png.length}B, ${result.controls.length} controls`);

    this.controls = result.controls;
    this.rootClient = { w: result.clientWidth, h: result.clientHeight };
    this.rootFrame = { w: result.width, h: result.height };
    this.post({ type: 'render', png: result.png.toString('base64'), width: result.width, height: result.height, gen: seq });
    this.postLayout(result.controls);
    this.post({ type: 'tray', items: result.tray }); // component tray (canvas strip)
    if (!result.controls.some((c) => c.id === this.currentId)) this.currentId = 'this';
    this.pushSelect(this.currentId);
    await this.loadProps(this.currentId);
    await this.postDirty();
    this.pushClipboardState();
    this.maybePromptForControlSource(result.unrepresentable, asm);
    // T2.2: surface WHAT the (partial) render skipped — controls whose ctor threw, unresolved types, unsupported
    // constructs — as a dismissible canvas banner. The engine already renders resiliently and records each dropped
    // statement + reason in `unrepresentable`; categorize it host-side (pure) and hand the canvas a compact set.
    // Empty items → the webview hides any stale banner (this render is clean). net48's compiled render is all-or-
    // nothing, so this is effectively net9 partial-render diagnostics; net48 per-control skip reasons are a follow-up.
    this.post({ type: 'renderDiag', items: categorizeUnrepresentable(result.unrepresentable) });
  }

  /** If the form references controls the engine couldn't resolve (no assembly holds their type) AND no control
   *  source is set yet, prompt the user ONCE to point the designer at the project/assembly that provides them —
   *  the "you must specify a project to use your controls" guidance. Silent when a source is already chosen. */
  private maybePromptForControlSource(unrepresentable: string[] | undefined, asm: string | undefined): void {
    if (this.promptedForSource || asm) return; // already chose a source (or was told) → don't nag
    const unresolved = (unrepresentable ?? [])
      .map((u) => /unresolved type\)?\s+([\w.]+)/.exec(u)?.[1])
      .filter((t): t is string => !!t);
    if (!unresolved.length) return;
    // T1.3 cross-runtime fallback: a multi-target (net48;net9) project whose vendor controls the net9 engine
    // can't load → offer the net48 compiled preview (which instantiates the REAL controls) instead of the
    // generic "select a control source" prompt. Only when we auto-routed to net9 (asm undefined, checked above).
    if (this.engineKind === 'net9' && this.maybeOfferFrameworkPreview(unresolved)) return;
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
    const csproj = findNearestCsproj(path.dirname(this.designerFile));
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
   *  controls until it is. Tell the user to build it, or point at a control source manually. */
  private frameworkUnbuiltNotice(names: string): void {
    void vscode.window.showWarningMessage(t('host.crossRuntime.unbuilt', { names }), t('host.unresolved.button'))
      .then((pick) => { if (pick) void vscode.commands.executeCommand('winformsDesigner.selectControlAssembly'); });
  }

  /** Persist the net48 build output as this form's control source (survives reload → routes to the compiled
   *  preview) and re-render on the net48 engine. VS-parity one-click of the Select-Control-Assembly flow. */
  private async switchToFrameworkPreview(net48Out: string, names: string): Promise<void> {
    if (!this.designerFile || this.disposed) return;
    // The net48 output can be cleaned/rebuilt away between showing the offer and this click — getControlSource
    // drops a non-existent path on read, so persisting it would silently re-render the same near-empty net9 form
    // with no feedback (unlike selectControlAssembly, which re-checks existence). Guard + tell the user instead.
    if (!fs.existsSync(net48Out)) { this.frameworkUnbuiltNotice(names); return; }
    this.output.appendLine(`[designer] cross-runtime: switching to net48 compiled preview → ${net48Out}`);
    await this.setAssemblyOverride(this.designerFile, net48Out);
    await this.reloadControlSource(); // drops the cached toolbox + full-renders; routing now sees the net48 asm
    if (!this.disposed) DesignerHub.instance.refreshStatus(); // parity with selectControlAssembly's status refresh
  }

  /** Show the one-shot "point the designer at a control source" prompt — latched (`promptedForSource`) so a
   *  form asks at most once per session. Clicking the action opens the Select-Control-Assembly picker. */
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
  private resolveRouting(explicitAsm: string | undefined): { kind: EngineKind; asm: string | undefined; frameworkUnbuilt: boolean } {
    if (explicitAsm) return { kind: detectEngineKind(explicitAsm), asm: explicitAsm, frameworkUnbuilt: false };
    const csproj = this.designerFile ? findNearestCsproj(path.dirname(this.designerFile)) : null;
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
    return { kind: 'net9', asm: undefined, frameworkUnbuilt: false };
  }

  /** Describe the selected component → push its grid to the Properties view + its manipulability to the canvas. */
  private async loadProps(id: string): Promise<void> {
    if (!this.designerFile || this.disposed) return;
    if (this.engineKind === 'net48') { // compiled preview: describe the LIVE instance, not the net9 graph
      const asm48 = this.asm();
      let comp: ComponentDesc | null = null;
      if (asm48) {
        try { comp = await describeCompiledComponent(await this.ensureEngine('net48'), this.designerFile, asm48, id); }
        catch { comp = null; }
      }
      if (this.disposed) return;
      DesignerHub.instance.pushPanel(this, { type: 'props', id, component: comp });
      this.post({ type: 'tasks', id, component: comp }); // canvas smart-tag flyout data
      const manip = this.manipFor(id, comp); // single drag/resize is live (net9 splices Location/Size, net48 mutates)
      this.post({ type: 'manip', id, move: manip.move, resize: manip.resize });
      return;
    }
    const eng = await this.ensureEngine();
    const component = await describeComponent(eng, this.designerFile, id, this.asm(), await this.currentText());
    if (this.disposed) return;
    DesignerHub.instance.pushPanel(this, { type: 'props', id, component });
    this.post({ type: 'tasks', id, component }); // canvas smart-tag flyout data
    const manip = this.manipFor(id, component);
    this.post({ type: 'manip', id, move: manip.move, resize: manip.resize });
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
    if (dock && dock !== 'None') return { move: false, resize: false };
    if (c?.parentId) {
      const par = this.controls.find((x) => x.id === c.parentId);
      if (par && /TableLayoutPanel|FlowLayoutPanel/.test(par.type)) return { move: false, resize: false };
    }
    return { move: true, resize: String(val('AutoSize')) !== 'True' };
  }

  /** The container a toolbox-added control should go into: the selected Panel/GroupBox/… or the form. */
  private containerParentFor(id: string): string {
    const c = id ? this.controls.find((x) => x.id === id) : null;
    if (c && !c.isRoot && /Panel|GroupBox|TabPage|FlowLayoutPanel|TableLayoutPanel/.test(c.type)) return id;
    return 'this';
  }

  private async applyManipulate(id: string, mode: string, winX: number, winY: number, w: number, h: number): Promise<void> {
    if (!this.designerFile || this.disposed) return;
    const old = this.controls.find((c) => c.id === id);
    if (!old) return;
    if (id === 'this') {
      if (mode !== 'resize' || !this.rootClient) return;
      const nw = Math.max(1, this.rootClient.w + Math.round(w - old.width));
      const nh = Math.max(1, this.rootClient.h + Math.round(h - old.height));
      await this.applyEdit(id, 'ClientSize', 'System.Drawing.Size', false, `${nw}, ${nh}`);
      return;
    }
    if (mode === 'resize') {
      const movedTopLeft = Math.round(winX) !== Math.round(old.x) || Math.round(winY) !== Math.round(old.y);
      if (movedTopLeft) {
        const comp = await this.describeFor(id);
        const loc = parsePair(comp?.properties?.find((p) => p.name === 'Location')?.value);
        if (loc) {
          const nx = loc[0] + Math.round(winX - old.x);
          const ny = loc[1] + Math.round(winY - old.y);
          await this.applyEdits(id, [
            { prop: 'Location', propType: 'System.Drawing.Point', value: `${nx}, ${ny}` },
            { prop: 'Size', propType: 'System.Drawing.Size', value: `${Math.round(w)}, ${Math.round(h)}` },
          ]);
          return;
        }
      }
      await this.applyEdit(id, 'Size', 'System.Drawing.Size', false, `${Math.round(w)}, ${Math.round(h)}`);
    } else {
      const comp = await this.describeFor(id);
      const loc = parsePair(comp?.properties?.find((p) => p.name === 'Location')?.value);
      if (!loc) return;
      const nx = loc[0] + Math.round(winX - old.x);
      const ny = loc[1] + Math.round(winY - old.y);
      await this.applyEdit(id, 'Location', 'System.Drawing.Point', false, `${nx}, ${ny}`);
    }
  }

  /**
   * Move several controls together (multi-select group drag): each control's Location += the window-space
   * delta (its parent's origin is constant during a drag), chained into ONE undoable edit + a single
   * re-render. Controls without a representable Location (layout-managed) are skipped.
   */
  private async applyGroupMove(ids: string[], dx: number, dy: number): Promise<void> {
    if (!this.designerFile || this.disposed) return;
    const movable = ids.filter((id) => id && id !== 'this');
    if (!movable.length || (Math.round(dx) === 0 && Math.round(dy) === 0)) return;
    const eng = await this.ensureEngine();
    const before = this.doc.designerText;
    const rev = this.doc.rev;
    let text = before;
    const live48Edits: CompiledEdit[] = [];
    let applied = 0;
    for (const id of movable) {
      const comp = this.engineKind === 'net48' ? await this.describeFor(id) : await describeComponent(eng, this.designerFile, id, this.asm(), text);
      const loc = parsePair(comp?.properties?.find((p) => p.name === 'Location')?.value);
      if (!loc) continue; // layout-managed / no representable Location → skip
      const value = `${loc[0] + Math.round(dx)}, ${loc[1] + Math.round(dy)}`;
      const expr = await convertValue(eng, 'System.Drawing.Point', value);
      if (expr === null) continue;
      const res = await setProperty(eng, this.designerFile, id, 'Location', expr, text);
      if (res.safe && res.text !== null) { text = res.text; applied++; live48Edits.push({ componentId: id, propName: 'Location', rawValue: value }); }
    }
    if (!applied) { this.post({ type: 'status', message: t('status.nothingMoved') }); await this.loadProps(this.currentId); return; }
    if (this.doc.rev !== rev) { this.post({ type: 'status', message: t('status.docChanged') }); await this.loadProps(this.currentId); return; }
    this.commit(before, text, `Move ${applied} control${applied > 1 ? 's' : ''}`);
    this.output.appendLine(`moved ${applied} controls by (${Math.round(dx)}, ${Math.round(dy)}) (unsaved)`);
    if (this.engineKind === 'net48') await this.live48((e) => applyCompiledEdits(e, this.designerFile!, this.asm()!, live48Edits));
    else await this.fullRender();
    this.post({ type: 'status', message: tn('status.moved', applied) });
  }

  /**
   * Center-in-form (VS Format → Center Horizontally / Vertically): shift the selection's bounding box to the
   * center of its container's CLIENT area along one axis, preserving relative offsets (the same window-space
   * delta for every selected control → reuses applyAlign for the actual Location edits, so it's one undo,
   * cross-runtime, and layout-managed controls are skipped). Computed host-side because only the host knows the
   * form's exact client origin within the window chrome (asymmetric caption vs border) — a webview window-space
   * center would put a vertical center ~half-a-caption too high. The root client rect is exact; a child container
   * uses its window rect (its own client inset is a minor approximation, per the engine's ComputeWindowOffset).
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
    let cx: number, cy: number, cw: number, ch: number;
    if ((parentId === 'this' || parentId === '') && this.rootFrame && this.rootClient) {
      const ox = (this.rootFrame.w - this.rootClient.w) / 2;            // symmetric side borders
      const oy = (this.rootFrame.h - this.rootClient.h) - ox;          // caption = total vertical chrome − bottom border
      cx = ox; cy = oy; cw = this.rootClient.w; ch = this.rootClient.h;
    } else {
      const cont = this.controls.find((c) => c.id === parentId);
      if (!cont) return;
      cx = cont.x; cy = cont.y; cw = cont.width; ch = cont.height;
    }
    // bounding box of the selection (window space) → the single delta that centers it in the container
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const c of sel) { minX = Math.min(minX, c.x); minY = Math.min(minY, c.y); maxX = Math.max(maxX, c.x + c.width); maxY = Math.max(maxY, c.y + c.height); }
    const edits: Array<{ id: string; dx: number; dy: number }> = [];
    if (axis === 'h') {
      const dx = Math.round(cx + (cw - (maxX - minX)) / 2 - minX);
      if (dx !== 0) for (const c of sel) edits.push({ id: c.id, dx, dy: 0 });
    } else {
      const dy = Math.round(cy + (ch - (maxY - minY)) / 2 - minY);
      if (dy !== 0) for (const c of sel) edits.push({ id: c.id, dx: 0, dy });
    }
    if (edits.length) await this.applyAlign(edits);
  }

  /**
   * Align (Phase 2): apply a PER-CONTROL window-space delta to each control's Location (its parent origin is
   * constant), chained into ONE undoable edit + a single re-render — like applyGroupMove but with distinct
   * deltas. Layout-managed controls (no representable Location) are skipped.
   */
  private async applyAlign(edits: Array<{ id: string; dx: number; dy: number }>): Promise<void> {
    if (!this.designerFile || this.disposed) return;
    const wanted = edits.filter((e) => e.id && e.id !== 'this' && (Math.round(e.dx) !== 0 || Math.round(e.dy) !== 0));
    if (!wanted.length) return;
    const eng = await this.ensureEngine();
    const before = this.doc.designerText;
    const rev = this.doc.rev;
    let text = before;
    const live48Edits: CompiledEdit[] = [];
    let applied = 0;
    for (const e of wanted) {
      const comp = this.engineKind === 'net48' ? await this.describeFor(e.id) : await describeComponent(eng, this.designerFile, e.id, this.asm(), text);
      const loc = parsePair(comp?.properties?.find((p) => p.name === 'Location')?.value);
      if (!loc) continue; // layout-managed / no representable Location → skip
      const value = `${loc[0] + Math.round(e.dx)}, ${loc[1] + Math.round(e.dy)}`;
      const expr = await convertValue(eng, 'System.Drawing.Point', value);
      if (expr === null) continue;
      const res = await setProperty(eng, this.designerFile, e.id, 'Location', expr, text);
      if (res.safe && res.text !== null) { text = res.text; applied++; live48Edits.push({ componentId: e.id, propName: 'Location', rawValue: value }); }
    }
    if (!applied) { this.post({ type: 'status', message: t('status.nothingAligned') }); await this.loadProps(this.currentId); return; }
    if (this.doc.rev !== rev) { this.post({ type: 'status', message: t('status.docChanged') }); await this.loadProps(this.currentId); return; }
    this.commit(before, text, `Align ${applied} control${applied > 1 ? 's' : ''}`);
    this.output.appendLine(`aligned ${applied} controls (unsaved)`);
    if (this.engineKind === 'net48') await this.live48((ee) => applyCompiledEdits(ee, this.designerFile!, this.asm()!, live48Edits));
    else await this.fullRender();
    this.post({ type: 'status', message: tn('status.aligned', applied) });
  }

  /**
   * Make-same-size (Phase 2): apply a target Size to each control, chained into ONE undoable edit + a single
   * re-render — like applyAlign but writing Size instead of Location. Layout-managed controls (no representable
   * Size assignment anchor) are skipped by the engine's targeted-edit gate.
   */
  private async applyResize(edits: Array<{ id: string; width: number; height: number }>): Promise<void> {
    if (!this.designerFile || this.disposed) return;
    const wanted = edits.filter((e) => e.id && e.id !== 'this' && Math.round(e.width) > 0 && Math.round(e.height) > 0);
    if (!wanted.length) return;
    const eng = await this.ensureEngine();
    const before = this.doc.designerText;
    const rev = this.doc.rev;
    let text = before;
    const live48Edits: CompiledEdit[] = [];
    let applied = 0;
    for (const e of wanted) {
      const value = `${Math.round(e.width)}, ${Math.round(e.height)}`;
      const expr = await convertValue(eng, 'System.Drawing.Size', value);
      if (expr === null) continue;
      const res = await setProperty(eng, this.designerFile, e.id, 'Size', expr, text);
      if (res.safe && res.text !== null) { text = res.text; applied++; live48Edits.push({ componentId: e.id, propName: 'Size', rawValue: value }); }
    }
    if (!applied) { this.post({ type: 'status', message: t('status.nothingResized') }); await this.loadProps(this.currentId); return; }
    if (this.doc.rev !== rev) { this.post({ type: 'status', message: t('status.docChanged') }); await this.loadProps(this.currentId); return; }
    this.commit(before, text, `Resize ${applied} control${applied > 1 ? 's' : ''}`);
    this.output.appendLine(`resized ${applied} controls (unsaved)`);
    if (this.engineKind === 'net48') await this.live48((ee) => applyCompiledEdits(ee, this.designerFile!, this.asm()!, live48Edits));
    else await this.fullRender();
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
    this.commit(before, text, `Remove ${applied} control${applied > 1 ? 's' : ''}`);
    this.currentId = 'this';
    this.output.appendLine(`removed ${applied} controls (unsaved)`);
    if (this.engineKind === 'net48') await this.live48((e) => removeCompiledControls(e, this.designerFile!, this.asm()!, removed));
    else await this.fullRender();
    this.post({ type: 'status', message: tn('status.removed', applied) });
  }

  /** Grid edit from the Properties view, with its own error/restore handling. */
  async editFromGrid(id: string, prop: string, propType: string, isEnum: boolean, value: string): Promise<void> {
    try {
      await this.applyEdit(id, prop, propType, isEnum, value);
    } catch (err) {
      this.post({ type: 'status', message: errMsg(err) });
      try { await this.loadProps(id); } catch { /* best effort */ }
    }
  }

  private async applyEdit(id: string, prop: string, propType: string, isEnum: boolean, raw: string): Promise<void> {
    if (!this.designerFile) return;

    if (COMPLEX_TYPE_SET.has(propType) && raw.trim() === '') {
      this.post({ type: 'status', message: t('status.enterValue', { type: shortName(propType) }) });
      await this.loadProps(id);
      return;
    }

    const eng = await this.ensureEngine();

    let expr: string | null;
    if (COMPLEX_TYPE_SET.has(propType)) {
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

    const before = this.doc.designerText;
    const revBefore = this.doc.rev;

    const res = await setProperty(eng, this.designerFile, id, prop, expr, before);
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

    this.commit(before, finalText, `Set ${id}.${prop}`);
    this.output.appendLine(`set ${id}.${prop} = ${expr} (${res.mode}, unsaved)`);
    this.post({ type: 'status', message: t('status.propSet', { id, prop }) });

    // net9 re-renders the interpreted graph from the edited text; net48 can't (it renders the compiled assembly),
    // so it mutates the LIVE instance for an immediate picture — the text edit above is what persists on save.
    if (this.engineKind === 'net48') {
      await this.liveEdit48(id, prop, raw);
    } else {
      await this.patchOrRerender(id, prop);
    }
    await this.loadProps(id);
    await this.postDirty();
  }

  /** net48 compiled preview: after the text edit is committed, mutate the live instance so the picture updates
   *  immediately (the net9 interpreter path can't render this DevExpress/Framework control). Best-effort — an
   *  unconvertible/read-only value leaves the picture on the built value with a note; the committed text still
   *  renders after a rebuild. */
  private async liveEdit48(id: string, prop: string, raw: string): Promise<void> {
    const asm = this.asm();
    if (!asm || !this.designerFile) return;
    await this.live48((eng) => setCompiledPropertyLive(eng, this.designerFile!, asm, id, prop, raw));
  }

  /** net48 compiled preview for a typed "…" collection edit: after the text edit is committed, reconstruct the
   *  collection (string Items / ListView.Columns / DataGridView.Columns) on the live instance so the canvas updates
   *  immediately (T1.1b) instead of showing the built collection until a rebuild. Best-effort — a bound/unsupported
   *  collection leaves the picture on the built value with a note (show48's previewPartial); the committed text still
   *  renders after a rebuild. */
  private async liveCollection48(id: string, prop: string, itemType: string, items: LiveCollItem[]): Promise<void> {
    const asm = this.asm();
    if (!asm || !this.designerFile) return;
    await this.live48((eng) => setCompiledCollectionLive(eng, this.designerFile!, asm, id, prop, itemType, items));
  }

  /** net48 compiled preview for the hierarchical TreeView.Nodes edit: after the net9 text commit, reconstruct the
   *  node forest on the live instance so the canvas updates immediately (the TreeView analogue of liveCollection48).
   *  Best-effort — a non-TreeNodeCollection Nodes (a DevExpress TreeList) leaves the picture on the built tree with a
   *  note (show48's previewPartial); the committed text still renders after a rebuild. */
  private async liveTreeNodes48(id: string, prop: string, nodes: TreeNodeItem[]): Promise<void> {
    const asm = this.asm();
    if (!asm || !this.designerFile) return;
    await this.live48((eng) => setCompiledTreeNodesLive(eng, this.designerFile!, asm, id, prop, nodes));
  }

  /** Push a net48 live-op's render result to the canvas (shared by property edit / drag / remove / z-order). */
  private show48(res: RenderLayout, seq: number): void {
    if (seq !== this.renderSeq || this.disposed) return;
    this.controls = res.controls;
    this.rootClient = { w: res.clientWidth, h: res.clientHeight };
    this.rootFrame = { w: res.width, h: res.height };
    this.post({ type: 'render', png: res.png.toString('base64'), width: res.width, height: res.height, gen: seq });
    this.postLayout(res.controls);
    this.post({ type: 'tray', items: res.tray });
    if (res.applied === false) {
      this.post({ type: 'status', message: t('status.previewPartial', { diag: res.diagnostics || 'some edits not applied live' }) });
    }
  }

  /** Run a net48 live-op (already text-committed by net9) with the session's net48 engine and render its result. */
  private async live48(op: (eng: EngineHandle) => Promise<RenderLayout>): Promise<void> {
    if (!this.designerFile || !this.asm()) return;
    const seq = ++this.renderSeq;
    try {
      const res = await op(await this.ensureEngine('net48'));
      this.show48(res, seq);
    } catch (err) {
      this.post({ type: 'status', message: errMsg(err) });
    }
  }

  /** Describe a component from the engine that owns this session (net48 live instance, or the net9 graph). */
  private async describeFor(id: string): Promise<ComponentDesc | null> {
    if (!this.designerFile) return null;
    const asm = this.asm();
    if (this.engineKind === 'net48') {
      if (!asm) return null;
      try { return await describeCompiledComponent(await this.ensureEngine('net48'), this.designerFile, asm, id); }
      catch { return null; }
    }
    return describeComponent(await this.ensureEngine(), this.designerFile, id, asm, await this.currentText());
  }

  /** The sibling .resx for the current designer file (Foo.Designer.cs / Foo.cs → Foo.resx). */
  private resxUri(): vscode.Uri {
    const f = this.designerFile!;
    const base = /\.Designer\.cs$/i.test(f) ? f.slice(0, -'.Designer.cs'.length)
      : /\.cs$/i.test(f) ? f.slice(0, -'.cs'.length) : f;
    return vscode.Uri.file(base + '.resx');
  }

  /** Read a text file's UTF-8 content (BOM stripped), or null when it doesn't exist. */
  private async readTextIfExists(uri: vscode.Uri): Promise<string | null> {
    try {
      const b = await vscode.workspace.fs.readFile(uri);
      let s = Buffer.from(b).toString('utf8');
      if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1); // strip a leading BOM so the XML parser is happy
      return s;
    } catch { return null; } // ENOENT → no .resx yet (the engine creates one)
  }

  /**
   * Import an image into a resx-backed image/icon property ("Import…"): pick a file, embed it into the form's
   * sibling .resx and write the `resources.GetObject` assignment. The .resx is written to disk immediately (a
   * resource file, like VS); the .Designer.cs edit is the undoable in-memory thing. On undo, the assignment
   * reverts and the image drops from the render; the .resx entry is left as a harmless orphan.
   */
  async importImageFromGrid(id: string, prop: string, propType: string): Promise<void> {
    if (!this.designerFile) return;
    const isIcon = propType === 'System.Drawing.Icon';
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false, openLabel: 'Import',
      title: `Import ${isIcon ? 'an icon' : 'an image'} for ${id}.${prop}`,
      filters: isIcon ? { Icons: ['ico'] } : { Images: ['png', 'jpg', 'jpeg', 'bmp', 'gif'] },
    });
    if (!picked || !picked.length) return; // cancelled
    try {
      const bytes = await vscode.workspace.fs.readFile(picked[0]);
      if (bytes.byteLength > 16 * 1024 * 1024) { this.post({ type: 'status', message: t('status.imageTooLarge') }); return; }
      const imageBase64 = Buffer.from(bytes).toString('base64');
      const eng = await this.ensureEngine();
      const resxUri = this.resxUri();
      const resxText = await this.readTextIfExists(resxUri);
      const before = this.doc.designerText;
      const revBefore = this.doc.rev;

      const res = await setImageResource(eng, this.designerFile, id, prop, propType, imageBase64, resxText, before);
      if (!res.safe || res.designerText === null || res.resxText === null) {
        this.post({ type: 'status', message: t('status.importRejected', { reason: res.reason || 'unsafe' }) });
        await this.loadProps(id);
        return;
      }
      if (this.doc.rev !== revBefore) {
        this.post({ type: 'status', message: t('status.docChangedImport') });
        await this.loadProps(id);
        return;
      }

      // write the .resx to disk FIRST (the engine reads it from disk on render), then commit the designer edit.
      await vscode.workspace.fs.writeFile(resxUri, Buffer.from(res.resxText, 'utf8'));
      this.commit(before, res.designerText, `Import ${id}.${prop} image`);
      this.output.appendLine(`imported image into ${id}.${prop} → ${res.resxKey} (${res.mode}; .resx written, designer unsaved)`);
      this.post({ type: 'status', message: t('status.imageImported', { id, prop }) });

      await this.fullRender(); // a new resx image + assignment → full re-render (not a single-control patch)
      await this.loadProps(id);
      await this.postDirty();
    } catch (err) {
      this.post({ type: 'status', message: t('status.importFailed', { error: errMsg(err) }) });
      try { await this.loadProps(id); } catch { /* best effort */ }
    }
  }

  /** Clear an image property ("(none)"): delete its assignment via the safe-save-gated ResetProperty. The .resx
   *  entry is left as a harmless orphan (mirrors VS, which also doesn't prune unused resources on clear). */
  async clearImageFromGrid(id: string, prop: string): Promise<void> {
    if (!this.designerFile) return;
    try {
      const eng = await this.ensureEngine();
      const before = this.doc.designerText;
      const revBefore = this.doc.rev;
      const res = await resetProperty(eng, this.designerFile, id, prop, before);
      if (!res.safe) { this.post({ type: 'status', message: t('status.clearRejected', { reason: res.reason || 'unsafe' }) }); await this.loadProps(id); return; }
      if (res.text == null) { this.post({ type: 'status', message: t('status.alreadyNone', { id, prop }) }); await this.loadProps(id); return; }
      if (this.doc.rev !== revBefore) { this.post({ type: 'status', message: t('status.docChangedShort') }); await this.loadProps(id); return; }
      this.commit(before, res.text, `Clear ${id}.${prop} image`);
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

  /** Per-property Reset (VS grid right-click → "Reset"): delete the property's source assignment via the
   *  safe-save-gated, no-op-safe ResetProperty (a pure net9 text splice, engine-agnostic), then refresh the picture.
   *  net9 re-renders the interpreted graph from the edited text; net48 renders the COMPILED assembly (stale after a
   *  text-only edit), so it resets the LIVE instance (pd.ResetValue) for an immediate, matching picture. */
  async resetFromGrid(id: string, prop: string): Promise<void> {
    if (!this.designerFile) return;
    try {
      const eng = await this.ensureEngine();
      const before = this.doc.designerText;
      const revBefore = this.doc.rev;
      const res = await resetProperty(eng, this.designerFile, id, prop, before);
      if (!res.safe) { this.post({ type: 'status', message: t('status.resetRejected', { reason: res.reason || 'unsafe' }) }); await this.loadProps(id); return; }
      if (res.text == null) { this.post({ type: 'status', message: t('status.alreadyDefault', { id, prop }) }); await this.loadProps(id); return; }
      if (this.doc.rev !== revBefore) { this.post({ type: 'status', message: t('status.docChangedShort') }); await this.loadProps(id); return; }
      this.commit(before, res.text, `Reset ${id}.${prop}`);
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

  /** net48 compiled preview after a Reset commit: reset the property on the LIVE instance (pd.ResetValue) so the
   *  picture matches the now-default value. Re-rendering the compiled assembly would show the stale built value
   *  (the bug clearImageFromGrid's fullRender exhibits); the committed text is what persists after a rebuild.
   *  Best-effort — a non-resettable prop leaves the picture unchanged with a note. */
  private async liveReset48(id: string, prop: string): Promise<void> {
    const asm = this.asm();
    if (!asm || !this.designerFile) return;
    await this.live48((eng) => resetCompiledPropertyLive(eng, this.designerFile!, asm, id, prop));
  }

  /** Grid edit of a TableLayoutPanel child's Column/Row — routed here (not applyEdit) because the cell lives in
   *  the 3-arg Controls.Add, not a property assignment. Mirrors editFromGrid's error/restore handling. */
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
    const eng = await this.ensureEngine();
    const before = this.doc.designerText;
    const revBefore = this.doc.rev;

    const column = cell === 'Column' ? n : null;
    const row = cell === 'Row' ? n : null;
    const res = await setTableCell(eng, this.designerFile, id, column, row, before);
    if (!res.safe || res.text === null) {
      this.post({ type: 'status', message: t('status.cellEditRejected', { reason: res.reason || 'unsafe' }) });
      await this.loadProps(id);
      return;
    }
    if (this.doc.rev !== revBefore) {
      this.post({ type: 'status', message: t('status.docChanged') });
      await this.loadProps(id);
      return;
    }

    this.commit(before, res.text, `Set ${id}.${cell}`);
    this.output.appendLine(`set ${id}.${cell} = ${n} (table cell, unsaved)`);
    this.post({ type: 'status', message: t('status.cellSet', { id, cell }) });

    // a cell move repositions the control and can re-flow its siblings → full re-render, not a single-control patch
    await this.fullRender();
    await this.loadProps(id);
    await this.postDirty();
  }

  /** Read side of the string-collection editor: send the "…"-opened collection's current items to the webview.
   *  Parses the unsaved buffer (so it reflects pending edits). PURE-TEXT Roslyn parse → routed to the net9 engine
   *  even for a net48 form (the compiled engine can't parse literal Add/AddRange; the text is framework-agnostic). */
  async sendCollectionItems(id: string, prop: string): Promise<void> {
    if (!this.designerFile) {
      this.post({ type: 'collectionItems', id, prop, ok: false, items: [], reason: 'not available' });
      return;
    }
    try {
      const eng = await this.ensureEngine('net9');
      const res = await listCollectionItems(eng, this.designerFile, id, prop, this.doc.designerText);
      this.post({ type: 'collectionItems', id, prop, ok: res.ok, items: res.items ?? [], reason: res.reason });
    } catch (err) {
      this.post({ type: 'collectionItems', id, prop, ok: false, items: [], reason: errMsg(err) });
    }
  }

  /** Write side of the string-collection editor (VS "String Collection Editor"): rewrite the owner's Add/AddRange
   *  calls to exactly `items`. Mirrors tableCellFromGrid's error/restore + single-undo commit. */
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
    const eng = await this.ensureEngine('net9');
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

    this.commit(before, res.text, `Set ${id}.${prop}`);
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

  /** Read side of the typed ListView.Columns editor: send the "…"-opened collection's current columns to the
   *  webview. Parses the unsaved buffer. PURE-TEXT → routed to the net9 engine even for a net48 form. */
  async sendColumnItems(id: string): Promise<void> {
    if (!this.designerFile) {
      this.post({ type: 'columnItems', id, ok: false, columns: [], reason: 'not available' });
      return;
    }
    try {
      const eng = await this.ensureEngine('net9');
      const res = await listColumns(eng, this.designerFile, id, this.doc.designerText);
      this.post({ type: 'columnItems', id, ok: res.ok, columns: res.columns ?? [], reason: res.reason });
    } catch (err) {
      this.post({ type: 'columnItems', id, ok: false, columns: [], reason: errMsg(err) });
    }
  }

  /** Write side of the typed ListView.Columns editor (VS "Collection Editor"). Mirrors collectionFromGrid's
   *  error/restore + single-undo commit. */
  async columnsFromGrid(id: string, columns: ColumnItem[]): Promise<void> {
    try {
      await this.applyColumns(id, columns);
    } catch (err) {
      this.post({ type: 'status', message: errMsg(err) });
      try { await this.loadProps(id); } catch { /* best effort */ }
    }
  }

  private async applyColumns(id: string, columns: ColumnItem[]): Promise<void> {
    if (!this.designerFile) return;
    const eng = await this.ensureEngine('net9'); // PURE-TEXT splice — net9 even on a net48 form
    const before = this.doc.designerText;
    const revBefore = this.doc.rev;

    const res = await setColumns(eng, this.designerFile, id, columns, before);
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

    this.commit(before, res.text, `Set ${id}.Columns`);
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
  }

  /** Read side of the hierarchical TreeView.Nodes editor. Parses the unsaved buffer. PURE-TEXT → net9 even on net48. */
  async sendTreeNodes(id: string): Promise<void> {
    if (!this.designerFile) {
      this.post({ type: 'treeNodeItems', id, ok: false, nodes: [], reason: 'not available' });
      return;
    }
    try {
      const eng = await this.ensureEngine('net9');
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
    const eng = await this.ensureEngine('net9'); // PURE-TEXT splice — net9 even on a net48 form
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

    this.commit(before, res.text, `Set ${id}.Nodes`);
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

  /** Read side of the typed DataGridView.Columns editor. Parses the unsaved buffer. PURE-TEXT → net9 even on net48. */
  async sendGridColumnItems(id: string): Promise<void> {
    if (!this.designerFile) {
      this.post({ type: 'gridColumnItems', id, ok: false, columns: [], reason: 'not available' });
      return;
    }
    try {
      const eng = await this.ensureEngine('net9');
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
    const eng = await this.ensureEngine('net9'); // PURE-TEXT splice — net9 even on a net48 form
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

    this.commit(before, res.text, `Set ${id}.Columns`);
    this.output.appendLine(`set ${id}.Columns = ${columns.length} column(s) (grid collection, unsaved)`);
    this.post({ type: 'status', message: t('status.propSet', { id, prop: 'Columns' }) });
    if (this.engineKind === 'net48') {
      // reconstruct the DataGridView.Columns on the live instance for an immediate net48 picture (T1.1b)
      await this.liveCollection48(id, 'Columns', 'System.Windows.Forms.DataGridViewColumn',
        columns.map((c) => ({ id: c.id, text: c.headerText, width: c.width, readOnly: c.readOnly, visible: c.visible })));
    } else {
      await this.fullRender();
    }
    await this.loadProps(id);
    await this.postDirty();
  }

  private async applyEdits(id: string, edits: Array<{ prop: string; propType: string; value: string }>): Promise<void> {
    if (!this.designerFile || !edits.length) return;
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
    this.commit(before, text, `Set ${id} (${edits.length} properties)`);
    this.output.appendLine(`set ${id} ${edits.map((e) => e.prop).join('+')} (${edits.length} edits, unsaved)`);
    if (this.engineKind === 'net48') {
      await this.live48((e) => applyCompiledEdits(e, this.designerFile!, this.asm()!,
        edits.map((ed) => ({ componentId: id, propName: ed.prop, rawValue: ed.value }))));
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

  private async saveDesigner(): Promise<void> {
    if (!this.designerFile || !this.doc.isDirty) return;
    // Route through VS Code's Save so the custom editor's NATIVE dirty state clears (→ saveCustomDocument,
    // which writes the .Designer.cs). The canvas webview is part of the active editor, so this targets it.
    try { await vscode.commands.executeCommand('workbench.action.files.save'); }
    catch (err) { this.post({ type: 'status', message: t('status.saveFailed', { error: errMsg(err) }) }); }
  }

  private codeFile(): string | null {
    if (!this.designerFile) return null;
    const m = /\.Designer\.cs$/i.exec(this.designerFile);
    const partner = m ? this.designerFile.slice(0, m.index) + '.cs' : this.designerFile;
    return fs.existsSync(partner) ? partner : null;
  }

  async navigateToHandler(id: string, eventName: string, handler: string | undefined): Promise<void> {
    if (this.disposed || !this.designerFile) return;
    if (handler) { await this.openHandlerAt(this.codeFile(), handler); return; }
    await this.createHandler(id, eventName);
  }

  async createHandler(id: string, eventName: string, handlerName?: string): Promise<void> {
    if (!this.designerFile) return;
    const codePath = this.codeFile();
    if (!codePath) { this.post({ type: 'status', message: t('status.noCodeBehindHandler') }); return; }
    const eng = await this.ensureEngine();

    const designerBefore = this.doc.designerText;
    const designerRev = this.doc.rev;

    let codeDoc: vscode.TextDocument;
    try { codeDoc = await vscode.workspace.openTextDocument(codePath); }
    catch { this.post({ type: 'status', message: t('status.cannotOpen', { file: path.basename(codePath) }) }); return; }
    const codeBefore = codeDoc.getText();
    const codeVer = codeDoc.version;

    const gen = await generateEventHandler(eng, this.designerFile, id, eventName, handlerName ?? null, designerBefore, codeBefore, this.asm() ?? null);
    if (!gen.safe) { this.post({ type: 'status', message: t('status.createHandlerRejected', { reason: gen.reason || 'unsafe' }) }); return; }
    if (this.disposed) return;

    if (this.doc.rev !== designerRev || codeDoc.version !== codeVer) {
      this.post({ type: 'status', message: t('status.docChanged') });
      return;
    }

    // Apply the code-behind .cs stub FIRST (a real text edit the user reads/writes); only then commit the
    // in-memory .Designer.cs wiring — so we never wire an event to a handler stub that failed to write.
    if (gen.codeText != null) {
      const edit = new vscode.WorkspaceEdit();
      edit.replace(codeDoc.uri, new vscode.Range(codeDoc.positionAt(0), codeDoc.positionAt(codeBefore.length)), gen.codeText);
      if (!(await vscode.workspace.applyEdit(edit))) { this.post({ type: 'status', message: t('status.couldNotWriteStub') }); return; }
      if (this.doc.rev !== designerRev) { this.post({ type: 'status', message: t('status.docChanged') }); return; }
    }
    if (gen.designerText != null) this.commit(designerBefore, gen.designerText, `Wire ${id}.${eventName}`);

    this.output.appendLine(`created handler ${gen.handlerName} for ${id}.${eventName}${gen.alreadyWired ? ' (already wired)' : ''} (unsaved)`);
    await this.loadProps(id);
    await this.postDirty();
    await this.openHandlerAt(codePath, gen.handlerName);
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
    const codePath = this.codeFile();
    if (!codePath) { DesignerHub.instance.pushPanel(this, { type: 'candidates', id, map: {} }); return; }
    try {
      const eng = await this.ensureEngine();
      const codeText = (await vscode.workspace.openTextDocument(codePath)).getText();
      const map = await listHandlerCandidates(eng, this.designerFile, id, (await this.currentText()) ?? null, codeText, this.asm() ?? null);
      if (this.disposed) return;
      DesignerHub.instance.pushPanel(this, { type: 'candidates', id, map });
    } catch {
      DesignerHub.instance.pushPanel(this, { type: 'candidates', id, map: {} });
    }
  }

  async setHandler(id: string, event: string, value: string): Promise<void> {
    if (value === NEW_HANDLER) { await this.createHandler(id, event); return; }
    await this.applyEventWiring(id, event, value === '' ? null : value);
  }

  private async applyEventWiring(id: string, event: string, handler: string | null): Promise<void> {
    if (!this.designerFile || this.disposed) return;
    const eng = await this.ensureEngine();
    const codePath = this.codeFile();
    const codeText = codePath ? (await vscode.workspace.openTextDocument(codePath)).getText() : null;

    const before = this.doc.designerText;
    const rev = this.doc.rev;

    const res = await setEventWiring(eng, this.designerFile, id, event, handler, before, codeText, this.asm() ?? null);
    if (!res.safe || res.designerText == null) {
      this.post({ type: 'status', message: t('status.wiringRejected', { reason: res.reason || 'unsafe' }) });
      await this.loadProps(id);
      return;
    }
    if (this.doc.rev !== rev) {
      this.post({ type: 'status', message: t('status.docChanged') });
      await this.loadProps(id);
      return;
    }
    this.commit(before, res.designerText, `${handler ? 'Wire' : 'Unwire'} ${id}.${event}`);
    this.output.appendLine(`${handler ? 'wired' : 'unwired'} ${id}.${event}${handler ? ' → ' + handler : ''} (unsaved)`);
    this.post({ type: 'status', message: handler ? t('status.wired', { event, handler }) : t('status.unwired', { event }) });
    await this.loadProps(id);
    await this.postDirty();
  }

  /** Toolbox click: add a control into the active session's selected container (or the form). */
  async addControlFromToolbox(controlType: string): Promise<void> {
    await this.applyAddControl(controlType, this.containerParentFor(this.currentId));
  }

  private async applyAddControl(controlType: string, parentId: string, dropX?: number, dropY?: number): Promise<void> {
    if (!this.designerFile || this.disposed) return;
    const eng = await this.ensureEngine();
    const before = this.doc.designerText;
    const rev = this.doc.rev;
    let locX: number | undefined;
    let locY: number | undefined;
    if (dropX !== undefined && dropY !== undefined) {
      if ((parentId === 'this' || parentId === '') && this.rootFrame && this.rootClient) {
        const ox = (this.rootFrame.w - this.rootClient.w) / 2;
        const oy = (this.rootFrame.h - this.rootClient.h) - ox;
        locX = Math.max(0, Math.round(dropX - ox));
        locY = Math.max(0, Math.round(dropY - oy));
      } else {
        const par = this.controls.find((c) => c.id === parentId);
        locX = Math.max(0, Math.round(dropX - (par ? par.x : 0)));
        locY = Math.max(0, Math.round(dropY - (par ? par.y : 0)));
      }
    }
    const asm = this.asm();
    // The Roslyn text splice runs on net9. For a net48 form net9 can't load the vendor (DevExpress/net4x)
    // assembly, so instead of an asm-based enumeration we hand it the FQNs the net48 engine enumerated —
    // the pure-text splice emits `new <Fqn>()` and the net48 engine live-instantiates the control below.
    const addAsm = this.engineKind === 'net48' ? undefined : asm;
    const projectFqns = this.engineKind === 'net48'
      ? (this.toolboxItems ?? []).filter((it) => it.fromProject).map((it) => it.fqn)
      : undefined;
    const res = await addControl(eng, this.designerFile, parentId || 'this', controlType, before, locX, locY, addAsm, projectFqns);
    if (!res.safe || res.newText === null) { this.post({ type: 'status', message: t('status.addRejected', { reason: res.reason || 'unsafe' }) }); return; }
    if (this.doc.rev !== rev) { this.post({ type: 'status', message: t('status.docChanged') }); return; }
    this.commit(before, res.newText, `Add ${controlType}`);
    this.currentId = res.name;
    this.output.appendLine(`added ${controlType} → ${res.name} (unsaved)`);
    if (this.engineKind === 'net48') await this.live48((e) => addCompiledControl(e, this.designerFile!, asm!, parentId || 'this', controlType, res.name, locX, locY));
    else await this.fullRender();
    this.post({ type: 'status', message: t('status.added', { name: res.name }) });
    // A control from the chosen control-source assembly won't compile until the project references it — offer to add
    // one. net48-only skip: its project controls live in the form's OWN compiled assembly, so no <Reference> is needed.
    if (this.engineKind !== 'net48') await this.maybeOfferProjectReference(controlType, asm);
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
      const item = [...(this.toolboxItems ?? []), ...DesignerHub.instance.chosenItems]
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
   *  undoable edit (a HintPath relative to the project, like VS's "Add Reference → Browse"). Saves the file
   *  only when it wasn't already dirty — so the reference takes effect without flushing the user's unrelated
   *  in-progress .csproj edits to disk. */
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
   *  No parent/position (unlike a control); mirrors applyAddControl's commit/rerender. */
  async addComponentFromToolbox(componentType: string): Promise<void> {
    if (!this.designerFile || this.disposed) return;
    const eng = await this.ensureEngine();
    const before = this.doc.designerText;
    const rev = this.doc.rev;
    const res = await addComponent(eng, this.designerFile, componentType, before);
    if (!res.safe || res.newText === null) { this.post({ type: 'status', message: t('status.addRejected', { reason: res.reason || 'unsafe' }) }); return; }
    if (this.doc.rev !== rev) { this.post({ type: 'status', message: t('status.docChanged') }); return; }
    this.commit(before, res.newText, `Add ${componentType}`);
    this.currentId = res.name;
    this.output.appendLine(`added component ${componentType} → ${res.name} (unsaved)`);
    await this.fullRender();
    this.post({ type: 'status', message: t('status.addedTray', { name: res.name }) });
  }

  private async applyRemoveControl(id: string): Promise<void> {
    if (!this.designerFile || this.disposed || id === 'this') return;
    const eng = await this.ensureEngine();
    const before = this.doc.designerText;
    const rev = this.doc.rev;
    const res = await removeControl(eng, this.designerFile, id, before);
    if (!res.safe || res.newText === null) { this.post({ type: 'status', message: t('status.removeRejected', { reason: res.reason || 'unsafe' }) }); return; }
    if (this.doc.rev !== rev) { this.post({ type: 'status', message: t('status.docChanged') }); return; }
    this.commit(before, res.newText, `Remove ${id}`);
    this.currentId = 'this';
    this.output.appendLine(`removed ${id} (unsaved)`);
    if (this.engineKind === 'net48') await this.live48((e) => removeCompiledControls(e, this.designerFile!, this.asm()!, [id]));
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
   *  resulting undo entry is just the removal. Controls the engine refuses to copy are not deleted either. */
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
    // For the net48 compiled preview, mirror each accepted paste by live-instantiating the clone (the net9 text
    // splice below isn't in the compiled instance). It comes up default-styled at the pasted Location, exactly like
    // Add; a project rebuild reconciles the copied property values (net48's text-is-truth / picture-best-effort).
    const live48Adds: { typeName: string; name: string; x: number; y: number }[] = [];
    for (const c of clip.clips) {
      const res = await pasteControl(eng, this.designerFile, c, parent, text);
      if (res.safe && res.newText !== null) {
        text = res.newText; last = res.name; applied++;
        if (this.engineKind === 'net48' && res.typeName) live48Adds.push({ typeName: res.typeName, name: res.name, x: res.x, y: res.y });
      }
    }
    if (!applied) { this.post({ type: 'status', message: t('status.pasteRejected') }); return; }
    if (this.doc.rev !== rev) { this.post({ type: 'status', message: t('status.docChanged') }); return; }
    this.commit(before, text, `Paste ${applied} control${applied > 1 ? 's' : ''}`);
    this.currentId = last || this.currentId;
    this.output.appendLine(`pasted ${applied} control(s) into ${parent} (unsaved)`);
    let net48Stale = false;
    if (this.engineKind === 'net48') {
      // If the control assembly went away mid-session the live picture can't be updated — the text/undo state is
      // still truthful (net48's text-is-truth contract), so say so instead of a plain "unsaved" that implies the
      // preview reflects the paste.
      if (live48Adds.length && !this.asm()) net48Stale = true;
      else for (const a of live48Adds) {
        await this.live48((e) => addCompiledControl(e, this.designerFile!, this.asm()!, parent, a.typeName, a.name, a.x >= 0 ? a.x : undefined, a.y >= 0 ? a.y : undefined));
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
    this.commit(before, text, `Duplicate ${applied} control${applied > 1 ? 's' : ''}`);
    this.currentId = last || this.currentId;
    this.output.appendLine(`duplicated ${applied} control(s) (unsaved)`);
    let net48Stale = false;
    if (this.engineKind === 'net48') {
      if (live48Adds.length && !this.asm()) net48Stale = true;
      else {
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
    this.commit(before, text, toFront ? 'Bring to Front' : 'Send to Back');
    this.output.appendLine(`${toFront ? 'brought to front' : 'sent to back'} ${applied} control(s) (unsaved)`);
    if (this.engineKind === 'net48') await this.live48((e) => setCompiledZOrder(e, this.designerFile!, this.asm()!, targets, toFront));
    else await this.fullRender();
    this.post({ type: 'status', message: toFront ? t('status.broughtFront') : t('status.sentBack') });
  }

  /**
   * A click that landed on a tab host (net48 compiled preview): ask the engine to switch the active tab to the
   * header under (x,y). If it switched, the live re-render shows the newly-active tab's controls (the hidden-tab
   * filter then exposes them); if the point wasn't on another tab's header it's a harmless no-op re-render, and the
   * normal `pick` (sent alongside by the webview) still selects the tab host.
   */
  private async applyTabClick(hostId: string, x: number, y: number): Promise<void> {
    if (this.disposed || this.engineKind !== 'net48') return; // net9 tab-switching is a future parity item
    const asm = this.asm();
    if (!asm) return;
    await this.live48((e) => selectCompiledTabAt(e, this.designerFile!, asm, hostId, Math.round(x), Math.round(y)));
  }

  /**
   * Double-click on a tab header (net48 compiled preview): find the tab page under (x,y), prompt for a new caption,
   * and rename it by editing that page's Text through the normal edit path (net9 splices `this.<page>.Text = "…"`,
   * net48 updates the live picture). A no-op if the point wasn't on a field-backed tab header.
   */
  private async applyTabRename(hostId: string, x: number, y: number): Promise<void> {
    if (this.disposed || this.engineKind !== 'net48') return; // net9 uses the property grid to rename a tab
    const asm = this.asm();
    if (!asm) return;
    let hit;
    try { hit = await hitTestCompiledTab(await this.ensureEngine('net48'), this.designerFile!, asm, hostId, Math.round(x), Math.round(y)); }
    catch { return; }
    if (!hit || !hit.pageId) return; // not on a tab header (or the page has no .Designer.cs field)
    const next = await vscode.window.showInputBox({
      prompt: `Rename tab "${hit.pageId}"`,
      value: hit.text,
      validateInput: (v) => (v.trim() === '' ? 'Enter a tab caption' : undefined),
    });
    if (next === undefined) return;         // cancelled
    const val = next.trim();
    if (val === hit.text) return;           // unchanged
    await this.applyEdit(hit.pageId, 'Text', 'System.String', false, val);
  }

  /**
   * Add a new empty tab page to the tab host (net48 compiled preview). net9 splices the field + `TabPages.Add`
   * (the page type is derived from an existing page in the layout), then net48 live-adds the page and makes it
   * active. Undoable in one commit. Persisted text keeps the tab even before a rebuild.
   */
  private async applyAddTab(hostId: string): Promise<void> {
    if (this.disposed || this.engineKind !== 'net48') return; // net9 add-tab needs interpreter support (future)
    const asm = this.asm();
    if (!asm) return;
    const pageType = this.controls.find((c) => c.parentId === hostId)?.type;
    if (!pageType) { this.post({ type: 'status', message: 'add tab: could not determine the tab page type' }); return; }
    const eng = await this.ensureEngine(); // net9 for the text splice
    const before = this.doc.designerText;
    const rev = this.doc.rev;
    const res = await addTabPage(eng, this.designerFile!, hostId, pageType, before);
    if (!res.safe || res.newText === null) { this.post({ type: 'status', message: 'add tab rejected: ' + (res.reason || 'unsafe') }); return; }
    if (this.doc.rev !== rev) { this.post({ type: 'status', message: 'document changed during edit — try again' }); return; }
    this.commit(before, res.newText, `Add tab ${res.name}`);
    this.currentId = res.name;
    this.output.appendLine(`added tab ${res.name} to ${hostId} (unsaved)`);
    await this.live48((e) => addCompiledTab(e, this.designerFile!, asm, hostId, pageType, res.name));
    this.post({ type: 'status', message: `added tab ${res.name} — unsaved` });
  }

  /**
   * Delete a whole tab page (the page + its entire subtree) from the tab host (net48 compiled preview). net9 removes
   * the subtree's fields/statements and detaches the page from the host's tab collection (whole Controls.Add /
   * TabPages.Add, or a trimmed TabPages.AddRange element); net48 live-removes the page from the picture. Undoable in
   * one commit. Declines (with a status) when the page's subtree is referenced from outside it. The page id is the
   * host's currently-active tab (the visible one), so the user deletes what they see. Confirmed first (destructive).
   */
  private async applyDeleteTab(hostId: string, pageId: string): Promise<void> {
    if (this.disposed || this.engineKind !== 'net48') return; // net9 delete-tab needs interpreter support (future)
    const asm = this.asm();
    if (!asm) return;
    const pick = await vscode.window.showWarningMessage(
      `Delete tab "${pageId}" and all controls on it? This cannot be undone except via Undo.`,
      { modal: true },
      'Delete Tab',
    );
    if (pick !== 'Delete Tab') return;               // cancelled
    const eng = await this.ensureEngine();           // net9 for the text edit
    const before = this.doc.designerText;
    const rev = this.doc.rev;
    const res = await removeTabPage(eng, this.designerFile!, hostId, pageId, before);
    if (!res.safe || res.newText === null) { this.post({ type: 'status', message: 'delete tab rejected: ' + (res.reason || 'unsafe') }); return; }
    if (this.doc.rev !== rev) { this.post({ type: 'status', message: 'document changed during edit — try again' }); return; }
    this.commit(before, res.newText, `Delete tab ${pageId}`);
    if (this.currentId === pageId) this.currentId = hostId;
    this.output.appendLine(`deleted tab ${pageId} from ${hostId} (unsaved)`);
    await this.live48((e) => removeCompiledTab(e, this.designerFile!, asm, hostId, pageId));
    this.post({ type: 'status', message: `deleted tab ${pageId} — unsaved` });
  }

  /** "Learn More Online": open the selected control type's .NET API docs (or the WinForms hub if unknown). */
  private async openLearnMore(typeName?: string): Promise<void> {
    const t = (typeName ?? '').trim();
    const url = /^[\w.]+\.[\w.]+$/.test(t)
      ? `https://learn.microsoft.com/dotnet/api/${t.toLowerCase()}`
      : 'https://learn.microsoft.com/dotnet/desktop/winforms/';
    await vscode.env.openExternal(vscode.Uri.parse(url));
  }

  private postDirty(): void {
    if (!this.designerFile || this.disposed) return;
    this.post({ type: 'dirty', dirty: this.doc.isDirty });
  }

  private async patchOrRerender(id: string, prop: string): Promise<void> {
    if (!this.designerFile || this.disposed) return;
    const eng = await this.ensureEngine();
    const asm = this.asm();
    const text = await this.currentText();
    const seq = ++this.renderSeq;

    const patchPossible = id !== 'this' && prop !== 'Checked' && prop !== 'CheckState';
    if (patchPossible) {
      let layout: Awaited<ReturnType<typeof describeLayout>>;
      try {
        layout = await describeLayout(eng, this.designerFile, asm, text);
      } catch {
        return;
      }
      if (seq !== this.renderSeq || this.disposed) return;

      const geometryUnchanged = sameLayout(this.controls, layout.controls);
      this.controls = layout.controls;
      this.rootClient = { w: layout.clientWidth, h: layout.clientHeight };
      this.postLayout(layout.controls);

      const hasChildren = layout.controls.some((c) => c.parentId === id);
      if (geometryUnchanged && !hasChildren) {
        const patch = await renderControl(eng, this.designerFile, id, asm, text);
        if (seq !== this.renderSeq || this.disposed) return;
        if (patch.found) {
          this.post({
            type: 'patch', png: patch.png.toString('base64'),
            x: patch.x, y: patch.y, width: patch.width, height: patch.height, gen: seq,
          });
          return;
        }
      }
    }

    let frame: Awaited<ReturnType<typeof renderWithLayout>>;
    try {
      frame = await renderWithLayout(eng, this.designerFile, asm, text);
    } catch (err) {
      this.post({ type: 'status', message: t('status.renderFailed', { error: errMsg(err) }) });
      return;
    }
    if (seq !== this.renderSeq || this.disposed) return;
    this.controls = frame.controls;
    this.rootClient = { w: frame.clientWidth, h: frame.clientHeight };
    this.rootFrame = { w: frame.width, h: frame.height };
    this.post({ type: 'render', png: frame.png.toString('base64'), width: frame.width, height: frame.height, gen: seq });
    this.postLayout(frame.controls);
    this.pushSelect(this.currentId);
    // keep the partial-render banner in lockstep with this whole-frame re-render (a value edit rarely changes which
    // constructs are unrepresentable, but if it does — e.g. fixing/breaking a control — refresh rather than go stale).
    this.post({ type: 'renderDiag', items: categorizeUnrepresentable(frame.unrepresentable) });
  }
}

/** Parse an invariant "x, y" / "w, h" pair to [n, n], or null if malformed. */
function parsePair(s?: string | null): [number, number] | null {
  if (!s) return null;
  const parts = s.split(',').map((n) => parseInt(n.trim(), 10));
  return parts.length === 2 && parts.every((n) => Number.isFinite(n)) ? [parts[0], parts[1]] : null;
}

/** Two layouts describe the same geometry (same ids at the same window rects) — patch-safety gate. */
function sameLayout(a: LayoutControl[], b: LayoutControl[]): boolean {
  if (a.length !== b.length) return false;
  const key = (c: LayoutControl) => `${c.id}|${c.x}|${c.y}|${c.width}|${c.height}`;
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
 * WPF), a Name/Namespace/Assembly table, a filter, a details strip, and OK/Cancel/Reset. The real DLL
 * scan/cache/load is a later increment; the host seeds the .NET tab with the already-discovered controls.
 */
function chooseItemsHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = randomBytes(16).toString('hex');
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'chooseItems.js'));
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
${cspMeta(webview, nonce)}
<style nonce="${nonce}">
  html, body { height: 100%; margin: 0; }
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
  html, body { height: 100%; margin: 0; }
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
  #diagHead { display: flex; align-items: center; gap: 8px; padding: 4px 8px; }
  #diagIcon { flex: 0 0 auto; }
  #diagToggle { cursor: pointer; text-decoration: underline; color: var(--vscode-textLink-foreground, #4ea1ff); }
  #diagSpacer { flex: 1; }
  #diagDismiss { flex: 0 0 auto; background: transparent; border: none; color: inherit; cursor: pointer; font-size: 14px; line-height: 1; padding: 0 4px; opacity: .8; }
  #diagDismiss:hover { opacity: 1; }
  #diagList { margin: 0; padding: 0 8px 6px 8px; list-style: none; }
  #diagList li { padding: 2px 0 2px 18px; text-indent: -18px; white-space: pre-wrap; word-break: break-word; }
  #diagList li .diagCat { margin-right: 6px; opacity: .9; font-weight: 600; }
  #diagList li .diagDetail { opacity: .8; }
  #surfaceWrap { position: relative; box-shadow: 0 4px 24px rgba(0,0,0,.5); }
  #surface { display: block; image-rendering: pixelated; }
  #sel { position: absolute; border: 1px solid #4ea1ff; box-shadow: 0 0 0 1px rgba(0,0,0,.5); pointer-events: none; display: none; }
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
  .selsec { position: absolute; border: 1px dashed #4ea1ff; box-shadow: 0 0 0 1px rgba(0,0,0,.4); box-sizing: border-box; pointer-events: none; }
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
  /* small visual separator between toolbar button groups */
  .tbsep { display: inline-block; width: 1px; align-self: stretch; margin: 1px 4px; background: var(--vscode-panel-border, #444); }
  /* rubber-band selection rectangle */
  .rubberband { position: absolute; border: 1px dashed #4ea1ff; background: rgba(78,161,255,.12); pointer-events: none; z-index: 6; box-sizing: border-box; }
  #status { padding: 4px 8px; min-height: 1em; color: var(--vscode-descriptionForeground); border-top: 1px solid var(--vscode-panel-border, #333); }
  /* component tray — non-visual components below the surface */
  #tray { flex: 0 0 auto; display: flex; flex-wrap: wrap; gap: 4px; padding: 4px 8px; border-top: 1px solid var(--vscode-panel-border, #333); background: var(--vscode-editorWidget-background, #252526); max-height: 88px; overflow: auto; }
  .trayItem { font-size: 12px; padding: 3px 8px; border-radius: 2px; cursor: pointer; user-select: none; white-space: nowrap;
    background: var(--vscode-button-secondaryBackground, #3a3d41); color: var(--vscode-button-secondaryForeground, #fff); }
  .trayItem:hover { background: var(--vscode-button-secondaryHoverBackground, #45494e); }
  .trayItem.sel { outline: 1px solid #4ea1ff; }
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
  .taskfly .tfLinks { border-top: 1px solid var(--vscode-menu-separatorBackground, #454545); padding: 3px 0; margin-top: 3px; }
  .taskfly .tfLink { display: block; padding: 4px 10px; cursor: pointer; color: var(--vscode-textLink-foreground, #4ea1ff); }
  .taskfly .tfLink:hover { background: var(--vscode-menu-selectionBackground, #04395e); color: #fff; }
</style></head>
<body>
  <div id="diag" style="display:none"><div id="diagHead"><span id="diagIcon">⚠</span><span id="diagMsg"></span><span id="diagToggle"></span><span id="diagSpacer"></span><button id="diagDismiss" title="${t('designer.diag.dismiss')}">×</button></div><ul id="diagList" style="display:none"></ul></div>
  <div id="stage"><div id="overlay">${t('designer.overlay.loading')}<noscript>${t('designer.overlay.noscript')}</noscript></div><div id="surfaceWrap"><canvas id="surface" width="1" height="1"></canvas><div id="sel"></div></div></div>
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
 * The single dockable designer panel: a Properties pane (component selector + Properties/Events grid) and a
 * Toolbox pane (click-to-add palette), each full-size, switched by a tab strip at the BOTTOM of the view.
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
  html, body { height: 100%; margin: 0; }
  body { font: 12px var(--vscode-font-family, sans-serif); color: var(--vscode-foreground); display: flex; flex-direction: column; }
  /* the two full-size panes share #content; the bottom tab strip switches between them */
  #content { flex: 1; min-height: 0; position: relative; }
  .pane { position: absolute; inset: 0; display: flex; flex-direction: column; }
  .paneEmpty { padding: 10px 12px; color: var(--vscode-descriptionForeground); }
  #bottomTabs { flex: 0 0 auto; display: flex; border-top: 1px solid var(--vscode-panel-border, #333); }
  #bottomTabs button { flex: 1 1 0; border: none; border-right: 1px solid var(--vscode-panel-border, #333); background: transparent; color: var(--vscode-descriptionForeground); padding: 5px 8px; cursor: pointer; font: inherit; }
  #bottomTabs button:last-child { border-right: none; }
  #bottomTabs button:hover { background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,.08)); }
  #bottomTabs button.active { color: var(--vscode-foreground); background: var(--vscode-tab-activeBackground, rgba(255,255,255,.10)); box-shadow: inset 0 2px 0 var(--vscode-focusBorder, #4ea1ff); }
  /* properties pane */
  #propsBody { display: flex; flex-direction: column; height: 100%; }
  #sideHeader { flex: 0 0 auto; padding: 8px 8px 4px; background: var(--vscode-sideBar-background, var(--vscode-editor-background, #1e1e1e)); border-bottom: 1px solid var(--vscode-panel-border, #333); }
  #grid { flex: 1; min-height: 0; overflow: auto; }
  #props, #events { padding: 0 8px 8px; }
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
  .gridColumnsPop .columnsList { min-width: 340px; }
  .colChkLbl { flex: 0 0 auto; display: inline-flex; align-items: center; gap: 2px; font-size: 11px; color: var(--vscode-descriptionForeground); }
  .colChk { margin: 0; }
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
  .treeNode:hover { background: var(--vscode-list-hoverBackground, #2a2d2e); }
  .treeNode.sel { background: var(--vscode-list-activeSelectionBackground, #094771); color: var(--vscode-list-activeSelectionForeground, #fff); }
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
  </div>
  <div id="bottomTabs">
    <button id="mainTabProps" class="active">${t('panel.mainTab.props')}</button>
    <button id="mainTabOutline">${t('panel.mainTab.outline')}</button>
    <button id="mainTabToolbox">${t('panel.mainTab.toolbox')}</button>
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
