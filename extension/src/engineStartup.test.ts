import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SharedEngineStartup, confirmEngineStartupExit } from './engineStartup';
import { currentEngineRequestContext, retainEngineForCurrentRequest, withEngineRequestContext } from './engineRequestContext';
import { EngineRegistry } from './engineRegistry';
import { engineWorkerKey } from './engineRequestContext';

const context = { sessionId: 'document-a', documentId: 'A.Designer.cs', documentRevision: 1, renderGeneration: 1,
  sourceText: '', ownerProject: 'D:\\workspace\\App.csproj', configuration: 'Release', targetFramework: 'net10.0-windows',
  platform: 'AnyCPU', dependencyFingerprint: 'graph', dependencyIdentityMode: 'content' as const };

function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function fixture() {
  let leases = 0;
  const owner = { dispose: vi.fn(), acquireUsageLease: () => { leases += 1; let active = true;
    return () => { if (active) { active = false; leases -= 1; } }; },
  ping: vi.fn(async () => 'usable') };
  const connecting = deferred<typeof owner>();
  const actions = { start: vi.fn(() => connecting.promise), publish: vi.fn(), cancelPending: vi.fn(),
    confirmStopped: vi.fn(async (): Promise<void> => undefined), remove: vi.fn() };
  return { owner, connecting, actions, startup: new SharedEngineStartup(actions), leases: () => leases };
}

