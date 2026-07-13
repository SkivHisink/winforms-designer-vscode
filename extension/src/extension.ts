import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { startEngine, EngineHandle, ping, resolveAssembly, describeDesigner, listToolboxItems } from './engineClient';
import { WinFormsDesignerProvider, DesignerPanelViewProvider, DesignerHub, hasDesignerSibling, canOpenDesigner, resolveOpenTarget, resolveDesignerFile, EngineKind } from './designerEditor';
import { resolveFrameworkOutput } from './csprojRef';
import { setLocale, t } from './i18n';

// Two engine processes, started lazily and keyed by kind: 'net9' (the default WinForms/Roslyn engine) and
// 'net48' (the .NET Framework compiled-render engine for DevExpress/Framework projects). A form routes to one
// by the runtime of its resolved control assembly (see DesignerSession.engineKind).
const engines = new Map<EngineKind, EngineHandle>();
const engineStarts = new Map<EngineKind, Promise<EngineHandle>>();
let output: vscode.OutputChannel;

/** Files the user explicitly chose to view as code — auto-open must not re-hijack them into the designer. */
const codeIntent = new Set<string>();
/** Re-entrancy guard while an auto-open's openWith is in flight. */
const autoOpening = new Set<string>();
/**
 * Files we've already auto-redirected to the designer once this open-lifecycle. After that, seeing the
 * file in a TEXT editor again means the user deliberately reopened it as code (e.g. native "Reopen
 * Editor With… → Text Editor"), so we respect it instead of fighting back into the designer. Cleared
 * when the file is genuinely closed (no designer tab left), so a later fresh open auto-opens again.
 */
const autoOpenedOnce = new Set<string>();

/** The active extension context — backs the per-form control-source overrides (workspaceState) so
 *  `getAssemblyOverride` (a free function) can read them without threading context everywhere. */
let extContext: vscode.ExtensionContext | undefined;
/** Status bar item showing the active designer's control source; click → select a project/assembly. */
let controlStatus: vscode.StatusBarItem | undefined;

/** Per-form explicit control-assembly choices, keyed by the .Designer.cs path (case-insensitive on Windows). */
function controlSourceMap(): Record<string, string> {
  return extContext?.workspaceState.get<Record<string, string>>('controlSources', {}) ?? {};
}
function csKey(file: string): string { return process.platform === 'win32' ? file.toLowerCase() : file; }
/** The user's explicit control assembly for a form, or undefined (auto). A stale (deleted) path is ignored. */
function getControlSource(file: string): string | undefined {
  const p = controlSourceMap()[csKey(file)];
  return p && fs.existsSync(p) ? p : undefined;
}
async function setControlSource(file: string, dll: string | undefined): Promise<void> {
  const m = { ...controlSourceMap() };
  if (dll) m[csKey(file)] = dll; else delete m[csKey(file)];
  await extContext?.workspaceState.update('controlSources', m);
}

