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
const explicitVersion = process.argv.find(argument => argument.startsWith('--version='))?.slice(10)
  ?? (process.argv.includes('--version') ? process.argv[process.argv.indexOf('--version') + 1] : undefined);
const version = explicitVersion || process.env.VSCODE_TEST_VERSION || '1.84.0';

if (process.platform !== 'win32') throw new Error('Release 2.1 product tests require Windows.');
if (!/^(?:stable|insiders|\d+\.\d+\.\d+)$/.test(version)) throw new Error(`Invalid VS Code version: ${version}`);
fs.mkdirSync(testTemp, { recursive: true });
process.env.TEMP = testTemp;
process.env.TMP = testTemp;
process.env.WFD_EXTENSION_HOST_E2E = '1';
process.env.VSCODE_TEST_VERSION = version;
delete process.env.ELECTRON_RUN_AS_NODE;

// Both the fixture and the editor profile are disposable. Nothing can edit the repository samples or the user's
// ordinary VS Code settings; the path sentinel also proves exported diagnostics do not leak this workspace path.
const fixtureRoot = fs.mkdtempSync(path.join(testTemp, 'release21-PRIVATE_PATH_SENTINEL-'));
const workspacePath = path.join(fixtureRoot, 'workspace');
const userDataPath = path.join(fixtureRoot, 'user-data');
const extensionsPath = path.join(fixtureRoot, 'extensions');
fs.mkdirSync(workspacePath, { recursive: true });
fs.mkdirSync(path.join(userDataPath, 'User'), { recursive: true });
fs.writeFileSync(path.join(userDataPath, 'User', 'settings.json'), JSON.stringify({
  'workbench.startupEditor': 'none',
  'window.restoreWindows': 'none',
  'files.hotExit': 'off',
  'security.workspace.trust.enabled': false,
  'winformsDesigner.autoOpenDesigner': false,
}, null, 2));

function build(project) {
  const result = spawnSync('dotnet.exe', ['build', project, '-c', 'Release', '--nologo', '-v:q'], {
    cwd: repo, env: process.env, stdio: 'inherit', windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw result.error ?? new Error(`Fixture/dependency build failed (${result.status}): ${project}`);
  }
}

function writeForm(directory, targetFramework, platformTarget, missingType = false) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'Release21Fixture.csproj'), [
    '<Project Sdk="Microsoft.NET.Sdk">',
    '  <PropertyGroup>',
    `    <TargetFramework>${targetFramework}</TargetFramework>`,
    '    <UseWindowsForms>true</UseWindowsForms>',
    '    <OutputType>Library</OutputType>',
    `    <PlatformTarget>${platformTarget}</PlatformTarget>`,
    '    <AssemblyName>Release21Fixture</AssemblyName>',
    '    <LangVersion>latest</LangVersion>',
    '  </PropertyGroup>',
    '</Project>', '',
  ].join('\n'));
  fs.writeFileSync(path.join(directory, 'Release21Form.cs'), [
    'using System.Windows.Forms;',
    'namespace Release21Fixture',
    '{',
    '    public partial class Release21Form : Form',
    '    {',
    '        public Release21Form() { InitializeComponent(); }',
    '    }',
    '}', '',
  ].join('\n'));
  const type = missingType ? 'UnavailableVendor.MissingButton' : 'System.Windows.Forms.Button';
  fs.writeFileSync(path.join(directory, 'Release21Form.Designer.cs'), [
    'namespace Release21Fixture',
    '{',
    '    partial class Release21Form',
    '    {',
    `        private ${type} button1;`,
    '        private void InitializeComponent()',
    '        {',
    `            this.button1 = new ${type}();`,
    '            this.SuspendLayout();',
    '            this.button1.Location = new System.Drawing.Point(12, 12);',
    '            this.button1.Size = new System.Drawing.Size(110, 30);',
    '            this.button1.Name = "button1";',
    '            this.button1.Text = "SOURCE_PRIVATE_SENTINEL_21";',
    '            this.ClientSize = new System.Drawing.Size(320, 180);',
    '            this.Controls.Add(this.button1);',
    '            this.Name = "Release21Form";',
    '            this.Text = "Release 2.1 fixture";',
    '            this.ResumeLayout(false);',
    '        }',
    '    }',
    '}', '',
  ].join('\n'));
  return path.join(directory, 'Release21Fixture.csproj');
}

