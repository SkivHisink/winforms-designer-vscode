import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import type { ExtensionHostTestApi } from './extension';

type Api = ExtensionHostTestApi;
type StoredRecord = { file: string; record: Record<string, unknown> };
const viewType = 'winformsDesigner.designer';
const sha = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');

async function waitFor(check: () => boolean, detail: () => unknown): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (!check()) {
    if (Date.now() >= deadline) assert.fail(JSON.stringify(detail()));
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

function tab(uri: vscode.Uri): vscode.Tab | undefined {
  return vscode.window.tabGroups.all.flatMap(group => group.tabs).find(candidate =>
    candidate.input instanceof vscode.TabInputCustom && candidate.input.viewType === viewType
    && candidate.input.uri.toString() === uri.toString());
}

async function open(api: Api, uri: vscode.Uri): Promise<void> {
  await vscode.commands.executeCommand('vscode.openWith', uri, viewType);
  await waitFor(() => api.openDesignerState(uri)?.renderReady === true, () => api.openDesignerState(uri));
  assert.ok(tab(uri), 'the installed product did not create a real CustomEditor tab');
}

async function history(api: Api, uri: vscode.Uri, command: 'undo' | 'redo'): Promise<void> {
  await api.focusOpenDesigner(uri);
  await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
  await waitFor(() => api.openDesignerState(uri)?.panelActive === true, () => api.openDesignerState(uri));
  await vscode.commands.executeCommand(command);
}

function records(root: string): StoredRecord[] {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) return records(file);
    if (!entry.name.endsWith('.json')) return [];
    return [{ file, record: JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown> }];
  });
}

