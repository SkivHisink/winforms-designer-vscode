import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EvaluatedProjectArchitecture, inspectPeArchitecture, inspectProjectCompatibility, parseProjectEvaluation,
  ProjectCompatibilityCache, ProjectCompatibilityResult,
  projectEvaluationArguments, evaluateProjectArchitecture,
} from './projectCompatibility';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

function pe(machine = 0x14c, flags: number | null = 1, dll = true): Buffer {
  const image = Buffer.alloc(1024);
  image.writeUInt16LE(0x5a4d, 0);
  image.writeUInt32LE(0x80, 0x3c);
  image.writeUInt32LE(0x4550, 0x80);
  image.writeUInt16LE(machine, 0x84);
  image.writeUInt16LE(1, 0x86);
  const optional = 0x98;
  const wide = machine === 0x8664 || machine === 0xaa64;
  const size = wide ? 240 : 224;
  const directories = optional + (wide ? 112 : 96);
  image.writeUInt16LE(size, 0x94);
  image.writeUInt16LE(dll ? 0x2002 : 2, 0x96);
  image.writeUInt16LE(wide ? 0x20b : 0x10b, optional);
  image.writeUInt32LE(0x200, optional + 60);
  image.writeUInt32LE(16, directories - 4);
  if (flags !== null) {
    image.writeUInt32LE(0x2000, directories + 14 * 8);
    image.writeUInt32LE(72, directories + 14 * 8 + 4);
    image.writeUInt32LE(72, 0x200);
    image.writeUInt32LE(flags, 0x210);
  }
  const section = optional + size;
  image.writeUInt32LE(0x200, section + 8);
  image.writeUInt32LE(0x2000, section + 12);
  image.writeUInt32LE(0x200, section + 16);
  image.writeUInt32LE(0x200, section + 20);
  return image;
}

const projectPath = path.resolve('fixtures', 'Form.csproj');
const outputPath = path.resolve('fixtures', 'bin', 'Form.dll');
const project: EvaluatedProjectArchitecture = {
  configuration: 'Debug', platform: 'AnyCPU', platformTarget: 'AnyCPU', targetFramework: 'net10.0-windows',
  prefer32Bit: false, targetPath: outputPath, knownDependencyPaths: [], importPaths: [],
};
const options = { trusted: true, projectPath, runtime: 'modern' as const, workerArchitecture: 'x64' as const };
const evaluate = (overrides: Partial<EvaluatedProjectArchitecture> = {}) => vi.fn(async () => ({ ok: true as const, project: { ...project, ...overrides } }));

describe('PE architecture evidence', () => {
  it.each([
    ['AnyCPU', 0x14c, 1, 'anycpu'], ['required x86', 0x14c, 3, 'x86'],
    ['mixed mode x86', 0x14c, 0, 'x86'], ['native x86', 0x14c, null, 'x86'],
    ['managed x64', 0x8664, 1, 'x64'], ['native x64', 0x8664, null, 'x64'],
    ['managed ARM64', 0xaa64, 1, 'arm64'], ['native ARM64', 0xaa64, null, 'arm64'],
  ])('recognizes %s from actual bytes', (_name, machine, flags, expected) => {
    expect(inspectPeArchitecture(pe(machine as number, flags as number | null)).architecture).toBe(expected);
  });

  it('decodes compiler preferred32 EXE flags without promoting preference to a requirement', () => {
    expect(inspectPeArchitecture(pe(0x14c, 0x20003, false))).toMatchObject({
      architecture: 'anycpu', managed: true, requires32Bit: false, prefers32Bit: true, isDll: false,
    });
  });

  it.each([0, 63, 140, 350, 525])('returns unknown for truncated managed headers (%s bytes)', (length) => {
    expect(inspectPeArchitecture(pe().subarray(0, length)).architecture).toBe('unknown');
  });

  it('never interprets missing optional-directory bytes as a native x86 certainty', () => {
    const image = pe();
    image.writeUInt16LE(100, 0x94);
    expect(inspectPeArchitecture(image).architecture).toBe('unknown');
  });

  it('does not map a CLR RVA into virtual padding that is not file data', () => {
    const image = pe();
    image.writeUInt32LE(0x300, 0x98 + 224 + 8);
    image.writeUInt32LE(0, 0x98 + 224 + 16);
    expect(inspectPeArchitecture(image).architecture).toBe('unknown');
  });
});

