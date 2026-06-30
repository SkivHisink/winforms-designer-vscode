import { spawn, ChildProcess } from 'child_process';
import * as net from 'net';
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
}

export async function startEngine(engineDllPath: string, opts: StartOptions = {}): Promise<EngineHandle> {
  const dotnet = opts.dotnet ?? 'dotnet';
  const log = opts.onLog ?? ((l: string) => console.error(l));
  const pipeName = `winforms-designer-${process.pid}-${Date.now()}`;

  const proc = spawn(dotnet, [engineDllPath, '--pipe', pipeName], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (d: Buffer) => log('[engine] ' + d.toString().trimEnd()));
  proc.stderr.on('data', (d: Buffer) => log('[engine] ' + d.toString().trimEnd()));
  proc.on('exit', (code) => log('[engine] exited ' + code));
  // MUST handle 'error' (e.g. ENOENT when `dotnet` isn't on PATH): an unhandled ChildProcess 'error'
  // event throws an uncaught exception that can take down the whole extension host (exit code 1). With a
  // handler it's logged instead, and connectWithRetry below then fails cleanly → a surfaced render error.
  proc.on('error', (err: Error) => log('[engine] spawn error: ' + err.message));

  const socket = await connectWithRetry('\\\\.\\pipe\\' + pipeName, 100, 100);
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
  png: Buffer;        // the control's PNG (empty when not found)
  x: number;          // left, relative to the root's client area
  y: number;          // top, relative to the root's client area
  width: number;
  height: number;
  found: boolean;     // false when the id matches no control
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
  id: string;          // edit id for SetProperty/RenderControl ("this" = root)
  name: string;        // display name
  type: string;
  parentId: string | null;
  isRoot: boolean;
  x: number;           // full-frame (window) pixel space — same transform as RenderControl
  y: number;
  width: number;
  height: number;
  depth: number;       // nesting from root (root = 0); higher wins a hit-test
  tabIndex: number;    // control's TabIndex for the tab-order overlay (root = -1)
}

/** A non-visual component for the tray (§7.3): Timer/ToolTip/ErrorProvider/ImageList/BindingSource/… */
export interface TrayComponent {
  id: string;   // edit id (Site.Name) for DescribeComponent/SetProperty
  name: string;
  type: string;
}

export interface LayoutResult {
  rootType: string;
  width: number;       // full frame size
  height: number;
  clientWidth: number;  // root client-area size (form serializes ClientSize, not window Size)
  clientHeight: number;
  controls: LayoutControl[]; // innermost-first (deepest, then smallest area)
  tray: TrayComponent[];     // non-visual components (§7.3)
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
  png: Buffer;               // full-frame PNG (same bytes as renderDesigner)
  width: number;             // full frame size
  height: number;
  clientWidth: number;       // root client-area size (form serializes ClientSize, not window Size)
  clientHeight: number;
  rootType: string;
  controls: LayoutControl[]; // innermost-first (deepest, then smallest area) — same as describeLayout
  tray: TrayComponent[];     // non-visual components (§7.3)
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
): Promise<RenderLayout> {
  const raw = await engine.connection.sendRequest<{
    png: string; width: number; height: number; clientWidth: number; clientHeight: number;
    rootType: string; controls: LayoutControl[]; tray: TrayComponent[];
  }>('RenderWithLayout', designerFilePath, ...asmTextTail(controlAssemblyPath, sourceText));
  return {
    png: Buffer.from(raw.png ?? '', 'base64'),
    width: raw.width,
    height: raw.height,
    clientWidth: raw.clientWidth,
    clientHeight: raw.clientHeight,
    rootType: raw.rootType,
    controls: raw.controls ?? [],
    tray: raw.tray ?? [],
  };
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
  /** TypeConverter standard values as invariant strings (§7.1 dropdowns), or null/absent when none. */
  standardValues?: string[] | null;
  /** True → closed set (render a <select>); false → editable combobox (datalist). */
  standardValuesExclusive?: boolean;
}

export interface EventDesc {
  name: string;
  type: string;            // delegate type (e.g. System.EventHandler)
  category: string;
  handler: string | null;  // wired handler method name from the source, or null if unhandled
}

export interface ComponentDesc {
  id: string;       // edit id for SetProperty ("this" = root)
  name: string;     // display name
  type: string;
  parent: string | null;
  isRoot: boolean;
  properties: PropertyDesc[];
  events: EventDesc[];
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
  mode: string;       // Replace | Insert | Failed
  text: string | null;
  reason: string;
}

export interface SerializePreview {
  safe: boolean;
  code: string | null;
  unrepresentable: string[];
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
 * Build an idiomatic C# initializer expression for a complex property value (Point/Size/Color/…)
 * from its invariant-string form. Returns null when the value isn't convertible (the grid then
 * leaves the property read-only / rejects the edit).
 */
export function convertValue(engine: EngineHandle, typeName: string, invariantValue: string): Promise<string | null> {
  return engine.connection.sendRequest<string | null>('ConvertValue', typeName, invariantValue);
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
  alreadyWired: boolean;      // event already had a handler → designer untouched, just navigate
  designerText: string | null; // new .Designer.cs text (wiring added), or null when unchanged
  codeText: string | null;     // new .cs text (stub added), or null when unchanged / no code file
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
  newText: string | null;   // new .Designer.cs text (field decl + InitializeComponent statements), or null
  name: string;             // generated control name (e.g. "button1")
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
): Promise<ControlAddResult> {
  // optional positional tail: each earlier slot must be filled (with null) once a later one is supplied.
  const hasLoc = locX !== undefined && locY !== undefined;
  const hasAsm = controlAssemblyPath !== undefined && controlAssemblyPath !== null;
  const tail: (string | number | null)[] = [];
  if (sourceText !== undefined || hasLoc || hasAsm) tail.push(sourceText ?? null);
  if (hasLoc || hasAsm) tail.push(hasLoc ? (locX as number) : null, hasLoc ? (locY as number) : null);
  if (hasAsm) tail.push(controlAssemblyPath as string);
  return engine.connection.sendRequest<ControlAddResult>('AddControl', designerFilePath, parentId, controlTypeKey, ...tail);
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
}

/** The auto-populated toolbox palette (§7.2): framework controls, plus the resolved project assembly's own
 * controls (§7.2 Increment 2, category "Project Controls") when designerFilePath is given. The `name` is the
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

export function scanToolboxAssembly(engine: EngineHandle, assemblyPath: string): Promise<ToolboxScanResult> {
  return engine.connection.sendRequest<ToolboxScanResult>('ScanToolboxAssembly', assemblyPath);
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

/** Result of CopyControl: an OPAQUE clipboard blob the host stores and hands back to pasteControl. */
export interface ControlCopyResult {
  safe: boolean;
  reason: string;
  clip: string | null;   // engine-internal JSON — never parsed by the host
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

/** Result of PasteControl: the new .Designer.cs text with the pasted clone, and its generated name. */
export interface ControlPasteResult {
  safe: boolean;
  reason: string;
  newText: string | null;
  name: string;
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
