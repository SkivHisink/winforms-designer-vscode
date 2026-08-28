import { describe, expect, test, vi } from 'vitest';
import {
  EngineHandle,
  GeometryCommitResult,
  GeometryDragStartResult,
  authorizeGeometryBatch,
  authorizeGeometryCommit,
  authorizeInheritedGeometryOverride,
  applyInheritedPropertyOverride,
  describeCompiledComponent,
  describeInterpretedComponent,
  removeInheritedPropertyOverride,
  beginGeometryDrag,
  commitGeometryBounds,
  createEngineBackedV2WorkerSupervisor,
  editCertifiedVendorCollectionEditor,
  editSupportedCollectionEditor,
  editSupportedUiTypeEditor,
  EngineCapabilities,
  geometryCandidateFromWindow,
  inspectCertifiedHostedDesigner,
  inspectCertifiedHostedServiceKernel,
  invokeCertifiedHostedServiceAction,
  listProjectImageResources,
  newPipeName,
  planBoundedComponentPatch,
  previewOwnedRegionPropertySet,
  recordV2EngineProbeCrash,
  requestV2EngineProbe,
  resolveDesignerDocumentOwner,
  setProjectImageResource,
  setPropertyViaProvenOwnedRegion,
} from './engineClient';

function mockEngine(sendRequest: ReturnType<typeof vi.fn>): EngineHandle {
  return { connection: { sendRequest } } as unknown as EngineHandle;
}

function geometryStart(overrides: Partial<GeometryDragStartResult> = {}): GeometryDragStartResult {
  return {
    ok: true,
    reason: '',
    componentId: 'button1',
    componentType: 'System.Windows.Forms.Button',
    parentId: 'this',
    parentType: 'System.Windows.Forms.Form',
    parentLayoutKind: 'DefaultLayout',
    logicalBounds: { x: 10, y: 20, width: 80, height: 24 },
    windowBounds: { x: 18, y: 51, width: 80, height: 24 },
    margin: { left: 3, top: 3, right: 3, bottom: 3 },
    padding: { left: 0, top: 0, right: 0, bottom: 0 },
    parentPadding: { left: 0, top: 0, right: 0, bottom: 0 },
    anchor: 'Top, Left',
    dock: 'None',
    autoSize: false,
    minimumWidth: 0,
    minimumHeight: 0,
    maximumWidth: 0,
    maximumHeight: 0,
    canMove: true,
    canResize: true,
    ...overrides,
  };
}

function geometryCommit(overrides: Partial<GeometryCommitResult> = {}): GeometryCommitResult {
  return {
    ok: true,
    reason: '',
    componentId: 'button1',
    requestedLogicalBounds: { x: 10, y: 20, width: 80, height: 24 },
    correctedLogicalBounds: { x: 10, y: 20, width: 80, height: 24 },
    correctedWindowBounds: { x: 18, y: 51, width: 80, height: 24 },
    corrected: false,
    designerText: 'SERVER_TEXT',
    sourceValues: [],
    ...overrides,
  };
}

class Deferred<T> {
  readonly promise: Promise<T>;
  private resolveCore!: (value: T) => void;

  constructor() {
    this.promise = new Promise<T>((resolve) => {
      this.resolveCore = resolve;
    });
  }

  resolve(value: T): void {
    this.resolveCore(value);
  }
}

function capabilities(overrides: Partial<EngineCapabilities> = {}): EngineCapabilities {
  return {
    engine: 'modern',
    render: true,
    edit: true,
    livePreviewUnsavedEdits: true,
    runtime: '.NET',
    notes: '',
    ...overrides,
  };
}

async function flushPromises(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('newPipeName', () => {
  test('is unique across many rapid calls in the same millisecond', () => {
    // Pin the regression directly: the old name was `winforms-designer-${process.pid}-${Date.now()}`, so with the
    // clock frozen (as it effectively is when two engine kinds start in the same tick) every call collided.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      const before = Date.now();
      const names = Array.from({ length: 1_000 }, () => newPipeName());
      expect(Date.now()).toBe(before); // clock really did not advance across the batch
      expect(new Set(names).size).toBe(names.length);
    } finally {
      vi.useRealTimers();
    }
  });

  test('keeps the diagnosable prefix and stays a legal Windows pipe name', () => {
    const name = newPipeName();
    expect(name.startsWith('winforms-designer-')).toBe(true);
    // \\.\pipe\<name>: any char but a backslash, and the whole path caps at 256 chars.
    expect(name).not.toContain('\\');
    expect(('\\\\.\\pipe\\' + name).length).toBeLessThanOrEqual(256);
  });
});

