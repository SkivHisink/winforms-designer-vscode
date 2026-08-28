import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { productFiles, productTree, repositoryHead } from './v2-evidence-provenance.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(scriptDir, '..');
const option = (name, fallback) => {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length) ?? fallback;
};

const repoRoot = path.resolve(option('repo-root', defaultRepoRoot));
const catalogPath = path.resolve(repoRoot, option('catalog', 'docs/v2/vs-parity-scenario-catalog.tsv'));
const evidenceDirectory = path.resolve(repoRoot, option('evidence-dir', '.codex-tmp/v2-scenario-evidence'));
const expectedStaticPassCount = option('static-pass-count');
const maxEvidenceAgeHours = Number(option('max-age-hours', '24'));
const errors = [];
const warnings = [];
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const expectedHead = repositoryHead(repoRoot, option('expected-repository-head'));
const expectedProduct = productTree(repoRoot);
const expectedReports = new Map([
  ['extension-host-1.84.0-s003.json', { suite: 'extension-host', producer: 'runtime-recorder:extension-host' }],
  ['extension-host-1.84.0.json', { suite: 'extension-host', producer: 'runtime-recorder:extension-host' }],
  ['extension-host-stable-s003.json', { suite: 'extension-host', producer: 'runtime-recorder:extension-host' }],
  ['extension-host-stable.json', { suite: 'extension-host', producer: 'runtime-recorder:extension-host' }],
  ['visual-reference.json', { suite: 'e2e', producer: 'visual-reference' }],
  ['vitest.json', { suite: 'unit', producer: 'test-collector:vitest', source: true }],
  ['webview.json', { suite: 'webview', producer: 'runtime-recorder:webview' }],
  ['xunit-modern.json', { suite: 'unit', producer: 'test-collector:xunit', source: true }],
  ['xunit-net48.json', { suite: 'unit', producer: 'test-collector:xunit', source: true }],
]);

if (!Number.isFinite(maxEvidenceAgeHours) || maxEvidenceAgeHours <= 0) {
  throw new Error('--max-age-hours must be a positive number');
}
if (process.argv.includes('--skip-refusal-check')) {
  throw new Error('--skip-refusal-check was removed; the evidence gate always validates the product tree');
}

