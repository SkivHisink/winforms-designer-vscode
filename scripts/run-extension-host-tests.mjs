import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(scriptDir, '..');
const requireFromExtension = createRequire(path.join(repo, 'extension', 'package.json'));
const { runTests } = requireFromExtension('@vscode/test-electron');
const extensionDevelopmentPath = path.join(repo, 'extension');
const extensionTestsPath = path.join(extensionDevelopmentPath, 'dist', 'extension-host-suite.cjs');
const testTemp = path.join(extensionDevelopmentPath, '.vscode-test', 'tmp');
fs.mkdirSync(testTemp, { recursive: true });

function findNamedFiles(root, fileName) {
  const found = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory || !fs.existsSync(directory)) continue;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile() && entry.name === fileName) found.push(candidate);
    }
  }
  return found;
}

process.env.TEMP = testTemp;
process.env.TMP = testTemp;
process.env.WFD_EXTENSION_HOST_E2E = '1';
// Inside an Extension Host process.execPath is Code.exe/Electron, not Node. Pass the real parent Node executable so
// the runtime evidence recorder can invoke the repository provenance helper without attempting to run it as Electron.
process.env.WFD_EVIDENCE_NODE_EXECUTABLE = process.execPath;
// S047 drives the actual certified FakeVendor drop-down worker without opening an interactive window. The fixture
// consumes this only inside its in-repo MIT UITypeEditor; the product still validates assembly path/hash/certification,
// starts the isolated worker, validates the returned type/value, and owns the normal source/native-history commit.
process.env.WFD_FAKE_VENDOR_COMPLEX_VALUE_RESULT = 'Vendor Beta';
process.env.WFD_FAKE_VENDOR_THRESHOLDS_RESULT = '3;5';
// Run this from VS Code's own integrated terminal (or any child of an extension host) and ELECTRON_RUN_AS_NODE=1 is
// inherited. The downloaded VS Code then boots as plain Node, treats the first launch arg as a script, and dies with
// a baffling "Cannot find module .../samples/DemoApp" that looks like a missing fixture rather than a stray env var.
// CONTRIBUTING tells contributors to run this suite, so make the documented command work wherever it is typed.
delete process.env.ELECTRON_RUN_AS_NODE;
const version = process.argv.find((arg) => arg.startsWith('--version='))?.slice('--version='.length)
  || process.env.VSCODE_TEST_VERSION
  || 'stable';
