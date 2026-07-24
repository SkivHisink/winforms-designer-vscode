import { spawn, ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import * as net from 'net';
import * as path from 'path';
import {
  createMessageConnection,
  MessageConnection,
} from 'vscode-jsonrpc/node';
import { StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node';

/**
* VS Code-free client for the WinForms design engine. Spawns the .NET engine in
* --pipe mode and talks JSON-RPC (Content-Length framing, interoperable with
* StreamJsonRpc) over a Windows named pipe. Kept free of any `vscode` import so it
* can be exercised headless (see src/e2e.ts).
*/
export interface EngineHandle {
  connection: MessageConnection;
  process: ChildProcess;
  pipeName: string;
  dispose(): void;
}

export interface StartOptions {
  dotnet?: string; // path to dotnet (default 'dotnet')
  onLog?: (line: string) => void;
  /**
   * Extra assembly-probe dirs for the net48 engine (vendor SDKs installed outside the target's bin dir and out of
   * the GAC). Passed at SPAWN — not per request — because the engine caches one child AppDomain per target bin dir
   * and only applies probe dirs when that domain is created (DomainManager.Create → RenderWorker.Init), so probe
   * dirs are process-scoped in effect no matter how they arrive. The per-request `probeDirs` RPC argument stays
   * available for callers that need it; these are unioned in by the engine.
   */
  probeDirs?: string[];
  /**
   * Called synchronously the instant the child is spawned — BEFORE the (up-to-10s) pipe-connect wait below, and
   * therefore before any disposable EngineHandle exists. Lets the host take ownership of the raw process for
   * shutdown/cancellation while startEngine() is still connecting: a start can sit in that wait when the host
   * deactivates, and without this hook the spawned child would be unowned and keep pinning the user's dll
   *.
   */
  onSpawn?: (proc: ChildProcess) => void;
}

/** Env var the net48 engine reads extra probe dirs from — mirrors Program.ProbeDirsEnvVar (engine-net48). */
export const PROBE_DIRS_ENV = 'WINFORMS_DESIGNER_PROBE_DIRS';

/**
* A fresh, unique name for one engine's named pipe.
*
* MUST be unique per CALL, not per process: extension.ts keeps a separate handle + in-flight start promise per
* EngineKind, so a modern and a net48 engine can be starting concurrently in the SAME extension host. The old
* `winforms-designer-${process.pid}-${Date.now()}` shared the pid and collided whenever both entered startEngine()
* within one millisecond (e.g. two restored tabs of different kinds): the second engine's NamedPipeServerStream is
* created with maxNumberOfServerInstances=1, so the loser died with "System.IO.IOException: All pipe instances are
* busy" (exit -532462766) — and with bounded crash recovery in place, that burned a restart attempt for no fault.
* A random UUID removes the collision; the `winforms-designer-` prefix keeps the handle recognizable in
* diagnostics / handle lists (`\\.\pipe\winforms-designer-…`, 54 chars, well inside the Windows pipe-name limit).
*/
export function newPipeName(): string {
  return `winforms-designer-${randomUUID()}`;
}

export async function startEngine(engineDllPath: string, opts: StartOptions = {}): Promise<EngineHandle> {
  const dotnet = opts.dotnet ?? 'dotnet';
  const log = opts.onLog ?? ((l: string) => console.error(l));
  const pipeName = newPipeName();

  // Packaged modern engines use a RID-specific framework-dependent apphost and net48 is a .NET Framework apphost,
  // so both launch directly. Development may still point at a managed DLL, which must go through the dotnet muxer.
  const isExe = /\.exe$/i.test(engineDllPath);
  // Probe dirs ride in on the environment (PATH-style) rather than argv: the engine also has a --render CLI, and an
  // env var keeps both entry points fed without widening the CLI contract. Absent/empty → inherit env unchanged.
  const probeDirs = (opts.probeDirs ?? []).map((d) => d.trim()).filter((d) => d.length > 0);
  const env = probeDirs.length ? { ...process.env, [PROBE_DIRS_ENV]: probeDirs.join(path.delimiter) } : process.env;
  const proc = spawn(
    isExe ? engineDllPath : dotnet,
    isExe ? ['--pipe', pipeName] : [engineDllPath, '--pipe', pipeName],
    { stdio: ['ignore', 'pipe', 'pipe'], env },
  );
  const startupOutput: string[] = [];
  const capture = (d: Buffer): void => {
    const line = '[engine] ' + d.toString().trimEnd();
    startupOutput.push(line);
    log(line);
  };
  proc.stdout.on('data', capture);
  proc.stderr.on('data', capture);
  proc.on('exit', (code) => log('[engine] exited ' + code));
  // MUST handle 'error' (e.g. ENOENT when `dotnet` isn't on PATH): an unhandled ChildProcess 'error'
  // event throws an uncaught exception that can take down the whole extension host (exit code 1). With a
  // handler it's logged instead, and connectWithRetry below then fails cleanly → a surfaced render error.
  proc.on('error', (err: Error) => log('[engine] spawn error: ' + err.message));
  // Hand the raw process to the host NOW, before the connect wait — so a deactivate() or cancellation during startup
  // can still kill a child that hasn't become an EngineHandle yet.
  opts.onSpawn?.(proc);

  const socket = await connectWithProcessGuard(proc, '\\\\.\\pipe\\' + pipeName, startupOutput, engineDllPath);
  const connection = createMessageConnection(
    new StreamMessageReader(socket),
    new StreamMessageWriter(socket),
  );
  connection.listen();

  return {
    connection,
    process: proc,
    pipeName,
    dispose() {
      try { connection.dispose(); } catch { /* ignore */ }
      try { socket.destroy(); } catch { /* ignore */ }
      try { proc.kill(); } catch { /* ignore */ }
    },
  };
}

/** Connect to the named pipe, but fail immediately when the apphost cannot start (missing .NET Desktop Runtime,
* wrong architecture, missing executable, etc.). The old code kept retrying the pipe for ten seconds and finally
* hid the apphost's actionable runtime-install message behind a generic connection timeout. */
function connectWithProcessGuard(
  proc: ChildProcess,
  pipePath: string,
  startupOutput: string[],
  engineEntry: string,
): Promise<net.Socket> {
  return new Promise<net.Socket>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      proc.off('error', onError);
      proc.off('exit', onExit);
    };
    const fail = (reason: string): void => {
      if (settled) return;
      settled = true;
      cleanup();
      // Every fail path rejects the whole startEngine(), so no EngineHandle is ever produced and nothing else owns
      // this child. If it is alive-but-not-listening (pipe never opened, retries exhausted), it would be orphaned and
      // keep pinning the user's dll. Kill it here; a no-op when it already exited.
      try { proc.kill(); } catch { /* already gone */ }
      const details = startupOutput.filter(Boolean).slice(-12).join('\n');
      reject(new Error(`failed to start WinForms designer engine (${engineEntry}): ${reason}${details ? `\n${details}` : ''}`));
    };
    const onError = (error: Error): void => fail(error.message);
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void =>
      fail(`process exited before opening its pipe (code=${code ?? 'null'}, signal=${signal ?? 'none'})`);
    proc.once('error', onError);
    proc.once('exit', onExit);
    void connectWithRetry(pipePath, 100, 100).then(
      (socket) => {
        if (settled) { socket.destroy(); return; }
        settled = true;
        cleanup();
        resolve(socket);
    },
      (error: Error) => fail(error.message),
    );
  });
}

function connectWithRetry(pipePath: string, tries: number, delayMs: number): Promise<net.Socket> {
  return new Promise<net.Socket>((resolve, reject) => {
    let attempt = 0;
    const tryOnce = () => {
      const socket = net.connect(pipePath);
      socket.once('connect', () => resolve(socket));
      socket.once('error', (err) => {
        socket.destroy();
        attempt += 1;
        if (attempt >= tries) {
          reject(new Error(`could not connect to engine pipe after ${tries} tries: ${err.message}`));
          return;
        }
        setTimeout(tryOnce, delayMs);
      });
    };
    tryOnce();
  });
}

export async function ping(engine: EngineHandle): Promise<string> {
  return engine.connection.sendRequest<string>('Ping');
}

/**
* Render a .Designer.cs to a PNG Buffer (engine returns base64 via JSON-RPC). controlAssemblyPath is an
* optional explicit override for the control assembly; omit it (or pass undefined) to let the engine
* auto-discover the project's build output. The override is the fallback for projects the lightweight
* resolver can't handle (multi-target, custom OutputPath, not-yet-built).
*/
export async function renderDesigner(
  engine: EngineHandle,
  designerFilePath: string,
  controlAssemblyPath?: string,
): Promise<Buffer> {
  const base64 = await engine.connection.sendRequest<string>('RenderDesigner', ...withAsm(designerFilePath, controlAssemblyPath));
  return Buffer.from(base64, 'base64');
}

/** Positional-args helper: append the explicit assembly path only when one is supplied. */
function withAsm(designerFilePath: string, controlAssemblyPath?: string): string[] {
  return controlAssemblyPath ? [designerFilePath, controlAssemblyPath] : [designerFilePath];
}

/**
* Positional tail for the optional assembly + optional source-text params. When sourceText is given (a
* VS-style unsaved buffer to render/edit instead of the disk file), the assembly slot must be occupied —
* null means "auto-discover" — so sourceText lands in the right position. When sourceText is absent, omit
* the assembly only when it too is absent (preserves the established "1-arg → auto-discover" interop).
*/
function asmTextTail(controlAssemblyPath?: string, sourceText?: string): (string | null)[] {
  if (sourceText !== undefined) return [controlAssemblyPath ?? null, sourceText];
  return controlAssemblyPath ? [controlAssemblyPath] : [];
}

/** A single control rendered to PNG + its placement (dirty-region patch). See engine RenderControl. */
export interface ControlPatch {
  png: Buffer; // the control's PNG (empty when not found)
  x: number; // left, relative to the root's client area
  y: number; // top, relative to the root's client area
  width: number;
  height: number;
  found: boolean; // false when the id matches no control
}

/**
* Render only ONE control (by edit id, "this" = root) — the dirty-region fast path: re-render the
* changed control (~0.3–1 ms) and composite the patch at (x,y) instead of a full-frame redraw.
*/
export async function renderControl(
  engine: EngineHandle,
  designerFilePath: string,
  componentId: string,
  controlAssemblyPath?: string,
  sourceText?: string,
): Promise<ControlPatch> {
  const raw = await engine.connection.sendRequest<{
    png: string; x: number; y: number; width: number; height: number; found: boolean;
  }>('RenderControl', designerFilePath, componentId, ...asmTextTail(controlAssemblyPath, sourceText));
  return {
    png: Buffer.from(raw.png ?? '', 'base64'),
    x: raw.x, y: raw.y, width: raw.width, height: raw.height, found: raw.found,
  };
}

// ---- layout (click-to-select hit-test map) ----

