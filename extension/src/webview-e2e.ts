// Live-webview regression tests (T2.3). Drives the REAL media/designer.js and media/panel.js in a headless jsdom
// window (see webviewHarness.ts) and asserts on the messages each webview posts to the host + the resulting DOM.
// This is the automated replacement for the recurring "F5 debt": the interaction layer (keyboard nudge, the T2.2
// diagnostics banner, selection, context menu, zoom, the property-grid editors) that engine-level e2e can't reach.
//
// Style mirrors e2e.ts: plain throw-on-failure assertions, run sequentially, print a PASS/FAIL summary and exit.
// Run: `npm run webview-e2e` (after `npm run build`). jsdom is a devDependency (never shipped in the VSIX).

import { loadDesigner, loadPanel, delay, drainHarnesses, Harness } from './webviewHarness';

let checks = 0;
function ok(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
  checks++;
}
function eq(actual: unknown, expected: unknown, msg: string): void {
  ok(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${msg} — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`,
  );
}
function only<T extends { type: string }>(posted: T[], type: string): T[] {
  return posted.filter((m) => m.type === type);
}
/* eslint-disable @typescript-eslint/no-explicit-any */
/** Find a rendered context-menu item (.mi) by a substring of its label (with an empty i18n catalog the label IS the key). */
function findMenuItem(h: Harness, menuId: string, labelSubstr: string): any {
  return (Array.from(h.el(menuId).querySelectorAll('.mi')) as any[]).find((d) => d.textContent.indexOf(labelSubstr) >= 0);
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const tests: Array<[string, () => void | Promise<void>]> = [];
function test(name: string, fn: () => void | Promise<void>): void {
  tests.push([name, fn]);
}

// ---- fixtures -------------------------------------------------------------------------------------------------
/* eslint-disable @typescript-eslint/no-explicit-any */
function mkCtrl(over: Record<string, any> = {}): any {
  return {
    id: 'button1',
    name: 'button1',
    type: 'System.Windows.Forms.Button',
    x: 10,
    y: 20,
    width: 80,
    height: 24,
    parentId: 'this',
    ...over,
  };
}
/** Put a single control on the surface, select it, and (optionally) mark it movable/resizable — the state the
 *  host establishes via layout/select/manip before the user nudges/drags. */
function setupSelected(h: Harness, ctrl: any, move = true, resize = true): void {
  h.send({ type: 'layout', controls: [ctrl] });
  h.send({ type: 'select', id: ctrl.id });
  h.send({ type: 'manip', id: ctrl.id, move, resize });
  h.resetPosted();
}
/** Deterministically commit a pending keyboard-nudge series WITHOUT waiting out the 250ms debounce: a competing
 *  gesture force-flushes it (designer.js:876 runs flushNudge() on a left-button mousedown, before hit-test). A
 *  mousedown on an empty canvas point only starts a harmless rubber-band, so it commits the nudge and posts nothing
 *  else. This also makes the guard tests non-vacuous: if a guard were broken, a nudge series would exist and this
 *  flush would surface its commit. */
function flushNudge(h: Harness): void {
  h.mouse('mousedown', { button: 0, offsetX: 5000, offsetY: 5000 }, h.el('surface'));
}

// ================================================================================================================
// DESIGNER (media/designer.js)
// ================================================================================================================

test('smoke: designer loads and posts ready', () => {
  const h = loadDesigner();
  ok(only(h.posted, 'ready').length === 1, 'designer posted exactly one ready on load');
  h.destroy();
});

test('nudge: Arrow moves 1px and commits exactly one manipulate after the idle debounce', async () => {
  // This is the SOLE test that waits out the real 250ms debounce (to prove the idle-commit actually fires). The
  // margin is deliberately generous so a loaded CI runner / GC pause can't make it flaky; every OTHER nudge test
  // commits deterministically via flushNudge() (a competing gesture) with no wall-clock dependency.
  const h = loadDesigner();
  setupSelected(h, mkCtrl());
  h.key('keydown', { key: 'ArrowRight' });
  eq(only(h.posted, 'manipulate').length, 0, 'nudge is optimistic — no commit before the debounce fires');
  await delay(700);
  const commits = only(h.posted, 'manipulate');
  eq(commits.length, 1, 'exactly one manipulate commit for the key series');
  eq(commits[0].mode, 'move', 'move mode');
  eq(commits[0].x, 11, 'x nudged +1px');
  eq(commits[0].y, 20, 'y unchanged');
  h.destroy();
});

test('nudge: Ctrl+Arrow uses the 8px grid step', () => {
  const h = loadDesigner();
  setupSelected(h, mkCtrl());
  h.key('keydown', { key: 'ArrowDown', ctrlKey: true });
  flushNudge(h);
  const commits = only(h.posted, 'manipulate');
  eq(commits.length, 1, 'one commit');
  eq(commits[0].y, 28, 'y nudged +8px (grid step)');
  h.destroy();
});

test('nudge: Shift+Arrow resizes instead of moving', () => {
  const h = loadDesigner();
  setupSelected(h, mkCtrl());
  h.key('keydown', { key: 'ArrowRight', shiftKey: true });
  flushNudge(h);
  const commits = only(h.posted, 'manipulate');
  eq(commits.length, 1, 'one commit');
  eq(commits[0].mode, 'resize', 'resize mode');
  eq(commits[0].width, 81, 'width grew +1px');
  eq(commits[0].x, 10, 'x unchanged on resize');
  h.destroy();
});

test('nudge: several arrows in one series commit ONE undo unit (accumulated)', () => {
  const h = loadDesigner();
  setupSelected(h, mkCtrl());
  h.key('keydown', { key: 'ArrowRight' });
  h.key('keydown', { key: 'ArrowRight' });
  h.key('keydown', { key: 'ArrowRight' });
  flushNudge(h);
  const commits = only(h.posted, 'manipulate');
  eq(commits.length, 1, 'three arrows → ONE commit');
  eq(commits[0].x, 13, 'x moved +3px total');
  h.destroy();
});

test('nudge: does NOT move when the host has not granted move (canMove=false)', () => {
  const h = loadDesigner();
  setupSelected(h, mkCtrl(), /*move*/ false, /*resize*/ false);
  h.key('keydown', { key: 'ArrowRight' });
  flushNudge(h); // a broken canMove gate would have started a nudge series → this flush would surface its commit
  eq(only(h.posted, 'manipulate').length, 0, 'no commit when not movable');
  h.destroy();
});

test('nudge: ignored while typing in an input (arrow keys belong to the field)', () => {
  const h = loadDesigner();
  setupSelected(h, mkCtrl());
  const input = h.document.createElement('input');
  h.document.body.appendChild(input);
  input.focus();
  eq(h.document.activeElement.tagName, 'INPUT', 'input is focused');
  h.key('keydown', { key: 'ArrowRight' });
  flushNudge(h);
  eq(only(h.posted, 'manipulate').length, 0, 'no nudge while an input has focus');
  h.destroy();
});

test('diag banner (T2.2): warn shows, toggle expands, dismiss latches, changed set re-shows, clean render resets', () => {
  const h = loadDesigner();
  const setA = [{ category: 'missingType', text: 'this.foo = new Bar();', detail: 'Bar' }];
  const setB = [{ category: 'initError', text: 'this.baz.Init();', detail: 'boom' }];

  h.send({ type: 'renderDiag', items: setA });
  ok(h.el('diag').style.display !== 'none', 'banner visible on a partial render');
  eq(h.el('diag').className, 'warn', 'warn styling');
  ok(h.el('diagList').children.length >= 1, 'categorized list rendered');

  // details toggle
  h.click(h.el('diagToggle'));
  ok(h.el('diagList').style.display !== 'none', 'list expands on toggle');

  // dismiss latches the exact set
  h.click(h.el('diagDismiss'));
  eq(h.el('diag').style.display, 'none', 'hidden after dismiss');
  h.send({ type: 'renderDiag', items: setA });
  eq(h.el('diag').style.display, 'none', 'the SAME set stays dismissed (no re-nag)');

  // a different problem set re-surfaces
  h.send({ type: 'renderDiag', items: setB });
  ok(h.el('diag').style.display !== 'none', 'a changed set re-shows');

  // a clean render clears the banner AND resets the dismiss latch
  h.send({ type: 'renderDiag', items: [] });
  eq(h.el('diag').style.display, 'none', 'clean render hides the banner');
  h.send({ type: 'renderDiag', items: setA });
  ok(h.el('diag').style.display !== 'none', 'the once-dismissed set shows again after a clean render reset the latch');
  h.destroy();
});

test('error (T2.2): overlay before first render, err-banner on a real render failure, footer status on an action error', () => {
  const h = loadDesigner();

  // (1) nothing rendered yet → a blocking error overlay
  h.send({ type: 'error', message: 'engine died' });
  ok(h.el('overlay').style.display !== 'none', 'overlay shown when nothing has rendered');
  eq(h.el('overlay').className, 'err', 'overlay in error styling');

  // simulate a first successful render so a prior preview exists on the canvas
  h.send({ type: 'render', png: '', width: 100, height: 100, gen: 0 });

  // (2) a real render failure with a prior preview → persistent "last successful preview" err banner
  h.send({ type: 'error', message: 'render died', renderFailure: true });
  eq(h.el('diag').className, 'err', 'renderFailure → err banner');
  ok(h.el('diag').style.display !== 'none', 'err banner visible');

  // (3) a failed user ACTION (no renderFailure) → unobtrusive footer status, NOT the scary stale-preview banner
  h.send({ type: 'renderDiag', items: [] }); // clear the err banner first
  h.send({ type: 'error', message: 'edit rejected' });
  ok((h.el('status').textContent || '').length > 0, 'action error surfaced in the footer status');
  ok(
    h.el('diag').className !== 'err' || h.el('diag').style.display === 'none',
    'no stale-preview banner for a plain action error',
  );
  h.destroy();
});

test('zoom: zoomIn raises the label and persists the zoom to webview state', () => {
  const h = loadDesigner();
  const before = h.el('zoomLabel').textContent;
  h.click(h.el('zoomIn'));
  ok(h.el('zoomLabel').textContent !== before, `zoom label changed from ${before}`);
  ok(typeof h.state.zoom === 'number' && h.state.zoom > 1, 'zoom > 1 persisted to state');
  // clicking the % label resets to 100%
  h.click(h.el('zoomLabel'));
  eq(h.el('zoomLabel').textContent, '100%', 'label click resets to 100%');
  h.destroy();
});

test('selection: a canvas click hit-tests the control under the cursor and posts pick', () => {
  const h = loadDesigner();
  h.send({ type: 'layout', controls: [mkCtrl()] });
  h.resetPosted();
  h.mouse('click', { offsetX: 20, offsetY: 30 }, h.el('surface')); // inside button1 (10,20,80,24)
  const picks = only(h.posted, 'pick');
  eq(picks.length, 1, 'one pick posted');
  eq(picks[0].id, 'button1', 'picked the control under the cursor');
  h.destroy();
});

test('nudge: a multi-selection moves as a group (one manipulateGroup)', () => {
  const h = loadDesigner();
  const b1 = mkCtrl();
  const b2 = mkCtrl({ id: 'button2', name: 'button2', x: 10, y: 60 });
  h.send({ type: 'layout', controls: [b1, b2] });
  h.mouse('click', { offsetX: 20, offsetY: 30 }, h.el('surface')); // button1
  h.mouse('click', { offsetX: 20, offsetY: 70, ctrlKey: true }, h.el('surface')); // + button2
  h.send({ type: 'manip', id: 'button2', move: true, resize: true }); // host grants move for the new primary
  h.resetPosted();
  h.key('keydown', { key: 'ArrowRight' });
  flushNudge(h);
  const g = only(h.posted, 'manipulateGroup');
  eq(g.length, 1, 'one group commit');
  eq(g[0].ids.length, 2, 'both controls moved');
  eq([g[0].dx, g[0].dy], [1, 0], 'accumulated delta dx=1, dy=0');
  h.destroy();
});

test('duplicate: Ctrl+D posts duplicate for the selection (no clipboard involved)', () => {
  const h = loadDesigner();
  setupSelected(h, mkCtrl());
  h.key('keydown', { key: 'd', ctrlKey: true });
  const dup = only(h.posted, 'duplicate');
  eq(dup.length, 1, 'one duplicate posted');
  eq(dup[0].ids, ['button1'], 'duplicates the selection');
  h.destroy();
});

test('copy: Ctrl+C posts copy for a single selection', () => {
  const h = loadDesigner();
  setupSelected(h, mkCtrl());
  h.key('keydown', { key: 'c', ctrlKey: true });
  const c = only(h.posted, 'copy');
  eq(c.length, 1, 'one copy posted');
  eq(c[0].id, 'button1', 'copies the selected control');
  h.destroy();
});

test('context menu: right-click selects the control, builds the VS menu, and Delete posts removeControl', () => {
  const h = loadDesigner();
  h.send({ type: 'layout', controls: [mkCtrl()] });
  h.send({ type: 'manip', id: 'button1', move: true, resize: true });
  h.resetPosted();
  h.mouse('contextmenu', { clientX: 20, clientY: 30, button: 2 }, h.el('surfaceWrap'));
  ok(h.el('ctxMenu').className.indexOf('open') >= 0, 'menu opened');
  eq(only(h.posted, 'pick')[0]?.id, 'button1', 'right-click selected the hit control'); // transform itself is covered separately
  const items = Array.from(h.el('ctxMenu').querySelectorAll('.mi')) as any[];
  ok(items.length > 5, 'menu has the expected items');
  const del = items.find((d) => d.querySelector('.acc')?.textContent === 'Del');
  ok(!!del && del.className.indexOf('disabled') < 0, 'Delete item present and enabled for a non-root control');
  h.resetPosted();
  h.click(del);
  eq(only(h.posted, 'removeControl').length, 1, 'clicking Delete posts removeControl');
  eq(h.posted[0].id, 'button1', 'removeControl targets the control');
  h.destroy();
});

test('context menu: the hit-test applies the canvas client→surface offset (getBoundingClientRect origin)', () => {
  const h = loadDesigner();
  h.setCanvasRect(8, 8); // the canvas sits at (8,8) in the webview (the toolbar / diag strip is above it)
  h.send({ type: 'layout', controls: [mkCtrl({ x: 2, y: 2, width: 12, height: 12 })] }); // surface bounds x∈[2,14), y∈[2,14)
  h.resetPosted();
  // client (16,16): the corrected surface point (16-8, 16-8) = (8,8) is INSIDE the control → picks button1.
  // If the '- rect.left / - rect.top' correction were dropped, the raw (16,16) is OUTSIDE → the form ('this').
  h.mouse('contextmenu', { clientX: 16, clientY: 16 }, h.el('surfaceWrap'));
  eq(only(h.posted, 'pick')[0]?.id, 'button1', 'the offset-corrected right-click hit the control (a dropped correction would miss → form)');
  h.destroy();
});

test('lock controls (T1.2): the menu locks every control, then a locked control cannot be nudged', () => {
  const h = loadDesigner();
  h.send({ type: 'layout', controls: [mkCtrl()] });
  h.send({ type: 'select', id: 'button1' });
  h.send({ type: 'manip', id: 'button1', move: true, resize: true });
  h.mouse('contextmenu', { clientX: 20, clientY: 30 }, h.el('surfaceWrap'));
  const lock = findMenuItem(h, 'ctxMenu', 'designer.menu.lockControls');
  ok(!!lock && lock.className.indexOf('disabled') < 0, 'Lock Controls is enabled');
  h.click(lock);
  // re-open (a plain click leaves no active band) → Lock Controls now shows a check
  h.mouse('contextmenu', { clientX: 20, clientY: 30 }, h.el('surfaceWrap'));
  ok(findMenuItem(h, 'ctxMenu', 'designer.menu.lockControls').textContent.indexOf('✓') >= 0, 'Lock Controls is now checked');
  // and the locked control no longer nudges
  h.resetPosted();
  h.key('keydown', { key: 'ArrowRight' });
  flushNudge(h); // a broken lock gate would have started a nudge series → this flush would surface its commit
  eq(only(h.posted, 'manipulate').length, 0, 'a locked control cannot be nudged (mouse move/resize/nudge blocked)');
  h.destroy();
});

// ================================================================================================================
// PANEL (media/panel.js) — property grid / toolbox / outline
// ================================================================================================================

/** Select a component and populate the property grid — the host's select + props sequence. */
function setupComponent(h: Harness, component: any): void {
  h.send({ type: 'select', id: component.id });
  h.send({ type: 'props', id: component.id, component });
  h.resetPosted();
}
function prop(name: string, over: Record<string, any> = {}): any {
  return { name, type: 'System.String', value: '', isEnum: false, sourceExplicit: false, isDefault: true, category: 'Misc', ...over };
}
/** Find a property row (a <tr> with a td.name) by property name, tolerating the ▸/▾ twisty prefix. */
function findPropRow(h: Harness, name: string): any {
  const rows = Array.from(h.el('props').querySelectorAll('tr')) as any[];
  return rows.find((tr) => {
    const nt = tr.querySelector('td.name');
    return nt && nt.textContent.replace(/^[▾▸]\s*/, '').trim() === name;
  });
}
function hasSet(h: Harness, name: string): boolean {
  return findPropRow(h, name).querySelector('td.name').className.indexOf('set') >= 0;
}

test('smoke: panel loads and posts ready', () => {
  const h = loadPanel();
  ok(only(h.posted, 'ready').length === 1, 'panel posted exactly one ready on load');
  h.destroy();
});

test('panel value edit: committing a text field posts an edit with the new value', () => {
  const h = loadPanel();
  setupComponent(h, {
    id: 'button1',
    name: 'button1',
    type: 'System.Windows.Forms.Button',
    properties: [prop('Text', { value: 'hello', sourceExplicit: true, isDefault: false, category: 'Appearance' })],
    events: [],
  });
  const input = h.el('props').querySelector('input');
  ok(!!input, 'a text editor was rendered for the string property');
  input.value = 'world';
  input.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  const edits = only(h.posted, 'edit');
  eq(edits.length, 1, 'one edit posted');
  eq([edits[0].prop, edits[0].value, edits[0].propType], ['Text', 'world', 'System.String'], 'edit carries prop/value/type');
  h.destroy();
});

test('panel reset (T0.2): right-click a source-explicit row → Reset posts resetProperty; a default row disables Reset', () => {
  const h = loadPanel();
  setupComponent(h, {
    id: 'button1',
    name: 'button1',
    type: 'System.Windows.Forms.Button',
    properties: [
      prop('Text', { value: 'hi', sourceExplicit: true, isDefault: false, category: 'Appearance' }),
      prop('Tag', { value: '', sourceExplicit: false, isDefault: true, category: 'Data' }),
    ],
    events: [],
  });
  // source-explicit → enabled Reset that posts
  h.mouse('contextmenu', { clientX: 5, clientY: 5 }, findPropRow(h, 'Text').querySelector('td.name'));
  const reset = h.el('tbMenu').querySelector('.mi');
  ok(!!reset && reset.className.indexOf('disabled') < 0, 'Reset enabled for a source-explicit property');
  h.click(reset);
  eq(only(h.posted, 'resetProperty').length, 1, 'Reset posts resetProperty');
  eq(h.posted[0].prop, 'Text', 'resets the right property');
  // a property already at its default → Reset greyed, no message
  h.resetPosted();
  h.mouse('contextmenu', { clientX: 5, clientY: 5 }, findPropRow(h, 'Tag').querySelector('td.name'));
  const reset2 = h.el('tbMenu').querySelector('.mi');
  ok(reset2.className.indexOf('disabled') >= 0, 'Reset disabled for a default property');
  h.click(reset2);
  eq(only(h.posted, 'resetProperty').length, 0, 'a disabled Reset posts nothing');
  h.destroy();
});

test('panel bold-nondefault (T0.3): non-default rows get the "set" class; ambient/noise props never do', () => {
  const h = loadPanel();
  setupComponent(h, {
    id: 'x',
    name: 'x',
    type: 'System.Windows.Forms.Button',
    properties: [
      prop('Text', { sourceExplicit: true, isDefault: false, category: 'A' }),
      prop('BackColor', { type: 'System.Drawing.Color', value: 'Red', sourceExplicit: false, isDefault: false, category: 'A' }),
      prop('TabIndex', { type: 'System.Int32', value: '3', sourceExplicit: false, isDefault: false, category: 'B' }),
      prop('Tag', { sourceExplicit: false, isDefault: true, category: 'B' }),
    ],
    events: [],
  });
  ok(hasSet(h, 'Text'), 'sourceExplicit → bold');
  ok(hasSet(h, 'BackColor'), 'isDefault=false → bold');
  ok(!hasSet(h, 'TabIndex'), 'TabIndex is in the ambient noise set → never bold even when isDefault=false');
  ok(!hasSet(h, 'Tag'), 'a default property is not bold');
  h.destroy();
});

test('panel description pane (T0.4): selecting a row shows its name + description', () => {
  const h = loadPanel();
  setupComponent(h, {
    id: 'x',
    name: 'btn',
    type: 'System.Windows.Forms.Button',
    properties: [prop('Text', { value: 'hi', sourceExplicit: true, isDefault: false, description: 'The caption of the control.', category: 'A' })],
    events: [],
  });
  h.mouse('mousedown', {}, findPropRow(h, 'Text'));
  eq(h.el('propDesc').querySelector('.pdName').textContent, 'Text', 'description pane shows the property name');
  ok(
    (h.el('propDesc').querySelector('.pdText').textContent || '').indexOf('The caption of the control.') >= 0,
    'description pane shows the DescriptionAttribute text',
  );
  h.destroy();
});

test('panel events tab: switching to Events posts listHandlers once and swaps the pane', () => {
  const h = loadPanel();
  setupComponent(h, {
    id: 'btn',
    name: 'btn',
    type: 'System.Windows.Forms.Button',
    properties: [],
    events: [{ name: 'Click', type: 'System.EventHandler', handler: '', category: 'Action' }],
  });
  h.click(h.el('tabEvents'));
  const lh = only(h.posted, 'listHandlers');
  eq(lh.length, 1, 'listHandlers posted on first Events view');
  eq(lh[0].id, 'btn', 'for the current component');
  ok(h.el('events').style.display !== 'none', 'events pane shown');
  eq(h.el('props').style.display, 'none', 'properties pane hidden');
  h.destroy();
});

test('panel collection editor: the "…" button posts listCollection', () => {
  const h = loadPanel();
  setupComponent(h, {
    id: 'lb',
    name: 'listBox1',
    type: 'System.Windows.Forms.ListBox',
    properties: [
      prop('Items', {
        type: 'System.Windows.Forms.ListBox.ObjectCollection',
        value: '(Collection)',
        isCollection: true,
        collectionItemType: 'System.String',
        category: 'Data',
      }),
    ],
    events: [],
  });
  const btn = findPropRow(h, 'Items').querySelector('button.collectionBtn');
  ok(!!btn, 'the "…" collection button is rendered');
  h.click(btn);
  const lc = only(h.posted, 'listCollection');
  eq(lc.length, 1, 'listCollection posted');
  eq([lc[0].id, lc[0].prop], ['lb', 'Items'], 'targets the control + property');
  h.destroy();
});

test('panel tree editor: "…" lists nodes, the popup renders the recursive forest, add-child + OK posts a nested setTreeNodes', () => {
  const h = loadPanel();
  setupComponent(h, {
    id: 'tv',
    name: 'treeView1',
    type: 'System.Windows.Forms.TreeView',
    properties: [
      prop('Nodes', {
        type: 'System.Windows.Forms.TreeNodeCollection',
        value: '(Collection)',
        isCollection: true,
        collectionItemType: 'System.Windows.Forms.TreeNode',
        category: 'Behavior',
      }),
    ],
    events: [],
  });
  const btn = findPropRow(h, 'Nodes').querySelector('button.collectionBtn');
  ok(!!btn, 'the "…" button is rendered for a TreeView.Nodes collection');
  h.click(btn);
  const lt = only(h.posted, 'listTreeNodes');
  eq(lt.length, 1, 'listTreeNodes posted');
  eq(lt[0].id, 'tv', 'targets the treeview');

  // host replies with a 2-level forest → the recursive popup mounts
  h.resetPosted();
  h.send({
    type: 'treeNodeItems',
    id: 'tv',
    ok: true,
    reason: '',
    nodes: [{ id: 'treeNode1', text: 'Fruits', name: 'nodeFruits', children: [{ id: 'treeNode2', text: 'Apple', name: '', children: [] }] }],
  });
  eq((Array.from(h.document.querySelectorAll('.treeNodeRow')) as any[]).length, 2, 'popup rendered the root + child rows');

  // add a child under the root, name it, OK → nested setTreeNodes with the ephemeral key stripped and empty new id
  h.click((Array.from(h.document.querySelectorAll('.treeNodeRow')) as any[])[0].querySelector('button[title="Add child"]'));
  const rows2 = Array.from(h.document.querySelectorAll('.treeNodeRow')) as any[];
  eq(rows2.length, 3, 'a new child row appeared');
  const newText = rows2[2].querySelector('input.colText');
  newText.value = 'Cherry';
  newText.dispatchEvent(new h.window.Event('input', { bubbles: true }));
  h.click(h.document.querySelector('.collectionOk'));
  const set = only(h.posted, 'setTreeNodes');
  eq(set.length, 1, 'setTreeNodes posted on OK');
  eq(set[0].nodes[0].text, 'Fruits', 'root preserved');
  eq(set[0].nodes[0].children.length, 2, 'root now has 2 children (Apple + the new one)');
  eq([set[0].nodes[0].children[1].text, set[0].nodes[0].children[1].id], ['Cherry', ''], 'new child carries text + an empty id (engine names it)');
  ok(!('_k' in set[0].nodes[0]), 'the ephemeral expand-key is stripped before sending');
  h.destroy();
});

// ================================================================================================================
// RUN
// ================================================================================================================

async function main(): Promise<void> {
  let failures = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  PASS  ${name}`);
    } catch (e) {
      failures++;
      console.log(`  FAIL  ${name}\n        ${(e as Error).message}`);
    } finally {
      // Backstop: close any harness a throwing test left open, so a leaked jsdom window (and its live 250ms
      // nudge timer) can't bleed into later tests. The per-test destroy() is the happy path; this covers throws.
      drainHarnesses();
    }
  }
  console.log(`\n${checks} checks across ${tests.length} tests, ${failures} failed`);
  if (failures) {
    console.log('WEBVIEW E2E RESULT: FAIL');
    process.exit(1);
  }
  console.log('WEBVIEW E2E RESULT: PASS');
}

main();
/* eslint-enable @typescript-eslint/no-explicit-any */
