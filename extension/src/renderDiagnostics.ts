// T2.2 — Load-failure / partial-render diagnostics.
//
// The engine renders resiliently: a statement whose control ctor throws, whose type can't be resolved, or that
// the interpreter doesn't model is caught, dropped from the canvas, and recorded in `unrepresentable` (a list of
// per-statement strings). Today the host only mines that list for "unresolved type X" to offer a control source;
// every OTHER reason (init exceptions, unsupported constructs) is invisible — the control silently vanishes.
//
// This module turns those raw engine strings into a small, categorized, actionable set the canvas can surface as a
// dismissible banner ("N constructs skipped — …"). It is PURE (no vscode / no I/O) so it is unit-testable headless
// (see e2e.ts) and shared by the host (designerEditor.ts).
//
// Raw entry shapes produced by the engine (net9 DesignerRenderer.Interpret):
//   "this.x.Prop = new decimal(...);  [InvalidOperationException: unresolved type decimal]"  // stmt + [Ex: msg]
//   "((Acme.Licensing.ISupportInitialize)(this.button1)).BeginInit()"                        // bare refused stmt
//   "AddRange: unknown element this.foo"                                                     // HandleInvocation why
//   "InitializeComponent not found"                                                          // structural
// The message inside [...] may itself be "unresolved type X" (a missing-type failure wearing an exception jacket).

export type DiagCategory = 'missingType' | 'initError' | 'unsupported';

export interface RenderDiagItem {
  /** Coarse bucket used for the banner's grouping + icon. */
  category: DiagCategory;
  /** The offending construct (the C# statement / reason), trimmed and stripped of the trailing "[Ex: ...]" jacket. */
  text: string;
  /** Human detail: the unresolved type name, or the exception message. Empty when there is nothing to add. */
  detail: string;
}

// A trailing "  [SomeException: message]" jacket the engine appends (DesignerRenderer.cs:1596 =
// stmt.ToString() + "  [" + ex.GetType().Name + ": " + ex.Message + "]") to a statement it caught mid-interpret.
// Anchored to the TAIL via a greedy leading group so a literal "[XxxException: ...]" INSIDE the statement (e.g. a
// Label.Text string) does not hijack the match — group 1 = statement, group 2 = exception type, group 3 = message.
const EX_JACKET = /^([\s\S]*)\s*\[([A-Za-z][A-Za-z0-9_]*Exception):\s*([\s\S]*?)\]\s*$/;
// The interpreter's two "missing type" signals (DesignerRenderer.cs:1666/1948 "unresolved type X" and :2009
// "cannot evaluate invocation (unresolved type) X"). Anchored to the phrase START or the PARENTHESIZED form so a
// genuine exception message that merely mentions "unresolved type" as prose is not mis-bucketed as missingType.
const UNRESOLVED = /(?:^unresolved type|\(unresolved type\))\s+([\w.+<>`]+)/;

/**
 * Categorize the engine's `unrepresentable` list into a compact, de-duplicated, actionable set for the canvas
 * banner. Order-preserving (first occurrence wins); a missing-type reason takes priority over its exception jacket.
 * Blank / whitespace-only entries are ignored. Returns [] for an empty or all-blank input.
 */
export function categorizeUnrepresentable(unrepresentable: readonly string[] | undefined): RenderDiagItem[] {
  if (!unrepresentable || unrepresentable.length === 0) return [];
  const out: RenderDiagItem[] = [];
  const seen = new Set<string>();
  for (const raw of unrepresentable) {
    if (typeof raw !== 'string') continue;
    const entry = raw.trim();
    if (!entry) continue;

    let text = entry;
    let detail = '';
    let category: DiagCategory;

    const jacket = EX_JACKET.exec(entry);
    if (jacket) {
      // caught mid-interpret: statement + "[Ex: message]". A missing-type signal INSIDE the message wins
      // (it's really a missing control/assembly wearing an exception jacket); otherwise it's a plain init error.
      // Only the jacket's own message is probed — never the raw entry — so a "(unresolved type)" literal sitting
      // in the statement text cannot flip a genuine init error to missingType.
      text = jacket[1].trim() || entry;
      const exMsg = jacket[3].trim();
      const missing = UNRESOLVED.exec(exMsg);
      if (missing) { category = 'missingType'; detail = missing[1]; }
      else { category = 'initError'; detail = exMsg; }
    } else {
      // no exception jacket: a bare refused statement or a HandleInvocation reason (may carry the parenthesized
      // "(unresolved type) X" form). Missing-type wins if present; otherwise it is an unsupported construct.
      const missing = UNRESOLVED.exec(entry);
      if (missing) { category = 'missingType'; detail = missing[1]; }
      else { category = 'unsupported'; detail = ''; }
    }

    const key = itemKey({ category, text, detail });
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ category, text, detail });
  }
  return out;
}

/** Collision-free per-item key: JSON-encodes the three fields so field boundaries are unambiguous (a plain
 *  space-joined key would let "a b"+"c" collide with "a"+"b c") — no control chars, plain ASCII. */
function itemKey(i: RenderDiagItem): string {
  return JSON.stringify([i.category, i.text, i.detail]);
}

/**
 * A stable signature of a diagnostics set, so the canvas can keep a banner DISMISSED across re-renders that surface
 * the exact same issues (don't re-nag), yet re-show it the moment the set of problems changes. Order-independent and
 * collision-free (JSON-encoded fields). Used headless by e2e.ts; designer.js diagSignature mirrors the idea for the
 * live dismiss latch.
 */
export function diagnosticsSignature(items: readonly RenderDiagItem[]): string {
  return JSON.stringify(items.map(itemKey).sort());
}
