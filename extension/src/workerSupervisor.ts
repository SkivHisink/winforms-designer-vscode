import { RecoverableEngineKind, RecoveryDecision } from './engineRecovery';
import { WorkerKey, WorkerPayloadIdentity, workerKeyId } from './workerSelection';
import {
  V2_PROTOCOL_CAPABILITIES,
  V2ProtocolEnvelope,
  createV2Fingerprint,
  createV2ProtocolEnvelope,
  validateV2ProtocolEnvelope,
} from './v2Protocol';

export type WorkerRequestStatus =
  | 'ok'
  | 'refused'
  | 'cancelled'
  | 'deadlineExceeded'
  | 'stale'
  | 'faulted'
  | 'crashLoop';

export interface WorkerEnvelope<TPayload> {
  protocol: V2ProtocolEnvelope;
  sessionId: string;
  generation: number;
  requestId: string;
  deadlineAt: number;
  identity: WorkerPayloadIdentity;
  payload: TPayload;
}

export interface WorkerReply<TResult> {
  sessionId: string;
  generation: number;
  requestId: string;
  status: 'ok' | 'refused';
  result?: TResult;
  reasonCode?: string;
}

export type WorkerRequestResult<TResult> =
  | { status: 'ok'; result: TResult; requestId: string; generation: number }
  | { status: 'refused'; reasonCode: string; requestId: string; generation: number }
  | { status: Exclude<WorkerRequestStatus, 'ok' | 'refused'>; reasonCode: string; requestId: string; generation: number };

export interface SupervisedWorker<TPayload, TResult> {
  key: WorkerKey;
  buildId?: string;
  send(envelope: WorkerEnvelope<TPayload>): Promise<WorkerReply<TResult>>;
  cancel?(envelope: WorkerEnvelope<TPayload>): void;
  usage?(): Promise<{ memoryBytes: number; handleCount: number }>;
  dispose?(): void;
}

export interface WorkerAdapter<TPayload, TResult> {
  start(key: WorkerKey, generation: number): Promise<SupervisedWorker<TPayload, TResult>>;
}

export interface WorkerTimer {
  cancel(): void;
}

export interface WorkerClock {
  now(): number;
  setTimer(callback: () => void, delayMs: number): WorkerTimer;
}

export interface WorkerRecoveryPolicy {
  recordCrash(kind: RecoverableEngineKind, now?: number): RecoveryDecision;
}

export interface WorkerSupervisorOptions {
  sessionId: string;
  buildId?: string;
  recoveryPolicy: WorkerRecoveryPolicy;
  clock?: WorkerClock;
  maxPendingRequests?: number;
  memoryBudgetBytes?: number;
  handleGrowthBudget?: number;
  usagePollIntervalMs?: number;
  usagePollTimeoutMs?: number;
}

export interface WorkerSlotState {
  key: WorkerKey;
  generation: number;
  state: 'idle' | 'starting' | 'running' | 'quarantined' | 'crashLoop';
  recentCrashes: number;
  quarantineUntil?: number;
  pendingRequests: number;
}

interface WorkerSlot<TPayload, TResult> {
  key: WorkerKey;
  generation: number;
  state: WorkerSlotState['state'];
  recentCrashes: number;
  worker?: SupervisedWorker<TPayload, TResult>;
  startPromise?: Promise<SupervisedWorker<TPayload, TResult>>;
  quarantineUntil?: number;
  pendingRequests: number;
  initialHandleCount?: number;
}

export class WorkerSupervisor<TPayload, TResult> {
  private readonly clock: WorkerClock;
  private readonly slots = new Map<string, WorkerSlot<TPayload, TResult>>();
  private requestSequence = 0;
  private disposed = false;

  constructor(
    private readonly adapter: WorkerAdapter<TPayload, TResult>,
    private readonly options: WorkerSupervisorOptions,
  ) {
    this.clock = options.clock ?? realClock;
  }

