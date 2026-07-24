// Headless "live-webview" harness (T2.3). Loads the REAL, unmodified media/designer.js and media/panel.js into a
// jsdom window with a faithful DOM scaffold + the two globals the host injects (acquireVsCodeApi + the i18n catalog),
// then lets a test drive synthetic DOM events (keydown / click / mouse / message) and assert on (a) the messages the
// webview posts back to the host and (b) the resulting DOM. This exercises the webview interaction layer that until
// now was only covered by manual F5 — WITHOUT the flakiness of a real VS Code Extension Host. jsdom is a devDependency
// only (never shipped in the VSIX; `vsce package --no-dependencies`).
//
// The scaffolds below mirror the element ids the host emits in designerEditor.ts (designerHtml / panelHtml). They are
// intentionally content-free skeletons: the media scripts capture every id into a var at load and are null-tolerant
// for all but a small hard-required set (designer: #surface has .getContext called unguarded at load; #sel gets the
// resize handles appended; panel: the three bottom tabs + panes + the tbPrompt OK/Cancel buttons are dereferenced
// unguarded). If the host adds a new load-time id, a script load here throws loudly — update the scaffold to match.

import { JSDOM } from 'jsdom';
import * as fs from 'fs';
import * as path from 'path';

const MEDIA_DIR = path.resolve(__dirname, '..', 'media');

/** A no-op 2D canvas context — jsdom returns null from getContext without the native `canvas` package, but
 *  designer.js dereferences ctx (drawImage/clearRect/ruler drawing). Every method is a no-op; measureText
 *  returns a zero-width metric so ruler code doesn't NaN. */
function noopCtx(): unknown {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'measureText') return () => ({ width: 0 });
        return () => undefined;
      },
      set() {
        return true;
      },
    },
  );
}

