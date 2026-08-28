// WinForms designer — canvas custom-editor webview (loaded as an EXTERNAL file via asWebviewUri + nonce).
// This view owns ONLY the rendered form: the PNG preview, the selection overlay (single + multi), click /
// Ctrl-click / rubber-band selection, in-surface drag-to-move (with snaplines) / resize, group move + group
// delete, and zoom. The Toolbox and Properties live in a separate, dockable WebviewView (media/panel.js);
// the host (src/designerEditor.ts) routes between them. Plain ES5-ish JS (no bundler touches this file).
(function () {
  // ---- i18n shim: the host injects window.__WFD_L10N__ (the resolved catalog) + window.__WFD_LANG__ (locale)
  // in a <script> immediately before this file. T()/TN() mirror the host's t()/tn(); a missing key falls back
  // to the key itself. Named T/TN (not t/tn) because `t` is already a local variable throughout this file. ----
  var __L10N = window.__WFD_L10N__ || {}, __LANG = window.__WFD_LANG__ || 'en';
  function T(k, p) {
    var s = __L10N[k];
    if (s == null) return k;
    if (typeof s === 'object') s = s.other || k;
    return p ? String(s).replace(/\{(\w+)\}/g, function (_m, n) { return p[n] != null ? p[n] : ''; }) : s;
  }
  function TN(k, n, p) {
    var e = __L10N[k];
    if (e == null) return k;
    if (typeof e !== 'object') { var pp = {}; if (p) for (var kk in p) pp[kk] = p[kk]; pp.n = n; return T(k, pp); }
    var cat; try { cat = new Intl.PluralRules(__LANG).select(n); } catch (_e) { cat = 'other'; }
    var s = e[cat] || e.other || k;
    return String(s).replace(/\{(\w+)\}/g, function (_m, x) { return x === 'n' ? n : (p && p[x] != null ? p[x] : ''); });
  }

  window.addEventListener('error', function (ev) {
    try { var o = document.getElementById('overlay'); if (o) { o.className = 'err'; o.textContent = T('designer.overlay.error', { message: ev.message }); } } catch (_e) {}
  });
  try { var _ov = document.getElementById('overlay'); if (_ov) _ov.textContent = T('designer.overlay.initializing'); } catch (_e) {}

  var vscode = acquireVsCodeApi();
  var canvas = document.getElementById('surface');
  var ctx = canvas.getContext('2d');
  var surfaceWrap = document.getElementById('surfaceWrap');
  var gridEl = document.getElementById('designerGrid');
  var selBox = document.getElementById('sel');
  var selName = document.getElementById('selName');
  var deleteCtlEl = document.getElementById('deleteCtl');
  var saveEl = document.getElementById('save');
  var dirtyEl = document.getElementById('dirty');
  var statusEl = document.getElementById('status');
  var overlayEl = document.getElementById('overlay');
  var hasRendered = false;
  function ensureA11yLabel(el, label) {
    if (!el) return;
    if (!el.getAttribute('aria-label')) el.setAttribute('aria-label', label || el.title || el.textContent || el.id || 'command');
    if (el.tagName === 'BUTTON' && !el.getAttribute('type')) el.setAttribute('type', 'button');
  }
  function installSurfaceAccessibility() {
    if (surfaceWrap) {
      surfaceWrap.setAttribute('role', 'application');
      surfaceWrap.setAttribute('aria-label', T('designer.surface.aria'));
      surfaceWrap.tabIndex = surfaceWrap.tabIndex >= 0 ? surfaceWrap.tabIndex : 0;
    }
    if (canvas) {
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', T('designer.canvas.aria'));
    }
    var toolbar = document.getElementById('toolbar');
    if (toolbar) {
      toolbar.setAttribute('role', 'toolbar');
      toolbar.setAttribute('aria-label', T('designer.toolbar.aria'));
    }
    var labels = {
      zoomOut: 'Zoom out', zoomLabel: 'Reset zoom to 100 percent', zoomIn: 'Zoom in', zoomFit: 'Fit to view',
      alignLeft: 'Align left', alignRight: 'Align right', alignTop: 'Align top', alignBottom: 'Align bottom',
      alignCenterH: 'Align centers horizontally', alignCenterV: 'Align centers vertically',
      distH: 'Distribute horizontally', distV: 'Distribute vertically',
      spaceHInc: 'Increase horizontal spacing', spaceHDec: 'Decrease horizontal spacing', spaceHRemove: 'Remove horizontal spacing',
      spaceVInc: 'Increase vertical spacing', spaceVDec: 'Decrease vertical spacing', spaceVRemove: 'Remove vertical spacing',
      sameW: 'Make same width', sameH: 'Make same height', sameWH: 'Make same size',
      centerFormH: 'Center horizontally', centerFormV: 'Center vertically',
      tabOrder: 'Tab order', rulerToggle: 'Toggle ruler', deleteCtl: 'Delete selection',
      diagDismiss: 'Dismiss diagnostics', diagRetry: 'Retry render', diagRebuild: 'Rebuild project',
      diagChooseAssembly: 'Choose assembly', diagCopy: 'Copy diagnostics'
    };
    for (var id in labels) if (Object.prototype.hasOwnProperty.call(labels, id)) ensureA11yLabel(document.getElementById(id), labels[id]);
    if (!document.getElementById('wfd-designer-a11y-style')) {
      var style = document.createElement('style');
      style.id = 'wfd-designer-a11y-style';
      style.textContent = '.handle{min-width:10px;min-height:10px}.handle:focus,.typehereslot:focus,.smarttag:focus,#surfaceWrap:focus{outline:2px solid var(--vscode-focusBorder, Highlight);outline-offset:2px}@media (forced-colors: active){#sel,.selsec,.stripitemsel,.hoverhint,.rubberband,.toolboxdroptarget,.containeroutline,.anchortether,.snapguide,.stripdropindicator,.typehereslot,.smarttag,.lockbadge,.designeradorner{forced-color-adjust:auto;border-color:Highlight!important;color:CanvasText!important;background:Canvas!important}#sel .handle,.handle{background:Highlight!important;border-color:CanvasText!important}.snapguide{background:Highlight!important}}';
      document.head.appendChild(style);
    }
  }
  installSurfaceAccessibility();
  function showOverlay(msg, isErr) { overlayEl.style.display = 'flex'; overlayEl.className = isErr ? 'err' : ''; overlayEl.textContent = msg; }
  function hideOverlay() { overlayEl.style.display = 'none'; }

  // ---- T2.2: partial-render / failure diagnostics banner (top strip). 'warn' = constructs the (partial) render
  // skipped, with an expandable categorized list; 'err' = a hard render failure while a prior render is kept on the
  // canvas ("showing the last successful preview"). Dismiss latches a signature so the SAME problem-set doesn't
  // re-nag across re-renders, but a CHANGED set (or a clean render) re-shows / resets. ----
  var formNoticeEl = document.getElementById('formNotice');
  var formNoticeMsgEl = document.getElementById('formNoticeMsg');
  var formNoticeIconEl = document.getElementById('formNoticeIcon');
  var diagEl = document.getElementById('diag');
  var diagMsgEl = document.getElementById('diagMsg');
  var diagToggleEl = document.getElementById('diagToggle');
  var diagListEl = document.getElementById('diagList');
  var diagDismissEl = document.getElementById('diagDismiss');
  var diagRetryEl = document.getElementById('diagRetry');
  var diagRebuildEl = document.getElementById('diagRebuild');
  var diagChooseAssemblyEl = document.getElementById('diagChooseAssembly');
  var diagCopyEl = document.getElementById('diagCopy');
  var diagSig = '';             // signature of what's currently shown
  var diagDismissedSig = null;  // signature the user dismissed (stay hidden while the next set matches it)
  var diagExpanded = false;
  var DIAG_MAX = 40;            // cap the rendered list; excess collapses to a "+N more" row
  var CAT_LABEL = { missingType: 'designer.diag.cat.missingType', initError: 'designer.diag.cat.initError', unsupported: 'designer.diag.cat.unsupported' };
  function diagSignature(mode, msg, items) {
    // JSON-encode fields so field boundaries are unambiguous — a space/'|'/'\n'-joined key would let two different
    // problem sets collide ("a b"+"c" == "a"+"b c") and wrongly keep a banner dismissed for a DIFFERENT set.
    var parts = items.map(function (i) { return JSON.stringify([i.category, i.target, i.text, i.detail]); });
    parts.sort();
    return JSON.stringify([mode, msg, parts]);
  }
  function hideDiag() { if (diagEl) diagEl.style.display = 'none'; }
  function renderDiagList(items) {
    diagListEl.textContent = '';
    var n = Math.min(items.length, DIAG_MAX);
    for (var i = 0; i < n; i++) {
      var it = items[i];
      var li = document.createElement('li');
      var target = document.createElement('span'); target.className = 'diagTarget';
      target.title = it.target || 'statement';
      target.textContent = T('designer.diag.target', { target: it.target || 'statement' });
      li.appendChild(target);
      var cat = document.createElement('span'); cat.className = 'diagCat';
      cat.textContent = T(CAT_LABEL[it.category] || CAT_LABEL.unsupported);
      li.appendChild(cat);
      li.appendChild(document.createTextNode(it.text || ''));   // engine text / user code — textContent, never innerHTML
      if (it.detail) { var d = document.createElement('span'); d.className = 'diagDetail'; d.textContent = ' — ' + it.detail; li.appendChild(d); }
      diagListEl.appendChild(li);
    }
    if (items.length > n) {
      var more = document.createElement('li'); more.textContent = T('designer.diag.more', { n: items.length - n }); more.style.opacity = '.7';
      diagListEl.appendChild(more);
    }
  }
  function showDiag(mode, msg, items) {
    if (!diagEl) return;
    var sig = diagSignature(mode, msg, items);
    if (sig === diagDismissedSig) { hideDiag(); return; }   // user dismissed this exact set → stay hidden
    diagSig = sig;
    diagEl.className = mode;                                  // 'warn' | 'err'
    diagMsgEl.textContent = msg;
    diagExpanded = false;
    if (items.length) { renderDiagList(items); diagToggleEl.textContent = T('designer.diag.details'); diagToggleEl.style.display = ''; }
    else { diagListEl.textContent = ''; diagToggleEl.style.display = 'none'; }
    diagListEl.style.display = 'none';
    diagEl.style.display = '';
  }
  if (diagToggleEl) diagToggleEl.addEventListener('click', function () {
    diagExpanded = !diagExpanded;
    diagListEl.style.display = diagExpanded ? '' : 'none';
    diagToggleEl.textContent = T(diagExpanded ? 'designer.diag.hide' : 'designer.diag.details');
  });
  if (diagDismissEl) diagDismissEl.addEventListener('click', function () { diagDismissedSig = diagSig; hideDiag(); });
  function postDiagAction(action) { vscode.postMessage({ type: 'diagnosticAction', action: action }); }
  if (diagRetryEl) diagRetryEl.addEventListener('click', function () { postDiagAction('retry'); });
  if (diagRebuildEl) diagRebuildEl.addEventListener('click', function () { postDiagAction('rebuild'); });
  if (diagChooseAssemblyEl) diagChooseAssemblyEl.addEventListener('click', function () { postDiagAction('chooseAssembly'); });
  if (diagCopyEl) diagCopyEl.addEventListener('click', function () { postDiagAction('copy'); });

  var controls = [];      // innermost-first (engine order)
  var current = null;     // primary selection id (drives the Properties panel + resize handles)
  var selection = [];     // all selected ids (multi-select); always contains `current` when non-empty
  var tray = [];          // non-visual components (component tray)
  var stripItems = [];    // per-item geometry for ToolStrip/MenuStrip/StatusStrip incl. the trailing "Type Here" slot
  // on-canvas strip ITEM selection (Slice D): a single top-level item chosen by clicking it — the Delete/F2 target.
  // Separate from the control selection above (an item is a Component, not a Control) so the generic control ops
  // (Delete→removeControl, Cut/Copy, z-order) never fire on it. Holds a cached geom {ownerId,itemId,itemType,text,x,y,
  // width,height} re-resolved from `stripItems` on every render, or null when nothing / a control is selected.
  var selectedItem = null;
  var trayEl = document.getElementById('tray');
  // tab-order editing (Phase 2): click controls in sequence to renumber TabIndex
  var tabOrderMode = false;
  var tabSeq = 0;
  var tabBadges = [];
  var tabOrderEl = document.getElementById('tabOrder');
  var alignEl = document.getElementById('align');
  var centerFormEl = document.getElementById('centerForm');

  // ---- direct manipulation (drag-to-move + resize) ----
  var canMove = false;     // can the primary selection be moved (set by the host's 'manip' message)
  var canResize = false;   // can it be resized
  var drag = null;         // active move/resize gesture
  var band = null;         // active rubber-band selection gesture
  var toolboxBand = null;  // active rectangle placement gesture from a selected toolbox item
  var stripDrag = null;    // active ToolStrip/MenuStrip item reorder/reparent gesture
  var nudge = null;        // in-progress keyboard-nudge series (arrow keys) — debounced into ONE commit/undo
  var NUDGE_COMMIT_MS = 250; // idle after the last arrow key before the accumulated nudge is committed
  var suppressClick = false; // swallow the click that ENDS a drag/band so it doesn't re-select
  var placementSnapOverrideModifier = 'alt';
  var placementLayoutMode = 'snapLines';
  var placementGridSize = 8;
  var placementShowGrid = false;
  var selectedToolboxControl = null;
  function sanitizePlacementSnapOverrideModifier(raw) {
    return raw === 'control' || raw === 'shift' || raw === 'disabled' ? raw : 'alt';
  }
  function sanitizeLayoutMode(raw) { return raw === 'snapToGrid' || raw === 'none' ? raw : 'snapLines'; }
  function sanitizeGridSize(raw) {
    var n = Number(raw); return isFinite(n) ? Math.max(2, Math.min(128, Math.round(n))) : 8;
  }
  function placementSnapOverrideActive(e, ctrlDrag) {
    if (placementSnapOverrideModifier === 'disabled') return false;
    // Ctrl+drag is Duplicate and takes precedence over a user-configured Control snap override for move gestures.
    if (placementSnapOverrideModifier === 'control') return !ctrlDrag && !!(e && e.ctrlKey);
    if (placementSnapOverrideModifier === 'shift') return !!(e && e.shiftKey);
    return !!(e && e.altKey);
  }
  function rawPlacementStatus(r) {
    return T('designer.status.freePlacement', {
      x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h)
    });
  }
  function geometryStatus(r) {
    return T('designer.status.geometry', {
      x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h)
    });
  }
  // Inline editors are not VS Code TextDocuments, so explicitly tell the host when typing should preempt a lazy
  // toolbox metadata pass. Navigation and command shortcuts do not count as text entry.
  document.addEventListener('keydown', function (e) {
    var target = e.target;
    if (!target || !target.matches || !target.matches('input, textarea, [contenteditable="true"]')) return;
    if (!e.ctrlKey && !e.metaKey && !e.altKey && (e.key.length === 1 || e.key === 'Backspace' || e.key === 'Delete')) {
      vscode.postMessage({ type: 'toolboxInteraction' });
    }
  });
  // ---- Lock Controls (VS): a locked control can't be moved/resized/nudged by mouse. The state is view metadata:
  // reported to the extension host and persisted per form in workspaceState, never written into .Designer.cs/.resx.
  var lockedIds = {};      // { id: true } for locked controls
  function isLocked(id) { return !!lockedIds[id]; }
  function selectionHasLocked() { var s = selectableIds(); for (var i = 0; i < s.length; i++) { if (isLocked(s[i])) return true; } return false; }
  var canvasStateTimer = null;
  function queueCanvasState() {
    if (canvasStateTimer) clearTimeout(canvasStateTimer);
    canvasStateTimer = setTimeout(function () {
      canvasStateTimer = null;
      var ids = [];
      for (var id in lockedIds) if (Object.prototype.hasOwnProperty.call(lockedIds, id) && lockedIds[id]) ids.push(id);
      vscode.postMessage({ type: 'canvasViewStateChanged', state: { zoom: zoom, lockedIds: ids } });
    }, 120);
  }
  var HANDLE_DIRS = ['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se'];
  var handles = {};
  HANDLE_DIRS.forEach(function (dir) {
    var h = document.createElement('div');
    h.className = 'handle h-' + dir;
    h.style.display = 'none';
    h.tabIndex = 0;
    h.setAttribute('role', 'button');
    h.setAttribute('aria-label', 'Resize ' + dir);
    h.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return; // left-button only — right-click opens the context menu, not a resize
      if (drag || !canResize || selection.length > 1 || isLocked(current)) return; // resize only: single, unlocked selection
      var c = findControl(current); if (!c) return;
      if (nudge) flushNudge(); // commit any pending keyboard-nudge before a handle-drag (handles bypass canvas mousedown)
      drag = { mode: 'resize', dir: dir, startX: e.clientX, startY: e.clientY, orig: { x: c.x, y: c.y, w: c.width, h: c.height } };
      e.preventDefault(); e.stopPropagation();
    });
    selBox.appendChild(h);
    handles[dir] = h;
  });

  // overlay pools (children of surfaceWrap, positioned in DISPLAY px = surface px × zoom)
  var secBoxes = [];   // outline boxes for non-primary selected controls
  var guideEls = [];   // snapline guides
  var anchorEls = [];  // anchor tethers for the single selected control (Phase 2)
  var containerEls = []; // persistent dashed outlines for container controls (VS-style layout hint)
  var bandEl = null;   // rubber-band rectangle
  var toolboxDropEl = null; // cross-webview drag target: the exact container the host will receive
  function secBox(i) {
    while (secBoxes.length <= i) { var d = document.createElement('div'); d.className = 'selsec'; d.style.display = 'none'; surfaceWrap.appendChild(d); secBoxes.push(d); }
    return secBoxes[i];
  }
  function clearGuides() { for (var i = 0; i < guideEls.length; i++) guideEls[i].style.display = 'none'; }
  function clearAnchors() { for (var i = 0; i < anchorEls.length; i++) anchorEls[i].style.display = 'none'; }
  function anchorEl(i) {
    while (anchorEls.length <= i) { var d = document.createElement('div'); d.className = 'anchortether'; d.style.display = 'none'; surfaceWrap.appendChild(d); anchorEls.push(d); }
    return anchorEls[i];
  }
  function containerBox(i) {
    while (containerEls.length <= i) { var d = document.createElement('div'); d.className = 'containeroutline'; d.style.display = 'none'; surfaceWrap.appendChild(d); containerEls.push(d); }
    return containerEls[i];
  }
  // ---- hover pre-selection hint (VS-style): a thin outline over the control a click WOULD select, so dense /
  // nested layouts show the click target before you commit. Pure overlay; no engine, no selection change. ----
  var hoverEl = null;
  function ensureHover() { if (!hoverEl) { hoverEl = document.createElement('div'); hoverEl.className = 'hoverhint'; hoverEl.style.display = 'none'; surfaceWrap.appendChild(hoverEl); } return hoverEl; }
  function hideHover() { if (hoverEl) hoverEl.style.display = 'none'; }
  function showHover(id) {
    var c = id ? findControl(id) : null;
    // skip the root, the already-selected control(s), and any active gesture / tab-order mode
    if (!c || c.isRoot || c.id === 'this' || selection.indexOf(id) >= 0 || drag || band || tabOrderMode) { hideHover(); return; }
    ensureHover();
    hoverEl.style.display = 'block';
    hoverEl.style.left = (c.x * zoom) + 'px'; hoverEl.style.top = (c.y * zoom) + 'px';
    hoverEl.style.width = Math.max(0, c.width * zoom - 2) + 'px'; hoverEl.style.height = Math.max(0, c.height * zoom - 2) + 'px';
  }

  // ---- hosted ControlDesigner adorners (S093): the engine publishes only bounded control-local rectangles. The
  // rectangle may be drawn for the current single selection, but hover activation remains provisional until the host
  // rebuilds the graph and the live designer confirms the exact point through HitTestDesignerAdorner. ----
  var designerAdornerEls = [];
  var designerAdornerHitToken = 0;
  function designerAdornerEl(i) {
    while (designerAdornerEls.length <= i) {
      var el = document.createElement('div');
      el.className = 'designeradorner'; el.style.display = 'none'; el.textContent = '◆';
      el.setAttribute('role', 'img');
      el.addEventListener('mouseenter', function (e) {
        var state = el._designerAdorner;
        if (!state || state.controlId !== current || selection.length !== 1) return;
        var a = state.adorner, r = el.getBoundingClientRect(), z = zoom || 1;
        var px = a.left + Math.floor((e.clientX - r.left) / z);
        var py = a.top + Math.floor((e.clientY - r.top) / z);
        if (!isFinite(px) || px < a.left || px >= a.left + a.width) px = a.left + Math.floor(a.width / 2);
        if (!isFinite(py) || py < a.top || py >= a.top + a.height) py = a.top + Math.floor(a.height / 2);
        var token = ++designerAdornerHitToken;
        el._designerAdornerHitToken = token;
        el.classList.remove('hit'); el.classList.add('pending');
        vscode.postMessage({ type: 'designerAdornerHit', id: state.controlId, adornerId: a.id, x: px, y: py, token: token });
      });
      el.addEventListener('mouseleave', function () {
        el._designerAdornerHitToken = null;
        el.classList.remove('pending'); el.classList.remove('hit');
      });
      surfaceWrap.appendChild(el); designerAdornerEls.push(el);
    }
    return designerAdornerEls[i];
  }
  function boundedDesignerAdorners(comp) {
    var source = comp && Array.isArray(comp.designerAdorners) ? comp.designerAdorners : [];
    var result = [], seen = {};
    for (var i = 0; i < source.length && result.length < 32; i++) {
      var a = source[i];
      if (!a || typeof a.id !== 'string' || !a.id || a.id.length > 128 || seen[a.id]
        || typeof a.displayName !== 'string' || a.displayName.length > 128 || a.hitTestable !== true
        || !Number.isInteger(a.left) || !Number.isInteger(a.top)
        || !Number.isInteger(a.width) || !Number.isInteger(a.height)
        || a.width <= 0 || a.height <= 0 || a.width > 16384 || a.height > 16384) continue;
      seen[a.id] = true; result.push(a);
    }
    return result;
  }
  function renderDesignerAdorners() {
    var comp = (tasksState && tasksState.id === current) ? tasksState.comp : null;
    var c = current ? findControl(current) : null;
    var adorners = !tabOrderMode && !drag && selection.length === 1 && c && comp
      ? boundedDesignerAdorners(comp) : [];
    var n = 0;
    for (; n < adorners.length; n++) {
      var a = adorners[n], el = designerAdornerEl(n);
      el._designerAdorner = { controlId: current, adorner: a };
      el._designerAdornerHitToken = null;
      el.classList.remove('pending'); el.classList.remove('hit');
      el.style.display = 'flex';
      el.style.left = ((c.x + a.left) * zoom) + 'px';
      el.style.top = ((c.y + a.top) * zoom) + 'px';
      el.style.width = Math.max(1, a.width * zoom) + 'px';
      el.style.height = Math.max(1, a.height * zoom) + 'px';
      el.title = a.displayName || a.id;
      el.setAttribute('aria-label', a.displayName || a.id);
    }
    for (; n < designerAdornerEls.length; n++) {
      designerAdornerEls[n].style.display = 'none';
      designerAdornerEls[n]._designerAdorner = null;
      designerAdornerEls[n]._designerAdornerHitToken = null;
      designerAdornerEls[n].classList.remove('pending'); designerAdornerEls[n].classList.remove('hit');
    }
  }
  // ---- container outlines: a persistent dashed border around every control that HOLDS children (VS shows layout
  // containers this way). "Is a parent of >=1 visible control" is robust across control libraries (no type list);
  // hidden-tab children are already dropped by the engine, so only on-surface containers get outlined. ----
  function renderContainers() {
    var n = 0;
    if (hasRendered) {
      var parentIds = {};
      for (var i = 0; i < controls.length; i++) { var pid = controls[i].parentId; if (pid && pid !== 'this') parentIds[pid] = true; }
      for (var j = 0; j < controls.length; j++) {
        var c = controls[j];
        if (c.isRoot || c.id === 'this' || !parentIds[c.id]) continue;
        var b = containerBox(n++); b.style.display = 'block';
        b.style.left = (c.x * zoom) + 'px'; b.style.top = (c.y * zoom) + 'px';
        b.style.width = Math.max(0, c.width * zoom) + 'px'; b.style.height = Math.max(0, c.height * zoom) + 'px';
      }
    }
    for (; n < containerEls.length; n++) containerEls[n].style.display = 'none';
  }

  // ---- on-canvas "Type Here" add-slot: a dashed placeholder cell drawn at the end of each ToolStrip/MenuStrip/
  // StatusStrip (engine-supplied window-space geometry). Clicking it opens the inline add-editor (openSlotEditor).
  // Pooled overlay divs like renderContainers. ----
  var stripSlotEls = [];
  function stripSlotEl(i) {
    while (stripSlotEls.length <= i) {
      var d = document.createElement('div'); d.className = 'typehereslot'; d.style.display = 'none'; d.textContent = '+';
      d.title = T('designer.typeHere');
      d.addEventListener('mousedown', function (e) { e.stopPropagation(); }); // a slot click must not start a marquee/drag
      d.addEventListener('click', (function (el) { return function (e) { e.stopPropagation(); if (el.__slot) openSlotEditor(el.__slot); }; })(d));
      surfaceWrap.appendChild(d); stripSlotEls.push(d);
    }
    return stripSlotEls[i];
  }
  function renderStripSlots() {
    var n = 0;
    if (hasRendered) {
      for (var i = 0; i < stripItems.length; i++) {
        var it = stripItems[i];
        if (!it.isTypeHere) continue; // this slice draws only the trailing add-slot; per-item outlines come later
        var b = stripSlotEl(n++); b.__slot = it; b.style.display = 'flex';
        b.style.left = (it.x * zoom) + 'px'; b.style.top = (it.y * zoom) + 'px';
        b.style.width = Math.max(0, it.width * zoom) + 'px'; b.style.height = Math.max(0, it.height * zoom) + 'px';
      }
    }
    for (; n < stripSlotEls.length; n++) { stripSlotEls[n].style.display = 'none'; stripSlotEls[n].__slot = null; }
  }
  // Hit-test a surface-space point against the top-level strip ITEM rects (not the trailing add-slot). Returns the
  // item geometry under the point (for double-click-to-rename), or null. Items are small; first containing rect wins.
  function stripItemHit(px, py) {
    for (var i = 0; i < stripItems.length; i++) {
      var it = stripItems[i];
      if (it.isTypeHere) continue;
      // an item with no field id (e.g. an anonymous statusStrip1.Items.Add("Ready")) can't be resolved on commit, so it
      // is NOT selectable/renamable/deletable — skip it so the click falls through to selecting the container strip
      // (avoids a dead click zone AND a stale-selection wrong-target delete via the context menu). Review wf_108a7dbe.
      if (!it.itemId) continue;
      if (it.overflow) continue; // the overflow chevron is hit-tested separately (overflowHit) → opens the overflow flyout
      if (px >= it.x && px < it.x + it.width && py >= it.y && py < it.y + it.height) return it;
    }
    return null;
  }
  // Hit-test a surface point against a strip's OVERFLOW chevron rect (overflow=true, id-less, painted by the ToolStrip
  // itself). Returns the chevron geom (its children = the overflow items) or null. Checked before the control hit-test so
  // a click on the chevron opens the overflow flyout instead of selecting the strip.
  function overflowHit(px, py) {
    for (var i = 0; i < stripItems.length; i++) {
      var it = stripItems[i];
      if (!it.overflow) continue;
      if (px >= it.x && px < it.x + it.width && py >= it.y && py < it.y + it.height) return it;
    }
    return null;
  }

  var stripDropEl = null;
  function ensureStripDropEl() {
    if (!stripDropEl) { stripDropEl = document.createElement('div'); stripDropEl.className = 'stripdropindicator'; stripDropEl.style.display = 'none'; surfaceWrap.appendChild(stripDropEl); }
    return stripDropEl;
  }
  function clearStripDropFeedback() {
    if (stripDropEl) stripDropEl.style.display = 'none';
  }
  function ancestorWithClass(n, cls) {
    while (n && n !== document) {
      if (n.className && String(n.className).split(/\s+/).indexOf(cls) >= 0) return n;
      n = n.parentNode;
    }
    return null;
  }
  function stripTopItems(ownerId) {
    var r = [];
    for (var i = 0; i < stripItems.length; i++) {
      var it = stripItems[i];
      if (it.ownerId === ownerId && !it.isTypeHere && !it.overflow && it.itemId) r.push(it);
    }
    return r;
  }
  function stripTopAppendIndex(ownerId) {
    return stripTopItems(ownerId).length;
  }
  function rectFromElement(el) {
    var wrap = surfaceWrap.getBoundingClientRect(), rr = el.getBoundingClientRect(), z = zoom || 1;
    return { x: (rr.left - wrap.left) / z, y: (rr.top - wrap.top) / z, w: rr.width / z, h: rr.height / z };
  }
  function showStripDropFeedback(target) {
    if (!target || !target.rect) { clearStripDropFeedback(); return; }
    var el = ensureStripDropEl(), r = target.rect;
    el.style.display = 'block';
    if (target.mode === 'append') {
      el.className = 'stripdropindicator append';
      el.style.left = (r.x * zoom) + 'px'; el.style.top = (r.y * zoom) + 'px';
      el.style.width = Math.max(8, r.w * zoom) + 'px'; el.style.height = Math.max(8, r.h * zoom) + 'px';
    } else if (target.mode === 'vline') {
      el.className = 'stripdropindicator vline';
      el.style.left = (r.x * zoom) + 'px'; el.style.top = (r.y * zoom) + 'px';
      el.style.width = '0px'; el.style.height = Math.max(8, r.h * zoom) + 'px';
    } else {
      el.className = 'stripdropindicator hline';
      el.style.left = (r.x * zoom) + 'px'; el.style.top = (r.y * zoom) + 'px';
      el.style.width = Math.max(8, r.w * zoom) + 'px'; el.style.height = '0px';
    }
  }
  function stripMoveTarget(clientX, clientY, eventTarget) {
    if (!stripDrag) return null;
    var ownerId = stripDrag.ownerId;
    var rowSlot = ancestorWithClass(eventTarget, 'stripflyouttypehere');
    if (rowSlot && rowSlot._smOwnerId === ownerId) {
      var rrSlot = rectFromElement(rowSlot);
      return {
        targetParentItemId: rowSlot._smParentItemId || null,
        targetIndex: Math.max(0, rowSlot._smIndex || 0),
        mode: 'append',
        rect: { x: rrSlot.x, y: rrSlot.y, w: rrSlot.w || SUBMENU_W, h: rrSlot.h || SUBMENU_ROW_H }
      };
    }
    var row = ancestorWithClass(eventTarget, 'stripflyoutrow');
    if (row && row._smItem && row._smOwnerId === ownerId && row._smItem.itemId && !row._smItem.overflow) {
      var rr = rectFromElement(row);
      var after = rr.h > 0 ? ((clientY - surfaceWrap.getBoundingClientRect().top) / (zoom || 1) >= rr.y + rr.h / 2) : false;
      return {
        targetParentItemId: row._smParentItemId || null,
        targetIndex: Math.max(0, (row._smIndex || 0) + (after ? 1 : 0)),
        mode: 'hline',
        rect: { x: rr.x, y: rr.y + (after ? (rr.h || SUBMENU_ROW_H) : 0), w: rr.w || SUBMENU_W, h: 0 }
      };
    }
    var topSlot = ancestorWithClass(eventTarget, 'typehereslot');
    if (topSlot && topSlot.__slot && topSlot.__slot.ownerId === ownerId) {
      var ts = topSlot.__slot;
      return {
        targetParentItemId: null,
        targetIndex: stripTopAppendIndex(ownerId),
        mode: 'append',
        rect: { x: ts.x, y: ts.y, w: ts.width, h: ts.height }
      };
    }
    var cr = bandRect();
    var px = (clientX - cr.left) / (zoom || 1), py = (clientY - cr.top) / (zoom || 1);
    var hit = stripItemHit(px, py);
    if (hit && hit.ownerId === ownerId && hit.itemId) {
      var top = stripTopItems(ownerId);
      var idx = 0;
      for (; idx < top.length; idx++) if (top[idx].itemId === hit.itemId) break;
      if (idx < top.length) {
        var afterTop = px >= hit.x + hit.width / 2;
        return {
          targetParentItemId: null,
          targetIndex: idx + (afterTop ? 1 : 0),
          mode: 'vline',
          rect: { x: hit.x + (afterTop ? hit.width : 0), y: hit.y, w: 0, h: hit.height }
        };
      }
    }
    return null;
  }
  function startStripDrag(item, e, level, rowEl) {
    if (!item || !item.ownerId || !item.itemId || item.overflow) return false;
    stripDrag = { ownerId: item.ownerId, itemId: item.itemId, itemType: item.itemType, text: item.text, startX: e.clientX, startY: e.clientY, active: false, target: null, level: level, rowEl: rowEl || null };
    e.preventDefault(); e.stopPropagation();
    return true;
  }

  // ---- on-canvas strip ITEM selection (Slice D): a single clicked top-level item, highlighted with a solid box and
  // made the Delete (Del / ctx "Delete Item") and F2-rename target. A pooled single overlay div (like the lock badge),
  // re-laid-out and re-resolved from the latest `stripItems` on every renderSelection so it tracks zoom/scroll and
  // clears itself when its item vanishes (e.g. after a delete commit). ----
  var stripItemSelEl = null;
  function ensureStripItemSel() {
    if (!stripItemSelEl) { stripItemSelEl = document.createElement('div'); stripItemSelEl.className = 'stripitemsel'; stripItemSelEl.style.display = 'none'; surfaceWrap.appendChild(stripItemSelEl); }
    return stripItemSelEl;
  }
  // re-resolve the selected item from the current geometry (id may have moved/vanished after a commit) and position
  // the highlight; if it's gone, drop the selection. Called early in renderSelection so downstream (Delete-enabled) is
  // consistent with the validated state.
  function renderStripItemSel() {
    ensureStripItemSel();
    if (!selectedItem) { stripItemSelEl.style.display = 'none'; return; }
    var g = null;
    for (var i = 0; i < stripItems.length; i++) {
      var it = stripItems[i];
      if (!it.isTypeHere && it.ownerId === selectedItem.ownerId && it.itemId === selectedItem.itemId) { g = it; break; }
    }
    if (!g) { selectedItem = null; stripItemSelEl.style.display = 'none'; return; }
    selectedItem = { ownerId: g.ownerId, itemId: g.itemId, itemType: g.itemType, text: g.text, x: g.x, y: g.y, width: g.width, height: g.height };
    stripItemSelEl.style.display = 'block';
    stripItemSelEl.style.left = (g.x * zoom) + 'px'; stripItemSelEl.style.top = (g.y * zoom) + 'px';
    stripItemSelEl.style.width = Math.max(0, g.width * zoom) + 'px'; stripItemSelEl.style.height = Math.max(0, g.height * zoom) + 'px';
  }
  // select a top-level strip item on the canvas: it becomes the Delete/F2 target AND loads its own properties into the
  // Properties panel. Clears the CONTROL selection (an item isn't a control — the generic Delete/Cut/z-order must not act
  // on it) and posts `selectItem` so the host describes the item field and pushes an `itemProps` message — a DEDICATED
  // channel that does NOT touch the control `currentId` (so manipFor / smart-tag / generic Delete stay on the last
  // control). itemId is guaranteed non-empty here (the guard below + stripItemHit skipping anonymous items).
  // renderSelection draws the highlight + updates the Delete-enabled state.
  function selectStripItem(item) {
    if (!item || !item.ownerId || !item.itemId) return;
    selectedItem = { ownerId: item.ownerId, itemId: item.itemId, itemType: item.itemType, text: item.text, x: item.x, y: item.y, width: item.width, height: item.height };
    selection = []; current = null; canMove = false; canResize = false;
    hideHover();
    closeSlotEditor(); // a stray inline editor must not linger over a new item selection
    vscode.postMessage({ type: 'selectItem', hostId: item.ownerId, itemId: item.itemId });
    renderSelection();
  }
  // delete the selected strip item (+ its subtree): the host fetches the owner's forest, omits this node, and reuses
  // the ToolStrip commit path (the engine computes removedIds + disposes). The re-render's fresh layout clears the
  // highlight once the item is gone; a refused delete leaves it in place.
  function deleteStripItem() {
    if (!selectedItem) return;
    vscode.postMessage({ type: 'stripDelete', hostId: selectedItem.ownerId, itemId: selectedItem.itemId });
  }

  // ---- on-canvas synthetic submenu flyout: clicking a top-level menu item that has nested DropDownItems (the engine-
  // supplied `children` on its geometry) draws a client-side dropdown listing those children. A closed dropdown isn't
  // laid out on the surface (no bounds), so we synthesize it here instead of rendering it into the PNG. Clicking a child
  // row loads THAT item's Properties via the existing item→Properties channel (posts `selectItem`; the host describes
  // the nested field-backed item by id — Site.Name / FieldNames reverse-scan). A child that itself has children opens a
  // nested level to its right. This is the reachability path for the scalar props / events of nested items now that the
  // component tray no longer surfaces strip items (VS parity). A selected nested row is ALSO the Del / F2 / dblclick /
  // right-click-menu target: rename & delete recurse through the depth-agnostic host splices (findToolStripItem /
  // removeToolStripItem) keyed by the OWNER strip; only nested ADD ("Type Here" inside a submenu) still lives in the
  // recursive Items editor. Pooled level-box overlays like
  // renderContainers; click-away (capture-phase doc mousedown, mirrors the inline editor / smart-tag flyout) dismisses.
  // NOTE the distinct `submenu*` naming: the smart-tag glyph already owns openFlyout/closeFlyout in this IIFE, so these
  // MUST NOT reuse those names (later function declarations would clobber earlier ones). ----
  var SUBMENU_ROW_H = 22; // per-row height in SURFACE px (× zoom when drawn)
  var SUBMENU_W = 168;    // level min-width in SURFACE px (nested levels anchor to the measured parent row, not this)
  var TRAY_FLYOUT_INSET = 8; // an off-tree strip's flyout anchors this far inside the VISIBLE surface top-left (SURFACE px)
  var submenuLevels = []; // open submenu path: [{ ownerId, items:[childGeom], ax, ay }] (ax/ay = anchor in SURFACE px)
  // the selected (properties-loaded) flyout row = the nested Del/F2/rename target, or null. ax/ay = the row's measured
  // top-left in SURFACE px (the rename editor overlays it); ownerId = the TOP-LEVEL strip (the host splice key).
  var submenuSel = null;
  var submenuBoxes = [];  // pooled level boxes (children of surfaceWrap)
  // Armed by a COMMITTED on-canvas add from a flyout's ROOT "Type Here" slot; consumed ONCE by the matching `stripAddDone`
  // (token-correlated with the add's real outcome), NOT by the ambient `tray` message. Keyed by a monotonic token so a
  // REJECTED/superseded add can't resurrect a stale flyout (host posts stripAddDone ok:false → just clear the arm), and
  // an OVERLAPPING second add can't consume the first's arm against a stale forest (only the token that matches reopens)
  // — the two state-machine holes codex found in the tray-signal version. { token, kind:'tray', ownerId } re-opens a tray
  // strip's chip flyout; { token, kind:'submenu', topItemId } re-opens a menu-bar item's dropdown; an optional `path`
  // (parentItemId per level below the root) replays the descent so a DEEPER-than-root add re-reveals its new item at the
  // right level. stripAddDone arrives AFTER this add's render→layout→tray, so the forest the reopen draws from is fresh.
  // reopenSeq is seeded with a RANDOM per-page-load base (a session epoch), NOT 0: a webview HTML rebuild (e.g. a live
  // locale switch replaces the HTML without cancelling an in-flight host add) resets this module, so a 0-based counter
  // would let the OLD page's in-flight completion token collide with the NEW page's arm and reopen the wrong flyout
  // (codex confirm #2). A distinct random base per load makes that cross-rebuild collision negligible — no message change.
  var slotReopen = null, reopenSeq = Math.floor(Math.random() * 0x40000000);
  function submenuBox(i) {
    while (submenuBoxes.length <= i) {
      var d = document.createElement('div'); d.className = 'stripflyout'; d.style.display = 'none';
      d.addEventListener('mousedown', function (e) { e.stopPropagation(); });   // a flyout click must not start a marquee/drag
      // right-click a flyout ROW → select it (its Properties + the nested Del/F2 target) and open the focused item menu
      // (Rename / Delete Item), mirroring a top-level item right-click. A click on padding / a separator opens nothing.
      d.addEventListener('contextmenu', onSubmenuCtx);
      surfaceWrap.appendChild(d); submenuBoxes.push(d);
    }
    return submenuBoxes[i];
  }
  function renderSubmenu() {
    var n = 0;
    for (var lvl = 0; lvl < submenuLevels.length; lvl++) {
      var L = submenuLevels[lvl];
      var box = submenuBox(n++); box.innerHTML = ''; box.style.display = 'block';
      box.style.left = (L.ax * zoom) + 'px'; box.style.top = (L.ay * zoom) + 'px';
      box.style.minWidth = (SUBMENU_W * zoom) + 'px';
      for (var r = 0; r < L.items.length; r++) {
        var it = L.items[r];
        if (isSeparatorType(it.itemType)) { var s = document.createElement('div'); s.className = 'stripflyoutsep'; box.appendChild(s); continue; }
        var hasKids = !!(it.children && it.children.length);
        // an item with no field id can't be selected/renamed/deleted, and with no children it can't be navigated either →
        // a purely DEAD row (e.g. a hand-authored Items.Add("Foo")). Render it INERT (no hover/cursor/handlers) so it
        // doesn't masquerade as a live click. An anonymous PARENT (has children) stays interactive — it still opens its
        // submenu. A field-backed item is always interactive.
        var interactive = !!(it.itemId || hasKids);
        var row = document.createElement('div');
        row.className = 'stripflyoutrow' + (interactive ? '' : ' inert') + (submenuSel && it.itemId && it.itemId === submenuSel.itemId ? ' sel' : '');
        row.style.height = (SUBMENU_ROW_H * zoom) + 'px';
        row._smItem = it; row._smLevel = lvl; row._smOwnerId = L.ownerId; row._smParentItemId = L.parentItemId || null; row._smIndex = r; // read by ctx + drag/drop
        var cap = document.createElement('span'); cap.className = 'stripflyoutcap'; cap.textContent = it.text || it.itemId || '—';
        row.appendChild(cap);
        if (hasKids) { var arr = document.createElement('span'); arr.className = 'stripflyoutarrow'; arr.textContent = '▸'; row.appendChild(arr); }
        if (interactive) {
          (function (item, level, rowEl, ownerId) {
            rowEl.addEventListener('click', function (e) { e.stopPropagation(); onSubmenuRow(item, level, rowEl); });
            rowEl.addEventListener('mousedown', function (e) { if (e.button === 0 && item.itemId) startStripDrag({ ownerId: item.ownerId || ownerId, itemId: item.itemId, itemType: item.itemType, text: item.text }, e, level, rowEl); });
            // double-click a nested row → rename it (mirrors the top-level dblclick; a separator has no Text so it's inert)
            rowEl.addEventListener('dblclick', function (e) { e.stopPropagation(); if (item.itemId && !isSeparatorType(item.itemType)) { selectSubmenuRow(item, level, rowEl); renameSubmenuSel(); } });
          })(it, lvl, row, L.ownerId);
        }
        box.appendChild(row);
      }
      // trailing "Type Here" add-slot for THIS submenu level — the nested analogue of the top-level .typehereslot.
      // Clicking it opens the inline add-editor to append a new item. For a nested level (parentItemId set) it grows
      // that owner-item's DropDownItems; for an off-tree strip's ROOT level (isStripRoot, parentItemId null) it appends
      // to the strip's TOP level (host applyStripAdd with no parentItemId). Skipped for an anonymous submenu parent (no
      // splice id → a dead click). openNestedSlot measures the slot BEFORE openSlotShell closes the flyout, then floats
      // the editor at that anchor.
      if (L.parentItemId || L.isStripRoot) {
        var slot = document.createElement('div'); slot.className = 'stripflyouttypehere';
        slot._smOwnerId = L.ownerId; slot._smParentItemId = L.parentItemId || null; slot._smIndex = L.items.length;
        slot.style.height = (SUBMENU_ROW_H * zoom) + 'px';
        var scap = document.createElement('span'); scap.className = 'stripflyoutcap'; scap.textContent = T('designer.typeHere');
        slot.appendChild(scap);
        (function (ownerId, parentItemId, slotEl, isRoot, level) {
          slotEl.addEventListener('click', function (e) { e.stopPropagation(); openNestedSlot(ownerId, parentItemId, slotEl, isRoot, level); });
        })(L.ownerId, L.parentItemId, slot, !!L.isStripRoot, lvl);
        box.appendChild(slot);
      }
    }
    for (; n < submenuBoxes.length; n++) { submenuBoxes[n].style.display = 'none'; submenuBoxes[n].innerHTML = ''; }
  }
  // open the flyout for a top-level item that has children (no-op / close otherwise). Anchored just under the item.
  function openSubmenu(item) {
    if (!item || !item.children || !item.children.length) { closeSubmenu(); return; }
    // parentItemId = the item whose DropDownItems this level lists (the host splice target for a nested "Type Here" ADD).
    submenuLevels = [{ ownerId: item.ownerId, parentItemId: item.itemId, items: item.children, ax: item.x, ay: item.y + item.height }];
    submenuSel = null;
    document.addEventListener('mousedown', onSubmenuDocDown, true);
    renderSubmenu();
  }
  // open the synthetic flyout for a strip's OVERFLOW chevron: the items pushed off the main strip (Placement==Overflow)
  // are its children. They're TOP-LEVEL Items of the strip (just overflow-placed), so selecting/renaming/deleting a row
  // is a normal top-level item op (the host's findToolStripItem finds it at the strip's root). No trailing "Type Here"
  // slot: the level carries parentItemId null and is NOT isStripRoot, so renderSubmenu shows no add row (a full strip has
  // no room to add — VS widens it first; adding-while-overflowed is a deferred follow-up). Anchored just under the chevron
  // rect, which the ToolStrip already paints into the PNG (so no overlay is drawn — only the hit region is synthetic).
  function openOverflowFlyout(item) {
    if (!item || !item.children || !item.children.length) { closeSubmenu(); return; }
    // isOverflowRoot marks this root so a DEEPER add inside an overflowed item's submenu can auto-reopen the flyout after
    // the commit (openNestedSlot → reopen {kind:'overflow',ownerId} → reopenFlyout re-finds the chevron). The root level
    // itself carries no add-slot (parentItemId null, NOT isStripRoot → renderSubmenu shows none).
    submenuLevels = [{ ownerId: item.ownerId, parentItemId: null, isOverflowRoot: true, items: item.children, ax: item.x, ay: item.y + item.height }];
    submenuSel = null;
    document.addEventListener('mousedown', onSubmenuDocDown, true);
    renderSubmenu();
  }
  // open the synthetic flyout for an OFF-TREE strip surfaced in the tray (a ContextMenuStrip is never painted on the
  // surface — VS docks it at the top of the design surface when selected). Its top-level Items ARE the flyout's ROOT
  // level, so that level's "Type Here" slot is a TOP-LEVEL add (isStripRoot, parentItemId null → host applyStripAdd with
  // no parent). Anchored at the VISIBLE surface top-left: the tray chip sits below the surface, outside surfaceWrap, so a
  // chip-anchored flyout would be clipped by #stage's overflow; mapping the stage's visible top-left into surfaceWrap
  // surface coords keeps it on-screen even when the form is scrolled. jsdom returns zero rects → anchors at the inset.
  function openTrayStripFlyout(t) {
    // A non-strip chip (Timer/ImageList/…) has no flyout — close any open one. An EMPTY strip (isStrip, items==[]) DOES
    // open: its ROOT level shows just the "Type Here" add-first-item slot, the only on-canvas way to seed its Items.
    // Keyed on isStrip (engine-supplied), NOT items.length: a non-strip and an empty strip both serialize an empty Items.
    if (!t || !t.isStrip) { closeSubmenu(); return; }
    var wrap = surfaceWrap.getBoundingClientRect(), st = stageEl ? stageEl.getBoundingClientRect() : wrap, z = zoom || 1;
    var ax = Math.max(TRAY_FLYOUT_INSET, (st.left - wrap.left) / z + TRAY_FLYOUT_INSET);
    var ay = Math.max(TRAY_FLYOUT_INSET, (st.top - wrap.top) / z + TRAY_FLYOUT_INSET);
    submenuLevels = [{ ownerId: t.id, parentItemId: null, isStripRoot: true, items: t.items || [], ax: ax, ay: ay }];
    submenuSel = null;
    document.addEventListener('mousedown', onSubmenuDocDown, true);
    renderSubmenu();
  }
  // Measure a rendered flyout row's top-left/right in surfaceWrap-local SURFACE px (× 1/zoom). Used for the rename
  // editor anchor (left) and a nested level's anchor (right). getBoundingClientRect is pixel-exact at any zoom/scroll;
  // jsdom returns zeros (tests assert structure/clicks, not pixel positions).
  function submenuRowRect(rowEl) {
    var wrap = surfaceWrap.getBoundingClientRect(), rr = rowEl.getBoundingClientRect(), z = zoom || 1;
    return { left: (rr.left - wrap.left) / z, right: (rr.right - wrap.left) / z, top: (rr.top - wrap.top) / z };
  }
  // select a flyout row: highlight it, load ITS properties (nested item→Properties), and make it the nested Del/F2/
  // rename target (submenuSel). Stores the row's measured anchor so the rename editor can overlay it even after the
  // flyout closes. Does NOT open a nested level (that's onSubmenuRow's click-navigate step). No-op for an anonymous row.
  function selectSubmenuRow(item, level, rowEl) {
    if (!item || !item.itemId) return;
    var L = submenuLevels[level];
    var g = submenuRowRect(rowEl);
    submenuSel = { ownerId: item.ownerId || (L && L.ownerId), itemId: item.itemId, itemType: item.itemType, text: item.text, ax: g.left, ay: g.top, level: level };
    selectedItem = null;                           // a nested selection isn't the top-level Del/F2 target — drop the stale one
    selection = []; current = null; canMove = false; canResize = false; // a nested item isn't a control — drop any control selection so Cut/Copy/nudge/z-order can't act on a lingering one (parity with selectStripItem)
    vscode.postMessage({ type: 'selectItem', hostId: submenuSel.ownerId, itemId: item.itemId });
    renderSelection();                             // clears the top-level highlight + refreshes the Delete-enabled state
  }
  // update the .sel highlight on the EXISTING flyout rows WITHOUT rebuilding them. A rebuild (renderSubmenu → innerHTML='')
  // would destroy the row element a following dblclick needs — Chromium fires dblclick only when both clicks land on the
  // same element, so a select-click that recreates the row makes dblclick-to-rename a dead gesture. Used for a
  // selection-only click; a structural change (open/close a nested level) still re-renders.
  function updateSubmenuSelClasses() {
    for (var i = 0; i < submenuBoxes.length; i++) {
      var rows = submenuBoxes[i].querySelectorAll('.stripflyoutrow');
      for (var r = 0; r < rows.length; r++) {
        var it = rows[r]._smItem;
        var on = submenuSel && it && it.itemId && it.itemId === submenuSel.itemId;
        // preserve the inert predicate — an in-place className rebuild must NOT re-grant hover/cursor to a dead anonymous
        // leaf (no id, no children); otherwise selecting a sibling makes the dead row look clickable again (mirrors renderSubmenu)
        var inert = !(it && (it.itemId || (it.children && it.children.length)));
        rows[r].className = 'stripflyoutrow' + (inert ? ' inert' : '') + (on ? ' sel' : '');
      }
    }
  }
  // click a flyout row: a field-backed item loads ITS properties + becomes the target; a parent opens its children.
  function onSubmenuRow(item, level, rowEl) {
    var hadDeeper = submenuLevels.length > level + 1;  // a deeper level was open → navigating away rebuilds
    submenuLevels = submenuLevels.slice(0, level + 1); // navigating from this level truncates any deeper open levels
    var L = submenuLevels[level];
    if (item.itemId) selectSubmenuRow(item, level, rowEl);
    // navigating INTO an anonymous (id-less) submenu parent can't select it — but the truncation above may have just
    // removed the DEEPER level that held the previously-selected row, leaving submenuSel pointing at a no-longer-visible
    // item (a wrong-target Delete/F2 with no highlight). Drop the stale selection ONLY when its level was truncated
    // (submenuSel.level > this clicked level); a selection at this level or shallower is still visible → keep it
    // (codex fix-verify: an unconditional clear wrongly dropped a still-valid selection). (review wf_897ba719.)
    else if (submenuSel && submenuSel.level > level) { submenuSel = null; selectedItem = null; renderSelection(); }
    var opened = false;
    if (item.children && item.children.length) {   // parent → open its nested level anchored to the ACTUAL parent row
      var g = submenuRowRect(rowEl);
      submenuLevels.push({ ownerId: item.ownerId || L.ownerId, parentItemId: item.itemId, items: item.children, ax: g.right, ay: g.top });
      opened = true;
    }
    // a purely-selection click updates the highlight IN PLACE (keeps the row element alive so a dblclick can fire on it);
    // only a structural change — a nested level opened, or a deeper one truncated — rebuilds the flyout DOM.
    if (opened || hadDeeper) renderSubmenu(); else updateSubmenuSelClasses();
  }
  // right-click a flyout row → select it + open the item ctx menu (Rename / Delete Item). Reads the row's cached
  // item/level (right-click has no per-row closure). The subsequent menu-item mousedown fires onSubmenuDocDown, which
  // closes the flyout and clears submenuSel — so the menu actions capture the descriptor at build time (buildCtxMenu).
  function onSubmenuCtx(e) {
    e.preventDefault(); e.stopPropagation();
    var rowEl = e.target;
    while (rowEl && !(rowEl.className && String(rowEl.className).indexOf('stripflyoutrow') >= 0)) { if (rowEl.className === 'stripflyout') return; rowEl = rowEl.parentNode; }
    if (!rowEl || !rowEl._smItem || !rowEl._smItem.itemId) return; // padding / separator / anonymous → no menu
    selectSubmenuRow(rowEl._smItem, rowEl._smLevel, rowEl);
    updateSubmenuSelClasses(); // highlight the right-clicked row (selectSubmenuRow doesn't re-render the flyout itself)
    renderCtx(e.clientX, e.clientY);
  }
  // rename the selected nested item: the SAME inline editor as the top-level rename, anchored at the row (stored ax/ay
  // — the flyout closes when openSlotShell runs). Enter posts `stripRename` keyed by the owner strip (the host recurses
  // via findToolStripItem). A separator has no Text so it's inert. `sel` defaults to the live selection (keyboard F2).
  function renameSubmenuSel(sel) {
    sel = sel || submenuSel;
    if (!sel || isSeparatorType(sel.itemType)) return;
    openItemRenameEditor({ ownerId: sel.ownerId, itemId: sel.itemId, text: sel.text, x: sel.ax, y: sel.ay });
  }
  // delete the selected nested item (+ its subtree): the host omits the node from the owner strip's forest (the engine
  // computes removedIds recursively). The commit's fresh layout closes the flyout. A vanished id is a graceful host
  // no-op. `sel` defaults to the live selection (keyboard Del); the ctx menu passes a build-time-captured descriptor.
  function deleteSubmenuSel(sel) {
    sel = sel || submenuSel;
    if (!sel) return;
    vscode.postMessage({ type: 'stripDelete', hostId: sel.ownerId, itemId: sel.itemId });
  }
  function onSubmenuDocDown(e) {
    for (var i = 0; i < submenuBoxes.length; i++) { if (submenuBoxes[i].style.display !== 'none' && submenuBoxes[i].contains(e.target)) return; }
    closeSubmenu();
  }
  function closeSubmenu() {
    document.removeEventListener('mousedown', onSubmenuDocDown, true);
    submenuLevels = []; submenuSel = null; renderSubmenu();
  }
  // open the inline add-editor for a submenu level's trailing "Type Here" slot: append a new item to `parentItemId`'s
  // DropDownItems (the host recurses via findToolStripItem keyed by the owner strip — the same depth-agnostic seam
  // rename/delete use). Measure the slot's surface anchor FIRST (openSlotShell → closeSubmenu hides the flyout), then
  // float the editor there. The editor's type list is the MENU set (a DropDownItems dropdown offers menu-item types).
  function openNestedSlot(ownerId, parentItemId, slotEl, isRoot, level) {
    if (!ownerId) return;                     // parentItemId may be null for an off-tree strip's root slot (top-level add)
    var g = submenuRowRect(slotEl);
    // Stash how to RE-OPEN this flyout after the add commits (the fresh layout closes it → the new item would be hidden).
    // Snapshot the FULL navigation path NOW — submenuLevels is still intact (openSlotShell→closeSubmenu wipes it below).
    // The ROOT descriptor (tray chip / menu-bar dropdown) plus the chain of parentItemIds for levels 1..level lets
    // reopenFlyout replay the descent to ANY depth (each hop re-measures its parent row, since nested children carry no
    // geometry). A level-0 add carries no path (an empty replay collapses to the original root-only reopen). openSlotEditor
    // stashes this on the editor; commitSlotEditor promotes it to the live `slotReopen` ONLY on a real commit.
    var reopen = null;
    var root = submenuLevels[0];
    if (root) {
      if (root.isStripRoot) reopen = { kind: 'tray', ownerId: root.ownerId };
      else if (root.isOverflowRoot) reopen = { kind: 'overflow', ownerId: root.ownerId };
      else if (root.parentItemId) reopen = { kind: 'submenu', topItemId: root.parentItemId };
      if (reopen && level > 0) reopen.path = submenuLevels.slice(1, level + 1).map(function (L) { return L.parentItemId; });
    }
    openSlotEditor({ ownerId: ownerId, parentItemId: parentItemId || null, x: g.left, y: g.top, reopen: reopen });
  }

  // ---- on-canvas "Type Here" inline add-editor: clicking an add-slot opens a small floating popup (item-type
  // <select> + text <input>) anchored at the slot. Enter commits (posts a `stripAdd` gesture — the host fetches the
  // owner's item forest, appends one node, and reuses the ToolStrip commit path); Escape / click-away cancels. The
  // type list is owner-appropriate (menu vs toolbar vs status); a Separator carries no text. Click-away dismissal
  // mirrors the smart-tag flyout. ----
  function toolStripNewTypes(ownerType) {
    var t = ownerType || '';
    if (t.indexOf('StatusStrip') >= 0) return [['ToolStripStatusLabel', 'Status Label'], ['ToolStripProgressBar', 'Progress Bar'], ['ToolStripDropDownButton', 'DropDown Button'], ['ToolStripSplitButton', 'Split Button'], ['ToolStripSeparator', 'Separator']];
    if (t.indexOf('MenuStrip') >= 0) return [['ToolStripMenuItem', 'Menu Item'], ['ToolStripComboBox', 'ComboBox'], ['ToolStripTextBox', 'TextBox'], ['ToolStripSeparator', 'Separator']];
    return [['ToolStripButton', 'Button'], ['ToolStripLabel', 'Label'], ['ToolStripSeparator', 'Separator'], ['ToolStripSplitButton', 'Split Button'], ['ToolStripDropDownButton', 'DropDown Button'], ['ToolStripComboBox', 'ComboBox'], ['ToolStripTextBox', 'TextBox'], ['ToolStripProgressBar', 'Progress Bar']];
  }
  var slotEditEl = null, slotEditSel = null, slotEditInput = null, slotEditOwner = null, slotEditMode = 'add', slotEditItemId = null, slotEditOrig = '', slotEditParentItemId = null, slotEditReopen = null, slotEditOrigType = '';
  // Correlate a canvas-origin `pick` with the host's echoed `select`, so an add-editor can suppress EXACTLY the echo of
  // the pick whose selection it dropped (to disarm the toolbar Delete) — and nothing else. Each canvas pick carries a
  // monotonic token the host echoes back on `select`; `pendingPick` is the last canvas pick not yet echoed. openSlotEditor
  // ADDS that pending token to `suppressPickTokens` IFF it belongs to the slot owner; the `select` handler suppresses only
  // a reply whose token is in that SET (then removes it — each armed pick echoes exactly once, so the set drains itself).
  // A SET, not a scalar: opening a second add-editor while a FIRST pick's echo is still in flight must not lose the first
  // arm (codex review — a scalar overwrite let the first delayed echo re-arm Delete and remove the wrong strip). This
  // supersedes both an earlier `!slotEditEl` lifetime guard AND an id-only suppression, which (codex review) mis-fired
  // under valid orderings: a late echo after the editor closed re-armed Delete; a `layout` without a trailing `select`
  // (a net48 live edit / a skipReselect render) wrongly disarmed it; and an id-only match swallowed a LEGITIMATE later
  // select of the SAME owner. A host-authoritative select (fullRender / a Properties-panel pick) carries NO token → always applied.
  var pickToken = 0, pendingPick = null, suppressPickTokens = new Set();
  function postGenerationBoundCanvasIntent(message) {
    if (lastDrawnGen >= 0) message.gen = lastDrawnGen;
    vscode.postMessage(message);
  }
  // Post a canvas-origin pick AND record it as the pending (not-yet-echoed) pick for select-echo correlation.
  function postPick(id) {
    pendingPick = { token: ++pickToken, id: id };
    // The Properties host needs the complete ordered set for v1.10 multi-object intersection/transactions. The canvas
    // remains the selection authority; the host validates every id against the current rendered layout and bounds it.
    postGenerationBoundCanvasIntent({ type: 'pick', id: id, ids: selection.slice(), token: pickToken });
  }
  function isSeparatorType(t) { return /Separator$/.test(t || ''); }
  function syncSlotEditText() {
    // a separator has no Text → hide the text field (and its width no longer matters); other types show + focus it
    var sep = isSeparatorType(slotEditSel.value);
    slotEditInput.style.display = sep ? 'none' : '';
    if (!sep) { try { slotEditInput.focus(); slotEditInput.select(); } catch (e) {} }
  }
  // Shared shell for the inline strip editor (ADD add-slot / RENAME item): a floating .slotedit box anchored at
  // (x,y) in surface coords. Keys stay local — Enter commits, Escape cancels, everything else is swallowed so canvas
  // keydowns (nudge/Delete/Ctrl-XCVD) never fire while typing (activeElement-guarded too, but stopPropagation is
  // belt-and-suspenders). A capture-phase document mousedown dismisses on click-away (mirrors the smart-tag flyout).
  // The caller fills in the mode-specific children (a type <select> for ADD; a prefilled input for RENAME).
  function openSlotShell(x, y) {
    closeSlotEditor(); // only one editor open at a time
    closeSubmenu();    // an inline add/rename editor supersedes an open submenu flyout (e.g. dblclick-rename on a parent item)
    slotEditEl = document.createElement('div'); slotEditEl.className = 'slotedit';
    slotEditEl.style.left = (x * zoom) + 'px'; slotEditEl.style.top = (y * zoom) + 'px';
    slotEditEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); commitSlotEditor(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSlotEditor(); }
      else { e.stopPropagation(); }
    });
    slotEditEl.addEventListener('mousedown', function (e) { e.stopPropagation(); }); // don't start a marquee/drag
    surfaceWrap.appendChild(slotEditEl);
    document.addEventListener('mousedown', onSlotEditDocDown, true);
  }
  function openSlotEditor(slot) {
    if (!slot || !slot.ownerId) return;
    openSlotShell(slot.x, slot.y);
    slotEditMode = 'add'; slotEditOwner = slot.ownerId; slotEditItemId = null; slotEditParentItemId = slot.parentItemId || null;
    slotEditReopen = slot.reopen || null; // re-open the source flyout after a committed add (see commitSlotEditor + the `tray` handler)
    // an ADD editor has no delete target: drop EVERY lingering delete target so the toolbar Delete can't fire while it's
    // open. Two targets exist — the strip-ITEM selection (selectedItem) AND the CONTROL selection (selection/current).
    // The nested add cleared both via selectStripItem before this; the OFF-TREE tray-strip root add reaches here with the
    // strip still the selected CONTROL (the chip click set selection=[stripId]), so clearing only selectedItem would leave
    // the toolbar Delete armed to remove the WHOLE ContextMenuStrip (a click cancels the editor, then doDelete falls
    // through to selectableIds()=[stripId]). Clearing both makes the Delete button disabled (its enabled state consults
    // selectableIds()+selectedItem+submenuSel), so it can't fire. Rename keeps its selectedItem (the renamed item IS its
    // target), so this lives in openSlotEditor (add-only), not the shared openSlotShell.
    selectedItem = null; selection = []; current = null; canMove = false; canResize = false;
    // if the owner's OWN pick echo is still in flight (the tray chip / on-canvas click that preceded this add), arm
    // suppression of EXACTLY that echo by its token, so its reply can't restore selection=[owner] and re-arm the Delete
    // we just disarmed. ADD (never replace): a still-armed token from an earlier add-editor whose echo hasn't landed yet
    // must survive. If no pick is pending for this owner — its echo already arrived, or the slot was opened without a
    // preceding control pick (e.g. a top-level menu-bar "Type Here") — arm nothing: a later legitimate select applies.
    if (pendingPick && pendingPick.id === slot.ownerId) suppressPickTokens.add(pendingPick.token);
    renderSelection();
    // an off-tree strip (a ContextMenuStrip) isn't in controls[] — it's a tray chip; fall back to the tray so its type
    // drives the type set (a ContextMenuStrip's FullName contains "MenuStrip" → the MENU item set, which is correct).
    var owner = findControl(slot.ownerId) || findTray(slot.ownerId);
    // a nested submenu slot (parentItemId set) always offers the MENU item set (MenuItem/ComboBox/TextBox/Separator) —
    // a DropDownItems dropdown holds menu items regardless of the top-level strip kind; a top-level slot uses the strip's set.
    var types = slot.parentItemId ? toolStripNewTypes('MenuStrip') : toolStripNewTypes(owner ? owner.type : '');
    slotEditSel = document.createElement('select'); slotEditSel.className = 'slotEditType';
    types.forEach(function (pt) { var o = document.createElement('option'); o.value = pt[0]; o.textContent = pt[1]; slotEditSel.appendChild(o); });
    slotEditInput = document.createElement('input'); slotEditInput.type = 'text'; slotEditInput.className = 'slotEditInput';
    slotEditInput.placeholder = T('designer.typeHere');
    slotEditEl.appendChild(slotEditSel); slotEditEl.appendChild(slotEditInput);
    slotEditSel.addEventListener('change', syncSlotEditText);
    syncSlotEditText();
  }
  // RENAME an existing top-level item: the SAME inline editor prefilled with the item's live caption. A TOP-LEVEL,
  // childless, non-separator item ALSO gets a type <select> pre-selected on its current type — changing it RETYPES the
  // item (host = remove old + add a fresh item of the new type at the same position, carrying only Text; type-specific
  // props are lost, hence "data-loss aware"). An item WITH a submenu can't be retyped (the engine can't add a submenu
  // under a new item) and a nested item isn't in stripItems → no select there, text-only rename as before. Enter posts a
  // `stripRename` (text only) or `stripRetype` (type changed) gesture; Escape / click-away / empty caption cancel.
  function openItemRenameEditor(item) {
    if (!item || !item.ownerId || !item.itemId) return;
    openSlotShell(item.x, item.y);
    slotEditMode = 'rename'; slotEditOwner = item.ownerId; slotEditItemId = item.itemId; slotEditSel = null; slotEditOrigType = '';
    // Resolve the item in the fresh TOP-LEVEL geometry: only a top-level item (found here), non-separator, with no
    // children, offers retype. Its owner's type drives the type set (menu vs toolbar vs status). An OVERFLOW-placed item
    // is a top-level Item too (host retype handles it), but it's a CHILD of the id-less chevron rather than a direct
    // stripItems entry → also search chevron children (codex review). A deeper submenu grandchild stays out (not searched).
    var geom = null;
    for (var gi = 0; gi < stripItems.length; gi++) {
      var s = stripItems[gi];
      if (s.isTypeHere) continue;
      if (!s.overflow && s.ownerId === item.ownerId && s.itemId === item.itemId) { geom = s; break; }
      if (s.overflow && s.ownerId === item.ownerId && s.children) {
        for (var ci = 0; ci < s.children.length; ci++) { if (s.children[ci].itemId === item.itemId) { geom = s.children[ci]; break; } }
        if (geom) break;
      }
    }
    var curType = item.itemType || (geom && geom.itemType) || '';
    // The geometry emits an FQN (System.Windows.Forms.ToolStripButton) but toolStripNewTypes values are SHORT names
    // (ToolStripButton) — the same short names the ADD path sends and the engine's ItemFqn resolves. Compare/send SHORT.
    var curShort = curType ? String(curType).split('.').pop() : '';
    var hasChildren = !!(geom && geom.children && geom.children.length);
    if (geom && curType && !isSeparatorType(curType) && !hasChildren) {
      var owner = findControl(item.ownerId) || findTray(item.ownerId);
      var types = toolStripNewTypes(owner ? owner.type : '');
      slotEditOrigType = curShort;
      slotEditSel = document.createElement('select'); slotEditSel.className = 'slotEditType';
      // Guarantee the current type is a selectable, pre-selected option so an untouched confirm never retypes: prepend it
      // when the owner's standard set doesn't list it (an already-exotic item type).
      var present = false;
      for (var ti = 0; ti < types.length; ti++) { if (types[ti][0] === curShort) { present = true; break; } }
      if (!present) { var o0 = document.createElement('option'); o0.value = curShort; o0.textContent = curShort; o0.selected = true; slotEditSel.appendChild(o0); }
      types.forEach(function (pt) { var o = document.createElement('option'); o.value = pt[0]; o.textContent = pt[1]; if (pt[0] === curShort) o.selected = true; slotEditSel.appendChild(o); });
      slotEditSel.value = curShort; // explicit initial selection (belt-and-suspenders: the untouched confirm must not retype)
      slotEditSel.addEventListener('change', syncSlotEditText); // switching to Separator hides the text field (mirrors ADD)
      slotEditEl.appendChild(slotEditSel);
    }
    slotEditInput = document.createElement('input'); slotEditInput.type = 'text'; slotEditInput.className = 'slotEditInput';
    slotEditInput.value = item.text || '';
    slotEditOrig = slotEditInput.value; // baseline AFTER the input sanitizes it (strips CR/LF); an unedited confirm must
    slotEditEl.appendChild(slotEditInput); //  never mutate the source — see the raw-value compare in commitSlotEditor
    try { slotEditInput.focus(); slotEditInput.select(); } catch (e) {} // VS-style: prefill selected so typing replaces
  }
  function onSlotEditDocDown(e) { if (slotEditEl && !slotEditEl.contains(e.target)) closeSlotEditor(); }
  function commitSlotEditor() {
    if (!slotEditEl) return;
    if (slotEditMode === 'rename') {
      var rOwner = slotEditOwner, rItemId = slotEditItemId, rawVal = slotEditInput.value, origVal = slotEditOrig;
      var newType = slotEditSel ? slotEditSel.value : null, origType = slotEditOrigType;
      closeSlotEditor();
      var typeChanged = !!(newType && origType && newType !== origType);
      // Compare the RAW input value against the prefill baseline: an unedited open+Enter (same text AND same type) must
      // post nothing. Trimming (below) and the host's target.text!==newText guard both normalize, so without this a no-op
      // confirm on a caption with leading/trailing space (or a newline the input stripped) would silently rewrite the
      // source (review wf_df230de7).
      if (rawVal === origVal && !typeChanged) return;
      if (typeChanged) {
        // RETYPE = remove the old item + add a fresh one of the new type at the SAME position (host applyStripRetype).
        // Data-loss aware: only Text + position carry over; type-specific props (Image/ShortcutKeys/…) reset. Carry the
        // RAW caption (NOT trimmed): the contract is "carry Text", so a type-only change on a padded caption ("  Save  ")
        // must not silently trim it (codex review). A separator target carries no text.
        vscode.postMessage({ type: 'stripRetype', hostId: rOwner, itemId: rItemId, itemType: newType, text: isSeparatorType(newType) ? '' : rawVal });
        return;
      }
      var newText = rawVal.trim();
      if (newText === '') return; // an emptied caption = no rename (VS keeps the old text; the engine rejects blank Text)
      vscode.postMessage({ type: 'stripRename', hostId: rOwner, itemId: rItemId, text: newText });
      return;
    }
    var itemType = slotEditSel.value, owner = slotEditOwner, parentItemId = slotEditParentItemId, reopen = slotEditReopen;
    var sep = isSeparatorType(itemType);
    var text = sep ? '' : slotEditInput.value.trim();
    closeSlotEditor();
    // a non-separator with no text adds nothing (VS: an empty "Type Here" commits no item)
    if (!sep && text === '') return;
    // Arm the flyout RE-OPEN for after this add's round-trip (the commit's fresh layout closes the flyout, hiding the new
    // item). Mint a monotonic token, stamp both the arm and the outgoing stripAdd with it: the host echoes it back on
    // stripAddDone once THIS add's outcome is known, and the canvas reopens ONLY on a matching-token ok:true (an empty/
    // cancelled add returned above / discarded the descriptor in closeSlotEditor, so it never arms).
    var reopenToken;
    if (reopen) { reopenToken = ++reopenSeq; slotReopen = { token: reopenToken, kind: reopen.kind, ownerId: reopen.ownerId, topItemId: reopen.topItemId, path: reopen.path }; }
    // parentItemId (set only for a nested submenu slot) tells the host to append into that item's DropDownItems instead
    // of the strip's top level; omit it for a top-level add so the message shape is unchanged there.
    vscode.postMessage({ type: 'stripAdd', hostId: owner, itemType: itemType, text: text, parentItemId: parentItemId || undefined, reopenToken: reopenToken });
  }
  function closeSlotEditor() {
    document.removeEventListener('mousedown', onSlotEditDocDown, true);
    if (slotEditEl && slotEditEl.parentNode) slotEditEl.parentNode.removeChild(slotEditEl);
    slotEditEl = null; slotEditSel = null; slotEditInput = null; slotEditOwner = null; slotEditMode = 'add'; slotEditItemId = null; slotEditOrig = ''; slotEditParentItemId = null; slotEditReopen = null; slotEditOrigType = '';
  }

  function findControl(id) { for (var i = 0; i < controls.length; i++) { if (controls[i].id === id) return controls[i]; } return null; }
  function findTray(id) { for (var i = 0; i < tray.length; i++) { if (tray[i].id === id) return tray[i]; } return null; }
  function findStripItemById(id) { if (!id) return null; for (var i = 0; i < stripItems.length; i++) { if (stripItems[i].itemId === id) return stripItems[i]; } return null; }
  // Re-open a flyout after a committed add (armed as `slotReopen`, consumed by the token-matched `stripAddDone` once the
  // fresh forest+tray have arrived). Opens the ROOT (tray chip / menu-bar dropdown), then replays the saved descent path
  // (rr.path = parentItemId per level below the root) so a DEEP nested add re-reveals its new item at the right level. A
  // vanished owner/item (strip/item removed meanwhile) is a graceful no-op / partial reopen.
  function reopenFlyout(rr) {
    if (!rr) return;
    if (rr.kind === 'tray') { var t = findTray(rr.ownerId); if (!t) return; openTrayStripFlyout(t); }
    else if (rr.kind === 'submenu') { var it = findStripItemById(rr.topItemId); if (!it) return; openSubmenu(it); }
    else if (rr.kind === 'overflow') { var ch = findOverflowChevron(rr.ownerId); if (!ch) return; openOverflowFlyout(ch); }
    else return;
    if (rr.path && rr.path.length) reopenNestedPath(rr.path);
  }
  // The strip's overflow chevron geometry in the current top-level layout (id-less, overflow=true), or null. Used to
  // re-open the overflow flyout after a deeper nested add committed against an overflowed item's submenu.
  function findOverflowChevron(ownerId) {
    for (var i = 0; i < stripItems.length; i++) { var it = stripItems[i]; if (it.overflow && it.ownerId === ownerId) return it; }
    return null;
  }
  // Replay a saved navigation path to re-open a DEEP flyout: for each hop, find the parent row (by field id) in the
  // current deepest level, measure it, and push its children level — the same push-and-measure onSubmenuRow does on a
  // click. Runs synchronously right after the root render (rows are already in the DOM); stops at a vanished/childless
  // hop (a graceful partial reopen). Renders each pushed level so the next hop can find its rows.
  function reopenNestedPath(path) {
    for (var i = 0; i < path.length; i++) {
      var lvl = submenuLevels.length - 1, box = submenuBoxes[lvl];
      if (!box) return;
      var rows = box.querySelectorAll('.stripflyoutrow'), rowEl = null, item = null;
      for (var r = 0; r < rows.length; r++) { if (rows[r]._smItem && rows[r]._smItem.itemId === path[i]) { rowEl = rows[r]; item = rows[r]._smItem; break; } }
      if (!rowEl || !item || !item.children || !item.children.length) return; // the path item vanished / lost its submenu → partial reopen
      var g = submenuRowRect(rowEl);
      submenuLevels.push({ ownerId: item.ownerId || submenuLevels[lvl].ownerId, parentItemId: item.itemId, items: item.children, ax: g.right, ay: g.top });
      renderSubmenu();
    }
  }

  // ---- component tray: non-visual components as a strip below the surface; click to select ----
  function renderTray() {
    if (!trayEl) return;
    trayEl.innerHTML = '';
    if (!tray.length) { trayEl.style.display = 'none'; return; }
    trayEl.style.display = '';
    trayEl.setAttribute('role', 'list');
    trayEl.setAttribute('aria-label', T('designer.tray.aria'));
    tray.forEach(function (t) {
      var chip = document.createElement('div');
      chip._trayId = t.id;                       // lets updateTraySelClasses() re-highlight without a rebuild
      chip.className = 'trayItem' + (t.id === current ? ' sel' : '');
      chip.tabIndex = 0;
      chip.setAttribute('role', 'listitem');
      chip.setAttribute('aria-label', (t.name || t.id) + ' : ' + shortType(t.type));
      chip.setAttribute('aria-selected', t.id === current ? 'true' : 'false');
      if (t.iconPng) {
        var icon = document.createElement('img'); icon.className = 'trayIcon'; icon.alt = ''; icon.draggable = false;
        icon.src = 'data:image/png;base64,' + t.iconPng; chip.appendChild(icon);
      }
      var text = document.createElement('span'); text.textContent = t.name + ' : ' + shortType(t.type); chip.appendChild(text);
      chip.title = t.id + ' : ' + t.type;
      chip.addEventListener('click', function () {
        // a tray component has no visual bounds → clear the canvas selection box, drive the Properties panel
        selectedItem = null;
        selection = [t.id]; current = t.id; canMove = false; canResize = false;
        renderSelection(); updateTraySelClasses(); postPick(t.id);
        // an off-tree strip (a ContextMenuStrip) also opens its synthetic items flyout — the on-canvas reach into its
        // Items (Properties / rename / delete / add), the tray-chip counterpart of a menu-bar item's dropdown. A
        // non-strip chip (Timer/ImageList/…) has no items → openTrayStripFlyout closes any open flyout instead.
        openTrayStripFlyout(t);
      });
      chip.addEventListener('keydown', function (ev) {
        if (ev.key !== 'Enter' && ev.key !== ' ') return;
        ev.preventDefault();
        chip.click();
      });
      chip.addEventListener('dblclick', function (ev) {
        ev.preventDefault(); ev.stopPropagation();
        beginTrayRename(chip, t);
      });
      trayEl.appendChild(chip);
    });
  }
  // update the .sel highlight on the EXISTING chips WITHOUT rebuilding them, for the same Chromium reason spelled out
  // on updateSubmenuSelClasses: dblclick fires only when both clicks land on the SAME element, so a select-click that
  // recreates the chip makes dblclick-to-rename a dead gesture. A rebuild (renderTray) stays for structural changes —
  // when the tray's contents actually change. This also keeps an open inline rename input alive across a late
  // selection echo from the host.
  function updateTraySelClasses() {
    if (!trayEl) return;
    for (var i = 0; i < trayEl.children.length; i++) {
      var chip = trayEl.children[i];
      if (!chip._trayId) continue;
      chip.className = 'trayItem' + (chip._trayId === current ? ' sel' : '');
      chip.setAttribute('aria-selected', chip._trayId === current ? 'true' : 'false');
    }
  }
  function beginTrayRename(chip, item) {
    var input = document.createElement('input'); input.type = 'text'; input.className = 'trayRename';
    input.value = item.name || item.id; input.spellcheck = false;
    chip.textContent = ''; chip.appendChild(input);
    var finished = false;
    function finish(commit) {
      if (finished) return;
      finished = true;
      var next = input.value.trim();
      if (commit && next && next !== item.id) vscode.postMessage({ type: 'trayRename', id: item.id, newName: next });
      else renderTray();
    }
    input.addEventListener('click', function (ev) { ev.stopPropagation(); });
    input.addEventListener('dblclick', function (ev) { ev.stopPropagation(); });
    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
      else if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', function () { finish(true); });
    setTimeout(function () { input.focus(); input.select(); }, 0);
  }
  function setStatus(s) { statusEl.textContent = s || ''; }
  function shortType(t) { var i = t.lastIndexOf('.'); return i < 0 ? t : t.slice(i + 1); }
  function selectableIds() { var r = []; for (var i = 0; i < selection.length; i++) { if (selection[i] && selection[i] !== 'this') r.push(selection[i]); } return r; }

  var lastDrawnGen = -1;
  var latestRenderGen = -1;
  function canvasHasPendingRender() { return latestRenderGen > lastDrawnGen; }
  function setStaleCanvasStatus() { setStatus('STALE_CANVAS'); }
  function ignorePendingRenderInput(e) {
    if (!canvasHasPendingRender()) return false;
    if (e) {
      if (e.preventDefault) e.preventDefault();
      if (e.stopPropagation) e.stopPropagation();
    }
    setStaleCanvasStatus();
    return true;
  }
  function drawPng(b64, dx, dy, dw, dh, full, gen) {
    var g = (typeof gen === 'number') ? gen : (lastDrawnGen + 1);
    if (g > latestRenderGen) latestRenderGen = g;
    var img = new Image();
    img.onload = function () {
      if (g < lastDrawnGen || g < latestRenderGen) return;
      lastDrawnGen = g;
      if (full) {
        // Backing store = the PNG's REAL pixel size (the engine uses a safe integer capture scale, so text is crisp on
        // high-DPI displays instead of an upscaled blur). natW/natH stay the LOGICAL form size so zoom, overlays and
        // hit-testing keep working in form pixels; CSS size is logical×zoom (applyZoomStyles). natScale (physical/logical)
        // drives image-rendering — a high-DPI backing must NOT be pixelated (that would throw away the extra pixels).
        canvas.width = img.naturalWidth || dw; canvas.height = img.naturalHeight || dh;
        natW = dw; natH = dh; natScale = (dw > 0 && img.naturalWidth) ? (img.naturalWidth / dw) : 1;
        applyZoomStyles(); ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      }
      else {
        // Patch coordinates are always logical form pixels; the backing canvas can be a 2x DPI capture. Composite in
        // backing pixels so the scaled PNG replaces exactly the same logical dirty rectangle without blur or drift.
        var px = dx * natScale, py = dy * natScale, pw = dw * natScale, ph = dh * natScale;
        ctx.clearRect(px, py, pw, ph); ctx.drawImage(img, px, py, pw, ph);
      }
    };
    img.onerror = function () { /* leave the prior frame; a later event refreshes */ };
    img.src = 'data:image/png;base64,' + b64;
  }

  // ---- zoom (display scaling) ----
  var zoom = 1;
  var natW = 1, natH = 1;
  var natScale = 1; // physical PNG px / logical form px (the engine's DPI capture scale) — 1 unless rendered high-DPI
  var ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 2, 3, 4];
  var zoomOutEl = document.getElementById('zoomOut');
  var zoomInEl = document.getElementById('zoomIn');
  var zoomLabelEl = document.getElementById('zoomLabel');
  var zoomFitEl = document.getElementById('zoomFit');
  var stageEl = document.getElementById('stage');
  var _persisted = {};
  try { _persisted = (vscode.getState && vscode.getState()) || {}; } catch (_e) {}
  // The form notice is a permanent disclosure, but it does not have to occupy a strip forever: collapsing leaves
  // the icon (with the full text as its tooltip) and remembers the choice for this editor, like zoom and the ruler.
  var noticeCollapsed = _persisted.noticeCollapsed === true;
  var formNoticeCollapseEl = document.getElementById('formNoticeCollapse');
  function applyNoticeCollapsed() {
    if (!formNoticeEl) return;
    formNoticeEl.classList.toggle('collapsed', noticeCollapsed);
    if (formNoticeCollapseEl) {
      formNoticeCollapseEl.textContent = noticeCollapsed ? '▸' : '▾';
      formNoticeCollapseEl.title = T(noticeCollapsed ? 'designer.notice.expand' : 'designer.notice.collapse');
    }
  }
  function setNoticeCollapsed(value) {
    noticeCollapsed = value;
    try { var s = (vscode.getState && vscode.getState()) || {}; s.noticeCollapsed = value; if (vscode.setState) vscode.setState(s); } catch (_e) {}
    applyNoticeCollapsed();
  }
  if (formNoticeCollapseEl) {
    formNoticeCollapseEl.addEventListener('click', function (e) { e.stopPropagation(); setNoticeCollapsed(!noticeCollapsed); });
  }
  if (formNoticeEl) {
    formNoticeEl.addEventListener('click', function () { if (noticeCollapsed) setNoticeCollapsed(false); });
  }

  function clampZoom(z) { return Math.max(0.1, Math.min(8, z)); }
  if (typeof _persisted.zoom === 'number') zoom = clampZoom(_persisted.zoom);
  function applyZoomStyles() {
    canvas.style.width = (natW * zoom) + 'px'; canvas.style.height = (natH * zoom) + 'px';
    surfaceWrap.style.width = (natW * zoom) + 'px'; surfaceWrap.style.height = (natH * zoom) + 'px';
    // Pixelate only a genuine upscale of a 1x render (crisp VS-style zoom-in). A high-DPI backing (natScale > 1) already
    // has the pixels, so 'auto' lets the browser resample it cleanly instead of nearest-neighbour throwing detail away.
    canvas.style.imageRendering = (zoom >= 1 && natScale <= 1) ? 'pixelated' : 'auto';
    if (zoomLabelEl) zoomLabelEl.textContent = Math.round(zoom * 100) + '%';
    renderSelection();
    renderRuler();
    renderGrid();
  }
  function setZoom(z) {
    closeSlotEditor(); closeSubmenu(); clearStripDropFeedback(); zoom = clampZoom(z);
    try { var s = (vscode.getState && vscode.getState()) || {}; s.zoom = zoom; if (vscode.setState) vscode.setState(s); } catch (_e) {}
    queueCanvasState();
    applyZoomStyles();
  }
  function stepZoom(dir) {
    var idx = 0, best = Infinity;
    for (var i = 0; i < ZOOM_STEPS.length; i++) { var d = Math.abs(ZOOM_STEPS[i] - zoom); if (d < best) { best = d; idx = i; } }
    idx = Math.max(0, Math.min(ZOOM_STEPS.length - 1, idx + dir));
    setZoom(ZOOM_STEPS[idx]);
  }
  function fitZoom() {
    if (!stageEl || natW <= 0 || natH <= 0) return;
    var pad = 32;
    setZoom(Math.max(0.1, Math.min(4, Math.min((stageEl.clientWidth - pad) / natW, (stageEl.clientHeight - pad) / natH))));
  }
  if (zoomOutEl) zoomOutEl.addEventListener('click', function () { stepZoom(-1); });
  if (zoomInEl) zoomInEl.addEventListener('click', function () { stepZoom(1); });
  if (zoomLabelEl) zoomLabelEl.addEventListener('click', function () { setZoom(1); });
  if (zoomFitEl) zoomFitEl.addEventListener('click', fitZoom);

  // ---- pixel ruler (toggled by the toolbar button; ticks in form-pixels scaled by zoom, around the surface) ----
  var rulerToggleEl = document.getElementById('rulerToggle');
  var rulerOn = !!_persisted.ruler;
  var rulerHEl = null, rulerVEl = null;
  function ensureRulers() {
    if (!rulerHEl) { rulerHEl = document.createElement('div'); rulerHEl.className = 'ruler rulerH'; surfaceWrap.appendChild(rulerHEl); }
    if (!rulerVEl) { rulerVEl = document.createElement('div'); rulerVEl.className = 'ruler rulerV'; surfaceWrap.appendChild(rulerVEl); }
  }
  function makeTicks(host, vertical) {
    host.innerHTML = '';
    var extent = vertical ? natH : natW, minor = 10, major = 50;
    for (var p = 0; p <= extent; p += minor) {
      var d = p * zoom;
      var t = document.createElement('div');
      t.className = 'tick' + (p % major === 0 ? ' maj' : '');
      if (vertical) t.style.top = d + 'px'; else t.style.left = d + 'px';
      host.appendChild(t);
      if (p % major === 0 && p > 0) {
        var l = document.createElement('div'); l.className = 'lab'; l.textContent = p;
        if (vertical) l.style.top = (d + 1) + 'px'; else l.style.left = (d + 2) + 'px';
        host.appendChild(l);
      }
    }
  }
  function renderRuler() {
    if (rulerToggleEl) { rulerToggleEl.className = rulerOn ? 'active' : ''; rulerToggleEl.textContent = rulerOn ? T('designer.ruler.hide') : T('designer.ruler.show'); }
    if (!rulerOn) {
      if (rulerHEl) rulerHEl.style.display = 'none';
      if (rulerVEl) rulerVEl.style.display = 'none';
      if (stageEl) stageEl.style.padding = '16px';
      return;
    }
    ensureRulers();
    if (stageEl) stageEl.style.padding = '30px 16px 16px 34px';
    rulerHEl.style.display = 'block'; rulerVEl.style.display = 'block';
    rulerHEl.style.width = (natW * zoom) + 'px';
    rulerVEl.style.height = (natH * zoom) + 'px';
    makeTicks(rulerHEl, false);
    makeTicks(rulerVEl, true);
  }
  if (rulerToggleEl) rulerToggleEl.addEventListener('click', function () {
    rulerOn = !rulerOn;
    try { var s = (vscode.getState && vscode.getState()) || {}; s.ruler = rulerOn; if (vscode.setState) vscode.setState(s); } catch (_e) {}
    renderRuler();
    renderSelection(); // refresh the on-ruler object-bounds markers for the current selection
  });
  // ruler object-bounds markers: highlight the selected (or dragging) control's extent on the H/V rulers with
  // dashed edges, so the ruler actually shows where the object is. Kept as surfaceWrap siblings (not ruler
  // children) so makeTicks' innerHTML reset can't wipe them.
  var rulerHMark = null, rulerVMark = null;
  function ensureRulerMarks() {
    if (!rulerHMark) { rulerHMark = document.createElement('div'); rulerHMark.className = 'rulerMark rulerMarkH'; rulerHMark.style.display = 'none'; surfaceWrap.appendChild(rulerHMark); }
    if (!rulerVMark) { rulerVMark = document.createElement('div'); rulerVMark.className = 'rulerMark rulerMarkV'; rulerVMark.style.display = 'none'; surfaceWrap.appendChild(rulerVMark); }
  }
  function updateRulerMarks(rect) {
    ensureRulerMarks();
    if (!rulerOn || !rect) { rulerHMark.style.display = 'none'; rulerVMark.style.display = 'none'; return; }
    rulerHMark.style.display = 'block'; rulerHMark.style.left = (rect.x * zoom) + 'px'; rulerHMark.style.width = Math.max(1, rect.w * zoom) + 'px';
    rulerVMark.style.display = 'block'; rulerVMark.style.top = (rect.y * zoom) + 'px'; rulerVMark.style.height = Math.max(1, rect.h * zoom) + 'px';
  }
  document.addEventListener('keydown', function (e) {
    if (!e.ctrlKey && !e.metaKey) return;
    var ae = document.activeElement;
    if (ae && /^(INPUT|SELECT|TEXTAREA)$/.test(ae.tagName)) return;
    if (e.key === '=' || e.key === '+') { e.preventDefault(); stepZoom(1); }
    else if (e.key === '-' || e.key === '_') { e.preventDefault(); stepZoom(-1); }
    else if (e.key === '0') { e.preventDefault(); setZoom(1); }
  });
  if (stageEl) stageEl.addEventListener('wheel', function (e) {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    setZoom(zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
  }, { passive: false });

  // position the primary selection box (#sel) + its handles for `id`
  function positionPrimary(id) {
    var c = findControl(id);
    if (!c) { selBox.style.display = 'none'; if (lockBadgeEl) lockBadgeEl.style.display = 'none'; return; } // e.g. a tray component is current
    selBox.style.display = 'block';
    selBox.style.left = (c.x * zoom) + 'px'; selBox.style.top = (c.y * zoom) + 'px';
    selBox.style.width = Math.max(0, c.width * zoom - 2) + 'px'; selBox.style.height = Math.max(0, c.height * zoom - 2) + 'px';
    var formOnly = c.isRoot || c.id === 'this';
    var locked = isLocked(id) && !formOnly;   // a locked control shows no grab handles (VS: locked = not sizeable)
    selBox.classList.toggle('locked', locked);
    var showHandles = canResize && selection.length <= 1 && !locked;
    HANDLE_DIRS.forEach(function (dir) {
      var show = showHandles && (!formOnly || dir === 'e' || dir === 's' || dir === 'se');
      handles[dir].style.display = show ? 'block' : 'none';
    });
    // lock glyph pinned to the control's top-left corner (VS-style lock affordance)
    ensureLockBadge();
    if (locked) { lockBadgeEl.style.display = 'block'; lockBadgeEl.style.left = (c.x * zoom) + 'px'; lockBadgeEl.style.top = (c.y * zoom) + 'px'; }
    else lockBadgeEl.style.display = 'none';
  }
  var lockBadgeEl = null;
  function ensureLockBadge() { if (!lockBadgeEl) { lockBadgeEl = document.createElement('div'); lockBadgeEl.className = 'lockbadge'; lockBadgeEl.textContent = '🔒'; lockBadgeEl.title = T('designer.menu.lockControls'); lockBadgeEl.style.display = 'none'; surfaceWrap.appendChild(lockBadgeEl); } return lockBadgeEl; }
  // render the WHOLE selection: primary box + handles, outline boxes for the rest, name/Delete state.
  function renderSelection() {
    renderStripItemSel(); // validate/position the on-canvas item highlight FIRST (may clear a vanished selectedItem)
    if (!current) { selBox.style.display = 'none'; if (lockBadgeEl) lockBadgeEl.style.display = 'none'; }
    else positionPrimary(current);
    var n = 0;
    for (var i = 0; i < selection.length; i++) {
      var id = selection[i]; if (id === current) continue;
      var c = findControl(id); if (!c) continue;
      var b = secBox(n++); b.style.display = 'block';
      b.style.left = (c.x * zoom) + 'px'; b.style.top = (c.y * zoom) + 'px';
      b.style.width = Math.max(0, c.width * zoom - 2) + 'px'; b.style.height = Math.max(0, c.height * zoom - 2) + 'px';
    }
    for (; n < secBoxes.length; n++) secBoxes[n].style.display = 'none';
    var pc = current ? findControl(current) : null;
    if (selection.length > 1) selName.textContent = TN('designer.sel.multi', selection.length);
    else if (pc) selName.textContent = (pc.isRoot ? pc.name + T('designer.formSuffix') : pc.name) + ' : ' + shortType(pc.type);
    else { var ti = current ? findTray(current) : null; selName.textContent = ti ? (ti.name + ' : ' + shortType(ti.type)) : '—'; }
    if (deleteCtlEl) deleteCtlEl.disabled = selectableIds().length === 0 && !selectedItem && !submenuSel; // a selected strip item (top-level or nested) is deletable too
    // the align/distribute/same-size tools apply only to a live 2+ selection on a rendered form — never show
    // them before the first render or while (re)loading (a stale retained selection would otherwise flash them)
    // ...and never while the selection contains a locked control (align/distribute/make-same-size would move/resize it)
    var locked = selectionHasLocked();
    if (alignEl) alignEl.style.display = (hasRendered && selection.length >= 2 && !locked) ? '' : 'none';
    // center-in-form works on a single control too (centers it in its parent), so it shows from 1+ selection —
    // but only when a VISUAL control is selected (a non-visual tray component has no bounds to center), never locked
    if (centerFormEl) {
      var hasVisualSel = false, sids = selectableIds();
      for (var ci = 0; ci < sids.length; ci++) { if (findControl(sids[ci])) { hasVisualSel = true; break; } }
      centerFormEl.style.display = (hasRendered && hasVisualSel && !locked) ? '' : 'none';
    }
    renderContainers();
    renderStripSlots();
    renderTabBadges();
    renderAnchors();
    renderDesignerAdorners();
    renderSmartTag();
    updateRulerMarks(pc && !pc.isRoot ? { x: pc.x, y: pc.y, w: pc.width, h: pc.height } : null);
  }

  // ---- on-canvas smart-tag "Tasks" flyout (VS/DevExpress-style): a chevron glyph pinned to the selected control's
  // top-right corner; clicking it opens the property items supplied by the control's real ComponentDesigner /
  // DesignerActionList, edited inline through the SAME source-first 'edit' message as the property grid. ----
  var tasksState = null;   // { id, comp } for the current single selection (from the host 'tasks' message)
  var smartTagEl = null;
  var flyoutEl = null;
  var flyoutOwner = null;  // the control id the open flyout edits
  function taskListFor(comp) {
    if (!comp || !Array.isArray(comp.properties) || !Array.isArray(comp.designerActions)) return [];
    var properties = {};
    for (var i = 0; i < comp.properties.length; i++) {
      var p = comp.properties[i];
      if (p && !p.readOnly && typeof p.name === 'string' && properties[p.name] === undefined) properties[p.name] = p;
    }
    var found = [];
    for (var j = 0; j < comp.designerActions.length; j++) {
      var action = comp.designerActions[j];
      var property = action && properties[action.propertyName];
      if (!property) continue;
      found.push(Object.assign({}, property, {
        taskDisplayName: action.displayName || property.name,
        taskCategory: action.category || '',
        taskDescription: action.description || '',
      }));
    }
    return found;
  }
  function commandListFor(comp) {
    if (!comp || !Array.isArray(comp.designerActions)) return [];
    var found = [];
    for (var i = 0; i < comp.designerActions.length; i++) {
      var action = comp.designerActions[i];
      if (!action || typeof action.commandId !== 'string' || !action.commandId
        || typeof action.certificationId !== 'string' || !action.certificationId) continue;
      found.push(action);
    }
    return found;
  }
  function sameSet(arr, want) {
    if (!arr || arr.length !== want.length) return false;
    for (var i = 0; i < want.length; i++) if (arr.indexOf(want[i]) < 0) return false;
    return true;
  }
  // The vendor's declared Tasks menu for the current selection (DevExpress "Add Tab Page"…), as sent by the host.
  // Labels are the vendor's own; the verb each one runs is OURS (a source-first edit) — an entry with no verb is shown
  // disabled rather than hidden, so the menu still reads like the vendor's.
  function vendorTagsNow() {
    return (tasksState && tasksState.id === current && tasksState.vendorTags) ? tasksState.vendorTags : [];
  }
  /** The tab host's ACTIVE page. The engine's layout only emits controls on the currently-shown surface (it excludes
   *  a standard TabControl's hidden pages by Control.Visible, and a vendor tab control's non-selected pages by a
   *  reflective SelectedTabPage check), so the host's one visible child IS the active page. Where that does NOT hold —
   *  two children surfaced, i.e. the engine could not tell which page is active, or the children aren't pages at all —
   *  we return null and the verb goes inert: this feeds a .Designer.cs DELETION, so ambiguity must fail closed rather
   *  than guess a page. */
  function activePageOf(hostId) {
    var found = null;
    for (var i = 0; i < controls.length; i++) {
      if (controls[i].parentId !== hostId) continue;
      if (found) return null;   // ambiguous → refuse rather than delete the wrong page
      found = controls[i];
    }
    return found;
  }
  /** Whether WE can honour a vendor verb right now. The vendor's method name is a LABEL, never authority: any assembly
   *  can declare an attribute of that name, and we do not evaluate the vendor's own SmartTagFilter (running vendor code
   *  is exactly what this design avoids). So every source-writing verb is gated on OUR OWN facts about the selected
   *  control — the engine's isTabHost and a resolvable active page — not on the declared name. */
  function vendorEnabled(v) {
    if (!v || !v.verb) return false;
    var c = current ? findControl(current) : null;
    if (!c) return false;
    if (v.verb === 'addTab') return !!c.isTabHost;
    if (v.verb === 'deleteTab') return !!c.isTabHost && !!activePageOf(current);
    return true;   // showProperties writes nothing
  }
  function renderSmartTag() {
    var comp = (tasksState && tasksState.id === current) ? tasksState.comp : null;
    var c = current ? findControl(current) : null;
    var show = !tabOrderMode && !drag && selection.length === 1 && !!c && !!comp &&
      (taskListFor(comp).length > 0 || commandListFor(comp).length > 0 || vendorTagsNow().length > 0);
    if (!smartTagEl) {
      smartTagEl = document.createElement('div'); smartTagEl.className = 'smarttag'; smartTagEl.textContent = '▸'; // ▸
      smartTagEl.title = 'Tasks';
      smartTagEl.addEventListener('mousedown', function (e) { e.stopPropagation(); });
      smartTagEl.addEventListener('click', function (e) { e.stopPropagation(); if (flyoutEl) closeFlyout(); else openFlyout(); });
      surfaceWrap.appendChild(smartTagEl);
    }
    if (!show) { smartTagEl.style.display = 'none'; if (flyoutEl) closeFlyout(); return; }
    smartTagEl.style.display = 'block';
    smartTagEl.style.left = Math.round((c.x + c.width) * zoom - 16) + 'px';
    smartTagEl.style.top = Math.round(c.y * zoom + 1) + 'px';
    if (flyoutEl) { if (flyoutOwner !== current) closeFlyout(); else positionFlyout(); }
  }
  function closeFlyout() {
    if (flyoutEl && flyoutEl.parentNode) flyoutEl.parentNode.removeChild(flyoutEl);
    flyoutEl = null; flyoutOwner = null;
    document.removeEventListener('mousedown', onFlyoutOutside, true);
    document.removeEventListener('keydown', onFlyoutKey, true);
  }
  function onFlyoutOutside(e) {
    if (!flyoutEl) return;
    if (flyoutEl.contains(e.target)) return;
    if (smartTagEl && smartTagEl.contains(e.target)) return;
    closeFlyout();
  }
  function onFlyoutKey(e) { if (e.key === 'Escape' && flyoutEl) { e.stopPropagation(); closeFlyout(); } }
  function positionFlyout() {
    if (!flyoutEl || !smartTagEl) return;
    var r = smartTagEl.getBoundingClientRect();
    var w = flyoutEl.offsetWidth || 240, h = flyoutEl.offsetHeight || 120;
    var left = Math.max(6, Math.min(r.right - w, window.innerWidth - w - 6));
    var top = r.bottom + 4; if (top + h > window.innerHeight - 6) top = Math.max(6, r.top - h - 4);
    flyoutEl.style.left = Math.round(left) + 'px';
    flyoutEl.style.top = Math.round(top) + 'px';
  }
  function openFlyout() {
    var comp = (tasksState && tasksState.id === current) ? tasksState.comp : null;
    var c = current ? findControl(current) : null;
    if (!comp || !c) return;
    closeFlyout();
    flyoutOwner = current;
    flyoutEl = document.createElement('div'); flyoutEl.className = 'taskfly';
    var title = document.createElement('div'); title.className = 'tfTitle';
    title.textContent = T('designer.smartTag.title', { type: shortType(comp.type) });
    flyoutEl.appendChild(title);
    // the vendor's own verbs first (as its panel orders them), then our curated property rows
    var vtags = vendorTagsNow();
    var commands = commandListFor(comp);
    if (vtags.length || commands.length) {
      var vbox = document.createElement('div'); vbox.className = 'tfVerbs';
      for (var vi = 0; vi < vtags.length; vi++) vbox.appendChild(vendorRow(vtags[vi]));
      for (var ci = 0; ci < commands.length; ci++) vbox.appendChild(commandRow(commands[ci]));
      flyoutEl.appendChild(vbox);
    }
    var tasks = taskListFor(comp);
    if (!tasks.length) {
      if (!vtags.length && !commands.length) {
        var note = document.createElement('div'); note.className = 'tfNote'; note.textContent = T('designer.smartTag.noTasks'); flyoutEl.appendChild(note);
      }
    } else {
      var pbox = document.createElement('div'); pbox.className = 'tfProps';
      for (var i = 0; i < tasks.length; i++) pbox.appendChild(taskRow(comp, tasks[i]));
      flyoutEl.appendChild(pbox);
    }
    var links = document.createElement('div'); links.className = 'tfLinks';
    var all = document.createElement('div'); all.className = 'tfLink'; all.textContent = T('designer.menu.allProperties');
    all.addEventListener('click', function () { closeFlyout(); vscode.postMessage({ type: 'showProperties' }); });
    links.appendChild(all);
    var learn = document.createElement('div'); learn.className = 'tfLink'; learn.textContent = T('designer.menu.learnMore');
    learn.addEventListener('click', function () { closeFlyout(); vscode.postMessage({ type: 'learnMore', typeName: comp.type }); });
    links.appendChild(learn);
    flyoutEl.appendChild(links);
    document.body.appendChild(flyoutEl);
    positionFlyout();
    setTimeout(function () { document.addEventListener('mousedown', onFlyoutOutside, true); document.addEventListener('keydown', onFlyoutKey, true); }, 0);
  }
  /** One vendor-declared verb row. The label is the vendor's; clicking runs OUR source-first equivalent (the same
   *  message the canvas context menu sends). A verb we can't express — or can't right now (no tab page to remove) —
   *  renders inert with a tooltip saying why, never a no-op that looks like it worked. */
  function vendorRow(v) {
    var owner = current;
    var row = document.createElement('div');
    var on = vendorEnabled(v);
    row.className = 'tfVerb' + (on ? '' : ' tfDisabled');
    row.textContent = v.label;
    if (!on) {
      row.title = v.verb ? T('designer.smartTag.vendorNoTarget') : T('designer.smartTag.vendorUnsupported');
      return row;
    }
    row.addEventListener('click', function () {
      // Re-check at CLICK time, not just at render time. renderSelection retracts the flyout when the selection moves,
      // but these verbs write .Designer.cs, so they must not rest on that being airtight: re-prove the row still owns
      // the current selection and the operation still applies before posting anything.
      if (owner !== current || !vendorEnabled(v)) { closeFlyout(); return; }
      if (v.closesPanel) closeFlyout();
      if (v.verb === 'addTab') {
        vscode.postMessage({ type: 'addTab', hostId: owner });
      } else if (v.verb === 'deleteTab') {
        var page = activePageOf(owner);
        if (page) vscode.postMessage({ type: 'deleteTab', hostId: owner, pageId: page.id });
      } else if (v.verb === 'showProperties') {
        vscode.postMessage({ type: 'showProperties' });
      }
    });
    return row;
  }
  /** One engine-certified DesignerActionMethodItem. Unlike property rows, the browser supplies no edit proposal:
   * it posts only the opaque command/certificate pair and the host re-authorizes both against current metadata. */
  function commandRow(action) {
    var owner = current;
    var row = document.createElement('div'); row.className = 'tfVerb tfCommand';
    row.textContent = action.displayName || action.commandId;
    if (action.description) row.title = action.description;
    row.addEventListener('click', function () {
      if (owner !== current || !tasksState || tasksState.id !== owner
        || commandListFor(tasksState.comp).indexOf(action) < 0) { closeFlyout(); return; }
      closeFlyout();
      vscode.postMessage({
        type: 'designerActionCommand',
        id: owner,
        commandId: action.commandId,
        certificationId: action.certificationId,
      });
    });
    return row;
  }
  function taskRow(comp, p) {
    var owner = current;
    var taskLabel = p.taskDisplayName || p.name;
    function send(value) { vscode.postMessage({ type: 'edit', id: owner, prop: p.name, propType: p.type, isEnum: !!p.isEnum, value: value }); }
    var cur = p.value == null ? '' : String(p.value);
    var isBool = /(^|\.)Boolean$/.test(p.type || '') || sameSet(p.standardValues, ['True', 'False']);
    var row;
    if (isBool) {
      row = document.createElement('label'); row.className = 'tfRow tfCheck';
      var cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = cur === 'True';
      cb.addEventListener('change', function () { send(cb.checked ? 'True' : 'False'); });
      var lb = document.createElement('span'); lb.className = 'tfLabel'; lb.textContent = taskLabel;
      row.appendChild(cb); row.appendChild(lb);
    } else if (p.standardValues && p.standardValues.length) {
      row = document.createElement('div'); row.className = 'tfRow';
      var l1 = document.createElement('span'); l1.className = 'tfLabel'; l1.textContent = taskLabel;
      var sel = document.createElement('select'); var has = false;
      for (var k = 0; k < p.standardValues.length; k++) {
        var o = document.createElement('option'); o.value = p.standardValues[k]; o.textContent = p.standardValues[k];
        if (o.value === cur) { o.selected = true; has = true; } sel.appendChild(o);
      }
      if (!has && cur) { var o0 = document.createElement('option'); o0.value = cur; o0.textContent = cur; o0.selected = true; sel.insertBefore(o0, sel.firstChild); }
      sel.addEventListener('change', function () { send(sel.value); });
      row.appendChild(l1); row.appendChild(sel);
    } else {
      row = document.createElement('div'); row.className = 'tfRow';
      var l2 = document.createElement('span'); l2.className = 'tfLabel'; l2.textContent = taskLabel;
      var inp = document.createElement('input'); inp.type = 'text'; inp.className = 'tfText'; inp.value = cur;
      inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } });
      inp.addEventListener('blur', function () { if (inp.value !== cur) send(inp.value); });
      row.appendChild(l2); row.appendChild(inp);
    }
    if (p.taskDescription) row.title = p.taskDescription;
    return row;
  }

  // ---- anchor overlay (Phase 2): for a single selected control, draw tether lines from each anchored edge to the
  // parent edge (VS-style). Display-only; editing is the property grid's anchor/dock glyph. Tethers reach the
  // parent's window-space rect (form chrome inset is a v1 gap). A docked control ignores Anchor at runtime, so it
  // simply shows no tethers (we intentionally do NOT paint a "Dock: …" text badge on the canvas). ----
  function renderAnchors() {
    clearAnchors();
    if (tabOrderMode || drag || selection.length !== 1) return;
    var c = current ? findControl(current) : null;
    if (!c || c.isRoot || c.id === 'this') return;
    if (c.dock && c.dock !== 'None') return; // docked → no anchor tethers, and no on-canvas dock label
    var parent = c.parentId != null ? findControl(c.parentId) : null;
    if (!parent) return;
    var px = parent.x, py = parent.y, pr = parent.x + parent.width, pb = parent.y + parent.height;
    var cmx = c.x + c.width / 2, cmy = c.y + c.height / 2;
    var set = {}; String(c.anchor || '').split(',').forEach(function (s) { var k = s.trim(); if (k) set[k] = true; });
    var segs = [];
    if (set.Top) segs.push({ vert: true, x: cmx, a: py, b: c.y });
    if (set.Bottom) segs.push({ vert: true, x: cmx, a: c.y + c.height, b: pb });
    if (set.Left) segs.push({ vert: false, y: cmy, a: px, b: c.x });
    if (set.Right) segs.push({ vert: false, y: cmy, a: c.x + c.width, b: pr });
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i], el = anchorEl(i); el.style.display = 'block';
      var lo = Math.min(s.a, s.b), len = Math.abs(s.b - s.a);
      if (s.vert) { el.className = 'anchortether vert'; el.style.left = (s.x * zoom) + 'px'; el.style.top = (lo * zoom) + 'px'; el.style.height = (len * zoom) + 'px'; el.style.width = '0px'; }
      else { el.className = 'anchortether horz'; el.style.top = (s.y * zoom) + 'px'; el.style.left = (lo * zoom) + 'px'; el.style.width = (len * zoom) + 'px'; el.style.height = '0px'; }
    }
  }

  // ---- tab-order overlay (Phase 2): a numbered badge on each control at its top-left ----
  function renderTabBadges() {
    for (var i = 0; i < tabBadges.length; i++) tabBadges[i].style.display = 'none';
    if (!tabOrderMode) return;
    var n = 0;
    for (var j = 0; j < controls.length; j++) {
      var c = controls[j];
      if (c.isRoot) continue;
      var b = tabBadges[n] || (tabBadges[n] = surfaceWrap.appendChild(document.createElement('div')));
      n++;
      b.className = 'tabBadge'; b.textContent = c.tabIndex; b.style.display = 'block';
      b.style.left = (c.x * zoom) + 'px'; b.style.top = (c.y * zoom) + 'px';
    }
  }
  function setTabOrder(on) {
    tabOrderMode = on; tabSeq = 0;
    if (tabOrderEl) tabOrderEl.className = on ? 'active' : '';
    canvas.style.cursor = 'default';
    renderTabBadges();
  }
  if (tabOrderEl) tabOrderEl.addEventListener('click', function () { setTabOrder(!tabOrderMode); });

  // ---- align (Phase 2): move the rest of the multi-selection to the primary (anchor) control's edge ----
  function alignSelected(mode) {
    if (selection.length < 2) return;
    var anchor = findControl(current); if (!anchor) return;
    var edits = [];
    for (var i = 0; i < selection.length; i++) {
      var id = selection[i]; if (id === 'this') continue;
      var c = findControl(id); if (!c || c.id === anchor.id) continue;
      var dx = 0, dy = 0;
      if (mode === 'left') dx = anchor.x - c.x;
      else if (mode === 'right') dx = (anchor.x + anchor.width) - (c.x + c.width);
      else if (mode === 'top') dy = anchor.y - c.y;
      else if (mode === 'bottom') dy = (anchor.y + anchor.height) - (c.y + c.height);
      else if (mode === 'centerH') dx = (anchor.x + anchor.width / 2) - (c.x + c.width / 2);
      else if (mode === 'centerV') dy = (anchor.y + anchor.height / 2) - (c.y + c.height / 2);
      if (Math.round(dx) !== 0 || Math.round(dy) !== 0) edits.push({ id: id, dx: Math.round(dx), dy: Math.round(dy) });
    }
    if (edits.length) vscode.postMessage({ type: 'alignControls', edits: edits });
  }
  [['alignLeft', 'left'], ['alignRight', 'right'], ['alignTop', 'top'], ['alignBottom', 'bottom'],
   ['alignCenterH', 'centerH'], ['alignCenterV', 'centerV']].forEach(function (pair) {
    var el = document.getElementById(pair[0]);
    if (el) el.addEventListener('click', function () { alignSelected(pair[1]); });
  });

  // ---- distribute (Phase 2): equalize the gaps between 3+ selected controls along one axis. First and last
  // keep their place; the middle ones move so every inter-control gap is identical. Reuses applyAlign (per-control
  // window-space deltas → chained Location edits, one undo). ----
  function distributeSelected(axis) { // axis: 'h' (horizontal gaps) | 'v' (vertical gaps)
    var sel = [];
    for (var i = 0; i < selection.length; i++) {
      var id = selection[i]; if (id === 'this') continue;
      var c = findControl(id); if (c) sel.push(c);
    }
    if (sel.length < 3) { setStatus(T('designer.status.distSelectMore')); return; }
    var parentId = sel[0].parentId;
    for (var pi = 1; pi < sel.length; pi++) {
      if (sel[pi].parentId !== parentId) { setStatus(T('designer.status.spacingSameParent')); return; }
    }
    var sk = (axis === 'h') ? 'x' : 'y';            // start coord
    var zk = (axis === 'h') ? 'width' : 'height';   // size along the axis
    sel.sort(function (a, b) { return (a[sk] - b[sk]) || String(a.id).localeCompare(String(b.id)); });
    var first = sel[0], last = sel[sel.length - 1];
    var span = (last[sk] + last[zk]) - first[sk];
    var sumSize = 0; for (var i = 0; i < sel.length; i++) sumSize += sel[i][zk];
    var gap = (span - sumSize) / (sel.length - 1);
    if (gap < 0) { setStatus(T('designer.status.distOverlap')); return; }
    var edits = [], cursor = first[sk];
    for (var i = 0; i < sel.length; i++) {
      var c = sel[i], newStart = Math.round(cursor), delta = newStart - c[sk];
      if (i !== 0 && i !== sel.length - 1 && delta !== 0) {
        edits.push((axis === 'h') ? { id: c.id, dx: delta, dy: 0 } : { id: c.id, dx: 0, dy: delta });
      }
      cursor += c[zk] + gap;
    }
    if (edits.length) vscode.postMessage({ type: 'alignControls', edits: edits });
  }
  [['distH', 'h'], ['distV', 'v']].forEach(function (pair) {
    var el = document.getElementById(pair[0]);
    if (el) el.addEventListener('click', function () { distributeSelected(pair[1]); });
  });

  // VS Format → Horizontal/Vertical Spacing → Increase/Decrease/Remove. The first control is the stable
  // anchor and each following control is placed recursively, so a repeated command is deterministic.
  function adjustSpacing(axis, operation) {
    var sel = [];
    for (var i = 0; i < selection.length; i++) {
      var c = selection[i] === 'this' ? null : findControl(selection[i]); if (c) sel.push(c);
    }
    if (sel.length < 2) { setStatus(T('designer.status.spacingSelectMore')); return; }
    var parentId = sel[0].parentId;
    for (var p = 1; p < sel.length; p++) {
      if (sel[p].parentId !== parentId) { setStatus(T('designer.status.spacingSameParent')); return; }
    }
    var sk = axis === 'h' ? 'x' : 'y', zk = axis === 'h' ? 'width' : 'height';
    sel.sort(function (a, b) { return (a[sk] - b[sk]) || String(a.id).localeCompare(String(b.id)); });
    var edits = [], cursor = sel[0][sk] + sel[0][zk], previousOriginalEnd = cursor;
    for (var j = 1; j < sel.length; j++) {
      var item = sel[j], oldGap = item[sk] - previousOriginalEnd;
      var gap = operation === 'remove' ? 0 : operation === 'increase'
        ? Math.max(0, oldGap) + placementGridSize
        : Math.max(0, oldGap - placementGridSize);
      var target = Math.round(cursor + gap), delta = target - item[sk];
      if (delta) edits.push(axis === 'h' ? { id: item.id, dx: delta, dy: 0 } : { id: item.id, dx: 0, dy: delta });
      cursor = target + item[zk];
      previousOriginalEnd = item[sk] + item[zk];
    }
    if (edits.length) vscode.postMessage({ type: 'alignControls', edits: edits });
  }
  [['spaceHInc', 'h', 'increase'], ['spaceHDec', 'h', 'decrease'], ['spaceHRemove', 'h', 'remove'],
   ['spaceVInc', 'v', 'increase'], ['spaceVDec', 'v', 'decrease'], ['spaceVRemove', 'v', 'remove']].forEach(function (entry) {
    var el = document.getElementById(entry[0]);
    if (el) el.addEventListener('click', function () { adjustSpacing(entry[1], entry[2]); });
  });

  // ---- make-same-size (Phase 2): resize every selected control to the primary selection's width/height/both. ----
  function sameSizeSelected(dim) { // dim: 'w' | 'h' | 'wh'
    if (selection.length < 2) return;
    var anchor = findControl(current); if (!anchor) return;
    var edits = [];
    for (var i = 0; i < selection.length; i++) {
      var id = selection[i]; if (id === 'this' || id === anchor.id) continue;
      var c = findControl(id); if (!c) continue;
      var w = (dim.indexOf('w') >= 0) ? anchor.width : c.width;
      var h = (dim.indexOf('h') >= 0) ? anchor.height : c.height;
      if (Math.round(w) !== Math.round(c.width) || Math.round(h) !== Math.round(c.height)) {
        edits.push({ id: id, width: Math.round(w), height: Math.round(h) });
      }
    }
    if (edits.length) vscode.postMessage({ type: 'resizeControls', sizeEdits: edits });
  }
  [['sameW', 'w'], ['sameH', 'h'], ['sameWH', 'wh']].forEach(function (pair) {
    var el = document.getElementById(pair[0]);
    if (el) el.addEventListener('click', function () { sameSizeSelected(pair[1]); });
  });

  // ---- center-in-form (VS Format → Center Horizontally / Vertically): center the selection's bounding box within
  // the parent's client area along one axis, preserving relative positions. Computed HOST-SIDE: the form's client
  // origin within the window chrome is asymmetric (caption ≫ side border) and only known to the host, so a webview
  // window-space center would place a vertical center ~half-a-caption too high. We forward the axis + selection. ----
  function centerInForm(axis) { // 'h' (horizontal) | 'v' (vertical)
    var ids = selectableIds();
    if (ids.length) vscode.postMessage({ type: 'centerInForm', axis: axis, ids: ids });
  }
  [['centerFormH', 'h'], ['centerFormV', 'v']].forEach(function (pair) {
    var el = document.getElementById(pair[0]);
    if (el) el.addEventListener('click', function () { centerInForm(pair[1]); });
  });

  function hitTest(px, py) {
    for (var i = 0; i < controls.length; i++) {
      var c = controls[i];
      if (px >= c.x && px < c.x + c.width && py >= c.y && py < c.y + c.height) return c.id;
    }
    return null;
  }
  function sortControlsForHitTest(items) {
    return (items || []).slice().sort(function (a, b) {
      var d = (b.depth || 0) - (a.depth || 0);
      if (d) return d;
      var az = typeof a.zOrder === 'number' && isFinite(a.zOrder) ? a.zOrder : 2147483647;
      var bz = typeof b.zOrder === 'number' && isFinite(b.zOrder) ? b.zOrder : 2147483647;
      if (az !== bz) return az - bz;
      var area = ((a.width || 0) * (a.height || 0)) - ((b.width || 0) * (b.height || 0));
      if (area) return area;
      return String(a.id || '').localeCompare(String(b.id || ''));
    });
  }
  function isContainerControl(id) {
    if (!id) return false;
    var control = findControl(id);
    if (control && (control.isRoot || /Panel|GroupBox|TabPage|FlowLayoutPanel|TableLayoutPanel/.test(control.type || ''))) return true;
    for (var i = 0; i < controls.length; i++) if (controls[i].parentId === id) return true;
    return false;
  }

  function toolboxContainerFor(id) {
    var c = id ? findControl(id) : null;
    while (c) {
      if (c.id === 'this' || c.isRoot) return findControl('this') || c;
      if (/Panel|GroupBox|TabPage|FlowLayoutPanel|TableLayoutPanel/.test(c.type || '')) return c;
      c = c.parentId ? findControl(c.parentId) : null;
    }
    return findControl('this');
  }

  function clearToolboxDropFeedback() {
    if (toolboxDropEl) toolboxDropEl.style.display = 'none';
  }

  function showToolboxDropFeedback(hitId, x, y) {
    var target = toolboxContainerFor(hitId || 'this');
    if (!target) { clearToolboxDropFeedback(); return; }
    if (!toolboxDropEl) {
      toolboxDropEl = document.createElement('div');
      toolboxDropEl.className = 'toolboxdroptarget';
      var label = document.createElement('span'); label.className = 'toolboxdroplabel';
      toolboxDropEl.appendChild(label); surfaceWrap.appendChild(toolboxDropEl);
    }
    var rect = clientRect(target);
    toolboxDropEl.style.display = 'block';
    toolboxDropEl.style.left = (rect.x * zoom) + 'px'; toolboxDropEl.style.top = (rect.y * zoom) + 'px';
    toolboxDropEl.style.width = Math.max(1, rect.w * zoom) + 'px'; toolboxDropEl.style.height = Math.max(1, rect.h * zoom) + 'px';
    var labelEl = toolboxDropEl.firstChild;
    if (labelEl) labelEl.textContent = (target.name || target.id) + '  ' + Math.max(0, Math.round(x - rect.x)) + ', ' + Math.max(0, Math.round(y - rect.y));
  }

  function finiteOr(value, fallback) { return typeof value === 'number' && isFinite(value) ? value : fallback; }
  function spacingSide(value, side) { return value && typeof value[side] === 'number' ? value[side] : 0; }
  function clientRect(c) {
    return {
      x: finiteOr(c && c.clientX, c ? c.x : 0), y: finiteOr(c && c.clientY, c ? c.y : 0),
      w: finiteOr(c && c.clientWidth, c ? c.width : 0), h: finiteOr(c && c.clientHeight, c ? c.height : 0)
    };
  }
  function placementParent(c) { return c && c.parentId != null ? findControl(c.parentId) : null; }
  function renderGrid() {
    if (!gridEl) return;
    var root = findControl('this');
    if (!placementShowGrid || !root) { gridEl.style.display = 'none'; return; }
    var r = clientRect(root), step = placementGridSize * zoom;
    gridEl.style.display = 'block';
    gridEl.style.left = (r.x * zoom) + 'px'; gridEl.style.top = (r.y * zoom) + 'px';
    gridEl.style.width = Math.max(0, r.w * zoom) + 'px'; gridEl.style.height = Math.max(0, r.h * zoom) + 'px';
    gridEl.style.backgroundSize = step + 'px ' + step + 'px';
  }

  function snapMoveToGrid(nx, ny, moving) {
    var parent = placementParent(moving), r = clientRect(parent || findControl('this'));
    return {
      x: r.x + Math.round((nx - r.x) / placementGridSize) * placementGridSize,
      y: r.y + Math.round((ny - r.y) / placementGridSize) * placementGridSize,
      guides: []
    };
  }

  function alignSelectionToGrid() {
    var ids = selectableIds(), edits = [];
    for (var i = 0; i < ids.length; i++) {
      var c = findControl(ids[i]); if (!c || isLocked(c.id)) continue;
      var snapped = snapMoveToGrid(c.x, c.y, c), dx = Math.round(snapped.x - c.x), dy = Math.round(snapped.y - c.y);
      if (dx || dy) edits.push({ id: c.id, dx: dx, dy: dy });
    }
    if (edits.length) vscode.postMessage({ type: 'alignControls', edits: edits });
  }

  // ---- snaplines: align the moving control's edges/centers to siblings within a threshold ----
  var SNAP_T = 6; // surface px
  function overlap1d(a0, a1, b0, b1) { return Math.min(a1, b1) > Math.max(a0, b0); }

  // Equal-spacing candidate: if the moving control sits between a left and a right flanker (siblings that
  // vertically overlap it), offer the X that makes the left gap == the right gap. Returns null when there is no
  // pair of flankers, they overlap the moving control, or the centered X is farther than SNAP_T.
  function equalSpaceX(nx, ny, w, h, movingId, parentId) {
    var left = null, right = null;
    for (var i = 0; i < controls.length; i++) {
      var s = controls[i];
      if (s.id === movingId || s.parentId !== parentId || selection.indexOf(s.id) >= 0) continue;
      if (!overlap1d(ny, ny + h, s.y, s.y + s.height)) continue;
      if (s.x + s.width <= nx + 1) { if (!left || s.x + s.width > left.x + left.width) left = s; }
      else if (s.x >= nx + w - 1) { if (!right || s.x < right.x) right = s; }
    }
    if (!left || !right) return null;
    var space = (right.x - (left.x + left.width) - w) / 2;
    if (space < 0) return null;
    var targetX = left.x + left.width + space, d = targetX - nx;
    if (Math.abs(d) > SNAP_T) return null;
    return { delta: d, left: left, right: right };
  }
  function equalSpaceY(nx, ny, w, h, movingId, parentId) {
    var top = null, bottom = null;
    for (var i = 0; i < controls.length; i++) {
      var s = controls[i];
      if (s.id === movingId || s.parentId !== parentId || selection.indexOf(s.id) >= 0) continue;
      if (!overlap1d(nx, nx + w, s.x, s.x + s.width)) continue;
      if (s.y + s.height <= ny + 1) { if (!top || s.y + s.height > top.y + top.height) top = s; }
      else if (s.y >= ny + h - 1) { if (!bottom || s.y < bottom.y) bottom = s; }
    }
    if (!top || !bottom) return null;
    var space = (bottom.y - (top.y + top.height) - h) / 2;
    if (space < 0) return null;
    var targetY = top.y + top.height + space, d = targetY - ny;
    if (Math.abs(d) > SNAP_T) return null;
    return { delta: d, top: top, bottom: bottom };
  }

  function computeSnap(nx, ny, w, h, movingId) {
    var moving = findControl(movingId);
    var parentId = moving ? moving.parentId : null;
    var ax = [nx, nx + w / 2, nx + w], ay = [ny, ny + h / 2, ny + h];
    var bestX = null, bestY = null;
    function choose(best, candidate) {
      if (Math.abs(candidate.delta) > SNAP_T) return best;
      // Actual VS gives a compatible text Baseline snapline precedence over ordinary edge/center candidates even
      // when an ordinary candidate is fractionally closer (S025: center +0.5px versus baseline -1px). The engine
      // supplies these baselines from the real live Font/DPI, so browser geometry must not demote that authority.
      if (candidate.baseline && (!best || !best.baseline)) return candidate;
      if (best && best.baseline && !candidate.baseline) return best;
      if (!best || Math.abs(candidate.delta) < Math.abs(best.delta)
          || (Math.abs(candidate.delta) === Math.abs(best.delta) && candidate.priority > best.priority)
          || (Math.abs(candidate.delta) === Math.abs(best.delta) && candidate.priority === best.priority
              && String(candidate.s && candidate.s.id || '').localeCompare(String(best.s && best.s.id || '')) < 0)) return candidate;
      return best;
    }
    for (var i = 0; i < controls.length; i++) {
      var s = controls[i];
      if (s.id === movingId || s.parentId !== parentId || selection.indexOf(s.id) >= 0) continue; // siblings only, not the group
      var tx = [s.x, s.x + s.width / 2, s.x + s.width], ty = [s.y, s.y + s.height / 2, s.y + s.height];
      for (var a = 0; a < 3; a++) {
        for (var b = 0; b < 3; b++) {
          bestX = choose(bestX, { delta: tx[b] - ax[a], line: tx[b], s: s, priority: 1 });
          bestY = choose(bestY, { delta: ty[b] - ay[a], line: ty[b], s: s, priority: 1 });
        }
      }
      // WinForms snapline spacing is Margin-aware: adjacent controls stop at the larger of the two declared margins.
      if (overlap1d(ny, ny + h, s.y, s.y + s.height)) {
        var rightGap = Math.max(spacingSide(s.margin, 'right'), spacingSide(moving && moving.margin, 'left'));
        var leftGap = Math.max(spacingSide(s.margin, 'left'), spacingSide(moving && moving.margin, 'right'));
        bestX = choose(bestX, { delta: s.x + s.width + rightGap - nx, line: s.x + s.width + rightGap, s: s, priority: 3 });
        bestX = choose(bestX, { delta: s.x - leftGap - w - nx, line: s.x - leftGap, s: s, priority: 3 });
      }
      if (overlap1d(nx, nx + w, s.x, s.x + s.width)) {
        var bottomGap = Math.max(spacingSide(s.margin, 'bottom'), spacingSide(moving && moving.margin, 'top'));
        var topGap = Math.max(spacingSide(s.margin, 'top'), spacingSide(moving && moving.margin, 'bottom'));
        bestY = choose(bestY, { delta: s.y + s.height + bottomGap - ny, line: s.y + s.height + bottomGap, s: s, priority: 3 });
        bestY = choose(bestY, { delta: s.y - topGap - h - ny, line: s.y - topGap, s: s, priority: 3 });
      }
      // Baselines are measured by the engine from the live Font/DPI. The browser only translates the absolute
      // baseline by the proposed move delta, so zoom never enters the measurement.
      if (moving && finiteOr(moving.textBaseline, -1) >= 0 && finiteOr(s.textBaseline, -1) >= 0) {
        var baseline = ny + (moving.textBaseline - moving.y);
        bestY = choose(bestY, { delta: s.textBaseline - baseline, line: s.textBaseline, s: s, priority: 4, baseline: true });
      }
    }
    var parent = placementParent(moving);
    if (parent) {
      var pr = clientRect(parent), pad = parent.padding || {}, mar = moving.margin || {};
      var left = pr.x + spacingSide(pad, 'left') + spacingSide(mar, 'left');
      var right = pr.x + pr.w - spacingSide(pad, 'right') - spacingSide(mar, 'right');
      var top = pr.y + spacingSide(pad, 'top') + spacingSide(mar, 'top');
      var bottom = pr.y + pr.h - spacingSide(pad, 'bottom') - spacingSide(mar, 'bottom');
      bestX = choose(bestX, { delta: left - nx, line: left, s: parent, priority: 2 });
      bestX = choose(bestX, { delta: right - (nx + w), line: right, s: parent, priority: 2 });
      bestY = choose(bestY, { delta: top - ny, line: top, s: parent, priority: 2 });
      bestY = choose(bestY, { delta: bottom - (ny + h), line: bottom, s: parent, priority: 2 });
    }
    // equal-spacing wins an axis only when it is at least as close as the best edge/center snap on that axis
    var eqX = equalSpaceX(nx, ny, w, h, movingId, parentId);
    var eqY = equalSpaceY(nx, ny, w, h, movingId, parentId);
    var useEqX = eqX && (!bestX || Math.abs(eqX.delta) <= Math.abs(bestX.delta));
    var useEqY = eqY && (!bestY || Math.abs(eqY.delta) <= Math.abs(bestY.delta));
    var sx = nx + (useEqX ? eqX.delta : (bestX ? bestX.delta : 0));
    var sy = ny + (useEqY ? eqY.delta : (bestY ? bestY.delta : 0));
    var guides = [];
    if (useEqX) {
      var cy = sy + h / 2; // two horizontal bars in the equal gaps, at the moving control's vertical center
      guides.push({ equal: true, vert: false, y: cy, a: eqX.left.x + eqX.left.width, b: sx });
      guides.push({ equal: true, vert: false, y: cy, a: sx + w, b: eqX.right.x });
    } else if (bestX) {
      guides.push({ vert: true, x: bestX.line, a: Math.min(sy, bestX.s.y), b: Math.max(sy + h, bestX.s.y + bestX.s.height) });
    }
    if (useEqY) {
      var cx = sx + w / 2; // two vertical bars in the equal gaps, at the moving control's horizontal center
      guides.push({ equal: true, vert: true, x: cx, a: eqY.top.y + eqY.top.height, b: sy });
      guides.push({ equal: true, vert: true, x: cx, a: sy + h, b: eqY.bottom.y });
    } else if (bestY) {
      guides.push({ vert: false, y: bestY.line, a: Math.min(sx, bestY.s.x), b: Math.max(sx + w, bestY.s.x + bestY.s.width) });
    }
    return { x: sx, y: sy, guides: guides };
  }
  // ---- resize snaplines: snap only the edge(s) being dragged to sibling edges/centers (the fixed edges stay
  // put). Mirrors the move-snap sibling scan but per moving edge, so resizing a control aligns its dragged edge
  // to neighbours the same way moving aligns the whole control. Single-selection only (resize handles require it).
  function computeResizeSnap(o, dir, movingId) {
    var moving = findControl(movingId);
    var parentId = moving ? moving.parentId : null;
    var rx = o.x, ry = o.y, rw = o.w, rh = o.h;
    var xl = [], yl = []; // candidate lines paired with the sibling that owns them, so a guide can reach it (move-snap parity)
    for (var i = 0; i < controls.length; i++) {
      var s = controls[i];
      if (s.id === movingId || s.parentId !== parentId || selection.indexOf(s.id) >= 0) continue; // siblings only
      xl.push({ v: s.x, s: s }, { v: s.x + s.width / 2, s: s }, { v: s.x + s.width, s: s });
      yl.push({ v: s.y, s: s }, { v: s.y + s.height / 2, s: s }, { v: s.y + s.height, s: s });
    }
    var parent = placementParent(moving);
    if (parent) {
      var pr = clientRect(parent), pad = parent.padding || {}, mar = moving.margin || {};
      xl.push({ v: pr.x + spacingSide(pad, 'left') + spacingSide(mar, 'left'), s: parent },
              { v: pr.x + pr.w - spacingSide(pad, 'right') - spacingSide(mar, 'right'), s: parent });
      yl.push({ v: pr.y + spacingSide(pad, 'top') + spacingSide(mar, 'top'), s: parent },
              { v: pr.y + pr.h - spacingSide(pad, 'bottom') - spacingSide(mar, 'bottom'), s: parent });
    }
    function nearest(val, lines) {
      var best = null;
      for (var i = 0; i < lines.length; i++) { var d = lines[i].v - val; if (Math.abs(d) <= SNAP_T && (!best || Math.abs(d) < Math.abs(best.d))) best = { d: d, line: lines[i].v, s: lines[i].s }; }
      return best;
    }
    var guides = [];
    if (dir.indexOf('e') >= 0) { var be = nearest(rx + rw, xl); if (be) { rw = Math.max(4, rw + be.d); guides.push({ vert: true, x: be.line, a: Math.min(ry, be.s.y), b: Math.max(ry + rh, be.s.y + be.s.height) }); } }
    if (dir.indexOf('w') >= 0) { var bw = nearest(rx, xl); if (bw) { var right = rx + rw; rx = rx + bw.d; rw = Math.max(4, right - rx); guides.push({ vert: true, x: bw.line, a: Math.min(ry, bw.s.y), b: Math.max(ry + rh, bw.s.y + bw.s.height) }); } }
    if (dir.indexOf('s') >= 0) { var bs = nearest(ry + rh, yl); if (bs) { rh = Math.max(4, rh + bs.d); guides.push({ vert: false, y: bs.line, a: Math.min(rx, bs.s.x), b: Math.max(rx + rw, bs.s.x + bs.s.width) }); } }
    if (dir.indexOf('n') >= 0) { var bn = nearest(ry, yl); if (bn) { var bottom = ry + rh; ry = ry + bn.d; rh = Math.max(4, bottom - ry); guides.push({ vert: false, y: bn.line, a: Math.min(rx, bn.s.x), b: Math.max(rx + rw, bn.s.x + bn.s.width) }); } }
    return { x: rx, y: ry, w: rw, h: rh, guides: guides };
  }
  function gridResizeSnap(o, dir, movingId) {
    var moving = findControl(movingId), parent = placementParent(moving), pr = clientRect(parent || findControl('this'));
    var rx = o.x, ry = o.y, rw = o.w, rh = o.h;
    function gx(v) { return pr.x + Math.round((v - pr.x) / placementGridSize) * placementGridSize; }
    function gy(v) { return pr.y + Math.round((v - pr.y) / placementGridSize) * placementGridSize; }
    if (dir.indexOf('e') >= 0) rw = Math.max(4, gx(rx + rw) - rx);
    if (dir.indexOf('w') >= 0) { var right = rx + rw; rx = Math.min(right - 4, gx(rx)); rw = right - rx; }
    if (dir.indexOf('s') >= 0) rh = Math.max(4, gy(ry + rh) - ry);
    if (dir.indexOf('n') >= 0) { var bottom = ry + rh; ry = Math.min(bottom - 4, gy(ry)); rh = bottom - ry; }
    return { x: rx, y: ry, w: rw, h: rh, guides: [] };
  }
  function computePlacementMove(nx, ny, w, h, movingId) {
    if (placementLayoutMode === 'none') return { x: nx, y: ny, guides: [] };
    if (placementLayoutMode === 'snapToGrid') return snapMoveToGrid(nx, ny, findControl(movingId));
    return computeSnap(nx, ny, w, h, movingId);
  }
  function computePlacementResize(o, dir, movingId) {
    if (placementLayoutMode === 'none') return { x: o.x, y: o.y, w: o.w, h: o.h, guides: [] };
    if (placementLayoutMode === 'snapToGrid') return gridResizeSnap(o, dir, movingId);
    return computeResizeSnap(o, dir, movingId);
  }
  function drawGuides(guides) {
    clearGuides();
    for (var i = 0; i < guides.length; i++) {
      var g = guides[i], el = guideEls[i];
      if (!el) { el = document.createElement('div'); el.className = 'snapguide'; surfaceWrap.appendChild(el); guideEls.push(el); }
      el.style.display = 'block';
      var base = 'snapguide' + (g.equal ? ' equal' : '');
      if (g.vert) { el.className = base + ' vert'; el.style.left = (g.x * zoom) + 'px'; el.style.top = (Math.min(g.a, g.b) * zoom) + 'px'; el.style.width = '0px'; el.style.height = (Math.abs(g.b - g.a) * zoom) + 'px'; }
      else { el.className = base + ' horz'; el.style.top = (g.y * zoom) + 'px'; el.style.left = (Math.min(g.a, g.b) * zoom) + 'px'; el.style.height = '0px'; el.style.width = (Math.abs(g.b - g.a) * zoom) + 'px'; }
    }
  }

  function clearToolboxBand() {
    toolboxBand = null;
    if (bandEl) bandEl.style.display = 'none';
    clearToolboxDropFeedback();
  }

  // ---- selection (click / Ctrl-click) ----
  function selectSingle(id) {
    selectedItem = null; // a control selection supersedes any on-canvas strip-item selection
    selection = [id]; current = id; canMove = false; canResize = false;
    renderSelection(); postPick(id);
  }
  function toggleSelect(id) {
    selectedItem = null; // a control selection supersedes any on-canvas strip-item selection
    var idx = selection.indexOf(id);
    if (idx >= 0) { if (selection.length > 1) { selection.splice(idx, 1); if (current === id) current = selection[selection.length - 1]; } }
    else { selection.push(id); if (!current || selection.length === 1) current = id; }
    canMove = false; canResize = false;
    renderSelection(); postPick(current);
  }

  canvas.addEventListener('click', function (e) {
    if (suppressClick) { suppressClick = false; return; }
    if (ignorePendingRenderInput(e)) return;
    if (!controls.length) return;
    var px = e.offsetX / zoom, py = e.offsetY / zoom;
    if (tabOrderMode) {
      var tid = hitTest(px, py);
      if (!tid || tid === 'this') return;
      vscode.postMessage({ type: 'edit', id: tid, prop: 'TabIndex', propType: 'System.Int32', isEnum: false, value: String(tabSeq) });
      tabSeq++;
      return;
    }
    // a plain click on a top-level ToolStrip/MenuStrip/StatusStrip item selects THAT item on the canvas (the Delete/F2
    // target) instead of its container strip. Checked before the control hit-test (mirrors dblclick-rename) so an item
    // is selectable even if its rect extends past the strip's hit area. Ctrl/Shift-click falls through to multi-select.
    if (!(e.ctrlKey || e.metaKey || e.shiftKey)) {
      // a click on a strip's OVERFLOW chevron opens a synthetic flyout of the overflow items (checked first — the chevron
      // sits within the strip's control hit area). No control/item selection changes: it just reveals the hidden items.
      var ovf = overflowHit(px, py);
      if (ovf) { openOverflowFlyout(ovf); return; }
      var sItem = stripItemHit(px, py);
      // an item with nested DropDownItems also opens a synthetic submenu flyout (its children are reachable for
      // Properties); a childless item just selects. Any previously-open flyout was already dismissed by the
      // capture-phase onSubmenuDocDown on this same mousedown, so openSubmenu starts fresh.
      if (sItem) { selectStripItem(sItem); if (sItem.children && sItem.children.length) openSubmenu(sItem); else closeSubmenu(); return; }
    }
    var id = hitTest(px, py);
    if (!id) return;
    // a click on a tab host may be on a tab HEADER → ask the host to switch the active tab (net48 compiled preview;
    // the engine no-ops if it wasn't a different tab's header). Sent regardless of selection state so re-clicking an
    // already-selected tab control still switches tabs. Normal selection still runs below.
    var hc = findControl(id);
    if (hc && hc.isTabHost && !(e.ctrlKey || e.metaKey || e.shiftKey)) {
      vscode.postMessage({ type: 'tabClick', hostId: id, x: Math.round(e.offsetX / zoom), y: Math.round(e.offsetY / zoom) });
    }
    if ((e.ctrlKey || e.metaKey || e.shiftKey) && id !== 'this') { toggleSelect(id); }
    else if (id !== current || selection.length > 1) { selectSingle(id); }
  });

  // Double-click keeps tab-header/item rename priority; an ordinary component invokes its real DefaultEvent through
  // the host's existing signature-aware handler pipeline.
  canvas.addEventListener('dblclick', function (e) {
    if (ignorePendingRenderInput(e)) return;
    if (!controls.length) return;
    var px = e.offsetX / zoom, py = e.offsetY / zoom;
    // double-click a top-level ToolStrip/MenuStrip/StatusStrip item → rename it inline (editor prefilled with its
    // caption). A Separator has no Text, so it isn't renamable — fall through (no default dblclick behavior on it).
    var item = stripItemHit(px, py);
    if (item && !isSeparatorType(item.itemType)) { openItemRenameEditor(item); return; }
    var id = hitTest(px, py);
    if (!id) return;
    var hc = findControl(id);
    if (hc && hc.isTabHost) {
      vscode.postMessage({ type: 'tabRename', hostId: id, x: Math.round(px), y: Math.round(py) });
      return;
    }
    vscode.postMessage({ type: 'createDefaultHandler', id: id });
  });

  // cross-webview drop: a control or an engine-discovered data schema dragged from the shared panel lands here.
  var TOOLBOX_MIME = 'application/vnd.winforms-toolbox-item';
  var DATA_SOURCE_MIME = 'application/vnd.winforms-data-source';
  function dragHasToolboxItem(e) {
    return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], TOOLBOX_MIME) >= 0;
  }
  function dragHasDataSource(e) {
    return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], DATA_SOURCE_MIME) >= 0;
  }
  canvas.addEventListener('dragover', function (e) {
    if (!dragHasToolboxItem(e) && !dragHasDataSource(e)) return;
    e.preventDefault(); // allow the drop
    e.dataTransfer.dropEffect = 'copy';
    var x = e.offsetX / zoom, y = e.offsetY / zoom;
    showToolboxDropFeedback(controls.length ? hitTest(x, y) : 'this', x, y);
  });
  canvas.addEventListener('dragleave', function (e) {
    if (!e.relatedTarget || e.relatedTarget !== canvas) clearToolboxDropFeedback();
  });
  canvas.addEventListener('drop', function (e) {
    if (!dragHasToolboxItem(e) && !dragHasDataSource(e)) return;
    clearToolboxDropFeedback();
    if (ignorePendingRenderInput(e)) return;
    e.preventDefault();
    var x = e.offsetX / zoom, y = e.offsetY / zoom;
    var hitId = controls.length ? hitTest(x, y) : 'this';
    if (dragHasDataSource(e)) {
      var raw = e.dataTransfer.getData(DATA_SOURCE_MIME), data = null;
      try { data = JSON.parse(raw); } catch (_e) { return; }
      if (!data || typeof data.schemaKey !== 'string' || !data.schemaKey || data.schemaKey.length > 1024
          || (data.mode !== 'detail' && data.mode !== 'grid')) return;
      vscode.postMessage({
        type: 'dropDataSource', schemaKey: data.schemaKey, mode: data.mode,
        includeNavigator: !!data.includeNavigator,
        existingBindingSourceId: typeof data.existingBindingSourceId === 'string' ? data.existingBindingSourceId : null,
        hitId: hitId || 'this', x: Math.round(x), y: Math.round(y)
      });
      return;
    }
    var controlType = e.dataTransfer.getData(TOOLBOX_MIME);
    if (controlType) vscode.postMessage({ type: 'dropControl', controlType: controlType, hitId: hitId || 'this', x: Math.round(x), y: Math.round(y) });
  });

  canvas.addEventListener('mousedown', function (e) {
    if (e.button !== 0) return; // left-button only — right-click opens the context menu
    if (ignorePendingRenderInput(e)) return;
    if (nudge) flushNudge(); // a new gesture ends the current nudge series (commit before selection can change)
    if (tabOrderMode) return; // no drag/select in tab-order mode
    if (!controls.length || drag || band || toolboxBand || stripDrag) return;
    hideHover(); // a new gesture starts — drop the pre-select hint
    var sx = e.offsetX / zoom, sy = e.offsetY / zoom;
    var id = hitTest(sx, sy);
    if (selectedToolboxControl && !(e.ctrlKey || e.metaKey || e.shiftKey)) {
      toolboxBand = { controlType: selectedToolboxControl, startX: e.clientX, startY: e.clientY, sx: sx, sy: sy, hitId: id || 'this', active: false };
      e.preventDefault();
      return;
    }
    if (!(e.ctrlKey || e.metaKey || e.shiftKey)) {
      var dragItem = stripItemHit(sx, sy);
      if (dragItem && startStripDrag(dragItem, e, null, null)) return;
    }
    var mdc = id ? findControl(id) : null;
    // a tab host never starts a move-drag: its header must stay clickable so tab-switching (tabClick) fires
    if (id && id !== 'this' && selection.indexOf(id) >= 0 && canMove && !selectionHasLocked() && !(mdc && mdc.isTabHost)) {
      // (group) move: snapshot every selected control's rect so they translate together
      var items = [];
      for (var i = 0; i < selection.length; i++) { var c = findControl(selection[i]); if (c) items.push({ id: c.id, x: c.x, y: c.y, w: c.width, h: c.height }); }
      var pc = findControl(current);
      drag = { mode: 'move', group: selection.length > 1, ids: selection.slice(), items: items, primaryId: current,
               orig: { x: pc.x, y: pc.y, w: pc.width, h: pc.height }, startX: e.clientX, startY: e.clientY,
               delta: { dx: 0, dy: 0 }, duplicate: !!(e.ctrlKey || e.metaKey) };
      e.preventDefault();
    } else if (id === 'this' || id === null || (isContainerControl(id) && selection.indexOf(id) < 0)) {
      // Rubber-band selection is scoped to the active container. Starting on a panel/group background selects only
      // fully enclosed direct children of that container; starting on the form background selects form-level controls.
      band = { startX: e.clientX, startY: e.clientY, sx: sx, sy: sy, active: false, parentId: id || 'this' };
      e.preventDefault();
    }
    // mousedown on an unselected control: let the click handler select it (select-then-drag, like before)
  });

  canvas.addEventListener('mousemove', function (e) {
    if (canvasHasPendingRender()) { canvas.style.cursor = 'default'; hideHover(); return; }
    if (drag || band || toolboxBand || stripDrag) return;
    var id = hitTest(e.offsetX / zoom, e.offsetY / zoom);
    canvas.style.cursor = (id && id !== 'this' && selection.indexOf(id) >= 0 && canMove && !selectionHasLocked()) ? 'move' : 'default';
    showHover(id);
  });
  canvas.addEventListener('mouseleave', hideHover);

  function bandRect() {
    var r = canvas.getBoundingClientRect();
    return r;
  }

  document.addEventListener('mousemove', function (e) {
    if (stripDrag) {
      if (!stripDrag.active && (Math.abs(e.clientX - stripDrag.startX) >= 3 || Math.abs(e.clientY - stripDrag.startY) >= 3)) stripDrag.active = true;
      if (stripDrag.active) {
        stripDrag.target = stripMoveTarget(e.clientX, e.clientY, e.target);
        showStripDropFeedback(stripDrag.target);
        setStatus(stripDrag.target ? T('designer.status.committing') : '');
      }
      return;
    }
    if (toolboxBand) {
      var tr = bandRect();
      var tx = (e.clientX - tr.left) / zoom, ty = (e.clientY - tr.top) / zoom;
      if (!toolboxBand.active && (Math.abs(e.clientX - toolboxBand.startX) >= 3 || Math.abs(e.clientY - toolboxBand.startY) >= 3)) toolboxBand.active = true;
      if (toolboxBand.active) {
        if (!bandEl) { bandEl = document.createElement('div'); bandEl.className = 'rubberband toolboxplace'; surfaceWrap.appendChild(bandEl); }
        else bandEl.className = 'rubberband toolboxplace';
        var x1t = Math.min(toolboxBand.sx, tx), y1t = Math.min(toolboxBand.sy, ty), x2t = Math.max(toolboxBand.sx, tx), y2t = Math.max(toolboxBand.sy, ty);
        toolboxBand.rect = { x1: x1t, y1: y1t, x2: x2t, y2: y2t };
        bandEl.style.display = 'block';
        bandEl.style.left = (x1t * zoom) + 'px'; bandEl.style.top = (y1t * zoom) + 'px';
        bandEl.style.width = ((x2t - x1t) * zoom) + 'px'; bandEl.style.height = ((y2t - y1t) * zoom) + 'px';
        setStatus(geometryStatus({ x: x1t, y: y1t, w: x2t - x1t, h: y2t - y1t }));
      }
      return;
    }
    if (drag) {
      var dx = (e.clientX - drag.startX) / zoom, dy = (e.clientY - drag.startY) / zoom;
      if (drag.mode === 'move') {
        var nx = drag.orig.x + dx, ny = drag.orig.y + dy;
        var ctrlDrag = !!(e.ctrlKey || e.metaKey); drag.duplicate = drag.duplicate || ctrlDrag;
        var snapOverride = placementSnapOverrideActive(e, ctrlDrag);
        var snap = snapOverride ? { x: nx, y: ny, guides: [] } : computePlacementMove(nx, ny, drag.orig.w, drag.orig.h, drag.primaryId);
        nx = snap.x; ny = snap.y;
        var sdx = nx - drag.orig.x, sdy = ny - drag.orig.y;
        drag.delta = { dx: sdx, dy: sdy };
        drag.cur = { x: nx, y: ny, w: drag.orig.w, h: drag.orig.h };
        if (snapOverride) clearGuides(); else drawGuides(snap.guides);
        updateRulerMarks(drag.cur); // keep the ruler bounds-markers tracking the object as it moves
        // ghost: translate the primary box and every secondary box by the snapped delta
        selBox.style.left = (nx * zoom) + 'px'; selBox.style.top = (ny * zoom) + 'px';
        var n = 0;
        for (var i = 0; i < drag.items.length; i++) {
          var it = drag.items[i]; if (it.id === current) continue;
          var b = secBox(n++); b.style.display = 'block';
          b.style.left = ((it.x + sdx) * zoom) + 'px'; b.style.top = ((it.y + sdy) * zoom) + 'px';
          b.style.width = Math.max(0, it.w * zoom - 2) + 'px'; b.style.height = Math.max(0, it.h * zoom - 2) + 'px';
        }
        setStatus(ctrlDrag ? T('designer.status.duplicateDrag', { count: drag.items.length, dx: Math.round(sdx), dy: Math.round(sdy) })
                             : snapOverride ? rawPlacementStatus(drag.cur)
                             : drag.group ? T('designer.status.moveGroup', { count: drag.items.length, dx: Math.round(sdx), dy: Math.round(sdy) }) + ' · ' + geometryStatus(drag.cur)
                             : geometryStatus(drag.cur));
      } else {
        var o = drag.orig, dir = drag.dir || 'se';
        var rx = o.x, ry = o.y, rw = o.w, rh = o.h;
        if (dir.indexOf('e') >= 0) rw = Math.max(4, o.w + dx);
        if (dir.indexOf('s') >= 0) rh = Math.max(4, o.h + dy);
        if (dir.indexOf('w') >= 0) { rw = Math.max(4, o.w - dx); rx = o.x + (o.w - rw); }
        if (dir.indexOf('n') >= 0) { rh = Math.max(4, o.h - dy); ry = o.y + (o.h - rh); }
        var resizeSnapOverride = placementSnapOverrideActive(e, false);
        var rsnap = resizeSnapOverride ? { x: rx, y: ry, w: rw, h: rh, guides: [] } : computePlacementResize({ x: rx, y: ry, w: rw, h: rh }, dir, current);
        rx = rsnap.x; ry = rsnap.y; rw = rsnap.w; rh = rsnap.h;
        if (resizeSnapOverride) clearGuides(); else drawGuides(rsnap.guides);
        drag.cur = { x: rx, y: ry, w: rw, h: rh };
        selBox.style.left = (rx * zoom) + 'px'; selBox.style.top = (ry * zoom) + 'px';
        selBox.style.width = Math.max(0, rw * zoom - 2) + 'px'; selBox.style.height = Math.max(0, rh * zoom - 2) + 'px';
        updateRulerMarks(drag.cur); // track bounds on the ruler during resize too
        setStatus(resizeSnapOverride ? rawPlacementStatus(drag.cur) : geometryStatus(drag.cur));
      }
      return;
    }
    if (band) {
      var r = bandRect();
      var cx = (e.clientX - r.left) / zoom, cy = (e.clientY - r.top) / zoom;
      if (!band.active && (Math.abs(e.clientX - band.startX) >= 3 || Math.abs(e.clientY - band.startY) >= 3)) band.active = true;
      if (band.active) {
        if (!bandEl) { bandEl = document.createElement('div'); bandEl.className = 'rubberband'; surfaceWrap.appendChild(bandEl); }
        else bandEl.className = 'rubberband';
        bandEl.style.display = 'block';
        var x1 = Math.min(band.sx, cx), y1 = Math.min(band.sy, cy), x2 = Math.max(band.sx, cx), y2 = Math.max(band.sy, cy);
        band.rect = { x1: x1, y1: y1, x2: x2, y2: y2 };
        bandEl.style.left = (x1 * zoom) + 'px'; bandEl.style.top = (y1 * zoom) + 'px';
        bandEl.style.width = ((x2 - x1) * zoom) + 'px'; bandEl.style.height = ((y2 - y1) * zoom) + 'px';
      }
    }
  });

  document.addEventListener('mouseup', function (e) {
    if (stripDrag) {
      var sd = stripDrag; stripDrag = null; clearStripDropFeedback();
      if (sd.active && sd.target && Number.isFinite(sd.target.targetIndex)) {
        suppressClick = true;
        vscode.postMessage({
          type: 'stripMove',
          hostId: sd.ownerId,
          itemId: sd.itemId,
          targetParentItemId: sd.target.targetParentItemId || null,
          targetIndex: Math.max(0, Math.round(sd.target.targetIndex))
        });
        setStatus(T('designer.status.committing'));
      }
      return;
    }
    if (toolboxBand) {
      var tb = toolboxBand, rectTb = tb.rect; clearToolboxBand();
      suppressClick = true;
      if (tb.active && rectTb && rectTb.x2 > rectTb.x1 && rectTb.y2 > rectTb.y1) {
        vscode.postMessage({
          type: 'dropControl',
          controlType: tb.controlType,
          hitId: tb.hitId || 'this',
          x: Math.round(rectTb.x1),
          y: Math.round(rectTb.y1),
          width: Math.round(rectTb.x2 - rectTb.x1),
          height: Math.round(rectTb.y2 - rectTb.y1)
        });
      }
      return;
    }
    if (drag) {
      var d = drag; drag = null; clearGuides();
      var cdx = e.clientX - d.startX, cdy = e.clientY - d.startY;
      if (Math.abs(cdx) < 2 && Math.abs(cdy) < 2) { renderSelection(); return; }
      suppressClick = true;
      if (d.mode === 'move') {
        if (d.duplicate || e.ctrlKey || e.metaKey) {
          var ddx = d.delta ? d.delta.dx : cdx / zoom, ddy = d.delta ? d.delta.dy : cdy / zoom;
          vscode.postMessage({ type: 'duplicateDrag', ids: d.ids, dx: Math.round(ddx), dy: Math.round(ddy) });
        } else if (d.group) {
          postGenerationBoundCanvasIntent({ type: 'manipulateGroup', ids: d.ids, dx: d.delta.dx, dy: d.delta.dy });
        } else {
          var m = d.cur || { x: d.orig.x + cdx / zoom, y: d.orig.y + cdy / zoom, w: d.orig.w, h: d.orig.h };
          // Layout-owned children do not persist free Location. Preserve the actual release point as a separate
          // window-space intent so the host can resolve a TableLayoutPanel cell or FlowLayoutPanel insertion slot
          // against the exact live layout metadata. Ordinary controls keep using the candidate bounds as before.
          var canvasRect = canvas.getBoundingClientRect();
          postGenerationBoundCanvasIntent({
            type: 'manipulate', id: current, mode: 'move', x: m.x, y: m.y, width: m.w, height: m.h,
            dropX: (e.clientX - canvasRect.left) / zoom,
            dropY: (e.clientY - canvasRect.top) / zoom
          });
        }
      } else {
        var r = d.cur || { x: d.orig.x, y: d.orig.y, w: Math.max(4, d.orig.w + cdx / zoom), h: Math.max(4, d.orig.h + cdy / zoom) };
        postGenerationBoundCanvasIntent({ type: 'manipulate', id: current, mode: 'resize', x: r.x, y: r.y, width: r.w, height: r.h });
      }
      setStatus(T('designer.status.committing'));
      return;
    }
    if (band) {
      var bandWasActive = band.active, rect = band.rect, bandParentId = band.parentId || 'this'; band = null;
      if (bandEl) bandEl.style.display = 'none';
      if (bandWasActive && rect) {
        suppressClick = true;
        // Visual Studio selects every direct child that intersects the marquee, not only fully enclosed children.
        // Keep the active-container boundary strict: a Panel-scope marquee must not leak to overlapping Form siblings.
        var hits = [];
        for (var i = 0; i < controls.length; i++) {
          var c = controls[i]; if (c.isRoot || c.id === 'this') continue;
          if (c.parentId !== bandParentId) continue;
          if (c.x < rect.x2 && c.x + c.width > rect.x1 && c.y < rect.y2 && c.y + c.height > rect.y1) hits.push(c.id);
        }
        selectedItem = null; // a marquee selects controls → drop any on-canvas strip-item selection
        if (hits.length) { selection = hits; current = hits[hits.length - 1]; canMove = false; canResize = false; renderSelection(); postPick(current); }
        else { selection = []; current = null; renderSelection(); }
      }
      // a band that never moved (a click on the form bg) → handled by the click → selectSingle('this')
    }
  });

  // View Code / Save toolbar buttons were removed: F7 opens the code-behind, Ctrl+S saves (native custom editor).
  function doDelete() {
    if (nudge) flushNudge(); // commit a pending keyboard-nudge before it races this action's document change
    if (drag || stripDrag) return;
    if (submenuSel) { deleteSubmenuSel(); return; } // a selected nested flyout item is the delete target
    if (selectedItem) { deleteStripItem(); return; } // an on-canvas strip item is the delete target
    var ids = selectableIds();
    if (!ids.length) return;
    if (ids.length > 1) vscode.postMessage({ type: 'removeControls', ids: ids });
    else vscode.postMessage({ type: 'removeControl', id: ids[0] });
  }
  if (deleteCtlEl) deleteCtlEl.addEventListener('click', doDelete);
  // ---- duplicate (VS Ctrl+D): clone the selection in place (offset by the engine's paste nudge) WITHOUT
  // touching the Cut/Copy clipboard. The host copies each source to a temp blob and pastes it into the source's
  // own parent, one undo unit; the last clone is selected so repeated Ctrl+D cascades, as in VS. ----
  function doDuplicate() {
    if (nudge) flushNudge(); // commit a pending keyboard-nudge so the clone copies the nudged position, not a stale one
    var ids = selectableIds();
    if (!ids.length || drag) return;
    vscode.postMessage({ type: 'duplicate', ids: ids });
  }
  // ---- Lock Controls (VS "Lock Controls"): flip the locked state of every control on the form. Locked controls drop
  // their grab handles + a lock glyph appears, and mouse move/resize/nudge is blocked. Host persistence is view-only. ----
  function toggleLockAll(ids, lock) {
    for (var i = 0; i < ids.length; i++) { if (lock) lockedIds[ids[i]] = true; else delete lockedIds[ids[i]]; }
    if (lock) canvas.style.cursor = 'default'; // the menu overlay swallows mousemove — drop a stale 'move' cursor now
    queueCanvasState();
    renderSelection();
  }
  document.addEventListener('keydown', function (e) {
    if (e.key === 'F7') { e.preventDefault(); vscode.postMessage({ type: 'viewCode' }); return; } // VS: F7 = designer → code
    // F2 renames the selected on-canvas strip item (VS: F2 = rename). Same inline editor as the double-click path;
    // a separator has no Text so it isn't renamable. With no item selected, F2 routes the current ordinary component
    // through the same source-first rename path used by the tray and `(Name)` property.
    if (e.key === 'F2') {
      var af2 = document.activeElement;
      if (af2 && /^(INPUT|SELECT|TEXTAREA)$/.test(af2.tagName)) return;
      if (submenuSel) { // a selected nested flyout item renames via the same inline editor (separator = inert)
        if (!(drag || band || stripDrag || tabOrderMode || isSeparatorType(submenuSel.itemType))) { e.preventDefault(); renameSubmenuSel(); }
        return;
      }
      if (selectedItem) {
        if (drag || band || stripDrag || tabOrderMode || isSeparatorType(selectedItem.itemType)) return;
        e.preventDefault(); openItemRenameEditor(selectedItem);
        return;
      }
      if (drag || band || stripDrag || tabOrderMode || !current || current === 'this') return;
      var renameTarget = findControl(current) || findTray(current);
      if (!renameTarget || renameTarget.readOnly || renameTarget.editable === false
          || renameTarget.inherited || renameTarget.isInherited
          || renameTarget.ownership === 'inherited' || renameTarget.ownership === 'unresolved') return;
      e.preventDefault(); vscode.postMessage({ type: 'renameComponent', id: current });
      return;
    }
    if (e.key === 'Escape' && selectedToolboxControl) {
      selectedToolboxControl = null;
      clearToolboxBand();
      e.preventDefault();
      if (e.stopImmediatePropagation) e.stopImmediatePropagation();
      vscode.postMessage({ type: 'cancelToolboxSelection' });
      return;
    }
    if (e.key !== 'Delete' && e.key !== 'Del') return;
    var ae = document.activeElement;
    if (ae && /^(INPUT|SELECT|TEXTAREA)$/.test(ae.tagName)) return;
    e.preventDefault(); doDelete();
  });

  // ---- keyboard nudge (VS: Arrow=move 1px, Ctrl+Arrow=grid step, Shift+Arrow=resize) ----
  // The most-used designer gesture. Moves/resizes optimistically (selection box follows) and commits the WHOLE
  // key series as ONE edit through the existing manipulate/manipulateGroup paths → one undo, one re-render.
  // VS selection traversal: Tab/Shift+Tab cycle siblings, Esc selects the parent container, and Ctrl+A selects
  // every sibling in the current design scope. These are selection-only gestures; source is untouched.
  function controlTabIndex(c) {
    var n = Number(c && c.tabIndex);
    return isFinite(n) ? n : 0;
  }
  function controlLayoutIndex(id) {
    for (var i = 0; i < controls.length; i++) { if (controls[i].id === id) return i; }
    return controls.length;
  }
  function compareTabTraversal(a, b) {
    return (controlTabIndex(a) - controlTabIndex(b))
      || (controlLayoutIndex(a.id) - controlLayoutIndex(b.id))
      || String(a.id).localeCompare(String(b.id));
  }
  document.addEventListener('keydown', function (e) {
    var ae = document.activeElement;
    if (ae && /^(INPUT|SELECT|TEXTAREA)$/.test(ae.tagName)) return;
    if (drag || band || stripDrag || tabOrderMode || slotEditEl) return;

    var c = current ? findControl(current) : null;
    if (!c) return;

    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && String(e.key).toLowerCase() === 'a') {
      var scopeParent = c.isRoot || c.id === 'this' ? c.id : c.parentId;
      var scoped = controls.filter(function (candidate) {
        return !candidate.isRoot && candidate.id !== 'this' && candidate.parentId === scopeParent;
      }).sort(compareTabTraversal);
      if (!scoped.length) return;
      if (ignorePendingRenderInput(e)) return;
      e.preventDefault(); flushNudge(); selectedItem = null;
      selection = scoped.map(function (candidate) { return candidate.id; });
      if (selection.indexOf(current) < 0) current = selection[selection.length - 1];
      canMove = false; canResize = false; renderSelection(); postPick(current);
      return;
    }

    if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      var parentId = c.isRoot || c.id === 'this' ? c.id : c.parentId;
      var siblings = controls.filter(function (candidate) {
        return !candidate.isRoot && candidate.id !== 'this' && candidate.parentId === parentId;
      }).sort(compareTabTraversal);
      if (!siblings.length) return;
      var index = siblings.findIndex(function (candidate) { return candidate.id === current; });
      var nextIndex = index < 0 ? (e.shiftKey ? siblings.length - 1 : 0)
        : (index + (e.shiftKey ? -1 : 1) + siblings.length) % siblings.length;
      if (ignorePendingRenderInput(e)) return;
      e.preventDefault(); flushNudge(); selectSingle(siblings[nextIndex].id);
      return;
    }

    if (e.key === 'Escape' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      if ((ctxEl && ctxEl.classList.contains('open')) || submenuLevels.length) return;
      var parent = c.parentId ? findControl(c.parentId) : null;
      if (!parent) return;
      if (ignorePendingRenderInput(e)) return;
      e.preventDefault(); flushNudge(); selectSingle(parent.id);
    }
  });

  function flushNudge() {
    if (!nudge) return;
    var n = nudge; nudge = null;
    if (n.timer) { clearTimeout(n.timer); n.timer = null; }
    if (n.mode === 'move') {
      if (n.ids.length > 1) postGenerationBoundCanvasIntent({ type: 'manipulateGroup', ids: n.ids, dx: n.dx, dy: n.dy });
      else { var c = findControl(n.ids[0]); if (c) postGenerationBoundCanvasIntent({ type: 'manipulate', id: n.ids[0], mode: 'move', x: c.x, y: c.y, width: c.width, height: c.height }); }
    } else { // resize — single selection only
      var rc = findControl(n.ids[0]); if (rc) postGenerationBoundCanvasIntent({ type: 'manipulate', id: n.ids[0], mode: 'resize', x: rc.x, y: rc.y, width: rc.width, height: rc.height });
    }
    setStatus(T('designer.status.committing'));
  }
  function cancelNudge() {
    if (!nudge) return;
    if (nudge.timer) clearTimeout(nudge.timer);
    nudge = null;
  }
  document.addEventListener('keydown', function (e) {
    if (e.key.indexOf('Arrow') !== 0) return; // ArrowLeft/Right/Up/Down
    var ae = document.activeElement;
    if (ae && /^(INPUT|SELECT|TEXTAREA)$/.test(ae.tagName)) return; // don't hijack arrows while typing
    if (drag || band || stripDrag || tabOrderMode) return;
    var ids = selectableIds();
    if (!ids.length) return;
    for (var li = 0; li < ids.length; li++) { if (isLocked(ids[li])) return; } // a locked control can't be nudged
    var resize = e.shiftKey;
    if (resize) { if (ids.length > 1 || !canResize) return; }  // resize: single, resizable selection only
    else if (!canMove) return;                                 // move: respect the host's movability gate
    if (ignorePendingRenderInput(e)) return;
    e.preventDefault();
    var step = (e.ctrlKey || e.metaKey) ? placementGridSize : 1;
    var dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
    var dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
    if (!dx && !dy) return;
    var mode = resize ? 'resize' : 'move';
    // a change of mode or selection starts a fresh undo series
    if (nudge && (nudge.mode !== mode || nudge.ids.join(',') !== ids.join(','))) flushNudge();
    if (!nudge) nudge = { mode: mode, ids: ids.slice(), dx: 0, dy: 0, timer: null };
    if (resize) {
      var c = findControl(ids[0]); if (!c) return;
      c.width = Math.max(4, c.width + dx);
      c.height = Math.max(4, c.height + dy);
    } else {
      for (var i = 0; i < ids.length; i++) { var cc = findControl(ids[i]); if (cc) { cc.x += dx; cc.y += dy; } }
      nudge.dx += dx; nudge.dy += dy;
    }
    renderSelection();
    if (nudge.timer) clearTimeout(nudge.timer);
    nudge.timer = setTimeout(flushNudge, NUDGE_COMMIT_MS);
  });

  function setDirty(d) { if (dirtyEl) dirtyEl.textContent = d ? T('designer.dirtyBadge') : ''; if (saveEl) saveEl.disabled = !d; }

  // ---- VS-style right-click context menu (HTML; native VS Code menus aren't reachable inside a webview) ----
  // Mirrors the Visual Studio designer menu: View Code, z-order, All Properties / Learn More, the "Select
  // '<ancestor>'" parent chain, Cut/Copy/Paste, Delete, Properties. Gating matches VS: the root form / a
  // UserControl can't be Cut, Copied, Deleted, or z-ordered (it owns the surface); Paste needs a non-empty
  // clipboard. Engine-backed actions (z-order, cut/copy/paste) post to the host; navigation is local.
  var ctxEl = document.getElementById('ctxMenu');
  var clipboardHas = false;
  function escHtml(s) { return String(s).replace(/[&<>"]/g, function (c) { return c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'; }); }
  function closeCtx() { if (ctxEl) ctxEl.className = 'ctxmenu'; }

  function zorder(front) {
    var ids = selectableIds(); if (!ids.length) return;
    if (ids.length > 1) vscode.postMessage({ type: front ? 'bringToFrontGroup' : 'sendToBackGroup', ids: ids });
    else vscode.postMessage({ type: front ? 'bringToFront' : 'sendToBack', id: ids[0] });
  }
  function doCopy() {
    if (nudge) flushNudge();
    var ids = selectableIds(); if (!ids.length) return;
    if (ids.length > 1) vscode.postMessage({ type: 'copyControls', ids: ids });
    else vscode.postMessage({ type: 'copy', id: ids[0] });
  }
  function doCut() {
    if (nudge) flushNudge();
    var ids = selectableIds(); if (!ids.length) return;
    if (ids.length > 1) vscode.postMessage({ type: 'cutControls', ids: ids });
    else vscode.postMessage({ type: 'cut', id: ids[0] });
  }
  function doPaste() { if (nudge) flushNudge(); vscode.postMessage({ type: 'paste', id: current || 'this' }); }

  function buildCtxMenu() {
    // a selected NESTED flyout item gets the same focused menu. Capture the descriptor NOW: clicking a menu item fires
    // a mousedown that onSubmenuDocDown treats as click-away → it closes the flyout and clears submenuSel before the
    // action runs, so the closures must not read the (now-null) live selection.
    if (submenuSel) {
      var nsel = submenuSel, nm = [];
      if (!isSeparatorType(nsel.itemType))
        nm.push({ label: T('designer.menu.renameItem'), acc: 'F2', act: function () { renameSubmenuSel(nsel); } });
      nm.push({ label: T('designer.menu.deleteItem'), acc: 'Del', act: function () { deleteSubmenuSel(nsel); } });
      return nm;
    }
    // a selected on-canvas strip item gets its own focused menu (Rename / Delete Item) — the generic control menu
    // (Cut/Copy/z-order/Delete-control) doesn't apply to a ToolStripItem.
    if (selectedItem) {
      var im = [];
      if (!isSeparatorType(selectedItem.itemType))
        im.push({ label: T('designer.menu.renameItem'), acc: 'F2', act: function () { if (selectedItem) openItemRenameEditor(selectedItem); } });
      im.push({ label: T('designer.menu.deleteItem'), acc: 'Del', act: deleteStripItem });
      return im;
    }
    var ids = selectableIds();
    var primary = current ? findControl(current) : null;            // a visual control (null for tray / nothing)
    var trayItem = (!primary && current) ? findTray(current) : null; // a non-visual component
    var subject = primary || trayItem;
    var isRoot = !!primary && (primary.isRoot || current === 'this');
    var multi = selection.length > 1;
    var canDelete = ids.length > 0;       // false when only the root is selected → Delete/Cut/Copy greyed (VS)
    var canZ = ids.length > 0 && !!primary && !isRoot; // z-order applies to visual non-root controls only
    var menu = [];
    menu.push({ label: T('designer.menu.viewCode'), acc: 'F7', act: function () { vscode.postMessage({ type: 'viewCode' }); } });
    menu.push({ sep: 1 });
    menu.push({ label: T('designer.menu.bringToFront'), disabled: !canZ, act: function () { zorder(true); } });
    menu.push({ label: T('designer.menu.sendToBack'), disabled: !canZ, act: function () { zorder(false); } });
    menu.push({ sep: 1 });
    menu.push({ label: T('designer.menu.alignToGrid'), disabled: !canDelete || selectionHasLocked(), act: alignSelectionToGrid });
    // Lock Controls (VS): toggles ALL controls on the form. Per-form view state (outside source/.resx), checked when
    // every control is already locked. Disabled on an empty form (nothing to lock).
    var lockable = [];
    for (var lci = 0; lci < controls.length; lci++) { var lc = controls[lci]; if (!lc.isRoot && lc.id !== 'this') lockable.push(lc.id); }
    var allLocked = lockable.length > 0;
    for (var lk = 0; lk < lockable.length; lk++) { if (!isLocked(lockable[lk])) { allLocked = false; break; } }
    menu.push({ label: T('designer.menu.lockControls'), disabled: lockable.length === 0, checked: allLocked,
                act: function () { toggleLockAll(lockable, !allLocked); } });
    menu.push({ sep: 1 });
    menu.push({ label: T('designer.menu.allProperties'), act: function () { vscode.postMessage({ type: 'showProperties' }); } });
    if (!multi && subject) menu.push({ label: T('designer.menu.learnMore'), act: function () { vscode.postMessage({ type: 'learnMore', typeName: subject.type }); } });
    // "Select '<ancestor>'" chain — immediate parent up to the root, like VS (single visual selection only)
    if (!multi && primary && !isRoot) {
      var chain = [], p = primary.parentId;
      while (p) { var pc = findControl(p); if (!pc) break; chain.push(pc); p = pc.parentId; }
      if (chain.length) {
        menu.push({ sep: 1 });
        chain.forEach(function (pc) {
          menu.push({ label: T('designer.menu.selectAncestor', { name: pc.name }), act: (function (idd) { return function () { selectSingle(idd); }; })(pc.id) });
        });
      }
    }
    // tab host (WinForms TabControl / DevExpress XtraTabControl): add a new tab, or delete the ACTIVE tab (the one
    // currently shown — switch to a tab first to delete it). net48 compiled preview. Renaming a tab is a double-click
    // on its header; switching is a single click.
    if (!multi && primary && primary.isTabHost) {
      menu.push({ sep: 1 });
      menu.push({ label: T('designer.menu.addTab'), act: function () { vscode.postMessage({ type: 'addTab', hostId: primary.id }); } });
      var activePage = null;
      for (var pi = 0; pi < controls.length; pi++) { if (controls[pi].parentId === primary.id) { activePage = controls[pi]; break; } }
      menu.push({
        label: T('designer.menu.moveTabLeft'),
        disabled: !activePage,
        act: function () { if (activePage) vscode.postMessage({ type: 'moveTab', hostId: primary.id, pageId: activePage.id, direction: 'left' }); },
      });
      menu.push({
        label: T('designer.menu.moveTabRight'),
        disabled: !activePage,
        act: function () { if (activePage) vscode.postMessage({ type: 'moveTab', hostId: primary.id, pageId: activePage.id, direction: 'right' }); },
      });
      menu.push({
        label: activePage ? T('designer.menu.deleteTabNamed', { name: activePage.name }) : T('designer.menu.deleteTab'),
        disabled: !activePage,
        act: function () { if (activePage) vscode.postMessage({ type: 'deleteTab', hostId: primary.id, pageId: activePage.id }); },
      });
    }
    menu.push({ sep: 1 });
    menu.push({ label: T('designer.menu.cut'), acc: 'Ctrl+X', disabled: !canDelete, act: doCut });
    menu.push({ label: T('designer.menu.copy'), acc: 'Ctrl+C', disabled: !canDelete, act: doCopy });
    menu.push({ label: T('designer.menu.paste'), acc: 'Ctrl+V', disabled: !clipboardHas, act: doPaste });
    menu.push({ label: T('designer.menu.duplicate'), acc: 'Ctrl+D', disabled: !canDelete, act: doDuplicate });
    menu.push({ sep: 1 });
    menu.push({ label: T('designer.menu.delete'), acc: 'Del', disabled: !canDelete, act: doDelete });
    menu.push({ sep: 1 });
    menu.push({ label: T('designer.menu.properties'), act: function () { vscode.postMessage({ type: 'showProperties' }); } });
    return menu;
  }

  function renderCtx(x, y) {
    if (!ctxEl) return;
    var items = buildCtxMenu();
    ctxEl.innerHTML = '';
    items.forEach(function (mi) {
      if (mi.sep) { var s = document.createElement('div'); s.className = 'sep'; ctxEl.appendChild(s); return; }
      var d = document.createElement('div'); d.className = 'mi' + (mi.disabled ? ' disabled' : '');
      d.innerHTML = '<span><span style="display:inline-block;width:1.1em">' + (mi.checked ? '✓' : '') + '</span>' + escHtml(mi.label) + '</span>' + (mi.acc ? '<span class="acc">' + escHtml(mi.acc) + '</span>' : '');
      if (!mi.disabled && mi.act) d.addEventListener('click', function () { closeCtx(); mi.act(); });
      ctxEl.appendChild(d);
    });
    ctxEl.className = 'ctxmenu open';
    ctxEl.style.left = '0px'; ctxEl.style.top = '0px'; // measure, then clamp into the viewport
    var w = ctxEl.offsetWidth, h = ctxEl.offsetHeight;
    ctxEl.style.left = Math.max(2, Math.min(x, window.innerWidth - w - 4)) + 'px';
    ctxEl.style.top = Math.max(2, Math.min(y, window.innerHeight - h - 4)) + 'px';
  }

  // right-click a control / the form background → select it (unless already in a multi-selection), then menu
  surfaceWrap.addEventListener('contextmenu', function (e) {
    e.preventDefault();
    if (ignorePendingRenderInput(e)) return;
    if (!controls.length || drag || band || stripDrag) return;
    // a flyout-ROW right-click is handled by onSubmenuCtx (which stopPropagation's) — so any contextmenu that reaches
    // here is OUTSIDE the flyout. Close it + clear submenuSel now, else a KEYBOARD menu (Menu key / Shift+F10, no
    // preceding mousedown to trigger onSubmenuDocDown) would build the nested item menu for a control the user targeted.
    closeSubmenu();
    var rect = canvas.getBoundingClientRect();
    var px = (e.clientX - rect.left) / zoom, py = (e.clientY - rect.top) / zoom;
    // right-clicking a top-level strip item selects it and opens the item menu (Rename / Delete Item)
    var sItem = stripItemHit(px, py);
    if (sItem) { selectStripItem(sItem); renderCtx(e.clientX, e.clientY); return; }
    var id = hitTest(px, py) || 'this';
    if (selection.indexOf(id) < 0) selectSingle(id);
    renderCtx(e.clientX, e.clientY);
  });
  document.addEventListener('keydown', function (e) {
    var menuKey = e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10');
    if (!menuKey) return;
    var ae = document.activeElement;
    if (ae && /^(INPUT|SELECT|TEXTAREA)$/.test(ae.tagName)) return;
    if (ignorePendingRenderInput(e) || !controls.length || drag || band || stripDrag) return;
    e.preventDefault();
    var c = current ? findControl(current) : null;
    if (c) renderCtx(Math.round((c.x + Math.max(8, c.width / 2)) * zoom), Math.round((c.y + Math.max(8, c.height / 2)) * zoom));
    else renderCtx(16, 16);
  });
  // right-click a tray component (non-visual) → select it, then menu
  if (trayEl) trayEl.addEventListener('contextmenu', function (e) {
    e.preventDefault();
    var chip = e.target; while (chip && chip !== trayEl && chip.className.indexOf('trayItem') < 0) chip = chip.parentNode;
    if (!chip || chip === trayEl) return;
    var idx = Array.prototype.indexOf.call(trayEl.children, chip);
    var t = tray[idx]; if (!t) return;
    selectedItem = null;
    selection = [t.id]; current = t.id; canMove = false; canResize = false;
    renderSelection(); updateTraySelClasses(); postPick(t.id);
    renderCtx(e.clientX, e.clientY);
  });
  document.addEventListener('mousedown', function (e) { if (ctxEl && ctxEl.classList.contains('open') && !ctxEl.contains(e.target)) closeCtx(); }, true);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeCtx(); });
  // VS clipboard accelerators (Cut/Copy/Paste) — guard against typing in a side-panel input
  document.addEventListener('keydown', function (e) {
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
    var ae = document.activeElement;
    if (ae && /^(INPUT|SELECT|TEXTAREA)$/.test(ae.tagName)) return;
    var k = (e.key || '').toLowerCase();
    if (k === 'x') { e.preventDefault(); doCut(); }
    else if (k === 'c') { e.preventDefault(); doCopy(); }
    else if (k === 'v') { e.preventDefault(); doPaste(); }
    else if (k === 'd') { e.preventDefault(); doDuplicate(); } // VS: Ctrl+D = Duplicate
  });

  window.addEventListener('message', function (e) {
    var m = e.data;
    if (m.type === 'canvasViewState') {
      var vs = m.state || {};
      if (typeof vs.zoom === 'number' && isFinite(vs.zoom)) zoom = clampZoom(vs.zoom);
      lockedIds = {};
      (vs.lockedIds || []).forEach(function (id) { if (typeof id === 'string' && id) lockedIds[id] = true; });
      applyZoomStyles();
    } else if (m.type === 'placementSettings') {
      placementSnapOverrideModifier = sanitizePlacementSnapOverrideModifier(m.snapOverrideModifier);
      placementLayoutMode = sanitizeLayoutMode(m.layoutMode);
      placementGridSize = sanitizeGridSize(m.gridSize);
      placementShowGrid = m.showGrid === true;
      renderGrid();
    } else if (m.type === 'toolboxSelection') {
      selectedToolboxControl = m.controlType || null;
      clearToolboxBand();
    } else if (m.type === 'render') {
      // A host render can be the result of native Undo while a keyboard nudge is still inside its debounce window.
      // The incoming document state wins: never let the stale timer post its optimistic coordinates afterwards.
      cancelNudge();
      hasRendered = true; hideOverlay();
      drawPng(m.png, 0, 0, m.width, m.height, true, m.gen);
    } else if (m.type === 'layout') {
      // strip/item geometry may have moved → dismiss a drifting inline add-editor and the synthetic submenu flyout
      // (its anchor item may have moved/vanished). Done HERE (and in setZoom), NOT in renderSelection: a 'manip'/'select'
      // push re-renders selection WITHOUT moving the slot/flyout, and must not eat typed text or snap the menu shut.
      closeSlotEditor(); closeSubmenu(); clearStripDropFeedback(); stripDrag = null;
      controls = sortControlsForHitTest(m.controls || []);
      stripItems = m.toolStripItems || [];
      renderGrid();
      // drop any selected ids that no longer exist (e.g. after a remove), keeping tray ids
      selection = selection.filter(function (id) { return findControl(id) || findTray(id); });
      for (var lid in lockedIds) { if (Object.prototype.hasOwnProperty.call(lockedIds, lid) && !findControl(lid)) delete lockedIds[lid]; } // prune locks for removed controls
      if (current && !findControl(current) && !findTray(current)) current = selection.length ? selection[selection.length - 1] : null;
      renderSelection();
    } else if (m.type === 'tray') {
      tray = m.items || []; renderTray();
    } else if (m.type === 'stripAddDone') {
      // The host confirms an on-canvas add's OUTCOME, correlated by the token the stripAdd carried. Consume the matching
      // reopen arm ONLY here — the ambient `tray` message can't tell adds apart and isn't sent for a rejected/superseded
      // render, which is exactly how the tray-signal version resurrected stale flyouts / consumed the wrong arm (codex).
      // This arrives AFTER this add's own render→layout→tray, so stripItems/tray are already fresh. ok:false → clear only.
      if (slotReopen && m.token != null && slotReopen.token === m.token) {
        var rr = slotReopen; slotReopen = null;
        if (m.ok && !submenuLevels.length) reopenFlyout(rr); // !submenuLevels: don't clobber a flyout the user opened meanwhile
      }
    } else if (m.type === 'patch') {
      drawPng(m.png, m.x, m.y, m.width, m.height, false, m.gen);
    } else if (m.type === 'select') {
      // host selection (after a render / group op). Keep the multi-set if the primary is part of it.
      // Token bookkeeping FIRST: retire the pending canvas pick this echoes, then decide suppression. Suppress ONLY an
      // echo whose token an add-editor armed against (openSlotEditor) — the one pick whose selection it dropped to disarm
      // the toolbar Delete. Precise under every ordering (codex review): a late echo after the editor closed is still
      // matched by token (P1); a `layout` / `select`-less render never disarms it (the set is untouched by layout); a
      // DIFFERENT component's select — or any host-authoritative select (fullRender / a Properties-panel pick), which
      // carries NO token — is never suppressed (P2 + the same-owner re-select leak); and a SET keeps every concurrently
      // armed token, so a second add-editor can't drop a first still-in-flight arm.
      if (m.token != null && pendingPick && m.token === pendingPick.token) pendingPick = null; // retire the echoed canvas pick
      if (m.token != null && suppressPickTokens.has(m.token)) {
        suppressPickTokens.delete(m.token); // consume this arm; a suppressed echo is a TRUE no-op — it must NOT clear the
        // current strip-item selection nor close an open submenu (those belong to whatever the user selected meanwhile).
      } else {
        selectedItem = null;
        // an explicit host control-selection supersedes any on-canvas strip-item highlight/flyout — EXCEPT the echo of a
        // tray chip's own `pick`: an off-tree strip's flyout is dismissed by selecting a real CONTROL (or click-away /
        // layout / zoom), never by a select that targets a TRAY component. Keying on findTray(m.id) (not the exact owner)
        // also survives a rapid chip-to-chip switch, where a stale `select` echo for the PREVIOUS strip would otherwise
        // arrive after the NEW flyout opened and wrongly close it. A real control select → findTray null → closes it.
        if (!(submenuLevels.length && submenuLevels[0].isStripRoot && findTray(m.id))) closeSubmenu();
        if (Array.isArray(m.ids) && m.ids.indexOf(m.id) >= 0) selection = m.ids.slice();
        else if (selection.indexOf(m.id) < 0) selection = [m.id];
        if (m.id !== current) { canMove = false; canResize = false; }
        current = m.id;
        renderSelection(); updateTraySelClasses();
      }
    } else if (m.type === 'manip') {
      if (m.id === current) { canMove = !!m.move; canResize = !!m.resize; renderSelection(); }
    } else if (m.type === 'tasks') {
      // the selected control's property descriptors + the vendor's own declared Tasks menu (net48 only; [] elsewhere,
      // which also clears a stale vendor menu when selection moves to a framework control) — feeds the smart-tag flyout
      tasksState = m.component ? { id: m.id, comp: m.component, vendorTags: m.vendorTags || [] } : null;
      renderDesignerAdorners();
      renderSmartTag();
    } else if (m.type === 'designerAdornerHit') {
      for (var ai = 0; ai < designerAdornerEls.length; ai++) {
        var ae = designerAdornerEls[ai], state = ae._designerAdorner;
        if (!state || state.controlId !== m.id || state.adorner.id !== m.adornerId
          || ae._designerAdornerHitToken !== m.token) continue;
        ae.classList.remove('pending'); ae.classList.toggle('hit', m.ok === true && m.hit === true);
      }
    } else if (m.type === 'loading') {
      // hide the align tools while (re)loading — the retained-context DOM can still show them from a prior
      // multi-selection; they'll reappear via renderSelection only if a 2+ selection survives the render
      if (alignEl) alignEl.style.display = 'none';
      if (!hasRendered) showOverlay(m.message, false);
    } else if (m.type === 'status') {
      setStatus(m.message);
    } else if (m.type === 'dirty') {
      setDirty(m.dirty);
    } else if (m.type === 'clipboard') {
      clipboardHas = !!m.has;
    } else if (m.type === 'requestDelete') {
      // Delete pressed while focus was in the side panel (Toolbox/Properties tab); this canvas owns the
      // selection, so run the same delete path as the local Delete key / toolbar button.
      doDelete();
    } else if (m.type === 'formNotice') {
      // 0.10.0 trust-floor — persistent, non-dismissible form-level notice (localizable read-only, and
      // reused by later fidelity banners). kind set → show with the given text; null → hide. Separate
      // from #diag so a partial-render banner and this lock strip never overwrite each other.
      if (formNoticeEl) {
        if (m.kind) {
          // always set the glyph (default 🔒) so a prior custom icon can't leak onto a later notice that
          // supplies none. engine/host text → textContent, never innerHTML.
          if (formNoticeIconEl) formNoticeIconEl.textContent = m.icon || '🔒';
          formNoticeMsgEl.textContent = m.text || '';
          // The strip is line-clamped to two lines (see #formNoticeMsg CSS); expose the full disclosure on hover.
          formNoticeMsgEl.title = m.text || '';
          formNoticeEl.title = m.text || ''; // collapsed: the icon alone still carries the whole disclosure
          formNoticeEl.style.display = '';
          applyNoticeCollapsed();
        } else {
          formNoticeEl.style.display = 'none';
        }
      }
    } else if (m.type === 'renderDiag') {
      // posted after every successful render: non-empty → warn banner listing what the partial render skipped;
      // empty → this render is clean, hide the banner and reset the dismiss latch so future issues re-surface.
      var diagItems = m.items || [];
      if (diagItems.length) showDiag('warn', TN('designer.diag.skipped', diagItems.length), diagItems);
      else { diagDismissedSig = null; hideDiag(); }
    } else if (m.type === 'error') {
      if (!hasRendered) showOverlay(T('designer.overlay.designerError', { message: m.message }), true);
      // A prior render is on the canvas. Only a real RENDER failure (m.renderFailure, set by the host's fail()/
      // frameworkUnbuilt paths) means the shown preview is stale → persistent "last successful preview" err banner
      // that the next clean render clears. A failed user ACTION (edit/move/paste RPC error) is NOT a render failure —
      // the canvas is intact — so surface it as the unobtrusive footer status, not a scary stale-preview banner.
      if (m.renderFailure) {
        var failureItem = {
          category: 'initError',
          target: m.target || 'this',
          text: m.cause || m.message || '',
          detail: m.cause && m.cause !== m.message ? (m.message || '') : '',
        };
        showDiag('err', T('designer.diag.stalePreview', { message: m.message }), [failureItem]);
      }
      else if (hasRendered) setStatus(T('designer.status.error', { message: m.message }));
    }
  });

  // Report the exact display DPR separately from the engine's integer capture scale.  The host supersamples at 2x for
  // fractional Windows ratios and lets Chromium downsample into the actual device grid, so form coordinates remain
  // logical pixels and the cached net48 graph never needs a lossy fractional Scale/Scale-back cycle.
  var lastReportedDpr = (typeof window.devicePixelRatio === 'number' && isFinite(window.devicePixelRatio))
    ? window.devicePixelRatio : 1;
  vscode.postMessage({ type: 'ready', dpr: lastReportedDpr });
  window.addEventListener('resize', function () {
    var nextDpr = (typeof window.devicePixelRatio === 'number' && isFinite(window.devicePixelRatio))
      ? window.devicePixelRatio : 1;
    if (Math.abs(nextDpr - lastReportedDpr) < 0.01) return;
    lastReportedDpr = nextDpr;
    vscode.postMessage({ type: 'dprChanged', dpr: nextDpr });
  });
})();
