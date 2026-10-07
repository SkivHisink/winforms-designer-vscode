import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ExtensionHostTestApi } from './extension';
import type { HostMutationRecord, HostMutationResult } from './mutationOperation';

const viewType = 'winformsDesigner.designer';
type Kind = 'modern' | 'net48';
type Api = ExtensionHostTestApi & {
  editOpenDesignerPropertyWithOperation(source: vscode.Uri, id: string, property: string, type: string,
    isEnum: boolean, value: string, operationId: string): Promise<HostMutationResult>;
  observeOpenDesignerOperation(source: vscode.Uri, operationId: string): HostMutationRecord | undefined;
  importOpenDesignerLocalImageWithJournalInterleave(source: vscode.Uri, id: string, property: string,
    type: string, image: vscode.Uri, interleave: () => Promise<void>): Promise<boolean>;
};
interface ScenarioResult { id: string; passed: boolean; elapsedMs: number; error?: string; }
interface DurableObservation {
  file: string; operationId?: string; transactionId?: string; status?: string; state?: string;
  commitCount?: number; beforeSourceSha256?: string; afterSourceSha256?: string; sourceReconciliationRequired?: boolean;
}
type HeldRequest = ReturnType<Api['productWorkerState']>[number]['delayedRequests'][number];
interface TimingWitness { phase: string; kind: Kind; workerGeneration: number; request: HeldRequest; hostOperationId?: string; }
const timingWitnesses: TimingWitness[] = [];
let scenarioPreviousAttempts: ReadonlySet<string> = new Set();

function durableRecords(root: string): DurableObservation[] {
  const observations: DurableObservation[] = [];
  const visit = (directory: string): void => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) { visit(file); continue; }
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      assert.ok(observations.length < 1_000, 'the isolated profile exceeded the bounded durable-record witness');
      const record = JSON.parse(fs.readFileSync(file, 'utf8'));
      // The evidence includes identities/hashes/outcomes, never the journal's source or resource byte images.
      observations.push({ file: path.relative(root, file), operationId: record.operationId ?? record.hostOperation?.operationId,
        transactionId: record.transactionId, status: record.status, state: record.state, commitCount: record.commitCount,
        beforeSourceSha256: record.beforeSourceSha256, afterSourceSha256: record.afterSourceSha256,
        sourceReconciliationRequired: record.sourceReconciliationRequired });
    }
  };
  visit(root);
  return observations;
}

