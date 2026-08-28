import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(scriptDir, '..');
const extensionDir = path.join(repo, 'extension');

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const manifest = readJson(path.join(extensionDir, 'package.json'));
const lock = readJson(path.join(extensionDir, 'package-lock.json'));
const globalJson = readJson(path.join(repo, 'global.json'));
const changelog = fs.readFileSync(path.join(repo, 'CHANGELOG.md'), 'utf8');
const readme = fs.readFileSync(path.join(repo, 'README.md'), 'utf8');
const marketplaceReadme = fs.readFileSync(path.join(extensionDir, 'README.md'), 'utf8');
const engineProject = fs.readFileSync(path.join(repo, 'engine', 'Engine.csproj'), 'utf8');
const net48EngineProject = fs.readFileSync(path.join(repo, 'engine-net48', 'Engine.Net48.csproj'), 'utf8');
const ciWorkflow = fs.readFileSync(path.join(repo, '.github', 'workflows', 'ci.yml'), 'utf8');
const releaseWorkflow = fs.readFileSync(path.join(repo, '.github', 'workflows', 'release.yml'), 'utf8');
const modernBundleScript = fs.readFileSync(path.join(repo, 'scripts', 'bundle-modern-engine.mjs'), 'utf8');
const net48BundleScript = fs.readFileSync(path.join(repo, 'scripts', 'bundle-net48-engine.mjs'), 'utf8');
const assertVsixScript = fs.readFileSync(path.join(repo, 'scripts', 'assert-vsix.ps1'), 'utf8');
const vscodeIgnore = fs.readFileSync(path.join(extensionDir, '.vscodeignore'), 'utf8');
const failures = [];
const metadataOnly = process.argv.includes('--metadata-only');

const expect = (condition, message) => {
  if (!condition) failures.push(message);
};

const version = manifest.version;
expect(/^\d+\.\d+\.\d+$/.test(version), `package.json version must be major.minor.patch, got ${JSON.stringify(version)}`);
expect(manifest.preview === false, 'package.json preview must be false for a stable release');
expect(lock.version === version, `package-lock.json root version ${JSON.stringify(lock.version)} does not match ${version}`);
expect(lock.packages?.['']?.version === version,
  `package-lock.json packages[""] version ${JSON.stringify(lock.packages?.['']?.version)} does not match ${version}`);
expect(manifest.packageManager === 'npm@11.9.0',
  `package.json packageManager must pin npm@11.9.0, got ${JSON.stringify(manifest.packageManager)}`);
expect(fs.readFileSync(path.join(repo, '.node-version'), 'utf8').trim() === '24.14.0',
  '.node-version must pin Node 24.14.0');
const lockCandidates = [
  'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock',
  'extension/package-lock.json', 'extension/npm-shrinkwrap.json', 'extension/pnpm-lock.yaml', 'extension/yarn.lock',
].filter((relative) => fs.existsSync(path.join(repo, relative)));
expect(lockCandidates.length === 1 && lockCandidates[0] === 'extension/package-lock.json',
  `exactly extension/package-lock.json must define the JavaScript dependency graph, found: ${lockCandidates.join(', ') || '(none)'}`);
for (const section of ['dependencies', 'devDependencies']) {
  for (const [name, specifier] of Object.entries(manifest[section] ?? {})) {
    expect(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(specifier),
      `package.json ${section}.${name} must be an exact version, got ${JSON.stringify(specifier)}`);
  }
}
expect(manifest.capabilities?.untrustedWorkspaces?.supported === false,
  'untrustedWorkspaces.supported must be false');
expect(manifest.capabilities?.virtualWorkspaces?.supported === false,
  'virtualWorkspaces.supported must be false');
expect(manifest.extensionKind?.includes('workspace'), 'extensionKind must include workspace');
expect(new RegExp(`^##\\s*\\[${version.replace(/\./g, '\\.')}\\]`, 'm').test(changelog),
  `CHANGELOG.md has no ## [${version}] section`);
