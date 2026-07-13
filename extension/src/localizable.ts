// 0.10.0 trust-floor — Localizable-form detection (pillar 3: read-only refusal).
//
// A [Localizable(true)] WinForms form does NOT serialize its per-control properties as direct
// `this.button1.Text = "…"` / `.Location = …` assignments. Instead VS routes every localizable
// property (Text, Location, Size, TabIndex, Anchor, the form's own ClientSize/Text via `$this`)
// through a ComponentResourceManager's bulk-apply calls in InitializeComponent:
//
//   System.ComponentModel.ComponentResourceManager resources =
//       new System.ComponentModel.ComponentResourceManager(typeof(Foo));
//   …
//   resources.ApplyResources(this.button1, "button1");
//   resources.ApplyResources(this, "$this");
//
// The net9 interpreter models `resources.GetObject/GetString` (single-key image/string lookups) but
// has ZERO handling for `ApplyResources` — the statement is dropped as unrepresentable, so every
// localized property is missing and the form mis-renders (controls pile at their field default
// 0,0 / default size / empty text). Worse, a property edit on such a form splices a direct
// `this.x.Prop = …` into the .Designer.cs while the real value lives in the .resx — a silent
// divergence VS later resolves by regenerating from the .resx and DROPPING the injected line
// (silent data loss).
//
// Under the 0.10.0 fail-closed bar the honest response is a read-only refusal + banner. This module
// is the runtime-independent detector: pure (no vscode / no I/O), so it is unit-testable headless
// (see e2e.ts) and works for BOTH engines (the host holds the .Designer.cs text regardless of which
// engine renders the picture).

// The `ApplyResources` bulk-apply MEMBER ACCESS, normalized over CODE tokens (comments/strings removed
// first by stripCommentsAndStrings, then Unicode identifier escapes decoded): a `.` receiver access,
// optional whitespace, an optional `@` verbatim-identifier prefix, the method name, then a word boundary.
// Anchoring on the MEMBER ACCESS `.ApplyResources` (not the call `(`, and not the manager declaration) is
// deliberately robust to how the ComponentResourceManager is declared/named AND to how the bulk-apply is
// invoked — `var`, a `using`/`global using` alias whose expansion lives in ANOTHER file, a split
// declaration, a nullable type, a Unicode receiver identifier, a custom manager subtype, a method-group
// indirection `Action<object,string> a = resources.ApplyResources; a(this.b, "b");` (no call paren on the
// access) — all of which a declaration-shape or require-the-paren regex misses (a false negative = the
// silent-data-loss path). `\b` still requires `ApplyResources` to be a COMPLETE identifier, so
// `.ApplyResourcesToFoo(` / `.ApplyResources2` do NOT match. The whitespace class is `[\s\u0085]` (not bare
// `\s`): C# accepts a line break between `.` and the member, and U+0085 (NEL) is a C# line terminator that
// JS `\s` does NOT include — so `resources.<NEL>ApplyResources` still matches (no false negative). See e2e.ts.
const APPLY_RESOURCES = /\.[\s\u0085]*@?ApplyResources\b/;

