import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  V2_SOAK_PROFILES,
  V2SoakCycleObservation,
  makeDeterministicV2SoakCycleRunner,
} from './v2SoakHarness';
import { runV2SoakCli } from './v2SoakCli';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wfd-v2-soak-cli-'));
}

async function makeObservations(cycles: number): Promise<V2SoakCycleObservation[]> {
  const runner = makeDeterministicV2SoakCycleRunner();
  const profile = V2_SOAK_PROFILES['ga-8h'];
  const observations: V2SoakCycleObservation[] = [];
  for (let cycle = 1; cycle <= cycles; cycle += 1) {
    observations.push(await runner({ profile, cycle, previousObservation: observations[observations.length - 1] }));
  }
  return observations;
}

describe('v2 soak CLI', () => {
  it('runs ci-short only through the deterministic synthetic profile', async () => {
    let stdout = '';
    const result = await runV2SoakCli(['--profile', 'ci-short', '--generated-at', '2026-08-20T00:00:00.000Z'], {
      io: {
        readFileSync: (file) => fs.readFileSync(file),
        writeFileSync: (file, data) => fs.writeFileSync(file, data, 'utf8'),
        stdout: (data) => { stdout += data; },
        stderr: () => undefined,
      },
    });
    const report = JSON.parse(stdout);

    expect(result).toEqual({ exitCode: 0, reportStatus: 'PASS' });
    expect(report.profile.id).toBe('ci-short');
    expect(report.executionMode).toBe('synthetic-harness');
    expect(report.observations).toHaveLength(25);
    expect(report.elapsedMs).toBe(0);
    expect(report.evidence).toEqual({ realProductPath: 'NOT_EXECUTED', hardware8hRun: 'NOT_EXECUTED' });
  });

  it('requires ga-8h to use explicit real-product input and explicit report output', async () => {
    const dir = tempDir();
    const input = path.join(dir, 'observations.json');

    expect((await runV2SoakCli(['--profile', 'ci-short', '--input', input])).exitCode).toBe(2);
    expect((await runV2SoakCli(['--profile', 'ga-8h'])).exitCode).toBe(2);
    expect((await runV2SoakCli(['--profile', 'ga-8h', '--input', input])).exitCode).toBe(2);
  });

  it('validates imported ga-8h observations without allowing the file to attest product-path or hardware evidence', async () => {
    const dir = tempDir();
    const input = path.join(dir, 'observations.json');
    const output = path.join(dir, 'report.json');
    fs.writeFileSync(input, JSON.stringify({
      schemaVersion: '2.0.0-soak-observations.1',
      generatedAtUtc: '2026-08-20T00:00:00.000Z',
      elapsedMs: V2_SOAK_PROFILES['ga-8h'].minimumElapsedMs,
      observations: await makeObservations(V2_SOAK_PROFILES['ga-8h'].requiredCycles),
    }), 'utf8');

    const result = await runV2SoakCli(['--profile', 'ga-8h', '--input', input, '--output', output]);
    const report = JSON.parse(fs.readFileSync(output, 'utf8'));

    expect(result).toEqual({ exitCode: 0, reportStatus: 'NOT_EXECUTED' });
    expect(report.profile.id).toBe('ga-8h');
    expect(report.executionMode).toBe('external-observation-import');
    expect(report.elapsedMs).toBe(V2_SOAK_PROFILES['ga-8h'].minimumElapsedMs);
    expect(report.evidence).toEqual({ realProductPath: 'NOT_EXECUTED', hardware8hRun: 'NOT_EXECUTED' });
    expect(report.notExecuted).toEqual([
      'ga-8h requires real product-path execution',
      'ga-8h requires real 8h hardware evidence',
    ]);
    expect(report.observations).toHaveLength(500);
  });

  it('keeps incomplete ga-8h evidence honest as NOT_EXECUTED instead of faking hardware or elapsed time', async () => {
    const dir = tempDir();
    const input = path.join(dir, 'observations.json');
    const output = path.join(dir, 'report.json');
    fs.writeFileSync(input, JSON.stringify({
      schemaVersion: '2.0.0-soak-observations.1',
      generatedAtUtc: '2026-08-20T00:00:00.000Z',
      elapsedMs: 1000,
      observations: await makeObservations(V2_SOAK_PROFILES['ga-8h'].requiredCycles),
    }), 'utf8');

    const result = await runV2SoakCli(['--profile', 'ga-8h', '--input', input, '--output', output]);
    const report = JSON.parse(fs.readFileSync(output, 'utf8'));

    expect(result).toEqual({ exitCode: 0, reportStatus: 'NOT_EXECUTED' });
    expect(report.evidence.hardware8hRun).toBe('NOT_EXECUTED');
    expect(report.evidence.realProductPath).toBe('NOT_EXECUTED');
    expect(report.elapsedMs).toBe(1000);
    expect(report.notExecuted).toEqual([
      'ga-8h requires real product-path execution',
      'ga-8h requires real 8h hardware evidence',
      `ga-8h elapsed 1000ms is below required ${V2_SOAK_PROFILES['ga-8h'].minimumElapsedMs}ms`,
    ]);
  });

  it('rejects malformed, oversized, unknown-root-field, and partial ga input', async () => {
    const dir = tempDir();
    const malformed = path.join(dir, 'malformed.json');
    const oversized = path.join(dir, 'oversized.json');
    const unknown = path.join(dir, 'unknown.json');
    const partial = path.join(dir, 'partial.json');
    const malformedObservation = path.join(dir, 'malformed-observation.json');
    const output = path.join(dir, 'report.json');
    fs.writeFileSync(malformed, '{', 'utf8');
    fs.writeFileSync(oversized, JSON.stringify({ schemaVersion: '2.0.0-soak-observations.1' }), 'utf8');
    fs.writeFileSync(unknown, JSON.stringify({
      schemaVersion: '2.0.0-soak-observations.1',
      generatedAtUtc: '2026-08-20T00:00:00.000Z',
      elapsedMs: 0,
      observations: [],
      unexpected: true,
    }), 'utf8');
    fs.writeFileSync(partial, JSON.stringify({
      schemaVersion: '2.0.0-soak-observations.1',
      generatedAtUtc: '2026-08-20T00:00:00.000Z',
      elapsedMs: 0,
      observations: await makeObservations(1),
    }), 'utf8');
    const observations = await makeObservations(V2_SOAK_PROFILES['ga-8h'].requiredCycles);
    fs.writeFileSync(malformedObservation, JSON.stringify({
      schemaVersion: '2.0.0-soak-observations.1',
      generatedAtUtc: '2026-08-20T00:00:00.000Z',
      elapsedMs: V2_SOAK_PROFILES['ga-8h'].minimumElapsedMs,
      observations: observations.map((observation, index) => index === 0
        ? { ...observation, privateBytes: undefined, unexpected: 1 }
        : observation),
    }), 'utf8');

    expect((await runV2SoakCli(['--profile', 'ga-8h', '--input', malformed, '--output', output])).exitCode).toBe(2);
    expect((await runV2SoakCli(['--profile', 'ga-8h', '--input', oversized, '--output', output], { maxInputBytes: 4 })).exitCode).toBe(2);
    expect((await runV2SoakCli(['--profile', 'ga-8h', '--input', unknown, '--output', output])).exitCode).toBe(2);
    expect((await runV2SoakCli(['--profile', 'ga-8h', '--input', partial, '--output', output])).exitCode).toBe(2);
    expect((await runV2SoakCli(['--profile', 'ga-8h', '--input', malformedObservation, '--output', output])).exitCode).toBe(2);
  });

  it('rejects self-attested hardware evidence in imported observation JSON', async () => {
    const dir = tempDir();
    const input = path.join(dir, 'observations.json');
    const output = path.join(dir, 'report.json');
    fs.writeFileSync(input, JSON.stringify({
      schemaVersion: '2.0.0-soak-observations.1',
      generatedAtUtc: '2026-08-20T00:00:00.000Z',
      elapsedMs: V2_SOAK_PROFILES['ga-8h'].minimumElapsedMs,
      hardwareEvidence: true,
      observations: await makeObservations(V2_SOAK_PROFILES['ga-8h'].requiredCycles),
    }), 'utf8');

    expect((await runV2SoakCli(['--profile', 'ga-8h', '--input', input, '--output', output])).exitCode).toBe(2);
  });
});