/** One control's window-space bounds (+ tree info) for click-to-select. See engine DescribeLayout. */
export interface LayoutControl {
  id: string; // edit id for SetProperty/RenderControl ("this" = root)
  name: string; // display name
  type: string;
  parentId: string | null;
  isRoot: boolean;
  x: number; // full-frame (window) pixel space — same transform as RenderControl
  y: number;
  width: number;
  height: number;
  depth: number; // nesting from root (root = 0); higher wins a hit-test
  tabIndex: number; // control's TabIndex for the tab-order overlay (root = -1)
  anchor: string; // anchor edges ("Top, Left" / "None") for the canvas anchor-tether overlay
  dock: string; // dock style ("Fill"/"Top"/… / "None") for the canvas dock indicator
  isTabHost?: boolean; // net48 compiled preview: control is a tab host (TabControl/XtraTabControl) → header clicks switch tabs
  isStripHost?: boolean; // control is a ToolStrip/MenuStrip/StatusStrip → canvas routes clicks into on-canvas item mode
}

/** One top-level ToolStrip/MenuStrip/StatusStrip item's window-space rect (or the trailing "Type Here" slot) for
* on-canvas item add/rename/delete. Same transform as LayoutControl. See engine ToolStripItemBounds. */
export interface ToolStripItemBounds {
  ownerId: string; // the owning strip's edit id
  itemId: string; // the item's designer field id (empty for the "Type Here" slot)
  itemType: string; // the item's concrete type FullName (empty for the slot)
  text: string; // the item's live caption — the canvas prefills the inline rename editor with it
  x: number;
  y: number;
  width: number;
  height: number;
  isTypeHere: boolean; // true for the synthesized trailing add-slot
  overflow?: boolean; // true for the strip's overflow chevron (children = the overflow-placed items) → canvas flyout
  children?: ToolStripItemBounds[]; // nested DropDownItems (id/text/type, no bounds) → canvas synthetic submenu flyout
}

/** A non-visual component for the tray (component tray): Timer/ToolTip/ErrorProvider/ImageList/BindingSource/… */
export interface TrayComponent {
  id: string; // edit id (Site.Name) for DescribeComponent/SetProperty
  name: string;
  type: string;
  // For an off-tree ToolStrip surfaced in the tray (a ContextMenuStrip): its top-level Items forest (id/text/type +
  // recursive children, no bounds) → the canvas opens a synthetic flyout from the tray chip so the strip's items are
  // reachable (Properties / rename / delete / add). Absent/empty for a non-strip component.
  items?: ToolStripItemBounds[];
  // True when this chip is a ToolStrip (ContextMenuStrip / off-tree strip): the canvas opens its flyout on a click,
  // and an EMPTY strip still gets an add-first-item "Type Here" flyout. Distinguishes an empty strip from a non-strip
  // component (Timer/ImageList/…), whose empty `items` is otherwise identical.
  isStrip?: boolean;
}

export interface LayoutResult {
  rootType: string;
  width: number; // full frame size
  height: number;
  clientWidth: number; // root client-area size (form serializes ClientSize, not window Size)
  clientHeight: number;
  controls: LayoutControl[]; // innermost-first (deepest, then smallest area)
  tray: TrayComponent[]; // non-visual components (component tray)
  toolStripItems: ToolStripItemBounds[]; // per-item geometry for on-canvas "Type Here"
}

/**
* Enumerate every control's window-space bounds for click-to-select: the webview hit-tests a click
* against these rectangles (first containing rect wins, since they're innermost-first) to map a pixel
* to a control id, which then drives the property panel + dirty-region patch.
*/
export function describeLayout(engine: EngineHandle, designerFilePath: string, controlAssemblyPath?: string, sourceText?: string): Promise<LayoutResult> {
  return engine.connection.sendRequest<LayoutResult>('DescribeLayout', designerFilePath, ...asmTextTail(controlAssemblyPath, sourceText));
}

/** A full-frame render + the click-to-select hit-test map from ONE engine graph load. See RenderWithLayout. */
export interface RenderLayout {
  png: Buffer; // full-frame PNG (same bytes as renderDesigner)
  width: number; // full frame size
  height: number;
  clientWidth: number; // root client-area size (form serializes ClientSize, not window Size)
  clientHeight: number;
  rootType: string;
  controls: LayoutControl[]; // innermost-first (deepest, then smallest area) — same as describeLayout
  tray: TrayComponent[]; // non-visual components (component tray)
  toolStripItems: ToolStripItemBounds[]; // per-item geometry for on-canvas "Type Here"
  unrepresentable: string[]; // statements the interpreter couldn't run — incl. "unresolved type X" for a control
                             // whose assembly isn't loaded (drives the "select a control source" prompt)
  /** net9 only (0.10.0 S2): the form's real base is an inherited/vendor type the interpreter can't reproduce, so this
   * best-effort preview silently drops the base's controls. Drives an honest "preview may be incomplete" banner.
   * net48 renders the real compiled type (all base controls present), so it always reports false. */
  inheritedBase: boolean;
  /** name of the inherited/unresolved base for the banner text; '' when the base resolved. */
  baseTypeName: string;
  /** net9 only (0.10.0 S3): count of sibling-.resx resources this preview can't render (BinaryFormatter/SOAP/
   * ImageStream/FileRef/non-allowlisted). >0 drives an honest "preview may be incomplete" banner. net48 renders
   * the real compiled instance (resources present), so it always reports 0. */
  unrenderableResxCount: number;
  /** net48 compiled engine only: for a live property edit, whether the value was applied to the live instance
   * (picture reflects it). Absent/true for a plain render. */
  applied?: boolean;
  /** net48 compiled engine only: why a live edit wasn't applied (or other non-fatal note). */
  diagnostics?: string;
  /** net48 compiled engine only (1.0.0): identity of the live compiled instance this result was drawn from. Changes
   * when the instance is (re)created — explicit discard, crash, control-source change, hot-exit recovery, or the
   * engine's AppDomain unload after a rebuild. DIAGNOSTIC / lifecycle only (the divergence lock this once fed was
   * descoped — see fidelityGate deletion). Undefined for the modern engine. */
  liveInstanceId?: string;
  /** net48 compiled engine only (1.0.0): identity of the compiled BUILD (assembly mtime+length) the instance came
   * from. A new liveInstanceId on the SAME liveBuildId is a reload of the same stale build; a new liveBuildId is a
   * genuine rebuild — the only event that re-syncs the preview to edited-but-unbuilt source (saving alone does not).
   * Undefined for the modern engine. */
  liveBuildId?: string;
}

/**
* Render the full frame AND fetch the click-to-select layout in ONE round-trip / engine graph load — the
* combined renderDesigner + describeLayout the designer's full render needs together. As two RPCs, render
* and layout each re-parsed/-interpreted/-rebuilt the graph (the dominant cost on large forms); folding
* them halves that work. The png/size/controls are identical to issuing both calls separately.
*/
export async function renderWithLayout(
  engine: EngineHandle,
  designerFilePath: string,
  controlAssemblyPath?: string,
  sourceText?: string,
  scale?: number,
): Promise<RenderLayout> {
  // Explicit positional args (not asmTextTail's variable tail) so renderScale always lands in the 4th slot; the C#
  // RenderWithLayout treats null asm/text exactly like the omitted-tail form. scale = integer DPI factor (1 default).
  const raw = await engine.connection.sendRequest<{
    png: string; width: number; height: number; clientWidth: number; clientHeight: number;
    rootType: string; controls: LayoutControl[]; tray: TrayComponent[]; toolStripItems?: ToolStripItemBounds[]; unrepresentable?: string[];
    inheritedBase?: boolean; baseTypeName?: string; unrenderableResxCount?: number;
  }>('RenderWithLayout', designerFilePath, controlAssemblyPath ?? null, sourceText ?? null, scale ?? 1);
  return {
    png: Buffer.from(raw.png ?? '', 'base64'),
    width: raw.width,
    height: raw.height,
    clientWidth: raw.clientWidth,
    clientHeight: raw.clientHeight,
    rootType: raw.rootType,
    controls: raw.controls ?? [],
    tray: raw.tray ?? [],
    toolStripItems: raw.toolStripItems ?? [],
    unrepresentable: raw.unrepresentable ?? [],
    // `InheritedBase` is a non-nullable engine bool, ALWAYS serialized (even false), and the engine is bundled in the
    // VSIX with this client — so the field is present for every real render. The `?? false` guards only a version-skew
    // dev build (new client + pre-S2 engine); we deliberately default false there rather than true: a
    // default-true would banner EVERY form against such an engine (a worse, ship-blocking over-banner). Skew is a build
    // problem, not a runtime state, and it would break far more than S2.
    inheritedBase: raw.inheritedBase ?? false,
    baseTypeName: raw.baseTypeName ?? '',
    unrenderableResxCount: raw.unrenderableResxCount ?? 0, // pre-S3 engine → 0 (no banner), same version-skew default as inheritedBase
  };
}

/**
* Render a Framework/DevExpress control via the net48 engine by INSTANTIATING the compiled control type
* (RenderCompiledWithLayout) — the render-first path for projects the net9 engine can't load. assemblyPath is
* REQUIRED (the design-host project's build output); sourceText is intentionally absent (the compiled render
* reflects the built assembly, not the unsaved buffer). The result shape matches renderWithLayout so the
* session's render pipeline is unchanged. rootTypeName/probeDirs are optional (the engine derives/defaults them).
*/
export async function renderCompiledWithLayout(
  engine: EngineHandle,
  designerFilePath: string,
  assemblyPath: string,
  rootTypeName?: string,
  probeDirs?: string[],
  width?: number,
  height?: number,
  scale?: number,
): Promise<RenderLayout> {
  const raw = await engine.connection.sendRequest<CompiledRenderRaw>(
    'RenderCompiledWithLayout', designerFilePath, assemblyPath, rootTypeName ?? null, probeDirs ?? null, width ?? 0, height ?? 0, scale ?? 1);
  return fromCompiledRaw(raw);
}

/** Render the LIVE .Designer.cs source through the net48 IR interpreter (VS model), or the compiled
* last build with a named reason when the interpreter can't cover the form. Unlike renderCompiledWithLayout this
* takes the unsaved buffer (sourceText) and returns renderMode ('interpreted' | 'compiledFallback') + fallbackReason
* so the host drives the two-axis mode + banner. Same layout shape otherwise. */
export interface InterpretedRenderResult extends RenderLayout { renderMode: string; fallbackReason: string; }
export async function renderInterpretedWithLayout(
  engine: EngineHandle,
  designerFilePath: string,
  assemblyPath: string,
  sourceText: string,
  rootTypeName?: string,
  probeDirs?: string[],
  width?: number,
  height?: number,
  selectedTabs?: string[], // transient "hostField=pageField" tab overrides, re-supplied each render
  scale?: number,
): Promise<InterpretedRenderResult> {
  const raw = await engine.connection.sendRequest<CompiledRenderRaw & { renderMode?: string; fallbackReason?: string }>(
    'RenderInterpretedWithLayout', designerFilePath, assemblyPath, sourceText ?? '', rootTypeName ?? null, probeDirs ?? null, width ?? 0, height ?? 0, selectedTabs ?? null, scale ?? 1);
  return { ...fromCompiledRaw(raw), renderMode: raw.renderMode ?? 'compiled', fallbackReason: raw.fallbackReason ?? '' };
}

