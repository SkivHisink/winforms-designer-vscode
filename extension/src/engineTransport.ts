import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { CancellationTokenSource, MessageConnection } from 'vscode-jsonrpc/node';
import type { EngineHandle, StartOptions } from './engineClient';
import { EngineRecoveryPolicy } from './engineRecovery';
import { currentEngineRequestContext, EngineRequestContext, engineIdentityHash, engineIdentityId, engineRequestGraphProven, engineRequestScopeActive, engineWorkerKey } from './engineRequestContext';
import { EngineAdmissionGate } from './engineAdmission';
import { ENGINE_SOURCE_ARGUMENTS } from './engineMethodSource';
import { WorkerEnvelope, WorkerReply, WorkerSupervisor } from './workerSupervisor';
import { WorkerKey, workerKeyId } from './workerSelection';
import { V2_PROTOCOL_CURRENT_VERSION, V2_PROTOCOL_ID,
  V2_PROTOCOL_SCHEMA_SHA256, V2ProtocolOutcome } from './v2Protocol';

export interface EngineProtocolNegotiation {
  ok: boolean;
  protocolId: string;
  protocolVersion: number;
  schemaSha256: string;
  buildId: string;
  engineVersion: string;
  runtime: string;
  architecture: string;
  capabilities: string[];
  outcome?: V2ProtocolOutcome;
}

interface EngineRpcPayload { method: string; args: unknown[]; }
interface EngineRpcReply {
  sessionId: string; documentId: string; requestId: string; documentRevision: string;
  generation: number; buildId: string; outcome: V2ProtocolOutcome; resultJson?: string;
}

export interface EngineRequestAudit {
  method: string; requestId: string; documentId: string; documentRevision: string;
  generation: number; commandId?: string; outcome: string; pid: number;
}

export interface EngineDelayedRequest {
  readonly method: string; readonly requestId: string; readonly pid: number;
  readonly documentId: string; readonly documentRevision: string; readonly commandId?: string;
}

const completedRequests: EngineRequestAudit[] = [];
export function productRequestOutcomes(): readonly EngineRequestAudit[] { return [...completedRequests]; }

export interface EngineTransportState {
  key: WorkerKey; pid: number; generation: number; state: string; pending: number;
  buildId: string; requests: readonly EngineRequestAudit[];
  delayedReplies: number;
  delayedRequests: readonly EngineDelayedRequest[];
  activeLeases: number;
  graphProven: boolean;
  completedDocumentRender: boolean;
}

/** Workflow leases preserve ownership across host awaits; explicit stop/crash/deadline still closes the owner. */
export function canRecycleEngineForBudget(handle: EngineHandle): boolean {
  const state = handle.workerState?.();
  return (state?.pending ?? 0) === 0 && (state?.activeLeases ?? 0) === 0;
}

/** Transient unverified workers and then verified metadata-only workers yield before document render owners. Every
 * victim is still idle; ordinary bounded recycling of render owners remains available in registry order. */
export function selectEngineForBudgetRecycle<T extends EngineHandle>(handles: Iterable<T>, background = false): T | undefined {
  const idle = [...handles].filter((handle) => canRecycleEngineForBudget(handle)
    && (!background || handle.workerState?.().completedDocumentRender === false));
  return idle.find((handle) => handle.workerState?.().graphProven === false)
    ?? idle.find((handle) => handle.workerState?.().completedDocumentRender === false) ?? idle[0];
}

/** Admission refusal while a build owns the .NET Framework output (see SupervisedEngineOptions.admission). */
export const BUILD_TASK_ACTIVE = 'BUILD_TASK_ACTIVE';

export class EngineTransportError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'EngineTransportError'; }
}

export interface SupervisedEngineOptions extends StartOptions {
  runtime?: 'modern' | 'net48';
  workerKey?: WorkerKey;
  maxPendingRequests?: number;
  memoryBudgetBytes?: number;
  handleGrowthBudget?: number;
  expectedBuildId?: string;
  /** Last-moment admission for a product request: a refusal code refuses it before it reaches the worker. Checked at
   * dispatch (not only in the UI) because a workflow can hold an engine handle across awaits while a build starts. */
  admission?: (method: string) => string | undefined;
}

