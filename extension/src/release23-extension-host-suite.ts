import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import type { ExtensionHostTestApi } from './extension';

const viewType = 'winformsDesigner.designer';
type Kind = 'modern' | 'net48';
interface Snapshot { designer: string; source: string; resource: string; cultures: Record<string, string>; }
interface ExpectedDocument {
  name: string; kind: Kind; mode: 'linked' | 'checkpoint' | 'branch' | 'localized' | 'evicted';
  snapshots: Snapshot[]; activeIndex: number; diskDesigner: string; diskSource: string;
}
interface Scenario { id: string; passed: boolean; elapsedMs: number; error?: string; }
interface HistoryState {
  length: number; activeIndex: number; checkpointIndex: number | null; recoveredUndoCount: number;
  retainedRedoCount: number; limitation: string | null; logicalUndoCount?: number; logicalRedoCount?: number;
  recoveryMode?: 'native' | 'logical'; editorCheckpointCount?: number; companionConflict?: boolean; logicalDirty?: boolean;
}

async function waitFor(predicate: () => boolean, detail: () => unknown, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(JSON.stringify(detail()));
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

function tab(uri: vscode.Uri): vscode.Tab | undefined {
  return vscode.window.tabGroups.all.flatMap(group => group.tabs).find(candidate =>
    candidate.input instanceof vscode.TabInputCustom && candidate.input.viewType === viewType
    && candidate.input.uri.toString() === uri.toString());
}

async function focus(api: ExtensionHostTestApi, uri: vscode.Uri): Promise<void> {
  await api.focusOpenDesigner(uri);
  await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
  await waitFor(() => api.openDesignerState(uri)?.panelActive === true, () => api.openDesignerState(uri));
}

async function history(api: ExtensionHostTestApi, uri: vscode.Uri, command: 'undo' | 'redo', requireReadyRender = true): Promise<void> {
  await focus(api, uri);
  await vscode.commands.executeCommand(command);
  await settled(api, uri, requireReadyRender);
}

async function settled(api: ExtensionHostTestApi, uri: vscode.Uri, requireReadyRender = true): Promise<void> {
  await waitFor(() => {
    const state = api.openDesignerState(uri);
    if (!state?.ownerProjectPath || (requireReadyRender && !state.renderReady)) return false;
    const owner = path.resolve(state.ownerProjectPath).toLowerCase();
    return api.productWorkerState().filter(worker => worker.key.ownerProject === owner)
      .every(worker => worker.pending === 0 && worker.activeLeases === 0);
  }, () => ({ document: api.openDesignerState(uri), workers: api.productWorkerState()
    .map(worker => ({ key: worker.key, pending: worker.pending, activeLeases: worker.activeLeases })) }));
}

async function recoveredStep(api: ExtensionHostTestApi, uri: vscode.Uri, direction: 'undo' | 'redo', logical: boolean,
  expectedMove = true, keyboardDispatchCommand?: string): Promise<void> {
  if (!logical) return history(api, uri, direction);
  await focus(api, uri);
  const moved = await vscode.commands.executeCommand(keyboardDispatchCommand ?? (direction === 'undo'
    ? 'winformsDesigner.undoRecoveredAction' : 'winformsDesigner.redoRecoveredAction'));
  if (keyboardDispatchCommand) assert.notStrictEqual(moved, false, 'the registered designer shortcut handler refused the operation');
  else assert.strictEqual(moved, expectedMove, `the public recovered ${direction} command returned an unexpected transition result`);
  await settled(api, uri, expectedMove);
}

function observedHistory(api: ExtensionHostTestApi, uri: vscode.Uri): HistoryState {
  const state = api.openDesignerState(uri) as ReturnType<ExtensionHostTestApi['openDesignerState']>
    & { history?: HistoryState };
  assert.ok(state?.history, 'the document did not expose its bounded serializable history observation');
  return state.history;
}

async function snapshot(api: ExtensionHostTestApi, uri: vscode.Uri): Promise<Snapshot> {
  const state = api.openDesignerState(uri);
  assert.ok(state?.designerFile);
  const source = await vscode.workspace.openTextDocument(uri);
  return { designer: state.designerText, source: source.getText(),
    resource: fs.readFileSync(state.designerFile.replace(/\.Designer\.cs$/i, '.resx'), 'utf8'),
    cultures: cultures(uri) };
}

function cultures(uri: vscode.Uri): Record<string, string> {
  const stem = path.basename(uri.fsPath).replace(/\.cs$/i, '');
  return Object.fromEntries(fs.readdirSync(path.dirname(uri.fsPath)).sort()
    .filter(name => name.startsWith(`${stem}.`) && name.endsWith('.resx') && name !== `${stem}.resx`)
    .map(name => [name, fs.readFileSync(path.join(path.dirname(uri.fsPath), name), 'utf8')]));
}

function hashes(value: Snapshot): Record<string, string> {
  const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
  return { designer: sha(value.designer), source: sha(value.source), resource: sha(value.resource),
    ...Object.fromEntries(Object.entries(value.cultures).map(([name, text]) => [`culture:${name}`, sha(text)])) };
}

async function assertSnapshot(api: ExtensionHostTestApi, uri: vscode.Uri, expected: Snapshot): Promise<void> {
  const source = await vscode.workspace.openTextDocument(uri);
  const resource = uri.fsPath.replace(/\.cs$/i, '.resx');
  await waitFor(() => api.openDesignerState(uri)?.designerText === expected.designer
    && source.getText() === expected.source && fs.readFileSync(resource, 'utf8') === expected.resource
    && JSON.stringify(cultures(uri)) === JSON.stringify(expected.cultures),
  () => ({ expected: hashes(expected), actual: hashes({ designer: api.openDesignerState(uri)?.designerText ?? '',
    source: source.getText(), resource: fs.readFileSync(resource, 'utf8'), cultures: cultures(uri) }), state: api.openDesignerState(uri) }));
}

export async function run(): Promise<void> {
  assert.strictEqual(process.platform, 'win32');
  const product = vscode.extensions.all.find(candidate => candidate.id.toLowerCase() === 'skivhisink.winforms-designer-vscode');
  assert.ok(product);
  const api = await product.activate() as ExtensionHostTestApi;
  assert.ok(api?.openDesignerState);
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  assert.ok(root);
  const phase = process.env.WFD_RELEASE23_PHASE === 'restore' ? 'restore' : 'setup';
  const focusedScenario = process.env.WFD_RELEASE23_FOCUS ?? '';
  const expectedPath = path.join(root, '.release23-hot-exit.json');
  const reportPath = path.join(root, `.release23-${phase}-results.json`);
  const scenarios: Scenario[] = [];
  const observations: unknown[] = [];
  const scenario = async (id: string, body: () => Promise<void>): Promise<void> => {
    console.log(`RELEASE23 ${id}: starting`);
    const started = Date.now();
    const deadlineMs = id.endsWith('native-history-above-20') ? 420_000 : 180_000;
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([body(), new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`Scenario exceeded ${deadlineMs} ms: ${id}`)), deadlineMs);
      })]);
      scenarios.push({ id, passed: true, elapsedMs: Date.now() - started });
      console.log(`RELEASE23 ${id}: PASS`);
    } catch (error) {
      scenarios.push({ id, passed: false, elapsedMs: Date.now() - started,
        error: error instanceof Error ? error.stack : String(error) });
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
      fs.writeFileSync(reportPath, `${JSON.stringify({ suite: 'release23-extension-host', phase,
        vscodeVersion: vscode.version, extensionVersion: product.packageJSON.version,
        completedAt: new Date().toISOString(), focusedScenario: focusedScenario || null,
        expectedScenarioCount: focusedScenario ? 1 : phase === 'setup' ? 15 : 10,
        failed: scenarios.filter(result => !result.passed).length, scenarios, observations,
        configuration: { maximumResidentProcesses: vscode.workspace.getConfiguration('winformsDesigner').get('workers.maximumResidentProcesses'),
          autoDiscoverProjectControls: vscode.workspace.getConfiguration('winformsDesigner').get('toolbox.autoDiscoverProjectControls') },
        publicApiBoundary: 'Source/disk-only native history restores the applied suffix after a matching saved checkpoint. Editor artifacts use the public recovered-action commands because native WorkspaceEdit history shares the source URI. Existing native redo branches remain validated data; ordinary text history and a second CustomEditor view have separate boundaries.',
      }, null, 2)}\n`);
    }
  };
  const documents: ExpectedDocument[] = phase === 'restore'
    ? JSON.parse(fs.readFileSync(expectedPath, 'utf8')).documents : [];
  if (phase === 'setup' && !focusedScenario) {
    await scenario('R23-HOST-setup-four-worker-capacity', async () => {
      assert.strictEqual(vscode.workspace.getConfiguration('winformsDesigner').get('workers.maximumResidentProcesses'), 4);
      const owners: string[] = [];
      for (const mode of ['checkpoint', 'linked', 'branch', 'localized']) {
        for (const prefix of ['Modern', 'Framework']) {
          const uri = vscode.Uri.file(path.join(root, `${prefix}${mode}`, 'Release23Form.cs'));
          await vscode.commands.executeCommand('vscode.openWith', uri, viewType);
          await settled(api, uri);
          assert.strictEqual(api.openDesignerState(uri)?.dirty, false);
          assert.ok(api.productWorkerState().length <= 4);
          owners.push(api.openDesignerState(uri)!.ownerProjectPath!);
        }
      }
      assert.strictEqual(new Set(owners).size, 8);
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await waitFor(() => api.engineLifecycleState().openDesignerSessions === 0, () => api.engineLifecycleState());
      await vscode.workspace.getConfiguration('winformsDesigner').update('workers.maximumResidentProcesses', 16,
        vscode.ConfigurationTarget.Workspace);
      observations.push({ capacityProbe: { maximumResidentProcesses: 4, documentOwners: owners.length },
        historyContract: { maximumResidentProcesses: 16, autoDiscoverProjectControls: false } });
    });
    for (const [kind, prefix] of [['modern', 'Modern'], ['net48', 'Framework']] as const) {
      const uri = vscode.Uri.file(path.join(root, `${prefix}checkpoint`, 'Release23Form.cs'));
      await scenario(`R23-HOST-setup-${kind}-native-history-above-20`, async () => {
        await vscode.commands.executeCommand('vscode.openWith', uri, viewType);
        await waitFor(() => api.openDesignerState(uri)?.renderReady === true, () => api.openDesignerState(uri));
        assert.strictEqual(api.openDesignerState(uri)?.engineKind, kind);
        const states = [api.openDesignerState(uri)!.designerText];
        for (let index = 0; index < 21; ++index) {
          await api.moveOpenDesignerGroup(uri, ['button1'], 1, 0);
          await settled(api, uri);
          states.push(api.openDesignerState(uri)!.designerText);
          assert.notStrictEqual(states[index + 1], states[index]);
        }
        assert.strictEqual(observedHistory(api, uri).length, 20, 'the serializable history did not enforce its declared cap');
        for (let index = 20; index >= 0; --index) {
          await history(api, uri, 'undo');
          await waitFor(() => api.openDesignerState(uri)?.designerText === states[index],
            () => ({ phase: 'live undo above retained limit', index, state: api.openDesignerState(uri) }));
        }
        for (let index = 1; index <= 21; ++index) {
          await history(api, uri, 'redo');
          await waitFor(() => api.openDesignerState(uri)?.designerText === states[index],
            () => ({ phase: 'live redo above retained limit', index, state: api.openDesignerState(uri) }));
        }
        observations.push({ name: `${prefix}checkpoint`, liveUndoCount: 21, liveRedoCount: 21,
          serializableLimit: 20, historyAfterCrossingRetainedBoundary: observedHistory(api, uri),
          sourceSha256: createHash('sha256').update(states[21]).digest('hex') });
      });
      await scenario(`R23-HOST-setup-${kind}-save-saveAll-autoSave`, async () => {
        await vscode.commands.executeCommand('vscode.openWith', uri, viewType);
        await waitFor(() => api.openDesignerState(uri)?.renderReady === true, () => api.openDesignerState(uri));
        assert.strictEqual(api.openDesignerState(uri)?.engineKind, kind);
        await api.moveOpenDesignerGroup(uri, ['button1'], 2, 3);
        await settled(api, uri);
        await focus(api, uri);
        await vscode.commands.executeCommand('workbench.action.files.save');
        await waitFor(() => api.openDesignerState(uri)?.dirty === false && tab(uri)?.isDirty === false,
          () => api.openDesignerState(uri));
        await api.editOpenDesignerProperty(uri, 'button1', 'Text', 'System.String', false, 'saved checkpoint');
        await settled(api, uri);
        await focus(api, uri);
        await vscode.commands.executeCommand('workbench.action.files.saveAll');
        await waitFor(() => api.openDesignerState(uri)?.dirty === false && tab(uri)?.isDirty === false,
          () => api.openDesignerState(uri));
        // Both runtime probes precede every dirty hot-exit scenario, so auto-save cannot move another scenario's marker.
        const files = vscode.workspace.getConfiguration('files');
        await files.update('autoSaveDelay', 100, vscode.ConfigurationTarget.Workspace);
        await files.update('autoSave', 'afterDelay', vscode.ConfigurationTarget.Workspace);
        try {
          await api.moveOpenDesignerGroup(uri, ['button1'], 1, 1);
          await settled(api, uri);
          await waitFor(() => api.openDesignerState(uri)?.dirty === false && tab(uri)?.isDirty === false,
            () => ({ checkpointProbe: 'auto-save', state: api.openDesignerState(uri) }));
        } finally {
          await files.update('autoSave', 'off', vscode.ConfigurationTarget.Workspace);
        }
        assert.strictEqual(fs.readFileSync(uri.fsPath.replace(/\.cs$/i, '.Designer.cs'), 'utf8'),
          api.openDesignerState(uri)?.designerText);
        observations.push({ name: `${prefix}checkpoint`, savedBy: ['Save', 'Save All', 'auto-save'],
          history: observedHistory(api, uri) });
      });
    }
  }
  for (const mode of ['checkpoint', 'linked', 'branch', 'localized', 'evicted'] as const) {
    for (const [kind, prefix] of [['modern', 'Modern'], ['net48', 'Framework']] as const) {
      if (focusedScenario && focusedScenario !== `${kind}-${mode}`) continue;
      const name = `${prefix}${mode}`;
      const uri = vscode.Uri.file(path.join(root, name, 'Release23Form.cs'));
      const designerFile = uri.fsPath.replace(/\.cs$/i, '.Designer.cs');
      await scenario(`R23-HOST-${phase}-${kind}-${mode}`, async () => {
        await vscode.commands.executeCommand('vscode.openWith', uri, viewType);
        await waitFor(() => api.openDesignerState(uri)?.renderReady === true, () => api.openDesignerState(uri));
        assert.strictEqual(api.openDesignerState(uri)?.engineKind, kind);
        assert.ok(tab(uri));
        if (phase === 'setup') {
          const snapshots: Snapshot[] = [];
          if (mode === 'checkpoint') {
            assert.strictEqual(api.openDesignerState(uri)?.dirty, false);
            assert.strictEqual(fs.readFileSync(designerFile, 'utf8'), api.openDesignerState(uri)?.designerText);
          }
          snapshots.push(await snapshot(api, uri));
          if (mode === 'localized') {
            const ids = new Set(api.openDesignerState(uri)!.controls.map(control => control.id));
            await api.addOpenDesignerControl(uri, 'Button', 'this', 33, 44);
            await settled(api, uri);
            const added = api.openDesignerState(uri)!.controls.find(control => !ids.has(control.id));
            assert.ok(added, 'localized add did not expose its new control');
            snapshots.push(await snapshot(api, uri));
            assert.notStrictEqual(snapshots[1].resource, snapshots[0].resource);
            assert.strictEqual(await api.setOpenDesignerLocalizationCulture(uri, 'fr'), true);
            await settled(api, uri);
            await api.editOpenDesignerProperty(uri, added.id, 'Text', 'System.String', false, 'Bouton ajoute');
            await settled(api, uri);
            snapshots.push(await snapshot(api, uri));
            assert.notDeepStrictEqual(snapshots[2].cultures, snapshots[1].cultures);
            assert.strictEqual(await api.setOpenDesignerLocalizationCulture(uri, ''), true);
            await settled(api, uri);
            assert.strictEqual(await api.removeOpenDesignerControl(uri, added.id), 1);
            await settled(api, uri);
            snapshots.push(await snapshot(api, uri));
            assert.ok(!snapshots[3].designer.includes(`this.${added.id}`));
            assert.ok(!Object.values(snapshots[3].cultures).some(text => text.includes(`name="${added.id}.`)),
              'localized removal retained the deleted control culture keys');
          } else if (mode === 'evicted') {
            const beforeCode = snapshots[0].source;
            await api.createOpenDesignerHandler(uri, 'button1', 'Click');
            await settled(api, uri);
            snapshots.length = 0;
            snapshots.push(await snapshot(api, uri));
            assert.notStrictEqual(snapshots[0].source, beforeCode, 'the cap probe did not create its unsaved editor artifact');
            for (let index = 0; index < 21; ++index) {
              await api.moveOpenDesignerGroup(uri, ['button1'], 1, 0);
              await settled(api, uri);
              snapshots.push(await snapshot(api, uri));
            }
            snapshots.shift(); // The event and first geometry unit are outside the twenty-operation recovery window.
            assert.strictEqual(snapshots.length, 21);
            assert.strictEqual(observedHistory(api, uri).length, 20);
          } else {
            await api.moveOpenDesignerGroup(uri, ['button1'], 7, 5);
            await settled(api, uri);
            snapshots.push(await snapshot(api, uri));
            await api.editOpenDesignerProperty(uri, 'button1', 'Text', 'System.String', false, `${name} edited`);
            await settled(api, uri);
            snapshots.push(await snapshot(api, uri));
            if (mode === 'linked') {
              await api.createOpenDesignerHandler(uri, 'button1', 'Click');
              await settled(api, uri);
              snapshots.push(await snapshot(api, uri));
              assert.notStrictEqual(snapshots[3].source, snapshots[2].source, 'event operation did not change code-behind buffer');
              assert.strictEqual(await api.importOpenDesignerLocalImage(uri, 'button1', 'Image', 'System.Drawing.Image',
                vscode.Uri.file(path.join(root, 'input.png'))), true);
              await settled(api, uri);
              snapshots.push(await snapshot(api, uri));
              assert.notStrictEqual(snapshots[4].resource, snapshots[3].resource, 'image operation did not change the linked resource');
            }
            await api.moveOpenDesignerGroup(uri, ['button1'], 3, 4);
            await settled(api, uri);
            snapshots.push(await snapshot(api, uri));
          }
          let activeIndex = snapshots.length - 1;
          if (mode === 'branch') {
            await history(api, uri, 'undo');
            --activeIndex;
            await assertSnapshot(api, uri, snapshots[activeIndex]);
            assert.ok(observedHistory(api, uri).retainedRedoCount >= 1);
          }
          const setupState = api.openDesignerState(uri)!;
          const setupDiskDesigner = fs.readFileSync(designerFile, 'utf8');
          assert.strictEqual(setupState.dirty, setupState.designerText !== setupDiskDesigner,
            'generated-source dirty state disagrees with its exact saved bytes');
          assert.strictEqual(observedHistory(api, uri).logicalDirty, true,
            'pending native history lost its independent recovery dirty checkpoint');
          assert.strictEqual(tab(uri)?.isDirty, true);
          const expected = { name, kind, mode, snapshots, activeIndex,
            diskDesigner: setupDiskDesigner, diskSource: fs.readFileSync(uri.fsPath, 'utf8') };
          documents.push(expected);
          observations.push({ name, history: observedHistory(api, uri), snapshots: snapshots.map(hashes), activeIndex,
            generatedSourceDirty: setupState.dirty, generatedSourceMatchesDisk: setupState.designerText === setupDiskDesigner,
            nativeCustomModelDirty: tab(uri)?.isDirty });
          return;
        }
        const expected = documents.find(document => document.name === name);
        assert.ok(expected);
        await assertSnapshot(api, uri, expected.snapshots[expected.activeIndex]);
        assert.strictEqual(fs.readFileSync(designerFile, 'utf8'), expected.diskDesigner, 'restore wrote unsaved designer text to disk');
        assert.strictEqual(fs.readFileSync(uri.fsPath, 'utf8'), expected.diskSource, 'restore wrote an unsaved code-behind buffer to disk');
        const restored = observedHistory(api, uri);
        const logical = mode === 'linked' || mode === 'evicted';
        let keyboardUndoCommand: string | undefined;
        let keyboardRedoCommand: string | undefined;
        assert.strictEqual(restored.recoveryMode, logical ? 'logical' : 'native');
        assert.strictEqual(restored.recoveredUndoCount, logical ? 0 : expected.activeIndex);
        if (logical) {
          assert.strictEqual(restored.logicalUndoCount, expected.activeIndex);
          assert.ok((restored.editorCheckpointCount ?? 0) >= 1, 'the independent current editor checkpoint was not preserved');
          assert.ok(restored.limitation, 'mixed editor/native ownership did not name its public API limitation');
          const commands = new Set(await vscode.commands.getCommands(true));
          assert.ok(commands.has('winformsDesigner.undoRecoveredAction') && commands.has('winformsDesigner.redoRecoveredAction'));
          const keybindings = product.packageJSON.contributes.keybindings as { key?: string; command: string; when?: string }[];
          const shortcut = (key: string) => keybindings.find(binding => binding.key?.toLowerCase() === key
            && binding.when?.includes('activeCustomEditorId == winformsDesigner.designer'))?.command;
          keyboardUndoCommand = shortcut('ctrl+z');
          keyboardRedoCommand = shortcut('ctrl+y');
          assert.ok(keyboardUndoCommand && commands.has(keyboardUndoCommand), 'the declared designer Undo shortcut has no registered public handler');
          assert.ok(keyboardRedoCommand && commands.has(keyboardRedoCommand), 'the declared designer Redo shortcut has no registered public handler');
          const current = expected.snapshots[expected.activeIndex];
          const assertRetained = async (): Promise<void> => {
            const actual = await snapshot(api, uri);
            assert.deepStrictEqual({ designer: actual.designer, resource: actual.resource, cultures: actual.cultures },
              { designer: current.designer, resource: current.resource, cultures: current.cultures });
            assert.strictEqual(fs.readFileSync(designerFile, 'utf8'), expected.diskDesigner);
            assert.strictEqual(fs.readFileSync(uri.fsPath, 'utf8'), expected.diskSource);
            const retained = observedHistory(api, uri);
            assert.strictEqual(retained.activeIndex, restored.activeIndex);
            assert.strictEqual(retained.length, restored.length);
            assert.strictEqual(retained.editorCheckpointCount, restored.editorCheckpointCount);
          };
          // The ordinary source editor owns this native stack. Its direct command can change only that buffer;
          // an aggregate save and recovered operation must refuse until native Redo restores the captured image.
          await history(api, uri, 'undo', false);
          const independent = await snapshot(api, uri);
          assert.notStrictEqual(independent.source, current.source, 'the native source-history boundary was not exercised');
          assert.strictEqual(independent.source, expected.diskSource);
          await assertRetained();
          await assert.rejects(() => api.saveOpenDesigner(uri),
            'aggregate CustomEditorProvider save accepted a source buffer outside its captured recovery image');
          await assertRetained();
          await recoveredStep(api, uri, 'undo', true, false);
          await assertRetained();
          await history(api, uri, 'redo');
          await assertSnapshot(api, uri, current);
          observations.push({ name, nativeSourceHistoryBoundary: {
            nativeUndoChangedOnlyOrdinarySourceBuffer: true, aggregateProviderSaveRefused: true,
            publicRecoveredUndoRefused: true, generatedResourceDiskAndCursorPreserved: true,
            editorCheckpointRetained: true, nativeRedoRestoredExactSourceBuffer: true,
            current: hashes(current), independent: hashes(independent),
          } });
        }
        if (mode === 'branch') {
          assert.ok(restored.retainedRedoCount >= 1, 'pre-exit redo data was discarded');
          assert.ok(restored.limitation, 'the public API redo limitation was not named');
          await history(api, uri, 'redo');
          await assertSnapshot(api, uri, expected.snapshots[expected.activeIndex]);
        }
        for (let index = expected.activeIndex - 1; index >= 0; --index) {
          console.log(`RELEASE23 ${name}: ${logical ? 'public recovered' : 'native'} Undo to snapshot ${index}`);
          await recoveredStep(api, uri, 'undo', logical, true,
            index === expected.activeIndex - 1 ? keyboardUndoCommand : undefined);
          await assertSnapshot(api, uri, expected.snapshots[index]);
        }
        if (mode === 'evicted') assert.strictEqual(api.openDesignerState(uri)?.dirty, true,
          'the retained cap boundary incorrectly became a clean disk checkpoint');
        if (logical) {
          await focus(api, uri);
          await vscode.commands.executeCommand('workbench.action.files.saveAll');
        }
        await waitFor(() => api.openDesignerState(uri)?.dirty === false && tab(uri)?.isDirty === false,
          () => api.openDesignerState(uri));
        const checkpointRevision = api.openDesignerState(uri)?.revision;
        await recoveredStep(api, uri, 'undo', logical, false);
        assert.strictEqual(api.openDesignerState(uri)?.revision, checkpointRevision,
          'native history crossed an unproven saved checkpoint boundary');
        for (let index = 1; index <= expected.activeIndex; ++index) {
          console.log(`RELEASE23 ${name}: ${logical ? 'public recovered' : 'native'} Redo to snapshot ${index}`);
          await recoveredStep(api, uri, 'redo', logical, true, index === 1 ? keyboardRedoCommand : undefined);
          await assertSnapshot(api, uri, expected.snapshots[index]);
        }
        await focus(api, uri);
        await vscode.commands.executeCommand('workbench.action.files.saveAll');
        await waitFor(() => api.openDesignerState(uri)?.dirty === false && tab(uri)?.isDirty === false,
          () => api.openDesignerState(uri));
        const final = expected.snapshots[expected.activeIndex];
        const sourceDocument = await vscode.workspace.openTextDocument(uri);
        await waitFor(() => !sourceDocument.isDirty && fs.readFileSync(uri.fsPath, 'utf8') === final.source
          && fs.readFileSync(designerFile, 'utf8') === final.designer,
        () => ({ saveAll: 'linked source and generated file did not settle', sourceDirty: sourceDocument.isDirty,
          sourceBufferSha256: createHash('sha256').update(sourceDocument.getText()).digest('hex'),
          sourceDiskSha256: createHash('sha256').update(fs.readFileSync(uri.fsPath)).digest('hex'),
          expectedSourceSha256: hashes(final).source }), 5_000);
        assert.strictEqual(fs.readFileSync(designerFile, 'utf8'), final.designer);
        assert.strictEqual(fs.readFileSync(uri.fsPath, 'utf8'), final.source);
        assert.strictEqual(fs.readFileSync(uri.fsPath.replace(/\.cs$/i, '.resx'), 'utf8'), final.resource);
        observations.push({ name, restoredHistory: restored, finalHistory: observedHistory(api, uri),
          historyIngress: logical ? 'public-recovered-action-commands' : 'native-undo-redo',
          ...(logical ? { shortcutHandlers: { undo: keyboardUndoCommand, redo: keyboardRedoCommand,
            scope: 'Registered public handlers invoked; operating-system keyboard delivery was not synthesized.' } } : {}),
          verifiedUndoCount: expected.activeIndex, verifiedRedoCount: expected.activeIndex, saved: hashes(final) });
        if (mode === 'linked') {
          // A saved, disjoint ordinary-editor change invalidates the captured companion image even while the
          // generated CustomDocument is clean. Exercise the same public Reload path selected from its timeline.
          await focus(api, uri);
          await vscode.commands.executeCommand('winformsDesigner.viewCode');
          await waitFor(() => vscode.window.activeTextEditor?.document === sourceDocument,
            () => ({ activeTextDocument: vscode.window.activeTextEditor?.document.uri.toString() }));
          const editor = vscode.window.activeTextEditor!;
          const eol = final.source.includes('\r\n') ? '\r\n' : '\n';
          const comment = `${final.source.endsWith('\n') ? '' : eol}// R23 saved disjoint companion comment${eol}`;
          const changed: Snapshot = { ...final, source: final.source + comment };
          assert.strictEqual(await editor.edit(edit => edit.insert(sourceDocument.positionAt(final.source.length), comment)), true);
          await settled(api, uri);
          assert.strictEqual(sourceDocument.isDirty, true);
          const dirtyCompanionHistory = observedHistory(api, uri);
          const dirtyCompanionRevision = api.openDesignerState(uri)?.revision;
          assert.strictEqual(await vscode.commands.executeCommand('winformsDesigner.reloadDesignerFromDisk', uri), false,
            'Reload accepted a dirty owned companion and discarded its tracked recovery image');
          await assertSnapshot(api, uri, changed);
          assert.strictEqual(sourceDocument.isDirty, true, 'refused Reload saved or reverted the dirty companion');
          assert.deepStrictEqual(observedHistory(api, uri), dirtyCompanionHistory, 'refused Reload changed retained history');
          assert.strictEqual(api.openDesignerState(uri)?.revision, dirtyCompanionRevision);
          assert.strictEqual(api.openDesignerState(uri)?.dirty, false);
          assert.strictEqual(tab(uri)?.isDirty, false);
          assert.strictEqual(fs.readFileSync(designerFile, 'utf8'), final.designer);
          assert.strictEqual(fs.readFileSync(uri.fsPath, 'utf8'), final.source);
          assert.strictEqual(await sourceDocument.save(), true, 'the ordinary companion editor did not save its disjoint comment');
          await waitFor(() => !sourceDocument.isDirty && fs.readFileSync(uri.fsPath, 'utf8') === changed.source
            && observedHistory(api, uri).companionConflict === true,
          () => ({ sourceDirty: sourceDocument.isDirty, history: observedHistory(api, uri) }), 5_000);
          await settled(api, uri);
          await assertSnapshot(api, uri, changed);
          assert.strictEqual(api.openDesignerState(uri)?.dirty, false, 'a saved companion comment dirtied generated source');
          assert.strictEqual(tab(uri)?.isDirty, false, 'a saved companion comment dirtied the clean custom model');
          const conflict = observedHistory(api, uri);
          const conflictRevision = api.openDesignerState(uri)?.revision;
          await assert.rejects(() => api.editOpenDesignerProperty(uri, 'button1', 'Text', 'System.String', false, 'must refuse conflicting companion'),
            (error: unknown) => (error as { code?: string })?.code === 'COMPANION_CHECKPOINT_CONFLICT',
            'the designer accepted a property edit against an independently changed saved companion');
          await assertSnapshot(api, uri, changed);
          assert.deepStrictEqual(observedHistory(api, uri), conflict, 'a refused mutation changed retained recovery history');
          assert.strictEqual(api.openDesignerState(uri)?.revision, conflictRevision);
          assert.strictEqual(fs.readFileSync(designerFile, 'utf8'), final.designer);
          assert.strictEqual(fs.readFileSync(uri.fsPath, 'utf8'), changed.source);
          assert.strictEqual(await vscode.commands.executeCommand('winformsDesigner.reloadDesignerFromDisk', uri), true,
            'the public timeline Reload path did not complete for a clean custom model');
          await settled(api, uri);
          await assertSnapshot(api, uri, changed);
          assert.strictEqual(observedHistory(api, uri).companionConflict, false, 'Reload retained the obsolete companion checkpoint');
          assert.strictEqual(api.openDesignerState(uri)?.dirty, false);
          assert.strictEqual(tab(uri)?.isDirty, false);
          assert.strictEqual(sourceDocument.isDirty, false);
          assert.strictEqual(fs.readFileSync(designerFile, 'utf8'), final.designer);
          assert.strictEqual(fs.readFileSync(uri.fsPath, 'utf8'), changed.source);
          const reloadedHistory = observedHistory(api, uri);
          assert.strictEqual(reloadedHistory.recoveryMode, 'native');
          assert.strictEqual(reloadedHistory.editorCheckpointCount, 0);
          assert.strictEqual(reloadedHistory.length, 0);
          assert.strictEqual(reloadedHistory.activeIndex, 0);
          await api.editOpenDesignerProperty(uri, 'button1', 'Text', 'System.String', false, 'post reload property edit');
          await settled(api, uri);
          assert.notStrictEqual(api.openDesignerState(uri)?.designerText, final.designer, 'Reload left ordinary designer editing blocked');
          assert.strictEqual(api.openDesignerState(uri)?.dirty, true);
          await focus(api, uri);
          await vscode.commands.executeCommand(keyboardUndoCommand!);
          await settled(api, uri);
          await assertSnapshot(api, uri, changed);
          await waitFor(() => api.openDesignerState(uri)?.dirty === false && tab(uri)?.isDirty === false,
            () => api.openDesignerState(uri));
          assert.strictEqual(sourceDocument.isDirty, false);
          assert.strictEqual(fs.readFileSync(designerFile, 'utf8'), final.designer);
          assert.strictEqual(fs.readFileSync(uri.fsPath, 'utf8'), changed.source);
          observations.push({ name, cleanCompanionReload: { publicCommand: 'winformsDesigner.reloadDesignerFromDisk',
            dirtyCompanionReloadRefused: true, dirtyCompanionBufferDiskHistoryAndGeneratedArtifactsPreserved: true,
            savedCommentConflictDetected: true, generatedAndCustomModelStayedClean: true,
            conflictingPropertyEditRefused: true, retainedHistoryUnchangedOnRefusal: true,
            savedCommentBufferAndDiskPreserved: true, generatedAndResourcesPreserved: true,
            companionConflictCleared: true, ordinaryPropertyEditAndSupportedUndo: true,
            undoCommand: keyboardUndoCommand, reloadedHistory, finalHistory: observedHistory(api, uri), saved: hashes(changed) } });
        }
        if (mode === 'localized') {
          assert.strictEqual(await api.setOpenDesignerLocalizationCulture(uri, ''), true);
          await settled(api, uri);
          let adopted = final;
          const notices: { cycle: number; retainedHistory: HistoryState; adopted: Record<string, string> }[] = [];
          for (const cycle of [1, 2]) {
            assert.strictEqual(api.openDesignerState(uri)?.recoveryConflictOffered, false,
              'a completed Reload retained the prior external-change notice latch');
            await api.editOpenDesignerProperty(uri, 'button1', 'Text', 'System.String', false, `R23 watcher neutral ${cycle}`);
            await settled(api, uri);
            const pending = await snapshot(api, uri);
            assert.strictEqual(pending.designer, adopted.designer, 'the neutral resource-only edit changed generated source');
            assert.strictEqual(pending.source, adopted.source);
            assert.notStrictEqual(pending.resource, adopted.resource);
            assert.deepStrictEqual(pending.cultures, adopted.cultures);
            await waitFor(() => tab(uri)?.isDirty === true && observedHistory(api, uri).logicalDirty === true,
              () => ({ history: observedHistory(api, uri), tabDirty: tab(uri)?.isDirty }));
            assert.strictEqual(api.openDesignerState(uri)?.dirty, false,
              'the pending resource history dirtied generated source');
            const pendingHistory = observedHistory(api, uri);
            const pendingRevision = api.openDesignerState(uri)?.revision;
            const eol = pending.designer.includes('\r\n') ? '\r\n' : '\n';
            const external = `${pending.designer}${pending.designer.endsWith('\n') ? '' : eol}// R23 external generated comment ${cycle}${eol}`;
            // Write as an independent actor, then wait for the real product watcher to offer recovery. No test hook
            // calls reloadFromDiskIfClean or fabricates a notice: the observation only reads its existing latch.
            fs.writeFileSync(designerFile, external, 'utf8');
            await waitFor(() => api.openDesignerState(uri)?.recoveryConflictOffered === true,
              () => ({ externalChange: 'actual watcher did not offer recovery', state: api.openDesignerState(uri) }), 10_000);
            await assertSnapshot(api, uri, pending);
            assert.deepStrictEqual(observedHistory(api, uri), pendingHistory, 'the watcher discarded resource-only history');
            assert.strictEqual(api.openDesignerState(uri)?.revision, pendingRevision);
            assert.strictEqual(api.openDesignerState(uri)?.dirty, false);
            assert.strictEqual(tab(uri)?.isDirty, true);
            assert.strictEqual(fs.readFileSync(designerFile, 'utf8'), external, 'the watcher overwrote the external source');
            assert.strictEqual(fs.readFileSync(uri.fsPath, 'utf8'), adopted.source);
            assert.strictEqual(await vscode.commands.executeCommand('winformsDesigner.reloadDesignerFromDisk', uri), true);
            await settled(api, uri);
            adopted = { ...pending, designer: external };
            await assertSnapshot(api, uri, adopted);
            assert.strictEqual(fs.readFileSync(designerFile, 'utf8'), external);
            assert.strictEqual(api.openDesignerState(uri)?.recoveryConflictOffered, false,
              'successful explicit Reload did not allow a later conflict notice');
            assert.strictEqual(api.openDesignerState(uri)?.dirty, false);
            assert.strictEqual(tab(uri)?.isDirty, false);
            assert.strictEqual(observedHistory(api, uri).length, 0);
            assert.strictEqual(observedHistory(api, uri).activeIndex, 0);
            assert.strictEqual(observedHistory(api, uri).logicalDirty, false);
            notices.push({ cycle, retainedHistory: pendingHistory, adopted: hashes(adopted) });
          }
          await api.editOpenDesignerProperty(uri, 'button1', 'Text', 'System.String', false, 'R23 resource edit after watcher Reload');
          await settled(api, uri);
          assert.notStrictEqual((await snapshot(api, uri)).resource, adopted.resource,
            'explicit Reload left localized resource editing blocked');
          await history(api, uri, 'undo');
          await assertSnapshot(api, uri, adopted);
          await waitFor(() => tab(uri)?.isDirty === false && observedHistory(api, uri).logicalDirty === false,
            () => ({ state: api.openDesignerState(uri), history: observedHistory(api, uri) }));
          assert.strictEqual(fs.readFileSync(designerFile, 'utf8'), adopted.designer);
          assert.strictEqual(fs.readFileSync(uri.fsPath, 'utf8'), adopted.source);
          observations.push({ name, resourceOnlyExternalWatcher: { sourceStayedCleanWithPendingResourceHistory: true,
            actualWatcherNoticeObservedTwice: true, generatedBufferHistoryAndResourcesPreservedBeforeReload: true,
            externalDiskBytesPreserved: true, publicReloadAdoptedExternalSourceAndResetHistory: true,
            noticeLatchResetAfterReload: true, laterResourceEditAndNativeUndo: true,
            publicCommand: 'winformsDesigner.reloadDesignerFromDisk', notices, final: hashes(adopted) } });
        }
      });
    }
  }
  if (phase === 'setup') {
    fs.writeFileSync(expectedPath, `${JSON.stringify({ documents }, null, 2)}\n`);
    // The marker is written only after all assertions. Let ordinary VS Code quit run backupCustomDocument; resolving
    // the suite here would let test-electron tear down the host before the hot-exit backups have been persisted.
    await new Promise(resolve => setTimeout(resolve, 2_500));
    await vscode.commands.executeCommand('workbench.action.quit');
    await new Promise<never>(() => undefined);
  }
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
}
