import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable, Writable } from 'node:stream';
import { validateAdapterPackage, validateAdapterRequest, validateAdapterResponse, responseFor, serveAdapter,
  isPackagePath, MAX_INVARIANT_BYTES, MAX_MESSAGE_BYTES } from '../index.mjs';

function manifest() {
  return {
    schemaId: 'winforms-designer.adapter-package', schemaVersion: 1, sdkVersion: '0.1.0',
    adapter: { id: 'example.author.action', version: '0.1.0', displayName: 'Example adapter' },
    cohort: { productId: 'winforms-designer-vscode', minProductVersion: '2.3.0', maxProductVersionExclusive: '2.4.0', runtimes: ['modern', 'net48'], architectures: ['x64'] },
    execution: { kind: 'node-stdio', entrypoint: 'adapter.mjs' },
    integrity: { algorithm: 'sha256', files: [{ path: 'adapter.mjs', sha256: 'a'.repeat(64) }] },
    provenance: { policy: 'local-development', certification: 'none' }, capabilities: ['action.set-property'],
    requiredServices: ['Transactions', 'ComponentChange'],
    contributions: { actions: [{ id: 'example.set-caption', title: 'Set caption', propertyName: 'Text', propertyType: 'System.String' }], editors: [] },
  };
}
function request(type = 'System.String', value = 'Before') {
  return { protocolId: 'winforms-designer.adapter-stdio', protocolVersion: 1, id: 'request-1',
    operation: 'invokeAction', contributionId: 'example.set-caption', context: {
      componentId: 'button1', propertyName: 'Text', propertyType: type, invariantValue: value, revision: 2,
    }, input: {} };
}
function response(req = request(), value = 'After') {
  return responseFor(req, { status: 'ok', intent: { kind: 'setProperty', componentId: req.context.componentId,
    propertyName: req.context.propertyName, propertyType: req.context.propertyType, invariantValue: value } });
}
test('a strict package declaration never grants signed-vendor or arbitrary execution policy', () => {
  assert.equal(validateAdapterPackage(manifest()).ok, true);
  for (const provenance of [{ policy: 'signed-vendor', certification: 'none' },
    { policy: 'local-development', certification: 'certified' }, { policy: 'local-development', certification: 'none', signature: 'signed-vendor' }]) {
    assert.equal(validateAdapterPackage({ ...manifest(), provenance }).ok, false);
  }
});
test('unknown fields fail at every package record, including contributions and integrity entries', () => {
  for (const target of ['root', 'adapter', 'cohort', 'execution', 'integrity', 'file', 'provenance', 'contributions', 'action']) {
    const candidate = manifest();
    const nested = target === 'root' ? candidate : target === 'file' ? candidate.integrity.files[0]
      : target === 'action' ? candidate.contributions.actions[0] : candidate[target];
    nested.unknownAuthority = true;
    assert.equal(validateAdapterPackage(candidate).ok, false, target);
  }
});
test('declared files reject aliases, streams, traversal, device names, absolute and drive-relative paths', () => {
  for (const file of ['', '../adapter.mjs', 'a/../adapter.mjs', '/adapter.mjs', 'C:adapter.mjs', 'C:/adapter.mjs',
    '\\server\\adapter.mjs', 'a\\adapter.mjs', 'adapter.mjs:stream', 'CON.mjs', 'a/NUL.txt', 'a/./b.mjs', 'a//b.mjs', 'a./b.mjs']) {
    assert.equal(isPackagePath(file), false, file);
    const candidate = manifest(); candidate.integrity.files[0].path = file;
    assert.equal(validateAdapterPackage(candidate).ok, false, file);
  }
  const duplicate = manifest(); duplicate.integrity.files.push({ path: 'ADAPTER.mjs', sha256: 'a'.repeat(64) });
  assert.equal(validateAdapterPackage(duplicate).ok, false);
  assert.equal(isPackagePath('modules/shared-1.mjs'), true);
});
test('unknown services, capability mismatch, unsupported SDK and reversed cohorts fail closed', () => {
  const cases = [manifest(), manifest(), manifest(), manifest()];
  cases[0].requiredServices = ['UnsupportedDesignService']; cases[1].capabilities = ['editor.scalar'];
  cases[2].sdkVersion = '0.2.0'; cases[3].cohort.maxProductVersionExclusive = '2.3.0';
  for (const candidate of cases) assert.equal(validateAdapterPackage(candidate).ok, false);
});
test('malformed declarations are diagnostics, never incidental TypeErrors', () => {
  for (const field of Object.keys(manifest())) for (const value of [null, 42, true, [], 'bad']) {
    if (field === 'requiredServices' && Array.isArray(value)) continue; // An empty optional service requirement is valid.
    const candidate = { ...manifest(), [field]: value };
    assert.doesNotThrow(() => validateAdapterPackage(candidate), `${field}/${JSON.stringify(value)}`);
    assert.equal(validateAdapterPackage(candidate).ok, false, `${field}/${JSON.stringify(value)}`);
  }
});
test('editor choices obey scalar invariants and cannot be attached to action declarations', () => {
  const candidate = manifest();
  const editor = { ...candidate.contributions.actions[0], presentation: 'dropdown', choices: ['True', 'False'], propertyType: 'System.Boolean' };
  candidate.capabilities = ['editor.scalar']; candidate.contributions = { actions: [], editors: [editor] };
  assert.equal(validateAdapterPackage(candidate).ok, true);
  editor.choices = ['true']; assert.equal(validateAdapterPackage(candidate).ok, false);
  editor.choices = ['True']; editor.presentation = 'input'; assert.equal(validateAdapterPackage(candidate).ok, false);
});
test('dropdown input and successful result must belong to choices while an old current value remains admissible', () => {
  const contribution = { ...manifest().contributions.actions[0], presentation: 'dropdown', choices: ['First', 'Second'] };
  const req = request(); req.operation = 'editProperty';
  assert.equal(req.context.invariantValue, 'Before');
  assert.equal(validateAdapterRequest(req, contribution).ok, true, 'An existing value may precede the current choice list.');
  req.input.invariantValue = 'First';
  assert.equal(validateAdapterRequest(req, contribution).ok, true);
  assert.equal(validateAdapterResponse(response(req, 'Second'), req, contribution).ok, true);
  const result = validateAdapterResponse(response(req, 'Unlisted'), req, contribution);
  assert.equal(result.ok, false);
  assert.deepEqual(result.diagnostics, [{ code: 'ADAPTER_EDITOR_CHOICE_INVALID', path: '$.intent.invariantValue' }]);
  req.input.invariantValue = 'Unlisted';
  const input = validateAdapterRequest(req, contribution);
  assert.equal(input.ok, false);
  assert.deepEqual(input.diagnostics, [{ code: 'ADAPTER_EDITOR_CHOICE_INVALID', path: '$.input.invariantValue' }]);
  delete req.input.invariantValue; req.input.cancel = true;
  assert.equal(validateAdapterRequest(req, contribution).ok, true);
  assert.equal(validateAdapterResponse(responseFor(req, { status: 'cancelled' }), req, contribution).ok, true);
});
test('wire results cannot change identity, target, declared type, cancellation or carry source patches', () => {
  const req = request();
  const candidates = [response(req), response(req), response(req), response(req), response(req)];
  candidates[0].id = 'other'; candidates[1].intent.componentId = 'other'; candidates[2].intent.propertyType = 'System.Boolean';
  candidates[2].intent.invariantValue = 'True'; candidates[3].intent.sourcePatch = 'arbitrary'; candidates[4].source = 'arbitrary';
  for (const candidate of candidates) assert.equal(validateAdapterResponse(candidate, req, manifest().contributions.actions[0]).ok, false);
  const cancel = request(); cancel.input.cancel = true;
  assert.equal(validateAdapterResponse(response(cancel), cancel).ok, false);
  assert.equal(validateAdapterResponse(responseFor(cancel, { status: 'cancelled' }), cancel).ok, true);
});
test('bool/int32 values use canonical invariant representations with exact range bounds', () => {
  for (const [type, good, bad] of [
    ['System.Boolean', ['True', 'False'], ['true', '0', '', 'FALSE']],
    ['System.Int32', ['0', '-1', '2147483647', '-2147483648'], ['-0', '01', '+1', '1.0', '2147483648', '-2147483649', 'NaN']],
  ]) {
    for (const value of good) assert.equal(validateAdapterRequest(request(type, value)).ok, true, value);
    for (const value of bad) assert.equal(validateAdapterRequest(request(type, value)).ok, false, value);
  }
});
test('string invariant bounds count UTF-8 bytes and requests have no caller-authored source context', () => {
  assert.equal(validateAdapterRequest(request('System.String', 'a'.repeat(MAX_INVARIANT_BYTES))).ok, true);
  assert.equal(validateAdapterRequest(request('System.String', '\u00e9'.repeat(MAX_INVARIANT_BYTES / 2 + 1))).ok, false);
  const req = request(); req.context.source = 'secret source'; assert.equal(validateAdapterRequest(req).ok, false);
});
test('single-request stdio helper validates frames and the returned proposal before emitting', async () => {
  const req = request(); let text = '';
  const output = new Writable({ write(chunk, encoding, done) { text += chunk.toString(); done(); } });
  await serveAdapter(value => response(value), { input: Readable.from([JSON.stringify(req), '\n']), output });
  assert.deepEqual(JSON.parse(text), response(req));
  await assert.rejects(serveAdapter(value => ({ ...response(value), id: 'stale' }), { input: Readable.from([`${JSON.stringify(req)}\n`]), output }), /ID_MISMATCH/);
  await assert.rejects(serveAdapter(value => response(value), { input: Readable.from(['x'.repeat(MAX_MESSAGE_BYTES + 1)]), output }), /MESSAGE_TOO_LARGE/);
  await assert.rejects(serveAdapter(value => response(value), { input: Readable.from([`${JSON.stringify(req)}\n{}\n`]), output }), /MULTIPLE_REQUESTS/);
  await assert.rejects(serveAdapter(value => response(value), { input: Readable.from([Buffer.from([0xff, 10])]), output }), /encoded data/);
});