/** One supervisor is the sole owner of this physical process, its envelope traffic and disposal. */
export async function startSupervisedEngine(
  entry: string,
  options: SupervisedEngineOptions,
  launch: (entry: string, options: StartOptions) => Promise<EngineHandle>,
): Promise<EngineHandle> {
  const runtime = options.runtime ?? (/net48/i.test(entry) ? 'net48' : 'modern');
  const key = options.workerKey ?? engineWorkerKey(runtime);
  const bindingContext = currentEngineRequestContext() ? { ...currentEngineRequestContext()! } : undefined;
  const graphProven = !!bindingContext && engineRequestGraphProven(bindingContext)
    && workerKeyId(engineWorkerKey(runtime, bindingContext)) === workerKeyId(key);
  const expectedBuildId = options.expectedBuildId ?? engineBinaryBuildId(entry, runtime);
  const sessionId = `engine:${randomUUID()}`;
  let physical: EngineHandle | undefined;
  let negotiation: EngineProtocolNegotiation | undefined;
  const attempts = new Map<string, CancellationTokenSource>();
  const executing = new Set<string>();
  const audit: EngineRequestAudit[] = [];
  let replyDelayForTest = 0;
  let delayedReplies = 0;
  const delayedRequests = new Map<string, EngineDelayedRequest>();
  let activeLeases = 0;
  let foregroundLeases = 0;
  const backgroundDispatch = new EngineAdmissionGate();
  let completedDocumentRender = false;
  let intentionalDisposal = false;
  let unexpectedLoss = false;
  const supervisor = new WorkerSupervisor<EngineRpcPayload, unknown>({
    async start() {
      const handle = await launch(entry, options);
      physical = handle;
      try {
        const negotiated = await negotiateEngineProtocol(handle.connection, expectedBuildId);
        const actualRuntime = negotiated.runtime === 'net48' || /^\.NET Framework(?: |$)/i.test(negotiated.runtime)
          ? 'net48' : negotiated.runtime === 'modern' || /^\.NET \d/i.test(negotiated.runtime) ? 'modern' : undefined;
        if (actualRuntime !== runtime || negotiated.architecture !== key.workerArchitecture) {
          throw new EngineTransportError('ENGINE_PROTOCOL_PARTIAL_UPDATE');
        }
        negotiation = negotiated;
        let disposed = false;
        return {
          key,
          buildId: negotiated.buildId,
          async send(envelope: WorkerEnvelope<EngineRpcPayload>): Promise<WorkerReply<unknown>> {
            const token = new CancellationTokenSource();
            attempts.set(envelope.requestId, token);
            executing.add(envelope.requestId);
            try {
              let response: EngineRpcReply;
              try {
                response = await handle.connection.sendRequest<EngineRpcReply>(
                  'ExecuteV2Envelope', JSON.stringify(envelope.protocol), token.token);
              } finally { executing.delete(envelope.requestId); }
              if (!response || typeof response !== 'object') throw new EngineTransportError('MISSING_ENGINE_PAYLOAD');
              const delay = replyDelayForTest;
              replyDelayForTest = 0;
              if (delay > 0) {
                delayedReplies += 1;
                delayedRequests.set(envelope.requestId, { method: envelope.payload.method, requestId: envelope.requestId,
                  pid: handle.process.pid ?? -1, documentId: envelope.identity.documentId,
                  documentRevision: envelope.identity.documentRevision, commandId: envelope.protocol.commandId });
                try { await new Promise<void>((resolve) => setTimeout(resolve, delay)); }
                finally { delayedReplies -= 1; delayedRequests.delete(envelope.requestId); }
              }
              if (response.sessionId !== envelope.sessionId || response.documentId !== envelope.identity.documentId
                || response.requestId !== envelope.requestId || response.documentRevision !== envelope.identity.documentRevision
                || response.generation !== envelope.protocol.renderGeneration || response.buildId !== negotiated.buildId
                || response.outcome?.requestId !== envelope.requestId || response.outcome.traceId !== envelope.protocol.traceId) {
                throw new EngineTransportError('STALE_WORKER_REPLY');
              }
              if (response.outcome.kind !== 'ok') {
                return { sessionId: envelope.sessionId, generation: envelope.generation, requestId: envelope.requestId,
                  status: 'refused', reasonCode: response.outcome.code };
              }
              if (typeof response.resultJson !== 'string') throw new EngineTransportError('MISSING_ENGINE_PAYLOAD');
              let result: unknown;
              try { result = JSON.parse(response.resultJson); }
              catch { throw new EngineTransportError('MISSING_ENGINE_PAYLOAD'); }
              return { sessionId: envelope.sessionId, generation: envelope.generation, requestId: envelope.requestId,
                status: 'ok', result };
            } finally {
              attempts.delete(envelope.requestId);
              executing.delete(envelope.requestId);
              token.dispose();
            }
          },
          cancel(envelope: WorkerEnvelope<EngineRpcPayload>) {
            attempts.get(envelope.requestId)?.cancel();
            void handle.connection.sendRequest('CancelV2Request', envelope.sessionId,
              envelope.protocol.cancellationToken).catch(() => undefined);
            if (executing.has(envelope.requestId)) {
              const grace = setTimeout(() => { if (executing.has(envelope.requestId)) supervisor.recycle(key); }, 2_000);
              grace.unref();
            }
          },
          usage: () => handle.connection.sendRequest<{ memoryBytes: number; handleCount: number }>('GetV2WorkerUsage'),
          dispose() {
            if (disposed) return;
            disposed = true;
            intentionalDisposal = true;
            for (const token of attempts.values()) token.cancel();
            handle.dispose();
          },
        };
      } catch (error) {
        handle.dispose();
        if (physical === handle) physical = undefined; // already released: the startup catch must not release it again
        throw error;
      }
    },
  }, { sessionId, recoveryPolicy: new EngineRecoveryPolicy(), maxPendingRequests: options.maxPendingRequests,
    memoryBudgetBytes: options.memoryBudgetBytes, handleGrowthBudget: options.handleGrowthBudget });
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([supervisor.prepare(key), new Promise<never>((_, reject) => {
      startupTimer = setTimeout(() => reject(new EngineTransportError('ENGINE_START_DEADLINE_EXCEEDED')), 15_000);
    })]);
  } catch (error) { supervisor.dispose(); physical?.dispose(); throw error; }
  finally { if (startupTimer) clearTimeout(startupTimer); }
  const handle = physical!;
  const revisionByDocument = new Map<string, { fingerprint: string; revision: string; generation: number }>();
  const sendRequest = async <T>(method: string, ...args: unknown[]): Promise<T> => {
    if (intentionalDisposal || unexpectedLoss) throw new EngineTransportError('WORKER_SUPERVISOR_DISPOSED');
    const context = currentEngineRequestContext();
    const requestDeadline = Date.now() + (context?.timeoutMs ?? 30_000);
    if (context) validateContextBinding(context, bindingContext, key, runtime);
    if (context?.admissionPriority === 'background') {
      // A foreground workflow owns this physical worker across converter/host-commit awaits too. Optional reflection
      // must not occupy its ordinary dispatch ahead of the live update; already-running work is allowed to finish.
      const admissionDeadline = Math.min(requestDeadline, Date.now() + 8_000);
      do {
        await backgroundDispatch.wait(() => {
          if (intentionalDisposal || unexpectedLoss) throw new EngineTransportError('WORKER_SUPERVISOR_DISPOSED');
          return foregroundLeases === 0;
        }, admissionDeadline, context.cancellation);
        if (!engineRequestScopeActive()) throw new EngineTransportError(
          context.cancellation?.aborted ? 'REQUEST_CANCELLED' : 'WORKER_REQUEST_SCOPE_COMPLETED');
        if (context.cancellation?.aborted) throw new EngineTransportError('REQUEST_CANCELLED');
        if (intentionalDisposal || unexpectedLoss) throw new EngineTransportError('WORKER_SUPERVISOR_DISPOSED');
        validateContextBinding(context, bindingContext, key, runtime);
      } while (foregroundLeases > 0); // foreground may acquire ownership between admission and its continuation
    }
    const designerPath = args.find((arg): arg is string => typeof arg === 'string' && /\.cs$/i.test(arg));
    const sourceIndex = ENGINE_SOURCE_ARGUMENTS[runtime]?.[method];
    let sourceText = sourceIndex !== undefined && typeof args[sourceIndex] === 'string'
      ? args[sourceIndex] as string : context?.sourceText;
    if (sourceText === undefined && designerPath) sourceText = fs.readFileSync(designerPath, 'utf8').replace(/^\uFEFF/, '');
    sourceText ??= '';
    const documentLabel = context?.documentId ?? designerPath ?? 'host-services';
    const documentId = engineIdentityId('document', documentLabel);
    const fingerprint = engineIdentityHash(sourceText);
    const prior = revisionByDocument.get(documentId);
    const revision = `${context?.documentRevision ?? 'source'}:${fingerprint}`;
    const generation = Math.max(context?.renderGeneration ?? 0,
      prior && prior.fingerprint === fingerprint && prior.revision === revision
        ? prior.generation : (prior?.generation ?? 0) + 1);
    revisionByDocument.set(documentId, { fingerprint, revision, generation });
    const payload = { method, args };
    const operationId = context?.operationId
      ? engineIdentityId('operation', `${context.operationId}:${method}:${engineIdentityHash(JSON.stringify(payload))}:${revision}`)
      : undefined;
    const remainingTimeout = requestDeadline - Date.now();
    if (remainingTimeout <= 0) throw new EngineTransportError('REQUEST_DEADLINE_EXCEEDED');
    const refusal = options.admission?.(method);
    if (refusal) throw new EngineTransportError(refusal);
    const result = await supervisor.request(key, {
      sessionId: context?.sessionId ?? sessionId,
      documentId,
      documentRevision: engineIdentityId('revision', revision),
      renderGeneration: Math.max(generation, context?.renderGeneration ?? 0),
      sourceFingerprint: fingerprint,
      sourceByteLength: Buffer.byteLength(sourceText, 'utf8'),
      operationId,
      payloadHash: engineIdentityHash(JSON.stringify(payload)),
    }, payload, remainingTimeout, context?.cancellation);
    // This sticky physical-process role requires a completed ordinary document render carrying a usable frame DTO.
    // It is an eviction priority only; audit trimming and later metadata must not turn a warm render owner into a helper.
    const frame = result.status === 'ok' && result.result && typeof result.result === 'object'
      ? result.result as { png?: unknown; width?: unknown; height?: unknown; error?: unknown; applied?: unknown; isPatch?: unknown; fullFrame?: unknown } : undefined;
    if (result.status === 'ok' && (method === 'RenderWithLayout' || method === 'RenderInterpretedWithLayout'
      || method === 'RenderCompiledWithLayout') && !frame?.error && frame?.applied !== false && frame?.isPatch !== true
      && frame?.fullFrame !== false && typeof frame?.png === 'string' && frame.png.length > 0
      && typeof frame.width === 'number' && frame.width > 0 && typeof frame.height === 'number' && frame.height > 0) completedDocumentRender = true;
    const record: EngineRequestAudit = { method, requestId: result.requestId, documentId,
      documentRevision: engineIdentityId('revision', revision), generation: result.generation * 1_000_000_000 + Math.max(generation, context?.renderGeneration ?? 0),
      outcome: result.status === 'ok' ? 'OK' : result.reasonCode, pid: handle.process.pid ?? -1,
      commandId: operationId ?? result.requestId };
    audit.push(record);
    completedRequests.push(record);
    if (audit.length > 128) audit.shift();
    if (completedRequests.length > 512) completedRequests.shift();
    if (result.status !== 'ok') {
      options.onLog?.(`[engine:v2] ${method}: ${result.reasonCode} (${result.requestId})`);
      if (result.status === 'deadlineExceeded') supervisor.recycle(key);
      throw new EngineTransportError(result.reasonCode);
    }
    return result.result as T;
  };
  const connection = new Proxy(handle.connection, {
    get(target, property) {
      if (property === 'sendRequest') return sendRequest;
      const member = Reflect.get(target, property);
      return typeof member === 'function' ? member.bind(target) : member;
    },
  });
  handle.process.once('exit', () => {
    unexpectedLoss ||= !intentionalDisposal;
    if (unexpectedLoss) supervisor.recordCrash(key);
    supervisor.dispose();
  });
  handle.connection.onClose?.(() => { unexpectedLoss ||= !intentionalDisposal; supervisor.dispose(); });
  return {
    ...handle,
    connection,
    dispose: () => supervisor.dispose(),
    workerState: () => ({ key, pid: handle.process.pid ?? -1, generation: supervisor.state(key).generation,
      state: intentionalDisposal || unexpectedLoss ? 'disposed' : supervisor.state(key).state, pending: supervisor.state(key).pendingRequests,
      buildId: negotiation!.buildId, requests: [...audit], delayedReplies,
      delayedRequests: [...delayedRequests.values()].map((request) => ({ ...request })), activeLeases, graphProven, completedDocumentRender }),
    acquireUsageLease: () => {
      if (intentionalDisposal || unexpectedLoss) throw new EngineTransportError('WORKER_SUPERVISOR_DISPOSED');
      const leaseContext = currentEngineRequestContext();
      if (leaseContext && !engineRequestScopeActive()) throw new EngineTransportError(
        leaseContext.cancellation?.aborted ? 'REQUEST_CANCELLED' : 'WORKER_REQUEST_SCOPE_COMPLETED');
      const foreground = leaseContext?.admissionPriority !== 'background';
      activeLeases += 1;
      if (foreground) foregroundLeases += 1;
      let released = false;
      return () => {
        if (!released) { released = true; activeLeases -= 1; if (foreground) foregroundLeases -= 1; }
      };
    },
    delayNextReplyForTest: (delayMs: number) => { replyDelayForTest = Math.max(0, Math.min(60_000, delayMs)); },
    wasUnexpectedlyLost: () => unexpectedLoss,
  };
}

