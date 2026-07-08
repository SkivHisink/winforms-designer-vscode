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
  var selBox = document.getElementById('sel');
  var selName = document.getElementById('selName');
  var deleteCtlEl = document.getElementById('deleteCtl');
  var saveEl = document.getElementById('save');
  var dirtyEl = document.getElementById('dirty');
  var statusEl = document.getElementById('status');
  var overlayEl = document.getElementById('overlay');
  var hasRendered = false;
  function showOverlay(msg, isErr) { overlayEl.style.display = 'flex'; overlayEl.className = isErr ? 'err' : ''; overlayEl.textContent = msg; }
  function hideOverlay() { overlayEl.style.display = 'none'; }

  // ---- T2.2: partial-render / failure diagnostics banner (top strip). 'warn' = constructs the (partial) render
  // skipped, with an expandable categorized list; 'err' = a hard render failure while a prior render is kept on the
  // canvas ("showing the last successful preview"). Dismiss latches a signature so the SAME problem-set doesn't
  // re-nag across re-renders, but a CHANGED set (or a clean render) re-shows / resets. ----
  var diagEl = document.getElementById('diag');
  var diagMsgEl = document.getElementById('diagMsg');
  var diagToggleEl = document.getElementById('diagToggle');
  var diagListEl = document.getElementById('diagList');
  var diagDismissEl = document.getElementById('diagDismiss');
  var diagSig = '';             // signature of what's currently shown
  var diagDismissedSig = null;  // signature the user dismissed (stay hidden while the next set matches it)
  var diagExpanded = false;
  var DIAG_MAX = 40;            // cap the rendered list; excess collapses to a "+N more" row
  var CAT_LABEL = { missingType: 'designer.diag.cat.missingType', initError: 'designer.diag.cat.initError', unsupported: 'designer.diag.cat.unsupported' };
  function diagSignature(mode, msg, items) {
    // JSON-encode fields so field boundaries are unambiguous — a space/'|'/'\n'-joined key would let two different
    // problem sets collide ("a b"+"c" == "a"+"b c") and wrongly keep a banner dismissed for a DIFFERENT set.
    var parts = items.map(function (i) { return JSON.stringify([i.category, i.text, i.detail]); });
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

  var controls = [];      // innermost-first (engine order)
  var current = null;     // primary selection id (drives the Properties panel + resize handles)
  var selection = [];     // all selected ids (multi-select); always contains `current` when non-empty
  var tray = [];          // non-visual components (component tray)
  var stripItems = [];    // per-item geometry for ToolStrip/MenuStrip/StatusStrip incl. the trailing "Type Here" slot
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
  var nudge = null;        // in-progress keyboard-nudge series (arrow keys) — debounced into ONE commit/undo
  var NUDGE_GRID = 8;      // Ctrl+Arrow step (VS default designer grid); plain Arrow = 1px
  var NUDGE_COMMIT_MS = 250; // idle after the last arrow key before the accumulated nudge is committed
  var suppressClick = false; // swallow the click that ENDS a drag/band so it doesn't re-select
  // ---- Lock Controls (VS): a locked control can't be moved/resized/nudged by mouse. SESSION-ONLY — webview state,
  // no engine / no .resx persistence yet (resets on reload); the "Lock Controls" menu toggles ALL controls, as VS does.
  var lockedIds = {};      // { id: true } for locked controls
  function isLocked(id) { return !!lockedIds[id]; }
  function selectionHasLocked() { var s = selectableIds(); for (var i = 0; i < s.length; i++) { if (isLocked(s[i])) return true; } return false; }
  var HANDLE_DIRS = ['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se'];
  var handles = {};
  HANDLE_DIRS.forEach(function (dir) {
    var h = document.createElement('div');
    h.className = 'handle h-' + dir;
    h.style.display = 'none';
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
  // StatusStrip (engine-supplied window-space geometry). Read-only affordance in this slice — it previews where a
  // new item lands; the click-to-add interaction is a follow-up. Pooled overlay divs like renderContainers. ----
  var stripSlotEls = [];
  function stripSlotEl(i) {
    while (stripSlotEls.length <= i) { var d = document.createElement('div'); d.className = 'typehereslot'; d.style.display = 'none'; d.textContent = '+'; surfaceWrap.appendChild(d); stripSlotEls.push(d); }
    return stripSlotEls[i];
  }
  function renderStripSlots() {
    var n = 0;
    if (hasRendered) {
      for (var i = 0; i < stripItems.length; i++) {
        var it = stripItems[i];
        if (!it.isTypeHere) continue; // this slice draws only the trailing add-slot; per-item outlines come later
        var b = stripSlotEl(n++); b.style.display = 'flex';
        b.style.left = (it.x * zoom) + 'px'; b.style.top = (it.y * zoom) + 'px';
        b.style.width = Math.max(0, it.width * zoom) + 'px'; b.style.height = Math.max(0, it.height * zoom) + 'px';
      }
    }
    for (; n < stripSlotEls.length; n++) stripSlotEls[n].style.display = 'none';
  }

  function findControl(id) { for (var i = 0; i < controls.length; i++) { if (controls[i].id === id) return controls[i]; } return null; }
  function findTray(id) { for (var i = 0; i < tray.length; i++) { if (tray[i].id === id) return tray[i]; } return null; }

  // ---- component tray: non-visual components as a strip below the surface; click to select ----
  function renderTray() {
    if (!trayEl) return;
    trayEl.innerHTML = '';
    if (!tray.length) { trayEl.style.display = 'none'; return; }
    trayEl.style.display = '';
    tray.forEach(function (t) {
      var chip = document.createElement('div');
      chip.className = 'trayItem' + (t.id === current ? ' sel' : '');
      chip.textContent = t.name + ' : ' + shortType(t.type);
      chip.title = t.id + ' : ' + t.type;
      chip.addEventListener('click', function () {
        // a tray component has no visual bounds → clear the canvas selection box, drive the Properties panel
        selection = [t.id]; current = t.id; canMove = false; canResize = false;
        renderSelection(); renderTray(); vscode.postMessage({ type: 'pick', id: t.id });
      });
      trayEl.appendChild(chip);
    });
  }
  function setStatus(s) { statusEl.textContent = s || ''; }
  function shortType(t) { var i = t.lastIndexOf('.'); return i < 0 ? t : t.slice(i + 1); }
  function selectableIds() { var r = []; for (var i = 0; i < selection.length; i++) { if (selection[i] && selection[i] !== 'this') r.push(selection[i]); } return r; }

  var lastDrawnGen = -1;
  function drawPng(b64, dx, dy, dw, dh, full, gen) {
    var g = (typeof gen === 'number') ? gen : (lastDrawnGen + 1);
    var img = new Image();
    img.onload = function () {
      if (g < lastDrawnGen) return;
      lastDrawnGen = g;
      if (full) { canvas.width = dw; canvas.height = dh; natW = dw; natH = dh; applyZoomStyles(); ctx.drawImage(img, 0, 0); }
      else { ctx.clearRect(dx, dy, dw, dh); ctx.drawImage(img, dx, dy); }
    };
    img.onerror = function () { /* leave the prior frame; a later event refreshes */ };
    img.src = 'data:image/png;base64,' + b64;
  }

  // ---- zoom (display scaling) ----
  var zoom = 1;
  var natW = 1, natH = 1;
  var ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 2, 3, 4];
  var zoomOutEl = document.getElementById('zoomOut');
  var zoomInEl = document.getElementById('zoomIn');
  var zoomLabelEl = document.getElementById('zoomLabel');
  var zoomFitEl = document.getElementById('zoomFit');
  var stageEl = document.getElementById('stage');
  var _persisted = {};
  try { _persisted = (vscode.getState && vscode.getState()) || {}; } catch (_e) {}
  function clampZoom(z) { return Math.max(0.1, Math.min(8, z)); }
  if (typeof _persisted.zoom === 'number') zoom = clampZoom(_persisted.zoom);
  function applyZoomStyles() {
    canvas.style.width = (natW * zoom) + 'px'; canvas.style.height = (natH * zoom) + 'px';
    surfaceWrap.style.width = (natW * zoom) + 'px'; surfaceWrap.style.height = (natH * zoom) + 'px';
    canvas.style.imageRendering = zoom >= 1 ? 'pixelated' : 'auto';
    if (zoomLabelEl) zoomLabelEl.textContent = Math.round(zoom * 100) + '%';
    renderSelection();
    renderRuler();
  }
  function setZoom(z) { zoom = clampZoom(z); try { var s = (vscode.getState && vscode.getState()) || {}; s.zoom = zoom; if (vscode.setState) vscode.setState(s); } catch (_e) {} applyZoomStyles(); }
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
    if (deleteCtlEl) deleteCtlEl.disabled = selectableIds().length === 0;
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
    renderSmartTag();
    updateRulerMarks(pc && !pc.isRoot ? { x: pc.x, y: pc.y, w: pc.width, h: pc.height } : null);
  }

  // ---- on-canvas smart-tag "Tasks" flyout (VS/DevExpress-style): a chevron glyph pinned to the selected control's
  // top-right corner; clicking it opens a flyout OF THE CONTROL'S common properties edited inline (through the SAME
  // 'edit' message the property grid uses), plus All Properties / Learn More. Curated set = a name heuristic. ----
  var tasksState = null;   // { id, comp } for the current single selection (from the host 'tasks' message)
  var smartTagEl = null;
  var flyoutEl = null;
  var flyoutOwner = null;  // the control id the open flyout edits
  var TASK_PROP_NAMES = ['Text', 'Caption', 'AutoSizeMode', 'AutoSize', 'Image', 'ImageIndex', 'UseMnemonic',
    'LineVisible', 'ShowCloseButton', 'PageEnabled', 'PageVisible', 'Enabled', 'Visible', 'ReadOnly', 'Checked',
    'CheckState', 'Value', 'Multiline', 'Dock', 'Anchor', 'BackColor', 'ForeColor'];
  function taskListFor(comp) {
    if (!comp || !comp.properties) return [];
    var rank = {};
    for (var i = 0; i < TASK_PROP_NAMES.length; i++) rank[TASK_PROP_NAMES[i].toLowerCase()] = i;
    var found = comp.properties.filter(function (p) { return p && !p.readOnly && rank[String(p.name).toLowerCase()] !== undefined; });
    found.sort(function (a, b) { return rank[a.name.toLowerCase()] - rank[b.name.toLowerCase()]; });
    return found;
  }
  function sameSet(arr, want) {
    if (!arr || arr.length !== want.length) return false;
    for (var i = 0; i < want.length; i++) if (arr.indexOf(want[i]) < 0) return false;
    return true;
  }
  function renderSmartTag() {
    var comp = (tasksState && tasksState.id === current) ? tasksState.comp : null;
    var c = current ? findControl(current) : null;
    var show = !tabOrderMode && !drag && selection.length === 1 && !!c && !!comp && taskListFor(comp).length > 0;
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
    title.textContent = shortType(comp.type) + ' Tasks';
    flyoutEl.appendChild(title);
    var tasks = taskListFor(comp);
    if (!tasks.length) {
      var note = document.createElement('div'); note.className = 'tfNote'; note.textContent = 'No common tasks'; flyoutEl.appendChild(note);
    } else {
      for (var i = 0; i < tasks.length; i++) flyoutEl.appendChild(taskRow(comp, tasks[i]));
    }
    var links = document.createElement('div'); links.className = 'tfLinks';
    var all = document.createElement('div'); all.className = 'tfLink'; all.textContent = 'All Properties…';
    all.addEventListener('click', function () { closeFlyout(); vscode.postMessage({ type: 'showProperties' }); });
    links.appendChild(all);
    var learn = document.createElement('div'); learn.className = 'tfLink'; learn.textContent = 'Learn More Online';
    learn.addEventListener('click', function () { closeFlyout(); vscode.postMessage({ type: 'learnMore', typeName: comp.type }); });
    links.appendChild(learn);
    flyoutEl.appendChild(links);
    document.body.appendChild(flyoutEl);
    positionFlyout();
    setTimeout(function () { document.addEventListener('mousedown', onFlyoutOutside, true); document.addEventListener('keydown', onFlyoutKey, true); }, 0);
  }
  function taskRow(comp, p) {
    var owner = current;
    function send(value) { vscode.postMessage({ type: 'edit', id: owner, prop: p.name, propType: p.type, isEnum: !!p.isEnum, value: value }); }
    var cur = p.value == null ? '' : String(p.value);
    var isBool = /(^|\.)Boolean$/.test(p.type || '') || sameSet(p.standardValues, ['True', 'False']);
    var row;
    if (isBool) {
      row = document.createElement('label'); row.className = 'tfRow tfCheck';
      var cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = cur === 'True';
      cb.addEventListener('change', function () { send(cb.checked ? 'True' : 'False'); });
      var lb = document.createElement('span'); lb.className = 'tfLabel'; lb.textContent = p.name;
      row.appendChild(cb); row.appendChild(lb);
    } else if (p.standardValues && p.standardValues.length) {
      row = document.createElement('div'); row.className = 'tfRow';
      var l1 = document.createElement('span'); l1.className = 'tfLabel'; l1.textContent = p.name;
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
      var l2 = document.createElement('span'); l2.className = 'tfLabel'; l2.textContent = p.name;
      var inp = document.createElement('input'); inp.type = 'text'; inp.className = 'tfText'; inp.value = cur;
      inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } });
      inp.addEventListener('blur', function () { if (inp.value !== cur) send(inp.value); });
      row.appendChild(l2); row.appendChild(inp);
    }
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
    var sk = (axis === 'h') ? 'x' : 'y';            // start coord
    var zk = (axis === 'h') ? 'width' : 'height';   // size along the axis
    sel.sort(function (a, b) { return a[sk] - b[sk]; });
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
    for (var i = 0; i < controls.length; i++) {
      var s = controls[i];
      if (s.id === movingId || s.parentId !== parentId || selection.indexOf(s.id) >= 0) continue; // siblings only, not the group
      var tx = [s.x, s.x + s.width / 2, s.x + s.width], ty = [s.y, s.y + s.height / 2, s.y + s.height];
      for (var a = 0; a < 3; a++) {
        for (var b = 0; b < 3; b++) {
          var dX = tx[b] - ax[a]; if (Math.abs(dX) <= SNAP_T && (!bestX || Math.abs(dX) < Math.abs(bestX.delta))) bestX = { delta: dX, line: tx[b], s: s };
          var dY = ty[b] - ay[a]; if (Math.abs(dY) <= SNAP_T && (!bestY || Math.abs(dY) < Math.abs(bestY.delta))) bestY = { delta: dY, line: ty[b], s: s };
        }
      }
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

  // ---- selection (click / Ctrl-click) ----
  function selectSingle(id) {
    selection = [id]; current = id; canMove = false; canResize = false;
    renderSelection(); vscode.postMessage({ type: 'pick', id: id });
  }
  function toggleSelect(id) {
    var idx = selection.indexOf(id);
    if (idx >= 0) { if (selection.length > 1) { selection.splice(idx, 1); if (current === id) current = selection[selection.length - 1]; } }
    else { selection.push(id); current = id; }
    canMove = false; canResize = false;
    renderSelection(); vscode.postMessage({ type: 'pick', id: current });
  }

  canvas.addEventListener('click', function (e) {
    if (suppressClick) { suppressClick = false; return; }
    if (!controls.length) return;
    var id = hitTest(e.offsetX / zoom, e.offsetY / zoom);
    if (!id) return;
    if (tabOrderMode) {
      if (id === 'this') return;
      vscode.postMessage({ type: 'edit', id: id, prop: 'TabIndex', propType: 'System.Int32', isEnum: false, value: String(tabSeq) });
      tabSeq++;
      return;
    }
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

  // double-click a tab header → rename that tab (the host hit-tests the page under the point and prompts). Only a
  // tab host reacts; other double-clicks are ignored here (no default dblclick behavior on the surface).
  canvas.addEventListener('dblclick', function (e) {
    if (!controls.length) return;
    var id = hitTest(e.offsetX / zoom, e.offsetY / zoom);
    if (!id) return;
    var hc = findControl(id);
    if (hc && hc.isTabHost) {
      vscode.postMessage({ type: 'tabRename', hostId: id, x: Math.round(e.offsetX / zoom), y: Math.round(e.offsetY / zoom) });
    }
  });

  // cross-webview drop: a control dragged from the toolbox webview (custom MIME) lands here → add at cursor
  var TOOLBOX_MIME = 'application/vnd.winforms-toolbox-item';
  function dragHasToolboxItem(e) {
    return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], TOOLBOX_MIME) >= 0;
  }
  canvas.addEventListener('dragover', function (e) {
    if (!dragHasToolboxItem(e)) return;
    e.preventDefault(); // allow the drop
    e.dataTransfer.dropEffect = 'copy';
  });
  canvas.addEventListener('drop', function (e) {
    if (!dragHasToolboxItem(e)) return;
    e.preventDefault();
    var controlType = e.dataTransfer.getData(TOOLBOX_MIME);
    if (!controlType) return;
    var x = e.offsetX / zoom, y = e.offsetY / zoom;
    var hitId = controls.length ? hitTest(x, y) : 'this';
    vscode.postMessage({ type: 'dropControl', controlType: controlType, hitId: hitId || 'this', x: Math.round(x), y: Math.round(y) });
  });

  canvas.addEventListener('mousedown', function (e) {
    if (e.button !== 0) return; // left-button only — right-click opens the context menu
    if (nudge) flushNudge(); // a new gesture ends the current nudge series (commit before selection can change)
    if (tabOrderMode) return; // no drag/select in tab-order mode
    if (!controls.length || drag || band) return;
    hideHover(); // a new gesture starts — drop the pre-select hint
    var sx = e.offsetX / zoom, sy = e.offsetY / zoom;
    var id = hitTest(sx, sy);
    var mdc = id ? findControl(id) : null;
    // a tab host never starts a move-drag: its header must stay clickable so tab-switching (tabClick) fires
    if (id && id !== 'this' && selection.indexOf(id) >= 0 && canMove && !selectionHasLocked() && !(mdc && mdc.isTabHost)) {
      // (group) move: snapshot every selected control's rect so they translate together
      var items = [];
      for (var i = 0; i < selection.length; i++) { var c = findControl(selection[i]); if (c) items.push({ id: c.id, x: c.x, y: c.y, w: c.width, h: c.height }); }
      var pc = findControl(current);
      drag = { mode: 'move', group: selection.length > 1, ids: selection.slice(), items: items, primaryId: current,
               orig: { x: pc.x, y: pc.y, w: pc.width, h: pc.height }, startX: e.clientX, startY: e.clientY, delta: { dx: 0, dy: 0 } };
      e.preventDefault();
    } else if (id === 'this' || id === null) {
      // rubber-band on the form background (the form itself isn't movable)
      band = { startX: e.clientX, startY: e.clientY, sx: sx, sy: sy, active: false };
      e.preventDefault();
    }
    // mousedown on an unselected control: let the click handler select it (select-then-drag, like before)
  });

  canvas.addEventListener('mousemove', function (e) {
    if (drag || band) return;
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
    if (drag) {
      var dx = (e.clientX - drag.startX) / zoom, dy = (e.clientY - drag.startY) / zoom;
      if (drag.mode === 'move') {
        var nx = drag.orig.x + dx, ny = drag.orig.y + dy;
        var snap = computeSnap(nx, ny, drag.orig.w, drag.orig.h, drag.primaryId);
        nx = snap.x; ny = snap.y;
        var sdx = nx - drag.orig.x, sdy = ny - drag.orig.y;
        drag.delta = { dx: sdx, dy: sdy };
        drag.cur = { x: nx, y: ny, w: drag.orig.w, h: drag.orig.h };
        drawGuides(snap.guides);
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
        setStatus(drag.group ? T('designer.status.moveGroup', { count: drag.items.length, dx: Math.round(sdx), dy: Math.round(sdy) })
                             : T('designer.status.moveSingle', { x: Math.round(nx), y: Math.round(ny) }));
      } else {
        var o = drag.orig, dir = drag.dir || 'se';
        var rx = o.x, ry = o.y, rw = o.w, rh = o.h;
        if (dir.indexOf('e') >= 0) rw = Math.max(4, o.w + dx);
        if (dir.indexOf('s') >= 0) rh = Math.max(4, o.h + dy);
        if (dir.indexOf('w') >= 0) { rw = Math.max(4, o.w - dx); rx = o.x + (o.w - rw); }
        if (dir.indexOf('n') >= 0) { rh = Math.max(4, o.h - dy); ry = o.y + (o.h - rh); }
        var rsnap = computeResizeSnap({ x: rx, y: ry, w: rw, h: rh }, dir, current);
        rx = rsnap.x; ry = rsnap.y; rw = rsnap.w; rh = rsnap.h;
        drawGuides(rsnap.guides);
        drag.cur = { x: rx, y: ry, w: rw, h: rh };
        selBox.style.left = (rx * zoom) + 'px'; selBox.style.top = (ry * zoom) + 'px';
        selBox.style.width = Math.max(0, rw * zoom - 2) + 'px'; selBox.style.height = Math.max(0, rh * zoom - 2) + 'px';
        updateRulerMarks(drag.cur); // track bounds on the ruler during resize too
        setStatus(T('designer.status.resize', { w: Math.round(rw), h: Math.round(rh) }));
      }
      return;
    }
    if (band) {
      var r = bandRect();
      var cx = (e.clientX - r.left) / zoom, cy = (e.clientY - r.top) / zoom;
      if (!band.active && (Math.abs(e.clientX - band.startX) >= 3 || Math.abs(e.clientY - band.startY) >= 3)) band.active = true;
      if (band.active) {
        if (!bandEl) { bandEl = document.createElement('div'); bandEl.className = 'rubberband'; surfaceWrap.appendChild(bandEl); }
        bandEl.style.display = 'block';
        var x1 = Math.min(band.sx, cx), y1 = Math.min(band.sy, cy), x2 = Math.max(band.sx, cx), y2 = Math.max(band.sy, cy);
        band.rect = { x1: x1, y1: y1, x2: x2, y2: y2 };
        bandEl.style.left = (x1 * zoom) + 'px'; bandEl.style.top = (y1 * zoom) + 'px';
        bandEl.style.width = ((x2 - x1) * zoom) + 'px'; bandEl.style.height = ((y2 - y1) * zoom) + 'px';
      }
    }
  });

  document.addEventListener('mouseup', function (e) {
    if (drag) {
      var d = drag; drag = null; clearGuides();
      var cdx = e.clientX - d.startX, cdy = e.clientY - d.startY;
      if (Math.abs(cdx) < 2 && Math.abs(cdy) < 2) { renderSelection(); return; }
      suppressClick = true;
      if (d.mode === 'move') {
        if (d.group) {
          vscode.postMessage({ type: 'manipulateGroup', ids: d.ids, dx: d.delta.dx, dy: d.delta.dy });
        } else {
          var m = d.cur || { x: d.orig.x + cdx / zoom, y: d.orig.y + cdy / zoom, w: d.orig.w, h: d.orig.h };
          vscode.postMessage({ type: 'manipulate', id: current, mode: 'move', x: m.x, y: m.y, width: m.w, height: m.h });
        }
      } else {
        var r = d.cur || { x: d.orig.x, y: d.orig.y, w: Math.max(4, d.orig.w + cdx / zoom), h: Math.max(4, d.orig.h + cdy / zoom) };
        vscode.postMessage({ type: 'manipulate', id: current, mode: 'resize', x: r.x, y: r.y, width: r.w, height: r.h });
      }
      setStatus(T('designer.status.committing'));
      return;
    }
    if (band) {
      var bandWasActive = band.active, rect = band.rect; band = null;
      if (bandEl) bandEl.style.display = 'none';
      if (bandWasActive && rect) {
        suppressClick = true;
        // select every non-root control intersecting the band rectangle
        var hits = [];
        for (var i = 0; i < controls.length; i++) {
          var c = controls[i]; if (c.isRoot || c.id === 'this') continue;
          if (!(c.x + c.width < rect.x1 || c.x > rect.x2 || c.y + c.height < rect.y1 || c.y > rect.y2)) hits.push(c.id);
        }
        if (hits.length) { selection = hits; current = hits[hits.length - 1]; canMove = false; canResize = false; renderSelection(); vscode.postMessage({ type: 'pick', id: current }); }
        else { selection = []; current = null; renderSelection(); }
      }
      // a band that never moved (a click on the form bg) → handled by the click → selectSingle('this')
    }
  });

  // View Code / Save toolbar buttons were removed: F7 opens the code-behind, Ctrl+S saves (native custom editor).
  function doDelete() {
    if (nudge) flushNudge(); // commit a pending keyboard-nudge before it races this action's document change
    var ids = selectableIds();
    if (!ids.length || drag) return;
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
  // ---- Lock Controls (VS "Lock Controls"): flip the locked state of every control on the form (session-only). Locked
  // controls drop their grab handles + a lock glyph appears, and mouse move/resize/nudge is blocked. No engine/persist. ----
  function toggleLockAll(ids, lock) {
    for (var i = 0; i < ids.length; i++) { if (lock) lockedIds[ids[i]] = true; else delete lockedIds[ids[i]]; }
    if (lock) canvas.style.cursor = 'default'; // the menu overlay swallows mousemove — drop a stale 'move' cursor now
    renderSelection();
  }
  document.addEventListener('keydown', function (e) {
    if (e.key === 'F7') { e.preventDefault(); vscode.postMessage({ type: 'viewCode' }); return; } // VS: F7 = designer → code
    if (e.key !== 'Delete' && e.key !== 'Del') return;
    var ae = document.activeElement;
    if (ae && /^(INPUT|SELECT|TEXTAREA)$/.test(ae.tagName)) return;
    e.preventDefault(); doDelete();
  });

  // ---- keyboard nudge (VS: Arrow=move 1px, Ctrl+Arrow=grid step, Shift+Arrow=resize) ----
  // The most-used designer gesture. Moves/resizes optimistically (selection box follows) and commits the WHOLE
  // key series as ONE edit through the existing manipulate/manipulateGroup paths → one undo, one re-render.
  function flushNudge() {
    if (!nudge) return;
    var n = nudge; nudge = null;
    if (n.timer) { clearTimeout(n.timer); n.timer = null; }
    if (n.mode === 'move') {
      if (n.ids.length > 1) vscode.postMessage({ type: 'manipulateGroup', ids: n.ids, dx: n.dx, dy: n.dy });
      else { var c = findControl(n.ids[0]); if (c) vscode.postMessage({ type: 'manipulate', id: n.ids[0], mode: 'move', x: c.x, y: c.y, width: c.width, height: c.height }); }
    } else { // resize — single selection only
      var rc = findControl(n.ids[0]); if (rc) vscode.postMessage({ type: 'manipulate', id: n.ids[0], mode: 'resize', x: rc.x, y: rc.y, width: rc.width, height: rc.height });
    }
    setStatus(T('designer.status.committing'));
  }
  document.addEventListener('keydown', function (e) {
    if (e.key.indexOf('Arrow') !== 0) return; // ArrowLeft/Right/Up/Down
    var ae = document.activeElement;
    if (ae && /^(INPUT|SELECT|TEXTAREA)$/.test(ae.tagName)) return; // don't hijack arrows while typing
    if (drag || band || tabOrderMode) return;
    var ids = selectableIds();
    if (!ids.length) return;
    for (var li = 0; li < ids.length; li++) { if (isLocked(ids[li])) return; } // a locked control can't be nudged
    var resize = e.shiftKey;
    if (resize) { if (ids.length > 1 || !canResize) return; }  // resize: single, resizable selection only
    else if (!canMove) return;                                 // move: respect the host's movability gate
    e.preventDefault();
    var step = (e.ctrlKey || e.metaKey) ? NUDGE_GRID : 1;
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
    menu.push({ label: T('designer.menu.alignToGrid'), disabled: true });   // no snap-to-grid → disabled, as in VS
    // Lock Controls (VS): toggles ALL controls on the form. Session-only (webview state; no .resx persistence yet) —
    // checked when every control is already locked. Disabled on an empty form (nothing to lock).
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
      menu.push({ label: 'Add Tab', act: function () { vscode.postMessage({ type: 'addTab', hostId: primary.id }); } });
      var activePage = null;
      for (var pi = 0; pi < controls.length; pi++) { if (controls[pi].parentId === primary.id) { activePage = controls[pi]; break; } }
      menu.push({
        label: activePage ? ('Delete Tab "' + activePage.name + '"') : 'Delete Tab',
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
    if (!controls.length || drag || band) return;
    var rect = canvas.getBoundingClientRect();
    var id = hitTest((e.clientX - rect.left) / zoom, (e.clientY - rect.top) / zoom) || 'this';
    if (selection.indexOf(id) < 0) selectSingle(id);
    renderCtx(e.clientX, e.clientY);
  });
  // right-click a tray component (non-visual) → select it, then menu
  if (trayEl) trayEl.addEventListener('contextmenu', function (e) {
    e.preventDefault();
    var chip = e.target; while (chip && chip !== trayEl && chip.className.indexOf('trayItem') < 0) chip = chip.parentNode;
    if (!chip || chip === trayEl) return;
    var idx = Array.prototype.indexOf.call(trayEl.children, chip);
    var t = tray[idx]; if (!t) return;
    selection = [t.id]; current = t.id; canMove = false; canResize = false;
    renderSelection(); renderTray(); vscode.postMessage({ type: 'pick', id: t.id });
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
    if (m.type === 'render') {
      hasRendered = true; hideOverlay();
      drawPng(m.png, 0, 0, m.width, m.height, true, m.gen);
    } else if (m.type === 'layout') {
      controls = m.controls || [];
      stripItems = m.toolStripItems || [];
      // drop any selected ids that no longer exist (e.g. after a remove), keeping tray ids
      selection = selection.filter(function (id) { return findControl(id) || findTray(id); });
      for (var lid in lockedIds) { if (Object.prototype.hasOwnProperty.call(lockedIds, lid) && !findControl(lid)) delete lockedIds[lid]; } // prune locks for removed controls
      if (current && !findControl(current) && !findTray(current)) current = selection.length ? selection[selection.length - 1] : null;
      renderSelection();
    } else if (m.type === 'tray') {
      tray = m.items || []; renderTray();
    } else if (m.type === 'patch') {
      drawPng(m.png, m.x, m.y, m.width, m.height, false, m.gen);
    } else if (m.type === 'select') {
      // host selection (after a render / group op). Keep the multi-set if the primary is part of it.
      if (selection.indexOf(m.id) < 0) selection = [m.id];
      if (m.id !== current) { canMove = false; canResize = false; }
      current = m.id; renderSelection(); renderTray();
    } else if (m.type === 'manip') {
      if (m.id === current) { canMove = !!m.move; canResize = !!m.resize; renderSelection(); }
    } else if (m.type === 'tasks') {
      // the selected control's property descriptors — feeds the on-canvas smart-tag flyout
      tasksState = m.component ? { id: m.id, comp: m.component } : null;
      renderSmartTag();
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
      else if (m.renderFailure) showDiag('err', T('designer.diag.stalePreview', { message: m.message }), []);
      else setStatus(T('designer.status.error', { message: m.message }));
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
