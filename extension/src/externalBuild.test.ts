import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExternalBuildRelease, intermediateDirCandidates, isAssemblyWrite } from './externalBuild';

describe('isAssemblyWrite', () => {
  it('reacts to a written assembly — the file a build is about to copy over the pinned output', () => {
    expect(isAssemblyWrite('App.exe')).toBe(true);
    expect(isAssemblyWrite('Vendor.Controls.dll')).toBe(true);
    expect(isAssemblyWrite(path.join('Debug', 'net48', 'App.EXE'))).toBe(true);
    expect(isAssemblyWrite(Buffer.from('App.dll'))).toBe(true);
  });

  it('ignores the churn a design-time build makes, so previews are not unloaded for nothing', () => {
    expect(isAssemblyWrite('App.csproj.CoreCompileInputs.cache')).toBe(false);
    expect(isAssemblyWrite('App.AssemblyInfo.cs')).toBe(false);
    expect(isAssemblyWrite('App.pdb')).toBe(false);
    expect(isAssemblyWrite('App.exe.config')).toBe(false);
  });

  // Only the INTERMEDIATE (obj) watch is filtered through this: fs.watch does not guarantee a filename, and in a
  // tree the compiler rewrites constantly an unnamed event is not evidence of a build. Events in the pinned OUTPUT
  // directory bypass this filter in extension.ts precisely so an unnamed one is never dropped there.
  it('ignores an unnamed event rather than treating any obj-tree activity as a build', () => {
    expect(isAssemblyWrite(null)).toBe(false);
    expect(isAssemblyWrite(undefined)).toBe(false);
    expect(isAssemblyWrite('')).toBe(false);
  });
});

describe('intermediateDirCandidates', () => {
  it('derives the obj directory for an SDK-style output', () => {
    const proj = path.join('C:', 'src', 'App');
    expect(intermediateDirCandidates(path.join(proj, 'bin', 'Debug', 'net48')))
      .toContain(path.join(proj, 'obj'));
  });

  it('derives the obj directory for a classic <proj>\\bin\\<Config> output', () => {
    const proj = path.join('C:', 'src', 'Legacy');
    expect(intermediateDirCandidates(path.join(proj, 'bin', 'Debug')))
      .toContain(path.join(proj, 'obj'));
  });

  it('does not guess for an output that is not under a bin directory', () => {
    expect(intermediateDirCandidates(path.join('C:', 'drops', 'nightly', 'x64'))).toEqual([]);
  });

  it('never returns duplicates (both depths can name the same directory)', () => {
    for (const dir of [
      path.join('C:', 'src', 'App', 'bin', 'Debug'),
      path.join('C:', 'src', 'App', 'bin', 'Debug', 'net48'),
      path.join('C:', 'src', 'App', 'bin'),
    ]) {
      const candidates = intermediateDirCandidates(dir);
      expect(new Set(candidates).size).toBe(candidates.length);
    }
  });
});

describe('ExternalBuildRelease', () => {
  const OUTPUT = path.join('C:', 'src', 'App', 'bin', 'Debug', 'net48', 'App.exe');
  let stamps: Map<string, number>;
  let log: string[];
  let releaseGate: (() => void) | undefined;

  function make(overrides: { maxWaits?: number; settleMs?: number; outputs?: () => string[] } = {}) {
    return new ExternalBuildRelease({
      outputsInUse: overrides.outputs ?? (() => [OUTPUT]),
      stamp: (file) => stamps.get(file) ?? -1,
      begin: () => log.push('begin'),
      release: () => {
        log.push('release');
        return new Promise<void>((resolve) => {
          releaseGate = () => { log.push('released'); resolve(); };
        });
      },
      end: async () => { log.push('end'); },
      settleMs: overrides.settleMs ?? 3000,
      maxWaits: overrides.maxWaits ?? 9,
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    stamps = new Map([[OUTPUT, 100]]);
    log = [];
    releaseGate = undefined;
  });
  afterEach(() => vi.useRealTimers());

  it('releases on the first write and does not release again for the same build', () => {
    const build = make();
    build.onWrite('intermediate');
    build.onWrite('intermediate');
    build.onWrite('intermediate');
    expect(log).toEqual(['begin', 'release']);
    expect(build.active).toBe(true);
  });

  it('does nothing when no designer pins an output', () => {
    const build = make({ outputs: () => [] });
    build.onWrite('intermediate');
    expect(log).toEqual([]);
    expect(build.active).toBe(false);
  });

  it('puts the previews back only AFTER the release has completed', async () => {
    const build = make();
    build.onWrite('intermediate');
    stamps.set(OUTPUT, 200); // the build replaced the output

    await vi.advanceTimersByTimeAsync(3000);
    expect(log).toEqual(['begin', 'release']); // release still in flight → no re-render may start yet

    releaseGate!();
    await vi.advanceTimersByTimeAsync(0);
    expect(log).toEqual(['begin', 'release', 'released', 'end']);
    expect(build.active).toBe(false);
  });

  it('keeps the handles off through the gap between compile and copy', async () => {
    const build = make();
    build.onWrite('intermediate'); // compiled, but nothing copied over the output yet
    releaseGate!();

    await vi.advanceTimersByTimeAsync(3000 * 3);
    expect(log).toContain('release');
    expect(log).not.toContain('end'); // still waiting for the copy — re-pinning now would break it
    expect(build.active).toBe(true);

    build.onWrite('output'); // the copy reached the output directory
    await vi.advanceTimersByTimeAsync(3000);
    expect(log[log.length - 1]).toBe('end');
  });

  it('gives up waiting after a bounded number of quiet periods (a build of another config/TFM)', async () => {
    const build = make({ maxWaits: 2 });
    build.onWrite('intermediate');
    releaseGate!();

    await vi.advanceTimersByTimeAsync(3000 * 2); // initial settle + 1 wait
    expect(log).not.toContain('end');
    await vi.advanceTimersByTimeAsync(3000 * 2); // remaining waits elapse → forced end
    expect(log[log.length - 1]).toBe('end');
    expect(build.active).toBe(false);
  });

  it('extends the quiet period while the build keeps writing', async () => {
    const build = make();
    build.onWrite('output');
    releaseGate!();
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(2000);
      expect(log).not.toContain('end');
      build.onWrite('output');
    }
    await vi.advanceTimersByTimeAsync(3000);
    expect(log[log.length - 1]).toBe('end');
  });

  it('starts a fresh release for a build that arrives after the previous one finished', async () => {
    const build = make();
    build.onWrite('output');
    releaseGate!();
    await vi.advanceTimersByTimeAsync(3000);
    expect(log).toEqual(['begin', 'release', 'released', 'end']);

    build.onWrite('output');
    expect(log.slice(-2)).toEqual(['begin', 'release']);
  });

  it('dispose drops a pending wait without putting the previews back', async () => {
    const build = make();
    build.onWrite('output');
    releaseGate!();
    build.dispose();
    await vi.advanceTimersByTimeAsync(3000 * 20);
    expect(log).not.toContain('end');
  });
});
