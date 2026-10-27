import { responseFor, serveAdapter } from './sdk.mjs';

const choices = ['SDK editor caption', 'Alternate caption', 'Original caption'];
await serveAdapter(request => {
  if (request.operation !== 'editProperty' || request.contributionId !== 'sample.caption-editor')
    return responseFor(request, { status: 'refused', code: 'ADAPTER_SAMPLE_CONTRIBUTION_UNKNOWN' });
  if (request.input.cancel) return responseFor(request, { status: 'cancelled' });
  const selected = request.input.invariantValue;
  if (!choices.includes(selected)) return responseFor(request, { status: 'refused', code: 'ADAPTER_SAMPLE_CHOICE_INVALID' });
  return responseFor(request, { status: 'ok', intent: {
    kind: 'setProperty', componentId: request.context.componentId, propertyName: 'Text', propertyType: 'System.String',
    invariantValue: selected,
  } });
});