async function waitFor(predicate: () => boolean, detail: () => unknown, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(JSON.stringify(detail()));
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

async function waitForIdleProduct(api: Api, kind: Kind): Promise<void> {
  await waitFor(() => api.productWorkerState().filter(worker => worker.key.runtime === kind)
    .every(worker => worker.pending === 0 && worker.delayedReplies === 0 && worker.activeLeases === 0),
  () => api.productWorkerState().filter(worker => worker.key.runtime === kind)
    .map(worker => ({ pid: worker.pid, pending: worker.pending, delayedReplies: worker.delayedReplies, activeLeases: worker.activeLeases })));
}

async function latchHeldReply(api: Api, uri: vscode.Uri, kind: Kind, known: ReadonlySet<string>,
  phase: string, methods: readonly string[]): Promise<HeldRequest> {
  const owner = path.join(path.dirname(uri.fsPath), 'Release22Fixture.csproj').toLowerCase();
  let witness: TimingWitness | undefined;
  await waitFor(() => {
    for (const worker of api.productWorkerState()) {
      if (worker.key.runtime !== kind || worker.key.ownerProject !== owner) continue;
      const request = worker.delayedRequests.find(candidate => !known.has(candidate.requestId));
      if (!request) continue;
      assert.ok(methods.includes(request.method), `the timing hook held an unrelated request: ${JSON.stringify(request)}`);
      assert.strictEqual(request.pid, worker.pid);
      witness = { phase, kind, workerGeneration: worker.generation, request };
      return true;
    }
    return false;
  }, () => api.productWorkerState().filter(worker => worker.key.runtime === kind)
    .map(worker => ({ pid: worker.pid, pending: worker.pending, delayedRequests: worker.delayedRequests })));
  assert.ok(witness);
  timingWitnesses.push(witness);
  return witness.request;
}

function tab(uri: vscode.Uri): vscode.Tab | undefined {
  return vscode.window.tabGroups.all.flatMap(group => group.tabs).find(candidate =>
    candidate.input instanceof vscode.TabInputCustom && candidate.input.viewType === viewType
    && candidate.input.uri.toString() === uri.toString());
}

async function open(api: Api, uri: vscode.Uri): Promise<void> {
  await vscode.commands.executeCommand('vscode.openWith', uri, viewType);
  await waitFor(() => api.openDesignerState(uri)?.renderReady === true, () => api.openDesignerState(uri));
  assert.ok(tab(uri), 'the ordinary open command did not create a real custom editor');
}

async function history(api: Api, uri: vscode.Uri, command: 'undo' | 'redo'): Promise<void> {
  await api.focusOpenDesigner(uri);
  await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
  await waitFor(() => api.openDesignerState(uri)?.panelActive === true, () => 'custom editor never became active');
  await vscode.commands.executeCommand(command);
}

async function undoTo(api: Api, uri: vscode.Uri, text: string, clean = false): Promise<void> {
  await history(api, uri, 'undo');
  await waitFor(() => api.openDesignerState(uri)?.designerText === text,
    () => ({ expected: text, actual: api.openDesignerState(uri) }));
  if (clean) {
    await waitFor(() => api.openDesignerState(uri)?.dirty === false && tab(uri)?.isDirty === false,
      () => 'native Undo failed to restore the clean document baseline');
  }
}

async function close(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
}

async function save(api: Api, uri: vscode.Uri): Promise<void> {
  await api.focusOpenDesigner(uri);
  await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
  await waitFor(() => api.openDesignerState(uri)?.panelActive === true, () => 'Save custom editor never became active');
  await vscode.commands.executeCommand('workbench.action.files.save');
}

export async function run(): Promise<void> {
  assert.strictEqual(process.platform, 'win32');
  const extension = vscode.extensions.all.find(candidate => candidate.id.toLowerCase() === 'skivhisink.winforms-designer-vscode');
  assert.ok(extension);
  const api = await extension.activate() as Api;
  assert.ok(api?.openDesignerState);
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  assert.ok(root);
  const scenarios: ScenarioResult[] = [];
  const productObservations: { scenarioId: string; requests: ReturnType<Api['productRequestOutcomes']>;
    workers: ReturnType<Api['productWorkerState']> }[] = [];
  const expectedScenarioCount = 28;
  let durableObservations: { operations: DurableObservation[]; journals: DurableObservation[] } | undefined;
  const scenario = async (id: string, body: () => Promise<void>): Promise<void> => {
    const start = Date.now();
    const previousAttempts = new Set(api.productRequestOutcomes().map(request => request.requestId));
    scenarioPreviousAttempts = previousAttempts;
    console.log(`RELEASE22 ${id}: starting`);
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([body(), new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`Product scenario exceeded its 180-second deadline: ${id}`)), 180_000);
      })]);
      scenarios.push({ id, passed: true, elapsedMs: Date.now() - start });
      console.log(`RELEASE22 ${id}: PASS`);
    } catch (error) {
      scenarios.push({ id, passed: false, elapsedMs: Date.now() - start, error: error instanceof Error ? error.stack : String(error) });
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
      productObservations.push({ scenarioId: id, requests: api.productRequestOutcomes().filter(request => !previousAttempts.has(request.requestId)),
        workers: api.productWorkerState() });
      fs.writeFileSync(path.join(root, '.release22-host-results.json'), `${JSON.stringify({
        suite: 'release22-extension-host', vscodeVersion: vscode.version, extensionVersion: extension.packageJSON.version,
        completedAt: new Date().toISOString(), expectedScenarioCount, failed: scenarios.filter(result => !result.passed).length,
        scenarios, productObservations, durableObservations, timingWitnesses,
      }, null, 2)}\n`);
    }
  };
  const source = (name: string) => vscode.Uri.file(path.join(root, name, 'Release22Form.cs'));

  for (const [name, kind] of [['ModernA', 'modern'], ['FrameworkA', 'net48']] as const) {
    const uri = source(name);
    const designer = path.join(path.dirname(uri.fsPath), 'Release22Form.Designer.cs');
    const resource = path.join(path.dirname(uri.fsPath), 'Release22Form.resx');
    const disk = fs.readFileSync(designer);
    const baseline = disk.toString('utf8');

    await scenario(`R22-HOST-001-${kind}-render-describe-noop-save`, async () => {
      await open(api, uri);
      const state = api.openDesignerState(uri)!;
      assert.strictEqual(state.engineKind, kind);
      assert.strictEqual(state.dirty, false);
      assert.ok(state.controls.some(control => control.id === 'button1'));
      assert.strictEqual(path.resolve(state.ownerProjectPath ?? '').toLowerCase(),
        path.join(path.dirname(uri.fsPath), 'Release22Fixture.csproj').toLowerCase());
      await api.selectOpenDesignerControl(uri, 'button1');
      await waitFor(() => api.openDesignerProperties(uri)?.id === 'button1'
        && api.openDesignerProperties(uri)?.properties.some(property => property.name === 'Text' && property.value === name) === true,
      () => api.openDesignerProperties(uri));
      const layout = api.openDesignerLayout(uri);
      const rootControl = layout.find(control => control.id === 'this');
      const button = layout.find(control => control.id === 'button1');
      assert.ok(rootControl && button);
      assert.deepStrictEqual([button.x - (rootControl.clientX ?? 0), button.y - (rootControl.clientY ?? 0), button.width, button.height],
        [12, 12, 110, 30], `ordinary render changed parent-client geometry: ${JSON.stringify(layout)}`);
      await save(api, uri);
      assert.deepStrictEqual(fs.readFileSync(designer), disk, 'no-op save changed bytes');
      assertProductRoute(api, kind, [kind === 'modern' ? 'RenderWithLayout' : 'RenderInterpretedWithLayout',
        kind === 'modern' ? 'DescribeComponent' : 'DescribeInterpretedComponent']);
      await close();
    });

    await scenario(`R22-HOST-002-${kind}-property-minimal-diff-native-undo`, async () => {
      await open(api, uri);
      await api.editOpenDesignerProperty(uri, 'button1', 'Text', 'System.String', false, 'RELEASE22_PROPERTY');
      await waitFor(() => api.openDesignerState(uri)?.designerText.includes('RELEASE22_PROPERTY') === true,
        () => api.openDesignerState(uri));
      const expected = baseline.replace(`this.button1.Text = "${name}";`, 'this.button1.Text = "RELEASE22_PROPERTY";');
      assert.strictEqual(api.openDesignerState(uri)?.designerText, expected, 'property edit exceeded the characterized source span');
      assert.deepStrictEqual(fs.readFileSync(designer), disk, 'an unsaved property mutation wrote source to disk');
      await undoTo(api, uri, baseline, true);
      assertProductRoute(api, kind);
      await history(api, uri, 'redo');
      await waitFor(() => api.openDesignerState(uri)?.designerText === expected, () => api.openDesignerState(uri));
      await undoTo(api, uri, baseline, true);
      await close();
    });

    await scenario(`R22-HOST-003-${kind}-geometry-structure-events`, async () => {
      await open(api, uri);
      const buttonBefore = api.openDesignerLayout(uri).find(control => control.id === 'button1')!;
      await api.moveOpenDesignerGroup(uri, ['button1'], 17, 9);
      await waitFor(() => api.openDesignerLayout(uri).some(control => control.id === 'button1'
        && control.x === buttonBefore.x + 17 && control.y === buttonBefore.y + 9),
        () => api.openDesignerLayout(uri));
      assert.strictEqual(api.openDesignerState(uri)?.designerText,
        baseline.replace('new System.Drawing.Point(12, 12)', 'new System.Drawing.Point(29, 21)'));
      await undoTo(api, uri, baseline, true);
      await api.resizeOpenDesignerControl(uri, 'button1', 125, 37);
      await waitFor(() => api.openDesignerLayout(uri).some(control => control.id === 'button1' && control.width === 125 && control.height === 37),
        () => api.openDesignerLayout(uri));
      await undoTo(api, uri, baseline, true);
      await api.addOpenDesignerControl(uri, 'System.Windows.Forms.Label', 'this', 30, 65, 120, 22);
      await waitFor(() => api.openDesignerState(uri)?.controls.some(control => control.id !== 'this' && control.id !== 'button1') === true,
        () => api.openDesignerState(uri));
      const added = api.openDesignerState(uri)!.controls.find(control => control.id !== 'this' && control.id !== 'button1')!;
      assert.ok(api.openDesignerState(uri)?.designerText.includes('RELEASE22_KEEP_OUTSIDE_EDIT'));
      await api.removeOpenDesignerControl(uri, added.id);
      await waitFor(() => api.openDesignerState(uri)?.controls.some(control => control.id === added.id) === false,
        () => api.openDesignerState(uri));
      await history(api, uri, 'undo');
      await waitFor(() => api.openDesignerState(uri)?.controls.some(control => control.id === added.id) === true,
        () => api.openDesignerState(uri));
      await undoTo(api, uri, baseline, true);
      await api.setOpenDesignerHandler(uri, 'button1', 'Click', 'ExistingClick');
      await waitFor(() => api.openDesignerState(uri)?.designerText.includes('this.button1.Click +=') === true,
        () => api.openDesignerState(uri));
      assert.match(api.openDesignerState(uri)!.designerText, /this\.button1\.Click\s*\+=\s*.*ExistingClick/);
      await undoTo(api, uri, baseline, true);
      assert.deepStrictEqual(fs.readFileSync(designer), disk);
      assertProductRoute(api, kind, kind === 'modern'
        ? ['BeginGeometryDrag', 'CommitGeometryBounds', 'AddControl', 'RemoveControl', 'SetEventWiring']
        : ['SetProperty', 'ApplyInterpretedEditsLive', 'AddControl', 'RemoveControl', 'SetEventWiring']);
      await close();
    });

    await scenario(`R22-HOST-004-${kind}-resource-save-native-undo`, async () => {
      const resourceBefore = fs.readFileSync(resource);
      const codeBehindBefore = fs.readFileSync(uri.fsPath);
      await open(api, uri);
      assert.strictEqual(await api.importOpenDesignerLocalImage(uri, 'button1', 'Image', 'System.Drawing.Image',
        vscode.Uri.file(path.join(root, 'input.png'))), true);
      await waitFor(() => api.openDesignerState(uri)?.designerText.includes('button1.Image') === true
        && !fs.readFileSync(resource).equals(resourceBefore), () => api.openDesignerState(uri));
      const edited = api.openDesignerState(uri)!.designerText;
      const resourceAfter = fs.readFileSync(resource);
      assert.match(resourceAfter.toString('utf8'), /RELEASE22_KEEP_RESOURCE/);
      assert.deepStrictEqual(fs.readFileSync(designer), disk);
      assert.deepStrictEqual(fs.readFileSync(uri.fsPath), codeBehindBefore);
      await undoTo(api, uri, baseline, true);
      assert.deepStrictEqual(fs.readFileSync(resource), resourceBefore, 'resource Undo did not restore exact bytes');
      await history(api, uri, 'redo');
      await waitFor(() => api.openDesignerState(uri)?.designerText === edited, () => api.openDesignerState(uri));
      assert.deepStrictEqual(fs.readFileSync(resource), resourceAfter);
      await save(api, uri);
      assert.deepStrictEqual(fs.readFileSync(designer), Buffer.from(edited, 'utf8'), 'Save differs from the in-memory source');
      await waitFor(() => tab(uri)?.isDirty === false, () => 'Save did not clear the native custom editor dirty flag');
      await close();
      await open(api, uri);
      assert.strictEqual(api.openDesignerState(uri)?.designerText, edited);
      assertProductRoute(api, kind);
      await close();
      // This file belongs only to the generated test workspace; restore it before the next independent scenario.
      fs.writeFileSync(designer, disk);
      fs.writeFileSync(resource, resourceBefore);
    });

    await scenario(`R22-HOST-005-${kind}-crash-preserves-unsaved-source-and-history`, async () => {
      await open(api, uri);
      await api.editOpenDesignerProperty(uri, 'button1', 'Text', 'System.String', false, 'RELEASE22_DIRTY_CRASH');
      await waitFor(() => api.openDesignerState(uri)?.renderReady === true, () => api.openDesignerState(uri));
      const edited = api.openDesignerState(uri)!.designerText;
      const beforeGeneration = api.openDesignerState(uri)!.renderGeneration;
      // A request is audited only once it settles; the crashed worker's session must be captured complete.
      await waitForIdleProduct(api, kind);
      const beforeCrash = api.productWorkerState();
      const crash = api.crashMappedEngineForRecoveryTest(kind);
      assert.ok(crash.signaled && crash.pid > 0);
      const crashed = sessionsOfPid(beforeCrash, kind, crash.pid);
      assert.ok(crashed.size > 0, 'the crashed worker had no audited product session');
      await waitFor(() => api.openDesignerState(uri)?.renderReady === true
        && api.openDesignerState(uri)!.renderGeneration > beforeGeneration
        && hasReplacementWorker(api, kind, crashed),
      () => ({ session: api.openDesignerState(uri), lifecycle: api.engineLifecycleState() }));
      assert.strictEqual(api.openDesignerState(uri)?.designerText, edited);
      assert.strictEqual(api.openDesignerState(uri)?.dirty, true);
      assert.deepStrictEqual(fs.readFileSync(designer), disk);
      await undoTo(api, uri, baseline, true);
      await close();
    });
  }

  await scenario('R22-HOST-006-net48-coordinated-build-preserves-dirty-history', async () => {
    const uri = source('FrameworkA');
    const baseline = fs.readFileSync(path.join(path.dirname(uri.fsPath), 'Release22Form.Designer.cs'), 'utf8');
    await open(api, uri);
    await api.editOpenDesignerProperty(uri, 'button1', 'Text', 'System.String', false, 'RELEASE22_BUILD_DIRTY');
    const edited = api.openDesignerState(uri)!.designerText;
    const diskBeforeBuild = fs.readFileSync(path.join(path.dirname(uri.fsPath), 'Release22Form.Designer.cs'));
    const generation = api.openDesignerState(uri)!.renderGeneration;
    const graphBefore = workerFor(api, uri, 'net48');
    assert.ok(graphBefore);
    const dependencySource = path.join(root, 'Dependencies', 'FrameworkA', 'Marker.cs');
    fs.writeFileSync(dependencySource, fs.readFileSync(dependencySource, 'utf8').replace('"FrameworkA"', '"FrameworkA_REBUILT"'));
    let buildCompleted = false;
    let exitCode: number | undefined;
    const subscription = vscode.tasks.onDidEndTaskProcess(event => {
      if (event.execution.task.name === 'Release22 Build') { buildCompleted = true; exitCode = event.exitCode; }
    });
    try {
      await vscode.commands.executeCommand('winformsDesigner.runBuildTask');
      await waitFor(() => buildCompleted, () => 'the public coordinated Build task never completed', 120_000);
      assert.strictEqual(exitCode, 0, 'the actual build failed while the product preview was open');
      await waitFor(() => api.openDesignerState(uri)?.renderReady === true
        && api.openDesignerState(uri)!.renderGeneration > generation, () => api.openDesignerState(uri));
      assert.strictEqual(api.openDesignerState(uri)?.designerText, edited);
      assert.strictEqual(api.openDesignerState(uri)?.dirty, true);
      assert.deepStrictEqual(fs.readFileSync(path.join(path.dirname(uri.fsPath), 'Release22Form.Designer.cs')), diskBeforeBuild,
        'the coordinated build wrote the intentionally unsaved designer buffer');
      const graphAfter = workerFor(api, uri, 'net48');
      assert.ok(graphAfter);
      assert.notStrictEqual(graphAfter.key.dependencyFingerprint, graphBefore.key.dependencyFingerprint,
        'an actual dependency rebuild did not invalidate the resolved product worker graph');
      await undoTo(api, uri, baseline, true);
    } finally { subscription.dispose(); }
    await close();
  });

  // The modern route through the same public coordinated build: a rebuilt dependency yields a new product graph
  // identity on the next request, while the dirty buffer, the disk bytes and native history stay as they were.
  await scenario('R22-HOST-006-modern-coordinated-build-preserves-dirty-history', async () => {
    const uri = source('ModernA');
    const designerPath = path.join(path.dirname(uri.fsPath), 'Release22Form.Designer.cs');
    const baseline = fs.readFileSync(designerPath, 'utf8');
    await open(api, uri);
    await api.editOpenDesignerProperty(uri, 'button1', 'Text', 'System.String', false, 'RELEASE22_MODERN_BUILD_DIRTY');
    await waitFor(() => api.openDesignerState(uri)?.designerText.includes('RELEASE22_MODERN_BUILD_DIRTY') === true,
      () => api.openDesignerState(uri));
    const edited = api.openDesignerState(uri)!.designerText;
    const diskBeforeBuild = fs.readFileSync(designerPath);
    const graphBefore = workerFor(api, uri, 'modern');
    assert.ok(graphBefore);
    const dependencySource = path.join(root, 'Dependencies', 'ModernA', 'Marker.cs');
    fs.writeFileSync(dependencySource, fs.readFileSync(dependencySource, 'utf8').replace('"ModernA"', '"ModernA_REBUILT"'));
    let buildCompleted = false;
    let exitCode: number | undefined;
    const subscription = vscode.tasks.onDidEndTaskProcess(event => {
      if (event.execution.task.name === 'Release22 Build') { buildCompleted = true; exitCode = event.exitCode; }
    });
    try {
      await vscode.commands.executeCommand('winformsDesigner.runBuildTask');
      await waitFor(() => buildCompleted, () => 'the public coordinated Build task never completed', 120_000);
      assert.strictEqual(exitCode, 0, 'the actual build failed while the modern preview was open');
      const generation = api.openDesignerState(uri)!.renderGeneration;
      await api.rerenderOpenDesigner(uri);
      await waitFor(() => api.openDesignerState(uri)?.renderReady === true
        && api.openDesignerState(uri)!.renderGeneration > generation, () => api.openDesignerState(uri));
      assert.strictEqual(api.openDesignerState(uri)?.designerText, edited);
      assert.strictEqual(api.openDesignerState(uri)?.dirty, true);
      assert.deepStrictEqual(fs.readFileSync(designerPath), diskBeforeBuild, 'the coordinated build wrote the unsaved designer buffer');
      const graphAfter = workerFor(api, uri, 'modern');
      assert.ok(graphAfter);
      assert.notStrictEqual(graphAfter.key.dependencyFingerprint, graphBefore.key.dependencyFingerprint,
        'an actual dependency rebuild did not change the modern product worker graph');
      await undoTo(api, uri, baseline, true);
    } finally { subscription.dispose(); }
    await close();
  });

  // Further protocol/worker assertions below use observation and timing hooks only; all mutations above went
  // through the same provider methods used by shipped canvas and Properties messages.
  await runProtocolScenarios(api, source, scenario, async () => {
    const storage = process.env.WFD_RELEASE22_GLOBAL_STORAGE;
    assert.ok(storage, 'the runner did not identify its isolated product storage');
    await waitFor(() => {
      durableObservations = { operations: durableRecords(path.join(storage, 'v2-operations')),
        journals: durableRecords(path.join(storage, 'v2-transactions')) };
      return durableObservations.operations.length > 0
        && durableObservations.operations.every(record => ['committed', 'noChange', 'refused'].includes(record.status ?? ''))
        && durableObservations.journals.every(record => ['committed', 'rolledBack', 'aborted'].includes(record.state ?? '')
          && !record.sourceReconciliationRequired);
    }, () => ({ detail: 'real product scenarios retained an unresolved durable operation or journal', durableObservations }));
  });
  assert.strictEqual(scenarios.length, expectedScenarioCount);
  console.log(`Release 2.2 ordinary product acceptance: ${scenarios.length} scenarios passed.`);
}

