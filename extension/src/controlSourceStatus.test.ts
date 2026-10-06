import { expect, it, vi } from 'vitest';
import { ControlSourceStatusItem, refreshControlSourceStatus } from './controlSourceStatus';

const translate = (key: string, params?: Record<string, unknown>): string => `${key}${params ? JSON.stringify(params) : ''}`;
const status = (): ControlSourceStatusItem => ({ text: '', tooltip: undefined, show: vi.fn(), hide: vi.fn() });

it('uses cached selected output and preserves explicit precedence and preview disclosure without RPC work', () => {
  const item = status();
  const getEngine = vi.fn(() => { throw new Error('status must not start an engine'); });
  const resolveAssembly = vi.fn(() => { throw new Error('status must not resolve an output'); });
  const session = { designerFilePath: 'Form.Designer.cs', isCompiledPreview: true, controlAssembly: undefined as string | undefined,
    getEngine, resolveAssembly };
  const override = vi.fn(() => undefined as string | undefined);
  refreshControlSourceStatus(item, session, override, translate);
  expect(item.text).toContain('host.statusbar.auto');
  expect(item.tooltip).toContain('host.statusbar.tip.previewNote');
  session.controlAssembly = 'Selected.dll';
  refreshControlSourceStatus(item, session, override, translate);
  expect(item.text).toContain('Selected.dllhost.statusbar.autoSuffix');
  expect(item.text).toContain('host.statusbar.previewBadge');
  expect(item.tooltip).toContain('host.statusbar.tip.autoResolved');
  override.mockReturnValue('Explicit.dll');
  refreshControlSourceStatus(item, session, override, translate);
  expect(item.text).toContain('Explicit.dll'); expect(item.text).not.toContain('autoSuffix');
  expect(item.tooltip).toContain('host.statusbar.tip.explicit');
  expect(item.tooltip).toContain('host.statusbar.tip.previewNote');
  expect(item.tooltip).toContain('host.statusbar.tip.clickChange');
  expect(getEngine).not.toHaveBeenCalled(); expect(resolveAssembly).not.toHaveBeenCalled();
});

it('shows only the currently active session and hides the badge when no designer is active', () => {
  const item = status();
  refreshControlSourceStatus(item, { designerFilePath: 'Old.Designer.cs', isCompiledPreview: false, controlAssembly: 'Old.dll' },
    () => undefined, translate);
  expect(item.text).toContain('Old.dll');
  refreshControlSourceStatus(item, { designerFilePath: 'New.Designer.cs', isCompiledPreview: false }, () => undefined, translate);
  expect(item.text).toContain('host.statusbar.auto'); expect(item.text).not.toContain('Old.dll');
  expect(item.tooltip).not.toContain('Old.dll');
  refreshControlSourceStatus(item, undefined, () => { throw new Error('inactive badge must not read an override'); }, translate);
  expect(item.hide).toHaveBeenCalledOnce();
});
