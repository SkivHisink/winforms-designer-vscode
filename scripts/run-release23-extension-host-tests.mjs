import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { release21Environment } from './release21-environment.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionDevelopmentPath = path.join(repo, 'extension');
const requireFromExtension = createRequire(path.join(extensionDevelopmentPath, 'package.json'));
const { runTests } = requireFromExtension('@vscode/test-electron');
const esbuild = requireFromExtension('esbuild');
const version = process.argv.find(argument => argument.startsWith('--version='))?.slice(10)
  ?? process.env.VSCODE_TEST_VERSION ?? '1.84.0';
const focus = process.argv.find(argument => argument.startsWith('--focus='))?.slice(8) ?? '';
if (focus && !/^(?:modern|net48)-(?:linked|localized|evicted)$/.test(focus)) throw new Error(`Invalid focused scenario: ${focus}`);
if (process.platform !== 'win32') throw new Error('Release 2.3 hot-exit acceptance requires Windows.');
if (!/^(?:stable|insiders|\d+\.\d+\.\d+)$/.test(version)) throw new Error(`Invalid VS Code version: ${version}`);
const cachePath = path.join(extensionDevelopmentPath, '.vscode-test');
const testTemp = path.join(cachePath, 'tmp');
fs.mkdirSync(testTemp, { recursive: true });
process.env.TEMP = testTemp;
process.env.TMP = testTemp;
delete process.env.ELECTRON_RUN_AS_NODE;
const fixtureRoot = fs.mkdtempSync(path.join(testTemp, 'release23-hot-exit-'));
const workspacePath = path.join(fixtureRoot, 'workspace');
const userDataPath = path.join(fixtureRoot, 'user-data');
const extensionsPath = path.join(fixtureRoot, 'extensions');
fs.mkdirSync(workspacePath, { recursive: true });
fs.mkdirSync(path.join(userDataPath, 'User'), { recursive: true });
fs.writeFileSync(path.join(userDataPath, 'User', 'settings.json'), `${JSON.stringify({
  'files.hotExit': 'onExitAndWindowClose', 'window.restoreWindows': 'all', 'workbench.startupEditor': 'none',
  'security.workspace.trust.enabled': false, 'winformsDesigner.autoOpenDesigner': false,
  'winformsDesigner.workers.maximumResidentProcesses': focus ? 16 : 4,
  'winformsDesigner.toolbox.autoDiscoverProjectControls': false,
}, null, 2)}\n`);

function build(project) {
  const result = spawnSync('dotnet.exe', ['build', project, '-c', 'Release', '-p:PlatformTarget=x64', '--nologo', '-v:q'],
    { cwd: repo, env: process.env, stdio: 'inherit', windowsHide: true });
  if (result.error || result.status !== 0) throw result.error ?? new Error(`Build failed (${result.status}): ${project}`);
}

function fixture(name, tfm) {
  const localized = name.endsWith('localized');
  const directory = path.join(workspacePath, name);
  fs.mkdirSync(directory, { recursive: true });
  const project = path.join(directory, 'Release23Fixture.csproj');
  fs.writeFileSync(project, [
    '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup>',
    `<TargetFramework>${tfm}</TargetFramework><UseWindowsForms>true</UseWindowsForms>`,
    '<OutputType>Library</OutputType><PlatformTarget>x64</PlatformTarget><LangVersion>latest</LangVersion>',
    `<AssemblyName>${name}</AssemblyName></PropertyGroup>`,
    // As in Net48CtxFixture, source-interpreted localization reads the owning form's resx. Avoid introducing a
    // fixture-only Resources.Extensions dependency into the Framework build just to embed its typed test resources.
    ...(localized && tfm === 'net48' ? ['<ItemGroup><EmbeddedResource Remove="Release23Form*.resx" /></ItemGroup>'] : []),
    '</Project>', '',
  ].join('\r\n'));
  fs.writeFileSync(path.join(directory, 'Release23Form.cs'), [
    'namespace Release23Fixture {',
    '    public partial class Release23Form : System.Windows.Forms.Form {',
    '        public Release23Form() { InitializeComponent(); }',
    '    }', '}', '',
  ].join('\r\n'));
  fs.writeFileSync(path.join(directory, 'Release23Form.Designer.cs'), [
    'namespace Release23Fixture {', '    partial class Release23Form {',
    '        private System.Windows.Forms.Button button1;',
    '        private void InitializeComponent() {',
    ...(localized ? ['            System.ComponentModel.ComponentResourceManager resources = new System.ComponentModel.ComponentResourceManager(typeof(Release23Form));'] : []),
    '            this.button1 = new System.Windows.Forms.Button();',
    '            this.SuspendLayout();',
    ...(localized ? ['            resources.ApplyResources(this.button1, "button1");'] : [
      '            this.button1.Location = new System.Drawing.Point(12, 12);',
      '            this.button1.Size = new System.Drawing.Size(110, 30);', `            this.button1.Text = "${name}";`]),
    '            this.button1.Name = "button1";',
    localized ? '            resources.ApplyResources(this, "$this");' : '            this.ClientSize = new System.Drawing.Size(320, 180);',
    '            this.Controls.Add(this.button1);', '            this.Name = "Release23Form";',
    `            this.Text = "${name}";`, '            this.ResumeLayout(false);',
    '        }', '    }', '}', '',
  ].join('\r\n'));
  fs.writeFileSync(path.join(directory, 'Release23Form.resx'), [
    '<?xml version="1.0" encoding="utf-8"?>', '<root>',
    '<resheader name="resmimetype"><value>text/microsoft-resx</value></resheader>',
    '<resheader name="version"><value>2.0</value></resheader>',
    '<resheader name="reader"><value>System.Resources.ResXResourceReader, System.Windows.Forms</value></resheader>',
    '<resheader name="writer"><value>System.Resources.ResXResourceWriter, System.Windows.Forms</value></resheader>',
    '<data name="opaque.Payload" xml:space="preserve"><value>RELEASE23_KEEP_RESOURCE</value></data>',
    ...(localized ? [
      '<data name="$this.ClientSize" type="System.Drawing.Size, System.Drawing"><value>320, 180</value></data>',
      '<data name="button1.Location" type="System.Drawing.Point, System.Drawing"><value>12, 12</value></data>',
      '<data name="button1.Size" type="System.Drawing.Size, System.Drawing"><value>110, 30</value></data>',
      '<data name="button1.Text" xml:space="preserve"><value>Neutral button</value></data>',
    ] : []),
    '</root>', '',
  ].join('\r\n'));
  if (localized) fs.writeFileSync(path.join(directory, 'Release23Form.fr.resx'),
    fs.readFileSync(path.join(directory, 'Release23Form.resx'), 'utf8').replace('Neutral button', 'Bouton francais'));
  return project;
}