async function runProtocolScenarios(api: Api, source: (name: string) => vscode.Uri,
  scenario: (id: string, body: () => Promise<void>) => Promise<void>, observeDurableState: () => Promise<void>): Promise<void> {
  for (const [prefix, kind] of [['Modern', 'modern'], ['Framework', 'net48']] as const) {
    await scenario(`R22-HOST-007-${kind}-incompatible-project-graphs`, async () => {
      const a = source(`${prefix}A`);
      const b = source(`${prefix}B`);
      await open(api, a);
      await api.selectOpenDesignerControl(a, 'button1');
      await waitFor(() => api.openDesignerProperties(a)?.properties.some(property =>
        property.name === 'Text' && property.value === `${prefix}A`) === true, () => api.openDesignerProperties(a));
      const first = workerFor(api, a, kind);
      assert.ok(first, 'ordinary product worker lacks its resolved owner project identity');
      await open(api, b);
      await api.selectOpenDesignerControl(b, 'button1');
      await waitFor(() => api.openDesignerProperties(b)?.properties.some(property =>
        property.name === 'Text' && property.value === `${prefix}B`) === true, () => api.openDesignerProperties(b));
      const second = workerFor(api, b, kind);
      assert.ok(second);
      assert.notStrictEqual(second.pid, first.pid, 'incompatible project outputs shared a physical worker');
      assert.notStrictEqual(second.key.dependencyFingerprint, first.key.dependencyFingerprint,
        'different dependency bytes have the same product graph identity');
      for (const worker of [first, second]) {
        assert.strictEqual(worker.key.targetFramework, kind === 'net48' ? 'net48' : 'net10.0-windows');
        assert.strictEqual(worker.key.configuration, 'Release');
        assert.strictEqual(worker.key.workerArchitecture, 'x64');
        assert.ok(worker.key.platform && worker.key.trustPolicy);
        assert.match(worker.buildId, /^sha256-[a-f0-9]{64}$/);
      }
      await api.focusOpenDesigner(a);
      await api.rerenderOpenDesigner(a);
      await api.selectOpenDesignerControl(a, 'button1');
      await waitFor(() => api.openDesignerProperties(a)?.properties.some(property =>
        property.name === 'Text' && property.value === `${prefix}A`) === true, () => api.openDesignerProperties(a));
      assert.strictEqual(api.openDesignerState(a)?.dirty, false);
      assert.strictEqual(api.openDesignerState(b)?.dirty, false);
      await close();
    });

    await scenario(`R22-HOST-008-${kind}-stable-operation-one-commit-and-undo`, async () => {
      const uri = source(`${prefix}A`);
      await open(api, uri);
      const baseline = api.openDesignerState(uri)!.designerText;
      const operationId = `release22-${kind}-stable-property`;
      const first = await api.editOpenDesignerPropertyWithOperation(uri, 'button1', 'Text', 'System.String', false,
        'RELEASE22_ONCE', operationId);
      assert.strictEqual(first.status, 'committed');
      assert.strictEqual(first.replayed, false);
      const committed = api.openDesignerState(uri)!;
      const second = await api.editOpenDesignerPropertyWithOperation(uri, 'button1', 'Text', 'System.String', false,
        'RELEASE22_ONCE', operationId);
      assert.strictEqual(second.status, 'committed');
      assert.strictEqual(second.replayed, true);
      assert.strictEqual(api.openDesignerState(uri)?.revision, committed.revision);
      assert.strictEqual(api.openDesignerState(uri)?.designerText, committed.designerText);
      const record = api.observeOpenDesignerOperation(uri, operationId);
      assert.ok(record);
      assert.strictEqual(record.commitCount, 1);
      assert.notStrictEqual(record.beforeSourceSha256, record.afterSourceSha256);
      await assert.rejects(() => api.editOpenDesignerPropertyWithOperation(uri, 'button1', 'Text', 'System.String', false,
        'RELEASE22_DIFFERENT_PAYLOAD', operationId), { code: 'OPERATION_PAYLOAD_MISMATCH' });
      assert.strictEqual(api.openDesignerState(uri)?.revision, committed.revision);
      await undoTo(api, uri, baseline, true);
      assertProductRoute(api, kind);
      await close();
    });

    // R22-04 beyond properties: every ordinary mutation family keeps one commit and one native Undo entry under a
    // repeated stable operation ID, and a different payload under that ID is refused.
    await scenario(`R22-HOST-013-${kind}-stable-geometry-structure-event-resource-operations`, async () => {
      const uri = source(`${prefix}A`);
      const resource = path.join(path.dirname(uri.fsPath), 'Release22Form.resx');
      await open(api, uri);
      const baseline = api.openDesignerState(uri)!.designerText;
      const resourceBefore = fs.readFileSync(resource);
      const workspaceRoot = path.dirname(path.dirname(uri.fsPath));
      const intents: Array<[string, Parameters<Api['runOpenDesignerOperation']>[2]]> = [
        ['move', { kind: 'move', ids: ['button1'], dx: 11, dy: 7 }],
        ['add', { kind: 'addControl', controlType: 'System.Windows.Forms.Label', parentId: 'this', x: 30, y: 65, width: 120, height: 22 }],
        ['event', { kind: 'setHandler', id: 'button1', eventName: 'Click', handlerName: 'ExistingClick' }],
        ['resource', { kind: 'importImage', id: 'button1', propertyName: 'Image', propertyType: 'System.Drawing.Image',
          image: vscode.Uri.file(path.join(workspaceRoot, 'input.png')) }],
      ];
      for (const [family, intent] of intents) {
        const operationId = `release22-${kind}-stable-${family}`;
        const first = await api.runOpenDesignerOperation(uri, operationId, intent);
        assert.strictEqual(first.status, 'committed', `${family}: ${JSON.stringify(first)}`);
        assert.strictEqual(first.replayed, false);
        await waitFor(() => api.openDesignerState(uri)?.designerText !== baseline, () => api.openDesignerState(uri));
        const committed = api.openDesignerState(uri)!;
        const resourceCommitted = fs.readFileSync(resource);
        const second = await api.runOpenDesignerOperation(uri, operationId, intent);
        assert.strictEqual(second.status, 'committed', family);
        assert.strictEqual(second.replayed, true, family);
        assert.strictEqual(api.openDesignerState(uri)?.revision, committed.revision, `${family}: a replay added a revision`);
        assert.strictEqual(api.openDesignerState(uri)?.designerText, committed.designerText, `${family}: a replay added a diff`);
        assert.deepStrictEqual(fs.readFileSync(resource), resourceCommitted, `${family}: a replay rewrote the resource`);
        assert.strictEqual(api.observeOpenDesignerOperation(uri, operationId)?.commitCount, 1, family);
        const conflicting = intent.kind === 'move' ? { ...intent, dx: intent.dx + 1 }
          : intent.kind === 'addControl' ? { ...intent, x: intent.x + 1 }
          : intent.kind === 'setHandler' ? { ...intent, handlerName: 'OtherClick' }
          : { ...intent, propertyName: 'BackgroundImage' };
        await assert.rejects(() => api.runOpenDesignerOperation(uri, operationId, conflicting),
          { code: 'OPERATION_PAYLOAD_MISMATCH' }, `${family}: a different payload under the same ID was accepted`);
        assert.strictEqual(api.openDesignerState(uri)?.revision, committed.revision);
        // Exactly one native Undo entry takes the document (and any resource) back to the baseline.
        await undoTo(api, uri, baseline, true);
        assert.deepStrictEqual(fs.readFileSync(resource), resourceBefore, `${family}: Undo did not restore the resource bytes`);
      }
      assertProductRoute(api, kind);
      await close();
    });

    // R22-08: a worker that keeps crashing stops being restarted automatically (bounded policy) and says so; the dirty
    // document survives untouched, and an explicit restart brings the preview back with its native history intact.
    await scenario(`R22-HOST-014-${kind}-repeated-crash-stops-automatic-recovery`, async () => {
      const uri = source(`${prefix}A`);
      const designerPath = path.join(path.dirname(uri.fsPath), 'Release22Form.Designer.cs');
      const disk = fs.readFileSync(designerPath);
      // Earlier scenarios leave other projects' workers resident; start from none so the form's own worker is the one
      // of its kind that is crashed and whose replacement is watched.
      await vscode.commands.executeCommand('winformsDesigner.stopEngines');
      await open(api, uri);
      const baseline = api.openDesignerState(uri)!.designerText;
      await api.editOpenDesignerProperty(uri, 'button1', 'Text', 'System.String', false, 'RELEASE22_CRASH_LOOP');
      await waitFor(() => api.openDesignerState(uri)?.designerText.includes('RELEASE22_CRASH_LOOP') === true,
        () => api.openDesignerState(uri));
      const edited = api.openDesignerState(uri)!.designerText;
      const running = () => api.engineLifecycleState().mappedEngines.filter(engine => engine.kind === kind && engine.running);
      const crashLoop = () => api.openDesignerState(uri)?.supportFailureCode === 'ENGINE_CRASH_LOOP';
      const state = () => ({ lifecycle: api.engineLifecycleState(), session: api.openDesignerState(uri) });
      await waitFor(() => api.openDesignerState(uri)?.renderReady === true && running().length > 0, state);
      // The policy allows two automatic restarts per 30 s window. A form can own more than one worker of its kind
      // (render and metadata), so every attempt crashes all of them; each loss counts against the same budget.
      for (let attempt = 0; attempt < 3 && !crashLoop(); attempt++) {
        // A request is audited only once it settles, so let every targeted worker finish before its session is captured.
        await waitForIdleProduct(api, kind);
        const pids = running().map(engine => engine.pid);
        assert.ok(pids.length > 0, `attempt ${attempt}: ${JSON.stringify(state())}`);
        const beforeCrash = api.productWorkerState();
        for (const pid of pids) {
          assert.ok(sessionsOfPid(beforeCrash, kind, pid).size > 0,
            `attempt ${attempt}: mapped ${kind} engine ${pid} has no audited session: ${JSON.stringify(state())}`);
        }
        const crashed = new Set(pids.flatMap(pid => [...sessionsOfPid(beforeCrash, kind, pid)]));
        for (const pid of pids) {
          const crash = api.crashMappedEngineForRecoveryTest(kind, pid);
          assert.ok(crash.signaled && crash.pid === pid, `attempt ${attempt}: the mapped ${kind} engine ${pid} was not signaled`);
        }
        // A replacement may be given a crashed worker's PID by Windows, so the crashed workers are followed by session.
        const crashedRunning = () => api.productWorkerState().some(worker => worker.key.runtime === kind
          && worker.state === 'running' && worker.requests.some(request => crashed.has(sessionOf(request.requestId))));
        await waitFor(() => !crashedRunning(), state);
        await waitFor(() => crashLoop() || (api.openDesignerState(uri)?.renderReady === true
          && running().length > 0 && hasReplacementWorker(api, kind, crashed) && !crashedRunning()), state);
      }
      assert.ok(crashLoop(), 'automatic recovery did not stop after repeated crashes');
      // Outlast every back-off an earlier restart decision could still have queued (250 ms, 500 ms).
      await new Promise(resolve => setTimeout(resolve, 1_500));
      assert.ok(crashLoop(), 'a queued restart cleared the crash-loop stop');
      assert.deepStrictEqual(running(), [], `a replacement worker started after the crash-loop guard: ${JSON.stringify(state())}`);
      assert.strictEqual(api.openDesignerState(uri)?.designerText, edited, 'a crash loop changed the unsaved source');
      assert.strictEqual(api.openDesignerState(uri)?.dirty, true);
      assert.deepStrictEqual(fs.readFileSync(designerPath), disk, 'a crash loop wrote the unsaved source');
      await vscode.commands.executeCommand('winformsDesigner.restartEngines');
      await api.rerenderOpenDesigner(uri);
      await waitFor(() => api.openDesignerState(uri)?.renderReady === true && api.openDesignerState(uri)?.renderFailureCause == null,
        () => ({ lifecycle: api.engineLifecycleState(), session: api.openDesignerState(uri) }));
      assert.strictEqual(api.openDesignerState(uri)?.designerText, edited);
      await undoTo(api, uri, baseline, true);
      await close();
    });

    await scenario(`R22-HOST-009-${kind}-out-of-order-metadata-and-close-cancellation`, async () => {
      const uri = source(`${prefix}A`);
      await open(api, uri);
      const baseline = api.openDesignerState(uri)!.designerText;
      await api.selectOpenDesignerControl(uri, 'this');
      await waitForIdleProduct(api, kind);
      const knownMetadata = new Set(api.productRequestOutcomes().map(request => request.requestId));
      api.delayNextProductReplyForTest(kind, 2_000);
      const older = api.selectOpenDesignerControl(uri, 'button1');
      await latchHeldReply(api, uri, kind, knownMetadata, 'out-of-order-metadata',
        ['DescribeComponent', 'DescribeInterpretedComponent', 'SetLocalizationCulture']);
      const newer = api.selectOpenDesignerControl(uri, 'this');
      await newer;
      await waitFor(() => api.openDesignerProperties(uri)?.id === 'this', () => api.openDesignerProperties(uri));
      await older;
      assert.strictEqual(api.openDesignerProperties(uri)?.id, 'this', 'a deliberately reordered describe overwrote the current selection');
      assert.strictEqual(api.openDesignerState(uri)?.designerText, baseline);
      const obsoleteGeneration = api.openDesignerState(uri)!.renderGeneration;
      await api.rerenderOpenDesigner(uri);
      const stale = await api.sendOpenDesignerCanvasInput(uri, 'nudge', 'button1', obsoleteGeneration);
      assert.strictEqual(stale.accepted, false);
      assert.strictEqual(stale.refusalCode, 'STALE_CANVAS');
      assert.strictEqual(api.openDesignerState(uri)?.designerText, baseline);

      await waitForIdleProduct(api, kind);
      api.delayNextProductReplyForTest(kind, 4_000);
      const known = new Set(api.productRequestOutcomes().map(request => request.requestId));
      const pending = api.rerenderOpenDesigner(uri).then(() => undefined, error => error);
      const held = await latchHeldReply(api, uri, kind, known, 'close-cancellation',
        ['ResolveAssembly', 'SetLocalizationCulture', 'RenderWithLayout', 'RenderInterpretedWithLayout']);
      await close();
      await waitFor(() => !api.openDesignerState(uri), () => 'closing the real tab did not dispose its document');
      await pending;
      assert.ok(api.productRequestOutcomes().some(request => request.requestId === held.requestId && request.pid === held.pid
        && request.outcome === 'REQUEST_CANCELLED'), 'closing a real document did not cancel its pending product request');
      await open(api, uri);
      assert.strictEqual(api.openDesignerState(uri)?.designerText, baseline);
      assert.strictEqual(api.openDesignerState(uri)?.dirty, false);
      assertProductRoute(api, kind);
      await close();
    });

    await scenario(`R22-HOST-010-${kind}-late-reply-after-worker-recycle`, async () => {
      const uri = source(`${prefix}A`);
      await open(api, uri);
      const baseline = api.openDesignerState(uri)!.designerText;
      const previousGeneration = api.openDesignerState(uri)!.renderGeneration;
      await waitForIdleProduct(api, kind);
      api.delayNextProductReplyForTest(kind, 3_000);
      const known = new Set(api.productRequestOutcomes().map(request => request.requestId));
      const pending = api.rerenderOpenDesigner(uri).then(() => undefined, error => error);
      const held = await latchHeldReply(api, uri, kind, known, 'late-reply-worker-recycle',
        ['ResolveAssembly', 'SetLocalizationCulture', 'RenderWithLayout', 'RenderInterpretedWithLayout']);
      const crashed = new Set([sessionOf(held.requestId)]);
      const crash = api.crashMappedEngineForRecoveryTest(kind);
      assert.ok(crash.signaled);
      assert.strictEqual(crash.pid, held.pid, 'the real crash hook targeted a different worker from the held product RPC');
      await pending;
      await waitFor(() => api.productRequestOutcomes().some(request => request.requestId === held.requestId
        && request.pid === crash.pid && request.outcome === 'STALE_WORKER_REPLY'),
      () => ({ held, outcomes: api.productRequestOutcomes().filter(request => request.requestId === held.requestId) }));
      await waitFor(() => api.openDesignerState(uri)?.renderReady === true
        && api.openDesignerState(uri)!.renderGeneration > previousGeneration
        && hasReplacementWorker(api, kind, crashed),
      () => ({ session: api.openDesignerState(uri), workers: api.productWorkerState() }));
      assert.strictEqual(api.openDesignerState(uri)?.designerText, baseline);
      assert.strictEqual(api.openDesignerState(uri)?.dirty, false);
      await api.editOpenDesignerProperty(uri, 'button1', 'Text', 'System.String', false, 'RELEASE22_AFTER_LATE_REPLY');
      await undoTo(api, uri, baseline, true);
      await close();
    });

    await scenario(`R22-HOST-011-${kind}-stop-during-pending-property-preserves-owner`, async () => {
      const uri = source(`${prefix}A`);
      await open(api, uri);
      const baseline = api.openDesignerState(uri)!.designerText;
      await api.editOpenDesignerProperty(uri, 'button1', 'Text', 'System.String', false, 'RELEASE22_RETAIN_DIRTY');
      await waitFor(() => api.openDesignerState(uri)?.renderReady === true, () => api.openDesignerState(uri));
      const retained = api.openDesignerState(uri)!;
      const disk = fs.readFileSync(retained.designerFile!);
      const operationId = `release22-${kind}-pending-stop`;
      // Both runtime families propose source through the modern planner. net48 live reconciliation follows
      // the host commit, so holding that later RPC would miss the rollback-before-source boundary.
      const plannerKind: Kind = 'modern';
      await waitForIdleProduct(api, kind);
      if (kind !== plannerKind) await waitForIdleProduct(api, plannerKind);
      const known = new Set(api.productRequestOutcomes().map(request => request.requestId));
      api.delayNextProductReplyForTest(plannerKind, 3_000);
      const pending = api.editOpenDesignerPropertyWithOperation(uri, 'button1', 'Text', 'System.String', false,
        'RELEASE22_MUST_NOT_COMMIT', operationId).then(value => value, error => error);
      const held = await latchHeldReply(api, uri, plannerKind, known, `stop-pending-property-${kind}`,
        kind === 'modern' ? ['PreviewOwnedRegionPropertySet', 'SetProperty'] : ['SetProperty']);
      assert.match(held.commandId ?? '', /^operation:/, 'the pending proposal has no child identity of its stable host operation');
      const pendingRecord = api.observeOpenDesignerOperation(uri, operationId);
      assert.ok(pendingRecord);
      assert.strictEqual(pendingRecord.status, 'pending', 'the held source proposal already crossed the host commit boundary');
      assert.strictEqual(pendingRecord.commitCount, 0);
      assert.strictEqual(pendingRecord.baseRevision, retained.revision);
      timingWitnesses[timingWitnesses.length - 1].hostOperationId = operationId;
      await vscode.commands.executeCommand('winformsDesigner.stopEngines');
      const stoppedResult = await pending;
      const recognizedCancellation = stoppedResult instanceof Error
        && ['REQUEST_CANCELLED', 'STALE_WORKER_GENERATION', 'STALE_WORKER_REPLY', 'WORKER_SUPERVISOR_DISPOSED']
          .includes((stoppedResult as Error & { code?: string }).code ?? stoppedResult.message);
      assert.ok(recognizedCancellation || stoppedResult && !(stoppedResult instanceof Error)
        && (stoppedResult.status === 'noChange' || stoppedResult.status === 'refused'),
      `a stopped pending property returned an unrecognized outcome: ${String(stoppedResult)}`);
      assert.strictEqual(api.openDesignerState(uri)?.designerText, retained.designerText,
        'stopping workers during a pending property discarded or replaced the earlier dirty buffer');
      assert.strictEqual(api.openDesignerState(uri)?.revision, retained.revision,
        'the cancelled pending property created a native history unit');
      assert.strictEqual(api.openDesignerState(uri)?.dirty, true);
      assert.deepStrictEqual(fs.readFileSync(retained.designerFile!), disk);
      const record = api.observeOpenDesignerOperation(uri, operationId);
      assert.ok(record);
      assert.strictEqual(record.createdAtUtc, pendingRecord.createdAtUtc, 'cancellation replaced the durable operation identity');
      assert.strictEqual(record.commitCount, 0);
      assert.ok(record.status === 'noChange' || record.status === 'refused',
        'rollback retained an unresolved durable operation outcome');
      await api.rerenderOpenDesigner(uri);
      await waitFor(() => api.openDesignerState(uri)?.renderReady === true, () => api.openDesignerState(uri));
      await undoTo(api, uri, baseline, true);
      await close();
    });

    await scenario(`R22-HOST-012-${kind}-rollback-after-resource-journal-write`, async () => {
      const uri = source(`${prefix}A`);
      const designer = path.join(path.dirname(uri.fsPath), 'Release22Form.Designer.cs');
      const resource = path.join(path.dirname(uri.fsPath), 'Release22Form.resx');
      const designerBefore = fs.readFileSync(designer);
      const resourceBefore = fs.readFileSync(resource);
      await open(api, uri);
      let journalBoundaryReached = false;
      const applied = await api.importOpenDesignerLocalImageWithJournalInterleave(uri, 'button1', 'Image', 'System.Drawing.Image',
        vscode.Uri.file(path.join(path.dirname(path.dirname(uri.fsPath)), 'input.png')), async () => {
          journalBoundaryReached = true;
          assert.ok(!fs.readFileSync(resource).equals(resourceBefore), 'the hook did not reach the applied resource journal state');
          assert.strictEqual(api.openDesignerState(uri)?.dirty, false, 'native Undo was registered before the durable journal boundary');
          await close();
          await vscode.commands.executeCommand('winformsDesigner.stopEngines');
        });
      assert.strictEqual(journalBoundaryReached, true);
      assert.strictEqual(applied, false, 'a resource transaction committed after its document owner closed');
      assert.deepStrictEqual(fs.readFileSync(designer), designerBefore);
      assert.deepStrictEqual(fs.readFileSync(resource), resourceBefore);
      await open(api, uri);
      assert.strictEqual(api.openDesignerState(uri)?.designerText, designerBefore.toString('utf8'));
      assert.strictEqual(api.openDesignerState(uri)?.dirty, false);
      await history(api, uri, 'undo');
      assert.strictEqual(api.openDesignerState(uri)?.designerText, designerBefore.toString('utf8'));
      assert.deepStrictEqual(fs.readFileSync(resource), resourceBefore, 'refused rollback left a phantom native Undo entry');
      await close();
      if (kind === 'net48') await observeDurableState();
    });
  }
}

