export type V2SoakProfileId = 'ci-short' | 'ga-8h';
export type V2SoakExecutionMode = 'synthetic-harness' | 'external-observation-import' | 'real-product-path';
export type V2SoakStatus = 'PASS' | 'FAIL' | 'NOT_EXECUTED';
export type V2SoakEvidenceStatus = 'EXECUTED' | 'NOT_EXECUTED';

export interface V2SoakProfile {
  readonly id: V2SoakProfileId;
  readonly requiredCycles: number;
  readonly minimumElapsedMs: number;
  readonly requiresRealProductPath: boolean;
  readonly requiresHardwareEvidence: boolean;
  readonly budgets: V2SoakBudgets;
}

export interface V2SoakBudgets {
  readonly maxPrivateBytesDelta: number;
  readonly maxManagedHeapBytesDelta: number;
  readonly maxGdiHandleDelta: number;
  readonly maxUserHandleDelta: number;
  readonly maxOutputLocksHeld: number;
  readonly maxOutputLockWaitMs: number;
  readonly maxCrashRecoveries: number;
  readonly maxRecoveryRequired: number;
}

export interface V2SoakCycleContext {
  readonly profile: V2SoakProfile;
  readonly cycle: number;
  readonly previousObservation?: V2SoakCycleObservation;
}

export interface V2SoakCycleObservation {
  readonly cycle: number;
  readonly privateBytes: number;
  readonly managedHeapBytes: number;
  readonly gdiHandles: number;
  readonly userHandles: number;
  readonly outputLocksHeld: number;
  readonly outputLockWaitMs: number;
  readonly crashRecoveries: number;
  readonly recoveryRequired: number;
  readonly workerGeneration: number;
  readonly buildChurnHash: string;
}

export type V2SoakCycleRunner = (context: V2SoakCycleContext) =>
  V2SoakCycleObservation | Promise<V2SoakCycleObservation>;

export interface V2SoakRunOptions {
  readonly profileId?: V2SoakProfileId;
  readonly executionMode?: V2SoakExecutionMode;
  readonly hardwareEvidence?: boolean;
  readonly nowMs?: () => number;
  readonly generatedAtUtc?: string;
}

export interface V2SoakEvidence {
  readonly realProductPath: V2SoakEvidenceStatus;
  readonly hardware8hRun: V2SoakEvidenceStatus;
}

export interface V2SoakMetricSummary {
  readonly baselinePrivateBytes: number;
  readonly finalPrivateBytes: number;
  readonly privateBytesDelta: number;
  readonly peakPrivateBytes: number;
  readonly baselineManagedHeapBytes: number;
  readonly finalManagedHeapBytes: number;
  readonly managedHeapBytesDelta: number;
  readonly peakManagedHeapBytes: number;
  readonly baselineGdiHandles: number;
  readonly finalGdiHandles: number;
  readonly gdiHandleDelta: number;
  readonly peakGdiHandles: number;
  readonly baselineUserHandles: number;
  readonly finalUserHandles: number;
  readonly userHandleDelta: number;
  readonly peakUserHandles: number;
  readonly peakOutputLocksHeld: number;
  readonly peakOutputLockWaitMs: number;
  readonly totalCrashRecoveries: number;
  readonly totalRecoveryRequired: number;
  readonly finalWorkerGeneration: number;
}

export interface V2SoakReport {
  readonly schemaVersion: '2.0.0-soak-harness.1';
  readonly profile: V2SoakProfile;
  readonly executionMode: V2SoakExecutionMode;
  readonly generatedAtUtc: string;
  readonly elapsedMs: number;
  readonly evidence: V2SoakEvidence;
  readonly observations: readonly V2SoakCycleObservation[];
  readonly summary: V2SoakMetricSummary;
  readonly status: V2SoakStatus;
  readonly failures: readonly string[];
  readonly notExecuted: readonly string[];
}