describe('session architecture cache', () => {
  const result = (): ProjectCompatibilityResult => ({
    status: 'compatible', code: 'ARCHITECTURE_COMPATIBLE', message: 'Matches.', workerArchitecture: 'x64',
    nativeDependencies: [], limitations: ['Native availability is unverified.'], observedPaths: [outputPath],
  });

  it('reuses stable evidence without evaluating again and returns independent copies', async () => {
    const inspect = vi.fn(async () => result());
    const cache = new ProjectCompatibilityCache({ inspect, stat: async () => ({ mtimeMs: 1, size: 100 }) });
    const first = await cache.inspect(options);
    first.limitations.push('caller mutation');
    expect((await cache.inspect(options)).limitations).not.toContain('caller mutation');
    expect(inspect).toHaveBeenCalledTimes(1);
  });

  it('coalesces in-flight inspection, including concurrent explicit refreshes', async () => {
    let release!: (value: ProjectCompatibilityResult) => void;
    const inspect = vi.fn(() => new Promise<ProjectCompatibilityResult>((resolve) => { release = resolve; }));
    const cache = new ProjectCompatibilityCache({ inspect, stat: async () => ({ mtimeMs: 1, size: 100 }) });
    const first = cache.inspect(options);
    const second = cache.inspect(options, { force: true });
    await vi.waitFor(() => expect(inspect).toHaveBeenCalledTimes(1));
    release(result());
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    expect(inspect).toHaveBeenCalledTimes(1);
  });

  it('invalidates reuse when an observed output or import changes', async () => {
    let mtimeMs = 1;
    const inspect = vi.fn(async () => result());
    const cache = new ProjectCompatibilityCache({ inspect, stat: async () => ({ mtimeMs, size: 100 }) });
    await cache.inspect(options);
    mtimeMs++;
    await cache.inspect(options);
    expect(inspect).toHaveBeenCalledTimes(2);
  });

  it('expires successful evidence after 30 seconds and unknown after 2 seconds', async () => {
    let now = 1;
    let status: ProjectCompatibilityResult['status'] = 'compatible';
    const inspect = vi.fn(async () => ({ ...result(), status }));
    const cache = new ProjectCompatibilityCache({ inspect, now: () => now, stat: async () => ({ mtimeMs: 1, size: 100 }) });
    await cache.inspect(options);
    now += 30_001;
    status = 'unknown';
    await cache.inspect(options);
    now += 2_001;
    await cache.inspect(options);
    expect(inspect).toHaveBeenCalledTimes(3);
  });

  it('re-evaluates completed evidence on explicit status refresh', async () => {
    const inspect = vi.fn(async () => result());
    const cache = new ProjectCompatibilityCache({ inspect, stat: async () => ({ mtimeMs: 1, size: 100 }) });
    await cache.inspect(options);
    await cache.inspect(options, { force: true });
    expect(inspect).toHaveBeenCalledTimes(2);
  });

  it('does not publish or recache stale evidence invalidated during evaluation', async () => {
    let release!: (value: ProjectCompatibilityResult) => void;
    const inspect = vi.fn(() => new Promise<ProjectCompatibilityResult>((resolve) => { release = resolve; }));
    const cache = new ProjectCompatibilityCache({ inspect, stat: async () => ({ mtimeMs: 1, size: 100 }) });
    const first = cache.inspect(options);
    await vi.waitFor(() => expect(inspect).toHaveBeenCalledTimes(1));
    cache.invalidate();
    release(result());
    expect((await first).status).toBe('unknown');
    const second = cache.inspect(options);
    await vi.waitFor(() => expect(inspect).toHaveBeenCalledTimes(2));
    release(result());
    expect((await second).status).toBe('compatible');
    expect(inspect).toHaveBeenCalledTimes(2);
  });

  it('does not cache old explicit DLL evidence under replacement metadata without a watcher invalidation', async () => {
    let mtimeMs = 1;
    const inspect = vi.fn(async () => {
      const oldEvidence = result();
      mtimeMs = 2; // The DLL is replaced after the inspector reads it, before the cache can stamp it.
      return oldEvidence;
    });
    const cache = new ProjectCompatibilityCache({ inspect, stat: async () => ({ mtimeMs, size: 100 }) });
    const selected = { ...options, assemblyPath: outputPath };
    const stale = await cache.inspect(selected);
    expect(stale.status).toBe('unknown');
    expect(stale.output).toBeUndefined();
    expect(stale.limitations.join(' ')).toContain('not cached');
    expect((await cache.inspect(selected)).status).toBe('compatible');
    await cache.inspect(selected);
    expect(inspect).toHaveBeenCalledTimes(2);
  });

  it('brackets PE reads for an output discovered by evaluation after inspection begins', async () => {
    let mtimeMs = 1;
    const readImage = vi.fn(async () => {
      if (mtimeMs === 1) {
        mtimeMs = 2; // The bytes just read belong to the old required32 image.
        return pe(0x14c, 3);
      }
      return pe(0x8664, 1);
    });
    const cache = new ProjectCompatibilityCache({
      evaluate: evaluate(), readImage,
      stat: async (filePath) => ({ mtimeMs: filePath === outputPath ? mtimeMs : 1, size: 100 }),
    });
    const stale = await cache.inspect(options); // No assemblyPath is available before evaluation.
    expect(stale.status).toBe('unknown');
    expect(stale.output).toBeUndefined();
    const fresh = await cache.inspect(options);
    expect(fresh.status).toBe('compatible');
    expect(fresh.output?.architecture).toBe('x64');
    await cache.inspect(options);
    expect(readImage).toHaveBeenCalledTimes(2);
  });

  it('keys evidence by route, selected configuration and trust', async () => {
    const inspect = vi.fn(async () => result());
    const cache = new ProjectCompatibilityCache({ inspect, stat: async () => ({ mtimeMs: 1, size: 100 }) });
    await cache.inspect(options);
    await cache.inspect({ ...options, runtime: 'net48' });
    await cache.inspect({ ...options, configuration: 'Release' });
    await cache.inspect({ ...options, trusted: false });
    expect(inspect).toHaveBeenCalledTimes(4);
  });

  it('bounds cached entries and reevaluates evicted projects', async () => {
    const inspect = vi.fn(async () => result());
    const cache = new ProjectCompatibilityCache({ inspect, stat: async () => ({ mtimeMs: 1, size: 100 }) });
    for (let i = 0; i < 34; i++) await cache.inspect({ ...options, projectPath: `${i}.csproj` });
    await cache.inspect({ ...options, projectPath: '0.csproj' });
    expect(inspect).toHaveBeenCalledTimes(35);
  });
});

