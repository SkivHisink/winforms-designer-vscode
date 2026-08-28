import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');
const option = (name, fallback) => {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length) ?? fallback;
};
const catalogPath = path.resolve(repositoryRoot, option('catalog', 'docs/v2/vs-parity-scenario-catalog.tsv'));
const evidenceDirectory = path.resolve(repositoryRoot, option('evidence-dir', '.codex-tmp/v2-scenario-evidence'));
const write = process.argv.includes('--write');

const echoHarnessOnly = new Set([
  'V2-FND-001-S113', 'V2-FND-001-S114', 'V2-FND-001-S115', 'V2-FND-001-S116',
  'V2-FND-001-S117', 'V2-FND-001-S119', 'V2-FND-001-S121', 'V2-FND-001-S123',
  'V2-FND-001-S125', 'V2-FND-001-S127',
]);
const refusalCorrections = new Map(Object.entries({
  'V2-FND-001-S007': 'invalidName',
  'V2-FND-001-S008': 'applyFailed',
  'V2-FND-001-S024': 'NONE',
  'V2-FND-001-S032': 'designer.status.spacingSameParent',
  'V2-FND-001-S044': 'NONE',
  'V2-FND-001-S052': 'handler method not found',
  'V2-FND-001-S068': 'has no DropDownItems collection',
  'V2-FND-001-S080': 'transaction refused before first write',
  'V2-FND-001-S088': 'not public or protected',
  'V2-FND-001-S092': 'Unsupported',
  'V2-FND-001-S099': 'ADAPTER_PROTOCOL_UNSUPPORTED',
  'V2-FND-001-S103': 'NONE',
}));

const document = readTsv(catalogPath);
const measured = readMeasuredEvidence(evidenceDirectory);
const changes = [];
for (const row of document.rows) {
  const correctedRefusal = refusalCorrections.get(row.scenarioId);
  if (correctedRefusal && row.refusal !== correctedRefusal) {
    changes.push(`${row.scenarioId} refusal ${row.refusal} -> ${correctedRefusal}`);
    row.refusal = correctedRefusal;
  }
  const forcedHarnessOnly = echoHarnessOnly.has(row.scenarioId);
  const testKinds = new Set(row.testKinds.split(';').filter(Boolean));
  const suites = measured.get(row.scenarioId) ?? new Set();
  const hasMatchingEvidence = [...suites].some((suite) => testKinds.has(suiteTestKind(suite)));
  const ordinaryReconciledDowngrade = row.repoExecutionStatus === 'NOT_EXECUTED'
    && row.notes.includes('Evidence-integrity reconciliation: no completed matching suite reported a direct assertion anchor;');
  if (ordinaryReconciledDowngrade && hasMatchingEvidence) {
    row.repoExecutionStatus = 'PASS';
    row.repoAutomationStatus = 'AUTOMATED';
    row.repoEvidenceRefs = 'MEASURED_AT_RUNTIME';
    row.repoEvidenceState = 'MEASURED_SUFFICIENT';
    row.repoEvidenceReason = 'NONE';
    const legs = row.architectureLegs.split(';').filter(Boolean);
    if (!legs.includes('repo-functional')) legs.push('repo-functional');
    row.architectureLegs = legs.join(';');
    row.claimBoundary = 'REPO_AUTOMATED';
    row.notes = row.notes.replace(/\s*Evidence-integrity reconciliation: no completed matching suite reported a direct assertion anchor; no repository PASS\./, '').trim();
    changes.push(`${row.scenarioId} NOT_EXECUTED -> PASS (new measured suite)`);
    continue;
  }
  if (row.repoExecutionStatus !== 'PASS') continue;

  if (!forcedHarnessOnly && hasMatchingEvidence) {
    if (row.repoEvidenceRefs !== 'MEASURED_AT_RUNTIME') {
      changes.push(`${row.scenarioId} PASS evidence -> MEASURED_AT_RUNTIME`);
      row.repoEvidenceRefs = 'MEASURED_AT_RUNTIME';
    }
    row.repoEvidenceState = 'MEASURED_SUFFICIENT';
    row.repoEvidenceReason = 'NONE';
    continue;
  }

  row.repoExecutionStatus = 'NOT_EXECUTED';
  row.repoAutomationStatus = forcedHarnessOnly ? 'HARNESS_ONLY' : 'NOT_AUTOMATED';
  row.repoEvidenceRefs = 'UNSET';
  row.repoEvidenceState = 'NOT_MEASURED';
  row.repoEvidenceReason = 'NONE';
  row.architectureLegs = row.architectureLegs.split(';').filter((leg) => leg !== 'repo-functional').join(';');
  row.claimBoundary = forcedHarnessOnly ? 'HARNESS_ONLY' : 'REPO_PARTIAL';
  const note = forcedHarnessOnly
    ? 'Evidence-integrity reconciliation: caller-supplied capability inspection is not product execution; no repository PASS.'
    : 'Evidence-integrity reconciliation: no completed matching suite reported a direct assertion anchor; no repository PASS.';
  if (!row.notes.includes('Evidence-integrity reconciliation:')) row.notes = `${row.notes} ${note}`.trim();
  changes.push(`${row.scenarioId} PASS -> ${row.repoExecutionStatus} (${row.repoAutomationStatus})`);
}