describe('modern engine-authoritative geometry client', () => {
  test('routes Begin/Commit with exact positional assembly and unsaved-source slots', async () => {
    const sendRequest = vi.fn()
      .mockResolvedValueOnce(geometryStart())
      .mockResolvedValueOnce(geometryCommit());
    const engine = mockEngine(sendRequest);

    await beginGeometryDrag(engine, 'C:\\Form.Designer.cs', 'button1', undefined, 'SOURCE');
    await commitGeometryBounds(
      engine, 'C:\\Form.Designer.cs', 'button1', { x: 14, y: 25, width: 91, height: 30 }, undefined, 'SOURCE');

    expect(sendRequest).toHaveBeenNthCalledWith(
      1, 'BeginGeometryDrag', 'C:\\Form.Designer.cs', 'button1', null, 'SOURCE');
    expect(sendRequest).toHaveBeenNthCalledWith(
      2, 'CommitGeometryBounds', 'C:\\Form.Designer.cs', 'button1', 14, 25, 91, 30, null, 'SOURCE', null);
  });

  test('translates window preview through live engine origins and returns only server DesignerText', async () => {
    const start = geometryStart({ baseIdentityToken: 'sha256:BASE' });
    const server: GeometryCommitResult = {
      ok: true,
      reason: '',
      componentId: 'button1',
      requestedLogicalBounds: { x: 15, y: 26, width: 500, height: 1 },
      correctedLogicalBounds: { x: 15, y: 26, width: 200, height: 8 },
      correctedWindowBounds: { x: 23, y: 57, width: 200, height: 8 },
      corrected: true,
      designerText: 'ENGINE_CORRECTED_TEXT',
      sourceValues: [{ componentId: 'button1', propertyName: 'Size', expression: 'new System.Drawing.Size(200, 8)' }],
    };
    const sendRequest = vi.fn().mockResolvedValueOnce(start).mockResolvedValueOnce(server);
    const engine = mockEngine(sendRequest);
    const result = await authorizeGeometryCommit(
      engine, 'C:\\Form.Designer.cs', 'button1', 'resize',
      (live) => geometryCandidateFromWindow(live, { x: 23, y: 57, width: 500, height: 1 }),
      undefined, 'ORIGINAL_SOURCE');

    expect(result.ok).toBe(true);
    expect(result.designerText).toBe('ENGINE_CORRECTED_TEXT');
    expect(result.result?.correctedLogicalBounds).toEqual({ x: 15, y: 26, width: 200, height: 8 });
    expect(sendRequest).toHaveBeenNthCalledWith(
      2, 'CommitGeometryBounds', 'C:\\Form.Designer.cs', 'button1', 15, 26, 500, 1,
      null, 'ORIGINAL_SOURCE', 'sha256:BASE');
  });

  test('V2-FND-001-S021 moves selected controls as one source transaction', async () => {
    const sendRequest = vi.fn()
      .mockResolvedValueOnce(geometryStart({ componentId: 'button1', logicalBounds: { x: 10, y: 20, width: 80, height: 24 } }))
      .mockResolvedValueOnce(geometryCommit({
        componentId: 'button1',
        designerText: 'BUTTON1_MOVED_SOURCE',
        requestedLogicalBounds: { x: 27, y: 29, width: 80, height: 24 },
        correctedLogicalBounds: { x: 27, y: 29, width: 80, height: 24 },
        correctedWindowBounds: { x: 35, y: 60, width: 80, height: 24 },
        sourceValues: [{
          componentId: 'button1',
          propertyName: 'Location',
          propertyTypeName: 'System.Drawing.Point',
          invariantValue: '27, 29',
          expression: 'new System.Drawing.Point(27, 29)',
        }],
      }))
      .mockResolvedValueOnce(geometryStart({ componentId: 'button2', logicalBounds: { x: 40, y: 50, width: 80, height: 24 } }))
      .mockResolvedValueOnce(geometryCommit({
        componentId: 'button2',
        designerText: 'BOTH_BUTTONS_MOVED_SOURCE',
        requestedLogicalBounds: { x: 57, y: 59, width: 80, height: 24 },
        correctedLogicalBounds: { x: 57, y: 59, width: 80, height: 24 },
        correctedWindowBounds: { x: 65, y: 90, width: 80, height: 24 },
        sourceValues: [{
          componentId: 'button2',
          propertyName: 'Location',
          propertyTypeName: 'System.Drawing.Point',
          invariantValue: '57, 59',
          expression: 'new System.Drawing.Point(57, 59)',
        }],
      }));
    const engine = mockEngine(sendRequest);
    const moveBy = (id: string) => ({
      id,
      mode: 'move' as const,
      candidate: (start: GeometryDragStartResult) => start.logicalBounds && ({
        ...start.logicalBounds,
        x: start.logicalBounds.x + 17,
        y: start.logicalBounds.y + 9,
      }),
    });

    const result = await authorizeGeometryBatch(
      engine,
      'C:\\Form.Designer.cs',
      [moveBy('button1'), moveBy('button2')],
      undefined,
      'ORIGINAL_SOURCE');

    expect(result).toMatchObject({
      ok: true,
      failedId: null,
      designerText: 'BOTH_BUTTONS_MOVED_SOURCE',
      appliedCount: 2,
    });
    expect(result.sourceValues.map((value) => `${value.componentId}:${value.invariantValue}`)).toEqual([
      'button1:27, 29',
      'button2:57, 59',
    ]);
    expect(sendRequest).toHaveBeenNthCalledWith(
      2, 'CommitGeometryBounds', 'C:\\Form.Designer.cs', 'button1', 27, 29, 80, 24, null, 'ORIGINAL_SOURCE', null);
    expect(sendRequest).toHaveBeenNthCalledWith(
      4, 'CommitGeometryBounds', 'C:\\Form.Designer.cs', 'button2', 57, 59, 80, 24, null, 'BUTTON1_MOVED_SOURCE', null);
  });

  test('routes inherited property overrides with only the engine-issued expected token', async () => {
    const sendRequest = vi.fn().mockResolvedValue({ safe: true, mode: 'Insert', text: 'DERIVED', reason: '' });
    await applyInheritedPropertyOverride(
      mockEngine(sendRequest), 'C:\\Form.Designer.cs', 'baseButton', 'Text', '"Derived"',
      'sha256:BASE', 'C:\\bin\\Demo.dll', 'SOURCE', 'DIRTY_CODE_BEHIND');

    expect(sendRequest).toHaveBeenCalledWith(
      'ApplyInheritedPropertyOverride', 'C:\\Form.Designer.cs', 'baseButton', 'Text', '"Derived"',
      'sha256:BASE', 'C:\\bin\\Demo.dll', 'SOURCE', 'DIRTY_CODE_BEHIND');
  });

  test('routes net48 inherited geometry authorization without source-authored identity metadata', async () => {
    const sendRequest = vi.fn().mockResolvedValue({
      safe: true, reason: '', baseIdentityToken: 'sha256:BASE',
    });
    const result = await authorizeInheritedGeometryOverride(
      mockEngine(sendRequest), 'C:\\Form.Designer.cs', 'baseButton',
      'sha256:BASE', 'C:\\bin\\Demo.dll');

    expect(result.safe).toBe(true);
    expect(sendRequest).toHaveBeenCalledWith(
      'AuthorizeInheritedGeometryOverride', 'C:\\Form.Designer.cs', 'baseButton',
      'sha256:BASE', 'C:\\bin\\Demo.dll');
  });

  test('routes inherited reset through the token-checked derived-source removal RPC', async () => {
    const sendRequest = vi.fn().mockResolvedValue({ safe: true, mode: 'Remove', text: 'DERIVED', reason: '' });
    await removeInheritedPropertyOverride(
      mockEngine(sendRequest), 'C:\\Form.Designer.cs', 'baseButton', 'Text',
      'sha256:BASE', 'C:\\bin\\Demo.dll', 'SOURCE', 'DIRTY_CODE_BEHIND');

    expect(sendRequest).toHaveBeenCalledWith(
      'RemoveInheritedPropertyOverride', 'C:\\Form.Designer.cs', 'baseButton', 'Text',
      'sha256:BASE', 'C:\\bin\\Demo.dll', 'SOURCE', 'DIRTY_CODE_BEHIND');
  });

  test('routes the current code-behind snapshot through both net48 describe authorities', async () => {
    const sendRequest = vi.fn().mockResolvedValue(null);
    const engine = mockEngine(sendRequest);

    await describeCompiledComponent(
      engine, 'C:\\Form.Designer.cs', 'C:\\bin\\Demo.dll', 'baseButton',
      'Demo.Form', ['C:\\bin'], 'DESIGNER', 'DIRTY_CODE_BEHIND');
    await describeInterpretedComponent(
      engine, 'C:\\Form.Designer.cs', 'C:\\bin\\Demo.dll', 'DESIGNER', 'baseButton',
      'Demo.Form', ['C:\\bin'], 640, 480, 'DIRTY_CODE_BEHIND');

    expect(sendRequest).toHaveBeenNthCalledWith(
      1, 'DescribeCompiledComponent', 'C:\\Form.Designer.cs', 'C:\\bin\\Demo.dll', 'baseButton',
      'Demo.Form', ['C:\\bin'], 'DESIGNER', 'DIRTY_CODE_BEHIND');
    expect(sendRequest).toHaveBeenNthCalledWith(
      2, 'DescribeInterpretedComponent', 'C:\\Form.Designer.cs', 'C:\\bin\\Demo.dll',
      'DESIGNER', 'baseButton', 'Demo.Form', ['C:\\bin'], 640, 480, 'DIRTY_CODE_BEHIND');
  });

  test('routes certified hosted-designer activation without caller-authored crash or quarantine state', async () => {
    const reply = {
      ok: false,
      status: 'quarantined',
      errorCode: 'DESIGNER_QUARANTINED',
      reason: 'quarantined',
      componentType: 'FakeVendor.CrashOnInitializeControl',
      designerType: 'FakeVendor.CrashOnInitializeDesigner',
      certificationId: 'repo.fakevendor.hosted-designer.v1',
      assemblySha256: 'abc',
      mainEnginePid: 100,
      workerPid: 101,
      exitCode: -1,
      workerStarted: false,
      quarantined: true,
      privateDesktop: true,
    } as const;
    const sendRequest = vi.fn().mockResolvedValue(reply);
    const result = await inspectCertifiedHostedDesigner(
      mockEngine(sendRequest),
      'C:\\bin\\FakeVendor.dll',
      'FakeVendor.CrashOnInitializeControl',
      'repo.fakevendor.hosted-designer.v1',
    );

    expect(result).toEqual(reply);
    expect(sendRequest).toHaveBeenCalledWith(
      'InspectCertifiedHostedDesigner',
      'C:\\bin\\FakeVendor.dll',
      'FakeVendor.CrashOnInitializeControl',
      'repo.fakevendor.hosted-designer.v1',
    );
  });

  test('routes certified hosted-service inspection and action without caller-authored edit proposals', async () => {
    const inspected = { ok: true, status: 'ready', edits: [] };
    const applied = {
      ok: true,
      status: 'applied',
      edits: [{ propertyName: 'Text', propertyType: 'System.String', invariantValue: 'Hosted service preset' }],
    };
    const sendRequest = vi.fn().mockResolvedValueOnce(inspected).mockResolvedValueOnce(applied);
    const engine = mockEngine(sendRequest);

    await expect(inspectCertifiedHostedServiceKernel(
      engine,
      'C:\bin\FakeVendor.dll',
      'FakeVendor.HostedServiceControl',
      'repo.fakevendor.hosted-service-kernel.v1',
    )).resolves.toBe(inspected);
    await expect(invokeCertifiedHostedServiceAction(
      engine,
      'C:\bin\FakeVendor.dll',
      'FakeVendor.HostedServiceControl',
      'repo.fakevendor.hosted-service-kernel.v1',
      'applyServicePreset',
    )).resolves.toBe(applied);
    expect(sendRequest).toHaveBeenNthCalledWith(
      1,
      'InspectCertifiedHostedServiceKernel',
      'C:\bin\FakeVendor.dll',
      'FakeVendor.HostedServiceControl',
      'repo.fakevendor.hosted-service-kernel.v1',
    );
    expect(sendRequest).toHaveBeenNthCalledWith(
      2,
      'InvokeCertifiedHostedServiceAction',
      'C:\bin\FakeVendor.dll',
      'FakeVendor.HostedServiceControl',
      'repo.fakevendor.hosted-service-kernel.v1',
      'applyServicePreset',
    );
  });

  test('layout-managed refusal never calls CommitGeometryBounds', async () => {
    const sendRequest = vi.fn().mockResolvedValueOnce(geometryStart({
      reason: 'parent layout manages child bounds: TableLayoutPanel',
      parentLayoutKind: 'TableLayoutPanel',
      canMove: false,
      canResize: false,
    }));
    const result = await authorizeGeometryCommit(
      mockEngine(sendRequest), 'C:\\Form.Designer.cs', 'button1', 'move',
      () => ({ x: 99, y: 99, width: 80, height: 24 }), undefined, 'SOURCE');

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('TableLayoutPanel');
    expect(sendRequest).toHaveBeenCalledTimes(1);
    expect(sendRequest.mock.calls.some((c) => c[0] === 'CommitGeometryBounds')).toBe(false);
  });

  test('multi-selection exposes no partial source when a later component refuses', async () => {
    const sendRequest = vi.fn()
      .mockResolvedValueOnce(geometryStart({ componentId: 'button1' }))
      .mockResolvedValueOnce(geometryCommit({ componentId: 'button1', designerText: 'PARTIAL_ENGINE_TEXT' }))
      .mockResolvedValueOnce(geometryStart({
        componentId: 'button2',
        reason: 'parent layout manages child bounds: FlowLayoutPanel',
        parentLayoutKind: 'FlowLayoutPanel',
        canMove: false,
        canResize: false,
      }));
    const intent = (id: string) => ({
      id,
      mode: 'move' as const,
      candidate: (start: GeometryDragStartResult) => start.logicalBounds && ({
        ...start.logicalBounds, x: start.logicalBounds.x + 4,
      }),
    });
    const result = await authorizeGeometryBatch(
      mockEngine(sendRequest), 'C:\\Form.Designer.cs', [intent('button1'), intent('button2')], undefined, 'SOURCE');

    expect(result).toMatchObject({
      ok: false,
      failedId: 'button2',
      designerText: null,
      appliedCount: 0,
    });
    expect(result.reason).toContain('FlowLayoutPanel');
    expect(sendRequest).toHaveBeenNthCalledWith(
      3, 'BeginGeometryDrag', 'C:\\Form.Designer.cs', 'button2', null, 'PARTIAL_ENGINE_TEXT');
    expect(sendRequest.mock.calls.filter((c) => c[0] === 'CommitGeometryBounds')).toHaveLength(1);
  });

  test('RPC failure propagates without any client-authored SetProperty fallback', async () => {
    const sendRequest = vi.fn().mockRejectedValueOnce(new Error('engine unavailable'));
    await expect(authorizeGeometryCommit(
      mockEngine(sendRequest), 'C:\\Form.Designer.cs', 'button1', 'move',
      () => ({ x: 1, y: 2, width: 3, height: 4 }), undefined, 'SOURCE'))
      .rejects.toThrow('engine unavailable');
    expect(sendRequest.mock.calls.map((c) => c[0])).toEqual(['BeginGeometryDrag']);
  });
});

