import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureDependencyGraphIdentity, settleBackgroundDigests } from './dependencyGraphIdentity';
import { engineWorkerKey } from './engineRequestContext';
import { workerKeyId } from './workerSelection';

const directories: string[] = [];
// Content and path assertions should not depend on unrelated build activity consuming the production deadline.
const clock = () => 0;
afterEach(() => { vi.restoreAllMocks(); for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wfd-dependency-content-')); directories.push(root);
  const project = path.join(root, 'FormApp.csproj'); const assembly = path.join(root, 'FormApp.dll');
  fs.writeFileSync(project, '<Project />'); fs.writeFileSync(assembly, 'AAAA');
  return { root, project, assembly };
}
describe('effective dependency graph content identity', () => {
  it('changes the actual worker key after same-length bytes replace a DLL with its timestamp restored', () => {
    const { project, assembly } = fixture();
    fs.utimesSync(assembly, new Date('2020-01-01'), new Date('2020-01-01'));
    const original = fs.statSync(assembly);
    const first = captureDependencyGraphIdentity([project, assembly], { clock });
    fs.writeFileSync(assembly, 'BBBB'); fs.utimesSync(assembly, original.atime, original.mtime);
    const second = captureDependencyGraphIdentity([project, assembly], { clock });
    expect(fs.statSync(assembly).size).toBe(original.size);
    expect(fs.statSync(assembly).mtimeMs).toBe(original.mtimeMs);
    expect(first.mode).toBe('content'); expect(second.mode).toBe('content');
    expect(second.fingerprint).not.toBe(first.fingerprint);
    const context = { sessionId: 'session', documentId: project, documentRevision: 1, renderGeneration: 1,
      sourceText: 'source', ownerProject: project };
    expect(workerKeyId(engineWorkerKey('modern', { ...context, dependencyFingerprint: first.fingerprint })))
      .not.toBe(workerKeyId(engineWorkerKey('modern', { ...context, dependencyFingerprint: second.fingerprint })));
  });
  it('is deterministic across resolver order, duplicate paths and timestamp-only changes', () => {
    const { project, assembly } = fixture();
    const first = captureDependencyGraphIdentity([project, assembly], { clock });
    fs.utimesSync(assembly, new Date(), new Date('2020-01-01'));
    const second = captureDependencyGraphIdentity([assembly, project, assembly], { clock });
    expect(second.mode).toBe('content'); expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.files).toBe(2); expect(second.bytes).toBe(15);
  });
  it.each([
    ['maxFiles', 1, 'FILE_LIMIT'], ['maxFileBytes', 3, 'FILE_BYTES_LIMIT'],
    ['maxTotalBytes', 12, 'TOTAL_BYTES_LIMIT'], ['maxElapsedMs', 0, 'TIME_LIMIT'],
  ] as const)('isolates a graph exceeding %s without authorizing reuse', (limit, value, reason) => {
    const { project, assembly } = fixture();
    const first = captureDependencyGraphIdentity([project, assembly], { clock, [limit]: value });
    const second = captureDependencyGraphIdentity([project, assembly], { clock, [limit]: value });
    expect(first).toMatchObject({ mode: 'opaque', reason }); expect(second.fingerprint).not.toBe(first.fingerprint);
  });
  it('isolates a graph when its default deadline expires during a file read', () => {
    const { assembly } = fixture();
    const read = fs.readSync;
    let elapsed = 0;
    vi.spyOn(fs, 'readSync').mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
      const count = read(...args);
      elapsed = 100;
      return count;
    }) as typeof fs.readSync);
    expect(captureDependencyGraphIdentity([assembly], { clock: () => elapsed }))
      .toMatchObject({ mode: 'opaque', reason: 'TIME_LIMIT', files: 0 });
  });
  it('does not read secret, unsupported, relative, missing or linked dependency content', () => {
    const { root, assembly } = fixture();
    const actual = path.join(root, 'actual'); fs.mkdirSync(actual); fs.writeFileSync(path.join(actual, 'linked.dll'), 'private');
    const linked = path.join(root, 'linked'); fs.symlinkSync(actual, linked, process.platform === 'win32' ? 'junction' : 'dir');
    const read = vi.spyOn(fs, 'readSync');
    for (const [file, reason] of [
      [path.join(root, '.env'), 'SECRET_PATH'], [path.join(root, 'cert.key'), 'SECRET_PATH'],
      [path.join(root, 'secrets', 'private.dll'), 'SECRET_PATH'], [path.join(root, 'note.txt'), 'UNSUPPORTED_FILE'],
      ['relative.dll', 'INVALID_PATH'], [path.join(root, 'missing.dll'), 'UNREADABLE'],
      [path.join(linked, 'linked.dll'), 'LINK_PATH'],
    ]) expect(captureDependencyGraphIdentity([file], { clock })).toMatchObject({ mode: 'opaque', reason, bytes: 0 });
    expect(read).not.toHaveBeenCalled();
    expect(captureDependencyGraphIdentity([assembly], { clock }).mode).toBe('content');
  });
  it('reuses a digest only while the file snapshot it was read under is unchanged', () => {
    const { project, assembly } = fixture();
    fs.utimesSync(assembly, new Date('2020-01-01'), new Date('2020-01-01'));
    const original = fs.statSync(assembly);
    const later = () => Date.now() + 60_000; // the files are no longer just written
    const first = captureDependencyGraphIdentity([project, assembly], { clock, wallClock: later });
    const read = vi.spyOn(fs, 'readSync');
    const second = captureDependencyGraphIdentity([project, assembly], { clock, wallClock: later });
    expect(read).not.toHaveBeenCalled();
    expect(second).toMatchObject({ mode: 'content', fingerprint: first.fingerprint, files: 2, bytes: 15 });
    // same length, write time put back: the change time still moves, so the bytes are read again
    fs.writeFileSync(assembly, 'BBBB'); fs.utimesSync(assembly, original.atime, original.mtime);
    const third = captureDependencyGraphIdentity([project, assembly], { clock, wallClock: later });
    expect(read).toHaveBeenCalled();
    expect(third.mode).toBe('content'); expect(third.fingerprint).not.toBe(first.fingerprint);
  });
  it('reads a just-written file again on every capture', () => {
    const { project, assembly } = fixture();
    captureDependencyGraphIdentity([project, assembly], { clock });
    const read = vi.spyOn(fs, 'readSync');
    captureDependencyGraphIdentity([project, assembly], { clock });
    expect(read).toHaveBeenCalled();
  });
  it('digests a file over the request budget in the background, then authorizes reuse', async () => {
    const { project, assembly } = fixture();
    const later = () => Date.now() + 60_000;
    const options = { clock, wallClock: later, maxFileBytes: 3 };
    expect(captureDependencyGraphIdentity([project, assembly], options)).toMatchObject({ mode: 'opaque', reason: 'FILE_BYTES_LIMIT' });
    await settleBackgroundDigests();
    const settled = captureDependencyGraphIdentity([project, assembly], options);
    expect(settled).toMatchObject({ mode: 'content', files: 2 });
    expect(captureDependencyGraphIdentity([project, assembly], options).fingerprint).toBe(settled.fingerprint);
    // and it is the identity the bytes give, with no budget in the way
    expect(settled.fingerprint).toBe(captureDependencyGraphIdentity([project, assembly], { clock, wallClock: later }).fingerprint);
  });
  it('reads a kept digest again in the background once it is old, and keeps using it meanwhile', async () => {
    const { project, assembly } = fixture();
    let monotonic = 1_000;
    const options = { clock: () => monotonic, wallClock: () => Date.now() + 60_000 };
    const first = captureDependencyGraphIdentity([project, assembly], options);
    const opened = vi.spyOn(fs.promises, 'open');
    monotonic += 10_000;
    expect(captureDependencyGraphIdentity([project, assembly], options).fingerprint).toBe(first.fingerprint);
    await settleBackgroundDigests();
    expect(opened).not.toHaveBeenCalled();
    monotonic += 30_000;
    expect(captureDependencyGraphIdentity([project, assembly], options).fingerprint).toBe(first.fingerprint);
    await settleBackgroundDigests();
    expect(opened).toHaveBeenCalledTimes(2);
    // a wall clock set back an hour does not make a digest young again: its age is measured on the monotonic clock
    opened.mockClear();
    monotonic += 31_000;
    captureDependencyGraphIdentity([project, assembly], { ...options, wallClock: () => Date.now() - 3_600_000 });
    await settleBackgroundDigests();
    expect(opened).toHaveBeenCalledTimes(2);
  });
  it('drops a kept digest whose re-reading fails, so the next capture reads the file itself', async () => {
    const { project, assembly } = fixture();
    let monotonic = 1_000;
    const options = { clock: () => monotonic, wallClock: () => Date.now() + 60_000 };
    const first = captureDependencyGraphIdentity([project, assembly], options);
    monotonic += 31_000;
    const busy = Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
    vi.spyOn(fs.promises, 'open').mockRejectedValue(busy);
    captureDependencyGraphIdentity([project, assembly], options);
    await settleBackgroundDigests();
    const read = vi.spyOn(fs, 'readSync');
    const next = captureDependencyGraphIdentity([project, assembly], options);
    expect(read).toHaveBeenCalled();
    expect(next).toMatchObject({ mode: 'content', fingerprint: first.fingerprint });
  });
  it('keeps a newer digest a capture kept while an older re-reading of the file was still failing', async () => {
    const { project, assembly } = fixture();
    let monotonic = 1_000;
    const options = { clock: () => monotonic, wallClock: () => Date.now() + 60_000 };
    captureDependencyGraphIdentity([project, assembly], options);
    let fail: (error: Error) => void = () => undefined;
    let dllOpening: () => void = () => undefined;
    const dllOpened = new Promise<void>((resolve) => { dllOpening = resolve; });
    const realOpen = fs.promises.open;
    vi.spyOn(fs.promises, 'open').mockImplementation(((...args: Parameters<typeof fs.promises.open>) =>
      path.basename(String(args[0])) === 'FormApp.dll'
        ? new Promise((_, reject) => { fail = reject; dllOpening(); })
        : realOpen(...args)) as typeof fs.promises.open);
    monotonic += 31_000;
    captureDependencyGraphIdentity([project, assembly], options); // the old digests go to be read again
    await dllOpened; // the DLL's re-reading has begun and is held open
    fs.writeFileSync(assembly, 'CCCCCC'); // a new build: the next capture reads and keeps it
    const rebuilt = captureDependencyGraphIdentity([project, assembly], options);
    fail(Object.assign(new Error('EBUSY'), { code: 'EBUSY' }));
    await settleBackgroundDigests();
    const read = vi.spyOn(fs, 'readSync');
    expect(captureDependencyGraphIdentity([project, assembly], options)).toMatchObject({ mode: 'content', fingerprint: rebuilt.fingerprint });
    expect(read).not.toHaveBeenCalled();
  });
  it('lets a slow but completed background reading authorize reuse', async () => {
    const { project, assembly } = fixture();
    let monotonic = 1_000;
    const options = { clock: () => monotonic, wallClock: () => Date.now() + 60_000, maxFileBytes: 3 };
    const realOpen = fs.promises.open;
    vi.spyOn(fs.promises, 'open').mockImplementation((async (...args: Parameters<typeof fs.promises.open>) => {
      const handle = await realOpen(...args);
      const read = handle.read.bind(handle);
      // every read of these bytes takes longer than the oldest a kept digest may be
      return Object.assign(handle, { read: async (...readArgs: Parameters<typeof handle.read>) => { monotonic += 120_001; return read(...readArgs); } });
    }) as typeof fs.promises.open);
    expect(captureDependencyGraphIdentity([project, assembly], options)).toMatchObject({ mode: 'opaque', reason: 'FILE_BYTES_LIMIT' });
    await settleBackgroundDigests();
    expect(captureDependencyGraphIdentity([project, assembly], options).mode).toBe('content');
  });
  it.skipIf(process.platform !== 'win32')('notices a write through a mapped view, which moves no file time', async () => {
    const { project, assembly } = fixture();
    fs.writeFileSync(assembly, Buffer.alloc(4096, 1));
    let monotonic = 1_000;
    const options = { clock: () => monotonic, wallClock: () => Date.now() + 60_000 };
    const first = captureDependencyGraphIdentity([project, assembly], options);
    const before = fs.lstatSync(assembly);
    const script = `$m=[IO.MemoryMappedFiles.MemoryMappedFile]::CreateFromFile('${assembly.replace(/'/g, "''")}',`
      + `[IO.FileMode]::Open,'wfd-test-'+[guid]::NewGuid(),0,[IO.MemoryMappedFiles.MemoryMappedFileAccess]::ReadWrite);`
      + '$v=$m.CreateViewAccessor();$v.Write(100,[byte]7);$v.Dispose();$m.Dispose()';
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
    const after = fs.lstatSync(assembly);
    expect(fs.readFileSync(assembly)[100]).toBe(7);
    // the snapshot cannot tell: every time and the size are as they were
    expect([after.size, after.mtimeMs, after.ctimeMs, after.birthtimeMs]).toEqual([before.size, before.mtimeMs, before.ctimeMs, before.birthtimeMs]);
    expect(captureDependencyGraphIdentity([project, assembly], options).fingerprint).toBe(first.fingerprint);
    // the bytes are read again once the digest is old, and the identity follows them
    monotonic += 31_000;
    captureDependencyGraphIdentity([project, assembly], options);
    await settleBackgroundDigests();
    const settled = captureDependencyGraphIdentity([project, assembly], options);
    expect(settled.mode).toBe('content'); expect(settled.fingerprint).not.toBe(first.fingerprint);
  }, 30_000);
  it('isolates a graph whose file is replaced while a content snapshot is read', () => {
    const { assembly } = fixture();
    const read = fs.readSync;
    let replaced = false;
    vi.spyOn(fs, 'readSync').mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
      const count = read(...args);
      if (!replaced) { replaced = true; fs.writeFileSync(assembly, 'changed'); }
      return count;
    }) as typeof fs.readSync);
    expect(captureDependencyGraphIdentity([assembly], { clock })).toMatchObject({ mode: 'opaque', reason: 'CHANGED_DURING_READ' });
  });
});