/** Reflect the active designer's control source in the status bar (explicit override, or the auto-resolved dll). */
function updateControlStatus(): void {
  if (!controlStatus) return;
  const file = DesignerHub.instance.activeSession?.designerFilePath ?? null;
  if (!file) { controlStatus.hide(); return; }
  // A form rendered by the net48 engine is a read-only compiled preview — surface that in the badge.
  const preview = DesignerHub.instance.activeSession?.isCompiledPreview
    ? t('host.statusbar.previewBadge') : '';
  const previewTip = DesignerHub.instance.activeSession?.isCompiledPreview
    ? '\n' + t('host.statusbar.tip.previewNote') : '';
  const explicit = getControlSource(file);
  if (explicit) {
    controlStatus.text = t('host.statusbar.controls', { name: path.basename(explicit) }) + preview;
    controlStatus.tooltip = t('host.statusbar.tip.explicit', { path: explicit }) + previewTip + '\n' + t('host.statusbar.tip.clickChange');
    controlStatus.show();
    return;
  }
  controlStatus.text = t('host.statusbar.controls', { name: t('host.statusbar.auto') }) + preview;
  controlStatus.tooltip = t('host.statusbar.tip.auto') + previewTip + '\n' + t('host.statusbar.tip.clickOverride');
  controlStatus.show();
  // best-effort: fill in the resolved dll name in the background (don't block the status update on the engine)
  void (async () => {
    try {
      if (!extContext) return;
      const r = await resolveAssembly(await getEngine(extContext), file);
      if (r && controlStatus && DesignerHub.instance.activeSession?.designerFilePath === file && !getControlSource(file)) {
        controlStatus.text = t('host.statusbar.controls', { name: path.basename(r) + t('host.statusbar.autoSuffix') });
        controlStatus.tooltip = t('host.statusbar.tip.autoResolved', { path: r }) + '\n' + t('host.statusbar.tip.clickOverride');
      }
    } catch { /* engine not up / unresolved — leave the neutral "auto" label */ }
  })();
}

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('WinForms Designer');
  context.subscriptions.push(output);
  extContext = context;

  // Resolve the UI language from the `winformsDesigner.language` setting (default English). It is driven
  // ONLY by the setting — it never auto-follows the VS Code display language. Refreshed on config change below.
  setLocale();

  // Persist the user's "Choose Items" toolbox additions across sessions (global, like VS toolbox customization).
  DesignerHub.instance.initState(context.globalState);

  // The unified VS-style designer: a custom editor on *.cs (the sibling .Designer.cs gate is enforced at
  // resolve time). priority "option" keeps the C# text editor the default; the designer opens via
  // auto-open below, the "Open Designer" action, or "Reopen Editor With…".
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      WinFormsDesignerProvider.viewType,
      new WinFormsDesignerProvider(context, (kind?: EngineKind) => getEngine(context, kind), getAssemblyOverride, output, doViewCode, (file, dll) => setControlSource(file, dll)),
      { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: false },
    ),
  );

  // The Properties + Toolbox live in ONE native, dockable VS Code WebviewView (in the "WinForms Designer"
  // view container), switched by a bottom tab strip. It mirrors whichever designer editor is focused.
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      DesignerPanelViewProvider.viewType, new DesignerPanelViewProvider(context.extensionUri),
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );

  // F4 (VS-style): reveal the designer panel and switch it to the Properties tab for the current selection.
  context.subscriptions.push(
    vscode.commands.registerCommand('winformsDesigner.showProperties', async () => {
      await vscode.commands.executeCommand('winformsDesigner.panel.focus');
      DesignerHub.instance.toPanel({ type: 'showTab', tab: 'props' });
    }),
  );

  // "Open Designer" for the active file. Works from a form .cs AND from a .Designer.cs (opens the
  // designer on the partner .cs) so the action is there however the user got to the file.
  context.subscriptions.push(
    vscode.commands.registerCommand('winformsDesigner.open', () => {
      const uri = vscode.window.activeTextEditor?.document.uri ?? activeCustomEditorUri();
      const target = uri ? resolveOpenTarget(uri.fsPath) : null;
      if (!target) {
        vscode.window.showErrorMessage(t('host.notify.openDesigner.noForm'));
        return;
      }
      const targetUri = vscode.Uri.file(target);
      const k = normalize(target);
      codeIntent.delete(k);
      autoOpenedOnce.add(k); // explicit open counts as the one auto-open, so a later switch to text is respected
      void vscode.commands.executeCommand('vscode.openWith', targetUri, WinFormsDesignerProvider.viewType);
    }),
  );

  // "View Code": open the form's .cs as a plain text editor (and suppress auto-open for it).
  context.subscriptions.push(
    vscode.commands.registerCommand('winformsDesigner.viewCode', () => {
      const uri = activeCustomEditorUri() ?? vscode.window.activeTextEditor?.document.uri;
      if (uri) doViewCode(uri);
    }),
  );

  // Export Diagnostics: gather engine/environment/active-document/settings info into a new
  // untitled Markdown document (no file written — the user saves it where they want, no permission prompt).
  context.subscriptions.push(
    vscode.commands.registerCommand('winformsDesigner.exportDiagnostics', () => exportDiagnostics(context)),
  );

  // "Select Control Assembly": point the active form at the project/assembly that builds its (custom) controls.
  // Reuses the engine's single-assembly override — the chosen dll's controls then populate the toolbox
  // (Project Controls) and render, exactly like an auto-resolved project. Persisted per form (workspaceState).
  context.subscriptions.push(
    vscode.commands.registerCommand('winformsDesigner.selectControlAssembly', () => selectControlAssembly(context)),
  );

  // 0.11.0 ImageList editor — edit the selected ImageList's images (add/remove) on the active designer.
  context.subscriptions.push(
    vscode.commands.registerCommand('winformsDesigner.editImageListImages',
      () => DesignerHub.instance.activeSession?.editImageListImages()),
  );

  // Status bar: show which assembly is providing controls for the focused form; click → change it.
  controlStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  controlStatus.command = 'winformsDesigner.selectControlAssembly';
  context.subscriptions.push(controlStatus);
  context.subscriptions.push(DesignerHub.instance.onDidChangeActive(() => updateControlStatus()));
  updateControlStatus();

  // Auto-open the designer when a form .cs becomes the active editor (VS-style: open Form1.cs → designer).
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((e) => { updateContext(e); autoOpenIfDesigner(e); }),
  );
  // Reset suppression on a GENUINE close so the file auto-opens as the designer again next time. Skip
  // the reset when a designer tab for the file is still open — that "close" was just our own text→designer
  // swap, and resetting there would let auto-open immediately re-hijack (a loop).
  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument((d) => {
      const k = normalize(d.uri.fsPath);
      if (hasOpenDesignerTab(k)) return;
      codeIntent.delete(k);
      autoOpenedOnce.delete(k);
    }),
  );
  // re-evaluate auto-open/context when the toggle changes. If a text editor is active, this can redirect
  // it to the designer (or stop doing so); if the designer itself is focused there's nothing to redirect
  // — it's already open — so the no-op is correct and the state self-corrects on the next editor switch.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('winformsDesigner.autoOpenDesigner')) {
        const ed = vscode.window.activeTextEditor;
        updateContext(ed);
        autoOpenIfDesigner(ed);
      }
      // Language: refresh the cached locale, then offer a window reload so all webviews (and the VS Code
      // display-language-driven chrome) pick up the new language consistently.
      if (e.affectsConfiguration('winformsDesigner.language')) {
        setLocale();
        // Re-emit open designer/panel webviews so the interactive UI switches language on the spot; the toast
        // then offers a window reload for the manifest "chrome" (palette/settings) that only reloads with it.
        DesignerHub.instance.rebuildOpenWebviews();
        void vscode.window
          .showInformationMessage(t('config.language.reloadPrompt'), t('config.language.reloadButton'))
          .then((pick) => {
            if (pick === t('config.language.reloadButton')) {
              void vscode.commands.executeCommand('workbench.action.reloadWindow');
            }
          });
      }
    }),
  );

  // handle the editor already active at activation time
  const active = vscode.window.activeTextEditor;
  updateContext(active);
  autoOpenIfDesigner(active);
}

