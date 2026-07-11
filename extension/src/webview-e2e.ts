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

test('strip slots (on-canvas Type Here, Slice A): a layout with toolStripItems draws one .typehereslot per strip at the slot rect (zoom=1)', () => {
  const h = loadDesigner();
  h.send({ type: 'render', png: '', width: 300, height: 100, gen: 0 }); // set hasRendered so overlays draw
  const strip = mkCtrl({ id: 'menuStrip1', type: 'System.Windows.Forms.MenuStrip', x: 8, y: 8, width: 284, height: 24, isStripHost: true });
  h.send({
    type: 'layout',
    controls: [strip],
    toolStripItems: [
      { ownerId: 'menuStrip1', itemId: 'fileMenu', itemType: 'System.Windows.Forms.ToolStripMenuItem', x: 14, y: 10, width: 37, height: 20, isTypeHere: false },
      { ownerId: 'menuStrip1', itemId: '', itemType: '', x: 53, y: 10, width: 66, height: 20, isTypeHere: true },
    ],
  });
  const shown = Array.prototype.filter.call(h.document.querySelectorAll('.typehereslot'), (s: any) => s.style.display !== 'none');
  eq(shown.length, 1, 'exactly one Type-Here slot drawn (the isTypeHere item, NOT the real item)');
  eq(shown[0].style.left, '53px', 'slot left = slot.x × zoom(1)');
  eq(shown[0].style.width, '66px', 'slot width = slot.w × zoom(1)');
  eq(shown[0].textContent, '+', 'slot shows the add glyph');
  // a fresh layout with NO strip items retracts every slot (no stale overlay after e.g. deleting the strip)
  h.send({ type: 'layout', controls: [strip], toolStripItems: [] });
  const stillShown = Array.prototype.filter.call(h.document.querySelectorAll('.typehereslot'), (s: any) => s.style.display !== 'none');
  eq(stillShown.length, 0, 'slots retract when the layout carries no strip items');
  h.destroy();
});

/** Layout a strip host with a real item + a trailing Type-Here slot, and return the visible slot element. */
function setupStripSlot(h: Harness, ownerType: string): any {
  h.send({ type: 'render', png: '', width: 300, height: 100, gen: 0 }); // hasRendered → overlays draw
  const strip = mkCtrl({ id: 'strip1', type: ownerType, x: 8, y: 8, width: 284, height: 24, isStripHost: true });
  h.send({
    type: 'layout',
    controls: [strip],
    toolStripItems: [
      { ownerId: 'strip1', itemId: 'existingItem', itemType: 'System.Windows.Forms.ToolStripButton', x: 10, y: 10, width: 40, height: 20, isTypeHere: false },
      { ownerId: 'strip1', itemId: '', itemType: '', x: 52, y: 10, width: 66, height: 20, isTypeHere: true },
    ],
  });
  h.resetPosted();
  return Array.prototype.filter.call(h.document.querySelectorAll('.typehereslot'), (s: any) => s.style.display !== 'none')[0];
}

test('on-canvas Type Here (Slice B ADD): clicking the slot opens the inline editor; Enter posts a stripAdd with the chosen type + typed text', () => {
  const h = loadDesigner();
  const slot = setupStripSlot(h, 'System.Windows.Forms.MenuStrip');
  ok(!!slot, 'the Type-Here slot is drawn and visible');
  h.click(slot);
  const editor = h.document.querySelector('.slotedit') as any;
  ok(!!editor, 'clicking the slot opens the inline add-editor');
  const sel = editor.querySelector('select.slotEditType') as any;
  const input = editor.querySelector('input.slotEditInput') as any;
  ok(!!sel && !!input, 'the editor has a type <select> and a text <input>');
  eq(sel.options[0].value, 'ToolStripMenuItem', 'a MenuStrip owner defaults the new item to ToolStripMenuItem');
  eq(sel.value, 'ToolStripMenuItem', 'the default type is preselected');
  input.value = 'Help';
  h.key('keydown', { key: 'Enter' }, input);
  const add = only(h.posted, 'stripAdd');
  eq(add.length, 1, 'Enter posts exactly one stripAdd gesture');
  eq([add[0].hostId, add[0].itemType, add[0].text], ['strip1', 'ToolStripMenuItem', 'Help'], 'the gesture carries the owner id, the chosen type, and the typed text');
  eq(add[0].parentItemId, undefined, 'a TOP-LEVEL add carries NO parentItemId (nested-ADD must not leak into the top-level path)');
  ok(!h.document.querySelector('.slotedit'), 'the editor is dismissed after committing');
  h.destroy();
});

test('on-canvas Type Here (Slice B ADD): the type <select> is owner-appropriate and a Separator commits with no text', () => {
  const h = loadDesigner();
  const slot = setupStripSlot(h, 'System.Windows.Forms.ToolStrip');
  h.click(slot);
  const editor = h.document.querySelector('.slotedit') as any;
  const sel = editor.querySelector('select.slotEditType') as any;
  const input = editor.querySelector('input.slotEditInput') as any;
  eq(sel.options[0].value, 'ToolStripButton', 'a ToolStrip owner defaults the new item to ToolStripButton');
  const optionValues = Array.prototype.map.call(sel.options, (o: any) => o.value);
  ok(optionValues.indexOf('ToolStripSeparator') >= 0, 'the toolbar type list offers a Separator');
  // choosing a Separator hides the text field (a separator carries no Text)
  sel.value = 'ToolStripSeparator';
  sel.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  eq(input.style.display, 'none', 'the text input is hidden for a Separator');
  h.key('keydown', { key: 'Enter' }, editor);
  const add = only(h.posted, 'stripAdd');
  eq(add.length, 1, 'Enter posts the separator add');
  eq([add[0].itemType, add[0].text], ['ToolStripSeparator', ''], 'the separator gesture carries the separator type and an empty text');
  h.destroy();
});

test('on-canvas Type Here (Slice B ADD): Escape cancels, and an empty caption commits nothing', () => {
  const h = loadDesigner();
  const slot = setupStripSlot(h, 'System.Windows.Forms.MenuStrip');
  // Escape dismisses without posting
  h.click(slot);
  (h.document.querySelector('input.slotEditInput') as any).value = 'Discarded';
  h.key('keydown', { key: 'Escape' }, h.document.querySelector('.slotedit'));
  eq(only(h.posted, 'stripAdd').length, 0, 'Escape posts nothing');
  ok(!h.document.querySelector('.slotedit'), 'Escape dismisses the editor');
  // an empty (whitespace-only) caption on a non-separator commits nothing
  h.click(slot);
  (h.document.querySelector('input.slotEditInput') as any).value = '   ';
  h.key('keydown', { key: 'Enter' }, h.document.querySelector('.slotedit'));
  eq(only(h.posted, 'stripAdd').length, 0, 'an empty caption adds no item');
  ok(!h.document.querySelector('.slotedit'), 'the editor still dismisses on an empty commit');
  h.destroy();
});

test('on-canvas Type Here (Slice B ADD): a late manip/select push does NOT dismiss the open editor (typed text survives); a layout does (review wf_ca42c504 fix)', () => {
  const h = loadDesigner();
  const slot = setupStripSlot(h, 'System.Windows.Forms.MenuStrip');
  h.send({ type: 'select', id: 'strip1' }); // the strip is the current selection, as right after clicking its body
  h.click(slot);
  const input = h.document.querySelector('input.slotEditInput') as any;
  ok(!!input, 'the editor opened while the strip is selected');
  input.value = 'Draft';
  // the async move/resize-flag push ('manip') that arrives AFTER selecting the strip must NOT eat the typed caption
  h.send({ type: 'manip', id: 'strip1', move: true, resize: false });
  ok(!!h.document.querySelector('.slotedit'), 'a manip push (same id) keeps the editor open');
  eq((h.document.querySelector('input.slotEditInput') as any).value, 'Draft', 'the typed caption survives the manip push');
  // a genuine geometry change (layout) DOES dismiss the (now potentially drifting) editor
  h.send({ type: 'layout', controls: [mkCtrl({ id: 'strip1', type: 'System.Windows.Forms.MenuStrip', isStripHost: true })], toolStripItems: [] });
  ok(!h.document.querySelector('.slotedit'), 'a layout (geometry change) dismisses the editor');
  h.destroy();
});

test('on-canvas Type Here (Slice B ADD): a StatusStrip owner defaults to ToolStripStatusLabel, and a click-away dismisses the editor', () => {
  const h = loadDesigner();
  const slot = setupStripSlot(h, 'System.Windows.Forms.StatusStrip');
  h.click(slot);
  const sel = h.document.querySelector('select.slotEditType') as any;
  eq(sel.options[0].value, 'ToolStripStatusLabel', 'a StatusStrip owner defaults the new item to ToolStripStatusLabel');
  // a mousedown OUTSIDE the editor (click-away, capture-phase document listener) dismisses it without posting
  h.mouse('mousedown', {}, h.el('surface'));
  ok(!h.document.querySelector('.slotedit'), 'a click-away (mousedown outside the editor) dismisses it');
  eq(only(h.posted, 'stripAdd').length, 0, 'click-away commits nothing');
  h.destroy();
});

/** Render + layout a strip host carrying the given item geometry, then clear the posted log. */
function setupStripItems(h: Harness, ownerType: string, items: any[]): void {
  h.send({ type: 'render', png: '', width: 300, height: 100, gen: 0 }); // hasRendered → overlays draw
  const strip = mkCtrl({ id: 'strip1', type: ownerType, x: 8, y: 8, width: 284, height: 24, isStripHost: true });
  h.send({ type: 'layout', controls: [strip], toolStripItems: items });
  h.resetPosted();
}

test('on-canvas item rename (Slice C): double-clicking a top-level item opens the inline editor prefilled with its caption; Enter posts stripRename', () => {
  const h = loadDesigner();
  setupStripItems(h, 'System.Windows.Forms.MenuStrip', [
    { ownerId: 'strip1', itemId: 'fileMenu', itemType: 'System.Windows.Forms.ToolStripMenuItem', text: '&File', x: 14, y: 10, width: 37, height: 20, isTypeHere: false },
    { ownerId: 'strip1', itemId: '', itemType: '', text: '', x: 53, y: 10, width: 66, height: 20, isTypeHere: true },
  ]);
  h.mouse('dblclick', { offsetX: 20, offsetY: 15 }, h.el('surface')); // inside fileMenu (14,10,37,20)
  const editor = h.document.querySelector('.slotedit') as any;
  ok(!!editor, 'double-clicking an item opens the inline rename editor');
  ok(!!editor.querySelector('select.slotEditType'), 'a top-level leaf item’s rename editor offers a type <select> (retype); a text-only edit still renames');
  const input = editor.querySelector('input.slotEditInput') as any;
  ok(!!input, 'the rename editor has a text <input>');
  eq(input.value, '&File', 'the input is prefilled with the item’s live caption');
  input.value = '&Edit';
  h.key('keydown', { key: 'Enter' }, input);
  const ren = only(h.posted, 'stripRename');
  eq(ren.length, 1, 'Enter (type unchanged) posts exactly one stripRename gesture');
  eq([ren[0].hostId, ren[0].itemId, ren[0].text], ['strip1', 'fileMenu', '&Edit'], 'the gesture carries the owner id, the item id, and the new caption');
  ok(!h.document.querySelector('.slotedit'), 'the editor is dismissed after committing');
  h.destroy();
});

test('on-canvas item rename (Slice C): double-clicking a Separator does not open the editor (a separator has no Text)', () => {
  const h = loadDesigner();
  setupStripItems(h, 'System.Windows.Forms.ToolStrip', [
    { ownerId: 'strip1', itemId: 'sep1', itemType: 'System.Windows.Forms.ToolStripSeparator', text: '', x: 14, y: 10, width: 6, height: 20, isTypeHere: false },
    { ownerId: 'strip1', itemId: '', itemType: '', text: '', x: 22, y: 10, width: 66, height: 20, isTypeHere: true },
  ]);
  h.mouse('dblclick', { offsetX: 16, offsetY: 15 }, h.el('surface')); // inside the separator (14,10,6,20)
  ok(!h.document.querySelector('.slotedit'), 'a separator is not renamable → no editor opens');
  eq(only(h.posted, 'stripRename').length, 0, 'nothing is posted for a separator double-click');
  h.destroy();
});

test('on-canvas item rename (Slice C): Escape cancels, and a blank caption commits nothing', () => {
  const h = loadDesigner();
  setupStripItems(h, 'System.Windows.Forms.MenuStrip', [
    { ownerId: 'strip1', itemId: 'fileMenu', itemType: 'System.Windows.Forms.ToolStripMenuItem', text: 'File', x: 14, y: 10, width: 37, height: 20, isTypeHere: false },
    { ownerId: 'strip1', itemId: '', itemType: '', text: '', x: 53, y: 10, width: 66, height: 20, isTypeHere: true },
  ]);
  // Escape dismisses without posting
  h.mouse('dblclick', { offsetX: 20, offsetY: 15 }, h.el('surface'));
  (h.document.querySelector('input.slotEditInput') as any).value = 'Discarded';
  h.key('keydown', { key: 'Escape' }, h.document.querySelector('.slotedit'));
  eq(only(h.posted, 'stripRename').length, 0, 'Escape posts nothing');
  ok(!h.document.querySelector('.slotedit'), 'Escape dismisses the editor');
  // a blank (whitespace-only) caption renames nothing (VS keeps the old text)
  h.mouse('dblclick', { offsetX: 20, offsetY: 15 }, h.el('surface'));
  (h.document.querySelector('input.slotEditInput') as any).value = '   ';
  h.key('keydown', { key: 'Enter' }, h.document.querySelector('.slotedit'));
  eq(only(h.posted, 'stripRename').length, 0, 'a blank caption renames nothing');
  ok(!h.document.querySelector('.slotedit'), 'the editor still dismisses on a blank commit');
  h.destroy();
});

test('on-canvas item rename (Slice C): a late manip push keeps the rename editor open (edited text survives); a layout dismisses it', () => {
  const h = loadDesigner();
  setupStripItems(h, 'System.Windows.Forms.MenuStrip', [
    { ownerId: 'strip1', itemId: 'fileMenu', itemType: 'System.Windows.Forms.ToolStripMenuItem', text: 'File', x: 14, y: 10, width: 37, height: 20, isTypeHere: false },
  ]);
  h.send({ type: 'select', id: 'strip1' }); // the strip is the current selection (as right after clicking its body)
  h.mouse('dblclick', { offsetX: 20, offsetY: 15 }, h.el('surface'));
  const input = h.document.querySelector('input.slotEditInput') as any;
  ok(!!input, 'the rename editor opened');
  input.value = 'Edited';
  h.send({ type: 'manip', id: 'strip1', move: true, resize: false });
  ok(!!h.document.querySelector('.slotedit'), 'a manip push (same id) keeps the rename editor open');
  eq((h.document.querySelector('input.slotEditInput') as any).value, 'Edited', 'the edited caption survives the manip push');
  h.send({ type: 'layout', controls: [mkCtrl({ id: 'strip1', type: 'System.Windows.Forms.MenuStrip', isStripHost: true })], toolStripItems: [] });
  ok(!h.document.querySelector('.slotedit'), 'a layout (geometry change) dismisses the rename editor');
  h.destroy();
});

test('on-canvas item rename (Slice C): opening the editor and pressing Enter WITHOUT editing posts nothing (no silent source mutation on a no-op confirm — review wf_df230de7)', () => {
  const h = loadDesigner();
  setupStripItems(h, 'System.Windows.Forms.ToolStrip', [
    { ownerId: 'strip1', itemId: 'padItem', itemType: 'System.Windows.Forms.ToolStripButton', text: 'Save ', x: 14, y: 10, width: 40, height: 20, isTypeHere: false },
    { ownerId: 'strip1', itemId: '', itemType: '', text: '', x: 56, y: 10, width: 66, height: 20, isTypeHere: true },
  ]);
  h.mouse('dblclick', { offsetX: 20, offsetY: 15 }, h.el('surface')); // inside padItem (14,10,40,20)
  const input = h.document.querySelector('input.slotEditInput') as any;
  eq(input.value, 'Save ', 'the editor prefills the caption verbatim (trailing space preserved)');
  // press Enter with NO edit → the trim would otherwise strip the space and rewrite the source; the dirty-check blocks it
  h.key('keydown', { key: 'Enter' }, input);
  eq(only(h.posted, 'stripRename').length, 0, 'an unedited confirm posts no rename (even though trim would change "Save " → "Save")');
  ok(!h.document.querySelector('.slotedit'), 'the editor still dismisses on the no-op confirm');
  // an ACTUAL edit still posts the (trimmed) new caption
  h.mouse('dblclick', { offsetX: 20, offsetY: 15 }, h.el('surface'));
  (h.document.querySelector('input.slotEditInput') as any).value = 'Store';
  h.key('keydown', { key: 'Enter' }, h.document.querySelector('.slotedit'));
  const ren = only(h.posted, 'stripRename');
  eq(ren.length, 1, 'a real edit posts exactly one stripRename');
  eq(ren[0].text, 'Store', 'the edited caption is posted');
  h.destroy();
});

test('on-canvas retype (Tier 4): a top-level leaf item’s rename editor offers a type <select> prefilled with its (short) type; changing it posts stripRetype, not stripRename', () => {
  const h = loadDesigner();
  setupStripItems(h, 'System.Windows.Forms.ToolStrip', [
    { ownerId: 'strip1', itemId: 'saveBtn', itemType: 'System.Windows.Forms.ToolStripButton', text: 'Save', x: 14, y: 10, width: 40, height: 20, isTypeHere: false },
    { ownerId: 'strip1', itemId: '', itemType: '', text: '', x: 56, y: 10, width: 66, height: 20, isTypeHere: true },
  ]);
  h.mouse('dblclick', { offsetX: 20, offsetY: 15 }, h.el('surface')); // inside saveBtn (14,10,40,20)
  const editor = h.document.querySelector('.slotedit') as any;
  const sel = editor.querySelector('select.slotEditType') as any;
  ok(!!sel, 'a top-level leaf item’s rename editor has a type <select> (retype)');
  eq(sel.value, 'ToolStripButton', 'the select is pre-selected on the item’s current (short) type — an untouched confirm won’t retype');
  sel.value = 'ToolStripLabel';
  h.key('keydown', { key: 'Enter' }, editor.querySelector('input.slotEditInput'));
  const rt = only(h.posted, 'stripRetype');
  eq(rt.length, 1, 'changing the type + Enter posts exactly one stripRetype');
  eq([rt[0].hostId, rt[0].itemId, rt[0].itemType, rt[0].text], ['strip1', 'saveBtn', 'ToolStripLabel', 'Save'], 'stripRetype carries owner, item, the NEW short type, and the carried text');
  eq(only(h.posted, 'stripRename').length, 0, 'no stripRename is posted for a retype');
  h.destroy();
});

