import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import type * as vscode from 'vscode';
import {
  authorizeFormStatusAction, bindFormStatusView, renderFormStatusHtml,
  type FormStatusLabels, type FormStatusSnapshot,
} from './formStatusView';

const NONCE = '0123456789abcdef0123456789abcdef';
const labels: FormStatusLabels = {
  title: 'Form status', fieldsHeading: 'Resolved context', diagnosticsHeading: 'Diagnostics',
  adaptersHeading: 'Adapter manifests', noDiagnostics: 'No current diagnostics', noAdapters: 'No manifests',
  details: 'Details', target: 'Affected item', loading: 'Loading status', loadFailed: 'Status unavailable',
  actionFailed: 'Action failed', severity: { info: 'Information', warning: 'Warning', error: 'Error' },
  actions: {
    retry: 'Retry render', rebuild: 'Rebuild', chooseAssembly: 'Choose assembly', viewCode: 'View code',
    clearCache: 'Clear cache', restart: 'Restart worker', reinstall: 'Open extension', refresh: 'Refresh',
  },
};

function snapshot(overrides: Partial<FormStatusSnapshot> = {}): FormStatusSnapshot {
  return {
    documentId: 'file:///project/Form1.cs', revision: 3, title: 'Form1',
    fields: [{ label: 'Runtime', value: '.NET 10' }],
    diagnostics: [{ code: 'BUILD_REQUIRED', severity: 'warning', message: 'Build the form.', actions: ['rebuild'] }],
    ...overrides,
  };
}