  async prepare(key: WorkerKey): Promise<SupervisedWorker<TPayload, TResult>> {
    if (this.disposed) throw new Error('WORKER_SUPERVISOR_DISPOSED');
    const slot = this.slotFor(key);
    this.releaseQuarantineIfElapsed(slot);
    if (slot.state === 'crashLoop' || slot.state === 'quarantined') throw new Error('WORKER_QUARANTINED');
    return this.ensureWorker(slot);
  }

  async request(
    key: WorkerKey,
    identity: WorkerPayloadIdentity,
    payload: TPayload,
    timeoutMs: number,
    cancellation?: AbortSignal,
  ): Promise<WorkerRequestResult<TResult>> {
    const slot = this.slotFor(key);
    const requestId = this.nextRequestId();
    if (this.disposed) return { status: 'refused', reasonCode: 'WORKER_SUPERVISOR_DISPOSED', requestId, generation: slot.generation };
    if (cancellation?.aborted) return problem('cancelled', 'REQUEST_CANCELLED', requestId, slot.generation);
    if (slot.pendingRequests >= (this.options.maxPendingRequests ?? 32)) {
      return { status: 'refused', reasonCode: 'WORKER_BACKPRESSURE', requestId, generation: slot.generation };
    }
    if (slot.state === 'crashLoop') {
      return problem('crashLoop', 'WORKER_CRASH_LOOP', requestId, slot.generation);
    }
    this.releaseQuarantineIfElapsed(slot);
    if (slot.state === 'quarantined') {
      return {
        status: 'refused',
        reasonCode: 'WORKER_QUARANTINED',
        requestId,
        generation: slot.generation,
      };
    }

    const generation = slot.generation;
    const payloadJson = JSON.stringify(payload);
    if (typeof payloadJson !== 'string') {
      return problem('faulted', 'WORKER_PAYLOAD_NOT_JSON', requestId, generation);
    }
    const deadlineAt = this.clock.now() + Math.max(0, timeoutMs);
    const protocol = createV2ProtocolEnvelope({
      messageKind: 'request',
      buildId: this.options.buildId ?? 'build-2.0.0',
      sessionId: this.options.sessionId,
      documentId: identity.documentId,
      requestId,
      traceId: `${requestId}:trace`,
      commandId: identity.operationId ?? requestId,
      documentRevision: identity.documentRevision,
      renderGeneration: identity.renderGeneration === undefined ? generation : generation * 1_000_000_000 + identity.renderGeneration,
      sourceFingerprint: createV2Fingerprint('source', identity.sourceFingerprint, identity.sourceByteLength ?? 0),
      resourceFingerprints: identity.resourceFingerprint
        ? [createV2Fingerprint('resource', identity.resourceFingerprint, 0)]
        : [],
      deadlineUnixMilliseconds: deadlineAt,
      cancellationToken: `${requestId}:cancel`,
      capabilities: [...V2_PROTOCOL_CAPABILITIES],
      requiredCapabilities: [
        'protocol.envelope-v2',
        'document.source-fingerprint',
        'request.deadline',
        'request.cancellation-token',
      ],
      payloadJson,
    });
    const protocolValidation = validateV2ProtocolEnvelope(protocol);
    if (!protocolValidation.ok) {
      return {
        status: 'refused',
        reasonCode: protocolValidation.outcome.code,
        requestId,
        generation,
      };
    }
    slot.pendingRequests += 1;
    try {
    const startup = this.ensureWorker(slot);
    const started = await this.raceWorkerReply(startup.then((worker) => ({
      sessionId: this.options.sessionId, generation, requestId, status: 'ok' as const, result: worker as unknown as TResult,
    })), requestId, generation, deadlineAt - this.clock.now(), cancellation);
    if (started.status !== 'reply') { this.recycle(key); return started.result; }
    const worker = started.reply.result as unknown as SupervisedWorker<TPayload, TResult>;
    if (!worker) {
      return problem('faulted', 'WORKER_START_FAILED', requestId, slot.generation);
    }
    if (generation !== slot.generation) {
      return problem('stale', 'STALE_WORKER_GENERATION', requestId, generation);
    }
    protocol.buildId = worker.buildId ?? protocol.buildId;
    const envelope: WorkerEnvelope<TPayload> = {
      protocol,
      sessionId: this.options.sessionId,
      generation,
      requestId,
      deadlineAt,
      identity,
      payload,
    };

    let replyPromise: Promise<WorkerReply<TResult>>;
    try {
      replyPromise = worker.send(envelope);
    } catch {
      return problem('faulted', 'WORKER_REQUEST_FAULTED', requestId, generation);
    }

    const usageWatch = this.watchActiveUsage(slot, worker, requestId, generation);
    const raced = await this.raceWorkerReply(replyPromise, requestId, generation, deadlineAt - this.clock.now(), cancellation, usageWatch.result);
    usageWatch.stop();
    if (raced.status !== 'reply') {
      try { worker.cancel?.(envelope); } catch { /* disconnected */ }
      return raced.result;
    }

    const reply = raced.reply;
    if (
      reply.sessionId !== this.options.sessionId
      || reply.generation !== generation
      || reply.requestId !== requestId
      || slot.generation !== generation
    ) {
      return problem('stale', 'STALE_WORKER_REPLY', requestId, generation);
    }

    if (reply.status === 'refused') {
      return {
        status: 'refused',
        reasonCode: reply.reasonCode ?? 'WORKER_REFUSED',
        requestId,
        generation,
      };
    }

    if (worker.usage) {
      // The health query has its own bound (as in active sampling), not whatever is left of the request deadline.
      const remaining = deadlineAt - this.clock.now();
      const usageBound = Math.min(this.options.usagePollTimeoutMs ?? 2_000, remaining);
      const measured = await this.raceWorkerReply(worker.usage().then((value) => ({
        sessionId: this.options.sessionId, generation, requestId, status: 'ok' as const,
        result: value as unknown as TResult,
      })), requestId, generation, usageBound, cancellation);
      if (measured.status !== 'reply') {
        try { worker.cancel?.(envelope); } catch { /* disconnected */ }
        if (measured.result.status === 'deadlineExceeded' && usageBound < remaining) {
          // The worker answered the request but cannot report its own health in time: treat it as wedged.
          this.recycle(key);
          return problem('faulted', 'WORKER_USAGE_DEADLINE_EXCEEDED', requestId, generation);
        }
        return measured.result;
      }
      const usage = measured.reply.result as unknown as { memoryBytes: number; handleCount: number };
      if (usage) {
        slot.initialHandleCount ??= usage.handleCount;
        if (this.exceedsUsageBudget(slot, usage)) {
          this.recycle(key);
          return problem('faulted', 'WORKER_RESOURCE_BUDGET_EXCEEDED', requestId, generation);
        }
      }
    }
    if (slot.generation !== generation) return problem('stale', 'STALE_WORKER_REPLY', requestId, generation);
    if (cancellation?.aborted) return problem('cancelled', 'REQUEST_CANCELLED', requestId, generation);
    if (this.clock.now() > deadlineAt) return problem('deadlineExceeded', 'REQUEST_DEADLINE_EXCEEDED', requestId, generation);

    return {
      status: 'ok',
      result: reply.result as TResult,
      requestId,
      generation,
    };
    } finally {
      slot.pendingRequests -= 1;
    }
  }

