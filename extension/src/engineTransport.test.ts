import { EventEmitter } from 'node:events';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import type { EngineHandle } from './engineClient';
import { currentEngineRequestContext, engineRequestGraphProven, engineRequestScopeActive, releaseEngineForCurrentRequest, retainEngineForCurrentRequest, withEngineRequestContext } from './engineRequestContext';
import { ENGINE_SOURCE_ARGUMENTS } from './engineMethodSource';
import { BUILD_TASK_ACTIVE, canRecycleEngineForBudget, selectEngineForBudgetRecycle, startSupervisedEngine } from './engineTransport';
import { EngineRegistry } from './engineRegistry';
import { EngineAdmissionGate } from './engineAdmission';
import { compatibilityForRender, type ProjectCompatibilityResult } from './projectCompatibility';
import { V2_PROTOCOL_SCHEMA_SHA256 } from './v2Protocol';

const buildId = `sha256-${'a'.repeat(64)}`;
const context = { sessionId: 'session-a', documentId: 'Form1.Designer.cs', documentRevision: 1,
  renderGeneration: 1, sourceText: 'class Form1 {}', operationId: 'operation-a' };

function fakeEngine(options: { negotiation?: object; reply?: (envelope: any) => any; usage?: () => Promise<unknown> } = {}) {
  const process = Object.assign(new EventEmitter(), { pid: 100, exitCode: null, signalCode: null });
  const dispose = vi.fn();
  const sendRequest = vi.fn(async (method: string, ...args: unknown[]) => {
    if (method === 'NegotiateProtocol') return { ok: true, protocolId: 'designer-protocol-v2', protocolVersion: 2,
      schemaSha256: V2_PROTOCOL_SCHEMA_SHA256, buildId, runtime: 'modern', architecture: 'x64', capabilities: ['protocol.rpc-envelope',
        'protocol.binary-identity', 'request.deadline', 'request.cancellation-token'], ...options.negotiation };
    if (method === 'GetV2WorkerUsage') return options.usage ? options.usage() : { memoryBytes: 100, handleCount: 10 };
    if (method === 'CancelV2Request') return true;
    if (method !== 'ExecuteV2Envelope') throw new Error(`direct ordinary RPC: ${method}`);
    const envelope = JSON.parse(args[0] as string);
    return options.reply ? options.reply(envelope) : { sessionId: envelope.sessionId, documentId: envelope.documentId,
      requestId: envelope.requestId, documentRevision: envelope.documentRevision, generation: envelope.renderGeneration,
      buildId, outcome: { kind: 'ok', code: 'OK', requestId: envelope.requestId, traceId: envelope.traceId },
      resultJson: JSON.stringify(/^Render(?:Interpreted|Compiled)?WithLayout$/.test(JSON.parse(envelope.payloadJson).method)
        ? { designerText: 'result', png: 'iVBORw0KGgo=', width: 10, height: 10 } : { designerText: 'result' }) };
  });
  const physical = { connection: { sendRequest }, process, pipeName: 'fake', dispose } as unknown as EngineHandle;
  return { physical, sendRequest, dispose };
}

