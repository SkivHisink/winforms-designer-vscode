import type { ChildProcess } from 'node:child_process';

interface StartupOwner { dispose(): void; acquireUsageLease?(): () => void; }

interface StartupActions<T> {
  start(): Promise<T>;
  publish(value: T): void;
  cancelPending(): void;
  confirmStopped(): Promise<void>;
  remove(): void;
}

/** A shared physical startup belongs to its live consumers, not the async scope that initiated it. */
export class SharedEngineStartup<T extends StartupOwner> {
  private startup: Promise<T> | undefined;
  private owner: T | undefined;
  private reservation: (() => void) | undefined;
  private consumers = 0;
  private accepted = false;
  private abandoned = false;
  private cleanup: Promise<void> | undefined;
  private cleanupFailed = false;
  private disposed = false;
  private cleanupWaiters = 0;

  constructor(private readonly actions: StartupActions<T>, private readonly maximumConsumers = 32) {}

  get value(): T | undefined { return this.owner; }
  get isAbandoned(): boolean { return this.abandoned; }

  stop(): void { this.abandon(); }

  acquire(retain: (value: T) => T, cancellation?: AbortSignal): Promise<T> {
    const problem = (code: string): Error => Object.assign(new Error(code), { code });
    if (cancellation?.aborted) return Promise.reject(problem('REQUEST_CANCELLED'));
    if (this.abandoned) return Promise.reject(problem('WORKER_STARTUP_ABANDONED'));
    if (this.consumers >= this.maximumConsumers) return Promise.reject(problem('WORKER_BACKPRESSURE'));
    this.consumers += 1;
    return new Promise<T>((resolve, reject) => {
      let active = true;
      const finish = (): void => {
        if (!active) return;
        active = false;
        cancellation?.removeEventListener('abort', aborted);
        this.consumers -= 1;
        if (this.consumers === 0) {
          this.reservation?.(); this.reservation = undefined;
          if (!this.accepted) this.abandon();
        }
      };
      const aborted = (): void => { finish(); reject(problem('REQUEST_CANCELLED')); };
      cancellation?.addEventListener('abort', aborted, { once: true });
      // Register this callback in each consumer's ALS context. A closed creator cannot poison other consumers.
      void this.begin().then((value) => {
        if (!active) return;
        if (this.abandoned) { finish(); reject(problem('WORKER_SUPERVISOR_DISPOSED')); return; }
        try {
          const retained = retain(value);
          this.accepted = true;
          finish(); resolve(retained);
        } catch (error) { finish(); reject(error); }
      }, (error) => { if (active) { finish(); reject(error); } });
    });
  }

  /** A new acquisition waits for actual abandoned-process exit before replacing the same startup. */
  waitForCleanup(deadline?: number, cancellation?: AbortSignal): Promise<void> {
    const problem = (code: string): Error => Object.assign(new Error(code), { code });
    if (cancellation?.aborted) return Promise.reject(problem('REQUEST_CANCELLED'));
    if (deadline !== undefined && Date.now() >= deadline) return Promise.reject(problem('REQUEST_DEADLINE_EXCEEDED'));
    if (this.cleanupFailed) this.cleanup = this.confirmCleanup();
    const cleanup = this.cleanup ?? Promise.resolve();
    if (deadline === undefined && !cancellation) return cleanup;
    if (this.cleanupWaiters >= this.maximumConsumers) return Promise.reject(problem('WORKER_BACKPRESSURE'));
    this.cleanupWaiters += 1;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: unknown): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        cancellation?.removeEventListener('abort', aborted);
        this.cleanupWaiters -= 1;
        if (error) reject(error); else resolve();
      };
      const aborted = (): void => finish(problem('REQUEST_CANCELLED'));
      cancellation?.addEventListener('abort', aborted, { once: true });
      if (deadline !== undefined) timer = setTimeout(() => finish(problem('REQUEST_DEADLINE_EXCEEDED')), Math.max(1, deadline - Date.now()));
      void cleanup.then(() => finish(), finish);
    });
  }

  private begin(): Promise<T> {
    if (this.startup) return this.startup;
    let complete!: (value: T) => void;
    let fail!: (error: unknown) => void;
    const physical = new Promise<T>((resolve, reject) => { complete = resolve; fail = reject; });
    this.startup = physical.then((value) => {
      this.owner = value;
      if (this.abandoned) {
        this.disposeOwner();
        throw Object.assign(new Error('WORKER_STARTUP_ABANDONED'), { code: 'WORKER_STARTUP_ABANDONED' });
      }
      this.reservation = value.acquireUsageLease?.();
      try { this.actions.publish(value); }
      catch (error) { this.disposeOwner(); throw error; }
      return value;
    });
    // A fully cancelled startup still owns its eventual process and consumes a late rejection.
    void this.startup.catch(() => undefined);
    try { void this.actions.start().then(complete, fail); }
    catch (error) { fail(error); }
    return this.startup;
  }

  private disposeOwner(): void {
    if (this.disposed || !this.owner) return;
    this.disposed = true;
    try { this.owner.dispose(); } catch { /* cancelPending plus exit confirmation remain the physical backstop */ }
  }

  private abandon(): void {
    if (this.abandoned) return;
    this.abandoned = true;
    this.disposeOwner();
    this.actions.cancelPending();
    this.cleanup = this.confirmCleanup();
  }

  private confirmCleanup(): Promise<void> {
    this.cleanupFailed = false;
    const result = (this.startup ?? Promise.resolve()).catch(() => undefined)
      .then(() => this.actions.confirmStopped()).then(() => { this.actions.remove(); })
      .catch((error) => { this.cleanupFailed = true; throw error; });
    void result.catch(() => undefined); // a later acquisition rechecks actual exit after a failed confirmation
    return result;
  }
}

/** Process facts, never the signal-sent flag, establish that an abandoned startup has relinquished ownership. */
export function confirmEngineStartupExit(proc: ChildProcess | undefined, timeoutMs = 5_000): Promise<void> {
  if (!proc || proc.pid === undefined || proc.exitCode != null || proc.signalCode != null) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const finish = (error?: Error): void => {
      clearTimeout(timer); proc.off('exit', stopped); proc.off('close', stopped);
      if (error) reject(error); else resolve();
    };
    const stopped = (): void => finish();
    const timer = setTimeout(() => finish(Object.assign(new Error('WORKER_PROCESS_RECYCLE_BLOCKED'), { code: 'WORKER_PROCESS_RECYCLE_BLOCKED' })), timeoutMs);
    proc.once('exit', stopped); proc.once('close', stopped);
    try { proc.kill('SIGKILL'); } catch { /* wait for confirmed facts */ }
  });
}