describe('evaluated project configuration', () => {
  it('constructs argv-only property/item queries without invoking build, restore, or response files', () => {
    const args = projectEvaluationArguments({ ...options, configuration: 'Release', platform: 'Any CPU', targetFramework: 'net48' });
    expect(args[0]).toBe(projectPath);
    expect(args).toContain('-noAutoResponse');
    expect(args).toContain('-property:Platform=Any CPU');
    expect(args).toContain('-property:Configuration=Release');
    expect(args).toContain('-property:TargetFramework=net48');
    expect(args.some((a) => /^[-/](?:t:|target|restore|getTargetResult)/i.test(a))).toBe(false);
  });

  it.each(['Debug;Other=bad', 'Debug,Other=bad', '%3B', 'Debug\r\n-build'])('rejects MSBuild property injection: %s', (configuration) => {
    expect(() => projectEvaluationArguments({ ...options, configuration })).toThrow('Invalid Configuration');
  });

  it('normalizes evaluated classic properties and only known reference paths', () => {
    const parsed = parseProjectEvaluation(JSON.stringify({ Properties: {
      Configuration: 'Release', Platform: 'x86', PlatformTarget: 'x86', TargetFrameworkVersion: 'v4.8',
      Prefer32Bit: 'true', TargetPath: 'bin\\Release\\Legacy.exe', MSBuildAllProjects: 'Form.csproj;Directory.Build.props',
    }, Items: { Reference: [{ Identity: 'System' }, { HintPath: 'vendor\\Controls.dll' }], NativeReference: [{ Identity: 'native\\Bridge.dll' }] } }), projectPath);
    expect(parsed).toMatchObject({ configuration: 'Release', platform: 'x86', platformTarget: 'x86', targetFramework: 'net48', prefer32Bit: true });
    expect(parsed.knownDependencyPaths).toEqual([path.resolve('fixtures/vendor/Controls.dll'), path.resolve('fixtures/native/Bridge.dll')]);
    expect(parsed.importPaths).toContain(path.resolve('fixtures/Directory.Build.props'));
  });

  it('leaves absent or unrecognized project settings unknown', () => {
    const parsed = parseProjectEvaluation('{"Properties":{"Prefer32Bit":"$(Unresolved)","TargetFrameworks":"net48;net10.0-windows"}}', projectPath);
    expect(parsed.platformTarget).toBe('');
    expect(parsed.prefer32Bit).toBeNull();
    expect(parsed.targetFramework).toBe('');
    expect(parsed.targetFrameworks).toEqual(['net48', 'net10.0-windows']);
  });
});