process.env.VSCODE_TEST_VERSION = version;
const scenarioEvidenceDirectory = process.env.WFD_SCENARIO_EVIDENCE_DIR;
let s003ScenarioEvidenceFile;
if (scenarioEvidenceDirectory) {
  fs.mkdirSync(scenarioEvidenceDirectory, { recursive: true });
  const safeVersion = version.replace(/[^0-9A-Za-z._-]+/g, '-');
  process.env.WFD_SCENARIO_EVIDENCE_FILE = path.resolve(
    scenarioEvidenceDirectory,
    `extension-host-${safeVersion}.json`,
  );
  s003ScenarioEvidenceFile = path.resolve(
    scenarioEvidenceDirectory,
    `extension-host-${safeVersion}-s003.json`,
  );
}
// Use a disposable workspace copy. The suite now executes the real Explorer Add commands, so a crash or failed
// assertion must never leave generated Form/UserControl files in the repository checkout. Keep CustomControls next
// to DemoApp because the sample project references it by a relative path.
const workspaceFixture = fs.mkdtempSync(path.join(testTemp, 'workspace-'));
const workspacePath = path.join(workspaceFixture, 'DemoApp');
const userDataPath = path.join(workspaceFixture, '.vscode-user-data');
const extensionsPath = path.join(workspaceFixture, '.vscode-extensions');
// The two-process S003 proof depends on the product's ordinary VS Code hot-exit lifecycle. Test profiles are created
// from scratch and otherwise inherit platform/version defaults that may reopen an empty window after the first test
// process exits. Pin the public user settings used by both supported hosts so the second process reopens the previous
// workspace and VS Code supplies each CustomDocument backup id to openCustomDocument.
const userSettingsDirectory = path.join(userDataPath, 'User');
fs.mkdirSync(userSettingsDirectory, { recursive: true });
fs.writeFileSync(
  path.join(userSettingsDirectory, 'settings.json'),
  `${JSON.stringify({
    'files.hotExit': 'onExitAndWindowClose',
    'window.restoreWindows': 'all',
    'workbench.startupEditor': 'none',
  }, null, 2)}\n`,
  'utf8',
);
fs.cpSync(path.join(repo, 'samples', 'DemoApp'), workspacePath, { recursive: true });
fs.cpSync(path.join(repo, 'samples', 'CustomControls'), path.join(workspaceFixture, 'CustomControls'), { recursive: true });
fs.cpSync(
  path.join(repo, 'fixtures', 'Net48CtxFixture'),
  path.join(workspaceFixture, 'fixtures', 'Net48CtxFixture'),
  { recursive: true, filter: (source) => !/[\\/](?:bin|obj)(?:[\\/]|$)/i.test(source) },
);
// S085/S086/S088 need the same inherited source shape through the modern product lane without a fresher net48
// output influencing runtime selection. Keep a separate source-identical copy and build only its net10 target.
fs.cpSync(
  path.join(repo, 'fixtures', 'Net48CtxFixture'),
  path.join(workspaceFixture, 'fixtures', 'Net48CtxFixtureModern'),
  { recursive: true, filter: (source) => !/[\\/](?:bin|obj)(?:[\\/]|$)/i.test(source) },
);
writeS016DenseForm(path.join(workspaceFixture, 'fixtures', 'Net48CtxFixture'));
writeS016DenseForm(path.join(workspaceFixture, 'fixtures', 'Net48CtxFixtureModern'));
writeS122PerformanceForm(
  path.join(workspaceFixture, 'fixtures', 'Net48CtxFixtureModern'),
  'SampleApp',
  'S122Standard50Form',
  50,
  0,
);
fs.cpSync(
  path.join(repo, 'fixtures', 'FakeVendor'),
  path.join(workspaceFixture, 'fixtures', 'FakeVendor'),
  { recursive: true, filter: (source) => !/[\\/](?:bin|obj)(?:[\\/]|$)/i.test(source) },
);
fs.cpSync(
  path.join(repo, 'fixtures', 'FakeVendor'),
  path.join(workspaceFixture, 'fixtures', 'FakeVendorNet48'),
  { recursive: true, filter: (source) => !/[\\/](?:bin|obj)(?:[\\/]|$)/i.test(source) },
);
writeS122PerformanceForm(
  path.join(workspaceFixture, 'fixtures', 'FakeVendorNet48'),
  'FakeVendor',
  'S122VendorHeavyForm',
  180,
  96,
);
fs.cpSync(
  path.join(repo, 'engine', 'samples'),
  path.join(workspaceFixture, 'engine', 'samples'),
  { recursive: true },
);

// The product reparent scenario must route through a real net48 CustomEditor session, not a modern surrogate. Build the
// disposable fixture immediately before launching VS Code so its Framework output is the freshest multi-target artifact
// and the normal runtime resolver selects the net48 engine. The source is only edited in the CustomDocument buffer;
// the suite restores it through native Undo and asserts disk byte identity.
const net48FixtureProject = path.join(workspaceFixture, 'fixtures', 'Net48CtxFixture', 'Net48CtxFixture.csproj');
const net48Build = spawnSync(
  process.platform === 'win32' ? 'dotnet.exe' : 'dotnet',
  ['build', net48FixtureProject, '-c', 'Release', '-f', 'net48', '--nologo', '-v:q'],
  { cwd: repo, env: { ...process.env, TEMP: testTemp, TMP: testTemp }, stdio: 'inherit' },
);
if (net48Build.error || net48Build.status !== 0) {
  discardWorkspace(workspaceFixture);
  throw net48Build.error ?? new Error(`net48 Extension Host fixture build failed with exit code ${String(net48Build.status)}`);
}
const modernInheritanceProject = path.join(
  workspaceFixture, 'fixtures', 'Net48CtxFixtureModern', 'Net48CtxFixture.csproj');
