import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { engineExitFact, latestEngineExit, observeEngineProcessExit, terminateEngineProcess } from './engineLifecycle';
import { buildDesignerDiagnosticBundle } from './designerDiagnostics';

function child() {
  return Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, kill: vi.fn(() => true) }) as unknown as ChildProcess;
}

describe('worker exit reasons', () => {
  it.each(['idle', 'buildRelease', 'generationReplacement', 'budgetRecycle', 'shutdown', 'manualStop'] as const)(
    'keeps %s in the null-code exit log and the same diagnostic bundle facts', (reason) => {
      const proc = child(); const log = vi.fn();
      observeEngineProcessExit(proc, 'modern', log);
      terminateEngineProcess(proc, reason);
      proc.emit('exit', null, 'SIGTERM');
      expect(log).toHaveBeenCalledWith(`[engine] exited code=null signal=SIGTERM reason=${reason} intentional=true`);
      const fact = latestEngineExit('modern')!;
      const bundle = buildDesignerDiagnosticBundle({ engines: [{ kind: 'modern', lastExitCode: fact.code,
        lastExitReason: fact.reason, lastExitIntentional: fact.intentional }] }).bundle;
      expect(bundle.engines?.[0]).toMatchObject({ lastExitCode: null, lastExitReason: reason, lastExitIntentional: true });
    });

  it('distinguishes an unrequested signal from deliberate termination and keeps the first cause', () => {
    const crashed = child();
    expect(engineExitFact(crashed, null)).toEqual({ reason: 'unexpectedExit', intentional: false, code: null });
    terminateEngineProcess(crashed, 'transportFailure');
    terminateEngineProcess(crashed, 'recycle');
    expect(engineExitFact(crashed, 1)).toEqual({ reason: 'transportFailure', intentional: false, code: 1 });
  });

  it('rejects arbitrary lifecycle text at the diagnostic export boundary', () => {
    const result = buildDesignerDiagnosticBundle({ engines: [{ kind: 'modern', lastExitReason: 'PRIVATE_PATH',
      lastExitIntentional: 'PRIVATE_MESSAGE' }] } as any);
    expect(result.json).not.toContain('PRIVATE_');
    expect(result.bundle.truncation.invalidFields).toBe(2);
  });
});
