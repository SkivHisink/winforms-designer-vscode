/** The supported Save As is a form copy with one class/constructor rename. Namespace and user text stay intact.
 * References that require semantic binding are refused; they belong to the general rename workflow. */
interface Token { text: string; start: number; end: number; }

const keywords = new Set(('abstract as base bool break byte case catch char checked class const continue decimal default '
  + 'delegate do double else enum event explicit extern false finally fixed float for foreach goto if implicit in int '
  + 'interface internal is lock long namespace new null object operator out override params private protected public '
  + 'readonly ref return sbyte sealed short sizeof stackalloc static string struct switch this throw true try typeof '
  + 'uint ulong unchecked unsafe ushort using virtual void volatile while').split(' '));

function tokens(text: string, refuseInterpolatedType?: string): Token[] {
  const result: Token[] = [];
  // Strings/comments are opaque. Treat an interpolation containing a self-type reference as unsupported below,
  // rather than accidentally changing its displayed text or guessing the bindings of embedded expressions.
  const lex = /\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|(?:\$+)?"{3,}[\s\S]*?"{3,}|(?:\$@|@\$|@)"(?:[^"]|"")*"|\$?"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|@?[\p{L}_][\p{L}\p{N}_]*|[^\s]/gu;
  for (const match of text.matchAll(lex)) {
    if (match.index == null) continue;
    if (/^(?:\/\/|\/\*|[\$@]*"|')/.test(match[0])) {
      if (refuseInterpolatedType && /^(?:\$+|@\$)/.test(match[0])
        && match[0].includes(refuseInterpolatedType)) throw new Error('SAVE_AS_SEMANTIC_RENAME_REQUIRED');
      continue;
    }
    result.push({ text: match[0], start: match.index, end: match.index + match[0].length });
  }
  return result;
}

export function saveAsTypeName(designerText: string, destinationStem: string): { sourceType: string; destinationType: string } {
  const input = tokens(designerText);
  const declarations = input.filter((token, index) => token.text === 'class' && input[index - 1]?.text === 'partial');
  const classIndex = declarations.length === 1 ? input.indexOf(declarations[0]) : -1;
  const sourceType = input[classIndex + 1]?.text;
  if (classIndex < 0 || !sourceType || !/^[\p{L}_][\p{L}\p{N}_]*$/u.test(destinationStem) || keywords.has(destinationStem)) {
    throw new Error('SAVE_AS_UNSUPPORTED_FORM_TYPE');
  }
  return { sourceType, destinationType: destinationStem };
}

export function renameSavedFormType(text: string, sourceType: string, destinationType: string): string {
  const input = tokens(text, sourceType);
  if (input.filter((token) => ['class', 'struct', 'interface', 'enum', 'record'].includes(token.text)).length !== 1
    || input.filter((token) => token.text === 'namespace').length > 1) throw new Error('SAVE_AS_SEMANTIC_RENAME_REQUIRED');
  if (sourceType === destinationType) return text;
  const edits: Token[] = [];
  for (let index = 0; index < input.length; index++) {
    const token = input[index];
    if (token.text !== sourceType) continue;
    const previous = input[index - 1]?.text;
    const next = input[index + 1]?.text;
    const declaration = previous === 'class';
    const constructor = next === '(' && ['public', 'private', 'protected', 'internal', 'static', '~'].includes(previous);
    const typeOf = previous === '(' && input[index - 2]?.text === 'typeof';
    const creation = previous === 'new' && next === '(';
    if (!declaration && !constructor && !typeOf && !creation) throw new Error('SAVE_AS_SEMANTIC_RENAME_REQUIRED');
    edits.push(token);
  }
  if (!edits.some((edit) => input[input.indexOf(edit) - 1]?.text === 'class')) throw new Error('SAVE_AS_UNSUPPORTED_FORM_TYPE');
  let result = text;
  for (const edit of edits.reverse()) result = result.slice(0, edit.start) + destinationType + result.slice(edit.end);
  return result;
}

/** Validate the complete source snapshot after asynchronous companion reads and again before committing a copy.
 * The revision includes resource-only designer edits, so a copy cannot combine old wiring with new image resources. */
export async function verifySaveAsSourceSnapshot(revision: number, currentRevision: () => number,
  images: ReadonlyMap<string, Uint8Array | null>, read: (target: string) => Promise<Uint8Array | null>): Promise<boolean> {
  if (currentRevision() !== revision) return false;
  for (const [target, expected] of images) {
    const actual = await read(target);
    if (currentRevision() !== revision || (expected === null || actual === null ? expected !== actual
      : !Buffer.from(expected).equals(Buffer.from(actual)))) return false;
  }
  return currentRevision() === revision;
}
