import { describe, expect, it } from 'vitest';
import {
  V2_SOAK_PROFILES,
  V2SoakReport,
  assertV2SoakReport,
  makeDeterministicV2SoakCycleRunner,
  runV2SoakHarness,
  validateV2SoakReport,
} from './v2SoakHarness';

describe('v2 soak harness', () => {
  it('models the short CI profile as a bounded deterministic gate', async () => {
    const report = await runV2SoakHarness(makeDeterministicV2SoakCycleRunner(), {
      generatedAtUtc: '2026-08-20T00:00:00.000Z',
    });

    assertV2SoakReport(report);
    expect(report.status).toBe('PASS');
    expect(report.profile.id).toBe('ci-short');
    expect(report.profile.requiredCycles).toBe(25);
    expect(report.observations).toHaveLength(25);
    expect(report.observations.map((observation) => observation.cycle)).toEqual(Array.from({ length: 25 }, (_, index) => index + 1));
    expect(report.evidence).toEqual({
      realProductPath: 'NOT_EXECUTED',
      hardware8hRun: 'NOT_EXECUTED',
    });
    expect(report.summary.peakOutputLocksHeld).toBe(0);
    expect(report.summary.totalRecoveryRequired).toBe(0);
  });

  it('keeps the GA profile at 500 cycles and blocks synthetic non-hardware claims', async () => {
    const elapsed = [0, V2_SOAK_PROFILES['ga-8h'].minimumElapsedMs];
    const report = await runV2SoakHarness(makeDeterministicV2SoakCycleRunner(), {
      profileId: 'ga-8h',
      nowMs: () => elapsed.shift() ?? V2_SOAK_PROFILES['ga-8h'].minimumElapsedMs,
    });

    expect(report.status).toBe('NOT_EXECUTED');
    expect(report.profile.requiredCycles).toBe(500);
    expect(report.observations).toHaveLength(500);
    expect(report.notExecuted).toEqual([
      'ga-8h requires real product-path execution',
      'ga-8h requires real 8h hardware evidence',
    ]);
  });

  it('allows a GA PASS only with real product-path, hardware evidence, 8h duration, and clean metrics', async () => {
    const elapsed = [100, 100 + V2_SOAK_PROFILES['ga-8h'].minimumElapsedMs];
    const report = await runV2SoakHarness(makeDeterministicV2SoakCycleRunner(), {
      profileId: 'ga-8h',
      executionMode: 'real-product-path',
      hardwareEvidence: true,
      nowMs: () => elapsed.shift() ?? (100 + V2_SOAK_PROFILES['ga-8h'].minimumElapsedMs),
    });

    expect(report.status).toBe('PASS');
    expect(report.elapsedMs).toBe(V2_SOAK_PROFILES['ga-8h'].minimumElapsedMs);
    expect(report.evidence).toEqual({
      realProductPath: 'EXECUTED',
      hardware8hRun: 'EXECUTED',
    });
    expect(validateV2SoakReport(report).status).toBe('PASS');
  });

  it('fails on memory, GDI, USER, output-lock, and recovery budget regressions', async () => {
    const report = await runV2SoakHarness(makeDeterministicV2SoakCycleRunner({
      privateBytesGrowthPerCycle: 2 * 1024 * 1024,
      managedHeapBytesGrowthPerCycle: 1024 * 1024,
      gdiHandleGrowthAtCycle: 2,
      userHandleGrowthAtCycle: 3,
      outputLocksHeldAtCycle: 4,
      outputLockWaitMsAtCycle: 5,
      crashRecoveryAtCycle: 6,
      recoveryRequiredAtCycle: 7,
    }));
    const validation = validateV2SoakReport(report);

    expect(validation.status).toBe('FAIL');
    expect(validation.failures).toEqual([
      'private bytes delta 50331648 exceeds budget 33554432',
      'managed heap bytes delta 25165824 exceeds budget 16777216',
      'output locks held 1 exceeds budget 0',
      'output lock wait ms 1 exceeds budget 0',
      'recovery required count 1 exceeds budget 0',
    ]);
    expect(() => assertV2SoakReport(report)).toThrow(/private bytes delta/);
  });

  it('rejects malformed cycle ordering and ambiguous build churn hashes', async () => {
    const report = await runV2SoakHarness(({ cycle }) => ({
      cycle: cycle === 3 ? 2 : cycle,
      privateBytes: 1000 + cycle,
      managedHeapBytes: 500 + cycle,
      gdiHandles: 10,
      userHandles: 20,
      outputLocksHeld: 0,
      outputLockWaitMs: 0,
      crashRecoveries: 0,
      recoveryRequired: 0,
      workerGeneration: 1,
      buildChurnHash: cycle === 4 ? 'cycle-003' : `cycle-${String(cycle).padStart(3, '0')}`,
    }));
    const broken: V2SoakReport = {
      ...report,
      observations: report.observations.slice(0, 24),
    };
    const validation = validateV2SoakReport(broken);

    expect(validation.status).toBe('FAIL');
    expect(validation.failures).toEqual([
      'ci-short executed 24 cycles, expected 25',
      'observation 2 recorded cycle 2, expected 3',
      'duplicate build churn hash cycle-003',
    ]);
  });
});
