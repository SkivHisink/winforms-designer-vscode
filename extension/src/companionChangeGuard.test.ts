import { describe, expect, it } from 'vitest';
import { CompanionChangeGuard } from './companionChangeGuard';

describe('owned companion change notifications', () => {
  it('defers only the exact awaited edit notification once', () => {
    const guard = new CompanionChangeGuard();
    const end = guard.begin('Form.cs', 3, 'with generated handler');
    expect(guard.isOwnChange('Form.cs', 4, 'with generated handler')).toBe(true);
    expect(guard.isOwnChange('Form.cs', 4, 'with generated handler')).toBe(false);
    end();
    expect(guard.isOwnChange('Form.cs', 4, 'with generated handler')).toBe(false);
  });

  it('never suppresses another document or an unowned notification', () => {
    const guard = new CompanionChangeGuard(); guard.begin('Form.cs', 3, 'after');
    expect(guard.isOwnChange('Other.cs', 4, 'after')).toBe(false);
    expect(guard.isOwnChange('Form.cs', 4, 'after')).toBe(true);
  });

  it('invalidates the exemption after an interleaved manual image', () => {
    const guard = new CompanionChangeGuard(); guard.begin('Form.cs', 3, 'after');
    expect(guard.isOwnChange('Form.cs', 4, 'manual edit')).toBe(false);
    expect(guard.isOwnChange('Form.cs', 4, 'after')).toBe(false);
  });

  it('invalidates the exemption after a different document version even with equal bytes', () => {
    const guard = new CompanionChangeGuard(); guard.begin('Form.cs', 3, 'after');
    expect(guard.isOwnChange('Form.cs', 5, 'after')).toBe(false);
    expect(guard.isOwnChange('Form.cs', 4, 'after')).toBe(false);
  });

  it('rejects overlapping writes to the same document and releases failed transitions', () => {
    const guard = new CompanionChangeGuard(); const end = guard.begin('Form.cs', 3, 'after');
    expect(() => guard.begin('Form.cs', 3, 'other')).toThrow('already pending');
    end();
    expect(() => guard.begin('Form.cs', 3, 'other')).not.toThrow();
  });
});
