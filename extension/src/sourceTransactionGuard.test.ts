import { describe, expect, it } from 'vitest';
import { SourceTransactionGuard } from './sourceTransactionGuard';

describe('owned generated-source transaction images', () => {
  it('owns both replay and compensation until document/cursor adoption finishes', () => {
    const guard = new SourceTransactionGuard();
    const release = guard.begin([{ text: 'before', bom: false }, { text: 'after', bom: false }]);
    const read = guard.beginRead(0);
    expect(guard.isCurrent(read, 0)).toBe(true);
    expect(guard.owns({ text: 'after', bom: false })).toBe(true);
    expect(guard.owns({ text: 'before', bom: false })).toBe(true);
    expect(guard.owns({ text: 'external edit', bom: false })).toBe(false);
    release();
    expect(guard.isCurrent(read, 0)).toBe(false);
    expect(guard.owns({ text: 'after', bom: false })).toBe(false);
  });

  it('invalidates an older read when replay starts and a transient read when replay ends', () => {
    const guard = new SourceTransactionGuard();
    const beforeReplay = guard.beginRead(4);
    const release = guard.begin([{ text: 'after', bom: false }]);
    expect(guard.isCurrent(beforeReplay, 4)).toBe(false);
    const duringReplay = guard.beginRead(4);
    release();
    expect(guard.isCurrent(duringReplay, 4)).toBe(false);
    expect(guard.isCurrent(guard.beginRead(5), 5)).toBe(true);
  });

  it('refuses a read after a document revision moved even if the source returned to identical bytes', () => {
    const guard = new SourceTransactionGuard();
    const read = guard.beginRead(8);
    expect(guard.isLatest(read)).toBe(true);
    expect(guard.isCurrent(read, 10)).toBe(false);
  });

  it('never exempts a changed BOM or another byte image', () => {
    const guard = new SourceTransactionGuard(); guard.begin([{ text: 'after\r\n', bom: true }]);
    expect(guard.owns({ text: 'after\r\n', bom: false })).toBe(false);
    expect(guard.owns({ text: 'after\n', bom: true })).toBe(false);
    expect(guard.owns({ text: 'after\r\n', bom: true })).toBe(true);
  });

  it('owns a known absent source during compensation without granting other read errors', () => {
    const guard = new SourceTransactionGuard();
    const release = guard.begin([{ text: null, bom: false }, { text: 'new source', bom: true }]);
    expect(guard.owns({ text: null, bom: false })).toBe(true);
    expect(guard.owns({ text: 'external', bom: true })).toBe(false);
    release();
    expect(guard.owns({ text: null, bom: false })).toBe(false);
  });

  it('releases only its own scope and tolerates repeated cleanup', () => {
    const guard = new SourceTransactionGuard();
    const first = guard.begin([{ text: 'one', bom: false }]);
    const second = guard.begin([{ text: 'two', bom: false }]);
    first(); first();
    expect(guard.owns({ text: 'one', bom: false })).toBe(false);
    expect(guard.owns({ text: 'two', bom: false })).toBe(true);
    const olderRead = guard.beginRead(1); const latestRead = guard.beginRead(1);
    expect(guard.isLatest(olderRead)).toBe(false);
    expect(guard.isCurrent(latestRead, 1)).toBe(true);
    second();
    expect(guard.isLatest(latestRead)).toBe(false);
  });
});
