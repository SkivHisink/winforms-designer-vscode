import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdapterPackage, AdapterRequest, SetPropertyIntent } from '../../adapter-sdk/index.mjs';

const host = vi.hoisted(() => {
  class Uri {
    readonly scheme = 'file';
    constructor(readonly fsPath: string) {}
    toString() { return `file:///${this.fsPath.replace(/\\/g, '/')}`; }
    static file(value: string) { return new Uri(value); }
    static parse(value: string) { return new Uri(decodeURIComponent(value.slice('file:///'.length))); }
  }
  class TabInputCustom { constructor(readonly uri: Uri) {} }
  class Events {
    readonly listeners = new Set<() => void>();
    readonly listen = (listener: () => void) => {
      this.listeners.add(listener);
      return { dispose: vi.fn(() => this.listeners.delete(listener)) };
    };
    fire() { for (const listener of [...this.listeners]) listener(); }
  }
  class QuickInput {
    title = ''; placeholder = ''; ignoreFocusOut = true; value = '';
    items: { label: string }[] = []; selectedItems: { label: string }[] = [];
    readonly accepted = new Events(); readonly hidden = new Events();
    readonly onDidAccept = this.accepted.listen; readonly onDidHide = this.hidden.listen;
    readonly show = vi.fn(); readonly hide = vi.fn(() => this.hidden.fire()); readonly dispose = vi.fn();
  }
  return {
    Uri, TabInputCustom, QuickInput, tabChanges: new Events(),
    commands: new Map<string, (...args: any[]) => any>(), pickers: [] as QuickInput[],
    isTrusted: true, activeInput: undefined as TabInputCustom | undefined,
    getWorkspaceFolder: vi.fn(), showOpenDialog: vi.fn(), showWarningMessage: vi.fn(), showQuickPick: vi.fn(),
    openTextDocument: vi.fn(), showTextDocument: vi.fn(),
    inspectPackage: vi.fn(), invokePackage: vi.fn(), activeSession: undefined as { documentUri: Uri } | undefined,
  };
});

vi.mock('vscode', () => ({
  Uri: host.Uri, TabInputCustom: host.TabInputCustom,
  workspace: { get isTrusted() { return host.isTrusted; }, getWorkspaceFolder: host.getWorkspaceFolder, openTextDocument: host.openTextDocument },
  window: {
    showOpenDialog: host.showOpenDialog, showWarningMessage: host.showWarningMessage, showQuickPick: host.showQuickPick,
    showTextDocument: host.showTextDocument,
    createQuickPick: () => { const picker = new host.QuickInput(); host.pickers.push(picker); return picker; },
    createInputBox: () => { const picker = new host.QuickInput(); host.pickers.push(picker); return picker; },
    tabGroups: {
      activeTabGroup: { get activeTab() { return { input: host.activeInput }; } },
      onDidChangeTabs: host.tabChanges.listen,
    },
  },
  commands: { registerCommand: (id: string, handler: (...args: any[]) => any) => {
    host.commands.set(id, handler);
    return { dispose: () => { if (host.commands.get(id) === handler) host.commands.delete(id); } };
  } },
}));
vi.mock('./designerEditor', () => ({ DesignerHub: { instance: { get activeSession() { return host.activeSession; } } } }));
vi.mock('./adapterRuntime', () => ({ inspectAdapterPackage: host.inspectPackage, invokeAdapterPackage: host.invokePackage }));
vi.mock('./i18n', () => ({ t: (key: string, values?: Record<string, unknown>) => values ? `${key}:${JSON.stringify(values)}` : key }));

import { registerAdapterCommands } from './adapterCommands';

