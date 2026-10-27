import { responseFor, serveAdapter } from './sdk.mjs';

// The author returns one typed proposal. The host owns source conversion, validation, commit, and Undo.
await serveAdapter(request => {
  if (request.operation !== 'invokeAction' || request.contributionId !== 'sample.set-caption')
    return responseFor(request, { status: 'refused', code: 'ADAPTER_SAMPLE_CONTRIBUTION_UNKNOWN' });
  if (request.input.cancel) return responseFor(request, { status: 'cancelled' });
  if (request.input.invariantValue === 'REFUSE')
    return responseFor(request, { status: 'refused', code: 'ADAPTER_SAMPLE_REFUSED' });
  return responseFor(request, { status: 'ok', intent: {
    kind: 'setProperty', componentId: request.context.componentId, propertyName: 'Text', propertyType: 'System.String',
    invariantValue: request.input.invariantValue ?? 'SDK action caption',
  } });
});