function assertProductRoute(api: Api, kind: Kind, methods: readonly string[] = []): void {
  const workers = api.productWorkerState().filter(worker => worker.key.runtime === kind);
  assert.ok(workers.some(worker => worker.pid > 0 && worker.state === 'running'), 'ordinary product traffic has no real supervised worker');
  const expectedBuild = process.env[kind === 'modern' ? 'WFD_RELEASE22_EXPECTED_MODERN_BUILD_ID' : 'WFD_RELEASE22_EXPECTED_NET48_BUILD_ID'];
  assert.ok(expectedBuild, 'runner did not bind product acceptance to the built engine binary');
  for (const worker of workers) assert.strictEqual(worker.buildId, expectedBuild, 'ordinary product negotiated a different engine binary');
  // Completed attempts remain evidence after normal budget eviction. A worker need not stay resident after its lease
  // ends; the scenario baseline prevents a required route from being satisfied by an earlier scenario's request.
  const requests = api.productRequestOutcomes().filter(request => !scenarioPreviousAttempts.has(request.requestId));
  for (const method of methods) assert.ok(requests.some(request => request.method === method && request.outcome === 'OK'),
    `ordinary product ${method} never traversed the versioned supervisor contract in this scenario: ${JSON.stringify(requests)}`);
  assert.ok(requests.length > 0);
  for (const request of requests) {
    assert.ok(request.requestId && request.documentId && request.documentRevision);
    assert.ok(Number.isSafeInteger(request.pid) && request.pid > 0);
    assert.ok(Number.isSafeInteger(request.generation) && request.generation >= 0);
  }
  assert.strictEqual(new Set(requests.map(request => request.requestId)).size, requests.length,
    'a request attempt identity was reused');
}