interface CompiledRenderRaw {
  png: string; width: number; height: number; clientWidth: number; clientHeight: number;
  rootType: string; controls: LayoutControl[]; tray: TrayComponent[]; toolStripItems?: ToolStripItemBounds[]; unrepresentable?: string[];
  applied?: boolean; diagnostics?: string;
  liveInstanceId?: string; // 1.0.0 — RenderLayoutResult.LiveInstanceId (camelCased on the wire)
  liveBuildId?: string; // 1.0.0 — RenderLayoutResult.LiveBuildId
}

function fromCompiledRaw(raw: CompiledRenderRaw): RenderLayout {
  return {
    png: Buffer.from(raw.png ?? '', 'base64'),
    width: raw.width,
    height: raw.height,
    clientWidth: raw.clientWidth,
    clientHeight: raw.clientHeight,
    rootType: raw.rootType,
    controls: raw.controls ?? [],
    tray: raw.tray ?? [],
    toolStripItems: raw.toolStripItems ?? [],
    unrepresentable: raw.unrepresentable ?? [],
    // net48 renders the real compiled type (base controls present), so it never flags inherited-base — S2 is net9-only.
    inheritedBase: false,
    baseTypeName: '',
    // net48 instantiates the real compiled form: its ImageStream/BinaryFormatter resx resources materialize and
    // render, so the preview is complete → 0 unrenderable. S3's banner is net9-only, same rationale as S2.
    unrenderableResxCount: 0,
    // 1.0.0 — the engine stamps every response in Snapshot(). DIAGNOSTIC / lifecycle only now (the divergence lock
    // these once fed was descoped); the release-for-rebuild e2e still asserts the build id advances
    // on a real rebuild. Left undefined on a version-skew dev build (new client + pre-1.0 engine).
    liveInstanceId: raw.liveInstanceId,
    liveBuildId: raw.liveBuildId,
    applied: raw.applied ?? true,
    diagnostics: raw.diagnostics ?? '',
  };
}

/** Property-grid + events for ONE control of the net48 live compiled instance ("this" = root, else its
* .Designer.cs field name). Same ComponentDesc shape as the net9 describeComponent. null when not found. */
export function describeCompiledComponent(
  engine: EngineHandle, designerFilePath: string, assemblyPath: string, componentId: string,
  rootTypeName?: string, probeDirs?: string[], sourceText?: string,
): Promise<ComponentDesc | null> {
  // sourceText = the UNSAVED .Designer.cs buffer; when passed, the net48 SourceMetadata pass parses IT (not the on-disk
  // file) so a just-wired event / just-reset property reflects the dirty edit immediately. Omitted → engine reads disk.
  return engine.connection.sendRequest<ComponentDesc | null>(
    'DescribeCompiledComponent', designerFilePath, assemblyPath, componentId, rootTypeName ?? null, probeDirs ?? null, sourceText ?? null);
}

/** describe one component of the INTERPRETED live-source instance, so the property panel matches
* the interpreted canvas on an unsaved edit. `sourceText` is the live (possibly unsaved) buffer. Returns null when the
* form doesn't fully interpret or the id names no current component — the host then keeps the panel UNAVAILABLE and must
* never substitute compiled values under an interpreted canvas. */
export function describeInterpretedComponent(
  engine: EngineHandle, designerFilePath: string, assemblyPath: string, sourceText: string, componentId: string,
  rootTypeName?: string, probeDirs?: string[], width?: number, height?: number,
): Promise<ComponentDesc | null> {
  return engine.connection.sendRequest<ComponentDesc | null>(
    'DescribeInterpretedComponent', designerFilePath, assemblyPath, sourceText ?? '', componentId,
    rootTypeName ?? null, probeDirs ?? null, width ?? 0, height ?? 0);
}

/** The vendor smart-tag menu a control's compiled type DECLARES (the DevExpress "XtraTabControl Tasks" panel).
* Metadata only — the engine never invokes the vendor's action (it would mutate the live instance and never reach
* .Designer.cs; some verbs open a modal dialog). The host maps the verbs it can express onto its own source-first
* edits and shows the rest disabled. [] for a plain framework control or any failure. net48 only: it needs the real
* compiled type, which only the compiled engine loads. */
export function listCompiledVendorSmartTags(
  engine: EngineHandle, designerFilePath: string, assemblyPath: string, componentId: string,
  rootTypeName?: string, probeDirs?: string[],
): Promise<VendorSmartTag[]> {
  return engine.connection.sendRequest<VendorSmartTag[]>(
    'ListCompiledVendorSmartTags', designerFilePath, assemblyPath, componentId, rootTypeName ?? null, probeDirs ?? null);
}

/** Apply ONE property edit to the net48 live instance + re-render (live preview for a designer-originated edit).
* The persisted TEXT write is separate (net9 splice); this is only the picture. `applied` is false when the
* value couldn't be set live (unconvertible/read-only) — the text edit still shows after a rebuild. */
export async function setCompiledPropertyLive(
  engine: EngineHandle, designerFilePath: string, assemblyPath: string, componentId: string,
  propName: string, rawValue: string, rootTypeName?: string, probeDirs?: string[],
): Promise<RenderLayout> {
  const raw = await engine.connection.sendRequest<CompiledRenderRaw>(
    'SetCompiledPropertyLive', designerFilePath, assemblyPath, componentId, propName, rawValue, rootTypeName ?? null, probeDirs ?? null);
  return fromCompiledRaw(raw);
}

/** Reset ONE property on the net48 live instance to its default (pd.ResetValue) + re-render — the picture half of
* a per-property Reset (the persisted TEXT delete is a separate net9 splice). `applied` is false when the property
* isn't resettable (CanResetValue == false); the committed text still shows after a rebuild. */
export async function resetCompiledPropertyLive(
  engine: EngineHandle, designerFilePath: string, assemblyPath: string, componentId: string,
  propName: string, rootTypeName?: string, probeDirs?: string[],
): Promise<RenderLayout> {
  const raw = await engine.connection.sendRequest<CompiledRenderRaw>(
    'ResetCompiledPropertyLive', designerFilePath, assemblyPath, componentId, propName, rootTypeName ?? null, probeDirs ?? null);
  return fromCompiledRaw(raw);
}

/** One item for the net48 live collection reconstruction (T1.1b). A superset carrying all three editable collections
* keyed by the RPC's `itemType`: `text` is the string value / ListView column Text / DataGridView HeaderText;
* `width`/`align` are ListView/DataGridView column props; `readOnly`/`visible` are DataGridView-only; `id` is an
* existing column's field name ("" = new). Fields the target collection doesn't use are ignored. */
export interface LiveCollItem {
  id?: string;
  text: string;
  width?: number;
  align?: string;
  readOnly?: boolean;
  visible?: boolean;
}

/** Reconstruct a typed collection (Items / ListView.Columns / DataGridView.Columns) on the net48 live instance from
* the net9-committed item data + re-render — the live picture for the "…" collection editor (T1.1b). The persisted
* TEXT write is separate (net9 splice); this is only the picture. `applied` is false when it can't be rebuilt live
* (bound/unsupported column) — the committed text still renders after a rebuild. */
export async function setCompiledCollectionLive(
  engine: EngineHandle, designerFilePath: string, assemblyPath: string, componentId: string,
  propName: string, itemType: string, items: LiveCollItem[], rootTypeName?: string, probeDirs?: string[],
): Promise<RenderLayout> {
  const raw = await engine.connection.sendRequest<CompiledRenderRaw>(
    'SetCompiledCollectionLive', designerFilePath, assemblyPath, componentId, propName, itemType, items, rootTypeName ?? null, probeDirs ?? null);
  return fromCompiledRaw(raw);
}

/** Reconstruct a TreeView's Nodes on the net48 live instance from the net9-committed node forest + re-render — the
* live picture for the hierarchical "…" TreeNode editor (the TreeView analogue of {@link setCompiledCollectionLive}).
* The recursive `TreeNodeItem` shape is sent verbatim; the engine reads only text/name/children (`id` is ignored).
* `applied` is false when it can't be rebuilt live (a DevExpress TreeList's non-TreeNodeCollection Nodes) — the
* committed text still renders after a rebuild. */
export async function setCompiledTreeNodesLive(
  engine: EngineHandle, designerFilePath: string, assemblyPath: string, componentId: string,
  propName: string, nodes: TreeNodeItem[], rootTypeName?: string, probeDirs?: string[],
): Promise<RenderLayout> {
  const raw = await engine.connection.sendRequest<CompiledRenderRaw>(
    'SetCompiledTreeNodesLive', designerFilePath, assemblyPath, componentId, propName, nodes, rootTypeName ?? null, probeDirs ?? null);
  return fromCompiledRaw(raw);
}

/** Reconcile a ToolStrip/MenuStrip's items (add/remove/rename/reorder) on the net48 live instance from the
* net9-committed forest + re-render — the live picture for the "…" ToolStrip item editor (the ToolStrip analogue of
* {@link setCompiledTreeNodesLive}). The recursive `ToolStripItemModel` shape is sent verbatim; unlike TreeNodes,
* items are persisted fields, so the engine reconciles them SURGICALLY by `id` (never Clear()+rebuild) to preserve
* unmodelled props (Image/events). The caller must send the RESOLVED forest (every id populated, incl. minted ids
* for "Type Here" adds), since the engine keys on id. `applied` is false when the owner isn't a live ToolStrip or a
* new item type can't be constructed — the committed text still renders after a rebuild. */
export async function setCompiledToolStripItemsLive(
  engine: EngineHandle, designerFilePath: string, assemblyPath: string, componentId: string,
  items: ToolStripItemModel[], rootTypeName?: string, probeDirs?: string[],
): Promise<RenderLayout> {
  const raw = await engine.connection.sendRequest<CompiledRenderRaw>(
    'SetCompiledToolStripItemsLive', designerFilePath, assemblyPath, componentId, items, rootTypeName ?? null, probeDirs ?? null);
  return fromCompiledRaw(raw);
}

