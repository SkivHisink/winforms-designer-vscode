import { afterEach, expect, it, vi } from 'vitest';
import { EngineAdmissionGate } from './engineAdmission';
afterEach(() => vi.useRealTimers());

it('admits a waiting read when a genuinely busy workflow releases capacity before its deadline', async () => {
  vi.useFakeTimers(); const gate = new EngineAdmissionGate(); let free = false; let admitted = false;
  const pending = gate.wait(() => free, Date.now() + 1_000).then(() => { admitted = true; });
  await vi.advanceTimersByTimeAsync(200); expect(admitted).toBe(false);
  free = true; await vi.advanceTimersByTimeAsync(50); await pending; expect(admitted).toBe(true);
});

it('bounds waiters, deadline and cancellation and releases capacity after each refusal', async () => {
  vi.useFakeTimers(); const gate = new EngineAdmissionGate(1); const cancellation = new AbortController();
  const cancelled = expect(gate.wait(() => false, Date.now() + 1_000, cancellation.signal)).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
  await expect(gate.wait(() => false, Date.now() + 1_000)).rejects.toMatchObject({ code: 'WORKER_BACKPRESSURE' });
  cancellation.abort(); await cancelled;
  const timeout = expect(gate.wait(() => false, Date.now() + 100)).rejects.toMatchObject({ code: 'REQUEST_DEADLINE_EXCEEDED' });
  await vi.advanceTimersByTimeAsync(101); await timeout;
  await gate.wait(() => true, Date.now() + 1_000);
});

it('does not invoke the availability callback for an already cancelled admission', async () => {
  const gate = new EngineAdmissionGate(); const cancellation = new AbortController(); cancellation.abort();
  const available = vi.fn(() => true);
  await expect(gate.wait(available, Date.now() + 1_000, cancellation.signal)).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
  expect(available).not.toHaveBeenCalled();
});