describe('ordinary supervised engine transport', () => {
  it('holds the live authority through an asynchronous converter gap and dispatches foreground reconciliation before optional metadata', async () => {
    const primaryWire = fakeEngine({ negotiation: { runtime: 'net48' } });
    let finishPlanner!: (value: unknown) => void;
    let plannerEnvelope: any;
    const converterWire = fakeEngine({ reply: (envelope) => {
      plannerEnvelope = envelope;
      return new Promise((resolve) => { finishPlanner = resolve; });
    } });
    const primaryLaunch = vi.fn(async () => primaryWire.physical);
    const primary = await startSupervisedEngine('fake-net48.exe', { expectedBuildId: buildId, runtime: 'net48' }, primaryLaunch);
    const converter = await startSupervisedEngine('fake.dll', { expectedBuildId: buildId }, async () => converterWire.physical);
    await withEngineRequestContext(context, () => primary.connection.sendRequest('RenderInterpretedWithLayout'));
    vi.useFakeTimers();
    try {
      const foreground = withEngineRequestContext(context, async () => {
        retainEngineForCurrentRequest(primary); // actual authority is owned before the modern source planner awaits
        retainEngineForCurrentRequest(converter);
        await converter.connection.sendRequest('SetProperty', context.documentId, 'button1', 'Text', '"edited"', context.sourceText);
        await primary.connection.sendRequest('ApplyInterpretedEditsLive');
      });
      await vi.advanceTimersByTimeAsync(0);
      const background = withEngineRequestContext({ ...context, admissionPriority: 'background' }, async () => {
        retainEngineForCurrentRequest(primary);
        await primary.connection.sendRequest('ScanToolboxAssembly', 'Fixture.dll');
      });
      await vi.advanceTimersByTimeAsync(200);
      expect(primary.workerState!()).toMatchObject({ activeLeases: 2, pending: 0, completedDocumentRender: true });
      expect(converter.workerState!()).toMatchObject({ activeLeases: 1, pending: 1 });
      expect(primaryWire.sendRequest.mock.calls.filter(([method]) => method === 'ExecuteV2Envelope')).toHaveLength(1);
      expect(canRecycleEngineForBudget(primary)).toBe(false);
      finishPlanner({ sessionId: plannerEnvelope.sessionId, documentId: plannerEnvelope.documentId,
        requestId: plannerEnvelope.requestId, documentRevision: plannerEnvelope.documentRevision,
        generation: plannerEnvelope.renderGeneration, buildId, outcome: { kind: 'ok', code: 'OK',
          requestId: plannerEnvelope.requestId, traceId: plannerEnvelope.traceId }, resultJson: '{}' });
      await foreground;
      expect(primary.workerState!().activeLeases).toBe(1); // only its background scope remains
      expect(converter.workerState!().activeLeases).toBe(0);
      await vi.advanceTimersByTimeAsync(50);
      await background;
      expect(primaryWire.sendRequest.mock.calls.filter(([method]) => method === 'ExecuteV2Envelope')
        .map(([, json]) => JSON.parse(JSON.parse(json as string).payloadJson).method))
        .toEqual(['RenderInterpretedWithLayout', 'ApplyInterpretedEditsLive', 'ScanToolboxAssembly']);
      expect(primaryLaunch).toHaveBeenCalledOnce();
      expect(primary.workerState!()).toMatchObject({ activeLeases: 0, pending: 0, completedDocumentRender: true });
      expect(primaryWire.dispose).not.toHaveBeenCalled();
    } finally { primary.dispose(); converter.dispose(); vi.useRealTimers(); }
  });

  it('refuses product requests at dispatch while a build owns the output, but still lets the release through', async () => {
    const fake = fakeEngine({ negotiation: { runtime: 'net48' } });
    let building = false;
    const handle = await startSupervisedEngine('fake-net48.exe', {
      expectedBuildId: buildId, runtime: 'net48',
      admission: (method) => building && method !== 'ReleaseAllCompiledAssemblies' ? BUILD_TASK_ACTIVE : undefined,
    }, async () => fake.physical);
    const dispatched = () => fake.sendRequest.mock.calls.filter(([method]) => method === 'ExecuteV2Envelope')
      .map(([, json]) => JSON.parse(JSON.parse(json as string).payloadJson).method);
    const releaseForeground = handle.acquireUsageLease!();
    vi.useFakeTimers();
    try {
      // A background request already waiting for the foreground when the build starts is refused, not dispatched:
      // the check is at dispatch, after every await, not only where the workflow began.
      const waiting = expect(withEngineRequestContext({ ...context, admissionPriority: 'background' }, async () => {
        retainEngineForCurrentRequest(handle);
        await handle.connection.sendRequest('ScanToolboxAssembly', 'Fixture.dll');
      })).rejects.toMatchObject({ code: BUILD_TASK_ACTIVE });
      await vi.advanceTimersByTimeAsync(10);
      building = true;
      releaseForeground();
      await vi.advanceTimersByTimeAsync(50);
      await waiting;

      await expect(withEngineRequestContext(context, () => handle.connection.sendRequest('RenderInterpretedWithLayout')))
        .rejects.toMatchObject({ code: BUILD_TASK_ACTIVE });
      await withEngineRequestContext(context, () => handle.connection.sendRequest('ReleaseAllCompiledAssemblies'));
      expect(dispatched()).toEqual(['ReleaseAllCompiledAssemblies']);

      building = false;
      await withEngineRequestContext(context, () => handle.connection.sendRequest('RenderInterpretedWithLayout'));
      expect(dispatched()).toEqual(['ReleaseAllCompiledAssemblies', 'RenderInterpretedWithLayout']);
      expect(fake.dispose).not.toHaveBeenCalled();
    } finally { releaseForeground(); handle.dispose(); vi.useRealTimers(); }
  });

  it('bounds same-worker metadata waiters, cancellation and their own leases without sending or replaying an RPC', async () => {
    const fake = fakeEngine();
    const handle = await startSupervisedEngine('fake.dll', { expectedBuildId: buildId }, async () => fake.physical);
    const releaseForeground = handle.acquireUsageLease!();
    vi.useFakeTimers();
    try {
      const cancellations = Array.from({ length: 32 }, () => new AbortController());
      const pending = cancellations.map((cancellation) => withEngineRequestContext({ ...context,
        admissionPriority: 'background', cancellation: cancellation.signal }, async () => {
        retainEngineForCurrentRequest(handle);
        await handle.connection.sendRequest('ScanToolboxAssembly', 'Fixture.dll');
      }));
      const outcomes = Promise.all(pending.map((item) => expect(item).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' })));
      await expect(withEngineRequestContext({ ...context, admissionPriority: 'background' }, async () => {
        retainEngineForCurrentRequest(handle);
        await handle.connection.sendRequest('ScanToolboxAssembly', 'Fixture.dll');
      })).rejects.toMatchObject({ code: 'WORKER_BACKPRESSURE' });
      expect(handle.workerState!().activeLeases).toBe(33);
      for (const cancellation of cancellations) cancellation.abort();
      await outcomes;
      expect(handle.workerState!()).toMatchObject({ activeLeases: 1, pending: 0 });
      const short = expect(withEngineRequestContext({ ...context, admissionPriority: 'background', timeoutMs: 100 },
        () => handle.connection.sendRequest('ScanToolboxAssembly', 'Fixture.dll')))
        .rejects.toMatchObject({ code: 'REQUEST_DEADLINE_EXCEEDED' });
      await vi.advanceTimersByTimeAsync(101); await short;
      const admission = expect(withEngineRequestContext({ ...context, admissionPriority: 'background' },
        () => handle.connection.sendRequest('ScanToolboxAssembly', 'Fixture.dll')))
        .rejects.toMatchObject({ code: 'REQUEST_DEADLINE_EXCEEDED' });
      await vi.advanceTimersByTimeAsync(8_001); await admission;
      expect(fake.sendRequest.mock.calls.some(([method]) => method === 'ExecuteV2Envelope')).toBe(false);
      expect(fake.dispose).not.toHaveBeenCalled();
      releaseForeground(); releaseForeground();
      await withEngineRequestContext({ ...context, admissionPriority: 'background' }, async () => {
        retainEngineForCurrentRequest(handle); // a background lease never waits for itself
        await handle.connection.sendRequest('ScanToolboxAssembly', 'Fixture.dll');
      });
      expect(handle.workerState!()).toMatchObject({ activeLeases: 0, pending: 0 });
      expect(fake.sendRequest.mock.calls.filter(([method]) => method === 'ExecuteV2Envelope')).toHaveLength(1);
    } finally { releaseForeground(); handle.dispose(); vi.useRealTimers(); }
  });

  it('keeps the original request deadline after metadata waits without restarting a timed out worker', async () => {
    vi.useFakeTimers();
    let envelope: any;
    const fake = fakeEngine({ reply: (value) => { envelope = value; return new Promise(() => undefined); } });
    const handle = await startSupervisedEngine('fake.dll', { expectedBuildId: buildId }, async () => fake.physical);
    const releaseForeground = handle.acquireUsageLease!();
    try {
      const startedAt = Date.now();
      const deadline = expect(withEngineRequestContext({ ...context, admissionPriority: 'background', timeoutMs: 1_000 },
        () => handle.connection.sendRequest('ScanToolboxAssembly', 'Fixture.dll')))
        .rejects.toMatchObject({ code: 'REQUEST_DEADLINE_EXCEEDED' });
      await vi.advanceTimersByTimeAsync(600);
      releaseForeground();
      await vi.advanceTimersByTimeAsync(50);
      expect(envelope.deadlineUnixMilliseconds).toBe(startedAt + 1_000);
      await vi.advanceTimersByTimeAsync(351); await deadline;
      expect(fake.sendRequest.mock.calls.filter(([method]) => method === 'ExecuteV2Envelope')).toHaveLength(1);
      expect(fake.dispose).toHaveBeenCalledOnce();
    } finally { releaseForeground(); handle.dispose(); vi.useRealTimers(); }
  });

  it('refuses queued metadata from closed scopes or stopped owners before dispatch', async () => {
    const fake = fakeEngine();
    const handle = await startSupervisedEngine('fake.dll', { expectedBuildId: buildId }, async () => fake.physical);
    let releaseForeground = handle.acquireUsageLease!();
    vi.useFakeTimers();
    try {
      let detached!: Promise<unknown>;
      withEngineRequestContext({ ...context, admissionPriority: 'background' }, () => {
        detached = handle.connection.sendRequest('ScanToolboxAssembly', 'Fixture.dll');
      });
      const closed = expect(detached).rejects.toMatchObject({ code: 'WORKER_REQUEST_SCOPE_COMPLETED' });
      releaseForeground();
      await vi.advanceTimersByTimeAsync(50); await closed;
      releaseForeground = handle.acquireUsageLease!();
      const stopped = expect(withEngineRequestContext({ ...context, admissionPriority: 'background' },
        () => handle.connection.sendRequest('ScanToolboxAssembly', 'Fixture.dll')))
        .rejects.toMatchObject({ code: 'WORKER_SUPERVISOR_DISPOSED' });
      handle.dispose();
      await vi.advanceTimersByTimeAsync(50); await stopped;
      releaseForeground(); releaseForeground();
      expect(handle.workerState!().activeLeases).toBe(0);
      expect(fake.sendRequest.mock.calls.filter(([method]) => method === 'ExecuteV2Envelope')).toHaveLength(0);
      expect(fake.dispose).toHaveBeenCalledOnce();
    } finally { releaseForeground(); handle.dispose(); vi.useRealTimers(); }
  });

  it('waits for a busy helper without displacing a completed frame for optional metadata', async () => {
    const ownerWire = fakeEngine(); const helperWire = fakeEngine();
    const owner = await startSupervisedEngine('fake.dll', { expectedBuildId: buildId }, async () => ownerWire.physical);
    const helper = await startSupervisedEngine('fake.dll', { expectedBuildId: buildId }, async () => helperWire.physical);
    await withEngineRequestContext(context, () => owner.connection.sendRequest('RenderWithLayout', context.documentId, null, context.sourceText));
    const release = helper.acquireUsageLease!();
    vi.useFakeTimers();
    try {
      const gate = new EngineAdmissionGate(); const residents = [owner, helper]; let admitted = false;
      expect(selectEngineForBudgetRecycle(residents, true)).toBeUndefined();
      expect(selectEngineForBudgetRecycle(residents)).toBe(owner); // foreground still has a bounded Render fallback
      const waiting = gate.wait(() => !!selectEngineForBudgetRecycle(residents, true), Date.now() + 1_000)
        .then(() => { admitted = true; });
      await vi.advanceTimersByTimeAsync(200); expect(admitted).toBe(false);
      expect(ownerWire.dispose).not.toHaveBeenCalled();
      release(); await vi.advanceTimersByTimeAsync(50); await waiting;
      expect(selectEngineForBudgetRecycle(residents, true)).toBe(helper);
      helper.dispose(); expect(helperWire.dispose).toHaveBeenCalledOnce();
      expect(ownerWire.dispose).not.toHaveBeenCalled();
      const abort = new AbortController();
      const cancelled = expect(gate.wait(() => !!selectEngineForBudgetRecycle([owner], true), Date.now() + 1_000, abort.signal))
        .rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
      abort.abort(); await cancelled;
      const timedOut = expect(gate.wait(() => !!selectEngineForBudgetRecycle([owner], true), Date.now() + 100))
        .rejects.toMatchObject({ code: 'REQUEST_DEADLINE_EXCEEDED' });
      await vi.advanceTimersByTimeAsync(101); await timedOut;
      expect(ownerWire.dispose).not.toHaveBeenCalled();
    } finally { release(); helper.dispose(); owner.dispose(); vi.useRealTimers(); }
  });

  it('does not prioritize a failed or empty render DTO as a completed document frame', async () => {
    for (const frame of [{ error: 'render failed', png: 'iVBORw0KGgo=', width: 10, height: 10 },
      { png: '', width: 0, height: 0 }, { applied: false, png: 'iVBORw0KGgo=', width: 10, height: 10 },
      { isPatch: true, png: 'iVBORw0KGgo=', width: 10, height: 10 }]) {
      const fake = fakeEngine({ reply: (envelope) => ({ sessionId: envelope.sessionId, documentId: envelope.documentId,
        requestId: envelope.requestId, documentRevision: envelope.documentRevision, generation: envelope.renderGeneration,
        buildId, outcome: { kind: 'ok', code: 'OK', requestId: envelope.requestId, traceId: envelope.traceId }, resultJson: JSON.stringify(frame) }) });
      const handle = await startSupervisedEngine('fake.dll', { expectedBuildId: buildId }, async () => fake.physical);
      try {
        await withEngineRequestContext(context, () => handle.connection.sendRequest('RenderCompiledWithLayout', 'Form1.Designer.cs'));
        expect(handle.workerState!().completedDocumentRender).toBe(false);
      } finally { handle.dispose(); }
    }
  });

  it('retires idle explicitly unproven helpers before warm proven owners without exempting leases or pending RPCs', async () => {
    const proven = { ...context, ownerProject: path.resolve('Form.csproj'), configuration: 'Release', platform: 'AnyCPU',
      targetFramework: 'net10.0-windows', dependencyFingerprint: 'content-a', dependencyIdentityMode: 'content' as const };
    const first = fakeEngine(); const second = fakeEngine();
    let releaseReply!: (value: any) => void;
    const helperWire = fakeEngine({ reply: () => new Promise((resolve) => { releaseReply = resolve; }) });
    const owner = await withEngineRequestContext(proven,
      () => startSupervisedEngine('fake.dll', { expectedBuildId: buildId }, async () => first.physical));
    const other = await withEngineRequestContext({ ...proven, ownerProject: path.resolve('Other.csproj') },
      () => startSupervisedEngine('fake.dll', { expectedBuildId: buildId }, async () => second.physical));
    await withEngineRequestContext(proven, () => owner.connection.sendRequest('RenderWithLayout', context.documentId, null, context.sourceText));
    let helper!: EngineHandle;
    try {
      await withEngineRequestContext({ ...context, ownerProject: path.resolve('Helper.csproj'), dependencyIdentityMode: 'opaque' }, async () => {
        helper = await startSupervisedEngine('fake.dll', { expectedBuildId: buildId }, async () => helperWire.physical);
        expect(owner.workerState!().graphProven).toBe(true);
        expect(owner.workerState!().completedDocumentRender).toBe(true);
        expect(other.workerState!().completedDocumentRender).toBe(false);
        expect(helper.workerState!().graphProven).toBe(false);
        expect(selectEngineForBudgetRecycle([owner, other, helper])).toBe(helper);
        const release = helper.acquireUsageLease!();
        expect(selectEngineForBudgetRecycle([owner, other, helper])).toBe(other); // completed metadata yields before Render
        await withEngineRequestContext({ ...proven, ownerProject: path.resolve('Other.csproj') },
          () => other.connection.sendRequest('RenderWithLayout', context.documentId, null, context.sourceText));
        expect(selectEngineForBudgetRecycle([owner, other, helper])).toBe(owner); // all eligible owners completed Render
        release();
        const pending = helper.connection.sendRequest('ResolveDesignerDocumentOwner', context.documentId, null, context.sourceText);
        for (let i = 0; !releaseReply && i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
        expect(helper.workerState!().pending).toBe(1);
        expect(selectEngineForBudgetRecycle([owner, other, helper])).toBe(owner);
        const envelope = JSON.parse(helperWire.sendRequest.mock.calls.find(([method]) => method === 'ExecuteV2Envelope')![1] as string);
        releaseReply({ sessionId: envelope.sessionId, documentId: envelope.documentId, requestId: envelope.requestId,
          documentRevision: envelope.documentRevision, generation: envelope.renderGeneration, buildId,
          outcome: { kind: 'ok', code: 'OK', requestId: envelope.requestId, traceId: envelope.traceId }, resultJson: '{}' });
        await pending;
        selectEngineForBudgetRecycle([owner, other, helper])!.dispose();
        expect(helperWire.dispose).toHaveBeenCalledOnce();
        await withEngineRequestContext(proven, async () => {
          for (let i = 0; i < 129; i++) await owner.connection.sendRequest('DescribeComponent', context.documentId, 'button1', null, context.sourceText);
        });
        expect(owner.workerState!().requests.some((request) => request.method === 'RenderWithLayout')).toBe(false);
        expect(owner.workerState!().completedDocumentRender).toBe(true); // bounded audit trimming cannot forget the role
        expect(first.dispose).not.toHaveBeenCalled();
        const ownerLease = owner.acquireUsageLease!(); const otherLease = other.acquireUsageLease!();
        expect(selectEngineForBudgetRecycle([owner, other])).toBeUndefined();
        ownerLease(); otherLease();
      });
    } finally { helper?.dispose(); owner.dispose(); other.dispose(); }
  });

  it('reuses a converter prewarmed in an independent proven scope for the next scalar planner', async () => {
    const proven = { ...context, ownerProject: path.resolve('Framework.csproj'), configuration: 'Release', platform: 'AnyCPU',
      targetFramework: 'net48', dependencyFingerprint: 'framework-content', dependencyIdentityMode: 'content' as const };
    const registry = new EngineRegistry<EngineHandle>(); const fake = fakeEngine();
    const launch = vi.fn(async () => fake.physical);
    const warm = await withEngineRequestContext({ ...proven, admissionPriority: 'background' }, async () => {
      expect(engineRequestGraphProven()).toBe(true);
      const handle = await startSupervisedEngine('fake.dll', { runtime: 'modern', expectedBuildId: buildId }, launch);
      registry.set('modern', handle); return handle;
    });
    try {
      expect(fake.sendRequest.mock.calls.map(([method]) => method)).toEqual(['NegotiateProtocol']);
      await withEngineRequestContext({ ...proven, operationId: 'next-property' }, async () => {
        const converter = retainEngineForCurrentRequest(registry.get('modern')!);
        expect(converter).toBe(warm);
        await converter.connection.sendRequest('SetProperty', context.documentId, 'button1', 'Text', '"after"', context.sourceText);
      });
      expect(launch).toHaveBeenCalledOnce();
      expect(warm.workerState!()).toMatchObject({ graphProven: true, pending: 0, activeLeases: 0 });
      expect(warm.workerState!().requests.map((request) => request.method)).toEqual(['SetProperty']);
      expect(engineRequestGraphProven({ ...proven, dependencyIdentityMode: 'opaque' })).toBe(false);
    } finally { warm.dispose(); }
  });

  it('allows optional metadata to reuse the exact matched rendered worker without changing graph identity', async () => {
    const proven = { ...context, ownerProject: path.resolve('Form.csproj'), configuration: 'Release', platform: 'AnyCPU',
      targetFramework: 'net10.0-windows', dependencyFingerprint: 'content-a', dependencyIdentityMode: 'content' as const };
    const registry = new EngineRegistry<EngineHandle>(); const fake = fakeEngine(); const launch = vi.fn(async () => fake.physical);
    const owner = await withEngineRequestContext(proven, async () => {
      const handle = await startSupervisedEngine('fake.dll', { expectedBuildId: buildId }, launch);
      registry.set('modern', handle);
      await handle.connection.sendRequest('RenderWithLayout', context.documentId, null, context.sourceText);
      return handle;
    });
    try {
      await withEngineRequestContext({ ...proven, admissionPriority: 'background' }, async () => {
        const borrowed = retainEngineForCurrentRequest(registry.get('modern')!);
        expect(borrowed).toBe(owner); expect(borrowed.workerState!().activeLeases).toBe(1);
        await borrowed.connection.sendRequest('DescribeComponent', context.documentId, 'button1', null, context.sourceText);
      });
      expect(owner.workerState!()).toMatchObject({ activeLeases: 0, pending: 0, completedDocumentRender: true });
      expect(launch).toHaveBeenCalledOnce(); expect(fake.dispose).not.toHaveBeenCalled();
    } finally { owner.dispose(); }
  });

  it('releases a short opaque enumeration lease while preserving its captured scope for palette reuse', async () => {
    const opaque = { ...context, ownerProject: path.resolve('Form.csproj'), dependencyFingerprint: 'opaque-capture',
      dependencyIdentityMode: 'opaque' as const, admissionPriority: 'background' as const };
    const registry = new EngineRegistry<EngineHandle>(); const fake = fakeEngine(); const launch = vi.fn(async () => fake.physical);
    let handle!: EngineHandle;
    try {
      await withEngineRequestContext(opaque, async () => {
        await withEngineRequestContext(currentEngineRequestContext()!, async () => {
          handle = retainEngineForCurrentRequest(await startSupervisedEngine('fake.dll', { expectedBuildId: buildId }, launch));
          registry.set('modern', handle);
          await handle.connection.sendRequest('ListToolboxItems', context.documentId);
          expect(handle.workerState!().activeLeases).toBe(1);
        });
        expect(handle.workerState!().activeLeases).toBe(0);
        const palette = retainEngineForCurrentRequest(registry.get('modern')!);
        expect(palette).toBe(handle);
        await palette.connection.sendRequest('GetDesignerPalette');
        expect(handle.workerState!().activeLeases).toBe(1);
      });
      expect(handle.workerState!().activeLeases).toBe(0); expect(launch).toHaveBeenCalledOnce();
      expect(handle.workerState!().requests.map((request) => request.method)).toEqual(['ListToolboxItems', 'GetDesignerPalette']);
      await expect(withEngineRequestContext(opaque, () => handle.connection.sendRequest('GetDesignerPalette')))
        .rejects.toMatchObject({ code: 'WORKER_CONTEXT_MISMATCH' });
    } finally { handle?.dispose(); }
  });

  it('binds delayed effective evaluation, render, planner and retained edit to one content worker', async () => {
    vi.useFakeTimers();
    const fake = fakeEngine();
    const launch = vi.fn(async () => fake.physical);
    const effective: ProjectCompatibilityResult = { status: 'compatible', code: 'ARCHITECTURE_COMPATIBLE', message: '',
      workerArchitecture: 'x64', effectiveOutputMatched: true, nativeDependencies: [], limitations: [], observedPaths: [],
      evaluated: { configuration: 'Release', platform: 'AnyCPU', targetFramework: 'net10.0-windows', platformTarget: 'AnyCPU',
        prefer32Bit: false, targetPath: 'Form.dll', knownDependencyPaths: [], importPaths: [] } };
    let handle: EngineHandle | undefined;
    try {
      const inspection = new Promise<ProjectCompatibilityResult>((resolve) => setTimeout(() => resolve(effective), 900));
      const preparing = (async () => {
        const selected = await compatibilityForRender(inspection, async () => { throw new Error('image-only graph published'); });
        const bound = { ...context, ownerProject: path.resolve('Form.csproj'), ...selected.evaluated,
          dependencyFingerprint: 'actual-content-a', dependencyIdentityMode: 'content' as const };
        handle = await withEngineRequestContext(bound,
          () => startSupervisedEngine('fake.dll', { expectedBuildId: buildId }, launch));
        await withEngineRequestContext(bound, () => handle!.connection.sendRequest('RenderWithLayout', context.documentId, null, context.sourceText));
        await withEngineRequestContext({ ...bound, operationId: 'edit-a' }, async () => {
          await handle!.connection.sendRequest('PreviewOwnedRegionPropertySet', context.documentId, 'before-hash', 'button1', 'Text', '"after"', context.sourceText, true, 'graph-token');
          await handle!.connection.sendRequest('ApplyCachedTextPropertyEdit', 'graph-token', context.documentId, 'button1', 'Text', '"after"', context.sourceText, 'edited source');
        });
        await expect(withEngineRequestContext({ ...bound, dependencyFingerprint: 'rebuilt-content-b' },
          () => handle!.connection.sendRequest('ApplyCachedTextPropertyEdit', 'graph-token', context.documentId, 'button1', 'Text', '"after"', context.sourceText, 'edited source')))
          .rejects.toMatchObject({ code: 'WORKER_CONTEXT_MISMATCH' });
      })();
      await vi.advanceTimersByTimeAsync(250);
      expect(launch).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(650);
      await preparing;
      expect(launch).toHaveBeenCalledOnce();
      expect(handle!.workerState?.().key).toMatchObject({ configuration: 'Release', platform: 'AnyCPU', dependencyFingerprint: 'actual-content-a' });
      expect(handle!.workerState?.().requests.map((request) => [request.method, request.pid, request.outcome])).toEqual([
        ['RenderWithLayout', 100, 'OK'], ['PreviewOwnedRegionPropertySet', 100, 'OK'], ['ApplyCachedTextPropertyEdit', 100, 'OK'],
      ]);
    } finally { handle?.dispose(); vi.useRealTimers(); }
  });

  it('refuses an actually absent selected engine payload before spawning or connecting', async () => {
    const launch = vi.fn(async () => fakeEngine().physical);
    await expect(startSupervisedEngine(path.resolve('missing-release22-engine-payload', 'WinFormsDesigner.Engine.dll'), {}, launch))
      .rejects.toMatchObject({ code: 'ENGINE_PAYLOAD_UNAVAILABLE' });
    expect(launch).not.toHaveBeenCalled();
  });

  it('refuses a real modern apphost whose managed DLL is missing before spawning', async () => {
    const prefix = path.join(os.tmpdir(), 'wfd-missing-managed-payload-');
    const root = fs.mkdtempSync(prefix); const launch = vi.fn(async () => fakeEngine().physical);
    try {
      const apphost = path.join(root, 'Engine.exe'); fs.writeFileSync(apphost, 'apphost');
      await expect(startSupervisedEngine(apphost, { runtime: 'modern' }, launch)).rejects.toMatchObject({ code: 'ENGINE_PAYLOAD_UNAVAILABLE' });
      expect(launch).not.toHaveBeenCalled();
    } finally {
      if (!path.resolve(root).startsWith(path.resolve(prefix))) throw new Error('Invalid test cleanup target');
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('bounds a connected worker whose negotiation never completes and disposes the actual process', async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeEngine(); fake.sendRequest.mockImplementation(async () => new Promise(() => undefined));
      // The handshake has its own 10-second bound inside the 15-second startup budget.
      const refusal = expect(startSupervisedEngine('fake.dll', { expectedBuildId: buildId }, async () => fake.physical))
        .rejects.toMatchObject({ code: 'ENGINE_NEGOTIATION_TIMEOUT' });
      await vi.advanceTimersByTimeAsync(10_001);
      await refusal;
      expect(fake.dispose).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it('refuses retained handles under a different proven graph while permitting new source revisions', async () => {
    const fake = fakeEngine();
    const actual = { ...context, ownerProject: path.resolve('ProjectA.csproj'), configuration: 'Release',
      platform: 'AnyCPU', targetFramework: 'net10.0-windows', dependencyFingerprint: 'graph-a', dependencyIdentityMode: 'content' as const };
    const handle = await withEngineRequestContext(actual,
      () => startSupervisedEngine('fake.dll', { expectedBuildId: buildId }, async () => fake.physical));
    await withEngineRequestContext({ ...actual, sourceText: 'edited source', documentRevision: 2, renderGeneration: 2 },
      () => handle.connection.sendRequest('Ping'));
    for (const changed of [{ ownerProject: path.resolve('ProjectB.csproj') }, { configuration: 'Debug' },
      { platform: 'x64' }, { targetFramework: 'net9.0-windows' }, { dependencyFingerprint: 'rebuilt-graph' },
      { workspaceTrust: 'untrusted' as const }]) {
      await expect(withEngineRequestContext({ ...actual, ...changed }, () => handle.connection.sendRequest('Ping')))
        .rejects.toMatchObject({ code: 'WORKER_CONTEXT_MISMATCH' });
    }
    expect(fake.sendRequest.mock.calls.filter(([method]) => method === 'ExecuteV2Envelope')).toHaveLength(1);
    await expect(withEngineRequestContext({ ...actual, dependencyIdentityMode: 'opaque' }, () => handle.connection.sendRequest('Ping')))
      .rejects.toMatchObject({ code: 'WORKER_CONTEXT_MISMATCH' });
    handle.dispose();
  });

  it('pins opaque handles to their captured request scope while permitting first-open refinement', async () => {
    const fake = fakeEngine();
    const provisional = { ...context, ownerProject: path.resolve('ProjectA.csproj'), dependencyIdentityMode: 'opaque' as const,
      configuration: 'Release', targetFramework: 'net10.0-windows', dependencyFingerprint: 'opaque-first' };
    const handle = await withEngineRequestContext(provisional, async () => {
      const retained = await startSupervisedEngine('fake.dll', { expectedBuildId: buildId }, async () => fake.physical);
      await retained.connection.sendRequest('ResolveAssembly');
      Object.assign(currentEngineRequestContext()!, { dependencyIdentityMode: 'content', dependencyFingerprint: 'verified-graph', platform: 'AnyCPU' });
      await retained.connection.sendRequest('RenderWithLayout');
      return retained;
    });
    await expect(withEngineRequestContext({ ...provisional, ownerProject: path.resolve('ProjectB.csproj') },
      () => handle.connection.sendRequest('Ping'))).rejects.toMatchObject({ code: 'WORKER_CONTEXT_MISMATCH' });
    await expect(withEngineRequestContext(provisional, () => handle.connection.sendRequest('Ping')))
      .rejects.toMatchObject({ code: 'WORKER_CONTEXT_MISMATCH' });
    expect(fake.sendRequest.mock.calls.filter(([method]) => method === 'ExecuteV2Envelope')).toHaveLength(2);
    handle.dispose();
  });

  it('refuses changed attested content even when platform metadata is missing', async () => {
    const fake = fakeEngine();
    const partial = { ...context, ownerProject: path.resolve('ProjectA.csproj'), configuration: 'Release',
      targetFramework: 'net10.0-windows', dependencyFingerprint: 'attested-content', dependencyIdentityMode: 'content' as const };
    const handle = await withEngineRequestContext(partial,
      () => startSupervisedEngine('fake.dll', { expectedBuildId: buildId }, async () => fake.physical));
    await withEngineRequestContext({ ...partial, documentRevision: 2, sourceText: 'edited source' }, () => handle.connection.sendRequest('Ping'));
    await expect(withEngineRequestContext({ ...partial, dependencyFingerprint: 'replaced-content' }, () => handle.connection.sendRequest('Ping')))
      .rejects.toMatchObject({ code: 'WORKER_CONTEXT_MISMATCH' });
    handle.dispose();
  });

  it('refuses a changed attested content fingerprint within the same incomplete scope', async () => {
    const fake = fakeEngine();
    const partial = { ...context, ownerProject: path.resolve('ProjectA.csproj'), configuration: 'Release',
      targetFramework: 'net10.0-windows', dependencyFingerprint: 'attested-content', dependencyIdentityMode: 'content' as const };
    await withEngineRequestContext(partial, async () => {
      const handle = await startSupervisedEngine('fake.dll', { expectedBuildId: buildId }, async () => fake.physical);
      try {
        await handle.connection.sendRequest('Ping');
        Object.assign(currentEngineRequestContext()!, { dependencyFingerprint: 'replaced-content' });
        await expect(handle.connection.sendRequest('Ping')).rejects.toMatchObject({ code: 'WORKER_CONTEXT_MISMATCH' });
        expect(fake.sendRequest.mock.calls.filter(([method]) => method === 'ExecuteV2Envelope')).toHaveLength(1);
      } finally { handle.dispose(); }
    });
  });

  it('negotiates binary identity and sends distinct stable child operation IDs through real envelope boundary', async () => {
    const fake = fakeEngine();
    const handle = await startSupervisedEngine('fake.dll', { expectedBuildId: buildId, runtime: 'modern' }, async () => fake.physical);
    await withEngineRequestContext(context, () => handle.connection.sendRequest('PreviewOwnedRegionPropertySet', 'Form1.Designer.cs', 'button1', 'Text', '"x"', null, context.sourceText));
    await withEngineRequestContext(context, () => handle.connection.sendRequest('SetProperty', 'Form1.Designer.cs', 'button1', 'Text', '"x"', context.sourceText));
    await withEngineRequestContext(context, () => handle.connection.sendRequest('SetProperty', 'Form1.Designer.cs', 'button1', 'Text', '"x"', context.sourceText));
    const envelopes = fake.sendRequest.mock.calls.filter(([method]) => method === 'ExecuteV2Envelope').map(([, raw]) => JSON.parse(raw as string));
    expect(envelopes[0].commandId).not.toBe(envelopes[1].commandId);
    expect(envelopes[1].commandId).toBe(envelopes[2].commandId);
    expect(envelopes[1].requestId).not.toBe(envelopes[2].requestId);
    expect(envelopes[1]).toMatchObject({ buildId, sourceFingerprint: { byteLength: Buffer.byteLength(context.sourceText) } });
    expect(JSON.parse(envelopes[1].payloadJson)).toMatchObject({ method: 'SetProperty' });
    handle.dispose();
    expect(fake.dispose).toHaveBeenCalledOnce();
    await expect(withEngineRequestContext(context, () => handle.connection.sendRequest('Ping'))).rejects.toMatchObject({ code: 'WORKER_SUPERVISOR_DISPOSED' });
    expect(fake.sendRequest.mock.calls.filter(([method]) => method === 'NegotiateProtocol')).toHaveLength(1);
  });

  it('refuses partial installations and disposes their actual process before any ordinary command', async () => {
    for (const negotiation of [{ buildId: `sha256-${'b'.repeat(64)}` }, { schemaSha256: 'old-schema' }, { capabilities: [] }, { runtime: 'net48' }, { architecture: 'arm64' }]) {
      const fake = fakeEngine({ negotiation });
      await expect(startSupervisedEngine('fake.dll', { expectedBuildId: buildId }, async () => fake.physical)).rejects.toMatchObject({ code: 'ENGINE_PROTOCOL_PARTIAL_UPDATE' });
      expect(fake.dispose).toHaveBeenCalled();
      expect(fake.sendRequest.mock.calls.some(([method]) => method === 'ExecuteV2Envelope')).toBe(false);
    }
  });

  it('refuses missing payloads, stale identities and oversized requests', async () => {
    for (const bad of ['missing', 'stale']) {
      const fake = fakeEngine({ reply: (envelope) => ({ sessionId: envelope.sessionId, documentId: envelope.documentId,
        requestId: bad === 'stale' ? 'wrong-request' : envelope.requestId, documentRevision: envelope.documentRevision,
        generation: envelope.renderGeneration, buildId, outcome: { kind: 'ok', code: 'OK', requestId: envelope.requestId, traceId: envelope.traceId } }) });
      const handle = await startSupervisedEngine('fake.dll', { expectedBuildId: buildId }, async () => fake.physical);
      await expect(withEngineRequestContext(context, () => handle.connection.sendRequest('DescribeComponent', 'Form1.Designer.cs'))).rejects.toMatchObject({ code: bad === 'stale' ? 'STALE_WORKER_REPLY' : 'MISSING_ENGINE_PAYLOAD' });
      handle.dispose();
    }
    const fake = fakeEngine();
    const handle = await startSupervisedEngine('fake.dll', { expectedBuildId: buildId }, async () => fake.physical);
    await expect(withEngineRequestContext(context, () => handle.connection.sendRequest('Ping', 'a'.repeat(1_048_576)))).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    expect(fake.sendRequest.mock.calls.some(([method]) => method === 'ExecuteV2Envelope')).toBe(false);
    handle.dispose();
  });

  it('bounds usage sampling and cancels without counting a completed physical call as a process crash', async () => {
    const fake = fakeEngine({ usage: () => new Promise(() => undefined) });
    const handle = await startSupervisedEngine('fake.dll', { expectedBuildId: buildId }, async () => fake.physical);
    const cancellation = new AbortController();
    const pending = withEngineRequestContext({ ...context, cancellation: cancellation.signal }, () => handle.connection.sendRequest('Ping'));
    await new Promise((resolve) => setImmediate(resolve));
    cancellation.abort();
    await expect(pending).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
    expect(fake.dispose).not.toHaveBeenCalled();
    expect(handle.workerState?.().requests.at(-1)?.outcome).toBe('REQUEST_CANCELLED');
    handle.dispose();
    expect(fake.dispose).toHaveBeenCalledOnce();
  });

  it('observes the exact completed RPC still held after cancellation until the delay drains', async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeEngine();
      const handle = await startSupervisedEngine('fake.dll', { expectedBuildId: buildId }, async () => fake.physical);
      const cancellation = new AbortController(); handle.delayNextReplyForTest?.(1_000);
      const pending = withEngineRequestContext({ ...context, cancellation: cancellation.signal },
        () => handle.connection.sendRequest('DescribeComponent', 'Form1.Designer.cs', 'button1', context.sourceText));
      await vi.advanceTimersByTimeAsync(0);
      const held = handle.workerState!().delayedRequests;
      expect(held).toHaveLength(1);
      expect(held[0]).toMatchObject({ method: 'DescribeComponent', pid: 100,
        documentId: expect.stringMatching(/^document:/), documentRevision: expect.stringMatching(/^revision:/) });
      expect(Object.keys(held[0]).sort()).toEqual(['commandId', 'documentId', 'documentRevision', 'method', 'pid', 'requestId']);
      const envelope = JSON.parse(fake.sendRequest.mock.calls.find(([method]) => method === 'ExecuteV2Envelope')![1] as string);
      expect(held[0].requestId).toBe(envelope.requestId); expect(held[0].commandId).toBe(envelope.commandId);
      cancellation.abort();
      await expect(pending).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
      expect(handle.workerState!()).toMatchObject({ pending: 0, delayedReplies: 1, delayedRequests: held });
      await vi.advanceTimersByTimeAsync(1_001);
      expect(handle.workerState!()).toMatchObject({ delayedReplies: 0, delayedRequests: [] });
      expect(fake.dispose).not.toHaveBeenCalled(); handle.dispose();
    } finally { vi.useRealTimers(); }
  });

  it('preserves a leased render owner across host preparation awaits while another idle worker is recycled', async () => {
    const first = fakeEngine(); const second = fakeEngine();
    const render = await startSupervisedEngine('fake.dll', { expectedBuildId: buildId }, async () => first.physical);
    const idle = await startSupervisedEngine('fake.dll', { expectedBuildId: buildId }, async () => second.physical);
    const release = render.acquireUsageLease!();
    try {
      await withEngineRequestContext(context, () => render.connection.sendRequest('SetLocalizationCulture', 'Form1.Designer.cs', ''));
      expect(render.workerState!()).toMatchObject({ pending: 0, activeLeases: 1 });
      await new Promise((resolve) => setImmediate(resolve)); // toolbox/buffer preparation holds the render handle
      const evicted = [render, idle].find(canRecycleEngineForBudget);
      expect(evicted).toBe(idle); evicted!.dispose();
      await withEngineRequestContext(context, () => render.connection.sendRequest('RenderInterpretedWithLayout', 'Form1.Designer.cs'));
      expect(first.dispose).not.toHaveBeenCalled(); expect(second.dispose).toHaveBeenCalledOnce();
      expect(first.sendRequest.mock.calls.filter(([method]) => method === 'ExecuteV2Envelope')).toHaveLength(2);
    } finally { release(); release(); render.dispose(); idle.dispose(); }
    expect(render.workerState!().activeLeases).toBe(0);
  });

  it('retains all workflow converters across awaits and releases them on completion, failure and cancellation', async () => {
    const first = fakeEngine(); const second = fakeEngine();
    const converter = await startSupervisedEngine('fake.dll', { expectedBuildId: buildId }, async () => first.physical);
    const authority = await startSupervisedEngine('fake.dll', { expectedBuildId: buildId }, async () => second.physical);
    let finishDetached!: () => void;
    const detachedGate = new Promise<void>((resolve) => { finishDetached = resolve; });
    let detachedCheck!: Promise<void>;
    await withEngineRequestContext(context, async () => {
      retainEngineForCurrentRequest(converter); retainEngineForCurrentRequest(converter);
      await converter.connection.sendRequest('SetLocalizationCulture', 'Form1.Designer.cs', '');
      retainEngineForCurrentRequest(authority);
      expect(converter.workerState!()).toMatchObject({ pending: 0, activeLeases: 1 });
      expect([converter, authority].find(canRecycleEngineForBudget)).toBeUndefined();
      releaseEngineForCurrentRequest(authority); releaseEngineForCurrentRequest(authority);
      expect(authority.workerState!().activeLeases).toBe(0);
      expect([converter, authority].find(canRecycleEngineForBudget)).toBe(authority);
      retainEngineForCurrentRequest(authority);
      await new Promise((resolve) => setImmediate(resolve));
      await converter.connection.sendRequest('Ping');
      detachedCheck = detachedGate.then(() => {
        expect(engineRequestScopeActive()).toBe(false);
        expect(() => retainEngineForCurrentRequest(converter)).toThrow('WORKER_REQUEST_SCOPE_COMPLETED');
      });
    });
    finishDetached(); await detachedCheck;
    expect(converter.workerState!().activeLeases).toBe(0); expect(authority.workerState!().activeLeases).toBe(0);
    await expect(withEngineRequestContext(context, async () => { retainEngineForCurrentRequest(converter); throw new Error('workflow failure'); }))
      .rejects.toThrow('workflow failure');
    expect(converter.workerState!().activeLeases).toBe(0);
    const cancellation = new AbortController();
    await withEngineRequestContext({ ...context, cancellation: cancellation.signal }, async () => {
      retainEngineForCurrentRequest(converter); cancellation.abort();
      expect(engineRequestScopeActive()).toBe(false); expect(converter.workerState!().activeLeases).toBe(0);
      expect(() => retainEngineForCurrentRequest(converter)).toThrow('REQUEST_CANCELLED');
    });
    const action = vi.fn();
    expect(() => withEngineRequestContext({ ...context, cancellation: cancellation.signal }, action)).toThrow('REQUEST_CANCELLED');
    expect(action).not.toHaveBeenCalled();
    let recursiveEntries = 0;
    const guardedRead = async (): Promise<void> => {
      recursiveEntries += 1;
      if (!engineRequestScopeActive()) return withEngineRequestContext({ ...context, cancellation: cancellation.signal }, guardedRead);
    };
    await expect(guardedRead()).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
    expect(recursiveEntries).toBe(1);
    converter.dispose(); authority.dispose();
  });

  it('explicitly disposes a leased owner without hidden restart and permits safe repeated release', async () => {
    const fake = fakeEngine(); const launch = vi.fn(async () => fake.physical);
    const handle = await startSupervisedEngine('fake.dll', { expectedBuildId: buildId }, launch);
    const release = handle.acquireUsageLease!(); handle.dispose();
    await expect(handle.connection.sendRequest('Ping')).rejects.toMatchObject({ code: 'WORKER_SUPERVISOR_DISPOSED' });
    expect(handle.workerState!()).toMatchObject({ state: 'disposed', activeLeases: 1 });
    release(); release(); expect(handle.workerState!().activeLeases).toBe(0); expect(launch).toHaveBeenCalledOnce();
  });

  it('releases each completed scanner phase while a separate parent render lease remains protected', async () => {
    const first = fakeEngine(); const second = fakeEngine();
    const render = await startSupervisedEngine('fake.dll', { expectedBuildId: buildId }, async () => first.physical);
    const converter = await startSupervisedEngine('fake.dll', { expectedBuildId: buildId }, async () => second.physical);
    await withEngineRequestContext(context, async () => {
      retainEngineForCurrentRequest(render);
      const captured = currentEngineRequestContext()!;
      await withEngineRequestContext(captured, async () => {
        retainEngineForCurrentRequest(render);
        expect(render.workerState!().activeLeases).toBe(2);
        await render.connection.sendRequest('ScanToolboxAssembly', 'Modern.dll');
      });
      expect(render.workerState!().activeLeases).toBe(1);
      await withEngineRequestContext(captured, async () => {
        retainEngineForCurrentRequest(converter);
        await converter.connection.sendRequest('ScanToolboxAssembly', 'Legacy.dll');
      });
      expect(converter.workerState!().activeLeases).toBe(0);
      expect([render, converter].find(canRecycleEngineForBudget)).toBe(converter);
      expect(engineRequestGraphProven({ ...captured, ownerProject: 'App.csproj', dependencyIdentityMode: 'content' })).toBe(false);
      expect(engineRequestGraphProven({ ...captured, ownerProject: 'App.csproj', dependencyIdentityMode: 'content',
        configuration: 'Release', targetFramework: 'net10.0-windows', platform: 'AnyCPU', dependencyFingerprint: 'content' })).toBe(true);
    });
    expect(render.workerState!().activeLeases).toBe(0); render.dispose(); converter.dispose();
  });

  it('uses aliases for event, cached transition and owner snapshots consistently with engine checks', () => {
    expect(ENGINE_SOURCE_ARGUMENTS.modern).toMatchObject({ GenerateEventHandler: 4, SetEventWiring: 4,
      ListHandlerCandidates: 2, FindEventHandlerSourceIndex: 3, ApplyCachedTextPropertyEdit: 5 });
    expect(ENGINE_SOURCE_ARGUMENTS.net48.ApplyInterpretedEditsLive).toBe(3);
  });

  it('increments actual wire generations above a dominating render sequence for successive proposed sources', async () => {
    const fake = fakeEngine();
    const handle = await startSupervisedEngine('fake.dll', { expectedBuildId: buildId }, async () => fake.physical);
    await withEngineRequestContext({ ...context, renderGeneration: 15 }, async () => {
      await handle.connection.sendRequest('SetProperty', 'Form1.Designer.cs', 'button1', 'Text', '"x"', 'source-a');
      await handle.connection.sendRequest('SetProperty', 'Form1.Designer.cs', 'button1', 'Text', '"y"', 'source-b');
    });
    const envelopes = fake.sendRequest.mock.calls.filter(([method]) => method === 'ExecuteV2Envelope').map(([, raw]) => JSON.parse(raw as string));
    expect(envelopes[1].renderGeneration).toBe(envelopes[0].renderGeneration + 1);
    handle.dispose();
  });

  it('separates context-only repeated RPCs before and after the same host operation commits new source', async () => {
    const fake = fakeEngine({ negotiation: { runtime: '.NET 10.0.0' } });
    const handle = await startSupervisedEngine('fake.dll', { expectedBuildId: buildId }, async () => fake.physical);
    await withEngineRequestContext(context, () => handle.connection.sendRequest('SetLocalizationCulture', 'Form1.Designer.cs', ''));
    await withEngineRequestContext({ ...context, documentRevision: 2, sourceText: 'class Form1 { }' }, () => handle.connection.sendRequest('SetLocalizationCulture', 'Form1.Designer.cs', ''));
    const envelopes = fake.sendRequest.mock.calls.filter(([method]) => method === 'ExecuteV2Envelope').map(([, raw]) => JSON.parse(raw as string));
    expect(envelopes[0].commandId).not.toBe(envelopes[1].commandId);
    handle.dispose();
  });
});
