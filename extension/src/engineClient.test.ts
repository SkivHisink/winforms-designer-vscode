import { describe, expect, test, vi } from 'vitest';
import {
  EngineHandle,
  GeometryCommitResult,
  GeometryDragStartResult,
  authorizeGeometryBatch,
  authorizeGeometryCommit,
  beginGeometryDrag,
  commitGeometryBounds,
  editSupportedUiTypeEditor,
  geometryCandidateFromWindow,
  newPipeName,
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
      .mockResolvedValueOnce({ ok: true, componentId: 'button1', designerText: 'SERVER_TEXT' });
    const engine = mockEngine(sendRequest);

    await beginGeometryDrag(engine, 'C:\\Form.Designer.cs', 'button1', undefined, 'SOURCE');
    await commitGeometryBounds(
      engine, 'C:\\Form.Designer.cs', 'button1', { x: 14, y: 25, width: 91, height: 30 }, undefined, 'SOURCE');

    expect(sendRequest).toHaveBeenNthCalledWith(
      1, 'BeginGeometryDrag', 'C:\\Form.Designer.cs', 'button1', null, 'SOURCE');
    expect(sendRequest).toHaveBeenNthCalledWith(
      2, 'CommitGeometryBounds', 'C:\\Form.Designer.cs', 'button1', 14, 25, 91, 30, null, 'SOURCE');
  });

  test('translates window preview through live engine origins and returns only server DesignerText', async () => {
    const start = geometryStart();
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
      2, 'CommitGeometryBounds', 'C:\\Form.Designer.cs', 'button1', 15, 26, 500, 1, null, 'ORIGINAL_SOURCE');
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
      .mockResolvedValueOnce({ ok: true, componentId: 'button1', designerText: 'PARTIAL_ENGINE_TEXT' })
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
  test('routes the narrow allowlisted worker RPC without widening its payload', async () => {
    const sendRequest = vi.fn().mockResolvedValue({
      ok: true, applied: false, dismissed: true, errorCode: '', reason: '',
    });
    const result = await editSupportedUiTypeEditor(
      mockEngine(sendRequest), 'req.1', 'System.Drawing.Design.ColorEditor', 'System.Drawing.Color', 'Red');
    expect(result.dismissed).toBe(true);
    expect(sendRequest).toHaveBeenCalledWith(
      'EditSupportedUiTypeEditor', 'req.1', 'System.Drawing.Design.ColorEditor', 'System.Drawing.Color', 'Red');
  });
});