/**
 * Replace the CONTENT of C# comments and string/char literals with spaces, leaving code tokens (and the
 * inter-token whitespace) intact. A lightweight lexer — NOT a full C# parser — so the detector below
 * scans real code only. This closes raw-text blind spots (codex convergence reviews):
 *   • a string value that merely CONTAINS `.ApplyResources(` (e.g. `label1.Text = ".ApplyResources(";`)
 *     no longer false-flags a normal non-localizable form as read-only;
 *   • a comment BETWEEN `.` and `ApplyResources` (e.g. `resources./*x* /ApplyResources(…)`) collapses to
 *     whitespace, so a genuine call is still detected (no false negative);
 *   • a C# 11 raw string literal (`"""…"""`, variable-length delimiter, may embed ordinary `"` and, when
 *     $-prefixed, interpolation holes) is consumed as a WHOLE token via a hole-aware scanner, so an embedded
 *     quote can't desync it into swallowing a later real ApplyResources call.
 * Implemented as a small recursive lexer (skipString / skipHole / skipChar). Handles `//` and block
 * comments, regular/verbatim(@)/interpolated($) strings, raw strings, and char literals, with their
 * respective escape/termination rules. A `//` line comment stops at ANY of C#'s FIVE line terminators
 * (`\r`, `\n`, U+0085, U+2028, U+2029 — see isLineTerminator), so a comment ended by a bare CR or a Unicode
 * separator can't swallow the code after it. INTERPOLATED strings (`$"…"`, `$@"…"`, `$"""…"""`) are HOLE-AWARE and re-emit their whole
 * token text as CODE rather than blanking it: their `{…}` holes are executable code, so a call reachable
 * from a hole (e.g. `$"{Run("x", () => resources.ApplyResources(…))}"` — note the nested `"x"` the naive
 * scanner used to trip on) stays visible to the detector. This is a fail-closed choice (codex fix-verify
 * rounds) whose only cost is a rare, safe false positive when an interpolated string's LITERAL text happens
 * to contain `.ApplyResources`. Non-interpolated literals are blanked (a plain string that merely CONTAINS
 * `.ApplyResources(` must not over-lock).
 */