test('on-canvas retype: keeping the SAME type but editing the text posts stripRename (not stripRetype)', () => {
  const h = loadDesigner();
  setupStripItems(h, 'System.Windows.Forms.ToolStrip', [
    { ownerId: 'strip1', itemId: 'saveBtn', itemType: 'System.Windows.Forms.ToolStripButton', text: 'Save', x: 14, y: 10, width: 40, height: 20, isTypeHere: false },
  ]);
  h.mouse('dblclick', { offsetX: 20, offsetY: 15 }, h.el('surface'));
  (h.document.querySelector('input.slotEditInput') as any).value = 'Store';
  h.key('keydown', { key: 'Enter' }, h.document.querySelector('.slotedit'));
  eq(only(h.posted, 'stripRetype').length, 0, 'unchanged type → no stripRetype');
  const ren = only(h.posted, 'stripRename');
  eq(ren.length, 1, 'a text-only edit still posts one stripRename');
  eq(ren[0].text, 'Store', 'the new caption is posted');
  h.destroy();
});

test('on-canvas retype: an item WITH a submenu (parent) offers no type <select> (can’t retype a submenu owner)', () => {
  const h = loadDesigner();
  setupStripItems(h, 'System.Windows.Forms.MenuStrip', [
    { ownerId: 'strip1', itemId: 'fileMenu', itemType: 'System.Windows.Forms.ToolStripMenuItem', text: 'File', x: 14, y: 10, width: 37, height: 20, isTypeHere: false,
      children: [{ ownerId: 'strip1', itemId: 'openItem', itemType: 'System.Windows.Forms.ToolStripMenuItem', text: 'Open' }] },
  ]);
  h.mouse('dblclick', { offsetX: 20, offsetY: 15 }, h.el('surface')); // inside fileMenu (a parent)
  const editor = h.document.querySelector('.slotedit') as any;
  ok(!!editor, 'the rename editor still opens for a parent item');
  ok(!editor.querySelector('select.slotEditType'), 'a parent item (has a submenu) offers no retype select');
  h.destroy();
});

test('on-canvas retype: changing the type to Separator posts stripRetype with empty text', () => {
  const h = loadDesigner();
  setupStripItems(h, 'System.Windows.Forms.ToolStrip', [
    { ownerId: 'strip1', itemId: 'saveBtn', itemType: 'System.Windows.Forms.ToolStripButton', text: 'Save', x: 14, y: 10, width: 40, height: 20, isTypeHere: false },
  ]);
  h.mouse('dblclick', { offsetX: 20, offsetY: 15 }, h.el('surface'));
  const editor = h.document.querySelector('.slotedit') as any;
  const sel = editor.querySelector('select.slotEditType') as any;
  sel.value = 'ToolStripSeparator';
  sel.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  h.key('keydown', { key: 'Enter' }, editor.querySelector('input.slotEditInput'));
  const rt = only(h.posted, 'stripRetype');
  eq(rt.length, 1, 'retype to Separator posts stripRetype');
  eq([rt[0].itemType, rt[0].text], ['ToolStripSeparator', ''], 'a separator target carries no text');
  h.destroy();
});

test('on-canvas item select (Slice D): a single click on a top-level item highlights it (a .stripitemsel box at its rect) without selecting the container strip', () => {
  const h = loadDesigner();
  setupStripItems(h, 'System.Windows.Forms.MenuStrip', [
    { ownerId: 'strip1', itemId: 'fileMenu', itemType: 'System.Windows.Forms.ToolStripMenuItem', text: 'File', x: 14, y: 10, width: 37, height: 20, isTypeHere: false },
    { ownerId: 'strip1', itemId: '', itemType: '', text: '', x: 53, y: 10, width: 66, height: 20, isTypeHere: true },
  ]);
  h.mouse('click', { offsetX: 20, offsetY: 15 }, h.el('surface')); // inside fileMenu (14,10,37,20)
  const hl = h.document.querySelector('.stripitemsel') as any;
  ok(!!hl && hl.style.display !== 'none', 'the clicked item is highlighted');
  eq([hl.style.left, hl.style.top, hl.style.width, hl.style.height], ['14px', '10px', '37px', '20px'], 'the highlight box sits on the item rect (zoom=1)');
  eq(only(h.posted, 'pick').length, 0, 'clicking an item does NOT pick the container strip as a control');
  eq(only(h.posted, 'stripAdd').length + only(h.posted, 'stripRename').length + only(h.posted, 'stripDelete').length, 0, 'a plain select posts no mutation');
  h.destroy();
});

test('on-canvas item delete (Slice D): Delete on a selected item posts stripDelete {hostId,itemId}; a separator is deletable too', () => {
  const h = loadDesigner();
  setupStripItems(h, 'System.Windows.Forms.ToolStrip', [
    { ownerId: 'strip1', itemId: 'saveButton', itemType: 'System.Windows.Forms.ToolStripButton', text: 'Save', x: 14, y: 10, width: 40, height: 20, isTypeHere: false },
    { ownerId: 'strip1', itemId: 'sep1', itemType: 'System.Windows.Forms.ToolStripSeparator', text: '', x: 56, y: 10, width: 6, height: 20, isTypeHere: false },
  ]);
  h.mouse('click', { offsetX: 20, offsetY: 15 }, h.el('surface')); // inside saveButton
  h.key('keydown', { key: 'Delete' });
  let del = only(h.posted, 'stripDelete');
  eq(del.length, 1, 'Delete posts exactly one stripDelete');
  eq([del[0].hostId, del[0].itemId], ['strip1', 'saveButton'], 'the gesture carries the owner id and the item id');
  // a separator is not renamable but IS deletable
  h.resetPosted();
  h.mouse('click', { offsetX: 58, offsetY: 15 }, h.el('surface')); // inside sep1 (56,10,6,20)
  h.key('keydown', { key: 'Delete' });
  del = only(h.posted, 'stripDelete');
  eq(del.length, 1, 'a separator is deletable');
  eq(del[0].itemId, 'sep1', 'the separator delete carries its id');
  h.destroy();
});

test('on-canvas item rename (Slice D): F2 on a selected item opens the inline editor prefilled; F2 on a separator does nothing', () => {
  const h = loadDesigner();
  setupStripItems(h, 'System.Windows.Forms.MenuStrip', [
    { ownerId: 'strip1', itemId: 'fileMenu', itemType: 'System.Windows.Forms.ToolStripMenuItem', text: '&File', x: 14, y: 10, width: 37, height: 20, isTypeHere: false },
    { ownerId: 'strip1', itemId: 'sep1', itemType: 'System.Windows.Forms.ToolStripSeparator', text: '', x: 53, y: 10, width: 6, height: 20, isTypeHere: false },
  ]);
  h.mouse('click', { offsetX: 20, offsetY: 15 }, h.el('surface')); // select fileMenu
  h.key('keydown', { key: 'F2' });
  const editor = h.document.querySelector('.slotedit') as any;
  ok(!!editor, 'F2 opens the inline rename editor for the selected item');
  ok(!!editor.querySelector('select.slotEditType'), 'a top-level leaf item’s F2 editor offers a retype type <select>');
  eq((editor.querySelector('input.slotEditInput') as any).value, '&File', 'the editor is prefilled with the item’s caption');
  h.key('keydown', { key: 'Escape' }, editor);
  // F2 on a separator does nothing (no Text to rename)
  h.mouse('click', { offsetX: 55, offsetY: 15 }, h.el('surface')); // select sep1 (53,10,6,20)
  h.key('keydown', { key: 'F2' });
  ok(!h.document.querySelector('.slotedit'), 'F2 on a separator opens no editor');
  h.destroy();
});

test('on-canvas item menu (Slice D): right-clicking an item selects it and shows Rename + Delete Item; Delete Item posts stripDelete', () => {
  const h = loadDesigner();
  setupStripItems(h, 'System.Windows.Forms.MenuStrip', [
    { ownerId: 'strip1', itemId: 'fileMenu', itemType: 'System.Windows.Forms.ToolStripMenuItem', text: 'File', x: 14, y: 10, width: 37, height: 20, isTypeHere: false },
  ]);
  h.mouse('contextmenu', { clientX: 20, clientY: 15, button: 2 }, h.el('surfaceWrap')); // default canvas rect (0,0) → px=clientX
  ok(h.el('ctxMenu').className.indexOf('open') >= 0, 'the item context menu opened');
  ok((h.document.querySelector('.stripitemsel') as any)?.style.display !== 'none', 'right-click selected (highlighted) the item');
  eq(only(h.posted, 'pick').length, 0, 'the item menu does not pick the strip as a control');
  ok(!!findMenuItem(h, 'ctxMenu', 'designer.menu.renameItem'), 'the menu offers Rename');
  const delItem = findMenuItem(h, 'ctxMenu', 'designer.menu.deleteItem');
  ok(!!delItem, 'the menu offers Delete Item');
  h.click(delItem);
  const del = only(h.posted, 'stripDelete');
  eq(del.length, 1, 'clicking Delete Item posts one stripDelete');
  eq([del[0].hostId, del[0].itemId], ['strip1', 'fileMenu'], 'Delete Item carries the owner + item id');
  h.destroy();
});

test('on-canvas item select (Slice D): selecting a control clears the item highlight (and Delete then targets the control, not the item)', () => {
  const h = loadDesigner();
  setupStripItems(h, 'System.Windows.Forms.MenuStrip', [
    { ownerId: 'strip1', itemId: 'fileMenu', itemType: 'System.Windows.Forms.ToolStripMenuItem', text: 'File', x: 14, y: 10, width: 37, height: 20, isTypeHere: false },
  ]);
  h.mouse('click', { offsetX: 20, offsetY: 15 }, h.el('surface')); // select the item
  ok((h.document.querySelector('.stripitemsel') as any)?.style.display !== 'none', 'the item is highlighted');
  // a host control-selection supersedes the item highlight
  h.send({ type: 'select', id: 'strip1' });
  eq((h.document.querySelector('.stripitemsel') as any).style.display, 'none', 'a host select clears the item highlight');
  h.send({ type: 'manip', id: 'strip1', move: false, resize: false });
  h.key('keydown', { key: 'Delete' });
  eq(only(h.posted, 'stripDelete').length, 0, 'with the item deselected, Delete no longer posts a stripDelete');
  h.destroy();
});

test('on-canvas item select (Slice D): an item that vanishes from a fresh layout drops the highlight (and Delete becomes a no-op)', () => {
  const h = loadDesigner();
  setupStripItems(h, 'System.Windows.Forms.ToolStrip', [
    { ownerId: 'strip1', itemId: 'saveButton', itemType: 'System.Windows.Forms.ToolStripButton', text: 'Save', x: 14, y: 10, width: 40, height: 20, isTypeHere: false },
  ]);
  h.mouse('click', { offsetX: 20, offsetY: 15 }, h.el('surface'));
  ok((h.document.querySelector('.stripitemsel') as any)?.style.display !== 'none', 'the item is highlighted');
  // a re-render whose layout no longer carries the item (e.g. it was just deleted) must clear the selection
  h.send({ type: 'layout', controls: [mkCtrl({ id: 'strip1', type: 'System.Windows.Forms.ToolStrip', isStripHost: true })], toolStripItems: [] });
  eq((h.document.querySelector('.stripitemsel') as any).style.display, 'none', 'the highlight is dropped when the item is gone');
  h.resetPosted();
  h.key('keydown', { key: 'Delete' });
  eq(only(h.posted, 'stripDelete').length, 0, 'Delete posts nothing once the selected item vanished');
  h.destroy();
});

test('on-canvas item select (Slice D): an anonymous item (empty itemId) is NOT selectable — click/right-click fall through to the container strip (review wf_108a7dbe)', () => {
  const h = loadDesigner();
  setupStripItems(h, 'System.Windows.Forms.StatusStrip', [
    // an item with no designer field (e.g. statusStrip1.Items.Add("Ready")) — real, painted, but has no resolvable id
    { ownerId: 'strip1', itemId: '', itemType: 'System.Windows.Forms.ToolStripStatusLabel', text: 'Ready', x: 14, y: 10, width: 40, height: 20, isTypeHere: false },
  ]);
  // a plain click on the anonymous item must NOT highlight it — it selects the container strip instead (no dead zone)
  h.mouse('click', { offsetX: 20, offsetY: 15 }, h.el('surface'));
  eq((h.document.querySelector('.stripitemsel') as any)?.style.display ?? 'none', 'none', 'an anonymous item is not highlighted');
  eq(only(h.posted, 'pick')[0]?.id, 'strip1', 'the click falls through to selecting the container strip');
  // a right-click on the anonymous item must build the CONTROL menu (Properties, NOT the Rename/Delete-Item menu) — so
  // the earlier wrong-target delete (a stale item/control selection surviving under a control menu) can't happen
  h.resetPosted();
  h.mouse('contextmenu', { clientX: 20, clientY: 15, button: 2 }, h.el('surfaceWrap'));
  ok(!findMenuItem(h, 'ctxMenu', 'designer.menu.deleteItem'), 'no "Delete Item" — the anonymous item did not become the item selection');
  ok(!!findMenuItem(h, 'ctxMenu', 'designer.menu.properties'), 'the control menu is shown for the strip under the cursor');
  eq((h.document.querySelector('.stripitemsel') as any)?.style.display ?? 'none', 'none', 'still no item highlight after the right-click');
  h.destroy();
});

test('on-canvas item rename (Slice D): a bare re-render layout (item still present, no trailing select) KEEPS the item highlighted — the host suppresses reselect for item ops (review wf_108a7dbe)', () => {
  const h = loadDesigner();
  setupStripItems(h, 'System.Windows.Forms.MenuStrip', [
    { ownerId: 'strip1', itemId: 'fileMenu', itemType: 'System.Windows.Forms.ToolStripMenuItem', text: 'File', x: 14, y: 10, width: 37, height: 20, isTypeHere: false },
  ]);
  h.mouse('click', { offsetX: 20, offsetY: 15 }, h.el('surface')); // select fileMenu
  ok((h.document.querySelector('.stripitemsel') as any)?.style.display !== 'none', 'the item is highlighted');
  // the host's on-canvas rename commit re-renders (render+layout, NO trailing pushSelect thanks to skipReselect); the
  // renamed item is still present → the highlight must survive so a follow-up F2/Delete still targets it
  h.send({ type: 'layout', controls: [mkCtrl({ id: 'strip1', type: 'System.Windows.Forms.MenuStrip', isStripHost: true })], toolStripItems: [
    { ownerId: 'strip1', itemId: 'fileMenu', itemType: 'System.Windows.Forms.ToolStripMenuItem', text: 'Files', x: 14, y: 10, width: 40, height: 20, isTypeHere: false },
  ] });
  const hl = h.document.querySelector('.stripitemsel') as any;
  ok(hl && hl.style.display !== 'none', 'the item stays highlighted across the item-op re-render (no snap to the container)');
  eq(hl.style.width, '40px', 'the highlight tracks the renamed item’s new geometry');
  // Delete now still targets the item, not a stale control
  h.key('keydown', { key: 'Delete' });
  const del = only(h.posted, 'stripDelete');
  eq(del.length, 1, 'Delete still targets the item after the re-render');
  eq(del[0].itemId, 'fileMenu', 'the delete carries the re-resolved item id');
  h.destroy();
});

/** Count the currently-visible synthetic-flyout level boxes. */
function visibleFlyouts(h: Harness): any[] {
  return Array.prototype.filter.call(h.document.querySelectorAll('.stripflyout'), (b: any) => b.style.display !== 'none');
}

test('on-canvas nested flyout: clicking a top-level item with children opens a synthetic submenu; a leaf-child click posts selectItem with the CHILD id', () => {
  const h = loadDesigner();
  setupStripItems(h, 'System.Windows.Forms.MenuStrip', [
    {
      ownerId: 'strip1', itemId: 'fileMenu', itemType: 'System.Windows.Forms.ToolStripMenuItem', text: 'File', x: 14, y: 10, width: 37, height: 20, isTypeHere: false,
      children: [
        { ownerId: 'strip1', itemId: 'openItem', itemType: 'System.Windows.Forms.ToolStripMenuItem', text: 'Open', children: [] },
        { ownerId: 'strip1', itemId: 'sepItem', itemType: 'System.Windows.Forms.ToolStripSeparator', text: '', children: [] },
        { ownerId: 'strip1', itemId: 'saveItem', itemType: 'System.Windows.Forms.ToolStripMenuItem', text: 'Save', children: [] },
      ],
    },
    { ownerId: 'strip1', itemId: 'editMenu', itemType: 'System.Windows.Forms.ToolStripMenuItem', text: 'Edit', x: 55, y: 10, width: 39, height: 20, isTypeHere: false, children: [] },
  ]);
  h.mouse('click', { offsetX: 20, offsetY: 15 }, h.el('surface')); // click File (14,10,37,20)
  const boxes = visibleFlyouts(h);
  eq(boxes.length, 1, 'a single submenu level opens');
  eq(boxes[0].querySelectorAll('.stripflyoutrow').length, 2, 'two selectable rows (Open, Save) — the separator is not a row');
  eq(boxes[0].querySelectorAll('.stripflyoutsep').length, 1, 'the separator child renders as a divider');
  const selWhenOpened = only(h.posted, 'selectItem');
  eq(selWhenOpened.length, 1, 'opening File also selects the top-level item (its own props load)');
  eq(selWhenOpened[0].itemId, 'fileMenu', 'the open posts the top-level id');
  h.resetPosted();
  const saveRow = Array.prototype.find.call(boxes[0].querySelectorAll('.stripflyoutrow'), (r: any) => r.textContent.indexOf('Save') >= 0);
  h.click(saveRow);
  const sel = only(h.posted, 'selectItem');
  eq(sel.length, 1, 'clicking a child posts exactly one selectItem');
  eq([sel[0].hostId, sel[0].itemId], ['strip1', 'saveItem'], 'the child selectItem carries the strip host + the CHILD id (nested item→Properties)');
  const selRow = visibleFlyouts(h)[0].querySelector('.stripflyoutrow.sel');
  ok(!!selRow && selRow.textContent.indexOf('Save') >= 0, 'the selected child row is highlighted, flyout stays open');
  eq((h.document.querySelector('.stripitemsel') as any)?.style.display ?? 'none', 'none', 'the top-level highlight is dropped — a nested selection is not the Del/F2 target');
  h.destroy();
});

