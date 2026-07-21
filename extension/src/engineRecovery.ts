export type RecoverableEngineKind = 'modern' | 'net48';

export interface RecoveryDecision {
  restart: boolean;
  delayMs: number;
  recentCrashes: number;
}

/** Bounded crash-loop policy for the out-of-process design engines. */
export class EngineRecoveryPolicy {
  private readonly crashes = new Map<RecoverableEngineKind, number[]>();

  constructor(
    private readonly maxRestarts = 2,
    private readonly windowMs = 30_000,
    private readonly baseDelayMs = 250,
  ) {}

  recordCrash(kind: RecoverableEngineKind, now = Date.now()): RecoveryDecision {
    const recent = (this.crashes.get(kind) ?? []).filter((at) => now - at < this.windowMs);
    recent.push(now);
    this.crashes.set(kind, recent);
    const restart = recent.length <= this.maxRestarts;
    return {
      restart,
      delayMs: restart ? this.baseDelayMs * (2 ** (recent.length - 1)) : 0,
      recentCrashes: recent.length,
    };
  }

  recentCrashCount(kind: RecoverableEngineKind, now = Date.now()): number {
    const recent = (this.crashes.get(kind) ?? []).filter((at) => now - at < this.windowMs);
    this.crashes.set(kind, recent);
    return recent.length;
  }
}
