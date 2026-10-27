import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import * as vscode from 'vscode';
import type { HostedServiceKernelCapabilitiesResult } from './engineClient';

const viewType = 'winformsDesigner.designer';
const prefix = 'winformsDesigner.';
type Kind = 'modern' | 'net48';
interface Outcome { status: 'ok' | 'refused' | 'cancelled'; code?: string; applied?: boolean; }
interface Inspection { ok: boolean; packageSha256?: string; manifest?: unknown; code?: string; }
interface EditorState { presented: boolean; presentation: string; requestId: string; }
interface DocumentInspection {
  ready: boolean; revision: number; sourceText: string; engineKind: Kind; documentUri: string; adapterEditor: EditorState | null;
  persistenceLane: 'ownedRegion' | 'sourceFirst' | null;
}
interface Scenario { id: string; passed: boolean; elapsedMs: number; error?: string; }
interface Inputs { packages: Record<'action' | 'editor' | 'changed' | 'revoked' | 'incomplete' | 'wrongResult', string>; conformanceFile: string; }
interface ConformanceResult { passed: boolean; phase: string; cases: { name: string; passed: boolean; code?: string }[]; }
interface ConformanceHost {
  executeCommand: (command: string, argument: unknown) => Promise<unknown>;
  readSource: (documentUri: string) => Promise<string>;
  readSavedSource: (documentUri: string) => Promise<string>;
  save: (documentUri: string) => Promise<void>;
  undo: (documentUri: string) => Promise<void>;
}

