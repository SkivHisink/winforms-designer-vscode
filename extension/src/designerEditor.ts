import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { randomBytes } from 'crypto';
import {
  EngineHandle,
  LayoutControl,
  ToolStripItemBounds,
  ComponentDesc,
  VendorSmartTag,
  renderWithLayout,
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
  removeCompiledControls,
  setCompiledZOrder,
  addCompiledControl,
  selectCompiledTabAt,
  hitTestCompiledTab,
  hitTestInterpretedTab,
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
  describeComponent,
  renderControl,
  setProperty,
  setModifier,
  convertValue,
  setTableCell,
  listCollectionItems,
  setCollectionItems,
  listStringArray,
  setStringArray,
  listColumns,
  setColumns,
  listGridColumns,
  setGridColumns,
  resetProperty,
  setImageResource,
  serializeImageList,
  deserializeImageList,
  setCompiledImageListLive,
  discardCompiledLive,
  setImageList,
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
  listCompiledVendorSmartTags,
} from './engineClient';
import { COMPLEX_TYPE_SET, toCSharpExpression, shortName } from './valueExpr';
import { findNearestCsproj, findOwningCsproj, projectAssemblyName, projectReferencesAssembly, addReferenceToCsproj, resolveFrameworkOutput, resolveFrameworkOnlyOutput, projectTargetFramework, isFrameworkTfm, multiTargetHasFramework } from './csprojRef';
import { t, tn, injectL10nScript } from './i18n';
import { categorizeUnrepresentable } from './renderDiagnostics';

/** One entry of the vendor's declared Tasks menu as the CANVAS sees it: the vendor's label, plus the verb this
* designer runs for it (null → shown disabled, because we have no source-first equivalent). See vendorTagsFor. */
interface VendorTagView {
  label: string;
  methodName: string;
  verb: 'addTab' | 'deleteTab' | 'showProperties' | null;
  closesPanel: boolean;
}
import { isLocalizableDesigner } from './localizable';
import { chooseFormNoticeKind, FormNoticeKind } from './formNotice';
import { binaryResxCount } from './binaryResx';
import { isByteLocalEdit } from './byteLocal';
import { refuseWhileRenderFailed } from './renderGate';
import { retainSelectionId } from './selection';
import { learnMoreUrl } from './learnMore';

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
* 0.10.0 trust-floor — every webview message that MUTATES the form (persists the .Designer.cs, and/or
* writes the .resx / the code-behind stub directly). On a [Localizable(true)] form the extension is a
* read-only preview: each of these is refused up front (before any live-picture mutation or file
* write), because an edit would either splice a direct `this.x.Prop = …` into the .Designer.cs while
* the real value lives in the .resx (a silent divergence VS drops on its next save) or write the
* .resx / code-behind of a form the banner promised not to touch. commit() is the airtight data-loss
* backstop for the .Designer.cs (the single funnel every persisted text edit flows through); this set
* additionally covers the direct-file-write ops (importImage/clearImage → .resx, createHandler → .cs)
* and gives an honest up-front refusal. Spans BOTH message handlers: the canvas (onMessage) and the
* Properties panel (WinFormsDesignerProvider.resolveWebviewView). Read-only messages (pick, select,
* copy, tabClick navigation, every list* collection read, navigate/list handler reads, viewCode,
* learnMore, showProperties, chooseItems, ready, save) are deliberately absent so inspection still
* works. Keep in sync with the mutating branches of BOTH handlers.
*/
const LOCALIZABLE_BLOCKED = new Set<string>([
  // canvas (designer.js → onMessage)
  'manipulate', 'manipulateGroup', 'edit', 'alignControls', 'centerInForm', 'resizeControls',
  'dropControl', 'removeControl', 'removeControls', 'cut', 'cutControls', 'paste', 'duplicate',
  'bringToFront', 'bringToFrontGroup', 'sendToBack', 'sendToBackGroup', 'tabRename',
  'stripAdd', 'stripRename', 'stripRetype', 'stripDelete', 'addTab', 'deleteTab',
  // Properties panel (panel.js → resolveWebviewView). 'edit' is shared with the canvas above.
  'importImage', 'clearImage', 'resetProperty', 'setTableCell', 'setCollection', 'setStringArray',
  'setColumns', 'setGridColumns', 'setTreeNodes', 'setToolStripItems', 'setHandler', 'createHandler',
  'addControl', 'addComponent', 'deleteSelected',
]);
/** One row the Choose-Items dialog sends back on OK: its identity + whether the user has it checked. The host
* diffs these against the current toolbox membership to add/remove/hide items. */
type ChooseRow = { fqn: string; name: string; namespace?: string; assemblyName?: string; fromProject?: boolean; checked: boolean };

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

/**
* Map a file the user opened to the .Designer.cs the engine should read — the "open Form1.cs → see the
* designer" mapping (the .Designer.cs is the generated partner, like in Visual Studio).
* Foo.cs → Foo.Designer.cs (only when that sibling exists)
* Foo.Designer.cs → itself (graceful: reopened the generated file directly)
* Foo.cs (no sibling)→ null
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
* Foo.cs (+ sibling) → Foo.cs
* Foo.Designer.cs → Foo.cs if it exists, else Foo.Designer.cs itself
* Foo.cs (no sibling) → null
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
   * an OPAQUE engine blob (from copyControl) handed back to pasteControl; `label` is a human display name. */
  clipboard: { clips: string[]; label: string } | null = null;

  /** Items the user ADDED via "Choose Items" (each tagged with `category` = the toolbox tab it landed in).
   * Merged into the toolbox palette and persisted, so a chosen library control survives reloads. */
  chosenItems: ToolboxItemInfo[] = [];
  /** Framework palette items the user UNCHECKED in "Choose Items" — filtered out of the toolbox. */
  private hidden = new Set<string>();

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
  registerSession(s: DesignerSession): void { this.openSessions.add(s); }
  unregisterSession(s: DesignerSession): void { this.openSessions.delete(s); }
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

/** 0.11.0 write-safety — process-global monotonic suffix for atomic-write temp files. Module scope (not per
* session) so two designer sessions in one host can't collide; combined with `process.pid` at the use site it
* is also unique across VS Code windows sharing a sibling .resx. */
let atomicWriteSeq = 0;

