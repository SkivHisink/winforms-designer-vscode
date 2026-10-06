import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';
import { HostMutationLedger, mutationPayloadFingerprint } from './mutationOperation';
import { drainHarnesses, Harness, loadDesigner, loadPanel } from './webviewHarness';

interface MutationMessage {
  type: string;
  operationId: string;
  requestAttemptId: string;
  [key: string]: unknown;
}

const directories: string[] = [];
afterEach(() => {
  drainHarnesses();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function shippedScript(name: string): string {
  return fs.readFileSync(path.resolve(__dirname, '..', 'media', name), 'utf8');
}

/** Exercise the private send helper from the shipped script without adding a product-only test hook. */
function sendHelper(name: string, cryptoApi: Record<string, unknown> = {}) {
  const source = shippedScript(name);
  const start = source.indexOf('  // ---- outgoing mutation identity ----');
  const end = source.indexOf('  // ---- end outgoing mutation identity ----');
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const posted: Record<string, unknown>[] = [];
  const context = vm.createContext({ window: { crypto: cryptoApi }, vscode: {
    postMessage: (message: Record<string, unknown>) => posted.push(JSON.parse(JSON.stringify(message))),
  } });
  vm.runInContext(source.slice(start, end), context);
  return {
    posted,
    send: context.postMessage as (message: Record<string, unknown>) => void,
    types: Object.keys(context.mutationMessageTypes as Record<string, true>),
  };
}

function mutation(harness: Harness, type: string): MutationMessage {
  const messages = harness.posted.filter((message) => message.type === type);
  expect(messages).toHaveLength(1);
  const message = messages[0] as MutationMessage;
  expect(message.operationId).toMatch(/^webview-operation-[\w-]+$/);
  expect(message.requestAttemptId).toMatch(/^webview-attempt-[\w-]+$/);
  expect(message.operationId).not.toBe(message.requestAttemptId);
  expect(message.operationId.length).toBeLessThanOrEqual(256);
  return message;
}

function component(harness: Harness, properties: Record<string, unknown>[]): void {
  harness.send({ type: 'select', id: 'button1' });
  harness.send({ type: 'props', id: 'button1', component: {
    id: 'button1', name: 'button1', type: 'System.Windows.Forms.Button', properties, events: [],
  } });
  harness.resetPosted();
}

function property(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { name, type: 'System.String', value: '', isEnum: false,
    sourceExplicit: false, isDefault: true, category: 'Appearance', ...extra };
}

describe('shipped webview mutation identity', () => {
  it.each(['designer.js', 'panel.js'])('preserves %s intent identity on retry and separates attempts and new intents', (name) => {
    const helper = sendHelper(name, { randomUUID: () => 'fixed-random-value' });
    const original = { type: 'edit', id: 'button1', prop: 'Text', value: 'Changed' };
    helper.send(original);
    helper.send(original);
    helper.send({ ...original, operationId: undefined, requestAttemptId: undefined });
    const [first, retry, next] = helper.posted;
    expect(first.operationId).toBe(retry.operationId);
    expect(first.requestAttemptId).not.toBe(retry.requestAttemptId);
    expect(next.operationId).not.toBe(first.operationId);
    expect(next.requestAttemptId).not.toBe(retry.requestAttemptId);
    expect(first).toMatchObject({ type: 'edit', id: 'button1', prop: 'Text', value: 'Changed' });
  });

  it.each(['designer.js', 'panel.js'])('only decorates known %s mutations and handles the browser fallback', (name) => {
    const helper = sendHelper(name);
    for (const type of ['ready', 'pick', 'tabClick', 'viewCode', 'copy', 'listBindings', 'constructor', '__proto__']) {
      helper.send({ type });
      expect(helper.posted.at(-1)).toEqual({ type });
    }
    helper.send({ type: 'edit', id: 'button1', prop: 'Text', value: 'Changed' });
    expect(helper.posted.at(-1)?.operationId).toMatch(/^webview-operation-[\w-]+$/);
    expect(helper.posted.at(-1)?.requestAttemptId).toMatch(/^webview-attempt-[\w-]+$/);
  });

  it.each([7, -1])('retains a canvas intent generation and fingerprint across a redraw from %s', (generation) => {
    const helper = sendHelper('designer.js');
    const source = shippedScript('designer.js');
    const generationHelper = source.match(/  function postGenerationBoundCanvasIntent\(message\) \{[\s\S]*?\n  \}/);
    expect(generationHelper).not.toBeNull();
    const context = vm.createContext({ postMessage: helper.send, lastDrawnGen: generation });
    vm.runInContext(generationHelper![0], context);
    const send = context.postGenerationBoundCanvasIntent as (message: Record<string, unknown>) => void;
    const intent = { type: 'manipulate', id: 'button1', mode: 'move', x: 11, y: 20 };
    send(intent);
    context.lastDrawnGen = 8;
    send(intent);
    const [first, retry] = helper.posted;
    expect(first.gen).toBe(generation < 0 ? undefined : generation);
    expect(retry.gen).toBe(first.gen);
    expect(retry.operationId).toBe(first.operationId);
    expect(retry.requestAttemptId).not.toBe(first.requestAttemptId);
    expect(mutationPayloadFingerprint(retry)).toBe(mutationPayloadFingerprint(first));
  });

  it('covers every host mutation ingress type and routes all shipped outgoing calls through the helper', () => {
    const host = fs.readFileSync(path.resolve(__dirname, 'designerEditor.ts'), 'utf8');
    const mutationSet = host.match(/const STALE_RENDER_BLOCKED = new Set<string>\(\[([\s\S]*?)\]\);/);
    expect(mutationSet).not.toBeNull();
    const hostTypes = [...mutationSet![1].replace(/\/\/[^\r\n]*/g, '').matchAll(/'([^']+)'/g)].map((match) => match[1]);
    const viewTypes = ['designer.js', 'panel.js'].flatMap((name) => sendHelper(name).types);
    expect([...new Set(viewTypes)].sort()).toEqual([...new Set(hostTypes)].sort());
    for (const name of ['designer.js', 'panel.js']) {
      expect(shippedScript(name).match(/vscode\.postMessage\(/g)).toHaveLength(1);
    }
  });

  it('sends distinct identities for actual property, structural, and image-resource actions in the panel', () => {
    const harness = loadPanel();
    expect(harness.posted.find((message) => message.type === 'ready')).toEqual({ type: 'ready' });
    component(harness, [property('Text')]);
    const editor = harness.el('props').querySelector('input');
    editor.value = 'Changed';
    editor.dispatchEvent(new harness.window.Event('change', { bubbles: true }));
    const edit = mutation(harness, 'edit');
    expect(edit).toMatchObject({ id: 'button1', prop: 'Text', propType: 'System.String', value: 'Changed' });

    harness.send({ type: 'toolbox', items: [{ name: 'Button', fqn: 'System.Windows.Forms.Button', category: 'Common Controls' }] });
    harness.click(harness.el('mainTabToolbox'));
    harness.resetPosted();
    harness.mouse('dblclick', {}, harness.el('tbList').querySelector('.tbItem'));
    const add = mutation(harness, 'addControl');
    expect(add.controlType).toBe('Button');

    component(harness, [property('Image', { type: 'System.Drawing.Image', isImage: true, value: 'image1', sourceExplicit: true })]);
    const buttons = [...harness.el('props').querySelectorAll('button')];
    for (const [label, type] of [['panel.image.project', 'pickProjectImageResource'],
      ['panel.image.import', 'importImage'], ['common.none', 'clearImage']]) {
      harness.click(buttons.find((button) => button.textContent === label));
      expect(mutation(harness, type)).toMatchObject({ id: 'button1', prop: 'Image' });
    }
    const images = harness.posted.filter((message) => /Image/.test(message.type));
    const ids = [edit.operationId, add.operationId, ...images.map((message) => message.operationId)];
    expect(new Set(ids).size).toBe(5);
  });

  it('sends actual canvas geometry and structural mutations with independent identities', () => {
    const harness = loadDesigner();
    const control = { id: 'button1', name: 'button1', type: 'System.Windows.Forms.Button',
      x: 10, y: 20, width: 80, height: 24, parentId: 'this' };
    harness.send({ type: 'layout', controls: [control] });
    harness.send({ type: 'select', id: 'button1' });
    harness.send({ type: 'manip', id: 'button1', move: true, resize: true });
    harness.resetPosted();
    harness.key('keydown', { key: 'ArrowRight' });
    harness.mouse('mousedown', { button: 0, offsetX: 5000, offsetY: 5000 }, harness.el('surface'));
    const move = mutation(harness, 'manipulate');
    expect(move).toMatchObject({ id: 'button1', mode: 'move', x: 11, y: 20 });
    harness.mouse('dblclick', { offsetX: 20, offsetY: 30 }, harness.el('surface'));
    const handler = mutation(harness, 'createDefaultHandler');
    expect(handler.operationId).not.toBe(move.operationId);
    harness.key('keydown', { key: 'Delete' });
    const remove = mutation(harness, 'removeControl');
    expect(remove.operationId).not.toBe(handler.operationId);
  });

  it('replays an actual outgoing AddControl message once through the host ledger, including a fresh attempt', async () => {
    const harness = loadPanel();
    harness.send({ type: 'toolbox', items: [{ name: 'Button', fqn: 'System.Windows.Forms.Button', category: 'Common Controls' }] });
    harness.click(harness.el('mainTabToolbox'));
    harness.resetPosted();
    harness.mouse('dblclick', {}, harness.el('tbList').querySelector('.tbItem'));
    const original = mutation(harness, 'addControl');
    const duplicate = JSON.parse(JSON.stringify(original)) as MutationMessage;
    expect(duplicate.operationId).toBe(original.operationId);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wfd-webview-identity-'));
    directories.push(root);
    const state = { sourceText: 'before', revision: 0 };
    const ledger = new HostMutationLedger(root, path.join(root, 'Form1.Designer.cs'), () => state);
    let undoUnits = 0;
    const commit = async () => {
      ledger.stageCommit('one-control');
      state.sourceText = 'one-control'; state.revision++; undoUnits++;
      ledger.finishCommit(true, true);
    };
    expect(await ledger.run(original, commit, original.operationId)).toMatchObject({ status: 'committed', replayed: false });
    expect(await ledger.run(duplicate, commit, duplicate.operationId)).toMatchObject({ status: 'committed', replayed: true });
    expect(await ledger.run({ ...duplicate, requestAttemptId: 'retry-attempt' }, commit, duplicate.operationId))
      .toMatchObject({ status: 'committed', replayed: true });
    expect(state).toEqual({ sourceText: 'one-control', revision: 1 });
    expect(undoUnits).toBe(1);
    expect(ledger.observe(original.operationId)?.commitCount).toBe(1);
  });
});
