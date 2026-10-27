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
const extensionDevelopmentPath = path.join(repo, 'extension');
const productManifest = JSON.parse(fs.readFileSync(path.join(extensionDevelopmentPath, 'package.json'), 'utf8'));
const productId = `${productManifest.publisher}.${productManifest.name}`;
const requireFromExtension = createRequire(path.join(extensionDevelopmentPath, 'package.json'));
const { downloadAndUnzipVSCode } = requireFromExtension('@vscode/test-electron');
const esbuild = requireFromExtension('esbuild');
const version = process.argv.find(argument => argument.startsWith('--version='))?.slice(10)
  ?? process.env.VSCODE_TEST_VERSION ?? '1.84.0';
if (process.platform !== 'win32') throw new Error('Release 2.3 (R24) adapter acceptance requires Windows.');
if (!/^(?:stable|insiders|\d+\.\d+\.\d+)$/.test(version)) throw new Error(`Invalid VS Code version: ${version}`);
const cachePath = path.join(extensionDevelopmentPath, '.vscode-test');
const testTemp = path.join(cachePath, 'tmp');
fs.mkdirSync(testTemp, { recursive: true });
process.env.TEMP = testTemp;
process.env.TMP = testTemp;
delete process.env.ELECTRON_RUN_AS_NODE;
const fixtureRoot = fs.mkdtempSync(path.join(testTemp, 'release24-adapters-'));
const workspacePath = path.join(fixtureRoot, 'workspace');
const authorPath = path.join(fixtureRoot, 'independent-author');
const userDataPath = path.join(fixtureRoot, 'user-data');
const extensionsPath = path.join(fixtureRoot, 'extensions');
const sharedDataPath = path.join(fixtureRoot, 'shared-data');
const harnessPath = path.join(fixtureRoot, 'harness');
fs.mkdirSync(workspacePath, { recursive: true });
fs.mkdirSync(path.join(userDataPath, 'User'), { recursive: true });
fs.mkdirSync(extensionsPath, { recursive: true });
fs.mkdirSync(harnessPath, { recursive: true });
fs.writeFileSync(path.join(userDataPath, 'User', 'settings.json'), `${JSON.stringify({
  'workbench.startupEditor': 'none', 'window.restoreWindows': 'none', 'files.hotExit': 'onExitAndWindowClose',
  'security.workspace.trust.enabled': false, 'winformsDesigner.autoOpenDesigner': false,
  'winformsDesigner.toolbox.autoDiscoverProjectControls': false, 'task.saveBeforeRun': 'never',
  'extensions.autoUpdate': false, 'extensions.autoCheckUpdates': false,
}, null, 2)}\n`);

