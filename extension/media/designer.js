// WinForms designer — canvas custom-editor webview (loaded as an EXTERNAL file via asWebviewUri + nonce).
// This view owns ONLY the rendered form: the PNG preview, the selection overlay (single + multi), click /
// Ctrl-click / rubber-band selection, in-surface drag-to-move (with snaplines) / resize, group move + group
// delete, and zoom. The Toolbox and Properties live in a separate, dockable WebviewView (media/panel.js);
// the host (src/designerEditor.ts) routes between them. Plain ES5-ish JS (no bundler touches this file).
(function () {
  window.addEventListener('error', function (ev) {
    try { var o = document.getElementById('overlay'); if (o) { o.className = 'err'; o.textContent = 'Webview error: ' + ev.message; } } catch (_e) {}
  });
  try { var _ov = document.getElementById('overlay'); if (_ov) _ov.textContent = 'Initializing…'; } catch (_e) {}

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

  var controls = [];      // innermost-first (engine order)
  var current = null;     // primary selection id (drives the Properties panel + resize handles)
  var selection = [];     // all selected ids (multi-select); always contains `current` when non-empty
  var tray = [];          // non-visual components (§7.3 component tray)
  var trayEl = document.getElementById('tray');
  // tab-order editing (Phase 2): click controls in sequence to renumber TabIndex
  var tabOrderMode = false;
  var tabSeq = 0;
  var tabBadges = [];
  var tabOrderEl = document.getElementById('tabOrder');
  var alignEl = document.getElementById('align');

  // ---- direct manipulation (drag-to-move + resize) ----
  var canMove = false;     // can the primary selection be moved (set by the host's 'manip' message)
  var canResize = false;   // can it be resized
  var drag = null;         // active move/resize gesture
  var band = null;         // active rubber-band selection gesture
  var suppressClick = false; // swallow the click that ENDS a drag/band so it doesn't re-select
  var HANDLE_DIRS = ['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se'];
  var handles = {};
  HANDLE_DIRS.forEach(function (dir) {
    var h = document.createElement('div');
    h.className = 'handle h-' + dir;
    h.style.display = 'none';
    h.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return; // left-button only — right-click opens the context menu, not a resize
      if (drag || !canResize || selection.length > 1) return; // resize only with a single selection
      var c = findControl(current); if (!c) return;
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
  var dockBadge = null; // dock indicator badge
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
  function getDockBadge() { if (!dockBadge) { dockBadge = document.createElement('div'); dockBadge.className = 'dockBadge'; dockBadge.style.display = 'none'; surfaceWrap.appendChild(dockBadge); } return dockBadge; }

  function findControl(id) { for (var i = 0; i < controls.length; i++) { if (controls[i].id === id) return controls[i]; } return null; }
  function findTray(id) { for (var i = 0; i < tray.length; i++) { if (tray[i].id === id) return tray[i]; } return null; }

  // ---- component tray (§7.3): non-visual components as a strip below the surface; click to select ----
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
    if (rulerToggleEl) { rulerToggleEl.className = rulerOn ? 'active' : ''; rulerToggleEl.textContent = rulerOn ? 'Скрыть линейку' : 'Показать линейку'; }
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
  });
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
    if (!c) { selBox.style.display = 'none'; return; }
    selBox.style.display = 'block';
    selBox.style.left = (c.x * zoom) + 'px'; selBox.style.top = (c.y * zoom) + 'px';
    selBox.style.width = Math.max(0, c.width * zoom - 2) + 'px'; selBox.style.height = Math.max(0, c.height * zoom - 2) + 'px';
    var formOnly = c.isRoot || c.id === 'this';
    var showHandles = canResize && selection.length <= 1;
    HANDLE_DIRS.forEach(function (dir) {
      var show = showHandles && (!formOnly || dir === 'e' || dir === 's' || dir === 'se');
      handles[dir].style.display = show ? 'block' : 'none';
    });
  }
  // render the WHOLE selection: primary box + handles, outline boxes for the rest, name/Delete state.
  function renderSelection() {
    if (!current) { selBox.style.display = 'none'; }
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
    if (selection.length > 1) selName.textContent = selection.length + ' controls selected';
    else if (pc) selName.textContent = (pc.isRoot ? pc.name + ' (form)' : pc.name) + ' : ' + shortType(pc.type);
    else { var ti = current ? findTray(current) : null; selName.textContent = ti ? (ti.name + ' : ' + shortType(ti.type)) : '—'; }
    if (deleteCtlEl) deleteCtlEl.disabled = selectableIds().length === 0;
    if (alignEl) alignEl.style.display = (selection.length >= 2) ? '' : 'none';
    renderTabBadges();
    renderAnchors();
  }

  // ---- anchor/dock overlay (Phase 2): for a single selected control, draw tether lines from each anchored
  // edge to the parent edge (VS-style), or a Dock badge when docked. Display-only; editing is the property
  // grid's anchor/dock glyph. Tethers reach the parent's window-space rect (form chrome inset is a v1 gap). ----
  function renderAnchors() {
    clearAnchors();
    var badge = getDockBadge(); badge.style.display = 'none';
    if (tabOrderMode || drag || selection.length !== 1) return;
    var c = current ? findControl(current) : null;
    if (!c || c.isRoot || c.id === 'this') return;
    if (c.dock && c.dock !== 'None') { // a docked control ignores Anchor at runtime — show the dock instead
      badge.style.display = 'block';
      badge.textContent = '⬓ Dock: ' + c.dock;
      badge.style.left = (c.x * zoom) + 'px';
      badge.style.top = (Math.max(0, c.y) * zoom) + 'px';
      return;
    }
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
    if (sel.length < 3) { setStatus('select 3+ controls to distribute'); return; }
    var sk = (axis === 'h') ? 'x' : 'y';            // start coord
    var zk = (axis === 'h') ? 'width' : 'height';   // size along the axis
    sel.sort(function (a, b) { return a[sk] - b[sk]; });
    var first = sel[0], last = sel[sel.length - 1];
    var span = (last[sk] + last[zk]) - first[sk];
    var sumSize = 0; for (var i = 0; i < sel.length; i++) sumSize += sel[i][zk];
    var gap = (span - sumSize) / (sel.length - 1);
    if (gap < 0) { setStatus('controls overlap — cannot distribute'); return; }
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
    if ((e.ctrlKey || e.metaKey || e.shiftKey) && id !== 'this') { toggleSelect(id); }
    else if (id !== current || selection.length > 1) { selectSingle(id); }
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
    if (tabOrderMode) return; // no drag/select in tab-order mode
    if (!controls.length || drag || band) return;
    var sx = e.offsetX / zoom, sy = e.offsetY / zoom;
    var id = hitTest(sx, sy);
    if (id && id !== 'this' && selection.indexOf(id) >= 0 && canMove) {
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
    canvas.style.cursor = (id && id !== 'this' && selection.indexOf(id) >= 0 && canMove) ? 'move' : 'default';
  });

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
        // ghost: translate the primary box and every secondary box by the snapped delta
        selBox.style.left = (nx * zoom) + 'px'; selBox.style.top = (ny * zoom) + 'px';
        var n = 0;
        for (var i = 0; i < drag.items.length; i++) {
          var it = drag.items[i]; if (it.id === current) continue;
          var b = secBox(n++); b.style.display = 'block';
          b.style.left = ((it.x + sdx) * zoom) + 'px'; b.style.top = ((it.y + sdy) * zoom) + 'px';
          b.style.width = Math.max(0, it.w * zoom - 2) + 'px'; b.style.height = Math.max(0, it.h * zoom - 2) + 'px';
        }
        setStatus(drag.group ? ('move ' + drag.items.length + ' → Δ(' + Math.round(sdx) + ', ' + Math.round(sdy) + ')')
                             : ('move → (' + Math.round(nx) + ', ' + Math.round(ny) + ')'));
      } else {
        var o = drag.orig, dir = drag.dir || 'se';
        var rx = o.x, ry = o.y, rw = o.w, rh = o.h;
        if (dir.indexOf('e') >= 0) rw = Math.max(4, o.w + dx);
        if (dir.indexOf('s') >= 0) rh = Math.max(4, o.h + dy);
        if (dir.indexOf('w') >= 0) { rw = Math.max(4, o.w - dx); rx = o.x + (o.w - rw); }
        if (dir.indexOf('n') >= 0) { rh = Math.max(4, o.h - dy); ry = o.y + (o.h - rh); }
        drag.cur = { x: rx, y: ry, w: rw, h: rh };
        selBox.style.left = (rx * zoom) + 'px'; selBox.style.top = (ry * zoom) + 'px';
        selBox.style.width = Math.max(0, rw * zoom - 2) + 'px'; selBox.style.height = Math.max(0, rh * zoom - 2) + 'px';
        setStatus('resize → ' + Math.round(rw) + ' × ' + Math.round(rh));
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
      setStatus('committing…');
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
    var ids = selectableIds();
    if (!ids.length || drag) return;
    if (ids.length > 1) vscode.postMessage({ type: 'removeControls', ids: ids });
    else vscode.postMessage({ type: 'removeControl', id: ids[0] });
  }
  if (deleteCtlEl) deleteCtlEl.addEventListener('click', doDelete);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'F7') { e.preventDefault(); vscode.postMessage({ type: 'viewCode' }); return; } // VS: F7 = designer → code
    if (e.key !== 'Delete' && e.key !== 'Del') return;
    var ae = document.activeElement;
    if (ae && /^(INPUT|SELECT|TEXTAREA)$/.test(ae.tagName)) return;
    e.preventDefault(); doDelete();
  });

  function setDirty(d) { if (dirtyEl) dirtyEl.textContent = d ? '● unsaved' : ''; if (saveEl) saveEl.disabled = !d; }

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
    var ids = selectableIds(); if (!ids.length) return;
    if (ids.length > 1) vscode.postMessage({ type: 'copyControls', ids: ids });
    else vscode.postMessage({ type: 'copy', id: ids[0] });
  }
  function doCut() {
    var ids = selectableIds(); if (!ids.length) return;
    if (ids.length > 1) vscode.postMessage({ type: 'cutControls', ids: ids });
    else vscode.postMessage({ type: 'cut', id: ids[0] });
  }
  function doPaste() { vscode.postMessage({ type: 'paste', id: current || 'this' }); }

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
    menu.push({ label: 'View Code', acc: 'F7', act: function () { vscode.postMessage({ type: 'viewCode' }); } });
    menu.push({ sep: 1 });
    menu.push({ label: 'Bring to Front', disabled: !canZ, act: function () { zorder(true); } });
    menu.push({ label: 'Send to Back', disabled: !canZ, act: function () { zorder(false); } });
    menu.push({ sep: 1 });
    menu.push({ label: 'Align to Grid', disabled: true });   // no snap-to-grid → disabled, as in VS
    menu.push({ label: 'Lock Controls', disabled: true });   // design-time Locked persistence not supported yet
    menu.push({ sep: 1 });
    menu.push({ label: 'All Properties…', act: function () { vscode.postMessage({ type: 'showProperties' }); } });
    if (!multi && subject) menu.push({ label: 'Learn More Online', act: function () { vscode.postMessage({ type: 'learnMore', typeName: subject.type }); } });
    // "Select '<ancestor>'" chain — immediate parent up to the root, like VS (single visual selection only)
    if (!multi && primary && !isRoot) {
      var chain = [], p = primary.parentId;
      while (p) { var pc = findControl(p); if (!pc) break; chain.push(pc); p = pc.parentId; }
      if (chain.length) {
        menu.push({ sep: 1 });
        chain.forEach(function (pc) {
          menu.push({ label: "Select '" + pc.name + "'", act: (function (idd) { return function () { selectSingle(idd); }; })(pc.id) });
        });
      }
    }
    menu.push({ sep: 1 });
    menu.push({ label: 'Cut', acc: 'Ctrl+X', disabled: !canDelete, act: doCut });
    menu.push({ label: 'Copy', acc: 'Ctrl+C', disabled: !canDelete, act: doCopy });
    menu.push({ label: 'Paste', acc: 'Ctrl+V', disabled: !clipboardHas, act: doPaste });
    menu.push({ sep: 1 });
    menu.push({ label: 'Delete', acc: 'Del', disabled: !canDelete, act: doDelete });
    menu.push({ sep: 1 });
    menu.push({ label: 'Properties', act: function () { vscode.postMessage({ type: 'showProperties' }); } });
    return menu;
  }

  function renderCtx(x, y) {
    if (!ctxEl) return;
    var items = buildCtxMenu();
    ctxEl.innerHTML = '';
    items.forEach(function (mi) {
      if (mi.sep) { var s = document.createElement('div'); s.className = 'sep'; ctxEl.appendChild(s); return; }
      var d = document.createElement('div'); d.className = 'mi' + (mi.disabled ? ' disabled' : '');
      d.innerHTML = '<span>' + escHtml(mi.label) + '</span>' + (mi.acc ? '<span class="acc">' + escHtml(mi.acc) + '</span>' : '');
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
  });

  window.addEventListener('message', function (e) {
    var m = e.data;
    if (m.type === 'render') {
      hasRendered = true; hideOverlay();
      drawPng(m.png, 0, 0, m.width, m.height, true, m.gen);
    } else if (m.type === 'layout') {
      controls = m.controls || [];
      // drop any selected ids that no longer exist (e.g. after a remove), keeping tray ids
      selection = selection.filter(function (id) { return findControl(id) || findTray(id); });
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
    } else if (m.type === 'loading') {
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
    } else if (m.type === 'error') {
      if (!hasRendered) showOverlay('Designer error:\n' + m.message, true);
      else setStatus('error: ' + m.message);
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
