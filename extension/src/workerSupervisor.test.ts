import { describe, expect, it } from 'vitest';
import { RecoveryDecision } from './engineRecovery';
import {
  SupervisedWorker,
  WorkerAdapter,
  WorkerClock,
  WorkerEnvelope,
  WorkerReply,
  WorkerSupervisor,
  WorkerTimer,
} from './workerSupervisor';
import { WorkerKey, WorkerPayloadIdentity } from './workerSelection';

interface RequestPayload {
  command: string;
  sourceText?: string;
}

interface RequestResult {
  value: string;
  sourceText?: string;
}

const key: WorkerKey = { runtime: 'modern', workerArchitecture: 'x64', compatibility: 'native' };
const net48Key: WorkerKey = { runtime: 'net48', workerArchitecture: 'x64', compatibility: 'native' };
const identity: WorkerPayloadIdentity = {
  sessionId: 'identity-session',
  documentId: 'Form1.cs',
  documentRevision: 'rev-1',
  sourceFingerprint: 'a'.repeat(64),
  payloadHash: 'payload-1',
};

class ManualClock implements WorkerClock {
  private current = 0;
  private readonly timers: Array<{ due: number; callback: () => void; cancelled: boolean }> = [];

  now(): number {
    return this.current;
  }

  setTimer(callback: () => void, delayMs: number): WorkerTimer {
    const timer = { due: this.current + Math.max(0, delayMs), callback, cancelled: false };
    this.timers.push(timer);
    return { cancel: () => { timer.cancelled = true; } };
  }

  advance(ms: number): void {
    this.current += ms;
    const due = this.timers
      .filter((timer) => !timer.cancelled && timer.due <= this.current)
      .sort((a, b) => a.due - b.due);
    for (const timer of due) {
      if (!timer.cancelled) {
        timer.cancelled = true;
        timer.callback();
      }
    }
  }
}

class Deferred<T> {
  readonly promise: Promise<T>;
  private resolveCore!: (value: T) => void;
  private rejectCore!: (error: Error) => void;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolveCore = resolve;
      this.rejectCore = reject;
    });
  }

  resolve(value: T): void {
    this.resolveCore(value);
  }

  reject(error: Error): void {
    this.rejectCore(error);
  }
}

class FakeWorker implements SupervisedWorker<RequestPayload, RequestResult> {
  readonly sends: WorkerEnvelope<RequestPayload>[] = [];
  readonly replies: Array<Deferred<WorkerReply<RequestResult>>> = [];
  disposed = false;
  throwOnSend = false;

  constructor(readonly key: WorkerKey) {}

  send(envelope: WorkerEnvelope<RequestPayload>): Promise<WorkerReply<RequestResult>> {
    if (this.throwOnSend) throw new Error('send failed');
    this.sends.push(envelope);
    const reply = new Deferred<WorkerReply<RequestResult>>();
    this.replies.push(reply);
    return reply.promise;
  }

  dispose(): void {
    this.disposed = true;
  }
}

class FakeAdapter implements WorkerAdapter<RequestPayload, RequestResult> {
  readonly workers: FakeWorker[] = [];

  async start(key: WorkerKey): Promise<SupervisedWorker<RequestPayload, RequestResult>> {
    const worker = new FakeWorker(key);
    this.workers.push(worker);
    return worker;
  }
}

class FakeRecovery {
  private decisions: RecoveryDecision[] = [];
  readonly calls: Array<{ kind: 'modern' | 'net48'; now?: number }> = [];

  constructor(...decisions: RecoveryDecision[]) {
    this.decisions = decisions;
  }

  recordCrash(kind: 'modern' | 'net48', now?: number): RecoveryDecision {
    this.calls.push({ kind, now });
    return this.decisions.shift() ?? { restart: false, delayMs: 0, recentCrashes: this.calls.length };
  }
}

async function flushSupervisorStart(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitForSend(adapter: FakeAdapter, workerIndex: number, sendIndex: number): Promise<WorkerEnvelope<RequestPayload>> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const envelope = adapter.workers[workerIndex]?.sends[sendIndex];
    if (envelope) return envelope;
    await flushSupervisorStart();
  }
  throw new Error(`missing worker ${workerIndex} send ${sendIndex}`);
}

