import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { productFiles, repositoryHead } from './v2-evidence-provenance.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const evidenceArgument = process.argv.find((argument) => argument.startsWith('--evidence-dir='));
const evidenceDirectory = path.resolve(repoRoot, evidenceArgument?.slice('--evidence-dir='.length)
  ?? '.codex-tmp/v2-scenario-evidence');
const validator = path.join(scriptDir, 'validate-v2-execution-evidence.mjs');
const collector = path.join(scriptDir, 'collect-v2-test-evidence.mjs');
const catalogRelative = 'docs/v2/vs-parity-scenario-catalog.tsv';
const currentHead = repositoryHead(repoRoot);

if (!fs.existsSync(evidenceDirectory)) throw new Error(`evidence directory does not exist: ${evidenceDirectory}`);
const reportFiles = fs.readdirSync(evidenceDirectory)
  .filter((name) => name.endsWith('.json') && name !== 'catalog-measured-evidence.json')
  .map((name) => path.join(evidenceDirectory, name));
if (reportFiles.length === 0) throw new Error('no scenario evidence reports are available for the gate self-test');

withFixture('baseline', ({ tempRoot, tempEvidence }) => {
  const baseline = runValidator(tempRoot, tempEvidence);
  if (baseline.status !== 0) {
    throw new Error(`full-tree gate self-test fixture did not validate before mutation:\n${outputOf(baseline)}`);
  }
});

withFixture('removed-assertion', ({ tempRoot, tempEvidence }) => {
  const target = firstPassingAnchor(tempEvidence);
  const targetFile = path.join(tempRoot, target.file);
  const lines = fs.readFileSync(targetFile, 'utf8').split(/\r?\n/);
  lines[target.line - 1] = '// evidence anchor deliberately removed by acceptance test';
  fs.writeFileSync(targetFile, lines.join('\n'), 'utf8');
  expectFailure(
    'removed executed assertion',
    runValidator(tempRoot, tempEvidence),
    /assertion (?:file|line) changed after execution/,
  );
  console.log(`NEGATIVE CONTROL 1 PASS: removing ${target.file}:${target.line} invalidated catalog PASS`);
});

withFixture('product-mutation', ({ tempRoot, tempEvidence }) => {
  const productFile = path.join(tempRoot, 'engine', 'SaveSafety.cs');
  if (!fs.existsSync(productFile)) throw new Error('product binding control cannot locate engine/SaveSafety.cs');
  fs.appendFileSync(productFile, '\n// product mutation deliberately injected by evidence-gate acceptance test\n', 'utf8');
  expectFailure(
    'product tree mutation',
    runValidator(tempRoot, tempEvidence),
    /product tree changed after measurement/,
  );
  console.log('PRODUCT BINDING CONTROL PASS: changing engine/SaveSafety.cs invalidated all measured reports');
});

withFixture('quoted-tsv', ({ tempRoot, tempEvidence }) => {
  const catalogFile = path.join(tempRoot, catalogRelative);
  const lines = fs.readFileSync(catalogFile, 'utf8').split(/\r?\n/);
  const header = lines[0].split('\t');
  const rowIndex = lines.findIndex((line) => line.includes('V2-FND-001-S113'));
  if (rowIndex < 1) throw new Error('quoted TSV control cannot locate S113');
  const cells = lines[rowIndex].split('\t');
  const replacements = {
    repoExecutionStatus: 'PASS',
    repoAutomationStatus: 'AUTOMATED',
    repoEvidenceRefs: 'MEASURED_AT_RUNTIME',
    testKinds: 'unit',
    architectureLegs: 'not-applicable;repo-functional',
    claimBoundary: 'REPO_AUTOMATED',
    repoEvidenceState: 'MEASURED_SUFFICIENT',
    repoEvidenceReason: 'NONE',
  };
  for (const [name, value] of Object.entries(replacements)) cells[header.indexOf(name)] = `"${value}"`;
  lines[rowIndex] = cells.join('\t');
  fs.writeFileSync(catalogFile, lines.join('\n'), 'utf8');
  expectFailure(
    'quoted TSV promotion',
    runValidator(tempRoot, tempEvidence),
    /S113 declares repository PASS|catalog PASS count 112 differs from measuredPassCount 111/,
  );
  console.log('NEGATIVE CONTROL 2 PASS: quoted TSV cells are decoded and cannot bypass measured evidence');
});

withFixture('handwritten-report', ({ tempRoot, tempEvidence }) => {
  const source = reportFiles[0];
  const forged = JSON.parse(fs.readFileSync(source, 'utf8'));
  forged.invocation = 'handwritten-untrusted-report';
  fs.writeFileSync(path.join(tempEvidence, 'handwritten.json'), `${JSON.stringify(forged, null, 2)}\n`, 'utf8');
  expectFailure(
    'handwritten report',
    runValidator(tempRoot, tempEvidence),
    /unexpected evidence report is forbidden: handwritten\.json/,
  );
  console.log('NEGATIVE CONTROL 3 PASS: an unexpected handwritten report is rejected');
});

