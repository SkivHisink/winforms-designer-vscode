import { serveAdapter, responseFor, type AdapterPackage, type AdapterHandler, type PropertyType } from '../index.mjs';

const kind: PropertyType = 'System.Int32';
// @ts-expect-error SDK 0.1 does not expose arbitrary object values.
const unsupported: PropertyType = 'System.Object';
const invoke: AdapterHandler = request => responseFor(request, { status: 'ok', intent: {
  kind: 'setProperty', componentId: request.context.componentId, propertyName: request.context.propertyName,
  propertyType: kind, invariantValue: '42',
} });
void serveAdapter(invoke);
// @ts-expect-error Local development cannot claim vendor certification.
const provenance: AdapterPackage['provenance'] = { policy: 'signed-vendor', certification: 'certified' };
void unsupported; void provenance;