  recordCrash(key: WorkerKey): RecoveryDecision {
    const slot = this.slotFor(key);
    const decision = this.options.recoveryPolicy.recordCrash(key.runtime, this.clock.now());
    this.replaceCrashedWorker(slot, decision);
    return decision;
  }

  state(key: WorkerKey): WorkerSlotState {
    const slot = this.slotFor(key);
    this.releaseQuarantineIfElapsed(slot);
    return {
      key: slot.key,
      generation: slot.generation,
      state: slot.state,
      recentCrashes: slot.recentCrashes,
      quarantineUntil: slot.quarantineUntil,
      pendingRequests: slot.pendingRequests,
    };
  }

  recycle(key: WorkerKey): void {
    const slot = this.slotFor(key);
    this.disposeWorker(slot);
    slot.worker = undefined;
    slot.startPromise = undefined;
    slot.generation += 1;
    slot.state = 'idle';
    slot.initialHandleCount = undefined;
    slot.quarantineUntil = undefined;
  }

  states(): WorkerSlotState[] {
    return [...this.slots.values()].map((slot) => this.state(slot.key));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const slot of this.slots.values()) {
      this.disposeWorker(slot);
      slot.worker = undefined;
      slot.state = 'idle';
      slot.startPromise = undefined;
      slot.quarantineUntil = undefined;
      slot.generation += 1;
    }
  }

  private async ensureWorker(slot: WorkerSlot<TPayload, TResult>): Promise<SupervisedWorker<TPayload, TResult>> {
    if (slot.worker && slot.state === 'running') return slot.worker;
    if (!slot.startPromise) {
      const generation = slot.generation;
      slot.state = 'starting';
      slot.startPromise = this.adapter.start(slot.key, slot.generation).then((worker) => {
        if (this.disposed || slot.generation !== generation || slot.state === 'crashLoop' || workerKeyId(slot.key) !== workerKeyId(worker.key)) {
          try { worker.dispose?.(); } catch { /* already unusable */ }
          throw new Error('stale worker start');
        }
        slot.worker = worker;
        slot.state = 'running';
        return worker;
      });
    }

    const starting = slot.startPromise;
    try {
      return await starting;
    } catch (error) {
      if (slot.startPromise === starting) {
        slot.startPromise = undefined;
        slot.worker = undefined;
        if (slot.state !== 'crashLoop') slot.state = 'idle';
      }
      throw error;
    }
  }

  private raceWorkerReply(
    reply: Promise<WorkerReply<TResult>>,
    requestId: string,
    generation: number,
    timeoutMs: number,
    cancellation?: AbortSignal,
    guard?: Promise<WorkerRequestResult<TResult>>,
  ): Promise<
    | { status: 'reply'; reply: WorkerReply<TResult> }
    | { status: 'result'; result: WorkerRequestResult<TResult> }
  > {
    if (cancellation?.aborted) {
      return Promise.resolve({ status: 'result', result: problem('cancelled', 'REQUEST_CANCELLED', requestId, generation) });
    }

    return new Promise((resolve) => {
      let settled = false;
      let cancelTimer: WorkerTimer | undefined;
      const finish = (value:
        | { status: 'reply'; reply: WorkerReply<TResult> }
        | { status: 'result'; result: WorkerRequestResult<TResult> },
      ): void => {
        if (settled) return;
        settled = true;
        cancelTimer?.cancel();
        cancellation?.removeEventListener('abort', onAbort);
        resolve(value);
      };
      const onAbort = (): void =>
        finish({ status: 'result', result: problem('cancelled', 'REQUEST_CANCELLED', requestId, generation) });

      cancellation?.addEventListener('abort', onAbort, { once: true });
      cancelTimer = this.clock.setTimer(
        () => finish({ status: 'result', result: problem('deadlineExceeded', 'REQUEST_DEADLINE_EXCEEDED', requestId, generation) }),
        Math.max(0, timeoutMs),
      );
      reply.then(
        (value) => finish({ status: 'reply', reply: value }),
        (error: unknown) => {
          const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
          const safeCode = typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,127}$/.test(code) ? code : 'WORKER_REQUEST_FAULTED';
          finish({ status: 'result', result: problem(safeCode === 'STALE_WORKER_REPLY' ? 'stale' : 'faulted', safeCode, requestId, generation) });
        },
      );
      guard?.then((result) => finish({ status: 'result', result }));
    });
  }

  private exceedsUsageBudget(slot: WorkerSlot<TPayload, TResult>, usage: { memoryBytes: number; handleCount: number }): boolean {
    slot.initialHandleCount ??= usage.handleCount;
    return !Number.isFinite(usage.memoryBytes) || !Number.isFinite(usage.handleCount)
      || usage.memoryBytes > (this.options.memoryBudgetBytes ?? 1_073_741_824)
      || usage.handleCount > 8_192
      || usage.handleCount - slot.initialHandleCount > (this.options.handleGrowthBudget ?? 2_048);
  }

  /** Poll the physical process while its STA is busy; an unresponsive usage probe also has a bound. */
  private watchActiveUsage(
    slot: WorkerSlot<TPayload, TResult>, worker: SupervisedWorker<TPayload, TResult>, requestId: string, generation: number,
  ): { result?: Promise<WorkerRequestResult<TResult>>; stop(): void } {
    if (!worker.usage) return { stop() {} };
    let stopped = false;
    let pollTimer: WorkerTimer | undefined;
    let probeTimer: WorkerTimer | undefined;
    let finish!: (result: WorkerRequestResult<TResult>) => void;
    const result = new Promise<WorkerRequestResult<TResult>>((resolve) => { finish = resolve; });
    const fail = (code: string): void => {
      if (stopped) return;
      stopped = true;
      pollTimer?.cancel(); probeTimer?.cancel();
      this.recycle(slot.key);
      finish(problem('faulted', code, requestId, generation));
    };
    const poll = (): void => {
      if (stopped || slot.generation !== generation || this.disposed) return;
      probeTimer = this.clock.setTimer(() => fail('WORKER_USAGE_DEADLINE_EXCEEDED'), this.options.usagePollTimeoutMs ?? 2_000);
      void Promise.resolve().then(() => worker.usage!()).then((usage) => {
        probeTimer?.cancel();
        if (stopped || slot.generation !== generation || this.disposed) return;
        if (this.exceedsUsageBudget(slot, usage)) { fail('WORKER_RESOURCE_BUDGET_EXCEEDED'); return; }
        pollTimer = this.clock.setTimer(poll, this.options.usagePollIntervalMs ?? 1_000);
      }, () => fail('WORKER_USAGE_UNAVAILABLE'));
    };
    pollTimer = this.clock.setTimer(poll, this.options.usagePollIntervalMs ?? 1_000);
    return { result, stop() { stopped = true; pollTimer?.cancel(); probeTimer?.cancel(); } };
  }

  private replaceCrashedWorker(slot: WorkerSlot<TPayload, TResult>, decision: RecoveryDecision): void {
    this.disposeWorker(slot);
    slot.recentCrashes = decision.recentCrashes;
    slot.startPromise = undefined;
    slot.worker = undefined;
    slot.generation += 1;
    slot.quarantineUntil = decision.restart
      ? this.clock.now() + Math.max(0, decision.delayMs)
      : undefined;
    slot.state = decision.restart ? 'quarantined' : 'crashLoop';
  }

  private releaseQuarantineIfElapsed(slot: WorkerSlot<TPayload, TResult>): void {
    if (slot.state !== 'quarantined') return;
    if (slot.quarantineUntil === undefined || this.clock.now() < slot.quarantineUntil) return;
    slot.state = 'idle';
    slot.quarantineUntil = undefined;
  }

  private disposeWorker(slot: WorkerSlot<TPayload, TResult>): void {
    try { slot.worker?.dispose?.(); } catch { /* best effort */ }
  }

  private slotFor(key: WorkerKey): WorkerSlot<TPayload, TResult> {
    const id = workerKeyId(key);
    const existing = this.slots.get(id);
    if (existing) return existing;

    const slot: WorkerSlot<TPayload, TResult> = {
      key,
      generation: 1,
      state: 'idle',
      recentCrashes: 0,
      pendingRequests: 0,
    };
    this.slots.set(id, slot);
    return slot;
  }

  private nextRequestId(): string {
    this.requestSequence += 1;
    return `${this.options.sessionId}:${this.requestSequence}`;
  }
}

function problem<TResult>(
  status: Exclude<WorkerRequestStatus, 'ok' | 'refused'>,
  reasonCode: string,
  requestId: string,
  generation: number,
): WorkerRequestResult<TResult> {
  return { status, reasonCode, requestId, generation };
}

const realClock: WorkerClock = {
  now: () => Date.now(),
  setTimer(callback: () => void, delayMs: number): WorkerTimer {
    const timer = setTimeout(callback, delayMs);
    return { cancel: () => clearTimeout(timer) };
  },
};
