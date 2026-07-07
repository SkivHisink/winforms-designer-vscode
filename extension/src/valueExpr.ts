/**
 * Shared property-value → C# expression helpers used by the designer's Properties panel. Kept
 * vscode-free so the conversion rules have one source of truth (the host wires the engine RPCs for
 * complex types; primitives/enums convert here).
 */

/**
 * Complex framework value types the grid can edit. Their raw value isn't a literal, so instead of
 * building the C# in TypeScript we hand the user's edited invariant string to the engine, which turns
 * it into an idiomatic initializer (new Point(x,y) / Color.Red / Color.FromArgb(…)) via
 * TypeConverter+InstanceDescriptor — that also validates the input and disambiguates Color. Keep this
 * list in sync with the webview's editable() check (it is injected into the HTML).
 */
export const COMPLEX_TYPES = [
  'System.Drawing.Point',
  'System.Drawing.Size',
  'System.Drawing.Color',
  'System.Drawing.Rectangle',
  'System.Windows.Forms.Padding',
  'System.Drawing.Font',
  // Cursor: the grid shows CursorConverter's standard values (Default/Hand/…) as a dropdown; the picked
  // NAME ("Hand") is handed to the engine, which emits System.Windows.Forms.Cursors.Hand via InstanceDescriptor.
  // A custom/.cur cursor has no Cursors.* member → the engine returns null → the edit is rejected (stays read-only).
  'System.Windows.Forms.Cursor',
];
export const COMPLEX_TYPE_SET = new Set(COMPLEX_TYPES);

/** Convert a raw grid value to a C# expression by property type (null = not editable here). */
export function toCSharpExpression(type: string, isEnum: boolean, raw: string): string | null {
  if (isEnum) {
    // single member → Type.Member; comma-separated (a [Flags] enum like AnchorStyles) → Type.A | Type.B | …
    // (one C# expression, accepted by the engine's single-expression gate and read back via its bitwise-or Eval).
    const members = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
    if (!members.length) return null;
    if (!members.every((m) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(m))) return null;
    return members.map((m) => `${type}.${m}`).join(' | ');
  }
  if (type === 'System.String') {
    return JSON.stringify(raw); // valid C# string literal for the common escapes
  }
  if (type === 'System.Boolean') {
    const t = raw.trim().toLowerCase();
    return t === 'true' ? 'true' : t === 'false' ? 'false' : null;
  }
  if (type === 'System.Char') {
    return raw.length >= 1 ? `'${raw[0] === "'" || raw[0] === '\\' ? '\\' + raw[0] : raw[0]}'` : null;
  }
  // numeric: emit a literal valid for the exact target type (suffix for float/decimal; no sign/
  // fraction for integers; unsigned rejects negatives) so the result also compiles, not just parses.
  const t = raw.trim();
  switch (type) {
    case 'System.Single': return /^-?\d+(\.\d+)?$/.test(t) ? t + 'f' : null;
    case 'System.Double': return /^-?\d+(\.\d+)?$/.test(t) ? t : null;
    case 'System.Decimal': return /^-?\d+(\.\d+)?$/.test(t) ? t + 'm' : null;
    case 'System.Byte':
    case 'System.UInt16':
    case 'System.UInt32':
    case 'System.UInt64':
      return /^\d+$/.test(t) ? t : null;
    case 'System.SByte':
    case 'System.Int16':
    case 'System.Int32':
    case 'System.Int64':
      return /^-?\d+$/.test(t) ? t : null;
    default:
      return null;
  }
}

/** Last dotted segment of a type name (System.Drawing.Color → Color), for user-facing messages. */
export function shortName(type: string): string {
  const i = type.lastIndexOf('.');
  return i < 0 ? type : type.slice(i + 1);
}
