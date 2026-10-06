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
const cachePath = path.join(extensionDevelopmentPath, '.vscode-test');
const testTemp = path.join(cachePath, 'tmp');
const version = process.argv.find(argument => argument.startsWith('--version='))?.slice(10)
  ?? process.env.VSCODE_TEST_VERSION ?? '1.84.0';
if (process.platform !== 'win32') throw new Error('Release 2.2 product tests require Windows.');
if (!/^(?:stable|insiders|\d+\.\d+\.\d+)$/.test(version)) throw new Error(`Invalid VS Code version: ${version}`);
fs.mkdirSync(testTemp, { recursive: true });
process.env.TEMP = testTemp;
process.env.TMP = testTemp;
process.env.WFD_EXTENSION_HOST_E2E = '1';
process.env.VSCODE_TEST_VERSION = version;
delete process.env.ELECTRON_RUN_AS_NODE;

const fixtureRoot = fs.mkdtempSync(path.join(testTemp, 'release22-product-'));
const workspacePath = path.join(fixtureRoot, 'workspace');
const userDataPath = path.join(fixtureRoot, 'user-data');
const extensionsPath = path.join(fixtureRoot, 'extensions');
fs.mkdirSync(workspacePath, { recursive: true });
fs.mkdirSync(path.join(userDataPath, 'User'), { recursive: true });
fs.writeFileSync(path.join(userDataPath, 'User', 'settings.json'), JSON.stringify({
  'workbench.startupEditor': 'none', 'window.restoreWindows': 'none', 'files.hotExit': 'off',
  'security.workspace.trust.enabled': false, 'winformsDesigner.autoOpenDesigner': false,
  'task.saveBeforeRun': 'never',
}, null, 2));

function build(project) {
  const result = spawnSync('dotnet.exe', ['build', project, '-c', 'Release', '-p:PlatformTarget=x64', '--nologo', '-v:q'], {
    cwd: repo, env: process.env, stdio: 'inherit', windowsHide: true,
  });
  if (result.error || result.status !== 0) throw result.error ?? new Error(`Build failed (${result.status}): ${project}`);
}