const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function execute(command, args, cwd = repo) {
  const result = spawnSync(command, args, { cwd, env: process.env, stdio: 'inherit', windowsHide: true });
  if (result.error || result.status !== 0) throw result.error ?? new Error(`Command failed (${result.status}): ${command} ${args.join(' ')}`);
}
function build(project) {
  execute('dotnet.exe', ['build', project, '-c', 'Release', '-p:PlatformTarget=x64', '--nologo', '-v:q']);
}
function files(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`A generated acceptance input must not contain links: ${file}`);
    return entry.isDirectory() ? files(file) : entry.isFile() ? [file] : [];
  });
}
function copySources(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('Independent SDK sources must not contain links.');
    if (entry.name === 'bin' || entry.name === 'obj' || entry.name === 'node_modules') continue;
    const from = path.join(source, entry.name), to = path.join(destination, entry.name);
    if (entry.isDirectory()) copySources(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}
function writeForm(name, targetFramework) {
  const directory = path.join(workspacePath, name);
  fs.mkdirSync(directory, { recursive: true });
  const project = path.join(directory, 'Release24Fixture.csproj');
  fs.writeFileSync(project, [
    '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup>',
    `<TargetFramework>${targetFramework}</TargetFramework><UseWindowsForms>true</UseWindowsForms>`,
    '<OutputType>Library</OutputType><PlatformTarget>x64</PlatformTarget><LangVersion>latest</LangVersion>',
    `<AssemblyName>Release24${name}</AssemblyName></PropertyGroup></Project>`, '',
  ].join('\r\n'));
  fs.writeFileSync(path.join(directory, 'Release24Form.cs'), [
    'namespace Release24Fixture {', '    public partial class Release24Form : System.Windows.Forms.Form {',
    '        public Release24Form() { InitializeComponent(); }', '    }', '}', '',
  ].join('\r\n'));
  fs.writeFileSync(path.join(directory, 'Release24Form.Designer.cs'), [
    'namespace Release24Fixture {', '    partial class Release24Form {',
    '        // RELEASE24_KEEP_UNOWNED_COMMENT', '        private System.Windows.Forms.Button button1;',
    '        private void InitializeComponent() {', '            this.button1 = new System.Windows.Forms.Button();',
    '            this.SuspendLayout();', '            this.button1.Location = new System.Drawing.Point(12, 12);',
    '            this.button1.Size = new System.Drawing.Size(140, 30);', '            this.button1.Name = "button1";',
    '            this.button1.Text = "Original caption";', '            this.ClientSize = new System.Drawing.Size(320, 180);',
    '            this.Controls.Add(this.button1);', '            this.Name = "Release24Form";',
    `            this.Text = "Release24 ${name}";`, '            this.ResumeLayout(false);', '        }', '    }', '}', '',
  ].join('\r\n'));
  fs.writeFileSync(path.join(directory, 'Release24Form.resx'), [
    '<?xml version="1.0" encoding="utf-8"?>', '<root>',
    '<resheader name="resmimetype"><value>text/microsoft-resx</value></resheader>',
    '<resheader name="version"><value>2.0</value></resheader>',
    '<resheader name="reader"><value>System.Resources.ResXResourceReader, System.Windows.Forms</value></resheader>',
    '<resheader name="writer"><value>System.Resources.ResXResourceWriter, System.Windows.Forms</value></resheader>',
    '<data name="opaque.Payload" xml:space="preserve"><value>RELEASE24_KEEP_RESOURCE</value></data>', '</root>', '',
  ].join('\r\n'));
  return project;
}
function packageCopy(name, transform) {
  const destination = path.join(workspacePath, 'adapters', name);
  fs.cpSync(path.join(workspacePath, 'adapters', 'action'), destination, { recursive: true, errorOnExist: true });
  const manifestFile = path.join(destination, 'adapter-package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  manifest.adapter.id = `release24.${name}`;
  transform?.(manifest, destination);
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  return path.relative(workspacePath, manifestFile);
}
function workspaceGrantWitness(phase) {
  const workspaceStorage = path.join(userDataPath, 'User', 'workspaceStorage');
  const databases = fs.existsSync(workspaceStorage) ? files(workspaceStorage).filter(file => path.basename(file) === 'state.vscdb') : [];
  if (databases.length !== 1) throw new Error(`Expected one real workspace SQLite database after ${phase}; found ${databases.length}.`);
  const database = databases[0];
  const relative = path.relative(userDataPath, database);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Workspace database escaped the isolated profile.');
  const connection = new DatabaseSync(database, { readOnly: true });
  let memento;
  try {
    const row = connection.prepare('SELECT value FROM ItemTable WHERE key = ?').get(productId);
    if (!row) throw new Error(`Product workspace memento was not durably stored after ${phase}.`);
    memento = JSON.parse(typeof row.value === 'string' ? row.value : Buffer.from(row.value).toString('utf8'));
  } finally { connection.close(); }
  const grantKey = 'winformsDesigner.adapterDevelopmentGrants.v1';
  const grants = memento[grantKey];
  if (!Array.isArray(grants) || (phase === 'setup' && grants.length !== 2)) throw new Error('Explicit sample grants were not persisted in the actual workspace memento.');
  const witness = grants.map(entry => {
    if (typeof entry?.path !== 'string' || !/^[a-f0-9]{64}$/.test(entry?.sha256 ?? '')) throw new Error('The persisted grant entry was invalid.');
    const relativePackage = path.relative(workspacePath, entry.path);
    if (!relativePackage || relativePackage.startsWith('..') || path.isAbsolute(relativePackage)) throw new Error('A persisted grant was outside the isolated workspace.');
    return { packagePath: relativePackage.replaceAll('\\', '/'), packageSha256: entry.sha256 };
  });
  for (const sample of ['action', 'editor']) if (!witness.some(entry => entry.packagePath.toLowerCase() === `adapters/${sample}/adapter-package.json`))
    throw new Error(`The real ${sample} sample grant was missing after ${phase}.`);
  return { phase, database: relative.replaceAll('\\', '/'), databaseSha256: sha(database), productMementoKey: productId, grantKey,
    productMementoSha256: createHash('sha256').update(JSON.stringify(memento)).digest('hex'), grants: witness, readOnlyInspection: true };
}

let succeeded = false;
let testedBuild;
let independentSample;
let realVSCodeLaunches = 0;
const phases = [];
const workspaceGrantPersistence = [];
try {
  // The author checkout has the public SDK and samples, with no extension source or private host modules.
  copySources(path.join(repo, 'adapter-sdk'), path.join(authorPath, 'adapter-sdk'));
  copySources(path.join(repo, 'samples', 'AdapterSdkPreview'), path.join(authorPath, 'samples', 'AdapterSdkPreview'));
  const independentSources = files(authorPath).map(file => ({ path: path.relative(authorPath, file).replaceAll('\\', '/'), sha256: sha(file) }));
  execute(process.execPath, [path.join(authorPath, 'samples', 'AdapterSdkPreview', 'build.mjs')], authorPath);
  for (const name of ['action', 'editor']) {
    const source = path.join(authorPath, 'samples', 'AdapterSdkPreview', name, 'bin');
    fs.cpSync(source, path.join(workspacePath, 'adapters', name), { recursive: true, errorOnExist: true });
  }
  const packages = { action: 'adapters/action/adapter-package.json', editor: 'adapters/editor/adapter-package.json',
    changed: packageCopy('changed-entry'), revoked: packageCopy('revoked'),
    incomplete: packageCopy('incomplete-services', manifest => { manifest.requiredServices = ['serialization.native-graph']; }),
    wrongResult: packageCopy('wrong-result', (manifest, directory) => {
      const entrypoint = path.join(directory, manifest.execution.entrypoint);
      // This deliberately bypasses serveAdapter's author-side validation; the product must reject the wire response.
      fs.writeFileSync(entrypoint, ["process.stdin.setEncoding('utf8');", "let input = ''; let replied = false;",
        "process.stdin.on('data', chunk => { if(replied) return; input += chunk; if(Buffer.byteLength(input)>65536) process.exit(2); const newline=input.indexOf('\\n'); if(newline<0) return; replied=true; const r=JSON.parse(input.slice(0,newline)); process.stdout.write(JSON.stringify({protocolId:r.protocolId,protocolVersion:r.protocolVersion,id:r.id,status:'ok',intent:{kind:'setProperty',componentId:r.context.componentId,propertyName:r.context.propertyName,propertyType:'System.Int32',invariantValue:'7'}})+'\\n',()=>process.exit(0)); });", ''].join('\n'));
      manifest.integrity.files.find(file => file.path === manifest.execution.entrypoint).sha256 = sha(entrypoint);
    }) };
  fs.writeFileSync(path.join(workspacePath, '.release24-inputs.json'), `${JSON.stringify({ packages,
    conformanceFile: path.join(authorPath, 'samples', 'AdapterSdkPreview', 'conformance.mjs') }, null, 2)}\n`);
  independentSample = { sourceRoot: 'independent-author', sourceSha256: independentSources,
    buildCommand: 'node samples/AdapterSdkPreview/build.mjs', extensionSourcesAvailable: false,
    packageFiles: files(path.join(workspacePath, 'adapters')).map(file => ({ path: path.relative(workspacePath, file).replaceAll('\\', '/'), sha256: sha(file) })) };
  if (!process.argv.includes('--skip-engine-build')) {
    build(path.join(repo, 'engine', 'Engine.csproj'));
    build(path.join(repo, 'engine-net48', 'Engine.Net48.csproj'));
  }
  for (const [name, tfm] of [['Modern', 'net10.0-windows'], ['Framework', 'net48']]) build(writeForm(name, tfm));
  for (const [entryPoint, outfile] of [['src/extension.ts', 'dist/extension.js'],
    ['src/release24-extension-host-suite.ts', 'dist/release24-extension-host-suite.cjs']]) {
    await esbuild.build({ absWorkingDir: extensionDevelopmentPath, entryPoints: [entryPoint], outfile,
      bundle: true, platform: 'node', target: 'node18', format: 'cjs', external: ['vscode'], sourcemap: true });
  }
  fs.copyFileSync(path.join(extensionDevelopmentPath, 'dist', 'release24-extension-host-suite.cjs'), path.join(harnessPath, 'suite.cjs'));
  fs.writeFileSync(path.join(harnessPath, 'package.json'), `${JSON.stringify({ name: 'release24-adapter-harness', publisher: 'local-test',
    version: '0.0.1', engines: { vscode: '^1.84.0' }, main: './harness.cjs', activationEvents: ['onStartupFinished'],
    extensionDependencies: ['skivhisink.winforms-designer-vscode'] }, null, 2)}\n`);
  fs.writeFileSync(path.join(harnessPath, 'harness.cjs'), `const vscode = require('vscode');
exports.activate = async function() {
  try { await require('./suite.cjs').run(); }
  catch (error) {
    const file = require('path').join(vscode.workspace.workspaceFolders[0].uri.fsPath,
      '.release24-' + process.env.WFD_RELEASE24_PHASE + '-results.json');
    let report = require('fs').existsSync(file) ? JSON.parse(require('fs').readFileSync(file, 'utf8')) : { phase:process.env.WFD_RELEASE24_PHASE,scenarios:[] };
    report.failed = Math.max(1, report.failed || 0); report.runError = String(error.stack || error);
    require('fs').writeFileSync(file, JSON.stringify(report, null, 2)+'\\n');
  }
  await vscode.commands.executeCommand('workbench.action.quit');
};\n`);
  const cachedExecutable = path.join(cachePath, `vscode-win32-${process.arch}-archive-${version}`, 'Code.exe');
  const executable = fs.existsSync(cachedExecutable) ? cachedExecutable : await downloadAndUnzipVSCode({ version, cachePath,
    extensionDevelopmentPath: [extensionDevelopmentPath, harnessPath] });
  const executableRoot = path.dirname(executable);
  const appRoots = [path.join(executableRoot, 'resources', 'app'), ...fs.readdirSync(executableRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.isSymbolicLink()).map(entry => path.join(executableRoot, entry.name, 'resources', 'app'))]
    .filter(directory => fs.existsSync(path.join(directory, 'package.json')));
  if (appRoots.length !== 1) throw new Error('Expected one actual VS Code application package.');
  const resolvedVSCodeVersion = JSON.parse(fs.readFileSync(path.join(appRoots[0], 'package.json'), 'utf8')).version;
  if (!/^\d+\.\d+\.\d+$/.test(resolvedVSCodeVersion) || /^\d/.test(version) && resolvedVSCodeVersion !== version)
    throw new Error(`Resolved VS Code version drifted: requested=${version}, actual=${resolvedVSCodeVersion}`);
  const listed = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: repo, encoding: 'utf8', windowsHide: true });
  if (listed.error || listed.status !== 0) throw listed.error ?? new Error('Could not enumerate release inputs.');
  const trackedInputs = [...new Set(listed.stdout.split('\0').filter(file => file &&
    /^(?:adapter-sdk\/|samples\/AdapterSdkPreview\/|engine(?:-net48)?\/|extension\/(?:src\/|media\/|package(?:-lock|\.nls[^/]*)?\.json$|build\.mjs$|\.vscodeignore$)|scripts\/|global\.json$|Directory\.Build\.props$|README\.md$|CHANGELOG\.md$|LICENSE$|THIRD_PARTY_NOTICES\.md$)/.test(file)
    && !/(?:^|\/)(?:secrets|bin|obj|node_modules)\/|\.(?:env|pfx|key|pem)$/i.test(file)
    && fs.statSync(path.join(repo, file)).isFile()))].sort();
  const artifacts = ['extension/dist/extension.js', 'extension/dist/release24-extension-host-suite.cjs',
    'engine/bin/Release/net10.0-windows/WinFormsDesigner.Engine.dll', 'engine-net48/bin/Release/net48/WinFormsDesigner.Engine.Net48.exe'];
  testedBuild = { requestedVSCodeVersion: version, resolvedVSCodeVersion, hostMode: 'normal-development-host',
    startedAt: new Date().toISOString(), environment: release21Environment(repo),
    normalHostHarness: Object.fromEntries(files(harnessPath).map(file => [path.basename(file), sha(file)])), vscodeExecutableSha256: sha(executable),
    sha256: Object.fromEntries([...new Set([...trackedInputs, ...artifacts])].map(file => [file, sha(path.join(repo, file))])) };
  for (const phase of ['setup', 'restore']) {
    realVSCodeLaunches++;
    const childEnvironment = { ...process.env, VSCODE_TEST_VERSION: version, WFD_RELEASE24_PHASE: phase,
      WFD_RELEASE24_EXPECTED_PRODUCT_ROOT: extensionDevelopmentPath };
    delete childEnvironment.WFD_EXTENSION_HOST_E2E;
    delete childEnvironment.ELECTRON_RUN_AS_NODE;
    // extensionTestsPath deliberately uses in-memory mementos. Two normal hosts are required to prove SQLite grants.
    await new Promise((resolve, reject) => {
      const child = spawn(executable, [workspacePath, '--new-window', `--user-data-dir=${userDataPath}`, `--shared-data-dir=${sharedDataPath}`,
        `--extensions-dir=${extensionsPath}`, `--extensionDevelopmentPath=${extensionDevelopmentPath}`, `--extensionDevelopmentPath=${harnessPath}`,
        '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--disable-updates'],
      { env: childEnvironment, windowsHide: true, stdio: 'inherit' });
      const timer = setTimeout(() => { child.kill(); reject(new Error(`Release 2.3 (R24) ${phase} normal VS Code process exceeded 900 seconds.`)); }, 900_000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        if (code === 0) resolve(); else reject(new Error(`Release 2.3 (R24) ${phase} normal VS Code process exited ${code}, signal=${signal}.`));
      });
    });
    const report = JSON.parse(fs.readFileSync(path.join(workspacePath, `.release24-${phase}-results.json`), 'utf8'));
    phases.push(report);
    const expected = phase === 'setup' ? 6 : 24;
    if (report.failed !== 0 || report.expectedScenarioCount !== expected || report.scenarios.length !== expected
      || report.scenarios.some(row => row.passed !== true) || new Set(report.scenarios.map(row => row.id)).size !== expected) {
      throw new Error(`Release 2.3 (R24) ${phase} scenario ledger is incomplete.`);
    }
    if (report.vscodeVersion !== resolvedVSCodeVersion || report.hostMode !== 'normal-development-host') throw new Error('The actual normal host did not match its resolved distribution.');
    workspaceGrantPersistence.push(workspaceGrantWitness(phase));
  }
  for (const [file, expected] of Object.entries(testedBuild.sha256)) if (sha(path.join(repo, file)) !== expected)
    throw new Error(`Release input changed while acceptance ran: ${file}`);
  succeeded = true;
  console.log(`Release 2.3 (R24) Extension Host: 30 passed across two real launches (VS Code ${phases[1].vscodeVersion}).`);
} finally {
  for (const phase of ['setup', 'restore']) {
    const file = path.join(workspacePath, `.release24-${phase}-results.json`);
    if (fs.existsSync(file) && !phases.some(report => report.phase === phase)) phases.push(JSON.parse(fs.readFileSync(file, 'utf8')));
  }
  const destination = path.resolve(process.env.WFD_RELEASE24_EVIDENCE_FILE ?? path.join(cachePath, `release24-host-${version}.json`));
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, `${JSON.stringify({ suite: 'release24-extension-host', passed: succeeded,
    expectedScenarioCount: 30, realVSCodeLaunches, testedBuild, independentSample, workspaceGrantPersistence, phases,
    publicApiBoundary: 'Published SDK packages built in a checkout without extension sources; public VS Code commands only, no private extension test API.' }, null, 2)}\n`);
  console.log(`Release 2.3 (R24) evidence: ${destination}`);
  if (succeeded) {
    const relative = path.relative(testTemp, fixtureRoot);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(fixtureRoot).startsWith('release24-adapters-'))
      throw new Error('Refusing cleanup outside the generated release24 workspace.');
    fs.rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } else console.error(`Failed Release 2.3 (R24) workspace retained: ${fixtureRoot}`);
}