async function command<T>(name: string, argument?: unknown): Promise<T> {
  return vscode.commands.executeCommand<T>(name.startsWith(prefix) ? name : `${prefix}${name}`, argument) as Promise<T>;
}
async function inspectDocument(uri: vscode.Uri): Promise<DocumentInspection> {
  const result = await command<DocumentInspection>('inspectDocument', { documentUri: uri.toString() });
  assert.ok(result?.ready, `The public document inspection did not observe a ready designer: ${JSON.stringify(result)}`);
  assert.strictEqual(typeof result.sourceText, 'string');
  assert.ok(Number.isSafeInteger(result.revision));
  return result;
}
async function open(uri: vscode.Uri): Promise<void> {
  await vscode.commands.executeCommand('vscode.openWith', uri, viewType);
  assert.ok(vscode.window.tabGroups.all.flatMap(group => group.tabs).some(tab => tab.input instanceof vscode.TabInputCustom
    && tab.input.viewType === viewType && tab.input.uri.toString() === uri.toString()), 'Public openWith did not create a real designer tab.');
  await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
}
async function save(uri: vscode.Uri): Promise<void> {
  await open(uri);
  await vscode.commands.executeCommand('workbench.action.files.save');
  const actual = await inspectDocument(uri);
  assert.strictEqual(fs.readFileSync(uri.fsPath.replace(/\.cs$/i, '.Designer.cs'), 'utf8'), actual.sourceText,
    'Public Save did not durably write the actual custom document source.');
}
async function nativeHistory(uri: vscode.Uri, direction: 'undo' | 'redo'): Promise<void> {
  await open(uri);
  const before = (await inspectDocument(uri)).sourceText;
  await vscode.commands.executeCommand(direction);
  const deadline = Date.now() + 30_000;
  while ((await inspectDocument(uri)).sourceText === before) {
    assert.ok(Date.now() < deadline, `The real native ${direction} command did not change the custom document.`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
async function snapshot(uri: vscode.Uri): Promise<Record<string, string>> {
  const observed = await inspectDocument(uri);
  const directory = path.dirname(uri.fsPath), stem = path.basename(uri.fsPath, '.cs');
  return { customDocument: digest(observed.sourceText), revision: String(observed.revision), ...Object.fromEntries(fs.readdirSync(directory).sort()
    .filter(name => name === `${stem}.cs` || name === `${stem}.Designer.cs` || name === `${stem}.resx` || name.startsWith(`${stem}.`) && name.endsWith('.resx'))
    .map(name => [name, digest(fs.readFileSync(path.join(directory, name)))])) };
}
async function unchanged(uri: vscode.Uri, invoke: () => Promise<Outcome | Inspection>, expectedStatus: 'refused' | 'cancelled' | 'invalid',
  expectedCode?: string): Promise<Outcome | Inspection> {
  const before = await snapshot(uri);
  const result = await invoke();
  assert.ok(result, 'The public command returned no machine-readable result.');
  if (expectedStatus === 'invalid') assert.strictEqual((result as Inspection).ok, false);
  else {
    assert.strictEqual((result as Outcome).status, expectedStatus, JSON.stringify(result));
    assert.notStrictEqual((result as Outcome).applied, true);
  }
  if (expectedCode) assert.strictEqual(result.code, expectedCode, JSON.stringify(result));
  assert.deepStrictEqual(await snapshot(uri), before, 'A refusal or cancellation changed in-memory or persisted form artifacts.');
  return result;
}
async function enable(packageUri: vscode.Uri, documentUri: vscode.Uri): Promise<Inspection> {
  const inspected = await command<Inspection>('inspectAdapterPackage', { packageUri: packageUri.toString(), documentUri: documentUri.toString() });
  assert.strictEqual(inspected.ok, true, JSON.stringify(inspected));
  assert.match(inspected.packageSha256 ?? '', /^[a-f0-9]{64}$/);
  const result = await command<Inspection>('enableAdapterDevelopment', { packageUri: packageUri.toString(),
    expectedPackageSha256: inspected.packageSha256, acknowledgeTrustedCodeExecution: true });
  assert.strictEqual(result.ok, true, JSON.stringify(result));
  return inspected;
}
async function presentedEditor(document: vscode.Uri, packageUri: vscode.Uri): Promise<{ pending: Promise<Outcome>; state: EditorState }> {
  await open(document);
  const pending = command<Outcome>('editAdapterProperty', { documentUri: document.toString(), packageUri: packageUri.toString(),
    contributionId: 'sample.caption-editor', componentId: 'button1' });
  let finished: Outcome | undefined;
  void pending.then(result => { finished = result; });
  const deadline = Date.now() + 30_000;
  for (;;) {
    const state = (await inspectDocument(document)).adapterEditor;
    if (state?.presented) {
      assert.strictEqual(state.presentation, 'dropdown');
      assert.match(state.requestId, /^[a-f0-9-]{36}$/);
      return { pending, state: { ...state } };
    }
    assert.ok(!finished, `The public property editor finished before presenting its real UI: ${JSON.stringify(finished)}`);
    assert.ok(Date.now() < deadline, 'The public property editor did not present its observable QuickPick.');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

export async function run(): Promise<void> {
  assert.strictEqual(process.platform, 'win32');
  const product = vscode.extensions.all.find(candidate => candidate.id.toLowerCase() === 'skivhisink.winforms-designer-vscode');
  assert.ok(product);
  const harness = vscode.extensions.getExtension('local-test.release24-adapter-harness');
  assert.ok(harness, 'The separate normal-host development harness was not activated.');
  assert.notStrictEqual(product.extensionPath, harness.extensionPath);
  assert.strictEqual(path.resolve(product.extensionPath), path.resolve(process.env.WFD_RELEASE24_EXPECTED_PRODUCT_ROOT ?? ''),
    'The normal host loaded a different product extension.');
  assert.notStrictEqual(process.env.WFD_EXTENSION_HOST_E2E, '1', 'Public acceptance must not activate private test hooks.');
  await product.activate();
  // Deliberately do not consume activate()'s private test exports. Every operation below is a public command.
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  assert.ok(root);
  const inputs: Inputs = JSON.parse(fs.readFileSync(path.join(root, '.release24-inputs.json'), 'utf8'));
  const packages = Object.fromEntries(Object.entries(inputs.packages).map(([key, value]) => [key, vscode.Uri.file(path.join(root, value))])) as Record<keyof Inputs['packages'], vscode.Uri>;
  const phase = process.env.WFD_RELEASE24_PHASE === 'restore' ? 'restore' : 'setup';
  const expectedScenarioCount = phase === 'setup' ? 6 : 24;
  const reportPath = path.join(root, `.release24-${phase}-results.json`);
  const scenarios: Scenario[] = [], observations: unknown[] = [];
  const scenario = async (id: string, body: () => Promise<void>): Promise<void> => {
    console.log(`RELEASE24 ${id}: starting`);
    const started = Date.now();
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([body(), new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`Scenario exceeded 180000 ms: ${id}`)), 180_000);
      })]);
      scenarios.push({ id, passed: true, elapsedMs: Date.now() - started });
      console.log(`RELEASE24 ${id}: PASS`);
    } catch (error) {
      scenarios.push({ id, passed: false, elapsedMs: Date.now() - started, error: error instanceof Error ? error.stack : String(error) });
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
      fs.writeFileSync(reportPath, `${JSON.stringify({ suite: 'release24-extension-host', phase, vscodeVersion: vscode.version,
        hostMode: 'normal-development-host', productExtensionPath: product.extensionPath, harnessExtensionPath: harness.extensionPath,
        extensionVersion: product.packageJSON.version, completedAt: new Date().toISOString(), expectedScenarioCount,
        failed: scenarios.filter(row => !row.passed).length, scenarios, observations,
        boundary: 'Public extension commands, CustomDocument model inspection, real native Undo/Redo, Save and process restart; no private test hooks.' }, null, 2)}\n`);
    }
  };
  const conformance = await import(pathToFileURL(inputs.conformanceFile).href) as {
    runAdapterConformance: (host: ConformanceHost, options: { phase: string; actionPackageUri: string; editorPackageUri: string;
      documentUri: string; componentId: string; runtime: Kind }) => Promise<ConformanceResult>;
  };
  assert.strictEqual(typeof conformance.runAdapterConformance, 'function');
  const registeredCommands = new Set(await vscode.commands.getCommands(false));
  const uiCommands = ['workbench.action.acceptSelectedQuickOpenItem', 'workbench.action.closeQuickOpen'];
  for (const id of uiCommands) assert.ok(registeredCommands.has(id), `The actual VS Code ${vscode.version} does not register ${id}.`);
  observations.push({ type: 'actual-vscode-ui-commands', commands: uiCommands });
  const host: ConformanceHost = {
    executeCommand: async (name, argument) => vscode.commands.executeCommand(name, argument),
    readSource: async value => (await inspectDocument(vscode.Uri.parse(value))).sourceText,
    readSavedSource: async value => fs.readFileSync(vscode.Uri.parse(value).fsPath.replace(/\.cs$/i, '.Designer.cs'), 'utf8'),
    save: async value => save(vscode.Uri.parse(value)),
    undo: async value => nativeHistory(vscode.Uri.parse(value), 'undo'),
  };
  for (const [folder, kind] of [['Modern', 'modern'], ['Framework', 'net48']] as const) {
    const uri = vscode.Uri.file(path.join(root, folder, 'Release24Form.cs'));
    await open(uri);
    assert.strictEqual((await inspectDocument(uri)).engineKind, kind, 'The fixture did not use its intended actual engine.');
    if (phase === 'setup') {
      await scenario(`${kind}.hosted-services-actual-profile`, async () => {
        const before = await snapshot(uri);
        const profile = await command<HostedServiceKernelCapabilitiesResult>('inspectHostedServices', { documentUri: uri.toString() });
        assert.strictEqual(profile.ok, true, JSON.stringify(profile));
        assert.strictEqual(profile.status, 'ready');
        assert.strictEqual(profile.serviceProfileVersion, '0.1.0');
        assert.strictEqual(profile.apartmentState, 'STA');
        assert.strictEqual(profile.rootType, 'System.Windows.Forms.Form');
        assert.deepStrictEqual(profile.contracts.map(item => item.capability).sort(), ['ContainerSiting', 'Naming', 'ComponentChange',
          'Selection', 'Transactions', 'MenuCommands', 'ToolboxCatalog', 'TypeResolution', 'PropertySerialization'].sort());
        for (const contract of profile.contracts) {
          assert.ok(contract.methods.length > 0 && contract.methods.every(method => typeof method === 'string' && method.length > 0));
          for (const key of ['serviceType', 'threading', 'lifetime', 'cancellation', 'reentrancy', 'refusal', 'scope'] as const)
            assert.ok(contract[key].length > 0, `The ${contract.capability} contract omitted ${key}.`);
        }
        assert.deepStrictEqual(profile.toolboxItems.map(item => item.id).sort(), ['Button', 'Label', 'Panel', 'TextBox']);
        assert.strictEqual(profile.resolvedType, 'System.Windows.Forms.Button');
        assert.deepStrictEqual(profile.serializedProperties, [{ componentName: 'previewButton1', componentType: 'System.Windows.Forms.Button',
          text: 'Hosted Preview', width: 144, height: 32 }]);
        assert.deepStrictEqual(profile.proposals, [
          { componentName: 'previewButton1', componentType: 'System.Windows.Forms.Button', propertyName: 'Text', propertyType: 'System.String', invariantValue: 'Hosted Preview' },
          { componentName: 'previewButton1', componentType: 'System.Windows.Forms.Button', propertyName: 'Size', propertyType: 'System.Drawing.Size', invariantValue: '144, 32' },
        ]);
        assert.strictEqual(profile.unsupportedClassicSerializationRefused, true);
        assert.strictEqual(profile.incompleteHostWithheld, true);
        assert.deepStrictEqual(await snapshot(uri), before, 'The disposable service probe mutated the actual document.');
        observations.push({ kind, type: 'actual-hosted-service-profile', profile });
      });
      await scenario(`${kind}.independent-packages-inspect`, async () => {
        for (const name of ['action', 'editor'] as const) {
          const inspected = await command<Inspection>('inspectAdapterPackage', { packageUri: packages[name].toString(), documentUri: uri.toString() });
          assert.strictEqual(inspected.ok, true, JSON.stringify(inspected));
          assert.match(inspected.packageSha256 ?? '', /^[a-f0-9]{64}$/);
          observations.push({ kind, type: 'package-inspection', name, ...inspected });
        }
      });
    }
    await scenario(`${kind}.independent-conformance-${phase}`, async () => {
      const result = await conformance.runAdapterConformance(host, { phase, actionPackageUri: packages.action.toString(),
        editorPackageUri: packages.editor.toString(), documentUri: uri.toString(), componentId: 'button1', runtime: kind });
      assert.strictEqual(result.passed, true, JSON.stringify(result));
      assert.strictEqual(result.phase, phase);
      assert.deepStrictEqual(result.cases.map(row => row.name), phase === 'setup' ? [
        'action-inspect-and-explicit-enable', 'editor-inspect-and-explicit-enable', 'action-success-and-exact-undo',
        'action-refusal-preserves-source', 'action-cancel-preserves-source', 'editor-cancel-preserves-source',
        'editor-success-save-for-next-launch',
      ] : ['previous-launch-save-survives-restart', 'action-enablement-survives-restart-and-undo',
        'editor-enablement-survives-restart-and-undo', 'revocation-refuses-before-mutation', 'editor-reenable-after-revocation'],
      'The independent conformance ledger omitted or duplicated a required transition.');
      assert.ok(result.cases.every(row => row.passed));
      observations.push({ kind, type: 'independent-conformance', result, source: await snapshot(uri) });
      if (phase === 'setup') {
        // Redo itself is also a real native transition; preserve the saved conformance final image before quitting.
        const before = (await inspectDocument(uri)).sourceText;
        const result = await command<Outcome>('invokeAdapterAction', { documentUri: uri.toString(), packageUri: packages.action.toString(),
          contributionId: 'sample.set-caption', componentId: 'button1', input: { invariantValue: 'SDK native redo witness' } });
        assert.strictEqual(result.status, 'ok', JSON.stringify(result));
        const after = (await inspectDocument(uri)).sourceText;
        assert.notStrictEqual(after, before);
        await nativeHistory(uri, 'undo');
        assert.strictEqual((await inspectDocument(uri)).sourceText, before);
        await nativeHistory(uri, 'redo');
        assert.strictEqual((await inspectDocument(uri)).sourceText, after);
        await nativeHistory(uri, 'undo');
        assert.strictEqual((await inspectDocument(uri)).sourceText, before);
        await save(uri);
      }
    });
    if (phase === 'setup') continue;
    const actionArguments = (packageUri: vscode.Uri) => ({ documentUri: uri.toString(), packageUri: packageUri.toString(),
      contributionId: 'sample.set-caption', componentId: 'button1' });
    await scenario(`${kind}.public-reset-owned-region-and-native-undo`, async () => {
      const before = await inspectDocument(uri);
      const fileImages = await snapshot(uri);
      const assignment = /^[\t ]*this\.button1\.Text = [^\r\n]+;\r?\n/gm;
      assert.strictEqual([...before.sourceText.matchAll(assignment)].length, 1, 'The nonlocalized fixture needs one authored Text assignment.');
      const expected = before.sourceText.replace(assignment, '');
      const result = await command<Outcome & { revision: number; persistenceLane: 'ownedRegion' | 'sourceFirst' }>('resetDesignerProperty', {
        documentUri: uri.toString(), componentId: 'button1', propertyName: 'Text',
      });
      assert.strictEqual(result.status, 'ok', JSON.stringify(result));
      assert.strictEqual(result.applied, true);
      const after = await inspectDocument(uri);
      assert.strictEqual(after.sourceText, expected, 'Reset changed bytes beyond the one authored property assignment.');
      assert.ok(after.revision > before.revision);
      assert.strictEqual(result.revision, after.revision);
      assert.strictEqual(result.persistenceLane, after.persistenceLane);
      if (kind === 'modern') assert.strictEqual(after.persistenceLane, 'ownedRegion', 'The modern public Reset did not use the proven Lane B planner.');
      else assert.ok(after.persistenceLane === 'ownedRegion' || after.persistenceLane === 'sourceFirst');
      const afterImages = await snapshot(uri);
      for (const [file, sha256] of Object.entries(fileImages)) if (file !== 'customDocument' && file !== 'revision')
        assert.strictEqual(afterImages[file], sha256, `Public Reset changed the persisted companion/resource ${file} before Save.`);
      await nativeHistory(uri, 'undo');
      assert.strictEqual((await inspectDocument(uri)).sourceText, before.sourceText, 'One native Undo did not restore the exact pre-Reset source.');
      const restoredImages = await snapshot(uri);
      for (const [file, sha256] of Object.entries(fileImages)) if (file !== 'revision') assert.strictEqual(restoredImages[file], sha256);
      observations.push({ kind, type: 'public-reset-owned-region', beforeSha256: digest(before.sourceText),
        afterSha256: digest(after.sourceText), persistenceLane: result.persistenceLane, result });
    });
    await scenario(`${kind}.real-dropdown-accept-and-native-undo`, async () => {
      const original = (await inspectDocument(uri)).sourceText;
      const baseline = await command<Outcome>('invokeAdapterAction', { ...actionArguments(packages.action),
        input: { invariantValue: 'SDK UI baseline caption' } });
      assert.strictEqual(baseline.status, 'ok', JSON.stringify(baseline));
      assert.strictEqual(baseline.applied, true);
      const before = (await inspectDocument(uri)).sourceText;
      assert.notStrictEqual(before, original);
      const editor = await presentedEditor(uri, packages.editor);
      try {
        await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
        const accepted = await editor.pending;
        assert.strictEqual(accepted.status, 'ok', JSON.stringify(accepted));
        assert.strictEqual(accepted.applied, true);
        const after = (await inspectDocument(uri)).sourceText;
        assert.notStrictEqual(after, before);
        assert.ok(after.includes('SDK editor caption'), 'Accepting the real dropdown did not select its first published choice.');
        assert.strictEqual((await inspectDocument(uri)).adapterEditor, null);
        await nativeHistory(uri, 'undo');
        assert.strictEqual((await inspectDocument(uri)).sourceText, before, 'The actual UI editor was not exactly one native Undo unit.');
        await nativeHistory(uri, 'undo');
        assert.strictEqual((await inspectDocument(uri)).sourceText, original);
        observations.push({ kind, type: 'real-dropdown-accepted', editor: editor.state, beforeSha256: digest(before), afterSha256: digest(after) });
      } finally { await vscode.commands.executeCommand('workbench.action.closeQuickOpen'); }
    });
    await scenario(`${kind}.real-dropdown-escape-preserves-every-artifact`, async () => {
      const before = await snapshot(uri);
      const editor = await presentedEditor(uri, packages.editor);
      await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
      const cancelled = await editor.pending;
      assert.strictEqual(cancelled.status, 'cancelled', JSON.stringify(cancelled));
      assert.notStrictEqual(cancelled.applied, true);
      assert.deepStrictEqual(await snapshot(uri), before);
      assert.strictEqual((await inspectDocument(uri)).adapterEditor, null);
      observations.push({ kind, type: 'real-dropdown-escape', editor: editor.state, cancelled });
    });
    await scenario(`${kind}.real-dropdown-nested-invocation-refused`, async () => {
      const before = await snapshot(uri);
      const first = await presentedEditor(uri, packages.editor);
      try {
        await unchanged(uri, () => command<Outcome>('editAdapterProperty', { documentUri: uri.toString(), packageUri: packages.editor.toString(),
          contributionId: 'sample.caption-editor', componentId: 'button1' }), 'refused', 'ADAPTER_EDITOR_BUSY');
        assert.deepStrictEqual((await inspectDocument(uri)).adapterEditor, first.state, 'The nested refusal closed or replaced the first actual editor.');
      } finally { await vscode.commands.executeCommand('workbench.action.closeQuickOpen'); }
      assert.strictEqual((await first.pending).status, 'cancelled');
      assert.deepStrictEqual(await snapshot(uri), before);
      assert.strictEqual((await inspectDocument(uri)).adapterEditor, null);
      observations.push({ kind, type: 'real-dropdown-nested-refusal', firstEditor: first.state });
    });
    await scenario(`${kind}.real-dropdown-focus-change-refused`, async () => {
      const before = await snapshot(uri);
      const editor = await presentedEditor(uri, packages.editor);
      const other = vscode.Uri.file(path.join(root, folder === 'Modern' ? 'Framework' : 'Modern', 'Release24Form.cs'));
      try {
        await open(other);
        const refused = await editor.pending;
        assert.strictEqual(refused.status, 'refused', JSON.stringify(refused));
        assert.strictEqual(refused.code, 'ADAPTER_FOCUS_CHANGED', JSON.stringify(refused));
        assert.notStrictEqual(refused.applied, true);
        assert.deepStrictEqual(await snapshot(uri), before);
        assert.strictEqual((await inspectDocument(uri)).adapterEditor, null);
        observations.push({ kind, type: 'real-dropdown-focus-change', editor: editor.state, refused });
      } finally {
        await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
        await open(uri);
      }
    });
    await scenario(`${kind}.unknown-required-service-catalog-refused`, async () => {
      const result = await unchanged(uri, () => command<Inspection>('inspectAdapterPackage', {
        packageUri: packages.incomplete.toString(), documentUri: uri.toString() }), 'invalid');
      assert.match(result.code ?? '', /^ADAPTER_/);
      observations.push({ kind, type: 'unknown-required-service-catalog', result,
        scope: 'Unknown service IDs are refused; the separate actual engine probe proves withholding an incomplete kernel.' });
    });
    await scenario(`${kind}.enabled-entry-modification-refused`, async () => {
      const manifest = JSON.parse(fs.readFileSync(packages.changed.fsPath, 'utf8'));
      const entry = path.join(path.dirname(packages.changed.fsPath), manifest.execution.entrypoint);
      const original = fs.readFileSync(path.join(path.dirname(packages.action.fsPath), manifest.execution.entrypoint));
      fs.writeFileSync(entry, original);
      await enable(packages.changed, uri);
      fs.appendFileSync(entry, '\n// RELEASE24_TAMPERED_AFTER_ENABLEMENT\n');
      try {
        const result = await unchanged(uri, () => command<Outcome>('invokeAdapterAction', actionArguments(packages.changed)), 'refused');
        assert.match(result.code ?? '', /(?:INTEGRITY|HASH)/);
        observations.push({ kind, type: 'changed-entry-after-enablement', result });
      } finally { fs.writeFileSync(entry, original); }
    });
    await scenario(`${kind}.wrong-wire-result-type-refused`, async () => {
      await enable(packages.wrongResult, uri);
      const result = await unchanged(uri, () => command<Outcome>('invokeAdapterAction', actionArguments(packages.wrongResult)), 'refused', 'ADAPTER_RESULT_TYPE_MISMATCH');
      observations.push({ kind, type: 'wrong-wire-result-type', result });
    });
    await scenario(`${kind}.revoked-enablement-refused`, async () => {
      await enable(packages.revoked, uri);
      await command('disableAdapter', { packageUri: packages.revoked.toString() });
      const result = await unchanged(uri, () => command<Outcome>('invokeAdapterAction', actionArguments(packages.revoked)), 'refused');
      assert.strictEqual(result.code, 'ADAPTER_ENABLEMENT_REQUIRED');
      observations.push({ kind, type: 'revoked-enablement', result });
    });
    await scenario(`${kind}.editor-cancel-preserves-every-artifact`, async () => {
      await unchanged(uri, () => command<Outcome>('editAdapterProperty', { documentUri: uri.toString(), packageUri: packages.editor.toString(),
        contributionId: 'sample.caption-editor', componentId: 'button1', input: { cancel: true } }), 'cancelled');
    });
    await scenario(`${kind}.adapter-refusal-preserves-every-artifact`, async () => {
      await unchanged(uri, () => command<Outcome>('invokeAdapterAction', { ...actionArguments(packages.action), input: { invariantValue: 'REFUSE' } }),
        'refused', 'ADAPTER_SAMPLE_REFUSED');
      await save(uri);
    });
  }
  assert.strictEqual(scenarios.length, expectedScenarioCount);
}