/** Open a file as a plain text editor and remember the user wants it as code (no auto-redirect). With a
 *  position, reveal it there (the "double-click event → go to handler body" navigation). Either way the
 *  file is marked code-intent first, so auto-open won't yank it back into the designer. */
function doViewCode(uri: vscode.Uri, position?: vscode.Position): void {
  codeIntent.add(normalize(uri.fsPath));
  if (!position) {
    void vscode.commands.executeCommand('vscode.openWith', uri, 'default');
    return;
  }
  void vscode.workspace.openTextDocument(uri).then((doc) =>
    vscode.window.showTextDocument(doc, { preview: false }).then((ed) => {
      ed.selection = new vscode.Selection(position, position);
      ed.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
    }));
}

/**
 * Export Diagnostics: collect engine + environment + active-document + settings state into a Markdown
 * report opened as a new untitled document. Read-only — never writes a file (no permission prompt) and never
 * throws out (each probe is guarded so a dead engine still produces a useful report).
 */
async function exportDiagnostics(context: vscode.ExtensionContext): Promise<void> {
  const L: string[] = [];
  L.push('# WinForms Designer — Diagnostics', '');
  L.push(`- Generated: ${new Date().toISOString()}`);
  L.push(`- VS Code: ${vscode.version}`);
  L.push(`- Platform: ${process.platform} ${process.arch}, Node ${process.versions.node}`);
  L.push(`- Engine DLL: ${resolveEngineDll(context)}`);

  let eng: EngineHandle | undefined;
  try {
    eng = await getEngine(context);
    L.push(`- Engine: ${await ping(eng)}`);
  } catch (e) {
    L.push(`- Engine: FAILED to start — ${e instanceof Error ? e.message : String(e)}`);
  }

  const uri = activeCustomEditorUri() ?? vscode.window.activeTextEditor?.document.uri;
  L.push('', '## Active document');
  if (!uri) {
    L.push('- (no active editor)');
  } else {
    const designer = resolveDesignerFile(uri.fsPath);
    L.push(`- File: ${uri.fsPath}`);
    L.push(`- Designer file: ${designer ?? '(no .Designer.cs)'}`);
    const cfg = vscode.workspace.getConfiguration('winformsDesigner', uri);
    L.push('', '## Settings');
    L.push(`- autoOpenDesigner: ${cfg.get('autoOpenDesigner', true)}`);
    L.push(`- assemblyPath (raw): ${cfg.get<string>('assemblyPath') || '(none)'}`);
    L.push(`- assemblyPath (resolved override): ${getAssemblyOverride(uri.fsPath) ?? '(none — auto-discover)'}`);
    if (eng && designer) {
      try { L.push(`- Resolved assembly: ${(await resolveAssembly(eng, designer)) ?? '(unresolved)'}`); }
      catch (e) { L.push(`- Resolved assembly: error — ${e instanceof Error ? e.message : String(e)}`); }
      try {
        const d = await describeDesigner(eng, designer, getAssemblyOverride(uri.fsPath));
        L.push('', '## Designer graph');
        L.push(`- Root type: ${d.rootType}`);
        L.push(`- Components: ${d.components.length}`);
        L.push(`- Representable statements: ${d.representable}/${d.totalStatements} (round-trip safe: ${d.roundTripSafe})`);
        if (d.unrepresentable.length) L.push('- Unrepresentable:', ...d.unrepresentable.map((u) => `  - ${u}`));
      } catch (e) {
        L.push('', `## Designer graph: error — ${e instanceof Error ? e.message : String(e)}`);
      }
      try {
        const tb = await listToolboxItems(eng, designer, getAssemblyOverride(uri.fsPath));
        const proj = tb.filter((t) => t.fromProject).length;
        L.push('', `## Toolbox: ${tb.length} controls (${proj} from project assembly)`);
      } catch { /* ignore */ }
    }
  }

  const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: L.join('\n') });
  await vscode.window.showTextDocument(doc, { preview: false });
}

