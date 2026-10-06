import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { DesignTimeTrust, ProjectArchitecture, WorkspaceTrust, WorkerKey } from './workerSelection';

/** Host-owned identity captured before an ordinary designer request starts. */
export interface EngineRequestContext {
  sessionId: string;
  documentId: string;
  documentRevision: string | number;
  renderGeneration: number;
  sourceText: string;
  operationId?: string;
  cancellation?: AbortSignal;
  ownerProject?: string;
  configuration?: string;
  targetFramework?: string;
  platform?: string;
  dependencyFingerprint?: string;
  dependencyIdentityMode?: 'content' | 'opaque';
  workspaceTrust?: WorkspaceTrust;
  designTimeTrust?: DesignTimeTrust;
  projectArchitecture?: ProjectArchitecture;
  timeoutMs?: number;
  /** Optional metadata must not displace a process that owns an accepted document frame. */
  admissionPriority?: 'background';
  /** A captured request scope permits bounded provisional graph refinement, never later opaque reuse. */
  requestScopeId?: string;
}

const requestContext = new AsyncLocalStorage<EngineRequestContext>();
interface EngineWorkflowLeases { closed: boolean; releases: Map<object, () => void>; }
const workflowLeases = new AsyncLocalStorage<EngineWorkflowLeases>();
interface WorkflowEngine { acquireUsageLease?(): () => void; }

export function engineRequestScopeActive(): boolean { return workflowLeases.getStore()?.closed === false; }
export function engineOwnedByCurrentRequest(handle: WorkflowEngine): boolean { return workflowLeases.getStore()?.releases.has(handle) === true; }
export function engineRequestGraphProven(value = currentEngineRequestContext()): boolean {
  return !!value && value.dependencyIdentityMode === 'content' && !!value.ownerProject && !!value.configuration
    && !!value.targetFramework && !!value.platform && !!value.dependencyFingerprint;
}

/** Register before returning a handle; one workflow may retain converters and authorities across separate awaits. */
export function retainEngineForCurrentRequest<T extends WorkflowEngine>(handle: T): T {
  const scope = workflowLeases.getStore();
  if (!scope) return handle;
  if (scope.closed) {
    const code = currentEngineRequestContext()?.cancellation?.aborted ? 'REQUEST_CANCELLED' : 'WORKER_REQUEST_SCOPE_COMPLETED';
    throw Object.assign(new Error(code), { code });
  }
  if (!scope.releases.has(handle)) scope.releases.set(handle, handle.acquireUsageLease?.() ?? (() => undefined));
  return handle;
}

/** Temporary owner/assembly resolvers have no later use in the workflow and can release their own lease early. */
export function releaseEngineForCurrentRequest(handle: WorkflowEngine): void {
  const scope = workflowLeases.getStore();
  const release = scope?.releases.get(handle);
  if (!release) return;
  scope!.releases.delete(handle); release();
}

export function withEngineRequestContext<T>(context: EngineRequestContext, action: () => T): T {
  const scope: EngineWorkflowLeases = { closed: false, releases: new Map() };
  const close = (): void => {
    if (scope.closed) return;
    scope.closed = true;
    context.cancellation?.removeEventListener('abort', close);
    for (const release of scope.releases.values()) { try { release(); } catch { /* disposed owner */ } }
    scope.releases.clear();
  };
  context.cancellation?.addEventListener('abort', close, { once: true });
  if (context.cancellation?.aborted) {
    close(); throw Object.assign(new Error('REQUEST_CANCELLED'), { code: 'REQUEST_CANCELLED' });
  }
  return requestContext.run({ ...context, requestScopeId: context.requestScopeId ?? randomUUID() },
    () => workflowLeases.run(scope, () => {
      let result: T;
      try { result = action(); } catch (error) { close(); throw error; }
      if (result && typeof (result as { then?: unknown }).then === 'function') return Promise.resolve(result).finally(close) as T;
      close(); return result;
    }));
}

export function currentEngineRequestContext(): EngineRequestContext | undefined {
  return requestContext.getStore();
}

export function engineIdentityHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function engineIdentityId(prefix: string, value: string): string {
  return `${prefix}:${engineIdentityHash(value).slice(0, 32)}`;
}

/** Configuration and trust are part of identity even when the dependency graph is unchanged. */
export function engineWorkerKey(runtime: 'modern' | 'net48', context = currentEngineRequestContext()): WorkerKey {
  const workerArchitecture = runtime === 'net48' || process.arch !== 'arm64' ? 'x64' : 'arm64';
  const ownerProject = context?.ownerProject
    ? path.resolve(context.ownerProject).toLocaleLowerCase('en-US')
    : context?.documentId ? path.resolve(context.documentId).toLocaleLowerCase('en-US') : 'host-services';
  return {
    runtime,
    workerArchitecture,
    compatibility: runtime === 'net48' && process.arch === 'arm64' ? 'x64-compat' : 'native',
    ownerProject,
    configuration: context?.configuration ?? 'default',
    targetFramework: context?.targetFramework ?? 'default',
    platform: context?.platform ?? context?.projectArchitecture ?? 'default',
    dependencyFingerprint: context?.dependencyFingerprint ?? engineIdentityHash(ownerProject),
    trustPolicy: `${context?.workspaceTrust ?? 'trusted'}:${context?.designTimeTrust ?? 'sourceFirst'}`,
  };
}