function find(root, name) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    if (entry.isSymbolicLink()) return [];
    const candidate = path.join(root, entry.name);
    return entry.isDirectory() ? find(candidate, name) : entry.isFile() && entry.name === name ? [candidate] : [];
  });
}

let succeeded = false;
let testedBuild;
let backupObservations;
let lifecycleWitnesses;
try {
  build(path.join(repo, 'engine', 'Engine.csproj'));
  build(path.join(repo, 'engine-net48', 'Engine.Net48.csproj'));
  for (const [prefix, tfm] of [['Modern', 'net10.0-windows'], ['Framework', 'net48']]) {
    for (const mode of ['linked', 'checkpoint', 'branch', 'localized', 'evicted']) build(fixture(`${prefix}${mode}`, tfm));
  }
  fs.copyFileSync(path.join(repo, 'extension', 'media', 'icon.png'), path.join(workspacePath, 'input.png'));
  for (const [entryPoint, outfile] of [['src/extension.ts', 'dist/extension.js'],
    ['src/release23-extension-host-suite.ts', 'dist/release23-extension-host-suite.cjs']]) {
    await esbuild.build({ absWorkingDir: extensionDevelopmentPath, entryPoints: [entryPoint], outfile,
      bundle: true, platform: 'node', target: 'node18', format: 'cjs', external: ['vscode'], sourcemap: true });
  }
  const sha = file => createHash('sha256').update(fs.readFileSync(path.join(repo, file))).digest('hex');
  testedBuild = { requestedVSCodeVersion: version, startedAt: new Date().toISOString(),
    environment: release21Environment(repo), sha256: Object.fromEntries([
      'extension/dist/extension.js', 'extension/dist/release23-extension-host-suite.cjs',
      'scripts/run-release23-extension-host-tests.mjs', 'extension/package.json',
      'extension/media/designer.js', 'extension/media/panel.js', 'extension/media/chooseItems.js',
      'engine/bin/Release/net10.0-windows/WinFormsDesigner.Engine.dll',
      'engine-net48/bin/Release/net48/WinFormsDesigner.Engine.Net48.exe',
    ].map(file => [file, sha(file)])) };
  const cachedExecutable = path.join(cachePath, `vscode-win32-${process.arch}-archive-${version}`, 'Code.exe');
  const launch = phase => runTests({ version, cachePath,
    ...(fs.existsSync(cachedExecutable) ? { vscodeExecutablePath: cachedExecutable } : {}),
    extensionDevelopmentPath, extensionTestsPath: path.join(extensionDevelopmentPath, 'dist', 'release23-extension-host-suite.cjs'),
    extensionTestsEnv: { WFD_EXTENSION_HOST_E2E: '1', VSCODE_TEST_VERSION: version, WFD_RELEASE23_PHASE: phase,
      WFD_RELEASE23_FOCUS: focus },
    launchArgs: [workspacePath, ...(phase === 'setup' ? ['--new-window'] : []), `--user-data-dir=${userDataPath}`,
      `--extensions-dir=${extensionsPath}`, '--disable-extensions', '--skip-welcome', '--skip-release-notes'],
  });
  try { await launch('setup'); } catch (error) {
    if (!fs.existsSync(path.join(workspacePath, '.release23-hot-exit.json'))) throw error;
  }
  const setup = JSON.parse(fs.readFileSync(path.join(workspacePath, '.release23-setup-results.json'), 'utf8'));
  if (setup.failed !== 0 || setup.scenarios.length !== (focus ? 1 : 15) || setup.scenarios.some(row => row.passed !== true)) {
    throw new Error('Release 2.3 setup scenario ledger is incomplete.');
  }
  const registries = find(userDataPath, 'hot-exit-recovery-v1.json');
  if (registries.length !== 1) throw new Error(`Expected one real hot-exit registry, found ${registries.length}.`);
  const registry = JSON.parse(fs.readFileSync(registries[0], 'utf8'));
  const entries = Object.values(registry.entries ?? {});
  if (registry.version !== 1 || entries.length !== (focus ? 1 : 10)) throw new Error('Dirty CustomEditors did not persist every hot-exit backup destination.');
  backupObservations = entries.map(entry => {
    const backup = fileURLToPath(entry.backupId);
    if (!fs.existsSync(backup)) throw new Error('A VS Code-owned backup destination was not persisted.');
    const bytes = fs.readFileSync(backup);
    const sidecar = `${backup}.history.json`;
    if (!fs.existsSync(sidecar)) throw new Error('A real backup destination did not persist its history sidecar.');
    const historyBytes = fs.readFileSync(sidecar);
    const parsed = JSON.parse(historyBytes.toString('utf8'));
    return { documentName: path.basename(path.dirname(fileURLToPath(entry.documentUri))),
      sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length,
      historySha256: createHash('sha256').update(historyBytes).digest('hex'), historyBytes: historyBytes.length,
      format: parsed.format, historyLength: parsed.units.length, activeIndex: parsed.activeIndex,
      checkpointIndex: parsed.checkpointIndex,
      editorCheckpointCount: parsed.editorCheckpoints?.length ?? 0,
      editorCheckpointImages: (parsed.editorCheckpoints ?? []).map(artifact => ({
        beforeSha256: createHash('sha256').update(artifact.before ?? '').digest('hex'),
        afterSha256: createHash('sha256').update(artifact.after ?? '').digest('hex'),
      })),
      linkedArtifactCount: parsed.units.reduce((total, unit) => total + unit.linkedArtifacts.length, 0) };
  });
  lifecycleWitnesses = find(userDataPath, '1-WinForms Designer.log').flatMap(file => fs.readFileSync(file, 'utf8')
    .split(/\r?\n/).flatMap(line => {
      const match = /\[engine\] exited code=(\S+) signal=(\S+) reason=(\S+) intentional=(true|false)/.exec(line);
      return match ? [{ code: match[1], signal: match[2], reason: match[3], intentional: match[4] === 'true' }] : [];
    }));
  if (!focus && !lifecycleWitnesses.some(witness => witness.reason === 'budgetRecycle' && witness.intentional)) {
    throw new Error('Opening eight distinct document owners under the four-worker capacity did not log its intentional budgetRecycle exit reason.');
  }
  console.log(`Release 2.3 setup: ${entries.length} actual VS Code backups persisted (${version}).`);
  await launch('restore');
  const restored = JSON.parse(fs.readFileSync(path.join(workspacePath, '.release23-restore-results.json'), 'utf8'));
  if (restored.failed !== 0 || restored.scenarios.length !== (focus ? 1 : 10) || restored.scenarios.some(row => row.passed !== true)) {
    throw new Error('Release 2.3 restore scenario ledger is incomplete.');
  }
  for (const [file, expected] of Object.entries(testedBuild.sha256)) {
    if (sha(file) !== expected) throw new Error(`Tested binary changed while acceptance ran: ${file}`);
  }
  succeeded = true;
  console.log(`Release 2.3 Extension Host: ${focus ? `focused ${focus}: 2` : '25'} passed across two real launches (VS Code ${restored.vscodeVersion}).`);
} finally {
  const phases = ['setup', 'restore'].map(phase => path.join(workspacePath, `.release23-${phase}-results.json`))
    .filter(file => fs.existsSync(file)).map(file => JSON.parse(fs.readFileSync(file, 'utf8')));
  if (phases.length > 0) {
    const destination = path.resolve(process.env.WFD_RELEASE23_EVIDENCE_FILE ?? path.join(cachePath, `release23-host-${version}${focus ? `-${focus}` : ''}.json`));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, `${JSON.stringify({ suite: 'release23-extension-host', passed: succeeded, focusedScenario: focus || null,
      completeReleaseAcceptance: succeeded && !focus,
      realVSCodeLaunches: phases.length, testedBuild, backupObservations,
      lifecycleCapacityProbe: { maximumResidentProcesses: 4, documentOwners: 8, lifecycleWitnesses }, phases }, null, 2)}\n`);
    console.log(`Release 2.3 evidence: ${destination}`);
  }
  if (succeeded) {
    const relative = path.relative(testTemp, fixtureRoot);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)
      || !path.basename(fixtureRoot).startsWith('release23-hot-exit-')) throw new Error('Refusing cleanup outside generated release23 workspace.');
    fs.rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } else console.error(`Failed Release 2.3 workspace retained: ${fixtureRoot}`);
}