/** Drives the "Open Designer" editor-title action (shown on a form .cs OR a .Designer.cs partner). */
function updateContext(editor: vscode.TextEditor | undefined): void {
  const canOpen = !!editor && canOpenDesigner(editor.document.uri.fsPath);
  void vscode.commands.executeCommand('setContext', 'winformsDesigner.canOpen', canOpen);
}

function autoOpenIfDesigner(editor: vscode.TextEditor | undefined): void {
  if (!editor) return;
  const file = editor.document.uri.fsPath;
  if (!hasDesignerSibling(file)) return;
  const cfg = vscode.workspace.getConfiguration('winformsDesigner', editor.document.uri);
  if (!cfg.get<boolean>('autoOpenDesigner', true)) return;
  const key = normalize(file);
  if (codeIntent.has(key) || autoOpening.has(key)) return;
  if (autoOpenedOnce.has(key)) {
    // already auto-opened once and the user is back on a TEXT editor for it → they want code; respect it
    // (and remember it) instead of yanking the tab back into the designer.
    codeIntent.add(key);
    return;
  }
  autoOpening.add(key);
  autoOpenedOnce.add(key);
  void vscode.commands
    .executeCommand('vscode.openWith', editor.document.uri, WinFormsDesignerProvider.viewType)
    .then(() => autoOpening.delete(key), () => autoOpening.delete(key));
}

/** The .cs/.Designer.cs URI behind the active custom-editor tab, if the designer is focused. */
function activeCustomEditorUri(): vscode.Uri | undefined {
  const input = vscode.window.tabGroups.activeTabGroup?.activeTab?.input;
  if (input instanceof vscode.TabInputCustom && input.viewType === WinFormsDesignerProvider.viewType) {
    return input.uri;
  }
  return undefined;
}