test('on-canvas nested flyout: a child that itself has children opens a nested level; clicking the grandchild posts selectItem with the deepest id', () => {
  const h = loadDesigner();
  setupStripItems(h, 'System.Windows.Forms.MenuStrip', [
    {
      ownerId: 'strip1', itemId: 'fileMenu', itemType: 'System.Windows.Forms.ToolStripMenuItem', text: 'File', x: 14, y: 10, width: 37, height: 20, isTypeHere: false,
      children: [
        {
          ownerId: 'strip1', itemId: 'recentMenu', itemType: 'System.Windows.Forms.ToolStripMenuItem', text: 'Recent',
          children: [{ ownerId: 'strip1', itemId: 'doc1Item', itemType: 'System.Windows.Forms.ToolStripMenuItem', text: 'Doc1', children: [] }],
        },
      ],
    },
  ]);
  h.mouse('click', { offsetX: 20, offsetY: 15 }, h.el('surface')); // open File
  h.resetPosted();
  const recentRow = visibleFlyouts(h)[0].querySelector('.stripflyoutrow');
  ok(!!recentRow.querySelector('.stripflyoutarrow'), 'a parent row shows a submenu arrow');
  h.click(recentRow);
  eq(visibleFlyouts(h).length, 2, 'clicking a parent child opens a second (nested) level');
  eq(only(h.posted, 'selectItem')[0].itemId, 'recentMenu', 'clicking the parent also selects it (a submenu parent has its own props)');
  h.resetPosted();
  const doc1Row = visibleFlyouts(h)[1].querySelector('.stripflyoutrow');
  h.click(doc1Row);
  eq(only(h.posted, 'selectItem')[0].itemId, 'doc1Item', 'clicking the grandchild selects the deepest nested item');
  h.destroy();
});

test('on-canvas nested flyout: a childless item opens no flyout; a control selection and a fresh layout each dismiss an open flyout', () => {
  const h = loadDesigner();
  setupStripItems(h, 'System.Windows.Forms.MenuStrip', [
    {
      ownerId: 'strip1', itemId: 'fileMenu', itemType: 'System.Windows.Forms.ToolStripMenuItem', text: 'File', x: 14, y: 10, width: 37, height: 20, isTypeHere: false,
      children: [{ ownerId: 'strip1', itemId: 'openItem', itemType: 'System.Windows.Forms.ToolStripMenuItem', text: 'Open', children: [] }],
    },
    { ownerId: 'strip1', itemId: 'helpMenu', itemType: 'System.Windows.Forms.ToolStripMenuItem', text: 'Help', x: 55, y: 10, width: 39, height: 20, isTypeHere: false, children: [] },
  ]);
  h.mouse('click', { offsetX: 60, offsetY: 15 }, h.el('surface')); // Help (55,10,39,20) — no children
  eq(visibleFlyouts(h).length, 0, 'a childless item opens no flyout');
  h.mouse('click', { offsetX: 20, offsetY: 15 }, h.el('surface')); // File — opens
  eq(visibleFlyouts(h).length, 1, 'File opens a flyout');
  h.send({ type: 'select', id: 'strip1' }); // a host control-selection supersedes the flyout
  eq(visibleFlyouts(h).length, 0, 'a control selection closes the flyout');
  h.mouse('click', { offsetX: 20, offsetY: 15 }, h.el('surface')); // re-open
  eq(visibleFlyouts(h).length, 1, 're-opened');
  h.send({ type: 'layout', controls: [mkCtrl({ id: 'strip1', type: 'System.Windows.Forms.MenuStrip', isStripHost: true })], toolStripItems: [] });
  eq(visibleFlyouts(h).length, 0, 'a fresh layout (geometry may have moved) closes the flyout');
  h.destroy();
});

test('on-canvas nested flyout: an anonymous nested child (empty itemId) renders a row but a click posts NO selectItem', () => {
  const h = loadDesigner();
  setupStripItems(h, 'System.Windows.Forms.MenuStrip', [
    {
      ownerId: 'strip1', itemId: 'fileMenu', itemType: 'System.Windows.Forms.ToolStripMenuItem', text: 'File', x: 14, y: 10, width: 37, height: 20, isTypeHere: false,
      children: [
        { ownerId: 'strip1', itemId: '', itemType: 'System.Windows.Forms.ToolStripMenuItem', text: 'Ad-hoc', children: [] }, // e.g. DropDownItems.Add("Ad-hoc") — no field
        { ownerId: 'strip1', itemId: 'openItem', itemType: 'System.Windows.Forms.ToolStripMenuItem', text: 'Open', children: [] },
      ],
    },
  ]);
  h.mouse('click', { offsetX: 20, offsetY: 15 }, h.el('surface')); // open File
  h.resetPosted();
  const rows = visibleFlyouts(h)[0].querySelectorAll('.stripflyoutrow');
  eq(rows.length, 2, 'both children (incl. the anonymous one) render as rows');
  const anon = Array.prototype.find.call(rows, (r: any) => r.textContent.indexOf('Ad-hoc') >= 0);
  h.click(anon);
  eq(only(h.posted, 'selectItem').length, 0, 'clicking an anonymous nested item (no field id) posts no selectItem — it can’t be resolved');
  h.resetPosted();
  const openRow = Array.prototype.find.call(rows, (r: any) => r.textContent.indexOf('Open') >= 0);
  h.click(openRow);
  eq(only(h.posted, 'selectItem')[0]?.itemId, 'openItem', 'a sibling with a real id still selects normally');
  h.destroy();
});

/** A MenuStrip whose editMenu → [undoItem, ───, redoItem] gives nested rename/delete + a nested separator to test. */
function setupNestedMenu(h: Harness): void {
  setupStripItems(h, 'System.Windows.Forms.MenuStrip', [
    {
      ownerId: 'strip1', itemId: 'editMenu', itemType: 'System.Windows.Forms.ToolStripMenuItem', text: 'Edit', x: 14, y: 10, width: 39, height: 20, isTypeHere: false,
      children: [
        { ownerId: 'strip1', itemId: 'undoItem', itemType: 'System.Windows.Forms.ToolStripMenuItem', text: 'Undo', children: [] },
        { ownerId: 'strip1', itemId: 'nestedSep', itemType: 'System.Windows.Forms.ToolStripSeparator', text: '', children: [] },
        { ownerId: 'strip1', itemId: 'redoItem', itemType: 'System.Windows.Forms.ToolStripMenuItem', text: 'Redo', children: [] },
      ],
    },
  ]);
  h.mouse('click', { offsetX: 20, offsetY: 15 }, h.el('surface')); // open Edit → flyout
}
function flyoutRow(h: Harness, level: number, caption: string): any {
  return Array.prototype.find.call(visibleFlyouts(h)[level].querySelectorAll('.stripflyoutrow'), (r: any) => r.textContent.indexOf(caption) >= 0);
}

test('on-canvas overflow (Tier 4): a full strip emits an overflow chevron (overflow=true) + no Type-Here; clicking it opens a synthetic flyout of the overflow items, and a row click posts selectItem (top-level item op)', () => {
  const h = loadDesigner();
  setupStripItems(h, 'System.Windows.Forms.ToolStrip', [
    { ownerId: 'strip1', itemId: 'btnOne', itemType: 'System.Windows.Forms.ToolStripButton', text: 'One', x: 14, y: 10, width: 40, height: 20, isTypeHere: false, children: [] },
    { ownerId: 'strip1', itemId: '', itemType: 'System.Windows.Forms.ToolStripOverflowButton', text: '', x: 60, y: 10, width: 16, height: 20, isTypeHere: false, overflow: true, children: [
      { ownerId: 'strip1', itemId: 'btnTwo', itemType: 'System.Windows.Forms.ToolStripButton', text: 'Two', children: [] },
      { ownerId: 'strip1', itemId: 'btnThree', itemType: 'System.Windows.Forms.ToolStripButton', text: 'Three', children: [] },
    ] },
  ]);
  // a full (overflowing) strip carries no trailing Type-Here slot in the geometry → the canvas draws none
  eq(Array.prototype.filter.call(h.document.querySelectorAll('.typehereslot'), (s: any) => s.style.display !== 'none').length, 0, 'no Type Here add-slot is drawn for an overflowing strip');
  h.mouse('click', { offsetX: 64, offsetY: 15 }, h.el('surface')); // inside the chevron (60,10,16,20)
  const flyout = visibleFlyouts(h)[0];
  ok(!!flyout, 'clicking the overflow chevron opens a synthetic flyout');
  const rows = flyout.querySelectorAll('.stripflyoutrow');
  eq(rows.length, 2, 'the flyout lists the two overflow items (Two, Three)');
  ok(!flyout.querySelector('.stripflyouttypehere'), 'the overflow flyout offers no Type-Here add-slot (a full strip is widened to add)');
  eq(only(h.posted, 'pick').length, 0, 'clicking the chevron does NOT select the strip as a control');
  const twoRow = Array.prototype.find.call(rows, (r: any) => r.textContent.indexOf('Two') >= 0) as any;
  h.click(twoRow);
  const sel = only(h.posted, 'selectItem');
  ok(sel.length >= 1, 'clicking an overflow row selects that item');
  eq([sel[0].hostId, sel[0].itemId], ['strip1', 'btnTwo'], 'an overflow item is a normal top-level item op (owner strip + item id)');
  h.destroy();
});

test('on-canvas overflow: the overflow chevron rect is NOT treated as a renamable item (no field id) — a dblclick on it opens no editor', () => {
  const h = loadDesigner();
  setupStripItems(h, 'System.Windows.Forms.ToolStrip', [
    { ownerId: 'strip1', itemId: '', itemType: 'System.Windows.Forms.ToolStripOverflowButton', text: '', x: 60, y: 10, width: 16, height: 20, isTypeHere: false, overflow: true, children: [
      { ownerId: 'strip1', itemId: 'btnTwo', itemType: 'System.Windows.Forms.ToolStripButton', text: 'Two', children: [] },
    ] },
  ]);
  h.mouse('dblclick', { offsetX: 64, offsetY: 15 }, h.el('surface')); // on the chevron
  ok(!h.document.querySelector('.slotedit'), 'the chevron is not renamable (stripItemHit skips it) — no inline editor opens');
  h.destroy();
});

test('on-canvas overflow retype (codex review): F2 on an OVERFLOW row (a chevron child, still a top-level item) opens the rename editor WITH a type <select>', () => {
  const h = loadDesigner();
  setupStripItems(h, 'System.Windows.Forms.ToolStrip', [
    { ownerId: 'strip1', itemId: '', itemType: 'System.Windows.Forms.ToolStripOverflowButton', text: '', x: 60, y: 10, width: 16, height: 20, isTypeHere: false, overflow: true, children: [
      { ownerId: 'strip1', itemId: 'ovfBtn', itemType: 'System.Windows.Forms.ToolStripButton', text: 'Two', children: [] },
    ] },
  ]);
  h.mouse('click', { offsetX: 64, offsetY: 15 }, h.el('surface')); // open the overflow flyout
  const row = Array.prototype.find.call(visibleFlyouts(h)[0].querySelectorAll('.stripflyoutrow'), (r: any) => r.textContent.indexOf('Two') >= 0) as any;
  h.click(row); // select the overflow row
  h.key('keydown', { key: 'F2' }); // F2 → rename editor
  const editor = h.document.querySelector('.slotedit') as any;
  ok(!!editor, 'F2 on an overflow row opens the rename editor');
  ok(!!editor.querySelector('select.slotEditType'), 'an overflow item (top-level, childless) offers a retype <select> too');
  h.destroy();
});

test('on-canvas retype (codex review): a type-only change carries the caption VERBATIM (no trim — data-loss guard)', () => {
  const h = loadDesigner();
  setupStripItems(h, 'System.Windows.Forms.ToolStrip', [
    { ownerId: 'strip1', itemId: 'padBtn', itemType: 'System.Windows.Forms.ToolStripButton', text: '  Save  ', x: 14, y: 10, width: 50, height: 20, isTypeHere: false },
  ]);
  h.mouse('dblclick', { offsetX: 20, offsetY: 15 }, h.el('surface'));
  const editor = h.document.querySelector('.slotedit') as any;
  (editor.querySelector('select.slotEditType') as any).value = 'ToolStripLabel'; // change ONLY the type, do not touch the input
  h.key('keydown', { key: 'Enter' }, editor.querySelector('input.slotEditInput'));
  const rt = only(h.posted, 'stripRetype');
  eq(rt.length, 1, 'a type-only change posts stripRetype');
  eq(rt[0].text, '  Save  ', 'the padded caption is carried verbatim (not trimmed to "Save")');
  h.destroy();
});

test('auto-reopen (overflow deeper — codex review): a nested add inside an overflowed item’s submenu arms an "overflow" reopen with a path; the flyout re-opens to the deep level', () => {
  const h = loadDesigner();
  const chevron = (kids: any[]): any => ({ ownerId: 'strip1', itemId: '', itemType: 'System.Windows.Forms.ToolStripOverflowButton', text: '', x: 60, y: 10, width: 16, height: 20, isTypeHere: false, overflow: true, children: kids });
  setupStripItems(h, 'System.Windows.Forms.ToolStrip', [
    chevron([
      { ownerId: 'strip1', itemId: 'ddBtn', itemType: 'System.Windows.Forms.ToolStripDropDownButton', text: 'More', children: [
        { ownerId: 'strip1', itemId: 'subA', itemType: 'System.Windows.Forms.ToolStripMenuItem', text: 'A', children: [] },
      ] },
    ]),
  ]);
  h.mouse('click', { offsetX: 64, offsetY: 15 }, h.el('surface')); // open the overflow flyout (level 0)
  h.click(Array.prototype.find.call(visibleFlyouts(h)[0].querySelectorAll('.stripflyoutrow'), (r: any) => r.textContent.indexOf('More') >= 0)); // open ddBtn's submenu (level 1)
  eq(visibleFlyouts(h).length, 2, 'the overflowed item’s submenu opened');
  h.click(visibleFlyouts(h)[1].querySelector('.stripflyouttypehere')); // Type-Here at level 1
  const input = h.document.querySelector('.slotedit input.slotEditInput') as any;
  input.value = 'B';
  h.key('keydown', { key: 'Enter' }, input);
  const add = only(h.posted, 'stripAdd').pop() as any;
  eq(add.parentItemId, 'ddBtn', 'the nested add targets the overflowed dropdown');
  ok(typeof add.reopenToken === 'number', 'a deeper add inside an overflow flyout NOW arms a reopen (the overflow-root gap is closed)');
  // host commits → fresh layout with the grown chevron (ddBtn now has A + B), then the token-matched stripAddDone
  const strip = mkCtrl({ id: 'strip1', type: 'System.Windows.Forms.ToolStrip', x: 8, y: 8, width: 284, height: 24, isStripHost: true });
  h.send({ type: 'layout', controls: [strip], toolStripItems: [chevron([
    { ownerId: 'strip1', itemId: 'ddBtn', itemType: 'System.Windows.Forms.ToolStripDropDownButton', text: 'More', children: [
      { ownerId: 'strip1', itemId: 'subA', itemType: 'System.Windows.Forms.ToolStripMenuItem', text: 'A', children: [] },
      { ownerId: 'strip1', itemId: 'subB', itemType: 'System.Windows.Forms.ToolStripMenuItem', text: 'B', children: [] },
    ] },
  ])] });
  h.send({ type: 'stripAddDone', token: add.reopenToken, ok: true });
  const boxes = visibleFlyouts(h);
  eq(boxes.length, 2, 'the overflow flyout re-opened to the deep level (root + ddBtn’s submenu)');
  ok(Array.from(boxes[1].querySelectorAll('.stripflyoutrow')).some((r: any) => r.textContent.indexOf('B') >= 0), 'the new nested item B is visible in the re-opened deep level');
  h.destroy();
});

test('on-canvas nested edit: selecting a nested row then Delete posts stripDelete keyed by the OWNER strip + the nested id', () => {
  const h = loadDesigner();
  setupNestedMenu(h);
  h.click(flyoutRow(h, 0, 'Undo')); // select the nested undoItem (its props load; it becomes the Del/F2 target)
  h.resetPosted();
  h.key('keydown', { key: 'Delete' });
  const sd = only(h.posted, 'stripDelete');
  eq(sd.length, 1, 'Delete on a selected nested row posts exactly one stripDelete');
  eq([sd[0].hostId, sd[0].itemId], ['strip1', 'undoItem'], 'the delete carries the OWNER strip host + the NESTED id (host recurses)');
  eq(only(h.posted, 'removeControl').length, 0, 'no control delete fires — a nested item is not a control');
  h.destroy();
});

test('on-canvas nested edit: F2 on a selected nested row opens the inline editor prefilled with its caption; Enter posts stripRename with the nested id', () => {
  const h = loadDesigner();
  setupNestedMenu(h);
  h.click(flyoutRow(h, 0, 'Redo'));
  h.resetPosted();
  h.key('keydown', { key: 'F2' });
  const editor = h.document.querySelector('.slotedit') as any;
  ok(!!editor, 'F2 opens the inline rename editor for the nested item');
  const input = editor.querySelector('input.slotEditInput') as any;
  eq(input.value, 'Redo', 'the editor is prefilled with the nested item’s live caption');
  ok(!editor.querySelector('select.slotEditType'), 'a NESTED item offers no retype <select> (retype is top-level-only — nested items aren’t in the top-level geometry)');
  input.value = 'Repeat';
  h.key('keydown', { key: 'Enter' }, input);
  const ren = only(h.posted, 'stripRename');
  eq(ren.length, 1, 'Enter posts exactly one stripRename gesture');
  eq([ren[0].hostId, ren[0].itemId, ren[0].text], ['strip1', 'redoItem', 'Repeat'], 'the rename carries the owner strip, the nested id, and the new caption');
  ok(!h.document.querySelector('.slotedit'), 'the editor is dismissed after committing');
  h.destroy();
});

test('on-canvas nested edit: double-clicking a nested row opens the rename editor prefilled with its caption', () => {
  const h = loadDesigner();
  setupNestedMenu(h);
  h.resetPosted();
  h.mouse('dblclick', {}, flyoutRow(h, 0, 'Undo'));
  const editor = h.document.querySelector('.slotedit') as any;
  ok(!!editor, 'a nested double-click opens the rename editor');
  eq((editor.querySelector('input.slotEditInput') as any).value, 'Undo', 'prefilled with the nested caption');
  h.destroy();
});

test('on-canvas nested edit: right-clicking a nested row opens a Rename/Delete Item menu; Delete Item posts stripDelete even after the flyout dismisses (build-time capture)', () => {
  const h = loadDesigner();
  setupNestedMenu(h);
  const undoRow = flyoutRow(h, 0, 'Undo');
  h.resetPosted();
  h.mouse('contextmenu', { clientX: 10, clientY: 40, button: 2 }, undoRow);
  ok(h.el('ctxMenu').className.indexOf('open') >= 0, 'the focused item menu opened');
  ok(!!findMenuItem(h, 'ctxMenu', 'designer.menu.renameItem'), 'the nested menu offers Rename');
  const del = findMenuItem(h, 'ctxMenu', 'designer.menu.deleteItem');
  ok(!!del, 'the nested menu offers Delete Item');
  eq(only(h.posted, 'selectItem')[0]?.itemId, 'undoItem', 'the right-click also selected the nested item (its props load)');
  // The real sequence: a mousedown on the menu item is treated as click-away by the flyout's capture-phase doc listener,
  // which closes the flyout and clears the LIVE selection BEFORE the click action runs. The menu closures captured the
  // descriptor at build time, so the delete still fires with the right id (a live-read closure would post nothing).
  h.mouse('mousedown', {}, del);
  eq(visibleFlyouts(h).length, 0, 'the menu-item mousedown dismissed the flyout (and cleared the live selection)');
  h.resetPosted();
  h.click(del);
  const sd = only(h.posted, 'stripDelete');
  eq(sd.length, 1, 'Delete Item posts one stripDelete despite the flyout having closed');
  eq([sd[0].hostId, sd[0].itemId], ['strip1', 'undoItem'], 'the delete carries the owner strip + the NESTED id from the captured descriptor');
  h.destroy();
});

