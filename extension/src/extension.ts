import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { startEngine, EngineHandle, ping, resolveAssembly, describeDesigner, listToolboxItems, getCapabilities, releaseCompiledAssembly, releaseAllCompiledAssemblies } from './engineClient';
import { WinFormsDesignerProvider, DesignerPanelViewProvider, DesignerHub, hasDesignerSibling, canOpenDesigner, resolveOpenTarget, resolveDesignerFile, EngineKind } from './designerEditor';
import { resolveFrameworkOutput } from './csprojRef';
import { setLocale, t } from './i18n';
import { EngineRecoveryPolicy } from './engineRecovery';

// Two engine processes, started lazily and keyed by kind: 'modern' (the default WinForms/Roslyn engine) and
// 'net48' (the .NET Framework compiled-render engine for DevExpress/Framework projects). A form routes to one
// by the runtime of its resolved control assembly (see DesignerSession.engineKind).
const engines = new Map<EngineKind, EngineHandle>();
const engineStarts = new Map<EngineKind, Promise<EngineHandle>>();
// Every child spawned via startEngine that has NOT yet exited — registered at spawn (onSpawn), before it becomes an
// EngineHandle, and self-removed on 'exit'. A start can sit in its ≤10s pipe-connect wait when the host deactivates;
// deactivate() only disposes handles already in `engines`, so without this a still-connecting child would outlive the
// host still pinning the user's dll. Reuses EngineHandle's ChildProcess type — no new import.
const liveProcs = new Set<EngineHandle['process']>();
const engineRecovery = new EngineRecoveryPolicy();
interface EngineHealth {
  starts: number;
  lastStartupMs?: number;
  lastStartedAt?: string;
  lastExit?: string;
}
const engineHealth = new Map<EngineKind, EngineHealth>();
let shuttingDown = false;
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
  // A form rendered by the net48 engine is drawn from the project's last compiled build — surface that in the badge.
  // The badge is informational, NOT a lock: net48 forms are editable. (It used to carry $(lock), which read as
  // "read-only" on a perfectly editable form and collided with the real 🔒 read-only states.)
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

  // 1.0.0 — teach the hub how to hand a .NET Framework build output back, so the LAST designer using one releases
  // it on close (the engine holds the user's dlls open until then; see releaseNet48Output). The engines live here,
  // so the doer does too — the hub only owns the refcount.
  DesignerHub.instance.setNet48Release(releaseNet48Output);

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

  // 1.0.0 "Release .NET Framework Assembly (for Rebuild)": free the build output the net48 preview holds open, so
  // the user can rebuild WITHOUT closing the designer. Deliberately NOT in the commandPalette `when` list: unlike
  // its siblings (which act ON the focused designer), this one is needed exactly when the designer is NOT focused —
  // the user is at the terminal / build output staring at MSB3027. See releaseFrameworkAssemblies.
  context.subscriptions.push(
    vscode.commands.registerCommand('winformsDesigner.releaseAssembly', () => releaseFrameworkAssemblies()),
  );

  // Status bar: show which assembly is providing controls for the focused form; click → change it.
  controlStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  controlStatus.command = 'winformsDesigner.selectControlAssembly';
  context.subscriptions.push(controlStatus);
  context.subscriptions.push(DesignerHub.instance.onDidChangeActive(() => updateControlStatus()));
  updateControlStatus();

  // 1.0.0 — auto-release the net48 build-output lock when VS Code loses OS focus (the user has almost certainly
  // switched to Visual Studio to build), and re-render the active preview when focus returns so it shows the fresh
  // build. Makes the "designer pins my dll" lock invisible for the common alt-tab-to-VS-and-Build flow, without the
  // user ever running the release command. A small debounce swallows momentary focus blips (no needless domain
  // reload); the release/re-render are chained so a refocus never recreates a domain the in-flight unload is tearing
  // down. See autoReleaseNet48OnBlur.
  let blurReleaseTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingBlurRelease: Promise<boolean> | undefined;
  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((st) => {
      if (!st.focused) {
        if (blurReleaseTimer || pendingBlurRelease) return; // already scheduled / released for this away-stint
        blurReleaseTimer = setTimeout(() => {
          blurReleaseTimer = undefined;
          pendingBlurRelease = autoReleaseNet48OnBlur();
        }, 500);
      } else {
        if (blurReleaseTimer) { clearTimeout(blurReleaseTimer); blurReleaseTimer = undefined; } // quick alt-tab: never really left
        const p = pendingBlurRelease;
        pendingBlurRelease = undefined;
        if (p) void p.then((released) => {
          if (!released) return;
          // The active preview's domain was unloaded while away; its picture may predate the user's rebuild. Re-render
          // it (only the active net48 preview — a no-op for anything else) so they see what they just built.
          const s = DesignerHub.instance.activeSession;
          if (s?.isCompiledPreview) void s.rerenderFromDoc();
        });
      }
    }),
  );

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
  L.push(`- Extension: ${String(context.extension.packageJSON.version ?? '(unknown)')}`);
  L.push(`- VS Code: ${vscode.version}`);
  L.push(`- Platform: ${process.platform} ${process.arch}, Node ${process.versions.node}`);
  L.push(`- Extension Host memory: ${Math.round(process.memoryUsage().rss / 1024 / 1024)} MiB RSS`);
  L.push(`- Engine entry point: ${resolveEngineEntry(context)}`);

  let eng: EngineHandle | undefined;
  try {
    const pingStarted = performance.now();
    eng = await getEngine(context);
    L.push(`- Engine: ${await ping(eng)}`);
    L.push(`- Engine ping: ${(performance.now() - pingStarted).toFixed(1)} ms`);
    L.push(`- Engine PID: ${eng.process.pid ?? '(unknown)'}`);
    try {
      const caps = await getCapabilities(eng);
      L.push(`- Engine capabilities: ${caps.engine}; edit=${caps.edit}; livePreviewUnsavedEdits=${caps.livePreviewUnsavedEdits}`);
    } catch (e) {
      // Keep an otherwise healthy ping/start result truthful when talking to an older/unexpected engine build.
      L.push(`- Engine capabilities: unavailable — ${e instanceof Error ? e.message : String(e)}`);
    }
  } catch (e) {
    L.push(`- Engine: FAILED to start — ${e instanceof Error ? e.message : String(e)}`);
  }

  L.push('', '## Engine lifecycle');
  for (const kind of ['modern', 'net48'] as const) {
    const health = engineHealth.get(kind);
    const running = engines.get(kind);
    L.push(`- ${kind}: ${running ? `running (pid ${running.process.pid ?? '?'})` : 'stopped'}; starts=${health?.starts ?? 0}; `
      + `lastStartup=${health?.lastStartupMs != null ? `${health.lastStartupMs} ms` : 'n/a'}; `
      + `recentCrashes=${engineRecovery.recentCrashCount(kind)}; lastExit=${health?.lastExit ?? 'n/a'}`);
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
async function getEngine(context: vscode.ExtensionContext, kind: EngineKind = 'modern'): Promise<EngineHandle> {
  // Never start a net48 engine while one is being recycled — that would re-pin the very output the recycle is freeing
  // Wait for the confirmed teardown; and if the teardown could NOT confirm the old process exited, stay
  // fail-closed rather than start a replacement beside a process that may still hold the dll.
  if (kind === 'net48') {
    if (net48Recycling) { try { await net48Recycling; } catch { /* fall through to the block check below */ } }
    if (net48Blocked) throw new Error(t('host.net48.recycleBlocked'));
  }
  // Refuse to start once the host is shutting down. This is the ONLY await-before-spawn point in getEngine (the net48
  // recycle wait above), so a start suspended there could otherwise resume AFTER deactivate() snapshotted liveProcs and
  // spawn a child that escapes shutdown ownership — still pinning the dll past teardown.
  // The recheck is synchronous from here through the spawn (no await), so any process onSpawn registers is guaranteed
  // to land in deactivate()'s snapshot instead. Covers both engine kinds; deactivate()'s late guard remains a backstop.
  if (shuttingDown) throw new Error('extension is shutting down');
  const running = engines.get(kind);
  // Liveness = the process has NOT terminated. Test the actual exit facts (exitCode for a normal exit, signalCode for a
  // signal-kill), never `process.killed` — Node's `killed` only means a signal was SENT, not that the child ended
  //, so it would call a still-alive process dead and hand back a broken handle.
  if (running && running.process.exitCode == null && running.process.signalCode == null) {
    return running;
  }
  if (running) {
    engines.delete(kind);
    engineStarts.delete(kind);
  }
  let start = engineStarts.get(kind);
  if (!start) {
    const entry = resolveEngineEntry(context, kind);
    const startedAt = Date.now();
    output.show(true); // reveal the log on first engine start so startup/render issues are visible
    output.appendLine(`starting ${kind} engine: ` + entry);
    start = startEngine(entry, {
      onLog: (l) => output.appendLine(l),
      probeDirs: kind === 'net48' ? getProbeDirectories() : undefined,
      // Own the child from the instant it spawns (before it becomes a handle) so deactivate() can kill it even if this
      // start is still connecting. Self-remove on 'close' AS WELL AS 'exit': an OS-level spawn
      // failure (ENOENT — dotnet/apphost missing) emits 'error' + 'close' but NEVER 'exit', so an exit-only listener
      // would leak that dead process forever. Set.delete is idempotent, so both firing is fine.
      onSpawn: (proc) => {
        liveProcs.add(proc);
        const drop = (): void => { liveProcs.delete(proc); };
        proc.once('exit', drop);
        proc.once('close', drop);
      },
    })
      .then((handle) => {
        // The window/extension can deactivate while this start is still connecting; deactivate() only disposes handles
        // already in the map, so a start that resolves afterward would reinsert and LEAK a live process + pinned dll
        // Refuse to install it — dispose and throw a shutdown error instead.
        if (shuttingDown) { try { handle.dispose(); } catch { /* ignore */ } throw new Error('extension is shutting down'); }
        engines.set(kind, handle);
        const health = engineHealth.get(kind) ?? { starts: 0 };
        health.starts += 1;
        health.lastStartupMs = Date.now() - startedAt;
        health.lastStartedAt = new Date().toISOString();
        engineHealth.set(kind, health);
        let lost = false;
        const onLost = (reason: string, confirmedExit: boolean): void => {
          if (lost) return;
          lost = true;
          if (engines.get(kind) !== handle) return;
          engines.delete(kind);
          engineStarts.delete(kind);
          health.lastExit = `${new Date().toISOString()} (${reason})`;
          output.appendLine(`[engine:${kind}] handle cleared: ${reason}`);
          if (shuttingDown) return;
          const scheduleRecovery = (): void => {
            const decision = engineRecovery.recordCrash(kind);
            output.appendLine(decision.restart
              ? `[engine:${kind}] automatic recovery ${decision.recentCrashes}/2 in ${decision.delayMs} ms`
              : `[engine:${kind}] crash-loop guard stopped automatic recovery (${decision.recentCrashes} crashes/30s)`);
            DesignerHub.instance.handleEngineCrash(kind, decision.restart ? decision.delayMs : null);
          };
          // A net48 RPC-connection close does NOT prove the process exited — it may still be alive and pinning the
          // user's dll. Confirm it is gone (kill + await a real exit) BEFORE recovering, so
          // an automatic re-render can never start a replacement beside a live process that still holds the lock. If
          // exit can't be confirmed, recycleNet48Engine leaves net48Blocked set and getEngine('net48') stays
          // fail-closed until the exit lands. A confirmed process exit (or any modern-engine loss) recovers directly.
          if (kind === 'net48' && !confirmedExit) {
            // Recover EXACTLY ONCE, whichever confirms the exit first: recycle within its deadline (freed=true), OR the
            // process exiting LATER, past that deadline. Without the late-exit
            // path, a process that dies after the 5s recycle window unblocks net48 but never re-renders, so an idle
            // designer sits on its stale canvas until the next manual op.
            let recovered = false;
            const recoverOnce = (): void => { if (recovered || shuttingDown) return; recovered = true; scheduleRecovery(); };
            handle.process.once('exit', recoverOnce);
            void recycleNet48Engine(handle).then((freed) => { if (freed) recoverOnce(); });
          } else {
            scheduleRecovery();
          }
        };
        handle.process.once('exit', (code, signal) => onLost(`process exit code=${code ?? 'null'} signal=${signal ?? 'none'}`, true));
        handle.connection.onClose(() => onLost('RPC connection closed', false));
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

  // Capture the net48 output this form pins BEFORE setControlSource mutates the override, so reloadControlSource can
  // release it if the new route no longer uses it.
  const priorNet48Output = session.pinnedNet48Output;
  await setControlSource(file, dll);
  void vscode.window.showInformationMessage(dll ? t('host.notify.controlSource.set', { name: path.basename(dll) }) : t('host.notify.controlSource.cleared'));
  await session.reloadControlSource(priorNet48Output);
  updateControlStatus();
}

/**
 * 1.0.0 — release every handle the net48 engine holds on `assemblyPath`'s output directory (it unloads the child
 * AppDomain that loaded it). True = a domain was actually unloaded, i.e. that output is now free to overwrite.
 *
 * Never STARTS an engine: one that isn't running (or has already exited, or is being torn down at shutdown) holds
 * no handles, so there is nothing to release and spawning a process to say so would be pure cost. Never throws —
 * both callers (the last-session-closed release from DesignerHub, and the command below) read a failure as "not
 * released", which is the honest answer.
 */
async function releaseNet48Output(assemblyPath: string): Promise<boolean> {
  const engine = engines.get('net48');
  // Terminated? Check the real exit facts (exitCode / signalCode), never `process.killed` — it only means a signal was
  // SENT (Node docs), so a still-alive process would be wrongly treated as gone.
  if (shuttingDown || !engine || engine.process.exitCode != null || engine.process.signalCode != null) return false;
  try {
    const r = await releaseCompiledAssembly(engine, assemblyPath);
    if (r.failed > 0) {
      // The domain was found but its AppDomain.Unload FAILED — it is quarantined (never reused) but STILL pins the
      // dll. "Nothing was loaded" would be a lie. Recycle the exact engine process to free
      // the handles the OS way; do NOT block on it (this path is fire-and-forget from a session close).
      output.appendLine(`[engine:net48] release ${assemblyPath}: unload FAILED (still pinning) — recycling engine`);
      void recycleNet48Engine(engine);
      return false;
    }
    output.appendLine(`[engine:net48] release ${assemblyPath}: `
      + (r.released > 0 ? 'AppDomain unloaded — the build output is free to rebuild' : 'nothing was loaded from that output'));
    return r.released > 0;
  } catch (e) {
    output.appendLine(`[engine:net48] release ${assemblyPath} failed: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

/**
 * 1.0.0 — auto-release the net48 build-output lock the moment VS Code loses OS focus, so the user can switch to
 * Visual Studio and rebuild WITHOUT first running the release command. The net48 preview pins the user's dlls in
 * place (ShadowCopyFiles must stay OFF for delay-signed vendor graphs like DevExpress), which fails their own build
 * with MSB3027 for the lifetime of an open designer. Releasing on window blur means the lock only ever exists while
 * the designer window is actually in the foreground — which matches the mental model and covers the overwhelmingly
 * common "alt-tab to VS and Build" flow. Silent (log only, no popups) since it fires on every focus change.
 *
 * Gated to cost nothing normally: only acts when a net48 engine is live AND an open designer is currently a compiled
 * preview (something is genuinely pinned by an open tab). Reuses the same engine-side ReleaseAllCompiledAssemblies +
 * bounded-RPC + recycle-on-stuck-unload the manual command does, so the release is as robust. Returns true if handles
 * were freed (so the caller can re-render the active preview on refocus to pick up the just-built output).
 */
async function autoReleaseNet48OnBlur(): Promise<boolean> {
  const eng = engines.get('net48');
  // Same "process is really alive" facts releaseNet48Output checks; never start an engine just to release.
  if (!eng || shuttingDown || eng.process.exitCode != null || eng.process.signalCode != null) return false;
  // Nothing an OPEN designer pins ⇒ nothing to do. (A source-switched leak that no session names is left to the
  // manual command, exactly as today — auto-release deliberately stays cheap and only fires for open previews.)
  if (DesignerHub.instance.net48OutputsInUse().length === 0) return false;
  let result;
  try {
    // Bound the RPC like the command: a wedged STA dispatcher must not hang the release with the dll still pinned.
    result = await Promise.race([
      releaseAllCompiledAssemblies(eng),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('release RPC timed out')), 5000)),
    ]);
  } catch (err) {
    output.appendLine('[release:blur] engine did not answer in time; recycling: ' + String(err));
    await recycleNet48Engine(eng); // frees the handles the OS way
    return true;
  }
  if (result.failed > 0) {
    output.appendLine(`[release:blur] ${result.failed}/${result.attempted} domains would not unload; recycling engine`);
    await recycleNet48Engine(eng);
    return true;
  }
  if (result.released > 0) {
    output.appendLine(`[release:blur] released ${result.released} .NET Framework build output(s) on focus loss — you can rebuild in Visual Studio now`);
    return true;
  }
  return false;
}

/**
 * "Release .NET Framework Assembly (for Rebuild)": free the build output(s) the net48 preview is holding open, so
 * the user's own `dotnet build` / VS build stops failing with MSB3027 — without closing the designer. The preview
 * keeps showing its current picture; the next render reloads the output from disk (paying a domain reload).
 *
 * Releases EVERY net48 output in use rather than just the active designer's. That is both simpler and more correct:
 *   • a rebuild is a project/solution-wide action — releasing one output while another open designer still pins its
 *     own leaves the build failing with the identical error, so a per-designer release would look broken;
 *   • there is no ambiguity to resolve. The user reaches for this from the terminal / build output, where there is
 *     no active designer at all — the very case a "the active one" rule would have to guess about;
 *   • it costs nothing but a domain reload on the next render of the affected designers, which the rebuild the user
 *     is about to run forces anyway.
 *
 * A no-op with a clear message (never an error) when nothing is held — no net48 designer open, no net48 engine
 * running, or the engine has no domain for that output.
 */
async function releaseFrameworkAssemblies(): Promise<void> {
  // Ask the ENGINE to release everything it holds, rather than releasing the outputs the HOST believes are in use.
  // net48OutputsInUse() can only name the assembly each open session is CURRENTLY routed to — but a session that
  // switched control source (or moved net48 → modern) silently forgets the output it previously pinned, and then no
  // session names it. That output stayed locked until the engine process exited, and this very command reported
  // "nothing to release" while the user's rebuild kept failing. Only the engine knows what it actually loaded.
  const eng = engines.get('net48');
  if (!eng || shuttingDown) { // never START an engine just to release: no engine ⇒ nothing is held
    void vscode.window.showInformationMessage(t('host.notify.releaseAssembly.none'));
    return;
  }
  // Bound the RPC: a net48 render can wedge the child's single-threaded STA dispatcher (a stuck ctor/paint
  // does an unconditional Wait()), and StreamJsonRpc serializes synchronous requests — so a release queued behind it
  // would never return, and the command would hang with the dll still pinned. On timeout we recycle the engine, which
  // frees the handles the OS way.
  let result;
  try {
    result = await Promise.race([
      releaseAllCompiledAssemblies(eng),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('release RPC timed out')), 5000)),
    ]);
  } catch (err) {
    output.appendLine('[release] engine did not answer in time; recycling: ' + String(err));
    await reportRecycle(eng);
    return;
  }
  if (result.failed > 0) {
    // Some AppDomains refused to unload (a control spun a non-cooperative thread) and STILL pin their dlls — reporting
    // success would send the user to a rebuild that fails with the same lock. Recycling the process is the
    // only sure release.
    output.appendLine(`[release] ${result.failed}/${result.attempted} domains would not unload; recycling engine`);
    await reportRecycle(eng);
    return;
  }
  // failed === 0: every held domain unloaded cleanly (or nothing was held). Both are honestly "you can rebuild now".
  void vscode.window.showInformationMessage(
    result.released > 0 ? t('host.notify.releaseAssembly.done') : t('host.notify.releaseAssembly.none'));
}

/** Recycle the net48 engine that was captured for THIS release, and report the TRUTH: success only if the process is
 *  confirmed gone (its handles are then freed); otherwise a warning, because a lingering process still pins the dll and
 *  the rebuild would still fail. */
async function reportRecycle(handle: EngineHandle | undefined): Promise<void> {
  const freed = await recycleNet48Engine(handle);
  if (freed) void vscode.window.showInformationMessage(t('host.notify.releaseAssembly.recycled'));
  else void vscode.window.showWarningMessage(t('host.notify.releaseAssembly.stuck'));
}

/** In-flight net48 recycle, so getEngine('net48') and a second Release invocation share the ONE teardown instead of
 * racing it. Null when not recycling. */
let net48Recycling: Promise<boolean> | null = null;
/** Set true when a recycle could NOT confirm the old process exited: it may still pin the dll, so getEngine('net48')
 * must NOT start a replacement beside it. Cleared if that process's exit finally arrives. */
let net48Blocked = false;

/**
 * 1.0.0 — force-recycle the net48 engine: kill the EXACT captured process and WAIT for a CONFIRMED exit, so the OS
 * actually releases every pinned dll handle before we tell the user rebuilding is safe. Returns true only when the
 * process is known to have exited.
 *
 * Barriered: concurrent callers (and getEngine) share the one in-flight recycle. Takes the exact handle captured for
 * this operation rather than re-reading the map — an `onLost` (which also fires on a mere RPC-connection close) can
 * clear the map entry while the process is still alive, so the map is not a reliable source of the process to kill.
 */
function recycleNet48Engine(handle: EngineHandle | undefined): Promise<boolean> {
  if (!net48Recycling) net48Recycling = doRecycleNet48(handle).finally(() => { net48Recycling = null; });
  return net48Recycling;
}

async function doRecycleNet48(handle: EngineHandle | undefined): Promise<boolean> {
  const target = handle ?? engines.get('net48');
  if (engines.get('net48') === target) { engines.delete('net48'); engineStarts.delete('net48'); }
  if (!target) return true; // nothing to recycle → the handles are already free
  const proc = target.process;
  // Already terminated? A signal-killed child keeps exitCode === null but records signalCode (Node docs), and its
  // single 'exit' event may have fired BEFORE we attach the listener below — so a stale listener-only wait would hang
  // and latch net48Blocked forever. Check both fields first.
  if (proc.exitCode != null || proc.signalCode != null) { net48Blocked = false; return true; }
  net48Blocked = true; // block a replacement start until we see this exact process exit
  proc.once('exit', () => { net48Blocked = false; }); // a late exit (even past our deadline) unblocks net48
  // `process.killed` only means a signal was SENT, not that the process ended (Node docs), so resolve exit ONLY from a
  // real exit event or an already-recorded exit/signal code — never from `killed`.
  const exited = new Promise<boolean>((resolve) => proc.once('exit', () => resolve(true)));
  const deadline = (ms: number) => new Promise<boolean>((r) => setTimeout(() => r(false), ms));
  try { target.dispose(); } catch { /* already dead */ }
  if (await Promise.race([exited, deadline(3000)])) return true;
  // Lingering (a wedged native thread) — escalate to an unconditional kill and wait a little longer.
  try { proc.kill('SIGKILL'); } catch { /* ignore */ }
  return Promise.race([exited, deadline(2000)]); // if this resolves false, net48Blocked stays true until the exit lands
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

/**
 * Extra assembly-probe dirs for the net48 engine (`winformsDesigner.net48.probeDirectories`) — where a vendor SDK's
 * assemblies live when they are neither next to the target's build output nor in the GAC.
 *
 * Window-scoped and read once per engine START (not per render): the engine caches one child AppDomain per target
 * bin dir and binds probe dirs when that domain is created, so a mid-session change can't retroactively apply —
 * the setting description tells the user to reload. Missing dirs are NOT warned about here; the engine drops
 * non-existent entries, and unlike `assemblyPath` (one path, silently wrong render if unset) a stale probe dir is
 * inert.
 */
function getProbeDirectories(): string[] {
  const raw = vscode.workspace.getConfiguration('winformsDesigner').get<string[]>('net48.probeDirectories');
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((d): d is string => typeof d === 'string')
    .map((d) => {
      let p = d.trim();
      if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) p = path.join(os.homedir(), p.slice(1));
      return p;
    })
    .filter((d) => d.length > 0);
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

function resolveEngineEntry(context: vscode.ExtensionContext, kind: EngineKind = 'modern'): string {
  const preferDevelopmentBuild = context.extensionMode !== vscode.ExtensionMode.Production;
  if (kind === 'net48') {
    // The net48 engine is a native .exe. Dev builds are Debug by default; prefer Release, then Debug, then bundled.
    const devRel = context.asAbsolutePath(path.join('..', 'engine-net48', 'bin', 'Release', 'net48', 'WinFormsDesigner.Engine.Net48.exe'));
    const devDbg = context.asAbsolutePath(path.join('..', 'engine-net48', 'bin', 'Debug', 'net48', 'WinFormsDesigner.Engine.Net48.exe'));
    if (preferDevelopmentBuild) {
      if (fs.existsSync(devRel)) return devRel;
      if (fs.existsSync(devDbg)) return devDbg;
    }
    const bundled48 = context.asAbsolutePath(path.join('engine-net48', 'WinFormsDesigner.Engine.Net48.exe'));
    if (fs.existsSync(bundled48)) return bundled48;
    return fs.existsSync(devRel) ? devRel : devDbg;
  }
  // Dev layout: <repo>/extension and <repo>/engine are siblings — run the Release build directly. Prefer the
  // architecture-specific apphost, but keep the DLL fallback for contributors who built without an apphost.
  const devExe = context.asAbsolutePath(
    path.join('..', 'engine', 'bin', 'Release', 'net10.0-windows', 'WinFormsDesigner.Engine.exe'),
  );
  const devDll = context.asAbsolutePath(
    path.join('..', 'engine', 'bin', 'Release', 'net10.0-windows', 'WinFormsDesigner.Engine.dll'),
  );
  // In the F5 dev loop, always prefer the freshly-built sibling engine. Otherwise a stale bundled
  // extension/engine/ (left behind by `npm run bundle-engine` / `vsce package`) would shadow the
  // engine a contributor just rebuilt, and their engine edits would silently not take effect.
  if (preferDevelopmentBuild) {
    if (fs.existsSync(devExe)) return devExe;
    if (fs.existsSync(devDll)) return devDll;
  }
  // Packaged layout: the engine is published into <extension>/engine/ at package time
  // (see the "bundle-engine" / "vscode:prepublish" scripts). Prefer it so an installed VSIX is
  // self-contained.
  const bundledExe = context.asAbsolutePath(path.join('engine', 'WinFormsDesigner.Engine.exe'));
  if (fs.existsSync(bundledExe)) return bundledExe;
  const bundledDll = context.asAbsolutePath(path.join('engine', 'WinFormsDesigner.Engine.dll'));
  if (fs.existsSync(bundledDll)) return bundledDll;
  return fs.existsSync(devExe) ? devExe : devDll;
}

/** Normalize a path for set keys (case-insensitive on Windows). */
function normalize(fsPath: string): string {
  const p = path.normalize(fsPath);
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

export function deactivate(): void | Promise<void> {
  shuttingDown = true;
  // dispose() already kills the mapped engines' processes; remember which so the pending-scan below does NOT signal them
  // a second time (a redundant failed kill on every normal shutdown). Startup children that never
  // became a handle aren't in this set, so they still get their one kill.
  const disposedProcs = new Set<EngineHandle['process']>();
  for (const handle of engines.values()) {
    disposedProcs.add(handle.process);
    try { handle.dispose(); } catch { /* ignore */ }
  }
  engines.clear();
  engineStarts.clear();
  // Await EVERY spawned child — including one still in its pipe-connect wait that never became a handle the loop above
  // could dispose — else it outlives the host still pinning the user's dll. Kill only the ones
  // dispose() didn't already signal. Return a bounded Promise so VS Code keeps the host alive until those children
  // actually exit (a `void` return declares the cleanup synchronous, which it isn't once a process must be awaited); the
  // timeout guarantees teardown is never unbounded.
  const pending = [...liveProcs];
  if (pending.length === 0) return;
  const exits = pending.map((proc) => new Promise<void>((resolve) => {
    if (proc.exitCode != null || proc.signalCode != null) { resolve(); return; }
    proc.once('exit', () => resolve());
    // Kill only a child neither dispose() (mapped handles) nor an in-flight recycle already signalled. `disposedProcs`
    // misses a recycling process — doRecycleNet48 removes it from `engines` before disposing — so ALSO skip one that is
    // already `killed`. Here `killed` means "a termination signal was already SENT" (its correct Node meaning), used to
    // avoid a redundant second signal — NOT as proof of exit (that stays exitCode/signalCode/'exit').
    if (!disposedProcs.has(proc) && !proc.killed) { try { proc.kill(); } catch { /* already gone */ } }
  }));
  return Promise.race([
    Promise.all(exits).then(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, 3000)),
  ]);
}
