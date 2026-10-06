import fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureDependencyGraphIdentity } from './dependencyGraphIdentity';
import { engineWorkerKey } from './engineRequestContext';
import { workerKeyId } from './workerSelection';

const directories: string[] = [];
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
    const first = captureDependencyGraphIdentity([project, assembly]);
    fs.writeFileSync(assembly, 'BBBB'); fs.utimesSync(assembly, original.atime, original.mtime);
    const second = captureDependencyGraphIdentity([project, assembly]);
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
    const first = captureDependencyGraphIdentity([project, assembly]);
    fs.utimesSync(assembly, new Date(), new Date('2020-01-01'));
    const second = captureDependencyGraphIdentity([assembly, project, assembly]);
    expect(second.mode).toBe('content'); expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.files).toBe(2); expect(second.bytes).toBe(15);
  });
  it.each([
    ['maxFiles', 1, 'FILE_LIMIT'], ['maxFileBytes', 3, 'FILE_BYTES_LIMIT'],
    ['maxTotalBytes', 12, 'TOTAL_BYTES_LIMIT'], ['maxElapsedMs', 0, 'TIME_LIMIT'],
  ] as const)('isolates a graph exceeding %s without authorizing reuse', (limit, value, reason) => {
    const { project, assembly } = fixture();
    const first = captureDependencyGraphIdentity([project, assembly], { [limit]: value });
    const second = captureDependencyGraphIdentity([project, assembly], { [limit]: value });
    expect(first).toMatchObject({ mode: 'opaque', reason }); expect(second.fingerprint).not.toBe(first.fingerprint);
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
    ]) expect(captureDependencyGraphIdentity([file])).toMatchObject({ mode: 'opaque', reason, bytes: 0 });
    expect(read).not.toHaveBeenCalled();
    expect(captureDependencyGraphIdentity([assembly]).mode).toBe('content');
  });
  it('isolates a graph whose file is replaced while a content snapshot is read', () => {
    const { assembly } = fixture();
    const read = fs.readSync;
    let replaced = false;
    vi.spyOn(fs, 'readSync').mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
      const count = read(...args);
      if (!replaced) { replaced = true; fs.writeFileSync(assembly, 'changed'); }
      return count;
    }) as typeof fs.readSync);
    expect(captureDependencyGraphIdentity([assembly])).toMatchObject({ mode: 'opaque', reason: 'CHANGED_DURING_READ' });
  });
});
