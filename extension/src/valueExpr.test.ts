import { describe, expect, test } from 'vitest';
import { COMPLEX_TYPE_SET, shortName, toCSharpExpression } from './valueExpr';

describe('toCSharpExpression', () => {
  test.each([
    ['System.Boolean', false, ' TRUE ', 'true'],
    ['System.Int32', false, '-42', '-42'],
    ['System.UInt64', false, '42', '42'],
    ['System.Single', false, '1.5', '1.5f'],
    ['System.Decimal', false, '-2.25', '-2.25m'],
    ['System.String', false, 'a"b\n', '"a\\\"b\\n"'],
    ['System.Char', false, "'", "'\\\''"],
    ['System.Windows.Forms.AnchorStyles', true, 'Top, Left',
      'System.Windows.Forms.AnchorStyles.Top | System.Windows.Forms.AnchorStyles.Left'],
  ] as const)('converts %s value %s', (type, isEnum, raw, expected) => {
    expect(toCSharpExpression(type, isEnum, raw)).toBe(expected);
  });

  test.each([
    ['System.Boolean', false, 'maybe'],
    ['System.UInt32', false, '-1'],
    ['System.Int32', false, '1.5'],
    ['System.Windows.Forms.AnchorStyles', true, 'Top, x; Evil()'],
    ['System.Object', false, 'anything'],
  ] as const)('rejects invalid %s value', (type, isEnum, raw) => {
    expect(toCSharpExpression(type, isEnum, raw)).toBeNull();
  });
});

describe('value-expression helpers', () => {
  test('tracks the complex engine-converted types', () => {
    expect(COMPLEX_TYPE_SET.has('System.Drawing.Color')).toBe(true);
    expect(COMPLEX_TYPE_SET.has('System.Drawing.Font')).toBe(true);
    expect(COMPLEX_TYPE_SET.has('System.String')).toBe(false);
  });

  test('returns the last dotted type segment', () => {
    expect(shortName('System.Drawing.Color')).toBe('Color');
    expect(shortName('Color')).toBe('Color');
  });
});
