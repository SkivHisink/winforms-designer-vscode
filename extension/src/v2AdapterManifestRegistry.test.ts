import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { V2AdapterManifest } from './v2AdapterManifest';

const host = vi.hoisted(() => {
  const diagnostics = { clear: vi.fn(), set: vi.fn(), dispose: vi.fn() };
  const watcher = {
    onDidCreate: vi.fn(() => ({ dispose: vi.fn() })),
    onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
    onDidDelete: vi.fn(() => ({ dispose: vi.fn() })),
    dispose: vi.fn(),
  };
  return {
    diagnostics,
    watcher,
    findFiles: vi.fn(),
    stat: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    output: { appendLine: vi.fn() },
  };
});

vi.mock('vscode', () => ({
  workspace: {
    createFileSystemWatcher: vi.fn(() => host.watcher),
    findFiles: host.findFiles,
    fs: { stat: host.stat, readFile: host.readFile, writeFile: host.writeFile },
  },
  languages: { createDiagnosticCollection: vi.fn(() => host.diagnostics) },
  Position: class { constructor(public line: number, public character: number) {} },
  Range: class { constructor(public start: unknown, public end: unknown) {} },
  Diagnostic: class { constructor(public range: unknown, public message: string, public severity: number) {} },
  DiagnosticSeverity: { Error: 0 },
}));

import {
  V2_ADAPTER_MANIFEST_DIAGNOSTIC_LIMIT,
  V2_ADAPTER_MANIFEST_DIAGNOSTIC_MESSAGE_LIMIT,
  V2_ADAPTER_MANIFEST_DISCOVERY_LIMIT,
  V2_ADAPTER_MANIFEST_FILE_BYTE_LIMIT,
  V2AdapterManifestRegistry,
} from './v2AdapterManifestRegistry';

function manifest(): V2AdapterManifest {
  return JSON.parse(fs.readFileSync(path.resolve(process.cwd(), '..', 'docs/v2/adapter-manifest.sample.json'), 'utf8'));
}

function uri(name: string, scheme = 'file') {
  return { scheme, toString: () => `${scheme}:///workspace/${name}/.winforms-designer/adapter-manifest.json` };
}

function discover(values: readonly { name: string; value: unknown }[]) {
  const manifests = new Map(values.map(({ name, value }) => [uri(name).toString(), Buffer.from(JSON.stringify(value))]));
  host.findFiles.mockResolvedValue(values.map(({ name }) => uri(name)));
  host.stat.mockImplementation(async (candidate) => ({ size: manifests.get(candidate.toString())!.byteLength }));
  host.readFile.mockImplementation(async (candidate) => manifests.get(candidate.toString()));
}

