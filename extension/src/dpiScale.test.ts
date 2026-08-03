import { describe, expect, it } from 'vitest';
import { designerDpiScale, displayDprChanged } from './dpiScale';

describe('designerDpiScale', () => {
  it.each([
    [1, 1, 1],
    [1.25, 1.25, 2],
    [1.5, 1.5, 2],
    [1.75, 1.75, 2],
    [2, 2, 2],
  ])('keeps DPR %s and selects safe integer backing scale %s/%s', (input, expectedDpr, expectedScale) => {
    expect(designerDpiScale(input)).toEqual({ displayDpr: expectedDpr, captureScale: expectedScale });
  });

  it('clamps invalid and out-of-range values without rounding fractional DPR', () => {
    expect(designerDpiScale(Number.NaN)).toEqual({ displayDpr: 1, captureScale: 1 });
    expect(designerDpiScale(0.5)).toEqual({ displayDpr: 1, captureScale: 1 });
    expect(designerDpiScale(3)).toEqual({ displayDpr: 2, captureScale: 2 });
    expect(designerDpiScale(1.333)).toEqual({ displayDpr: 1.333, captureScale: 2 });
  });

  it('detects Windows fractional and monitor changes but ignores floating noise', () => {
    expect(displayDprChanged(1, 1.25)).toBe(true);
    expect(displayDprChanged(1.25, 1.5)).toBe(true);
    expect(displayDprChanged(1.5, 1.75)).toBe(true);
    expect(displayDprChanged(1.75, 2)).toBe(true);
    expect(displayDprChanged(1.5, 1.50001)).toBe(false);
  });
});