export interface V2SoakValidationResult {
  readonly status: V2SoakStatus;
  readonly failures: readonly string[];
  readonly notExecuted: readonly string[];
}

const EIGHT_HOURS_MS = 8 * 60 * 60 * 1000;
const MIB = 1024 * 1024;

export const V2_SOAK_PROFILES: Readonly<Record<V2SoakProfileId, V2SoakProfile>> = {
  'ci-short': {
    id: 'ci-short',
    requiredCycles: 25,
    minimumElapsedMs: 0,
    requiresRealProductPath: false,
    requiresHardwareEvidence: false,
    budgets: {
      maxPrivateBytesDelta: 32 * MIB,
      maxManagedHeapBytesDelta: 16 * MIB,
      maxGdiHandleDelta: 4,
      maxUserHandleDelta: 4,
      maxOutputLocksHeld: 0,
      maxOutputLockWaitMs: 0,
      maxCrashRecoveries: 1,
      maxRecoveryRequired: 0,
    },
  },
  'ga-8h': {
    id: 'ga-8h',
    requiredCycles: 500,
    minimumElapsedMs: EIGHT_HOURS_MS,
    requiresRealProductPath: true,
    requiresHardwareEvidence: true,
    budgets: {
      maxPrivateBytesDelta: 128 * MIB,
      maxManagedHeapBytesDelta: 64 * MIB,
      maxGdiHandleDelta: 10,
      maxUserHandleDelta: 10,
      maxOutputLocksHeld: 0,
      maxOutputLockWaitMs: 0,
      maxCrashRecoveries: 5,
      maxRecoveryRequired: 0,
    },
  },
};

export async function runV2SoakHarness(
  runner: V2SoakCycleRunner,
  options: V2SoakRunOptions = {},
): Promise<V2SoakReport> {
  const profile = V2_SOAK_PROFILES[options.profileId ?? 'ci-short'];
  const executionMode = options.executionMode ?? 'synthetic-harness';
  const nowMs = options.nowMs ?? (() => Date.now());
  const startedAt = nowMs();
  const observations: V2SoakCycleObservation[] = [];

  for (let cycle = 1; cycle <= profile.requiredCycles; cycle += 1) {
    const observation = await runner({
      profile,
      cycle,
      previousObservation: observations[observations.length - 1],
    });
    observations.push(observation);
  }

  const elapsedMs = Math.max(0, nowMs() - startedAt);
  const summary = summarizeV2SoakMetrics(observations);
  const evidence: V2SoakEvidence = {
    realProductPath: executionMode === 'real-product-path' ? 'EXECUTED' : 'NOT_EXECUTED',
    hardware8hRun: options.hardwareEvidence === true ? 'EXECUTED' : 'NOT_EXECUTED',
  };
  const baseReport: Omit<V2SoakReport, 'status' | 'failures' | 'notExecuted'> = {
    schemaVersion: '2.0.0-soak-harness.1',
    profile,
    executionMode,
    generatedAtUtc: options.generatedAtUtc ?? new Date(0).toISOString(),
    elapsedMs,
    evidence,
    observations,
    summary,
  };
  const validation = validateV2SoakReport({
    ...baseReport,
    status: 'NOT_EXECUTED',
    failures: [],
    notExecuted: [],
  });

  return {
    ...baseReport,
    status: validation.status,
    failures: validation.failures,
    notExecuted: validation.notExecuted,
  };
}