const catalog = readTsv(catalogPath);
const reportFiles = fs.existsSync(evidenceDirectory)
  ? fs.readdirSync(evidenceDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json') && entry.name !== 'catalog-measured-evidence.json')
    .map((entry) => path.join(evidenceDirectory, entry.name))
    .sort()
  : [];
const actualReportNames = new Set(reportFiles.map((file) => path.basename(file)));
for (const name of expectedReports.keys()) {
  if (!actualReportNames.has(name)) errors.push(`required evidence report is missing: ${name}`);
}
for (const name of actualReportNames) {
  if (!expectedReports.has(name)) errors.push(`unexpected evidence report is forbidden: ${name}`);
}

const measured = new Map();
const reportSummaries = [];
const runIds = new Set();
const trxCache = new Map();
for (const reportFile of reportFiles) {
  const reportName = path.basename(reportFile);
  const contract = expectedReports.get(reportName);
  if (!contract) continue;
  let report;
  try {
    report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  } catch (error) {
    errors.push(`${reportName} is not valid JSON: ${error.message}`);
    continue;
  }
  if (report.schemaVersion !== 'v2-scenario-evidence.2') {
    errors.push(`${reportName} has unsupported schemaVersion ${JSON.stringify(report.schemaVersion)}`);
    continue;
  }
  if (report.suite !== contract.suite) {
    errors.push(`${reportName} has suite ${JSON.stringify(report.suite)}; expected ${contract.suite}`);
    continue;
  }
  const provenance = validateProvenance(reportName, report, contract);
  if (!provenance.valid) continue;
  runIds.add(report.provenance.runId);
  if (report.completed !== true) {
    errors.push(`${reportName} did not complete successfully`);
    continue;
  }
  if (!Array.isArray(report.results)) {
    errors.push(`${reportName} has no results array`);
    continue;
  }

  let validPasses = 0;
  for (const result of report.results) {
    if (!/^V2-FND-001-S\d{3}$/.test(result?.scenarioId ?? '')) {
      errors.push(`${reportName} contains invalid scenario id ${JSON.stringify(result?.scenarioId)}`);
      continue;
    }
    if (!['PASS', 'FAIL'].includes(result.status)) {
      errors.push(`${reportName} scenario ${result.scenarioId} has invalid status ${JSON.stringify(result.status)}`);
      continue;
    }
    if (result.status !== 'PASS') continue;
    if (!Number.isInteger(result.assertionCount) || result.assertionCount < 1 || !Array.isArray(result.assertions)
        || result.assertions.length < 1) {
      errors.push(`${reportName} scenario ${result.scenarioId} claims PASS without an executed evidence anchor`);
      continue;
    }

    const validAssertions = [];
    for (const assertion of result.assertions) {
      const failure = validateAssertion(assertion, report, result.scenarioId, provenance.sourceFile);
      if (failure) errors.push(`${reportName} scenario ${result.scenarioId}: ${failure}`);
      else validAssertions.push(assertion);
    }
    if (validAssertions.length === 0) continue;
    validPasses++;
    const aggregate = measured.get(result.scenarioId) ?? { suites: new Set(), assertions: [] };
    aggregate.suites.add(report.suite);
    aggregate.assertions.push(...validAssertions.map((assertion) => ({ ...assertion, suite: report.suite })));
    measured.set(result.scenarioId, aggregate);
  }
  reportSummaries.push({
    file: reportName,
    suite: report.suite,
    invocation: report.invocation,
    passScenarios: validPasses,
    runId: report.provenance.runId,
    repositoryHead: report.provenance.repositoryHead,
    productTreeSha256: report.provenance.productTreeSha256,
  });
}

if (runIds.size !== 1) errors.push(`evidence reports must share exactly one runId; found ${[...runIds].join(', ') || 'none'}`);
if (process.env.WFD_EVIDENCE_RUN_ID && !runIds.has(process.env.WFD_EVIDENCE_RUN_ID)) {
  errors.push(`evidence runId does not match WFD_EVIDENCE_RUN_ID=${process.env.WFD_EVIDENCE_RUN_ID}`);
}

for (const row of catalog) {
  const scenarioId = row.scenarioId;
  const declaredPass = row.repoExecutionStatus === 'PASS';
  const runtimeEvidence = measured.get(scenarioId);
  const testKinds = new Set((row.testKinds ?? '').split(';').filter(Boolean));
  const matchingSuites = runtimeEvidence
    ? [...runtimeEvidence.suites].filter((suite) => testKinds.has(suiteTestKind(suite)))
    : [];

  if (declaredPass) {
    if (row.repoEvidenceRefs !== 'MEASURED_AT_RUNTIME') {
      errors.push(`${scenarioId} PASS must derive repoEvidenceRefs from runtime reports, got ${JSON.stringify(row.repoEvidenceRefs)}`);
    }
    if (row.repoEvidenceState !== 'MEASURED_SUFFICIENT' || row.repoEvidenceReason !== 'NONE') {
      errors.push(`${scenarioId} PASS must declare MEASURED_SUFFICIENT with reason NONE`);
    }
    if (matchingSuites.length === 0) {
      errors.push(`${scenarioId} declares repository PASS but no completed matching suite executed an evidence anchor`);
    }
  } else if (row.repoEvidenceRefs === 'MEASURED_AT_RUNTIME') {
    errors.push(`${scenarioId} is ${row.repoExecutionStatus} but still claims MEASURED_AT_RUNTIME evidence`);
  } else if (runtimeEvidence && matchingSuites.length > 0) {
    if (row.repoEvidenceState !== 'MEASURED_BUT_INSUFFICIENT'
        || !row.repoEvidenceReason || row.repoEvidenceReason === 'NONE') {
      errors.push(`${scenarioId} has measured evidence but its deliberate downgrade lacks MEASURED_BUT_INSUFFICIENT and a reason`);
    }
  } else if (!['NOT_MEASURED', 'EXTERNALLY_GATED'].includes(row.repoEvidenceState)) {
    errors.push(`${scenarioId} has no matching measured evidence but declares repoEvidenceState ${JSON.stringify(row.repoEvidenceState)}`);
  }
}

validateRefusalCodes(catalog);

const declaredCounts = countBy(catalog, (row) => row.repoExecutionStatus);
const measuredDeclaredPasses = catalog.filter((row) => row.repoExecutionStatus === 'PASS'
  && measured.has(row.scenarioId)
  && [...measured.get(row.scenarioId).suites]
    .some((suite) => (row.testKinds ?? '').split(';').includes(suiteTestKind(suite))));
const declaredPassCount = declaredCounts.PASS ?? 0;
if (expectedStaticPassCount !== undefined && Number(expectedStaticPassCount) !== declaredPassCount) {
  errors.push(`PowerShell static PASS count ${expectedStaticPassCount} differs from JavaScript catalog PASS count ${declaredPassCount}`);
}
if (declaredPassCount !== measuredDeclaredPasses.length) {
  errors.push(`catalog PASS count ${declaredPassCount} differs from measuredPassCount ${measuredDeclaredPasses.length}`);
}

const measuredLedger = {
  schemaVersion: 'v2-catalog-measured-evidence.2',
  generatedAtUtc: new Date().toISOString(),
  runId: runIds.size === 1 ? [...runIds][0] : null,
  repositoryHead: expectedHead,
  productTreeSha256: expectedProduct.sha256,
  productFileCount: expectedProduct.fileCount,
  reports: reportSummaries,
  declaredRepositoryStatuses: declaredCounts,
  measuredPassCount: measuredDeclaredPasses.length,
  scenarios: measuredDeclaredPasses.map((row) => {
    const evidence = measured.get(row.scenarioId);
    return {
      scenarioId: row.scenarioId,
      status: 'PASS',
      suites: [...evidence.suites].sort(),
      assertionCount: evidence.assertions.reduce((sum, assertion) => sum + assertion.executions, 0),
      assertions: evidence.assertions
        .map(({ file, line, kind, executions, suite }) => ({ file, line, kind, executions, suite }))
        .sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line),
    };
  }),
  warnings,
};
if (fs.existsSync(evidenceDirectory)) {
  fs.writeFileSync(path.join(evidenceDirectory, 'catalog-measured-evidence.json'), `${JSON.stringify(measuredLedger, null, 2)}\n`, 'utf8');
}

