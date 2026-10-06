import { describe, expect, test } from 'vitest';
import { EngineRecoveryPolicy } from './engineRecovery';

describe('EngineRecoveryPolicy', () => {
  test('allows two bounded restarts with exponential backoff', () => {
    const policy = new EngineRecoveryPolicy(2, 30_000, 100);
    expect(policy.recordCrash('modern', 1_000)).toEqual({ restart: true, delayMs: 100, recentCrashes: 1 });
    expect(policy.recordCrash('modern', 2_000)).toEqual({ restart: true, delayMs: 200, recentCrashes: 2 });
    expect(policy.recordCrash('modern', 3_000)).toEqual({ restart: false, delayMs: 0, recentCrashes: 3 });
  });

  test('isolates engine kinds and recovers after the time window', () => {
    const policy = new EngineRecoveryPolicy(1, 1_000, 50);
    expect(policy.recordCrash('modern', 100).restart).toBe(true);
    expect(policy.recordCrash('modern', 200).restart).toBe(false);
    expect(policy.recordCrash('net48', 200).restart).toBe(true);
    expect(policy.recordCrash('modern', 1_201)).toEqual({ restart: true, delayMs: 50, recentCrashes: 1 });
  });

  test('an explicit restart gives that engine kind a fresh budget', () => {
    const policy = new EngineRecoveryPolicy(1, 30_000, 50);
    policy.recordCrash('modern', 100);
    policy.recordCrash('net48', 100);
    expect(policy.recordCrash('modern', 200).restart).toBe(false);
    policy.reset('modern');
    expect(policy.recentCrashCount('modern', 300)).toBe(0);
    expect(policy.recordCrash('modern', 300)).toEqual({ restart: true, delayMs: 50, recentCrashes: 1 });
    expect(policy.recordCrash('net48', 300).restart).toBe(false);
  });
});