describe('supported UITypeEditor client', () => {
  test('routes the allowlisted worker RPC with explicit nullable vendor certification slots', async () => {
    const sendRequest = vi.fn().mockResolvedValue({
      ok: true, applied: false, dismissed: true, errorCode: '', reason: '',
    });
    const result = await editSupportedUiTypeEditor(
      mockEngine(sendRequest), 'req.1', 'System.Drawing.Design.ColorEditor', 'System.Drawing.Color', 'Red');
    expect(result.dismissed).toBe(true);
    expect(sendRequest).toHaveBeenCalledWith(
      'EditSupportedUiTypeEditor', 'req.1', 'System.Drawing.Design.ColorEditor', 'System.Drawing.Color', 'Red',
      null, null, null);
  });

  test('routes the real CollectionEditor worker with bounded invariant items', async () => {
    const sendRequest = vi.fn().mockResolvedValue({
      ok: true, applied: true, dismissed: false, collectionItems: ['3', '5'], errorCode: '', reason: '',
    });

    const result = await editSupportedCollectionEditor(
      mockEngine(sendRequest), 'collection.1', 'System.Int32', ['1', '2']);

    expect(result.collectionItems).toEqual(['3', '5']);
    expect(sendRequest).toHaveBeenCalledWith(
      'EditSupportedCollectionEditor', 'collection.1', 'System.Int32', ['1', '2']);
  });

  test('routes a certified vendor collection editor with the complete assembly identity tuple', async () => {
    const sendRequest = vi.fn().mockResolvedValue({
      ok: true, applied: true, dismissed: false, collectionItems: ['3', '5'], errorCode: '', reason: '',
    });

    const result = await editCertifiedVendorCollectionEditor(
      mockEngine(sendRequest),
      'collection.vendor.1',
      'FakeVendor.VendorThresholdsEditor',
      'System.Int32',
      ['1', '2'],
      'C:\\fixtures\\FakeVendor.dll',
      'a'.repeat(64),
      'repo.fakevendor.thresholds.v1',
    );

    expect(result.collectionItems).toEqual(['3', '5']);
    expect(sendRequest).toHaveBeenCalledWith(
      'EditCertifiedVendorCollectionEditor',
      'collection.vendor.1',
      'FakeVendor.VendorThresholdsEditor',
      'System.Int32',
      ['1', '2'],
      'C:\\fixtures\\FakeVendor.dll',
      'a'.repeat(64),
      'repo.fakevendor.thresholds.v1',
    );
  });
});

