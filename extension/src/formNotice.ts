// 0.10.0 trust-floor — which persistent #formNotice banner to show for the current render.
//
// #formNotice is SINGLE-SLOT (one icon + one message, last-post-wins). A form can be several conditions at once:
// localizable (read-only lock, S1), binary/ImageStream resx resources the preview can't render (S3), inherited base
// whose controls net9 drops (S2). This returns the DOMINANT icon-kind by precedence; the host composes the message
// text from EVERY true condition so a single-slot banner never HIDES a lower-precedence disclosure (codex R#12).
//
// Precedence: localizable (hard read-only lock — subsumes the binaryResx write-refusal) > binaryResx (data-loss risk)
// > inheritedBase (merely-incomplete preview). localizable+inherited keeps its own kind for the 🔒 icon; binaryResx
// and inheritedBase both use ⚠️. Every non-null outcome is fail-closed / non-silent.
//
// Pure (no vscode / no i18n) so the precedence is unit-testable in isolation. `inheritedNet9` and `binaryResx` must
// ALREADY be gated to the net9 engine by the caller — net48 renders the real compiled type (base controls + resx
// resources present) and flags neither.

export type FormNoticeKind = 'localizable' | 'inheritedBase' | 'localizableInherited' | 'binaryResx' | null;

export function chooseFormNoticeKind(
  localizable: boolean, inheritedNet9: boolean, binaryResx = false): FormNoticeKind {
  if (localizable && inheritedNet9) return 'localizableInherited'; // 🔒 (+ any binaryResx clause appended by host)
  if (localizable) return 'localizable';                          // 🔒 lock subsumes the binaryResx refusal
  if (binaryResx) return 'binaryResx';                            // ⚠️ data-loss risk > incomplete preview
  if (inheritedNet9) return 'inheritedBase';                      // ⚠️ incomplete preview
  return null;
}
