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
        row._smItem = it; row._smLevel = lvl; // read by onSubmenuCtx (right-click has no per-row closure of its own)
        var cap = document.createElement('span'); cap.className = 'stripflyoutcap'; cap.textContent = it.text || it.itemId || '—';
        row.appendChild(cap);
        if (hasKids) { var arr = document.createElement('span'); arr.className = 'stripflyoutarrow'; arr.textContent = '▸'; row.appendChild(arr); }
        if (interactive) {
          (function (item, level, rowEl) {
            rowEl.addEventListener('click', function (e) { e.stopPropagation(); onSubmenuRow(item, level, rowEl); });
            // double-click a nested row → rename it (mirrors the top-level dblclick; a separator has no Text so it's inert)
            rowEl.addEventListener('dblclick', function (e) { e.stopPropagation(); if (item.itemId && !isSeparatorType(item.itemType)) { selectSubmenuRow(item, level, rowEl); renameSubmenuSel(); } });
          })(it, lvl, row);
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
  // Post a canvas-origin pick AND record it as the pending (not-yet-echoed) pick for select-echo correlation.
  function postPick(id) { pendingPick = { token: ++pickToken, id: id }; vscode.postMessage({ type: 'pick', id: id, token: pickToken }); }
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
    tray.forEach(function (t) {
      var chip = document.createElement('div');
      chip.className = 'trayItem' + (t.id === current ? ' sel' : '');
      chip.textContent = t.name + ' : ' + shortType(t.type);
      chip.title = t.id + ' : ' + t.type;
      chip.addEventListener('click', function () {
        // a tray component has no visual bounds → clear the canvas selection box, drive the Properties panel
        selectedItem = null;
        selection = [t.id]; current = t.id; canMove = false; canResize = false;
        renderSelection(); renderTray(); postPick(t.id);
        // an off-tree strip (a ContextMenuStrip) also opens its synthetic items flyout — the on-canvas reach into its
        // Items (Properties / rename / delete / add), the tray-chip counterpart of a menu-bar item's dropdown. A
        // non-strip chip (Timer/ImageList/…) has no items → openTrayStripFlyout closes any open flyout instead.
        openTrayStripFlyout(t);
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
  function setZoom(z) { closeSlotEditor(); closeSubmenu(); zoom = clampZoom(z); try { var s = (vscode.getState && vscode.getState()) || {}; s.zoom = zoom; if (vscode.setState) vscode.setState(s); } catch (_e) {} applyZoomStyles(); }
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
    title.textContent = T('designer.smartTag.title', { type: shortType(comp.type) });
    flyoutEl.appendChild(title);
    var tasks = taskListFor(comp);
    if (!tasks.length) {
      var note = document.createElement('div'); note.className = 'tfNote'; note.textContent = T('designer.smartTag.noTasks'); flyoutEl.appendChild(note);
    } else {
      for (var i = 0; i < tasks.length; i++) flyoutEl.appendChild(taskRow(comp, tasks[i]));
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
    selectedItem = null; // a control selection supersedes any on-canvas strip-item selection
    selection = [id]; current = id; canMove = false; canResize = false;
    renderSelection(); postPick(id);
  }
  function toggleSelect(id) {
    selectedItem = null; // a control selection supersedes any on-canvas strip-item selection
    var idx = selection.indexOf(id);
    if (idx >= 0) { if (selection.length > 1) { selection.splice(idx, 1); if (current === id) current = selection[selection.length - 1]; } }
    else { selection.push(id); current = id; }
    canMove = false; canResize = false;
    renderSelection(); postPick(current);
  }

  canvas.addEventListener('click', function (e) {
    if (suppressClick) { suppressClick = false; return; }
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

  // double-click a tab header → rename that tab (the host hit-tests the page under the point and prompts). Only a
  // tab host reacts; other double-clicks are ignored here (no default dblclick behavior on the surface).
  canvas.addEventListener('dblclick', function (e) {
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
    if (drag) return;
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
  // ---- Lock Controls (VS "Lock Controls"): flip the locked state of every control on the form (session-only). Locked
  // controls drop their grab handles + a lock glyph appears, and mouse move/resize/nudge is blocked. No engine/persist. ----
  function toggleLockAll(ids, lock) {
    for (var i = 0; i < ids.length; i++) { if (lock) lockedIds[ids[i]] = true; else delete lockedIds[ids[i]]; }
    if (lock) canvas.style.cursor = 'default'; // the menu overlay swallows mousemove — drop a stale 'move' cursor now
    renderSelection();
  }
  document.addEventListener('keydown', function (e) {
    if (e.key === 'F7') { e.preventDefault(); vscode.postMessage({ type: 'viewCode' }); return; } // VS: F7 = designer → code
    // F2 renames the selected on-canvas strip item (VS: F2 = rename). Same inline editor as the double-click path;
    // a separator has no Text so it isn't renamable. No strip-item selected → let F2 fall through (no default action).
    if (e.key === 'F2') {
      var af2 = document.activeElement;
      if (af2 && /^(INPUT|SELECT|TEXTAREA)$/.test(af2.tagName)) return;
      if (submenuSel) { // a selected nested flyout item renames via the same inline editor (separator = inert)
        if (!(drag || band || tabOrderMode || isSeparatorType(submenuSel.itemType))) { e.preventDefault(); renameSubmenuSel(); }
        return;
      }
      if (!selectedItem || drag || band || tabOrderMode || isSeparatorType(selectedItem.itemType)) return;
      e.preventDefault(); openItemRenameEditor(selectedItem);
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
      menu.push({ label: T('designer.menu.addTab'), act: function () { vscode.postMessage({ type: 'addTab', hostId: primary.id }); } });
      var activePage = null;
      for (var pi = 0; pi < controls.length; pi++) { if (controls[pi].parentId === primary.id) { activePage = controls[pi]; break; } }
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
    if (!controls.length || drag || band) return;
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
  // right-click a tray component (non-visual) → select it, then menu
  if (trayEl) trayEl.addEventListener('contextmenu', function (e) {
    e.preventDefault();
    var chip = e.target; while (chip && chip !== trayEl && chip.className.indexOf('trayItem') < 0) chip = chip.parentNode;
    if (!chip || chip === trayEl) return;
    var idx = Array.prototype.indexOf.call(trayEl.children, chip);
    var t = tray[idx]; if (!t) return;
    selectedItem = null;
    selection = [t.id]; current = t.id; canMove = false; canResize = false;
    renderSelection(); renderTray(); postPick(t.id);
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
      // strip/item geometry may have moved → dismiss a drifting inline add-editor and the synthetic submenu flyout
      // (its anchor item may have moved/vanished). Done HERE (and in setZoom), NOT in renderSelection: a 'manip'/'select'
      // push re-renders selection WITHOUT moving the slot/flyout, and must not eat typed text or snap the menu shut.
      closeSlotEditor(); closeSubmenu();
      controls = m.controls || [];
      stripItems = m.toolStripItems || [];
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
        if (selection.indexOf(m.id) < 0) selection = [m.id];
        if (m.id !== current) { canMove = false; canResize = false; }
        current = m.id;
        renderSelection(); renderTray();
      }
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