/** True when any tab group still shows the designer (custom editor) for this file. */
function hasOpenDesignerTab(key: string): boolean {
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input;
      if (input instanceof vscode.TabInputCustom
        && input.viewType === WinFormsDesignerProvider.viewType
        && normalize(input.uri.fsPath) === key) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Start the engine at most once even under concurrent renders, and self-heal if it dies.
 * Without the shared startup promise two first-renders could each spawn an engine and leak one.
 */
async function getEngine(context: vscode.ExtensionContext, kind: EngineKind = 'net9'): Promise<EngineHandle> {
  const running = engines.get(kind);
  if (running) {
    return running;
  }
  let start = engineStarts.get(kind);
  if (!start) {
    const dll = resolveEngineDll(context, kind);
    output.show(true); // reveal the log on first engine start so startup/render issues are visible
    output.appendLine(`starting ${kind} engine: ` + dll);
    start = startEngine(dll, { onLog: (l) => output.appendLine(l) })
      .then((handle) => {
        engines.set(kind, handle);
        handle.process.once('exit', () => {
          if (engines.get(kind) === handle) {
            engines.delete(kind);
            engineStarts.delete(kind);
            output.appendLine(`[engine:${kind}] handle cleared after process exit`);
          }
        });
        return handle;
      })
      .catch((err) => {
        engineStarts.delete(kind); // allow a retry on the next render
        throw err;
      });
    engineStarts.set(kind, start);
  }
  return start;
}

const warnedAssemblyPaths = new Set<string>();

/**
 * Optional explicit control-assembly override from `winformsDesigner.assemblyPath` (resource-scoped, so a
 * folder-level setting wins). Empty → undefined (engine auto-discovers). A leading `~` expands to the home
 * dir; a relative path resolves against the file's workspace folder, or the file's own directory in
 * single-file mode. If the resolved path doesn't exist we warn once and return undefined (graceful
 * fallback to auto-discovery) rather than letting a typo silently render the wrong assembly. (Env-var
 * expansion is intentionally not done — see the setting's description.)
 */
/**
 * Prompt the user to select the control source (project or assembly) for the ACTIVE designer, and apply it.
 * A project (.csproj) is resolved to its build output via the engine; a .dll is used directly. Cleared → the
 * engine auto-detects again. The choice is persisted per form and takes effect immediately (re-render).
 */
async function selectControlAssembly(context: vscode.ExtensionContext): Promise<void> {
  const session = DesignerHub.instance.activeSession;
  const file = session?.designerFilePath ?? null;
  if (!file || !session) {
    void vscode.window.showInformationMessage(t('host.notify.selectAssembly.noSession'));
    return;
  }
  const PROJECT = t('host.controlSource.project');
  const BROWSE = t('host.controlSource.browse');
  const CLEAR = t('host.controlSource.clear');
  const cur = getControlSource(file);
  const choice = await vscode.window.showQuickPick([PROJECT, BROWSE, CLEAR], {
    title: t('host.controlSource.title'),
    placeHolder: cur ? t('host.controlSource.current', { name: path.basename(cur) }) : t('host.controlSource.currentAuto'),
  });
  if (!choice) return;

  let dll: string | undefined;
  if (choice === CLEAR) {
    dll = undefined;
  } else if (choice === BROWSE) {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false, openLabel: t('host.dialog.selectAssembly.openLabel'),
      title: t('host.dialog.selectAssembly.title'), filters: { Assemblies: ['dll', 'exe'] },
    });
    if (!picked || !picked.length) return;
    dll = picked[0].fsPath;
  } else {
    const csprojs = await vscode.workspace.findFiles('**/*.csproj', '**/{bin,obj,node_modules}/**', 200);
    if (!csprojs.length) {
      void vscode.window.showWarningMessage(t('host.notify.selectProject.notFound'));
      return;
    }
    const proj = await vscode.window.showQuickPick(
      csprojs.map((u) => ({ label: '$(project) ' + path.basename(u.fsPath), description: vscode.workspace.asRelativePath(u), uri: u })),
      { title: t('host.dialog.selectProject.title'), placeHolder: t('host.dialog.selectProject.placeholder') },
    );
    if (!proj) return;
    try {
      // The net9 engine resolves .NET (Core) output; for a .NET Framework project (net4x, often OutputType=Exe)
      // it returns null by design — fall back to the Framework output finder so a net48 control source resolves.
      let resolved = await resolveAssembly(await getEngine(context), proj.uri.fsPath);
      if (!resolved || !fs.existsSync(resolved)) {
        resolved = resolveFrameworkOutput(proj.uri.fsPath) ?? null;
      }
      if (!resolved || !fs.existsSync(resolved)) {
        void vscode.window.showWarningMessage(
          t('host.notify.resolveProject.error', { name: path.basename(proj.uri.fsPath) }),
        );
        return;
      }
      dll = resolved;
    } catch (e) {
      void vscode.window.showWarningMessage(t('host.notify.resolveEngine.error', { error: e instanceof Error ? e.message : String(e) }));
      return;
    }
  }

  await setControlSource(file, dll);
  void vscode.window.showInformationMessage(dll ? t('host.notify.controlSource.set', { name: path.basename(dll) }) : t('host.notify.controlSource.cleared'));
  await session.reloadControlSource();
  updateControlStatus();
}