/** The transport session of a request: one session is one started worker process. Windows recycles PIDs, so a
 * replacement may carry a crashed worker's number; only the session tells the two apart. */
function sessionOf(requestId: string): string {
  return requestId.slice(0, requestId.lastIndexOf(':'));
}

/** Sessions of the workers of a kind that had the given PID in a snapshot taken before that worker was crashed. */
function sessionsOfPid(workers: ReturnType<Api['productWorkerState']>, kind: Kind, pid: number): Set<string> {
  return new Set(workers.filter(worker => worker.key.runtime === kind && worker.pid === pid)
    .flatMap(worker => worker.requests.map(request => sessionOf(request.requestId))));
}

/** A running worker of a kind that is not one of the given (crashed) sessions. */
function hasReplacementWorker(api: Api, kind: Kind, crashed: ReadonlySet<string>): boolean {
  return api.productWorkerState().some(worker => worker.key.runtime === kind && worker.state === 'running'
    && worker.requests.length > 0 && worker.requests.every(request => !crashed.has(sessionOf(request.requestId))));
}

function workerFor(api: Api, uri: vscode.Uri, kind: Kind): ReturnType<Api['productWorkerState']>[number] | undefined {
  const owner = path.join(path.dirname(uri.fsPath), 'Release22Fixture.csproj').toLowerCase();
  const candidates = api.productWorkerState().filter(worker => worker.key.runtime === kind && worker.key.ownerProject === owner);
  const byPid = new Map(candidates.map(worker => [worker.pid, worker]));
  const latest = [...api.productRequestOutcomes()].reverse().find(request => byPid.has(request.pid)
    && (request.method === 'RenderWithLayout' || request.method === 'RenderInterpretedWithLayout') && request.outcome === 'OK');
  return latest ? byPid.get(latest.pid) : candidates[candidates.length - 1];
}
