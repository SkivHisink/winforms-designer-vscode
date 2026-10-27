import assert from 'node:assert/strict';

/**
 * Runs against the documented command surface. readSource reads the public document inspection's sourceText;
 * save and undo use public VS Code commands. The outer driver must run setup and restore in separate processes.
 * @param {{ executeCommand: (command:string,arg:object)=>Promise<any>, readSource:(uri:string)=>Promise<string>,
 *   save:(uri:string)=>Promise<void>, undo:(uri:string)=>Promise<void>, readSavedSource?:(uri:string)=>Promise<string> }} host
 * @param {{ phase:'setup'|'restore', actionPackageUri:string, editorPackageUri:string, documentUri:string,
 *   componentId?:string, runtime:'modern'|'net48' }} options
 */
export async function runAdapterConformance(host, options) {
  const { phase, actionPackageUri, editorPackageUri, documentUri } = options;
  assert.ok(['setup', 'restore'].includes(phase), 'Conformance phase must identify an actual launch.');
  const componentId = options.componentId ?? 'button1';
  const cases = [];
  const check = async (name, run) => {
    try { const detail = await run(); cases.push({ name, passed: true, ...detail }); }
    catch (error) { cases.push({ name, passed: false, message: String(error?.message ?? error).slice(0, 1024) }); throw error; }
  };
  const inspect = packageUri => host.executeCommand('winformsDesigner.inspectAdapterPackage', { packageUri, documentUri });
  const enable = async packageUri => {
    const inspected = await inspect(packageUri);
    assert.equal(inspected.ok, true, `Sample package inspection refused: ${inspected.code}`);
    assert.match(inspected.packageSha256, /^[a-f0-9]{64}$/);
    const enabled = await host.executeCommand('winformsDesigner.enableAdapterDevelopment', {
      packageUri, expectedPackageSha256: inspected.packageSha256, acknowledgeTrustedCodeExecution: true,
    });
    assert.ok(enabled?.ok === true || enabled?.status === 'ok', `Sample enablement refused: ${enabled?.code}`);
    return inspected;
  };
  const invoke = (kind, input = {}) => host.executeCommand(kind === 'action'
    ? 'winformsDesigner.invokeAdapterAction' : 'winformsDesigner.editAdapterProperty', {
    documentUri, packageUri: kind === 'action' ? actionPackageUri : editorPackageUri,
    contributionId: kind === 'action' ? 'sample.set-caption' : 'sample.caption-editor', componentId, input,
  });
  const unchanged = async (kind, input, status) => {
    const before = await host.readSource(documentUri);
    const result = await invoke(kind, input);
    assert.equal(result?.status, status);
    assert.notEqual(result?.applied, true);
    assert.equal(await host.readSource(documentUri), before, `${kind} ${status} must preserve exact source.`);
    return { code: result?.code };
  };
  const appliedThenUndo = async (kind, value) => {
    const before = await host.readSource(documentUri);
    const result = await invoke(kind, { invariantValue: value });
    assert.equal(result?.status, 'ok', `Sample ${kind} refused: ${result?.code}`);
    assert.equal(result?.applied, true);
    const after = await host.readSource(documentUri);
    assert.notEqual(after, before, `${kind} success must change the document source.`);
    assert.ok(after.includes(value), `${kind} value must be represented in source.`);
    await host.undo(documentUri);
    assert.equal(await host.readSource(documentUri), before, `${kind} must be exactly one public Undo unit.`);
  };

  if (phase === 'setup') {
    await check('action-inspect-and-explicit-enable', async () => {
      const inspection = await enable(actionPackageUri);
      assert.deepEqual(inspection.manifest?.capabilities, ['action.set-property']);
    });
    await check('editor-inspect-and-explicit-enable', async () => {
      const inspection = await enable(editorPackageUri);
      assert.deepEqual(inspection.manifest?.capabilities, ['editor.scalar']);
    });
    await check('action-success-and-exact-undo', () => appliedThenUndo('action', 'SDK action caption'));
    await check('action-refusal-preserves-source', () => unchanged('action', { invariantValue: 'REFUSE' }, 'refused'));
    await check('action-cancel-preserves-source', () => unchanged('action', { cancel: true }, 'cancelled'));
    await check('editor-cancel-preserves-source', () => unchanged('editor', { cancel: true }, 'cancelled'));
    await check('editor-success-save-for-next-launch', async () => {
      const before = await host.readSource(documentUri);
      const result = await invoke('editor', { invariantValue: 'SDK editor caption' });
      assert.equal(result?.status, 'ok'); assert.equal(result?.applied, true);
      const after = await host.readSource(documentUri);
      assert.notEqual(after, before); assert.ok(after.includes('SDK editor caption'));
      await host.save(documentUri);
      if (host.readSavedSource) assert.equal(await host.readSavedSource(documentUri), after, 'Save must persist the actual accepted source.');
    });
  } else {
    await check('previous-launch-save-survives-restart', async () => {
      assert.ok((await host.readSource(documentUri)).includes('SDK editor caption'));
    });
    await check('action-enablement-survives-restart-and-undo', () => appliedThenUndo('action', 'SDK action after restart'));
    await check('editor-enablement-survives-restart-and-undo', () => appliedThenUndo('editor', 'Alternate caption'));
    await check('revocation-refuses-before-mutation', async () => {
      await host.executeCommand('winformsDesigner.disableAdapter', { packageUri: editorPackageUri });
      await unchanged('editor', { invariantValue: 'Alternate caption' }, 'refused');
    });
    await check('editor-reenable-after-revocation', () => enable(editorPackageUri));
  }
  return { phase, runtime: options.runtime, passed: cases.every(item => item.passed), cases };
}