/** Set a generic string[] property (TextBox/RichTextBox.Lines) on the net48 live instance from the net9-committed
* values + re-render — the live picture for the "…" string-array editor (mirror of {@link setCompiledCollectionLive}).
* The persisted TEXT write is separate (net9 splice); this is only the picture. `applied` is false when the property
* isn't a writable string[] — the committed text still renders after a rebuild. */
export async function setCompiledStringArrayLive(
  engine: EngineHandle, designerFilePath: string, assemblyPath: string, componentId: string,
  propName: string, items: string[], rootTypeName?: string, probeDirs?: string[],
): Promise<RenderLayout> {
  const raw = await engine.connection.sendRequest<CompiledRenderRaw>(
    'SetCompiledStringArrayLive', designerFilePath, assemblyPath, componentId, propName, items, rootTypeName ?? null, probeDirs ?? null);
  return fromCompiledRaw(raw);
}

/** 0.11.0 ImageList editor — one image to embed (decoded bytes as base64 + its key, "" = keyless). */
export interface ImageListImage { dataBase64: string; key: string; }
/** The images + settings to serialize into an ImageList's ImageStream resource (net48 binary primitive). */
export interface ImageListSpec { images: ImageListImage[]; width: number; height: number; colorDepth: string; transparentColor: string; }
/** Result of serializeImageList: VS-format ImageStream base64 (+ mimetype), key order, self round-trip count. */
export interface ImageStreamResult { ok: boolean; base64: string; mimeType: string; keys: string[]; count: number; reason: string; }

/** 0.11.0 ImageList editor — serialize images into a VS-format ImageStream base64 blob via the net48 engine (the one
* op that needs the .NET Framework runtime; net9 can't serialize an ImageListStreamer). No compiled assembly is
* touched, so the host may route it through the bundled net48 engine even for a pure .NET project. The host embeds
* the payload into the sibling .resx (net9 XML upsert) and emits the matching designer edit. */
export async function serializeImageList(engine: EngineHandle, spec: ImageListSpec): Promise<ImageStreamResult> {
  // POSITIONAL args (not the spec object) — vscode-jsonrpc sends a lone object as JSON-RPC *named* params, which
  // StreamJsonRpc would try to bind field-by-field; spreading the fields sends a params array it binds positionally.
  return await engine.connection.sendRequest<ImageStreamResult>(
    'SerializeImageList', spec.images, spec.width, spec.height, spec.colorDepth, spec.transparentColor);
}

/** Result of deserializeImageList: the current images (PNG base64 + keys) + size/depth/transparent an ImageStream
* blob decodes to, so the editor can show existing images (ok=false on a foreign/malformed blob). */
export interface ImageListReadResult {
  ok: boolean; images: ImageListImage[]; width: number; height: number;
  colorDepth: string; transparentColor: string; reason: string;
}

/** 0.11.0 ImageList editor (READ side) — deserialize an ImageStream blob back to its current images via the net48
* engine, so the editor can show the existing images before the user edits them. Works for any project. */
export async function deserializeImageList(engine: EngineHandle, base64: string): Promise<ImageListReadResult> {
  return await engine.connection.sendRequest<ImageListReadResult>('DeserializeImageList', base64);
}

/** Reconcile an ImageList edit on the net48 cached compiled instance and re-render immediately. The host has already
* committed the source + .resx transaction; this RPC updates only the preview instance. */
export async function setCompiledImageListLive(
  engine: EngineHandle, designerFilePath: string, assemblyPath: string, componentId: string,
  imageStreamBase64: string, keys: string[], rootTypeName?: string, probeDirs?: string[],
): Promise<RenderLayout> {
  const raw = await engine.connection.sendRequest<CompiledRenderRaw>(
    'SetCompiledImageListLive', designerFilePath, assemblyPath, componentId, imageStreamBase64, keys,
    rootTypeName ?? null, probeDirs ?? null);
  return fromCompiledRaw(raw);
}

/** 0.11.0 net48 undo reconcile — drop the cached live compiled instance so the next render re-instantiates from the
* compiled baseline. Called on undo/redo/revert (net48 renders the instance, not the reverted text, so the cache
* would otherwise keep showing the undone edit). Returns true if an instance was dropped. */
export async function discardCompiledLive(
  engine: EngineHandle, designerFilePath: string, assemblyPath: string, rootTypeName?: string, probeDirs?: string[],
): Promise<boolean> {
  return await engine.connection.sendRequest<boolean>(
    'DiscardCompiledLive', designerFilePath, assemblyPath, rootTypeName ?? null, probeDirs ?? null);
}

/**
* 1.0.0 — release every handle the net48 engine holds on this assembly's output directory (it unloads the child
* AppDomain that loaded it). Idempotent; returns a ReleaseResult ({attempted, released, failed}) so the caller can
* tell "nothing was loaded" (attempted 0) from "found it but the unload FAILED and it still pins the dll" (failed > 0).
*
* The net48 preview loads the user's dlls in place, which PINS them: while it is live, the user's own build fails
* with MSB3027 ("The file is locked by: WinFormsDesigner.Engine.Net48"). Nothing releases them implicitly — that is
* what made every "rebuild to refresh the preview" instruction unfollowable. Call this when the last session using an
* assembly closes, and from the explicit release-for-rebuild command.
*
* Keyed on the output DIRECTORY, not the form: one domain serves every form built there. Costly (the next render pays
* a fresh domain + assembly load), so this is not a per-edit call.
*/
export async function releaseCompiledAssembly(engine: EngineHandle, assemblyPath: string): Promise<ReleaseResult> {
  const r = await engine.connection.sendRequest<Partial<ReleaseResult>>('ReleaseCompiledAssembly', assemblyPath);
  return { attempted: r?.attempted ?? 0, released: r?.released ?? 0, failed: r?.failed ?? 0 };
}

/** 1.0.0 — outcome of releasing every held net48 build output. `failed > 0` means an AppDomain refused to unload and
* is still pinning the user's dlls, so the caller must recycle the engine process to actually free them. */
export interface ReleaseResult { attempted: number; released: number; failed: number; }

/**
* 1.0.0 — release EVERY build output the net48 engine currently holds open; returns {attempted, released, failed}.
*
* Backs the project-wide release-for-rebuild command. Ask the ENGINE rather than releasing the assemblies the host
* believes are in use: a session that switched control source forgets the output it previously pinned, so no session
* names it and it stays locked until the engine exits. Only the engine knows what it actually loaded.
*
* A `failed` count is not a soft warning: those domains still hold the file handles, so a caller that reported
* success would send the user to a rebuild that fails with the same lock. Recycle the engine process on `failed > 0`.
*/
export async function releaseAllCompiledAssemblies(engine: EngineHandle): Promise<ReleaseResult> {
  const r = await engine.connection.sendRequest<Partial<ReleaseResult>>('ReleaseAllCompiledAssemblies');
  return { attempted: r?.attempted ?? 0, released: r?.released ?? 0, failed: r?.failed ?? 0 };
}

/** One live property edit for the net48 batch-mutate (drag/resize/align). */
export interface CompiledEdit { componentId: string; propName: string; rawValue: string; }

/** Apply a BATCH of property edits to the net48 live instance + re-render once (drag/resize/align). */
export async function applyCompiledEdits(
  engine: EngineHandle, designerFilePath: string, assemblyPath: string, edits: CompiledEdit[],
  rootTypeName?: string, probeDirs?: string[],
): Promise<RenderLayout> {
  const raw = await engine.connection.sendRequest<CompiledRenderRaw>(
    'ApplyCompiledEdits', designerFilePath, assemblyPath, edits, rootTypeName ?? null, probeDirs ?? null);
  return fromCompiledRaw(raw);
}

/** Remove field-backed controls from the net48 live instance + re-render. */
export async function removeCompiledControls(
  engine: EngineHandle, designerFilePath: string, assemblyPath: string, ids: string[],
  rootTypeName?: string, probeDirs?: string[],
): Promise<RenderLayout> {
  const raw = await engine.connection.sendRequest<CompiledRenderRaw>(
    'RemoveCompiledControls', designerFilePath, assemblyPath, ids, rootTypeName ?? null, probeDirs ?? null);
  return fromCompiledRaw(raw);
}

/** Bring-to-front / send-to-back the given controls of the net48 live instance + re-render. */
export async function setCompiledZOrder(
  engine: EngineHandle, designerFilePath: string, assemblyPath: string, ids: string[], toFront: boolean,
  rootTypeName?: string, probeDirs?: string[],
): Promise<RenderLayout> {
  const raw = await engine.connection.sendRequest<CompiledRenderRaw>(
    'SetCompiledZOrder', designerFilePath, assemblyPath, ids, toFront, rootTypeName ?? null, probeDirs ?? null);
  return fromCompiledRaw(raw);
}

/** Switch the active tab of the net48 live tab host at hostId to the header under window-space (x,y) + re-render.
* `applied` is true only when the active tab actually changed (a header of a DIFFERENT tab was hit). */
export async function selectCompiledTabAt(
  engine: EngineHandle, designerFilePath: string, assemblyPath: string, hostId: string, x: number, y: number,
  rootTypeName?: string, probeDirs?: string[],
): Promise<RenderLayout> {
  const raw = await engine.connection.sendRequest<CompiledRenderRaw>(
    'SelectCompiledTabAt', designerFilePath, assemblyPath, hostId, x, y, rootTypeName ?? null, probeDirs ?? null);
  return fromCompiledRaw(raw);
}

/** The tab page (field id + current Text) whose header is under window-space (x,y) on the net48 live tab host —
* for renaming a tab. `pageId` is "" when the point isn't on a header of a field-backed page. */
export interface TabHit { pageId: string; text: string; }
export function hitTestCompiledTab(
  engine: EngineHandle, designerFilePath: string, assemblyPath: string, hostId: string, x: number, y: number,
  rootTypeName?: string, probeDirs?: string[],
): Promise<TabHit> {
  return engine.connection.sendRequest<TabHit>(
    'HitTestCompiledTab', designerFilePath, assemblyPath, hostId, x, y, rootTypeName ?? null, probeDirs ?? null);
}

/** the INTERPRETED tab hit-test: which page's header is under (x,y) on the live-source geometry
* (applying the current tab view-state). The host uses the returned pageId to re-render interpreted with that page
* selected, so a tab-click stays interpreted. pageId "" when off a header / not a tab host / not interpretable. */
export function hitTestInterpretedTab(
  engine: EngineHandle, designerFilePath: string, assemblyPath: string, sourceText: string, hostId: string,
  x: number, y: number, selectedTabs?: string[], rootTypeName?: string, probeDirs?: string[],
): Promise<TabHit> {
  return engine.connection.sendRequest<TabHit>(
    'HitTestInterpretedTab', designerFilePath, assemblyPath, sourceText ?? '', hostId, x, y,
    selectedTabs ?? null, rootTypeName ?? null, probeDirs ?? null);
}

/** Add a control (controlTypeKey) to parentId at (locX,locY), registered under newId, on the net48 live
* instance + re-render (the persisted declaration is the host's net9 splice). */
export async function addCompiledControl(
  engine: EngineHandle, designerFilePath: string, assemblyPath: string, parentId: string,
  controlTypeKey: string, newId: string, locX?: number, locY?: number, rootTypeName?: string, probeDirs?: string[],
): Promise<RenderLayout> {
  const raw = await engine.connection.sendRequest<CompiledRenderRaw>(
    'AddCompiledControl', designerFilePath, assemblyPath, parentId, controlTypeKey, newId,
    locX ?? -1, locY ?? -1, rootTypeName ?? null, probeDirs ?? null);
  return fromCompiledRaw(raw);
}

