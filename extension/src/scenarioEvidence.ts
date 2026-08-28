import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { SourceMap } from 'node:module';
import * as path from 'node:path';

const scenarioPattern = /V2-FND-001-S\d{3}/g;

export interface ScenarioAssertionEvidence {
  readonly file: string;
  readonly line: number;
  readonly kind: string;
  readonly executions: number;
  readonly fileSha256: string;
  readonly lineSha256: string;
}

interface MutableAssertionEvidence {
  file: string;
  line: number;
  kind: string;
  executions: number;
}

interface MutableScenarioResult {
  scenarioId: string;
  status: 'PASS' | 'FAIL' | 'UNKNOWN';
  error: string | null;
  assertionCalls: number;
  assertions: Map<string, MutableAssertionEvidence>;
}

interface SourceLocation {
  absoluteFile: string;
  line: number;
}

export interface ScenarioEvidenceRecorderOptions {
  readonly suite: 'webview' | 'extension-host';
  readonly invocation?: string;
}

/**
 * Runtime evidence recorder for the custom (non-test-framework) v2 suites.
 *
 * A catalog PASS is deliberately not inferred from a source marker alone. The recorder only creates evidence while
 * an assertion helper is actually executing, maps the generated bundle frame back through esbuild's source map, and
 * fingerprints both the source file and the exact assertion line. The catalog validator rejects the report after any
 * source edit, including removing or moving the assertion that earned the row.
 */
export class ScenarioEvidenceRecorder {
  private readonly results = new Map<string, MutableScenarioResult>();
  private readonly sourceMaps = new Map<string, SourceMap | null>();
  private readonly sourceLines = new Map<string, readonly string[]>();
  private readonly excluded = new Set<string>();
  private activeScenarioIds: readonly string[] = [];
  private completed = false;
  private suiteSucceeded = false;

  constructor(private readonly options: ScenarioEvidenceRecorderOptions) {}

  beginScenarioTest(name: string): readonly string[] {
    const ids = uniqueScenarioIds(name);
    this.activeScenarioIds = ids;
    for (const scenarioId of ids) this.result(scenarioId);
    return ids;
  }

  endScenarioTest(passed: boolean, error?: unknown): void {
    const detail = error == null ? null : error instanceof Error ? (error.stack ?? error.message) : String(error);
    for (const scenarioId of this.activeScenarioIds) {
      const result = this.result(scenarioId);
      if (!passed || result.assertionCalls === 0) {
        result.status = 'FAIL';
        result.error = detail ?? 'scenario test completed without executing an assertion';
      } else if (result.status !== 'FAIL') {
        result.status = 'PASS';
      }
    }
    this.activeScenarioIds = [];
  }

  recordAssertion(kind: string, caller: Function): void {
    const error = new Error();
    Error.captureStackTrace?.(error, caller);
    const frames = this.sourceLocations(error.stack ?? '');
    if (frames.length === 0) return;

    const assertionLocation = frames[0];
    let scenarioIds = this.activeScenarioIds;
    if (scenarioIds.length === 0) {
      for (const frame of frames) {
        const inferred = this.inferScenarioIds(frame);
        if (inferred.length > 0) {
          scenarioIds = inferred;
          break;
        }
      }
    }
    if (scenarioIds.length === 0) return;

    const repoRoot = repositoryRoot();
    const relativeFile = path.relative(repoRoot, assertionLocation.absoluteFile).replace(/\\/g, '/');
    if (!relativeFile || relativeFile.startsWith('../') || path.isAbsolute(relativeFile)) return;
    const key = `${relativeFile}:${assertionLocation.line}:${kind}`;
    for (const scenarioId of scenarioIds) {
      const result = this.result(scenarioId);
      result.assertionCalls++;
      const existing = result.assertions.get(key);
      if (existing) {
        existing.executions++;
      } else {
        result.assertions.set(key, {
          file: relativeFile,
          line: assertionLocation.line,
          kind,
          executions: 1,
        });
      }
    }
  }

  excludeScenario(scenarioId: string): void {
    this.excluded.add(scenarioId);
  }

  complete(succeeded: boolean): void {
    this.completed = true;
    this.suiteSucceeded = succeeded;
    for (const result of this.results.values()) {
      if (result.status === 'UNKNOWN') {
        if (succeeded && result.assertionCalls > 0) {
          result.status = 'PASS';
        } else {
          result.status = 'FAIL';
          result.error ??= succeeded
            ? 'scenario reached no runtime assertion'
            : 'suite did not complete successfully';
        }
      }
    }
  }

  writeFromEnvironment(): void {
    const outputFile = process.env.WFD_SCENARIO_EVIDENCE_FILE;
    if (!outputFile) return;
    if (!this.completed) throw new Error('scenario evidence cannot be written before the suite is completed');

    const repoRoot = repositoryRoot();
    const results = [...this.results.values()]
      .filter((result) => !this.excluded.has(result.scenarioId))
      .sort((left, right) => left.scenarioId.localeCompare(right.scenarioId))
      .map((result) => {
        const assertions: ScenarioAssertionEvidence[] = [...result.assertions.values()]
          .sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line)
          .map((assertion) => {
            const absoluteFile = path.join(repoRoot, assertion.file);
            const lines = readLines(absoluteFile);
            const lineText = lines[assertion.line - 1] ?? '';
            return {
              ...assertion,
              fileSha256: sha256(fs.readFileSync(absoluteFile)),
              lineSha256: sha256(Buffer.from(lineText, 'utf8')),
            };
          });
        return {
          scenarioId: result.scenarioId,
          status: result.status,
          assertionCount: result.assertionCalls,
          assertions,
          error: result.error,
        };
      });

