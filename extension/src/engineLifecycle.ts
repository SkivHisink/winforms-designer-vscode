import type { ChildProcess } from 'node:child_process';

/** Stable host lifecycle facts shared by the process log and the redacted support bundle. */
export const ENGINE_EXIT_REASONS = [
  'idle', 'buildRelease', 'recycle', 'generationReplacement', 'budgetRecycle', 'shutdown', 'manualStop',
  'startupCancelled', 'startupFailed', 'requestDeadline', 'usageBudget', 'transportFailure', 'unexpectedExit',
] as const;
export type EngineExitReason = typeof ENGINE_EXIT_REASONS[number];
export interface EngineExitFact { reason: EngineExitReason; intentional: boolean; code: number | null; }

const requestedExits = new WeakMap<ChildProcess, EngineExitReason>();
const latestExits = new Map<'modern' | 'net48', EngineExitFact>();

/** Mark before signalling: an exit event can arrive synchronously in a test or immediately after kill(). */
export function terminateEngineProcess(proc: ChildProcess, reason: EngineExitReason, signal?: NodeJS.Signals): void {
  if (proc.exitCode != null || proc.signalCode != null) return;
  if (!requestedExits.has(proc)) requestedExits.set(proc, reason);
  try { proc.kill(signal); } catch { /* confirmed exit remains the caller's responsibility */ }
}

export function engineExitFact(proc: ChildProcess, code: number | null): EngineExitFact {
  const reason = requestedExits.get(proc) ?? 'unexpectedExit';
  return { reason, intentional: reason !== 'unexpectedExit' && reason !== 'transportFailure', code };
}

export function observeEngineProcessExit(
  proc: ChildProcess, runtime: 'modern' | 'net48', log: (line: string) => void,
): void {
  proc.once('exit', (code: number | null, signal: NodeJS.Signals | null) => {
    const fact = engineExitFact(proc, code);
    latestExits.set(runtime, fact);
    log(`[engine] exited code=${code ?? 'null'} signal=${signal ?? 'none'} reason=${fact.reason} intentional=${fact.intentional}`);
  });
}

export function latestEngineExit(runtime: 'modern' | 'net48'): EngineExitFact | undefined {
  const fact = latestExits.get(runtime);
  return fact ? { ...fact } : undefined;
}