let succeeded = false;
let testedBuild;
try {
  // Incremental builds cover only the two engines and three tiny real fixtures. This runner does not invoke the
  // historical full Extension Host suite, benchmarks, vendor builds, packaging, or release acceptance scripts.
  build(path.join(repo, 'engine', 'Engine.csproj'));
  build(path.join(repo, 'engine-net48', 'Engine.Net48.csproj'));
  build(writeForm(path.join(workspacePath, 'Modern'), 'net10.0-windows', 'x64'));
  build(writeForm(path.join(workspacePath, 'Framework'), 'net48', 'x64'));
  build(writeForm(path.join(workspacePath, 'X86'), 'net48', 'x86'));
  writeForm(path.join(workspacePath, 'MissingType'), 'net10.0-windows', 'x64', true);
  writeForm(path.join(workspacePath, 'InvalidConfig'), 'net10.0-windows', 'x64');
  fs.copyFileSync(path.join(repo, 'docs', 'v2', 'adapter-manifest.sample.json'),
    path.join(workspacePath, 'adapter-manifest.sample.json'));

  for (const [entryPoint, outfile] of [
    ['src/extension.ts', 'dist/extension.js'],
    ['src/release21-extension-host-suite.ts', 'dist/release21-extension-host-suite.cjs'],
  ]) {
    await esbuild.build({
      absWorkingDir: extensionDevelopmentPath, entryPoints: [entryPoint], outfile,
      bundle: true, platform: 'node', target: 'node18', format: 'cjs', external: ['vscode'], sourcemap: true,
    });
  }
  const sha256 = file => createHash('sha256').update(fs.readFileSync(path.join(repo, file))).digest('hex');
  testedBuild = {
    requestedVSCodeVersion: version,
    startedAt: new Date().toISOString(),
    environment: release21Environment(repo),
    sha256: Object.fromEntries([
      'extension/dist/extension.js', 'extension/dist/release21-extension-host-suite.cjs',
      'engine/bin/Release/net10.0-windows/WinFormsDesigner.Engine.dll',
      'engine-net48/bin/Release/net48/WinFormsDesigner.Engine.Net48.exe',
    ].map(file => [file, sha256(file)])),
  };
  const cachedExecutable = path.join(cachePath, `vscode-win32-${process.arch}-archive-${version}`, 'Code.exe');
  await runTests({
    version,
    cachePath,
    ...(fs.existsSync(cachedExecutable) ? { vscodeExecutablePath: cachedExecutable } : {}),
    extensionDevelopmentPath,
    extensionTestsPath: path.join(extensionDevelopmentPath, 'dist', 'release21-extension-host-suite.cjs'),
    extensionTestsEnv: { WFD_EXTENSION_HOST_E2E: '1', VSCODE_TEST_VERSION: version },
    launchArgs: [workspacePath, '--new-window', `--user-data-dir=${userDataPath}`,
      `--extensions-dir=${extensionsPath}`, '--disable-extensions', '--skip-welcome', '--skip-release-notes'],
  });
  const report = JSON.parse(fs.readFileSync(path.join(workspacePath, '.release21-host-results.json'), 'utf8'));
  if (report.failed !== 0 || report.scenarios.length !== 9) throw new Error('Release 2.1 product scenario ledger is incomplete.');
  succeeded = true;
  console.log(`Release 2.1 Extension Host: ${report.scenarios.length} passed (VS Code ${report.vscodeVersion}).`);
} finally {
  const reportPath = path.join(workspacePath, '.release21-host-results.json');
  if (fs.existsSync(reportPath)) {
    const destination = path.join(cachePath, `release21-host-${version}.json`);
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    fs.writeFileSync(destination, `${JSON.stringify({ ...report, testedBuild }, null, 2)}\n`);
    console.log(`Release 2.1 evidence: ${destination}`);
  }
  if (succeeded) {
    // Delete only our verified generated directory; no inferred repository or global profile paths are eligible.
    const relative = path.relative(testTemp, fixtureRoot);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)
      || !path.basename(fixtureRoot).startsWith('release21-PRIVATE_PATH_SENTINEL-')) {
      throw new Error('Refusing cleanup outside the generated release21 workspace.');
    }
    fs.rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } else {
    console.error(`Failed Release 2.1 workspace retained: ${fixtureRoot}`);
  }
}
