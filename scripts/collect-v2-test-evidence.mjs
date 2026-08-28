import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { buildEvidenceProvenance, sourceArtifact } from './v2-evidence-provenance.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultRepositoryRoot = path.resolve(scriptDirectory, '..');
const option = (name) => {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
};
const repositoryRoot = path.resolve(option('repo-root') ?? defaultRepositoryRoot);
const kind = option('kind');
const input = path.resolve(repositoryRoot, option('input') ?? '');
const output = path.resolve(repositoryRoot, option('output') ?? '');
const invocation = option('invocation') ?? kind ?? 'unit';
if (!['vitest', 'xunit'].includes(kind ?? '')) throw new Error('--kind must be vitest or xunit');
if (!option('input') || !fs.existsSync(input)) throw new Error(`test result does not exist: ${input}`);
if (!option('output')) throw new Error('--output is required');

const sourceRoot = kind === 'vitest'
  ? path.join(repositoryRoot, 'extension', 'src')
  : path.join(repositoryRoot, 'tests');
const sourceExtension = kind === 'vitest' ? '.test.ts' : '.cs';
const sourceFiles = walk(sourceRoot).filter((file) => file.endsWith(sourceExtension));
const sourceCache = new Map(sourceFiles.map((file) => [file, fs.readFileSync(file, 'utf8').split(/\r?\n/)]));
const testResults = kind === 'vitest' ? readVitest(input) : readTrx(input);
const scenarioResults = new Map();

for (const test of testResults.tests) {
  const scenarioIds = uniqueScenarioIds(test.name);
  if (scenarioIds.length === 0) continue;
  let executedAnchors = null;
  if (test.status === 'PASS') {
    executedAnchors = kind === 'xunit'
      ? [locateExecutedXunitTest(test, scenarioIds)]
      : scenarioIds.flatMap((scenarioId) => locateVitestAssertionAnchors(scenarioId, test.name));
  }
  for (const scenarioId of scenarioIds) {
    const result = scenarioResults.get(scenarioId) ?? {
      scenarioId,
      status: 'PASS',
      error: null,
      assertionCount: 0,
      assertions: new Map(),
    };
    scenarioResults.set(scenarioId, result);
    if (test.status !== 'PASS') {
      result.status = 'FAIL';
      result.error = `${invocation} test did not pass: ${test.name}`;
      continue;
    }

    const anchors = kind === 'xunit'
      ? executedAnchors
      : executedAnchors.filter((anchor) => sourceContainsScenario(anchor.file, scenarioId));
    for (const assertion of anchors) {
      result.assertionCount++;
      const key = `${assertion.file}:${assertion.line}:${assertion.kind}:${assertion.testId ?? ''}`;
      const existing = result.assertions.get(key);
      if (existing) existing.executions++;
      else result.assertions.set(key, { ...assertion, executions: 1 });
    }
  }
}

const results = [...scenarioResults.values()]
  .sort((left, right) => left.scenarioId.localeCompare(right.scenarioId))
  .map((result) => {
    if (result.status === 'PASS' && result.assertionCount === 0) {
      result.status = 'FAIL';
      result.error = `${invocation} passed a scenario-named test, but produced no executed evidence anchor`;
    }
    return {
      scenarioId: result.scenarioId,
      status: result.status,
      assertionCount: result.assertionCount,
      assertions: [...result.assertions.values()]
        .sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line)
        .map((assertion) => {
          const absolute = path.join(repositoryRoot, assertion.file);
          const bytes = fs.readFileSync(absolute);
          const lineText = bytes.toString('utf8').split(/\r?\n/)[assertion.line - 1] ?? '';
          return {
            ...assertion,
            fileSha256: sha256(bytes),
            lineSha256: sha256(Buffer.from(lineText, 'utf8')),
          };
        }),
      error: result.error,
    };
  });

