/** Admission waits before spawning/sending; it never repeats an engine operation or evicts a busy owner. */
export class EngineAdmissionGate {
  private pending = 0;
  constructor(private readonly maximumPending = 32) {}

  wait(available: () => boolean, deadline: number, cancellation?: AbortSignal): Promise<void> {
    const problem = (code: string): Error => Object.assign(new Error(code), { code });
    if (cancellation?.aborted) return Promise.reject(problem('REQUEST_CANCELLED'));
    if (available()) return Promise.resolve();
    if (this.pending >= this.maximumPending) return Promise.reject(problem('WORKER_BACKPRESSURE'));
    this.pending += 1;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: unknown): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        cancellation?.removeEventListener('abort', aborted);
        this.pending -= 1;
        if (error) reject(error); else resolve();
      };
      const aborted = (): void => finish(problem('REQUEST_CANCELLED'));
      const check = (): void => {
        if (cancellation?.aborted) { aborted(); return; }
        try {
          if (Date.now() >= deadline) { finish(problem('REQUEST_DEADLINE_EXCEEDED')); return; }
          if (available()) { finish(); return; }
        } catch (error) { finish(error); return; }
        timer = setTimeout(check, Math.min(50, Math.max(1, deadline - Date.now())));
      };
      cancellation?.addEventListener('abort', aborted, { once: true });
      check();
    });
  }
}
