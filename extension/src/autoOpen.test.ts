import { describe, expect, test } from 'vitest';
import { shouldSuppressAutoOpen } from './autoOpen';

const FORM = 'file:///c%3A/proj/Form1.cs';
const GIT_FORM = 'git:/c%3A/proj/Form1.cs?%7B%22path%22%3A%22Form1.cs%22%7D';
const OTHER = 'file:///c%3A/proj/Other.cs';

describe('shouldSuppressAutoOpen', () => {
  test('an ordinary file editor still auto-opens the designer', () => {
    expect(shouldSuppressAutoOpen({ scheme: 'file', uri: FORM, comparisonUris: [] })).toBe(false);
  });

  test('the MODIFIED side of a diff is a plain file URI and must be recognized from the tab', () => {
    expect(shouldSuppressAutoOpen({ scheme: 'file', uri: FORM, comparisonUris: [GIT_FORM, FORM] })).toBe(true);
  });

  test('the ORIGINAL side of a diff is caught by its non-file scheme', () => {
    expect(shouldSuppressAutoOpen({ scheme: 'git', uri: GIT_FORM, comparisonUris: [GIT_FORM, FORM] })).toBe(true);
  });

  // The predicate is comparison-kind agnostic: whatever the caller enumerates is off limits. Today that is diffs
  // only (TabInputTextMerge is absent from the 1.84 API floor), so this pins the contract for when it is not.
  test('any enumerated comparison URI is off limits, whatever kind of comparison produced it', () => {
    const merge = ['file:///c%3A/proj/base.cs', 'git:/c%3A/proj/ours.cs', 'git:/c%3A/proj/theirs.cs', FORM];
    expect(shouldSuppressAutoOpen({ scheme: 'file', uri: FORM, comparisonUris: merge })).toBe(true);
  });

  test('a comparison of a DIFFERENT file does not suppress auto-open for this one', () => {
    expect(shouldSuppressAutoOpen({
      scheme: 'file',
      uri: FORM,
      comparisonUris: ['git:/c%3A/proj/Other.cs', OTHER],
    })).toBe(false);
  });

  test('comparisons from several groups are all considered', () => {
    expect(shouldSuppressAutoOpen({
      scheme: 'file',
      uri: FORM,
      comparisonUris: ['git:/c%3A/proj/Other.cs', OTHER, GIT_FORM, FORM],
    })).toBe(true);
  });

  test.each(['untitled', 'output', 'vscode-userdata', 'gitlens', 'conflictResolution'])(
    'the virtual scheme %s never auto-opens',
    (scheme) => {
      expect(shouldSuppressAutoOpen({ scheme, uri: `${scheme}:/Form1.cs`, comparisonUris: [] })).toBe(true);
    },
  );

  test('URI comparison is exact — a sibling whose path merely extends the diffed one is unaffected', () => {
    expect(shouldSuppressAutoOpen({
      scheme: 'file',
      uri: 'file:///c%3A/proj/Form1.Designer.cs',
      comparisonUris: [GIT_FORM, FORM],
    })).toBe(false);
  });
});
