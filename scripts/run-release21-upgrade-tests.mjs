import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { release21Environment } from './release21-environment.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionRoot = path.join(repo, 'extension');
const requireExtension = createRequire(path.join(extensionRoot, 'package.json'));
const esbuild = requireExtension('esbuild');
const arg = (name, fallback) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const version = arg('version', '1.135.0');
const baselineRef = arg('baseline', '72a4ee3');
const newVsix = path.resolve(arg('new-vsix', path.join(extensionRoot, 'winforms-designer-2.1.0-win32-x64.vsix')));
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Installed upgrade acceptance requires Windows x64.');
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Use an explicit cached VS Code version.');
if (!/^[0-9a-f]{7,40}$/.test(baselineRef)) throw new Error('Baseline must be an explicit hexadecimal git revision.');
const cachePath = path.join(extensionRoot, '.vscode-test');
const tempRoot = path.join(cachePath, 'tmp');
fs.mkdirSync(tempRoot, { recursive: true });
const fixtureRoot = fs.mkdtempSync(path.join(tempRoot, 'release21-upgrade-'));
const workspace = path.join(fixtureRoot, 'workspace');
const profile = path.join(fixtureRoot, 'user-data');
const sharedData = path.join(fixtureRoot, 'shared-data');
const installed = path.join(fixtureRoot, 'extensions');
const baseline = path.join(fixtureRoot, 'baseline');
const harness = path.join(fixtureRoot, 'harness');
const code = path.join(cachePath, `vscode-win32-x64-archive-${version}`, 'Code.exe');
assert.ok(fs.existsSync(code), `Cached VS Code executable missing: ${code}`);
assert.ok(fs.existsSync(newVsix), `New package missing: ${newVsix}`);
for (const directory of [workspace, path.join(profile, 'User'), installed, baseline, harness]) fs.mkdirSync(directory, { recursive: true });
const env = { ...process.env, TEMP: tempRoot, TMP: tempRoot, WFD_EXTENSION_HOST_E2E: '1' };
delete env.ELECTRON_RUN_AS_NODE;
Object.assign(process.env, env);
delete process.env.ELECTRON_RUN_AS_NODE;
const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const productId = 'skivhisink.winforms-designer-vscode';
let mementoId;
const checks = [];
const phases = [];
const evidence = { suite: 'release21-installed-upgrade-downgrade', passed: false, startedAt: new Date().toISOString(),
  vscodeVersion: version, fixtureRoot, baselineRef, baselineProvenance: 'Reconstructed from the exact repository 2.0.0 baseline; not a historical published VSIX.',
  environment: release21Environment(repo), packages: {}, phases, checks };
const reportFile = path.join(cachePath, `release21-upgrade-${version}.json`);