test('on-canvas nested edit: a nested separator is inert (no rename on F2, no right-click menu) and a nested selection never leaks into a control delete', () => {
  const h = loadDesigner();
  setupNestedMenu(h);
  const sepRow = visibleFlyouts(h)[0].querySelector('.stripflyoutsep');
  h.resetPosted();
  h.mouse('contextmenu', { clientX: 10, clientY: 40, button: 2 }, sepRow); // a separator is not a row → no menu
  ok(h.el('ctxMenu').className.indexOf('open') < 0, 'right-clicking a nested separator opens no item menu');
  // select the separator’s sibling, then a control mousedown dismisses the flyout (capture-phase doc listener) and
  // clears the nested target — a following Delete must hit the control, not the vanished nested item.
  h.click(flyoutRow(h, 0, 'Undo'));
  h.send({ type: 'layout', controls: [mkCtrl({ id: 'button1' }), mkCtrl({ id: 'strip1', type: 'System.Windows.Forms.MenuStrip', isStripHost: true })] });
  eq(visibleFlyouts(h).length, 0, 'a fresh layout closed the flyout');
  h.send({ type: 'select', id: 'button1' });
  h.send({ type: 'manip', id: 'button1', move: true, resize: true });
  h.resetPosted();
  h.key('keydown', { key: 'Delete' });
  eq(only(h.posted, 'stripDelete').length, 0, 'no stale nested stripDelete after the flyout dismissed');
  eq(only(h.posted, 'removeControl')[0]?.id, 'button1', 'Delete now targets the selected control');
  h.destroy();
});

test('on-canvas nested edit: a select-click updates the nested highlight IN PLACE (preserves the row element) so a dblclick can fire', () => {
  const h = loadDesigner();
  setupNestedMenu(h);
  const undoRow = flyoutRow(h, 0, 'Undo');
  h.click(undoRow); // a selection-only click must NOT rebuild the flyout (a rebuilt row would break Chromium's dblclick)
  const afterClick = flyoutRow(h, 0, 'Undo');
  ok(afterClick === undoRow, 'the same row element survives a select-click (in-place highlight, not a full rebuild)');
  ok(afterClick.className.indexOf('sel') >= 0, 'the clicked row is highlighted');
  ok((h.document.querySelector('.stripflyoutrow.sel') as any) === undoRow, 'exactly the clicked row carries the .sel highlight');
  h.destroy();
});

test('on-canvas nested edit: right-click → Rename opens the inline editor prefilled AND anchored at the row, even after the flyout dismisses (build-time capture + stored anchor)', () => {
  const h = loadDesigner();
  setupNestedMenu(h);
  // stub geometry so the anchor is non-zero (jsdom's getBoundingClientRect returns 0 — the anchor logic would be untested)
  const wrap = h.el('surfaceWrap') as any;
  wrap.getBoundingClientRect = () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON() {} });
  const redoRow = flyoutRow(h, 0, 'Redo') as any;
  redoRow.getBoundingClientRect = () => ({ left: 120, top: 60, right: 288, bottom: 82, width: 168, height: 22, x: 120, y: 60, toJSON() {} });
  h.resetPosted();
  h.mouse('contextmenu', { clientX: 130, clientY: 65, button: 2 }, redoRow); // selects + measures anchor (ax=120, ay=60)
  const ren = findMenuItem(h, 'ctxMenu', 'designer.menu.renameItem');
  ok(!!ren, 'the nested menu offers Rename');
  h.mouse('mousedown', {}, ren); // the flyout dismisses here (capture-phase doc mousedown) → the live submenuSel is cleared
  eq(visibleFlyouts(h).length, 0, 'the menu-item mousedown dismissed the flyout');
  h.click(ren);
  const editor = h.document.querySelector('.slotedit') as any;
  ok(!!editor, 'Rename opens the inline editor from the captured descriptor despite the cleared live selection');
  eq((editor.querySelector('input.slotEditInput') as any).value, 'Redo', 'the editor is prefilled with the captured nested caption');
  eq([editor.style.left, editor.style.top], ['120px', '60px'], 'the editor is anchored at the row’s stored surface coords (survives the flyout close)');
  h.destroy();
});

test('on-canvas nested ADD ("Type Here" in a submenu): an open level shows a trailing add-slot; clicking it opens the add-editor with the MENU type set; Enter posts stripAdd into the owner submenu', () => {
  const h = loadDesigner();
  setupNestedMenu(h); // opens editMenu → [Undo, ───, Redo]; the open level's owner item is editMenu
  const slot = visibleFlyouts(h)[0].querySelector('.stripflyouttypehere') as any;
  ok(!!slot, 'the open submenu level shows a trailing Type-Here add-slot');
  ok(slot.textContent.length > 0, 'the slot carries a caption (the localized "Type Here")');
  h.resetPosted();
  h.click(slot);
  const editor = h.document.querySelector('.slotedit') as any;
  ok(!!editor, 'clicking the nested slot opens the inline add-editor');
  eq(visibleFlyouts(h).length, 0, 'opening the editor closes the flyout (the editor floats at the captured slot anchor)');
  const sel = editor.querySelector('select.slotEditType') as any;
  ok(!!sel, 'the nested add-editor has a type <select>');
  const types = Array.prototype.map.call(sel.options, (o: any) => o.value);
  eq(types[0], 'ToolStripMenuItem', 'a submenu slot defaults to a menu item');
  ok(types.indexOf('ToolStripSeparator') >= 0 && types.indexOf('ToolStripButton') < 0, 'the type list is the MENU set (no toolbar-only ToolStripButton)');
  const input = editor.querySelector('input.slotEditInput') as any;
  input.value = 'Find';
  h.key('keydown', { key: 'Enter' }, input);
  const add = only(h.posted, 'stripAdd');
  eq(add.length, 1, 'Enter posts exactly one stripAdd');
  eq([add[0].hostId, add[0].itemType, add[0].text, add[0].parentItemId], ['strip1', 'ToolStripMenuItem', 'Find', 'editMenu'],
    'the nested add carries the OWNER strip host, the chosen type, the text, and the submenu PARENT id');
  ok(!h.document.querySelector('.slotedit'), 'the editor dismisses after committing');
  h.destroy();
});

test('on-canvas nested ADD: a Separator commits with no text (still keyed by the parent id); an empty caption / Escape cancels', () => {
  const h = loadDesigner();
  setupNestedMenu(h);
  h.click(visibleFlyouts(h)[0].querySelector('.stripflyouttypehere'));
  let editor = h.document.querySelector('.slotedit') as any;
  const sel = editor.querySelector('select.slotEditType') as any;
  sel.value = 'ToolStripSeparator';
  sel.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  eq((editor.querySelector('input.slotEditInput') as any).style.display, 'none', 'the text input hides for a Separator');
  h.resetPosted();
  h.key('keydown', { key: 'Enter' }, editor);
  const add = only(h.posted, 'stripAdd');
  eq(add.length, 1, 'a nested separator commits an add');
  eq([add[0].itemType, add[0].text, add[0].parentItemId], ['ToolStripSeparator', '', 'editMenu'], 'the separator carries no text and the submenu parent id');
  // re-open the flyout + slot and cancel two ways (Escape, empty caption) — nothing posts
  h.resetPosted();
  h.mouse('click', { offsetX: 20, offsetY: 15 }, h.el('surface')); // re-open editMenu
  h.click(visibleFlyouts(h)[0].querySelector('.stripflyouttypehere'));
  (h.document.querySelector('input.slotEditInput') as any).value = 'Discarded';
  h.key('keydown', { key: 'Escape' }, h.document.querySelector('.slotedit'));
  eq(only(h.posted, 'stripAdd').length, 0, 'Escape on a nested add posts nothing');
  h.mouse('click', { offsetX: 20, offsetY: 15 }, h.el('surface')); // re-open again
  h.click(visibleFlyouts(h)[0].querySelector('.stripflyouttypehere'));
  (h.document.querySelector('input.slotEditInput') as any).value = '   ';
  h.key('keydown', { key: 'Enter' }, h.document.querySelector('.slotedit'));
  eq(only(h.posted, 'stripAdd').length, 0, 'a whitespace-only nested caption adds nothing');
  h.destroy();
});

test('on-canvas nested ADD: a DEEPER submenu level’s add-slot is keyed by that nested parent id (not the top-level one)', () => {
  const h = loadDesigner();
  setupStripItems(h, 'System.Windows.Forms.MenuStrip', [
    {
      ownerId: 'strip1', itemId: 'fileMenu', itemType: 'System.Windows.Forms.ToolStripMenuItem', text: 'File', x: 14, y: 10, width: 37, height: 20, isTypeHere: false,
      children: [
        {
          ownerId: 'strip1', itemId: 'recentMenu', itemType: 'System.Windows.Forms.ToolStripMenuItem', text: 'Recent',
          children: [{ ownerId: 'strip1', itemId: 'doc1Item', itemType: 'System.Windows.Forms.ToolStripMenuItem', text: 'Doc1', children: [] }],
        },
      ],
    },
  ]);
  h.mouse('click', { offsetX: 20, offsetY: 15 }, h.el('surface')); // open File (level 0, owner fileMenu)
  h.click(visibleFlyouts(h)[0].querySelector('.stripflyoutrow'));   // click Recent → opens level 1 (owner recentMenu)
  eq(visibleFlyouts(h).length, 2, 'a nested level opened');
  const l0slot = visibleFlyouts(h)[0].querySelector('.stripflyouttypehere') as any;
  const l1slot = visibleFlyouts(h)[1].querySelector('.stripflyouttypehere') as any;
  ok(!!l0slot && !!l1slot, 'both open levels show their own add-slot');
  h.resetPosted();
  h.click(l1slot);
  (h.document.querySelector('input.slotEditInput') as any).value = 'Doc2';
  h.key('keydown', { key: 'Enter' }, h.document.querySelector('.slotedit'));
  const add = only(h.posted, 'stripAdd');
  eq(add.length, 1, 'the deeper slot posts one stripAdd');
  eq([add[0].hostId, add[0].parentItemId], ['strip1', 'recentMenu'], 'the deeper add targets the NESTED parent (recentMenu), keyed by the top-level strip host');
  h.destroy();
});

test('on-canvas nested ADD: opening the add-editor drops the parent selection so a later Delete cannot delete the PARENT menu (review wf_192f24c8)', () => {
  const h = loadDesigner();
  setupNestedMenu(h); // clicking Edit selected editMenu (selectedItem) AND opened its flyout
  ok((h.document.querySelector('.stripitemsel') as any)?.style.display !== 'none', 'the parent (editMenu) is selected + highlighted while the flyout is open');
  h.click(visibleFlyouts(h)[0].querySelector('.stripflyouttypehere')); // open the nested add-editor
  ok(!!h.document.querySelector('.slotedit'), 'the nested add-editor is open');
  eq((h.document.querySelector('.stripitemsel') as any)?.style.display ?? 'none', 'none', 'the parent selection/highlight is dropped when the add-editor opens (an add has no delete target)');
  // dismiss the editor, then a Delete must post NOTHING — before the fix selectedItem still pointed at editMenu, so the
  // toolbar Delete (not activeElement-guarded) would delete the parent menu + its whole subtree while the user meant to add
  h.key('keydown', { key: 'Escape' }, h.document.querySelector('.slotedit'));
  ok(!h.document.querySelector('.slotedit'), 'Escape dismissed the add-editor');
  h.resetPosted();
  h.key('keydown', { key: 'Delete' });
  eq(only(h.posted, 'stripDelete').length, 0, 'no stripDelete — the parent menu is not deleted by a Delete after the add-editor closes');
  h.destroy();
});

test('on-canvas nested ADD: the add-editor is anchored at the slot’s measured surface coords (measured before the flyout closes)', () => {
  const h = loadDesigner();
  setupNestedMenu(h);
  const wrap = h.el('surfaceWrap') as any;
  wrap.getBoundingClientRect = () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON() {} });
  const slot = visibleFlyouts(h)[0].querySelector('.stripflyouttypehere') as any;
  slot.getBoundingClientRect = () => ({ left: 96, top: 84, right: 264, bottom: 106, width: 168, height: 22, x: 96, y: 84, toJSON() {} });
  h.click(slot);
  const editor = h.document.querySelector('.slotedit') as any;
  ok(!!editor, 'the add-editor opened');
  eq(visibleFlyouts(h).length, 0, 'the flyout closed (the anchor was captured before the close)');
  eq([editor.style.left, editor.style.top], ['96px', '84px'], 'the editor floats at the slot’s measured surface coords');
  h.destroy();
});

test('on-canvas nested ADD: a submenu level owned by an ANONYMOUS parent (no field id) shows NO add-slot (a dead splice target is never offered)', () => {
  const h = loadDesigner();
  setupStripItems(h, 'System.Windows.Forms.MenuStrip', [
    {
      ownerId: 'strip1', itemId: 'fileMenu', itemType: 'System.Windows.Forms.ToolStripMenuItem', text: 'File', x: 14, y: 10, width: 37, height: 20, isTypeHere: false,
      children: [
        // an anonymous submenu parent (e.g. a DropDownItems.Add(...) with no field) that itself has a child
        { ownerId: 'strip1', itemId: '', itemType: 'System.Windows.Forms.ToolStripMenuItem', text: 'Ad-hoc', children: [{ ownerId: 'strip1', itemId: 'kidItem', itemType: 'System.Windows.Forms.ToolStripMenuItem', text: 'Kid', children: [] }] },
      ],
    },
  ]);
  h.mouse('click', { offsetX: 20, offsetY: 15 }, h.el('surface')); // open File (level 0, owner fileMenu → HAS a slot)
  ok(!!visibleFlyouts(h)[0].querySelector('.stripflyouttypehere'), 'the field-backed top level (fileMenu) does show a slot');
  h.click(visibleFlyouts(h)[0].querySelector('.stripflyoutrow')); // click the anonymous "Ad-hoc" row → opens its level
  eq(visibleFlyouts(h).length, 2, 'the anonymous parent still opens a nested level (its child is shown)');
  eq(visibleFlyouts(h)[1].querySelector('.stripflyouttypehere'), null, 'but that level offers NO add-slot — its owner has no splice id');
  h.destroy();
});

// ---- off-tree ContextMenuStrip: its items reached via a synthetic flyout opened from the TRAY chip ----------------

/** Put a component tray on the surface, including one off-tree ContextMenuStrip with its item forest. Returns the
 *  rendered chip elements (index 0 = the strip). */
function setupTrayStrip(h: Harness, trayItems: any[]): any[] {
  h.send({ type: 'render', png: '', width: 300, height: 100, gen: 0 });
  h.send({ type: 'layout', controls: [mkCtrl({ id: 'panel1', type: 'System.Windows.Forms.Panel' })], toolStripItems: [] });
  h.send({ type: 'tray', items: trayItems });
  h.resetPosted();
  return Array.from(h.el('tray').querySelectorAll('.trayItem'));
}
/** A ContextMenuStrip tray descriptor with cutItem/pasteItem (Paste has an Options submenu when withSub). */
function ctxTray(withSub = false): any {
  const paste: any = { ownerId: 'contextMenuStrip1', itemId: 'pasteItem', itemType: 'System.Windows.Forms.ToolStripMenuItem', text: 'Paste', children: [] };
  if (withSub) paste.children = [{ ownerId: 'contextMenuStrip1', itemId: 'optItem', itemType: 'System.Windows.Forms.ToolStripMenuItem', text: 'Options', children: [] }];
  return {
    id: 'contextMenuStrip1', name: 'contextMenuStrip1', type: 'System.Windows.Forms.ContextMenuStrip', isStrip: true,
    items: [
      { ownerId: 'contextMenuStrip1', itemId: 'cutItem', itemType: 'System.Windows.Forms.ToolStripMenuItem', text: 'Cut', children: [] },
      paste,
    ],
  };
}

test('off-tree ContextMenuStrip (tray): clicking its chip opens a synthetic flyout of its top-level items; the pick→select echo does NOT close it; a row click posts selectItem with the strip host + item id', () => {
  const h = loadDesigner();
  const chips = setupTrayStrip(h, [ctxTray(), { id: 'timer1', name: 'timer1', type: 'System.Windows.Forms.Timer' }]);
  h.click(chips[0]); // click the ContextMenuStrip chip
  eq(only(h.posted, 'pick').map((m) => m.id), ['contextMenuStrip1'], 'the chip click still selects the strip (its own props load)');
  const boxes = visibleFlyouts(h);
  eq(boxes.length, 1, 'a single flyout level opens for the off-tree strip');
  eq(boxes[0].querySelectorAll('.stripflyoutrow').length, 2, 'both top-level items (Cut, Paste) render as rows');
  // the host echoes a `select` for the strip in response to `pick` — it must NOT snap the just-opened flyout shut
  h.send({ type: 'select', id: 'contextMenuStrip1' });
  eq(visibleFlyouts(h).length, 1, 'the select echo for the OWNING strip keeps the flyout open');
  h.resetPosted();
  const cutRow = Array.prototype.find.call(visibleFlyouts(h)[0].querySelectorAll('.stripflyoutrow'), (r: any) => r.textContent.indexOf('Cut') >= 0);
  h.click(cutRow);
  const sel = only(h.posted, 'selectItem');
  eq(sel.length, 1, 'clicking an item posts exactly one selectItem');
  eq([sel[0].hostId, sel[0].itemId], ['contextMenuStrip1', 'cutItem'], 'the selectItem carries the strip host + the item id (item→Properties on an off-tree strip)');
  h.destroy();
});

test('off-tree ContextMenuStrip (tray): the ROOT flyout level shows a "Type Here" slot; it uses the MENU type set; Enter posts a TOP-LEVEL stripAdd (no parentItemId) keyed by the strip', () => {
  const h = loadDesigner();
  const chips = setupTrayStrip(h, [ctxTray()]);
  h.click(chips[0]);
  const slot = visibleFlyouts(h)[0].querySelector('.stripflyouttypehere') as any;
  ok(!!slot, 'the off-tree strip’s ROOT level offers a top-level "Type Here" add-slot (isStripRoot)');
  h.click(slot);
  const editor = h.document.querySelector('.slotedit') as any;
  ok(!!editor, 'the add-editor opens');
  const opts = Array.prototype.map.call(editor.querySelectorAll('select.slotEditType option'), (o: any) => o.value);
  ok(opts.indexOf('ToolStripMenuItem') >= 0, 'the type set is the MENU set (a ContextMenuStrip holds menu items)');
  ok(opts.indexOf('ToolStripButton') < 0, 'the toolbar-only ToolStripButton is NOT offered for a ContextMenuStrip');
  const input = editor.querySelector('input.slotEditInput') as any;
  input.value = 'Copy';
  h.key('keydown', { key: 'Enter' }, input);
  const add = only(h.posted, 'stripAdd');
  eq(add.length, 1, 'Enter posts one stripAdd');
  eq([add[0].hostId, add[0].text], ['contextMenuStrip1', 'Copy'], 'the add is keyed by the ContextMenuStrip with the typed caption');
  eq(add[0].parentItemId, undefined, 'a ROOT-level add carries NO parentItemId (it appends to the strip’s TOP level, not a submenu)');
  h.destroy();
});