const modernInheritanceBuild = spawnSync(
  process.platform === 'win32' ? 'dotnet.exe' : 'dotnet',
  ['build', modernInheritanceProject, '-c', 'Release', '-f', 'net10.0-windows',
    '-p:PlatformTarget=x64', '--nologo', '-v:q'],
  { cwd: repo, env: { ...process.env, TEMP: testTemp, TMP: testTemp }, stdio: 'inherit' },
);
if (modernInheritanceBuild.error || modernInheritanceBuild.status !== 0) {
  discardWorkspace(workspaceFixture);
  throw modernInheritanceBuild.error
    ?? new Error(`modern visual-inheritance Extension Host fixture build failed with exit code ${String(modernInheritanceBuild.status)}`);
}
// S094 must discover a real custom ComponentDesigner/DesignerActionList from the disposable project's current output.
// Build the in-repo MIT fixture rather than pointing the product at a repository bin path; this keeps the proof
// workspace-local and preserves the external gate for an actual licensed vendor artifact.
const fakeVendorProject = path.join(workspaceFixture, 'fixtures', 'FakeVendor', 'FakeVendor.csproj');
const fakeVendorBuild = spawnSync(
  process.platform === 'win32' ? 'dotnet.exe' : 'dotnet',
  ['build', fakeVendorProject, '-c', 'Release', '-f', 'net10.0-windows', '-p:PlatformTarget=x64', '--nologo', '-v:q'],
  { cwd: repo, env: { ...process.env, TEMP: testTemp, TMP: testTemp }, stdio: 'inherit' },
);
if (fakeVendorBuild.error || fakeVendorBuild.status !== 0) {
  discardWorkspace(workspaceFixture);
  throw fakeVendorBuild.error ?? new Error(`modern FakeVendor Extension Host fixture build failed with exit code ${String(fakeVendorBuild.status)}`);
}
// S047/S048 need the real compiled-net48 metadata lane without making the modern S093/S094 fixture resolve to its
// Framework output. Build an independent disposable copy so each source has one unambiguous nearest project/output.
const fakeVendorNet48Project = path.join(workspaceFixture, 'fixtures', 'FakeVendorNet48', 'FakeVendor.csproj');
const fakeVendorNet48Build = spawnSync(
  process.platform === 'win32' ? 'dotnet.exe' : 'dotnet',
  ['build', fakeVendorNet48Project, '-c', 'Release', '-f', 'net48', '-p:PlatformTarget=x64', '--nologo', '-v:q'],
  { cwd: repo, env: { ...process.env, TEMP: testTemp, TMP: testTemp }, stdio: 'inherit' },
);
if (fakeVendorNet48Build.error || fakeVendorNet48Build.status !== 0) {
  discardWorkspace(workspaceFixture);
  throw fakeVendorNet48Build.error
    ?? new Error(`net48 FakeVendor Extension Host fixture build failed with exit code ${String(fakeVendorNet48Build.status)}`);
}
try {
  process.env.WFD_HOT_EXIT_PHASE = 'setup';
  try {
    await runTests({
      version,
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [
        workspaceFixture,
        '--new-window',
        `--user-data-dir=${userDataPath}`,
        `--extensions-dir=${extensionsPath}`,
        '--disable-extensions',
        '--skip-welcome',
        '--skip-release-notes',
      ],
    });
  } catch (error) {
    // The setup suite deliberately never resolves after issuing workbench.action.quit: letting extensionTestsPath
    // complete would make the test harness tear down the host before VS Code persists editor state. Consequently the
    // harness reports the user-initiated quit as a failed/incomplete test run. Accept that transition only when the
    // suite reached its post-assertion S003 marker; every earlier assertion/build/launch failure still propagates.
    const setupEvidencePath = path.join(workspaceFixture, '.wfd-s003-hot-exit.json');
    if (!fs.existsSync(setupEvidencePath)) throw error;
    console.log(`S003 setup workbench quit persisted after terminal suite marker: ${version}`);
  }
  const focusedScenario = process.env.WFD_EXTENSION_HOST_S122_ONLY === '1'
    ? 'S122'
    : process.env.WFD_EXTENSION_HOST_S016_ONLY === '1'
      ? 'S016'
    : process.env.WFD_EXTENSION_HOST_S126_ONLY === '1'
      ? 'S126/S128'
      : process.env.WFD_EXTENSION_HOST_S124_ONLY === '1'
        ? 'S124'
        : process.env.WFD_EXTENSION_HOST_S095_ONLY === '1'
          ? 'S095'
        : process.env.WFD_EXTENSION_HOST_S089_ONLY === '1'
          ? 'S089/S090'
          : process.env.WFD_EXTENSION_HOST_S091_ONLY === '1'
            ? 'S091/S092'
            : process.env.WFD_EXTENSION_HOST_S097_ONLY === '1'
              ? 'S097-S099'
              : process.env.WFD_EXTENSION_HOST_S100_S108_ONLY === '1'
                ? 'S100/S108'
                : null;
  if (focusedScenario) {
    console.log(`VS Code Extension Host focused ${focusedScenario} passed: ${version}`);
  } else {
  // The suite now isolates its tail scenarios so one failure no longer skips the rest — which also means the suite
  // can reach its terminal quit WITH failures. The quit is what the catch above forgives, so without this gate a
  // failing run would be reported as a pass. The ledger, not the quit, decides the exit code.
  const ledgerPath = path.join(workspaceFixture, '.wfd-scenario-results.json');
  if (!fs.existsSync(ledgerPath)) {
    throw new Error(`S003 setup produced no scenario ledger at ${ledgerPath}`);
  }
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  const ledgerResults = Array.isArray(ledger?.results) ? ledger.results : [];
  if (ledgerResults.length < 11) {
    throw new Error(`S003 setup scenario ledger is truncated: ${ledgerResults.length} row(s)`);
  }
  const ledgerFailures = ledgerResults.filter((result) => result?.passed !== true);
  if (ledgerFailures.length > 0) {
    // Keep the whole assertion message and drop only the stack: an assertion that names which budget or invariant
    // broke puts that on the lines after the headline, and taking the first line alone reported a CI failure whose
    // reasons had already been thrown away.
    throw new Error(`S003 setup suite reported ${ledgerFailures.length} failed scenario(s): `
      + ledgerFailures
        .map((result) => `${result?.scenarioId}: ${String(result?.error ?? '').split('\n    at ')[0]}`)
        .join(' | '));
  }
  console.log(`VS Code Extension Host tail scenarios all passed (${ledgerResults.length} rows): ${version}`);

  const recoveryRegistries = findNamedFiles(userDataPath, 'hot-exit-recovery-v1.json');
  if (recoveryRegistries.length !== 1) {
    throw new Error(`S003 setup expected one fallback recovery registry, found ${recoveryRegistries.length}`);
  }
  const recoveryRegistry = JSON.parse(fs.readFileSync(recoveryRegistries[0], 'utf8'));
  const recoveryEntries = Object.values(recoveryRegistry?.entries ?? {});
  if (recoveryRegistry?.version !== 1 || recoveryEntries.length !== 2
    || recoveryEntries.some((entry) => typeof entry?.backupId !== 'string'
      || !fs.existsSync(fileURLToPath(entry.backupId)))) {
    throw new Error(`S003 setup recovery registry is incomplete: ${JSON.stringify(recoveryRegistry)}`);
  }
  console.log(`S003 setup persisted two VS Code backup destinations: ${version}`);
  // S003 is a real hot-exit contract, so its restore half runs in a fresh Extension Host process against the same
  // disposable workspace and user-data directory. The first process exits with two dirty CustomEditors and VS Code
  // invokes backupCustomDocument. Extension Development Host keeps editor state in memory, so the suite explicitly
  // reopens each designer and the product consumes its workspace-local index of those VS Code-owned destinations.
  process.env.WFD_HOT_EXIT_PHASE = 'restore';
  if (s003ScenarioEvidenceFile) process.env.WFD_SCENARIO_EVIDENCE_FILE = s003ScenarioEvidenceFile;
  await runTests({
    version,
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [
      // Reopen the exact workspace without --new-window. The explicit folder avoids a platform-default empty window;
      // the restore suite then performs the frozen scenario's explicit designer-reopen action.
      workspaceFixture,
      `--user-data-dir=${userDataPath}`,
      `--extensions-dir=${extensionsPath}`,
      '--disable-extensions',
      '--skip-welcome',
      '--skip-release-notes',
    ],
  });
  console.log(`VS Code Extension Host smoke + S003 hot-exit restore passed: ${version}`);
  }
} catch (error) {
  console.error(`VS Code Extension Host smoke failed: ${version}`);
  console.error(error);
  process.exitCode = 1;
} finally {
  if (process.exitCode && process.env.WFD_KEEP_FAILED_WORKSPACE === '1') {
    console.error(`Preserving failed Extension Host workspace for diagnostics: ${workspaceFixture}`);
  } else {
    discardWorkspace(workspaceFixture);
  }
}