const evidenceDirectory = path.dirname(output);
const report = {
  schemaVersion: 'v2-scenario-evidence.2',
  suite: 'unit',
  invocation,
  generatedAtUtc: new Date().toISOString(),
  completed: testResults.completed,
  sourceRoot: '.',
  provenance: buildEvidenceProvenance(repositoryRoot, {
    producer: `test-collector:${kind}`,
    repositoryHead: option('repository-head'),
    sourceArtifact: sourceArtifact(input, evidenceDirectory),
  }),
  results,
};
fs.mkdirSync(evidenceDirectory, { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

const passes = results.filter((result) => result.status === 'PASS').length;
const failures = results.length - passes;
console.log(`V2 ${invocation} evidence: ${passes} scenario PASS, ${failures} without executed evidence`);
if (!testResults.completed || failures > 0) process.exitCode = 1;

function readVitest(file) {
  const document = JSON.parse(fs.readFileSync(file, 'utf8'));
  const tests = [];
  for (const testFile of document.testResults ?? []) {
    for (const assertion of testFile.assertionResults ?? []) {
      tests.push({
        name: assertion.fullName ?? [...(assertion.ancestorTitles ?? []), assertion.title].join(' '),
        status: assertion.status === 'passed' ? 'PASS' : 'FAIL',
      });
    }
  }
  return { completed: document.success === true, tests };
}

function readTrx(file) {
  const xml = fs.readFileSync(file, 'utf8');
  const definitions = new Map();
  for (const tag of xml.matchAll(/<UnitTest\b([^>]*)>([\s\S]*?)<\/UnitTest>/g)) {
    const unit = xmlAttributes(tag[1]);
    const methodMatch = /<TestMethod\b([^>]+?)\s*\/?>/.exec(tag[2]);
    const method = methodMatch ? xmlAttributes(methodMatch[1]) : {};
    definitions.set(unit.id ?? '', {
      definitionName: unit.name ?? '',
      className: method.className ?? '',
      methodName: method.name ?? '',
    });
  }
  const tests = [];
  for (const tag of xml.matchAll(/<UnitTestResult\b([^>]+?)(?:\s*\/?>)/g)) {
    const result = xmlAttributes(tag[1]);
    const definition = definitions.get(result.testId ?? '') ?? {};
    tests.push({
      testId: result.testId ?? '',
      name: result.testName ?? definition.definitionName ?? '',
      status: result.outcome === 'Passed' ? 'PASS' : 'FAIL',
      outcome: result.outcome ?? '',
      className: definition.className ?? '',
      methodName: definition.methodName ?? '',
    });
  }
  const counterAttributes = xmlAttributes(/<Counters\b([^>]+)>/.exec(xml)?.[1] ?? '');
  return {
    completed: Number(counterAttributes.failed ?? '0') === 0 && Number(counterAttributes.error ?? '0') === 0,
    tests,
  };
}

function locateExecutedXunitTest(test, scenarioIds) {
  if (!test.testId || !test.className || !test.methodName) {
    throw new Error(`TRX scenario result lacks TestDefinitions identity: ${test.name}`);
  }
  const className = test.className.split('.').pop();
  const candidates = [];
  for (const [file, lines] of sourceCache) {
    if (!lines.some((line) => new RegExp(`\\bclass\\s+${escapeRegExp(className)}\\b`).test(line))) continue;
    for (let index = 0; index < lines.length; index++) {
      if (new RegExp(`\\b${escapeRegExp(test.methodName)}\\s*\\(`).test(lines[index])) {
        candidates.push({ file, lines, line: index + 1 });
      }
    }
  }
  if (candidates.length !== 1) {
    throw new Error(`TRX test ${test.className}.${test.methodName} maps to ${candidates.length} source methods`);
  }
  const candidate = candidates[0];
  const attributeText = candidate.lines
    .slice(Math.max(0, candidate.line - 13), candidate.line - 1)
    .join('\n');
  const declaredIds = [...attributeText.matchAll(/\[Trait\s*\(\s*"V2Scenario"\s*,\s*"(V2-FND-001-S\d{3})"\s*\)\s*\]/g)]
    .map((match) => match[1]);
  const missing = scenarioIds.filter((scenarioId) => !declaredIds.includes(scenarioId));
  if (missing.length > 0) {
    throw new Error(`TRX test ${test.className}.${test.methodName} lacks explicit V2Scenario Trait for ${missing.join(', ')}`);
  }
  return {
    file: path.relative(repositoryRoot, candidate.file).replace(/\\/g, '/'),
    line: candidate.line,
    kind: 'xunit.test-pass',
    testId: test.testId,
    testName: test.name,
    className: test.className,
    methodName: test.methodName,
    outcome: test.outcome,
  };
}

function locateVitestAssertionAnchors(scenarioId, testName) {
  const found = [];
  for (const [file, lines] of sourceCache) {
    for (let index = 0; index < lines.length; index++) {
      if (!lines[index].includes(scenarioId)) continue;
      const block = testBlock(lines, index);
      const blockText = block.map((line) => line.text).join('\n');
      const nameWords = testName.replace(/V2-FND-001-S\d{3}/g, '').match(/[A-Za-z][A-Za-z0-9_-]{3,}/g) ?? [];
      const normalizedBlockText = blockText.toLocaleLowerCase('en-US');
      if (nameWords.length > 0
          && !nameWords.some((word) => normalizedBlockText.includes(word.toLocaleLowerCase('en-US')))) continue;
      for (const line of block) {
        const match = /\b(expect)\s*\(/.exec(line.text) ?? /\b(assert)\.([A-Za-z]+)\s*\(/.exec(line.text);
        if (!match) continue;
        found.push({
          file: path.relative(repositoryRoot, file).replace(/\\/g, '/'),
          line: line.index + 1,
          kind: match[1] === 'expect' ? 'expect.call' : `assert.${match[2]}`,
        });
      }
    }
  }
  return uniqueBy(found, (assertion) => `${assertion.file}:${assertion.line}:${assertion.kind}`);
}

function sourceContainsScenario(relativeFile, scenarioId) {
  const lines = sourceCache.get(path.join(repositoryRoot, relativeFile));
  return lines?.some((line) => line.includes(scenarioId)) === true;
}

function testBlock(lines, anchor) {
  const start = firstOpeningBrace(lines, anchor, Math.min(lines.length - 1, anchor + 4));
  if (start < 0) return [];
  const result = [];
  let depth = 0;
  let began = false;
  for (let index = start; index < lines.length; index++) {
    const text = lines[index];
    result.push({ index, text });
    const structural = stripQuotedAndComments(text);
    for (const character of structural) {
      if (character === '{') { depth++; began = true; }
      else if (character === '}') depth--;
    }
    if (began && depth <= 0) break;
  }
  return result;
}

function firstOpeningBrace(lines, start, end) {
  for (let index = start; index <= end; index++) {
    if (stripQuotedAndComments(lines[index]).includes('{')) return index;
  }
  return -1;
}

function stripQuotedAndComments(value) {
  return value
    .replace(/\/\/.*$/, '')
    .replace(/@?"(?:""|\\.|[^"])*"/g, '""')
    .replace(/'(?:\\.|[^'])'/g, "''")
    .replace(/`(?:\\.|[^`])*`/g, '``');
}

function uniqueScenarioIds(value) {
  const ids = new Set(value.match(/V2-FND-001-S\d{3}/g) ?? []);
  for (const match of value.matchAll(/V2-FND-001-S(\d{3})([\/-])S?(\d{3})/g)) {
    const start = Number(match[1]);
    const end = Number(match[3]);
    if (match[2] === '-' && end >= start && end - start <= 20) {
      for (let number = start; number <= end; number++) ids.add(`V2-FND-001-S${String(number).padStart(3, '0')}`);
    } else {
      ids.add(`V2-FND-001-S${match[3]}`);
    }
  }
  return [...ids].sort();
}

function uniqueBy(values, key) {
  const seen = new Set();
  return values.filter((value) => {
    const candidate = key(value);
    if (seen.has(candidate)) return false;
    seen.add(candidate);
    return true;
  });
}

function walk(root) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (['bin', 'obj', 'node_modules', 'dist'].includes(entry.name)) continue;
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile()) files.push(candidate);
    }
  }
  return files;
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

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