export function getAssemblyOverride(file: string): string | undefined {
  // an explicit per-form choice (Select Control Assembly) wins over the config setting and auto-detection.
  const picked = getControlSource(file);
  if (picked) return picked;
  const uri = vscode.Uri.file(file);
  const raw = vscode.workspace.getConfiguration('winformsDesigner', uri).get<string>('assemblyPath');
  if (!raw || !raw.trim()) {
    return undefined;
  }
  let p = raw.trim();
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) {
    p = path.join(os.homedir(), p.slice(1));
  }
  if (!path.isAbsolute(p)) {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    p = path.join(folder ? folder.uri.fsPath : path.dirname(file), p);
  }
  if (!fs.existsSync(p)) {
    warnMissingAssembly(p);
    return undefined; // fall back to auto-discovery, but the user is told why (vs a silent wrong render)
  }
  return p;
}

/** One warning per missing path (config is read on every render — don't spam on each save/re-render). */
function warnMissingAssembly(resolved: string): void {
  if (warnedAssemblyPaths.has(resolved)) {
    return;
  }
  warnedAssemblyPaths.add(resolved);
  output.appendLine('winformsDesigner.assemblyPath not found, using auto-discovery: ' + resolved);
  void vscode.window.showWarningMessage(
    t('host.notify.assemblyPath.missing', { path: resolved }),
  );
}

function resolveEngineDll(context: vscode.ExtensionContext, kind: EngineKind = 'net9'): string {
  if (kind === 'net48') {
    // The net48 engine is a native .exe. Dev builds are Debug by default; prefer Release, then Debug, then bundled.
    const devRel = context.asAbsolutePath(path.join('..', 'engine-net48', 'bin', 'Release', 'net48', 'WinFormsDesigner.Engine.Net48.exe'));
    const devDbg = context.asAbsolutePath(path.join('..', 'engine-net48', 'bin', 'Debug', 'net48', 'WinFormsDesigner.Engine.Net48.exe'));
    if (context.extensionMode === vscode.ExtensionMode.Development) {
      if (fs.existsSync(devRel)) return devRel;
      if (fs.existsSync(devDbg)) return devDbg;
    }
    const bundled48 = context.asAbsolutePath(path.join('engine-net48', 'WinFormsDesigner.Engine.Net48.exe'));
    if (fs.existsSync(bundled48)) return bundled48;
    return fs.existsSync(devRel) ? devRel : devDbg;
  }
  // Dev layout: <repo>/extension and <repo>/engine are siblings — run the Release build directly.
  const dev = context.asAbsolutePath(
    path.join('..', 'engine', 'bin', 'Release', 'net9.0-windows', 'WinFormsDesigner.Engine.dll'),
  );
  // In the F5 dev loop, always prefer the freshly-built sibling engine. Otherwise a stale bundled
  // extension/engine/ (left behind by `npm run bundle-engine` / `vsce package`) would shadow the
  // engine a contributor just rebuilt, and their engine edits would silently not take effect.
  if (context.extensionMode === vscode.ExtensionMode.Development && fs.existsSync(dev)) {
    return dev;
  }
  // Packaged layout: the engine is published into <extension>/engine/ at package time
  // (see the "bundle-engine" / "vscode:prepublish" scripts). Prefer it so an installed VSIX is
  // self-contained.
  const bundled = context.asAbsolutePath(path.join('engine', 'WinFormsDesigner.Engine.dll'));
  if (fs.existsSync(bundled)) {
    return bundled;
  }
  return dev;
}

/** Normalize a path for set keys (case-insensitive on Windows). */
function normalize(fsPath: string): string {
  const p = path.normalize(fsPath);
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

export function deactivate(): void {
  for (const handle of engines.values()) {
    try { handle.dispose(); } catch { /* ignore */ }
  }
  engines.clear();
  engineStarts.clear();
}