/** Normal installed hosts use real SQLite mementos and CustomDocument hot-exit backups, unlike extensionTestsPath. */
export async function run(): Promise<void> {
  const phase = process.env.WFD_RELEASE22_UPGRADE_PHASE;
  assert.ok(phase === 'old-initialize' || phase === 'upgrade' || phase === 'downgrade');
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  assert.ok(root);
  const storageRoot = process.env.WFD_RELEASE22_UPGRADE_GLOBAL_STORAGE;
  assert.ok(storageRoot);
  const reportPath = path.join(root, `.upgrade-${phase}.json`);
  const product = vscode.extensions.all.find(candidate => candidate.id.toLowerCase() === 'skivhisink.winforms-designer-vscode');
  const harness = vscode.extensions.getExtension('local-test.release22-upgrade-harness');
  assert.ok(product && harness, 'the installed product or unrelated harness is absent');
  assert.strictEqual(product.packageJSON.version, phase === 'upgrade' ? '2.2.0' : '2.1.0');
  assert.notStrictEqual(product.extensionPath, harness.extensionPath);
  const api = await product.activate() as Api;
  assert.ok(api?.openDesignerState, 'installed product activation failed or E2E seam is absent');
  const checks = ['installed-product-version', 'separate-development-harness', 'real-product-activation'];
  const observations: unknown[] = [];
  try {
    const commands = new Set(await vscode.commands.getCommands(true));
    assert.ok(commands.has('winformsDesigner.rebuildToolboxCache'));
    checks.push('real-command-registry');
    if (phase === 'upgrade') {
      await vscode.commands.executeCommand('winformsDesigner.rebuildToolboxCache');
      checks.push('real-disposable-cache-clear-command');

      // Reach the durable multi-file write boundary while the document is clean, then remove its sole commit owner.
      for (const [name, kind] of [['Modern', 'modern'], ['Framework', 'net48']] as const) {
        const uri = vscode.Uri.file(path.join(root, name, 'UpgradeForm.cs'));
        const designer = path.join(root, name, 'UpgradeForm.Designer.cs');
        const resource = path.join(root, name, 'UpgradeForm.resx');
        const designerBefore = fs.readFileSync(designer);
        const resourceBefore = fs.readFileSync(resource);
        await open(api, uri);
        assert.strictEqual(api.openDesignerState(uri)?.engineKind, kind);
        const previous = new Set(records(path.join(storageRoot, 'v2-transactions')).map(item => item.file));
        let boundary: unknown;
        const applied = await api.importOpenDesignerLocalImageWithJournalInterleave(uri, 'button1', 'Image',
          'System.Drawing.Image', vscode.Uri.file(path.join(root, 'input.png')), async () => {
            const journals: StoredRecord[] = records(path.join(storageRoot, 'v2-transactions')).filter(item =>
              !previous.has(item.file) && item.record.schemaVersion === '2.0.0');
            assert.strictEqual(journals.length, 1);
            assert.strictEqual(journals[0].record.state, 'applied');
            assert.ok(!fs.readFileSync(resource).equals(resourceBefore), 'resource bytes were not written before the journal hook');
            assert.strictEqual(api.openDesignerState(uri)?.dirty, false);
            boundary = { journal: journals[0], workers: api.productWorkerState(), lifecycle: api.engineLifecycleState() };
            await vscode.commands.executeCommand('workbench.action.closeAllEditors');
            await waitFor(() => !api.openDesignerState(uri), () => 'resource document owner did not close');
            await vscode.commands.executeCommand('winformsDesigner.stopEngines');
          });
        assert.ok(boundary, 'resource journal boundary was not reached');
        assert.strictEqual(applied, false, 'resource mutation committed after its sole document owner closed');
        assert.deepStrictEqual(fs.readFileSync(designer), designerBefore);
        assert.deepStrictEqual(fs.readFileSync(resource), resourceBefore);
        const journals: StoredRecord[] = records(path.join(storageRoot, 'v2-transactions')).filter(item =>
          !previous.has(item.file) && item.record.schemaVersion === '2.0.0');
        assert.strictEqual(journals.length, 1);
        assert.strictEqual(journals[0].record.state, 'rolledBack');
        await open(api, uri);
        assert.strictEqual(api.openDesignerState(uri)?.designerText, designerBefore.toString('utf8'));
        await history(api, uri, 'undo');
        assert.strictEqual(api.openDesignerState(uri)?.designerText, designerBefore.toString('utf8'));
        assert.strictEqual(api.openDesignerState(uri)?.dirty, false);
        assert.deepStrictEqual(fs.readFileSync(resource), resourceBefore, 'rolled-back journal left a phantom Undo entry');
        observations.push({ kind, scenario: 'rollback-after-applied-resource-journal', boundary,
          terminalJournal: journals[0], designerSha256: sha(designerBefore), resourceSha256: sha(resourceBefore) });
        checks.push(`${kind}-actual-applied-resource-journal`, `${kind}-resource-rollback-before-downgrade`, `${kind}-no-phantom-native-undo`);
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      }

      // Preserve an earlier dirty image while stopping a newer property intent with an actual worker reply outstanding.
      for (const [name, kind] of [['Modern', 'modern'], ['Framework', 'net48']] as const) {
        const uri = vscode.Uri.file(path.join(root, name, 'UpgradeForm.cs'));
        const designer = path.join(root, name, 'UpgradeForm.Designer.cs');
        const disk = fs.readFileSync(designer);
        await open(api, uri);
        await api.editOpenDesignerProperty(uri, 'button1', 'Text', 'System.String', false, `UPGRADE_UNSAVED_BACKUP_22_${kind}`);
        await waitFor(() => api.openDesignerState(uri)?.renderReady === true, () => api.openDesignerState(uri));
        const retained = api.openDesignerState(uri)!;
        assert.strictEqual(retained.engineKind, kind);
        assert.strictEqual(retained.dirty, true);
        assert.strictEqual(tab(uri)?.isDirty, true);
        assert.ok(retained.designerText.includes(`UPGRADE_UNSAVED_BACKUP_22_${kind}`));
        const operationId = `release22-installed-${kind}-pending-stop`;
        // Even a net48 document plans ordinary source properties in the modern parser; its net48 live update runs
        // after the host source commit. Hold the pre-commit source planner, never the already-committed live update.
        const planningRuntime = 'modern';
        await waitFor(() => api.productWorkerState().filter(worker => worker.key.runtime === planningRuntime)
          .every(worker => worker.pending === 0 && worker.delayedRequests.length === 0), () => api.productWorkerState());
        const planningMethods = kind === 'modern' ? ['PreviewOwnedRegionPropertySet', 'SetProperty'] : ['SetProperty'];
        api.delayNextProductReplyForTest(planningRuntime, 5_000);
        const operationStartedAt = Date.now();
        const pending = api.editOpenDesignerPropertyWithOperation(uri, 'button1', 'Text', 'System.String', false,
          'RELEASE22_MUST_NOT_COMMIT', operationId).then(value => ({ value, error: undefined, code: undefined }),
            error => ({ value: undefined, error: String(error), code: error?.code ?? error?.message }));
        await waitFor(() => api.productWorkerState().some(worker => worker.key.runtime === planningRuntime
          && worker.delayedRequests.some(request => planningMethods.includes(request.method)
            && request.commandId?.startsWith('operation:') === true && request.pid === worker.pid)),
          () => api.productWorkerState());
        const activeWorkers = api.productWorkerState();
        const pendingRecord = api.observeOpenDesignerOperation(uri, operationId);
        assert.ok(pendingRecord);
        assert.strictEqual(pendingRecord.operationId, operationId);
        assert.strictEqual(pendingRecord.status, 'pending');
        assert.ok(Date.parse(pendingRecord.createdAtUtc) >= operationStartedAt,
          'the pending intent reused a durable record from an earlier invocation');
        assert.ok(activeWorkers.some(worker => worker.key.runtime === planningRuntime
          && worker.buildId === process.env.WFD_RELEASE22_EXPECTED_MODERN_BUILD_ID));
        await vscode.commands.executeCommand('winformsDesigner.stopEngines');
        const outcome = await pending;
        assert.strictEqual(api.openDesignerState(uri)?.designerText, retained.designerText);
        assert.strictEqual(api.openDesignerState(uri)?.revision, retained.revision);
        assert.strictEqual(api.openDesignerState(uri)?.dirty, true);
        assert.deepStrictEqual(fs.readFileSync(designer), disk);
        const operation = api.observeOpenDesignerOperation(uri, operationId);
        assert.ok(operation);
        assert.strictEqual(operation.commitCount, 0);
        assert.ok(operation.status === 'noChange' || operation.status === 'refused', `unreconciled pending mutation: ${JSON.stringify(operation)}`);
        if (outcome.error !== undefined) assert.ok(['REQUEST_CANCELLED', 'STALE_WORKER_REPLY',
          'STALE_WORKER_GENERATION', 'WORKER_SUPERVISOR_DISPOSED'].includes(outcome.code),
        `stopping a pending mutation produced an unrelated failure: ${JSON.stringify(outcome)}`);
        else assert.ok(outcome.value && (outcome.value.status === 'noChange' || outcome.value.status === 'refused'));
        await history(api, uri, 'undo');
        await waitFor(() => api.openDesignerState(uri)?.designerText === disk.toString('utf8')
          && api.openDesignerState(uri)?.dirty === false && tab(uri)?.isDirty === false, () => api.openDesignerState(uri));
        await history(api, uri, 'redo');
        await waitFor(() => api.openDesignerState(uri)?.designerText === retained.designerText
          && api.openDesignerState(uri)?.dirty === true && tab(uri)?.isDirty === true, () => api.openDesignerState(uri));
        assert.deepStrictEqual(fs.readFileSync(designer), disk);
        observations.push({ kind, planningRuntime, scenario: 'stop-during-pending-property', activeWorkers, outcome, operation,
          retainedSourceSha256: sha(retained.designerText), diskSha256: sha(disk), requests: api.productRequestOutcomes() });
        checks.push(`${kind}-actual-supervisor-pending-edit`, `${kind}-stopped-property-no-commit-or-history`,
          `${kind}-pending-stop-preserved-native-history`, `${kind}-dirty-source-preserved`);
      }
      // The product's own rollback coordinator, not test-side quiescence: freeze admission, settle, prove the durable
      // state terminal, release worker ownership — and keep any request from starting a replacement worker.
      const prepared = await vscode.commands.executeCommand<{ ready: boolean; blockers: unknown[]; stoppedWorkers: number }>(
        'winformsDesigner.prepareRollback', { interactive: false, acceptUnresolved: false });
      assert.strictEqual(prepared?.ready, true, `rollback preparation refused: ${JSON.stringify(prepared)}`);
      await waitFor(() => api.productWorkerState().length === 0 && api.engineLifecycleState().liveProcessPids.length === 0,
        () => ({ workers: api.productWorkerState(), lifecycle: api.engineLifecycleState() }));
      const frozenUri = vscode.Uri.file(path.join(root, 'Modern', 'UpgradeForm.cs'));
      if (api.openDesignerState(frozenUri)) {
        try { await api.rerenderOpenDesigner(frozenUri); } catch { /* a refused render is the expected outcome */ }
      }
      assert.strictEqual(api.productWorkerState().length, 0, 'a request started a worker after the rollback was prepared');
      assert.strictEqual(api.engineLifecycleState().liveProcessPids.length, 0);
      checks.push('product-rollback-coordinator-ready', 'no-replacement-worker-after-rollback-preparation');
      const journals = records(path.join(storageRoot, 'v2-transactions')).filter(item => item.record.schemaVersion === '2.0.0');
      assert.ok(journals.length >= 2);
      assert.ok(journals.every(item => ['rolledBack', 'aborted', 'committed'].includes(String(item.record.state))));
      const operations = records(path.join(storageRoot, 'v2-operations')).filter(item => item.record.schemaVersion === '2.2.0');
      assert.ok(operations.length >= 2);
      assert.ok(operations.every(item => ['committed', 'noChange', 'refused'].includes(String(item.record.status))),
        `the installation is not ready for downgrade: ${JSON.stringify(operations)}`);
      observations.push({ scenario: 'quiescent-before-downgrade', workers: api.productWorkerState(),
        lifecycle: api.engineLifecycleState(), journals, operations });
      checks.push('no-worker-owner-before-host-restart', 'all-durable-journals-and-operations-reconciled-before-downgrade');
    } else if (phase === 'downgrade') {
      for (const [name, kind] of [['Modern', 'modern'], ['Framework', 'net48']] as const) {
        const uri = vscode.Uri.file(path.join(root, name, 'UpgradeForm.cs'));
        const designer = path.join(root, name, 'UpgradeForm.Designer.cs');
        const disk = fs.readFileSync(designer);
        const original = disk.toString('utf8');
        await open(api, uri);
        assert.strictEqual(api.openDesignerState(uri)?.engineKind, kind);
        assert.strictEqual(api.openDesignerState(uri)?.dirty, true);
        assert.ok(api.openDesignerState(uri)?.designerText.includes(`UPGRADE_UNSAVED_BACKUP_22_${kind}`));
        assert.deepStrictEqual(fs.readFileSync(designer), disk);
        await history(api, uri, 'undo');
        await waitFor(() => api.openDesignerState(uri)?.designerText === original && api.openDesignerState(uri)?.dirty === false
          && tab(uri)?.isDirty === false, () => api.openDesignerState(uri));
        await history(api, uri, 'redo');
        await waitFor(() => api.openDesignerState(uri)?.designerText.includes(`UPGRADE_UNSAVED_BACKUP_22_${kind}`) === true
          && api.openDesignerState(uri)?.dirty === true && tab(uri)?.isDirty === true, () => api.openDesignerState(uri));
        assert.deepStrictEqual(fs.readFileSync(designer), disk);
        checks.push(`${kind}-old-product-restored-new-source-byte-backup`, `${kind}-old-product-native-undo-redo`,
          `${kind}-restored-disk-source-unchanged`);
        await history(api, uri, 'undo');
        await waitFor(() => api.openDesignerState(uri)?.dirty === false, () => api.openDesignerState(uri));
      }
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }
    fs.writeFileSync(reportPath, `${JSON.stringify({ phase, passed: true, completedAt: new Date().toISOString(),
      vscodeVersion: vscode.version, extensionVersion: product.packageJSON.version,
      installedExtensionPath: product.extensionPath, developmentHarnessPath: harness.extensionPath, checks, observations,
    }, null, 2)}\n`);
    console.log(`RELEASE22-UPGRADE ${phase}: PASS (${checks.length} checks)`);
    if (phase === 'upgrade') {
      await vscode.commands.executeCommand('workbench.action.quit');
      await new Promise<never>(() => {});
    }
  } catch (error) {
    fs.writeFileSync(reportPath, `${JSON.stringify({ phase, passed: false, checks, observations,
      error: error instanceof Error ? error.stack : String(error),
    }, null, 2)}\n`);
    throw error;
  }
}