const GRANTS_KEY = 'winformsDesigner.adapterDevelopmentGrants.v1';
const SHA = 'a'.repeat(64);
const packageUri = host.Uri.file('D:\\workspace\\Adapters\\adapter-package.json');
const documentUri = host.Uri.file('D:\\workspace\\Form1.Designer.cs');
const workspaceUri = host.Uri.file('D:\\workspace');
const sourceText = 'partial class Form1 { }';
const intent: SetPropertyIntent = { kind: 'setProperty', componentId: 'button1', propertyName: 'Text', propertyType: 'System.String', invariantValue: 'new' };
function packageManifest(): AdapterPackage {
  return {
    schemaId: 'winforms-designer.adapter-package', schemaVersion: 1, sdkVersion: '0.1.0',
    adapter: { id: 'test.adapter', version: '0.1.0', displayName: 'Test adapter' },
    cohort: { productId: 'winforms-designer-vscode', minProductVersion: '2.3.0', maxProductVersionExclusive: '2.4.0', runtimes: ['modern', 'net48'], architectures: ['x64', 'arm64'] },
    execution: { kind: 'node-stdio', entrypoint: 'entry.mjs' }, integrity: { algorithm: 'sha256', files: [] },
    provenance: { policy: 'local-development', certification: 'none' }, capabilities: ['action.set-property', 'editor.scalar'],
    contributions: {
      actions: [{ id: 'sample.action', title: 'Action', propertyName: 'Text', propertyType: 'System.String' }],
      editors: [{ id: 'sample.editor', title: 'Text editor', propertyName: 'Text', propertyType: 'System.String', presentation: 'input' }],
    },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function success(request?: AdapterRequest) {
  return { ok: true, response: { protocolId: 'winforms-designer.adapter-stdio', protocolVersion: 1,
    id: request?.id ?? 'request', status: 'ok', intent } };
}
const contexts: { subscriptions: { dispose(): unknown }[] }[] = [];
function createCommands(state = new Map<string, unknown>()) {
  const context = {
    subscriptions: [] as { dispose(): unknown }[], extension: { packageJSON: { version: '2.3.0' } },
    workspaceState: { get: vi.fn((key: string) => state.get(key)), update: vi.fn(async (key: string, value: unknown) => { state.set(key, value); }) },
  };
  const target = { documentUri: documentUri.toString(), documentInstanceId: 'document-instance-1', revision: 7, sourceText, runtime: 'net48', architecture: 'arm64',
    invariantValue: 'old', serviceProfile: { ok: true, serviceProfileVersion: '0.1.0', contracts: [{ capability: 'Transactions' }, { capability: 'PropertySerialization' }] } };
  const provider = {
    inspectAdapterContext: vi.fn(async (_uri: unknown, _component?: string, _property?: string, _type?: string) => target),
    inspectDocument: vi.fn(async (_uri: unknown) => ({ ready: true, revision: 7, sourceText })),
    applyAdapterIntent: vi.fn(async (_uri: unknown, _intent: unknown, _revision: number, _source: string, _enabled: () => boolean,
      _verifyPackage?: () => Promise<boolean>, _documentInstanceId?: string):
      Promise<{ status: 'ok' | 'refused'; applied?: boolean; code?: string }> => ({ status: 'ok', applied: true })),
    configureAdapterActions: vi.fn(async (_uri: unknown, _packageUri: unknown, _sha: string, _actions: unknown) => undefined),
    removeAdapterActions: vi.fn(async (_packageUri: unknown) => undefined),
  };
  const output = { appendLine: vi.fn() };
  registerAdapterCommands(context as never, provider as never, output as never);
  contexts.push(context);
  return { context, provider, target, output, state };
}
function command(name: string, args: Record<string, unknown> = {}) {
  const handler = host.commands.get(`winformsDesigner.${name}`);
  if (!handler) throw new Error(`Missing public command ${name}`);
  return handler({ documentUri, packageUri, ...args });
}
async function grant() {
  expect(await command('enableAdapterDevelopment', { expectedPackageSha256: SHA, acknowledgeTrustedCodeExecution: true }))
    .toEqual({ ok: true, packageSha256: SHA });
}
async function flush() { for (let turn = 0; turn < 12; turn += 1) await Promise.resolve(); }
function action(args: Record<string, unknown> = {}) { return command('invokeAdapterAction', { contributionId: 'sample.action', componentId: 'button1', ...args }); }
function edit(args: Record<string, unknown> = {}) { return command('editAdapterProperty', { contributionId: 'sample.editor', componentId: 'button1', ...args }); }

describe('public local adapter commands', () => {
  let manifest: AdapterPackage;
  beforeEach(() => {
    vi.resetAllMocks(); vi.useFakeTimers();
    host.commands.clear(); host.pickers.splice(0); host.tabChanges.listeners.clear();
    host.isTrusted = true; host.activeInput = new host.TabInputCustom(documentUri); host.activeSession = { documentUri };
    manifest = packageManifest();
    host.getWorkspaceFolder.mockReturnValue({ uri: workspaceUri });
    host.showOpenDialog.mockResolvedValue(undefined); host.showWarningMessage.mockResolvedValue(undefined);
    host.openTextDocument.mockImplementation(async document => ({ ...document, uri: host.Uri.file('D:\\diagnostic.json') }));
    host.showTextDocument.mockResolvedValue(undefined);
    host.inspectPackage.mockImplementation(async (_file, runtime) => runtime.workspaceTrusted
      ? { ok: true, diagnostics: [], manifest, packageSha256: SHA, provenance: 'local-development', certification: 'none' }
      : { ok: false, diagnostics: [{ code: 'ADAPTER_WORKSPACE_UNTRUSTED' }] });
    host.invokePackage.mockImplementation(async (_file, _runtime, options) => options.request.input.cancel
      ? { ok: true, response: { status: 'cancelled' } } : success(options.request));
  });
  afterEach(() => {
    for (const context of contexts.splice(0)) for (const subscription of context.subscriptions) subscription.dispose();
    vi.clearAllTimers(); vi.useRealTimers();
  });

  it('passes the selected worker architecture and actual service capabilities to data-only inspection', async () => {
    const { provider } = createCommands();
    expect(await command('inspectAdapterPackage')).toMatchObject({ ok: true, packageSha256: SHA });
    expect(host.inspectPackage).toHaveBeenCalledWith(packageUri.fsPath, {
      workspaceRoot: workspaceUri.fsPath, productVersion: '2.3.0', runtime: 'net48', architecture: 'arm64',
      workspaceTrusted: true, availableServices: ['Transactions', 'PropertySerialization'],
    });
    expect(host.invokePackage).not.toHaveBeenCalled();
    expect(provider.configureAdapterActions).not.toHaveBeenCalled();
  });
  it('publishes only exact-granted action metadata on enable and invocation', async () => {
    const { provider } = createCommands();
    await command('inspectAdapterPackage'); expect(provider.configureAdapterActions).not.toHaveBeenCalled();
    await grant();
    expect(provider.configureAdapterActions).toHaveBeenLastCalledWith(documentUri, packageUri.toString(), SHA, manifest.contributions.actions);
    provider.configureAdapterActions.mockClear(); await action();
    expect(provider.configureAdapterActions).toHaveBeenCalledWith(documentUri, packageUri.toString(), SHA, manifest.contributions.actions);
  });
  it('removes published actions synchronously before waiting for disabled-grant persistence', async () => {
    const { context, provider } = createCommands(); await grant();
    const persisted = deferred<void>(); context.workspaceState.update.mockImplementationOnce(() => persisted.promise);
    const pending = command('disableAdapter'); await flush();
    expect(provider.removeAdapterActions).toHaveBeenCalledWith(packageUri.toString());
    expect(await action()).toEqual({ status: 'refused', code: 'ADAPTER_ENABLEMENT_REQUIRED' });
    persisted.resolve(); expect(await pending).toEqual({ ok: true });
  });
  it('refreshes persisted grants as data-only metadata for an active custom editor', async () => {
    const grantKey = path.resolve(packageUri.fsPath).toLocaleLowerCase('en-US');
    const { provider } = createCommands(new Map([[GRANTS_KEY, [{ path: grantKey, sha256: SHA }]]]));
    await flush();
    expect(provider.configureAdapterActions).toHaveBeenCalledWith(documentUri, host.Uri.file(grantKey).toString(), SHA, manifest.contributions.actions);
    expect(host.invokePackage).not.toHaveBeenCalled(); expect(provider.applyAdapterIntent).not.toHaveBeenCalled();
  });
  it('refreshes exact-granted metadata after active tab changes without executing the package', async () => {
    const { provider } = createCommands(); await grant(); provider.configureAdapterActions.mockClear();
    host.tabChanges.fire(); await flush();
    expect(provider.configureAdapterActions).toHaveBeenCalled(); expect(host.invokePackage).not.toHaveBeenCalled();
  });
  it('does not publish a stale tab refresh after focus moves while inspection is pending', async () => {
    const { provider } = createCommands(); await grant(); provider.configureAdapterActions.mockClear();
    const inspection = deferred<unknown>(); host.inspectPackage.mockReturnValueOnce(inspection.promise);
    host.tabChanges.fire(); await flush();
    host.activeInput = new host.TabInputCustom(host.Uri.file('D:\\workspace\\Other.Designer.cs')); host.tabChanges.fire();
    inspection.resolve({ ok: true, manifest, packageSha256: SHA }); await flush();
    expect(provider.configureAdapterActions).not.toHaveBeenCalled(); expect(host.invokePackage).not.toHaveBeenCalled();
  });
  it('does not publish a tab refresh whose grant was revoked while inspection was pending', async () => {
    const { provider } = createCommands(); await grant(); provider.configureAdapterActions.mockClear();
    const inspection = deferred<unknown>(); host.inspectPackage.mockReturnValueOnce(inspection.promise);
    host.tabChanges.fire(); await flush(); await command('disableAdapter');
    inspection.resolve({ ok: true, manifest, packageSha256: SHA }); await flush();
    expect(provider.configureAdapterActions).not.toHaveBeenCalled(); expect(host.invokePackage).not.toHaveBeenCalled();
  });
  it('requires both the exact hash and explicit execution acknowledgement to bypass the modal trust prompt', async () => {
    const { context } = createCommands();
    expect(await command('enableAdapterDevelopment', { expectedPackageSha256: SHA })).toEqual({ ok: false, code: 'ADAPTER_CANCELLED' });
    expect(await command('enableAdapterDevelopment', { acknowledgeTrustedCodeExecution: true })).toEqual({ ok: false, code: 'ADAPTER_CANCELLED' });
    expect(host.showWarningMessage).toHaveBeenCalledTimes(2);
    expect(host.showWarningMessage).toHaveBeenLastCalledWith('adapter.trustPrompt', { modal: true }, 'adapter.enableButton');
    expect(context.workspaceState.update).not.toHaveBeenCalled();
    expect(await action()).toEqual({ status: 'refused', code: 'ADAPTER_ENABLEMENT_REQUIRED' });
    expect(host.invokePackage).not.toHaveBeenCalled();
  });
  it('rejects a mismatched expected hash before prompting or persisting authority', async () => {
    const { context } = createCommands();
    expect(await command('enableAdapterDevelopment', { expectedPackageSha256: 'b'.repeat(64), acknowledgeTrustedCodeExecution: true }))
      .toEqual({ ok: false, code: 'ADAPTER_ENABLEMENT_HASH_MISMATCH' });
    expect(host.showWarningMessage).not.toHaveBeenCalled();
    expect(context.workspaceState.update).not.toHaveBeenCalled();
    expect(host.invokePackage).not.toHaveBeenCalled();
  });
  it('rejects a stale canvas package hash before publication or child execution', async () => {
    const { provider } = createCommands(); await grant(); provider.configureAdapterActions.mockClear();
    expect(await action({ expectedPackageSha256: 'b'.repeat(64) })).toEqual({ status: 'refused', code: 'ADAPTER_ENABLEMENT_HASH_MISMATCH' });
    expect(provider.configureAdapterActions).not.toHaveBeenCalled(); expect(host.invokePackage).not.toHaveBeenCalled();
  });
  it.each([
    { expectedDocumentRevision: 6 }, { expectedDocumentRevision: '7' }, { expectedDocumentInstanceId: 'closed-document' },
  ])('rejects stale canvas document binding %j before executing', async expected => {
    const { provider } = createCommands(); await grant(); provider.configureAdapterActions.mockClear();
    expect(await action(expected)).toEqual({ status: 'refused', code: 'ADAPTER_DOCUMENT_CHANGED' });
    expect(host.invokePackage).not.toHaveBeenCalled(); expect(provider.configureAdapterActions).not.toHaveBeenCalled();
  });
  it('accepts the matching canvas hash, revision and document instance', async () => {
    createCommands(); await grant();
    expect(await action({ expectedPackageSha256: SHA, expectedDocumentRevision: 7, expectedDocumentInstanceId: 'document-instance-1' }))
      .toEqual({ status: 'ok', applied: true });
  });
  it.each(['runtime', 'architecture', 'documentInstanceId', 'revision', 'sourceText', 'serviceProfile'] as const)(
    'refuses changed %s between initial package context and concrete property context', async field => {
      const { provider, target } = createCommands(); await grant();
      const changed = { ...target, [field]: field === 'runtime' ? 'modern' : field === 'architecture' ? 'x64'
        : field === 'revision' ? 8 : field === 'serviceProfile' ? { ...target.serviceProfile, contracts: [{ capability: 'Naming' }] } : 'changed' };
      provider.inspectAdapterContext.mockResolvedValueOnce(target).mockResolvedValueOnce(changed as typeof target);
      expect(await action()).toEqual({ status: 'refused', code: 'ADAPTER_DOCUMENT_CHANGED' });
      expect(host.invokePackage).not.toHaveBeenCalled(); expect(provider.applyAdapterIntent).not.toHaveBeenCalled();
    });
  it('persists exact-byte acknowledgement and accepts a freshly registered command set using that grant', async () => {
    const first = createCommands(); await grant();
    const expected = [{ path: path.resolve(packageUri.fsPath).toLocaleLowerCase('en-US'), sha256: SHA }];
    expect(first.state.get(GRANTS_KEY)).toEqual(expected);
    expect(host.showWarningMessage).not.toHaveBeenCalled();
    for (const subscription of first.context.subscriptions) subscription.dispose();
    const second = createCommands(first.state);
    expect(await action()).toEqual({ status: 'ok', applied: true });
    expect(host.invokePackage.mock.calls[0][2].enabledPackageSha256).toBe(SHA);
    expect(second.provider.applyAdapterIntent).toHaveBeenCalledWith(documentUri, intent, 7, sourceText, expect.any(Function), expect.any(Function), 'document-instance-1');
  });
  it('supports explicit modal consent without claiming package certification', async () => {
    const { output } = createCommands(); host.showWarningMessage.mockResolvedValue('adapter.enableButton');
    expect(await command('enableAdapterDevelopment')).toEqual({ ok: true, packageSha256: SHA });
    expect(output.appendLine).toHaveBeenCalledWith(expect.stringContaining('certification=none'));
    expect(host.invokePackage).not.toHaveBeenCalled();
  });
  it('ignores malformed persisted grants instead of using them as execution authority', async () => {
    createCommands(new Map([[GRANTS_KEY, [{ path: path.resolve(packageUri.fsPath).toLocaleLowerCase('en-US'), sha256: SHA.toUpperCase() }, null, { path: 1, sha256: SHA }]]]));
    expect(await action()).toEqual({ status: 'refused', code: 'ADAPTER_ENABLEMENT_REQUIRED' });
    expect(host.invokePackage).not.toHaveBeenCalled();
  });
  it('refuses a changed package hash and an untrusted workspace before execution', async () => {
    const { provider } = createCommands(); await grant();
    host.inspectPackage.mockResolvedValueOnce({ ok: true, manifest, packageSha256: 'b'.repeat(64) });
    expect(await action()).toEqual({ status: 'refused', code: 'ADAPTER_ENABLEMENT_HASH_MISMATCH' });
    host.isTrusted = false;
    expect(await action()).toEqual({ status: 'refused', code: 'ADAPTER_WORKSPACE_UNTRUSTED' });
    expect(host.invokePackage).not.toHaveBeenCalled(); expect(provider.applyAdapterIntent).not.toHaveBeenCalled();
  });
  it('aborts active execution on disable and refuses a late successful result after revocation', async () => {
    const { provider, state } = createCommands(); await grant();
    const result = deferred<ReturnType<typeof success>>(); host.invokePackage.mockReturnValue(result.promise);
    const pending = action(); await flush();
    const options = host.invokePackage.mock.calls[0][2]; expect(options.signal.aborted).toBe(false);
    expect(await command('disableAdapter')).toEqual({ ok: true });
    expect(options.signal.aborted).toBe(true); expect(options.isStillEnabled()).toBe(false); expect(state.get(GRANTS_KEY)).toEqual([]);
    result.resolve(success(options.request));
    expect(await pending).toEqual({ status: 'refused', code: 'ADAPTER_ENABLEMENT_REVOKED' });
    expect(provider.applyAdapterIntent).not.toHaveBeenCalled();
  });
  it('rechecks trust after a response and before passing an intent to the provider', async () => {
    const { provider } = createCommands(); await grant();
    const result = deferred<ReturnType<typeof success>>(); host.invokePackage.mockReturnValue(result.promise);
    const pending = action(); await flush(); host.isTrusted = false; result.resolve(success());
    expect(await pending).toEqual({ status: 'refused', code: 'ADAPTER_ENABLEMENT_REVOKED' });
    expect(provider.applyAdapterIntent).not.toHaveBeenCalled();
  });
  it('does not release the first editor admission when a nested request is busy', async () => {
    createCommands(); await grant(); const pending = edit(); await flush();
    expect(host.pickers).toHaveLength(1);
    expect(await edit()).toEqual({ status: 'refused', code: 'ADAPTER_EDITOR_BUSY' });
    expect(await edit()).toEqual({ status: 'refused', code: 'ADAPTER_EDITOR_BUSY' });
    expect((await command('inspectDocument')).adapterEditor).toMatchObject({ presented: true, presentation: 'input', requestId: expect.any(String) });
    const picker = host.pickers[0]; picker.value = 'accepted'; picker.accepted.fire();
    expect(await pending).toEqual({ status: 'ok', applied: true });
    expect(host.invokePackage.mock.calls[0][2].request.input).toEqual({ invariantValue: 'accepted' });
    expect((await command('inspectDocument')).adapterEditor).toBeNull();
    const next = edit(); await flush(); expect(host.pickers).toHaveLength(2); host.pickers[1].hide();
    expect(await next).toEqual({ status: 'cancelled' });
  });
  it('owns an input box until acceptance, supplies the current value, and disposes every event listener', async () => {
    const { provider } = createCommands(); await grant(); const pending = edit(); await flush();
    const picker = host.pickers[0];
    expect(picker.value).toBe('old'); expect(picker.ignoreFocusOut).toBe(false); expect(picker.show).toHaveBeenCalledOnce();
    expect(picker.title).toContain('Text editor'); expect(host.tabChanges.listeners.size).toBe(2);
    picker.value = 'typed value'; picker.accepted.fire();
    expect(await pending).toEqual({ status: 'ok', applied: true });
    expect(host.invokePackage.mock.calls[0][2].request).toMatchObject({ operation: 'editProperty', contributionId: 'sample.editor',
      context: { componentId: 'button1', propertyName: 'Text', propertyType: 'System.String', invariantValue: 'old', revision: 7 }, input: { invariantValue: 'typed value' } });
    expect(provider.applyAdapterIntent).toHaveBeenCalledOnce(); expect(picker.dispose).toHaveBeenCalledOnce();
    expect(picker.accepted.listeners.size).toBe(0); expect(picker.hidden.listeners.size).toBe(0); expect(host.tabChanges.listeners.size).toBe(1);
    await vi.advanceTimersByTimeAsync(30_001); expect(host.invokePackage).toHaveBeenCalledOnce();
  });
  it('uses a QuickPick for dropdown choices and sends only its selected invariant value', async () => {
    createCommands(); manifest.contributions.editors[0].presentation = 'dropdown'; manifest.contributions.editors[0].choices = ['red', 'blue'];
    await grant(); const pending = edit(); await flush(); const picker = host.pickers[0];
    expect(picker.items).toEqual([{ label: 'red' }, { label: 'blue' }]);
    expect((await command('inspectDocument')).adapterEditor).toMatchObject({ presented: true, presentation: 'dropdown' });
    picker.selectedItems = [picker.items[1]]; picker.accepted.fire();
    expect(await pending).toEqual({ status: 'ok', applied: true });
    expect(host.invokePackage.mock.calls[0][2].request.input).toEqual({ invariantValue: 'blue' });
  });
  it('treats Escape as cancellation without applying a value or retaining editor ownership', async () => {
    const { provider } = createCommands(); await grant(); const pending = edit(); await flush();
    host.pickers[0].hide(); expect(await pending).toEqual({ status: 'cancelled' });
    expect(host.invokePackage.mock.calls[0][2].request.input).toEqual({ cancel: true });
    expect(provider.applyAdapterIntent).not.toHaveBeenCalled(); expect((await command('inspectDocument')).adapterEditor).toBeNull();
  });
  it('cancels an accepted dropdown with no selected item', async () => {
    const { provider } = createCommands(); manifest.contributions.editors[0].presentation = 'dropdown'; manifest.contributions.editors[0].choices = ['one'];
    await grant(); const pending = edit(); await flush(); host.pickers[0].accepted.fire();
    expect(await pending).toEqual({ status: 'cancelled' }); expect(provider.applyAdapterIntent).not.toHaveBeenCalled();
  });
  it('refuses a tab focus change before acceptance without starting runtime execution', async () => {
    const { provider } = createCommands(); await grant(); const pending = edit(); await flush();
    host.activeInput = new host.TabInputCustom(host.Uri.file('D:\\workspace\\Other.Designer.cs')); host.tabChanges.fire();
    expect(await pending).toEqual({ status: 'refused', code: 'ADAPTER_FOCUS_CHANGED' });
    expect(host.invokePackage).not.toHaveBeenCalled(); expect(provider.applyAdapterIntent).not.toHaveBeenCalled(); expect(host.pickers[0].dispose).toHaveBeenCalledOnce();
  });
  it('checks focus again at accept even when a tab change event was missed', async () => {
    const { provider } = createCommands(); await grant(); const pending = edit(); await flush();
    host.activeInput = undefined; host.pickers[0].accepted.fire();
    expect(await pending).toEqual({ status: 'refused', code: 'ADAPTER_FOCUS_CHANGED' });
    expect(host.invokePackage).not.toHaveBeenCalled(); expect(provider.applyAdapterIntent).not.toHaveBeenCalled();
  });
  it('refuses a changed worker route while owned UI was awaiting input before starting a child', async () => {
    const { provider, target } = createCommands(); await grant(); const pending = edit(); await flush();
    provider.inspectAdapterContext.mockResolvedValue({ ...target, runtime: 'modern' });
    host.pickers[0].value = 'chosen'; host.pickers[0].accepted.fire();
    expect(await pending).toEqual({ status: 'refused', code: 'ADAPTER_DOCUMENT_CHANGED' });
    expect(host.invokePackage).not.toHaveBeenCalled(); expect(provider.applyAdapterIntent).not.toHaveBeenCalled();
  });
  it('times out owned UI after 30 seconds with no runtime or provider mutation', async () => {
    const { provider } = createCommands(); await grant(); const pending = edit(); await flush();
    await vi.advanceTimersByTimeAsync(29_999); expect(host.pickers[0].dispose).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(await pending).toEqual({ status: 'refused', code: 'ADAPTER_EDITOR_TIMEOUT' });
    expect(host.invokePackage).not.toHaveBeenCalled(); expect(provider.applyAdapterIntent).not.toHaveBeenCalled();
    expect((await command('inspectDocument')).adapterEditor).toBeNull(); expect(host.tabChanges.listeners.size).toBe(1);
  });
  it('revokes and disposes owned UI immediately when its package is disabled', async () => {
    const { provider } = createCommands(); await grant(); const pending = edit(); await flush();
    await command('disableAdapter'); expect(await pending).toEqual({ status: 'refused', code: 'ADAPTER_ENABLEMENT_REVOKED' });
    expect(host.invokePackage).not.toHaveBeenCalled(); expect(provider.applyAdapterIntent).not.toHaveBeenCalled(); expect(host.pickers[0].dispose).toHaveBeenCalledOnce();
  });
  it.each(['invokeAdapterAction', 'editAdapterProperty'])('preserves a disabled reason for %s without creating UI or executing', async name => {
    const { provider } = createCommands(); manifest.contributions.actions[0].disabledReasonCode = 'ADAPTER_TEST_DISABLED'; manifest.contributions.editors[0].disabledReasonCode = 'ADAPTER_TEST_DISABLED';
    await grant(); provider.inspectAdapterContext.mockClear();
    expect(await command(name, { contributionId: name === 'editAdapterProperty' ? 'sample.editor' : 'sample.action' }))
      .toEqual({ status: 'refused', code: 'ADAPTER_TEST_DISABLED' });
    expect(provider.inspectAdapterContext).toHaveBeenCalledTimes(1); expect(host.pickers).toHaveLength(0); expect(host.invokePackage).not.toHaveBeenCalled(); expect(provider.applyAdapterIntent).not.toHaveBeenCalled();
  });
  it('refuses a provider target validation failure before UI or child execution', async () => {
    const { provider, target } = createCommands(); await grant();
    provider.inspectAdapterContext.mockImplementation(async (_uri: unknown, component?: string) => {
      if (component !== undefined) throw new Error('ADAPTER_PROPERTY_UNAVAILABLE'); return target;
    });
    expect(await edit()).toEqual({ status: 'refused', code: 'ADAPTER_PROPERTY_UNAVAILABLE' });
    expect(host.invokePackage).not.toHaveBeenCalled(); expect(host.pickers).toHaveLength(0);
  });
  it('propagates wrong-target runtime refusal without admitting a provider mutation', async () => {
    const { provider } = createCommands(); await grant(); host.invokePackage.mockResolvedValue({ ok: false, diagnostics: [{ code: 'ADAPTER_RESULT_TARGET_MISMATCH' }] });
    expect(await action()).toEqual({ status: 'refused', code: 'ADAPTER_RESULT_TARGET_MISMATCH' }); expect(provider.applyAdapterIntent).not.toHaveBeenCalled();
  });
  it('passes the original revision and source through to a provider that refuses a stale response', async () => {
    const { provider, target } = createCommands(); await grant();
    const response = deferred<ReturnType<typeof success>>(); host.invokePackage.mockReturnValue(response.promise);
    const pending = action(); await flush(); const originalRevision = target.revision; const originalSource = target.sourceText;
    // A fresh provider snapshot is a new object; the in-flight command must retain the one it inspected.
    provider.inspectAdapterContext.mockResolvedValue({ ...target, revision: 8, sourceText: `${sourceText}\n` });
    const liveRevision = 8;
    provider.applyAdapterIntent.mockImplementation(async (_uri: unknown, _intent: unknown, revision: number, source: string) =>
      revision === liveRevision && source === `${sourceText}\n` ? { status: 'ok', applied: true } : { status: 'refused', code: 'ADAPTER_DOCUMENT_CHANGED' });
    response.resolve(success()); expect(await pending).toEqual({ status: 'refused', code: 'ADAPTER_DOCUMENT_CHANGED' });
    expect(provider.applyAdapterIntent).toHaveBeenCalledWith(documentUri, intent, originalRevision, originalSource, expect.any(Function), expect.any(Function), 'document-instance-1');
    expect(liveRevision).toBe(8);
  });
  it.each(['ADAPTER_TIMEOUT', 'ADAPTER_CANCELLED'])('preserves runtime %s without admitting a provider mutation', async code => {
    const { provider } = createCommands(); await grant();
    host.invokePackage.mockResolvedValue({ ok: false, diagnostics: [{ code }] });
    expect(await action()).toEqual({ status: 'refused', code }); expect(provider.applyAdapterIntent).not.toHaveBeenCalled();
  });
  it('passes live enablement to the provider so disable during final mutation admission remains visible', async () => {
    const { provider } = createCommands(); await grant();
    provider.applyAdapterIntent.mockImplementation(async (_uri, _intent, _revision, _source, enabled) => {
      expect(enabled()).toBe(true); await command('disableAdapter');
      return enabled() ? { status: 'ok', applied: true } : { status: 'refused', code: 'ADAPTER_ENABLEMENT_REVOKED' };
    });
    expect(await action()).toEqual({ status: 'refused', code: 'ADAPTER_ENABLEMENT_REVOKED' });
  });
  it('admits exact unchanged bytes through a fresh package inspection at provider commit admission', async () => {
    const { provider } = createCommands(); await grant(); host.inspectPackage.mockClear();
    provider.applyAdapterIntent.mockImplementation(async (_uri, _intent, _revision, _source, _enabled, verifyPackage) => {
      expect(verifyPackage).toBeTypeOf('function');
      return await verifyPackage!() ? { status: 'ok', applied: true } : { status: 'refused', code: 'ADAPTER_PACKAGE_CHANGED' };
    });
    expect(await action()).toEqual({ status: 'ok', applied: true });
    expect(host.inspectPackage).toHaveBeenCalledTimes(2);
    expect(host.inspectPackage.mock.calls[1]).toEqual(host.inspectPackage.mock.calls[0]);
  });
  it.each(['documentUri', 'runtime', 'architecture', 'documentInstanceId', 'revision', 'sourceText', 'serviceProfile'] as const)(
    'rejects changed %s at final provider verification before package inspection', async field => {
      const { provider, target } = createCommands(); await grant();
      provider.applyAdapterIntent.mockImplementation(async (_uri, _intent, _revision, _source, _enabled, verifyPackage) => {
        const changed = { ...target, [field]: field === 'runtime' ? 'modern' : field === 'architecture' ? 'x64'
          : field === 'revision' ? 8 : field === 'serviceProfile' ? { ...target.serviceProfile, contracts: [{ capability: 'Naming' }] } : 'changed' };
        provider.inspectAdapterContext.mockResolvedValueOnce(changed as typeof target); host.inspectPackage.mockClear();
        expect(await verifyPackage!()).toBe(false); expect(host.inspectPackage).not.toHaveBeenCalled();
        return { status: 'refused', code: 'ADAPTER_PACKAGE_CHANGED' };
      });
      expect(await action()).toEqual({ status: 'refused', code: 'ADAPTER_PACKAGE_CHANGED' });
    });
  it('uses the fresh actual service list when verifying bytes and allows stable reordered contracts', async () => {
    const { provider, target } = createCommands(); await grant();
    provider.applyAdapterIntent.mockImplementation(async (_uri, _intent, _revision, _source, _enabled, verifyPackage) => {
      provider.inspectAdapterContext.mockResolvedValue({ ...target, serviceProfile: { ...target.serviceProfile, contracts: [...target.serviceProfile.contracts].reverse() } });
      expect(await verifyPackage!()).toBe(true);
      expect(host.inspectPackage.mock.lastCall?.[1].availableServices).toEqual(['PropertySerialization', 'Transactions']);
      return { status: 'ok', applied: true };
    });
    expect(await action()).toEqual({ status: 'ok', applied: true });
  });
  it('rejects a route change during the asynchronous final physical inspection', async () => {
    const { provider, target } = createCommands(); await grant();
    provider.applyAdapterIntent.mockImplementation(async (_uri, _intent, _revision, _source, _enabled, verifyPackage) => {
      host.inspectPackage.mockImplementationOnce(async () => {
        provider.inspectAdapterContext.mockResolvedValue({ ...target, architecture: 'x64' });
        return { ok: true, manifest, packageSha256: SHA };
      });
      expect(await verifyPackage!()).toBe(false); return { status: 'refused', code: 'ADAPTER_PACKAGE_CHANGED' };
    });
    expect(await action()).toEqual({ status: 'refused', code: 'ADAPTER_PACKAGE_CHANGED' });
  });
  it('rejects changed package bytes discovered only at provider commit admission', async () => {
    const { provider } = createCommands(); await grant();
    provider.applyAdapterIntent.mockImplementation(async (_uri, _intent, _revision, _source, _enabled, verifyPackage) => {
      host.inspectPackage.mockResolvedValueOnce({ ok: true, manifest, packageSha256: 'b'.repeat(64) });
      const verified = await verifyPackage!(); expect(verified).toBe(false);
      return verified ? { status: 'ok', applied: true } : { status: 'refused', code: 'ADAPTER_PACKAGE_CHANGED' };
    });
    expect(await action()).toEqual({ status: 'refused', code: 'ADAPTER_PACKAGE_CHANGED' });
  });
  it('fails final package verification closed when fresh inspection refuses the physical package', async () => {
    const { provider } = createCommands(); await grant();
    provider.applyAdapterIntent.mockImplementation(async (_uri, _intent, _revision, _source, _enabled, verifyPackage) => {
      host.inspectPackage.mockResolvedValueOnce({ ok: false, diagnostics: [{ code: 'ADAPTER_FILE_HASH_MISMATCH' }] });
      expect(await verifyPackage!()).toBe(false);
      return { status: 'refused', code: 'ADAPTER_PACKAGE_CHANGED' };
    });
    expect(await action()).toEqual({ status: 'refused', code: 'ADAPTER_PACKAGE_CHANGED' });
  });
  it('rejects a revoked grant before final package inspection starts', async () => {
    const { provider } = createCommands(); await grant();
    provider.applyAdapterIntent.mockImplementation(async (_uri, _intent, _revision, _source, _enabled, verifyPackage) => {
      await command('disableAdapter'); host.inspectPackage.mockClear();
      expect(await verifyPackage!()).toBe(false); expect(host.inspectPackage).not.toHaveBeenCalled();
      return { status: 'refused', code: 'ADAPTER_PACKAGE_CHANGED' };
    });
    expect(await action()).toEqual({ status: 'refused', code: 'ADAPTER_PACKAGE_CHANGED' });
  });
  it('rejects revocation during asynchronous final inspection even when its bytes still match', async () => {
    const { provider } = createCommands(); await grant();
    const inspection = deferred<{ ok: boolean; manifest: AdapterPackage; packageSha256: string }>();
    provider.applyAdapterIntent.mockImplementation(async (_uri, _intent, _revision, _source, _enabled, verifyPackage) => {
      host.inspectPackage.mockReturnValueOnce(inspection.promise);
      const verification = verifyPackage!(); await command('disableAdapter');
      inspection.resolve({ ok: true, manifest, packageSha256: SHA }); expect(await verification).toBe(false);
      return { status: 'refused', code: 'ADAPTER_PACKAGE_CHANGED' };
    });
    expect(await action()).toEqual({ status: 'refused', code: 'ADAPTER_PACKAGE_CHANGED' });
  });
  it('aborts and disposes an owned input when command registration is disposed', async () => {
    const { context, provider } = createCommands(); await grant(); const pending = edit(); await flush();
    for (const subscription of context.subscriptions) subscription.dispose();
    expect(await pending).toEqual({ status: 'refused', code: 'ADAPTER_ENABLEMENT_REVOKED' });
    expect(host.pickers[0].dispose).toHaveBeenCalledOnce(); expect(host.tabChanges.listeners.size).toBe(0);
    expect(host.invokePackage).not.toHaveBeenCalled(); expect(provider.applyAdapterIntent).not.toHaveBeenCalled();
  });
  it('does not admit a late successful child result after command registration was disposed', async () => {
    const { context, provider } = createCommands(); await grant();
    const response = deferred<ReturnType<typeof success>>(); host.invokePackage.mockReturnValue(response.promise);
    const pending = action(); await flush();
    for (const subscription of context.subscriptions) subscription.dispose();
    response.resolve(success());
    expect(await pending).toEqual({ status: 'refused', code: 'ADAPTER_ENABLEMENT_REVOKED' });
    expect(provider.applyAdapterIntent).not.toHaveBeenCalled();
  });
  it.each(['True', 'False'])('preserves canonical Boolean %s from the provider in the public adapter request', async invariantValue => {
    const { target } = createCommands(); target.invariantValue = invariantValue;
    manifest.contributions.editors[0].propertyName = 'Enabled'; manifest.contributions.editors[0].propertyType = 'System.Boolean';
    await grant(); expect(await edit({ input: { cancel: true } })).toEqual({ status: 'cancelled' });
    expect(host.invokePackage.mock.calls[0][2].request.context).toMatchObject({ propertyName: 'Enabled', propertyType: 'System.Boolean', invariantValue });
  });
  it.each(['inspectDocument', 'inspectHostedServices', 'inspectAdapterPackage'])('shows concise JSON for no-argument palette %s', async name => {
    createCommands(); host.showOpenDialog.mockResolvedValue([packageUri]);
    const result = await host.commands.get(`winformsDesigner.${name}`)!();
    expect(result).toBeDefined(); expect(host.openTextDocument).toHaveBeenCalledOnce();
    const options = host.openTextDocument.mock.calls[0][0]; expect(options.language).toBe('json');
    const report = JSON.parse(options.content); expect(report.title).toBeTypeOf('string');
    expect(host.showTextDocument).toHaveBeenCalledWith(expect.objectContaining({ content: options.content }), { preview: true });
    if (name === 'inspectDocument') expect(options.content).not.toContain(sourceText);
    expect(host.invokePackage).not.toHaveBeenCalled();
  });
  it.each(['inspectDocument', 'inspectHostedServices', 'inspectAdapterPackage'])('returns programmatic %s data without opening diagnostics UI', async name => {
    createCommands(); expect(await command(name)).toBeDefined();
    expect(host.openTextDocument).not.toHaveBeenCalled(); expect(host.showTextDocument).not.toHaveBeenCalled();
  });
  it('sanitizes unexpected failures without leaking exception details or applying an intent', async () => {
    const { provider } = createCommands(); await grant(); host.invokePackage.mockRejectedValue(new Error('private source text canary'));
    expect(await action()).toEqual({ status: 'refused', code: 'ADAPTER_REQUEST_FAILED' }); expect(provider.applyAdapterIntent).not.toHaveBeenCalled();
  });
});