function stripCommentsAndStrings(src: string): string {
  const n = src.length;

  // ---- pure end-finders (they NEVER touch `out`; the top-level loop decides blank-vs-re-emit) ----

  // All FIVE C# line terminators: CR, LF, U+0085 (NEL), U+2028 (LINE SEP), U+2029 (PARAGRAPH SEP). A `//`
  // comment ends at ANY of them, so a comment terminated by one of the three Unicode separators can't swallow
  // the real code after it (codex fix-verify R5 — a false negative not covered by the interpolation net).
  const isLineTerminator = (ch: string): boolean =>
    ch === '\n' || ch === '\r' || ch === '\u0085' || ch === '\u2028' || ch === '\u2029';

  // A position starts a string literal iff, after any run of `@`/`$` prefixes, the next char is `"`.
  const isStringStart = (i: number): boolean => {
    let p = i;
    while (src[p] === '@' || src[p] === '$') p++;
    return src[p] === '"';
  };

  // char literal 'x' / '\n' / '\'' → index just past the closing '.
  const skipChar = (i: number): number => {
    i++; // past opening '
    while (i < n && src[i] !== "'") { if (src[i] === '\\') i++; i++; }
    return i + 1;
  };

  // A `{…}` interpolation hole is CODE — walk it to its matching `}` (depth-tracked), consuming nested
  // string/char literals and comments so an inner `"` or `}` can't be mistaken for the hole/string end.
  // `i` points just past the opening `{`. Returns the index just past the matching `}`.
  const skipHole = (i: number): number => {
    let depth = 1;
    while (i < n && depth > 0) {
      const ch = src[i];
      if (ch === '{') { depth++; i++; }
      else if (ch === '}') { depth--; i++; }
      else if (isStringStart(i)) { i = skipString(i).end; }
      else if (ch === "'") { i = skipChar(i); }
      else if (ch === '/' && src[i + 1] === '/') { i += 2; while (i < n && !isLineTerminator(src[i])) i++; }
      else if (ch === '/' && src[i + 1] === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; }
      else i++;
    }
    return i;
  };

  // Consume a complete string literal starting at `i` (its `@`/`$` prefixes or opening `"`). Returns the
  // index just past the token and whether it was interpolated. HOLE-AWARE: for an interpolated string the
  // `{…}` holes are walked as code (via skipHole), so a `"` inside a hole cannot end the outer string
  // early (the bug codex found: `$"{Run("x", () => resources.ApplyResources(…))}"`). Supports raw (≥3-quote
  // delimiter) and non-raw, verbatim and not, with single-brace (`$`) interpolation — the shapes that occur
  // in a .Designer.cs; multi-`$` raw interpolation is approximated (single-brace holes), which over-consumes
  // rather than under-consumes and so stays fail-closed.
  function skipString(i: number): { end: number; interpolated: boolean } {
    let p = i;
    let verbatim = false;
    let interpolated = false;
    while (src[p] === '@' || src[p] === '$') { if (src[p] === '@') verbatim = true; else interpolated = true; p++; }
    let q = 0;
    while (p + q < n && src[p + q] === '"') q++;
    if (q >= 3) {
      // raw string: closed by the first run of ≥q quotes that is NOT inside an interpolation hole.
      let k = p + q;
      while (k < n) {
        if (interpolated && src[k] === '{') { k = src[k + 1] === '{' ? k + 2 : skipHole(k + 1); continue; }
        if (src[k] === '"') {
          let r = 0;
          while (k + r < n && src[k + r] === '"') r++;
          if (r >= q) { k += r; break; } // a run of ≥q quotes closes the raw string
          k += r;                        // a shorter run is ordinary content
          continue;
        }
        k++;
      }
      return { end: k, interpolated };
    }
    // non-raw single-delimiter string
    let k = p + 1; // past opening "
    while (k < n) {
      const ch = src[k];
      if (ch === '"') {
        if (verbatim && src[k + 1] === '"') { k += 2; continue; } // "" escaped quote (verbatim)
        k++; break;                                               // closing quote
      }
      if (!verbatim && ch === '\\') { k += 2; continue; }         // escape (regular/interpolated)
      if (interpolated && ch === '{') { k = src[k + 1] === '{' ? k + 2 : skipHole(k + 1); continue; }
      if (interpolated && ch === '}' && src[k + 1] === '}') { k += 2; continue; } // }} literal
      k++;
    }
    return { end: k, interpolated };
  }

  // ---- top-level pass: blank comment/char/plain-string content; RE-EMIT interpolated strings as code ----
  let out = '';
  let i = 0;
  while (i < n) {
    const c = src[i];
    const c2 = i + 1 < n ? src[i + 1] : '';
    // line comment → drop to end of line (stop at ANY of C#'s five line terminators — see isLineTerminator)
    if (c === '/' && c2 === '/') {
      i += 2;
      while (i < n && !isLineTerminator(src[i])) i++;
      out += ' ';
      continue;
    }
    // block comment → drop through the closing */
    if (c === '/' && c2 === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      out += ' ';
      continue;
    }
    // char literal
    if (c === "'") {
      i = skipChar(i);
      out += ' ';
      continue;
    }
    // string literal (any prefix). An INTERPOLATED string ($"…{code}…" / $"""…""") evaluates its holes, so
    // re-emit its whole token text as code — a call reachable from a hole must stay visible to the regex.
    // A plain/verbatim (non-$) literal is blanked (a string that merely CONTAINS ".ApplyResources(" must not
    // over-lock). Consuming the token hole-aware also advances `i` past its TRUE end, so a `"` inside a hole
    // can't desync the lexer into blanking a later real call.
    if (isStringStart(i)) {
      const { end, interpolated } = skipString(i);
      out += interpolated ? src.slice(i, end) : ' ';
      i = end;
      continue;
    }
    // ordinary code character (includes a bare `@`/`$` that was NOT a string prefix — e.g. @verbatim identifiers)
    out += c;
    i++;
  }
  return out;
}

