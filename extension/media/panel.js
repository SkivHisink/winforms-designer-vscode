// WinForms designer — the single dockable panel WebviewView. Hosts TWO full-size panes (Properties grid +
// Toolbox palette) switched by a tab strip at the bottom of the view, so each category gets the whole area
// (instead of two stacked views splitting it). Mirrors the active designer editor; edits/adds are posted to
// the host, which applies them to the active .Designer.cs and live-updates the canvas. Kept in sync with the
// host protocol in src/designerEditor.ts.
(function () {
  var vscode = acquireVsCodeApi();
  // ---- i18n shim: host injects window.__WFD_L10N__ (catalog) + window.__WFD_LANG__ (locale) before this
  // script. T()/TN() mirror the host's t()/tn(); a missing key falls back to the key itself. Named T/TN (not
  // t/tn) because `t` is already used as a local variable throughout this file. ----
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
  // Toolbox categories + composite/anchor field names are canonical English KEYS (matched against engine data,
  // persisted in state, and used in edit logic); only their DISPLAY is localized. Unknown names (custom tabs)
  // show verbatim.
  var CAT_KEY = {
    'All Windows Forms': 'panel.cat.allWinforms', 'Common Controls': 'panel.cat.commonControls',
    'Containers': 'panel.cat.containers', 'Menus & Toolbars': 'panel.cat.menusToolbars',
    'Components': 'panel.cat.components', 'Printing': 'panel.cat.printing', 'Dialogs': 'panel.cat.dialogs',
    'WPF Interoperability': 'panel.cat.wpfInterop', 'Data': 'panel.cat.data', 'Project Controls': 'panel.cat.projectControls'
  };
  function catLabel(tab) { return CAT_KEY[tab] ? T(CAT_KEY[tab]) : tab; }
  var FIELD_KEY = {
    X: 'panel.field.x', Y: 'panel.field.y', Width: 'panel.field.width', Height: 'panel.field.height',
    Left: 'panel.field.left', Top: 'panel.field.top', Right: 'panel.field.right', Bottom: 'panel.field.bottom',
    All: 'panel.field.all', Dock: 'panel.field.dock'
  };
  function fieldLabel(n) { return FIELD_KEY[n] ? T(FIELD_KEY[n]) : n; }

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
  var DEFERRED_TABS = ['WPF Interoperability'];

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
    var rendered = 0;
    tabOrder().forEach(function (tab) {
      var items = tabItems(tab);
      // during an active search, drop categories with no matching controls entirely (no header, no hint) —
      // showing empty "no matching controls" sections while filtering is just noise.
      if (q && !items.length) return;
      rendered++;
      var isCustom = !!findCustom(tab);
      var collapsed = !!tbState.collapsed[tab] && !q; // an active search forces expand
      var head = document.createElement('div');
      head.className = 'tbCat' + (isCustom ? ' custom' : '');
      head.innerHTML = '<span class="tw">' + (collapsed ? '▸' : '▾') + '</span>' + escapeHtml(catLabel(tab)) + ' <span class="cnt">(' + items.length + ')</span>';
      head.addEventListener('click', function () { tbState.collapsed[tab] = !tbState.collapsed[tab]; saveTbState(); renderToolbox(); });
      head.addEventListener('contextmenu', function (ev) { ev.preventDefault(); ev.stopPropagation(); openTbMenu(ev.clientX, ev.clientY, tab, isCustom); });
      tbListEl.appendChild(head);
      if (collapsed) return;
      if (!items.length) {
        // reached only when NOT searching (empty categories are filtered above during search)
        var e = document.createElement('div'); e.className = 'tbEmptyCat';
        e.textContent = DEFERRED_TABS.indexOf(tab) >= 0 ? T('panel.tb.comingSoon') : T('panel.tb.noItems');
        tbListEl.appendChild(e); return;
      }
      var box = document.createElement('div'); box.className = 'tbItems' + (tbState.listView ? '' : ' icons');
      items.forEach(function (it) { box.appendChild(makeTbItem(it)); });
      tbListEl.appendChild(box);
    });
    // a search that filters out every category → one hint instead of a blank pane
    if (q && !rendered) {
      var none = document.createElement('div'); none.className = 'tbEmptyCat'; none.textContent = T('panel.tb.noMatching');
      tbListEl.appendChild(none);
    }
  }
  function makeTbItem(it) {
    var b = document.createElement('div'); b.className = 'tbItem';
    // The control's own [ToolboxBitmap] (same icon VS shows), sent by the engine as a base64 PNG. When absent
    // (e.g. a "Choose Items" addition) the .tbItem keeps its generic ::before glyph as a fallback.
    if (it.iconPng) {
      b.classList.add('ic');
      var img = document.createElement('img');
      img.className = 'tbIcon'; img.alt = '';
      img.draggable = false;            // images are draggable by default → would hijack the .tbItem drag with their own
      img.src = 'data:image/png;base64,' + it.iconPng;
      b.appendChild(img);
    }
    var lbl = document.createElement('span'); lbl.className = 'tbLabel'; lbl.textContent = it.name;
    b.appendChild(lbl);
    // non-visual components (Timer/ToolTip/dialog…) go to the component tray — click-to-add only (no position), via
    // the AddComponent path. Visual controls support click-to-add AND drag onto the form at a position.
    // For a PROJECT/vendor control send the FULLY-QUALIFIED name as the add key, not the short name: a vendor control
    // whose short name collides with a framework one (e.g. a project "Panel") would otherwise resolve to the stock
    // framework type, and two project controls sharing a short name would be ambiguous. A dotted FQN resolves exactly
    // in both engines (net9 ResolveSpec by Fqn; net48 ResolveControlType via Type.GetType). Framework/components keep
    // their short name (unchanged). See #5 DevExpress-add review.
    var addKey = it.fromProject ? it.fqn : it.name;
    b.title = it.fqn + (it.isComponent ? T('panel.tb.item.componentTip') : T('panel.tb.item.controlTip'));
    b.addEventListener('click', function () {
      if (it.isComponent) vscode.postMessage({ type: 'addComponent', componentType: it.name });
      else vscode.postMessage({ type: 'addControl', controlType: addKey });
    });
    if (it.isComponent) return b;   // components aren't draggable (no on-form position)
    // cross-webview drag → canvas drop (custom MIME, NOT text/uri-list). Click-to-add is the reliable fallback.
    b.draggable = true;
    b.addEventListener('dragstart', function (ev) {
      if (!ev.dataTransfer) return;
      ev.dataTransfer.setData('application/vnd.winforms-toolbox-item', addKey);
      ev.dataTransfer.effectAllowed = 'copy';
      // give the drag a clean single-item image — the default drag snapshot in this host can balloon to look like
      // the whole list is being dragged. A throwaway off-screen chip with just the control name fixes the visual.
      try {
        var di = document.createElement('div'); di.className = 'tbDragImage'; di.textContent = it.name;
        document.body.appendChild(di);
        ev.dataTransfer.setDragImage(di, 12, 10);
        setTimeout(function () { if (di.parentNode) di.parentNode.removeChild(di); }, 0);
      } catch (_e) { /* setDragImage unsupported → fall back to the default image */ }
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
      { label: T('panel.menu.paste'), acc: 'Ctrl+V', disabled: true },
      { sep: 1 },
      { label: T('panel.menu.listView'), check: tbState.listView, act: function () { tbState.listView = !tbState.listView; saveTbState(); renderToolbox(); } },
      { label: T('panel.menu.showAll'), check: tbState.showAll, act: function () { tbState.showAll = !tbState.showAll; saveTbState(); renderToolbox(); } },
      { sep: 1 },
      { label: T('panel.menu.chooseItems'), act: function () { openChoose(tab); } },
      { label: T('panel.menu.sortAlpha'), check: tbState.sortAlpha, act: function () { tbState.sortAlpha = !tbState.sortAlpha; saveTbState(); renderToolbox(); } },
      { sep: 1 },
      { label: T('panel.menu.resetToolbox'), act: resetToolbox },
      { sep: 1 },
      { label: T('panel.menu.addTab'), act: addTab },
      { label: T('panel.menu.deleteTab'), disabled: !isCustom, act: function () { deleteTab(tab); } },
      { label: T('panel.menu.renameTab'), disabled: !isCustom, act: function () { renameTab(tab); } },
      { sep: 1 },
      { label: T('panel.menu.moveUp'), disabled: !isCustom || idx <= 0, act: function () { moveTab(idx, -1); } },
      { label: T('panel.menu.moveDown'), disabled: !isCustom || idx < 0 || idx >= last, act: function () { moveTab(idx, 1); } }
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
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { closeTbMenu(); closePrompt(); closeChoose(); closePopup(); } });

  // ---- custom-tab management (Add/Rename/Delete/Move Up/Down) ----
  function addTab() {
    promptTab(T('panel.tbPrompt.title'), '', function (name) {
      name = (name || '').trim(); if (!name) return;
      if (tabOrder().indexOf(name) >= 0) return; // ignore duplicate name
      tbState.customTabs.push({ name: name, items: [] });
      tbState.collapsed[name] = false; saveTbState(); renderToolbox();
    });
  }
  function renameTab(tab) {
    var c = findCustom(tab); if (!c) return;
    promptTab(T('panel.tbPrompt.renameTitle'), tab, function (name) {
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
  var descEl = document.getElementById('propDesc');

  var controls = [];
  var currentId = null;
  var currentComponent = null;
  var currentProp = null;   // name of the active property row (drives the description pane + row highlight)
  var activeTab = 'props';
  var eventCandidates = {};
  var candFetchedFor = null;
  var sortMode = 'category';
  var nameColW = 130;

  var NUM = new Set(['System.Int32', 'System.Int64', 'System.Int16', 'System.Byte', 'System.SByte', 'System.UInt16', 'System.UInt32', 'System.UInt64', 'System.Single', 'System.Double', 'System.Decimal']);
  // keep in sync with COMPLEX_TYPES in src/valueExpr.ts
  var COMPLEX = new Set(['System.Drawing.Point', 'System.Drawing.Size', 'System.Drawing.Color', 'System.Drawing.Rectangle', 'System.Windows.Forms.Padding', 'System.Drawing.Font', 'System.Windows.Forms.Cursor']);
  var COLOR_TYPE = 'System.Drawing.Color';
  var FONT_TYPE = 'System.Drawing.Font';

  // The color/font palette pushed by the host (engine GetDesignerPalette). Feeds the Color dropdown swatches,
  // the Font Name combobox, and the authoritative FontConverter unit suffixes. Null until it arrives → the
  // Color/Font editors gracefully fall back to plain text inputs.
  var palette = null;
  var colorByName = {};   // lowercased KnownColor name -> "#rrggbb"
  var unitBySuffix = {};  // FontConverter suffix ("pt") -> GraphicsUnit name ("Point")
  var unitByName = {};    // GraphicsUnit name ("Point") -> suffix ("pt")
  function applyPalette(p) {
    palette = p || null;
    colorByName = {}; unitBySuffix = {}; unitByName = {};
    if (!palette) return;
    (palette.webColors || []).concat(palette.systemColors || []).forEach(function (c) { colorByName[String(c.name).toLowerCase()] = '#' + c.argb; });
    (palette.fontUnits || []).forEach(function (u) { unitBySuffix[u.suffix] = u.name; unitByName[u.name] = u.suffix; });
  }

  function shortType(t) { var i = t.lastIndexOf('.'); return i < 0 ? t : t.slice(i + 1); }
  function repeat(s, n) { var r = ''; for (var i = 0; i < n; i++) r += s; return r; }
  function setEmpty(on) { if (emptyEl) emptyEl.style.display = on ? 'block' : 'none'; if (bodyEl) bodyEl.style.display = on ? 'none' : ''; }

  function editable(p) {
    if (p.readOnly) return false;
    if (p.isEnum) return true;
    return p.type === 'System.String' || p.type === 'System.Boolean' || p.type === 'System.Char' || NUM.has(p.type) || COMPLEX.has(p.type);
  }
  // The engine's ShouldSerializeValue over-reports a few ambient/runtime props on the interpreted host, so an
  // untouched control would otherwise show them non-default (per DesignerDescribe.cs:17-21). Visible/Enabled are
  // ambient; TabIndex is assigned implicitly by the layout engine and ShouldSerialize reports any non-zero value —
  // empirically it leaked bold onto ~every control, which VS never shows in-source. Keep this set minimal.
  var NONDEFAULT_NOISE = new Set(['Visible', 'Enabled', 'TabIndex']);
  // A property is "non-default" (VS bolds it, and it's the natural reset target): trust the accurate source signal
  // (sourceExplicit = assigned in .Designer.cs) unioned with the engine's ShouldSerializeValue verdict
  // (isDefault === false = "value differs from the type default"), guarding the latter against its documented
  // over-reporting — only literal/editable/resettable rows contribute it (skip non-literal collection/image/
  // table-cell rows and read-only rows, plus the named ambient offenders).
  function isNonDefault(p) {
    if (p.sourceExplicit) return true;
    return p.isDefault === false && !p.isCollection && !p.isImage && !p.tableCell && !p.readOnly && !NONDEFAULT_NOISE.has(p.name);
  }
  function editHint(p) {
    if (p.standardValues && p.standardValues.length) return p.standardValuesExclusive ? T('panel.hint.chooseValue') : T('panel.hint.chooseOrType');
    if (p.isEnum) return T('panel.hint.enum');
    if (p.type === 'System.Drawing.Point') return T('panel.hint.point');
    if (p.type === 'System.Drawing.Size') return T('panel.hint.size');
    if (p.type === 'System.Drawing.Color') return T('panel.hint.color');
    if (p.type === 'System.Drawing.Rectangle') return T('panel.hint.rectangle');
    if (p.type === 'System.Windows.Forms.Padding') return T('panel.hint.padding');
    if (p.type === 'System.Drawing.Font') return T('panel.hint.font');
    return '';
  }

  function findProp(c, name) {
    if (!c || !c.properties || name == null) return null;
    for (var i = 0; i < c.properties.length; i++) if (c.properties[i].name === name) return c.properties[i];
    return null;
  }
  // The description pane text: the property's DescriptionAttribute, falling back to its type + edit hint when it
  // carries no description (so the pane is never blank for a selected row).
  function descFor(p) {
    if (p.description && String(p.description).trim()) return p.description;
    var hint = editHint(p);
    return p.type + (hint ? ' — ' + hint : '');
  }
  // Repaint the bottom description pane for the active property row, or a neutral component summary when none is
  // selected. textContent throughout — never innerHTML — so a control's description text can't inject markup.
  function updateDescPane() {
    if (!descEl) return;
    descEl.innerHTML = '';
    if (!currentComponent) return;
    // property descriptions only apply on the Properties tab; on Events show the neutral component summary
    var p = activeTab === 'props' ? findProp(currentComponent, currentProp) : null;
    var nm = document.createElement('div'); nm.className = 'pdName';
    var ds = document.createElement('div'); ds.className = 'pdText';
    if (p) { nm.textContent = p.name; ds.textContent = descFor(p); }
    else { nm.textContent = currentComponent.name || ''; ds.textContent = shortType(currentComponent.type || ''); }
    descEl.appendChild(nm); descEl.appendChild(ds);
  }
  // Mark a property row active (VS: the description pane follows the focused row). Toggles the highlight class
  // in place — no full re-render — so clicking into a value editor doesn't rebuild/lose focus.
  function selectProp(name, tr) {
    if (currentProp === name) return;
    currentProp = name;
    if (propsEl) { var prev = propsEl.querySelector('tr.sel'); if (prev) prev.classList.remove('sel'); }
    if (tr) tr.classList.add('sel');
    updateDescPane();
  }

  // VS-style right-click menu for a property row. Reuses the shared floating ctxmenu element (tbMenuEl). "Reset"
  // is enabled only when the property has a source assignment to delete (sourceExplicit) — otherwise it is already
  // at its default and reset would be a no-op, so we grey it like VS. The engine reset is safe-save-gated + no-op-safe.
  function openPropMenu(x, y, c, p) {
    if (!tbMenuEl) return;
    var items = [
      { label: T('panel.menu.reset'), disabled: !p.sourceExplicit, act: function () { vscode.postMessage({ type: 'resetProperty', id: c.id, prop: p.name }); } }
    ];
    tbMenuEl.innerHTML = '';
    items.forEach(function (mi) {
      if (mi.sep) { var s = document.createElement('div'); s.className = 'sep'; tbMenuEl.appendChild(s); return; }
      var d = document.createElement('div'); d.className = 'mi' + (mi.disabled ? ' disabled' : '');
      d.innerHTML = '<span>' + escapeHtml(mi.label) + '</span>';
      if (!mi.disabled && mi.act) d.addEventListener('click', function () { closeTbMenu(); mi.act(); });
      tbMenuEl.appendChild(d);
    });
    tbMenuEl.className = 'ctxmenu open';
    tbMenuEl.style.left = '0px'; tbMenuEl.style.top = '0px'; // measure, then clamp into the viewport
    var w = tbMenuEl.offsetWidth, h = tbMenuEl.offsetHeight;
    tbMenuEl.style.left = Math.max(2, Math.min(x, window.innerWidth - w - 4)) + 'px';
    tbMenuEl.style.top = Math.max(2, Math.min(y, window.innerHeight - h - 4)) + 'px';
  }

  function rebuildTree() {
    var ordered = controls.slice().sort(function (a, b) { return (a.isRoot ? -1 : b.isRoot ? 1 : a.depth - b.depth); });
    treeEl.innerHTML = '';
    for (var i = 0; i < ordered.length; i++) {
      var c = ordered[i];
      var o = document.createElement('option');
      o.value = c.id;
      o.textContent = (c.isRoot ? c.name + T('panel.tree.formSuffix') : repeat('   ', c.depth) + c.name) + ' : ' + shortType(c.type);
      treeEl.appendChild(o);
    }
    if (currentId) treeEl.value = currentId;
  }

  // ---- Document outline: hierarchical tree built from the layout's parentId/depth ----
  var outlineEl = document.getElementById('outlineTree');
  var outlineCollapsed = {}; // control id -> true when collapsed
  function renderOutline() {
    if (!outlineEl) return;
    // a11y mirror-tree: the outline IS the accessible mirror of the design surface — expose it as an ARIA
    // tree so a screen reader announces the control hierarchy, selection and expand state.
    outlineEl.setAttribute('role', 'tree');
    outlineEl.setAttribute('aria-label', T('panel.outline.aria'));
    outlineEl.innerHTML = '';
    if (!controls.length) {
      var empty = document.createElement('div'); empty.className = 'paneEmpty';
      empty.textContent = T('panel.outline.empty');
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
      var isSel = c.id === currentId;
      var node = document.createElement('div');
      node.className = 'treeNode' + (isSel ? ' sel' : '');
      node.style.paddingLeft = (4 + level * 14) + 'px';
      node.setAttribute('role', 'treeitem');
      node.setAttribute('aria-level', String(level + 1));
      node.setAttribute('aria-selected', isSel ? 'true' : 'false');
      if (children.length) node.setAttribute('aria-expanded', outlineCollapsed[c.id] ? 'false' : 'true');
      node.tabIndex = isSel ? 0 : -1;          // roving tabindex — one tab stop, arrows move within the tree
      node.dataset.id = c.id;
      var tw = document.createElement('span'); tw.className = 'tw';
      if (children.length) {
        tw.textContent = (outlineCollapsed[c.id] ? '▸ ' : '▾ ');
        tw.addEventListener('click', function (ev) { ev.stopPropagation(); outlineCollapsed[c.id] = !outlineCollapsed[c.id]; renderOutline(); });
      } else { tw.textContent = '   '; }
      node.appendChild(tw);
      var label = document.createElement('span');
      label.textContent = (c.isRoot ? c.name + T('panel.tree.formSuffix') : c.name) + ' : ' + shortType(c.type);
      node.appendChild(label);
      node.title = c.id + ' : ' + c.type;
      node.addEventListener('click', function () { pickOutline(c.id); });
      outlineEl.appendChild(node);
      if (!outlineCollapsed[c.id]) children.forEach(function (ch) { emit(ch, level + 1); });
    }
    roots.forEach(function (r) { emit(r, 0); });
    // when nothing is selected, keep the tree Tab-reachable by giving the first node the tab stop
    if (!currentId && outlineEl.firstChild && outlineEl.firstChild.setAttribute) outlineEl.firstChild.tabIndex = 0;
  }
  function pickOutline(id) {
    currentId = id; if (treeEl) treeEl.value = id;
    vscode.postMessage({ type: 'pick', id: id }); renderOutline();
  }
  // keyboard navigation for the ARIA tree: Up/Down move between visible items, Right/Left expand/collapse,
  // Enter/Space select. Attached once to the container; nodes are re-created each render but delegation persists.
  if (outlineEl) outlineEl.addEventListener('keydown', function (e) {
    var nodes = Array.prototype.slice.call(outlineEl.querySelectorAll('.treeNode'));
    if (!nodes.length) return;
    var idx = nodes.indexOf(document.activeElement);
    if (idx < 0) { for (var i = 0; i < nodes.length; i++) { if (nodes[i].classList.contains('sel')) { idx = i; break; } } }
    function focusAt(j) { var n = nodes[j]; if (!n) return; nodes.forEach(function (x) { x.tabIndex = -1; }); n.tabIndex = 0; n.focus(); }
    var aid = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.id : null;
    if (e.key === 'ArrowDown') { e.preventDefault(); focusAt(idx < 0 ? 0 : Math.min(nodes.length - 1, idx + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); focusAt(idx <= 0 ? 0 : idx - 1); }
    else if (e.key === 'ArrowRight') { if (aid && outlineCollapsed[aid]) { e.preventDefault(); outlineCollapsed[aid] = false; renderOutline(); } }
    else if (e.key === 'ArrowLeft') { if (aid && !outlineCollapsed[aid]) { e.preventDefault(); outlineCollapsed[aid] = true; renderOutline(); } }
    else if (e.key === 'Enter' || e.key === ' ') { if (aid) { e.preventDefault(); pickOutline(aid); } }
  });

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
    // a TableLayoutPanel child's Column/Row is not a property assignment — it lives in the 3-arg Controls.Add, so
    // route it to the SetTableCell path (which rewrites the cell args) instead of the normal setProperty edit.
    if (prop.tableCell) {
      vscode.postMessage({ type: 'setTableCell', id: id, cell: prop.name, value: value });
      return;
    }
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
  // standard-values editor: a <select> for an exclusive set (enum/bool/…), else an editable combobox
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
      var o0 = document.createElement('option'); o0.value = cur; o0.textContent = cur === '' ? T('panel.grid.unset') : cur;
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
  // a composite sub-row whose value cell is a <select> (exclusive combobox) — used by the expanded
  // Anchor (per-edge True/False) and Dock (DockStyle) editors.
  function subSelectRow(label, value, values, onCommit) {
    var tr = document.createElement('tr');
    var nameTd = document.createElement('td'); nameTd.className = 'name sub'; nameTd.textContent = label;
    var valTd = document.createElement('td'); valTd.className = 'val';
    valTd.appendChild(editSelect(values, true, value, label, onCommit));
    tr.appendChild(nameTd); tr.appendChild(valTd); return tr;
  }
  // a composite sub-row whose value cell is an editable combobox (datalist) — accepts a listed value OR free
  // text. Used by the expanded Font editor's Name row (installed families as suggestions, custom name allowed).
  function subComboRow(label, value, values, onCommit) {
    var tr = document.createElement('tr');
    var nameTd = document.createElement('td'); nameTd.className = 'name sub'; nameTd.textContent = label;
    var valTd = document.createElement('td'); valTd.className = 'val';
    valTd.appendChild(editSelect(values, false, value, label, onCommit));
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
    box.title = T('panel.anchor.boxTip');
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
      el.title = T('panel.dock.zoneTip', { side: z[0] });
      el.addEventListener('click', function () { onCommit(z[0]); });
      box.appendChild(el);
    });
    wrap.appendChild(box);
    var none = document.createElement('button'); none.type = 'button'; none.className = 'dNone' + (cur === 'None' ? ' on' : '');
    none.textContent = 'None'; none.title = T('panel.dock.noneTip');
    none.addEventListener('click', function () { onCommit('None'); });
    wrap.appendChild(none);
    return wrap;
  }

  // ---- floating popup (VS-style dropdown surface: color picker, flags checkboxes). Appended to <body> and
  // position:fixed so #grid's overflow can't clip it. One at a time; closes on outside-click / Esc / re-open. ----
  var popupEl = null;
  var popupAnchor = null;
  function closePopup() {
    if (!popupEl) return;
    if (popupEl.parentNode) popupEl.parentNode.removeChild(popupEl);
    popupEl = null; popupAnchor = null;
    document.removeEventListener('mousedown', onPopupOutside, true);
  }
  // Close on a mousedown that is neither inside the popup NOR on its own anchor button — the anchor is excluded
  // so ddButton's click handler can toggle the popup shut itself (otherwise the capture-phase mousedown would
  // pre-close it and the following click would reopen it — the "flicker-reopen" bug).
  function onPopupOutside(e) {
    if (!popupEl) return;
    if (popupEl.contains(e.target)) return;
    if (popupAnchor && popupAnchor.contains(e.target)) return;
    closePopup();
  }
  function openPopup(anchorEl, build) {
    closePopup();
    popupEl = document.createElement('div'); popupEl.className = 'propPopup';
    popupAnchor = anchorEl;
    build(popupEl);
    document.body.appendChild(popupEl);
    var r = anchorEl.getBoundingClientRect();
    var w = popupEl.offsetWidth, h = popupEl.offsetHeight;
    var left = Math.max(2, Math.min(r.left, window.innerWidth - w - 4));
    var top = r.bottom + 2;
    if (top + h > window.innerHeight - 4) top = Math.max(2, r.top - h - 2); // flip above the anchor if no room below
    popupEl.style.left = left + 'px';
    popupEl.style.top = top + 'px';
    // register after this click's event cycle so the opening click doesn't immediately close it
    setTimeout(function () { document.addEventListener('mousedown', onPopupOutside, true); }, 0);
  }
  function ddButton(title, onClick) {
    var b = document.createElement('span'); b.className = 'ddBtn'; b.textContent = '▾'; b.title = title || '';
    // toggle: a second click on the arrow that owns the open popup closes it (standard dropdown contract)
    b.addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (popupEl && popupAnchor === b) { closePopup(); return; }
      onClick(b);
    });
    return b;
  }

  // ---- Color editor (VS-style): swatch + free-text input + a dropdown to a tabbed palette (Custom/Web/System).
  // Commits an invariant string ("Red" / "255, 128, 0" / "Control"); the engine's convertValue disambiguates
  // named vs system vs ARGB. Falls back to the raw text input when the palette hasn't arrived. ----
  function colorToHex(value) {
    if (value == null) return null;
    var v = String(value).trim();
    if (!v) return null;
    // Transparent is the one KnownColor with alpha 0; the palette reports it as opaque white (alpha is stripped
    // from the RRGGBB swatch), so surface it as the checkerboard "no color" swatch rather than a white block.
    if (v.toLowerCase() === 'transparent') return null;
    var parts = v.split(',').map(function (s) { return s.trim(); });
    if (parts.length === 3 || parts.length === 4) {
      // "R, G, B" or "A, R, G, B" — every part must be an integer 0..255
      if (!parts.every(function (s) { return /^\d{1,3}$/.test(s) && Number(s) <= 255; })) return null;
      var off = parts.length === 4 ? 1 : 0; // skip the alpha component for the swatch
      return '#' + [off, off + 1, off + 2].map(function (i) { return ('0' + Number(parts[i]).toString(16)).slice(-2); }).join('');
    }
    return colorByName[v.toLowerCase()] || null; // named / system color
  }
  function swatchSpan(hex) {
    var s = document.createElement('span'); s.className = 'swatch' + (hex ? '' : ' none');
    if (hex) s.style.background = hex;
    return s;
  }
  // A compact, fixed common-color grid for the "Custom" tab (all standard KnownColor names → resolve to swatches).
  var CUSTOM_COLORS = [
    'White', 'Silver', 'Gray', 'DimGray', 'Black', 'Red', 'Maroon', 'Orange',
    'Gold', 'Yellow', 'Olive', 'Lime', 'Green', 'Aqua', 'Teal', 'Blue',
    'Navy', 'Fuchsia', 'Purple', 'Pink', 'HotPink', 'Crimson', 'OrangeRed', 'Coral',
    'Khaki', 'Tan', 'Brown', 'Chocolate', 'ForestGreen', 'SeaGreen', 'Turquoise', 'SteelBlue',
    'CornflowerBlue', 'RoyalBlue', 'MediumBlue', 'Indigo', 'Violet', 'Plum', 'LightGray', 'Transparent'];
  function colorEditor(value, onCommit) {
    var wrap = document.createElement('div'); wrap.className = 'colorEd';
    var sw = swatchSpan(colorToHex(value));
    var inp = document.createElement('input'); inp.className = 'colorInp'; inp.value = value == null ? '' : value;
    inp.title = T('panel.color.inputTip');
    inp.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); inp.blur(); } });
    inp.addEventListener('change', function () { onCommit(inp.value); });
    wrap.appendChild(sw); wrap.appendChild(inp);
    wrap.appendChild(ddButton(T('panel.color.pickTip'), function (btn) { openColorPopup(btn, value, onCommit); }));
    return wrap;
  }
  function colorSwatchGrid(container, names, curVal, onPick) {
    var cur = String(curVal == null ? '' : curVal).trim().toLowerCase();
    var grid = document.createElement('div'); grid.className = 'swGrid';
    names.forEach(function (name) {
      var hex = colorByName[name.toLowerCase()];
      var cell = document.createElement('span'); cell.className = 'swCell' + (cur === name.toLowerCase() ? ' sel' : '');
      if (hex && name.toLowerCase() !== 'transparent') cell.style.background = hex; else cell.classList.add('none');
      cell.title = name;
      cell.addEventListener('click', function () { onPick(name); });
      grid.appendChild(cell);
    });
    container.appendChild(grid);
  }
  function colorSwatchList(container, swatches, curVal, onPick) {
    var cur = String(curVal == null ? '' : curVal).trim().toLowerCase();
    var list = document.createElement('div'); list.className = 'swList';
    (swatches || []).forEach(function (c) {
      var row = document.createElement('div'); row.className = 'swRow' + (cur === String(c.name).toLowerCase() ? ' sel' : '');
      var s = document.createElement('span'); s.className = 'swatch';
      if (String(c.name).toLowerCase() === 'transparent') s.classList.add('none'); else s.style.background = '#' + c.argb;
      var lbl = document.createElement('span'); lbl.className = 'swName'; lbl.textContent = c.name;
      row.appendChild(s); row.appendChild(lbl);
      row.addEventListener('click', function () { onPick(c.name); });
      list.appendChild(row);
    });
    container.appendChild(list);
  }
  function openColorPopup(anchor, curVal, onCommit) {
    openPopup(anchor, function (pop) {
      pop.classList.add('colorPop');
      var tabs = document.createElement('div'); tabs.className = 'popTabs';
      var body = document.createElement('div'); body.className = 'popBody';
      var which = 'custom';
      function pick(name) { closePopup(); onCommit(name); }
      function render() {
        body.innerHTML = '';
        if (which === 'custom') colorSwatchGrid(body, CUSTOM_COLORS, curVal, pick);
        else if (which === 'web') colorSwatchList(body, palette && palette.webColors, curVal, pick);
        else colorSwatchList(body, palette && palette.systemColors, curVal, pick);
        Array.prototype.forEach.call(tabs.children, function (t) { t.className = 'popTab' + (t.getAttribute('data-k') === which ? ' active' : ''); });
      }
      [['custom', T('panel.color.tab.custom')], ['web', T('panel.color.tab.web')], ['system', T('panel.color.tab.system')]].forEach(function (t) {
        var b = document.createElement('span'); b.className = 'popTab'; b.setAttribute('data-k', t[0]); b.textContent = t[1];
        b.addEventListener('click', function () { which = t[0]; render(); });
        tabs.appendChild(b);
      });
      pop.appendChild(tabs); pop.appendChild(body);
      render();
    });
  }

  // ---- Font editor: expandable sub-rows (Name/Size/Unit/Bold/Italic/Underline/Strikeout) that compose the
  // FontConverter invariant string ("Segoe UI, 9pt, style=Bold, Italic"), which the engine's convertValue turns
  // into new Font(...). Unit suffixes come from the palette (authoritative, not hardcoded). ----
  function parseFont(value) {
    var out = { name: '', size: '', unit: 'Point', styles: {} };
    if (value == null || String(value).trim() === '') return out;
    var v = String(value);
    var firstComma = v.indexOf(',');
    if (firstComma < 0) { out.name = v.trim(); return out; }
    out.name = v.slice(0, firstComma).trim();
    var rest = v.slice(firstComma + 1);
    var sizePart = rest;
    var si = rest.indexOf('style=');
    if (si >= 0) {
      rest.slice(si + 6).split(',').forEach(function (s) { var k = s.trim(); if (k && k !== 'Regular') out.styles[k] = true; });
      sizePart = rest.slice(0, si).replace(/,\s*$/, '');
    }
    var m = /^([0-9.]+)\s*(.*)$/.exec(sizePart.trim());
    if (m) { out.size = m[1]; out.unit = unitBySuffix[m[2].trim()] || 'Point'; }
    return out;
  }
  function composeFont(f) {
    var suffix = unitByName[f.unit] || 'pt';
    var s = (f.name || '') + ', ' + (f.size || '') + suffix;
    var styleList = ['Bold', 'Italic', 'Underline', 'Strikeout'].filter(function (k) { return f.styles[k]; });
    if (styleList.length) s += ', style=' + styleList.join(', ');
    return s;
  }
  function fontSubRows(c, p, t) {
    var f = parseFont(p.value);
    var fams = (palette && palette.fontFamilies) || [];
    var unitNames = ((palette && palette.fontUnits) || []).map(function (u) { return u.name; });
    if (!unitNames.length) unitNames = ['Point'];
    // commit only a COMPLETE, valid font: a non-empty family AND a numeric size. This prevents a size-less
    // ("Name, pt") or family-less (", 9pt") string — both of which FontConverter silently DEFAULTS rather
    // than rejects (→ would drop the size to 8.25pt or rewrite the family). Normalize a comma decimal
    // ("9,75" → "9.75") so comma-locale users can type sizes; the invariant string needs a '.' separator.
    function commitFont() {
      var name = (f.name || '').trim();
      var size = (f.size || '').trim().replace(',', '.');
      if (!name || !/^[0-9]+(\.[0-9]+)?$/.test(size)) return; // incomplete/invalid → leave the value unchanged
      sendEdit(c.id, p, composeFont({ name: name, size: size, unit: f.unit, styles: f.styles }));
    }
    t.appendChild(subComboRow(T('panel.font.name'), f.name, fams, function (v) { f.name = v; commitFont(); }));
    t.appendChild(subRow(T('panel.font.size'), f.size, function (v) { f.size = v; commitFont(); }));
    t.appendChild(subSelectRow(T('panel.font.unit'), f.unit, unitNames, function (v) { f.unit = v; commitFont(); }));
    ['Bold', 'Italic', 'Underline', 'Strikeout'].forEach(function (st) {
      t.appendChild(subSelectRow(st, f.styles[st] ? 'True' : 'False', ['True', 'False'], function (v) {
        f.styles[st] = (v === 'True'); commitFont();
      }));
    });
  }

  // ---- Flags-enum editor (generic [Flags] enums other than Anchor, which keeps its glyph editor): a read-only
  // summary + a dropdown of member checkboxes. Composes "Top, Left"; empty → the enum's zero member (usually
  // "None"). The popup stays open across toggles (it lives on <body>, surviving the grid re-render). ----
  function parseFlagSet(value) {
    var set = {};
    String(value == null ? '' : value).split(',').forEach(function (s) { var k = s.trim(); if (k) set[k] = true; });
    return set;
  }
  function flagsEditor(p, value, onCommit) {
    var wrap = document.createElement('div'); wrap.className = 'flagsEd';
    var inp = document.createElement('input'); inp.className = 'flagsInp'; inp.value = value == null ? '' : value; inp.readOnly = true;
    inp.title = T('panel.flags.inputTip');
    wrap.appendChild(inp);
    wrap.appendChild(ddButton(T('panel.flags.toggleTip'), function (btn) { openFlagsPopup(btn, p, value, onCommit); }));
    return wrap;
  }
  function openFlagsPopup(anchor, p, value, onCommit) {
    var members = p.flagsMembers || [];
    var set = parseFlagSet(value);
    openPopup(anchor, function (pop) {
      pop.classList.add('flagsPop');
      members.forEach(function (name) {
        var row = document.createElement('label'); row.className = 'flagRow';
        var cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !!set[name];
        var lbl = document.createElement('span'); lbl.textContent = name;
        cb.addEventListener('change', function () {
          set[name] = cb.checked;
          var chosen = members.filter(function (mm) { return set[mm]; });
          if (chosen.length) { onCommit(chosen.join(', ')); return; }
          // all unchecked → commit the zero member. If the enum has none (rare — most flags define None=0),
          // we can't represent "cleared" as a member name without emitting an invalid Type.None, so leave the
          // value unchanged rather than corrupt the source. Re-check the box to reflect that.
          if (p.flagsZero) { onCommit(p.flagsZero); return; }
          cb.checked = true; set[name] = true;
        });
        row.appendChild(cb); row.appendChild(lbl); pop.appendChild(row);
      });
    });
  }

  // ---- Image/Icon editor (Slice 2/5): a preview swatch + "Import…" (host opens a file picker → embeds the
  // image into the form's sibling .resx and writes the resources.GetObject assignment) + "(none)" (clears the
  // assignment via ResetProperty). The value isn't a literal, so there's no text field — engine sets p.isImage
  // and p.imagePreview (a base64 thumbnail of the current value, or null when unset). ----
  function imageEditor(c, p) {
    var wrap = document.createElement('div'); wrap.className = 'imageEd';
    var sw = document.createElement('span'); sw.className = 'imgSwatch' + (p.imagePreview ? '' : ' none');
    if (p.imagePreview) {
      var img = document.createElement('img'); img.className = 'imgThumb'; img.alt = ''; img.draggable = false;
      img.src = 'data:image/png;base64,' + p.imagePreview;
      sw.appendChild(img);
    }
    sw.title = p.type;
    wrap.appendChild(sw);
    var lbl = document.createElement('span'); lbl.className = 'imgLabel';
    lbl.textContent = p.imagePreview ? shortType(p.type) : T('common.none');
    wrap.appendChild(lbl);
    if (!p.readOnly) {
      var imp = document.createElement('button'); imp.type = 'button'; imp.className = 'imgBtn'; imp.textContent = T('panel.image.import');
      imp.title = T('panel.image.importTip');
      imp.addEventListener('click', function () { vscode.postMessage({ type: 'importImage', id: c.id, prop: p.name, propType: p.type }); });
      wrap.appendChild(imp);
      // "(none)" clears an image that is actually set in the source (has a preview or an explicit assignment).
      if (p.imagePreview || p.sourceExplicit) {
        var clr = document.createElement('button'); clr.type = 'button'; clr.className = 'imgBtn'; clr.textContent = T('common.none');
        clr.title = T('panel.image.clearTip');
        clr.addEventListener('click', function () { vscode.postMessage({ type: 'clearImage', id: c.id, prop: p.name }); });
        wrap.appendChild(clr);
      }
    }
    return wrap;
  }

  // ---- String Collection editor (VS "String Collection Editor"): a "(Collection)" label + a "…" button that
  // asks the host for the current items (ListCollectionItems parses the unsaved buffer), then opens a popup with
  // a one-item-per-line textarea. OK rewrites the owner's Add/AddRange calls via SetCollectionItems. A non-literal
  // (bound/complex) collection comes back ok:false → the popup shows a read-only note so items can't be dropped. ----
  var COLUMN_ITEM_TYPE = 'System.Windows.Forms.ColumnHeader';
  var GRIDCOLUMN_ITEM_TYPE = 'System.Windows.Forms.DataGridViewColumn';
  var TREENODE_ITEM_TYPE = 'System.Windows.Forms.TreeNode';
  var TOOLSTRIP_ITEM_TYPE = 'System.Windows.Forms.ToolStripItem';
  // Item types the "Type Here" picker offers for a NEW item, curated by the owner strip's kind (VS shows a
  // context-appropriate subset). The engine's `ItemTypeFqns` allowlist accepts every one of these; the FIRST entry is
  // the default for a fresh item. Existing items keep their concrete type (changing it would risk losing type-specific
  // properties), so the picker is offered on new rows only.
  function toolStripNewTypes(ownerType) {
    var t = ownerType || '';
    if (t.indexOf('StatusStrip') >= 0) return [['ToolStripStatusLabel', 'Status Label'], ['ToolStripProgressBar', 'Progress Bar'], ['ToolStripDropDownButton', 'DropDown Button'], ['ToolStripSplitButton', 'Split Button'], ['ToolStripSeparator', 'Separator']];
    if (t.indexOf('MenuStrip') >= 0) return [['ToolStripMenuItem', 'Menu Item'], ['ToolStripComboBox', 'ComboBox'], ['ToolStripTextBox', 'TextBox'], ['ToolStripSeparator', 'Separator']];
    return [['ToolStripButton', 'Button'], ['ToolStripLabel', 'Label'], ['ToolStripSeparator', 'Separator'], ['ToolStripSplitButton', 'Split Button'], ['ToolStripDropDownButton', 'DropDown Button'], ['ToolStripComboBox', 'ComboBox'], ['ToolStripTextBox', 'TextBox'], ['ToolStripProgressBar', 'Progress Bar']];
  }
  var STRINGARRAY_ITEM_TYPE = 'System.String[]'; // sentinel for a generic string[] property (TextBox/RichTextBox.Lines)
  var pendingCollection = null; // { id, prop, anchor } awaiting the host's collectionItems reply
  var pendingColumns = null;    // { id, anchor } awaiting the host's columnItems reply
  var pendingGridColumns = null; // { id, anchor } awaiting the host's gridColumnItems reply
  var pendingTreeNodes = null;  // { id, anchor } awaiting the host's treeNodeItems reply
  var pendingToolStrip = null;  // { id, anchor, ownerType } awaiting the host's toolStripItems reply
  var pendingStringArray = null; // { id, prop, anchor } awaiting the host's stringArrayItems reply
  function collectionEditor(c, p) {
    var wrap = document.createElement('div'); wrap.className = 'collectionEd';
    var lbl = document.createElement('span'); lbl.className = 'collectionLabel'; lbl.textContent = '(Collection)';
    lbl.title = p.type;
    wrap.appendChild(lbl);
    var btn = document.createElement('button'); btn.type = 'button'; btn.className = 'collectionBtn'; btn.textContent = '…';
    btn.title = 'Edit items…';
    btn.addEventListener('click', function () {
      pendingCollection = { id: c.id, prop: p.name, anchor: btn };
      vscode.postMessage({ type: 'listCollection', id: c.id, prop: p.name });
    });
    wrap.appendChild(btn);
    return wrap;
  }
  // Generic string[] property editor (TextBox/RichTextBox.Lines): same one-item-per-line popup as the string
  // collection, but the value is a single `= new string[]{…}` assignment — routed via the stringArray RPCs.
  function stringArrayEditor(c, p) {
    var wrap = document.createElement('div'); wrap.className = 'collectionEd';
    var lbl = document.createElement('span'); lbl.className = 'collectionLabel'; lbl.textContent = '(Collection)';
    lbl.title = p.type;
    wrap.appendChild(lbl);
    var btn = document.createElement('button'); btn.type = 'button'; btn.className = 'collectionBtn'; btn.textContent = '…';
    btn.title = 'Edit items…';
    btn.addEventListener('click', function () {
      pendingStringArray = { id: c.id, prop: p.name, anchor: btn };
      vscode.postMessage({ type: 'listStringArray', id: c.id, prop: p.name });
    });
    wrap.appendChild(btn);
    return wrap;
  }
  function openCollectionPopup(anchor, id, prop, ok, items, reason, msgType) {
    var commitType = msgType || 'setCollection';
    openPopup(anchor, function (pop) {
      pop.classList.add('collectionPop');
      var title = document.createElement('div'); title.className = 'collectionTitle'; title.textContent = prop; pop.appendChild(title);
      if (!ok) {
        var note = document.createElement('div'); note.className = 'collectionNote';
        note.textContent = 'This collection can’t be edited here (' + (reason || 'non-literal items') + ').';
        pop.appendChild(note);
        return;
      }
      var ta = document.createElement('textarea'); ta.className = 'collectionTa'; ta.spellcheck = false;
      var original = (items || []).join('\n');
      ta.value = original;
      ta.rows = Math.min(14, Math.max(4, (items || []).length + 2));
      ta.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape') { ev.stopPropagation(); closePopup(); }
        else if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); commit(); }
      });
      pop.appendChild(ta);
      var bar = document.createElement('div'); bar.className = 'collectionBar';
      var okBtn = document.createElement('button'); okBtn.type = 'button'; okBtn.className = 'collectionOk'; okBtn.textContent = 'OK';
      var cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel';
      function commit() {
        closePopup();
        // unchanged textarea → don't post an edit at all: preserves any pre-existing trailing empty items (a trailing
        // "" is indistinguishable from the editor-convenience newline once joined) and avoids a spurious dirty/undo.
        if (ta.value === original) return;
        var lines = ta.value.split(/\r?\n/);
        // For a string[] property (Lines), a trailing blank line is MEANINGFUL content (a trailing newline that the
        // engine round-trips), so keep it. For a string-item collection (.Items) a trailing blank is just the
        // editor-convenience newline → drop it.
        if (commitType !== 'setStringArray') {
          while (lines.length && lines[lines.length - 1] === '') lines.pop();
        }
        vscode.postMessage({ type: commitType, id: id, prop: prop, items: lines });
      }
      okBtn.addEventListener('click', commit);
      cancel.addEventListener('click', function () { closePopup(); });
      bar.appendChild(okBtn); bar.appendChild(cancel);
      pop.appendChild(bar);
      setTimeout(function () { ta.focus(); }, 0);
    });
  }

  // Typed collection editor (VS "Collection Editor") for ListView.Columns — the "…" opens a small grid of
  // columns (Text / Width / Align) with add / remove / reorder, committed atomically on OK.
  function columnsEditor(c, p) {
    var wrap = document.createElement('div'); wrap.className = 'collectionEd';
    var lbl = document.createElement('span'); lbl.className = 'collectionLabel'; lbl.textContent = '(Collection)';
    lbl.title = p.type;
    wrap.appendChild(lbl);
    var btn = document.createElement('button'); btn.type = 'button'; btn.className = 'collectionBtn'; btn.textContent = '…';
    btn.title = 'Edit columns…';
    btn.addEventListener('click', function () {
      pendingColumns = { id: c.id, anchor: btn };
      vscode.postMessage({ type: 'listColumns', id: c.id });
    });
    wrap.appendChild(btn);
    return wrap;
  }
  var ALIGNS = ['Left', 'Center', 'Right'];
  function openColumnsPopup(anchor, id, ok, columns, reason) {
    openPopup(anchor, function (pop) {
      pop.classList.add('collectionPop'); pop.classList.add('columnsPop');
      var title = document.createElement('div'); title.className = 'collectionTitle'; title.textContent = 'Columns'; pop.appendChild(title);
      if (!ok) {
        var note = document.createElement('div'); note.className = 'collectionNote';
        note.textContent = 'This collection can’t be edited here (' + (reason || 'unsupported column') + ').';
        pop.appendChild(note);
        return;
      }
      // working copy of the columns; `id` empty marks a new column the engine will name on commit
      var rows = (columns || []).map(function (col) {
        return { id: col.id || '', text: col.text || '', width: (typeof col.width === 'number' ? col.width : 60), textAlign: col.textAlign || 'Left' };
      });
      var original = JSON.stringify(rows);

      var list = document.createElement('div'); list.className = 'columnsList';
      pop.appendChild(list);
      function render() {
        list.textContent = '';
        if (!rows.length) {
          var empty = document.createElement('div'); empty.className = 'columnsEmpty'; empty.textContent = '(no columns)';
          list.appendChild(empty);
        }
        rows.forEach(function (row, i) {
          var r = document.createElement('div'); r.className = 'columnsRow';
          var up = document.createElement('button'); up.type = 'button'; up.className = 'colMini'; up.textContent = '↑'; up.title = 'Move up'; up.disabled = i === 0;
          up.addEventListener('click', function () { var t2 = rows[i - 1]; rows[i - 1] = rows[i]; rows[i] = t2; render(); });
          var down = document.createElement('button'); down.type = 'button'; down.className = 'colMini'; down.textContent = '↓'; down.title = 'Move down'; down.disabled = i === rows.length - 1;
          down.addEventListener('click', function () { var t2 = rows[i + 1]; rows[i + 1] = rows[i]; rows[i] = t2; render(); });
          var txt = document.createElement('input'); txt.type = 'text'; txt.className = 'colText'; txt.value = row.text; txt.placeholder = 'Header text';
          txt.addEventListener('input', function () { row.text = txt.value; });
          var w = document.createElement('input'); w.type = 'number'; w.className = 'colWidth'; w.value = String(row.width); w.title = 'Width (px; -1 = size to content, -2 = size to header)';
          // only commit a valid number — an empty/half-typed field keeps the column's current width (don't silently reset to 60)
          w.addEventListener('input', function () { var n = parseInt(w.value, 10); if (!isNaN(n)) row.width = n; });
          var al = document.createElement('select'); al.className = 'colAlign'; al.title = 'Text alignment';
          ALIGNS.forEach(function (a) { var o = document.createElement('option'); o.value = a; o.textContent = a; if (a === row.textAlign) o.selected = true; al.appendChild(o); });
          al.addEventListener('change', function () { row.textAlign = al.value; });
          var del = document.createElement('button'); del.type = 'button'; del.className = 'colMini colDel'; del.textContent = '✕'; del.title = 'Remove column';
          del.addEventListener('click', function () { rows.splice(i, 1); render(); });
          r.appendChild(up); r.appendChild(down); r.appendChild(txt); r.appendChild(w); r.appendChild(al); r.appendChild(del);
          list.appendChild(r);
        });
      }
      render();

      var addBtn = document.createElement('button'); addBtn.type = 'button'; addBtn.className = 'columnsAdd'; addBtn.textContent = '+ Add column';
      addBtn.addEventListener('click', function () { rows.push({ id: '', text: '', width: 60, textAlign: 'Left' }); render(); });
      pop.appendChild(addBtn);

      var bar = document.createElement('div'); bar.className = 'collectionBar';
      var okBtn = document.createElement('button'); okBtn.type = 'button'; okBtn.className = 'collectionOk'; okBtn.textContent = 'OK';
      var cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel';
      function commit() {
        closePopup();
        if (JSON.stringify(rows) === original) return; // unchanged → no edit (avoids a spurious dirty/undo)
        var cols = rows.map(function (row) {
          return { id: row.id || '', text: row.text || '', width: (typeof row.width === 'number' && !isNaN(row.width)) ? row.width : 60, textAlign: row.textAlign || 'Left' };
        });
        vscode.postMessage({ type: 'setColumns', id: id, columns: cols });
      }
      okBtn.addEventListener('click', commit);
      cancel.addEventListener('click', function () { closePopup(); });
      bar.appendChild(okBtn); bar.appendChild(cancel);
      pop.appendChild(bar);
    });
  }

  // Typed collection editor for DataGridView.Columns — a grid of columns (Header / Width / ReadOnly / Visible)
  // with add / remove / reorder, committed atomically on OK.
  function gridColumnsEditor(c, p) {
    var wrap = document.createElement('div'); wrap.className = 'collectionEd';
    var lbl = document.createElement('span'); lbl.className = 'collectionLabel'; lbl.textContent = '(Collection)';
    lbl.title = p.type;
    wrap.appendChild(lbl);
    var btn = document.createElement('button'); btn.type = 'button'; btn.className = 'collectionBtn'; btn.textContent = '…';
    btn.title = 'Edit columns…';
    btn.addEventListener('click', function () {
      pendingGridColumns = { id: c.id, anchor: btn };
      vscode.postMessage({ type: 'listGridColumns', id: c.id });
    });
    wrap.appendChild(btn);
    return wrap;
  }
  function openGridColumnsPopup(anchor, id, ok, columns, reason) {
    openPopup(anchor, function (pop) {
      pop.classList.add('collectionPop'); pop.classList.add('columnsPop'); pop.classList.add('gridColumnsPop');
      var title = document.createElement('div'); title.className = 'collectionTitle'; title.textContent = 'Columns'; pop.appendChild(title);
      if (!ok) {
        var note = document.createElement('div'); note.className = 'collectionNote';
        note.textContent = 'This collection can’t be edited here (' + (reason || 'unsupported column') + ').';
        pop.appendChild(note);
        return;
      }
      var rows = (columns || []).map(function (col) {
        return { id: col.id || '', headerText: col.headerText || '', width: (typeof col.width === 'number' ? col.width : 100),
          readOnly: !!col.readOnly, visible: col.visible !== false };
      });
      var original = JSON.stringify(rows);

      var list = document.createElement('div'); list.className = 'columnsList';
      pop.appendChild(list);
      function render() {
        list.textContent = '';
        if (!rows.length) {
          var empty = document.createElement('div'); empty.className = 'columnsEmpty'; empty.textContent = '(no columns)';
          list.appendChild(empty);
        }
        rows.forEach(function (row, i) {
          var r = document.createElement('div'); r.className = 'columnsRow';
          var up = document.createElement('button'); up.type = 'button'; up.className = 'colMini'; up.textContent = '↑'; up.title = 'Move up'; up.disabled = i === 0;
          up.addEventListener('click', function () { var t2 = rows[i - 1]; rows[i - 1] = rows[i]; rows[i] = t2; render(); });
          var down = document.createElement('button'); down.type = 'button'; down.className = 'colMini'; down.textContent = '↓'; down.title = 'Move down'; down.disabled = i === rows.length - 1;
          down.addEventListener('click', function () { var t2 = rows[i + 1]; rows[i + 1] = rows[i]; rows[i] = t2; render(); });
          var txt = document.createElement('input'); txt.type = 'text'; txt.className = 'colText'; txt.value = row.headerText; txt.placeholder = 'Header text';
          txt.addEventListener('input', function () { row.headerText = txt.value; });
          var w = document.createElement('input'); w.type = 'number'; w.className = 'colWidth'; w.value = String(row.width); w.title = 'Width (px)';
          w.addEventListener('input', function () { var n = parseInt(w.value, 10); if (!isNaN(n)) row.width = n; });
          var ro = document.createElement('input'); ro.type = 'checkbox'; ro.className = 'colChk'; ro.checked = row.readOnly; ro.title = 'ReadOnly';
          ro.addEventListener('change', function () { row.readOnly = ro.checked; });
          var vis = document.createElement('input'); vis.type = 'checkbox'; vis.className = 'colChk'; vis.checked = row.visible; vis.title = 'Visible';
          vis.addEventListener('change', function () { row.visible = vis.checked; });
          var del = document.createElement('button'); del.type = 'button'; del.className = 'colMini colDel'; del.textContent = '✕'; del.title = 'Remove column';
          del.addEventListener('click', function () { rows.splice(i, 1); render(); });
          var roLbl = document.createElement('label'); roLbl.className = 'colChkLbl'; roLbl.appendChild(ro); roLbl.appendChild(document.createTextNode('RO'));
          var visLbl = document.createElement('label'); visLbl.className = 'colChkLbl'; visLbl.appendChild(vis); visLbl.appendChild(document.createTextNode('Vis'));
          r.appendChild(up); r.appendChild(down); r.appendChild(txt); r.appendChild(w); r.appendChild(roLbl); r.appendChild(visLbl); r.appendChild(del);
          list.appendChild(r);
        });
      }
      render();

      var addBtn = document.createElement('button'); addBtn.type = 'button'; addBtn.className = 'columnsAdd'; addBtn.textContent = '+ Add column';
      addBtn.addEventListener('click', function () { rows.push({ id: '', headerText: '', width: 100, readOnly: false, visible: true }); render(); });
      pop.appendChild(addBtn);

      var bar = document.createElement('div'); bar.className = 'collectionBar';
      var okBtn = document.createElement('button'); okBtn.type = 'button'; okBtn.className = 'collectionOk'; okBtn.textContent = 'OK';
      var cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel';
      function commit() {
        closePopup();
        if (JSON.stringify(rows) === original) return; // unchanged → no edit
        var cols = rows.map(function (row) {
          return { id: row.id || '', headerText: row.headerText || '', width: (typeof row.width === 'number' && !isNaN(row.width)) ? row.width : 100,
            readOnly: !!row.readOnly, visible: row.visible !== false };
        });
        vscode.postMessage({ type: 'setGridColumns', id: id, gridColumns: cols });
      }
      okBtn.addEventListener('click', commit);
      cancel.addEventListener('click', function () { closePopup(); });
      bar.appendChild(okBtn); bar.appendChild(cancel);
      pop.appendChild(bar);
    });
  }

  // ---- TreeView.Nodes: recursive hierarchical editor (VS "TreeNode Editor"). Nodes serialize as local vars, so a
  // node's Id is its generated local name (empty = NEW); only Text (label) + Name (key) round-trip. ----
  function treeNodesEditor(c, p) {
    var wrap = document.createElement('div'); wrap.className = 'collectionEd';
    var lbl = document.createElement('span'); lbl.className = 'collectionLabel'; lbl.textContent = '(Collection)';
    lbl.title = p.type;
    wrap.appendChild(lbl);
    var btn = document.createElement('button'); btn.type = 'button'; btn.className = 'collectionBtn'; btn.textContent = '…';
    btn.title = 'Edit nodes…';
    btn.addEventListener('click', function () {
      pendingTreeNodes = { id: c.id, anchor: btn };
      vscode.postMessage({ type: 'listTreeNodes', id: c.id });
    });
    wrap.appendChild(btn);
    return wrap;
  }
  var _tnKey = 0;
  function openTreeNodesPopup(anchor, id, ok, nodes, reason) {
    openPopup(anchor, function (pop) {
      pop.classList.add('collectionPop'); pop.classList.add('treeNodesPop');
      var title = document.createElement('div'); title.className = 'collectionTitle'; title.textContent = 'TreeNodes'; pop.appendChild(title);
      if (!ok) {
        var note = document.createElement('div'); note.className = 'collectionNote';
        note.textContent = 'This collection can’t be edited here (' + (reason || 'unsupported node') + ').';
        pop.appendChild(note);
        return;
      }
      // working copy of the forest; an empty id marks a NEW node the engine names on commit. `_k` is an ephemeral
      // key for the expand/collapse state only — it is stripped before sending.
      // every modelled field rides through clone/strip/fresh so an edit through the popup preserves it (strip feeds
      // BOTH the transmitted payload AND the change-detection baseline — omitting a field would silently drop an
      // edit that only touched it).
      function ii(n) { return (n == null ? -1 : n); }
      function clone(n) { return { _k: ++_tnKey, id: n.id || '', text: n.text || '', name: n.name || '', imageKey: n.imageKey || '', imageIndex: ii(n.imageIndex), selectedImageKey: n.selectedImageKey || '', selectedImageIndex: ii(n.selectedImageIndex), toolTipText: n.toolTipText || '', checked: !!n.checked, foreColor: n.foreColor || '', backColor: n.backColor || '', nodeFont: n.nodeFont || '', children: (n.children || []).map(clone) }; }
      function strip(a) { return a.map(function (n) { return { id: n.id || '', text: n.text || '', name: n.name || '', imageKey: n.imageKey || '', imageIndex: ii(n.imageIndex), selectedImageKey: n.selectedImageKey || '', selectedImageIndex: ii(n.selectedImageIndex), toolTipText: n.toolTipText || '', checked: !!n.checked, foreColor: n.foreColor || '', backColor: n.backColor || '', nodeFont: n.nodeFont || '', children: strip(n.children) }; }); }
      function fresh() { return { _k: ++_tnKey, id: '', text: '', name: '', imageKey: '', imageIndex: -1, selectedImageKey: '', selectedImageIndex: -1, toolTipText: '', checked: false, foreColor: '', backColor: '', nodeFont: '', children: [] }; }
      var roots = (nodes || []).map(clone);
      var original = JSON.stringify(strip(roots));
      var expanded = {};
      (function expandAll(a) { a.forEach(function (n) { if (n.children.length) { expanded[n._k] = true; expandAll(n.children); } }); })(roots);
      // per-node "style" sub-row (ForeColor/BackColor/NodeFont) open-state; auto-open a node that already carries a style.
      var styleOpen = {};
      (function autoStyle(a) { a.forEach(function (n) { if (n.foreColor || n.backColor || n.nodeFont) styleOpen[n._k] = true; autoStyle(n.children); }); })(roots);

      var listEl = document.createElement('div'); listEl.className = 'columnsList treeNodesList';
      pop.appendChild(listEl);
      function mini(glyph, ttl, disabled, fn) {
        var b = document.createElement('button'); b.type = 'button'; b.className = 'colMini'; b.textContent = glyph; b.title = ttl;
        if (disabled) b.disabled = true; else b.addEventListener('click', fn);
        return b;
      }
      function rowEl(node, i, depth, arr, parentNode, parentList) {
        var r = document.createElement('div'); r.className = 'columnsRow treeNodeRow'; r.style.marginLeft = (depth * 14) + 'px';
        var hasKids = node.children.length > 0;
        var tw = document.createElement('span'); tw.textContent = hasKids ? (expanded[node._k] ? '▾' : '▸') : '·';
        tw.style.cssText = 'display:inline-block;width:1.1em;text-align:center;opacity:' + (hasKids ? '1' : '.3') + ';cursor:' + (hasKids ? 'pointer' : 'default');
        if (hasKids) tw.addEventListener('click', function () { if (expanded[node._k]) delete expanded[node._k]; else expanded[node._k] = true; render(); });
        var txt = document.createElement('input'); txt.type = 'text'; txt.className = 'colText'; txt.value = node.text; txt.placeholder = 'Node text';
        txt.addEventListener('input', function () { node.text = txt.value; });
        var nm = document.createElement('input'); nm.type = 'text'; nm.className = 'colText'; nm.value = node.name; nm.placeholder = '(name)'; nm.style.maxWidth = '6em';
        nm.addEventListener('input', function () { node.name = nm.value; });
        // MVP image editors: ImageKey (text, matches a TreeView.ImageList key) + ImageIndex (number; empty = -1 = none).
        // No thumbnail dropdown yet (no ImageList-image source RPC).
        var imgKey = document.createElement('input'); imgKey.type = 'text'; imgKey.className = 'colText'; imgKey.value = node.imageKey || ''; imgKey.placeholder = '(img key)'; imgKey.style.maxWidth = '6em'; imgKey.title = 'ImageKey — a key in the TreeView.ImageList';
        var imgIdx = document.createElement('input'); imgIdx.type = 'number'; imgIdx.min = '0'; imgIdx.className = 'colText'; imgIdx.value = (node.imageIndex != null && node.imageIndex >= 0) ? String(node.imageIndex) : ''; imgIdx.placeholder = '#'; imgIdx.style.maxWidth = '3.5em'; imgIdx.title = 'ImageIndex — index into the TreeView.ImageList (empty = none)';
        // ImageKey and ImageIndex are mutually exclusive (as in the VS property grid): setting one clears the other so
        // the committed node carries a single effective image. The engine emits key-preferred and net48 applies
        // key-first; a both-set node would let the index silently shadow a just-typed key. A negative index is 'no
        // image' (min=0 blocks the spinner; the parseInt guard also rejects a hand-typed negative).
        imgKey.addEventListener('input', function () { node.imageKey = imgKey.value; if (imgKey.value) { node.imageIndex = -1; imgIdx.value = ''; } });
        imgIdx.addEventListener('input', function () { var v = parseInt(imgIdx.value, 10); node.imageIndex = (isNaN(v) || v < 0) ? -1 : v; if (node.imageIndex >= 0) { node.imageKey = ''; imgKey.value = ''; } });
        // SelectedImageKey / SelectedImageIndex — the glyph shown while the node is selected; same mutually-exclusive
        // pair semantics as ImageKey/ImageIndex above.
        var selKey = document.createElement('input'); selKey.type = 'text'; selKey.className = 'colText'; selKey.value = node.selectedImageKey || ''; selKey.placeholder = '(sel key)'; selKey.style.maxWidth = '6em'; selKey.title = 'SelectedImageKey — ImageList key shown while the node is selected';
        var selIdx = document.createElement('input'); selIdx.type = 'number'; selIdx.min = '0'; selIdx.className = 'colText'; selIdx.value = (node.selectedImageIndex != null && node.selectedImageIndex >= 0) ? String(node.selectedImageIndex) : ''; selIdx.placeholder = '#'; selIdx.style.maxWidth = '3.5em'; selIdx.title = 'SelectedImageIndex — ImageList index shown while the node is selected (empty = none)';
        selKey.addEventListener('input', function () { node.selectedImageKey = selKey.value; if (selKey.value) { node.selectedImageIndex = -1; selIdx.value = ''; } });
        selIdx.addEventListener('input', function () { var v = parseInt(selIdx.value, 10); node.selectedImageIndex = (isNaN(v) || v < 0) ? -1 : v; if (node.selectedImageIndex >= 0) { node.selectedImageKey = ''; selKey.value = ''; } });
        // ToolTipText (hover tooltip) + Checked (the node check-box state, visible when TreeView.CheckBoxes is on).
        var tip = document.createElement('input'); tip.type = 'text'; tip.className = 'colText'; tip.value = node.toolTipText || ''; tip.placeholder = '(tooltip)'; tip.style.maxWidth = '6em'; tip.title = 'ToolTipText — the hover tooltip';
        tip.addEventListener('input', function () { node.toolTipText = tip.value; });
        var chkWrap = document.createElement('label'); chkWrap.className = 'colText'; chkWrap.style.maxWidth = '2.5em'; chkWrap.title = 'Checked — the node check-box state (visible when TreeView.CheckBoxes is on)';
        var chk = document.createElement('input'); chk.type = 'checkbox'; chk.checked = !!node.checked;
        chk.addEventListener('change', function () { node.checked = chk.checked; });
        chkWrap.appendChild(chk);
        var addChild = mini('＋', 'Add child', false, function () { node.children.push(fresh()); expanded[node._k] = true; render(); });
        var addSib = mini('＋⇢', 'Add sibling', false, function () { arr.splice(i + 1, 0, fresh()); render(); });
        var indent = mini('»', 'Indent (make child of the node above)', i === 0, function () { var prev = arr[i - 1]; arr.splice(i, 1); prev.children.push(node); expanded[prev._k] = true; render(); });
        var outdent = mini('«', 'Outdent (move up one level)', !parentNode, function () { var pidx = parentList.indexOf(parentNode); arr.splice(i, 1); parentList.splice(pidx + 1, 0, node); render(); });
        var up = mini('↑', 'Move up', i === 0, function () { var t2 = arr[i - 1]; arr[i - 1] = arr[i]; arr[i] = t2; render(); });
        var down = mini('↓', 'Move down', i === arr.length - 1, function () { var t2 = arr[i + 1]; arr[i + 1] = arr[i]; arr[i] = t2; render(); });
        var del = mini('✕', 'Remove node (and its children)', false, function () { arr.splice(i, 1); render(); }); del.classList.add('colDel');
        // toggle a per-node style sub-row (ForeColor / BackColor / NodeFont) — kept off the main row so it stays compact.
        var styleTgl = mini('🎨', 'Node style — fore/back colour, font', false, function () { if (styleOpen[node._k]) delete styleOpen[node._k]; else styleOpen[node._k] = true; render(); });
        if (styleOpen[node._k]) styleTgl.classList.add('sel');
        r.appendChild(tw); r.appendChild(txt); r.appendChild(nm); r.appendChild(imgKey); r.appendChild(imgIdx);
        r.appendChild(selKey); r.appendChild(selIdx); r.appendChild(tip); r.appendChild(chkWrap);
        r.appendChild(addChild); r.appendChild(addSib); r.appendChild(indent); r.appendChild(outdent); r.appendChild(up); r.appendChild(down); r.appendChild(styleTgl); r.appendChild(del);
        return r;
      }
      // A colour field: a live swatch + a free-text invariant input ("Red" / "64, 128, 255" / "Control"). No dropdown
      // picker here — the tree-nodes popup is itself a singleton popup, so opening the colour palette popup would close
      // it. The engine turns the invariant into Color.Red / Color.FromArgb(...) via the same converter the grid uses.
      function styleColorField(label, get, set) {
        var wrap = document.createElement('span'); wrap.style.cssText = 'display:inline-flex;align-items:center;gap:3px;margin-right:8px';
        var lab = document.createElement('span'); lab.textContent = label; lab.style.cssText = 'font-size:.85em;opacity:.7';
        var sw = swatchSpan(colorToHex(get()));
        var inp = document.createElement('input'); inp.type = 'text'; inp.className = 'colText'; inp.style.maxWidth = '7em';
        inp.value = get(); inp.placeholder = '(default)'; inp.title = label + ' — colour name, "R, G, B", or a system colour';
        inp.addEventListener('input', function () {
          set(inp.value);
          var hex = colorToHex(inp.value);
          sw.className = 'swatch' + (hex ? '' : ' none'); sw.style.background = hex || '';
        });
        wrap.appendChild(lab); wrap.appendChild(sw); wrap.appendChild(inp);
        return wrap;
      }
      function styleFontField(node) {
        var wrap = document.createElement('span'); wrap.style.cssText = 'display:inline-flex;align-items:center;gap:3px';
        var lab = document.createElement('span'); lab.textContent = 'Font'; lab.style.cssText = 'font-size:.85em;opacity:.7';
        var inp = document.createElement('input'); inp.type = 'text'; inp.className = 'colText'; inp.style.maxWidth = '15em';
        inp.value = node.nodeFont || ''; inp.placeholder = 'Segoe UI, 9pt, style=Bold';
        inp.title = 'NodeFont — FontConverter string: "Family, <size>pt[, style=Bold, Italic]"';
        inp.addEventListener('input', function () { node.nodeFont = inp.value; });
        wrap.appendChild(lab); wrap.appendChild(inp);
        return wrap;
      }
      function styleRowEl(node, depth) {
        var r = document.createElement('div'); r.className = 'treeNodeStyleRow';
        r.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;padding:2px 0 4px;opacity:.95;margin-left:' + ((depth * 14) + 20) + 'px';
        r.appendChild(styleColorField('Fore', function () { return node.foreColor || ''; }, function (v) { node.foreColor = v; }));
        r.appendChild(styleColorField('Back', function () { return node.backColor || ''; }, function (v) { node.backColor = v; }));
        r.appendChild(styleFontField(node));
        return r;
      }
      function walk(arr, depth, parentNode, parentList) {
        arr.forEach(function (node, i) {
          listEl.appendChild(rowEl(node, i, depth, arr, parentNode, parentList));
          if (styleOpen[node._k]) listEl.appendChild(styleRowEl(node, depth));
          if (node.children.length && expanded[node._k]) walk(node.children, depth + 1, node, arr);
        });
      }
      function render() {
        listEl.textContent = '';
        if (!roots.length) { var empty = document.createElement('div'); empty.className = 'columnsEmpty'; empty.textContent = '(no nodes)'; listEl.appendChild(empty); }
        walk(roots, 0, null, null);
      }
      render();

      var addBtn = document.createElement('button'); addBtn.type = 'button'; addBtn.className = 'columnsAdd'; addBtn.textContent = '+ Add root node';
      addBtn.addEventListener('click', function () { roots.push(fresh()); render(); });
      pop.appendChild(addBtn);

      var bar = document.createElement('div'); bar.className = 'collectionBar';
      var okBtn = document.createElement('button'); okBtn.type = 'button'; okBtn.className = 'collectionOk'; okBtn.textContent = 'OK';
      var cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel';
      function commit() {
        closePopup();
        if (JSON.stringify(strip(roots)) === original) return; // unchanged → no edit (avoids a spurious dirty/undo)
        vscode.postMessage({ type: 'setTreeNodes', id: id, nodes: strip(roots) });
      }
      okBtn.addEventListener('click', commit);
      cancel.addEventListener('click', function () { closePopup(); });
      bar.appendChild(okBtn); bar.appendChild(cancel);
      pop.appendChild(bar);
    });
  }

  // ---- ToolStrip / MenuStrip item editor (read + REORDER + ADD "Type Here" + REMOVE + RENAME + item-TYPE picker). The
  // item tree renders recursively (menus have nested DropDownItems); ↑/↓ reorder within siblings, ✕ deletes, "+ Add item"
  // appends a NEW item whose type is chosen from a context-appropriate picker and whose Text is typed inline, and an
  // existing item's Text can be edited to RENAME it. OK posts the resulting forest. ----
  function toolStripEditor(c, p) {
    var wrap = document.createElement('div'); wrap.className = 'collectionEd';
    var lbl = document.createElement('span'); lbl.className = 'collectionLabel'; lbl.textContent = '(Collection)'; lbl.title = p.type;
    wrap.appendChild(lbl);
    var btn = document.createElement('button'); btn.type = 'button'; btn.className = 'collectionBtn'; btn.textContent = '…'; btn.title = 'Edit items…';
    btn.addEventListener('click', function () {
      pendingToolStrip = { id: c.id, anchor: btn, ownerType: c.type || '' };
      vscode.postMessage({ type: 'listToolStripItems', id: c.id });
    });
    wrap.appendChild(btn);
    return wrap;
  }
  var _tsKey = 0;
  function openToolStripPopup(anchor, id, ok, items, reason, ownerType) {
    var pickTypes = toolStripNewTypes(ownerType);   // context-appropriate item types a NEW item may be
    var defaultType = pickTypes[0][0];              // the default type for a fresh() item
    openPopup(anchor, function (pop) {
      pop.classList.add('collectionPop'); pop.classList.add('treeNodesPop');
      var title = document.createElement('div'); title.className = 'collectionTitle'; title.textContent = 'Items'; pop.appendChild(title);
      if (!ok) {
        var note = document.createElement('div'); note.className = 'collectionNote';
        note.textContent = 'This collection can’t be edited here (' + (reason || 'unsupported item') + ').';
        pop.appendChild(note);
        return;
      }
      // `_k` is an ephemeral key for expand-state only; it is stripped before sending. Every modelled field rides
      // through clone/strip so the change-detection baseline and the payload agree. A NEW item ("Type Here") is a node
      // with an EMPTY id — the engine mints its field name, construction and Name/Text on commit.
      function clone(n) { return { _k: ++_tsKey, id: n.id || '', text: n.text || '', name: n.name || '', itemType: n.itemType || '', children: (n.children || []).map(clone) }; }
      function strip(a) { return a.map(function (n) { return { id: n.id || '', text: n.text || '', name: n.name || '', itemType: n.itemType || '', children: strip(n.children) }; }); }
      function fresh() { return { _k: ++_tsKey, id: '', text: '', name: '', itemType: defaultType, children: [] }; }
      var roots = (items || []).map(clone);
      var original = JSON.stringify(strip(roots));
      var expanded = {};
      (function ex(a) { a.forEach(function (n) { if (n.children.length) { expanded[n._k] = true; ex(n.children); } }); })(roots);
      var listEl = document.createElement('div'); listEl.className = 'columnsList treeNodesList'; pop.appendChild(listEl);
      function mini(glyph, ttl, disabled, fn) {
        var b = document.createElement('button'); b.type = 'button'; b.className = 'colMini'; b.textContent = glyph; b.title = ttl;
        if (disabled) b.disabled = true; else b.addEventListener('click', fn);
        return b;
      }
      function rowEl(node, i, depth, arr) {
        var r = document.createElement('div'); r.className = 'columnsRow treeNodeRow'; r.style.marginLeft = (depth * 14) + 'px';
        var isNew = !node.id;                              // a fresh() item has an empty id until the engine mints one
        var isMenu = node.itemType === 'ToolStripMenuItem';
        var hasKids = node.children.length > 0;
        var tw = document.createElement('span'); tw.textContent = hasKids ? (expanded[node._k] ? '▾' : '▸') : '·';
        tw.style.cssText = 'display:inline-block;width:1.1em;text-align:center;opacity:' + (hasKids ? '1' : '.3') + ';cursor:' + (hasKids ? 'pointer' : 'default');
        if (hasKids) tw.addEventListener('click', function () { if (expanded[node._k]) delete expanded[node._k]; else expanded[node._k] = true; render(); });
        r.appendChild(tw);
        if (isNew) {
          // NEW item: a type picker (existing items keep their concrete type — changing it would risk losing
          // type-specific properties, so no picker there). Switching to Separator drops the item's Text.
          var typeSel = document.createElement('select'); typeSel.className = 'colTypeSel'; typeSel.title = 'Item type';
          typeSel.style.cssText = 'margin-right:.35em';
          pickTypes.forEach(function (pt) {
            var o = document.createElement('option'); o.value = pt[0]; o.textContent = pt[1];
            if (pt[0] === node.itemType) o.selected = true;
            typeSel.appendChild(o);
          });
          typeSel.addEventListener('change', function () {
            node.itemType = typeSel.value;
            if (node.itemType === 'ToolStripSeparator') node.text = '';
            render();
          });
          r.appendChild(typeSel);
        }
        if (node.itemType === 'ToolStripSeparator') {
          // a separator carries no Text — show a rule, not an editor (its Text is never rewritten)
          var label = document.createElement('span'); label.className = 'colText'; label.style.cssText = 'min-width:9em;opacity:.5';
          label.textContent = '──────'; label.title = (node.itemType || 'item') + '  ' + node.name;
          r.appendChild(label);
        } else {
          // Text is editable: a NEW item is "Type Here"; an EXISTING item can be RENAMED — the engine rewrites its
          // `.Text = "…"` literal in place on commit (clearing it to empty leaves the source Text unchanged).
          var inp = document.createElement('input'); inp.type = 'text'; inp.className = 'colText'; inp.value = node.text || '';
          inp.placeholder = isNew ? 'Type Here' : (node.name || node.id || ''); inp.style.minWidth = '9em';
          if (!isNew) inp.title = (node.itemType || 'item') + '  ' + node.name;
          inp.addEventListener('input', function () { node.text = inp.value; });
          r.appendChild(inp);
        }
        r.appendChild(mini('↑', 'Move up', i === 0, function () { var t = arr[i - 1]; arr[i - 1] = arr[i]; arr[i] = t; render(); }));
        r.appendChild(mini('↓', 'Move down', i === arr.length - 1, function () { var t = arr[i + 1]; arr[i + 1] = arr[i]; arr[i] = t; render(); }));
        r.appendChild(mini('＋⇢', 'Add item below', false, function () { arr.splice(i + 1, 0, fresh()); render(); }));
        // add a child only under an EXISTING menu item — a submenu under a brand-new item isn't supported yet
        if (isMenu && !isNew) r.appendChild(mini('＋', 'Add child item', false, function () { node.children.push(fresh()); expanded[node._k] = true; render(); }));
        // remove this item: a NEW (unsaved) item is just discarded; an EXISTING item (and its whole subtree) is deleted
        // from source on commit — the engine strips its field/construction/property block and its AddRange membership.
        r.appendChild(mini('✕', isNew ? 'Remove' : 'Delete item (and any sub-items)', false, function () { arr.splice(i, 1); render(); }));
        return r;
      }
      function walk(arr, depth) {
        arr.forEach(function (node, i) { listEl.appendChild(rowEl(node, i, depth, arr)); if (node.children.length && expanded[node._k]) walk(node.children, depth + 1); });
      }
      function render() {
        listEl.textContent = '';
        if (!roots.length) { var e = document.createElement('div'); e.className = 'columnsEmpty'; e.textContent = '(no items)'; listEl.appendChild(e); }
        else walk(roots, 0);
      }
      render();
      var addBtn = document.createElement('button'); addBtn.type = 'button'; addBtn.className = 'columnsAdd'; addBtn.textContent = '+ Add item';
      addBtn.addEventListener('click', function () { roots.push(fresh()); render(); });
      pop.appendChild(addBtn);
      var bar = document.createElement('div'); bar.className = 'collectionBar';
      var okBtn = document.createElement('button'); okBtn.type = 'button'; okBtn.className = 'collectionOk'; okBtn.textContent = 'OK';
      var cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel';
      function commit() {
        closePopup();
        if (JSON.stringify(strip(roots)) === original) return; // unchanged → no edit
        vscode.postMessage({ type: 'setToolStripItems', id: id, toolStripItems: strip(roots) });
      }
      okBtn.addEventListener('click', commit);
      cancel.addEventListener('click', function () { closePopup(); });
      bar.appendChild(okBtn); bar.appendChild(cancel);
      pop.appendChild(bar);
    });
  }

  function propRow(c, p, t) {
    var comp = editable(p) ? COMPOSITE[p.type] : null;
    var parts = comp ? parseParts(p.value, comp.fields.length) : null;
    // Anchor/Dock are expandable too: collapsed shows the visual glyph editor (value cell), expanded adds
    // combobox sub-rows — Anchor → a True/False <select> per edge, Dock → a single DockStyle <select>.
    var isAnchor = editable(p) && p.type === ANCHOR_TYPE;
    var isDock = editable(p) && p.type === DOCK_TYPE;
    var isColor = editable(p) && p.type === COLOR_TYPE;
    var isFont = editable(p) && p.type === FONT_TYPE;
    // generic [Flags] enums (Anchor keeps its dedicated glyph editor) → checkbox dropdown
    var isFlags = editable(p) && p.isEnum && !isAnchor && p.flagsMembers && p.flagsMembers.length;
    var canExpand = !!parts || isAnchor || isDock || isFont;
    var isOpen = canExpand && expandedProps.has(p.name);

    var tr = document.createElement('tr');
    if (currentProp === p.name) tr.className = 'sel';
    // selecting a row (click or keyboard focus into its editor) drives the description pane + the active highlight
    tr.addEventListener('mousedown', function () { selectProp(p.name, tr); });
    tr.addEventListener('focusin', function () { selectProp(p.name, tr); });
    tr.addEventListener('contextmenu', function (ev) {
      // right-click inside a value editor → let the browser's native Copy/Paste/Select-All menu through
      var tgt = ev.target;
      if (tgt && (/^(INPUT|TEXTAREA|SELECT)$/.test(tgt.tagName) || tgt.isContentEditable)) return;
      ev.preventDefault(); selectProp(p.name, tr); openPropMenu(ev.clientX, ev.clientY, c, p);
    });
    var nameTd = document.createElement('td');
    nameTd.className = 'name' + (isNonDefault(p) ? ' set' : '');
    nameTd.title = p.description || p.name;
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
    if (p.isImage) {
      // Image/Icon properties (resx-backed): preview swatch + Import…/(none) — no text field (value isn't a literal)
      valTd.className = 'val';
      valTd.appendChild(imageEditor(c, p));
    } else if (p.isCollection) {
      // a collection surfaced with a "…" editor. The value isn't a literal → no text field. String-item
      // collections (ComboBox/ListBox/CheckedListBox.Items) open the one-item-per-line editor; a typed
      // collection (ListView.Columns) opens the per-item grid editor.
      valTd.className = 'val';
      valTd.appendChild(
        p.collectionItemType === COLUMN_ITEM_TYPE ? columnsEditor(c, p)
        : p.collectionItemType === GRIDCOLUMN_ITEM_TYPE ? gridColumnsEditor(c, p)
        : p.collectionItemType === TREENODE_ITEM_TYPE ? treeNodesEditor(c, p)
        : p.collectionItemType === TOOLSTRIP_ITEM_TYPE ? toolStripEditor(c, p)
        : p.collectionItemType === STRINGARRAY_ITEM_TYPE ? stringArrayEditor(c, p)
        : collectionEditor(c, p));
    } else if (editable(p)) {
      valTd.className = 'val';
      if (isAnchor) {
        valTd.appendChild(anchorEditor(p.value, function (v) { sendEdit(c.id, p, v); }));
      } else if (isDock) {
        valTd.appendChild(dockEditor(p.value, function (v) { sendEdit(c.id, p, v); }));
      } else if (isColor) {
        valTd.appendChild(colorEditor(p.value, function (v) { sendEdit(c.id, p, v); }));
      } else if (isFlags) {
        valTd.appendChild(flagsEditor(p, p.value, function (v) { sendEdit(c.id, p, v); }));
      } else if (p.standardValues && p.standardValues.length && !isOpen) {
        valTd.appendChild(editSelect(p.standardValues, !!p.standardValuesExclusive, p.value, p.type + editHint(p), function (v) { sendEdit(c.id, p, v); }));
      } else {
        // collapsed Font (and Point/Size/etc.) show the whole invariant string as a text input; expand for sub-rows
        valTd.appendChild(editInput(p.type + editHint(p), p.value, function (v) { sendEdit(c.id, p, v); }));
      }
    } else {
      valTd.className = 'ro';
      valTd.textContent = (p.value == null ? '' : p.value) + (p.readOnly ? T('panel.grid.readOnly') : '');
      valTd.title = p.type;
    }
    addColSplit(nameTd);
    tr.appendChild(nameTd); tr.appendChild(valTd); t.appendChild(tr);

    if (isOpen && comp) {
      if (comp.all) {
        var allVal = (parts[0] === parts[1] && parts[1] === parts[2] && parts[2] === parts[3]) ? parts[0] : '';
        t.appendChild(subRow(T('panel.field.all'), allVal, function (v) { sendEdit(c.id, p, [v, v, v, v].join(', ')); }));
      }
      for (var k = 0; k < comp.fields.length; k++) {
        (function (idx) {
          t.appendChild(subRow(fieldLabel(comp.fields[idx]), parts[idx], function (v) {
            var nums = parts.slice(); nums[idx] = v; sendEdit(c.id, p, nums.join(', '));
          }));
        })(k);
      }
    } else if (isOpen && isAnchor) {
      // one True/False <select> per edge; recompose the full "Top, Left"/"None" flags string on change
      var aset = parseAnchor(p.value);
      ['Top', 'Bottom', 'Left', 'Right'].forEach(function (side) {
        t.appendChild(subSelectRow(fieldLabel(side), aset[side] ? 'True' : 'False', ['True', 'False'], function (v) {
          aset[side] = (v === 'True'); sendEdit(c.id, p, composeAnchor(aset));
        }));
      });
    } else if (isOpen && isDock) {
      var curDock = String(p.value == null ? '' : p.value).trim() || 'None';
      t.appendChild(subSelectRow(fieldLabel('Dock'), curDock, ['None', 'Top', 'Bottom', 'Left', 'Right', 'Fill'], function (v) {
        sendEdit(c.id, p, v);
      }));
    } else if (isOpen && isFont) {
      fontSubRows(c, p, t);
    }
  }

  // ---- smart-tag "Tasks" flyout (VS/DevExpress-style): a "⚡ <Type> Tasks" button above the grid opens a popup
  // with a CURATED subset of the control's common properties, edited with the SAME inline editors as the grid,
  // plus "All Properties…". The set is a name heuristic (we don't read DevExpress DesignerActionList). ----
  var TASK_PROP_NAMES = ['Text', 'Caption', 'Image', 'ImageOptions', 'ImageIndex', 'ShowCloseButton', 'TabPageWidth',
    'PageEnabled', 'PageVisible', 'AutoScroll', 'TouchScroll', 'SmallChange', 'Enabled', 'Visible', 'ReadOnly',
    'Checked', 'CheckState', 'Value', 'Multiline', 'Dock', 'Anchor', 'BackColor', 'ForeColor', 'Font'];
  function tasksFor(c) {
    if (!c || !c.properties) return [];
    var rank = {};
    for (var i = 0; i < TASK_PROP_NAMES.length; i++) rank[TASK_PROP_NAMES[i].toLowerCase()] = i;
    var found = c.properties.filter(function (p) { return rank[p.name.toLowerCase()] !== undefined; });
    found.sort(function (a, b) { return rank[a.name.toLowerCase()] - rank[b.name.toLowerCase()]; });
    return found;
  }
  function openTasksPopup(anchor, c) {
    openPopup(anchor, function (pop) {
      var title = document.createElement('div'); title.className = 'tasksTitle';
      title.textContent = T('panel.tasks.title', { type: shortType(c.type) });
      pop.appendChild(title);
      var tasks = tasksFor(c);
      if (!tasks.length) {
        var note = document.createElement('div'); note.className = 'tasksNote';
        note.textContent = T('panel.tasks.none'); pop.appendChild(note);
      } else {
        var tbl = gridTable();
        for (var i = 0; i < tasks.length; i++) propRow(c, tasks[i], tbl);
        pop.appendChild(tbl);
      }
      var all = document.createElement('button'); all.type = 'button'; all.className = 'tasksAll';
      all.textContent = T('panel.tasks.all');
      all.addEventListener('click', function () { closePopup(); setTab('props'); if (searchEl) searchEl.value = ''; renderActiveTab(); });
      pop.appendChild(all);
    });
  }
  function tasksBar(c) {
    var bar = document.createElement('div'); bar.className = 'tasksbar';
    var btn = document.createElement('button'); btn.type = 'button'; btn.className = 'tasksbtn';
    btn.textContent = '⚡ ' + T('panel.tasks.title', { type: shortType(c.type) });
    btn.title = T('panel.tasks.tooltip', { name: c.name || shortType(c.type) });
    btn.addEventListener('click', function () {
      if (popupEl && popupAnchor === btn) { closePopup(); return; } // toggle
      openTasksPopup(btn, c);
    });
    bar.appendChild(btn);
    return bar;
  }

  function renderProps(c, filter) {
    propsEl.innerHTML = '';
    if (!c) { propsEl.textContent = T('panel.grid.notFound'); return; }
    // NOTE: the "Tasks" smart-tag now lives ON THE CANVAS (a chevron glyph at the control's top-right, VS-style),
    // not as a button above this grid — see designer.js renderSmartTag/openFlyout. tasksBar/openTasksPopup remain
    // available but are intentionally not rendered here.
    var sorted = filterSort(c.properties, filter);
    if (!sorted.length) {
      var m = document.createElement('div'); m.className = 'propsMsg';
      m.textContent = filter ? T('panel.grid.noMatchingProps') : T('panel.grid.noProps');
      propsEl.appendChild(m); return;
    }
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
    inp.setAttribute('list', listId); inp.placeholder = T('common.none');
    inp.title = T('panel.event.handlerTip');
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
    if (!c) { eventsEl.textContent = T('panel.grid.notFound'); return; }
    var evs = filterSort(c.events || [], filter);
    if (!evs.length) { eventsEl.textContent = filter ? T('panel.grid.noMatchingEvents') : T('panel.grid.noEvents'); return; }
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
        nameTd.title = e.type + (e.handler ? T('panel.event.wiredTip') : T('panel.event.unwiredTip'));
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
    updateDescPane(); // keep the description pane in sync with the active tab (and any re-render)
  }
  function setTab(tab) {
    closePopup();
    activeTab = tab;
    tabPropsEl.className = tab === 'props' ? 'active' : '';
    tabEventsEl.className = tab === 'events' ? 'active' : '';
    propsEl.style.display = tab === 'props' ? '' : 'none';
    eventsEl.style.display = tab === 'events' ? '' : 'none';
    searchEl.placeholder = tab === 'props' ? T('panel.search.props') : T('panel.search.events');
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
    } else if (m.type === 'palette') {
      applyPalette(m.palette);
      // a late palette (color swatches / font families) → close any popup opened before it arrived (its
      // swatches were empty) and re-render so the Color/Font editors pick up the palette
      closePopup();
      if (currentComponent) renderActiveTab();
    } else if (m.type === 'showTab') {
      showMainTab(m.tab); // F4 → reveal Properties
    } else if (m.type === 'layout') {
      controls = m.controls || [];
      rebuildTree(); renderOutline();
    } else if (m.type === 'select') {
      if (m.id !== currentId) closePopup(); // selection moved to another control → drop any open dropdown
      currentId = m.id;
      if (treeEl) treeEl.value = m.id;
      renderOutline();
    } else if (m.type === 'props') {
      if (m.id !== currentId) return;
      var compId = m.component ? m.component.id : null;
      if (!currentComponent || currentComponent.id !== compId) { closePopup(); eventCandidates = {}; candFetchedFor = null; currentProp = null; }
      currentComponent = m.component;
      setEmpty(!m.component);
      renderActiveTab();
      fetchCandidatesIfNeeded();
    } else if (m.type === 'candidates') {
      if (currentComponent && currentComponent.id === m.id) { eventCandidates = m.map || {}; if (activeTab === 'events') renderActiveTab(); }
    } else if (m.type === 'collectionItems') {
      // reply to a "…" click — open the string-collection editor anchored to the button that requested it
      if (pendingCollection && pendingCollection.id === m.id && pendingCollection.prop === m.prop) {
        var anchor = pendingCollection.anchor;
        pendingCollection = null;
        if (anchor && anchor.isConnected) openCollectionPopup(anchor, m.id, m.prop, !!m.ok, m.items || [], m.reason);
      }
    } else if (m.type === 'stringArrayItems') {
      // reply to a string[] "…" click — same one-item-per-line popup, committed via the setStringArray route
      if (pendingStringArray && pendingStringArray.id === m.id && pendingStringArray.prop === m.prop) {
        var saAnchor = pendingStringArray.anchor;
        pendingStringArray = null;
        if (saAnchor && saAnchor.isConnected) openCollectionPopup(saAnchor, m.id, m.prop, !!m.ok, m.items || [], m.reason, 'setStringArray');
      }
    } else if (m.type === 'columnItems') {
      // reply to a ListView.Columns "…" click — open the typed grid editor anchored to the requesting button
      if (pendingColumns && pendingColumns.id === m.id) {
        var colAnchor = pendingColumns.anchor;
        pendingColumns = null;
        if (colAnchor && colAnchor.isConnected) openColumnsPopup(colAnchor, m.id, !!m.ok, m.columns || [], m.reason);
      }
    } else if (m.type === 'gridColumnItems') {
      // reply to a DataGridView.Columns "…" click — open the grid-column editor anchored to the requesting button
      if (pendingGridColumns && pendingGridColumns.id === m.id) {
        var gcAnchor = pendingGridColumns.anchor;
        pendingGridColumns = null;
        if (gcAnchor && gcAnchor.isConnected) openGridColumnsPopup(gcAnchor, m.id, !!m.ok, m.columns || [], m.reason);
      }
    } else if (m.type === 'treeNodeItems') {
      // reply to a TreeView.Nodes "…" click — open the recursive tree editor anchored to the requesting button
      if (pendingTreeNodes && pendingTreeNodes.id === m.id) {
        var tnAnchor = pendingTreeNodes.anchor;
        pendingTreeNodes = null;
        if (tnAnchor && tnAnchor.isConnected) openTreeNodesPopup(tnAnchor, m.id, !!m.ok, m.nodes || [], m.reason);
      }
    } else if (m.type === 'toolStripItems') {
      // reply to a ToolStrip/MenuStrip.Items "…" click — open the recursive reorder editor anchored to the button
      if (pendingToolStrip && pendingToolStrip.id === m.id) {
        var tsAnchor = pendingToolStrip.anchor;
        var tsOwnerType = pendingToolStrip.ownerType;
        pendingToolStrip = null;
        if (tsAnchor && tsAnchor.isConnected) openToolStripPopup(tsAnchor, m.id, !!m.ok, m.items || [], m.reason, tsOwnerType);
      }
    } else if (m.type === 'clear') {
      closePopup();
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
