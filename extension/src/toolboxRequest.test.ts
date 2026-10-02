import { afterEach, describe, expect, it } from 'vitest';
import { classifyToolboxRequest } from './toolboxRequest';
import { drainHarnesses, loadChooseItems, type Harness } from './webviewHarness';

afterEach(drainHarnesses);

function selectScope(harness: Harness, scope: 'net' | 'com' | 'wpf'): void {
  harness.click(harness.document.querySelector(`#ciTabs [data-tab="${scope}"]`));
}

function sendRefusal(harness: Harness, scope: 'com' | 'wpf'): void {
  harness.send({ type: 'scopeRefused', scope, ...classifyToolboxRequest(scope) });
}

describe('toolbox request classification', () => {
  it('permits only the exact .NET scope', () => {
    expect(classifyToolboxRequest('net')).toEqual({ status: 'allowed', scope: 'net' });
  });

  it.each([
    ['com', 'COM_ACTIVE_X_UNSUPPORTED'],
    ['wpf', 'WPF_TOOLBOX_UNSUPPORTED'],
  ])('returns the named refusal for %s without granting a mutating action', (scope, reasonCode) => {
    const result = classifyToolboxRequest(scope);
    expect(result).toMatchObject({ status: 'refused', reasonCode, actions: ['viewCode'] });
    expect(result.status === 'refused' && result.message.length).toBeGreaterThan(20);
  });

  it('rejects omitted, malformed and similar scopes without coercing or echoing input', () => {
    const hostile = { toString() { throw new Error('Scope coercion must not run'); } };
    const inputs: unknown[] = [undefined, null, false, 0, {}, hostile, [], ['net'], 'NET', 'Net', ' net', 'net ', 'COM', 'wpf\0', '__proto__', 'constructor', '<script>private-source</script>'];
    const reference = classifyToolboxRequest(undefined);
    for (const input of inputs) {
      expect(classifyToolboxRequest(input)).toEqual(reference);
    }
    expect(reference).toMatchObject({ status: 'refused', reasonCode: 'TOOLBOX_SCOPE_INVALID', actions: ['viewCode'] });
    expect(JSON.stringify(reference)).not.toContain('private-source');
  });
});

describe('Choose Items scope request boundary', () => {
  it.each(['com', 'wpf'] as const)('requests and displays the host refusal for %s while browse/apply remain blocked', scope => {
    const harness = loadChooseItems();
    harness.resetPosted();
    selectScope(harness, scope);
    expect(harness.posted).toEqual([{ type: 'requestScope', scope }]);
    expect(harness.el('ciLoading').style.display).toBe('none');
    expect(harness.el('ciBrowse').disabled).toBe(true);
    expect(harness.el('ciOk').disabled).toBe(true);
    sendRefusal(harness, scope);
    const refusal = classifyToolboxRequest(scope);
    if (refusal.status !== 'refused') throw new Error('Expected an unsupported scope');
    expect(harness.el('ciTable').textContent).toContain(refusal.reasonCode);
    expect(harness.el('ciTable').textContent).toContain(refusal.message);
    expect(harness.el('ciStatus').textContent).toContain(refusal.reasonCode);
    expect(harness.el('ciTable').querySelector('[role="status"]')).not.toBeNull();
    harness.click(harness.el('ciBrowse'));
    harness.click(harness.el('ciOk'));
    expect(harness.posted).toEqual([{ type: 'requestScope', scope }]);
  });

  it('ignores another tab response and clears the refusal when returning to .NET', () => {
    const harness = loadChooseItems();
    selectScope(harness, 'com');
    selectScope(harness, 'wpf');
    sendRefusal(harness, 'com');
    expect(harness.el('ciTable').textContent).not.toContain('COM_ACTIVE_X_UNSUPPORTED');
    sendRefusal(harness, 'wpf');
    expect(harness.el('ciTable').textContent).toContain('WPF_TOOLBOX_UNSUPPORTED');
    selectScope(harness, 'net');
    sendRefusal(harness, 'wpf');
    expect(harness.el('ciTable').textContent).not.toContain('WPF_TOOLBOX_UNSUPPORTED');
    expect(harness.el('ciStatus').textContent).not.toContain('WPF_TOOLBOX_UNSUPPORTED');
    expect(harness.el('ciBrowse').disabled).toBe(false);
    expect(harness.el('ciOk').disabled).toBe(false);
    expect(harness.el('ciReset').disabled).toBe(true);
    harness.resetPosted();
    harness.click(harness.el('ciBrowse'));
    harness.click(harness.el('ciOk'));
    expect(harness.posted.map(value => ({ type: value.type, scope: value.scope }))).toEqual([
      { type: 'browse', scope: 'net' }, { type: 'applyChooseItems', scope: 'net' },
    ]);
  });

  it('renders host refusal text as text and ignores unknown refusal codes', () => {
    const harness = loadChooseItems();
    selectScope(harness, 'com');
    const injected = '<img src="https://invalid.test" onerror="attack()"> & <script>attack()</script>';
    harness.send({ type: 'scopeRefused', scope: 'com', reasonCode: 'COM_ACTIVE_X_UNSUPPORTED', message: injected });
    expect(harness.el('ciTable').querySelectorAll('img, script, [onerror]')).toHaveLength(0);
    expect(harness.el('ciTable').querySelector('p').textContent).toBe(injected);
    for (const value of [null, undefined, {
      type: 'scopeRefused', scope: 'com', reasonCode: '<script>attack()</script>', message: 'Unknown response',
    }, {
      type: 'scopeRefused', scope: 'com', reasonCode: 'COM_ACTIVE_X_UNSUPPORTED', message: {},
    }]) harness.send(value);
    expect(harness.el('ciTable').querySelector('p').textContent).toBe(injected);
  });

  it('preserves the .NET selection and host refusal when delayed item/browse results arrive', () => {
    const harness = loadChooseItems();
    harness.send({
      type: 'items', tab: 'General', chosen: ['Demo.Widget'], check: [],
      items: [{ name: 'Widget', namespace: 'Demo', assemblyName: 'Demo.Controls' }],
    });
    selectScope(harness, 'com');
    sendRefusal(harness, 'com');
    harness.send({ type: 'browseResult', message: 'Previous .NET browse completed' });
    expect(harness.el('ciStatus').textContent).toContain('COM_ACTIVE_X_UNSUPPORTED');
    harness.send({
      type: 'items', tab: 'General', chosen: [], check: [],
      items: [{ name: 'Widget', namespace: 'Demo', assemblyName: 'Demo.Controls' }],
    });
    expect(harness.el('ciStatus').textContent).toContain('COM_ACTIVE_X_UNSUPPORTED');
    selectScope(harness, 'net');
    expect(harness.el('ciTable').querySelector('input[type="checkbox"]').checked).toBe(true);
  });
});