/** An engine's self-description (GetCapabilities) — drives edit-affordance gating + the "compiled preview" badge. */
export interface EngineCapabilities {
  engine: string;
  render: boolean;
  edit: boolean;
  livePreviewUnsavedEdits: boolean;
  runtime: string;
  notes: string;
}

/** Ask an engine what it supports. Both bundled 1.0 engines implement this handshake. */
export function getCapabilities(engine: EngineHandle): Promise<EngineCapabilities> {
  return engine.connection.sendRequest<EngineCapabilities>('GetCapabilities');
}

// ---- describe / edit (property-grid data + write side) ----

export interface PropertyDesc {
  name: string;
  type: string;
  value: string | null;
  isDefault: boolean | null;
  sourceExplicit: boolean;
  readOnly: boolean;
  isEnum: boolean;
  category: string;
  /** TypeConverter standard values as invariant strings (dropdowns), or null/absent when none. */
  standardValues?: string[] | null;
  /** True → closed set (render a <select>); false → editable combobox (datalist). */
  standardValuesExclusive?: boolean;
  /** For a [Flags] enum: the individual single-bit member names (e.g. Top/Bottom/Left/Right), so the grid
   * can render a checkbox dropdown that composes "Top, Left". Null/absent for non-flags. */
  flagsMembers?: string[] | null;
  /** For a [Flags] enum: the name of its zero-valued member (e.g. "None") — committed when all are
   * unchecked. Null/absent when the enum has no zero member. */
  flagsZero?: string | null;
  /** True for a TableLayoutPanel child's Column/Row extender — edited via SetTableCell (rewrites the 3-arg
   * Controls.Add cell args), NOT a normal property assignment. */
  tableCell?: boolean;
  /** True when the property's value type is an image/icon (System.Drawing.Image/Bitmap/Icon) — the grid renders
   * a preview swatch + Import…/(none) editor (resx-backed) instead of a text field. `value` stays null. */
  isImage?: boolean;
  /** A small base64 PNG thumbnail of the current image value (max 64×64), or null/absent when unset / not an
   * image. Display-only. */
  imagePreview?: string | null;
  /** True for a string-item collection (ComboBox/ListBox/CheckedListBox.Items) — the grid renders a "…" button
   * that opens the VS "String Collection Editor" (one item per line). Edits route through SetCollectionItems
   * (rewrites the owner's Add/AddRange calls), NOT a normal property assignment. `value` stays null. */
  isCollection?: boolean;
  /** The collection's item type (currently always "System.String"), or null/absent when not a collection. */
  collectionItemType?: string | null;
  /** The property's DescriptionAttribute text (shown in the description pane below the grid), or null/absent
   * when the property carries no description. */
  description?: string | null;
  /** True for a component-reference property (ReferenceConverter: AcceptButton/CancelButton/ContextMenuStrip).
   * `standardValues` are the compatible sibling field names + a leading "(none)"; the panel tags the edit with
   * `refEdit` so the host writes `this.<name>` / `null` (net9 splice, net48 live resolve) instead of a literal. */
  referenceValues?: boolean;
  /** True for a design-time PSEUDO-property (Modifiers / GenerateMember) — a source artifact, not a live component
   * property. The panel tags its edit `designTime` so the host routes to the field-declaration splice (setModifier),
   * not setProperty. Routing on this flag (not the name) keeps a real property named "Modifiers" on the normal path. */
  designTime?: boolean;
}

export interface EventDesc {
  name: string;
  type: string; // delegate type (e.g. System.EventHandler)
  category: string;
  handler: string | null; // wired handler method name from the source, or null if unhandled
}

export interface ComponentDesc {
  id: string; // edit id for SetProperty ("this" = root)
  name: string; // display name
  type: string;
  parent: string | null;
  isRoot: boolean;
  properties: PropertyDesc[];
  events: EventDesc[];
}

/** One entry of a vendor control's DECLARED smart-tag menu (DevExpress "Tasks"), read off the compiled type's
* attributes by the net48 engine. Display + identity only — see listCompiledVendorSmartTags. */
export interface VendorSmartTag {
  displayName: string; // the vendor's own label, verbatim ("Add Tab Page")
  methodName: string; // verb id on the vendor actions class ("AddTabPage") — the host's mapping key
  actionsType: string; // FQN of the vendor actions class; diagnostic only, never loaded
  sortOrder: number;
  closesPanel: boolean;
  declarationIndex: number;
}

export interface DescribeResult {
  rootType: string;
  components: ComponentDesc[];
  totalStatements: number;
  representable: number;
  unrepresentable: string[];
  roundTripSafe: boolean;
}

export interface EditPreview {
  safe: boolean;
  mode: string; // Replace | Insert | Failed
  text: string | null;
  reason: string;
}

export interface SerializePreview {
  safe: boolean;
  code: string | null;
  unrepresentable: string[];
}

export interface SavePreview {
  safe: boolean;
  text: string | null; // spliced whole-file text; null when not safe (read-only fallback)
  unrepresentable: string[];
  missingStatements: string[]; // safe-save gate: original statements the re-serialization fails to reproduce
  reasonCategory: string; // capability preflight: safe | localizable | binaryResx | unresolvedType | lostStatements | unrepresentable
}

/** Enumerate the form's controls + properties (read side for a property grid). */
export function describeDesigner(engine: EngineHandle, designerFilePath: string, controlAssemblyPath?: string): Promise<DescribeResult> {
  return engine.connection.sendRequest<DescribeResult>('DescribeDesigner', ...withAsm(designerFilePath, controlAssemblyPath));
}

/** Describe one component by edit id ("this" = root) — bounded per-selection fetch. */
export function describeComponent(engine: EngineHandle, designerFilePath: string, componentId: string, controlAssemblyPath?: string, sourceText?: string): Promise<ComponentDesc | null> {
  return engine.connection.sendRequest<ComponentDesc | null>('DescribeComponent', designerFilePath, componentId, ...asmTextTail(controlAssemblyPath, sourceText));
}

/**
* Serialize a .Designer.cs back to a normalized InitializeComponent (no write) — the round-trip preview.
* `code` is null when the source doesn't fully round-trip (read-only fallback). controlAssemblyPath
* optionally overrides project auto-discovery.
*/
export function serializeDesigner(engine: EngineHandle, designerFilePath: string, controlAssemblyPath?: string): Promise<SerializePreview> {
  return engine.connection.sendRequest<SerializePreview>('SerializeDesigner', ...withAsm(designerFilePath, controlAssemblyPath));
}

/**
* Full safe-save gate preview (no write): re-serialize + splice into the existing file and report whether
* it is safe to save back. This is the AUTHORITATIVE capability-preflight signal. Unlike {@link serializeDesigner}
* (`safe` == RoundTripSafe, an interpret/render-only signal), `safe` here also requires that no original statement
* is lost by the re-serialization (`missingStatements` empty) — e.g. a form whose serializer canonicalizes
* `TabPages.AddRange` to per-page `Controls.Add`, or one with TreeNode local-variable naming, renders fully
* (RoundTripSafe) yet is refused here. `reasonCategory` explains why when `safe` is false.
*/
export function previewSave(engine: EngineHandle, designerFilePath: string, controlAssemblyPath?: string): Promise<SavePreview> {
  return engine.connection.sendRequest<SavePreview>('PreviewSave', ...withAsm(designerFilePath, controlAssemblyPath));
}

/**
* Build an idiomatic C# initializer expression for a complex property value (Point/Size/Color/…)
* from its invariant-string form. Returns null when the value isn't convertible (the grid then
* leaves the property read-only / rejects the edit).
*/
export function convertValue(engine: EngineHandle, typeName: string, invariantValue: string): Promise<string | null> {
  return engine.connection.sendRequest<string | null>('ConvertValue', typeName, invariantValue);
}

/** One color-dropdown swatch: a KnownColor name + its opaque RRGGBB hex (theme-accurate for system colors). */
export interface ColorSwatch {
  name: string;
  argb: string; // 6-hex RRGGBB, no leading '#'
}

/** A GraphicsUnit member + the exact suffix the installed FontConverter emits (Point → "pt"). */
export interface FontUnitInfo {
  name: string;
  suffix: string;
}

/** Static palette for the Color dropdown + Font editor (see GetDesignerPalette). */
export interface DesignerPaletteInfo {
  webColors: ColorSwatch[];
  systemColors: ColorSwatch[];
  fontFamilies: string[];
  fontUnits: FontUnitInfo[];
}

/**
* The KnownColor palette (web + system, with ARGB for swatches), installed font families, and the
* authoritative FontConverter unit suffixes — data for the property grid's Color dropdown and Font
* editor. Static engine-wide (independent of any designer file); the host fetches it once and caches it.
*/
export function getDesignerPalette(engine: EngineHandle): Promise<DesignerPaletteInfo> {
  return engine.connection.sendRequest<DesignerPaletteInfo>('GetDesignerPalette');
}

/**
* Resolve the auto-discovered control assembly for a .Designer.cs (MSBuild design-time eval → bin
* search), or null if none was found. Lets the host surface which assembly auto-discovery chose.
*/
export function resolveAssembly(engine: EngineHandle, designerFilePath: string): Promise<string | null> {
  return engine.connection.sendRequest<string | null>('ResolveAssembly', designerFilePath);
}

/** Result of GenerateEventHandler: new texts for the .Designer.cs (wiring) and .cs code-behind (stub). */
export interface EventGenResult {
  safe: boolean;
  reason: string;
  handlerName: string;
  alreadyWired: boolean; // event already had a handler → designer untouched, just navigate
  designerText: string | null; // new .Designer.cs text (wiring added), or null when unchanged
  codeText: string | null; // new .cs text (stub added), or null when unchanged / no code file
  /** The stub as a MINIMAL edit against the codeText passed in: insert codeInsertText at this offset (-1 = none).
   * Apply THIS, not codeText: a whole-document replace is built from a snapshot and silently erases any edit that
   * lands during the awaited write (a formatter, a generator, the user typing) — applyEdit has no version
   * precondition to prevent it. A one-point insert leaves the rest of the user's file alone. */
  codeInsertOffset: number;
  codeInsertText: string | null;
  stubCreated: boolean;
}