function message(action = 'rebuild', state: FormStatusSnapshot | undefined = snapshot()): unknown {
  return {
    type: 'formStatusAction', action,
    documentId: state?.documentId ?? null, revision: state?.revision ?? null,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}

function panelHarness(): {
  panel: vscode.WebviewPanel;
  renders: string[];
  receive: (value: unknown) => Promise<void>;
  dispose: () => void;
  listenerDisposed: ReturnType<typeof vi.fn>;
} {
  const renders: string[] = [];
  let receive!: (value: unknown) => Promise<void>;
  let dispose!: () => void;
  const listenerDisposed = vi.fn();
  const panel = {
    webview: {
      set html(value: string) { renders.push(value); },
      get html() { return renders.at(-1) ?? ''; },
      postMessage: vi.fn(async () => true),
      onDidReceiveMessage: (callback: (value: unknown) => Promise<void>) => {
        receive = callback;
        return { dispose: listenerDisposed };
      },
    },
    onDidDispose: (callback: () => void) => { dispose = callback; return { dispose() {} }; },
  } as unknown as vscode.WebviewPanel;
  return { panel, renders, receive: value => receive(value), dispose: () => dispose(), listenerDisposed };
}

describe('form status action authorization', () => {
  it('allows only currently offered catalogue actions and refresh', () => {
    expect(authorizeFormStatusAction(message('rebuild'), snapshot())).toBe('rebuild');
    expect(authorizeFormStatusAction(message('refresh'), snapshot())).toBe('refresh');
    expect(authorizeFormStatusAction(message('restart'), snapshot())).toBeUndefined();
    const malicious = snapshot({ diagnostics: [{
      code: 'X', severity: 'error', message: 'X', actions: ['executeCommand', 'constructor', 'toString'],
    }] });
    for (const action of malicious.diagnostics[0].actions) {
      expect(authorizeFormStatusAction(message(action, malicious), malicious)).toBeUndefined();
    }
  });

  it('rejects stale revisions, another document, and malformed messages', () => {
    for (const candidate of [
      undefined, null, [], 'rebuild', 3, {},
      { type: 'command', action: 'rebuild', documentId: snapshot().documentId, revision: 3 },
      { type: 'formStatusAction', action: 'rebuild', documentId: snapshot().documentId, revision: '3' },
      message('rebuild', snapshot({ revision: 2 })),
      message('rebuild', snapshot({ documentId: 'file:///project/Other.cs' })),
    ]) expect(authorizeFormStatusAction(candidate, snapshot())).toBeUndefined();
    expect(authorizeFormStatusAction(message('rebuild', snapshot({ revision: NaN })), snapshot({ revision: NaN })))
      .toBeUndefined();
    expect(authorizeFormStatusAction(message('rebuild', snapshot({ revision: -1 })), snapshot({ revision: -1 })))
      .toBeUndefined();
  });

  it('permits recovery of a failed initial read without granting other actions', () => {
    const refresh = { type: 'formStatusAction', action: 'refresh', documentId: null, revision: null };
    expect(authorizeFormStatusAction(refresh, undefined)).toBe('refresh');
    expect(authorizeFormStatusAction({ ...refresh, action: 'rebuild' }, undefined)).toBeUndefined();
    expect(authorizeFormStatusAction(message('refresh'), undefined)).toBeUndefined();
  });
});

describe('form status HTML', () => {
  it('escapes all displayed values and keeps source-like strings out of executable markup', () => {
    const injected = '<img src="https://invalid.test" onerror="attack()"> & \' </script><script>attack()</script>';
    const state = snapshot({
      documentId: injected, title: injected, fields: [{ label: injected, value: injected }],
      diagnostics: [{ code: injected, severity: 'error', message: injected, target: injected, actions: ['rebuild'] }],
      adapterRows: [{ id: injected, state: injected, message: injected }],
    });
    const localLabels = { ...labels, title: injected, language: injected, actions: { ...labels.actions, rebuild: injected } };
    const dom = new JSDOM(renderFormStatusHtml(state, localLabels, NONCE, injected));
    const document = dom.window.document;
    expect(document.querySelectorAll('script')).toHaveLength(1);
    expect(document.querySelectorAll('img, [onerror], [src], [href]')).toHaveLength(0);
    expect(document.querySelector('h1').textContent).toBe(injected);
    expect(document.querySelector('main').dataset.documentId).toBe(injected);
    expect(document.documentElement.lang).toBe(injected);
    expect(document.querySelector('dt').textContent).toBe(injected);
    expect(document.querySelector('dd').textContent).toBe(injected);
    expect(document.querySelector('.diagnostic code').textContent).toBe(injected);
    expect(document.querySelector('.diagnostic p').textContent).toBe(injected);
    expect(document.querySelector('[data-action="rebuild"]').textContent).toBe(injected);
    expect(document.querySelector('#status-notice').textContent).toBe(injected);
    dom.window.close();
  });

  it('uses a nonce CSP with no external resources and rejects invalid nonce syntax', () => {
    const dom = new JSDOM(renderFormStatusHtml(snapshot(), labels, NONCE));
    const document = dom.window.document;
    expect(document.querySelector('meta[http-equiv="Content-Security-Policy"]').content).toBe(
      `default-src 'none'; style-src 'nonce-${NONCE}'; script-src 'nonce-${NONCE}'; base-uri 'none'; form-action 'none';`,
    );
    expect(document.querySelector('script').nonce).toBe(NONCE);
    expect(document.querySelector('style').nonce).toBe(NONCE);
    expect(() => renderFormStatusHtml(snapshot(), labels, "nonce' unsafe-inline")).toThrow('Invalid form status nonce');
    dom.window.close();
  });

  it('uses native headings, expandable details and visible severity labels; filters unknown actions', () => {
    const state = snapshot({ diagnostics: [{
      code: 'X', severity: 'warning', message: 'Not available', target: 'Control1',
      actions: ['rebuild', 'rebuild', 'constructor', 'refresh', 'https://invalid.test'],
    }] });
    const dom = new JSDOM(renderFormStatusHtml(state, labels, NONCE));
    const document = dom.window.document;
    expect(document.querySelector('main h1').textContent).toBe('Form1');
    expect(document.querySelectorAll('details > summary').length).toBe(3);
    expect(document.querySelector('.diagnostic strong').textContent).toBe('Warning');
    expect(document.querySelector('.diagnostic dd').textContent).toBe('Control1');
    expect(Array.from(document.querySelectorAll('button')).map((button: any) => button.dataset.action))
      .toEqual(['refresh', 'rebuild']);
    expect(document.querySelector('[role="status"]').getAttribute('aria-live')).toBe('polite');
    dom.window.close();
  });

  it('executes its fixed client script and posts only the document identity, revision and action', () => {
    const posted: unknown[] = [];
    const state = snapshot({ documentId: 'file:///project/A "quoted" & B.cs' });
    const dom = new JSDOM(renderFormStatusHtml(state, labels, NONCE), {
      runScripts: 'dangerously',
      beforeParse(window: any) { window.acquireVsCodeApi = () => ({ postMessage: (value: unknown) => posted.push(value) }); },
    });
    const document = dom.window.document;
    document.querySelector('[data-action="rebuild"]').click();
    expect(posted).toEqual([message('rebuild', state)]);
    expect(document.querySelector('[data-action="rebuild"]').disabled).toBe(true);
    document.querySelector('[data-action="rebuild"]').click();
    expect(posted).toHaveLength(1);
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { type: 'formStatusBusy', busy: false } }));
    document.querySelector('[data-action="refresh"]').click();
    expect(posted[1]).toEqual(message('refresh', state));
    dom.window.close();
  });
});

