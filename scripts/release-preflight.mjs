import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(scriptDir, '..');
const extensionDir = path.join(repo, 'extension');

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const manifest = readJson(path.join(extensionDir, 'package.json'));
const lock = readJson(path.join(extensionDir, 'package-lock.json'));
const globalJson = readJson(path.join(repo, 'global.json'));
const changelog = fs.readFileSync(path.join(repo, 'CHANGELOG.md'), 'utf8');
const engineProject = fs.readFileSync(path.join(repo, 'engine', 'Engine.csproj'), 'utf8');
const ciWorkflow = fs.readFileSync(path.join(repo, '.github', 'workflows', 'ci.yml'), 'utf8');
const releaseWorkflow = fs.readFileSync(path.join(repo, '.github', 'workflows', 'release.yml'), 'utf8');
const failures = [];

const expect = (condition, message) => {
  if (!condition) failures.push(message);
};

const version = manifest.version;
expect(/^\d+\.\d+\.\d+$/.test(version), `package.json version must be major.minor.patch, got ${JSON.stringify(version)}`);
expect(manifest.preview === false, 'package.json preview must be false for a stable release');
expect(lock.version === version, `package-lock.json root version ${JSON.stringify(lock.version)} does not match ${version}`);
expect(lock.packages?.['']?.version === version,
  `package-lock.json packages[""] version ${JSON.stringify(lock.packages?.['']?.version)} does not match ${version}`);
expect(manifest.capabilities?.untrustedWorkspaces?.supported === false,
  'untrustedWorkspaces.supported must be false');
expect(manifest.capabilities?.virtualWorkspaces?.supported === false,
  'virtualWorkspaces.supported must be false');
expect(manifest.extensionKind?.includes('workspace'), 'extensionKind must include workspace');
expect(new RegExp(`^##\\s*\\[${version.replace(/\./g, '\\.')}\\]`, 'm').test(changelog),
  `CHANGELOG.md has no ## [${version}] section`);
expect(/^10\./.test(globalJson.sdk?.version ?? ''),
  `global.json must pin the .NET 10 SDK for v${version}, got ${JSON.stringify(globalJson.sdk?.version)}`);
expect(/<TargetFramework>net10\.0-windows<\/TargetFramework>/.test(engineProject),
  'engine/Engine.csproj must target net10.0-windows');

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

for (const relative of [
  'tests/Engine.UnitTests/Engine.UnitTests.csproj',
  'tests/Engine.Net48.UnitTests/Engine.Net48.UnitTests.csproj',
  'extension/src/engineRecovery.test.ts',
  'extension/src/valueExpr.test.ts',
  'extension/src/performance-baseline.ts',
]) {
  expect(fs.existsSync(path.join(repo, relative)), `${relative} is required by the strengthened 1.0 release gate`);
}
for (const [name, workflow] of [['CI', ciWorkflow], ['Release', releaseWorkflow]]) {
  expect(workflow.includes('dotnet test tests/Engine.UnitTests -c Release'),
    `${name} workflow must run the engine unit tests`);
  expect(workflow.includes('dotnet test tests/Engine.Net48.UnitTests -c Release'),
    `${name} workflow must run the net48 engine unit tests (ADR 0001 net48 unit floor)`);
  expect(workflow.includes('run: npm test'), `${name} workflow must run the extension unit tests`);
  expect(workflow.includes('run: npm run perf:baseline'), `${name} workflow must run the performance baseline`);
  expect(workflow.includes('10.0.x'), `${name} workflow must install the .NET 10 SDK`);
}

const explicitTag = process.argv.find((arg) => arg.startsWith('--tag='))?.slice('--tag='.length);
const envTag = process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : undefined;
const tag = explicitTag || envTag;
if (tag) {
  expect(tag === `v${version}`, `release tag ${JSON.stringify(tag)} must equal v${version}`);
}

if (failures.length) {
  console.error('release preflight failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`release preflight ok: v${version}${tag ? ` (${tag})` : ''}`);