test('off-tree ContextMenuStrip (tray): a nested submenu opens a deeper level whose add-slot IS keyed by the nested parent; a root row renames/deletes keyed by the strip', () => {
  const h = loadDesigner();
  const chips = setupTrayStrip(h, [ctxTray(true)]); // Paste has an Options submenu
  h.click(chips[0]);
  const pasteRow = Array.prototype.find.call(visibleFlyouts(h)[0].querySelectorAll('.stripflyoutrow'), (r: any) => r.textContent.indexOf('Paste') >= 0);
  ok(!!pasteRow.querySelector('.stripflyoutarrow'), 'the Paste row shows a submenu arrow');
  h.click(pasteRow); // opens the nested level (owner pasteItem)
  eq(visibleFlyouts(h).length, 2, 'clicking the parent opens a nested level');
  const l1slot = visibleFlyouts(h)[1].querySelector('.stripflyouttypehere') as any;
  ok(!!l1slot, 'the nested level offers its own add-slot');
  h.click(l1slot);
  h.document.querySelector('.slotedit input.slotEditInput').value = 'Deep';
  h.key('keydown', { key: 'Enter' }, h.document.querySelector('.slotedit input.slotEditInput'));
  const nestedAdd = only(h.posted, 'stripAdd').pop();
  eq([nestedAdd.hostId, nestedAdd.parentItemId], ['contextMenuStrip1', 'pasteItem'], 'a NESTED add is keyed by the strip host + the nested parent id (grows pasteItem.DropDownItems)');
  h.resetPosted();
  // select a ROOT row and delete it → stripDelete keyed by the strip
  h.click(chips[0]); // re-open (the add commit closed the flyout in real life; here just re-open cleanly)
  const cutRow = Array.prototype.find.call(visibleFlyouts(h)[0].querySelectorAll('.stripflyoutrow'), (r: any) => r.textContent.indexOf('Cut') >= 0);
  h.click(cutRow);          // select cutItem (submenuSel)
  h.key('keydown', { key: 'Delete' });
  const del = only(h.posted, 'stripDelete');
  eq(del.length, 1, 'Delete on a selected root row posts stripDelete');
  eq([del[0].hostId, del[0].itemId], ['contextMenuStrip1', 'cutItem'], 'the delete is keyed by the strip host + the item id');
  h.destroy();
});

test('off-tree ContextMenuStrip (tray): a non-strip chip (Timer, no items) opens NO flyout; a select for a DIFFERENT control closes an open tray-strip flyout', () => {
  const h = loadDesigner();
  const chips = setupTrayStrip(h, [ctxTray(), { id: 'timer1', name: 'timer1', type: 'System.Windows.Forms.Timer' }]);
  h.click(chips[1]); // the Timer chip — no items
  eq(visibleFlyouts(h).length, 0, 'a non-strip tray chip opens no flyout');
  const chips2 = Array.from(h.el('tray').querySelectorAll('.trayItem')) as any[];
  h.click(chips2[0]); // open the ContextMenuStrip flyout
  eq(visibleFlyouts(h).length, 1, 'the strip chip opens the flyout');
  h.send({ type: 'select', id: 'panel1' }); // selecting a DIFFERENT control supersedes the flyout
  eq(visibleFlyouts(h).length, 0, 'a select for another control closes the tray-strip flyout');
  h.destroy();
});

test('off-tree ContextMenuStrip (tray): a STALE select echo for a previously-clicked strip does not close the flyout now open for a DIFFERENT strip (rapid chip-to-chip switch)', () => {
  const h = loadDesigner();
  const stripA = ctxTray(); stripA.id = 'ctxA'; stripA.name = 'ctxA'; stripA.items.forEach((it: any) => (it.ownerId = 'ctxA'));
  const stripB = ctxTray(); stripB.id = 'ctxB'; stripB.name = 'ctxB'; stripB.items.forEach((it: any) => (it.ownerId = 'ctxB'));
  const chips = setupTrayStrip(h, [stripA, stripB]);
  h.click(chips[0]); // open A's flyout
  const chips2 = Array.from(h.el('tray').querySelectorAll('.trayItem')) as any[];
  h.click(chips2[1]); // rapidly switch to B (mousedown closed A, click opened B)
  eq(visibleFlyouts(h).length, 1, 'B’s flyout is open after the switch');
  // now the STALE pick→select echo for A arrives (host processed pick A before pick B) — it must NOT close B’s flyout
  h.send({ type: 'select', id: 'ctxA' });
  eq(visibleFlyouts(h).length, 1, 'the stale select for the PREVIOUS strip leaves B’s flyout open (findTray guard, not exact-owner)');
  h.destroy();
});

test('off-tree ContextMenuStrip (tray): the flyout anchors at the VISIBLE surface top-left — the stage→surfaceWrap mapping (not the 8px zero-rect fallback)', () => {
  const h = loadDesigner();
  const chips = setupTrayStrip(h, [ctxTray()]);
  // simulate a scrolled surface: surfaceWrap's top-left is left/above the stage's visible top-left. The flyout must
  // anchor at the VISIBLE top-left (stage) mapped into surfaceWrap surface coords + the inset, NOT the form's (0,0).
  const rect = (left: number, top: number): any => ({ left, top, right: left, bottom: top, width: 0, height: 0, x: left, y: top, toJSON() {} });
  (h.el('surfaceWrap') as any).getBoundingClientRect = () => rect(0, 0);
  (h.el('stage') as any).getBoundingClientRect = () => rect(40, 24); // stage visible top-left is 40,24 into the wrap
  h.click(chips[0]);
  const box = visibleFlyouts(h)[0];
  // ax = max(8, (40-0)/1 + 8) = 48; ay = max(8, (24-0)/1 + 8) = 32 (zoom 1). If the mapping regressed to the zero-rect
  // fallback the box would sit at 8px/8px — this asserts the real formula runs.
  eq([box.style.left, box.style.top], ['48px', '32px'], 'the flyout anchors at the mapped visible top-left + inset, not the (8,8) fallback');
  h.destroy();
});

test('off-tree ContextMenuStrip (tray): the flyout anchor divides the stage→wrap offset by zoom — at 2× the box moves by the SCALED surface offset, not raw display px (codex — zoom transform coverage)', () => {
  const h = loadDesigner();
  setupTrayStrip(h, [ctxTray()]);
  h.click(h.el('zoomIn')); h.click(h.el('zoomIn')); h.click(h.el('zoomIn')); h.click(h.el('zoomIn')); // 1 → 1.1 → 1.25 → 1.5 → 2
  eq(h.state.zoom, 2, 'four zoomIn steps land exactly on 2× (guards the fixture, not the product)');
  const rect = (left: number, top: number): any => ({ left, top, right: left, bottom: top, width: 0, height: 0, x: left, y: top, toJSON() {} });
  (h.el('surfaceWrap') as any).getBoundingClientRect = () => rect(0, 0);
  (h.el('stage') as any).getBoundingClientRect = () => rect(40, 24);
  const chips2 = Array.from(h.el('tray').querySelectorAll('.trayItem')) as any[];
  h.click(chips2[0]);
  const box = visibleFlyouts(h)[0];
  // ax = max(8, (40-0)/2 + 8) = 28 surface px; box.left = ax × zoom = 56px.  ay = max(8, (24-0)/2 + 8) = 20; box.top = 40px.
  // If the `/zoom` were dropped, ax = max(8, 40+8) = 48 and box.left = 96px — this asserts the divide-then-remultiply runs.
  eq([box.style.left, box.style.top], ['56px', '40px'], 'the anchor scales the visible-offset by 1/zoom before re-multiplying by zoom — not raw display px');
  h.destroy();
});

test('off-tree ContextMenuStrip (tray): opening the ROOT add-editor disarms Delete so the strip echo (while the editor is open) cannot remove the whole ContextMenuStrip (review wf_6b3ffa70 + codex token correlation)', () => {
  const h = loadDesigner();
  const chips = setupTrayStrip(h, [ctxTray()]);
  h.click(chips[0]); // selects contextMenuStrip1 as the CONTROL AND opens the flyout; posts pick(strip, token)
  const tok = (only(h.posted, 'pick').slice(-1)[0] as any).token; // the chip pick's correlation token
  h.click(visibleFlyouts(h)[0].querySelector('.stripflyouttypehere')); // open the ROOT "Type Here" add-editor
  ok(!!h.document.querySelector('.slotedit'), 'the root add-editor is open');
  // before the fix, openSlotEditor cleared only selectedItem, leaving the strip as the selected CONTROL — the toolbar
  // Delete (not activeElement-guarded) would then removeControl(the whole ContextMenuStrip). openSlotEditor now clears
  // selection/current AND arms suppression of the strip's OWN pick echo BY ITS TOKEN. Inject that exact echo (same token)
  // while the editor is open — it must not restore selection=[strip] and re-arm the Delete.
  h.send({ type: 'select', id: 'contextMenuStrip1', token: tok });
  ok(!!h.document.querySelector('.slotedit'), 'the strip echo leaves the add-editor open');
  h.key('keydown', { key: 'Escape' }, h.document.querySelector('.slotedit'));
  ok(!h.document.querySelector('.slotedit'), 'Escape dismissed the add-editor');
  h.resetPosted();
  h.key('keydown', { key: 'Delete' });
  eq(only(h.posted, 'removeControl').length, 0, 'no removeControl — the add-editor disarmed the strip Delete and its own echo (matched by token) did not re-arm it');
  eq(only(h.posted, 'removeControls').length, 0, 'and no multi-remove either');
  h.destroy();
});

test('off-tree ContextMenuStrip (tray): the strip echo arriving AFTER the add-editor is dismissed still cannot re-arm Delete — matched by token, not editor lifetime (codex P1 — late echo)', () => {
  const h = loadDesigner();
  const chips = setupTrayStrip(h, [ctxTray()]);
  h.click(chips[0]);
  const tok = (only(h.posted, 'pick').slice(-1)[0] as any).token;
  h.click(visibleFlyouts(h)[0].querySelector('.stripflyouttypehere')); // arms suppression for THIS pick's token
  ok(!!h.document.querySelector('.slotedit'), 'the root add-editor is open');
  h.key('keydown', { key: 'Escape' }, h.document.querySelector('.slotedit'));
  ok(!h.document.querySelector('.slotedit'), 'Escape dismissed the add-editor FIRST');
  // the slow chip echo lands NOW, after the editor closed. A `!slotEditEl` lifetime guard (null by now) would restore
  // selection=[strip] and re-arm Delete; token correlation still matches this exact echo, so the strip stays unselected.
  h.send({ type: 'select', id: 'contextMenuStrip1', token: tok });
  h.resetPosted();
  h.key('keydown', { key: 'Delete' });
  eq(only(h.posted, 'removeControl').length, 0, 'no removeControl — the LATE echo, matched by token, did not re-arm the strip Delete');
  eq(only(h.posted, 'removeControls').length, 0, 'and no multi-remove either');
  h.destroy();
});

test('off-tree ContextMenuStrip (tray): a DIFFERENT control’s (token-less) select applies while the editor is open, and a later delayed strip echo does NOT overwrite it (codex P2 + "B then delayed A")', () => {
  const h = loadDesigner();
  const chips = setupTrayStrip(h, [ctxTray()]);
  h.click(chips[0]); // pick(strip, tok)
  const tok = (only(h.posted, 'pick').slice(-1)[0] as any).token;
  h.click(visibleFlyouts(h)[0].querySelector('.stripflyouttypehere')); // arms suppression for the strip's tok
  ok(!!h.document.querySelector('.slotedit'), 'the root add-editor is open');
  // panel1 is picked in the Properties outline (another webview) — a host-authoritative select with NO token → applies.
  h.send({ type: 'select', id: 'panel1' });
  // the strip's OWN delayed echo lands AFTER → suppressed by token, so it cannot overwrite panel1 and re-arm the strip Delete.
  h.send({ type: 'select', id: 'contextMenuStrip1', token: tok });
  h.key('keydown', { key: 'Escape' }, h.document.querySelector('.slotedit')); // close the (now orphaned) editor
  h.resetPosted();
  h.key('keydown', { key: 'Delete' });
  eq(only(h.posted, 'removeControl')[0]?.id, 'panel1', 'panel1 was applied and NOT overwritten by the delayed strip echo → Delete targets panel1');
  h.destroy();
});

test('off-tree ContextMenuStrip (tray): a `layout` (net48 live edit / skipReselect render — no trailing select) between the add-editor and the delayed strip echo does NOT disarm the token suppression (codex — layout-disarm)', () => {
  const h = loadDesigner();
  const chips = setupTrayStrip(h, [ctxTray()]);
  h.click(chips[0]);
  const tok = (only(h.posted, 'pick').slice(-1)[0] as any).token;
  h.click(visibleFlyouts(h)[0].querySelector('.stripflyouttypehere')); // arms suppression for tok
  h.key('keydown', { key: 'Escape' }, h.document.querySelector('.slotedit'));
  // an authoritative re-render (e.g. a net48 live property edit, or a skipReselect ToolStrip commit) posts a `layout`
  // with NO trailing `select`. Treating that as proof the pending echo is obsolete would re-open the P1 hole, so the
  // token arm must survive a `layout`.
  h.send({ type: 'layout', controls: [], toolStripItems: [] });
  h.send({ type: 'select', id: 'contextMenuStrip1', token: tok }); // the delayed echo, AFTER the layout
  h.resetPosted();
  h.key('keydown', { key: 'Delete' });
  eq(only(h.posted, 'removeControl').length, 0, 'no removeControl — the intervening layout did not disarm the token suppression');
  h.destroy();
});

test('off-tree ContextMenuStrip (tray): when the strip echo already arrived BEFORE the add-editor opened, a later genuine re-select of the SAME strip is NOT swallowed (codex — same-owner leak)', () => {
  const h = loadDesigner();
  const chips = setupTrayStrip(h, [ctxTray()]);
  h.click(chips[0]); // pick(strip, tok)
  const tok = (only(h.posted, 'pick').slice(-1)[0] as any).token;
  h.send({ type: 'select', id: 'contextMenuStrip1', token: tok }); // the echo arrives promptly → retires the pending pick
  h.click(visibleFlyouts(h)[0].querySelector('.stripflyouttypehere')); // NOW open the add-editor: no pending pick → arms nothing
  h.key('keydown', { key: 'Escape' }, h.document.querySelector('.slotedit'));
  // the user genuinely re-selects the ContextMenuStrip (a fresh pick / a host select). An id-only suppression would have
  // wrongly swallowed this same-owner select; token correlation does not — this is a real selection, so it applies.
  h.send({ type: 'select', id: 'contextMenuStrip1' });
  h.resetPosted();
  h.key('keydown', { key: 'Delete' });
  eq(only(h.posted, 'removeControl')[0]?.id, 'contextMenuStrip1', 'the genuine re-select applied → Delete targets the strip (the same-owner select was NOT swallowed)');
  h.destroy();
});

test('off-tree ContextMenuStrip (tray): opening a SECOND strip’s add-editor before the FIRST strip’s echo returns keeps BOTH arms — the first strip’s delayed echo cannot re-arm its Delete (codex — multi-editor / cross-strip race)', () => {
  const h = loadDesigner();
  const stripA = ctxTray(); stripA.id = 'ctxA'; stripA.name = 'ctxA'; stripA.items.forEach((it: any) => (it.ownerId = 'ctxA'));
  const stripB = ctxTray(); stripB.id = 'ctxB'; stripB.name = 'ctxB'; stripB.items.forEach((it: any) => (it.ownerId = 'ctxB'));
  const chips = setupTrayStrip(h, [stripA, stripB]);
  h.click(chips[0]); // pick(ctxA, tokA) — echo NOT delivered yet
  const tokA = (only(h.posted, 'pick').filter((m: any) => m.id === 'ctxA').slice(-1)[0] as any).token;
  h.click(visibleFlyouts(h)[0].querySelector('.stripflyouttypehere')); // open A's add-editor → arms tokA
  h.key('keydown', { key: 'Escape' }, h.document.querySelector('.slotedit')); // cancel A's editor (tokA still armed, echo pending)
  const chips2 = Array.from(h.el('tray').querySelectorAll('.trayItem')) as any[];
  h.click(chips2[1]); // pick(ctxB, tokB) — opens B's flyout
  const tokB = (only(h.posted, 'pick').filter((m: any) => m.id === 'ctxB').slice(-1)[0] as any).token;
  h.click(visibleFlyouts(h)[0].querySelector('.stripflyouttypehere')); // open B's add-editor → arms tokB; a SCALAR would drop tokA here
  h.key('keydown', { key: 'Escape' }, h.document.querySelector('.slotedit')); // cancel B's editor
  ok(tokA !== tokB, 'the two picks carry distinct tokens');
  // NOW A's long-delayed echo finally lands. A scalar arm (overwritten by tokB) would select ctxA and re-arm its Delete;
  // the SET still holds tokA → suppressed.
  h.send({ type: 'select', id: 'ctxA', token: tokA });
  h.resetPosted();
  h.key('keydown', { key: 'Delete' });
  eq(only(h.posted, 'removeControl').length, 0, 'no removeControl — the first strip’s delayed echo stayed suppressed (the SET kept tokA when tokB armed)');
  eq(only(h.posted, 'removeControls').length, 0, 'and no multi-remove either');
  h.destroy();
});