/**
 * Normalize C# identifiers the way the compiler compares them (spec §6.4.3): (1) translate Unicode escapes
 * (`\uXXXX`, `\UXXXXXXXX`) to their characters, then (2) strip Unicode FORMAT characters (category `Cf`, e.g.
 * U+200C/U+200D/U+00AD). C# permits both in IDENTIFIERS, so `resources.ApplyResources(…)` (an escaped
 * letter) and `resources.ApplyResources(…)` (a zero-width formatting char inside the name) both invoke
 * the real `ApplyResources` method; without this the literal-text regex would miss them (fail-open false
 * negatives — codex review). Run only on the STRIPPED code (string/comment content is already spaced out).
 * Both transforms can only REVEAL / join identifier characters, never hide the all-ASCII `ApplyResources`,
 * so neither can introduce a false negative. An out-of-range codepoint (malformed source) is left verbatim
 * rather than throwing — it can't be part of the ASCII target anyway.
 */
function decodeUnicodeEscapes(code: string): string {
  return code
    .replace(/\\u([0-9A-Fa-f]{4})|\\U([0-9A-Fa-f]{8})/g, (m, u4, u8) => {
      const cp = parseInt(u4 ?? u8, 16);
      return cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    })
    .replace(/\p{Cf}/gu, ''); // C# removes Cf format chars when comparing identifiers (§6.4.3)
}

/**
 * True when `text` (a .Designer.cs buffer) is a localizable form — i.e. its CODE contains an
 * `ApplyResources` member access (the ComponentResourceManager bulk-apply that ONLY a [Localizable(true)]
 * form emits).
 *
 * FAIL-CLOSED by design. This is the trust boundary for a read-only lock, so it must never MISS a real
 * localizable form (a false negative lets an edit splice a divergent assignment the .resx later drops =
 * silent data loss). It keys on the MEMBER ACCESS `.ApplyResources` over code tokens (comments/strings
 * stripped, Unicode identifier escapes decoded), rather than the manager declaration or the call paren, so
 * no valid-C# spelling of the declaration OR of the invocation (var / cross-file alias / split decl /
 * nullable / @verbatim / Unicode-escaped method / method-group indirection / raw-string-adjacent code) can
 * evade it. The cost is that a false POSITIVE only makes a form read-only — safe and, on real VS-generated
 * `.Designer.cs`, essentially never: `.ApplyResources` is the ComponentResourceManager bulk-apply and
 * appears in code there ONLY for localizable forms. A non-localizable form that merely reads one image via
 * `resources.GetObject(...)`, or shows a code snippet in a string / mentions ApplyResources in a comment,
 * is NOT flagged.
 *
 * A precise binding of the member access to `ComponentResourceManager.ApplyResources` needs a semantic C#
 * model (the engine's Roslyn tree, not a host lexer) — a documented follow-up for even fewer false
 * positives. It is NOT a 0.10.0 requirement, because a false positive is already fail-closed.
 */
export function isLocalizableDesigner(text: string | undefined | null): boolean {
  if (!text) return false;
  if (APPLY_RESOURCES.test(decodeUnicodeEscapes(stripCommentsAndStrings(text)))) return true;
  // Fail-closed safety net for the ONE construct the lexer can only APPROXIMATE — C# interpolated strings,
  // whose `{…}` holes are executable code and can, in exotic multi-`$` raw forms, nest a same/longer-delimited
  // literal the hole-aware scanner may mis-terminate. If the buffer uses ANY interpolated string AND mentions
  // `ApplyResources` anywhere in the (Unicode-decoded) text, lock rather than risk a hole hiding a real call.
  // The `decodeUnicodeEscapes(text)` on the RIGHT is essential: the residual case combines the mis-terminated
  // hole with a `\uXXXX`-escaped method name, which a raw-text word match would miss (codex fix-verify R4).
  // This can only OVER-lock (safe); a real VS-generated `.Designer.cs` neither uses interpolation nor mentions
  // ApplyResources outside a real call, so it never fires there — but it makes the no-false-negative guarantee
  // hold for EVERY input, not just the lexer's modelled cases. Openers: `$"` / `$@"` / `@$"` / `$$"…` / `$$$"…`.
  if (/\$@?"|@\$"/.test(text) && /\bApplyResources\b/.test(decodeUnicodeEscapes(text))) return true;
  return false;
}