describe('v2 owned-region product route', () => {
  test('routes a full vendor proposal through the component-bounded preview RPC', async () => {
    const sendRequest = vi.fn().mockResolvedValue({
      safe: true,
      reason: '',
      plannedSourceText: 'PROPOSED',
      semanticEquivalence: true,
      outsideRegionPreserved: true,
    });

    const result = await planBoundedComponentPatch(
      mockEngine(sendRequest),
      'SOURCE',
      'b'.repeat(64),
      'PROPOSED',
      'vendorEdit1',
      'vendorEdit1.Thresholds',
    );

    expect(result.safe).toBe(true);
    expect(sendRequest).toHaveBeenCalledWith(
      'PlanBoundedComponentPatch',
      'SOURCE',
      'b'.repeat(64),
      'PROPOSED',
      'vendorEdit1',
      'vendorEdit1.Thresholds',
    );
  });

  test('uses Lane B for an independently proven byte-identical owned region', async () => {
    const sendRequest = vi.fn().mockResolvedValue({
      safe: true,
      reason: '',
      semanticEquivalence: true,
      outsideRegionPreserved: true,
      plannedSourceText: 'LANE_B',
      laneASourceText: 'LANE_B',
    });
    const engine = mockEngine(sendRequest);

    const result = await setPropertyViaProvenOwnedRegion(
      engine,
      'C:\\Form.Designer.cs',
      'button1',
      'Text',
      '"Renamed"',
      'SOURCE',
      'graph-token',
    );

    expect(result).toMatchObject({ safe: true, text: 'LANE_B', persistenceLane: 'ownedRegion' });
    expect(sendRequest).toHaveBeenCalledWith(
      'PreviewOwnedRegionPropertySet',
      'C:\\Form.Designer.cs',
      '56ccd012fa61dd4b6697697b49cc06debf68c1876c2fa89750ba35dd2ae875d9',
      'button1',
      'Text',
      '"Renamed"',
      'SOURCE',
      true,
      'graph-token',
    );
    expect(sendRequest.mock.calls.some((call) => call[0] === 'SetProperty')).toBe(false);
  });

  test('falls back to Lane A when an owned-region proof is incomplete', async () => {
    const sendRequest = vi.fn()
      .mockResolvedValueOnce({
        safe: true,
        reason: '',
        semanticEquivalence: true,
        outsideRegionPreserved: true,
        plannedSourceText: 'LANE_B',
        laneASourceText: 'DIFFERENT_LANE_A',
      })
      .mockResolvedValueOnce({ safe: true, mode: 'Replace', text: 'LANE_A', reason: '' });

    const result = await setPropertyViaProvenOwnedRegion(
      mockEngine(sendRequest), 'C:\\Form.Designer.cs', 'button1', 'Text', '"Renamed"', 'SOURCE');

    expect(result).toMatchObject({
      safe: true,
      text: 'LANE_A',
      persistenceLane: 'sourceFirst',
      ownedRegionRefusal: 'owned-region proof was incomplete',
    });
    expect(sendRequest.mock.calls.map((call) => call[0])).toEqual([
      'PreviewOwnedRegionPropertySet',
      'SetProperty',
    ]);
  });
});

