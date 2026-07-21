// 0.10.0 / 1.0.0 — which persistent #formNotice banner to show for the current render.
//
// #formNotice is SINGLE-SLOT (one icon + one message, last-post-wins). A form can be several conditions at once:
// localizable (read-only lock, S1), binary/ImageStream resx resources the preview can't render (S3), inherited base
// whose controls the modern engine drops (S2), and — 1.0.0 — the .NET Framework compiled preview (net48Preview), which
// always renders the last BUILD rather than the live source. This returns the DOMINANT icon-kind by precedence; the
// host composes the message text from EVERY true condition so a single-slot banner never HIDES a lower-precedence
// disclosure.
//
// Precedence: localizable (the one genuinely read-only lock — 🔒) > net48Preview (ℹ️ unconditional "last build"
// disclosure on an editable form) > binaryResx (⚠️) > inheritedBase (⚠️). The modern-only flags (inheritedNet9,
// binaryResx) must ALREADY be gated to the modern engine by the caller; net48Preview is net48-only. Every non-null
// outcome is non-silent.
//
// Pure (no vscode / no i18n) so the precedence is unit-testable in isolation.

export type FormNoticeKind =
  | 'localizable' | 'inheritedBase' | 'localizableInherited' | 'binaryResx' | 'compiledPreview' | null;

export function chooseFormNoticeKind(
  localizable: boolean, inheritedNet9: boolean, binaryResx = false, net48Preview = false): FormNoticeKind {
  if (localizable && inheritedNet9) return 'localizableInherited'; // 🔒 (+ any other clause appended by host)
  if (localizable) return 'localizable';                          // 🔒 the one read-only lock
  if (net48Preview) return 'compiledPreview';                     // ℹ️ 1.0.0 — editable, but the picture is the build
  if (binaryResx) return 'binaryResx';                            // ⚠️ data-loss risk > incomplete preview
  if (inheritedNet9) return 'inheritedBase';                      // ⚠️ incomplete preview
  return null;
}
