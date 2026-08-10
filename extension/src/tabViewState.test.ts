import { describe, expect, test } from 'vitest';
import { sanitizeSelectedTabs, selectedTabsFromEntries } from './tabViewState';

describe('tab view-state', () => {
  test('keeps bounded valid host/page pairs and rejects protocol-breaking data', () => {
    const state = sanitizeSelectedTabs({
      tabControl1: 'tabPage2',
      'bad=host': 'tabPage1',
      tabControl2: 'bad\npage',
      constructor: 'tabPage3',
      numeric: 42,
    });
    expect(state).toEqual({ tabControl1: 'tabPage2' });
  });

  test('caps persisted selections at 128 entries', () => {
    const input = Object.fromEntries(Array.from({ length: 160 }, (_, i) => [`host${i}`, `page${i}`]));
    expect(Object.keys(sanitizeSelectedTabs(input) ?? {})).toHaveLength(128);
  });

  test('serializes a session map through the same sanitizer', () => {
    expect(selectedTabsFromEntries(new Map([['tabs', 'page2']]))).toEqual({ tabs: 'page2' });
  });
});