for (const warning of warnings) console.warn(`WARNING: ${warning}`);
if (errors.length > 0) {
  for (const error of errors) console.error(`ERROR: ${error}`);
  process.exit(1);
}

console.log('V2-FND-001 runtime execution evidence PASS');
console.log(`Evidence reports: ${reportFiles.length}`);
console.log(`Evidence runId: ${[...runIds][0]}`);
console.log(`Repository HEAD: ${expectedHead}`);
console.log(`Product tree: ${expectedProduct.sha256} (${expectedProduct.fileCount} files)`);
console.log(`Measured declared PASS: ${measuredDeclaredPasses.length}`);
console.log(`Measured suites: ${[...new Set(reportSummaries.map((report) => report.suite))].sort().join(', ')}`);

function validateProvenance(reportName, report, contract) {
  const provenance = report.provenance;
  if (!provenance || provenance.schemaVersion !== 'v2-evidence-provenance.1') {
    errors.push(`${reportName} has no supported evidence provenance`);
    return { valid: false, sourceFile: null };
  }
  if (!/^[A-Za-z0-9._:-]{8,200}$/.test(provenance.runId ?? '')) {
    errors.push(`${reportName} has invalid provenance runId`);
  }
  if (provenance.producer !== contract.producer) {
    errors.push(`${reportName} producer ${JSON.stringify(provenance.producer)} does not match ${contract.producer}`);
  }
  if (provenance.repositoryHead !== expectedHead) {
    errors.push(`${reportName} was measured at HEAD ${provenance.repositoryHead}; current HEAD is ${expectedHead}`);
  }
  if (provenance.productTreeSha256 !== expectedProduct.sha256
      || provenance.productFileCount !== expectedProduct.fileCount) {
    errors.push(`${reportName} product tree changed after measurement`);
  }
  const generatedAt = Date.parse(report.generatedAtUtc);
  const age = Date.now() - generatedAt;
  if (!Number.isFinite(generatedAt) || age < -5 * 60 * 1000 || age > maxEvidenceAgeHours * 60 * 60 * 1000) {
    errors.push(`${reportName} generatedAtUtc is invalid, future-dated, or older than ${maxEvidenceAgeHours} hours`);
  }

  let sourceFile = null;
  if (contract.source) {
    const source = provenance.sourceArtifact;
    if (!source || typeof source.path !== 'string' || !/^[0-9a-f]{64}$/.test(source.sha256 ?? '')
        || !Number.isInteger(source.bytes) || source.bytes < 1) {
      errors.push(`${reportName} does not present a hashed raw test source artifact`);
    } else {
      sourceFile = path.resolve(evidenceDirectory, source.path);
      const prefix = `${evidenceDirectory.replace(/[\\/]$/, '')}${path.sep}`.toLowerCase();
      if (!sourceFile.toLowerCase().startsWith(prefix)) {
        errors.push(`${reportName} raw source escapes the evidence directory`);
        sourceFile = null;
      } else if (!fs.existsSync(sourceFile) || !fs.statSync(sourceFile).isFile()) {
        errors.push(`${reportName} raw source is not presented: ${source.path}`);
        sourceFile = null;
      } else {
        const bytes = fs.readFileSync(sourceFile);
        if (bytes.length !== source.bytes || sha256(bytes) !== source.sha256) {
          errors.push(`${reportName} raw source artifact hash or size does not match`);
          sourceFile = null;
        } else if (Number.isFinite(generatedAt)
            && fs.statSync(sourceFile).mtimeMs > generatedAt + 5 * 60 * 1000) {
          errors.push(`${reportName} predates its raw source artifact`);
          sourceFile = null;
        }
      }
    }
  } else if (provenance.sourceArtifact !== null) {
    errors.push(`${reportName} runtime producer must not claim an unrelated raw test artifact`);
  }
  return { valid: !errors.some((error) => error.startsWith(reportName)), sourceFile };
}