withFixture('trivial-fact', ({ tempRoot, tempEvidence }) => {
  const testFile = path.join(tempRoot, 'tests', 'Engine.UnitTests', 'TrivialEvidenceAttackTests.cs');
  fs.mkdirSync(path.dirname(testFile), { recursive: true });
  fs.writeFileSync(testFile, [
    'using Xunit;',
    'namespace Engine.UnitTests;',
    'public sealed class TrivialEvidenceAttackTests',
    '{',
    '    [Fact(DisplayName = "V2-FND-001-S121 forged evidence")]',
    '    public void TrivialFact() { Assert.True(true); }',
    '}',
    '',
  ].join('\n'), 'utf8');
  const trxFile = path.join(tempEvidence, 'test-results', 'trivial.trx');
  fs.mkdirSync(path.dirname(trxFile), { recursive: true });
  fs.writeFileSync(trxFile, [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<TestRun>',
    '  <Results><UnitTestResult testId="attack-1" testName="V2-FND-001-S121 forged evidence" outcome="Passed" /></Results>',
    '  <TestDefinitions><UnitTest id="attack-1" name="V2-FND-001-S121 forged evidence"><TestMethod className="Engine.UnitTests.TrivialEvidenceAttackTests" name="TrivialFact" /></UnitTest></TestDefinitions>',
    '  <ResultSummary><Counters total="1" executed="1" passed="1" failed="0" error="0"></Counters></ResultSummary>',
    '</TestRun>',
    '',
  ].join('\n'), 'utf8');
  const collected = spawnSync(process.execPath, [
    collector,
    `--repo-root=${tempRoot}`,
    '--kind=xunit',
    `--input=${trxFile}`,
    `--output=${path.join(tempEvidence, 'trivial.json')}`,
    '--invocation=trivial-fact-attack',
    `--repository-head=${currentHead}`,
  ], { encoding: 'utf8', windowsHide: true });
  expectFailure('trivial Fact collector attack', collected, /lacks explicit V2Scenario Trait for V2-FND-001-S121/);
  console.log('NEGATIVE CONTROL 4 PASS: a trivial DisplayName Fact without an explicit scenario binding is rejected');
});

console.log('V2 evidence gate adversarial acceptance PASS: 4/4 required controls plus product-tree mutation exited nonzero');

function withFixture(label, action) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `wfd-v2-evidence-${label}-`));
  try {
    copyRelative(catalogRelative, tempRoot);
    for (const productFile of productFiles(repoRoot)) copyRelative(path.relative(repoRoot, productFile), tempRoot);
    const tempEvidence = path.join(tempRoot, 'evidence');
    fs.cpSync(evidenceDirectory, tempEvidence, { recursive: true, preserveTimestamps: true });
    const assertionFiles = new Set();
    for (const reportFile of reportFiles) {
      const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
      for (const result of report.results ?? []) {
        for (const assertion of result.assertions ?? []) assertionFiles.add(assertion.file);
      }
    }
    for (const relative of assertionFiles) copyRelative(relative, tempRoot);
    action({ tempRoot, tempEvidence });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function firstPassingAnchor(tempEvidence) {
  let fallback;
  for (const name of fs.readdirSync(tempEvidence).filter((candidate) => candidate.endsWith('.json')).sort()) {
    if (name === 'catalog-measured-evidence.json') continue;
    const report = JSON.parse(fs.readFileSync(path.join(tempEvidence, name), 'utf8'));
    const target = report.results?.find((result) => result.status === 'PASS' && result.assertions?.length > 0)?.assertions[0];
    if (target?.file?.startsWith('tests/')) return target;
    fallback ??= target;
  }
  if (fallback) return fallback;
  throw new Error('no passing evidence anchor is available for the gate self-test');
}

function copyRelative(relative, tempRoot) {
  const source = path.join(repoRoot, relative);
  const destination = path.join(tempRoot, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

function runValidator(root, evidence) {
  return spawnSync(process.execPath, [
    validator,
    `--repo-root=${root}`,
    `--catalog=${catalogRelative}`,
    `--evidence-dir=${evidence}`,
    `--expected-repository-head=${currentHead}`,
  ], { encoding: 'utf8', windowsHide: true });
}

function expectFailure(label, result, expected) {
  if (result.status === 0) throw new Error(`${label} unexpectedly exited 0`);
  const output = outputOf(result);
  if (!expected.test(output)) throw new Error(`${label} failed for an unrelated reason:\n${output}`);
}

function outputOf(result) {
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}