test('off-tree ContextMenuStrip (tray): cancel+reopen the SAME strip’s add-editor before its first echo returns — the first delayed echo still cannot re-arm Delete (codex — re-entrant editor)', () => {
  const h = loadDesigner();
  const chips = setupTrayStrip(h, [ctxTray()]);
  h.click(chips[0]); // pick(strip, tok1)
  const tok1 = (only(h.posted, 'pick').slice(-1)[0] as any).token;
  h.click(visibleFlyouts(h)[0].querySelector('.stripflyouttypehere')); // open editor → arms tok1
  h.key('keydown', { key: 'Escape' }, h.document.querySelector('.slotedit')); // cancel
  const chips2 = Array.from(h.el('tray').querySelectorAll('.trayItem')) as any[];
  h.click(chips2[0]); // re-pick the SAME chip → pick(strip, tok2), reopens the flyout
  const tok2 = (only(h.posted, 'pick').slice(-1)[0] as any).token;
  ok(tok2 !== tok1, 'the re-pick carries a fresh token');
  h.click(visibleFlyouts(h)[0].querySelector('.stripflyouttypehere')); // open editor again → arms tok2; tok1 still armed (its echo is pending)
  h.key('keydown', { key: 'Escape' }, h.document.querySelector('.slotedit')); // cancel
  // the FIRST editor's still-in-flight echo (tok1) lands now. A scalar arm (overwritten by tok2) would re-arm Delete.
  h.send({ type: 'select', id: 'contextMenuStrip1', token: tok1 });
  h.resetPosted();
  h.key('keydown', { key: 'Delete' });
  eq(only(h.posted, 'removeControl').length, 0, 'no removeControl — the first editor’s delayed echo (tok1) stayed suppressed');
  h.destroy();
});

test('on-canvas MenuStrip: a SUPPRESSED strip echo is a true no-op — it does NOT clear a strip-item highlight the user selected meanwhile (codex — suppressed select side-effects)', () => {
  const h = loadDesigner();
  const slot = setupStripSlot(h, 'System.Windows.Forms.MenuStrip'); // strip1 + existingItem + a trailing Type-Here slot
  h.mouse('click', { offsetX: 200, offsetY: 15 }, h.el('surface')); // pick the strip control (empty area) → pick(strip1, tok)
  const tok = (only(h.posted, 'pick').slice(-1)[0] as any).token;
  h.click(slot); // open the strip's Type Here add-editor → arms tok
  ok(!!h.document.querySelector('.slotedit'), 'the add-editor is open');
  h.key('keydown', { key: 'Escape' }, h.document.querySelector('.slotedit')); // cancel (tok stays armed, its echo pending)
  h.mouse('click', { offsetX: 20, offsetY: 15 }, h.el('surface')); // select existingItem → the item highlight turns on
  ok((h.document.querySelector('.stripitemsel') as any)?.style.display !== 'none', 'the strip item is highlighted');
  // the strip's stale (armed) pick echo lands now. Suppressed → a TRUE no-op: before the fix the handler cleared
  // selectedItem BEFORE deciding suppression, wiping the highlight of whatever the user selected meanwhile.
  h.send({ type: 'select', id: 'strip1', token: tok });
  ok((h.document.querySelector('.stripitemsel') as any)?.style.display !== 'none', 'the suppressed echo did NOT clear the item highlight (no-op)');
  // and the arm was consumed (one-shot): a subsequent NORMAL token-less host select still supersedes the item highlight.
  h.send({ type: 'select', id: 'strip1' });
  eq((h.document.querySelector('.stripitemsel') as any).style.display, 'none', 'a normal token-less host select still clears the item highlight');
  h.destroy();
});

test('off-tree ContextMenuStrip (tray): a hand-authored anonymous item (no field id, no children) renders INERT — not a live-looking dead click (review wf_6b3ffa70)', () => {
  const h = loadDesigner();
  const strip = ctxTray();
  strip.items.push({ ownerId: 'contextMenuStrip1', itemId: '', itemType: 'System.Windows.Forms.ToolStripMenuItem', text: 'Ad-hoc', children: [] }); // Items.Add("Ad-hoc")
  const chips = setupTrayStrip(h, [strip]);
  h.click(chips[0]);
  const rows = Array.from(visibleFlyouts(h)[0].querySelectorAll('.stripflyoutrow')) as any[];
  const anon = rows.find((r) => r.textContent.indexOf('Ad-hoc') >= 0);
  ok(!!anon, 'the anonymous item still renders as a row (menu structure stays visible)');
  ok((anon.className as string).indexOf('inert') >= 0, 'but it is marked inert (dimmed, no pointer/hover)');
  h.resetPosted();
  h.click(anon);
  eq(only(h.posted, 'selectItem').length, 0, 'clicking the inert anonymous row posts nothing (no dead affordance)');
  const cutRow = rows.find((r) => r.textContent.indexOf('Cut') >= 0);
  ok((cutRow.className as string).indexOf('inert') < 0, 'a field-backed sibling (Cut) stays interactive');
  // selecting a sibling triggers updateSubmenuSelClasses (an in-place className rebuild) — it must PRESERVE the inert
  // predicate, else the dead anonymous row regains hover/cursor and looks clickable again (codex review P3).
  h.click(cutRow);
  ok((anon.className as string).indexOf('inert') >= 0, 'the anonymous row STAYS inert after a sibling selection (className rebuild preserves inert)');
  h.destroy();
});

test('off-tree ContextMenuStrip (tray): an EMPTY strip (isStrip, no items) still opens a flyout with just a "Type Here" add-first-item slot; a non-strip chip with an identical empty items list opens NOTHING', () => {
  const h = loadDesigner();
  const empty = { id: 'contextMenuStrip1', name: 'contextMenuStrip1', type: 'System.Windows.Forms.ContextMenuStrip', isStrip: true, items: [] };
  const timer = { id: 'timer1', name: 'timer1', type: 'System.Windows.Forms.Timer', items: [] }; // non-strip: same empty items, no isStrip
  const chips = setupTrayStrip(h, [empty, timer]);
  h.click(chips[0]); // the EMPTY strip chip
  const boxes = visibleFlyouts(h);
  eq(boxes.length, 1, 'the empty strip still opens its root flyout level');
  eq(boxes[0].querySelectorAll('.stripflyoutrow').length, 0, 'no item rows (the strip has no items yet)');
  ok(!!boxes[0].querySelector('.stripflyouttypehere'), 'but the ROOT "Type Here" add-first-item slot is present (the only way to seed an empty strip)');
  const chips2 = Array.from(h.el('tray').querySelectorAll('.trayItem')) as any[];
  h.click(chips2[1]); // the Timer chip — identical empty items, but NOT a strip
  eq(visibleFlyouts(h).length, 0, 'a non-strip chip opens nothing — the isStrip flag distinguishes it (items.length alone can\'t)');
  h.destroy();
});

/** The reopenToken the canvas stamped on its LAST posted stripAdd (undefined when it armed no auto-re-open). */
function lastReopenToken(h: Harness): number | undefined {
  const adds = only(h.posted, 'stripAdd') as any[];
  return adds.length ? adds[adds.length - 1].reopenToken : undefined;
}

test('auto-reopen: committing a ROOT "Type Here" add on a tray strip RE-OPENS the flyout on the token-matched stripAddDone (not the ambient tray)', () => {
  const h = loadDesigner();
  const chips = setupTrayStrip(h, [ctxTray()]);
  h.click(chips[0]);
  h.click(visibleFlyouts(h)[0].querySelector('.stripflyouttypehere'));
  const input = h.document.querySelector('.slotedit input.slotEditInput') as any;
  input.value = 'Copy';
  h.key('keydown', { key: 'Enter' }, input); // posts stripAdd (carrying a reopenToken); the editor + flyout close
  const tok = lastReopenToken(h);
  ok(typeof tok === 'number', 'a ROOT add stamps the stripAdd with a reopenToken (it armed a re-open)');
  eq(visibleFlyouts(h).length, 0, 'the flyout is closed right after the commit');
  // the host commits + re-renders (render → layout → tray) THEN posts stripAddDone once the outcome is known.
  const grown = ctxTray();
  grown.items.push({ ownerId: 'contextMenuStrip1', itemId: 'copyItem', itemType: 'System.Windows.Forms.ToolStripMenuItem', text: 'Copy', children: [] });
  h.send({ type: 'layout', controls: [mkCtrl({ id: 'panel1', type: 'System.Windows.Forms.Panel' })], toolStripItems: [] });
  h.send({ type: 'tray', items: [grown] });
  eq(visibleFlyouts(h).length, 0, 'the ambient tray alone does NOT re-open (the correlated stripAddDone drives it, not tray)');
  h.send({ type: 'stripAddDone', token: tok, ok: true });
  const boxes = visibleFlyouts(h);
  eq(boxes.length, 1, 'the flyout auto-re-opened on the matching stripAddDone');
  ok(Array.from(boxes[0].querySelectorAll('.stripflyoutrow')).some((r: any) => r.textContent.indexOf('Copy') >= 0), 'the newly added item (Copy) is now visible in the re-opened flyout');
  h.destroy();
});

test('auto-reopen: committing an add in a menu-bar item’s submenu RE-OPENS that submenu on the matching stripAddDone (keyed by the top-level item id)', () => {
  const h = loadDesigner();
  setupStripItems(h, 'System.Windows.Forms.MenuStrip', [
    { ownerId: 'strip1', itemId: 'fileMenu', itemType: 'System.Windows.Forms.ToolStripMenuItem', text: 'File', x: 14, y: 10, width: 37, height: 20, isTypeHere: false,
      children: [{ ownerId: 'strip1', itemId: 'openItem', itemType: 'System.Windows.Forms.ToolStripMenuItem', text: 'Open', children: [] }] },
  ]);
  h.mouse('click', { offsetX: 20, offsetY: 15 }, h.el('surface')); // open File's submenu
  eq(visibleFlyouts(h).length, 1, 'File’s submenu opened');
  h.click(visibleFlyouts(h)[0].querySelector('.stripflyouttypehere'));
  const input = h.document.querySelector('.slotedit input.slotEditInput') as any;
  input.value = 'Close';
  h.key('keydown', { key: 'Enter' }, input);
  const add = only(h.posted, 'stripAdd').pop() as any;
  eq([add.hostId, add.parentItemId], ['strip1', 'fileMenu'], 'the add grows fileMenu.DropDownItems');
  ok(typeof add.reopenToken === 'number', 'the submenu-root add arms a re-open');
  eq(visibleFlyouts(h).length, 0, 'the submenu closed on commit');
  const strip = mkCtrl({ id: 'strip1', type: 'System.Windows.Forms.MenuStrip', x: 8, y: 8, width: 284, height: 24, isStripHost: true });
  const grown = [
    { ownerId: 'strip1', itemId: 'fileMenu', itemType: 'System.Windows.Forms.ToolStripMenuItem', text: 'File', x: 14, y: 10, width: 37, height: 20, isTypeHere: false,
      children: [
        { ownerId: 'strip1', itemId: 'openItem', itemType: 'System.Windows.Forms.ToolStripMenuItem', text: 'Open', children: [] },
        { ownerId: 'strip1', itemId: 'closeItem', itemType: 'System.Windows.Forms.ToolStripMenuItem', text: 'Close', children: [] },
      ] },
  ];
  h.send({ type: 'layout', controls: [strip], toolStripItems: grown });
  h.send({ type: 'tray', items: [] });
  h.send({ type: 'stripAddDone', token: add.reopenToken, ok: true });
  const boxes = visibleFlyouts(h);
  eq(boxes.length, 1, 'File’s submenu auto-re-opened on the matching stripAddDone');
  ok(Array.from(boxes[0].querySelectorAll('.stripflyoutrow')).some((r: any) => r.textContent.indexOf('Close') >= 0), 'the new item (Close) is visible in the re-opened submenu');
  h.destroy();
});

test('auto-reopen: a CANCELLED add (Escape) arms nothing — no stripAdd, and a stray stripAddDone does not re-open', () => {
  const h = loadDesigner();
  const chips = setupTrayStrip(h, [ctxTray()]);
  h.click(chips[0]);
  h.click(visibleFlyouts(h)[0].querySelector('.stripflyouttypehere'));
  const input = h.document.querySelector('.slotedit input.slotEditInput') as any;
  input.value = 'Copy';
  h.key('keydown', { key: 'Escape' }, input); // cancel — no stripAdd
  eq(only(h.posted, 'stripAdd').length, 0, 'Escape posts no add');
  h.send({ type: 'stripAddDone', token: 1, ok: true }); // a stray/unmatched done can't re-open (nothing armed)
  eq(visibleFlyouts(h).length, 0, 'no flyout re-opens after a cancelled add (only a committed add arms the re-open)');
  h.destroy();
});

test('auto-reopen (deeper-than-root): a DEEPER-level add arms a re-open with a saved path — on the matching stripAddDone the flyout re-opens BOTH levels and the new nested item is visible', () => {
  const h = loadDesigner();
  const chips = setupTrayStrip(h, [ctxTray(true)]); // Paste has an Options submenu (a nested level exists)
  h.click(chips[0]);
  const pasteRow = Array.prototype.find.call(visibleFlyouts(h)[0].querySelectorAll('.stripflyoutrow'), (r: any) => r.textContent.indexOf('Paste') >= 0);
  h.click(pasteRow); // open the nested level (level 1)
  eq(visibleFlyouts(h).length, 2, 'the nested level is open');
  h.click(visibleFlyouts(h)[1].querySelector('.stripflyouttypehere')); // add-slot at level 1
  const input = h.document.querySelector('.slotedit input.slotEditInput') as any;
  input.value = 'Deep';
  h.key('keydown', { key: 'Enter' }, input);
  const add = only(h.posted, 'stripAdd').pop() as any;
  eq(add.parentItemId, 'pasteItem', 'the nested add targets the deeper parent');
  ok(typeof add.reopenToken === 'number', 'a deeper-level add now ALSO arms a re-open (a token is stamped)');
  eq(visibleFlyouts(h).length, 0, 'the flyout closed on commit');
  // the host commits + re-renders → a fresh tray carrying the grown pasteItem (Options + the new Deep), then stripAddDone
  const grownTray = {
    id: 'contextMenuStrip1', name: 'contextMenuStrip1', type: 'System.Windows.Forms.ContextMenuStrip', isStrip: true,
    items: [
      { ownerId: 'contextMenuStrip1', itemId: 'cutItem', itemType: 'System.Windows.Forms.ToolStripMenuItem', text: 'Cut', children: [] },
      { ownerId: 'contextMenuStrip1', itemId: 'pasteItem', itemType: 'System.Windows.Forms.ToolStripMenuItem', text: 'Paste', children: [
        { ownerId: 'contextMenuStrip1', itemId: 'optItem', itemType: 'System.Windows.Forms.ToolStripMenuItem', text: 'Options', children: [] },
        { ownerId: 'contextMenuStrip1', itemId: 'deepItem', itemType: 'System.Windows.Forms.ToolStripMenuItem', text: 'Deep', children: [] },
      ] },
    ],
  };
  h.send({ type: 'layout', controls: [mkCtrl({ id: 'panel1', type: 'System.Windows.Forms.Panel' })], toolStripItems: [] });
  h.send({ type: 'tray', items: [grownTray] });
  h.send({ type: 'stripAddDone', token: add.reopenToken, ok: true });
  const boxes = visibleFlyouts(h);
  eq(boxes.length, 2, 'the deeper add re-opened BOTH levels (root + the nested submenu) by replaying the saved path');
  ok(Array.from(boxes[1].querySelectorAll('.stripflyoutrow')).some((r: any) => r.textContent.indexOf('Deep') >= 0), 'the new nested item (Deep) is visible in the re-opened deep level');
  h.destroy();
});

test('auto-reopen (codex #1): a REJECTED add (stripAddDone ok:false) clears the arm — no later render can resurrect the flyout', () => {
  const h = loadDesigner();
  const chips = setupTrayStrip(h, [ctxTray()]);
  h.click(chips[0]);
  h.click(visibleFlyouts(h)[0].querySelector('.stripflyouttypehere'));
  const input = h.document.querySelector('.slotedit input.slotEditInput') as any;
  input.value = 'Copy';
  h.key('keydown', { key: 'Enter' }, input);
  const tok = lastReopenToken(h) as number;
  ok(typeof tok === 'number', 'the add armed a re-open');
  // the host REJECTS the add (docChanged / unsafe splice / vanished owner) → stripAddDone ok:false, NO fresh render
  h.send({ type: 'stripAddDone', token: tok, ok: false });
  eq(visibleFlyouts(h).length, 0, 'a rejected add does NOT re-open the flyout');
  // a LATER unrelated render must not resurrect it — the arm was already consumed by the ok:false
  h.send({ type: 'layout', controls: [mkCtrl({ id: 'panel1', type: 'System.Windows.Forms.Panel' })], toolStripItems: [] });
  h.send({ type: 'tray', items: [ctxTray()] });
  h.send({ type: 'stripAddDone', token: tok, ok: true }); // even a duplicated (now-stale) success can't re-arm it
  eq(visibleFlyouts(h).length, 0, 'no stale flyout appears on an unrelated later render (the arm is gone after ok:false)');
  h.destroy();
});

test('auto-reopen (codex #2): overlapping adds — a stripAddDone for a SUPERSEDED add does not re-open; only the newest token does', () => {
  const h = loadDesigner();
  const chips = setupTrayStrip(h, [ctxTray()]);
  h.click(chips[0]);
  h.click(visibleFlyouts(h)[0].querySelector('.stripflyouttypehere'));
  let input = h.document.querySelector('.slotedit input.slotEditInput') as any;
  input.value = 'A';
  h.key('keydown', { key: 'Enter' }, input);       // add A → token tA (arms slotReopen)
  const tA = lastReopenToken(h) as number;
  // the user re-opens the flyout and commits a SECOND add B before A's round-trip finishes → B overwrites the single arm
  const chips2 = Array.from(h.el('tray').querySelectorAll('.trayItem')) as any[];
  h.click(chips2[0]);
  h.click(visibleFlyouts(h)[0].querySelector('.stripflyouttypehere'));
  input = h.document.querySelector('.slotedit input.slotEditInput') as any;
  input.value = 'B';
  h.key('keydown', { key: 'Enter' }, input);       // add B → token tB
  const tB = lastReopenToken(h) as number;
  ok(typeof tB === 'number' && tB !== tA, 'each add mints a distinct token');
  // A's LATE stripAddDone arrives against A's (stale, B-less) forest — its token no longer matches the armed (B) one
  h.send({ type: 'tray', items: [ctxTray()] }); // A's forest — no B item
  h.send({ type: 'stripAddDone', token: tA, ok: true });
  eq(visibleFlyouts(h).length, 0, 'the superseded add A does NOT re-open (its token no longer matches the armed B) — no stale-forest flyout');
  // B's stripAddDone re-opens against B's fresh forest
  const grownB = ctxTray();
  grownB.items.push({ ownerId: 'contextMenuStrip1', itemId: 'bItem', itemType: 'System.Windows.Forms.ToolStripMenuItem', text: 'Bee', children: [] });
  h.send({ type: 'tray', items: [grownB] });
  h.send({ type: 'stripAddDone', token: tB, ok: true });
  const boxes = visibleFlyouts(h);
  eq(boxes.length, 1, 'B (the newest arm) re-opens on its matching token');
  ok(Array.from(boxes[0].querySelectorAll('.stripflyoutrow')).some((r: any) => r.textContent.indexOf('Bee') >= 0), 'B’s new item is visible in the re-opened flyout');
  h.destroy();
});

