import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { FormStatusSnapshot } from './formStatusView';

const viewType = 'winformsDesigner.designer';
interface DesignerState {
  dirty: boolean;
  designerText: string;
  revision: number;
  renderReady: boolean;
  renderGeneration: number;
  renderFailureCause: string | null;
  engineKind: 'modern' | 'net48' | null;
  controls: readonly { id: string }[];
}
interface AdapterState {
  uri: string;
  ok: boolean;
  adapterId: string | null;
  diagnosticCodes: readonly string[];
  vendorCodeLoaded: false;
  workspaceMutationAuthorityGranted: false;
}
interface TestApi {
  openDesignerState(source: vscode.Uri): DesignerState | undefined;
  focusOpenDesigner(source: vscode.Uri): Promise<void>;
  editOpenDesignerProperty(source: vscode.Uri, id: string, property: string, type: string,
    isEnum: boolean, value: string): Promise<void>;
  engineLifecycleState(): {
    mappedEngines: readonly { kind: 'modern' | 'net48'; pid: number; running: boolean }[];
  };
}
interface ScenarioResult { id: string; passed: boolean; error?: string; }

async function waitFor(predicate: () => boolean, failure: () => string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(failure());
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

function customTab(uri: vscode.Uri): vscode.Tab | undefined {
  return vscode.window.tabGroups.all.flatMap(group => group.tabs).find(tab =>
    tab.input instanceof vscode.TabInputCustom && tab.input.viewType === viewType
    && tab.input.uri.toString() === uri.toString());
}

async function open(api: TestApi, uri: vscode.Uri, rendered = true): Promise<DesignerState> {
  await vscode.commands.executeCommand('vscode.openWith', uri, viewType);
  await waitFor(() => {
    const state = api.openDesignerState(uri);
    return Boolean(state && (rendered ? state.renderReady : state.renderReady || state.renderFailureCause));
  }, () => `Form did not reach an observable render outcome: ${JSON.stringify(api.openDesignerState(uri))}`);
  const state = api.openDesignerState(uri);
  assert.ok(state);
  assert.ok(customTab(uri), 'form did not open a real CustomEditor tab');
  return state;
}

async function status(api: TestApi, uri: vscode.Uri): Promise<FormStatusSnapshot> {
  await api.focusOpenDesigner(uri);
  const snapshot = await vscode.commands.executeCommand<FormStatusSnapshot>('winformsDesigner.showFormStatus');
  assert.ok(snapshot, 'the public Form Status command did not return its displayed snapshot');
  assert.strictEqual(snapshot.revision, api.openDesignerState(uri)?.revision);
  assert.ok(snapshot.documentId.length > 0);
  assert.ok(snapshot.fields.length >= 5, 'Form Status omitted project/runtime/preview/readiness facts');
  await waitFor(() => vscode.window.tabGroups.all.some(group => group.tabs.some(tab =>
    tab.input instanceof vscode.TabInputWebview && tab.input.viewType.includes('formStatus'))),
  () => `Form Status did not open its real webview: ${JSON.stringify(vscode.window.tabGroups.all.flatMap(group =>
    group.tabs.map(tab => ({ label: tab.label, input: tab.input }))))}`);
  return snapshot;
}

async function closeEditors(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
}

export async function run(): Promise<void> {
  assert.strictEqual(process.platform, 'win32');
  const extension = vscode.extensions.all.find(candidate =>
    candidate.id.toLowerCase() === 'skivhisink.winforms-designer-vscode');
  assert.ok(extension);
  const api = await extension.activate() as TestApi;
  assert.ok(api?.openDesignerState, 'product E2E API unavailable');
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  assert.ok(root);
  const scenarios: ScenarioResult[] = [];
  const scenario = async (id: string, body: () => Promise<void>): Promise<void> => {
    console.log(`RELEASE21 ${id}: starting`);
    try {
      await body();
      scenarios.push({ id, passed: true });
      console.log(`RELEASE21 ${id}: PASS`);
    } catch (error) {
      scenarios.push({ id, passed: false, error: error instanceof Error ? error.stack : String(error) });
      throw error;
    } finally {
      fs.writeFileSync(path.join(root, '.release21-host-results.json'), `${JSON.stringify({
        suite: 'release21-extension-host', vscodeVersion: vscode.version,
        extensionVersion: extension.packageJSON.version, completedAt: new Date().toISOString(),
        failed: scenarios.filter(result => !result.passed).length, scenarios,
      }, null, 2)}\n`);
    }
  };
  const source = (name: string): vscode.Uri => vscode.Uri.file(path.join(root, name, 'Release21Form.cs'));

  await scenario('R21-HOST-001-command-registration', async () => {
    const commands = new Set(await vscode.commands.getCommands(true));
    for (const command of ['showFormStatus', 'rebuildToolboxCache', 'refreshToolbox', 'requestToolboxItems',
      'exportDiagnostics', 'restartEngines', 'refreshAdapterManifests']) {
      assert.ok(commands.has(`winformsDesigner.${command}`), `missing command: ${command}`);
    }
  });

  for (const [name, kind] of [['Modern', 'modern'], ['Framework', 'net48']] as const) {
    await scenario(`R21-HOST-002-${kind}-render-status`, async () => {
      const uri = source(name);
      const state = await open(api, uri);
      assert.strictEqual(state.engineKind, kind);
      assert.ok(state.controls.some(control => control.id === 'button1'), 'real render omitted the fixture control');
      assert.strictEqual(state.dirty, false);
      const snapshot = await status(api, uri);
      assert.ok(snapshot.fields.some(field => field.value.toLowerCase().includes(kind)),
        `Form Status did not reflect the actual ${kind} engine: ${JSON.stringify(snapshot.fields)}`);
      assert.ok(!snapshot.diagnostics.some(diagnostic => diagnostic.severity === 'error'),
        `healthy form has an error diagnostic: ${JSON.stringify(snapshot.diagnostics)}`);
      await closeEditors();
    });
  }

  for (const [name, kind] of [['Modern', 'modern'], ['Framework', 'net48']] as const) {
    await scenario(`R21-HOST-003-${kind}-recovery-preserves-dirty-source`, async () => {
      const uri = source(name);
      const designer = path.join(path.dirname(uri.fsPath), 'Release21Form.Designer.cs');
      const disk = fs.readFileSync(designer);
      await open(api, uri);
      const before = api.openDesignerState(uri)!.designerText;
      await api.editOpenDesignerProperty(uri, 'button1', 'Text', 'System.String', false, 'UNSAVED_RELEASE21_EDIT');
      await waitFor(() => api.openDesignerState(uri)?.dirty === true,
        () => `property edit never dirtied the real CustomDocument: ${JSON.stringify(api.openDesignerState(uri))}`);
      const edited = api.openDesignerState(uri)!.designerText;
      assert.notStrictEqual(edited, before);
      assert.ok(edited.includes('UNSAVED_RELEASE21_EDIT'));
      const revision = api.openDesignerState(uri)!.revision;
      const previousPid = api.engineLifecycleState().mappedEngines.find(engine => engine.kind === kind)?.pid;
      assert.ok(previousPid);
      for (const command of ['rebuildToolboxCache', 'refreshToolbox', 'restartEngines']) {
        await api.focusOpenDesigner(uri);
        await vscode.commands.executeCommand(`winformsDesigner.${command}`);
        await waitFor(() => api.openDesignerState(uri)?.renderReady === true,
          () => `${command} failed to recover a usable render: ${JSON.stringify(api.openDesignerState(uri))}`);
        assert.strictEqual(api.openDesignerState(uri)?.designerText, edited, `${command} discarded the dirty edit`);
        assert.strictEqual(api.openDesignerState(uri)?.dirty, true, `${command} cleared CustomDocument dirty state`);
        assert.strictEqual(api.openDesignerState(uri)?.revision, revision, `${command} changed source history`);
        assert.strictEqual(customTab(uri)?.isDirty, true, `${command} lost native dirty-tab state`);
        assert.deepStrictEqual(fs.readFileSync(designer), disk, `${command} wrote unsaved source to disk`);
      }
      assert.notStrictEqual(api.engineLifecycleState().mappedEngines.find(engine => engine.kind === kind)?.pid,
        previousPid, 'Restart Engines did not replace the real process');
      await api.focusOpenDesigner(uri);
      await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
      await vscode.commands.executeCommand('undo');
      await waitFor(() => api.openDesignerState(uri)?.designerText === before && !api.openDesignerState(uri)?.dirty,
        () => 'native Undo did not retain the edit history across recovery');
      assert.deepStrictEqual(fs.readFileSync(designer), disk);
      await closeEditors();
    });
  }

  await scenario('R21-HOST-004-x86-refusal-and-com-boundary', async () => {
    const uri = source('X86');
    const state = await open(api, uri, false);
    assert.strictEqual(state.renderReady, false, 'x86-only fixture was rendered by an unsupported worker');
    const snapshot = await status(api, uri);
    assert.ok(snapshot.diagnostics.some(diagnostic => diagnostic.severity === 'error'
      && /X86|ARCHITECTURE|COM_ACTIVE_X_UNSUPPORTED/.test(diagnostic.code) && diagnostic.actions.length > 0),
    `x86 refusal lacks an actionable stable diagnostic: ${JSON.stringify(snapshot.diagnostics)}`);
    const processes = api.engineLifecycleState().mappedEngines;
    const result = await vscode.commands.executeCommand<{ status: string; reasonCode: string }>(
      'winformsDesigner.requestToolboxItems', 'com');
    assert.strictEqual(result?.status, 'refused');
    assert.strictEqual(result?.reasonCode, 'COM_ACTIVE_X_UNSUPPORTED');
    assert.deepStrictEqual(api.engineLifecycleState().mappedEngines, processes,
      'COM refusal unexpectedly launched or recycled an engine');
    await closeEditors();
  });

  await scenario('R21-HOST-005-missing-type-and-private-export', async () => {
    const uri = source('MissingType');
    await open(api, uri, false);
    const snapshot = await status(api, uri);
    assert.ok(snapshot.diagnostics.some(diagnostic => diagnostic.severity !== 'info' && diagnostic.actions.length > 0),
      `missing type has no actionable warning/refusal: ${JSON.stringify(snapshot.diagnostics)}`);
    await api.focusOpenDesigner(uri);
    await vscode.commands.executeCommand('winformsDesigner.exportDiagnostics');
    const document = vscode.window.activeTextEditor?.document;
    assert.strictEqual(document?.languageId, 'markdown');
    const text = document!.getText();
    assert.match(text, /# WinForms Designer .* Diagnostics/);
    for (const sentinel of ['SOURCE_PRIVATE_SENTINEL_21', 'PRIVATE_PATH_SENTINEL',
      'UnavailableVendor.MissingButton', 'this.button1 =', root]) {
      assert.ok(!text.includes(sentinel), `public diagnostics leaked source/path sentinel: ${sentinel}`);
    }
    const json = /```json\s*([\s\S]*?)```/.exec(text);
    assert.ok(json, 'export did not include machine-readable safe JSON');
    const payload = JSON.parse(json[1]) as {
      schema: string;
      schemaVersion: number;
      privacy: Record<string, unknown>;
      versions: { extension: string; vscode: string };
      diagnostics: { code: string }[];
    };
    assert.strictEqual(payload.schema, 'winforms-designer.diagnostics');
    assert.strictEqual(payload.schemaVersion, 1);
    assert.strictEqual(payload.versions.extension, extension.packageJSON.version);
    assert.strictEqual(payload.versions.vscode, vscode.version);
    for (const field of ['sourceIncluded', 'propertyValuesIncluded', 'rawErrorsIncluded', 'pathsIncluded']) {
      assert.strictEqual(payload.privacy[field], false, `export privacy contract does not exclude ${field}`);
    }
    assert.ok(payload.diagnostics.some(diagnostic => snapshot.diagnostics.some(local => local.code === diagnostic.code)),
      'export lost all diagnostics from the currently refused/partial product form');
    await closeEditors();
  });

  await scenario('R21-HOST-006-invalid-assembly-configuration', async () => {
    const uri = source('InvalidConfig');
    const configuration = vscode.workspace.getConfiguration('winformsDesigner', uri);
    await configuration.update('assemblyPath', path.join(root, 'PRIVATE_PATH_SENTINEL-missing.dll'),
      vscode.ConfigurationTarget.Workspace);
    try {
      await open(api, uri, false);
      const snapshot = await status(api, uri);
      assert.ok(snapshot.diagnostics.some(diagnostic => /ASSEMBLY|CONFIG/.test(diagnostic.code)
        && diagnostic.severity !== 'info' && diagnostic.actions.length > 0),
      `invalid assembly setting is not diagnosed: ${JSON.stringify(snapshot.diagnostics)}`);
    } finally {
      await closeEditors();
      await configuration.update('assemblyPath', undefined, vscode.ConfigurationTarget.Workspace);
    }
  });

  await scenario('R21-HOST-007-duplicate-adapter-manifests', async () => {
    const sample = fs.readFileSync(path.join(root, 'adapter-manifest.sample.json'));
    const files = ['DuplicateA', 'DuplicateB'].map(name => path.join(root, name, '.winforms-designer', 'adapter-manifest.json'));
    for (const file of files) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, sample);
    }
    const statuses = await vscode.commands.executeCommand<readonly AdapterState[]>('winformsDesigner.refreshAdapterManifests');
    assert.ok(statuses);
    for (const file of files) {
      const result = statuses.find(candidate => candidate.uri === vscode.Uri.file(file).toString());
      assert.ok(result, 'public registry refresh omitted a discovered manifest');
      assert.strictEqual(result.ok, false, 'duplicate adapter identity was accepted');
      assert.ok(result.diagnosticCodes.some(code => /DUPLICATE/.test(code)));
      assert.strictEqual(result.vendorCodeLoaded, false);
      assert.strictEqual(result.workspaceMutationAuthorityGranted, false);
      assert.ok(vscode.languages.getDiagnostics(vscode.Uri.file(file)).some(diagnostic =>
        /DUPLICATE/.test(String(diagnostic.code))), 'duplicate refusal was not published to Problems');
      assert.deepStrictEqual(fs.readFileSync(file), sample, 'read-only discovery changed a manifest');
    }
  });
  console.log(`Release 2.1 product tests passed: ${scenarios.length}/${scenarios.length}; VS Code ${vscode.version}`);
}
