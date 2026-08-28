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
  send(envelope: WorkerEnvelope<TPayload>): Promise<WorkerReply<TResult>>;
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
}

export interface WorkerSlotState {
  key: WorkerKey;
  generation: number;
  state: 'idle' | 'starting' | 'running' | 'quarantined' | 'crashLoop';
  recentCrashes: number;
  quarantineUntil?: number;
}

interface WorkerSlot<TPayload, TResult> {
  key: WorkerKey;
  generation: number;
  state: WorkerSlotState['state'];
  recentCrashes: number;
  worker?: SupervisedWorker<TPayload, TResult>;
  startPromise?: Promise<SupervisedWorker<TPayload, TResult>>;
  quarantineUntil?: number;
}

export class WorkerSupervisor<TPayload, TResult> {
  private readonly clock: WorkerClock;
  private readonly slots = new Map<string, WorkerSlot<TPayload, TResult>>();
  private requestSequence = 0;

  constructor(
    private readonly adapter: WorkerAdapter<TPayload, TResult>,
    private readonly options: WorkerSupervisorOptions,
  ) {
    this.clock = options.clock ?? realClock;
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
      commandId: requestId,
      documentRevision: identity.documentRevision,
      renderGeneration: generation,
      sourceFingerprint: createV2Fingerprint('source', identity.sourceFingerprint, 0),
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
    const worker = await this.ensureWorker(slot).catch(() => undefined);
    if (!worker) {
      return problem('faulted', 'WORKER_START_FAILED', requestId, slot.generation);
    }
    if (generation !== slot.generation) {
      return problem('stale', 'STALE_WORKER_GENERATION', requestId, generation);
    }
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

    const raced = await this.raceWorkerReply(replyPromise, requestId, generation, timeoutMs, cancellation);
    if (raced.status !== 'reply') return raced.result;

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

    return {
      status: 'ok',
      result: reply.result as TResult,
      requestId,
      generation,
    };
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
    };
  }

  dispose(): void {
    for (const slot of this.slots.values()) {
      this.disposeWorker(slot);
      slot.state = 'idle';
      slot.startPromise = undefined;
      slot.quarantineUntil = undefined;
    }
  }

  private async ensureWorker(slot: WorkerSlot<TPayload, TResult>): Promise<SupervisedWorker<TPayload, TResult>> {
    if (slot.worker && slot.state === 'running') return slot.worker;
    if (!slot.startPromise) {
      slot.state = 'starting';
      slot.startPromise = this.adapter.start(slot.key, slot.generation).then((worker) => {
        if (slot.state === 'crashLoop' || workerKeyId(slot.key) !== workerKeyId(worker.key)) {
          try { worker.dispose?.(); } catch { /* already unusable */ }
          throw new Error('stale worker start');
        }
        slot.worker = worker;
        slot.state = 'running';
        return worker;
      });
    }

    try {
      return await slot.startPromise;
    } catch (error) {
      slot.startPromise = undefined;
      slot.worker = undefined;
      if (slot.state !== 'crashLoop') slot.state = 'idle';
      throw error;
    }
  }

  private raceWorkerReply(
    reply: Promise<WorkerReply<TResult>>,
    requestId: string,
    generation: number,
    timeoutMs: number,
    cancellation?: AbortSignal,
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
        () => finish({ status: 'result', result: problem('faulted', 'WORKER_REQUEST_FAULTED', requestId, generation) }),
      );
    });
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
