import * as vscode from 'vscode';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DesignerHub, WinFormsDesignerProvider } from './designerEditor';
import { inspectAdapterPackage, invokeAdapterPackage, AdapterRuntimeContext } from './adapterRuntime';
import { PROTOCOL_ID, PROTOCOL_VERSION, type AdapterRequest, type AdapterEditorContribution } from '../../adapter-sdk/index.mjs';
import { t } from './i18n';

interface Arguments {
  packageUri?: unknown; documentUri?: unknown; contributionId?: unknown; componentId?: unknown;
  expectedPackageSha256?: unknown; acknowledgeTrustedCodeExecution?: unknown;
  expectedDocumentRevision?: unknown; expectedDocumentInstanceId?: unknown;
  input?: { invariantValue?: string; cancel?: boolean };
}
type Outcome = { status: 'ok' | 'refused' | 'cancelled'; code?: string; applied?: boolean };
const GRANTS_KEY = 'winformsDesigner.adapterDevelopmentGrants.v1';
const refused = (code: string): Outcome => ({ status: 'refused', code });

/** Public SDK commands. A grant authorizes exact local bytes; it is neither a certificate nor a sandbox. */
export function registerAdapterCommands(context: vscode.ExtensionContext, provider: WinFormsDesignerProvider,
  output: vscode.OutputChannel): void {
  const stored = context.workspaceState.get<unknown>(GRANTS_KEY);
  const grants = new Map<string, string>();
  if (Array.isArray(stored)) for (const entry of stored.slice(0, 64)) {
    if (entry && typeof entry === 'object' && typeof entry.path === 'string'
      && typeof entry.sha256 === 'string' && /^[a-f0-9]{64}$/.test(entry.sha256)) grants.set(entry.path, entry.sha256);
  }
  const pending = new Map<string, Set<AbortController>>();
  const editors = new Map<string, { presented: boolean; presentation: string; requestId: string }>();
  const publishedPackages = new Map<string, Set<string>>();
  let disposed = false;
  let refreshEpoch = 0;
  let writes = Promise.resolve();
  const key = (file: string) => path.resolve(file).toLocaleLowerCase('en-US');
  const persist = () => {
    const entries = [...grants].map(([file, sha256]) => ({ path: file, sha256 }));
    writes = writes.then(() => context.workspaceState.update(GRANTS_KEY, entries));
    return writes;
  };
  const uri = (value: unknown): vscode.Uri | undefined => {
    if (value instanceof vscode.Uri) return value;
    return typeof value === 'string' && value.startsWith('file:') ? vscode.Uri.parse(value) : undefined;
  };
  const documentUri = (args: Arguments): vscode.Uri => {
    const result = uri(args.documentUri) ?? DesignerHub.instance.activeSession?.documentUri;
    if (!result || result.scheme !== 'file' || !vscode.workspace.getWorkspaceFolder(result)) throw new Error('ADAPTER_DOCUMENT_UNAVAILABLE');
    return result;
  };
  const packageUri = async (args: Arguments): Promise<vscode.Uri | undefined> => uri(args.packageUri)
    ?? (await vscode.window.showOpenDialog({ canSelectMany: false, canSelectFiles: true, canSelectFolders: false,
      openLabel: t('adapter.choosePackage'), filters: { JSON: ['json'] } }))?.[0];
  type Target = Awaited<ReturnType<WinFormsDesignerProvider['inspectAdapterContext']>>;
  const runtimeContext = (document: vscode.Uri, target: Target): AdapterRuntimeContext => {
    const workspace = vscode.workspace.getWorkspaceFolder(document);
    if (!workspace) throw new Error('ADAPTER_PATH_DENIED');
    return { workspaceRoot: workspace.uri.fsPath,
      productVersion: context.extension.packageJSON.version, runtime: target.runtime, architecture: target.architecture,
      workspaceTrusted: vscode.workspace.isTrusted, availableServices: target.serviceProfile.contracts.map(item => item.capability) };
  };
  const productContext = async (document: vscode.Uri) => {
    const target = await provider.inspectAdapterContext(document);
    return { target, runtime: runtimeContext(document, target) };
  };
  // Bind the service contract, not mutable diagnostic proposals returned alongside it.
  const binding = (target: Target) => JSON.stringify({ documentUri: target.documentUri,
    documentInstanceId: target.documentInstanceId, revision: target.revision, sourceText: target.sourceText,
    runtime: target.runtime, architecture: target.architecture, serviceProfileVersion: target.serviceProfile.serviceProfileVersion,
    apartmentState: target.serviceProfile.apartmentState,
    contracts: target.serviceProfile.contracts.map(item => ({ capability: item.capability, serviceType: item.serviceType,
      methods: item.methods ? [...item.methods].sort() : [], threading: item.threading, lifetime: item.lifetime,
      cancellation: item.cancellation, reentrancy: item.reentrancy, refusal: item.refusal, scope: item.scope }))
      .sort((left, right) => left.capability.localeCompare(right.capability)) });
  const isTarget = (document: vscode.Uri, target: Target) => target.documentUri === document.toString()
    && typeof target.documentInstanceId === 'string' && target.documentInstanceId.length > 0;
  const expectedTarget = (args: Arguments, target: Target) =>
    (args.expectedDocumentRevision === undefined || args.expectedDocumentRevision === target.revision)
    && (args.expectedDocumentInstanceId === undefined || args.expectedDocumentInstanceId === target.documentInstanceId);
  const removePublication = (manifest: vscode.Uri) => {
    const packageKey = key(manifest.fsPath);
    const aliases = publishedPackages.get(packageKey) ?? new Set<string>();
    aliases.add(manifest.toString());
    for (const alias of aliases) provider.removeAdapterActions(alias);
    publishedPackages.delete(packageKey);
  };
  const publish = async (document: vscode.Uri, manifest: vscode.Uri,
    inspected: Awaited<ReturnType<typeof inspectAdapterPackage>>, current: () => boolean = () => true) => {
    const packageKey = key(manifest.fsPath);
    const enabled = () => !disposed && vscode.workspace.isTrusted && inspected.ok
      && grants.get(packageKey) === inspected.packageSha256 && current();
    if (!inspected.ok || !enabled()) return;
    const aliases = publishedPackages.get(packageKey) ?? new Set<string>();
    aliases.add(manifest.toString()); publishedPackages.set(packageKey, aliases);
    await provider.configureAdapterActions(document, manifest.toString(), inspected.packageSha256, inspected.manifest.contributions.actions);
    if (!enabled()) removePublication(manifest);
  };
  const code = (error: unknown) => error instanceof Error && /^[A-Z][A-Z0-9_]{2,95}$/.test(error.message)
    ? error.message : 'ADAPTER_REQUEST_FAILED';
  const activeDocument = () => {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    return input instanceof vscode.TabInputCustom ? input.uri.toString() : undefined;
  };
  const showReport = async (title: string, result: unknown) => {
    const report = await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify({ title, result }, null, 2) });
    await vscode.window.showTextDocument(report, { preview: true });
  };
  const refreshActive = async () => {
    const epoch = ++refreshEpoch;
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (disposed || !grants.size || !vscode.workspace.isTrusted || !(input instanceof vscode.TabInputCustom)) return;
    const document = input.uri;
    const current = () => !disposed && epoch === refreshEpoch && activeDocument() === document.toString();
    try {
      const initial = await productContext(document);
      if (!isTarget(document, initial.target) || !current()) return;
      const initialBinding = binding(initial.target);
      for (const [file, sha256] of [...grants]) {
        if (!current()) return;
        const manifest = vscode.Uri.file(file);
        const inspected = await inspectAdapterPackage(manifest.fsPath, initial.runtime);
        if (!current()) return;
        if (!inspected.ok || inspected.packageSha256 !== sha256 || grants.get(file) !== sha256 || !vscode.workspace.isTrusted) {
          removePublication(manifest); continue;
        }
        const latest = await productContext(document);
        if (!current() || !isTarget(document, latest.target) || binding(latest.target) !== initialBinding) return;
        await publish(document, manifest, inspected, current);
      }
    } catch { /* A stale/unavailable designer cannot acquire a publication or execution authority. */ }
  };
  const inspect = async (args: Arguments = {}) => {
    try {
      const document = documentUri(args);
      const manifest = await packageUri(args);
      if (!manifest) return { ok: false as const, code: 'ADAPTER_CANCELLED' };
      const initial = await productContext(document);
      if (!isTarget(document, initial.target)) return { ok: false as const, code: 'ADAPTER_DOCUMENT_CHANGED' };
      const runtime = initial.runtime;
      const result = await inspectAdapterPackage(manifest.fsPath, runtime);
      return result.ok ? result : { ...result, code: result.diagnostics[0]?.code ?? 'ADAPTER_PACKAGE_INVALID' };
    } catch (error) { return { ok: false as const, code: code(error) }; }
  };
  const ownedEditor = (document: vscode.Uri, contribution: AdapterEditorContribution, current: string,
    requestId: string, signal: AbortSignal): Promise<{ input?: Arguments['input']; code?: string }> => new Promise(resolve => {
    const dropdown = contribution.presentation === 'dropdown';
    const picker = dropdown ? vscode.window.createQuickPick() : vscode.window.createInputBox();
    picker.title = t('adapter.inputTitle', { title: contribution.title });
    picker.ignoreFocusOut = false;
    if (dropdown) (picker as vscode.QuickPick<vscode.QuickPickItem>).items = (contribution.choices ?? []).map(value => ({ label: value }));
    else { (picker as vscode.InputBox).value = current; picker.placeholder = t('adapter.editorDescription'); }
    let done = false;
    const disposables: vscode.Disposable[] = [];
    const finish = (result: { input?: Arguments['input']; code?: string }) => {
      if (done) return;
      done = true; clearTimeout(timeout); signal.removeEventListener('abort', abort);
      for (const item of disposables) item.dispose();
      const state = editors.get(document.toString());
      if (state?.requestId === requestId) state.presented = false;
      picker.hide(); picker.dispose(); resolve(result);
    };
    const abort = () => finish({ code: 'ADAPTER_ENABLEMENT_REVOKED' });
    const timeout = setTimeout(() => finish({ code: 'ADAPTER_EDITOR_TIMEOUT' }), 30_000);
    disposables.push(picker.onDidHide(() => finish({ input: { cancel: true } })),
      picker.onDidAccept(() => {
        if (activeDocument() !== document.toString()) return finish({ code: 'ADAPTER_FOCUS_CHANGED' });
        const value = dropdown ? (picker as vscode.QuickPick<vscode.QuickPickItem>).selectedItems[0]?.label
          : (picker as vscode.InputBox).value;
        finish({ input: value === undefined ? { cancel: true } : { invariantValue: value } });
      }), vscode.window.tabGroups.onDidChangeTabs(() => {
        if (activeDocument() !== document.toString()) finish({ code: 'ADAPTER_FOCUS_CHANGED' });
      }));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) return abort();
    const state = editors.get(document.toString());
    if (state?.requestId === requestId) state.presented = true;
    picker.show();
  });
  const invoke = async (args: Arguments = {}, operation: AdapterRequest['operation']): Promise<Outcome> => {
    let owner: string | undefined;
    let packageKey: string | undefined;
    let abort: AbortController | undefined;
    let ownsEditor = false;
    try {
      const document = documentUri(args);
      owner = document.toString();
      if (operation === 'editProperty') {
        if (editors.has(owner)) return refused('ADAPTER_EDITOR_BUSY');
        editors.set(owner, { presented: false, presentation: 'pending', requestId: '' });
        ownsEditor = true;
      }
      const manifest = await packageUri(args);
      if (!manifest) return { status: 'cancelled' };
      const initial = await productContext(document);
      if (!isTarget(document, initial.target)) return refused('ADAPTER_DOCUMENT_CHANGED');
      if (!expectedTarget(args, initial.target)) return refused('ADAPTER_DOCUMENT_CHANGED');
      const initialBinding = binding(initial.target);
      const runtime = initial.runtime;
      const inspected = await inspectAdapterPackage(manifest.fsPath, runtime);
      if (!inspected.ok) return refused(inspected.diagnostics[0]?.code ?? 'ADAPTER_PACKAGE_INVALID');
      packageKey = key(manifest.fsPath);
      const enabledHash = grants.get(packageKey);
      if (!enabledHash) return refused('ADAPTER_ENABLEMENT_REQUIRED');
      if (enabledHash !== inspected.packageSha256) return refused('ADAPTER_ENABLEMENT_HASH_MISMATCH');
      if (args.expectedPackageSha256 !== undefined && args.expectedPackageSha256 !== enabledHash)
        return refused('ADAPTER_ENABLEMENT_HASH_MISMATCH');
      await publish(document, manifest, inspected);
      const list = operation === 'invokeAction' ? inspected.manifest.contributions.actions : inspected.manifest.contributions.editors;
      const contribution = typeof args.contributionId === 'string' ? list.find(item => item.id === args.contributionId)
        : (await vscode.window.showQuickPick(list.map(item => ({ label: item.title, contribution: item })),
          { title: t(operation === 'invokeAction' ? 'adapter.chooseAction' : 'adapter.chooseEditor') }))?.contribution;
      if (!contribution) return refused('ADAPTER_SERVICE_UNAVAILABLE');
      if (contribution.disabledReasonCode) return refused(contribution.disabledReasonCode);
      const componentId = typeof args.componentId === 'string' ? args.componentId : 'this';
      const target = await provider.inspectAdapterContext(document, componentId, contribution.propertyName, contribution.propertyType);
      if (!isTarget(document, target) || !expectedTarget(args, target) || binding(target) !== initialBinding)
        return refused('ADAPTER_DOCUMENT_CHANGED');
      const requestId = randomUUID();
      const state = editors.get(owner);
      if (state) { state.requestId = requestId; state.presentation = (contribution as AdapterEditorContribution).presentation ?? 'input'; }
      abort = new AbortController();
      const calls = pending.get(packageKey) ?? new Set<AbortController>();
      calls.add(abort); pending.set(packageKey, calls);
      const enabled = () => !disposed && vscode.workspace.isTrusted && grants.get(packageKey!) === enabledHash;
      let input = args.input;
      if (operation === 'editProperty' && input === undefined) {
        const selected = await ownedEditor(document, contribution as AdapterEditorContribution, target.invariantValue ?? '', requestId, abort.signal);
        if (selected.code) return refused(selected.code);
        input = selected.input;
      }
      const beforeExecution = await provider.inspectAdapterContext(document, componentId, contribution.propertyName, contribution.propertyType);
      if (!isTarget(document, beforeExecution) || binding(beforeExecution) !== initialBinding)
        return refused('ADAPTER_DOCUMENT_CHANGED');
      if (!enabled()) return refused('ADAPTER_ENABLEMENT_REVOKED');
      const request: AdapterRequest = { protocolId: PROTOCOL_ID, protocolVersion: PROTOCOL_VERSION, id: requestId,
        operation, contributionId: contribution.id, context: { componentId, propertyName: contribution.propertyName,
          propertyType: contribution.propertyType, invariantValue: target.invariantValue ?? '', revision: target.revision }, input: input ?? {} };
      const result = await invokeAdapterPackage(manifest.fsPath, runtime, { enabledPackageSha256: enabledHash,
        request, signal: abort.signal, isStillEnabled: enabled });
      if (!result.ok) return refused(result.diagnostics[0]?.code ?? 'ADAPTER_RESULT_INVALID');
      if (result.response.status !== 'ok') return result.response;
      if (!enabled()) return refused('ADAPTER_ENABLEMENT_REVOKED');
      return await provider.applyAdapterIntent(document, result.response.intent, target.revision, target.sourceText, enabled, async () => {
        try {
          if (!enabled()) return false;
          const current = await provider.inspectAdapterContext(document, componentId, contribution.propertyName, contribution.propertyType);
          if (!isTarget(document, current) || binding(current) !== initialBinding || !enabled()) return false;
          const final = await inspectAdapterPackage(manifest.fsPath, runtimeContext(document, current));
          if (!final.ok || final.packageSha256 !== enabledHash || !enabled()) return false;
          const latest = await provider.inspectAdapterContext(document, componentId, contribution.propertyName, contribution.propertyType);
          return isTarget(document, latest) && binding(latest) === initialBinding && enabled();
        } catch { return false; }
      }, target.documentInstanceId);
    } catch (error) { return refused(code(error)); }
    finally {
      if (ownsEditor && owner) editors.delete(owner);
      if (packageKey && abort) {
        const calls = pending.get(packageKey); calls?.delete(abort); if (!calls?.size) pending.delete(packageKey);
      }
    }
  };
  const register = (id: string, handler: (...args: any[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(id, handler));
  register('winformsDesigner.inspectDocument', async (args?: Arguments) => {
    try {
      const document = documentUri(args ?? {});
      const result = { ...(await provider.inspectDocument(document)), adapterEditor: editors.get(document.toString()) ?? null };
      if (args === undefined) {
        const { sourceText: _source, ...summary } = result;
        await showReport(t('support.diagnosticsHeading'), summary);
      }
      return result;
    } catch (error) {
      const result = { ok: false, code: code(error) };
      if (args === undefined) await showReport(t('adapter.noDocument'), result);
      return result;
    }
  });
  register('winformsDesigner.resetDesignerProperty', async (args: Arguments & { propertyName?: unknown } = {}) => {
    if (typeof args.componentId !== 'string' || typeof args.propertyName !== 'string') return refused('ADAPTER_PROPERTY_UNAVAILABLE');
    try { return await provider.resetDesignerProperty(documentUri(args), args.componentId, args.propertyName); }
    catch (error) { return refused(code(error)); }
  });
  register('winformsDesigner.inspectHostedServices', async (args?: Arguments) => {
    try {
      const { target } = await productContext(documentUri(args ?? {}));
      if (args === undefined) await showReport(t('adapter.hostedServicesTitle', { runtime: target.runtime }), {
        documentUri: target.documentUri, documentInstanceId: target.documentInstanceId, runtime: target.runtime,
        architecture: target.architecture, serviceProfileVersion: target.serviceProfile.serviceProfileVersion,
        contracts: target.serviceProfile.contracts });
      return target.serviceProfile;
    } catch (error) {
      const result = { ok: false, errorCode: code(error) };
      if (args === undefined) await showReport(t('adapter.noDocument'), result);
      return result;
    }
  });
  register('winformsDesigner.inspectAdapterPackage', async (args?: Arguments) => {
    const result = await inspect(args ?? {});
    if (args === undefined) await showReport(result.ok ? t('adapter.packageReport', { name: result.manifest.adapter.displayName })
      : t('adapter.inspectFailed', { code: result.code }), result.ok ? { ok: true, adapter: result.manifest.adapter,
        packageSha256: result.packageSha256, provenance: result.provenance, certification: result.certification,
        fileHashes: result.fileHashes, contributions: result.manifest.contributions } : result);
    return result;
  });
  register('winformsDesigner.enableAdapterDevelopment', async (args: Arguments = {}) => {
    const manifest = await packageUri(args);
    if (!manifest) return { ok: false, code: 'ADAPTER_CANCELLED' };
    const inspected = await inspect({ ...args, packageUri: manifest });
    if (!inspected.ok) return inspected;
    if (args.expectedPackageSha256 !== undefined && args.expectedPackageSha256 !== inspected.packageSha256)
      return { ok: false, code: 'ADAPTER_ENABLEMENT_HASH_MISMATCH' };
    const acknowledged = args.acknowledgeTrustedCodeExecution === true && args.expectedPackageSha256 === inspected.packageSha256;
    if (!acknowledged && await vscode.window.showWarningMessage(t('adapter.trustPrompt'), { modal: true },
      t('adapter.enableButton')) !== t('adapter.enableButton')) return { ok: false, code: 'ADAPTER_CANCELLED' };
    if (!vscode.workspace.isTrusted) return { ok: false, code: 'ADAPTER_WORKSPACE_UNTRUSTED' };
    if (grants.size >= 64 && !grants.has(key(manifest.fsPath))) return { ok: false, code: 'ADAPTER_ENABLEMENT_LIMIT' };
    grants.set(key(manifest.fsPath), inspected.packageSha256);
    await persist();
    await publish(documentUri(args), manifest, inspected);
    output.appendLine('[adapter] exact local-development package enabled; certification=none');
    return { ok: true, packageSha256: inspected.packageSha256 };
  });
  register('winformsDesigner.disableAdapter', async (args: Arguments = {}) => {
    const manifest = await packageUri(args);
    if (!manifest) return { ok: false, code: 'ADAPTER_CANCELLED' };
    const packageKey = key(manifest.fsPath);
    grants.delete(packageKey);
    removePublication(manifest);
    for (const controller of pending.get(packageKey) ?? []) controller.abort();
    await persist();
    return { ok: true };
  });
  register('winformsDesigner.invokeAdapterAction', (args: Arguments = {}) => invoke(args, 'invokeAction'));
  register('winformsDesigner.editAdapterProperty', (args: Arguments = {}) => invoke(args, 'editProperty'));
  context.subscriptions.push(vscode.window.tabGroups.onDidChangeTabs(() => { void refreshActive(); }));
  context.subscriptions.push({ dispose() {
    if (disposed) return;
    disposed = true; refreshEpoch += 1;
    for (const calls of pending.values()) for (const controller of calls) controller.abort();
    pending.clear();
    for (const aliases of publishedPackages.values()) for (const alias of aliases) provider.removeAdapterActions(alias);
    publishedPackages.clear();
  } });
  void refreshActive();
}