/** True when `e` is a VS Code "file not found" filesystem error (a delete of an already-absent file). Used so a
* resx-undo delete treats "already gone" as success but lets a real lock/permission failure propagate. */
function isFileNotFound(e: unknown): boolean {
  return e instanceof vscode.FileSystemError && e.code === 'FileNotFound';
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
    const tmp = uri.with({ path: `${uri.path}.wfd-${process.pid}-${atomicWriteSeq++}.tmp` });
  try {
      await vscode.workspace.fs.writeFile(tmp, bytes);
      await vscode.workspace.fs.rename(tmp, uri, { overwrite: true });
  } catch (e) {
    // clean up a partially-staged temp on EITHER a failed write or a failed rename (an interrupted stage would
    // otherwise leak a `.wfd-…tmp` sibling).
      try { await vscode.workspace.fs.delete(tmp); } catch { /* best effort */ }
    throw e;
  }
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

  constructor(
    readonly uri: vscode.Uri,
    readonly designerFile: string | null,
    initialText: string,
    /** The real on-disk text. Differs from initialText only for a recovered (dirty) hot-exit backup. */
    savedText: string,
    hadBom: boolean,
    savedExisted = false,
    baselineUnknown = false,
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

  private bytesOf(text: string): Uint8Array {
    const body = Buffer.from(text, 'utf8');
    return this.hadBom ? Buffer.concat([UTF8_BOM, body]) : body;
  }

  /** Adopt the on-disk text as the new clean baseline (revert / external change while clean). */
  adoptDiskBaseline(text: string, hadBom: boolean): void {
    this.designerText = text; this.savedDesignerText = text; this.hadBom = hadBom; this.rev++;
  this.savedExisted = true; // we just read it off disk …
  this._baselineUnknown = false; // … so the baseline is trustworthy again
  }

  /** Persist to the .Designer.cs on disk (called by VS Code's save), preserving the original BOM. */
  async save(): Promise<void> {
    if (!this.designerFile) return;
    // Snapshot the exact text we write: if an edit/undo commits during the async write, the file holds this
    // snapshot, so only mark THAT as saved (a newer edit stays dirty — no silent data loss / reload-drop).
    const snapshot = this.designerText;
    // 0.10.0 trust-floor — refuse to flush a DIRTY localizable buffer. commit() already blocks new edits,
    // so the only way a localizable form is dirty here is a recovered hot-exit backup that a PRE-lock
    // version left holding a direct `this.x.Prop = …` assignment which diverges from the .resx. This native
    // save path never calls commit(), so without this guard it would persist the exact divergence the
    // read-only lock forbids. Throw so VS Code keeps the document dirty and surfaces the reason — the user
    // must revert the file (or hand-resolve the recovered content). A CLEAN localizable form is never dirty
    // (isDirty === false → this is a no-op), so this never spuriously fails an ordinary save.
    if (this.isDirty && isLocalizableDesigner(snapshot)) throw new Error(t('status.localizableSaveRefused'));
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
    if (this.baselineUnknown) throw new Error(t('status.designerDiskConflict'));
    let onDisk: { text: string; hadBom: boolean } | null = null;
    try {
      onDisk = await readDesignerBytesUri(vscode.Uri.file(this.designerFile));
    } catch (e) {
      // Only a genuine "not there" is benign, and only if it was NEVER there: a file that existed when we took our
      // baseline and is gone now was deleted by someone else — an external change, not permission to recreate it.
      // Any other read failure (locked, permissions, transient) must surface rather than become a blind write.
      if (!isFileNotFound(e)) throw e;
      if (this.savedExisted) throw new Error(t('status.designerDiskConflict'));
    }
    // Compare the BOM too: readDesignerBytesUri strips it, so a rewrite that only added/removed the BOM has identical
    // text and would otherwise slip through — and bytesOf would then write OUR old byte form back over it.
    if (onDisk !== null && (onDisk.text !== this.savedDesignerText || onDisk.hadBom !== this.hadBom)) {
      throw new Error(t('status.designerDiskConflict'));
    }
    // Atomic (temp+rename): an interrupted write must never truncate the user's form. The read→compare→write window
    // above is inherent — VS Code's FS API has no compare-and-swap — but nothing awaits between the comparison and
    // this call, so it is as small as the platform allows.
    await atomicWrite(vscode.Uri.file(this.designerFile), this.bytesOf(snapshot));
    this.savedDesignerText = snapshot;
    this.savedExisted = true;
    this.session?.notifySaved();
  }
  async saveAs(dest: vscode.Uri): Promise<void> {
    // 0.10.0 trust-floor — same recovered-dirty-buffer guard as save(): don't copy a divergent localizable
    // buffer to a new file. A clean localizable form (isDirty === false) still saves-as a faithful copy.
    if (this.isDirty && isLocalizableDesigner(this.designerText)) throw new Error(t('status.localizableSaveRefused'));
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
    // text — so a recovered backup that differs from disk is correctly DIRTY, not silently "saved".
    let text = diskText;
    if (openContext.backupId) {
      try { const r = await readDesignerBytesUri(vscode.Uri.parse(openContext.backupId)); text = r.text; if (!designerFile) hadBom = r.hadBom; } catch { /* fall back to disk */ }
    }
    return new WinFormsDesignDocument(uri, designerFile, text, diskText, hadBom, diskExisted, baselineUnknown);
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
      type?: string; id?: string; prop?: string; propType?: string; isEnum?: boolean; value?: string; ownerId?: string;
      refEdit?: boolean; designTime?: boolean;
      event?: string; handler?: string | null; controlType?: string; tab?: string; cell?: string; componentType?: string;
      items?: string[]; columns?: ColumnItem[]; gridColumns?: GridColumnItem[]; nodes?: TreeNodeItem[];
      toolStripItems?: ToolStripItemModel[];
    }) => {
      const s = DesignerHub.instance.activeSession;
      try {
        // 0.10.0 trust-floor: a localizable form is read-only — refuse every mutating panel op (grid
        // edit, image import/clear, reset, collections, event wiring, toolbox add) before it can splice
        // the .Designer.cs or write the .resx / code-behind. Reads (list*, navigate, ready, pick) pass.
        if (s?.refuseLocalizableEdit(m?.type)) return;
        if (s?.refuseStaleRenderEdit(m?.type)) return; // 0.10.0 S5 — read-only while the last render failed (stale graph)
        if (m?.type === 'ready') { s?.refreshViews(); }
        else if (m?.type === 'pick' && m.id) { await s?.pick(m.id); }
        else if (m?.type === 'edit' && m.id && m.prop && m.propType !== undefined) {
          // an `ownerId` marks this as a ToolStripItem edit (the grid is showing item→Properties) → route to the
          // item-edit path (targets the item field, refreshes via itemProps, keeps the canvas item highlight).
          if (m.ownerId) await s?.editItemFromGrid(m.ownerId, m.id, m.prop, m.propType, !!m.isEnum, m.value ?? '');
          else await s?.editFromGrid(m.id, m.prop, m.propType, !!m.isEnum, m.value ?? '', !!m.refEdit, !!m.designTime);
        }
        else if (m?.type === 'importImage' && m.id && m.prop && m.propType) { await s?.importImageFromGrid(m.id, m.prop, m.propType); }
        else if (m?.type === 'clearImage' && m.id && m.prop) { await s?.clearImageFromGrid(m.id, m.prop); }
        else if (m?.type === 'resetProperty' && m.id && m.prop) {
          // an `ownerId` marks this as a ToolStripItem reset (the grid is showing item→Properties) → route to the
          // item-reset path (targets the item field, refreshes via itemProps, keeps the canvas item highlight).
          if (m.ownerId) await s?.resetItemFromGrid(m.ownerId, m.id, m.prop);
          else await s?.resetFromGrid(m.id, m.prop);
        }
        else if (m?.type === 'setTableCell' && m.id && m.cell) { await s?.tableCellFromGrid(m.id, m.cell, m.value ?? ''); }
        else if (m?.type === 'listCollection' && m.id && m.prop) { await s?.sendCollectionItems(m.id, m.prop); }
        else if (m?.type === 'setCollection' && m.id && m.prop && Array.isArray(m.items)) { await s?.collectionFromGrid(m.id, m.prop, m.items as string[]); }
        else if (m?.type === 'listStringArray' && m.id && m.prop) { await s?.sendStringArray(m.id, m.prop); }
        else if (m?.type === 'setStringArray' && m.id && m.prop && Array.isArray(m.items)) { await s?.stringArrayFromGrid(m.id, m.prop, m.items as string[]); }
        else if (m?.type === 'listColumns' && m.id) { await s?.sendColumnItems(m.id); }
        else if (m?.type === 'setColumns' && m.id && Array.isArray(m.columns)) { await s?.columnsFromGrid(m.id, m.columns as ColumnItem[]); }
        else if (m?.type === 'listGridColumns' && m.id) { await s?.sendGridColumnItems(m.id); }
        else if (m?.type === 'setGridColumns' && m.id && Array.isArray(m.gridColumns)) { await s?.gridColumnsFromGrid(m.id, m.gridColumns as GridColumnItem[]); }
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
        else if (m?.type === 'addControl' && m.controlType) { await s?.addControlFromToolbox(m.controlType); }
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

/** A .resx read: its text with any leading UTF-8 BOM stripped, plus whether that BOM was there — so every write
* back can restore it byte-for-byte instead of silently rewriting the whole file's encoding signature. */
interface ResxRead { text: string; hadBom: boolean; }

/** Manages one open designer editor: render, selection, property edits, and live-update. */
class DesignerSession {
  private readonly designerFile: string | null;
  private readonly disposables: vscode.Disposable[] = [];
  private currentId = 'this';
  // The strip item currently shown in the Properties panel (item→Properties), or null when a control is selected. Set by
  // the `selectItem` gesture, cleared on a control `pick`. A delayed item refresh (loadItemProps after a reset/wire/edit)
  // checks this before pushing `itemProps`, so a stale refresh for item A can't overwrite a newer selection of item B
  // (canvas dispatch isn't serialized.
  private currentSelItem: { ownerId: string; itemId: string } | null = null;
  /** Bumped by every pick(); captured by loadProps so a load whose awaits outlive its selection publishes nothing. */
  private selectionGen = 0;
  private renderSeq = 0;
  private controls: LayoutControl[] = [];
  // 0.10.0 trust-floor S5 — false = the last render FAILED (or nothing has rendered yet). A hard load/render failure
  // leaves a STALE preview on the canvas; while this is false, mutating gestures are refused fail-closed so an edit
  // can't splice against a graph the designer couldn't load. Set true only at fullRender's clean success exit; set
  // false in every failure branch. Stored (not derived from source — a parseable form can still fail to render).
  private renderOk = false;
  // 1.0.0 — the .NET Framework compiled preview shows the last BUILD, never the live source, and cannot prove the
  // build matches `.Designer.cs` (the user can hand-edit and not rebuild). After eight review rounds the divergence
  // LOCK that tried to infer that from instance/build identity was descoped: a lock that
  // can misclassify is less trustworthy than an honest disclosure. net48 forms stay editable; source safety comes from
  // the byte-local firewall in commit(), not from any fidelity inference. Instead composeFormNotice shows an
  // UNCONDITIONAL "this is your last build; rebuild is authoritative" banner on every net48 render. The wire fields
  // liveInstanceId / liveBuildId remain for diagnostics + the release/rebuild e2e, but grant no editing authority.
  /** Monotonic id per reloadFromDiskIfClean run; a read that resumes after a newer one started is discarded. */
  private reloadEpoch = 0;
  private toolStripItems: ToolStripItemBounds[] = []; // per-item geometry from the last render (on-canvas "Type Here")
  private rootClient: { w: number; h: number } | null = null;
  private rootFrame: { w: number; h: number } | null = null;
  /** Which engine renders THIS form — detected per render from the resolved control assembly's runtime
   * (net48 = .NET Framework/DevExpress compiled preview). Drives engine routing + edit gating + the badge. */
  private engineKind: EngineKind = 'modern';
  /** Integer DPI capture scale for the picture, from the webview's devicePixelRatio (1 = logical, 2 = 4K@200%…). The
   * engine renders the PNG at this factor so text/metrics are crisp instead of the frame being upscaled on a high-DPI
   * display. Clamped to [1,2]: ×2/×0.5 is exactly reversible, which the net48 CACHED compiled instance requires. */
  private renderScale = 1;
  private debounce?: ReturnType<typeof setTimeout>;
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
  private net48FallbackReason = '';
  // transient interpreted tab view-state: tab-host field id → selected page field id. Re-supplied
  // to every interpreted render (the interpreted graph is uncached), so a tab-click's selection survives later renders. A
  // stale entry (host/page removed) is a no-op via the engine's narrow adapter.
  private net48SelectedTabs = new Map<string, string>();
  private tabViewState(): string[] { return Array.from(this.net48SelectedTabs, ([h, p]) => `${h}=${p}`); }
  /** Auto-populated toolbox palette — fetched once, then mirrored to the Toolbox view. */
  private toolboxItems: ToolboxItemInfo[] | undefined;
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
  /** Assemblies the user added via the Choose-Items "Browse…" button (accumulated across clicks). */
  private browsedDlls: string[] = [];
  /** (project, assembly) pairs we've already offered a <Reference> for — ask at most once each per session,
   * whatever the user answered, so adding several controls from one library doesn't nag repeatedly. */
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
    if (delayMs == null) {
          this.post({
        type: 'error',
        message: t('host.engineCrashLoop'),
        renderFailure: true,
      });
      return;
    }
    this.post({ type: 'loading', message: t('host.loading.restarting', { ms: delayMs }) });
    setTimeout(() => {
      if (!this.disposed && this.engineKind === kind) void this.fullRender();
    }, delayMs);
  }

  private asm(): string | undefined {
    // Explicit control source wins; otherwise the framework assembly the last render auto-resolved (net48/
    // DevExpress). A net9 form leaves autoAsm undefined → this returns undefined → engine-side auto-discovery.
    return (this.designerFile ? this.getAssemblyOverride(this.designerFile) : undefined) ?? this.autoAsm;
  }

  /** The .Designer.cs this session renders (the key the control-source override is stored under). */
  get designerFilePath(): string | null { return this.designerFile; }

  /** True when this form is rendered by the net48 engine — the picture is a real compiled instance of the last build
   * rather than an interpretation of the text. NOT a read-only state: net48 forms are editable (net9 splices the
   * source, net48 mirrors supported edits onto the live instance). The only read-only states are `localizable` and a
   * failed render (`renderOk` false); net48 additionally shows an unconditional "last build" disclosure banner. */
  get isCompiledPreview(): boolean { return this.engineKind === 'net48'; }

  /**
   * 0.10.0 trust-floor — true when THIS form is [Localizable(true)] (its InitializeComponent uses
   * ComponentResourceManager.ApplyResources), making it a read-only preview: a persisted edit would
   * diverge from the .resx (VS drops it on its next save = silent data loss), and net9 mis-renders it.
   * Computed FRESH from the current in-memory buffer on every read — never cached — so the read-only
   * lock is authoritative regardless of render timing (no stale-false window before the first render,
   * no stale-true window after an external edit). Cheap: two regex tests, only on user-gesture paths.
   */
  private get localizable(): boolean { return isLocalizableDesigner(this.doc.designerText); }

  /** The control assembly currently in effect: explicit override, else the auto-resolved framework assembly
   * (net48/DevExpress) from the last render, else undefined (a net9 form → engine auto-discovery). */
  get controlAssembly(): string | undefined { return this.asm(); }

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
    void this.panel.webview.postMessage(message);
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
    this.post({ type: 'select', id, token });
    DesignerHub.instance.pushPanel(this, { type: 'select', id });
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
      this.toolboxItems = [...framework, ...project];
    } else {
      let items: ToolboxItemInfo[];
      try { items = await listToolboxItems(await this.ensureEngine('modern'), this.designerFile, this.asm()); } catch { return; }
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
      void this.loadProps(this.currentId);
    } else {
      DesignerHub.instance.pushPanel(this, { type: 'clear' }); // not rendered yet → blank until fullRender
    }
  }
  refreshViews(): void { void this.refreshToolbox(); this.refreshProperties(); this.pushClipboardState(); }

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
  // fail-closed gate (byte-local / render-failed / localizable) REFUSED it — the caller must then skip its success
  // status + live-preview mutation so a refused edit never shows as applied was void, callers diverged).
  //
  // 0.11.0 write-safety — an optional `resx` transaction ties a sibling-.resx disk write to THIS undoable edit: the
  // caller writes the new .resx to disk atomically BEFORE calling commit(); we then thread the resx before/after into
  // the undo/redo closures so Ctrl+Z reverts the resource too (deleting a resx this edit created, or restoring its
  // prior bytes) and Ctrl+Y re-applies it. If a fail-closed gate REFUSES here, no edit is fired — the caller then
  // rolls the resx back (revertResx) so neither half lands. The gates run before anything is mutated, so a refusal
  // never leaves a half-applied transaction.
  private commit(before: string, after: string, label: string, resx?: ResxTx): boolean {
    // No-op edit → nothing to persist. But if a resx transaction is attached whose bytes actually CHANGED (a
    // re-import of a new image into a property whose `resources.GetObject("key")` assignment is byte-identical —
    // designer text unchanged, base64 payload different), we must still fire an undo entry so Ctrl+Z reverts the
    // resource. Fall through in that case.
    const resxChanged = !!resx && resx.before !== resx.after;
    if (after === before && !resxChanged) return true;
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
    // 0.10.0 trust-floor — airtight data-loss backstop. Every persisted edit funnels through here; on a
    // localizable form a forward edit would diverge from the .resx (VS drops it on its next save), so
    // refuse to persist even if a mutating message slipped past the LOCALIZABLE_BLOCKED dispatch gate.
    // Classified FRESH from the buffer (the getter), so it is correct even during a render race — the
    // firewall never trusts a stale render-populated flag. (undo/redo set designerText directly, NOT via
    // commit, so reverting a pre-lock edit still works.)
    if (this.localizable) {
      this.output.appendLine('[designer] edit refused — localizable form is read-only (' + label + ')');
      return false;
    }
    this.doc.rev++;
    this.doc.designerText = after;
    // 1.0.0 — reflect the new dirty state in the net48 "last build" banner IMMEDIATELY, at
    // the mutation point, before the caller's awaited loadProps / render. Those can stall or reject (a nonvisual
    // Modifiers edit hydrates via loadProps, whose rejection is caught without reaching the trailing postDirty), which
    // would otherwise leave the banner showing the stale clean wording over a now-dirty source. Idempotent — the notice
    // is deduped, so the caller's later postDirty is a no-op when nothing changed.
    this.postDirty();
    this.fireEdit({
      document: this.doc,
      label,
      // Do the resx disk op FIRST (it can fail — a locked/permission-denied file): if it throws, the in-memory
      // designerText is left untouched and the undo/redo promise rejects, so the two halves never split (
      // mutating text before a fallible resx op leaves the code reverted while the resource didn't move).
      undo: async () => {
        if (resx) await this.revertResx(resx.uri, resx.before, resx.after, resx.bom);
        this.doc.rev++; this.doc.designerText = before;
        await this.rerenderFromDoc();
      },
      redo: async () => {
        if (resx) await this.reapplyResx(resx.uri, resx.before, resx.after, resx.bom);
        this.doc.rev++; this.doc.designerText = after;
        await this.rerenderFromDoc();
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
   * 0.10.0 trust-floor — the read-only lock for a [Localizable(true)] form. Returns true (and shows the
   * read-only status) when this form is localizable AND `type` is a mutating message; the caller then
   * returns without dispatching. Public because BOTH webview message handlers gate through it: the
   * canvas (onMessage) and the Properties panel (WinFormsDesignerProvider.resolveWebviewView), which
   * carries the direct-file-write ops (importImage/clearImage/createHandler) that never reach commit().
   */
  public refuseLocalizableEdit(type: string | undefined): boolean {
    if (!type || !LOCALIZABLE_BLOCKED.has(type) || !this.localizable) return false;
    this.post({ type: 'status', message: t('status.localizableReadonly') });
    return true;
  }

  /**
   * 0.10.0 trust-floor — method-level read-only guard (defense-in-depth beyond the dispatch gates).
   * True (and shows the status) when this form is localizable. Called at the entry of the mutation
   * methods that either write an IRREVERSIBLE side effect before commit() (importImage/clearImage → .resx)
   * or are reachable via a NON-dispatch-gated ingress (navigateHandler → createHandler writes a code-behind
   * stub), so a refused commit() can't be reached with the file already changed.
   */
  private refuseLocalizableMutation(): boolean {
    if (!this.localizable) return false;
    this.post({ type: 'status', message: t('status.localizableReadonly') });
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
    if (!refuseWhileRenderFailed(type, LOCALIZABLE_BLOCKED, this.renderOk)) return false;
    this.post({ type: 'status', message: t('status.renderFailedReadonly') });
    return true;
  }

  private async onMessage(m: {
    type: string; id?: string; mode?: string; x?: number; y?: number; width?: number; height?: number;
    ids?: string[]; dx?: number; dy?: number; prop?: string; propType?: string; isEnum?: boolean; value?: string;
    edits?: Array<{ id: string; dx: number; dy: number }>; controlType?: string; hitId?: string; typeName?: string;
    sizeEdits?: Array<{ id: string; width: number; height: number }>; hostId?: string; pageId?: string;
    axis?: 'h' | 'v'; itemType?: string; text?: string; itemId?: string; parentItemId?: string; token?: number; reopenToken?: number;
    dpr?: number;
  }): Promise<void> {
    try {
      // 0.10.0 trust-floor: a localizable form is a read-only preview — refuse every mutating gesture
      // up front (before any live-picture mutation or text splice) so an edit can't diverge from the
      // .resx. commit() backstops persistence; this gate keeps the UX honest and the picture stable.
      if (this.refuseLocalizableEdit(m.type)) return;
      // 0.10.0 trust-floor S5 — if the last render failed, the canvas is a stale preview of a form that didn't
      // load; refuse mutating gestures so an edit can't target a graph the designer couldn't build.
      if (this.refuseStaleRenderEdit(m.type)) return;
      if (m.type === 'ready') {
        this.gotReady = true;
        // The webview reports its devicePixelRatio so the engine can render the PNG at the display's resolution (crisp on
        // 4K) instead of a blurry upscale. Clamp to an integer in [1,2] — 2 covers the common 4K@200% and keeps the net48
        // cached-instance up/down scaling exactly reversible. A dpr change (window dragged to another monitor) re-posts ready.
        if (typeof m.dpr === 'number' && isFinite(m.dpr)) this.renderScale = Math.max(1, Math.min(2, Math.round(m.dpr)));
        // A fresh/reloaded webview cleared its DOM. Drop the notice cache so fullRender re-sends it, and post the dirty
        // badge SYNCHRONOUSLY now — before the awaited fullRender, which posts dirty only after loadProps and may return
        // early (unbuilt output / engine or render failure) or stall in hydration. Without this, a recovered/pre-existing
        // dirty document would show a clean badge on reload until a render eventually succeeds. A
        // badge-only post (not postDirty) avoids recomposing the net48 notice with the pre-render engineKind; a following
        // successful fullRender then suppresses its identical trailing dirty via lastDirtyPosted.
        this.lastNoticeSig = undefined;
        this.lastDirtyPosted = this.doc.isDirty;
    this.post({ type: 'dirty', dirty: this.doc.isDirty });
        this.output.appendLine('[designer] webview ready: ' + this.designerFile);
        await this.fullRender();
      } else if (m.type === 'pick' && m.id) {
        // thread the canvas-origin pick's correlation token so the echoed `select` can be matched to THIS exact pick
        // (the canvas suppresses only the echo of a pick whose selection an add-editor deliberately dropped.
        await this.pick(m.id, m.token);
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
      } else if (m.type === 'stripAdd' && m.hostId) {
        await this.applyStripAdd(m.hostId, typeof m.itemType === 'string' ? m.itemType : '', typeof m.text === 'string' ? m.text : '', typeof m.parentItemId === 'string' ? m.parentItemId : undefined, typeof m.reopenToken === 'number' ? m.reopenToken : undefined);
      } else if (m.type === 'stripRename' && m.hostId && m.itemId) {
        await this.applyStripRename(m.hostId, m.itemId, typeof m.text === 'string' ? m.text : '');
      } else if (m.type === 'stripRetype' && m.hostId && m.itemId && m.itemType) {
        await this.applyStripRetype(m.hostId, m.itemId, m.itemType, typeof m.text === 'string' ? m.text : '');
      } else if (m.type === 'stripDelete' && m.hostId && m.itemId) {
        await this.applyStripDelete(m.hostId, m.itemId);
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
  async pick(id: string, token?: number): Promise<void> {
    if (this.disposed) return;
    this.currentId = id;
    // Any load still in flight for the PREVIOUS pick is now stale: its awaits can resolve after this one's and would
    // otherwise publish the old control's grid/tasks over the new selection. Bumping the generation here (before the
    // awaits below) lets loadProps drop such a load. Ids alone can't do this — select A, B, A again would let the
    // first A's late reply pass an id check.
    this.selectionGen++;
    this.currentSelItem = null; // a control selection supersedes any item→Properties selection (drops the item-refresh guard)
    this.pushSelect(id, token);
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
   * which of its items are currently in the toolbox (so the checkboxes start in the right state). */
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
    this.renderOk = false; // S5: a hard render failure → read-only until a render succeeds again
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
      this.renderOk = false; // S5: an unbuilt framework project can't render → read-only (this path doesn't call fail())
      this.post({ type: 'error', message: t('host.frameworkUnbuilt'), renderFailure: true });
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
    // Toolbox: net9 shows framework + project controls (one enumeration); net48 merges net9 framework controls
    // with the project/vendor (DevExpress) controls the net48 engine enumerates (the net9 ALC can't load them).
    await this.loadToolboxItems();
    DesignerHub.instance.pushPanel(this, { type: 'toolbox', items: [...(this.toolboxItems ?? []).filter((it) => !DesignerHub.instance.isHidden(it.fqn)), ...DesignerHub.instance.chosenItems] });
    void this.refreshPalette();
    this.post({ type: 'loading', message: t('host.loading.rendering') });
    const text = await this.currentText();
    let result: Awaited<ReturnType<typeof renderWithLayout>>;
    try {
      if (this.engineKind === 'net48') {
        // Render the LIVE .Designer.cs source through the IR interpreter (VS model — instantiate
        // the base type, replay the parsed statements onto it). Forms the interpreter can't fully cover fall back to
        // the compiled last build WITH a named reason. `renderMode` drives the banner below (interpreted = no
        // disclosure, it IS your source; compiledFallback = the "last build" disclosure). The compiled describe/live-
        // edit RPCs are unchanged — for an interpreted, unedited form they read the same build, so selection/props line
        // up; unifying edits onto the interpreted picture is a later step.
        const ir = await this.withTimeout(
          renderInterpretedWithLayout(eng, this.designerFile, asm as string, text ?? '', undefined, undefined, 0, 0, this.tabViewState(), this.renderScale),
          20000, 'engine render timed out — it may be stuck (first-run)');
        result = ir;
      } else {
        result = await this.withTimeout(
            renderWithLayout(eng, this.designerFile, asm, text, this.renderScale),
            20000, 'engine render timed out — it may be stuck (first-run / MSBuild)');
      }
    } catch (err) {
      if (seq === this.renderSeq && !this.disposed) this.fail(err);
      return false;
    }
    if (seq !== this.renderSeq || this.disposed) return false;
    // Persist the net48 render mode ONLY after the sequence gate — mirroring how all other shared state below is
    // mutated post-gate. Assigning it earlier (inside the try) let a SUPERSEDED interpreted render resolve last,
    // overwrite this.net48RenderMode with its stale mode, then bail at the gate without recomposing the banner —
    // leaving the mode field out of sync with the on-screen picture.
    if (this.engineKind === 'net48') {
      const ir = result as typeof result & { renderMode: string; fallbackReason: string };
      this.net48RenderMode = ir.renderMode;
      this.net48FallbackReason = ir.fallbackReason;
    }
    this.output.appendLine(`[designer] render #${seq} ok: ${result.png.length}B, ${result.controls.length} controls`);

    this.controls = result.controls;
    this.toolStripItems = result.toolStripItems ?? [];
    this.rootClient = { w: result.clientWidth, h: result.clientHeight };
    this.rootFrame = { w: result.width, h: result.height };
    this.post({ type: 'render', png: result.png.toString('base64'), width: result.width, height: result.height, gen: seq });
    this.postLayout(result.controls, this.toolStripItems);
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
    // Keep the selection across a full re-render only if it still exists — as a visual control OR a tray component
    // (a ContextMenuStrip, Timer, …); otherwise fall back to the root form. Consulting the tray too matters after
    // editing a tray component's collection (e.g. a ContextMenuStrip's Items commits via this net9 fullRender):
    // without it the selection would snap to the form. See retainSelectionId (unit-tested in e2e.ts).
    this.currentId = retainSelectionId(this.currentId, result.controls, result.tray);
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
    this.maybePromptForControlSource(result.unrepresentable, asm);
    // T2.2: surface WHAT the (partial) render skipped — controls whose ctor threw, unresolved types, unsupported
    // constructs — as a dismissible canvas banner. The engine already renders resiliently and records each dropped
    // statement + reason in `unrepresentable`; categorize it host-side (pure) and hand the canvas a compact set.
    // Empty items → the webview hides any stale banner (this render is clean). net48's compiled render is all-or-
    // nothing, so this is effectively net9 partial-render diagnostics; net48 per-control skip reasons are a follow-up.
    this.post({ type: 'renderDiag', items: categorizeUnrepresentable(result.unrepresentable) });
  // composeFormNotice(result) was already posted synchronously right after the render/layout/tray posts above, so a
  // stalled loadProps can never leave the canvas without its persistent notice.
    return true; // a fresh render→layout→tray was posted → the canvas forest is current
  }

  /**
   * 0.10.0 / 1.0.0 — post the single-slot persistent #formNotice. The one place that composes the banner, so every
   * render path stays consistent. A clean modern render posts `kind:null` (hides the banner).
   *
   * Visible banner producers:
   * - localizable read-only lock (S1) — 🔒;
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
    // The visible banner covers only the modern-engine disclosures (⚠️ binaryResx / inheritedBase) and the localizable
    // read-only lock (🔒). net48Preview is deliberately NOT passed — it no longer drives a banner (see above).
    const kind = chooseFormNoticeKind(this.localizable, inheritedModern, binaryResx);
    let payload: { type: 'formNotice'; kind: FormNoticeKind; icon?: string; text?: string };
    if (kind === null) {
    payload = { type: 'formNotice', kind: null }; // clean render → hide
    } else {
      const parts: string[] = [];
      if (this.localizable) parts.push(t('designer.notice.localizable'));
      if (binaryResx) parts.push(t('designer.notice.binaryResx', { n: res.unrenderableResxCount ?? 0 }));
      if (inheritedModern) parts.push(t('designer.notice.inheritedBase', { base: res.baseTypeName ?? '' }));
      const icon = this.localizable ? '🔒' : '⚠️';
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
    const csproj = findOwningCsproj(path.dirname(this.designerFile), this.wsRoot());
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

  private resolveRouting(explicitAsm: string | undefined): { kind: EngineKind; asm: string | undefined; frameworkUnbuilt: boolean } {
    if (explicitAsm) return { kind: detectEngineKind(explicitAsm), asm: explicitAsm, frameworkUnbuilt: false };
    // findOwningCsproj, not findNearestCsproj: a form living in a SHARED PROJECT (.shproj/.projitems) has no .csproj
    // above it, so the walk returned null and everything below — the net48 routing AND every "pick an assembly"
    // offer — was skipped. The form then went to the .NET 9 renderer with no assembly and came back empty.
    const csproj = this.designerFile ? findOwningCsproj(path.dirname(this.designerFile), this.wsRoot()) : null;
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

  /** Describe the selected component → push its grid to the Properties view + its manipulability to the canvas. */
  private async loadProps(id: string): Promise<void> {
    if (!this.designerFile || this.disposed) return;
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
      let vendorTags: VendorTagView[] = [];
      if (asm48) {
        // pass the UNSAVED buffer so the net48 source-metadata pass (bold / wired-handler) reflects an unsaved reset /
        // wiring on a CONTROL too (parity with the item path — the same pre-existing disk-staleness, closed here).
        // …and the vendor's own declared Tasks menu (DevExpress "Add Tab Page"…), if this control's compiled type
        // ships one — net48 only, since reading it needs the real type the net9 engine can't load. Fetched CONCURRENTLY
        // with the describe on purpose: a second sequential await would widen the window in which a newer selection's
        // `tasks` post can be overtaken by this older one. Both are best-effort — a failure degrades to no vendor menu.
        srcRev = this.doc.rev; // bind the SOURCE revision (bumps on edit/undo/load, not a view render) BEFORE the sync text sample
        const text = await this.currentText();
      const eng48 = await this.ensureEngine('net48');
        // when the net48 CANVAS is interpreted (live source), describe the SAME interpreted
        // instance so the panel matches the canvas on an unsaved edit; a null (unknown/inherited/non-interpreted) leaves
        // the panel UNAVAILABLE — it must NEVER fall back to compiled values under an interpreted canvas. Only a
        // compiled/fallback canvas describes the cached compiled instance.
        const interpreted = this.net48RenderMode === 'interpreted';
        const describeP = interpreted
          ? describeInterpretedComponent(eng48, this.designerFile, asm48, text ?? '', id).catch(() => null)
          : describeCompiledComponent(eng48, this.designerFile, asm48, id, undefined, undefined, text).catch(() => null);
        const [c, v] = await Promise.all([describeP, this.vendorTagsFor(id)]);
        comp = c;
        vendorTags = v;
      }
      if (this.disposed || gen !== this.selectionGen || srcRev !== this.doc.rev) return; // a newer pick OR SOURCE edit superseded this load
      DesignerHub.instance.pushPanel(this, { type: 'props', id, component: comp });
      this.post({ type: 'tasks', id, component: comp, vendorTags }); // canvas smart-tag flyout data
      // A null describe under an INTERPRETED canvas means the selection is unavailable (unknown/inherited) — disable
      // move/resize too, else the canvas would offer manipulation of a component the panel can't describe.
      const manip = (comp === null && this.net48RenderMode === 'interpreted')
        ? { move: false, resize: false }
      : this.manipFor(id, comp); // single drag/resize is live (net9 splices Location/Size, net48 mutates)
      this.post({ type: 'manip', id, move: manip.move, resize: manip.resize });
      return;
    }
    const eng = await this.ensureEngine();
    srcRev = this.doc.rev; // bind the SOURCE revision BEFORE the sync text sample — see the net48 path above
    const text9 = await this.currentText();
    const component = await describeComponent(eng, this.designerFile, id, this.asm(), text9);
    if (this.disposed || gen !== this.selectionGen || srcRev !== this.doc.rev) return; // a newer pick OR SOURCE edit superseded this load
    DesignerHub.instance.pushPanel(this, { type: 'props', id, component });
    // No vendor tags on net9: reading them needs the real compiled vendor type, which this engine can't load (a form
    // that uses vendor controls doesn't render here at all). Sent explicitly so the canvas clears a stale net48 menu.
    this.post({ type: 'tasks', id, component, vendorTags: [] }); // canvas smart-tag flyout data
    const manip = this.manipFor(id, component);
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
          const eng48i = await this.ensureEngine('net48');
          component = this.net48RenderMode === 'interpreted'
            ? await describeInterpretedComponent(eng48i, this.designerFile, asm48, text48 ?? '', itemId)
            : await describeCompiledComponent(eng48i, this.designerFile, asm48, itemId, undefined, undefined, text48);
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
    if (!this.commit(before, text, `Move ${applied} control${applied > 1 ? 's' : ''}`)) return;
    this.output.appendLine(`moved ${applied} controls by (${Math.round(dx)}, ${Math.round(dy)}) (unsaved)`);
    if (this.engineKind === 'net48') await this.live48((e) => applyCompiledEdits(e, this.designerFile!, this.asm()!, live48Edits), true, {});
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
      const ox = (this.rootFrame.w - this.rootClient.w) / 2; // symmetric side borders
      const oy = (this.rootFrame.h - this.rootClient.h) - ox; // caption = total vertical chrome − bottom border
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
    if (!this.commit(before, text, `Align ${applied} control${applied > 1 ? 's' : ''}`)) return;
    this.output.appendLine(`aligned ${applied} controls (unsaved)`);
    if (this.engineKind === 'net48') await this.live48((ee) => applyCompiledEdits(ee, this.designerFile!, this.asm()!, live48Edits), true, {});
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
    if (!this.commit(before, text, `Resize ${applied} control${applied > 1 ? 's' : ''}`)) return;
    this.output.appendLine(`resized ${applied} controls (unsaved)`);
    if (this.engineKind === 'net48') await this.live48((ee) => applyCompiledEdits(ee, this.designerFile!, this.asm()!, live48Edits), true, {});
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
    if (!this.commit(before, text, `Remove ${applied} control${applied > 1 ? 's' : ''}`)) return;
    this.currentId = 'this';
    this.output.appendLine(`removed ${applied} controls (unsaved)`);
    if (this.engineKind === 'net48') await this.live48((e) => removeCompiledControls(e, this.designerFile!, this.asm()!, removed), true, {});
    else await this.fullRender();
    this.post({ type: 'status', message: tn('status.removed', applied) });
  }

  /** Grid edit from the Properties view, with its own error/restore handling. */
  async editFromGrid(id: string, prop: string, propType: string, isEnum: boolean, value: string, refEdit = false, designTime = false): Promise<void> {
    try {
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

    if (!this.commit(before, finalText, `Set ${id}.${prop}`)) return;
    this.output.appendLine(`set ${id}.${prop} = ${expr} (${res.mode}, unsaved)`);
    this.post({ type: 'status', message: t('status.propSet', { id, prop }) });

    // net9 re-renders the interpreted graph from the edited text; net48 can't (it renders the compiled assembly),
    // so it mutates the LIVE instance for an immediate picture — the text edit above is what persists on save.
    if (this.engineKind === 'net48') {
      await this.liveEdit48(id, prop, liveRaw);
    } else {
      await this.patchOrRerender(id, prop);
    }
    await this.loadProps(id);
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
  private async liveEdit48(id: string, prop: string, raw: string): Promise<void> {
    const asm = this.asm();
    if (!asm || !this.designerFile) return;
    // a property edit IS a committed source-backed edit, so opt into interpreted re-render: under
    // an interpreted canvas re-interpret the committed source (fullRender) instead of mutating the compiled instance.
    // ALWAYS skipReselect: this matches the earlier net48 `show48`, which posted NO host control selection — so the
    // webview keeps its current selection and the trailing loadProps(id)/loadItemProps restores the grid. Posting a fresh
    // control select instead breaks a visibility-changing edit (Visible=false leaves the control out of the layout →
    // selection snaps to the form → the hidden control's grid is dropped and can't be set back) and clears an item/nested
    // highlight — both are visibility contracts (CONTROL-visibility + ITEM-highlight).
    await this.live48((eng) => setCompiledPropertyLive(eng, this.designerFile!, asm, id, prop, raw), true, { skipReselect: true });
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
  private async live48(op: (eng: EngineHandle) => Promise<RenderLayout>, notifyOnNotApplied = true, interp?: { skipReselect?: boolean }): Promise<boolean> {
    if (!this.designerFile || !this.asm()) return false;
    if (interp && this.net48RenderMode === 'interpreted') return this.fullRender(interp.skipReselect ?? false);
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
        const eng48r = await this.ensureEngine('net48');
        return this.net48RenderMode === 'interpreted'
          ? await describeInterpretedComponent(eng48r, this.designerFile, asm, textR ?? '', id)
          : await describeCompiledComponent(eng48r, this.designerFile, asm, id, undefined, undefined, textR);
      }
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

  /**
   * Import an image into a resx-backed image/icon property ("Import…"): pick a file, embed it into the form's
   * sibling .resx and write the `resources.GetObject` assignment. The .resx is written to disk immediately (a
   * resource file, like VS), atomically (temp+rename); the .Designer.cs edit is the undoable in-memory thing.
   * 0.11.0 write-safety — the resx write is bundled into the SAME undoable transaction (via commit's `resx` arg),
   * so Ctrl+Z reverts BOTH the assignment and the resource (deleting a .resx this import created, or restoring
   * its prior bytes), and Ctrl+Y re-applies both. The resx revert is conflict-guarded (a concurrent external
   * change is left alone). Existing forward guards stay: localizable re-check, on-disk .resx conflict, binary-node drop.
   */
  async importImageFromGrid(id: string, prop: string, propType: string): Promise<void> {
    if (!this.designerFile) return;
    if (this.refuseLocalizableMutation()) return; // writes the .resx before commit() — guard the irreversible write
    if (this.refuseUnknownBaselineMutation()) return; // no trustworthy baseline → no file write
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
      const resxRead = await this.readResx(resxUri);
      const resxText = resxRead?.text ?? null;
      const resxBom = resxRead?.hadBom ?? false; // preserve the file's own BOM; a .resx we create gets none
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

      // 0.10.0 trust-floor TOCTOU close: the form could have turned localizable DURING the file picker /
      // engine round-trip above (the entry guard ran before them). Re-check FRESH immediately before the
      // irreversible .resx write, so a form that became read-only mid-operation can't have its .resx changed.
      // The render can equally have FAILED, or the baseline gone unknown, across that same (user-length!) window:
      // commit() would then refuse and revertResx would roll the file back, so this was never a lost write — but
      // refusing here means the user's .resx is never written-then-unwritten at all.
      if (this.refuseLocalizableMutation()) { await this.loadProps(id); return; }
      if (this.refuseUnknownBaselineMutation()) { await this.loadProps(id); return; }
      if (this.refuseStaleRenderMutation()) { await this.loadProps(id); return; }
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
        return; // never write a .resx built from a now-stale snapshot
      }
      const droppedN = binaryResxCount(resxText) - binaryResxCount(res.resxText);
      if (droppedN > 0) {
        this.output.appendLine(`import refused: it would drop ${droppedN} binary resx resource(s)`);
        this.post({ type: 'status', message: t('status.binaryResxRegenRefused', { n: droppedN }) });
        await this.loadProps(id);
        return; // never write a .resx that dropped a binary node
      }
      // 0.11.0 write-safety — write the .resx to disk ATOMICALLY (temp+rename; the engine reads it from disk on the
      // render below), then commit the designer edit as ONE undoable transaction. The resx before/after is threaded
      // into commit() so Ctrl+Z reverts the resource too (deleting a .resx this import created, or restoring its
      // prior bytes) rather than leaving a permanent orphan. If a fail-closed gate refuses the designer edit AFTER
      // the resx hit disk, roll the resx back so neither half lands (never a resx entry with no assignment).
      await this.atomicWriteFile(resxUri, this.resxBytesOf(res.resxText, resxBom));
      const resxTx: ResxTx = { uri: resxUri, before: resxText, after: res.resxText, bom: resxBom };
      if (!this.commit(before, res.designerText, `Import ${id}.${prop} image`, resxTx)) {
        await this.revertResx(resxUri, resxText, res.resxText, resxBom);
        await this.loadProps(id);
        return;
      }
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
   * entry is left as a harmless orphan (mirrors VS, which also doesn't prune unused resources on clear). */
  async clearImageFromGrid(id: string, prop: string): Promise<void> {
    if (!this.designerFile) return;
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
  async editImageListImages(): Promise<void> {
    if (!this.designerFile) return;
    if (this.refuseLocalizableMutation()) return; // writes the .resx (irreversible pre-commit) — guard up front
    if (this.refuseUnknownBaselineMutation()) return; // no trustworthy baseline → no file write
    if (!this.renderOk) { this.post({ type: 'status', message: t('status.renderFailedReadonly') }); return; }
    const id = this.currentId;
    if (!id || id === 'this') { this.post({ type: 'status', message: t('status.selectImageListFirst') }); return; }
    try {
      const eng9 = await this.ensureEngine('modern');
      const asm = this.asm();
      // confirm the current selection really is an ImageList (else the SetKeyName/ImageStream rewrite is meaningless).
      const desc = this.engineKind === 'net48' && asm
        ? await describeCompiledComponent(await this.ensureEngine('net48'), this.designerFile, asm, id, undefined, undefined, this.doc.designerText)
        : await describeComponent(eng9, this.designerFile, id, asm, this.doc.designerText);
      if (!desc || !/(^|\.)ImageList$/.test(desc.type)) { this.post({ type: 'status', message: t('status.selectImageListFirst') }); return; }

      // read the CURRENT images: deserialize the existing .resx ImageStream blob (net48), pair with designer keys.
      const resxUri = this.resxUri();
      const resxRead = await this.readResx(resxUri);
      const resxText = resxRead?.text ?? null;
      const resxBom = resxRead?.hadBom ?? false; // preserve the file's own BOM; a .resx we create gets none
      const blob = extractResxBinaryValue(resxText, id + '.ImageStream');
      const eng48 = await this.ensureEngine('net48');
      let images: { dataBase64: string; key: string }[] = [];
      let width = 16, height = 16, colorDepth = 'Depth32Bit', transparentColor = 'Transparent';
      if (blob) {
        const read = await deserializeImageList(eng48, blob);
        if (read.ok) {
          const keys = parseImageListKeys(this.doc.designerText, id);
          images = read.images.map((im, i) => ({ dataBase64: im.dataBase64, key: keys[i] ?? '' }));
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
        return;
      }

      const edited = await this.manageImagesUi(id, images);
      if (!edited) return; // cancelled or unchanged

      // serialize the full set (net48) → VS-format ImageStream blob (+ validated round-trip count).
      const ser = await serializeImageList(eng48, { images: edited, width, height, colorDepth, transparentColor });
      if (!ser.ok) { this.post({ type: 'status', message: t('status.importRejected', { reason: ser.reason || 'unsafe' }) }); return; }

      // rewrite the designer + embed the blob (net9) — returns both new texts.
      const before = this.doc.designerText;
      const revBefore = this.doc.rev;
      const set = await setImageList(eng9, this.designerFile, id, ser.base64, ser.keys, resxText, before);
      if (!set.safe || set.designerText === null || set.resxText === null) { this.post({ type: 'status', message: t('status.importRejected', { reason: set.reason || 'unsafe' }) }); return; }
      if (this.doc.rev !== revBefore) { this.post({ type: 'status', message: t('status.docChangedImport') }); return; }
      // TOCTOU close + S3 fail-closed guards, identical to importImageFromGrid (the .resx write is irreversible).
      if (this.refuseLocalizableMutation()) return;
      if (this.refuseUnknownBaselineMutation()) return; // no trustworthy baseline → no file write
      if (this.refuseStaleRenderMutation()) return; // a render that failed across the images dialog → no file write
      const freshResx = await this.readResx(resxUri);
      if ((freshResx?.text ?? null) !== resxText || (freshResx?.hadBom ?? false) !== resxBom) { this.post({ type: 'status', message: t('status.docChangedImport') }); return; }
      const droppedN = binaryResxCount(resxText) - binaryResxCount(set.resxText);
      if (droppedN > 0) { this.post({ type: 'status', message: t('status.binaryResxRegenRefused', { n: droppedN }) }); return; }

      // atomic + undoable write: .resx to disk (temp+rename), designer as one undoable transaction.
      await this.atomicWriteFile(resxUri, this.resxBytesOf(set.resxText, resxBom));
      const resxTx: ResxTx = { uri: resxUri, before: resxText, after: set.resxText, bom: resxBom };
      if (!this.commit(before, set.designerText, `Edit ${id} images`, resxTx)) { await this.revertResx(resxUri, resxText, set.resxText, resxBom); return; }
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
    } catch (err) {
      this.post({ type: 'status', message: t('status.importFailed', { error: errMsg(err) }) });
    }
  }

  /** Native add/remove manage loop for the ImageList editor. Returns the new image set, or null if the user made no
   * change / cancelled. Reorder + key-rename are follow-ups; add + remove cover the core (and are undoable as one edit). */
  private async manageImagesUi(id: string, images: { dataBase64: string; key: string }[]): Promise<{ dataBase64: string; key: string }[] | null> {
    const cur = images.slice();
    let changed = false;
    for (; ;) {
      const menu: Array<vscode.QuickPickItem & { action: string }> = [
        { label: '$(add) ' + t('imageList.add'), action: 'add' },
      ];
      if (cur.length) menu.push({ label: '$(trash) ' + t('imageList.remove'), action: 'remove' });
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
            cur.push({ dataBase64: Buffer.from(bytes).toString('base64'), key });
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
      }
    }
    return changed ? cur : null;
  }

  /** Per-property Reset (VS grid right-click → "Reset"): delete the property's source assignment via the
   * safe-save-gated, no-op-safe ResetProperty (a pure net9 text splice, engine-agnostic), then refresh the picture.
   * net9 re-renders the interpreted graph from the edited text; net48 renders the COMPILED assembly (stale after a
   * text-only edit), so it resets the LIVE instance (pd.ResetValue) for an immediate, matching picture. */
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

  /** Reset a ToolStrip item property to its default — the item-aware sibling of resetFromGrid (routed here when the
   * grid message carries an `ownerId`, i.e. item→Properties is shown). The text splice (resetProperty) is field-agnostic
   * so it targets the item field directly; the picture-refresh mirrors applyItemEdit: net9 fullRender(skipReselect) to
   * keep the item highlight (not patchOrRerender, which reselects the control), net48 liveReset48 (the SAME live-reset
   * primitive controls use — TryReset already resolves a ToolStripItem via ResolveLiveEditTarget). Refreshes the item
   * grid via the itemProps channel (loadItemProps), never the control props (loadProps). */
  async resetItemFromGrid(ownerId: string, itemId: string, prop: string): Promise<void> {
    if (!this.designerFile) return;
    try {
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

    if (!this.commit(before, res.text, `Set ${id}.${cell}`)) return;
    this.output.appendLine(`set ${id}.${cell} = ${n} (table cell, unsaved)`);
    this.post({ type: 'status', message: t('status.cellSet', { id, cell }) });

    // a cell move repositions the control and can re-flow its siblings → full re-render, not a single-control patch
    await this.fullRender();
    await this.loadProps(id);
    await this.postDirty();
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

  /** Read side of the typed ListView.Columns editor: send the "…"-opened collection's current columns to the
   * webview. Parses the unsaved buffer. PURE-TEXT → routed to the net9 engine even for a net48 form. */
  async sendColumnItems(id: string): Promise<void> {
    if (!this.designerFile) {
      this.post({ type: 'columnItems', id, ok: false, columns: [], reason: 'not available' });
      return;
    }
    try {
      const eng = await this.ensureEngine('modern');
      const res = await listColumns(eng, this.designerFile, id, this.doc.designerText);
      this.post({ type: 'columnItems', id, ok: res.ok, columns: res.columns ?? [], reason: res.reason });
    } catch (err) {
      this.post({ type: 'columnItems', id, ok: false, columns: [], reason: errMsg(err) });
    }
  }

  /** Write side of the typed ListView.Columns editor (VS "Collection Editor"). Mirrors collectionFromGrid's
   * error/restore + single-undo commit. */
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
    const eng = await this.ensureEngine('modern'); // PURE-TEXT splice — modern engine even on a net48 form
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

    if (!this.commit(before, res.text, `Set ${id}.Columns`)) return;
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

  /** Read side of the ToolStrip/MenuStrip item editor. Parses the unsaved buffer. PURE-TEXT → net9 even on net48. */
  async sendToolStripItems(id: string): Promise<void> {
    if (!this.designerFile) {
      this.post({ type: 'toolStripItems', id, ok: false, items: [], reason: 'not available' });
      return;
    }
    try {
      const eng = await this.ensureEngine('modern');
      const revAtRead = this.doc.rev; // against the very text handed to the reader on the next line
      const res = await listToolStripItems(eng, this.designerFile, id, this.doc.designerText);
      if (res.ok) this.stripReadRev.set(id, revAtRead);
      else this.stripReadRev.delete(id);
      this.post({ type: 'toolStripItems', id, ok: res.ok, items: res.items ?? [], reason: res.reason });
    } catch (err) {
      this.stripReadRev.delete(id);
      this.post({ type: 'toolStripItems', id, ok: false, items: [], reason: errMsg(err) });
    }
  }

  /** Write side of the ToolStrip/MenuStrip item editor (reorder / add / remove). Mirrors treeNodesFromGrid's error/restore. */
  async toolStripFromGrid(id: string, items: ToolStripItemModel[]): Promise<void> {
    try {
      // Gate on the revision the panel's forest was READ at, not on "now" — see stripReadRev.
      await this.applyToolStripItems(id, items, false, this.stripReadRev.get(id));
    } catch (err) {
      this.post({ type: 'status', message: errMsg(err) });
      try { await this.loadProps(id); } catch { /* best effort */ }
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
    if (!this.commit(before, text, `Set ${id} (${edits.length} properties)`)) return;
    this.output.appendLine(`set ${id} ${edits.map((e) => e.prop).join('+')} (${edits.length} edits, unsaved)`);
    if (this.engineKind === 'net48') {
      // a multi-property control edit (e.g. an N/W/NW/NE/SW resize = Location+Size) is a committed
      // source-backed edit; opt into interpreted re-render. skipReselect (like liveEdit48) so the trailing loadProps(id)
      // keeps the grid and a visibility-changing property can't strand the selection.
      await this.live48((e) => applyCompiledEdits(e, this.designerFile!, this.asm()!,
        edits.map((ed) => ({ componentId: id, propName: ed.prop, rawValue: ed.value }))), true, { skipReselect: true });
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

  async navigateToHandler(id: string, eventName: string, handler: string | undefined, ownerId?: string): Promise<void> {
    if (this.disposed || !this.designerFile) return;
    if (handler) { await this.openHandlerAt(this.codeFile(), handler); return; }
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

  async createHandler(id: string, eventName: string, handlerName?: string, ownerId?: string): Promise<void> {
    if (!this.designerFile) return;
    // 0.10.0 trust-floor: reachable via navigateHandler (NOT a LOCALIZABLE_BLOCKED message) and the grid's
    // "(new handler)" path — refuse here so a read-only localizable form can't gain a code-behind stub +
    // event-wiring splice. Navigating to an EXISTING handler stays allowed (navigateToHandler's open branch).
    if (this.refuseLocalizableMutation()) return;
    if (this.refuseUnknownBaselineMutation()) return; // no trustworthy baseline → no file write
    // Same reasoning for the render gate: navigateHandler is not a LOCALIZABLE_BLOCKED message, so nothing stopped
    // this path on a failed-render form — the .cs stub was written and only the wiring was refused by commit(),
    // leaving an orphan handler behind. Navigating to an EXISTING handler is unaffected (that branch never gets here).
    if (this.refuseStaleRenderMutation()) return;
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

    // 0.10.0 trust-floor TOCTOU close: the form could have turned localizable DURING the engine round-trip
    // above (the entry guard ran before it). Re-check FRESH before writing the code-behind stub so a form
    // that became read-only mid-operation can't gain a stub + wiring.
    if (this.refuseLocalizableMutation()) return;
    if (this.refuseUnknownBaselineMutation()) return; // no trustworthy baseline → no file write
    // Same for the render gate: a concurrent fullRender can FAIL during the engine round-trip above without moving
    // doc.rev (a control-source reload, a webview reinit), so the rev check misses it. Without this fresh look the
    // stub still lands and only commit() refuses the wiring — recreating the orphan handler the entry guard exists
    // to prevent.
    if (this.refuseStaleRenderMutation()) return;
    // Apply the code-behind .cs stub FIRST (a real text edit the user reads/writes); only then commit the
    // in-memory .Designer.cs wiring — so we never wire an event to a handler stub that failed to write.
    if (gen.codeText != null) {
      // Apply the stub as a ONE-POINT INSERT, never a whole-document replace. The replace was built from the
      // `codeBefore` snapshot and spanned the entire file, so any edit that landed during the awaited applyEdit — a
      // formatter, a source generator, the user typing — was silently erased: applyEdit carries no version
      // precondition, and the version check above only covers the moment before the write. An insert touches
      // one offset, so everything else in the user's .cs survives regardless.
      const edit = new vscode.WorkspaceEdit();
      if (gen.codeInsertText != null && gen.codeInsertOffset >= 0) {
        edit.insert(codeDoc.uri, codeDoc.positionAt(gen.codeInsertOffset), gen.codeInsertText);
      } else {
        // No minimal form offered (shouldn't happen — the engine always emits one for a stub); refuse rather than
        // fall back to overwriting the file wholesale.
        this.post({ type: 'status', message: t('status.couldNotWriteStub') });
        return;
      }
      if (!(await vscode.workspace.applyEdit(edit))) { this.post({ type: 'status', message: t('status.couldNotWriteStub') }); return; }
      // VERIFY the write landed where it was aimed. `gen.codeText` is exactly what the engine says the file becomes
      // once this insert is applied to `codeBefore`, so any mismatch means something else changed the document across
      // the awaited applyEdit — and our offset, computed against the snapshot, may have addressed a completely
      // different place (inside a method body, a string, past EOF). The insert can't be taken back safely, but the
      // WIRING must not be committed on top of it: that is what would turn a visibly misplaced method into a
      // .Designer.cs that references a handler the form doesn't semantically have. Detect and refuse, loudly.
      if (codeDoc.getText() !== gen.codeText) {
        this.output.appendLine('[designer] handler wiring refused: the code-behind changed while the stub was being written');
        this.post({ type: 'status', message: t('status.docChanged') });
        return;
      }
      // The gates above were fresh immediately before this write, but applyEdit is itself awaited: a concurrent render
      // can FAIL (or the form turn localizable, or the baseline go unknown) WHILE the stub is landing. Re-check, so the
      // WIRING is refused with the real reason rather than by commit()'s generic backstop.
  //
      // The stub itself stays — an unused empty method the user can Ctrl+Z. Taking it back would mean a read-then-
      // replace of the whole .cs, and applyEdit carries no version precondition, so a concurrent edit landing in that
      // gap would be erased by the rollback. Leaving a dead method is the smaller harm; refusing to roll back
      // IS the fail-closed side here. (This is only defensible because the forward write above is a one-point insert —
      // while it was a whole-document replace, the "harmless orphan" claim was simply false.)
      if (this.refuseLocalizableMutation() || this.refuseUnknownBaselineMutation() || this.refuseStaleRenderMutation()) return;
      if (this.doc.rev !== designerRev) { this.post({ type: 'status', message: t('status.docChanged') }); return; }
    }
    // if the designer wiring is refused by a fail-closed gate, don't claim success or navigate (the code-behind stub
    // written above is the user's own .cs — undoable — and stays; the wiring just isn't persisted).
    if (gen.designerText != null && !this.commit(designerBefore, gen.designerText, `Wire ${id}.${eventName}`)) return;

    this.output.appendLine(`created handler ${gen.handlerName} for ${id}.${eventName}${gen.alreadyWired ? ' (already wired)' : ''} (unsaved)`);
    await this.refreshAfterWiring(id, ownerId);
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

  async setHandler(id: string, event: string, value: string, ownerId?: string): Promise<void> {
    if (value === NEW_HANDLER) { await this.createHandler(id, event, undefined, ownerId); return; }
    await this.applyEventWiring(id, event, value === '' ? null : value, ownerId);
  }

  private async applyEventWiring(id: string, event: string, handler: string | null, ownerId?: string): Promise<void> {
    if (!this.designerFile || this.disposed) return;
    const eng = await this.ensureEngine();
    const codePath = this.codeFile();
    // Keep the DOCUMENT, not just its text: the engine validates the handler against this snapshot, so the wiring is
    // only sound if the code-behind still says the same thing when we commit.
    const codeDoc = codePath ? await vscode.workspace.openTextDocument(codePath) : null;
    const codeText = codeDoc ? codeDoc.getText() : null;
    const codeVer = codeDoc ? codeDoc.version : -1;

    const before = this.doc.designerText;
    const rev = this.doc.rev;

    const res = await setEventWiring(eng, this.designerFile, id, event, handler, before, codeText, this.asm() ?? null);
    if (!res.safe || res.designerText == null) {
      this.post({ type: 'status', message: t('status.wiringRejected', { reason: res.reason || 'unsafe' }) });
      await this.refreshAfterWiring(id, ownerId);
      return;
    }
    // The .Designer.cs revision was always checked here; the CODE-BEHIND was not checked at all. The engine had just
    // confirmed the handler exists in the snapshot above — but if it was renamed or deleted during the round-trip,
    // this committed `Click += new EventHandler(this.button1_Click)` against a method that no longer exists, and said
    // it wired successfully. createHandler guarded its own write and this sibling path stayed fail-open.
    if (this.doc.rev !== rev || (codeDoc !== null && codeDoc.version !== codeVer)) {
      this.post({ type: 'status', message: t('status.docChanged') });
      await this.refreshAfterWiring(id, ownerId);
      return;
    }
    if (!this.commit(before, res.designerText, `${handler ? 'Wire' : 'Unwire'} ${id}.${event}`)) return;
    this.output.appendLine(`${handler ? 'wired' : 'unwired'} ${id}.${event}${handler ? ' → ' + handler : ''} (unsaved)`);
    this.post({ type: 'status', message: handler ? t('status.wired', { event, handler }) : t('status.unwired', { event }) });
    await this.refreshAfterWiring(id, ownerId);
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
    if (!this.commit(before, res.newText, `Add ${controlType}`)) return;
    this.currentId = res.name;
    this.output.appendLine(`added ${controlType} → ${res.name} (unsaved)`);
    if (this.engineKind === 'net48') await this.live48((e) => addCompiledControl(e, this.designerFile!, asm!, parentId || 'this', controlType, res.name, locX, locY), true, {});
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
    const eng = await this.ensureEngine();
    const before = this.doc.designerText;
    const rev = this.doc.rev;
    const res = await addComponent(eng, this.designerFile, componentType, before);
    if (!res.safe || res.newText === null) { this.post({ type: 'status', message: t('status.addRejected', { reason: res.reason || 'unsafe' }) }); return; }
    if (this.doc.rev !== rev) { this.post({ type: 'status', message: t('status.docChanged') }); return; }
    if (!this.commit(before, res.newText, `Add ${componentType}`)) return;
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
    if (!this.commit(before, res.newText, `Remove ${id}`)) return;
    this.currentId = 'this';
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
    if (!this.commit(before, text, `Paste ${applied} control${applied > 1 ? 's' : ''}`)) return;
    this.currentId = last || this.currentId;
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
    if (this.net48RenderMode === 'interpreted') {
      // under an interpreted canvas, tab navigation is TRANSIENT VIEW STATE (not a source edit):
      // resolve the clicked page on the interpreted geometry, record it, and re-render interpreted with that page
      // selected — the canvas stays interpreted (no compiled mutation, no flip to the build). Off a header → no-op.
    let hit;
      try { hit = await hitTestInterpretedTab(await this.ensureEngine('net48'), this.designerFile!, asm, (await this.currentText()) ?? '', hostId, Math.round(x), Math.round(y), this.tabViewState()); }
    catch { return; }
      if (hit.pageId) { this.net48SelectedTabs.set(hostId, hit.pageId); await this.fullRender(true); }
      return;
    }
    // notifyOnNotApplied=false — this is NAVIGATION, not an edit: it persists no source, and its ordinary
    // `applied===false` (the point wasn't on another tab's header — the active tab or the page body) is a plain no-op,
    // so it must not post a "changes aren't reflected" status.
    await this.live48((e) => selectCompiledTabAt(e, this.designerFile!, asm, hostId, Math.round(x), Math.round(y)), false);
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
    // hit-test against the geometry the user actually sees: interpreted when the canvas is interpreted
    // (else the compiled build's tab-header rects, which can differ after a live move.
    try {
      hit = this.net48RenderMode === 'interpreted'
        ? await hitTestInterpretedTab(await this.ensureEngine('net48'), this.designerFile!, asm, (await this.currentText()) ?? '', hostId, Math.round(x), Math.round(y), this.tabViewState())
        : await hitTestCompiledTab(await this.ensureEngine('net48'), this.designerFile!, asm, hostId, Math.round(x), Math.round(y));
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
    if (!this.commit(before, res.newText, `Add tab ${res.name}`)) return;
    this.currentId = res.name;
    this.output.appendLine(`added tab ${res.name} to ${hostId} (unsaved)`);
    // Adding a tab is a committed source-backed edit: opt into interpreted re-render (like delete-tab) so an interpreted
    // net48 canvas re-interprets the new source rather than mutating the compiled instance and flipping to the last build.
    // A compiled-fallback canvas keeps the live addCompiledTab path.
    await this.live48((e) => addCompiledTab(e, this.designerFile!, asm, hostId, pageType, res.name), true, {});
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
    if (pick !== 'Delete Tab') return; // cancelled
    const eng = await this.ensureEngine(); // net9 for the text edit
    const before = this.doc.designerText;
    const rev = this.doc.rev;
    const res = await removeTabPage(eng, this.designerFile!, hostId, pageId, before);
    if (!res.safe || res.newText === null) { this.post({ type: 'status', message: 'delete tab rejected: ' + (res.reason || 'unsafe') }); return; }
    if (this.doc.rev !== rev) { this.post({ type: 'status', message: 'document changed during edit — try again' }); return; }
    if (!this.commit(before, res.newText, `Delete tab ${pageId}`)) return;
    if (this.currentId === pageId) this.currentId = hostId;
    this.output.appendLine(`deleted tab ${pageId} from ${hostId} (unsaved)`);
    // A deleted tab is a committed source-backed edit: opt into interpreted re-render (like a multi-property edit) so an
    // interpreted net48 canvas re-interprets the new source (the page is gone) instead of running the compiled-instance
    // mutation and flipping the picture to the last build. A compiled-fallback canvas keeps the live removeCompiledTab path.
    await this.live48((e) => removeCompiledTab(e, this.designerFile!, asm, hostId, pageId), true, {});
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

  private async patchOrRerender(id: string, prop: string): Promise<void> {
    if (!this.designerFile || this.disposed) return;
    const eng = await this.ensureEngine();
    const asm = this.asm();
    const text = await this.currentText();
    const seq = ++this.renderSeq;

    // A dirty-region patch is a 1x single-control PNG at logical coords; under a >1 DPI capture the frame is scaled, so a
    // 1x patch would land wrong-sized and blurry. Force the full (scaled) frame instead when rendering at high DPI.
    const patchPossible = id !== 'this' && prop !== 'Checked' && prop !== 'CheckState' && this.renderScale === 1;
    if (patchPossible) {
      let layout: Awaited<ReturnType<typeof describeLayout>>;
      try {
        layout = await describeLayout(eng, this.designerFile, asm, text);
      } catch {
        if (seq === this.renderSeq && !this.disposed) this.renderOk = false; // S5: current source didn't render → read-only
        return;
      }
      if (seq !== this.renderSeq || this.disposed) return;

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
        if (seq !== this.renderSeq || this.disposed) return;
        if (patch?.found) {
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
      frame = await renderWithLayout(eng, this.designerFile, asm, text, this.renderScale);
    } catch (err) {
      // S5: the full re-render of the current source FAILED → the form isn't renderable right now → read-only
      // (fail-closed; self-recovers when a later render — e.g. after Undo restores a renderable buffer — succeeds).
      if (seq === this.renderSeq && !this.disposed) this.renderOk = false;
      this.post({ type: 'status', message: t('status.renderFailed', { error: errMsg(err) }) });
      return;
    }
    if (seq !== this.renderSeq || this.disposed) return;
    this.controls = frame.controls;
    this.toolStripItems = frame.toolStripItems ?? [];
    this.rootClient = { w: frame.clientWidth, h: frame.clientHeight };
    this.rootFrame = { w: frame.width, h: frame.height };
    this.post({ type: 'render', png: frame.png.toString('base64'), width: frame.width, height: frame.height, gen: seq });
    this.postLayout(frame.controls, this.toolStripItems);
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
  /* 0.10.0 trust-floor — persistent (non-dismissible) read-only / fidelity notice strip. Distinct from #diag. */
  #formNotice { flex: 0 0 auto; display: flex; align-items: flex-start; gap: 8px; padding: 4px 8px; font-size: 12px;
    background: var(--vscode-inputValidation-infoBackground, #063b49); color: var(--vscode-inputValidation-infoForeground, inherit);
    border-bottom: 1px solid var(--vscode-inputValidation-infoBorder, #1c78c0); }
  #formNoticeIcon { flex: 0 0 auto; }
  /* Cap the always-on disclosure at two lines so a long notice can't eat the canvas on a narrow or high-DPI pane; the
     full text stays reachable via the element's title (hover) tooltip, set alongside its text in designer.js. */
  #formNoticeMsg { flex: 1; min-width: 0; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2;
    line-clamp: 2; overflow: hidden; }
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
  <div id="formNotice" style="display:none"><span id="formNoticeIcon">🔒</span><span id="formNoticeMsg"></span></div>
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
