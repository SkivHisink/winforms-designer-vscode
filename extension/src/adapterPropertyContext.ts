import type { PropertyType } from '../../adapter-sdk/index.mjs';

/** A missing or failed getter cannot establish an adapter's current invariant value. */
export function observedAdapterScalar(type: PropertyType, value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (type === 'System.String') return value;
  if (type === 'System.Boolean') return /^(?:true|false)$/i.test(value)
    ? (value.toLowerCase() === 'true' ? 'True' : 'False') : undefined;
  if (!/^(?:0|-?[1-9]\d*)$/.test(value)) return undefined;
  const number = Number(value);
  return Number.isInteger(number) && number >= -2147483648 && number <= 2147483647 ? value : undefined;
}