const [major, minor] = version.split('.');
expect(readme.includes(`Version ${major}.${minor}`) && readme.includes(`version-${major}.${minor}-brightgreen.svg`),
  `README.md version badge must advertise ${major}.${minor}`);
expect(marketplaceReadme.includes(`**${version}.**`),
  `extension/README.md release banner must advertise ${version}`);
expect(/^10\./.test(globalJson.sdk?.version ?? ''),
  `global.json must pin the .NET 10 SDK for v${version}, got ${JSON.stringify(globalJson.sdk?.version)}`);
expect(/<TargetFramework>net10\.0-windows<\/TargetFramework>/.test(engineProject),
  'engine/Engine.csproj must target net10.0-windows');
for (const [name, project] of [['modern', engineProject], ['net48', net48EngineProject]]) {
  expect(project.includes(`<Version>${version}</Version>`), `${name} engine Version must be ${version}`);
  expect(project.includes(`<AssemblyVersion>${version}.0</AssemblyVersion>`), `${name} engine AssemblyVersion must be ${version}.0`);
  expect(project.includes(`<FileVersion>${version}.0</FileVersion>`), `${name} engine FileVersion must be ${version}.0`);
  expect(project.includes(`<InformationalVersion>${version}</InformationalVersion>`),
    `${name} engine InformationalVersion must be ${version}`);
}

// The Marketplace description advertises the runtime users must install, so every locale's
// ".NET <major>" token has to track the engine's real TargetFramework.
const engineMajor = /<TargetFramework>net(\d+)\.0-windows<\/TargetFramework>/.exec(engineProject)?.[1];
expect(engineMajor !== undefined,
  'engine/Engine.csproj TargetFramework must look like net<major>.0-windows so the nls .NET version can be checked');
if (engineMajor !== undefined) {
  for (const nlsFile of fs.readdirSync(extensionDir).filter((file) => /^package\.nls(\..+)?\.json$/.test(file))) {
    const description = readJson(path.join(extensionDir, nlsFile)).description ?? '';
    for (const [token, major] of description.matchAll(/\.NET\s*(\d+)/g)) {
      expect(major === engineMajor,
        `${nlsFile} description says ${JSON.stringify(token)} but the engine targets net${engineMajor}.0-windows — update the .NET version token in that locale`);
    }
  }
}
expect(manifest.scripts?.test === 'vitest run', 'package.json test script must run the fast Vitest layer');
expect(manifest.scripts?.['perf:baseline'] === 'node dist/performance-baseline.cjs',
  'package.json perf:baseline script is missing or changed');
expect(manifest.scripts?.['bundle-engine'] === 'node ../scripts/bundle-modern-engine.mjs',
  'package.json bundle-engine must use the isolated modern-engine staging helper');
expect(manifest.scripts?.['bundle-engine:x64'] === 'node ../scripts/bundle-modern-engine.mjs --rid=win-x64',
  'package.json bundle-engine:x64 must explicitly request win-x64');
expect(manifest.scripts?.['bundle-engine:arm64'] === 'node ../scripts/bundle-modern-engine.mjs --rid=win-arm64',
  'package.json bundle-engine:arm64 must explicitly request win-arm64');
expect(manifest.scripts?.['bundle-engine-net48'] === 'node ../scripts/bundle-net48-engine.mjs',
  'package.json bundle-engine-net48 must use the isolated net48 staging helper');
expect(modernBundleScript.includes('fs.rmSync(outputDir, { recursive: true, force: true })')
  && modernBundleScript.includes("'net10.0-windows'")
  && modernBundleScript.includes('deps.json does not contain target RID'),
  'scripts/bundle-modern-engine.mjs must clean staging and verify the requested net10 RID');
expect(net48BundleScript.includes('fs.rmSync(outputDir, { recursive: true, force: true })')
  && net48BundleScript.includes("'-p:PlatformTarget=x64'")
  && net48BundleScript.includes('.NETFramework,Version=v4.8'),
  'scripts/bundle-net48-engine.mjs must clean staging and verify the x64 net48 compatibility host');