describe('product adapter manifest registry', () => {
  let registry: V2AdapterManifestRegistry;
  beforeEach(() => {
    vi.clearAllMocks();
    registry = new V2AdapterManifestRegistry('2.1.0', host.output as never);
  });
  afterEach(() => registry.dispose());

  it('keeps valid net48 metadata accepted until a different form cohort is inspected', async () => {
    const candidate = manifest();
    candidate.compatibility.cohorts[0].runtimes = ['net48'];
    candidate.compatibility.cohorts[0].architectures = ['x64'];
    candidate.trust = { ...candidate.trust, signature: 'signed-vendor', loadVendorCode: true };
    discover([{ name: 'net48', value: candidate }]);

    expect((await registry.refresh())[0]).toMatchObject({
      ok: true, manifestValid: true, compatibilityState: 'compatible',
      manifestDeclaresVendorCodeLoad: true, vendorCodeLoaded: false, workspaceMutationAuthorityGranted: false,
    });
    const problemsBefore = host.diagnostics.set.mock.calls.length;
    const incompatible = registry.snapshotForContext({ runtime: 'modern', architecture: 'arm64' })[0];
    expect(incompatible).toMatchObject({
      ok: false, manifestValid: true, compatibilityState: 'incompatible',
      compatibilityContext: { productVersion: '2.1.0', runtime: 'modern', architecture: 'arm64' },
      diagnosticCodes: ['ADAPTER_COHORT_UNSUPPORTED'],
    });
    expect(incompatible.diagnostics[0].message).toContain('runtime modern, architecture arm64');
    expect(incompatible.diagnostics[0].message).toContain('[2.0.0, 3.0.0) net48 x64');
    expect(registry.snapshotForContext({ runtime: 'net48', architecture: 'x64' })[0].ok).toBe(true);
    expect(registry.snapshot()[0].ok).toBe(true);
    expect(host.diagnostics.set).toHaveBeenCalledTimes(problemsBefore);
    expect(host.writeFile).not.toHaveBeenCalled();
  });

  it('rejects all declarations of a duplicate identity, even with different versions or disjoint cohorts', async () => {
    const second = manifest();
    second.adapter.version = '2.2.0';
    second.compatibility.cohorts[0].runtimes = ['net48'];
    discover([{ name: 'z', value: second }, { name: 'a', value: manifest() }]);

    const statuses = await registry.refresh();
    expect(statuses.map((item) => item.uri)).toEqual([uri('a').toString(), uri('z').toString()]);
    expect(statuses.every((item) => !item.ok && item.manifestValid && item.compatibilityState === 'duplicate')).toBe(true);
    expect(statuses.every((item) => item.diagnosticCodes.includes('ADAPTER_IDENTITY_DUPLICATE'))).toBe(true);
    expect(statuses[0].diagnostics[0].message).toContain('Keep one declaration');
    expect(registry.snapshotForContext({ runtime: 'modern' })[1].diagnosticCodes).toEqual([
      'ADAPTER_IDENTITY_DUPLICATE', 'ADAPTER_COHORT_UNSUPPORTED',
    ]);
    expect(host.diagnostics.set.mock.calls.every(([, diagnostics]) => diagnostics[0].code === 'ADAPTER_IDENTITY_DUPLICATE')).toBe(true);

    discover([{ name: 'a', value: manifest() }]);
    expect((await registry.refresh())[0].ok).toBe(true);
  });

  it('explains installed product version incompatibility without losing valid metadata', async () => {
    const candidate = manifest();
    candidate.compatibility.cohorts[0].minProductVersion = '2.2.0';
    discover([{ name: 'future', value: candidate }]);
    const [status] = await registry.refresh();
    expect(status).toMatchObject({ ok: false, manifestValid: true, compatibilityState: 'incompatible' });
    expect(status.diagnostics[0].message).toContain('product 2.1.0');
    expect(status.diagnostics[0].message).toContain('[2.2.0, 3.0.0)');
    expect(registry.snapshotForContext({ runtime: 'net48' })[0].ok).toBe(false);
  });

  it('does not let an invalid duplicate identity invalidate an accepted sample declaration', async () => {
    const invalid = manifest();
    invalid.protocol.supportedVersions = [2];
    discover([{ name: 'valid', value: manifest() }, { name: 'invalid', value: invalid }]);
    const statuses = await registry.refresh();
    expect(statuses.find((item) => item.uri === uri('valid').toString())).toMatchObject({ ok: true, diagnosticCodes: [] });
    expect(statuses.find((item) => item.uri === uri('invalid').toString())).toMatchObject({
      ok: false, adapterId: null, diagnosticCodes: ['ADAPTER_PROTOCOL_UNSUPPORTED'],
    });
  });

  it('publishes actionable invalid-capability diagnostics without echoing arbitrary values', async () => {
    const candidate = manifest() as unknown as Record<string, unknown>;
    candidate.capabilities = ['PRIVATE_CANARY\n' + 'x'.repeat(10000)];
    discover([{ name: 'invalid', value: candidate }]);
    const [status] = await registry.refresh();
    expect(status).toMatchObject({ ok: false, manifestValid: false, compatibilityState: 'invalid' });
    expect(status.diagnosticCodes).toContain('ADAPTER_CAPABILITY_UNDECLARED');
    expect(status.diagnostics[0].message).toContain('Use unique values from: adapter.manifest-v1');
    expect(JSON.stringify(status)).not.toContain('PRIVATE_CANARY');
    expect(status.vendorCodeLoaded).toBe(false);
    expect(host.writeFile).not.toHaveBeenCalled();
  });

  it('bounds diagnostic count, messages and paths for malformed manifest fields', async () => {
    const candidate = { ...manifest(), ...Object.fromEntries(Array.from({ length: 80 }, (_, index) => [`${index}-${'x'.repeat(400)}`, true])) };
    discover([{ name: 'invalid', value: candidate }]);
    const [status] = await registry.refresh();
    expect(status.diagnostics).toHaveLength(V2_ADAPTER_MANIFEST_DIAGNOSTIC_LIMIT);
    expect(status.diagnosticsTruncated).toBe(true);
    expect(status.diagnostics.every((item) => item.message.length <= V2_ADAPTER_MANIFEST_DIAGNOSTIC_MESSAGE_LIMIT
      && (item.path?.length ?? 0) <= 256)).toBe(true);
    expect(host.diagnostics.set.mock.calls[0][1]).toHaveLength(V2_ADAPTER_MANIFEST_DIAGNOSTIC_LIMIT);
  });

  it('refuses file growth after stat before parsing and exposes no partial declaration', async () => {
    host.findFiles.mockResolvedValue([uri('large')]);
    host.stat.mockResolvedValue({ size: 1 });
    host.readFile.mockResolvedValue(new Uint8Array(V2_ADAPTER_MANIFEST_FILE_BYTE_LIMIT + 1));
    const [status] = await registry.refresh();
    expect(status).toMatchObject({ ok: false, manifestValid: false, adapterId: null, diagnosticCodes: ['ADAPTER_MANIFEST_FILE_TOO_LARGE'] });
  });

  it('avoids reading known oversized files and sanitizes read errors', async () => {
    host.findFiles.mockResolvedValue([uri('large')]);
    host.stat.mockResolvedValue({ size: V2_ADAPTER_MANIFEST_FILE_BYTE_LIMIT + 1 });
    expect((await registry.refresh())[0].diagnosticCodes).toEqual(['ADAPTER_MANIFEST_FILE_TOO_LARGE']);
    expect(host.readFile).not.toHaveBeenCalled();
    host.stat.mockRejectedValue(new Error('PRIVATE_ERROR_CANARY'));
    const [status] = await registry.refresh();
    expect(status.diagnosticCodes).toEqual(['ADAPTER_MANIFEST_READ_FAILED']);
    expect(JSON.stringify(status)).not.toContain('PRIVATE_ERROR_CANARY');
    expect(JSON.stringify(host.output.appendLine.mock.calls)).not.toContain('PRIVATE_ERROR_CANARY');
  });

  it('limits discovery and ignores non-file URIs and repeated provider results', async () => {
    const many = Array.from({ length: V2_ADAPTER_MANIFEST_DISCOVERY_LIMIT + 1 }, (_, index) => uri(String(index)));
    host.findFiles.mockResolvedValue([uri('virtual', 'memfs'), many[0], ...many]);
    host.stat.mockResolvedValue({ size: 1 });
    host.readFile.mockResolvedValue(Buffer.from(JSON.stringify(manifest())));
    expect(await registry.refresh()).toHaveLength(V2_ADAPTER_MANIFEST_DISCOVERY_LIMIT);
    expect(host.readFile).toHaveBeenCalledTimes(V2_ADAPTER_MANIFEST_DISCOVERY_LIMIT);
    expect(host.findFiles).toHaveBeenCalledWith(expect.any(String), undefined, V2_ADAPTER_MANIFEST_DISCOVERY_LIMIT + 1);
  });

  it('returns detached status snapshots and prevents old refreshes replacing the latest result', async () => {
    discover([{ name: 'current', value: manifest() }]);
    const first = await registry.refresh();
    (first[0].capabilities as string[]).length = 0;
    (first[0].compatibilityCohorts[0].runtimes as string[]).length = 0;
    (first[0].compatibilityContext as { productVersion: string }).productVersion = '9.0.0';
    expect(registry.snapshot()[0].capabilities.length).toBeGreaterThan(0);
    expect(registry.snapshot()[0].compatibilityCohorts[0].runtimes.length).toBeGreaterThan(0);
    expect(registry.snapshot()[0].compatibilityContext.productVersion).toBe('2.1.0');

    let completeOld!: (bytes: Uint8Array) => void;
    let oldReadStarted!: () => void;
    const started = new Promise<void>((resolve) => { oldReadStarted = resolve; });
    host.readFile.mockImplementationOnce(() => new Promise<Uint8Array>((resolve) => {
      completeOld = resolve;
      oldReadStarted();
    }));
    const oldRefresh = registry.refresh();
    await started;
    discover([]);
    expect(await registry.refresh()).toEqual([]);
    completeOld(Buffer.from(JSON.stringify(manifest())));
    expect(await oldRefresh).toEqual([]);
    expect(registry.snapshot()).toEqual([]);
  });

  it('disposes watchers and diagnostics without resurrecting discovery', async () => {
    registry.dispose();
    expect(await registry.refresh()).toEqual([]);
    expect(host.findFiles).not.toHaveBeenCalled();
    expect(host.watcher.dispose).toHaveBeenCalledOnce();
    expect(host.diagnostics.dispose).toHaveBeenCalledOnce();
  });
});