function writeS016DenseForm(root) {
  const source = [
    'namespace SampleApp',
    '{',
    '    public partial class S016DenseForm : System.Windows.Forms.Form',
    '    {',
    '        public S016DenseForm() => InitializeComponent();',
    '    }',
    '}',
    '',
  ].join('\r\n');
  const fields = [];
  const initialize = [];
  const configure = [];
  const add = [];
  for (let index = 0; index < 300; index++) {
    const suffix = String(index).padStart(3, '0');
    const kind = index % 3 === 0 ? 'Button' : index % 3 === 1 ? 'Label' : 'TextBox';
    const id = `${kind[0].toLowerCase()}${kind.slice(1)}${suffix}`;
    const x = 8 + (index % 20) * 38;
    const y = 8 + Math.floor(index / 20) * 26;
    fields.push(`        private System.Windows.Forms.${kind} ${id};`);
    initialize.push(`            this.${id} = new System.Windows.Forms.${kind}();`);
    configure.push(
      `            this.${id}.Location = new System.Drawing.Point(${x}, ${y});`,
      `            this.${id}.Name = "${id}";`,
      `            this.${id}.Size = new System.Drawing.Size(32, 20);`,
      `            this.${id}.Text = "${kind} ${suffix}";`,
    );
    add.push(`            this.Controls.Add(this.${id});`);
  }
  const designer = [
    'namespace SampleApp',
    '{',
    '    partial class S016DenseForm',
    '    {',
    ...fields,
    '',
    '        private void InitializeComponent()',
    '        {',
    ...initialize,
    '            this.SuspendLayout();',
    ...configure,
    ...add,
    '            this.ClientSize = new System.Drawing.Size(780, 410);',
    '            this.Name = "S016DenseForm";',
    '            this.Text = "S016 dense product form";',
    '            this.ResumeLayout(false);',
    '            this.PerformLayout();',
    '        }',
    '    }',
    '}',
    '',
  ].join('\r\n');
  fs.writeFileSync(path.join(root, 'S016DenseForm.cs'), source, 'utf8');
  fs.writeFileSync(path.join(root, 'S016DenseForm.Designer.cs'), designer, 'utf8');
}