expect(assertVsixScript.includes('wrong target directory')
  && assertVsixScript.includes('.NETFramework,Version=v4\\.8')
  && assertVsixScript.includes('does not have an MZ header')
  && assertVsixScript.includes('also contains $unexpectedRuntimeIdentifier targets')
  && assertVsixScript.includes('v2-headless-validate\\.cjs$')
  && assertVsixScript.includes('v2-soak\\.cjs$'),
  'scripts/assert-vsix.ps1 must enforce cross-target isolation, net48 TFM, PE headers, sibling RID absence, and dev-CLI absence');
expect(vscodeIgnore.includes('dist/v2-headless-validate.cjs')
  && vscodeIgnore.includes('dist/v2-soak.cjs'),
  'extension/.vscodeignore must exclude the development-only v2 headless and soak CLIs');

for (const relative of [
  'tests/Engine.UnitTests/Engine.UnitTests.csproj',
  'tests/Engine.Net48.UnitTests/Engine.Net48.UnitTests.csproj',
  'extension/src/engineRecovery.test.ts',
  'extension/src/valueExpr.test.ts',
  'extension/src/performance-baseline.ts',
  'scripts/test-vsix-isolation.ps1',
  'scripts/test-v2-execution-evidence-gate.mjs',
  'scripts/collect-v2-test-evidence.mjs',
  'scripts/reconcile-v2-catalog-evidence.mjs',
  'scripts/validate-v2-execution-evidence.mjs',
  'scripts/validate-v2-scenario-catalog.ps1',
  'scripts/capture-visual-studio-reference-traces.ps1',
  'fixtures/VisualStudioReference/Modern/VisualStudioReference.Modern.csproj',
  'fixtures/VisualStudioReference/Net48/VisualStudioReference.Net48.csproj',
  'docs/v2/reference-traces/README.md',
]) {
  expect(fs.existsSync(path.join(repo, relative)), `${relative} is required by the strengthened 1.0 release gate`);
}
for (const [name, workflow] of [['CI', ciWorkflow], ['Release', releaseWorkflow]]) {
  expect(workflow.includes('dotnet test tests/Engine.UnitTests -c Release'),
    `${name} workflow must run the engine unit tests`);
  expect(workflow.includes('dotnet test tests/Engine.Net48.UnitTests -c Release'),
    `${name} workflow must run the net48 engine unit tests (ADR 0001 net48 unit floor)`);
  expect(workflow.includes('dotnet run --project engine -c Release --coverage-report engine/samples --min-rate 80'),
    `${name} workflow must run the M6 sample-corpus coverage gate`);
  expect(workflow.includes('run: ./scripts/test-vsix-isolation.ps1'),
    `${name} workflow must run the VSIX packaging isolation tests`);
  expect(workflow.includes('run: ./scripts/validate-v2-scenario-catalog.ps1 -StaticOnly'),
    `${name} workflow must validate the catalog shape and archived traces before running suites`);
  expect(workflow.includes("run: ./scripts/validate-v2-scenario-catalog.ps1 -EvidenceDirectory (Join-Path $env:RUNNER_TEMP 'v2-scenario-evidence')")
    && workflow.includes('WFD_SCENARIO_EVIDENCE_FILE:')
    && (workflow.match(/WFD_SCENARIO_EVIDENCE_DIR:/g) || []).length >= 2,
    `${name} workflow must derive repository PASS from fresh webview and Extension Host reports`);
  expect(workflow.includes('run: node ./scripts/test-v2-execution-evidence-gate.mjs'),
    `${name} workflow must prove removal of an executed assertion invalidates repository PASS`);
  expect(workflow.includes('name: v2-scenario-evidence'),
    `${name} workflow must retain the measured scenario evidence artifact`);
  expect(workflow.includes('run: node ./scripts/generate-v2-protocol.mjs --check'),
    `${name} workflow must reject stale generated v2 protocol bindings`);
  expect(workflow.includes('npm test -- --reporter=json'), `${name} workflow must run the extension unit tests with a machine-readable result`);
  expect((workflow.match(/collect-v2-test-evidence\.mjs --kind=xunit/g) || []).length >= 2
    && workflow.includes('collect-v2-test-evidence.mjs --kind=vitest'),
    `${name} workflow must derive unit scenario evidence from both xUnit lanes and Vitest`);
  expect(workflow.includes('run: npm run perf:baseline'), `${name} workflow must run the performance baseline`);
  expect(workflow.includes('node --check media/designer.js')
    && workflow.includes('node --check media/panel.js')
    && workflow.includes('node --check media/chooseItems.js'),
  `${name} workflow must syntax-check every shipped webview script`);
  expect(workflow.includes('run: npm run mojibake:scan'),
    `${name} workflow must run the mojibake scan (a CP1251/Latin-1 round trip passes every other gate)`);
  expect(workflow.includes('10.0.x'), `${name} workflow must install the .NET 10 SDK`);
  expect(workflow.includes('node-version: "24.14.0"'), `${name} workflow must pin Node 24.14.0`);
  expect(workflow.includes('cache-dependency-path: extension/package-lock.json')
    && workflow.includes('run: npm ci'), `${name} workflow must use the single npm lockfile/toolchain`);
  expect(workflow.includes('--target win32-x64'), `${name} workflow must package win32-x64`);
  expect(workflow.includes('--target win32-arm64'), `${name} workflow must package win32-arm64`);
  expect(workflow.includes('WFD_BUNDLE_RID: win-x64'), `${name} workflow must explicitly stage the win-x64 engine`);
  expect(workflow.includes('WFD_BUNDLE_RID: win-arm64'), `${name} workflow must explicitly stage the win-arm64 engine`);
  expect(workflow.includes('ExpectedRuntimeIdentifier win-x64'), `${name} workflow must assert the win-x64 engine RID`);
  expect(workflow.includes('ExpectedRuntimeIdentifier win-arm64'), `${name} workflow must assert the win-arm64 engine RID`);
  expect(workflow.includes('frozen-win32-x64.vsix') && workflow.includes('frozen-win32-arm64.vsix'),
    `${name} workflow must freeze each verified target before the shared engine staging directory changes`);
  expect((workflow.match(/ExpectedRuntimeIdentifier win-x64/g) || []).length >= 2
    && (workflow.match(/ExpectedRuntimeIdentifier win-arm64/g) || []).length >= 2,
  `${name} workflow must re-verify both restored immutable artifacts after cross-target packaging`);
}

