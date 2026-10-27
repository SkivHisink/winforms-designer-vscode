import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectAdapterPackage, invokeAdapterPackage, type AdapterRuntimeContext } from './adapterRuntime';
import { PROTOCOL_ID, PROTOCOL_VERSION, type AdapterPackage, type AdapterRequest } from '../../adapter-sdk/index.mjs';

const scratch: string[] = [];
afterEach(() => { for (const directory of scratch.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
function digest(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex'); }
const request: AdapterRequest = { protocolId: PROTOCOL_ID, protocolVersion: PROTOCOL_VERSION, id: 'request-1', operation: 'invokeAction',
  contributionId: 'sample.action', context: { componentId: 'button1', propertyName: 'Text', propertyType: 'System.String', invariantValue: 'old', revision: 7 }, input: {} };
const success = `const chunks=[]; for await(const chunk of process.stdin) chunks.push(chunk); const request=JSON.parse(Buffer.concat(chunks).toString());
process.stdout.write(JSON.stringify({protocolId:request.protocolId,protocolVersion:request.protocolVersion,id:request.id,status:'ok',intent:{kind:'setProperty',componentId:request.context.componentId,propertyName:request.context.propertyName,propertyType:request.context.propertyType,invariantValue:'new'}})+'\\n');`;
function fixture(source = success): { root: string; manifestPath: string; context: AdapterRuntimeContext; manifest: AdapterPackage } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wfd-adapter-test-')); scratch.push(root);
  const manifestPath = path.join(root, 'adapter-package.json');
  const manifest: AdapterPackage = {
    schemaId: 'winforms-designer.adapter-package', schemaVersion: 1, sdkVersion: '0.1.0',
    adapter: { id: 'sample.adapter', version: '0.1.0', displayName: 'Sample' },
    cohort: { productId: 'winforms-designer-vscode', minProductVersion: '2.3.0', maxProductVersionExclusive: '2.4.0', runtimes: ['modern', 'net48'], architectures: ['x64', 'arm64'] },
    execution: { kind: 'node-stdio', entrypoint: 'entry.mjs' }, integrity: { algorithm: 'sha256', files: [{ path: 'entry.mjs', sha256: digest(source) }] },
    provenance: { policy: 'local-development', certification: 'none' }, capabilities: ['action.set-property'],
    contributions: { actions: [{ id: 'sample.action', title: 'Set text', propertyName: 'Text', propertyType: 'System.String' }], editors: [] },
  };
  fs.writeFileSync(path.join(root, 'entry.mjs'), source); fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  return { root, manifestPath, manifest, context: { workspaceRoot: root, workspaceTrusted: true, productVersion: '2.3.0', runtime: 'modern', architecture: 'x64' } };
}
function saveManifest(item: ReturnType<typeof fixture>): void { fs.writeFileSync(item.manifestPath, JSON.stringify(item.manifest)); }
async function enabled(item: ReturnType<typeof fixture>, changes: Partial<Parameters<typeof invokeAdapterPackage>[2]> = {}) {
  const inspection = await inspectAdapterPackage(item.manifestPath, item.context);
  expect(inspection.ok).toBe(true);
  if (!inspection.ok) throw new Error('fixture is invalid');
  return invokeAdapterPackage(item.manifestPath, item.context, { enabledPackageSha256: inspection.packageSha256, request, isStillEnabled: () => true, ...changes });
}
function code(result: Awaited<ReturnType<typeof invokeAdapterPackage>> | Awaited<ReturnType<typeof inspectAdapterPackage>>): string | undefined {
  return result.ok ? undefined : result.diagnostics[0]?.code;
}

describe('verified local adapter package runtime', () => {
  it('inspects without executing and invokes one real child with a data-only intent', async () => {
    const item = fixture();
    const inspection = await inspectAdapterPackage(item.manifestPath, item.context);
    expect(inspection.ok).toBe(true);
    if (inspection.ok) {
      expect(inspection.provenance).toBe('local-development'); expect(inspection.certification).toBe('none');
      expect(inspection.fileHashes).toEqual([{ path: 'entry.mjs', sha256: digest(success), bytes: Buffer.byteLength(success) }]);
      expect(inspection.packageSha256).toMatch(/^[a-f0-9]{64}$/);
    }
    const result = await enabled(item);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (result.ok) expect(result.response).toMatchObject({ status: 'ok', intent: { invariantValue: 'new' } });
    expect(fs.readdirSync(item.root).sort()).toEqual(['adapter-package.json', 'entry.mjs']);
  });
  it('hashes exact manifest bytes as well as every declared package file', async () => {
    const item = fixture(); const before = await inspectAdapterPackage(item.manifestPath, item.context);
    fs.appendFileSync(item.manifestPath, '\n'); const after = await inspectAdapterPackage(item.manifestPath, item.context);
    expect(before.ok && after.ok && before.packageSha256 !== after.packageSha256).toBe(true);
  });
  it('refuses invalid UTF-8 bytes inside an otherwise valid manifest display name', async () => {
    const item = fixture(); const bytes = fs.readFileSync(item.manifestPath);
    bytes[bytes.indexOf('Sample')] = 0xff; fs.writeFileSync(item.manifestPath, bytes);
    const inspected = await inspectAdapterPackage(item.manifestPath, item.context);
    expect(code(inspected), inspected.ok ? inspected.manifest.adapter.displayName : undefined).toBe('ADAPTER_MANIFEST_INVALID');
  });
  it('refuses invalid UTF-8 bytes emitted by an actual child inside an otherwise valid String intent', async () => {
    const source = success.replace('process.stdout.write(', 'const encoded=Buffer.from(')
      + "\nencoded[encoded.indexOf('new')]=0xff;process.stdout.write(encoded);";
    const result = await enabled(fixture(source));
    expect(code(result), result.ok ? JSON.stringify(result.response) : undefined).toBe('ADAPTER_RESPONSE_INVALID');
  });
  it.each(['entry', 'dependency'] as const)('refuses correctly hashed %s module bytes that are not valid UTF-8', async (kind) => {
    const item = fixture(kind === 'entry' ? success : `import './dependency.mjs';\n${success}`);
    const name = kind === 'entry' ? 'entry.mjs' : 'dependency.mjs';
    const bytes = Buffer.concat([Buffer.from('//'), Buffer.from([0xff]), Buffer.from(`\n${kind === 'entry' ? success : 'export const value=1;'}`)]);
    fs.writeFileSync(path.join(item.root, name), bytes);
    if (kind === 'entry') item.manifest.integrity.files[0].sha256 = digest(bytes);
    else item.manifest.integrity.files.push({ path: name, sha256: digest(bytes) });
    saveManifest(item);
    expect(code(await inspectAdapterPackage(item.manifestPath, item.context))).toBe('ADAPTER_MODULE_INVALID');
  });
  it('preserves valid UTF-8 Unicode and an explicitly encoded replacement character', async () => {
    const value = 'Café Пример 😀 \ufffd';
    const item = fixture(success.replace("invariantValue:'new'", `invariantValue:${JSON.stringify(value)}`));
    item.manifest.adapter.displayName = value; saveManifest(item);
    const result = await enabled(item); expect(result.ok, JSON.stringify(result)).toBe(true);
    if (result.ok) expect(result.response).toMatchObject({ status: 'ok', intent: { invariantValue: value } });
  });
  it('keeps BOM-prefixed manifest and actual child response refusals', async () => {
    const item = fixture();
    fs.writeFileSync(item.manifestPath, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), fs.readFileSync(item.manifestPath)]));
    expect(code(await inspectAdapterPackage(item.manifestPath, item.context))).toBe('ADAPTER_MANIFEST_INVALID');
    const source = success.replace('process.stdout.write(', 'const encoded=Buffer.from(')
      + '\nprocess.stdout.write(Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),encoded]));';
    expect(code(await enabled(fixture(source)))).toBe('ADAPTER_RESPONSE_INVALID');
  });
  it('refuses untrusted workspace and incompatible product/runtime/architecture without a child', async () => {
    const item = fixture();
    expect(code(await inspectAdapterPackage(item.manifestPath, { ...item.context, workspaceTrusted: false }))).toBe('ADAPTER_WORKSPACE_UNTRUSTED');
    for (const productVersion of ['2.2.9', '2.4.0', '2.3.0-preview'])
      expect(code(await inspectAdapterPackage(item.manifestPath, { ...item.context, productVersion }))).toBe('ADAPTER_COHORT_UNSUPPORTED');
    item.manifest.cohort.runtimes = ['net48']; item.manifest.cohort.architectures = ['arm64']; saveManifest(item);
    expect(code(await inspectAdapterPackage(item.manifestPath, item.context))).toBe('ADAPTER_COHORT_UNSUPPORTED');
  });
  it('never accepts signed-vendor strings as proof of execution authority', async () => {
    const item = fixture(); (item.manifest.provenance as unknown as { policy: string }).policy = 'signed-vendor'; saveManifest(item);
    expect(code(await inspectAdapterPackage(item.manifestPath, item.context))).toBe('ADAPTER_PROVENANCE_UNSUPPORTED');
  });
  it('refuses missing declared services and unknown contribution before launch', async () => {
    const item = fixture(); item.manifest.requiredServices = ['Transactions']; saveManifest(item);
    expect(code(await inspectAdapterPackage(item.manifestPath, item.context))).toBe('ADAPTER_SERVICE_UNAVAILABLE');
    item.context = { ...item.context, availableServices: ['Transactions'] };
    expect(code(await enabled(item, { request: { ...request, contributionId: 'unknown.action' } }))).toBe('ADAPTER_SERVICE_UNAVAILABLE');
  });
  it('rejects modified bytes, enabled-hash mismatch and unlisted files', async () => {
    const item = fixture();
    expect(code(await enabled(item, { enabledPackageSha256: '0'.repeat(64) }))).toBe('ADAPTER_ENABLEMENT_HASH_MISMATCH');
    fs.appendFileSync(path.join(item.root, 'entry.mjs'), '//changed');
    expect(code(await inspectAdapterPackage(item.manifestPath, item.context))).toBe('ADAPTER_FILE_HASH_MISMATCH');
    fs.writeFileSync(path.join(item.root, 'entry.mjs'), success); fs.writeFileSync(path.join(item.root, 'extra.mjs'), 'process.exit(0)');
    expect(code(await inspectAdapterPackage(item.manifestPath, item.context))).toBe('ADAPTER_UNDECLARED_PACKAGE_FILE');
  });
  it('rejects dependency folders and secret-path names before reading their contents', async () => {
    const dependency = fixture(); fs.mkdirSync(path.join(dependency.root, 'node_modules'));
    expect(code(await inspectAdapterPackage(dependency.manifestPath, dependency.context))).toBe('ADAPTER_PATH_DENIED');
    for (const name of ['secrets/entry.mjs', 'private.key']) {
      const item = fixture(); item.manifest.integrity.files.push({ path: name, sha256: '0'.repeat(64) }); saveManifest(item);
      expect(code(await inspectAdapterPackage(item.manifestPath, item.context))).toBe('ADAPTER_PATH_DENIED');
    }
  });
  it('rejects package root junctions and lexical escapes', async () => {
    const item = fixture(); const other = fixture(); const link = path.join(other.root, 'linked');
    fs.symlinkSync(item.root, link, process.platform === 'win32' ? 'junction' : 'dir');
    expect(code(await inspectAdapterPackage(path.join(link, 'adapter-package.json'), other.context))).toBe('ADAPTER_PATH_DENIED');
    expect(code(await inspectAdapterPackage(item.manifestPath, other.context))).toBe('ADAPTER_PATH_DENIED');
    fs.unlinkSync(link);
  });
  it('bounds each file and the package file count', async () => {
    const item = fixture(); fs.writeFileSync(path.join(item.root, 'entry.mjs'), Buffer.alloc(1_048_577));
    expect(code(await inspectAdapterPackage(item.manifestPath, item.context))).toBe('ADAPTER_PACKAGE_TOO_LARGE');
    const count = fixture(); for (let index = 0; index < 17; index += 1) fs.writeFileSync(path.join(count.root, `extra${index}.txt`), 'x');
    expect(code(await inspectAdapterPackage(count.manifestPath, count.context))).toBe('ADAPTER_PACKAGE_TOO_LARGE');
  });
  it.each([
    ['zero output', 'process.exit(0);', 'ADAPTER_RESPONSE_FRAMING'],
    ['multiple responses', success.replace("+'\\n'", "+'\\n{}\\n'"), 'ADAPTER_RESPONSE_FRAMING'],
    ['trailing data', success.replace("+'\\n'", "+'\\nsecret-source'"), 'ADAPTER_RESPONSE_FRAMING'],
    ['wrong identity', success.replace('id:request.id', "id:'other'"), 'ADAPTER_RESPONSE_ID_MISMATCH'],
    ['wrong target', success.replace('componentId:request.context.componentId', "componentId:'button2'"), 'ADAPTER_RESULT_TARGET_MISMATCH'],
    ['wrong type', success.replace('propertyType:request.context.propertyType', "propertyType:'System.Int32'"), 'ADAPTER_RESULT_VALUE_INVALID'],
    ['overlarge stdout', `process.stdout.write('x'.repeat(65537));`, 'ADAPTER_MESSAGE_TOO_LARGE'],
    ['overlarge stderr', `process.stderr.write('source-secret'.repeat(1000));setInterval(()=>{},1000);`, 'ADAPTER_STDERR_TOO_LARGE'],
  ])('refuses %s without including source-bearing process output', async (_label, source, expected) => {
    const result = await enabled(fixture(source)); expect(code(result)).toBe(expected); expect(JSON.stringify(result)).not.toContain('source-secret');
  });
  it('allows the SDK buffer import and only exact hashed relative module dependencies', async () => {
    const source = `import { Buffer } from 'node:buffer'; import { value } from './values.mjs';\n${success.replace("invariantValue:'new'", 'invariantValue:value')}`;
    const item = fixture(source); const helper = "export const value='from-helper';";
    fs.writeFileSync(path.join(item.root, 'values.mjs'), helper); item.manifest.integrity.files.push({ path: 'values.mjs', sha256: digest(helper) }); saveManifest(item);
    const result = await enabled(item); expect(result.ok, JSON.stringify(result)).toBe(true);
    if (result.ok) expect(result.response).toMatchObject({ status: 'ok', intent: { invariantValue: 'from-helper' } });
    for (const specifier of ['node:fs', 'unlisted-package', './unlisted.mjs']) {
      const denied = fixture(`import ${JSON.stringify(specifier)};\n${success}`);
      expect(code(await enabled(denied))).toBe('ADAPTER_PROCESS_FAILED');
    }
  });
  it('enforces cancellation, timeout and live enablement revocation', async () => {
    const source = 'setInterval(()=>{},1000);';
    const cancelled = new AbortController(); const item = fixture(source);
    const pending = enabled(item, { signal: cancelled.signal }); setTimeout(() => cancelled.abort(), 150);
    expect(code(await pending)).toBe('ADAPTER_CANCELLED');
    expect(code(await enabled(item, { timeoutMs: 100 }))).toBe('ADAPTER_TIMEOUT');
    let live = true; const revoked = enabled(item, { isStillEnabled: () => live }); setTimeout(() => { live = false; }, 150);
    expect(code(await revoked)).toBe('ADAPTER_ENABLEMENT_REVOKED');
  });
  it.skipIf(process.platform !== 'win32' || Number(process.versions.node.split('.')[0]) < 22)(
    'cancellation terminates the invocation-owned Windows descendant tree', async () => {
      // A trusted author has normal OS rights; the import contract is intentionally not a security sandbox.
      const source = `const child=process.getBuiltinModule('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});
process.getBuiltinModule('node:fs').writeFileSync('descendant.pid',String(child.pid));setInterval(()=>{},1000);`;
      const item = fixture(source); const controller = new AbortController();
      const pending = enabled(item, { signal: controller.signal });
      const marker = path.join(item.root, 'descendant.pid');
      const deadline = Date.now() + 3_000;
      while (!fs.existsSync(marker) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      expect(fs.existsSync(marker)).toBe(true);
      const descendant = Number(fs.readFileSync(marker, 'utf8'));
      const exists = (): boolean => { try { process.kill(descendant, 0); return true; } catch { return false; } };
      try {
        expect(exists()).toBe(true); controller.abort(); expect(code(await pending)).toBe('ADAPTER_CANCELLED');
        const stoppedBy = Date.now() + 2_000;
        while (exists() && Date.now() < stoppedBy) await new Promise((resolve) => setTimeout(resolve, 20));
        expect(exists()).toBe(false);
      } finally { controller.abort(); if (exists()) process.kill(descendant, 'SIGKILL'); await pending; }
    },
  );
  it('rejects noncanonical scalar results and an ignored input cancellation', async () => {
    for (const [propertyType, value] of [['System.Boolean', 'true'], ['System.Int32', '01'], ['System.Int32', '2147483648'], ['System.String', 'x'.repeat(8_193)]] as const) {
      const item = fixture(success.replace("invariantValue:'new'", `invariantValue:${JSON.stringify(value)}`));
      item.manifest.contributions.actions[0].propertyType = propertyType; saveManifest(item);
      const typedRequest = { ...request, context: { ...request.context, propertyType,
        invariantValue: propertyType === 'System.Boolean' ? 'True' : propertyType === 'System.Int32' ? '1' : 'old' } };
      expect(code(await enabled(item, { request: typedRequest }))).toBe('ADAPTER_RESULT_VALUE_INVALID');
    }
    expect(code(await enabled(fixture(), { request: { ...request, input: { cancel: true } } }))).toBe('ADAPTER_CANCEL_IGNORED');
  });
  it('refuses an out-of-list dropdown input before the executable entrypoint can run', async () => {
    const item = fixture("throw new Error('ENTRY_MUST_NOT_RUN');");
    const contribution = item.manifest.contributions.actions[0];
    item.manifest.capabilities = ['editor.scalar'];
    item.manifest.contributions = { actions: [], editors: [{ ...contribution, presentation: 'dropdown', choices: ['A'] }] };
    saveManifest(item);
    const result = await enabled(item, { request: { ...request, operation: 'editProperty', input: { invariantValue: 'B' } } });
    expect(code(result)).toBe('ADAPTER_EDITOR_CHOICE_INVALID');
  });
  it('checks an actual child dropdown result against its declared choices, allowing the old context value outside them', async () => {
    const item = fixture(success);
    const contribution = item.manifest.contributions.actions[0];
    item.manifest.capabilities = ['editor.scalar'];
    item.manifest.contributions = { actions: [], editors: [{ ...contribution, presentation: 'dropdown', choices: ['A'] }] };
    saveManifest(item);
    const editorRequest: AdapterRequest = { ...request, operation: 'editProperty', input: { invariantValue: 'A' } };
    expect(editorRequest.context.invariantValue).toBe('old');
    expect(code(await enabled(item, { request: editorRequest }))).toBe('ADAPTER_EDITOR_CHOICE_INVALID');
    const validSource = success.replace("invariantValue:'new'", "invariantValue:'A'");
    fs.writeFileSync(path.join(item.root, 'entry.mjs'), validSource);
    item.manifest.integrity.files[0].sha256 = digest(validSource); saveManifest(item);
    const accepted = await enabled(item, { request: editorRequest });
    expect(accepted.ok, JSON.stringify(accepted)).toBe(true);
    if (accepted.ok) expect(accepted.response).toMatchObject({ status: 'ok', intent: { invariantValue: 'A' } });
  });
  it('honors a declarative disabled reason without executing an entrypoint', async () => {
    const item = fixture('process.exit(23)'); item.manifest.contributions.actions[0].disabledReasonCode = 'ADAPTER_FEATURE_DISABLED'; saveManifest(item);
    expect(code(await enabled(item))).toBe('ADAPTER_FEATURE_DISABLED');
  });
  it('does not copy response field names into diagnostics', async () => {
    const item = fixture(success.replace("status:'ok'", "sourceSecretMarker:'private source contents',status:'ok'"));
    const result = await enabled(item); expect(code(result)).toBe('ADAPTER_FIELD_UNKNOWN');
    expect(JSON.stringify(result)).not.toContain('sourceSecretMarker'); expect(JSON.stringify(result)).not.toContain('private source');
  });
  it('revalidates physical package bytes after a running child before returning an intent', async () => {
    const item = fixture(`await new Promise(resolve=>setTimeout(resolve,250));\n${success}`);
    const pending = enabled(item); setTimeout(() => fs.appendFileSync(path.join(item.root, 'entry.mjs'), '//modified-during-child'), 150);
    expect(code(await pending)).toBe('ADAPTER_FILE_HASH_MISMATCH');
  });
});