const counts = countBy(document.rows, (row) => row.repoExecutionStatus);
console.log(`Catalog reconciliation candidate: ${JSON.stringify(counts)}`);
console.log(`Runtime reports: ${[...measured.values()].reduce((total, suites) => total + suites.size, 0)} scenario/suite pairs`);
for (const change of changes) console.log(change);
if (write) {
  const serialized = [document.header.join('\t'), ...document.rows.map((row) => document.header.map((name) => row[name]).join('\t'))]
    .join('\n');
  fs.writeFileSync(catalogPath, `${serialized}\n`, 'utf8');
  console.log(`Wrote ${path.relative(repositoryRoot, catalogPath)} (${changes.length} changes)`);
} else {
  console.log('Dry run only; pass --write to update the catalog.');
}

function readMeasuredEvidence(directory) {
  if (!fs.existsSync(directory)) throw new Error(`evidence directory does not exist: ${directory}`);
  const measured = new Map();
  const reports = fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json') && entry.name !== 'catalog-measured-evidence.json');
  if (reports.length === 0) throw new Error(`no runtime reports in ${directory}`);
  for (const entry of reports) {
    const report = JSON.parse(fs.readFileSync(path.join(directory, entry.name), 'utf8'));
    if (report.schemaVersion !== 'v2-scenario-evidence.2' || report.completed !== true) continue;
    for (const result of report.results ?? []) {
      if (result.status !== 'PASS' || !Number.isInteger(result.assertionCount) || result.assertionCount < 1
          || !Array.isArray(result.assertions) || result.assertions.length < 1) continue;
      const suites = measured.get(result.scenarioId) ?? new Set();
      suites.add(report.suite);
      measured.set(result.scenarioId, suites);
    }
  }
  return measured;
}

function readTsv(file) {
  const lines = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trimEnd().split(/\r?\n/);
  const header = lines.shift().split('\t');
  const rows = lines.map((line, index) => {
    const cells = line.split('\t');
    if (cells.length !== header.length) throw new Error(`catalog line ${index + 2} has ${cells.length}/${header.length} columns`);
    return Object.fromEntries(header.map((name, cellIndex) => [name, cells[cellIndex]]));
  });
  return { header, rows };
}

function suiteTestKind(suite) {
  return suite === 'unit' ? 'unit' : suite;
}

function countBy(values, selector) {
  return Object.fromEntries([...values.reduce((counts, value) => {
    const key = selector(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    return counts;
  }, new Map()).entries()].sort(([left], [right]) => left.localeCompare(right)));
}