describe('WorkerSupervisor', () => {
  it('wraps requests in a v2 envelope with deadline and payload identity', async () => {
    const clock = new ManualClock();
    const adapter = new FakeAdapter();
    const supervisor = new WorkerSupervisor<RequestPayload, RequestResult>(adapter, {
      sessionId: 'session-a',
      recoveryPolicy: new FakeRecovery(),
      clock,
    });

    const pending = supervisor.request(key, identity, { command: 'render' }, 250);
    await flushSupervisorStart();

    const envelope = await waitForSend(adapter, 0, 0);
    const worker = adapter.workers[0];
    expect(envelope).toMatchObject({
      sessionId: 'session-a',
      generation: 1,
      requestId: 'session-a:1',
      deadlineAt: 250,
      identity,
      payload: { command: 'render' },
    });
    expect(envelope.protocol).toMatchObject({
      protocolId: 'designer-protocol-v2',
      protocolVersion: 2,
      documentRevision: 'rev-1',
      renderGeneration: 1,
      sourceFingerprint: { artifactId: 'source', value: 'a'.repeat(64) },
      deadlineUnixMilliseconds: 250,
      payloadJson: '{"command":"render"}',
    });

    worker.replies[0].resolve({
      sessionId: envelope.sessionId,
      generation: envelope.generation,
      requestId: envelope.requestId,
      status: 'ok',
      result: { value: 'frame' },
    });

    await expect(pending).resolves.toEqual({
      status: 'ok',
      result: { value: 'frame' },
      requestId: 'session-a:1',
      generation: 1,
    });
  });

  it('cancels and deadlines requests without accepting late replies', async () => {
    const clock = new ManualClock();
    const adapter = new FakeAdapter();
    const supervisor = new WorkerSupervisor<RequestPayload, RequestResult>(adapter, {
      sessionId: 'session-a',
      recoveryPolicy: new FakeRecovery(),
      clock,
    });

    const timedOut = supervisor.request(key, identity, { command: 'render' }, 100);
    await waitForSend(adapter, 0, 0);
    clock.advance(101);
    await expect(timedOut).resolves.toMatchObject({
      status: 'deadlineExceeded',
      reasonCode: 'REQUEST_DEADLINE_EXCEEDED',
      requestId: 'session-a:1',
      generation: 1,
    });

    const controller = new AbortController();
    const cancelled = supervisor.request(key, identity, { command: 'describe' }, 100, controller.signal);
    await waitForSend(adapter, 0, 1);
    controller.abort();
    await expect(cancelled).resolves.toMatchObject({
      status: 'cancelled',
      reasonCode: 'REQUEST_CANCELLED',
      requestId: 'session-a:2',
      generation: 1,
    });
  });

  it('maps synchronous send failures to structured fault results', async () => {
    const clock = new ManualClock();
    const adapter = new FakeAdapter();
    const supervisor = new WorkerSupervisor<RequestPayload, RequestResult>(adapter, {
      sessionId: 'session-a',
      recoveryPolicy: new FakeRecovery(),
      clock,
    });

    const first = supervisor.request(key, identity, { command: 'render' }, 100);
    const firstEnvelope = await waitForSend(adapter, 0, 0);
    adapter.workers[0].replies[0].resolve({
      sessionId: firstEnvelope.sessionId,
      generation: firstEnvelope.generation,
      requestId: firstEnvelope.requestId,
      status: 'ok',
      result: { value: 'first' },
    });
    await expect(first).resolves.toMatchObject({ status: 'ok' });

    adapter.workers[0].throwOnSend = true;
    await expect(supervisor.request(key, identity, { command: 'render' }, 100)).resolves.toMatchObject({
      status: 'faulted',
      reasonCode: 'WORKER_REQUEST_FAULTED',
      requestId: 'session-a:2',
      generation: 1,
    });
  });

  it('refuses malformed protocol identity before starting a worker', async () => {
    const clock = new ManualClock();
    const adapter = new FakeAdapter();
    const supervisor = new WorkerSupervisor<RequestPayload, RequestResult>(adapter, {
      sessionId: 'session-a', recoveryPolicy: new FakeRecovery(), clock,
    });

    await expect(supervisor.request(key, { ...identity, sourceFingerprint: 'not-sha256' },
      { command: 'render' }, 100)).resolves.toMatchObject({
      status: 'refused', reasonCode: 'INVALID_ENVELOPE', generation: 1,
    });
    expect(adapter.workers).toHaveLength(0);
  });

  it('rejects stale replies by session, request, and generation', async () => {
    const clock = new ManualClock();
    const adapter = new FakeAdapter();
    const supervisor = new WorkerSupervisor<RequestPayload, RequestResult>(adapter, {
      sessionId: 'session-a',
      recoveryPolicy: new FakeRecovery(),
      clock,
    });

    const wrongSession = supervisor.request(key, identity, { command: 'render' }, 100);
    const firstEnvelope = await waitForSend(adapter, 0, 0);
    adapter.workers[0].replies[0].resolve({
      sessionId: 'other-session',
      generation: firstEnvelope.generation,
      requestId: firstEnvelope.requestId,
      status: 'ok',
      result: { value: 'bad' },
    });
    await expect(wrongSession).resolves.toMatchObject({ status: 'stale', reasonCode: 'STALE_WORKER_REPLY' });

    const wrongRequest = supervisor.request(key, identity, { command: 'render' }, 100);
    const secondEnvelope = await waitForSend(adapter, 0, 1);
    adapter.workers[0].replies[1].resolve({
      sessionId: secondEnvelope.sessionId,
      generation: secondEnvelope.generation,
      requestId: 'session-a:999',
      status: 'ok',
      result: { value: 'bad' },
    });
    await expect(wrongRequest).resolves.toMatchObject({ status: 'stale', reasonCode: 'STALE_WORKER_REPLY' });

    const oldGeneration = supervisor.request(key, identity, { command: 'render' }, 100);
    const thirdEnvelope = await waitForSend(adapter, 0, 2);
    supervisor.recordCrash(key);
    adapter.workers[0].replies[2].resolve({
      sessionId: thirdEnvelope.sessionId,
      generation: thirdEnvelope.generation,
      requestId: thirdEnvelope.requestId,
      status: 'ok',
      result: { value: 'bad' },
    });
    await expect(oldGeneration).resolves.toMatchObject({ status: 'stale', reasonCode: 'STALE_WORKER_REPLY' });
  });

  it('honors recovery quarantine before replacing a crashed worker', async () => {
    const clock = new ManualClock();
    const adapter = new FakeAdapter();
    const recovery = new FakeRecovery({ restart: true, delayMs: 25, recentCrashes: 1 });
    const supervisor = new WorkerSupervisor<RequestPayload, RequestResult>(adapter, {
      sessionId: 'session-a',
      recoveryPolicy: recovery,
      clock,
    });

    const first = supervisor.request(key, identity, { command: 'render' }, 100);
    const firstEnvelope = await waitForSend(adapter, 0, 0);
    const firstWorker = adapter.workers[0];
    firstWorker.replies[0].resolve({
      sessionId: firstEnvelope.sessionId,
      generation: firstEnvelope.generation,
      requestId: firstEnvelope.requestId,
      status: 'ok',
      result: { value: 'first' },
    });
    await expect(first).resolves.toMatchObject({ status: 'ok' });

    expect(supervisor.recordCrash(key)).toEqual({ restart: true, delayMs: 25, recentCrashes: 1 });
    expect(firstWorker.disposed).toBe(true);
    expect(supervisor.state(key)).toMatchObject({
      generation: 2, state: 'quarantined', recentCrashes: 1, quarantineUntil: 25,
    });

    await expect(supervisor.request(key, identity, { command: 'render' }, 100)).resolves.toMatchObject({
      status: 'refused', reasonCode: 'WORKER_QUARANTINED', generation: 2,
    });
    expect(adapter.workers).toHaveLength(1);

    clock.advance(24);
    await expect(supervisor.request(key, identity, { command: 'render' }, 100)).resolves.toMatchObject({
      status: 'refused', reasonCode: 'WORKER_QUARANTINED', generation: 2,
    });
    expect(adapter.workers).toHaveLength(1);

    clock.advance(1);
    const second = supervisor.request(key, identity, { command: 'render' }, 100);
    await waitForSend(adapter, 1, 0);
    expect(adapter.workers).toHaveLength(2);
    const secondEnvelope = adapter.workers[1].sends[0];
    expect(secondEnvelope.generation).toBe(2);
    adapter.workers[1].replies[0].resolve({
      sessionId: secondEnvelope.sessionId,
      generation: secondEnvelope.generation,
      requestId: secondEnvelope.requestId,
      status: 'ok',
      result: { value: 'second' },
    });
    await expect(second).resolves.toMatchObject({ status: 'ok', result: { value: 'second' }, generation: 2 });
  });

  it('enters crash-loop state when recovery policy refuses restart', async () => {
    const clock = new ManualClock();
    const adapter = new FakeAdapter();
    const supervisor = new WorkerSupervisor<RequestPayload, RequestResult>(adapter, {
      sessionId: 'session-a',
      recoveryPolicy: new FakeRecovery({ restart: false, delayMs: 0, recentCrashes: 3 }),
      clock,
    });

    expect(supervisor.recordCrash(key)).toEqual({ restart: false, delayMs: 0, recentCrashes: 3 });
    expect(supervisor.state(key)).toMatchObject({ generation: 2, state: 'crashLoop', recentCrashes: 3 });

    await expect(supervisor.request(key, identity, { command: 'render' }, 100)).resolves.toMatchObject({
      status: 'crashLoop',
      reasonCode: 'WORKER_CRASH_LOOP',
      requestId: 'session-a:1',
      generation: 2,
    });
    expect(adapter.workers).toHaveLength(0);
  });

  it('V2-FND-001-S103 recycles a modern dependency-load failure without accepting a stale reply', async () => {
    const clock = new ManualClock();
    const adapter = new FakeAdapter();
    const recovery = new FakeRecovery({ restart: true, delayMs: 25, recentCrashes: 1 });
    const supervisor = new WorkerSupervisor<RequestPayload, RequestResult>(adapter, {
      sessionId: 'session-a',
      recoveryPolicy: recovery,
      clock,
    });

    const staleRender = supervisor.request(key, identity, { command: 'render' }, 100);
    const staleEnvelope = await waitForSend(adapter, 0, 0);
    const firstWorker = adapter.workers[0];

    expect(supervisor.recordCrash(key)).toEqual({ restart: true, delayMs: 25, recentCrashes: 1 });
    expect(firstWorker.disposed).toBe(true);
    firstWorker.replies[0].resolve({
      sessionId: staleEnvelope.sessionId,
      generation: staleEnvelope.generation,
      requestId: staleEnvelope.requestId,
      status: 'refused',
      reasonCode: 'DEPENDENCY_LOAD_FAILED',
    });
    await expect(staleRender).resolves.toMatchObject({
      status: 'stale',
      reasonCode: 'STALE_WORKER_REPLY',
      requestId: 'session-a:1',
      generation: 1,
    });

    await expect(supervisor.request(key, identity, { command: 'render' }, 100)).resolves.toMatchObject({
      status: 'refused',
      reasonCode: 'WORKER_QUARANTINED',
      requestId: 'session-a:2',
      generation: 2,
    });

    clock.advance(25);
    const recoveredRender = supervisor.request(key, identity, { command: 'render' }, 100);
    const recoveredEnvelope = await waitForSend(adapter, 1, 0);
    expect(adapter.workers).toHaveLength(2);
    expect(recoveredEnvelope.generation).toBe(2);
    adapter.workers[1].replies[0].resolve({
      sessionId: recoveredEnvelope.sessionId,
      generation: recoveredEnvelope.generation,
      requestId: recoveredEnvelope.requestId,
      status: 'ok',
      result: { value: 'recovered-frame' },
    });
    await expect(recoveredRender).resolves.toMatchObject({
      status: 'ok',
      result: { value: 'recovered-frame' },
      requestId: 'session-a:3',
      generation: 2,
    });
  });

  it('V2-FND-001-S107 keeps net48 live-source bytes immutable across crash recovery', async () => {
    const clock = new ManualClock();
    const adapter = new FakeAdapter();
    const recovery = new FakeRecovery({ restart: true, delayMs: 0, recentCrashes: 1 });
    const supervisor = new WorkerSupervisor<RequestPayload, RequestResult>(adapter, {
      sessionId: 'session-a',
      recoveryPolicy: recovery,
      clock,
    });
    const liveSource = 'partial class Form1 { void InitializeComponent() { this.Text = "live"; } }';
    const liveIdentity: WorkerPayloadIdentity = {
      ...identity,
      documentRevision: 'rev-live-source',
      sourceFingerprint: 'b'.repeat(64),
      payloadHash: 'payload-live-source',
    };

    const staleRender = supervisor.request(
      net48Key,
      liveIdentity,
      { command: 'render', sourceText: liveSource },
      100,
    );
    const staleEnvelope = await waitForSend(adapter, 0, 0);
    expect(staleEnvelope.payload.sourceText).toBe(liveSource);

    expect(supervisor.recordCrash(net48Key)).toEqual({ restart: true, delayMs: 0, recentCrashes: 1 });
    adapter.workers[0].replies[0].resolve({
      sessionId: staleEnvelope.sessionId,
      generation: staleEnvelope.generation,
      requestId: staleEnvelope.requestId,
      status: 'ok',
      result: { value: 'stale-frame', sourceText: 'CORRUPTED' },
    });
    await expect(staleRender).resolves.toMatchObject({
      status: 'stale',
      reasonCode: 'STALE_WORKER_REPLY',
      requestId: 'session-a:1',
      generation: 1,
    });

    const recoveredRender = supervisor.request(
      net48Key,
      liveIdentity,
      { command: 'render', sourceText: liveSource },
      100,
    );
    const recoveredEnvelope = await waitForSend(adapter, 1, 0);
    expect(recoveredEnvelope.generation).toBe(2);
    expect(recoveredEnvelope.identity.sourceFingerprint).toBe('b'.repeat(64));
    expect(recoveredEnvelope.payload.sourceText).toBe(liveSource);
    adapter.workers[1].replies[0].resolve({
      sessionId: recoveredEnvelope.sessionId,
      generation: recoveredEnvelope.generation,
      requestId: recoveredEnvelope.requestId,
      status: 'ok',
      result: { value: 'fresh-frame', sourceText: liveSource },
    });

    await expect(recoveredRender).resolves.toEqual({
      status: 'ok',
      result: { value: 'fresh-frame', sourceText: liveSource },
      requestId: 'session-a:2',
      generation: 2,
    });
  });

  it('V2-FND-001-S104 repo boundary disposes supervised idle workers; leak trend remains external-lab evidence', async () => {
    const clock = new ManualClock();
    const adapter = new FakeAdapter();
    const supervisor = new WorkerSupervisor<RequestPayload, RequestResult>(adapter, {
      sessionId: 'session-a',
      recoveryPolicy: new FakeRecovery(),
      clock,
    });

    const first = supervisor.request(key, identity, { command: 'render' }, 100);
    const firstEnvelope = await waitForSend(adapter, 0, 0);
    adapter.workers[0].replies[0].resolve({
      sessionId: firstEnvelope.sessionId,
      generation: firstEnvelope.generation,
      requestId: firstEnvelope.requestId,
      status: 'ok',
      result: { value: 'frame' },
    });
    await expect(first).resolves.toMatchObject({ status: 'ok' });

    supervisor.dispose();
    expect(adapter.workers[0].disposed).toBe(true);
    expect(supervisor.state(key)).toMatchObject({
      generation: 1,
      state: 'idle',
      recentCrashes: 0,
    });

    const afterDispose = supervisor.request(key, identity, { command: 'render' }, 100);
    const secondEnvelope = await waitForSend(adapter, 1, 0);
    expect(secondEnvelope.generation).toBe(1);
    expect(adapter.workers).toHaveLength(2);
    adapter.workers[1].replies[0].resolve({
      sessionId: secondEnvelope.sessionId,
      generation: secondEnvelope.generation,
      requestId: secondEnvelope.requestId,
      status: 'ok',
      result: { value: 'fresh-after-dispose' },
    });
    await expect(afterDispose).resolves.toMatchObject({
      status: 'ok',
      result: { value: 'fresh-after-dispose' },
      requestId: 'session-a:2',
    });
  });
});