function validateAssertion(assertion, report, scenarioId, sourceFile) {
  if (!assertion || typeof assertion.file !== 'string' || !Number.isInteger(assertion.line)
      || assertion.line < 1 || !Number.isInteger(assertion.executions) || assertion.executions < 1) {
    return 'contains a malformed evidence entry';
  }
  const relative = assertion.file.replace(/\\/g, '/');
  const absolute = path.resolve(repoRoot, relative);
  const prefix = `${repoRoot.replace(/[\\/]$/, '')}${path.sep}`.toLowerCase();
  if (absolute.toLowerCase() !== repoRoot.toLowerCase() && !absolute.toLowerCase().startsWith(prefix)) {
    return `evidence path escapes the repository: ${relative}`;
  }
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) return `evidence file does not exist: ${relative}`;
  const bytes = fs.readFileSync(absolute);
  if (sha256(bytes) !== assertion.fileSha256) return `assertion file changed after execution: ${relative}`;
  const lines = bytes.toString('utf8').split(/\r?\n/);
  const lineText = lines[assertion.line - 1];
  if (lineText === undefined || sha256(Buffer.from(lineText, 'utf8')) !== assertion.lineSha256) {
    return `assertion line changed after execution: ${relative}:${assertion.line}`;
  }
  if (!bytes.toString('utf8').includes(scenarioId)) {
    return `evidence file has no independent binding to ${scenarioId}: ${relative}`;
  }

  if (report.provenance.producer === 'test-collector:xunit') {
    if (!relative.startsWith('tests/') || !relative.endsWith('.cs')) return `xUnit evidence is not a test source: ${relative}`;
    if (assertion.kind !== 'xunit.test-pass') return `invalid xUnit evidence kind ${JSON.stringify(assertion.kind)}`;
    if (!new RegExp(`\\b${escapeRegExp(assertion.methodName ?? '')}\\s*\\(`).test(lineText)) {
      return `xUnit evidence line is not the executed method ${JSON.stringify(assertion.methodName)}`;
    }
    const attributeText = lines.slice(Math.max(0, assertion.line - 13), assertion.line - 1).join('\n');
    const trait = new RegExp(`\\[Trait\\s*\\(\\s*"V2Scenario"\\s*,\\s*"${escapeRegExp(scenarioId)}"\\s*\\)\\s*\\]`);
    if (!trait.test(attributeText)) return `xUnit method lacks explicit V2Scenario Trait for ${scenarioId}`;
    return validateXunitExecution(assertion, sourceFile);
  }
  if (report.provenance.producer === 'test-collector:vitest') {
    if (!relative.startsWith('extension/src/') || !relative.endsWith('.test.ts')) return `Vitest evidence is not a .test.ts source: ${relative}`;
  }

  const expectedKind = report.suite === 'webview'
    ? /^webview\.(?:ok|eq)$/
    : report.suite === 'extension-host'
      ? /^assert\.[A-Za-z]+$/
      : report.suite === 'e2e'
        ? /^powershell\.condition$/
        : /^(?:assert\.[A-Za-z]+|expect\.call)$/;
  if (!expectedKind.test(assertion.kind)) return `invalid assertion kind ${JSON.stringify(assertion.kind)}`;
  const assertionSyntax = report.suite === 'webview'
    ? /\b(?:ok|eq)\s*\(/
    : report.suite === 'extension-host'
      ? /\bassert\.[A-Za-z]+\s*\(/
      : report.suite === 'e2e'
        ? /(?:\$pass\s*=|-and)\s+\$[A-Za-z]+\s+-le\s+/
        : /\b(?:assert\.[A-Za-z]+|expect)\s*\(/;
  if (!assertionSyntax.test(lineText)) return `runtime evidence anchor is not an assertion call: ${relative}:${assertion.line}`;
  return null;
}

function validateXunitExecution(assertion, sourceFile) {
  if (!sourceFile) return 'xUnit raw TRX source is unavailable';
  let executions = trxCache.get(sourceFile);
  if (!executions) {
    executions = readTrxExecutions(sourceFile);
    trxCache.set(sourceFile, executions);
  }
  const execution = executions.get(assertion.testId);
  if (!execution || execution.outcome !== 'Passed') return `TRX does not contain passed testId ${JSON.stringify(assertion.testId)}`;
  if (execution.testName !== assertion.testName || execution.className !== assertion.className
      || execution.methodName !== assertion.methodName || assertion.outcome !== 'Passed') {
    return `xUnit evidence identity does not match the presented TRX for testId ${assertion.testId}`;
  }
  return null;
}

function readTrxExecutions(file) {
  const xml = fs.readFileSync(file, 'utf8');
  const definitions = new Map();
  for (const tag of xml.matchAll(/<UnitTest\b([^>]*)>([\s\S]*?)<\/UnitTest>/g)) {
    const unit = xmlAttributes(tag[1]);
    const methodMatch = /<TestMethod\b([^>]+?)\s*\/?>/.exec(tag[2]);
    const method = methodMatch ? xmlAttributes(methodMatch[1]) : {};
    definitions.set(unit.id ?? '', { className: method.className ?? '', methodName: method.name ?? '' });
  }
  const executions = new Map();
  for (const tag of xml.matchAll(/<UnitTestResult\b([^>]+?)(?:\s*\/?>)/g)) {
    const result = xmlAttributes(tag[1]);
    const definition = definitions.get(result.testId ?? '') ?? {};
    executions.set(result.testId ?? '', {
      outcome: result.outcome ?? '',
      testName: result.testName ?? '',
      className: definition.className ?? '',
      methodName: definition.methodName ?? '',
    });
  }
  return executions;
}

function suiteTestKind(suite) {
  return suite === 'unit' ? 'unit' : suite;
}

function validateRefusalCodes(rows) {
  const productText = productFiles(repoRoot).map((file) => fs.readFileSync(file, 'utf8')).join('\n');
  for (const row of rows) {
    if (row.repoExecutionStatus !== 'PASS' || !row.refusal || row.refusal === 'NONE') continue;
    if (!productText.includes(row.refusal)) {
      errors.push(`${row.scenarioId} declares refusal ${JSON.stringify(row.refusal)} which no product source emits`);
    }
  }
}

function readTsv(file) {
  const lines = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.length > 0);
  const header = parseDelimitedLine(lines.shift() ?? '', '\t', 1);
  return lines.map((line, index) => {
    const cells = parseDelimitedLine(line, '\t', index + 2);
    if (cells.length !== header.length) errors.push(`catalog line ${index + 2} has ${cells.length} columns; expected ${header.length}`);
    return Object.fromEntries(header.map((name, cellIndex) => [name, cells[cellIndex] ?? '']));
  });
}

function parseDelimitedLine(line, delimiter, lineNumber) {
  const cells = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (quoted) {
      if (character === '"' && line[index + 1] === '"') { cell += '"'; index++; }
      else if (character === '"') quoted = false;
      else cell += character;
    } else if (character === delimiter) {
      cells.push(cell);
      cell = '';
    } else if (character === '"' && cell.length === 0) {
      quoted = true;
    } else {
      cell += character;
    }
  }
  if (quoted) errors.push(`catalog line ${lineNumber} has an unterminated quoted field`);
  cells.push(cell);
  return cells;
}

function xmlAttributes(value) {
  return Object.fromEntries([...value.matchAll(/([A-Za-z][A-Za-z0-9]*)="([^"]*)"/g)]
    .map((match) => [match[1], decodeXml(match[2])]));
}

function decodeXml(value) {
  return value.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function countBy(values, selector) {
  return Object.fromEntries([...values.reduce((counts, value) => {
    const key = selector(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    return counts;
  }, new Map()).entries()].sort(([left], [right]) => left.localeCompare(right)));
}