    const report = {
      schemaVersion: 'v2-scenario-evidence.2',
      suite: this.options.suite,
      invocation: this.options.invocation ?? process.argv.join(' '),
      generatedAtUtc: new Date().toISOString(),
      completed: this.suiteSucceeded,
      sourceRoot: '.',
      provenance: evidenceProvenance(repoRoot, `runtime-recorder:${this.options.suite}`),
      results,
    };
    fs.mkdirSync(path.dirname(outputFile), { recursive: true });
    fs.writeFileSync(outputFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }

  private result(scenarioId: string): MutableScenarioResult {
    let result = this.results.get(scenarioId);
    if (!result) {
      result = {
        scenarioId,
        status: 'UNKNOWN',
        error: null,
        assertionCalls: 0,
        assertions: new Map(),
      };
      this.results.set(scenarioId, result);
    }
    return result;
  }

  private sourceLocations(stack: string): SourceLocation[] {
    const locations: SourceLocation[] = [];
    for (const stackLine of stack.split(/\r?\n/).slice(1)) {
      const match = /(?:\()?(.+):(\d+):(\d+)\)?$/.exec(stackLine.trim());
      if (!match) continue;
      const generatedFile = match[1].replace(/^at\s+/, '').replace(/^.*\s\(/, '');
      if (!path.isAbsolute(generatedFile)) continue;
      const mapped = this.mapGeneratedLocation(generatedFile, Number(match[2]), Number(match[3]));
      if (!mapped || mapped.absoluteFile.endsWith(`${path.sep}scenarioEvidence.ts`)) continue;
      locations.push(mapped);
    }
    return locations;
  }

  private mapGeneratedLocation(generatedFile: string, generatedLine: number, generatedColumn: number): SourceLocation | null {
    const normalizedFile = path.normalize(generatedFile);
    let sourceMap = this.sourceMaps.get(normalizedFile);
    if (sourceMap === undefined) {
      const mapFile = `${normalizedFile}.map`;
      sourceMap = fs.existsSync(mapFile)
        ? new SourceMap(JSON.parse(fs.readFileSync(mapFile, 'utf8')))
        : null;
      this.sourceMaps.set(normalizedFile, sourceMap);
    }
    if (!sourceMap) return { absoluteFile: normalizedFile, line: generatedLine };
    const entry = sourceMap.findEntry(generatedLine - 1, Math.max(0, generatedColumn - 1));
    if (!('originalSource' in entry) || !entry.originalSource || entry.originalLine == null) return null;
    return {
      absoluteFile: path.resolve(path.dirname(normalizedFile), entry.originalSource),
      line: entry.originalLine + 1,
    };
  }

  private inferScenarioIds(location: SourceLocation): readonly string[] {
    const lines = this.lines(location.absoluteFile);
    if (lines.length === 0) return [];
    const start = Math.min(location.line - 1, lines.length - 1);
    for (let index = start; index >= Math.max(0, start - 240); index--) {
      const ids = uniqueScenarioIds(lines[index]);
      if (ids.length > 0) return ids;
    }
    return [];
  }

  private lines(file: string): readonly string[] {
    let lines = this.sourceLines.get(file);
    if (!lines) {
      lines = fs.existsSync(file) ? readLines(file) : [];
      this.sourceLines.set(file, lines);
    }
    return lines;
  }
}

export function createEvidenceAssert<T extends object>(
  baseAssert: T,
  recorder: ScenarioEvidenceRecorder,
): T {
  return new Proxy(baseAssert, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      const wrapped = function evidenceAssertMethod(this: unknown, ...args: unknown[]): unknown {
        recorder.recordAssertion(`assert.${String(property)}`, wrapped);
        return Reflect.apply(value, target, args);
      };
      return wrapped;
    },
  });
}

function uniqueScenarioIds(value: string): readonly string[] {
  return [...new Set(value.match(scenarioPattern) ?? [])];
}

function repositoryRoot(): string {
  return path.resolve(__dirname, '..', '..');
}

function evidenceProvenance(repoRoot: string, producer: string): unknown {
  const helper = path.join(repoRoot, 'scripts', 'v2-evidence-provenance.mjs');
  const nodeExecutable = process.env.WFD_EVIDENCE_NODE_EXECUTABLE ?? process.execPath;
  const result = spawnSync(nodeExecutable, [helper, `--repo-root=${repoRoot}`, `--producer=${producer}`], {
    cwd: repoRoot,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`cannot capture v2 evidence provenance: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return JSON.parse(result.stdout);
}

function readLines(file: string): readonly string[] {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/);
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
