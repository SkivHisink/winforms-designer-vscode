// 0.10.0 trust-floor S4 — the byte-LOCAL invariant for a persisted .Designer.cs edit.
//
// A form is saved by writing the in-memory designerText VERBATIM. Every interactive edit (net9 AND net48 — net48
// never writes source; it mutates the live compiled instance for preview and persists the SAME net9 splice) produces
// `after` = `before` with only a bounded set of changed line-hunks; a splice preserves the file outside the edited
// span BY CONSTRUCTION. This module is the fail-closed RUNTIME BACKSTOP in commit(): if `after` is NOT a confined edit
// of `before`, a non-splice path (a future refactor, a whole-file regenerate/reflow/EOL-normalize, or a recovered
// arbitrary buffer) reached the persist funnel — refuse it rather than corrupt the file.
//
// Pure (no vscode / no engine round-trip) so the predicate is unit-testable in isolation — the standalone-module model
// of localizable.ts. It is COARSE by design: the TIGHT per-statement confinement is already the engine's
// minimal/OnlyTargetChanged gate; this catches the gross catastrophe (whole-file replacement / normalize / reorder).

export interface EditDiff {
  beforeLines: number;
  afterLines: number;
  commonLines: number; // line-level LCS length (lines identical AND in the same relative order)
  removed: number;     // beforeLines - commonLines
  inserted: number;    // afterLines  - commonLines
  commonPrefix: number; // # identical leading lines (the file's structural head — usings/namespace/class/InitC sig)
  commonSuffix: number; // # identical trailing lines, not overlapping the prefix (Dispose / closing braces)
}

// Above the churn floor, an edit is byte-local when EITHER the structural head AND tail both survive (a bounded
// middle-confined splice, of ANY size — a large collection replace or bulk delete still keeps the file's header +
// footer) OR ≥half the shared content survives verbatim & in order. Only a whole-file rewrite/reflow/EOL-normalize/
// recovered-arbitrary-buffer trips BOTH (it wrecks an edge AND preserves <half).
const ABS_CHURN_FLOOR = 64;      // lines — below this, ALWAYS allow (protects small hand-written designers)
const MIN_SURVIVE_RATIO = 0.5;   // secondary path: ≥half of the LARGER side survives verbatim & in order
const EDGE_LINES = 1;            // a designer splice keeps ≥1 header AND ≥1 footer line identical (the edit is in the
                                 // middle) — 1, not 2, so a COMPACTED file with a single-physical-line head/tail (all
                                 // usings+class on one line) is still allowed (codex); real VS output keeps many more.
const LCS_CELL_BUDGET = 16_000_000; // O(n·m) time bound; a pathologically huge file falls back to a linear proxy

// Split on '\n' KEEPING any trailing '\r' on each line — so a file-wide CRLF↔LF normalization makes EVERY line differ
// (a violation we WANT to catch), while a same-EOL splice keeps unchanged lines byte-identical.
function splitLines(s: string): string[] {
  return s.length === 0 ? [] : s.split('\n');
}

// LCS length via a rolling two-row DP (O(min) space). Order-sensitive → a reordered InitializeComponent scores low.
function lcsLength(a: string[], b: string[]): number {
  const n = a.length, m = b.length;
  if (n === 0 || m === 0) return 0;
  let prev = new Int32Array(m + 1);
  let cur = new Int32Array(m + 1);
  for (let i = 1; i <= n; i++) {
    const ai = a[i - 1];
    for (let j = 1; j <= m; j++) {
      cur[j] = ai === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    const t = prev; prev = cur; cur = t;
    cur.fill(0);
  }
  return prev[m];
}

// Order-INSENSITIVE multiset intersection (an upper bound on LCS) — only for a file too large for the O(n·m) LCS.
function multisetCommon(a: string[], b: string[]): number {
  const counts = new Map<string, number>();
  for (const line of a) counts.set(line, (counts.get(line) ?? 0) + 1);
  let common = 0;
  for (const line of b) {
    const c = counts.get(line) ?? 0;
    if (c > 0) { common++; counts.set(line, c - 1); }
  }
  return common;
}

// # of identical leading lines shared by a and b.
function commonPrefixLen(a: string[], b: string[]): number {
  const lim = Math.min(a.length, b.length);
  let p = 0;
  while (p < lim && a[p] === b[p]) p++;
  return p;
}
// # of identical trailing lines shared by a and b, not overlapping the already-counted prefix.
function commonSuffixLen(a: string[], b: string[], prefix: number): number {
  const lim = Math.min(a.length, b.length) - prefix;
  let s = 0;
  while (s < lim && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  return s;
}

export function diffLines(before: string, after: string): EditDiff {
  const a = splitLines(before), b = splitLines(after);
  const n = a.length, m = b.length;
  const common = n * m > LCS_CELL_BUDGET ? multisetCommon(a, b) : lcsLength(a, b);
  const prefix = commonPrefixLen(a, b);
  return {
    beforeLines: n, afterLines: m, commonLines: common, removed: n - common, inserted: m - common,
    commonPrefix: prefix, commonSuffix: commonSuffixLen(a, b, prefix),
  };
}

/** Fail-closed backstop: is `after` a byte-LOCAL (confined-splice) edit of `before`? */
export function isByteLocalEdit(before: string, after: string): boolean {
  if (after === before) return true; // no-op (commit() already returns early on this)
  const d = diffLines(before, after);
  const churn = d.removed + d.inserted;
  if (churn < ABS_CHURN_FLOOR) return true; // small edit — always allowed
  // STRUCTURAL: a real designer splice preserves the file's head (usings/namespace/class/InitializeComponent
  // signature) AND tail (Dispose/closing braces) — the edit is a bounded region in the MIDDLE, even a large
  // collection replace or a bulk delete. Allow when both edges survive.
  if (d.commonPrefix >= EDGE_LINES && d.commonSuffix >= EDGE_LINES) return true;
  // SECONDARY (an edge was destroyed): allow only a high-survival edit that keeps ≥half of the LARGER side, AND is
  // non-empty. The MAX denominator + `afterLines > 0` close the degenerate fail-opens the min() denominator had
  // (codex): deleting the WHOLE file (after empty → refused) or truncating to a line (survival ≪ max → refused),
  // while a whole-file reindent/reorder/EOL-normalize (few common lines vs the larger side) is still refused.
  return d.afterLines > 0 && d.commonLines >= MIN_SURVIVE_RATIO * Math.max(d.beforeLines, d.afterLines);
}

/** For TIGHT test assertions: lines inserted in `after` / removed from `before` (multiset difference — cheap,
 *  order-insensitive). A splice's inserted lines contain ONLY the edited statements, so a test can assert they
 *  include the target and EXCLUDE neighbor field-decls / usings / Dispose (proving the edit didn't touch them). */
export function changedLines(before: string, after: string): { inserted: string[]; removed: string[] } {
  const a = splitLines(before), b = splitLines(after);
  const aCount = new Map<string, number>();
  for (const l of a) aCount.set(l, (aCount.get(l) ?? 0) + 1);
  const inserted: string[] = [];
  for (const l of b) { const c = aCount.get(l) ?? 0; if (c > 0) aCount.set(l, c - 1); else inserted.push(l); }
  const bCount = new Map<string, number>();
  for (const l of b) bCount.set(l, (bCount.get(l) ?? 0) + 1);
  const removed: string[] = [];
  for (const l of a) { const c = bCount.get(l) ?? 0; if (c > 0) bCount.set(l, c - 1); else removed.push(l); }
  return { inserted, removed };
}