export function makeDeterministicV2SoakCycleRunner(options: {
  readonly basePrivateBytes?: number;
  readonly privateBytesGrowthPerCycle?: number;
  readonly baseManagedHeapBytes?: number;
  readonly managedHeapBytesGrowthPerCycle?: number;
  readonly baseGdiHandles?: number;
  readonly gdiHandleGrowthAtCycle?: number;
  readonly baseUserHandles?: number;
  readonly userHandleGrowthAtCycle?: number;
  readonly outputLocksHeldAtCycle?: number;
  readonly outputLockWaitMsAtCycle?: number;
  readonly crashRecoveryAtCycle?: number;
  readonly recoveryRequiredAtCycle?: number;
} = {}): V2SoakCycleRunner {
  const basePrivateBytes = options.basePrivateBytes ?? 220 * MIB;
  const baseManagedHeapBytes = options.baseManagedHeapBytes ?? 64 * MIB;
  const baseGdiHandles = options.baseGdiHandles ?? 120;
  const baseUserHandles = options.baseUserHandles ?? 96;
  return ({ cycle }) => ({
    cycle,
    privateBytes: basePrivateBytes + cycle * (options.privateBytesGrowthPerCycle ?? 64 * 1024),
    managedHeapBytes: baseManagedHeapBytes + cycle * (options.managedHeapBytesGrowthPerCycle ?? 16 * 1024),
    gdiHandles: baseGdiHandles + (options.gdiHandleGrowthAtCycle !== undefined && cycle >= options.gdiHandleGrowthAtCycle ? 1 : 0),
    userHandles: baseUserHandles + (options.userHandleGrowthAtCycle !== undefined && cycle >= options.userHandleGrowthAtCycle ? 1 : 0),
    outputLocksHeld: options.outputLocksHeldAtCycle === cycle ? 1 : 0,
    outputLockWaitMs: options.outputLockWaitMsAtCycle === cycle ? 1 : 0,
    crashRecoveries: options.crashRecoveryAtCycle === cycle ? 1 : 0,
    recoveryRequired: options.recoveryRequiredAtCycle === cycle ? 1 : 0,
    workerGeneration: 1 + (options.crashRecoveryAtCycle !== undefined && cycle > options.crashRecoveryAtCycle ? 1 : 0),
    buildChurnHash: `cycle-${String(cycle).padStart(3, '0')}`,
  });
}

export function summarizeV2SoakMetrics(observations: readonly V2SoakCycleObservation[]): V2SoakMetricSummary {
  if (observations.length === 0) throw new Error('v2 soak report has no observations');
  const first = observations[0];
  const last = observations[observations.length - 1];
  return {
    baselinePrivateBytes: first.privateBytes,
    finalPrivateBytes: last.privateBytes,
    privateBytesDelta: last.privateBytes - first.privateBytes,
    peakPrivateBytes: maxOf(observations, (observation) => observation.privateBytes),
    baselineManagedHeapBytes: first.managedHeapBytes,
    finalManagedHeapBytes: last.managedHeapBytes,
    managedHeapBytesDelta: last.managedHeapBytes - first.managedHeapBytes,
    peakManagedHeapBytes: maxOf(observations, (observation) => observation.managedHeapBytes),
    baselineGdiHandles: first.gdiHandles,
    finalGdiHandles: last.gdiHandles,
    gdiHandleDelta: last.gdiHandles - first.gdiHandles,
    peakGdiHandles: maxOf(observations, (observation) => observation.gdiHandles),
    baselineUserHandles: first.userHandles,
    finalUserHandles: last.userHandles,
    userHandleDelta: last.userHandles - first.userHandles,
    peakUserHandles: maxOf(observations, (observation) => observation.userHandles),
    peakOutputLocksHeld: maxOf(observations, (observation) => observation.outputLocksHeld),
    peakOutputLockWaitMs: maxOf(observations, (observation) => observation.outputLockWaitMs),
    totalCrashRecoveries: observations.reduce((total, observation) => total + observation.crashRecoveries, 0),
    totalRecoveryRequired: observations.reduce((total, observation) => total + observation.recoveryRequired, 0),
    finalWorkerGeneration: last.workerGeneration,
  };
}

