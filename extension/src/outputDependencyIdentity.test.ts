import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { selectedOutputDependencyFiles } from './outputDependencyIdentity';
import { captureDependencyGraphIdentity } from './dependencyGraphIdentity';

const roots: string[] = [];
const fixturePrefix = path.join(os.tmpdir(), 'wfd-output-graph-');
const clock = () => 0;
// Enumeration and content assertions use fixed clocks; the scan deadline has its own advancing-clock case.
beforeEach(() => { vi.spyOn(Date, 'now').mockImplementation(clock); });
afterEach(() => {
  vi.restoreAllMocks();
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
    expect(captureDependencyGraphIdentity(captured.files, { clock }).mode).toBe('content');
  });

  it('walks only what the runtime loads, so a log folder or a publish copy cannot make the graph opaque', () => {
    const { root, assembly } = fixture();
    const loaded = ['ReferencedProject.dll', 'de/Form.resources.dll', 'runtimes/win/lib/net9.0/System.IO.Ports.dll'];
    const ignored = ['publish/Form.dll', 'publish/_Release/Form.dll', 'de/Other.dll', 'de/deeper/Form.resources.dll'];
    for (const file of [...loaded, ...ignored]) {
      const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, file);
    }
    fs.mkdirSync(path.join(root, 'Log'));
    for (let i = 0; i < 600; i++) fs.writeFileSync(path.join(root, 'Log', `run${i}.config`), 'log');
    const captured = selectedOutputDependencyFiles(assembly);
    expect(captured.complete).toBe(true);
    expect([...captured.files].sort()).toEqual([assembly, ...loaded.map((file) => path.join(root, file))].sort());
  });

  it('reads a culture folder by name only, so a large one cannot spend the entry budget', () => {
    const { root, assembly } = fixture();
    fs.mkdirSync(path.join(root, 'Log'));
    for (let i = 0; i < 2000; i++) fs.writeFileSync(path.join(root, 'Log', `run${i}.log`), 'log');
    fs.writeFileSync(path.join(root, 'Log', 'Form.resources.dll'), 'satellite');
    const captured = selectedOutputDependencyFiles(assembly);
    expect(captured.complete).toBe(true);
    expect([...captured.files].sort()).toEqual([assembly, path.join(root, 'Log', 'Form.resources.dll')].sort());
  });

  it("follows .NET Framework's probing: <name>/<name>.dll and the config's privatePath folders", () => {
    const { root, assembly } = fixture();
    fs.writeFileSync(path.join(root, 'Form.dll.config'), `<?xml version="1.0"?>
<configuration><runtime><assemblyBinding xmlns="urn:schemas-microsoft-com:asm.v1">
  <!-- <probing privatePath="commented"/> -->
  <probing privatePath="lib; plugins\\vendor ;..\\outside;C:\\elsewhere;missing" />
</assemblyBinding></runtime></configuration>`);
    const loaded = ['Helper/Helper.dll', 'lib/Dependency.dll', 'lib/Nested/Nested.dll', 'lib/de/Dependency.resources.dll',
      'plugins/vendor/Vendor.Grid.dll', 'de/Vendor.Grid.resources.dll'];
    const ignored = ['Helper/Other.dll', 'commented/Hidden.dll', 'lib/Nested/Other.dll', 'plugins/Top.dll', 'de/Unknown.resources.dll'];
    for (const file of [...loaded, ...ignored]) {
      const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, file);
    }
    const outside = path.join(path.dirname(root), path.basename(root) + '-outside');
    const captured = selectedOutputDependencyFiles(assembly);
    expect(captured.complete).toBe(true);
    expect([...captured.files].sort()).toEqual([assembly, path.join(root, 'Form.dll.config'),
      ...loaded.map((file) => path.join(root, file))].sort());
    expect(captured.files.some((file) => file.startsWith(outside))).toBe(false);
  });

  it("reads every satellite .NET Framework probes, for assemblies found in any of its places", () => {
    const { root, assembly } = fixture();
    const loaded = ['Helper/Helper.dll', 'de/Helper.resources.dll', 'de/Form.resources/Form.resources.dll',
      'fr-CA/Helper.resources/Helper.resources.dll'];
    const ignored = ['de/Other.resources/Other.resources.dll', 'de/Form.resources/Other.dll'];
    for (const file of [...loaded, ...ignored]) {
      const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, file);
    }
    const captured = selectedOutputDependencyFiles(assembly);
    expect(captured.complete).toBe(true);
    expect([...captured.files].sort()).toEqual([assembly, ...loaded.map((file) => path.join(root, file))].sort());
  });

  it("decodes the config as XML and reads the files its codeBase elements name", () => {
    const { root, assembly } = fixture();
    const elsewhere = fs.mkdtempSync(fixturePrefix); roots.push(elsewhere);
    const shared = path.join(elsewhere, 'Shared.dll'); fs.writeFileSync(shared, 'shared');
    fs.writeFileSync(path.join(root, 'Form.dll.config'), `<configuration><runtime>
  <asm:assemblyBinding xmlns:asm="urn:schemas-microsoft-com:asm.v1">
    <asm:probing privatePath="lib&amp;tools;ext&#x2F;deep"/>
    <asm:dependentAssembly><asm:codeBase version="1.0.0.0" href="plugins/Plugin%20One.dll"/></asm:dependentAssembly>
    <asm:dependentAssembly><asm:codeBase version="2.0.0.0" href="${new URL('file:///' + shared.replace(/\\/g, '/')).href}"/></asm:dependentAssembly>
    <asm:dependentAssembly><asm:codeBase version="3.0.0.0" href="plugins/Missing.dll"/></asm:dependentAssembly>
  </asm:assemblyBinding></runtime></configuration>`);
    const loaded = ['lib&tools/Tool.dll', 'ext/deep/Deep.dll', 'plugins/Plugin One.dll', 'de/Plugin One.resources.dll'];
    for (const file of loaded) {
      const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, file);
    }
    fs.writeFileSync(path.join(root, 'plugins', 'Unnamed.dll'), 'not named by the config');
    const captured = selectedOutputDependencyFiles(assembly);
    expect(captured.complete).toBe(true);
    expect([...captured.files].sort()).toEqual([assembly, path.join(root, 'Form.dll.config'), shared,
      ...loaded.map((file) => path.join(root, file))].sort());
  });

  it('reads a UTF-16 config, a code base named as written, and the satellites of the identity a code base binds', () => {
    const { root, assembly } = fixture();
    const xml = `<?xml version="1.0" encoding="utf-16"?><configuration><runtime>
  <assemblyBinding xmlns="urn:schemas-microsoft-com:asm.v1"><probing privatePath="lib"/>
    <dependentAssembly><assemblyIdentity name="Helper" publicKeyToken="0123456789abcdef"/>
      <codeBase version="1.0.0.0" href="plugins/Renamed.dll"/></dependentAssembly>
    <dependentAssembly><assemblyIdentity name="Literal"/><codeBase version="1.0.0.0" href="plugins/Literal%20Name.dll"/></dependentAssembly>
  </assemblyBinding></runtime></configuration>`;
    fs.writeFileSync(path.join(root, 'Form.dll.config'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]));
    const loaded = ['lib/Dependency.dll', 'plugins/Renamed.dll', 'de/Helper.resources.dll', 'plugins/Literal%20Name.dll',
      'de/Literal.resources.dll'];
    for (const file of loaded) {
      const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, file);
    }
    const captured = selectedOutputDependencyFiles(assembly);
    expect(captured.complete).toBe(true);
    expect([...captured.files].sort()).toEqual([assembly, path.join(root, 'Form.dll.config'),
      ...loaded.map((file) => path.join(root, file))].sort());
  });

  it('decodes a config by the encoding its declaration names, however long the declaration', () => {
    const { root, assembly } = fixture();
    const xml = `<?xml version="1.0"${' '.repeat(300)}encoding="windows-1252"?><configuration><runtime>`
      + '<probing privatePath="café"/></runtime></configuration>';
    fs.writeFileSync(path.join(root, 'Form.dll.config'), Buffer.from(xml, 'latin1'));
    fs.mkdirSync(path.join(root, 'café')); fs.writeFileSync(path.join(root, 'café', 'Dependency.dll'), 'dll');
    const captured = selectedOutputDependencyFiles(assembly);
    expect(captured.complete).toBe(true);
    expect(captured.files).toContain(path.join(root, 'café', 'Dependency.dll'));
  });

  it('cannot vouch for a config in an encoding it cannot decode', () => {
    const { root, assembly } = fixture();
    fs.writeFileSync(path.join(root, 'Form.dll.config'), '<?xml version="1.0" encoding="x-unknown-encoding"?><configuration/>');
    expect(selectedOutputDependencyFiles(assembly)).toMatchObject({ complete: false, reason: 'OUTPUT_DEPENDENCY_CONFIG_ENCODING' });
  });

  it('cannot vouch for a code base that is not a file', () => {
    const { root, assembly } = fixture();
    fs.writeFileSync(path.join(root, 'Form.dll.config'),
      '<configuration><runtime><codeBase version="1.0.0.0" href="https://example.invalid/Remote.dll"/></runtime></configuration>');
    expect(selectedOutputDependencyFiles(assembly)).toMatchObject({ complete: false, reason: 'OUTPUT_DEPENDENCY_CODEBASE' });
  });

  it('takes the one host .exe.config of a library output, and refuses a linked privatePath folder', () => {
    const { root, assembly } = fixture();
    fs.writeFileSync(path.join(root, 'App.exe'), 'app');
    fs.writeFileSync(path.join(root, 'App.exe.config'), '<configuration><runtime><probing privatePath=\'lib\'/></runtime></configuration>');
    fs.mkdirSync(path.join(root, 'lib')); fs.writeFileSync(path.join(root, 'lib', 'Dependency.dll'), 'dll');
    expect(selectedOutputDependencyFiles(assembly).files).toContain(path.join(root, 'lib', 'Dependency.dll'));
    // a privatePath folder reached through a link: the output's own listing sees only the real 'plugins' folder
    fs.writeFileSync(path.join(root, 'App.exe.config'), '<configuration><runtime><probing privatePath="plugins\\inner"/></runtime></configuration>');
    fs.mkdirSync(path.join(root, 'plugins'));
    const external = fs.mkdtempSync(fixturePrefix); roots.push(external);
    fs.symlinkSync(external, path.join(root, 'plugins', 'inner'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(selectedOutputDependencyFiles(assembly)).toMatchObject({ complete: false, reason: 'OUTPUT_DEPENDENCY_LINK' });
  });

  it('changes graph identity after a copied project reference is replaced at the same path', () => {
    const { root, assembly } = fixture(); const dependency = path.join(root, 'ReferencedProject.dll');
    fs.writeFileSync(dependency, 'AAAA');
    const before = captureDependencyGraphIdentity(selectedOutputDependencyFiles(assembly).files, { clock });
    const timestamp = fs.statSync(dependency); fs.writeFileSync(dependency, 'BBBB'); fs.utimesSync(dependency, timestamp.atime, timestamp.mtime);
    const after = captureDependencyGraphIdentity(selectedOutputDependencyFiles(assembly).files, { clock });
    expect(before.mode).toBe('content'); expect(after.mode).toBe('content');
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

  it('marks a scan incomplete when its production deadline expires', () => {
    const { assembly } = fixture();
    let elapsed = 0;
    vi.mocked(Date.now).mockImplementation(() => { const now = elapsed; elapsed = 101; return now; });
    expect(selectedOutputDependencyFiles(assembly)).toMatchObject({ complete: false, reason: 'OUTPUT_DEPENDENCY_SCAN_BUDGET' });
  });

  it('marks over-budget and unavailable scans incomplete rather than attesting partial graphs', () => {
    const { root, assembly } = fixture();
    for (let i = 0; i < 257; i++) fs.writeFileSync(path.join(root, `dependency${i}.dll`), 'dll');
    expect(selectedOutputDependencyFiles(assembly)).toMatchObject({ complete: false, reason: 'OUTPUT_DEPENDENCY_FILE_BUDGET' });
    expect(selectedOutputDependencyFiles(path.join(root, 'missing', 'Form.dll'))).toMatchObject({ complete: false, reason: 'OUTPUT_DEPENDENCY_UNAVAILABLE' });
  });
});