function writeForm(name, targetFramework) {
  const directory = path.join(workspacePath, name);
  const dependency = path.join(workspacePath, 'Dependencies', name);
  fs.mkdirSync(directory, { recursive: true });
  fs.mkdirSync(dependency, { recursive: true });
  // Same dependency identity, different bytes: runtime-only routing would silently share an incompatible graph.
  fs.writeFileSync(path.join(dependency, 'GraphDependency.csproj'), [
    '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup>',
    `<TargetFramework>${targetFramework}</TargetFramework><AssemblyName>GraphDependency</AssemblyName>`,
    '<LangVersion>latest</LangVersion></PropertyGroup></Project>', '',
  ].join('\r\n'));
  fs.writeFileSync(path.join(dependency, 'Marker.cs'),
    `namespace GraphDependency { public static class Marker { public const string Value = "${name}"; } }\r\n`);
  const project = path.join(directory, 'Release22Fixture.csproj');
  fs.writeFileSync(project, [
    '<Project Sdk="Microsoft.NET.Sdk">',
    '  <PropertyGroup>',
    `    <TargetFramework>${targetFramework}</TargetFramework><UseWindowsForms>true</UseWindowsForms>`,
    '    <OutputType>Library</OutputType><PlatformTarget>x64</PlatformTarget>',
    '    <AssemblyName>Release22Fixture</AssemblyName><LangVersion>latest</LangVersion>',
    '  </PropertyGroup>',
    `  <ItemGroup><ProjectReference Include="../Dependencies/${name}/GraphDependency.csproj" /></ItemGroup>`,
    '</Project>', '',
  ].join('\r\n'));
  fs.writeFileSync(path.join(directory, 'Release22Form.cs'), [
    'using System.Windows.Forms;', 'namespace Release22Fixture', '{',
    '    public partial class Release22Form : Form', '    {',
    '        public Release22Form() { InitializeComponent(); }',
    '        private void ExistingClick(object sender, System.EventArgs e) { }',
    '    }', '}', '',
  ].join('\r\n'));
  fs.writeFileSync(path.join(directory, 'Release22Form.Designer.cs'), [
    'namespace Release22Fixture', '{', '    partial class Release22Form', '    {',
    '        // RELEASE22_KEEP_OUTSIDE_EDIT',
    '        private System.Windows.Forms.Button button1;',
    '        private void InitializeComponent()', '        {',
    '            System.ComponentModel.ComponentResourceManager resources = new System.ComponentModel.ComponentResourceManager(typeof(Release22Form));',
    '            this.button1 = new System.Windows.Forms.Button();', '            this.SuspendLayout();',
    '            this.button1.Location = new System.Drawing.Point(12, 12);',
    '            this.button1.Size = new System.Drawing.Size(110, 30);',
    '            this.button1.Name = "button1";', `            this.button1.Text = "${name}";`,
    '            this.ClientSize = new System.Drawing.Size(320, 180);',
    '            this.Controls.Add(this.button1);', '            this.Name = "Release22Form";',
    `            this.Text = "Release22 ${name}";`, '            this.ResumeLayout(false);',
    '        }', '    }', '}', '',
  ].join('\r\n'));
  fs.writeFileSync(path.join(directory, 'Release22Form.resx'), [
    '<?xml version="1.0" encoding="utf-8"?>', '<root>',
    '<resheader name="resmimetype"><value>text/microsoft-resx</value></resheader>',
    '<resheader name="version"><value>2.0</value></resheader>',
    '<resheader name="reader"><value>System.Resources.ResXResourceReader, System.Windows.Forms</value></resheader>',
    '<resheader name="writer"><value>System.Resources.ResXResourceWriter, System.Windows.Forms</value></resheader>',
    '<data name="opaque.Payload" xml:space="preserve"><value>RELEASE22_KEEP_RESOURCE</value></data>',
    '</root>', '',
  ].join('\r\n'));
  return project;
}

