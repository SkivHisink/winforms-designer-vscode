import * as path from 'node:path';

export interface ControlSourceStatusSession {
  designerFilePath: string | null;
  isCompiledPreview: boolean;
  controlAssembly?: string;
}

export interface ControlSourceStatusItem {
  text: string;
  tooltip?: unknown;
  show(): void;
  hide(): void;
}

/** Status reads only the active session's selected output. It never starts a worker or performs another resolution. */
export function refreshControlSourceStatus(
  item: ControlSourceStatusItem | undefined,
  session: ControlSourceStatusSession | undefined,
  override: (file: string) => string | undefined,
  translate: (key: string, params?: Record<string, unknown>) => string,
): void {
  if (!item) return;
  const file = session?.designerFilePath;
  if (!file) { item.hide(); return; }
  const preview = session.isCompiledPreview ? translate('host.statusbar.previewBadge') : '';
  const previewTip = session.isCompiledPreview ? '\n' + translate('host.statusbar.tip.previewNote') : '';
  const explicit = override(file);
  const selected = explicit ?? session.controlAssembly;
  const name = selected ? path.basename(selected) + (explicit ? '' : translate('host.statusbar.autoSuffix'))
    : translate('host.statusbar.auto');
  item.text = translate('host.statusbar.controls', { name }) + preview;
  item.tooltip = (explicit ? translate('host.statusbar.tip.explicit', { path: explicit })
    : selected ? translate('host.statusbar.tip.autoResolved', { path: selected }) : translate('host.statusbar.tip.auto'))
    + previewTip + '\n' + translate(explicit ? 'host.statusbar.tip.clickChange' : 'host.statusbar.tip.clickOverride');
  item.show();
}
