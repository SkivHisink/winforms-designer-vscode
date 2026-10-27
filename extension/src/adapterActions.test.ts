import { describe, expect, it } from 'vitest';
import { ADAPTER_ACTION_COMMAND, AdapterActionBinding, AdapterActionPublication,
  resolveAdapterActionIntent, validateAdapterActionPublication } from './adapterActions';

const current: AdapterActionBinding = { documentUri: 'file:///workspace/Form1.Designer.cs', revision: 3, componentId: 'button1' };
const action = { id: 'sdk.0123456789abcdef01234567', title: 'Apply caption', commandId: ADAPTER_ACTION_COMMAND,
  keyboardCommandId: ADAPTER_ACTION_COMMAND };
const publication = (): AdapterActionPublication => ({ type: 'adapterActions', ...current,
  publicationId: 'publication-123', actions: [{ ...action }] });
const intent = () => ({ type: 'adapterAction', publicationId: 'publication-123', componentId: 'button1', contributionId: action.id,
  operationId: 'webview-operation-123', requestAttemptId: 'webview-attempt-123', gen: 4 });

describe('data-only adapter canvas actions', () => {
  it('returns detached frozen metadata with the same public command for pointer and keyboard', () => {
    const source = publication();
    const result = validateAdapterActionPublication(source, current)!;
    expect(result).toEqual(source);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.actions)).toBe(true);
    expect(Object.isFrozen(result.actions[0])).toBe(true);
    (source.actions[0] as { title: string }).title = 'Changed afterwards';
    expect(result.actions[0].title).toBe('Apply caption');
    expect(resolveAdapterActionIntent(intent(), result, current)).toEqual(action);
  });

  it.each([
    { documentUri: 'file:///workspace/Other.Designer.cs' }, { revision: 4 }, { componentId: 'button2' },
    { revision: -1 }, { revision: Number.NaN }, { revision: Number.MAX_SAFE_INTEGER + 1 },
    { componentId: 'button1.Text' }, { documentUri: 'https://example.test/Form.cs' },
  ])('refuses a stale or invalid current binding %j', delta => {
    const changed = { ...current, ...delta };
    expect(validateAdapterActionPublication(publication(), changed)).toBeUndefined();
    expect(resolveAdapterActionIntent(intent(), publication(), changed)).toBeUndefined();
  });

  it.each([
    { commandId: 'workbench.action.files.save' }, { keyboardCommandId: 'other.command' }, { methodName: 'Run' },
    { value: 'replacement' }, { propertyName: 'Text' }, { packageUri: 'file:///untrusted/package.json' },
    { id: 'prototype.bad/value' }, { title: '<img>\n' }, { title: 'x'.repeat(121) }, { disabledReasonCode: '' },
  ])('refuses execution authority or malformed publication fields %j', extra => {
    const candidate = { ...publication(), actions: [{ ...action, ...extra }] };
    expect(validateAdapterActionPublication(candidate, current)).toBeUndefined();
  });

  it('accepts disabled metadata for display but never resolves an executable intent', () => {
    const source = { ...publication(), actions: [{ ...action, disabledReasonCode: 'ADAPTER_SERVICE_UNAVAILABLE' }] };
    const result = validateAdapterActionPublication(source, current)!;
    expect(result.actions[0].disabledReasonCode).toBe('ADAPTER_SERVICE_UNAVAILABLE');
    expect(resolveAdapterActionIntent(intent(), result, current)).toBeUndefined();
  });

  it('bounds and deduplicates contributions and rejects unknown publication fields', () => {
    expect(validateAdapterActionPublication({ ...publication(), actions: Array(33).fill(action) }, current)).toBeUndefined();
    expect(validateAdapterActionPublication({ ...publication(), actions: [action, action] }, current)).toBeUndefined();
    expect(validateAdapterActionPublication({ ...publication(), trusted: true }, current)).toBeUndefined();
    expect(validateAdapterActionPublication({ ...publication(), publicationId: 'x'.repeat(129) }, current)).toBeUndefined();
    expect(validateAdapterActionPublication({ ...publication(), actions: [] }, current)?.actions).toEqual([]);
  });

  it.each([
    { publicationId: 'other-publication' }, { componentId: 'button2' }, { contributionId: 'sdk.other' },
    { commandId: ADAPTER_ACTION_COMMAND }, { invariantValue: 'replacement' }, { sourceText: 'replacement' },
    { packageUri: 'file:///other/package.json' }, { gen: -1 }, { gen: 1.5 },
    { operationId: 'x'.repeat(257) }, { requestAttemptId: 'bad\nidentity' },
  ])('refuses forged, stale or payload-bearing invocation %j', extra => {
    expect(resolveAdapterActionIntent({ ...intent(), ...extra }, publication(), current)).toBeUndefined();
  });

  it('never interprets render-only adorner identities as actions', () => {
    expect(resolveAdapterActionIntent({ type: 'designerAdornerHit', componentId: 'button1', adornerId: action.id,
      publicationId: 'publication-123' }, publication(), current)).toBeUndefined();
    expect(resolveAdapterActionIntent({ ...intent(), type: 'designerActionCommand' }, publication(), current)).toBeUndefined();
  });
});