export function validateV2SoakReport(report: V2SoakReport): V2SoakValidationResult {
  const failures: string[] = [];
  const notExecuted: string[] = [];
  const profile = report.profile;
  const budgets = profile.budgets;

  if (report.observations.length !== profile.requiredCycles) {
    failures.push(`${profile.id} executed ${report.observations.length} cycles, expected ${profile.requiredCycles}`);
  }
  if (profile.requiresRealProductPath && report.evidence.realProductPath !== 'EXECUTED') {
    notExecuted.push(`${profile.id} requires real product-path execution`);
  }
  if (profile.requiresHardwareEvidence && report.evidence.hardware8hRun !== 'EXECUTED') {
    notExecuted.push(`${profile.id} requires real 8h hardware evidence`);
  }
  if (profile.minimumElapsedMs > 0 && report.elapsedMs < profile.minimumElapsedMs) {
    notExecuted.push(`${profile.id} elapsed ${report.elapsedMs}ms is below required ${profile.minimumElapsedMs}ms`);
  }

  validateObservations(report.observations, failures);
  validateBudget('private bytes delta', report.summary.privateBytesDelta, budgets.maxPrivateBytesDelta, failures);
  validateBudget('managed heap bytes delta', report.summary.managedHeapBytesDelta, budgets.maxManagedHeapBytesDelta, failures);
  validateBudget('GDI handle delta', report.summary.gdiHandleDelta, budgets.maxGdiHandleDelta, failures);
  validateBudget('USER handle delta', report.summary.userHandleDelta, budgets.maxUserHandleDelta, failures);
  validateBudget('output locks held', report.summary.peakOutputLocksHeld, budgets.maxOutputLocksHeld, failures);
  validateBudget('output lock wait ms', report.summary.peakOutputLockWaitMs, budgets.maxOutputLockWaitMs, failures);
  validateBudget('crash recoveries', report.summary.totalCrashRecoveries, budgets.maxCrashRecoveries, failures);
  validateBudget('recovery required count', report.summary.totalRecoveryRequired, budgets.maxRecoveryRequired, failures);

  return {
    status: failures.length > 0 ? 'FAIL' : notExecuted.length > 0 ? 'NOT_EXECUTED' : 'PASS',
    failures,
    notExecuted,
  };
}

export function assertV2SoakReport(report: V2SoakReport): void {
  const validation = validateV2SoakReport(report);
  if (validation.status === 'FAIL') {
    throw new Error(`v2 soak report failed:\n${validation.failures.join('\n')}`);
  }
}

function validateObservations(observations: readonly V2SoakCycleObservation[], failures: string[]): void {
  const hashes = new Set<string>();
  for (let index = 0; index < observations.length; index += 1) {
    const expectedCycle = index + 1;
    const observation = observations[index];
    if (observation.cycle !== expectedCycle) {
      failures.push(`observation ${index} recorded cycle ${observation.cycle}, expected ${expectedCycle}`);
    }
    if (!validHashLabel(observation.buildChurnHash)) {
      failures.push(`cycle ${observation.cycle} has invalid build churn hash`);
    } else if (hashes.has(observation.buildChurnHash)) {
      failures.push(`duplicate build churn hash ${observation.buildChurnHash}`);
    }
    hashes.add(observation.buildChurnHash);
    for (const [name, value] of Object.entries(observation)) {
      if (name === 'buildChurnHash') continue;
      if (!Number.isFinite(value) || value < 0) {
        failures.push(`cycle ${observation.cycle} has invalid ${name} ${String(value)}`);
      }
    }
  }
}

function validateBudget(label: string, actual: number, limit: number, failures: string[]): void {
  if (!Number.isFinite(actual) || actual < 0) {
    failures.push(`${label} is invalid: ${String(actual)}`);
  } else if (actual > limit) {
    failures.push(`${label} ${actual} exceeds budget ${limit}`);
  }
}

function validHashLabel(value: string): boolean {
  return /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}

function maxOf(
  observations: readonly V2SoakCycleObservation[],
  select: (observation: V2SoakCycleObservation) => number,
): number {
  return observations.reduce((maximum, observation) => Math.max(maximum, select(observation)), 0);
}
