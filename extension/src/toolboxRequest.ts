export type ToolboxRequestClassification =
  | { status: 'allowed'; scope: 'net' }
  | {
    status: 'refused';
    reasonCode: 'COM_ACTIVE_X_UNSUPPORTED' | 'WPF_TOOLBOX_UNSUPPORTED' | 'TOOLBOX_SCOPE_INVALID';
    message: string;
    actions: readonly ['viewCode'];
  };

/** Shared boundary for toolbox commands and webview requests. Never coerce an untrusted scope value. */
export function classifyToolboxRequest(scope: unknown): ToolboxRequestClassification {
  if (scope === 'net') return { status: 'allowed', scope: 'net' };
  if (scope === 'com') {
    return {
      status: 'refused', reasonCode: 'COM_ACTIVE_X_UNSUPPORTED',
      message: 'COM and ActiveX controls are not supported by this toolbox. Open the form source to inspect existing controls.',
      actions: ['viewCode'],
    };
  }
  if (scope === 'wpf') {
    return {
      status: 'refused', reasonCode: 'WPF_TOOLBOX_UNSUPPORTED',
      message: 'WPF controls are not supported by this Windows Forms toolbox. Open the form source to inspect existing controls.',
      actions: ['viewCode'],
    };
  }
  return {
    status: 'refused', reasonCode: 'TOOLBOX_SCOPE_INVALID',
    message: 'The toolbox request has an invalid scope. Choose the .NET tab for supported Windows Forms controls.',
    actions: ['viewCode'],
  };
}
