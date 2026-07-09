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
  ok(!editor.querySelector('select.slotEditType'), 'the rename editor has NO type <select> (rename never changes type)');
  const input = editor.querySelector('input.slotEditInput') as any;
  ok(!!input, 'the rename editor has a text <input>');
  eq(input.value, '&File', 'the input is prefilled with the item’s live caption');
  input.value = '&Edit';
  h.key('keydown', { key: 'Enter' }, input);
  const ren = only(h.posted, 'stripRename');
  eq(ren.length, 1, 'Enter posts exactly one stripRename gesture');
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
  ok(!editor.querySelector('select.slotEditType'), 'the F2 rename editor has NO type <select>');
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

test('item→Properties: Reset is disabled while an item is shown (resetProperty carries no ownerId — item reset is a follow-up)', () => {
  const h = loadPanel();
  h.send({ type: 'itemProps', id: 'fileMenu', ownerId: 'strip1', editable: true, component: itemComp() });
  h.mouse('contextmenu', { clientX: 5, clientY: 5 }, findPropRow(h, 'Text').querySelector('td.name'));
  const reset = h.el('tbMenu').querySelector('.mi');
  ok(!!reset && reset.className.indexOf('disabled') >= 0, 'Reset is greyed for a shown item even though the prop is source-explicit');
  h.click(reset);
  eq(only(h.posted, 'resetProperty').length, 0, 'a disabled Reset posts nothing');
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