/**
* VS-style "create event handler": add the event wiring to InitializeComponent (.Designer.cs) and an empty
* handler stub (matching the delegate signature) to the code-behind (.cs). The host applies both returned
* texts as unsaved edits and navigates into the stub. Pass the unsaved buffers as designerSourceText/codeText
* (null → engine reads disk / skips the code edit); handlerName overrides the default comp_Event name.
*/
export function generateEventHandler(
  engine: EngineHandle,
  designerFilePath: string,
  componentId: string,
  eventName: string,
  handlerName: string | null,
  designerSourceText: string | null,
  codeText: string | null,
  controlAssemblyPath: string | null,
): Promise<EventGenResult> {
  return engine.connection.sendRequest<EventGenResult>(
    'GenerateEventHandler',
    designerFilePath, componentId, eventName, handlerName, designerSourceText, codeText, controlAssemblyPath,
  );
}

/**
* Events dropdown: existing code-behind methods compatible (by signature) with each of a component's
* events, as a map eventName → candidate method names (only events that have ≥1 candidate are present).
*/
export async function listHandlerCandidates(
  engine: EngineHandle,
  designerFilePath: string,
  componentId: string,
  designerSourceText: string | null,
  codeText: string | null,
  controlAssemblyPath: string | null,
): Promise<Record<string, string[]>> {
  // the engine returns a LIST of {event, handlers} (not a map) so event names aren't camelCased as JSON
  // dictionary keys; rebuild the by-event map here with the real names preserved.
  const list = await engine.connection.sendRequest<Array<{ event: string; handlers: string[] }>>(
    'ListHandlerCandidates', designerFilePath, componentId, designerSourceText, codeText, controlAssemblyPath,
  );
  const map: Record<string, string[]> = {};
  for (const e of list ?? []) map[e.event] = e.handlers ?? [];
  return map;
}

/** Result of SetEventWiring: the new .Designer.cs text after a wire/rewire/unwire (code-behind untouched). */
export interface EventWiringResult {
  safe: boolean;
  reason: string;
  handlerName: string;
  designerText: string | null;
}

/**
* Events dropdown write path: wire/rewire/unwire an event to an EXISTING handler. handlerName null →
* unwire. The chosen method must already exist in the code-behind (codeText) — the engine refuses to wire
* to a missing method. Edits only the .Designer.cs; the host applies the returned text as an unsaved edit.
*/
export function setEventWiring(
  engine: EngineHandle,
  designerFilePath: string,
  componentId: string,
  eventName: string,
  handlerName: string | null,
  designerSourceText: string | null,
  codeText: string | null,
  controlAssemblyPath: string | null,
): Promise<EventWiringResult> {
  return engine.connection.sendRequest<EventWiringResult>(
    'SetEventWiring', designerFilePath, componentId, eventName, handlerName, designerSourceText, codeText, controlAssemblyPath,
  );
}

/** Result of AddControl: the new .Designer.cs text with a control added, and the generated control name. */
export interface ControlAddResult {
  safe: boolean;
  reason: string;
  newText: string | null; // new .Designer.cs text (field decl + InitializeComponent statements), or null
  name: string; // generated control name (e.g. "button1")
}

/**
* Toolbox add-control: add a standard WinForms control (field declaration + InitializeComponent statements)
* to the .Designer.cs as a minimal text edit. controlTypeKey must be one of listControlTypes(); parentId
* "this" = the root form. The host applies the returned text as an unsaved edit, then re-renders.
*/
export function addControl(
  engine: EngineHandle,
  designerFilePath: string,
  parentId: string,
  controlTypeKey: string,
  sourceText?: string,
  locX?: number,
  locY?: number,
  controlAssemblyPath?: string,
  /** For a net48/DevExpress form: the project-control FQNs the net48 engine enumerated. net9 can't load that
   * assembly, so it trusts these (validated engine-side) to emit `new <Fqn>()` as pure text. */
  projectControlFqns?: string[],
): Promise<ControlAddResult> {
  // optional positional tail: each earlier slot must be filled (with null) once a later one is supplied.
  const hasLoc = locX !== undefined && locY !== undefined;
  const hasAsm = controlAssemblyPath !== undefined && controlAssemblyPath !== null;
  const hasFqns = projectControlFqns !== undefined && projectControlFqns !== null;
  const tail: (string | number | null | string[])[] = [];
  if (sourceText !== undefined || hasLoc || hasAsm || hasFqns) tail.push(sourceText ?? null);
  if (hasLoc || hasAsm || hasFqns) tail.push(hasLoc ? (locX as number) : null, hasLoc ? (locY as number) : null);
  if (hasAsm || hasFqns) tail.push((controlAssemblyPath as string) ?? null);
  if (hasFqns) tail.push(projectControlFqns as string[]);
  return engine.connection.sendRequest<ControlAddResult>('AddControl', designerFilePath, parentId, controlTypeKey, ...tail);
}

/** Enumerate the project/vendor (DevExpress/net4x) assembly's own toolbox-eligible controls via the net48 engine
* (the ones the net9 enumerator can't load). The host merges these — category "Project Controls" — with the net9
* framework palette so a net48 form's toolbox offers the vendor controls. [] on any failure. */
export function listCompiledToolboxControls(engine: EngineHandle, assemblyPath: string, probeDirs?: string[]): Promise<ToolboxItemInfo[]> {
  return engine.connection.sendRequest<ToolboxItemInfo[]>('ListCompiledToolboxControls', assemblyPath, probeDirs ?? null);
}

/** Add a new empty tab page to a tab host (pure net9 text edit; pageTypeFqn is the page type, derived by the host
* from an existing page). Host applies the returned text, then the net48 engine live-adds the page to the picture. */
export function addTabPage(
  engine: EngineHandle, designerFilePath: string, hostId: string, pageTypeFqn: string, sourceText?: string,
): Promise<ControlAddResult> {
  const tail = sourceText !== undefined ? [sourceText] : [];
  return engine.connection.sendRequest<ControlAddResult>('AddTabPage', designerFilePath, hostId, pageTypeFqn, ...tail);
}

/** Add a new empty tab page (pageTypeFqn) to the net48 live tab host, registered under newId, + re-render. */
export async function addCompiledTab(
  engine: EngineHandle, designerFilePath: string, assemblyPath: string, hostId: string, pageTypeFqn: string, newId: string,
  rootTypeName?: string, probeDirs?: string[],
): Promise<RenderLayout> {
  const raw = await engine.connection.sendRequest<CompiledRenderRaw>(
    'AddCompiledTab', designerFilePath, assemblyPath, hostId, pageTypeFqn, newId, rootTypeName ?? null, probeDirs ?? null);
  return fromCompiledRaw(raw);
}

/** Remove tab page pageId from the net48 live tab host + re-render (the persisted removal is the host's net9 text edit). */
export async function removeCompiledTab(
  engine: EngineHandle, designerFilePath: string, assemblyPath: string, hostId: string, pageId: string,
  rootTypeName?: string, probeDirs?: string[],
): Promise<RenderLayout> {
  const raw = await engine.connection.sendRequest<CompiledRenderRaw>(
    'RemoveCompiledTab', designerFilePath, assemblyPath, hostId, pageId, rootTypeName ?? null, probeDirs ?? null);
  return fromCompiledRaw(raw);
}

/** Toolbox add-component: add a non-visual component (Timer/ToolTip/dialog…) — a bare `new T()` that lands in the
* component tray (no parent/location). componentTypeKey must be a toolbox component key. Host applies the returned text. */
export function addComponent(
  engine: EngineHandle,
  designerFilePath: string,
  componentTypeKey: string,
  sourceText?: string,
): Promise<ControlAddResult> {
  const tail = sourceText !== undefined ? [sourceText] : [];
  return engine.connection.sendRequest<ControlAddResult>('AddComponent', designerFilePath, componentTypeKey, ...tail);
}

/** The toolbox's available control type keys (e.g. "Button", "Label", …). */
export function listControlTypes(engine: EngineHandle): Promise<string[]> {
  return engine.connection.sendRequest<string[]>('ListControlTypes');
}

/** One auto-populated toolbox control type: its AddControl key (name), full type name, and VS category. */
export interface ToolboxItemInfo {
  name: string;
  fqn: string;
  category: string;
  fromProject: boolean;
  /** Source assembly for a user-chosen project/vendor control. Persisted with Choose Items so Add/Reference can use
   * the same library after a window reload. Framework palette entries normally omit it. */
  assemblyPath?: string;
  /** 16×16 toolbox bitmap (the control's own [ToolboxBitmap]) as a base64 PNG, or null/absent when none was
   * found. Display-only; the palette renders it as a data: image, falling back to a generic glyph when absent. */
  iconPng?: string | null;
  /** True for a non-visual component (Timer/ToolTip/dialog…) — added via addComponent (lands in the tray), not addControl. */
  isComponent?: boolean;
}

/** The auto-populated toolbox palette (auto-population): framework controls, plus the resolved project assembly's own
* controls (category "Project Controls") when designerFilePath is given. The `name` is the
* AddControl controlTypeKey (project controls also resolve by their `fqn`). */
export function listToolboxItems(engine: EngineHandle, designerFilePath?: string, controlAssemblyPath?: string): Promise<ToolboxItemInfo[]> {
  const args: (string | null)[] = [];
  if (designerFilePath !== undefined) {
    args.push(designerFilePath);
    if (controlAssemblyPath !== undefined) args.push(controlAssemblyPath);
  }
  return engine.connection.sendRequest<ToolboxItemInfo[]>('ListToolboxItems', ...args);
}

/** One row of the "Choose Toolbox Items" dialog: a toolbox-eligible Control/Component type with the assembly
* metadata VS shows (Name / Namespace / Assembly Name / Version / Directory). Listing only — never an
* AddControl key. */
export interface ToolboxCandidate {
  name: string;
  namespace: string;
  assemblyName: string;
  version: string;
  directory: string;
  fromProject: boolean;
  /** Exact assembly reflected for this row (empty for dynamic assemblies). */
  assemblyPath?: string;
}

/** The "Choose Toolbox Items" rows: framework Controls+Components + the project assembly's types + any browsed
* .dlls the user added. Pure reflection in the engine (collectible ALC for project/browsed assemblies). */
export function listToolboxCandidates(
  engine: EngineHandle, designerFilePath?: string, controlAssemblyPath?: string, browseAssemblyPaths?: string[],
): Promise<ToolboxCandidate[]> {
  return engine.connection.sendRequest<ToolboxCandidate[]>('ListToolboxCandidates',
    designerFilePath ?? null, controlAssemblyPath ?? null, browseAssemblyPaths ?? null);
}

/** The outcome of scanning ONE browsed .dll (Choose-Items "Browse…"): the found rows plus a reason when nothing
* usable was found (a .NET Framework / non-.NET assembly that won't load, or one with no Control/Component types). */
export interface ToolboxScanResult {
  assemblyName: string;
  items: ToolboxCandidate[];
  error: string | null;
}

export function scanToolboxAssembly(
  engine: EngineHandle, assemblyPath: string, probeDirectories?: string[],
): Promise<ToolboxScanResult> {
  return engine.connection.sendRequest<ToolboxScanResult>(
    'ScanToolboxAssembly', assemblyPath, probeDirectories ?? null);
}