describe('v2 engine-backed worker probe', () => {
  test('routes a read-only capabilities probe through selected worker supervision', async () => {
    const sendRequest = vi.fn().mockResolvedValue(capabilities({ engine: 'modern-test' }));
    const requestedKinds: string[] = [];
    const supervisor = createEngineBackedV2WorkerSupervisor(
      async (kind) => {
        requestedKinds.push(kind);
        return mockEngine(sendRequest);
      },
      {
        sessionId: 'probe-session',
        recoveryPolicy: { recordCrash: () => ({ restart: false, delayMs: 0, recentCrashes: 1 }) },
      },
    );

    const result = await requestV2EngineProbe(supervisor, {
      runtime: 'modern',
      command: 'getCapabilities',
      documentLabel: 'C:\\src\\Form1.cs',
      documentRevision: 7,
      sourceFingerprintSeed: 'designer-source',
      hostArchitecture: 'x64',
      timeoutMs: 250,
    });

    expect(result).toMatchObject({
      status: 'ok',
      workerKey: 'modern:x64:native',
      requestId: 'probe-session:1',
      generation: 1,
      result: {
        command: 'getCapabilities',
        value: { engine: 'modern-test' },
      },
    });
    expect(requestedKinds).toEqual(['modern']);
    expect(sendRequest).toHaveBeenCalledWith('GetCapabilities');
  });

  test('refuses x86 selection before starting an engine-backed worker', async () => {
    const start = vi.fn();
    const supervisor = createEngineBackedV2WorkerSupervisor(
      async (kind) => {
        start(kind);
        return mockEngine(vi.fn());
      },
      {
        sessionId: 'probe-session',
        recoveryPolicy: { recordCrash: () => ({ restart: false, delayMs: 0, recentCrashes: 1 }) },
      },
    );

    await expect(requestV2EngineProbe(supervisor, {
      runtime: 'net48',
      command: 'ping',
      projectArchitecture: 'x86',
      hostArchitecture: 'x64',
    })).resolves.toEqual({
      status: 'selectionRefused',
      reasonCode: 'X86_WORKER_UNAVAILABLE',
    });
    expect(start).not.toHaveBeenCalled();
  });

  test('maps cancellation and deadline to structured probe statuses', async () => {
    const sendRequest = vi.fn().mockReturnValue(new Promise(() => undefined));
    const supervisor = createEngineBackedV2WorkerSupervisor(
      async () => mockEngine(sendRequest),
      {
        sessionId: 'probe-session',
        recoveryPolicy: { recordCrash: () => ({ restart: false, delayMs: 0, recentCrashes: 1 }) },
      },
    );

    await expect(requestV2EngineProbe(supervisor, {
      runtime: 'modern',
      command: 'ping',
      hostArchitecture: 'x64',
      timeoutMs: 0,
    })).resolves.toMatchObject({
      status: 'deadlineExceeded',
      reasonCode: 'REQUEST_DEADLINE_EXCEEDED',
      requestId: 'probe-session:1',
      generation: 1,
    });

    const controller = new AbortController();
    const cancelled = requestV2EngineProbe(supervisor, {
      runtime: 'modern',
      command: 'ping',
      hostArchitecture: 'x64',
      timeoutMs: 1_000,
      cancellation: controller.signal,
    });
    await flushPromises();
    controller.abort();

    await expect(cancelled).resolves.toMatchObject({
      status: 'cancelled',
      reasonCode: 'REQUEST_CANCELLED',
      requestId: 'probe-session:2',
      generation: 1,
    });
  });

  test('rejects a late probe reply after the host records an engine crash', async () => {
    const reply = new Deferred<EngineCapabilities>();
    const sendRequest = vi.fn().mockReturnValue(reply.promise);
    const recovery = { recordCrash: vi.fn(() => ({ restart: true, delayMs: 0, recentCrashes: 1 })) };
    const supervisor = createEngineBackedV2WorkerSupervisor(
      async () => mockEngine(sendRequest),
      { sessionId: 'probe-session', recoveryPolicy: recovery },
    );

    const pending = requestV2EngineProbe(supervisor, {
      runtime: 'modern',
      command: 'getCapabilities',
      hostArchitecture: 'x64',
      timeoutMs: 1_000,
    });
    await flushPromises();
    expect(sendRequest).toHaveBeenCalledWith('GetCapabilities');

    expect(recordV2EngineProbeCrash(supervisor, 'modern', 'x64')).toEqual({
      restart: true,
      delayMs: 0,
      recentCrashes: 1,
    });
    reply.resolve(capabilities());

    await expect(pending).resolves.toMatchObject({
      status: 'stale',
      reasonCode: 'STALE_WORKER_REPLY',
      requestId: 'probe-session:1',
      generation: 1,
    });
  });
});