function validateContextBinding(context: EngineRequestContext, binding: EngineRequestContext | undefined,
  key: WorkerKey, runtime: 'modern' | 'net48'): void {
  const currentKey = engineWorkerKey(runtime, context);
  const provisionalRefinement = binding?.dependencyIdentityMode === 'opaque'
    && !!binding.requestScopeId && binding.requestScopeId === context.requestScopeId;
  const mismatch = context.ownerProject && currentKey.ownerProject !== key.ownerProject
    || context.workspaceTrust && key.trustPolicy && key.trustPolicy.split(':')[0] !== context.workspaceTrust
    || context.designTimeTrust && key.trustPolicy && key.trustPolicy.split(':')[1] !== context.designTimeTrust
    || binding?.configuration && context.configuration && binding.configuration !== context.configuration
    || binding?.targetFramework && context.targetFramework && binding.targetFramework !== context.targetFramework
    || binding?.platform && context.platform && binding.platform !== context.platform
    || engineRequestGraphProven(context) && !!binding && engineRequestGraphProven(binding) && workerKeyId(currentKey) !== workerKeyId(key)
    || context.dependencyIdentityMode === 'content' && binding?.dependencyIdentityMode === 'content'
      && currentKey.dependencyFingerprint !== key.dependencyFingerprint
    || engineRequestGraphProven(context) && !!binding && !engineRequestGraphProven(binding)
      && !provisionalRefinement && workerKeyId(currentKey) !== workerKeyId(key)
    || (binding?.dependencyIdentityMode === 'opaque' || context.dependencyIdentityMode === 'opaque')
      && binding?.requestScopeId && context.requestScopeId !== binding.requestScopeId;
  if (mismatch) throw new EngineTransportError('WORKER_CONTEXT_MISMATCH');
}