export interface Harness {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  window: any;
  document: any;
  /** Messages the webview posted to the host (vscode.postMessage), in order. Cleared with resetPosted(). */
  posted: any[];
  /** The webview's persisted state store (vscode.getState/setState). */
  state: Record<string, any>;
  /** Deliver a host -> webview message (window 'message' event with {data}). */
  send(msg: any): void;
  /** Dispatch a KeyboardEvent (default target: document). Returns the event (inspect defaultPrevented). */
  key(type: string, init?: any, target?: any): any;
  /** Dispatch a MouseEvent supporting offsetX/offsetY (jsdom leaves them 0 otherwise). Default target: document. */
  mouse(type: string, init?: any, target?: any): any;
  /** Fire a plain click on an element. */
  click(el: any): void;
  /** getElementById shortcut. */
  el(id: string): any;
  /** Give the canvas a non-zero client rect so tests can exercise the client→surface coordinate transform
   *  (jsdom's getBoundingClientRect is all-zeros by default, which masks a dropped `- rect.left` correction). */
  setCanvasRect(left: number, top: number): void;
  /** Empty the posted-message log (handy between phases of one test). */
  resetPosted(): void;
  /** Tear down the jsdom window (cancels pending timers). Idempotent. */
  destroy(): void;
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

// Every live harness, so a test that throws before its own destroy() can't leak a jsdom window (and its pending
// 250ms nudge timer) into the rest of the suite — the runner drains this in a finally after each test.
const OPEN_HARNESSES = new Set<Harness>();
/** Close every still-open harness (cancels their timers via jsdom window.close → stopAllTimers). */
export function drainHarnesses(): void {
  for (const h of Array.from(OPEN_HARNESSES)) h.destroy();
}

// Designer canvas webview scaffold — element ids mirror designerEditor.ts designerHtml (:2850-2887).
export const DESIGNER_SCAFFOLD = `
  <div id="formNotice" style="display:none"><span id="formNoticeIcon">L</span><span id="formNoticeMsg"></span></div>
  <div id="diag" style="display:none">
    <div id="diagHead">
      <span id="diagIcon">!</span><span id="diagMsg"></span><span id="diagToggle"></span>
      <span id="diagSpacer"></span><button id="diagDismiss">x</button>
    </div>
    <ul id="diagList" style="display:none"></ul>
    <div id="diagActions">
      <button id="diagRetry">Retry</button><button id="diagRebuild">Rebuild</button>
      <button id="diagChooseAssembly">Choose Assembly</button><button id="diagCopy">Copy</button>
    </div>
  </div>
  <div id="stage">
    <div id="overlay">Loading</div>
    <div id="surfaceWrap"><canvas id="surface" width="1" height="1"></canvas><div id="sel"></div></div>
  </div>
  <div id="tray" style="display:none"></div>
  <div id="status"></div>
  <div id="toolbar">
    <span id="selName">-</span>
    <span id="zoom"><button id="zoomOut">-</button><button id="zoomLabel">100%</button><button id="zoomIn">+</button><button id="zoomFit">Fit</button></span>
    <span id="align" style="display:none">
      <button id="alignLeft"></button><button id="alignRight"></button><button id="alignTop"></button><button id="alignBottom"></button>
      <button id="alignCenterH"></button><button id="alignCenterV"></button>
      <button id="distH"></button><button id="distV"></button>
      <button id="sameW"></button><button id="sameH"></button><button id="sameWH"></button>
    </span>
    <span id="centerForm" style="display:none"><button id="centerFormH"></button><button id="centerFormV"></button></span>
    <button id="tabOrder">Tab Order</button>
    <button id="rulerToggle">Ruler</button>
    <span id="dirty"></span>
  </div>
  <div id="ctxMenu" class="ctxmenu"></div>
`;

// Properties/Toolbox/Outline panel webview scaffold — mirrors designerEditor.ts panelHtml (:3157-3202).
export const PANEL_SCAFFOLD = `
  <div id="content">
    <div id="propsPane" class="pane">
      <div id="propsEmpty" class="paneEmpty">No selection</div>
      <div id="propsBody" style="display:none">
        <div id="sideHeader">
          <select id="tree"></select>
          <div id="tabs">
            <button id="sortCat" class="active"></button><button id="sortAlpha"></button>
            <button id="tabProps" class="active"></button><button id="tabEvents"></button>
          </div>
          <input id="search" type="text">
        </div>
        <div id="grid"><div id="props"></div><div id="events" style="display:none"></div></div>
        <div id="propDesc"></div>
      </div>
    </div>
    <div id="outlinePane" class="pane" style="display:none"><div id="outlineTree"></div></div>
    <div id="toolboxPane" class="pane" style="display:none">
      <div id="tbEmpty" class="paneEmpty">Empty</div>
      <div id="tbBody" style="display:none"><div id="tbHeader"><input id="tbSearch" type="text"></div><div id="tbList"></div></div>
    </div>
  </div>
  <div id="bottomTabs">
    <button id="mainTabProps" class="active">Properties</button>
    <button id="mainTabOutline">Outline</button>
    <button id="mainTabToolbox">Toolbox</button>
  </div>
  <div id="tbMenu" class="ctxmenu" style="display:none"></div>
  <div id="tbPrompt" class="modal" style="display:none">
    <div class="modalBox">
      <div id="tbPromptTitle">Add Tab</div>
      <input id="tbPromptInput" type="text">
      <button id="tbPromptCancel">Cancel</button><button id="tbPromptOk">OK</button>
    </div>
  </div>
`;

function load(scriptFile: string, bodyHtml: string, needCanvas: boolean): Harness {
  const dom = new JSDOM(`<!DOCTYPE html><html><head></head><body>${bodyHtml}</body></html>`, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
  });
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const win: any = dom.window;
  const posted: any[] = [];
  let closed = false;
  const harness: Harness = {
    window: win,
    document: win.document,
    posted,
    state: {},
    send(msg: any) {
      win.dispatchEvent(new win.MessageEvent('message', { data: msg }));
    },
    key(type: string, init: any = {}, target?: any) {
      const ev = new win.KeyboardEvent(type, { bubbles: true, cancelable: true, ...init });
      (target || win.document).dispatchEvent(ev);
      return ev;
    },
    mouse(type: string, init: any = {}, target?: any) {
      const ev = new win.MouseEvent(type, { bubbles: true, cancelable: true, ...init });
      if (init.offsetX !== undefined) Object.defineProperty(ev, 'offsetX', { value: init.offsetX, configurable: true });
      if (init.offsetY !== undefined) Object.defineProperty(ev, 'offsetY', { value: init.offsetY, configurable: true });
      (target || win.document).dispatchEvent(ev);
      return ev;
    },
    click(elm: any) {
      elm.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
    },
    el(id: string) {
      return win.document.getElementById(id);
    },
    setCanvasRect(left: number, top: number) {
      win.HTMLCanvasElement.prototype.getBoundingClientRect = () => ({
        left,
        top,
        right: left,
        bottom: top,
        width: 0,
        height: 0,
        x: left,
        y: top,
        toJSON() {},
      });
    },
    resetPosted() {
      posted.length = 0;
    },
    destroy() {
      if (closed) return;
      closed = true;
      OPEN_HARNESSES.delete(harness);
      win.close();
    },
  };
  // Globals the host injects BEFORE the media <script> (i18n catalog + the VS Code API bridge). An empty catalog
  // makes T() echo the key, which is deterministic and locale-independent — ideal for assertions.
  win.__WFD_L10N__ = {};
  win.__WFD_LANG__ = 'en';
  win.acquireVsCodeApi = () => ({
    postMessage: (m: any) => posted.push(m),
    getState: () => harness.state,
    setState: (s: any) => {
      harness.state = s;
    },
  });
  if (needCanvas) win.HTMLCanvasElement.prototype.getContext = () => noopCtx();

  // Inject the REAL media script into the window realm (executes its IIFE synchronously; it posts {type:'ready'}).
  const code = fs.readFileSync(path.join(MEDIA_DIR, scriptFile), 'utf8');
  const s = win.document.createElement('script');
  s.textContent = code;
  win.document.body.appendChild(s);
  OPEN_HARNESSES.add(harness);
  /* eslint-enable @typescript-eslint/no-explicit-any */
  return harness;
}

export function loadDesigner(): Harness {
  return load('designer.js', DESIGNER_SCAFFOLD, true);
}
export function loadPanel(): Harness {
  return load('panel.js', PANEL_SCAFFOLD, false);
}

/** Real-timer delay — the nudge commit debounce (250ms) fires on jsdom's Node-backed timers, so a test waits it out. */
export function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