describe('project resource picker client', () => {
  test('routes list and bind RPCs with host-supplied resource texts', async () => {
    const sendRequest = vi.fn()
      .mockResolvedValueOnce({ ok: true, reason: '', candidates: [] })
      .mockResolvedValueOnce({ safe: true, mode: 'Insert', text: 'TEXT', reason: '' });
    const engine = mockEngine(sendRequest);

    await listProjectImageResources(engine, '<root />', 'namespace Demo.Properties { class Resources {} }');
    await setProjectImageResource(
      engine,
      'C:\\Form.Designer.cs',
      'pictureBox1',
      'Image',
      'System.Drawing.Image',
      '<root />',
      'RESOURCES_DESIGNER',
      'Demo.Properties.Resources',
      'Logo',
      'SOURCE');

    expect(sendRequest).toHaveBeenNthCalledWith(
      1, 'ListProjectImageResources', '<root />', 'namespace Demo.Properties { class Resources {} }');
    expect(sendRequest).toHaveBeenNthCalledWith(
      2,
      'SetProjectImageResource',
      'C:\\Form.Designer.cs',
      'pictureBox1',
      'Image',
      'System.Drawing.Image',
      '<root />',
      'RESOURCES_DESIGNER',
      'Demo.Properties.Resources',
      'Logo',
      'SOURCE');
  });
});

describe('v2 document owner client', () => {
  test('V2-FND-001-S009: routes bounded owner resolution with host-supplied source', async () => {
    const sendRequest = vi.fn().mockResolvedValue({
      diagnosticCode: 'NONE',
      typeName: 'Demo.Form1',
      projectPath: 'C:\\Demo\\Demo.csproj',
      owners: ['C:\\Demo\\Demo.csproj'],
    });
    const engine = mockEngine(sendRequest);

    await resolveDesignerDocumentOwner(
      engine,
      'C:\\Demo\\Form1.Designer.cs',
      ['C:\\Demo\\Demo.csproj'],
      'partial class Form1 { private void InitializeComponent() { } }',
      'partial class Form1 : System.Windows.Forms.Form { }',
    );

    expect(sendRequest).toHaveBeenCalledWith(
      'ResolveDesignerDocumentOwner',
      'C:\\Demo\\Form1.Designer.cs',
      ['C:\\Demo\\Demo.csproj'],
      'partial class Form1 { private void InitializeComponent() { } }',
      'partial class Form1 : System.Windows.Forms.Form { }',
    );
  });
});