function command(executable, args, options = {}) {
  const result = spawnSync(executable, args, { cwd: repo, env, windowsHide: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
  if (result.error || result.status !== 0) throw result.error ?? new Error(`${executable} ${args.join(' ')} failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  if (result.stdout) console.log(result.stdout.trim());
  return result.stdout;
}

function assertFixturePath(target) {
  const relative = path.relative(fixtureRoot, path.resolve(target));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Refusing operation outside fixture: ${target}`);
}

function database(file, update) {
  assertFixturePath(file);
  const connection = new DatabaseSync(file);
  try { return update(connection); } finally { connection.close(); }
}

function readMemento(file) {
  return database(file, db => {
    const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(mementoId);
    return row ? JSON.parse(typeof row.value === 'string' ? row.value : Buffer.from(row.value).toString('utf8')) : {};
  });
}

function writeMemento(file, values) {
  database(file, db => { db.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)').run(mementoId, JSON.stringify(values)); });
}

function filesNamed(root, name) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? filesNamed(path.join(root, entry.name), name) : entry.name === name ? [path.join(root, entry.name)] : []);
}

function install(vsix) {
  // Calling Electron's CLI entry through its own executable avoids cmd.exe quoting and stays in our profile.
  const codeRoot = path.dirname(code);
  const cliCandidates = [path.join(codeRoot, 'resources', 'app', 'out', 'cli.js'),
    ...fs.readdirSync(codeRoot, { withFileTypes: true }).filter(entry => entry.isDirectory())
      .map(entry => path.join(codeRoot, entry.name, 'resources', 'app', 'out', 'cli.js'))].filter(file => fs.existsSync(file));
  assert.equal(cliCandidates.length, 1, 'expected one CLI entry in the cached VS Code distribution');
  command(code, [cliCandidates[0],
    `--user-data-dir=${profile}`, `--shared-data-dir=${sharedData}`, `--extensions-dir=${installed}`, '--install-extension', vsix, '--force'],
  { env: { ...env, ELECTRON_RUN_AS_NODE: '1' } });
}

async function phase(name) {
  // --extensionTestsPath puts VS Code's mementos in memory. A normal host plus a development-only
  // harness is essential here: the installed product and real SQLite storage must survive all three launches.
  await new Promise((resolve, reject) => {
    const child = spawn(code, [workspace, '--new-window', `--user-data-dir=${profile}`, `--shared-data-dir=${sharedData}`, `--extensions-dir=${installed}`,
      `--extensionDevelopmentPath=${harness}`, '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--disable-updates'],
    { env: { ...env, WFD_RELEASE21_UPGRADE_PHASE: name }, windowsHide: true, stdio: 'inherit' });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${name}: normal VS Code process exceeded 120 seconds`)); }, 120_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve(); else reject(new Error(`${name}: VS Code exited ${code}, signal ${signal}`));
    });
  });
  const result = JSON.parse(fs.readFileSync(path.join(workspace, `.upgrade-${name}.json`), 'utf8'));
  assert.equal(result.passed, true, result.error);
  assert.ok(path.relative(installed, result.installedExtensionPath).startsWith(`${productId}-`), 'product did not load from isolated installed extensions');
  phases.push(result);
}

try {
  evidence.baselineCommit = command('git', ['rev-parse', `${baselineRef}^{commit}`]).trim();
  const archive = path.join(fixtureRoot, 'baseline.tar');
  const selected = ['extension/src', 'extension/media', 'extension/package.json', 'extension/README.md',
    'extension/package.nls.json', 'extension/package.nls.ru.json', 'extension/package.nls.de.json',
    'extension/package.nls.es.json', 'extension/package.nls.fr.json', 'extension/package.nls.hi.json',
    'extension/package.nls.zh-cn.json', 'engine', 'engine-net48', 'Directory.Build.props', 'global.json', 'LICENSE'];
  // Archive explicit source/assets only, never the checkout's dirty files or secret material.
  command('git', ['archive', '--format=tar', `--output=${archive}`, baselineRef, ...selected]);
  // The Windows tar, by path: a GNU tar earlier on PATH (Git Bash, MSYS) reads `D:\...` as a remote host.
  command(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', archive, '-C', baseline]);
  const oldExtension = path.join(baseline, 'extension');
  const oldManifest = JSON.parse(fs.readFileSync(path.join(oldExtension, 'package.json'), 'utf8'));
  assert.equal(oldManifest.version, '2.0.0');
  mementoId = `${oldManifest.publisher}.${oldManifest.name}`;
  await esbuild.build({ absWorkingDir: oldExtension, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js',
    nodePaths: [path.join(extensionRoot, 'node_modules')], bundle: true, platform: 'node', target: 'node18', format: 'cjs', external: ['vscode'] });
  for (const [project, output] of [['engine/Engine.csproj', 'engine'], ['engine-net48/Engine.Net48.csproj', 'engine-net48']]) {
    command('dotnet.exe', ['publish', path.join(baseline, project), '-c', 'Release', '--nologo', '-v:q',
      ...(output === 'engine' ? ['-r', 'win-x64', '--self-contained', 'false'] : []), '-o', path.join(oldExtension, output)], { cwd: baseline });
  }
  const stage = path.join(fixtureRoot, 'vsix-stage');
  const stageExtension = path.join(stage, 'extension');
  fs.mkdirSync(stageExtension, { recursive: true });
  for (const name of ['dist', 'media', 'engine', 'engine-net48']) fs.cpSync(path.join(oldExtension, name), path.join(stageExtension, name), { recursive: true });
  for (const name of fs.readdirSync(oldExtension).filter(name => /^package(?:\.nls(?:\.[a-z-]+)?)?\.json$/.test(name))) {
    fs.copyFileSync(path.join(oldExtension, name), path.join(stageExtension, name));
  }
  fs.copyFileSync(path.join(oldExtension, 'README.md'), path.join(stageExtension, 'README.md'));
  fs.copyFileSync(path.join(baseline, 'LICENSE'), path.join(stageExtension, 'LICENSE'));
  fs.writeFileSync(path.join(stage, '[Content_Types].xml'), '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="json" ContentType="application/json"/><Default Extension="vsixmanifest" ContentType="text/xml"/></Types>');
  fs.writeFileSync(path.join(stage, 'extension.vsixmanifest'), `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011"><Metadata>
<Identity Language="en-US" Id="winforms-designer-vscode" Version="2.0.0" Publisher="SkivHisink" TargetPlatform="win32-x64"/>
<DisplayName>WinForms Designer for VS Code</DisplayName><Description>Reconstructed 2.0.0 baseline for local upgrade acceptance</Description>
<Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="^1.84.0"/><Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace"/></Properties>
</Metadata><Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation><Dependencies/><Assets>
<Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/></Assets></PackageManifest>`);
  const oldVsix = path.join(fixtureRoot, 'baseline-2.0.0-win32-x64.vsix');
  const zipScript = path.join(fixtureRoot, 'package-baseline.ps1');
  fs.writeFileSync(zipScript, 'param([string]$SourceRoot,[string]$OutputVsix)\nAdd-Type -AssemblyName System.IO.Compression.FileSystem\n[System.IO.Compression.ZipFile]::CreateFromDirectory($SourceRoot,$OutputVsix)\n');
  command('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', zipScript, '-SourceRoot', stage, '-OutputVsix', oldVsix]);
  evidence.packages = {
    old: { version: '2.0.0', path: oldVsix, sha256: sha(oldVsix), bundledEntrySha256: sha(path.join(stageExtension, 'dist', 'extension.js')),
      modernEngineSha256: sha(path.join(stageExtension, 'engine', 'WinFormsDesigner.Engine.dll')),
      classicEngineSha256: sha(path.join(stageExtension, 'engine-net48', 'WinFormsDesigner.Engine.Net48.exe')) },
    new: { version: '2.1.0', path: newVsix, sha256: sha(newVsix) },
  };
  fs.writeFileSync(path.join(harness, 'package.json'), JSON.stringify({ name: 'release21-upgrade-harness', publisher: 'local-test',
    version: '0.0.1', engines: { vscode: '^1.84.0' }, main: './harness.cjs', activationEvents: ['onStartupFinished'] }));
  fs.writeFileSync(path.join(harness, 'harness.cjs'), `const vscode = require('vscode');
exports.activate = async function() {
  try { await require('./suite.cjs').run(); }
  catch (error) {
    require('fs').writeFileSync(require('path').join(vscode.workspace.workspaceFolders[0].uri.fsPath,
      '.upgrade-' + process.env.WFD_RELEASE21_UPGRADE_PHASE + '.json'), JSON.stringify({ passed: false, error: String(error.stack || error) }));
  }
  await vscode.commands.executeCommand('workbench.action.quit');
};\n`);
  await esbuild.build({ absWorkingDir: extensionRoot, entryPoints: ['src/release21-upgrade-suite.ts'],
    outfile: path.join(harness, 'suite.cjs'), bundle: true, platform: 'node', target: 'node18', format: 'cjs', external: ['vscode'] });
  fs.writeFileSync(path.join(profile, 'User', 'settings.json'), JSON.stringify({
    'workbench.startupEditor': 'none', 'window.restoreWindows': 'all', 'files.hotExit': 'onExitAndWindowClose',
    'security.workspace.trust.enabled': false, 'winformsDesigner.autoOpenDesigner': false,
    'winformsDesigner.toolbox.autoDiscoverProjectControls': false,
    'chat.disableAIFeatures': true,
    'extensions.autoUpdate': false, 'extensions.autoCheckUpdates': false,
  }));
  fs.writeFileSync(path.join(workspace, 'UpgradeFixture.csproj'), '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0-windows</TargetFramework><UseWindowsForms>true</UseWindowsForms><OutputType>Library</OutputType></PropertyGroup></Project>');
  fs.writeFileSync(path.join(workspace, 'UpgradeForm.cs'), 'using System.Windows.Forms; namespace UpgradeFixture { public partial class UpgradeForm : Form { public UpgradeForm() { InitializeComponent(); } } }\n');
  fs.writeFileSync(path.join(workspace, 'UpgradeForm.Designer.cs'), `namespace UpgradeFixture { partial class UpgradeForm {
private System.Windows.Forms.Button button1;
private void InitializeComponent() {
this.button1 = new System.Windows.Forms.Button();
this.SuspendLayout();
this.button1.Location = new System.Drawing.Point(12, 12);
this.button1.Size = new System.Drawing.Size(120, 30);
this.button1.Name = "button1";
this.button1.Text = "SAVED_BASELINE_20";
this.ClientSize = new System.Drawing.Size(320, 180);
this.Controls.Add(this.button1);
this.Name = "UpgradeForm";
this.ResumeLayout(false);
} } }\n`);
  command('dotnet.exe', ['build', path.join(workspace, 'UpgradeFixture.csproj'), '-c', 'Release', '--nologo', '-v:q']);
  install(oldVsix);
  await phase('old-initialize');
  const globalDb = path.join(profile, 'User', 'globalStorage', 'state.vscdb');
  const workspaceDbs = filesNamed(path.join(profile, 'User', 'workspaceStorage'), 'state.vscdb');
  assert.equal(workspaceDbs.length, 1, 'expected one real VS Code workspace memento database');
  const workspaceDb = workspaceDbs[0];
  assert.ok(database(workspaceDb, db => db.prepare('SELECT key FROM ItemTable WHERE key = ?').get(mementoId)),
    'the baseline activation did not create the expected case-sensitive memento key');
  evidence.storage = { globalDb, workspaceDb, mementoId, sharedData, seeding: 'Offline SQLite mutation of the real closed VS Code profile, using shipped 2.0 memento shapes.' };
  const originalGlobal = {
    chosenToolboxItems: [{ name: 'GlobalWidget', fqn: 'Legacy.GlobalWidget', category: 'Legacy', fromProject: true }],
    hiddenToolboxFqns: ['Legacy.HiddenWidget'],
    toolboxUiState: { customTabs: [{ name: 'Global Legacy', items: ['Legacy.GlobalWidget'] }], listView: true, sortAlpha: false, showAll: false },
    browsedToolboxAssemblies: ['D:\\StateOnlyFixture\\Legacy.dll'],
    toolboxScanCache: { 'legacy.dll': { stamp: '10:20|', items: [{ name: 'LegacyWidget', namespace: 'Legacy', assemblyName: 'Legacy', version: '1.0', directory: 'D:\\StateOnlyFixture', fromProject: true }] } },
  };
  const existingWorkspace = {
    chosenToolboxItems: [{ name: 'WorkspaceWidget', fqn: 'Current.WorkspaceWidget', category: 'Workspace', fromProject: true }],
    toolboxUiState: { customTabs: [{ name: 'Workspace', items: ['Current.WorkspaceWidget'] }], listView: false, sortAlpha: true, showAll: false },
    controlSources: { 'unopened-form': 'preserved-assembly.dll' },
    designerViewStates: { 'unopened-form': { canvas: { zoom: 1.5, lockedIds: ['button1'], selectedTabs: { tabs: 'page2' } } } },
  };
  writeMemento(globalDb, { ...readMemento(globalDb), ...originalGlobal });
  const priorWorkspace = readMemento(workspaceDb);
  delete priorWorkspace.hiddenToolboxFqns;
  delete priorWorkspace.browsedToolboxAssemblies;
  writeMemento(workspaceDb, { ...priorWorkspace, ...existingWorkspace });
  const globalStorage = path.join(profile, 'User', 'globalStorage', productId);
  const journal = path.join(globalStorage, 'v2-transactions', 'unknown-schema', 'future.json');
  const unrelatedBackup = path.join(path.dirname(workspaceDb), productId, 'preserve-unsaved-backup.bytes');
  fs.mkdirSync(path.dirname(journal), { recursive: true });
  fs.mkdirSync(path.dirname(unrelatedBackup), { recursive: true });
  fs.writeFileSync(journal, '{"schemaVersion":"999.0.0","state":"future","unsaved":"PRESERVE_JOURNAL_21"}\n');
  fs.writeFileSync(unrelatedBackup, Buffer.from('\ufeffPRESERVE_UNSAVED_BACKUP_21\r\n'));
  const sentinelHashes = { journal: sha(journal), unrelatedBackup: sha(unrelatedBackup) };
  const expectedWorkspace = { ...existingWorkspace, hiddenToolboxFqns: originalGlobal.hiddenToolboxFqns,
    browsedToolboxAssemblies: originalGlobal.browsedToolboxAssemblies };
  install(newVsix);
  await phase('upgrade');
  const checkPersistentState = () => {
    const afterGlobal = readMemento(globalDb);
    const afterWorkspace = readMemento(workspaceDb);
    for (const [key, value] of Object.entries(originalGlobal)) assert.deepEqual(afterGlobal[key], key === 'toolboxScanCache' ? {} : value, `global ${key} changed`);
    for (const [key, value] of Object.entries(expectedWorkspace)) {
      if (key === 'designerViewStates') assert.deepEqual(afterWorkspace[key]['unopened-form'], value['unopened-form']);
      else assert.deepEqual(afterWorkspace[key], value, `workspace ${key} changed`);
    }
    assert.deepEqual({ journal: sha(journal), unrelatedBackup: sha(unrelatedBackup) }, sentinelHashes);
  };
  checkPersistentState();
  checks.push('actual-2.1-activation-migrated-missing-workspace-keys', 'existing-workspace-curation-preserved',
    'legacy-global-curation-preserved-for-downgrade', 'cache-clear-persisted-only-disposable-key',
    'unknown-journal-and-backup-bytes-preserved');
  const registries = filesNamed(profile, 'hot-exit-recovery-v1.json');
  assert.equal(registries.length, 1, 'real product did not persist its CustomDocument hot-exit registry');
  const registry = JSON.parse(fs.readFileSync(registries[0], 'utf8'));
  assert.equal(registry.version, 1);
  const backups = Object.values(registry.entries);
  assert.equal(backups.length, 1);
  const realBackupFile = fileURLToPath(backups[0].backupId);
  assertFixturePath(realBackupFile);
  assert.ok(fs.readFileSync(realBackupFile, 'utf8').includes('UPGRADE_UNSAVED_BACKUP_21'));
  evidence.hotExitBackup = { path: realBackupFile, sha256: sha(realBackupFile), registryPath: registries[0], sourceByteFormat: true };
  checks.push('actual-2.1-custom-document-backup-persisted');
  install(oldVsix);
  await phase('downgrade');
  checkPersistentState();
  checks.push('actual-2.0-downgrade-activation-preserved-settings', 'actual-2.0-restored-2.1-backup-with-undo-redo');
  evidence.passed = true;
  console.log(`Installed 2.0.0 -> 2.1.0 -> 2.0.0 acceptance PASS: ${checks.length} persistent checks and ${phases.length} real host phases.`);
} catch (error) {
  evidence.error = error instanceof Error ? error.stack : String(error);
  throw error;
} finally {
  evidence.completedAt = new Date().toISOString();
  fs.writeFileSync(reportFile, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`Upgrade evidence: ${reportFile}`);
  console.log(`Isolated profile and reconstructed baseline retained: ${fixtureRoot}`);
}
