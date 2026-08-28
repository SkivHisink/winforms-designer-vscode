import type { ComponentDesc, PropertyDesc } from './engineClient';

const MAX_MULTI_PROPERTY_TARGETS = 128;

/** Normalize the untrusted canvas selection against the current rendered control ids. The primary id is always the
 * final member (matching the canvas contract) and an invalid/oversized selection collapses to the primary only. */
export function normalizeMultiSelection(primaryId: string, requestedIds: unknown, renderedIds: Iterable<string>): string[] {
  if (!Array.isArray(requestedIds)) return [primaryId];
  const allowed = new Set(renderedIds);
  if (!allowed.has(primaryId) || requestedIds.length < 1 || requestedIds.length > MAX_MULTI_PROPERTY_TARGETS) return [primaryId];

  const seen = new Set<string>();
  const ids: string[] = [];
  for (const value of requestedIds) {
    // The canvas contract emits a closed, unique set containing its primary. Treat any malformed member as a stale or
    // forged snapshot and collapse the grid to the primary; silently dropping it could widen a different subset into
    // a valid-looking multi-object transaction.
    if (typeof value !== 'string' || !allowed.has(value) || seen.has(value)) return [primaryId];
    seen.add(value);
    if (value !== primaryId) ids.push(value);
  }
  if (!seen.has(primaryId)) return [primaryId];
  ids.push(primaryId);
  return ids.length >= 2 ? ids : [primaryId];
}

function batchScalarProperty(property: PropertyDesc): boolean {
  const builtInEditorScalar = property.type === 'System.Drawing.Color'
    || property.type === 'System.Drawing.Font';
  return !property.readOnly
    && !property.designTime
    && !property.tableCell
    && !property.isImage
    && !property.isCollection
    && !property.isDataSource
    && !property.extenderProvider
    && !property.extenderProperty
    && !property.referenceValues
    // Color and Font have built-in grid affordances plus a modal editor, but their invariant values still route
    // losslessly through the same scalar batch adapter. Excluding every uiTypeEditor property made exactly these
    // canonical VS multi-selection rows disappear. Certified vendor/modal editor types remain single-target only.
    && (!property.uiTypeEditor || builtInEditorScalar);
}

function sameTypeShape(left: PropertyDesc, right: PropertyDesc): boolean {
  return left.type === right.type && !!left.isEnum === !!right.isEnum;
}

function sharedStandardValues(properties: PropertyDesc[]): { values?: string[] | null; exclusive?: boolean } | null {
  const lists = properties.map((property) => property.standardValues);
  const hasList = lists.map((list) => Array.isArray(list));
  if (hasList.some(Boolean) && !hasList.every(Boolean)) return null;
  if (!hasList.some(Boolean)) return {
    values: null,
    exclusive: properties.every((property) => !!property.standardValuesExclusive),
  };

  const rest = lists.slice(1).map((list) => new Set(list as string[]));
  const values = (lists[0] as string[]).filter((value) => rest.every((set) => set.has(value)));
  const exclusive = properties.every((property) => !!property.standardValuesExclusive);
  if (exclusive && values.length === 0) return null;
  return { values, exclusive };
}

function valuesEqual(left: string | null, right: string | null): boolean {
  return left === right;
}

/** Build the VS-style shared property view for a multi-selection. Only browsable properties emitted by every engine
 * description, writable on every target, exact-type compatible, and representable by the scalar batch adapter remain.
 * Special structural/resource/reference/modal editors keep their dedicated single-target transactions and therefore
 * do not masquerade as atomic multi-object rows. */
export function intersectMultiProperties(components: ComponentDesc[], primaryId: string): ComponentDesc | null {
  if (components.length < 2 || components.some((component) => component.editable === false)) return null;
  const primary = components.find((component) => component.id === primaryId);
  if (!primary) return null;

  const properties: PropertyDesc[] = [];
  for (const firstProperty of primary.properties) {
    if (!batchScalarProperty(firstProperty)) continue;
    const matches: PropertyDesc[] = [firstProperty];
    let compatible = true;
    for (const component of components) {
      if (component === primary) continue;
      const match = component.properties.find((property) => property.name === firstProperty.name);
      if (!match || !batchScalarProperty(match) || !sameTypeShape(firstProperty, match)) {
        compatible = false;
        break;
      }
      matches.push(match);
    }
    if (!compatible) continue;

    const standard = sharedStandardValues(matches);
    if (!standard) continue;
    const mixed = matches.some((property) => !valuesEqual(property.value, firstProperty.value));
    const defaultStates = matches.map((property) => property.isDefault);
    const commonDefault = defaultStates.every((value) => value === defaultStates[0]) ? defaultStates[0] : null;

    properties.push({
      ...firstProperty,
      value: mixed ? null : firstProperty.value,
      isDefault: commonDefault,
      sourceExplicit: matches.some((property) => !!property.sourceExplicit),
      readOnly: false,
      standardValues: standard.values,
      standardValuesExclusive: standard.exclusive,
      properties: mixed ? null : firstProperty.properties,
      propertiesTruncated: mixed ? false : firstProperty.propertiesTruncated,
      uiTypeEditor: null,
      mixed,
      multi: true,
      // A target already at its default is a representable no-op. The source adapter performs the definitive
      // comment/directive/ownership preflight before returning any batch text.
      multiResettable: matches.some((property) => !!property.sourceExplicit),
    });
  }

  return {
    id: primary.id,
    name: primary.name,
    type: primary.type,
    parent: null,
    isRoot: false,
    ownership: 'currentSource',
    editable: true,
    readOnlyReason: null,
    properties,
    events: [],
    multiCount: components.length,
  };
}
