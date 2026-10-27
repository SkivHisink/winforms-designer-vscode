import { describe, expect, it } from 'vitest';
import { observedAdapterScalar } from './adapterPropertyContext';

describe('observed adapter scalar metadata', () => {
  it('preserves actual String metadata including the empty value', () => {
    expect(observedAdapterScalar('System.String', '')).toBe('');
    expect(observedAdapterScalar('System.String', 'caption \u0411')).toBe('caption \u0411');
  });
  it('keeps canonical Boolean SDK spelling without guessing failed getters', () => {
    expect(observedAdapterScalar('System.Boolean', 'True')).toBe('True');
    expect(observedAdapterScalar('System.Boolean', 'false')).toBe('False');
    for (const value of [null, undefined, '', 'unknown', ' False ', 0, false])
      expect(observedAdapterScalar('System.Boolean', value)).toBeUndefined();
  });
  it('requires an actual successful getter for every admitted property type', () => {
    for (const type of ['System.String', 'System.Boolean', 'System.Int32'] as const)
      for (const value of [null, undefined, { value: '' }]) expect(observedAdapterScalar(type, value)).toBeUndefined();
  });
  it('retains exact canonical Int32 boundaries and refuses lossy or out-of-range observations', () => {
    for (const value of ['0', '-1', '-2147483648', '2147483647']) expect(observedAdapterScalar('System.Int32', value)).toBe(value);
    for (const value of ['-0', '+1', '01', '1.0', ' 1', '2147483648', '-2147483649', 'NaN', '1e2'])
      expect(observedAdapterScalar('System.Int32', value)).toBeUndefined();
  });
});
