/** Data-only canvas bindings. These values never authorize execution or carry an edit proposal. */
export const ADAPTER_ACTION_COMMAND = 'winformsDesigner.invokeAdapterAction' as const;

export interface AdapterActionBinding {
  readonly documentUri: string;
  readonly revision: number;
  readonly componentId: string;
}

export interface PublishedAdapterAction {
  readonly id: string;
  readonly title: string;
  readonly disabledReasonCode?: string;
  readonly commandId: typeof ADAPTER_ACTION_COMMAND;
  readonly keyboardCommandId: typeof ADAPTER_ACTION_COMMAND;
}

export interface AdapterActionPublication extends AdapterActionBinding {
  readonly type: 'adapterActions';
  readonly publicationId: string;
  readonly actions: readonly PublishedAdapterAction[];
}

const identity = /^[a-z][a-z0-9.-]{2,95}$/;
const symbol = /^(?:this|[A-Za-z_][A-Za-z0-9_]{0,127})$/;
const publicationId = /^[A-Za-z0-9_-]{1,128}$/;
const stableCode = /^[A-Z][A-Z0-9_]{2,95}$/;
const controls = /[\x00-\x1f\x7f]/;
const hasOwn = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

function record(value: unknown, keys: readonly string[], required: readonly string[] = keys): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => keys.includes(key))
    && required.every(key => hasOwn(value, key));
}

function binding(value: AdapterActionBinding): boolean {
  return typeof value.documentUri === 'string' && value.documentUri.startsWith('file:')
    && value.documentUri.length <= 8192 && !controls.test(value.documentUri)
    && Number.isSafeInteger(value.revision) && value.revision >= 0
    && typeof value.componentId === 'string' && symbol.test(value.componentId);
}

/** Reject unknown keys and stale bindings; return detached metadata so a caller cannot mutate a stored publication. */
export function validateAdapterActionPublication(value: unknown, current: AdapterActionBinding): AdapterActionPublication | undefined {
  if (!binding(current) || !record(value, ['type', 'documentUri', 'revision', 'componentId', 'publicationId', 'actions'])
    || value.type !== 'adapterActions' || value.documentUri !== current.documentUri
    || value.revision !== current.revision || value.componentId !== current.componentId
    || typeof value.publicationId !== 'string' || !publicationId.test(value.publicationId)
    || !Array.isArray(value.actions) || value.actions.length > 32) return undefined;
  const ids = new Set<string>();
  const actions: PublishedAdapterAction[] = [];
  for (const action of value.actions) {
    if (!record(action, ['id', 'title', 'disabledReasonCode', 'commandId', 'keyboardCommandId'],
      ['id', 'title', 'commandId', 'keyboardCommandId'])
      || typeof action.id !== 'string' || !identity.test(action.id) || ids.has(action.id)
      || typeof action.title !== 'string' || action.title.length < 1 || action.title.length > 120 || controls.test(action.title)
      || action.commandId !== ADAPTER_ACTION_COMMAND || action.keyboardCommandId !== ADAPTER_ACTION_COMMAND
      || (hasOwn(action, 'disabledReasonCode') && (typeof action.disabledReasonCode !== 'string'
        || !stableCode.test(action.disabledReasonCode)))) return undefined;
    ids.add(action.id);
    const disabledReasonCode = typeof action.disabledReasonCode === 'string' ? action.disabledReasonCode : undefined;
    actions.push(Object.freeze({ id: action.id, title: action.title,
      ...(disabledReasonCode === undefined ? {} : { disabledReasonCode }),
      commandId: ADAPTER_ACTION_COMMAND, keyboardCommandId: ADAPTER_ACTION_COMMAND }));
  }
  return Object.freeze({ type: 'adapterActions', documentUri: current.documentUri, revision: current.revision,
    componentId: current.componentId, publicationId: value.publicationId, actions: Object.freeze(actions) });
}

/** Resolve only a current enabled published identity. The host must independently recheck its package grant and metadata. */
export function resolveAdapterActionIntent(value: unknown, publication: AdapterActionPublication,
  current: AdapterActionBinding): PublishedAdapterAction | undefined {
  const checked = validateAdapterActionPublication(publication, current);
  if (!checked || !record(value,
    ['type', 'publicationId', 'componentId', 'contributionId', 'operationId', 'requestAttemptId', 'gen'],
    ['type', 'publicationId', 'componentId', 'contributionId'])
    || value.type !== 'adapterAction' || value.publicationId !== checked.publicationId
    || value.componentId !== checked.componentId || typeof value.contributionId !== 'string'
    || !identity.test(value.contributionId)
    || (hasOwn(value, 'gen') && (!Number.isSafeInteger(value.gen) || (value.gen as number) < 0))) return undefined;
  for (const key of ['operationId', 'requestAttemptId']) {
    if (hasOwn(value, key) && (typeof value[key] !== 'string' || value[key].length < 1
      || value[key].length > 256 || !/^[A-Za-z0-9_-]+$/.test(value[key]))) return undefined;
  }
  return checked.actions.find(action => action.id === value.contributionId && !action.disabledReasonCode);
}
