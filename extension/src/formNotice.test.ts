// 1.0.0 — #formNotice kind precedence after the net48 divergence lock was descoped.
// The net48 "compiled preview" disclosure is UNCONDITIONAL and editable (ℹ️); the only genuine read-only lock is
// `localizable` (🔒); binaryResx / inheritedBase are modern-engine ⚠️ disclosures.

import { describe, it, expect } from 'vitest';
import { chooseFormNoticeKind } from './formNotice';

describe('chooseFormNoticeKind', () => {
  it('a clean modern render shows nothing', () => {
    expect(chooseFormNoticeKind(false, false, false, false)).toBeNull();
  });

  it('net48 always discloses the compiled preview (editable, not a lock)', () => {
    expect(chooseFormNoticeKind(false, false, false, true)).toBe('compiledPreview');
  });

  it('the localizable read-only lock outranks the net48 disclosure', () => {
    expect(chooseFormNoticeKind(true, false, false, true)).toBe('localizable');
  });

  it('the net48 disclosure outranks the modern ⚠️ disclosures (which net48 never raises anyway)', () => {
    expect(chooseFormNoticeKind(false, false, true, true)).toBe('compiledPreview');
    expect(chooseFormNoticeKind(false, true, false, true)).toBe('compiledPreview');
  });

  it('modern disclosures: binaryResx outranks inheritedBase; both are non-lock', () => {
    expect(chooseFormNoticeKind(false, false, true, false)).toBe('binaryResx');
    expect(chooseFormNoticeKind(false, true, false, false)).toBe('inheritedBase');
  });

  it('localizable + inherited keeps its combined 🔒 kind', () => {
    expect(chooseFormNoticeKind(true, true, false, false)).toBe('localizableInherited');
  });

  it('pre-existing 2/3-arg call sites are unchanged by the new 4th param defaulting false', () => {
    expect(chooseFormNoticeKind(false, false)).toBeNull();
    expect(chooseFormNoticeKind(false, true)).toBe('inheritedBase');
    expect(chooseFormNoticeKind(false, false, true)).toBe('binaryResx');
  });
});