/** Result of RemoveControl: the new .Designer.cs text with the control removed, or null when rejected. */
export interface ControlRemoveResult {
  safe: boolean;
  reason: string;
  newText: string | null;
}

/**
* Remove a leaf control from the .Designer.cs (its field declaration + InitializeComponent statements).
* Refuses a container with children or a control referenced elsewhere. The host applies the returned text
* as an unsaved edit, then re-renders.
*/
export function removeControl(
  engine: EngineHandle,
  designerFilePath: string,
  controlId: string,
  sourceText?: string,
): Promise<ControlRemoveResult> {
  const tail = sourceText !== undefined ? [sourceText] : [];
  return engine.connection.sendRequest<ControlRemoveResult>('RemoveControl', designerFilePath, controlId, ...tail);
}

/**
* Remove a whole tab page (the page + its entire subtree) from a tab host (pure net9 text edit): deletes the
* subtree's fields/statements and detaches the page from the host's tab collection (whole Controls.Add/TabPages.Add,
* or a trimmed TabPages.AddRange element). Refuses when the subtree is referenced from outside it. The host applies
* the returned text as an unsaved edit, then the net48 engine live-removes the page from the picture.
*/
export function removeTabPage(
  engine: EngineHandle,
  designerFilePath: string,
  hostId: string,
  pageId: string,
  sourceText?: string,
): Promise<ControlRemoveResult> {
  const tail = sourceText !== undefined ? [sourceText] : [];
  return engine.connection.sendRequest<ControlRemoveResult>('RemoveTabPage', designerFilePath, hostId, pageId, ...tail);
}

/** Result of CopyControl: an OPAQUE clipboard blob the host stores and hands back to pasteControl. */
export interface ControlCopyResult {
  safe: boolean;
  reason: string;
  clip: string | null; // engine-internal JSON — never parsed by the host
}

/**
* Copy a leaf control to a clipboard blob (its field type + InitializeComponent statements). Refuses the
* root, a container with children, a shared field declaration, or a control referenced elsewhere. Pure text.
*/
export function copyControl(
  engine: EngineHandle,
  designerFilePath: string,
  controlId: string,
  sourceText?: string,
): Promise<ControlCopyResult> {
  const tail = sourceText !== undefined ? [sourceText] : [];
  return engine.connection.sendRequest<ControlCopyResult>('CopyControl', designerFilePath, controlId, ...tail);
}

/** Result of PasteControl: the new .Designer.cs text with the pasted clone, and its generated name.
* `typeName` / `x` / `y` let the net48 compiled-preview host live-instantiate the clone (the text splice alone
* isn't in the compiled instance). `x`/`y` are the nudged Location, or -1 when the clip has no integer Location. */
export interface ControlPasteResult {
  safe: boolean;
  reason: string;
  newText: string | null;
  name: string;
  typeName: string;
  x: number;
  y: number;
}

/**
* Paste a clipboard blob (from copyControl) into a container ("this" = root) as a fresh, uniquely-named clone
* (renamed receiver, Name kept in sync, Location nudged). The host applies the returned text as an unsaved edit.
*/
export function pasteControl(
  engine: EngineHandle,
  designerFilePath: string,
  clip: string,
  parentId: string,
  sourceText?: string,
): Promise<ControlPasteResult> {
  const tail = sourceText !== undefined ? [sourceText] : [];
  return engine.connection.sendRequest<ControlPasteResult>('PasteControl', designerFilePath, clip, parentId, ...tail);
}

/** Result of MoveZOrder: the reordered text (equals the input when already at the requested end), or null. */
export interface ControlReorderResult {
  safe: boolean;
  reason: string;
  newText: string | null;
}

/**
* Bring a control to front (toFront true) or send it to back by relocating its Controls.Add among its
* siblings. newText equals the input when it's already at the requested end (a no-op the host can ignore).
*/
export function moveZOrder(
  engine: EngineHandle,
  designerFilePath: string,
  controlId: string,
  toFront: boolean,
  sourceText?: string,
): Promise<ControlReorderResult> {
  const tail = sourceText !== undefined ? [sourceText] : [];
  return engine.connection.sendRequest<ControlReorderResult>('MoveZOrder', designerFilePath, controlId, toFront, ...tail);
}

/** Reparent: move a leaf control into a different container (newParentId "this" = root). Minimal text edit
* (rewrites only the child's Controls.Add receiver). The host applies newText like a removeControl/moveZOrder edit. */
export function reparentControl(
  engine: EngineHandle,
  designerFilePath: string,
  childId: string,
  newParentId: string,
  sourceText?: string,
): Promise<ControlReorderResult> {
  const tail = sourceText !== undefined ? [sourceText] : [];
  return engine.connection.sendRequest<ControlReorderResult>('Reparent', designerFilePath, childId, newParentId, ...tail);
}

/** Compute a targeted property edit (no write) — returns the would-be-saved file text. */
export function setProperty(
  engine: EngineHandle,
  designerFilePath: string,
  componentId: string,
  propertyName: string,
  newValueExpr: string,
  sourceText?: string,
): Promise<EditPreview> {
  const tail = sourceText !== undefined ? [sourceText] : [];
  return engine.connection.sendRequest<EditPreview>('SetProperty', designerFilePath, componentId, propertyName, newValueExpr, ...tail);
}

/**
* Edit the design-time "Modifiers" pseudo-property (no write) — a byte-local splice of the component's field-
* declaration access keyword, safe on EVERY form (never touches InitializeComponent / the whole-file serializer).
* `newModifier` is a VS display name ("Public"/"Private"/…). Returns the would-be-saved file text.
*/
export function setModifier(
  engine: EngineHandle,
  designerFilePath: string,
  componentId: string,
  newModifier: string,
  sourceText?: string,
): Promise<EditPreview> {
  const tail = sourceText !== undefined ? [sourceText] : [];
  return engine.connection.sendRequest<EditPreview>('SetModifier', designerFilePath, componentId, newModifier, ...tail);
}

/** Safe-save-gated grid-cell edit: move a TableLayoutPanel child to a new column/row (rewrites the cell args of its 3-arg
* Controls.Add). Pass null for a coordinate to leave it unchanged. The host applies the returned text like setProperty. */
export function setTableCell(
  engine: EngineHandle,
  designerFilePath: string,
  childId: string,
  column: number | null,
  row: number | null,
  sourceText?: string,
): Promise<EditPreview> {
  const tail = sourceText !== undefined ? [sourceText] : [];
  return engine.connection.sendRequest<EditPreview>('SetTableCell', designerFilePath, childId, column, row, ...tail);
}

/** Result of ListCollectionItems: the string-item collection's current items and whether it's editable. `ok`
* is false for a bound/complex collection whose elements aren't string literals — the webview keeps it read-only
* so editing can't silently drop the non-literal entries. */
export interface CollectionItems {
  ok: boolean;
  items: string[];
  reason: string;
}

/** Read a string-item collection's current items (ComboBox/ListBox/CheckedListBox.Items) for the "…" editor. */
export function listCollectionItems(
  engine: EngineHandle,
  designerFilePath: string,
  ownerId: string,
  propertyName: string,
  sourceText?: string,
): Promise<CollectionItems> {
  const tail = sourceText !== undefined ? [sourceText] : [];
  return engine.connection.sendRequest<CollectionItems>('ListCollectionItems', designerFilePath, ownerId, propertyName, ...tail);
}

/** Set a string-item collection's items (VS "String Collection Editor"): rewrite the owner's Add/AddRange calls
* to exactly `items`. Items are emitted as escaped string literals — nothing is interpolated. The host applies
* the returned text like setProperty. */
export function setCollectionItems(
  engine: EngineHandle,
  designerFilePath: string,
  ownerId: string,
  propertyName: string,
  items: string[],
  sourceText?: string,
): Promise<EditPreview> {
  const tail = sourceText !== undefined ? [sourceText] : [];
  return engine.connection.sendRequest<EditPreview>('SetCollectionItems', designerFilePath, ownerId, propertyName, items, ...tail);
}

/** Read a generic string[] property's current items (TextBox/RichTextBox.Lines) for the "…" editor. `ok` is false
* for a non-literal (bound/computed) value — the webview keeps it read-only. Reuses {@link CollectionItems}. */
export function listStringArray(
  engine: EngineHandle,
  designerFilePath: string,
  ownerId: string,
  propertyName: string,
  sourceText?: string,
): Promise<CollectionItems> {
  const tail = sourceText !== undefined ? [sourceText] : [];
  return engine.connection.sendRequest<CollectionItems>('ListStringArray', designerFilePath, ownerId, propertyName, ...tail);
}

/** Set a generic string[] property (TextBox/RichTextBox.Lines): rewrite it to the single assignment
* `owner.prop = new string[] { … }`. Items are emitted as escaped string literals — nothing is interpolated. */
export function setStringArray(
  engine: EngineHandle,
  designerFilePath: string,
  ownerId: string,
  propertyName: string,
  items: string[],
  sourceText?: string,
): Promise<EditPreview> {
  const tail = sourceText !== undefined ? [sourceText] : [];
  return engine.connection.sendRequest<EditPreview>('SetStringArray', designerFilePath, ownerId, propertyName, items, ...tail);
}

/** One ColumnHeader of a ListView.Columns collection (typed collection editor). `id` is the field id; an empty
* id marks a NEW column (the engine generates one). Only these managed properties round-trip — a column with any
* other property makes the whole collection read-only. */
export interface ColumnItem {
  id: string;
  text: string;
  width: number;
  textAlign: string; // "Left" | "Center" | "Right"
}

/** Result of ListColumns: the ListView's ordered columns and whether the collection is editable. `ok` is false
* when a column isn't a plain named ColumnHeader field with only Text/Width/TextAlign — the webview then keeps it
* read-only so an unmanaged value can't be dropped. */
export interface ColumnItems {
  ok: boolean;
  columns: ColumnItem[];
  reason: string;
}

/** Read a ListView's columns (typed collection editor) for the "…" editor. */
export function listColumns(
  engine: EngineHandle,
  designerFilePath: string,
  ownerId: string,
  sourceText?: string,
): Promise<ColumnItems> {
  const tail = sourceText !== undefined ? [sourceText] : [];
  return engine.connection.sendRequest<ColumnItems>('ListColumns', designerFilePath, ownerId, ...tail);
}

/** Set a ListView's columns (VS "Collection Editor"): reconcile field declarations, per-column construction /
* property statements and Columns.AddRange to exactly `columns`. Values are emitted as literals/enum members —
* nothing is interpolated. The host applies the returned text like setProperty. */
export function setColumns(
  engine: EngineHandle,
  designerFilePath: string,
  ownerId: string,
  columns: ColumnItem[],
  sourceText?: string,
): Promise<EditPreview> {
  const tail = sourceText !== undefined ? [sourceText] : [];
  return engine.connection.sendRequest<EditPreview>('SetColumns', designerFilePath, ownerId, columns, ...tail);
}