function writeS122PerformanceForm(root, namespaceName, className, count, vendorCount) {
  const source = [
    `namespace ${namespaceName}`,
    '{',
    `    public partial class ${className} : System.Windows.Forms.Form`,
    '    {',
    `        public ${className}() => InitializeComponent();`,
    '    }',
    '}',
    '',
  ].join('\r\n');
  const fields = [];
  const initialize = [];
  const configure = [];
  const add = [];
  const standardTypes = ['Button', 'TextBox', 'Label', 'CheckBox', 'ComboBox'];
  for (let index = 0; index < count; index++) {
    const suffix = String(index + 1).padStart(3, '0');
    const vendor = index < vendorCount;
    const typeName = vendor
      ? 'FakeVendor.FancyButton'
      : `System.Windows.Forms.${standardTypes[index % standardTypes.length]}`;
    const id = `control${suffix}`;
    const x = 12 + (index % 10) * 86;
    const y = 12 + Math.floor(index / 10) * 32;
    fields.push(`        private ${typeName} ${id};`);
    initialize.push(`            this.${id} = new ${typeName}();`);
    configure.push(
      `            this.${id}.Location = new System.Drawing.Point(${x}, ${y});`,
      `            this.${id}.Name = "${id}";`,
      `            this.${id}.Size = new System.Drawing.Size(${vendor ? 104 : 78}, 24);`,
      `            this.${id}.Text = "${vendor ? 'Vendor' : 'Control'} ${index + 1}";`,
    );
    add.push(`            this.Controls.Add(this.${id});`);
  }
  const designer = [
    `namespace ${namespaceName}`,
    '{',
    `    partial class ${className}`,
    '    {',
    ...fields,
    '',
    '        private void InitializeComponent()',
    '        {',
    ...initialize,
    '            this.SuspendLayout();',
    ...configure,
    ...add,
    `            this.ClientSize = new System.Drawing.Size(900, ${Math.max(180, 56 + Math.ceil(count / 10) * 32)});`,
    `            this.Name = "${className}";`,
    `            this.Text = "${className}";`,
    '            this.ResumeLayout(false);',
    '            this.PerformLayout();',
    '        }',
    '    }',
    '}',
    '',
  ].join('\r\n');
  fs.writeFileSync(path.join(root, `${className}.cs`), source, 'utf8');
  fs.writeFileSync(path.join(root, `${className}.Designer.cs`), designer, 'utf8');
}

/** Removes the disposable Extension Host workspace.
 *
 * Windows can keep a handle on a file for a moment after the editor and the engines have exited, and `force` only
 * forgives a missing path, not a locked one — so retry. If the directory still will not go, say so and move on:
 * this runs after the suite has already printed its verdict, and a temp directory that outlives the run must not
 * be what decides it. On a CI runner that is exactly what happened — every scenario passed and the step still
 * failed, on an EPERM from the teardown. */
function discardWorkspace(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (error) {
    console.warn(`Could not remove the Extension Host workspace ${target}: ${error?.message ?? error}`);
  }
}