/** Negotiation has its own bound inside the overall startup budget: a peer that connects but never answers the
 * handshake is a dead worker, not a slow one, and must not consume the whole startup window. */
export const NEGOTIATION_TIMEOUT_MS = 10_000;

export async function negotiateEngineProtocol(connection: MessageConnection, expectedBuildId?: string,
  timeoutMs = NEGOTIATION_TIMEOUT_MS): Promise<EngineProtocolNegotiation> {
  const requiredCapabilities = ['protocol.rpc-envelope', 'protocol.binary-identity',
    'request.deadline', 'request.cancellation-token'];
  let reply: EngineProtocolNegotiation;
  const cancellation = new CancellationTokenSource();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    reply = await Promise.race([
      connection.sendRequest<EngineProtocolNegotiation>('NegotiateProtocol', JSON.stringify({
        protocolId: V2_PROTOCOL_ID, minimumVersion: V2_PROTOCOL_CURRENT_VERSION, maximumVersion: V2_PROTOCOL_CURRENT_VERSION,
        requiredCapabilities, expectedBuildId,
      }), cancellation.token),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          cancellation.cancel();
          reject(new EngineTransportError('ENGINE_NEGOTIATION_TIMEOUT'));
        }, Math.max(1, timeoutMs));
      }),
    ]);
  } catch (error) {
    if (error instanceof EngineTransportError) throw error;
    throw new EngineTransportError('ENGINE_PROTOCOL_PARTIAL_UPDATE');
  } finally {
    if (timer) clearTimeout(timer);
    cancellation.dispose();
  }
  if (!reply || !reply.ok || reply.protocolId !== V2_PROTOCOL_ID || reply.protocolVersion !== V2_PROTOCOL_CURRENT_VERSION
    || reply.schemaSha256 !== V2_PROTOCOL_SCHEMA_SHA256 || !/^sha256-[a-f0-9]{64}$/.test(reply.buildId)
    || !Array.isArray(reply.capabilities) || requiredCapabilities.some((capability) => !reply.capabilities.includes(capability))
    || expectedBuildId && reply.buildId !== expectedBuildId) {
    throw new EngineTransportError(reply?.outcome?.code ?? 'ENGINE_PROTOCOL_PARTIAL_UPDATE');
  }
  return reply;
}

export function engineBinaryBuildId(entry: string, runtime: 'modern' | 'net48' = /net48/i.test(entry) ? 'net48' : 'modern'): string {
  const sibling = entry.replace(/\.exe$/i, '.dll');
  const managedAssembly = runtime === 'modern' && /\.exe$/i.test(entry) ? sibling : entry;
  try {
    return `sha256-${createHash('sha256').update(fs.readFileSync(path.resolve(managedAssembly))).digest('hex')}`;
  } catch { throw new EngineTransportError('ENGINE_PAYLOAD_UNAVAILABLE'); }
}