let succeeded = false;
let testedBuild;
try {
  build(path.join(repo, 'engine', 'Engine.csproj'));
  build(path.join(repo, 'engine-net48', 'Engine.Net48.csproj'));
  for (const [name, tfm] of [['ModernA', 'net10.0-windows'], ['ModernB', 'net10.0-windows'],
    ['FrameworkA', 'net48'], ['FrameworkB', 'net48']]) build(writeForm(name, tfm));
  fs.copyFileSync(path.join(repo, 'extension', 'media', 'icon.png'), path.join(workspacePath, 'input.png'));
  fs.mkdirSync(path.join(workspacePath, '.vscode'), { recursive: true });
  // Exactly one real Build task makes the public coordinated-build command deterministic without replacing it. It
  // rebuilds both runtime routes' first fixtures (already restored above) through a plain MSBuild traversal.
  fs.writeFileSync(path.join(workspacePath, 'Release22Build.proj'), [
    '<Project>',
    '  <Target Name="Build">',
    '    <MSBuild Projects="FrameworkA\\Release22Fixture.csproj;ModernA\\Release22Fixture.csproj" Targets="Build"',
    '      Properties="Configuration=Release;PlatformTarget=x64" />',
    '  </Target>',
    '</Project>', '',
  ].join('\r\n'));
  fs.writeFileSync(path.join(workspacePath, '.vscode', 'tasks.json'), JSON.stringify({
    version: '2.0.0', tasks: [{ label: 'Release22 Build', type: 'process', command: 'dotnet.exe',
      args: ['msbuild', '${workspaceFolder}/Release22Build.proj', '-t:Build', '-nologo', '-v:q'],
      group: { kind: 'build', isDefault: true },
      problemMatcher: '$msCompile', presentation: { reveal: 'never', panel: 'dedicated' } }],
  }, null, 2));
  for (const [entryPoint, outfile] of [['src/extension.ts', 'dist/extension.js'],
    ['src/release22-extension-host-suite.ts', 'dist/release22-extension-host-suite.cjs']]) {
    await esbuild.build({ absWorkingDir: extensionDevelopmentPath, entryPoints: [entryPoint], outfile,
      bundle: true, platform: 'node', target: 'node18', format: 'cjs', external: ['vscode'], sourcemap: true });
  }
  const sha256 = file => createHash('sha256').update(fs.readFileSync(path.join(repo, file))).digest('hex');
  testedBuild = { requestedVSCodeVersion: version, startedAt: new Date().toISOString(),
    environment: release21Environment(repo), sha256: Object.fromEntries([
      'extension/dist/extension.js', 'extension/dist/release22-extension-host-suite.cjs',
      'extension/media/designer.js', 'extension/media/panel.js', 'extension/media/chooseItems.js',
      'engine/bin/Release/net10.0-windows/WinFormsDesigner.Engine.dll',
      'engine-net48/bin/Release/net48/WinFormsDesigner.Engine.Net48.exe',
    ].map(file => [file, sha256(file)])) };
  const expectedModernBuild = `sha256-${testedBuild.sha256['engine/bin/Release/net10.0-windows/WinFormsDesigner.Engine.dll']}`;
  const expectedFrameworkBuild = `sha256-${testedBuild.sha256['engine-net48/bin/Release/net48/WinFormsDesigner.Engine.Net48.exe']}`;
  const cachedExecutable = path.join(cachePath, `vscode-win32-${process.arch}-archive-${version}`, 'Code.exe');
  await runTests({ version, cachePath,
    ...(fs.existsSync(cachedExecutable) ? { vscodeExecutablePath: cachedExecutable } : {}),
    extensionDevelopmentPath, extensionTestsPath: path.join(extensionDevelopmentPath, 'dist', 'release22-extension-host-suite.cjs'),
    extensionTestsEnv: { WFD_EXTENSION_HOST_E2E: '1', VSCODE_TEST_VERSION: version,
      WFD_RELEASE22_GLOBAL_STORAGE: path.join(userDataPath, 'User', 'globalStorage', 'skivhisink.winforms-designer-vscode'),
      WFD_RELEASE22_EXPECTED_MODERN_BUILD_ID: expectedModernBuild,
      WFD_RELEASE22_EXPECTED_NET48_BUILD_ID: expectedFrameworkBuild },
    launchArgs: [workspacePath, '--new-window', `--user-data-dir=${userDataPath}`, `--extensions-dir=${extensionsPath}`,
      '--disable-extensions', '--skip-welcome', '--skip-release-notes'],
  });
  const report = JSON.parse(fs.readFileSync(path.join(workspacePath, '.release22-host-results.json'), 'utf8'));
  if (report.failed !== 0 || report.expectedScenarioCount !== 28 || report.scenarios.length !== 28
    || report.scenarios.some(scenario => scenario.passed !== true)) {
    throw new Error('Release 2.2 product scenario ledger is incomplete.');
  }
  for (const [file, expected] of Object.entries(testedBuild.sha256)) {
    if (sha256(file) !== expected) throw new Error(`Tested binary changed while product acceptance ran: ${file}`);
  }
  succeeded = true;
  console.log(`Release 2.2 Extension Host: ${report.scenarios.length} passed (VS Code ${report.vscodeVersion}).`);
} finally {
  const reportPath = path.join(workspacePath, '.release22-host-results.json');
  if (fs.existsSync(reportPath)) {
    const destination = path.resolve(process.env.WFD_RELEASE22_EVIDENCE_FILE ?? path.join(cachePath, `release22-host-${version}.json`));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, `${JSON.stringify({ ...JSON.parse(fs.readFileSync(reportPath, 'utf8')), testedBuild }, null, 2)}\n`);
    console.log(`Release 2.2 evidence: ${destination}`);
  }
  if (succeeded) {
    const relative = path.relative(testTemp, fixtureRoot);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)
      || !path.basename(fixtureRoot).startsWith('release22-product-')) throw new Error('Refusing cleanup outside generated release22 workspace.');
    fs.rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } else console.error(`Failed Release 2.2 workspace retained: ${fixtureRoot}`);
}
