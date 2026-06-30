// WinForms designer — the single dockable panel WebviewView. Hosts TWO full-size panes (Properties grid +
// Toolbox palette) switched by a tab strip at the bottom of the view, so each category gets the whole area
// (instead of two stacked views splitting it). Mirrors the active designer editor; edits/adds are posted to
// the host, which applies them to the active .Designer.cs and live-updates the canvas. Kept in sync with the
// host protocol in src/designerEditor.ts.
(function () {
  var vscode = acquireVsCodeApi();

  // ---- bottom tab switching (Properties / Outline / Toolbox panes) ----
  var propsPane = document.getElementById('propsPane');
  var toolboxPane = document.getElementById('toolboxPane');
  var outlinePane = document.getElementById('outlinePane');
  var mainTabProps = document.getElementById('mainTabProps');
  var mainTabToolbox = document.getElementById('mainTabToolbox');
  var mainTabOutline = document.getElementById('mainTabOutline');
  function showMainTab(which) {
    propsPane.style.display = which === 'props' ? '' : 'none';
    outlinePane.style.display = which === 'outline' ? '' : 'none';
    toolboxPane.style.display = which === 'toolbox' ? '' : 'none';
    mainTabProps.className = which === 'props' ? 'active' : '';
    mainTabOutline.className = which === 'outline' ? 'active' : '';
    mainTabToolbox.className = which === 'toolbox' ? 'active' : '';
    if (which === 'outline') renderOutline();
  }
  mainTabProps.addEventListener('click', function () { showMainTab('props'); });
  mainTabOutline.addEventListener('click', function () { showMainTab('outline'); });
  mainTabToolbox.addEventListener('click', function () { showMainTab('toolbox'); });

  // ---- Toolbox pane: VS-style vertical stack of collapsible category "tabs" + custom tabs + right-click menu.
  // In VS the toolbox "tabs" are these collapsible category headers; the right-click menu (Add/Rename/Delete/
  // Move Tab, List View, Sort, Choose Items, Reset…) operates on them. Built-in categories come from the engine
  // (it tags each control with a VS category); custom tabs are user-defined and persisted in webview state.
  var tbListEl = document.getElementById('tbList');
  var tbBodyEl = document.getElementById('tbBody');
  var tbEmptyEl = document.getElementById('tbEmpty');
  var tbSearchEl = document.getElementById('tbSearch');
  var tbMenuEl = document.getElementById('tbMenu');
  var toolboxItems = [];

  // The nine VS toolbox categories, in VS order. "All Windows Forms" is the catch-all (lists every item).
  var BUILTIN_TABS = ['All Windows Forms', 'Common Controls', 'Containers', 'Menus & Toolbars',
    'Components', 'Printing', 'Dialogs', 'WPF Interoperability', 'Data'];
  // Categories that need the (deferred) non-Control component-tray add path before they can be populated —
  // shown as visible "coming soon" sections, mirroring VS's category list (Codex Q2 = increment B).
  var DEFERRED_TABS = ['Components', 'Dialogs', 'WPF Interoperability'];

  // Persisted toolbox UI state (survives reloads via vscode.setState). customTabs: [{name, items:[fqn]}].
  var tbState = loadTbState();
  function loadTbState() {
    var s = (vscode.getState && vscode.getState()) || {};
    var t = (s && s.toolbox) || {};
    var st = {
      collapsed: t.collapsed || null,    // tab name -> true when collapsed (null = seed defaults below)
      customTabs: t.customTabs || [],    // user-defined tabs
      listView: t.listView !== false,    // List View (text rows) — checked by default
      sortAlpha: !!t.sortAlpha,          // Sort Items Alphabetically
      showAll: !!t.showAll               // Show All — currently surfaces the empty-category hint
    };
    if (!st.collapsed) { st.collapsed = {}; BUILTIN_TABS.forEach(function (c) { if (c !== 'Common Controls') st.collapsed[c] = true; }); }
    return st;
  }
  function saveTbState() {
    if (!vscode.setState || !vscode.getState) return;
    var s = vscode.getState() || {}; s.toolbox = tbState; vscode.setState(s);
  }
  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, function (c) { return c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'; }); }
  function findCustom(name) { for (var i = 0; i < tbState.customTabs.length; i++) { if (tbState.customTabs[i].name === name) return tbState.customTabs[i]; } return null; }
  function customIndex(name) { for (var i = 0; i < tbState.customTabs.length; i++) { if (tbState.customTabs[i].name === name) return i; } return -1; }
  function hasProject() { return toolboxItems.some(function (it) { return it.fromProject || it.category === 'Project Controls'; }); }

  function tabOrder() {
    var order = BUILTIN_TABS.slice();
    if (hasProject()) order.push('Project Controls');
    tbState.customTabs.forEach(function (t) { order.push(t.name); });
    return order;
  }
  function tabItems(tab) {
    var q = (tbSearchEl.value || '').trim().toLowerCase();
    var src;
    if (tab === 'All Windows Forms') { var seen = {}; src = toolboxItems.filter(function (it) { var k = it.fqn || it.name; if (seen[k]) return false; seen[k] = true; return true; }); }
    else if (tab === 'Project Controls') src = toolboxItems.filter(function (it) { return it.fromProject || it.category === 'Project Controls'; });
    else {
      var custom = findCustom(tab);
      // a custom tab shows items explicitly added to it (custom.items) OR items the host tagged with this tab
      // as their category (the "Choose Items" additions land here).
      if (custom) src = toolboxItems.filter(function (it) { return custom.items.indexOf(it.fqn) >= 0 || it.category === tab; });
      else src = toolboxItems.filter(function (it) { return it.category === tab; });
    }
    if (q) src = src.filter(function (it) { return it.name.toLowerCase().indexOf(q) >= 0; });
    if (tbState.sortAlpha || tab === 'All Windows Forms') src = src.slice().sort(function (a, b) { return a.name.localeCompare(b.name); });
    return src;
  }

  function renderToolbox() {
    closeTbMenu();
    tbListEl.innerHTML = '';
    if (!toolboxItems.length) { tbEmptyEl.style.display = 'block'; tbBodyEl.style.display = 'none'; return; }
    tbEmptyEl.style.display = 'none'; tbBodyEl.style.display = '';
    var q = (tbSearchEl.value || '').trim().toLowerCase();
    tabOrder().forEach(function (tab) {
      var items = tabItems(tab);
      var isCustom = !!findCustom(tab);
      var collapsed = !!tbState.collapsed[tab] && !q; // an active search forces expand
      var head = document.createElement('div');
      head.className = 'tbCat' + (isCustom ? ' custom' : '');
      head.innerHTML = '<span class="tw">' + (collapsed ? '▸' : '▾') + '</span>' + escapeHtml(tab) + ' <span class="cnt">(' + items.length + ')</span>';
      head.addEventListener('click', function () { tbState.collapsed[tab] = !tbState.collapsed[tab]; saveTbState(); renderToolbox(); });
      head.addEventListener('contextmenu', function (ev) { ev.preventDefault(); ev.stopPropagation(); openTbMenu(ev.clientX, ev.clientY, tab, isCustom); });
      tbListEl.appendChild(head);
      if (collapsed) return;
      if (!items.length) {
        var e = document.createElement('div'); e.className = 'tbEmptyCat';
        e.textContent = q ? 'no matching controls' : (DEFERRED_TABS.indexOf(tab) >= 0 ? 'coming soon' : 'no items');
        tbListEl.appendChild(e); return;
      }
      var box = document.createElement('div'); box.className = 'tbItems' + (tbState.listView ? '' : ' icons');
      items.forEach(function (it) { box.appendChild(makeTbItem(it)); });
      tbListEl.appendChild(box);
    });
  }
  function makeTbItem(it) {
    var b = document.createElement('div'); b.className = 'tbItem'; b.textContent = it.name;
    b.title = it.fqn + ' — click to add, or drag onto the form';
    b.addEventListener('click', function () { vscode.postMessage({ type: 'addControl', controlType: it.name }); });
    // cross-webview drag → canvas drop (custom MIME, NOT text/uri-list). Click-to-add is the reliable fallback.
    b.draggable = true;
    b.addEventListener('dragstart', function (ev) {
      if (!ev.dataTransfer) return;
      ev.dataTransfer.setData('application/vnd.winforms-toolbox-item', it.name);
      ev.dataTransfer.effectAllowed = 'copy';
    });
    return b;
  }
  tbSearchEl.addEventListener('input', renderToolbox);
  // Right-click anywhere in the toolbox body (empty area / between items) → the menu with no tab context
  // (Add Tab enabled; Delete/Rename/Move Tab disabled). Category headers stopPropagation, so this fires only
  // for non-header clicks. Matches VS, where the menu opens on right-click anywhere in the toolbox.
  tbListEl.addEventListener('contextmenu', function (ev) { ev.preventDefault(); openTbMenu(ev.clientX, ev.clientY, null, false); });

  // ---- the VS toolbox right-click context menu (HTML; native menus aren't reachable inside a webview) ----
  function closeTbMenu() { if (tbMenuEl) tbMenuEl.className = 'ctxmenu'; }
  function openTbMenu(x, y, tab, isCustom) {
    var idx = customIndex(tab), last = tbState.customTabs.length - 1;
    var menu = [
      { label: 'Paste', acc: 'Ctrl+V', disabled: true },
      { sep: 1 },
      { label: 'List View', check: tbState.listView, act: function () { tbState.listView = !tbState.listView; saveTbState(); renderToolbox(); } },
      { label: 'Show All', check: tbState.showAll, act: function () { tbState.showAll = !tbState.showAll; saveTbState(); renderToolbox(); } },
      { sep: 1 },
      { label: 'Choose Items…', act: function () { openChoose(tab); } },
      { label: 'Sort Items Alphabetically', check: tbState.sortAlpha, act: function () { tbState.sortAlpha = !tbState.sortAlpha; saveTbState(); renderToolbox(); } },
      { sep: 1 },
      { label: 'Reset Toolbox', act: resetToolbox },
      { sep: 1 },
      { label: 'Add Tab', act: addTab },
      { label: 'Delete Tab', disabled: !isCustom, act: function () { deleteTab(tab); } },
      { label: 'Rename Tab', disabled: !isCustom, act: function () { renameTab(tab); } },
      { sep: 1 },
      { label: 'Move Up', disabled: !isCustom || idx <= 0, act: function () { moveTab(idx, -1); } },
      { label: 'Move Down', disabled: !isCustom || idx < 0 || idx >= last, act: function () { moveTab(idx, 1); } }
    ];
    tbMenuEl.innerHTML = '';
    menu.forEach(function (mi) {
      if (mi.sep) { var s = document.createElement('div'); s.className = 'sep'; tbMenuEl.appendChild(s); return; }
      var d = document.createElement('div'); d.className = 'mi' + (mi.disabled ? ' disabled' : '');
      d.innerHTML = '<span>' + (mi.check ? '✓ ' : '') + escapeHtml(mi.label) + '</span>' + (mi.acc ? '<span class="acc">' + escapeHtml(mi.acc) + '</span>' : '');
      if (!mi.disabled && mi.act) d.addEventListener('click', function () { closeTbMenu(); mi.act(); });
      tbMenuEl.appendChild(d);
    });
    tbMenuEl.className = 'ctxmenu open';
    tbMenuEl.style.left = '0px'; tbMenuEl.style.top = '0px'; // measure, then clamp into the viewport
    var w = tbMenuEl.offsetWidth, h = tbMenuEl.offsetHeight;
    tbMenuEl.style.left = Math.max(2, Math.min(x, window.innerWidth - w - 4)) + 'px';
    tbMenuEl.style.top = Math.max(2, Math.min(y, window.innerHeight - h - 4)) + 'px';
  }
  document.addEventListener('click', function (e) { if (tbMenuEl && tbMenuEl.classList.contains('open') && !tbMenuEl.contains(e.target)) closeTbMenu(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { closeTbMenu(); closePrompt(); closeChoose(); } });

  // ---- custom-tab management (Add/Rename/Delete/Move Up/Down) ----
  function addTab() {
    promptTab('Add Tab', '', function (name) {
      name = (name || '').trim(); if (!name) return;
      if (tabOrder().indexOf(name) >= 0) return; // ignore duplicate name
      tbState.customTabs.push({ name: name, items: [] });
      tbState.collapsed[name] = false; saveTbState(); renderToolbox();
    });
  }
  function renameTab(tab) {
    var c = findCustom(tab); if (!c) return;
    promptTab('Rename Tab', tab, function (name) {
      name = (name || '').trim(); if (!name || name === tab || tabOrder().indexOf(name) >= 0) return;
      if (tbState.collapsed[tab] != null) { tbState.collapsed[name] = tbState.collapsed[tab]; delete tbState.collapsed[tab]; }
      c.name = name; saveTbState(); renderToolbox();
    });
  }
  function deleteTab(tab) {
    var idx = customIndex(tab); if (idx < 0) return;
    tbState.customTabs.splice(idx, 1); delete tbState.collapsed[tab]; saveTbState(); renderToolbox();
  }
  function moveTab(idx, dir) {
    var j = idx + dir; if (idx < 0 || j < 0 || j >= tbState.customTabs.length) return;
    var a = tbState.customTabs, tmp = a[idx]; a[idx] = a[j]; a[j] = tmp; saveTbState(); renderToolbox();
  }
  function resetToolbox() {
    tbState.customTabs = []; tbState.listView = true; tbState.sortAlpha = false; tbState.showAll = false;
    tbState.collapsed = {}; BUILTIN_TABS.forEach(function (c) { if (c !== 'Common Controls') tbState.collapsed[c] = true; });
    saveTbState(); renderToolbox();
  }

  // ---- tab-name prompt (window.prompt() is unavailable inside a webview) ----
  var promptCb = null;
  var tbPromptEl = document.getElementById('tbPrompt');
  var tbPromptTitleEl = document.getElementById('tbPromptTitle');
  var tbPromptInputEl = document.getElementById('tbPromptInput');
  function promptTab(title, initial, cb) {
    promptCb = cb; tbPromptTitleEl.textContent = title; tbPromptInputEl.value = initial || '';
    tbPromptEl.className = 'modal open';
    setTimeout(function () { tbPromptInputEl.focus(); tbPromptInputEl.select(); }, 0);
  }
  function closePrompt() { if (tbPromptEl) tbPromptEl.className = 'modal'; promptCb = null; }
  function acceptPrompt() { var cb = promptCb, v = tbPromptInputEl.value; closePrompt(); if (cb) cb(v); }
  document.getElementById('tbPromptOk').addEventListener('click', acceptPrompt);
  document.getElementById('tbPromptCancel').addEventListener('click', closePrompt);
  tbPromptInputEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); acceptPrompt(); }
    else if (e.key === 'Escape') { e.preventDefault(); closePrompt(); }
  });

  // ---- Choose Items → opens the big "Choose Toolbox Items" window. It is a SEPARATE editor-area webview
  // panel (created by the host), not a micro modal inside this narrow side panel (matches VS).
  function openChoose(tab) { vscode.postMessage({ type: 'chooseItems', tab: tab || null }); }
  function closeChoose() { /* the Choose Items window is its own panel now — nothing to close here */ }

  // ---- Properties pane (component selector + Properties/Events grid) ----
  var treeEl = document.getElementById('tree');
  var propsEl = document.getElementById('props');
  var eventsEl = document.getElementById('events');
  var searchEl = document.getElementById('search');
  var tabPropsEl = document.getElementById('tabProps');
  var tabEventsEl = document.getElementById('tabEvents');
  var sortCatEl = document.getElementById('sortCat');
  var sortAlphaEl = document.getElementById('sortAlpha');
  var bodyEl = document.getElementById('propsBody');
  var emptyEl = document.getElementById('propsEmpty');

  var controls = [];
  var currentId = null;
  var currentComponent = null;
  var activeTab = 'props';
  var eventCandidates = {};
  var candFetchedFor = null;
  var sortMode = 'category';
  var nameColW = 130;

  var NUM = new Set(['System.Int32', 'System.Int64', 'System.Int16', 'System.Byte', 'System.SByte', 'System.UInt16', 'System.UInt32', 'System.UInt64', 'System.Single', 'System.Double', 'System.Decimal']);
  // keep in sync with COMPLEX_TYPES in src/valueExpr.ts
  var COMPLEX = new Set(['System.Drawing.Point', 'System.Drawing.Size', 'System.Drawing.Color', 'System.Drawing.Rectangle', 'System.Windows.Forms.Padding', 'System.Drawing.Font']);

  function shortType(t) { var i = t.lastIndexOf('.'); return i < 0 ? t : t.slice(i + 1); }
  function repeat(s, n) { var r = ''; for (var i = 0; i < n; i++) r += s; return r; }
  function setEmpty(on) { if (emptyEl) emptyEl.style.display = on ? 'block' : 'none'; if (bodyEl) bodyEl.style.display = on ? 'none' : ''; }

  function editable(p) {
    if (p.readOnly) return false;
    if (p.isEnum) return true;
    return p.type === 'System.String' || p.type === 'System.Boolean' || p.type === 'System.Char' || NUM.has(p.type) || COMPLEX.has(p.type);
  }
  function editHint(p) {
    if (p.standardValues && p.standardValues.length) return p.standardValuesExclusive ? ' (choose a value)' : ' (choose or type a value)';
    if (p.isEnum) return ' (enum: type the member name)';
    if (p.type === 'System.Drawing.Point') return ' (x, y)';
    if (p.type === 'System.Drawing.Size') return ' (width, height)';
    if (p.type === 'System.Drawing.Color') return ' (name, or R, G, B / A, R, G, B)';
    if (p.type === 'System.Drawing.Rectangle') return ' (x, y, width, height)';
    if (p.type === 'System.Windows.Forms.Padding') return ' (left, top, right, bottom)';
    if (p.type === 'System.Drawing.Font') return ' (name, sizept[, style=Bold, Italic])';
    return '';
  }

  function rebuildTree() {
    var ordered = controls.slice().sort(function (a, b) { return (a.isRoot ? -1 : b.isRoot ? 1 : a.depth - b.depth); });
    treeEl.innerHTML = '';
    for (var i = 0; i < ordered.length; i++) {
      var c = ordered[i];
      var o = document.createElement('option');
      o.value = c.id;
      o.textContent = (c.isRoot ? c.name + ' (form)' : repeat('   ', c.depth) + c.name) + ' : ' + shortType(c.type);
      treeEl.appendChild(o);
    }
    if (currentId) treeEl.value = currentId;
  }

  // ---- Document outline (§7.4): hierarchical tree built from the layout's parentId/depth ----
  var outlineEl = document.getElementById('outlineTree');
  var outlineCollapsed = {}; // control id -> true when collapsed
  function renderOutline() {
    if (!outlineEl) return;
    outlineEl.innerHTML = '';
    if (!controls.length) {
      var empty = document.createElement('div'); empty.className = 'paneEmpty';
      empty.textContent = 'Render a WinForms designer to see its outline.';
      outlineEl.appendChild(empty); return;
    }
    var kids = {}, roots = [], parentOf = {};
    controls.forEach(function (c) {
      parentOf[c.id] = c.parentId;
      if (c.isRoot || c.parentId == null) roots.push(c);
      else (kids[c.parentId] = kids[c.parentId] || []).push(c);
    });
    // keep the selected node visible: expand its ancestors
    if (currentId) {
      var p = parentOf[currentId];
      while (p != null) { delete outlineCollapsed[p]; p = parentOf[p]; }
    }
    function emit(c, level) {
      var children = kids[c.id] || [];
      var node = document.createElement('div');
      node.className = 'treeNode' + (c.id === currentId ? ' sel' : '');
      node.style.paddingLeft = (4 + level * 14) + 'px';
      var tw = document.createElement('span'); tw.className = 'tw';
      if (children.length) {
        tw.textContent = (outlineCollapsed[c.id] ? '▸ ' : '▾ ');
        tw.addEventListener('click', function (ev) { ev.stopPropagation(); outlineCollapsed[c.id] = !outlineCollapsed[c.id]; renderOutline(); });
      } else { tw.textContent = '   '; }
      node.appendChild(tw);
      var label = document.createElement('span');
      label.textContent = (c.isRoot ? c.name + ' (form)' : c.name) + ' : ' + shortType(c.type);
      node.appendChild(label);
      node.title = c.id + ' : ' + c.type;
      node.addEventListener('click', function () {
        currentId = c.id; if (treeEl) treeEl.value = c.id;
        vscode.postMessage({ type: 'pick', id: c.id }); renderOutline();
      });
      outlineEl.appendChild(node);
      if (!outlineCollapsed[c.id]) children.forEach(function (ch) { emit(ch, level + 1); });
    }
    roots.forEach(function (r) { emit(r, 0); });
  }

  var collapsed = { props: new Set(), events: new Set() };
  function catRow(t, label, tabKey) {
    var isCollapsed = collapsed[tabKey].has(label);
    var cr = document.createElement('tr'); var cd = document.createElement('td');
    cd.colSpan = 2; cd.className = 'cat';
    cd.textContent = (isCollapsed ? '▸ ' : '▾ ') + label;
    cd.addEventListener('click', function () {
      if (collapsed[tabKey].has(label)) collapsed[tabKey].delete(label); else collapsed[tabKey].add(label);
      renderActiveTab();
    });
    cr.appendChild(cd); t.appendChild(cr);
  }
  function filterSort(items, filter) {
    var f = (filter || '').toLowerCase();
    return items.slice()
      .filter(function (x) { return !f || x.name.toLowerCase().indexOf(f) >= 0; })
      .sort(function (a, b) {
        return sortMode === 'alpha' ? a.name.localeCompare(b.name) : (a.category + a.name).localeCompare(b.category + b.name);
      });
  }
  function gridTable() {
    var t = document.createElement('table');
    var cg = document.createElement('colgroup');
    var c1 = document.createElement('col'); c1.style.width = nameColW + 'px';
    cg.appendChild(c1); cg.appendChild(document.createElement('col'));
    t.appendChild(cg);
    t.__nameCol = c1;
    return t;
  }
  function addColSplit(td) {
    var s = document.createElement('div'); s.className = 'colsplit';
    s.addEventListener('mousedown', function (e) {
      e.preventDefault(); e.stopPropagation();
      var startX = e.clientX, startW = nameColW;
      var tbl = td.closest ? td.closest('table') : null;
      function mm(ev) {
        var maxW = (bodyEl ? bodyEl.clientWidth : 320) - 60;
        nameColW = Math.max(60, Math.min(startW + (ev.clientX - startX), maxW));
        if (tbl && tbl.__nameCol) tbl.__nameCol.style.width = nameColW + 'px';
      }
      function mu() { document.removeEventListener('mousemove', mm); document.removeEventListener('mouseup', mu); }
      document.addEventListener('mousemove', mm); document.addEventListener('mouseup', mu);
    });
    td.appendChild(s);
  }

  var COMPOSITE = {
    'System.Drawing.Point': { fields: ['X', 'Y'] },
    'System.Drawing.Size': { fields: ['Width', 'Height'] },
    'System.Drawing.Rectangle': { fields: ['X', 'Y', 'Width', 'Height'] },
    'System.Windows.Forms.Padding': { fields: ['Left', 'Top', 'Right', 'Bottom'], all: true }
  };
  var expandedProps = new Set();
  function parseParts(value, n) {
    if (value == null) return null;
    var arr = String(value).split(',').map(function (s) { return s.trim(); });
    if (arr.length !== n) return null;
    for (var i = 0; i < arr.length; i++) { if (!/^-?\d+$/.test(arr[i])) return null; }
    return arr;
  }
  function sendEdit(id, prop, value) {
    vscode.postMessage({ type: 'edit', id: id, prop: prop.name, propType: prop.type, isEnum: prop.isEnum, value: value });
  }
  function editInput(title, value, onCommit) {
    var input = document.createElement('input');
    input.value = value == null ? '' : value;
    if (title) input.title = title;
    input.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); } });
    input.addEventListener('change', function () { onCommit(input.value); });
    return input;
  }
  // §7.1 standard-values editor: a <select> for an exclusive set (enum/bool/…), else an editable combobox
  // (datalist) that also accepts free text (named Color, etc.). Commits the chosen invariant string.
  var svSeq = 0;
  function editSelect(values, exclusive, value, title, onCommit) {
    var cur = value == null ? '' : String(value);
    if (!exclusive) {
      var wrap = document.createElement('span'); wrap.className = 'evtwrap';
      var listId = 'svlist_' + (svSeq++);
      var dl = document.createElement('datalist'); dl.id = listId;
      values.forEach(function (v) { var o = document.createElement('option'); o.value = v; dl.appendChild(o); });
      var inp = document.createElement('input'); inp.value = cur;
      if (title) inp.title = title;
      inp.setAttribute('list', listId);
      inp.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); inp.blur(); } });
      inp.addEventListener('change', function () { onCommit(inp.value); });
      wrap.appendChild(inp); wrap.appendChild(dl);
      return wrap;
    }
    var sel = document.createElement('select');
    var has = false;
    values.forEach(function (v) {
      var o = document.createElement('option'); o.value = v; o.textContent = v;
      if (v === cur) { o.selected = true; has = true; }
      sel.appendChild(o);
    });
    if (!has) { // keep the current (possibly out-of-set) value selectable so a change is explicit
      var o0 = document.createElement('option'); o0.value = cur; o0.textContent = cur === '' ? '(unset)' : cur;
      o0.selected = true; sel.insertBefore(o0, sel.firstChild);
    }
    if (title) sel.title = title;
    sel.addEventListener('change', function () { onCommit(sel.value); });
    return sel;
  }
  function subRow(label, value, onCommit) {
    var tr = document.createElement('tr');
    var nameTd = document.createElement('td'); nameTd.className = 'name sub'; nameTd.textContent = label;
    var valTd = document.createElement('td'); valTd.className = 'val'; valTd.appendChild(editInput(label, value, onCommit));
    tr.appendChild(nameTd); tr.appendChild(valTd); return tr;
  }

  // ---- Anchor/Dock visual editors (Phase 2): a VS-style glyph picker instead of a raw text/enum field.
  // Each commits an invariant string ("Top, Left" / "Fill" / "None"); the host turns it into a C# enum/flags
  // expression via toCSharpExpression and applies it through the proven setProperty path. ----
  var ANCHOR_TYPE = 'System.Windows.Forms.AnchorStyles';
  var DOCK_TYPE = 'System.Windows.Forms.DockStyle';
  function parseAnchor(value) {
    var set = {};
    String(value == null ? '' : value).split(',').forEach(function (s) { var k = s.trim(); if (k && k !== 'None') set[k] = true; });
    return set; // keys among Top/Bottom/Left/Right; "None" → empty
  }
  function composeAnchor(set) {
    var out = []; ['Top', 'Bottom', 'Left', 'Right'].forEach(function (s) { if (set[s]) out.push(s); });
    return out.length ? out.join(', ') : 'None';
  }
  function anchorEditor(value, onCommit) {
    var set = parseAnchor(value);
    var wrap = document.createElement('div'); wrap.className = 'anchorEd';
    var box = document.createElement('div'); box.className = 'anchorBox';
    box.title = 'Anchor — click a bar to tether/untether that edge';
    ['Top', 'Bottom', 'Left', 'Right'].forEach(function (side) {
      var bar = document.createElement('span');
      bar.className = 'aBar a' + side + (set[side] ? ' on' : '');
      bar.addEventListener('click', function () {
        set[side] = !set[side];
        bar.className = 'aBar a' + side + (set[side] ? ' on' : '');
        onCommit(composeAnchor(set));
      });
      box.appendChild(bar);
    });
    var center = document.createElement('span'); center.className = 'aCenter';
    box.appendChild(center); wrap.appendChild(box);
    return wrap;
  }
  function dockEditor(value, onCommit) {
    var cur = String(value == null ? '' : value).trim() || 'None';
    var wrap = document.createElement('div'); wrap.className = 'dockEd';
    var box = document.createElement('div'); box.className = 'dockBox';
    [['Top', 'dTop'], ['Left', 'dLeft'], ['Fill', 'dFill'], ['Right', 'dRight'], ['Bottom', 'dBottom']].forEach(function (z) {
      var el = document.createElement('span'); el.className = 'dZone ' + z[1] + (cur === z[0] ? ' on' : '');
      el.title = 'Dock ' + z[0];
      el.addEventListener('click', function () { onCommit(z[0]); });
      box.appendChild(el);
    });
    wrap.appendChild(box);
    var none = document.createElement('button'); none.type = 'button'; none.className = 'dNone' + (cur === 'None' ? ' on' : '');
    none.textContent = 'None'; none.title = 'Dock None';
    none.addEventListener('click', function () { onCommit('None'); });
    wrap.appendChild(none);
    return wrap;
  }

  function propRow(c, p, t) {
    var comp = editable(p) ? COMPOSITE[p.type] : null;
    var parts = comp ? parseParts(p.value, comp.fields.length) : null;
    var canExpand = !!parts;
    var isOpen = canExpand && expandedProps.has(p.name);

    var tr = document.createElement('tr');
    var nameTd = document.createElement('td');
    nameTd.className = 'name' + (p.sourceExplicit ? ' set' : '');
    nameTd.title = p.name;
    if (canExpand) {
      var tw = document.createElement('span'); tw.className = 'tw'; tw.textContent = isOpen ? '▾ ' : '▸ ';
      tw.addEventListener('click', function () {
        if (expandedProps.has(p.name)) expandedProps.delete(p.name); else expandedProps.add(p.name);
        renderActiveTab();
      });
      nameTd.appendChild(tw); nameTd.appendChild(document.createTextNode(p.name));
    } else {
      nameTd.textContent = p.name;
    }

    var valTd = document.createElement('td');
    if (editable(p)) {
      valTd.className = 'val';
      if (p.type === ANCHOR_TYPE) {
        valTd.appendChild(anchorEditor(p.value, function (v) { sendEdit(c.id, p, v); }));
      } else if (p.type === DOCK_TYPE) {
        valTd.appendChild(dockEditor(p.value, function (v) { sendEdit(c.id, p, v); }));
      } else if (p.standardValues && p.standardValues.length && !isOpen) {
        valTd.appendChild(editSelect(p.standardValues, !!p.standardValuesExclusive, p.value, p.type + editHint(p), function (v) { sendEdit(c.id, p, v); }));
      } else {
        valTd.appendChild(editInput(p.type + editHint(p), p.value, function (v) { sendEdit(c.id, p, v); }));
      }
    } else {
      valTd.className = 'ro';
      valTd.textContent = (p.value == null ? '' : p.value) + (p.readOnly ? '  (read-only)' : '');
      valTd.title = p.type;
    }
    addColSplit(nameTd);
    tr.appendChild(nameTd); tr.appendChild(valTd); t.appendChild(tr);

    if (isOpen) {
      if (comp.all) {
        var allVal = (parts[0] === parts[1] && parts[1] === parts[2] && parts[2] === parts[3]) ? parts[0] : '';
        t.appendChild(subRow('All', allVal, function (v) { sendEdit(c.id, p, [v, v, v, v].join(', ')); }));
      }
      for (var k = 0; k < comp.fields.length; k++) {
        (function (idx) {
          t.appendChild(subRow(comp.fields[idx], parts[idx], function (v) {
            var nums = parts.slice(); nums[idx] = v; sendEdit(c.id, p, nums.join(', '));
          }));
        })(k);
      }
    }
  }

  function renderProps(c, filter) {
    propsEl.innerHTML = '';
    if (!c) { propsEl.textContent = 'component not found'; return; }
    var sorted = filterSort(c.properties, filter);
    if (!sorted.length) { propsEl.textContent = filter ? 'no matching properties' : 'no properties'; return; }
    var t = gridTable();
    var lastCat = '';
    var hideCat = false;
    for (var i = 0; i < sorted.length; i++) {
      var p = sorted[i];
      if (sortMode === 'category') {
        if (p.category !== lastCat) { lastCat = p.category; hideCat = collapsed.props.has(p.category); catRow(t, p.category, 'props'); }
        if (hideCat) continue;
      }
      propRow(c, p, t);
    }
    propsEl.appendChild(t);
  }

  function fetchCandidatesIfNeeded() {
    if (activeTab === 'events' && currentComponent && candFetchedFor !== currentComponent.id) {
      candFetchedFor = currentComponent.id;
      vscode.postMessage({ type: 'listHandlers', id: currentComponent.id });
    }
  }

  var evtSeq = 0;
  function eventCombo(c, ev) {
    var wrap = document.createElement('span'); wrap.className = 'evtwrap';
    var cur = ev.handler || '';
    var cands = eventCandidates[ev.name] || [];
    var listId = 'evtlist_' + (evtSeq++);
    var dl = document.createElement('datalist'); dl.id = listId;
    for (var i = 0; i < cands.length; i++) { var o = document.createElement('option'); o.value = cands[i]; dl.appendChild(o); }
    var inp = document.createElement('input'); inp.className = 'evt'; inp.value = cur;
    inp.setAttribute('list', listId); inp.placeholder = '(none)';
    inp.title = 'Type a handler name (new or existing), or clear to unwire';
    function commit() {
      var val = inp.value.trim();
      if (val === cur) return;
      if (val === '') { vscode.postMessage({ type: 'setHandler', id: c.id, event: ev.name, handler: '' }); return; }
      var known = eventCandidates[ev.name] || [];
      if (known.indexOf(val) >= 0) vscode.postMessage({ type: 'setHandler', id: c.id, event: ev.name, handler: val });
      else vscode.postMessage({ type: 'createHandler', id: c.id, event: ev.name, handler: val });
    }
    inp.addEventListener('keydown', function (e2) { if (e2.key === 'Enter') { e2.preventDefault(); inp.blur(); } });
    inp.addEventListener('change', commit);
    wrap.appendChild(inp); wrap.appendChild(dl);
    return wrap;
  }

  function renderEvents(c, filter) {
    eventsEl.innerHTML = '';
    if (!c) { eventsEl.textContent = 'component not found'; return; }
    var evs = filterSort(c.events || [], filter);
    if (!evs.length) { eventsEl.textContent = filter ? 'no matching events' : 'no events'; return; }
    var t = gridTable();
    var lastCat = '';
    var hideCat = false;
    for (var i = 0; i < evs.length; i++) {
      var ev = evs[i];
      if (sortMode === 'category') {
        if (ev.category !== lastCat) { lastCat = ev.category; hideCat = collapsed.events.has(ev.category); catRow(t, ev.category, 'events'); }
        if (hideCat) continue;
      }
      var tr = document.createElement('tr');
      var nameTd = document.createElement('td');
      nameTd.className = 'name' + (ev.handler ? ' set' : '');
      nameTd.textContent = ev.name;
      nameTd.style.cursor = 'pointer';
      var valTd = document.createElement('td'); valTd.className = 'val';
      valTd.appendChild(eventCombo(c, ev));
      (function (e) {
        nameTd.title = e.type + (e.handler ? '  —  double-click to go to the handler' : '  —  double-click to create a handler');
        // VS-style: double-click an event → if wired, go to the handler; if unwired, CREATE one (auto-named) and go.
        nameTd.addEventListener('dblclick', function () {
          if (e.handler) vscode.postMessage({ type: 'navigateHandler', id: c.id, event: e.name, handler: e.handler });
          else vscode.postMessage({ type: 'createHandler', id: c.id, event: e.name });
        });
      })(ev);
      addColSplit(nameTd);
      tr.appendChild(nameTd); tr.appendChild(valTd); t.appendChild(tr);
    }
    eventsEl.appendChild(t);
  }

  function renderActiveTab() {
    if (activeTab === 'props') renderProps(currentComponent, searchEl.value);
    else renderEvents(currentComponent, searchEl.value);
  }
  function setTab(tab) {
    activeTab = tab;
    tabPropsEl.className = tab === 'props' ? 'active' : '';
    tabEventsEl.className = tab === 'events' ? 'active' : '';
    propsEl.style.display = tab === 'props' ? '' : 'none';
    eventsEl.style.display = tab === 'events' ? '' : 'none';
    searchEl.placeholder = tab === 'props' ? 'Search properties…' : 'Search events…';
    renderActiveTab();
    fetchCandidatesIfNeeded();
  }
  function setSort(mode) {
    sortMode = mode;
    sortCatEl.className = mode === 'category' ? 'active' : '';
    sortAlphaEl.className = mode === 'alpha' ? 'active' : '';
    renderActiveTab();
  }

  treeEl.addEventListener('change', function () { currentId = treeEl.value; vscode.postMessage({ type: 'pick', id: currentId }); });
  tabPropsEl.addEventListener('click', function () { setTab('props'); });
  tabEventsEl.addEventListener('click', function () { setTab('events'); });
  searchEl.addEventListener('input', renderActiveTab);
  sortCatEl.addEventListener('click', function () { setSort('category'); });
  sortAlphaEl.addEventListener('click', function () { setSort('alpha'); });

  // Delete while this panel has focus (e.g. the user is on the Toolbox tab): the canvas — a separate webview —
  // owns the selection, so forward to the host, which tells the canvas to delete its current selection. Guard
  // against typing in the search box / a grid value editor.
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Delete' && e.key !== 'Del') return;
    var ae = document.activeElement;
    if (ae && (/^(INPUT|SELECT|TEXTAREA)$/.test(ae.tagName) || ae.isContentEditable)) return;
    e.preventDefault(); vscode.postMessage({ type: 'deleteSelected' });
  });

  window.addEventListener('message', function (e) {
    var m = e.data;
    if (m.type === 'toolbox') {
      toolboxItems = m.items || []; renderToolbox();
    } else if (m.type === 'showTab') {
      showMainTab(m.tab); // F4 → reveal Properties
    } else if (m.type === 'layout') {
      controls = m.controls || [];
      rebuildTree(); renderOutline();
    } else if (m.type === 'select') {
      currentId = m.id;
      if (treeEl) treeEl.value = m.id;
      renderOutline();
    } else if (m.type === 'props') {
      if (m.id !== currentId) return;
      var compId = m.component ? m.component.id : null;
      if (!currentComponent || currentComponent.id !== compId) { eventCandidates = {}; candFetchedFor = null; }
      currentComponent = m.component;
      setEmpty(!m.component);
      renderActiveTab();
      fetchCandidatesIfNeeded();
    } else if (m.type === 'candidates') {
      if (currentComponent && currentComponent.id === m.id) { eventCandidates = m.map || {}; if (activeTab === 'events') renderActiveTab(); }
    } else if (m.type === 'clear') {
      controls = []; currentId = null; currentComponent = null; eventCandidates = {}; candFetchedFor = null;
      toolboxItems = []; renderToolbox();
      rebuildTree(); renderOutline(); setEmpty(true);
    }
  });

  setEmpty(true);
  renderToolbox();
  // Deterministic initial state: show ONLY the Properties pane. The panes are position:absolute/inset:0 and
  // stack on top of each other; without this explicit call the first paint could show more than one pane's
  // text overlapping until the user clicked a tab. (Bug fix: "каша" on init.)
  showMainTab('props');
  vscode.postMessage({ type: 'ready' });
})();