/** One TreeView node (hierarchical collection editor), recursively. `id` is the generated local var name; an empty
* id marks a NEW node (the engine names it `treeNodeN`). Only Text (the ctor label) + Name (the node key) round-trip
* — a node with any other property or an unsupported constructor makes the whole collection read-only. */
export interface TreeNodeItem {
  id: string;
  text: string;
  name: string;
  // TreeNode image props. Optional to stay source-compatible with existing image-less traffic; 'no image' is
  // "" key / -1 index. They ride verbatim through listTreeNodes/setTreeNodes/liveTreeNodes48 — threaded so an
  // edit through the popup preserves images even where the UI doesn't yet expose a picker.
  imageKey?: string;
  imageIndex?: number;
  selectedImageKey?: string;
  selectedImageIndex?: number;
  // Other scalar node props (optional, source-compatible with existing traffic): the hover tooltip + the check-box
  // state. Ride verbatim through listTreeNodes/setTreeNodes/liveTreeNodes48.
  toolTipText?: string;
  checked?: boolean;
  // Visual-style node props as property-grid invariant strings ("Red" / "64, 128, 255" / "Segoe UI, 9pt, style=Bold");
  // "" = unset. Ride verbatim; the engine turns them into a Color/Font initializer (net9) or a live value (net48).
  foreColor?: string;
  backColor?: string;
  nodeFont?: string;
  children: TreeNodeItem[];
}

/** Result of ListNodes: the TreeView's node forest (roots in Nodes.AddRange order, children in ctor order) and
* whether it is editable. `ok` is false for an unmanaged property / ctor overload / shared or unattached node. */
export interface TreeNodeItems {
  ok: boolean;
  nodes: TreeNodeItem[];
  reason: string;
}

/** Read a TreeView's node forest (hierarchical collection editor) for the "…" editor. */
export function listTreeNodes(
  engine: EngineHandle,
  designerFilePath: string,
  ownerId: string,
  sourceText?: string,
): Promise<TreeNodeItems> {
  const tail = sourceText !== undefined ? [sourceText] : [];
  return engine.connection.sendRequest<TreeNodeItems>('ListNodes', designerFilePath, ownerId, ...tail);
}

/** Set a TreeView's nodes (VS "TreeNode Editor"): drop and regenerate the TreeNode local declarations +
* Nodes.AddRange in post-order to exactly `nodes`. Text/Name are emitted as literals — nothing is interpolated. */
export function setTreeNodes(
  engine: EngineHandle,
  designerFilePath: string,
  ownerId: string,
  nodes: TreeNodeItem[],
  sourceText?: string,
): Promise<EditPreview> {
  const tail = sourceText !== undefined ? [sourceText] : [];
  return engine.connection.sendRequest<EditPreview>('SetNodes', designerFilePath, ownerId, nodes, ...tail);
}

/** One ToolStrip/MenuStrip item (structural view for the "…" editor), recursively. `id` is the item's field name;
* `itemType` is its short type (ToolStripMenuItem/…); `text`/`name` are display-only in the reorder view; `children`
* are the nested DropDownItems. The engine models ONLY this structure — every other item property is preserved. */
export interface ToolStripItemModel {
  id: string;
  text: string;
  name: string;
  itemType: string;
  children: ToolStripItemModel[];
}

/** Result of ListToolStripItems: the strip/menu item tree and whether it is editable. `ok` is false for an inline or
* shared item, an unexpected collection shape, or a non-field element (→ the webview keeps it read-only). */
export interface ToolStripItems {
  ok: boolean;
  items: ToolStripItemModel[];
  reason: string;
}

/** Read a ToolStrip/MenuStrip item tree (Items / DropDownItems) for the "…" editor. */
export function listToolStripItems(
  engine: EngineHandle,
  designerFilePath: string,
  ownerId: string,
  sourceText?: string,
): Promise<ToolStripItems> {
  const tail = sourceText !== undefined ? [sourceText] : [];
  return engine.connection.sendRequest<ToolStripItems>('ListToolStripItems', designerFilePath, ownerId, ...tail);
}

/** Reorder a ToolStrip/MenuStrip item tree: rewrite each Items/DropDownItems AddRange to the given order
* (same items — no add/remove/rename), leaving every other statement byte-identical. */
export function setToolStripItems(
  engine: EngineHandle,
  designerFilePath: string,
  ownerId: string,
  items: ToolStripItemModel[],
  sourceText?: string,
): Promise<EditPreview> {
  const tail = sourceText !== undefined ? [sourceText] : [];
  return engine.connection.sendRequest<EditPreview>('SetToolStripItems', designerFilePath, ownerId, items, ...tail);
}

/** One DataGridView column (typed grid-column editor). `id` is the field id; an empty id marks a NEW column (the
* engine generates one + a DataGridViewTextBoxColumn). Only these managed properties round-trip — a bound/cast/
* unmanaged column makes the whole collection read-only. */
export interface GridColumnItem {
  id: string;
  headerText: string;
  width: number;
  readOnly: boolean;
  visible: boolean;
}

/** Result of ListGridColumns: the DataGridView's ordered columns and whether the collection is editable. */
export interface GridColumnItems {
  ok: boolean;
  columns: GridColumnItem[];
  reason: string;
}

/** Read a DataGridView's columns (typed grid-column editor) for the "…" editor. */
export function listGridColumns(
  engine: EngineHandle,
  designerFilePath: string,
  ownerId: string,
  sourceText?: string,
): Promise<GridColumnItems> {
  const tail = sourceText !== undefined ? [sourceText] : [];
  return engine.connection.sendRequest<GridColumnItems>('ListGridColumns', designerFilePath, ownerId, ...tail);
}

/** Set a DataGridView's columns (VS "Collection Editor"): reconcile field declarations, per-column construction /
* property statements and Columns.AddRange to exactly `columns`. Values are emitted as literals/keywords — nothing
* is interpolated. The host applies the returned text like setProperty. */
export function setGridColumns(
  engine: EngineHandle,
  designerFilePath: string,
  ownerId: string,
  columns: GridColumnItem[],
  sourceText?: string,
): Promise<EditPreview> {
  const tail = sourceText !== undefined ? [sourceText] : [];
  return engine.connection.sendRequest<EditPreview>('SetGridColumns', designerFilePath, ownerId, columns, ...tail);
}

/** Reset a property to its default by deleting its assignment(s) (VS "Reset"; the engine side of Dock↔Anchor
* mutual exclusivity). Nothing is interpolated. The host applies the returned text like setProperty; `text` is
* null on a no-op (already default, mode "Noop") — that is still `safe` — or on a reject (`safe` false). */
export function resetProperty(
  engine: EngineHandle,
  designerFilePath: string,
  componentId: string,
  propertyName: string,
  sourceText?: string,
): Promise<EditPreview> {
  const tail = sourceText !== undefined ? [sourceText] : [];
  return engine.connection.sendRequest<EditPreview>('ResetProperty', designerFilePath, componentId, propertyName, ...tail);
}

/** Result of SetImageResource: the new .Designer.cs text (resources.GetObject assignment) AND the new sibling
* .resx text (image embedded). Both null when rejected. The host writes `resxText` to the .resx and applies
* `designerText` as an undoable edit. */
export interface ImageEditPreview {
  safe: boolean;
  mode: string; // Replace | Insert | Failed
  designerText: string | null;
  resxText: string | null;
  resxKey: string;
  reason: string;
}

/**
* Import an image into a resx-backed image/icon property ("Import…"): embed the image bytes into the form's
* sibling .resx and write the `resources.GetObject("key")` assignment into InitializeComponent. `imageBase64`
* is the raw file bytes base64-encoded; `propertyTypeName` is the declared property type (System.Drawing.Image
* /Bitmap/Icon — the engine allowlists it). `resxText` is the current .resx content (null ⇒ the engine creates
* it). `sourceText` is the unsaved designer buffer. The engine never writes files — it returns both new texts.
*/
export function setImageResource(
  engine: EngineHandle,
  designerFilePath: string,
  componentId: string,
  propertyName: string,
  propertyTypeName: string,
  imageBase64: string,
  resxText: string | null,
  sourceText: string | null,
): Promise<ImageEditPreview> {
  return engine.connection.sendRequest<ImageEditPreview>(
    'SetImageResource', designerFilePath, componentId, propertyName, propertyTypeName, imageBase64, resxText, sourceText,
  );
}

/** 0.11.0 ImageList editor — embed a serialized ImageStream blob (from {@link serializeImageList}) into the sibling
* .resx and rewrite the ImageList's init (ImageStream assignment + SetKeyName, removing any in-code Images.Add).
* Returns both new texts (safe=false with a reason on rejection); the host persists them atomically + undoably. */
export function setImageList(
  engine: EngineHandle,
  designerFilePath: string,
  componentId: string,
  imageStreamBase64: string,
  keys: string[],
  resxText: string | null,
  sourceText: string | null,
  oldKeys?: string[],
  oldIndexForNew?: number[],
): Promise<ImageEditPreview> {
  return engine.connection.sendRequest<ImageEditPreview>(
    'SetImageList', designerFilePath, componentId, imageStreamBase64, keys, resxText, sourceText,
    oldKeys ?? null, oldIndexForNew ?? null,
  );
}

/** One TableLayoutPanel column/row sizing style (read side for the style editor). */
export interface TableStyleInfo {
  axis: string; // "Column" | "Row"
  index: number; // ordinal within its axis (= column/row index)
  sizeType: string; // "Absolute" | "Percent" | "AutoSize"
  value: number; // size (percent or pixels); 0 for AutoSize
}
export interface TableStylesResult {
  found: boolean;
  styles: TableStyleInfo[];
}

/** Read a TableLayoutPanel's ordered column + row sizing styles. Pure text parse (no graph load). */
export function readTableStyles(
  engine: EngineHandle,
  designerFilePath: string,
  panelId: string,
  sourceText?: string,
): Promise<TableStylesResult> {
  const tail = sourceText !== undefined ? [sourceText] : [];
  return engine.connection.sendRequest<TableStylesResult>('ReadTableStyles', designerFilePath, panelId, ...tail);
}

/** Safe-save-gated TableLayoutPanel size-style edit: set the Nth Column/Row style's SizeType and/or value. Pass null for
* sizeType or value to keep the existing one (they occupy fixed positional slots before the optional sourceText).
* The host applies the returned text like setProperty. */
export function setTableStyle(
  engine: EngineHandle,
  designerFilePath: string,
  panelId: string,
  axis: 'Column' | 'Row',
  index: number,
  sizeType: string | null,
  value: number | null,
  sourceText?: string,
): Promise<EditPreview> {
  const tail = sourceText !== undefined ? [sourceText] : [];
  return engine.connection.sendRequest<EditPreview>('SetTableStyle', designerFilePath, panelId, axis, index, sizeType, value, ...tail);
}