test('auto-reopen (codex #2 lifecycle): each page load seeds a DISTINCT token epoch, so an in-flight completion cannot match a NEW page (after a webview rebuild) and reopen the wrong flyout', () => {
  // Reproduces the cross-rebuild collision: a 0-based reopenSeq would restart at the same value on every HTML reload,
  // so an old page's token N could match a rebuilt page's arm N. Seeding from a random per-load base makes two page
  // loads mint tokens from different epochs (collision ~1e-9). Two fresh harnesses = two page loads.
  const firstToken = (): number => {
    const h = loadDesigner();
    const chips = setupTrayStrip(h, [ctxTray()]);
    h.click(chips[0]);
    h.click(visibleFlyouts(h)[0].querySelector('.stripflyouttypehere'));
    const input = h.document.querySelector('.slotedit input.slotEditInput') as any;
    input.value = 'X';
    h.key('keydown', { key: 'Enter' }, input);
    const t = lastReopenToken(h) as number;
    h.destroy();
    return t;
  };
  const a = firstToken(), b = firstToken();
  ok(typeof a === 'number' && typeof b === 'number', 'both page loads mint a numeric token');
  ok(a !== b, 'two independent page loads mint tokens from different epochs (a rebuild can’t reuse an in-flight token)');
});

test('tab-host context menu: Add Tab / Delete Tab labels come from the i18n catalog (localized, not hardcoded literals)', () => {
  const h = loadDesigner();
  h.send({ type: 'render', png: '', width: 300, height: 200, gen: 0 });
  h.send({ type: 'layout', controls: [
    mkCtrl({ id: 'tabControl1', name: 'tabControl1', type: 'System.Windows.Forms.TabControl', x: 8, y: 8, width: 200, height: 150, isTabHost: true }),
    mkCtrl({ id: 'tabPage1', name: 'tabPage1', type: 'System.Windows.Forms.TabPage', parentId: 'tabControl1', x: 12, y: 30, width: 190, height: 120 }),
  ] });
  h.resetPosted();
  // right-click the tab HEADER area (y=15 is above the page at y=30) so the hit-test lands on the tab host, not the page
  h.mouse('contextmenu', { clientX: 40, clientY: 15, button: 2 }, h.el('surfaceWrap'));
  ok(!!findMenuItem(h, 'ctxMenu', 'designer.menu.addTab'), 'the Add-Tab item is keyed by designer.menu.addTab (localizable — was a hardcoded "Add Tab")');
  ok(!!findMenuItem(h, 'ctxMenu', 'designer.menu.deleteTabNamed'), 'the Delete-Tab item is keyed by designer.menu.deleteTabNamed with the active page name (was a hardcoded literal)');
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

test('panel cursor editor (Tier 4): a Cursor property renders an editable dropdown; picking a value posts an edit', () => {
  const h = loadPanel();
  setupComponent(h, {
    id: 'nb',
    name: 'notesBox',
    type: 'System.Windows.Forms.TextBox',
    properties: [
      prop('Cursor', {
        type: 'System.Windows.Forms.Cursor',
        value: 'Default',
        standardValues: ['Default', 'Hand', 'Cross'],
        standardValuesExclusive: false,
        sourceExplicit: false,
        isDefault: true,
        category: 'Appearance',
      }),
    ],
    events: [],
  });
  // Cursor is now in the COMPLEX set → editable() true → the CursorConverter standard values render as a datalist
  // input (non-exclusive), NOT read-only text. (Previously the type failed editable() and showed a plain label.)
  const inp = findPropRow(h, 'Cursor').querySelector('input');
  ok(!!inp, 'Cursor renders an editable input (dropdown), not read-only text');
  inp.value = 'Hand';
  inp.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  const edits = only(h.posted, 'edit');
  eq(edits.length, 1, 'one edit posted');
  eq([edits[0].prop, edits[0].value, edits[0].propType], ['Cursor', 'Hand', 'System.Windows.Forms.Cursor'], 'edit carries the picked cursor NAME + Cursor type (engine converts to Cursors.Hand)');
  h.destroy();
});

test('panel component-reference dropdown (Tier 4): a referenceValues prop renders an exclusive <select> pre-selected on the field name; edits tag refEdit (pick + clear)', () => {
  const h = loadPanel();
  setupComponent(h, {
    id: 'this',
    name: 'Form1',
    type: 'System.Windows.Forms.Form',
    properties: [
      prop('AcceptButton', {
        type: 'System.Windows.Forms.IButtonControl', // NOT an editable literal type — the referenceValues flag is what makes it editable
        value: 'okButton',
        standardValues: ['(none)', 'cancelButton', 'okButton'],
        standardValuesExclusive: true,
        referenceValues: true,
        sourceExplicit: true,
        isDefault: false,
        category: 'Misc',
      }),
    ],
    events: [],
  });
  const sel = findPropRow(h, 'AcceptButton').querySelector('select');
  ok(!!sel, 'a component-reference property renders an exclusive <select> (referenceValues makes a non-literal type editable)');
  eq(sel.value, 'okButton', 'the dropdown pre-selects the current reference FIELD NAME (engine overrode the un-sited converter value)');
  // pick a different sibling → the edit carries the field name + refEdit so the host writes `this.cancelButton`
  sel.value = 'cancelButton';
  sel.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  let edits = only(h.posted, 'edit');
  eq(edits.length, 1, 'one edit posted on the pick');
  eq([edits[0].prop, edits[0].value, edits[0].refEdit], ['AcceptButton', 'cancelButton', true], 'the pick posts the field name + refEdit (host writes this.cancelButton)');
  // clear to "(none)" → still tagged refEdit so the host writes null
  h.resetPosted();
  sel.value = '(none)';
  sel.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  edits = only(h.posted, 'edit');
  eq([edits[0].value, edits[0].refEdit], ['(none)', true], 'clearing posts "(none)" + refEdit (host writes null)');
  h.destroy();
});

test('panel component-reference ROOT token (Tier 4): a [(none), (this)] dropdown pre-selects "(this)"; picking it posts value "(this)" + refEdit (host splices bare `this`)', () => {
  const h = loadPanel();
  setupComponent(h, {
    id: 'errorProvider1',
    name: 'errorProvider1',
    type: 'System.Windows.Forms.ErrorProvider',
    properties: [
      prop('ContainerControl', {
        type: 'System.Windows.Forms.ContainerControl', // non-literal — referenceValues makes it editable
        value: '(this)', // the engine pre-selects the synthetic root token (current value is the root form)
        standardValues: ['(none)', '(this)'],
        standardValuesExclusive: true,
        referenceValues: true,
        sourceExplicit: true,
        isDefault: false,
        category: 'Misc',
      }),
    ],
    events: [],
  });
  const sel = findPropRow(h, 'ContainerControl').querySelector('select');
  ok(!!sel, 'a ROOT-reference property renders an exclusive <select>');
  eq(sel.value, '(this)', 'the dropdown pre-selects the synthetic "(this)" root token');
  // clear to "(none)" → refEdit so the host writes null
  sel.value = '(none)';
  sel.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  let edits = only(h.posted, 'edit');
  eq([edits[0].prop, edits[0].value, edits[0].refEdit], ['ContainerControl', '(none)', true], 'clearing the root ref posts "(none)" + refEdit');
  // re-pick "(this)" → refEdit so the host splices a bare `this`
  h.resetPosted();
  sel.value = '(this)';
  sel.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  edits = only(h.posted, 'edit');
  eq([edits[0].value, edits[0].refEdit], ['(this)', true], 'picking the root token posts "(this)" + refEdit (host splices bare `this`)');
  h.destroy();
});

test('panel string[] editor (Tier 4): the "…" posts listStringArray; editing + OK posts setStringArray', () => {
  const h = loadPanel();
  setupComponent(h, {
    id: 'nb',
    name: 'notesBox',
    type: 'System.Windows.Forms.TextBox',
    properties: [
      prop('Lines', {
        type: 'System.String[]',
        value: '(Collection)',
        isCollection: true,
        collectionItemType: 'System.String[]', // distinct sentinel → routes to the string-array RPCs, not the Items splicer
        category: 'Appearance',
      }),
    ],
    events: [],
  });
  const btn = findPropRow(h, 'Lines').querySelector('button.collectionBtn');
  ok(!!btn, 'the "…" button is rendered for a string[] property');
  h.click(btn);
  const lsa = only(h.posted, 'listStringArray');
  eq(lsa.length, 1, 'listStringArray posted (not listCollection)');
  eq([lsa[0].id, lsa[0].prop], ['nb', 'Lines'], 'targets the control + property');

  // host replies with the current lines → the same one-item-per-line popup opens
  h.resetPosted();
  h.send({ type: 'stringArrayItems', id: 'nb', prop: 'Lines', ok: true, reason: '', items: ['one', 'two'] });
  const ta = h.document.querySelector('textarea.collectionTa');
  ok(!!ta, 'the string-array popup textarea opened');
  eq(ta.value, 'one\ntwo', 'popup prefilled with the current lines');
  ta.value = 'one\ntwo\nthree';
  h.click(h.document.querySelector('.collectionOk'));
  const set = only(h.posted, 'setStringArray');
  eq(set.length, 1, 'OK posts setStringArray (not setCollection)');
  eq([set[0].id, set[0].prop, set[0].items.join('|')], ['nb', 'Lines', 'one|two|three'], 'setStringArray carries the edited items');
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

test('panel toolstrip editor: "…" lists items, the popup renders the recursive menu, ↑ reorders a sibling group + OK posts setToolStripItems (review wf_55284a72-7f3 F5-proxy)', () => {
  const h = loadPanel();
  setupComponent(h, {
    id: 'ms',
    name: 'menuStrip1',
    type: 'System.Windows.Forms.MenuStrip',
    properties: [
      prop('Items', {
        type: 'System.Windows.Forms.ToolStripItemCollection',
        value: '(Collection)',
        isCollection: true,
        collectionItemType: 'System.Windows.Forms.ToolStripItem',
        category: 'Behavior',
      }),
    ],
    events: [],
  });
  const btn = findPropRow(h, 'Items').querySelector('button.collectionBtn');
  ok(!!btn, 'the "…" button is rendered for a MenuStrip.Items collection');
  h.click(btn);
  const lt = only(h.posted, 'listToolStripItems');
  eq(lt.length, 1, 'listToolStripItems posted');
  eq(lt[0].id, 'ms', 'targets the menu strip');

  // host replies with File[Open,Save] + Edit → the recursive popup mounts (nodes with children auto-expand)
  h.resetPosted();
  h.send({
    type: 'toolStripItems',
    id: 'ms',
    ok: true,
    reason: '',
    items: [
      { id: 'fileToolStripMenuItem', text: 'File', name: 'fileToolStripMenuItem', itemType: 'ToolStripMenuItem', children: [
        { id: 'openToolStripMenuItem', text: 'Open', name: '', itemType: 'ToolStripMenuItem', children: [] },
        { id: 'saveToolStripMenuItem', text: 'Save', name: '', itemType: 'ToolStripMenuItem', children: [] },
      ] },
      { id: 'editToolStripMenuItem', text: 'Edit', name: 'editToolStripMenuItem', itemType: 'ToolStripMenuItem', children: [] },
    ],
  });
  const rows = (): any[] => Array.from(h.document.querySelectorAll('.treeNodeRow')) as any[];
  eq(rows().length, 4, 'popup rendered File + Open + Save + Edit (submenu auto-expanded)');

  // reorder the TOP-LEVEL sibling group: move Edit (root index 1, flat row 3) above File via its ↑ button, OK
  h.click(rows()[3].querySelector('button[title="Move up"]'));
  h.click(h.document.querySelector('.collectionOk'));
  const set = only(h.posted, 'setToolStripItems');
  eq(set.length, 1, 'setToolStripItems posted on OK');
  eq(set[0].toolStripItems.map((n: any) => n.text), ['Edit', 'File'], 'top-level order is now Edit, File');
  eq(set[0].toolStripItems[1].children.map((n: any) => n.text), ['Open', 'Save'], 'File submenu order preserved (only the reordered group changed)');
  ok(!('_k' in set[0].toolStripItems[0]), 'the ephemeral expand-key is stripped before sending');
  h.destroy();
});

test('panel toolstrip editor: "+ Add item" ("Type Here") appends an empty-id item, typing sets its Text, OK posts it (Slice 2 ADD)', () => {
  const h = loadPanel();
  setupComponent(h, {
    id: 'ms',
    name: 'menuStrip1',
    type: 'System.Windows.Forms.MenuStrip',
    properties: [
      prop('Items', {
        type: 'System.Windows.Forms.ToolStripItemCollection',
        value: '(Collection)',
        isCollection: true,
        collectionItemType: 'System.Windows.Forms.ToolStripItem',
        category: 'Behavior',
      }),
    ],
    events: [],
  });
  h.click(findPropRow(h, 'Items').querySelector('button.collectionBtn'));
  h.resetPosted();
  h.send({
    type: 'toolStripItems',
    id: 'ms',
    ok: true,
    reason: '',
    items: [{ id: 'fileToolStripMenuItem', text: 'File', name: 'fileToolStripMenuItem', itemType: 'ToolStripMenuItem', children: [] }],
  });
  // "+ Add item" appends a NEW row whose Text is an editable input (the NEW item's carries the "Type Here" placeholder;
  // since Slice 4 existing items are renameable and so ALSO expose an input — the new one is picked by its placeholder).
  const addBtn = (Array.from(h.document.querySelectorAll('button')) as any[]).find((b) => b.textContent === '+ Add item');
  ok(!!addBtn, 'the "+ Add item" button is present');
  h.click(addBtn);
  const inputs = Array.from(h.document.querySelectorAll('.treeNodeRow input')) as any[];
  eq(inputs.length, 2, 'File (existing, renameable) + the new item each expose a Text input');
  const newInput = inputs.find((i: any) => i.placeholder === 'Type Here');
  ok(!!newInput, 'the NEW item’s input carries the "Type Here" placeholder');
  newInput.value = 'Help';
  newInput.dispatchEvent(new h.window.Event('input', { bubbles: true }));
  h.click(h.document.querySelector('.collectionOk'));
  const set = only(h.posted, 'setToolStripItems');
  eq(set.length, 1, 'setToolStripItems posted on OK');
  eq(set[0].toolStripItems.length, 2, 'File + the new item');
  eq([set[0].toolStripItems[1].id, set[0].toolStripItems[1].text, set[0].toolStripItems[1].itemType], ['', 'Help', 'ToolStripMenuItem'], 'the new item carries an EMPTY id (engine mints it), the typed Text, and a concrete type');
  ok(!('_k' in set[0].toolStripItems[1]), 'the ephemeral key is stripped');
  h.destroy();
});

test('panel toolstrip editor: the ✕ button deletes an EXISTING item (and its subtree) — OK posts a forest that omits it (Slice 3 REMOVE F5-proxy)', () => {
  const h = loadPanel();
  setupComponent(h, {
    id: 'ms',
    name: 'menuStrip1',
    type: 'System.Windows.Forms.MenuStrip',
    properties: [
      prop('Items', {
        type: 'System.Windows.Forms.ToolStripItemCollection',
        value: '(Collection)',
        isCollection: true,
        collectionItemType: 'System.Windows.Forms.ToolStripItem',
        category: 'Behavior',
      }),
    ],
    events: [],
  });
  h.click(findPropRow(h, 'Items').querySelector('button.collectionBtn'));
  h.resetPosted();
  h.send({
    type: 'toolStripItems',
    id: 'ms',
    ok: true,
    reason: '',
    items: [
      { id: 'fileToolStripMenuItem', text: 'File', name: 'fileToolStripMenuItem', itemType: 'ToolStripMenuItem', children: [
        { id: 'openToolStripMenuItem', text: 'Open', name: '', itemType: 'ToolStripMenuItem', children: [] },
        { id: 'saveToolStripMenuItem', text: 'Save', name: '', itemType: 'ToolStripMenuItem', children: [] },
      ] },
      { id: 'editToolStripMenuItem', text: 'Edit', name: 'editToolStripMenuItem', itemType: 'ToolStripMenuItem', children: [] },
    ],
  });
  const rows = (): any[] => Array.from(h.document.querySelectorAll('.treeNodeRow')) as any[];
  eq(rows().length, 4, 'popup rendered File + Open + Save + Edit');
  // every item (existing too) now offers a ✕ delete affordance; before Slice 3 only NEW items did.
  const delBtn = rows()[3].querySelector('button[title="Delete item (and any sub-items)"]');
  ok(!!delBtn, 'an EXISTING item exposes the ✕ delete button');
  h.click(delBtn);
  eq(rows().length, 3, 'Edit row removed from the popup (File + Open + Save remain)');
  h.click(h.document.querySelector('.collectionOk'));
  const set = only(h.posted, 'setToolStripItems');
  eq(set.length, 1, 'setToolStripItems posted on OK');
  eq(set[0].toolStripItems.map((n: any) => n.text), ['File'], 'the committed forest OMITS the deleted Edit (engine removes it)');
  eq(set[0].toolStripItems[0].children.map((n: any) => n.text), ['Open', 'Save'], 'the surviving item keeps its submenu');
  h.destroy();
});

test('panel toolstrip editor: editing an EXISTING item’s Text input RENAMES it — OK posts the forest with the new caption on the same id (Slice 4 RENAME F5-proxy)', () => {
  const h = loadPanel();
  setupComponent(h, {
    id: 'ms',
    name: 'menuStrip1',
    type: 'System.Windows.Forms.MenuStrip',
    properties: [
      prop('Items', {
        type: 'System.Windows.Forms.ToolStripItemCollection',
        value: '(Collection)',
        isCollection: true,
        collectionItemType: 'System.Windows.Forms.ToolStripItem',
        category: 'Behavior',
      }),
    ],
    events: [],
  });
  h.click(findPropRow(h, 'Items').querySelector('button.collectionBtn'));
  h.resetPosted();
  h.send({
    type: 'toolStripItems',
    id: 'ms',
    ok: true,
    reason: '',
    items: [
      { id: 'fileToolStripMenuItem', text: 'File', name: 'fileToolStripMenuItem', itemType: 'ToolStripMenuItem', children: [] },
      { id: 'editToolStripMenuItem', text: 'Edit', name: 'editToolStripMenuItem', itemType: 'ToolStripMenuItem', children: [] },
      // a separator has NO editable Text — it must render a rule, never an input
      { id: 'toolStripSeparator1', text: '', name: 'toolStripSeparator1', itemType: 'ToolStripSeparator', children: [] },
    ],
  });
  const rows = (): any[] => Array.from(h.document.querySelectorAll('.treeNodeRow')) as any[];
  eq(rows().length, 3, 'popup rendered File + Edit + separator');
  // existing non-separator items are pre-filled, editable inputs; the separator is a read-only rule
  const inputs = Array.from(h.document.querySelectorAll('.treeNodeRow input')) as any[];
  eq(inputs.length, 2, 'File + Edit expose an editable Text input; the separator does not');
  eq(inputs.map((i: any) => i.value), ['File', 'Edit'], 'existing items’ inputs are pre-filled with their current Text');
  ok(rows()[2].textContent.includes('──────'), 'the separator row shows a rule, not an input');
  // rename File → "Datei" by editing its input; leave Edit untouched
  const fileInput = inputs.find((i: any) => i.value === 'File');
  fileInput.value = 'Datei';
  fileInput.dispatchEvent(new h.window.Event('input', { bubbles: true }));
  h.click(h.document.querySelector('.collectionOk'));
  const set = only(h.posted, 'setToolStripItems');
  eq(set.length, 1, 'setToolStripItems posted on OK');
  eq(set[0].toolStripItems.map((n: any) => [n.id, n.text]), [
    ['fileToolStripMenuItem', 'Datei'],
    ['editToolStripMenuItem', 'Edit'],
    ['toolStripSeparator1', ''],
  ], 'File is renamed to "Datei" on the SAME id; Edit and the separator are unchanged');
  h.destroy();
});

test('panel toolstrip editor: a NEW item exposes a context-aware TYPE picker — a MenuStrip offers menu types, choosing Separator drops the Text input, OK posts the chosen type (Slice 5 item-type picker F5-proxy)', () => {
  const h = loadPanel();
  setupComponent(h, {
    id: 'ms',
    name: 'menuStrip1',
    type: 'System.Windows.Forms.MenuStrip',
    properties: [
      prop('Items', {
        type: 'System.Windows.Forms.ToolStripItemCollection',
        value: '(Collection)',
        isCollection: true,
        collectionItemType: 'System.Windows.Forms.ToolStripItem',
        category: 'Behavior',
      }),
    ],
    events: [],
  });
  h.click(findPropRow(h, 'Items').querySelector('button.collectionBtn'));
  h.resetPosted();
  h.send({
    type: 'toolStripItems',
    id: 'ms',
    ok: true,
    reason: '',
    items: [{ id: 'fileToolStripMenuItem', text: 'File', name: 'fileToolStripMenuItem', itemType: 'ToolStripMenuItem', children: [] }],
  });
  const addBtn = (Array.from(h.document.querySelectorAll('button')) as any[]).find((b) => b.textContent === '+ Add item');
  h.click(addBtn);
  const sel = h.document.querySelector('.treeNodeRow select.colTypeSel') as any;
  ok(!!sel, 'a NEW item row exposes a type <select> (existing items do not)');
  eq(Array.from(sel.options).map((o: any) => o.value), ['ToolStripMenuItem', 'ToolStripComboBox', 'ToolStripTextBox', 'ToolStripSeparator'], 'a MenuStrip offers the menu-context item types');
  eq(sel.value, 'ToolStripMenuItem', 'the default new-item type is Menu Item');
  // switch the new item to a Separator → its Text input disappears (a separator carries no Text) and shows a rule
  sel.value = 'ToolStripSeparator';
  sel.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  const newRow = (Array.from(h.document.querySelectorAll('.treeNodeRow')) as any[])[1];
  ok(!newRow.querySelector('input'), 'the separator new-item row no longer has a Text input');
  ok(newRow.textContent.includes('──────'), 'the separator new-item row shows a rule');
  h.click(h.document.querySelector('.collectionOk'));
  const set = only(h.posted, 'setToolStripItems');
  eq(set.length, 1, 'setToolStripItems posted on OK');
  eq([set[0].toolStripItems[1].id, set[0].toolStripItems[1].itemType, set[0].toolStripItems[1].text], ['', 'ToolStripSeparator', ''], 'the new item carries an EMPTY id, the chosen Separator type, and no Text');
  h.destroy();
});

test('panel toolstrip editor: the TYPE picker is context-sensitive — a ToolStrip (toolbar) defaults a new item to Button, not Menu Item (Slice 5)', () => {
  const h = loadPanel();
  setupComponent(h, {
    id: 'ts',
    name: 'toolStrip1',
    type: 'System.Windows.Forms.ToolStrip',
    properties: [
      prop('Items', {
        type: 'System.Windows.Forms.ToolStripItemCollection',
        value: '(Collection)',
        isCollection: true,
        collectionItemType: 'System.Windows.Forms.ToolStripItem',
        category: 'Behavior',
      }),
    ],
    events: [],
  });
  h.click(findPropRow(h, 'Items').querySelector('button.collectionBtn'));
  h.resetPosted();
  h.send({ type: 'toolStripItems', id: 'ts', ok: true, reason: '', items: [] });
  const addBtn = (Array.from(h.document.querySelectorAll('button')) as any[]).find((b) => b.textContent === '+ Add item');
  h.click(addBtn);
  const sel = h.document.querySelector('.treeNodeRow select.colTypeSel') as any;
  ok(!!sel, 'the new toolbar item exposes a type <select>');
  eq(sel.value, 'ToolStripButton', 'a ToolStrip defaults a new item to Button');
  ok(Array.from(sel.options).map((o: any) => o.value).indexOf('ToolStripMenuItem') < 0, 'a toolbar picker does not offer Menu Item');
  // commit with the default type + a caption
  const inp = h.document.querySelector('.treeNodeRow input') as any;
  inp.value = 'Run';
  inp.dispatchEvent(new h.window.Event('input', { bubbles: true }));
  h.click(h.document.querySelector('.collectionOk'));
  const set = only(h.posted, 'setToolStripItems');
  eq([set[0].toolStripItems[0].id, set[0].toolStripItems[0].itemType, set[0].toolStripItems[0].text], ['', 'ToolStripButton', 'Run'], 'the committed new item is a ToolStripButton with the typed caption');
  h.destroy();
});

// ---- item → Properties (Slice 1e): clicking a top-level ToolStrip item loads ITS properties into the panel via a
// dedicated selectItem→itemProps channel that never touches the control selection (currentId / manip / smart-tag). ----

test('item→Properties: a single click on a top-level item posts selectItem {hostId,itemId} (loads item props) and no control pick', () => {
  const h = loadDesigner();
  setupStripItems(h, 'System.Windows.Forms.MenuStrip', [
    { ownerId: 'strip1', itemId: 'fileMenu', itemType: 'System.Windows.Forms.ToolStripMenuItem', text: 'File', x: 14, y: 10, width: 37, height: 20, isTypeHere: false },
  ]);
  h.mouse('click', { offsetX: 20, offsetY: 15 }, h.el('surface')); // inside fileMenu
  const sel = only(h.posted, 'selectItem');
  eq(sel.length, 1, 'clicking an item posts exactly one selectItem');
  eq([sel[0].hostId, sel[0].itemId], ['strip1', 'fileMenu'], 'selectItem carries the owner + item id');
  eq(only(h.posted, 'pick').length, 0, 'it does NOT pick the container strip as a control');
  h.destroy();
});

test('item→Properties: right-clicking a top-level item also posts selectItem (its props follow the context selection)', () => {
  const h = loadDesigner();
  setupStripItems(h, 'System.Windows.Forms.MenuStrip', [
    { ownerId: 'strip1', itemId: 'fileMenu', itemType: 'System.Windows.Forms.ToolStripMenuItem', text: 'File', x: 14, y: 10, width: 37, height: 20, isTypeHere: false },
  ]);
  h.mouse('contextmenu', { clientX: 20, clientY: 15, button: 2 }, h.el('surfaceWrap'));
  const sel = only(h.posted, 'selectItem');
  eq(sel.length, 1, 'a right-click posts one selectItem');
  eq([sel[0].hostId, sel[0].itemId], ['strip1', 'fileMenu'], 'it carries the owner + item id');
  h.destroy();
});

test('item→Properties: an anonymous item (empty id) posts NO selectItem — the click falls through to the strip (review wf_108a7dbe)', () => {
  const h = loadDesigner();
  setupStripItems(h, 'System.Windows.Forms.StatusStrip', [
    { ownerId: 'strip1', itemId: '', itemType: 'System.Windows.Forms.ToolStripStatusLabel', text: 'Ready', x: 14, y: 10, width: 40, height: 20, isTypeHere: false },
  ]);
  h.mouse('click', { offsetX: 20, offsetY: 15 }, h.el('surface'));
  eq(only(h.posted, 'selectItem').length, 0, 'an unresolvable (anonymous) item posts no selectItem');
  eq(only(h.posted, 'pick')[0]?.id, 'strip1', 'the click selects the container strip instead');
  h.destroy();
});

/** Push item→Properties into the panel: a layout+select+props for the control (so the tree has it), then an itemProps. */
function itemComp(over: Record<string, any> = {}): any {
  return { id: 'fileMenu', name: 'fileToolStripMenuItem', type: 'System.Windows.Forms.ToolStripMenuItem', events: [], properties: [prop('Text', { value: 'File', sourceExplicit: true, isDefault: false, category: 'Appearance' })], ...over };
}

test('item→Properties: an itemProps message renders the item grid WITHOUT hijacking the control tree selection', () => {
  const h = loadPanel();
  h.send({ type: 'layout', controls: [mkCtrl({ id: 'button1' })] });
  h.send({ type: 'select', id: 'button1' });
  h.send({ type: 'props', id: 'button1', component: { id: 'button1', name: 'button1', type: 'System.Windows.Forms.Button', events: [], properties: [prop('Text', { value: 'hi', sourceExplicit: true, isDefault: false })] } });
  h.resetPosted();
  h.send({ type: 'itemProps', id: 'fileMenu', ownerId: 'strip1', editable: true, component: itemComp() });
  eq((findPropRow(h, 'Text').querySelector('input') as any).value, 'File', 'the grid now shows the item’s Text');
  eq(h.el('tree').value, 'button1', 'the control tree still shows the control — item props did not move currentId');
  h.destroy();
});

test('item→Properties: editing an item scalar prop posts an edit tagged with ownerId (routes to the item-edit path)', () => {
  const h = loadPanel();
  h.send({ type: 'itemProps', id: 'fileMenu', ownerId: 'strip1', editable: true, component: itemComp() });
  const input = h.el('props').querySelector('input') as any;
  ok(!!input, 'an editable text input rendered for the item’s Text');
  input.value = 'Edit';
  input.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  const edits = only(h.posted, 'edit');
  eq(edits.length, 1, 'one edit posted');
  eq([edits[0].id, edits[0].prop, edits[0].value, edits[0].ownerId], ['fileMenu', 'Text', 'Edit', 'strip1'], 'the edit targets the item field and carries the strip owner id');
  h.destroy();
});

test('item→Properties: an item’s collection/image props render READ-ONLY (their "…" editors are not item-aware — e.g. DropDownItems is a forest)', () => {
  const h = loadPanel();
  h.send({ type: 'itemProps', id: 'fileMenu', ownerId: 'strip1', editable: true, component: itemComp({ properties: [
    prop('DropDownItems', { type: 'System.Windows.Forms.ToolStripItemCollection', isCollection: true, collectionItemType: 'System.Windows.Forms.ToolStripItem', value: '(Collection)', category: 'Data' }),
    prop('Image', { type: 'System.Drawing.Image', isImage: true, value: '', category: 'Appearance' }),
    prop('Text', { value: 'File', sourceExplicit: true, isDefault: false, category: 'Appearance' }),
  ] }) });
  const coll = findPropRow(h, 'DropDownItems');
  ok(!coll.querySelector('button.collectionBtn'), 'no "…" collection editor is offered for an item collection');
  ok(!!coll.querySelector('td.ro'), 'the item collection renders read-only');
  ok(!findPropRow(h, 'Image').querySelector('button'), 'no Import/(none) image editor for an item image');
  ok(!!(findPropRow(h, 'Text').querySelector('input')), 'a scalar prop (Text) is still editable on an item');
  h.destroy();
});

test('item→Properties: net48 (component null) shows the compiled-preview placeholder, and returning to a control restores the default empty text', () => {
  const h = loadPanel();
  h.send({ type: 'itemProps', id: 'fileMenu', ownerId: 'strip1', editable: false, component: null });
  eq(h.el('propsEmpty').textContent, 'panel.itemProps.unavailable', 'the placeholder names the compiled-preview limitation');
  ok(h.el('propsEmpty').style.display !== 'none', 'the empty pane is shown');
  eq(h.el('propsBody').style.display, 'none', 'the grid body is hidden for the placeholder');
  // returning to a control (which describes to nothing) restores the DEFAULT empty text (no stale item note)
  h.send({ type: 'select', id: 'button1' });
  h.send({ type: 'props', id: 'button1', component: null });
  eq(h.el('propsEmpty').textContent, 'panel.props.empty', 'the default empty text is restored');
  h.destroy();
});

test('item→Properties: selecting a control after an item clears item mode — a later edit posts WITHOUT ownerId', () => {
  const h = loadPanel();
  h.send({ type: 'itemProps', id: 'fileMenu', ownerId: 'strip1', editable: true, component: itemComp() });
  // a genuine control selection supersedes the item view
  h.send({ type: 'select', id: 'button1' });
  h.send({ type: 'props', id: 'button1', component: { id: 'button1', name: 'button1', type: 'System.Windows.Forms.Button', events: [], properties: [prop('Text', { value: 'hi', sourceExplicit: true, isDefault: false })] } });
  h.resetPosted();
  const input = h.el('props').querySelector('input') as any;
  input.value = 'world';
  input.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  const edits = only(h.posted, 'edit');
  eq(edits.length, 1, 'the control edit posts');
  eq(edits[0].ownerId, undefined, 'after returning to a control the edit carries NO ownerId (item mode cleared)');
  h.destroy();
});

test('item→Properties: after an item is deleted, a bare props(control) for the retained selection exits item mode (review wf_df05090e-a67 — the host restores the control)', () => {
  const h = loadPanel();
  // a control was the selection (panel currentId = button1); the user then clicked an item → item grid shown
  h.send({ type: 'select', id: 'button1' });
  h.send({ type: 'itemProps', id: 'fileMenu', ownerId: 'strip1', editable: true, component: itemComp() });
  eq((findPropRow(h, 'Text').querySelector('input') as any).value, 'File', 'the item grid is shown');
  // the host deletes the item and restores the selected control's props via loadProps(currentId) — a bare props message
  // (NO preceding select) whose id matches the panel's currentId. The props gate passes → item mode must exit.
  h.send({ type: 'props', id: 'button1', component: { id: 'button1', name: 'button1', type: 'System.Windows.Forms.Button', events: [], properties: [prop('Text', { value: 'hi', sourceExplicit: true, isDefault: false })] } });
  eq((findPropRow(h, 'Text').querySelector('input') as any).value, 'hi', 'the panel now shows the restored control, not the deleted item');
  h.resetPosted();
  const input = h.el('props').querySelector('input') as any;
  input.value = 'z';
  input.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  eq(only(h.posted, 'edit')[0]?.ownerId, undefined, 'edits now target the control (no ownerId) — item mode fully exited');
  h.destroy();
});

test('item→Properties: Reset works for an EDITABLE item — posts resetProperty tagged with ownerId (routes to the item-reset path)', () => {
  const h = loadPanel();
  h.send({ type: 'itemProps', id: 'fileMenu', ownerId: 'strip1', editable: true, component: itemComp() });
  h.mouse('contextmenu', { clientX: 5, clientY: 5 }, findPropRow(h, 'Text').querySelector('td.name'));
  const reset = h.el('tbMenu').querySelector('.mi');
  ok(!!reset && reset.className.indexOf('disabled') < 0, 'Reset is enabled for a source-explicit prop on an editable item');
  h.click(reset);
  const rst = only(h.posted, 'resetProperty');
  eq(rst.length, 1, 'Reset posts one resetProperty');
  eq([rst[0].id, rst[0].prop, rst[0].ownerId], ['fileMenu', 'Text', 'strip1'], 'the reset targets the item field and carries the strip owner id (item-reset path)');
  h.destroy();
});

test('item→Properties: Reset stays disabled for a READ-ONLY item (net48 unresolved placeholder — currentItemEditable false)', () => {
  const h = loadPanel();
  h.send({ type: 'itemProps', id: 'fileMenu', ownerId: 'strip1', editable: false, component: itemComp() });
  h.mouse('contextmenu', { clientX: 5, clientY: 5 }, findPropRow(h, 'Text').querySelector('td.name'));
  const reset = h.el('tbMenu').querySelector('.mi');
  ok(!!reset && reset.className.indexOf('disabled') >= 0, 'Reset is greyed for a non-editable item');
  h.click(reset);
  eq(only(h.posted, 'resetProperty').length, 0, 'a disabled Reset posts nothing');
  h.destroy();
});

test('item→Properties Events tab: wiring an event on a shown item tags createHandler with ownerId (routes to the item-event path)', () => {
  const h = loadPanel();
  h.send({ type: 'itemProps', id: 'fileMenu', ownerId: 'strip1', editable: true, component: itemComp({ events: [{ name: 'Click', type: 'System.EventHandler', handler: '', category: 'Action' }] }) });
  h.click(h.el('tabEvents'));
  // listHandlers is a plain read (no ownerId tag needed — it replies via `candidates` keyed on the component id)
  eq(only(h.posted, 'listHandlers')[0]?.ownerId, undefined, 'listHandlers is not owner-tagged (a read that never refreshes props)');
  const inp = h.el('events').querySelector('input.evt') as any;
  ok(!!inp, 'the Events tab rendered an event input for the item');
  inp.value = 'fileMenu_Click';
  inp.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  const ch = only(h.posted, 'createHandler');
  eq(ch.length, 1, 'typing a new handler name posts one createHandler');
  eq([ch[0].id, ch[0].event, ch[0].ownerId], ['fileMenu', 'Click', 'strip1'], 'the wiring targets the item field and carries the strip owner id (item-event path)');
  h.destroy();
});

test('item→Properties Events tab: double-clicking an unwired event creates a handler tagged with ownerId', () => {
  const h = loadPanel();
  h.send({ type: 'itemProps', id: 'fileMenu', ownerId: 'strip1', editable: true, component: itemComp({ events: [{ name: 'Click', type: 'System.EventHandler', handler: '', category: 'Action' }] }) });
  h.click(h.el('tabEvents'));
  h.resetPosted();
  const nameTd = Array.prototype.find.call(h.el('events').querySelectorAll('td.name'), (td: any) => td.textContent.indexOf('Click') >= 0) as any;
  ok(!!nameTd, 'the Click event row rendered');
  nameTd.dispatchEvent(new h.window.Event('dblclick', { bubbles: true }));
  const ch = only(h.posted, 'createHandler');
  eq(ch.length, 1, 'double-clicking an unwired event posts createHandler');
  eq(ch[0].ownerId, 'strip1', 'the createHandler carries the strip owner id');
  h.destroy();
});

test('item→Properties (defensive): a non-null but non-editable itemProps (future net48 describe parity) renders the grid READ-ONLY', () => {
  const h = loadPanel();
  h.send({ type: 'itemProps', id: 'fileMenu', ownerId: 'strip1', editable: false, component: itemComp() });
  const row = findPropRow(h, 'Text');
  ok(!!row.querySelector('td.ro'), 'a non-editable item grid renders the value read-only');
  ok(!row.querySelector('input'), 'no editable input for a read-only item prop');
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
