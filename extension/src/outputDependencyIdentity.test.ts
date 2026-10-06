import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { selectedOutputDependencyFiles } from './outputDependencyIdentity';
import { captureDependencyGraphIdentity } from './dependencyGraphIdentity';

const roots: string[] = [];
const fixturePrefix = path.join(os.tmpdir(), 'wfd-output-graph-');
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (!path.resolve(root).startsWith(path.resolve(fixturePrefix))) throw new Error('Invalid test cleanup target');
    fs.rmSync(root, { recursive: true, force: true });
  }
});
function fixture() {
  const root = fs.mkdtempSync(fixturePrefix); roots.push(root);
  const assembly = path.join(root, 'Form.dll'); fs.writeFileSync(assembly, 'form');
  return { root, assembly };
}

describe('selected output private dependency graph', () => {
  it('captures copied project references, native/culture DLLs and runtime sidecars', () => {
    const { root, assembly } = fixture();
    const files = ['ReferencedProject.dll', 'Form.deps.json', 'Form.runtimeconfig.json', 'Form.dll.config', 'fr/ReferencedProject.resources.dll', 'runtimes/win-x64/native/Native.dll'];
    for (const file of files) {
      const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, file);
    }
    fs.writeFileSync(path.join(root, 'unrelated.pdb'), 'symbols');
    const captured = selectedOutputDependencyFiles(assembly);
    expect(captured.complete).toBe(true);
    expect(captured.files).toEqual(expect.arrayContaining([assembly, ...files.map((file) => path.join(root, file))]));
    expect(captured.files).toHaveLength(files.length + 1);
    expect(captureDependencyGraphIdentity(captured.files).mode).toBe('content');
  });

  it('changes graph identity after a copied project reference is replaced at the same path', () => {
    const { root, assembly } = fixture(); const dependency = path.join(root, 'ReferencedProject.dll');
    fs.writeFileSync(dependency, 'AAAA');
    const before = captureDependencyGraphIdentity(selectedOutputDependencyFiles(assembly).files);
    const timestamp = fs.statSync(dependency); fs.writeFileSync(dependency, 'BBBB'); fs.utimesSync(dependency, timestamp.atime, timestamp.mtime);
    const after = captureDependencyGraphIdentity(selectedOutputDependencyFiles(assembly).files);
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });

  it('refuses linked or secret directories without enumerating them', () => {
    const { root, assembly } = fixture(); const external = path.join(root, 'external'); fs.mkdirSync(external);
    const linked = path.join(root, 'linked'); fs.symlinkSync(external, linked, process.platform === 'win32' ? 'junction' : 'dir');
    expect(selectedOutputDependencyFiles(assembly)).toMatchObject({ complete: false, reason: 'OUTPUT_DEPENDENCY_LINK' });
    fs.mkdirSync(path.join(external, 'nested'));
    expect(selectedOutputDependencyFiles(path.join(linked, 'nested', 'Form.dll'))).toMatchObject({ complete: false, reason: 'OUTPUT_DEPENDENCY_LINK' });
    fs.unlinkSync(linked);
    fs.mkdirSync(path.join(root, 'secrets'));
    expect(selectedOutputDependencyFiles(assembly)).toMatchObject({ complete: false, reason: 'OUTPUT_DEPENDENCY_SECRET_PATH' });
  });

  it('marks over-budget and unavailable scans incomplete rather than attesting partial graphs', () => {
    const { root, assembly } = fixture();
    for (let i = 0; i < 257; i++) fs.writeFileSync(path.join(root, `dependency${i}.dll`), 'dll');
    expect(selectedOutputDependencyFiles(assembly)).toMatchObject({ complete: false, reason: 'OUTPUT_DEPENDENCY_FILE_BUDGET' });
    expect(selectedOutputDependencyFiles(path.join(root, 'missing', 'Form.dll'))).toMatchObject({ complete: false, reason: 'OUTPUT_DEPENDENCY_UNAVAILABLE' });
  });
});
