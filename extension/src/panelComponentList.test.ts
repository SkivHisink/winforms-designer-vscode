import { afterEach, describe, expect, it } from 'vitest';
import { drainHarnesses, loadDesigner, loadPanel } from './webviewHarness';

afterEach(() => { drainHarnesses(); });

const form = { id: 'this', name: 'Form1', type: 'System.Windows.Forms.Form', isRoot: true, depth: 0, x: 0, y: 0, width: 300, height: 200 };
const list = { id: 'listView1', name: 'listView1', type: 'System.Windows.Forms.ListView', depth: 1, parentId: 'this',
  x: 8, y: 8, width: 200, height: 100 };
const components = [
  { id: 'timer1', name: 'timer1', type: 'System.Windows.Forms.Timer' },
  { id: 'columnHeader1', name: 'columnHeader1', type: 'System.Windows.Forms.ColumnHeader' },
];

function options(panel: ReturnType<typeof loadPanel>): string[] {
  return [...panel.el('tree').querySelectorAll('option')].map((option: any) => option.value);
}

describe("the Properties view's component list", () => {
  it('lists the controls, then every non-visual component by name, tray chip or not', () => {
    const panel = loadPanel();
    panel.send({ type: 'layout', controls: [form, list] });
    panel.send({ type: 'components', components });
    expect(options(panel)).toEqual(['this', 'listView1', 'columnHeader1', 'timer1']);
    // a later layout keeps them; a clear drops them
    panel.send({ type: 'layout', controls: [form] });
    expect(options(panel)).toEqual(['this', 'columnHeader1', 'timer1']);
    panel.send({ type: 'clear' });
    expect(options(panel)).toHaveLength(0);
  });

  it('lists a component whatever its field name', () => {
    const panel = loadPanel();
    panel.send({ type: 'layout', controls: [form] });
    panel.send({ type: 'components', components: ['constructor', 'toString', '__proto__', 'hasOwnProperty'].map((id) => (
      { id, name: id, type: 'System.Windows.Forms.ColumnHeader' })) });
    expect(options(panel)).toEqual(['this', '__proto__', 'constructor', 'hasOwnProperty', 'toString']);
  });

  it('selects a component the tray shows no chip for', () => {
    const panel = loadPanel();
    panel.send({ type: 'layout', controls: [form, list] });
    panel.send({ type: 'components', components });
    panel.send({ type: 'select', id: 'this' });
    panel.resetPosted();
    const tree = panel.el('tree');
    tree.value = 'columnHeader1';
    tree.dispatchEvent(new panel.window.Event('change', { bubbles: true }));
    expect(panel.posted).toContainEqual({ type: 'pick', id: 'columnHeader1' });
    // the host's select of it keeps the list on it
    panel.send({ type: 'select', id: 'columnHeader1' });
    expect(tree.value).toBe('columnHeader1');
  });
});

describe('the canvas tray', () => {
  const tray = [
    { id: 'timer1', name: 'timer1', type: 'System.Windows.Forms.Timer' },
    { id: 'columnHeader1', name: 'columnHeader1', type: 'System.Windows.Forms.ColumnHeader', trayHidden: true },
  ];

  it('draws no chip for a tray-hidden component, and its selection survives a re-layout', () => {
    const designer = loadDesigner();
    designer.send({ type: 'layout', controls: [form, list] });
    designer.send({ type: 'tray', items: tray });
    const chips = [...designer.el('tray').querySelectorAll('.trayItem')].map((chip: any) => chip._trayId);
    expect(chips).toEqual(['timer1']);
    // selected in the Properties list, then the form re-lays out (an edit, a re-render)
    designer.send({ type: 'select', id: 'columnHeader1' });
    designer.send({ type: 'layout', controls: [form, list] });
    designer.send({ type: 'tray', items: tray });
    expect(designer.el('selName').textContent).toBe('columnHeader1 : ColumnHeader');
    // and Delete acts on it
    designer.resetPosted();
    designer.key('keydown', { key: 'Delete' });
    expect(designer.posted.some((message: any) => JSON.stringify(message).includes('columnHeader1'))).toBe(true);
  });

  it("opens a chip's menu for that chip's component", () => {
    const designer = loadDesigner();
    designer.send({ type: 'layout', controls: [form] });
    designer.send({ type: 'tray', items: [tray[1], tray[0]] }); // the hidden one first: its chip is not the first
    designer.resetPosted();
    const chip = designer.el('tray').querySelector('.trayItem');
    chip.dispatchEvent(new designer.window.MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 }));
    expect(designer.posted).toContainEqual(expect.objectContaining({ type: 'pick', id: 'timer1' }));
  });
});