describe('bounded trusted MSBuild evaluator', () => {
  afterEach(() => { vi.useRealTimers(); vi.mocked(spawn).mockReset(); });
  const payload = (properties: Record<string, string> = {}) => JSON.stringify({ Properties: {
    Configuration: 'Debug', Platform: 'AnyCPU', TargetFramework: 'net10.0-windows', PlatformTarget: 'AnyCPU', ...properties,
  } });
  const child = () => Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true) });
  function respond(...outputs: string[]): void {
    let invocation = 0;
    vi.mocked(spawn).mockImplementation(() => {
      const process = child();
      queueMicrotask(() => { process.stdout.write(outputs[Math.min(invocation++, outputs.length - 1)]); process.emit('close', 0); });
      return process as unknown as ReturnType<typeof spawn>;
    });
  }

  it('returns evaluated selected configuration via a hidden shell-free subprocess', async () => {
    respond(payload({ Configuration: 'Release', Platform: 'x64', PlatformTarget: 'x64' }));
    const result = await evaluateProjectArchitecture({ ...options, configuration: 'Release', platform: 'x64' });
    expect(result).toMatchObject({ ok: true, project: { configuration: 'Release', platformTarget: 'x64' } });
    expect(spawn).toHaveBeenCalledWith('dotnet', expect.arrayContaining(['msbuild', '-property:Configuration=Release']), expect.objectContaining({ shell: false, windowsHide: true }));
  });

  it('does not start MSBuild in an untrusted workspace', async () => {
    expect((await evaluateProjectArchitecture({ ...options, trusted: false })).ok).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('selects a unique runtime-compatible TFM through a second evaluated query', async () => {
    respond(payload({ TargetFramework: '', TargetFrameworks: 'net48;net10.0-windows' }), payload());
    expect((await evaluateProjectArchitecture(options)).ok).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(vi.mocked(spawn).mock.calls[1][1]).toContain('-property:TargetFramework=net10.0-windows');
  });

  it('keeps ambiguous modern target selection unknown', async () => {
    respond(payload({ TargetFramework: '', TargetFrameworks: 'net9.0-windows;net10.0-windows' }));
    expect(await evaluateProjectArchitecture(options)).toMatchObject({ ok: false, reason: expect.stringContaining('must be selected') });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('terminates an evaluator exceeding the shared timeout without waiting for process close', async () => {
    vi.useFakeTimers();
    const process = child();
    vi.mocked(spawn).mockReturnValue(process as unknown as ReturnType<typeof spawn>);
    const pending = evaluateProjectArchitecture(options);
    await vi.advanceTimersByTimeAsync(12_001);
    expect(await pending).toMatchObject({ ok: false, reason: expect.stringContaining('timed out') });
    expect(process.kill).toHaveBeenCalled();
  });

  it('bounds stderr and discards raw project output from diagnostics', async () => {
    const process = child();
    vi.mocked(spawn).mockReturnValue(process as unknown as ReturnType<typeof spawn>);
    const pending = evaluateProjectArchitecture(options);
    process.stderr.write(Buffer.alloc(1024 * 1024 + 1, 'x'));
    expect(await pending).toMatchObject({ ok: false, reason: 'MSBuild evaluation exceeded the output limit.' });
    expect(process.kill).toHaveBeenCalled();
  });
});

describe('project compatibility decisions', () => {
  it('does not evaluate or read even an explicit assembly in an untrusted workspace', async () => {
    const evaluator = evaluate();
    const readImage = vi.fn();
    const result = await inspectProjectCompatibility({ ...options, trusted: false, assemblyPath: outputPath }, { evaluate: evaluator, readImage });
    expect(result.code).toBe('WORKSPACE_TRUST_REQUIRED');
    expect(evaluator).not.toHaveBeenCalled();
    expect(readImage).not.toHaveBeenCalled();
  });

  it('does not guess conditional project properties when evaluation fails', async () => {
    const result = await inspectProjectCompatibility(options, { evaluate: async () => ({ ok: false, reason: 'No MSBuild.' }) });
    expect(result.status).toBe('unknown');
    expect(result.evaluated).toBeUndefined();
    expect(result.limitations).toContain('No MSBuild.');
  });

  it('reports definite evaluated x86 when output is not yet built', async () => {
    const result = await inspectProjectCompatibility(options, { evaluate: evaluate({ platformTarget: 'x86' }), readImage: async () => { throw new Error('ENOENT'); } });
    expect(result.code).toBe('PROJECT_ARCHITECTURE_MISMATCH');
    expect(result.status).toBe('incompatible');
  });

  it('does not invent an x86 requirement from the Platform label or Prefer32Bit alone', async () => {
    const result = await inspectProjectCompatibility(options, { evaluate: evaluate({ platform: 'x86', platformTarget: '', prefer32Bit: true, targetPath: '' }) });
    expect(result.status).toBe('unknown');
  });

  it('lets actual AnyCPU output outrank an edited x86 project setting', async () => {
    const result = await inspectProjectCompatibility(options, { evaluate: evaluate({ platformTarget: 'x86' }), readImage: async () => pe() });
    expect(result.status).toBe('compatible');
  });

  it.each(['modern', 'net48'] as const)('blocks actual required32 output on the %s branch', async (runtime) => {
    const result = await inspectProjectCompatibility({ ...options, runtime }, { evaluate: evaluate(), readImage: async () => pe(0x14c, 3) });
    expect(result.code).toBe('OUTPUT_ARCHITECTURE_MISMATCH');
  });

  it('treats a preferred32 EXE as loadable by an existing x64 process', async () => {
    const result = await inspectProjectCompatibility(options, { evaluate: evaluate({ prefer32Bit: true }), readImage: async () => pe(0x14c, 0x20003, false) });
    expect(result.status).toBe('compatible');
  });

  it('refuses a preferred32 DLL in the x64 process', async () => {
    const result = await inspectProjectCompatibility(options, { evaluate: evaluate(), readImage: async () => pe(0x14c, 0x20003, true) });
    expect(result.code).toBe('OUTPUT_ARCHITECTURE_MISMATCH');
  });

  it('uses the net48 x64 worker even when the current machine can run ARM64', async () => {
    const result = await inspectProjectCompatibility({ trusted: true, projectPath, runtime: 'net48' }, { evaluate: evaluate(), readImage: async () => pe(0xaa64) });
    expect(result.workerArchitecture).toBe('x64');
    expect(result.code).toBe('OUTPUT_ARCHITECTURE_MISMATCH');
  });

  it('compares modern ARM64 against actual x64 output', async () => {
    const result = await inspectProjectCompatibility({ ...options, workerArchitecture: 'arm64' }, { evaluate: evaluate(), readImage: async () => pe(0x8664) });
    expect(result.status).toBe('incompatible');
  });

  it('refuses a native apphost selected as the managed form assembly', async () => {
    const result = await inspectProjectCompatibility(options, { evaluate: evaluate(), readImage: async () => pe(0x8664, null) });
    expect(result.status).toBe('incompatible');
    expect(result.code).toBe('OUTPUT_NOT_MANAGED');
  });

  it('inspects an explicit assembly without applying a different project configuration to it', async () => {
    const result = await inspectProjectCompatibility({ ...options, assemblyPath: outputPath }, {
      evaluate: evaluate({ platformTarget: 'x86' }), readImage: async () => Buffer.alloc(0),
    });
    expect(result.status).toBe('unknown');
  });

  it('does not apply Debug reference architecture to an explicitly selected Release output', async () => {
    const otherOutput = path.resolve('Release/Form.dll');
    const dependency = path.resolve('Debug/Native.dll');
    const readImage = vi.fn(async (file) => file === dependency ? pe(0x14c, null) : pe());
    const result = await inspectProjectCompatibility({ ...options, assemblyPath: otherOutput }, {
      evaluate: evaluate({ knownDependencyPaths: [dependency] }), readImage,
    });
    expect(result.status).toBe('compatible');
    expect(result.nativeDependencies).toHaveLength(0);
    expect(result.limitations.join(' ')).toContain('differs from the evaluated TargetPath');
  });

  it('detects an actual known native x86 dependency of an AnyCPU output', async () => {
    const native = path.resolve('native/Control.dll');
    const result = await inspectProjectCompatibility({ ...options, nativeDependencyPaths: [native] }, {
      evaluate: evaluate(), readImage: async (file) => file === native ? pe(0x14c, null) : pe(),
    });
    expect(result.code).toBe('DEPENDENCY_ARCHITECTURE_MISMATCH');
    expect(result.nativeDependencies[0]).toMatchObject({ architecture: 'x86', managed: false });
  });

  it('keeps missing native dependencies unknown and never claims complete transitive availability', async () => {
    const result = await inspectProjectCompatibility({ ...options, nativeDependencyPaths: ['missing.dll'] }, {
      evaluate: evaluate(), readImage: async (file) => { if (file === 'missing.dll') throw new Error('ENOENT'); return pe(); },
    });
    expect(result.code).toBe('DEPENDENCY_ARCHITECTURE_UNKNOWN');
    expect(result.limitations.join(' ')).toContain('transitive');
  });

  it('bounds dependency count and per-image reads, with cache invalidation hints', async () => {
    const readImage = vi.fn(async () => pe());
    const imported = path.resolve('Directory.Build.props');
    const result = await inspectProjectCompatibility({ ...options, nativeDependencyPaths: Array.from({ length: 24 }, (_, i) => `${i}.dll`) }, {
      evaluate: evaluate({ importPaths: [imported] }), readImage,
    });
    expect(readImage).toHaveBeenCalledTimes(17);
    expect(readImage.mock.calls.every((call) => (call as unknown[])[1] === 1024 * 1024)).toBe(true);
    expect(result.nativeDependencies).toHaveLength(16);
    expect(result.status).toBe('unknown');
    expect(result.limitations.join(' ')).toContain('limited to 16');
    expect(result.observedPaths).toContain(imported);
  });

  it('does not read unsupported or secret file paths', async () => {
    const readImage = vi.fn(async () => pe());
    const result = await inspectProjectCompatibility({ trusted: true, runtime: 'modern', assemblyPath: 'secrets/Key.dll', nativeDependencyPaths: ['private.pem'] }, { readImage });
    expect(result.status).toBe('unknown');
    expect(readImage).not.toHaveBeenCalled();
    expect(result.observedPaths).not.toContain('secrets/Key.dll');
  });
});
