// The big "Choose Toolbox Items" window (a separate editor-area webview). VS-style tabs (.NET / COM / WPF), a
// Name / Namespace / Assembly Name / Version / Directory table with checkboxes, a filter, a details strip,
// OK/Cancel/Reset and a working Browse… (the host opens a file dialog and the engine scans the picked .dll).
// The CHECKBOXES are real: OK sends the checked rows back to the host, which puts them in the toolbox tab the
// dialog was opened from (and persists them). Opening the dialog pre-checks the items already in that tab.
(function () {
  var vscode = acquireVsCodeApi();
  var items = [];          // all candidate rows (framework + project + browsed)
  var selected = {};       // fqn -> true for rows the user wants in the toolbox tab
  var targetTab = null;    // the toolbox tab these go into (from the right-clicked tab)
  var inited = false;      // seed `selected` from the tab's current membership only on first load
  var view = 'net';        // the active dialog tab (.NET / COM / WPF)

  var loadingEl = document.getElementById('ciLoading');
  var tableEl = document.getElementById('ciTable');
  var filterEl = document.getElementById('ciFilter');
  var detailsEl = document.getElementById('ciDetails');
  var loadNameEl = document.getElementById('ciLoadName');
  var statusEl = document.getElementById('ciStatus');

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'; }); }
  function fqnOf(it) { return it.namespace ? it.namespace + '.' + it.name : it.name; }
  function showLoading(on) { loadingEl.style.display = on ? 'flex' : 'none'; tableEl.style.display = on ? 'none' : 'block'; }
  function setStatus() { if (statusEl) statusEl.textContent = targetTab ? ('Adding to tab: ' + targetTab) : 'Tip: open Choose Items from a custom toolbox tab to add there'; }

  function render() {
    if (view !== 'net') {
      tableEl.innerHTML = '<div class="empty">' + (view === 'com' ? 'COM Components' : 'WPF Components') +
        ' — not yet implemented. Scanning of registered components is a later increment.</div>';
      return;
    }
    var q = (filterEl.value || '').trim().toLowerCase();
    var list = items.filter(function (it) {
      return !q || it.name.toLowerCase().indexOf(q) >= 0 ||
        (it.namespace || '').toLowerCase().indexOf(q) >= 0 || (it.assemblyName || '').toLowerCase().indexOf(q) >= 0;
    });
    list.sort(function (a, b) { return a.name.localeCompare(b.name); });
    if (!list.length) { tableEl.innerHTML = '<div class="empty">No matching components.</div>'; return; }
    var h = '<table><thead><tr><th class="chk"></th><th>Name</th><th>Namespace</th><th>Assembly Name</th><th>Version</th><th>Directory</th></tr></thead><tbody>';
    list.forEach(function (it) {
      var fqn = fqnOf(it);
      h += '<tr data-fqn="' + esc(fqn) + '">' +
        '<td class="chk"><input type="checkbox" data-fqn="' + esc(fqn) + '"' + (selected[fqn] ? ' checked' : '') + '></td>' +
        '<td>' + esc(it.name) + '</td>' +
        '<td>' + esc(it.namespace || '') + '</td>' +
        '<td>' + esc(it.assemblyName || '') + '</td>' +
        '<td>' + esc(it.version || '') + '</td>' +
        '<td>' + esc(it.directory || (it.fromProject ? '(project)' : '')) + '</td></tr>';
    });
    h += '</tbody></table>';
    tableEl.innerHTML = h;
    var rows = tableEl.querySelectorAll('tbody tr');
    for (var i = 0; i < rows.length; i++) { (function (r) { r.addEventListener('click', function () { selectRow(r); }); })(rows[i]); }
    var cbs = tableEl.querySelectorAll('tbody input[type=checkbox]');
    for (var j = 0; j < cbs.length; j++) {
      (function (cb) {
        cb.addEventListener('click', function (e) { e.stopPropagation(); });
        cb.addEventListener('change', function () { selected[cb.getAttribute('data-fqn')] = cb.checked; });
      })(cbs[j]);
    }
  }

  function selectRow(r) {
    var rows = tableEl.querySelectorAll('tbody tr');
    for (var i = 0; i < rows.length; i++) rows[i].className = '';
    r.className = 'sel';
    var fqn = r.getAttribute('data-fqn');
    var it = items.filter(function (x) { return fqnOf(x) === fqn; })[0];
    if (!it) { detailsEl.textContent = fqn; return; }
    detailsEl.innerHTML = '<b>' + esc(it.name) + '</b><br>Language: Invariant Language (Invariant Country)<br>Version: ' + esc(it.version || '');
  }

  function setView(v) {
    view = v;
    var ts = document.querySelectorAll('#ciTabs .t');
    for (var i = 0; i < ts.length; i++) ts[i].className = ts[i].getAttribute('data-tab') === v ? 't active' : 't';
    render();
  }

  var tabs = document.querySelectorAll('#ciTabs .t');
  for (var i = 0; i < tabs.length; i++) { (function (el) { el.addEventListener('click', function () { setView(el.getAttribute('data-tab')); }); })(tabs[i]); }
  filterEl.addEventListener('input', render);
  document.getElementById('ciClear').addEventListener('click', function () { filterEl.value = ''; render(); });
  document.getElementById('ciBrowse').addEventListener('click', function () {
    if (loadNameEl) loadNameEl.textContent = 'scanning selected assembly…';
    showLoading(true); // the host always re-posts items (even on cancel), so this never sticks
    vscode.postMessage({ type: 'browse' });
  });
  document.getElementById('ciOk').addEventListener('click', function () {
    // send EVERY shown row + its checkbox state so the host can diff against the current toolbox (add/remove/hide)
    var rows = items.map(function (it) {
      var f = fqnOf(it);
      return { fqn: f, name: it.name, namespace: it.namespace, assemblyName: it.assemblyName, fromProject: it.fromProject, checked: !!selected[f] };
    });
    vscode.postMessage({ type: 'applyChooseItems', tab: targetTab, rows: rows });
  });
  document.getElementById('ciCancel').addEventListener('click', function () { vscode.postMessage({ type: 'close' }); });

  window.addEventListener('message', function (e) {
    var m = e.data;
    if (m.type === 'items') {
      items = m.items || [];
      targetTab = m.tab || null;
      // seed the checkboxes from the tab's current membership ONCE; keep the user's in-progress checks across
      // Browse re-fetches (a Browse re-posts 'items' and we must not wipe what they already ticked).
      if (!inited) { selected = {}; (m.chosen || []).forEach(function (f) { selected[f] = true; }); inited = true; }
      // auto-tick the just-browsed assembly's items so a loaded library is one OK-click from the toolbox.
      (m.check || []).forEach(function (f) { selected[f] = true; });
      if (loadNameEl) loadNameEl.textContent = (items[0] && items[0].assemblyName) ? items[0].assemblyName + '.dll' : 'assemblies…';
      setStatus();
      // brief shimmer so it reads like VS's "Loading items…" scan, then reveal the (updated) list
      setTimeout(function () { showLoading(false); render(); }, 600);
    } else if (m.type === 'browseResult') {
      // per-Browse summary (added N / no components / could-not-load reason) so a no-op pick isn't silent
      if (statusEl) statusEl.textContent = m.message || '';
    }
  });

  showLoading(true);
  vscode.postMessage({ type: 'ready' });
})();