const explicitTag = process.argv.find((arg) => arg.startsWith('--tag='))?.slice('--tag='.length);
const envTag = process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : undefined;
const tag = explicitTag || envTag;
if (tag) {
  expect(tag === `v${version}`, `release tag ${JSON.stringify(tag)} must equal v${version}`);
}

const git = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true });
if (!metadataOnly) {
  const status = git('status', '--porcelain=v1', '--untracked-files=all');
  expect(status.status === 0, `git status failed: ${(status.stderr || status.stdout || '').trim()}`);
  if (status.status === 0) {
    const changes = status.stdout.split(/\r?\n/).filter(Boolean);
    expect(changes.length === 0,
      `release worktree must be clean; found ${changes.length} changed path(s), first: ${changes.slice(0, 5).join(', ')}`);
  }

  if (tag === `v${version}`) {
    const head = git('rev-parse', 'HEAD');
    const target = git('rev-parse', '--verify', `refs/tags/${tag}^{}`);
    expect(head.status === 0, `could not resolve release HEAD: ${(head.stderr || '').trim()}`);
    expect(target.status === 0, `release tag ${tag} does not exist in the checkout`);
    if (head.status === 0 && target.status === 0) {
      expect(head.stdout.trim() === target.stdout.trim(),
        `release tag ${tag} targets ${target.stdout.trim()}, but checkout HEAD is ${head.stdout.trim()}`);
    }
  }
}

if (failures.length) {
  console.error('release preflight failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

if (metadataOnly) {
  console.log(`release metadata preflight ok: v${version} (git cleanliness/tag identity intentionally not checked)`);
} else {
  console.log(`release preflight ok: v${version}${tag ? ` (${tag}; clean exact target)` : ' (clean tree; tag not requested)'}`);
}