describe('shared physical engine startup ownership', () => {
  it('confirms an actual ENOENT spawn with an already observed close and no OS child', async () => {
    const child = spawn(path.resolve(`missing-startup-executable-${process.pid}.exe`), [], { windowsHide: true, stdio: 'ignore' });
    const error = deferred<Error>(); child.once('error', error.resolve);
    await new Promise<void>((resolve) => child.once('close', () => resolve()));
    expect(await error.promise).toMatchObject({ code: 'ENOENT' }); expect(child.pid).toBeUndefined();
    await confirmEngineStartupExit(child, 50);
  });

  it('cancels a closing creator promptly while another document receives one usable worker in its own scope', async () => {
    const f = fixture(); const a = new AbortController(); const keepB = deferred<void>();
    const first = withEngineRequestContext({ ...context, cancellation: a.signal },
      () => f.startup.acquire(retainEngineForCurrentRequest, a.signal));
    const cancelled = expect(first).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
    const second = withEngineRequestContext({ ...context, sessionId: 'document-b', documentId: 'B.Designer.cs' }, async () => {
      const owner = await f.startup.acquire(retainEngineForCurrentRequest);
      expect(currentEngineRequestContext()?.sessionId).toBe('document-b');
      expect(f.leases()).toBe(1);
      expect(await owner.ping()).toBe('usable');
      await keepB.promise;
      return owner;
    });
    a.abort(); await cancelled; // abort fires outside either consumer's ALS scope
    expect(f.actions.cancelPending).not.toHaveBeenCalled();
    f.connecting.resolve(f.owner);
    await new Promise((resolve) => setImmediate(resolve));
    expect(f.actions.start).toHaveBeenCalledOnce(); expect(f.actions.publish).toHaveBeenCalledOnce();
    expect(f.owner.dispose).not.toHaveBeenCalled(); keepB.resolve(); await second; expect(f.leases()).toBe(0);
  });

  it('refuses only a completed detached scope when another active consumer still needs the startup', async () => {
    const f = fixture(); let late!: Promise<typeof f.owner>;
    withEngineRequestContext(context, () => { late = f.startup.acquire(retainEngineForCurrentRequest); });
    const refused = expect(late).rejects.toMatchObject({ code: 'WORKER_REQUEST_SCOPE_COMPLETED' });
    const active = withEngineRequestContext({ ...context, sessionId: 'document-b' },
      () => f.startup.acquire(retainEngineForCurrentRequest));
    f.connecting.resolve(f.owner); await refused; expect(await active).toBe(f.owner);
    expect(f.actions.publish).toHaveBeenCalledOnce(); expect(f.owner.dispose).not.toHaveBeenCalled(); expect(f.leases()).toBe(0);
  });

  it('kills an abandoned real child and blocks later consumers until its physical exit is confirmed', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });
    const connecting = deferred<{ dispose(): void }>(); const owner = { dispose: vi.fn(() => { child.kill(); }) };
    const publish = vi.fn(); const removed = vi.fn(); const a = new AbortController(); const b = new AbortController();
    const startup = new SharedEngineStartup({ start: () => connecting.promise, publish,
      cancelPending: () => { child.kill(); }, confirmStopped: () => confirmEngineStartupExit(child), remove: removed });
    try {
      const first = expect(startup.acquire((value) => value, a.signal)).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
      const second = expect(startup.acquire((value) => value, b.signal)).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
      a.abort(); b.abort(); await Promise.all([first, second]);
      expect(startup.isAbandoned).toBe(true);
      await expect(startup.acquire((value) => value)).rejects.toMatchObject({ code: 'WORKER_STARTUP_ABANDONED' });
      expect(removed).not.toHaveBeenCalled();
      connecting.resolve(owner); await startup.waitForCleanup();
      expect(child.exitCode != null || child.signalCode != null).toBe(true);
      expect(owner.dispose).toHaveBeenCalledOnce(); expect(publish).not.toHaveBeenCalled(); expect(removed).toHaveBeenCalledOnce();
    } finally { child.kill(); await confirmEngineStartupExit(child); }
  });

  it('disposes a late owner without publication when the sole consumer cancels', async () => {
    const f = fixture(); const a = new AbortController();
    const cancelled = expect(f.startup.acquire((value) => value, a.signal)).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
    a.abort(); await cancelled; expect(f.actions.cancelPending).toHaveBeenCalledOnce();
    f.connecting.resolve(f.owner); await f.startup.waitForCleanup();
    expect(f.owner.dispose).toHaveBeenCalledOnce(); expect(f.actions.publish).not.toHaveBeenCalled(); expect(f.leases()).toBe(0);
  });

  it('holds the cleanup barrier when all consumers cancel during publication before their handoff', async () => {
    const f = fixture(); const a = new AbortController(); const b = new AbortController(); const stopped = deferred<void>();
    const registry = new EngineRegistry<typeof f.owner>();
    f.actions.publish.mockImplementation((owner) => { registry.set('modern', owner); a.abort(); b.abort(); });
    f.actions.confirmStopped.mockImplementation(() => stopped.promise);
    f.actions.remove.mockImplementation(() => { registry.deleteValue(f.owner); });
    const first = expect(f.startup.acquire((value) => value, a.signal)).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
    const second = expect(f.startup.acquire((value) => value, b.signal)).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
    f.connecting.resolve(f.owner); await Promise.all([first, second]);
    expect(f.startup.isAbandoned).toBe(true); expect(f.owner.dispose).toHaveBeenCalledOnce();
    await expect(f.startup.acquire((value) => value)).rejects.toMatchObject({ code: 'WORKER_STARTUP_ABANDONED' });
    let cleaned = false; const cleanup = f.startup.waitForCleanup().then(() => { cleaned = true; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(cleaned).toBe(false); expect(registry.get('modern')).toBe(f.owner);
    stopped.resolve(); await cleanup; expect(registry.get('modern')).toBeUndefined(); expect(f.leases()).toBe(0);
  });

  it('keeps a timed-out abandoned process blocked but releases the slot after actual late exit', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture(); const a = new AbortController();
      const process = Object.assign(new EventEmitter(), { pid: 123, exitCode: null as number | null, signalCode: null, kill: vi.fn() });
      f.actions.confirmStopped.mockImplementation(() => confirmEngineStartupExit(process as unknown as ChildProcess, 50));
      const cancelled = expect(f.startup.acquire((value) => value, a.signal)).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
      a.abort(); await cancelled; f.connecting.resolve(f.owner);
      const blocked = expect(f.startup.waitForCleanup()).rejects.toMatchObject({ code: 'WORKER_PROCESS_RECYCLE_BLOCKED' });
      await vi.advanceTimersByTimeAsync(51); await blocked;
      expect(f.actions.remove).not.toHaveBeenCalled();
      const stillBlocked = expect(f.startup.waitForCleanup()).rejects.toMatchObject({ code: 'WORKER_PROCESS_RECYCLE_BLOCKED' });
      await vi.advanceTimersByTimeAsync(51); await stillBlocked;
      expect(f.actions.remove).not.toHaveBeenCalled();
      process.exitCode = 1; process.emit('exit', 1); await f.startup.waitForCleanup();
      expect(f.actions.remove).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it('bounds and cancels each cleanup waiter without cancelling shared process cleanup', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture(); const a = new AbortController(); const b = new AbortController(); const stopped = deferred<void>();
      f.actions.confirmStopped.mockImplementation(() => stopped.promise);
      const cancelledA = expect(f.startup.acquire((value) => value, a.signal)).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
      a.abort(); await cancelledA; f.connecting.resolve(f.owner);
      const cancelledB = expect(f.startup.waitForCleanup(Date.now() + 1_000, b.signal)).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
      b.abort(); await cancelledB;
      const expired = expect(f.startup.waitForCleanup(Date.now() + 50)).rejects.toMatchObject({ code: 'REQUEST_DEADLINE_EXCEEDED' });
      await vi.advanceTimersByTimeAsync(51); await expired;
      expect(f.actions.remove).not.toHaveBeenCalled(); expect(f.actions.confirmStopped).toHaveBeenCalledOnce();
      const stillActive = f.startup.waitForCleanup(Date.now() + 1_000);
      stopped.resolve(); await stillActive; expect(f.actions.remove).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it('passes one startup rejection to every consumer and removes only the failed entry', async () => {
    const f = fixture(); const registry = new EngineRegistry<SharedEngineStartup<typeof f.owner>>();
    registry.set('modern', f.startup);
    f.actions.remove.mockImplementation(() => { registry.deleteValue(f.startup); });
    const failure = new Error('startup failed');
    const first = expect(f.startup.acquire((value) => value)).rejects.toBe(failure);
    const second = expect(f.startup.acquire((value) => value)).rejects.toBe(failure);
    const replacement = fixture().startup; registry.set('modern', replacement);
    f.connecting.reject(failure); await Promise.all([first, second]); await f.startup.waitForCleanup();
    expect(registry.get('modern')).toBe(replacement); expect(f.actions.start).toHaveBeenCalledOnce();
    expect(f.actions.remove).toHaveBeenCalledOnce();
  });

  it('keeps explicit stop authoritative despite live consumers and consumes a late completion', async () => {
    const f = fixture();
    const stopped = expect(f.startup.acquire((value) => value)).rejects.toMatchObject({ code: 'WORKER_STARTUP_ABANDONED' });
    f.startup.stop(); f.connecting.resolve(f.owner); await stopped; await f.startup.waitForCleanup();
    expect(f.actions.cancelPending).toHaveBeenCalledOnce(); expect(f.owner.dispose).toHaveBeenCalledOnce();
    expect(f.actions.publish).not.toHaveBeenCalled();
  });

  it('bounds joining consumers and refuses an already cancelled caller without launching', async () => {
    const f = fixture(); const startup = new SharedEngineStartup(f.actions, 1); const aborted = new AbortController(); aborted.abort();
    await expect(startup.acquire((value) => value, aborted.signal)).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
    expect(f.actions.start).not.toHaveBeenCalled();
    const first = startup.acquire((value) => value);
    await expect(startup.acquire((value) => value)).rejects.toMatchObject({ code: 'WORKER_BACKPRESSURE' });
    f.connecting.resolve(f.owner); await first;
  });

  it('publishes under the immutable graph captured before the creator context changes', async () => {
    const f = fixture(); const registry = new EngineRegistry<typeof f.owner>();
    const key = engineWorkerKey('modern', context);
    f.actions.publish.mockImplementation((owner) => { registry.set('modern', owner, key); });
    await withEngineRequestContext(context, async () => {
      const acquired = f.startup.acquire(retainEngineForCurrentRequest);
      Object.assign(currentEngineRequestContext()!, { dependencyFingerprint: 'later-graph' });
      f.connecting.resolve(f.owner); await acquired;
      expect(registry.get('modern')).toBeUndefined();
    });
    withEngineRequestContext(context, () => expect(registry.get('modern')).toBe(f.owner));
  });
});
