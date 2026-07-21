import { describe, expect, test, vi } from 'vitest';
import { newPipeName } from './engineClient';

describe('newPipeName', () => {
  test('is unique across many rapid calls in the same millisecond', () => {
    // Pin the regression directly: the old name was `winforms-designer-${process.pid}-${Date.now()}`, so with the
    // clock frozen (as it effectively is when two engine kinds start in the same tick) every call collided.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      const before = Date.now();
      const names = Array.from({ length: 1_000 }, () => newPipeName());
      expect(Date.now()).toBe(before); // clock really did not advance across the batch
      expect(new Set(names).size).toBe(names.length);
    } finally {
      vi.useRealTimers();
    }
  });

  test('keeps the diagnosable prefix and stays a legal Windows pipe name', () => {
    const name = newPipeName();
    expect(name.startsWith('winforms-designer-')).toBe(true);
    // \\.\pipe\<name>: any char but a backslash, and the whole path caps at 256 chars.
    expect(name).not.toContain('\\');
    expect(('\\\\.\\pipe\\' + name).length).toBeLessThanOrEqual(256);
  });
});