describe('form status host lifecycle', () => {
  it('rechecks the host snapshot and passes that snapshot to an authorized action', async () => {
    const harness = panelHarness();
    const initial = snapshot();
    const current = snapshot({ title: 'Current host context' });
    const getSnapshot = vi.fn().mockResolvedValueOnce(initial).mockResolvedValue(current);
    const onAction = vi.fn().mockResolvedValue(undefined);
    bindFormStatusView(harness.panel, getSnapshot, onAction, labels);
    await Promise.resolve();
    await harness.receive(message());
    expect(onAction).toHaveBeenCalledExactlyOnceWith('rebuild', current);
    expect(getSnapshot).toHaveBeenCalledTimes(3);
    expect(harness.panel.webview.html).not.toContain(' disabled');
    expect(harness.panel.webview.html).toContain('aria-busy="false"');
    harness.dispose();
  });

  it.each([
    snapshot({ revision: 4 }),
    snapshot({ documentId: 'file:///project/Other.cs' }),
    snapshot({ diagnostics: [] }),
  ])('does not run an action whose latest host context changed', async current => {
    const harness = panelHarness();
    const getSnapshot = vi.fn().mockResolvedValueOnce(snapshot()).mockResolvedValue(current);
    const onAction = vi.fn().mockResolvedValue(undefined);
    bindFormStatusView(harness.panel, getSnapshot, onAction, labels);
    await Promise.resolve();
    await harness.receive(message());
    expect(onAction).not.toHaveBeenCalled();
    expect(getSnapshot).toHaveBeenCalledTimes(2);
    harness.dispose();
  });

  it('rejects a forged action before another snapshot read', async () => {
    const harness = panelHarness();
    const getSnapshot = vi.fn().mockResolvedValue(snapshot());
    const onAction = vi.fn();
    bindFormStatusView(harness.panel, getSnapshot, onAction, labels);
    await Promise.resolve();
    await harness.receive(message('restart'));
    expect(getSnapshot).toHaveBeenCalledTimes(1);
    expect(onAction).not.toHaveBeenCalled();
    harness.dispose();
  });

  it('ignores duplicate messages until the authorized action completes', async () => {
    const harness = panelHarness();
    const pending = deferred<void>();
    const onAction = vi.fn(() => pending.promise);
    bindFormStatusView(harness.panel, async () => snapshot(), onAction, labels);
    await Promise.resolve();
    const running = harness.receive(message());
    await Promise.resolve();
    await Promise.resolve();
    await harness.receive(message());
    expect(onAction).toHaveBeenCalledTimes(1);
    pending.resolve();
    await running;
    harness.dispose();
  });

  it('discards an earlier refresh result after a newer refresh finishes', async () => {
    const harness = panelHarness();
    const initialRead = deferred<FormStatusSnapshot>();
    const getSnapshot = vi.fn().mockReturnValueOnce(initialRead.promise).mockResolvedValue(snapshot({ title: 'Newest' }));
    bindFormStatusView(harness.panel, getSnapshot, vi.fn(), labels);
    await harness.receive({ type: 'formStatusAction', action: 'refresh', documentId: null, revision: null });
    initialRead.resolve(snapshot({ title: 'Outdated' }));
    await Promise.resolve();
    expect(harness.panel.webview.html).toContain('<h1>Newest</h1>');
    expect(harness.panel.webview.html).not.toContain('Outdated');
    harness.dispose();
  });

  it('never renders or invokes a pending action after disposal', async () => {
    const harness = panelHarness();
    const pending = deferred<FormStatusSnapshot>();
    const getSnapshot = vi.fn().mockResolvedValueOnce(snapshot()).mockReturnValue(pending.promise);
    const onAction = vi.fn();
    bindFormStatusView(harness.panel, getSnapshot, onAction, labels);
    await Promise.resolve();
    const running = harness.receive(message());
    const renderCount = harness.renders.length;
    harness.dispose();
    pending.resolve(snapshot());
    await running;
    expect(harness.renders).toHaveLength(renderCount);
    expect(harness.listenerDisposed).toHaveBeenCalledTimes(1);
    expect(onAction).not.toHaveBeenCalled();
  });

  it('shows catalogue failure text and permits refresh without displaying the thrown error', async () => {
    const harness = panelHarness();
    const getSnapshot = vi.fn().mockRejectedValueOnce(new Error('private diagnostic text')).mockResolvedValue(snapshot());
    bindFormStatusView(harness.panel, getSnapshot, vi.fn(), labels);
    await Promise.resolve();
    expect(harness.panel.webview.html).toContain(labels.loadFailed);
    expect(harness.panel.webview.html).not.toContain('private diagnostic text');
    await harness.receive({ type: 'formStatusAction', action: 'refresh', documentId: null, revision: null });
    expect(harness.panel.webview.html).toContain('<h1>Form1</h1>');
    harness.dispose();
  });

  it('contains action failures and restores availability of the panel', async () => {
    const harness = panelHarness();
    const onAction = vi.fn().mockRejectedValueOnce(new Error('private action detail')).mockResolvedValue(undefined);
    bindFormStatusView(harness.panel, async () => snapshot(), onAction, labels);
    await Promise.resolve();
    await harness.receive(message());
    expect(harness.panel.webview.html).toContain(labels.actionFailed);
    expect(harness.panel.webview.html).not.toContain('private action detail');
    expect(harness.panel.webview.html).not.toContain(' disabled');
    await harness.receive(message());
    expect(onAction).toHaveBeenCalledTimes(2);
    harness.dispose();
  });
});
