import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { randomBytes } from 'crypto';
import {
  EngineHandle,
  LayoutControl,
  ComponentDesc,
  renderWithLayout,
  describeLayout,
  describeComponent,
  renderControl,
  setProperty,
  convertValue,
  generateEventHandler,
  listHandlerCandidates,
  setEventWiring,
  addControl,
  listToolboxItems,
  ToolboxItemInfo,
  listToolboxCandidates,
  scanToolboxAssembly,
  removeControl,
  copyControl,
  pasteControl,
  moveZOrder,
} from './engineClient';
import { COMPLEX_TYPE_SET, toCSharpExpression, shortName } from './valueExpr';

type EnsureEngine = () => Promise<EngineHandle>;
type AssemblyOverride = (file: string) => string | undefined;
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

  private memento: vscode.Memento | undefined;
  /** The designer clipboard (Cut/Copy → Paste), shared across all open designer editors like VS. Each entry is
   *  an OPAQUE engine blob (from copyControl) handed back to pasteControl; `label` is a human display name. */
  clipboard: { clips: string[]; label: string } | null = null;

  /** Items the user ADDED via "Choose Items" (each tagged with `category` = the toolbox tab it landed in).
   *  Merged into the toolbox palette and persisted, so a chosen library control survives reloads. */
  chosenItems: ToolboxItemInfo[] = [];
  /** Framework palette items the user UNCHECKED in "Choose Items" — filtered out of the toolbox. */
  private hidden = new Set<string>();

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

  setActive(s: DesignerSession | null): void {
    this.active = s;
    if (s) s.refreshViews();
    else this.toPanel({ type: 'clear' });
  }
  /** When a session closes: if it owned the panel, blank it (another focus will re-populate). */
  clearIfActive(s: DesignerSession): void { if (this.active === s) this.setActive(null); }

  toPanel(msg: unknown): void { void this.panel?.postMessage(msg); }
  /** From a session — forward to the panel only if it's the one currently mirrored. */
  pushPanel(s: DesignerSession, msg: unknown): void { if (this.active === s) this.toPanel(msg); }
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
      document, panel, (e) => this._onDidChangeCustomDocument.fire(e),
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
    DesignerHub.instance.panel = view.webview;
    view.webview.onDidReceiveMessage(async (m: {
      type?: string; id?: string; prop?: string; propType?: string; isEnum?: boolean; value?: string;
      event?: string; handler?: string | null; controlType?: string; tab?: string;
    }) => {
      const s = DesignerHub.instance.activeSession;
      try {
        if (m?.type === 'ready') { s?.refreshViews(); }
        else if (m?.type === 'pick' && m.id) { await s?.pick(m.id); }
        else if (m?.type === 'edit' && m.id && m.prop && m.propType !== undefined) { await s?.editFromGrid(m.id, m.prop, m.propType, !!m.isEnum, m.value ?? ''); }
        else if (m?.type === 'setHandler' && m.id && m.event) { await s?.setHandler(m.id, m.event, m.handler ?? ''); }
        else if (m?.type === 'createHandler' && m.id && m.event) { await s?.createHandler(m.id, m.event, m.handler || undefined); }
        else if (m?.type === 'navigateHandler' && m.id) { await s?.navigateToHandler(m.id, m.event ?? '', m.handler ?? undefined); }
        else if (m?.type === 'listHandlers' && m.id) { await s?.sendCandidates(m.id); }
        else if (m?.type === 'addControl' && m.controlType) { await s?.addControlFromToolbox(m.controlType); }
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
  private debounce?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private gotReady = false;
  /** Auto-populated toolbox palette (§7.2) — fetched once, then mirrored to the Toolbox view. */
  private toolboxItems: ToolboxItemInfo[] | undefined;
  /** The big "Choose Toolbox Items" window (a separate editor-area webview panel), if open. */
  private chooseItemsPanel: vscode.WebviewPanel | undefined;
  /** Assemblies the user added via the Choose-Items "Browse…" button (accumulated across clicks). */
  private browsedDlls: string[] = [];
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
  ) {
    this.doc = document;
    this.documentUri = document.uri;
    this.designerFile = document.designerFile;
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
        void vscode.window.showErrorMessage(
          'WinForms Designer: the preview did not initialize (no "ready" from the webview). Its script may be blocked.',
        );
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
    DesignerHub.instance.clearIfActive(this);
    if (this.debounce) clearTimeout(this.debounce);
    for (const d of this.disposables.splice(0)) {
      try { d.dispose(); } catch { /* ignore */ }
    }
  }

  private asm(): string | undefined {
    return this.designerFile ? this.getAssemblyOverride(this.designerFile) : undefined;
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

  // ----- view refresh (when this session becomes the focused one, or a view (re)opens) -----
  async refreshToolbox(): Promise<void> {
    if (this.disposed || !this.designerFile) return;
    if (!this.toolboxItems) {
      try { this.toolboxItems = await listToolboxItems(await this.ensureEngine(), this.designerFile, this.asm()); } catch { /* ignore */ }
    }
    DesignerHub.instance.pushPanel(this, { type: 'toolbox', items: [...(this.toolboxItems ?? []).filter((it) => !DesignerHub.instance.isHidden(it.fqn)), ...DesignerHub.instance.chosenItems] });
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
      this.post({ type: 'status', message: '.Designer.cs changed on disk — keeping your unsaved designer edits' });
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
    this.post({ type: 'status', message: 'saved' });
    this.postDirty();
  }

  private async onMessage(m: {
    type: string; id?: string; mode?: string; x?: number; y?: number; width?: number; height?: number;
    ids?: string[]; dx?: number; dy?: number; prop?: string; propType?: string; isEnum?: boolean; value?: string;
    edits?: Array<{ id: string; dx: number; dy: number }>; controlType?: string; hitId?: string; typeName?: string;
  }): Promise<void> {
    try {
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
      } else if (m.type === 'bringToFront' && m.id) {
        await this.applyZOrder([m.id], true);
      } else if (m.type === 'bringToFrontGroup' && Array.isArray(m.ids)) {
        await this.applyZOrder(m.ids, true);
      } else if (m.type === 'sendToBack' && m.id) {
        await this.applyZOrder([m.id], false);
      } else if (m.type === 'sendToBackGroup' && Array.isArray(m.ids)) {
        await this.applyZOrder(m.ids, false);
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
    if (this.chooseItemsPanel) { this.chooseItemsPanel.reveal(); void this.pushCandidates(this.chooseItemsPanel); return; }
    const panel = vscode.window.createWebviewPanel(
      'winformsDesigner.chooseItems', 'Choose Toolbox Items', vscode.ViewColumn.Active,
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
  private async pushCandidates(panel: vscode.WebviewPanel): Promise<void> {
    const hub = DesignerHub.instance;
    const tab = this.chooseItemsTab ?? null;
    // "chosen" sent to the dialog = the fqns CURRENTLY in the toolbox (framework-not-hidden + added) → so the
    // checkboxes start checked for everything already in the toolbox (matching VS), not all-off.
    const inToolbox = (): string[] => [
      ...(this.toolboxItems ?? []).filter((c) => !hub.isHidden(c.fqn)).map((c) => c.fqn),
      ...hub.chosenItems.map((c) => c.fqn),
    ];
    if (this.disposed || !this.designerFile) { void panel.webview.postMessage({ type: 'items', items: [], tab, chosen: inToolbox() }); return; }
    try {
      const eng = await this.ensureEngine();
      if (!this.toolboxItems) { try { this.toolboxItems = await listToolboxItems(eng, this.designerFile, this.asm()); } catch { /* ignore */ } }
      const items = await listToolboxCandidates(eng, this.designerFile, this.asm(), this.browsedDlls.length ? this.browsedDlls : undefined);
      void panel.webview.postMessage({ type: 'items', items, tab, chosen: inToolbox() });
    } catch (err) {
      void panel.webview.postMessage({ type: 'items', items: [], tab, chosen: inToolbox() });
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
    this.post({ type: 'status', message: `toolbox updated (${chosen.length} added, ${hidden.size} hidden)` });
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
    let added = 0;
    let okCount = 0;
    for (const u of picked) {
      const base = path.basename(u.fsPath);
      try {
        const res = await scanToolboxAssembly(eng, u.fsPath);
        if (res.items.length) {
          added += res.items.length; okCount++;
          if (!this.browsedDlls.includes(u.fsPath)) this.browsedDlls.push(u.fsPath);
        } else {
          notes.push(`${base}: ${res.error || 'no toolbox components'}`);
        }
      } catch (e) {
        notes.push(`${base}: ${errMsg(e)}`);
      }
    }
    await this.pushCandidates(panel);
    const parts: string[] = [];
    if (added) parts.push(`Added ${added} component${added > 1 ? 's' : ''} from ${okCount} assembl${okCount > 1 ? 'ies' : 'y'}`);
    if (notes.length) parts.push(notes.join('; '));
    void panel.webview.postMessage({ type: 'browseResult', message: parts.join(' — ') || 'No components added.' });
  }

  private fail(err: unknown): void {
    const msg = errMsg(err);
    this.post({ type: 'error', message: msg });
    this.output.appendLine('designer render failed: ' + msg);
    void vscode.window.showErrorMessage('WinForms Designer: ' + msg);
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
    this.post({ type: 'loading', message: 'Starting engine…' });

    let eng: EngineHandle;
    try {
      eng = await this.withTimeout(this.ensureEngine(), 12000, 'engine did not start (is the .NET SDK / dotnet on PATH?)');
    } catch (err) {
      if (seq === this.renderSeq && !this.disposed) this.fail(err);
      return;
    }
    if (seq !== this.renderSeq || this.disposed) return;
    if (!this.toolboxItems) { // auto-populated palette (§7.2 framework + project controls) → fetch once
      try { this.toolboxItems = await listToolboxItems(eng, this.designerFile, this.asm()); } catch { /* ignore */ }
    }
    DesignerHub.instance.pushPanel(this, { type: 'toolbox', items: [...(this.toolboxItems ?? []).filter((it) => !DesignerHub.instance.isHidden(it.fqn)), ...DesignerHub.instance.chosenItems] });
    this.post({ type: 'loading', message: 'Rendering…' });
    const asm = this.asm();
    const text = await this.currentText();
    let result: Awaited<ReturnType<typeof renderWithLayout>>;
    try {
      result = await this.withTimeout(
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
    this.post({ type: 'tray', items: result.tray }); // §7.3 component tray (canvas strip)
    if (!result.controls.some((c) => c.id === this.currentId)) this.currentId = 'this';
    this.pushSelect(this.currentId);
    await this.loadProps(this.currentId);
    await this.postDirty();
    this.pushClipboardState();
  }

  /** Describe the selected component → push its grid to the Properties view + its manipulability to the canvas. */
  private async loadProps(id: string): Promise<void> {
    if (!this.designerFile || this.disposed) return;
    const eng = await this.ensureEngine();
    const component = await describeComponent(eng, this.designerFile, id, this.asm(), await this.currentText());
    if (this.disposed) return;
    DesignerHub.instance.pushPanel(this, { type: 'props', id, component });
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
        const eng = await this.ensureEngine();
        const comp = await describeComponent(eng, this.designerFile, id, this.asm(), await this.currentText());
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
      const eng = await this.ensureEngine();
      const comp = await describeComponent(eng, this.designerFile, id, this.asm(), await this.currentText());
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
    let applied = 0;
    for (const id of movable) {
      const comp = await describeComponent(eng, this.designerFile, id, this.asm(), text);
      const loc = parsePair(comp?.properties?.find((p) => p.name === 'Location')?.value);
      if (!loc) continue; // layout-managed / no representable Location → skip
      const expr = await convertValue(eng, 'System.Drawing.Point', `${loc[0] + Math.round(dx)}, ${loc[1] + Math.round(dy)}`);
      if (expr === null) continue;
      const res = await setProperty(eng, this.designerFile, id, 'Location', expr, text);
      if (res.safe && res.text !== null) { text = res.text; applied++; }
    }
    if (!applied) { this.post({ type: 'status', message: 'nothing moved (layout-managed?)' }); await this.loadProps(this.currentId); return; }
    if (this.doc.rev !== rev) { this.post({ type: 'status', message: 'document changed during edit — try again' }); await this.loadProps(this.currentId); return; }
    this.commit(before, text, `Move ${applied} control${applied > 1 ? 's' : ''}`);
    this.output.appendLine(`moved ${applied} controls by (${Math.round(dx)}, ${Math.round(dy)}) (unsaved)`);
    await this.fullRender();
    this.post({ type: 'status', message: `moved ${applied} control${applied > 1 ? 's' : ''} — unsaved` });
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
    let applied = 0;
    for (const e of wanted) {
      const comp = await describeComponent(eng, this.designerFile, e.id, this.asm(), text);
      const loc = parsePair(comp?.properties?.find((p) => p.name === 'Location')?.value);
      if (!loc) continue; // layout-managed / no representable Location → skip
      const expr = await convertValue(eng, 'System.Drawing.Point', `${loc[0] + Math.round(e.dx)}, ${loc[1] + Math.round(e.dy)}`);
      if (expr === null) continue;
      const res = await setProperty(eng, this.designerFile, e.id, 'Location', expr, text);
      if (res.safe && res.text !== null) { text = res.text; applied++; }
    }
    if (!applied) { this.post({ type: 'status', message: 'nothing aligned (layout-managed?)' }); await this.loadProps(this.currentId); return; }
    if (this.doc.rev !== rev) { this.post({ type: 'status', message: 'document changed during edit — try again' }); await this.loadProps(this.currentId); return; }
    this.commit(before, text, `Align ${applied} control${applied > 1 ? 's' : ''}`);
    this.output.appendLine(`aligned ${applied} controls (unsaved)`);
    await this.fullRender();
    this.post({ type: 'status', message: `aligned ${applied} control${applied > 1 ? 's' : ''} — unsaved` });
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
    let applied = 0;
    for (const id of removable) {
      const res = await removeControl(eng, this.designerFile, id, text);
      if (res.safe && res.newText !== null) { text = res.newText; applied++; }
    }
    if (!applied) { this.post({ type: 'status', message: 'remove rejected: nothing removable' }); return; }
    if (this.doc.rev !== rev) { this.post({ type: 'status', message: 'document changed during edit — try again' }); return; }
    this.commit(before, text, `Remove ${applied} control${applied > 1 ? 's' : ''}`);
    this.currentId = 'this';
    this.output.appendLine(`removed ${applied} controls (unsaved)`);
    await this.fullRender();
    this.post({ type: 'status', message: `removed ${applied} control${applied > 1 ? 's' : ''} — unsaved` });
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
      this.post({ type: 'status', message: `enter a ${shortName(propType)} value` });
      await this.loadProps(id);
      return;
    }

    const eng = await this.ensureEngine();

    let expr: string | null;
    if (COMPLEX_TYPE_SET.has(propType)) {
      expr = await convertValue(eng, propType, raw);
      if (expr === null) {
        this.post({ type: 'status', message: `'${raw}' is not a valid ${shortName(propType)} value` });
        await this.loadProps(id);
        return;
      }
    } else {
      expr = toCSharpExpression(propType, isEnum, raw);
      if (expr === null) {
        this.post({ type: 'status', message: `cannot edit ${propType} from the panel yet` });
        return;
      }
    }

    const before = this.doc.designerText;
    const revBefore = this.doc.rev;

    const res = await setProperty(eng, this.designerFile, id, prop, expr, before);
    if (!res.safe || res.text === null) {
      this.post({ type: 'status', message: `edit rejected: ${res.reason || 'unsafe'}` });
      await this.loadProps(id);
      return;
    }
    if (this.doc.rev !== revBefore) {
      this.post({ type: 'status', message: 'document changed during edit — try again' });
      await this.loadProps(id);
      return;
    }

    this.commit(before, res.text, `Set ${id}.${prop}`);
    this.output.appendLine(`set ${id}.${prop} = ${expr} (${res.mode}, unsaved)`);
    this.post({ type: 'status', message: `set ${id}.${prop} — unsaved` });

    await this.patchOrRerender(id, prop);
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
        this.post({ type: 'status', message: `cannot set ${e.prop} to '${e.value}'` });
        await this.loadProps(id);
        return;
      }
      const res = await setProperty(eng, this.designerFile, id, e.prop, expr, text);
      if (!res.safe || res.text === null) {
        this.post({ type: 'status', message: `edit rejected: ${res.reason || 'unsafe'}` });
        await this.loadProps(id);
        return;
      }
      text = res.text;
    }

    if (this.doc.rev !== revBefore) {
      this.post({ type: 'status', message: 'document changed during edit — try again' });
      await this.loadProps(id);
      return;
    }
    this.commit(before, text, `Set ${id} (${edits.length} properties)`);
    this.output.appendLine(`set ${id} ${edits.map((e) => e.prop).join('+')} (${edits.length} edits, unsaved)`);
    await this.patchOrRerender(id, edits[edits.length - 1].prop);
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
    catch (err) { this.post({ type: 'status', message: 'save failed: ' + errMsg(err) }); }
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
    if (!codePath) { this.post({ type: 'status', message: 'no code-behind .cs to add a handler to' }); return; }
    const eng = await this.ensureEngine();

    const designerBefore = this.doc.designerText;
    const designerRev = this.doc.rev;

    let codeDoc: vscode.TextDocument;
    try { codeDoc = await vscode.workspace.openTextDocument(codePath); }
    catch { this.post({ type: 'status', message: 'cannot open ' + path.basename(codePath) }); return; }
    const codeBefore = codeDoc.getText();
    const codeVer = codeDoc.version;

    const gen = await generateEventHandler(eng, this.designerFile, id, eventName, handlerName ?? null, designerBefore, codeBefore, this.asm() ?? null);
    if (!gen.safe) { this.post({ type: 'status', message: 'create handler rejected: ' + (gen.reason || 'unsafe') }); return; }
    if (this.disposed) return;

    if (this.doc.rev !== designerRev || codeDoc.version !== codeVer) {
      this.post({ type: 'status', message: 'document changed during edit — try again' });
      return;
    }

    // Apply the code-behind .cs stub FIRST (a real text edit the user reads/writes); only then commit the
    // in-memory .Designer.cs wiring — so we never wire an event to a handler stub that failed to write.
    if (gen.codeText != null) {
      const edit = new vscode.WorkspaceEdit();
      edit.replace(codeDoc.uri, new vscode.Range(codeDoc.positionAt(0), codeDoc.positionAt(codeBefore.length)), gen.codeText);
      if (!(await vscode.workspace.applyEdit(edit))) { this.post({ type: 'status', message: 'could not write the handler stub — wiring not added' }); return; }
      if (this.doc.rev !== designerRev) { this.post({ type: 'status', message: 'document changed during edit — try again' }); return; }
    }
    if (gen.designerText != null) this.commit(designerBefore, gen.designerText, `Wire ${id}.${eventName}`);

    this.output.appendLine(`created handler ${gen.handlerName} for ${id}.${eventName}${gen.alreadyWired ? ' (already wired)' : ''} (unsaved)`);
    await this.loadProps(id);
    await this.postDirty();
    await this.openHandlerAt(codePath, gen.handlerName);
  }

  private async openHandlerAt(codePath: string | null, handler: string): Promise<void> {
    if (!codePath) { this.post({ type: 'status', message: 'no .cs code-behind to navigate to' }); return; }
    let doc: vscode.TextDocument;
    try { doc = await vscode.workspace.openTextDocument(codePath); }
    catch { this.post({ type: 'status', message: 'cannot open ' + path.basename(codePath) }); return; }

    const re = new RegExp('(?:^|[^\\w.])' + escapeRegex(handler) + '\\s*\\([^)]*\\)\\s*\\{');
    const text = doc.getText();
    const mm = re.exec(text);
    if (!mm) { this.post({ type: 'status', message: `handler '${handler}' not found in ${path.basename(codePath)}` }); return; }
    const brace = mm.index + mm[0].length - 1;

    const braceLine = doc.positionAt(brace).line;
    const bodyLine = Math.min(braceLine + 1, doc.lineCount - 1);
    const lineText = doc.lineAt(bodyLine).text;
    const col = lineText.trim().length === 0 ? lineText.length : doc.lineAt(bodyLine).firstNonWhitespaceCharacterIndex;
    const pos = new vscode.Position(bodyLine, col);
    this.onViewCode(vscode.Uri.file(codePath), pos);
    this.post({ type: 'status', message: `→ ${handler}` });
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
      this.post({ type: 'status', message: 'wiring rejected: ' + (res.reason || 'unsafe') });
      await this.loadProps(id);
      return;
    }
    if (this.doc.rev !== rev) {
      this.post({ type: 'status', message: 'document changed during edit — try again' });
      await this.loadProps(id);
      return;
    }
    this.commit(before, res.designerText, `${handler ? 'Wire' : 'Unwire'} ${id}.${event}`);
    this.output.appendLine(`${handler ? 'wired' : 'unwired'} ${id}.${event}${handler ? ' → ' + handler : ''} (unsaved)`);
    this.post({ type: 'status', message: `${handler ? 'wired ' + event + ' → ' + handler : 'unwired ' + event} — unsaved` });
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
    const res = await addControl(eng, this.designerFile, parentId || 'this', controlType, before, locX, locY, this.asm());
    if (!res.safe || res.newText === null) { this.post({ type: 'status', message: 'add rejected: ' + (res.reason || 'unsafe') }); return; }
    if (this.doc.rev !== rev) { this.post({ type: 'status', message: 'document changed during edit — try again' }); return; }
    this.commit(before, res.newText, `Add ${controlType}`);
    this.currentId = res.name;
    this.output.appendLine(`added ${controlType} → ${res.name} (unsaved)`);
    await this.fullRender();
    this.post({ type: 'status', message: `added ${res.name} — unsaved` });
  }

  private async applyRemoveControl(id: string): Promise<void> {
    if (!this.designerFile || this.disposed || id === 'this') return;
    const eng = await this.ensureEngine();
    const before = this.doc.designerText;
    const rev = this.doc.rev;
    const res = await removeControl(eng, this.designerFile, id, before);
    if (!res.safe || res.newText === null) { this.post({ type: 'status', message: 'remove rejected: ' + (res.reason || 'unsafe') }); return; }
    if (this.doc.rev !== rev) { this.post({ type: 'status', message: 'document changed during edit — try again' }); return; }
    this.commit(before, res.newText, `Remove ${id}`);
    this.currentId = 'this';
    this.output.appendLine(`removed ${id} (unsaved)`);
    await this.fullRender();
    this.post({ type: 'status', message: `removed ${id} — unsaved` });
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
    if (!clips.length) { this.post({ type: 'status', message: 'nothing copied (root / container with children / referenced elsewhere)' }); return; }
    DesignerHub.instance.clipboard = { clips, label: names.join(', ') };
    this.pushClipboardState();
    const note = refused ? ` (${refused} skipped)` : '';
    this.post({ type: 'status', message: `copied ${clips.length} control${clips.length > 1 ? 's' : ''}${note}` });
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
    if (!clip || !clip.clips.length) { this.post({ type: 'status', message: 'clipboard is empty' }); return; }
    const parent = this.containerParentFor(targetId ?? this.currentId);
    const eng = await this.ensureEngine();
    const before = this.doc.designerText;
    const rev = this.doc.rev;
    let text = before;
    let last = '';
    let applied = 0;
    for (const c of clip.clips) {
      const res = await pasteControl(eng, this.designerFile, c, parent, text);
      if (res.safe && res.newText !== null) { text = res.newText; last = res.name; applied++; }
    }
    if (!applied) { this.post({ type: 'status', message: 'paste rejected' }); return; }
    if (this.doc.rev !== rev) { this.post({ type: 'status', message: 'document changed during edit — try again' }); return; }
    this.commit(before, text, `Paste ${applied} control${applied > 1 ? 's' : ''}`);
    this.currentId = last || this.currentId;
    this.output.appendLine(`pasted ${applied} control(s) into ${parent} (unsaved)`);
    await this.fullRender();
    this.post({ type: 'status', message: `pasted ${applied} control${applied > 1 ? 's' : ''} — unsaved` });
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
    if (!applied) { this.post({ type: 'status', message: toFront ? 'already at front' : 'already at back' }); return; }
    if (this.doc.rev !== rev) { this.post({ type: 'status', message: 'document changed during edit — try again' }); return; }
    this.commit(before, text, toFront ? 'Bring to Front' : 'Send to Back');
    this.output.appendLine(`${toFront ? 'brought to front' : 'sent to back'} ${applied} control(s) (unsaved)`);
    await this.fullRender();
    this.post({ type: 'status', message: `${toFront ? 'brought to front' : 'sent to back'} — unsaved` });
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
      this.post({ type: 'status', message: 'render failed: ' + errMsg(err) });
      return;
    }
    if (seq !== this.renderSeq || this.disposed) return;
    this.controls = frame.controls;
    this.rootClient = { w: frame.clientWidth, h: frame.clientHeight };
    this.rootFrame = { w: frame.width, h: frame.height };
    this.post({ type: 'render', png: frame.png.toString('base64'), width: frame.width, height: frame.height, gen: seq });
    this.postLayout(frame.controls);
    this.pushSelect(this.currentId);
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
  <h3>No WinForms designer for ${escapeHtml(name)}</h3>
  <p class="muted">The designer view needs a generated <code>${escapeHtml(base)}.Designer.cs</code> next to this file.</p>
  <p class="muted">Open a form's <code>.cs</code> that has a <code>.Designer.cs</code> partner, or reopen this file as code.</p>
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
    <div class="t active" data-tab="net">.NET Framework Components</div>
    <div class="t" data-tab="com">COM Components</div>
    <div class="t" data-tab="wpf">WPF Components</div>
  </div>
  <div id="ciMain">
    <div id="ciArea">
      <div id="ciLoading"><div>Loading items…</div><div class="bar"><div></div></div><div id="ciLoadName">scanning assemblies…</div></div>
      <div id="ciTable"></div>
    </div>
    <div id="ciFilterRow"><span>Filter:</span><input id="ciFilter" type="text"><button id="ciClear">Clear</button><button id="ciBrowse">Browse…</button></div>
    <div id="ciDetails">Select an item to see details.</div>
  </div>
  <div id="ciFoot"><span id="ciStatus"></span><button id="ciReset" disabled>Reset</button><button id="ciCancel">Cancel</button><button id="ciOk" class="primary">OK</button></div>
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
  /* tab-order overlay badges (§ Phase 2) */
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
  /* multi-select: outline boxes for the non-primary selected controls */
  .selsec { position: absolute; border: 1px dashed #4ea1ff; box-shadow: 0 0 0 1px rgba(0,0,0,.4); box-sizing: border-box; pointer-events: none; }
  /* snaplines (alignment guides while dragging) */
  .snapguide { position: absolute; pointer-events: none; z-index: 6; }
  .snapguide.vert { border-left: 1px solid #ff4d9d; }
  .snapguide.horz { border-top: 1px solid #ff4d9d; }
  /* rubber-band selection rectangle */
  .rubberband { position: absolute; border: 1px dashed #4ea1ff; background: rgba(78,161,255,.12); pointer-events: none; z-index: 6; box-sizing: border-box; }
  #status { padding: 4px 8px; min-height: 1em; color: var(--vscode-descriptionForeground); border-top: 1px solid var(--vscode-panel-border, #333); }
  /* component tray (§7.3) — non-visual components below the surface */
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
</style></head>
<body>
  <div id="stage"><div id="overlay">Loading designer…<noscript> — (JavaScript is DISABLED in this webview)</noscript></div><div id="surfaceWrap"><canvas id="surface" width="1" height="1"></canvas><div id="sel"></div></div></div>
  <div id="tray" style="display:none"></div>
  <div id="status"></div>
  <div id="toolbar">
    <span id="selName" class="sel">—</span>
    <span class="spacer"></span>
    <span id="zoom" class="zoomgrp">
      <button id="zoomOut" title="Zoom out (Ctrl+-)">−</button>
      <button id="zoomLabel" title="Reset to 100% (Ctrl+0)">100%</button>
      <button id="zoomIn" title="Zoom in (Ctrl+=)">+</button>
      <button id="zoomFit" title="Fit the form to the view">Fit</button>
    </span>
    <span id="align" class="zoomgrp" style="display:none" title="Align the selected controls to the primary selection">
      <button id="alignLeft" title="Align lefts">⊢</button>
      <button id="alignRight" title="Align rights">⊣</button>
      <button id="alignTop" title="Align tops">⊤</button>
      <button id="alignBottom" title="Align bottoms">⊥</button>
      <button id="alignCenterH" title="Align horizontal centers">↔</button>
      <button id="alignCenterV" title="Align vertical centers">↕</button>
    </span>
    <button id="tabOrder" title="Toggle tab-order editing: click controls in order to renumber TabIndex">Tab Order</button>
    <button id="rulerToggle" title="Показать/скрыть линейку (pixel ruler)">Показать линейку</button>
    <span id="dirty" class="dirty" title="Unsaved designer changes"></span>
  </div>
  <div id="ctxMenu" class="ctxmenu"></div>
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
  td.cat { font-weight: bold; color: var(--vscode-foreground); cursor: pointer; user-select: none;
           background: var(--vscode-sideBarSectionHeader-background, rgba(255,255,255,.045)); padding: 3px 5px; }
  td.cat:hover { color: var(--vscode-foreground); }
  /* outline pane (Document outline §7.4) */
  #outlineTree { flex: 1; min-height: 0; overflow: auto; padding: 4px; font-size: 12px; }
  .treeNode { white-space: nowrap; cursor: pointer; user-select: none; padding: 1px 2px; border-radius: 2px; overflow: hidden; text-overflow: ellipsis; }
  .treeNode:hover { background: var(--vscode-list-hoverBackground, #2a2d2e); }
  .treeNode.sel { background: var(--vscode-list-activeSelectionBackground, #094771); color: var(--vscode-list-activeSelectionForeground, #fff); }
  .treeNode .tw { white-space: pre; }
  /* toolbox pane — VS-style: vertical stack of collapsible category "tabs", right-click menu, custom tabs */
  #tbBody { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  #tbHeader { flex: 0 0 auto; padding: 4px; }
  #tbSearch { width: 100%; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, #555); }
  #tbList { flex: 1 1 auto; min-height: 0; overflow: auto; display: flex; flex-direction: column; padding: 2px 0; }
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
  .tbItem:hover { background: var(--vscode-list-hoverBackground, #2a2d2e); }
  .tbItems.icons .tbItem { padding: 3px 6px 3px 18px; }
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
      <div id="propsEmpty" class="paneEmpty">Select a control in the WinForms designer to edit its properties.</div>
      <div id="propsBody" style="display:none">
        <div id="sideHeader">
          <select id="tree"></select>
          <div id="tabs">
            <button id="sortCat" class="active" title="Categorized"><span class="codicon ico-cat"></span></button>
            <button id="sortAlpha" title="Alphabetical"><span class="codicon ico-alpha"></span></button>
            <span class="tabgap"></span>
            <button id="tabProps" class="active" title="Properties"><span class="codicon ico-props"></span></button>
            <button id="tabEvents" title="Events"><span class="codicon ico-events"></span></button>
          </div>
          <input id="search" type="text" placeholder="Search…">
        </div>
        <div id="grid">
          <div id="props"></div><div id="events" style="display:none"></div>
        </div>
      </div>
    </div>
    <div id="outlinePane" class="pane" style="display:none">
      <div id="outlineTree"></div>
    </div>
    <div id="toolboxPane" class="pane" style="display:none">
      <div id="tbEmpty" class="paneEmpty">Open a WinForms designer to use the toolbox.</div>
      <div id="tbBody" style="display:none">
        <div id="tbHeader"><input id="tbSearch" type="text" placeholder="Search toolbox…"></div>
        <div id="tbList"></div>
      </div>
    </div>
  </div>
  <div id="bottomTabs">
    <button id="mainTabProps" class="active">Properties</button>
    <button id="mainTabOutline">Outline</button>
    <button id="mainTabToolbox">Toolbox</button>
  </div>
  <div id="tbMenu" class="ctxmenu" style="display:none"></div>
  <div id="tbPrompt" class="modal" style="display:none">
    <div class="modalBox small">
      <div class="modalHead" id="tbPromptTitle">Add Tab</div>
      <div class="modalBody"><input id="tbPromptInput" class="full" type="text" placeholder="Tab name"></div>
      <div class="modalFoot"><button id="tbPromptCancel">Cancel</button><button id="tbPromptOk" class="primary">OK</button></div>
    </div>
  </div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body></html>`;
}
