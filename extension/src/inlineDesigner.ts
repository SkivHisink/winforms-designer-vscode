import * as fs from 'fs';

const maxInlineDesignerBytes = 2 * 1024 * 1024;

function sourceWithoutCommentsAndStrings(source: string): string {
  let result = '';
  let i = 0;
  let state: 'code' | 'line' | 'block' | 'string' | 'verbatim' | 'char' = 'code';
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1] ?? '';
    if (state === 'code') {
      if (c === '/' && next === '/') { result += '  '; i += 2; state = 'line'; continue; }
      if (c === '/' && next === '*') { result += '  '; i += 2; state = 'block'; continue; }
      if (c === '@' && next === '"') { result += '  '; i += 2; state = 'verbatim'; continue; }
      if (c === '"') { result += ' '; i++; state = 'string'; continue; }
      if (c === '\'') { result += ' '; i++; state = 'char'; continue; }
      result += c; i++; continue;
    }
    if (state === 'line') {
      if (c === '\r' || c === '\n') { result += c; i++; state = 'code'; } else { result += ' '; i++; }
      continue;
    }
    if (state === 'block') {
      if (c === '*' && next === '/') { result += '  '; i += 2; state = 'code'; }
      else { result += c === '\r' || c === '\n' ? c : ' '; i++; }
      continue;
    }
    if (state === 'verbatim') {
      if (c === '"' && next === '"') { result += '  '; i += 2; }
      else if (c === '"') { result += ' '; i++; state = 'code'; }
      else { result += c === '\r' || c === '\n' ? c : ' '; i++; }
      continue;
    }
    if (c === '\\' && next) { result += '  '; i += 2; continue; }
    if ((state === 'string' && c === '"') || (state === 'char' && c === '\'')) {
      result += ' '; i++; state = 'code'; continue;
    }
    result += c === '\r' || c === '\n' ? c : ' '; i++;
  }
  return result;
}

export function sourceHasInlineInitializeComponent(source: string, requireWinFormsBase = false): boolean {
  const code = sourceWithoutCommentsAndStrings(source);
  const initialize = /\bvoid\s+InitializeComponent\s*\(\s*\)\s*(?:\{|=>)/.test(code);
  if (!initialize) return false;
  if (!requireWinFormsBase) return true;
  const declaration = /\bpartial\s+class\s+@?[A-Za-z_][A-Za-z0-9_]*(?:\s*<[^>{}]+>)?\s*:\s*([^\r\n{]+)/.exec(code);
  if (!declaration) return false;
  const knownBases = new Set(['Form', 'UserControl', 'ContainerControl']);
  return declaration[1].split(',').some(base => {
    const identity = base.trim().replace(/^global::/, '');
    const simpleName = identity.slice(identity.lastIndexOf('.') + 1);
    return knownBases.has(simpleName);
  });
}

export function fileHasInlineInitializeComponent(file: string, requireWinFormsBase = false): boolean {
  if (!/\.cs$/i.test(file) || /\.Designer\.cs$/i.test(file)) return false;
  let stat: fs.Stats;
  try { stat = fs.statSync(file); } catch { return false; }
  if (!stat.isFile() || stat.size > maxInlineDesignerBytes) return false;
  try { return sourceHasInlineInitializeComponent(fs.readFileSync(file, 'utf8'), requireWinFormsBase); }
  catch { return false; }
}

/** Merge the engine's two independently-authorized insertions when InitializeComponent and the handler body live in
 * one file. The event editor adds one wiring statement; the code editor adds one handler stub. Any replacement,
 * overlap, stale offset, or output mismatch refuses instead of guessing at a whole-file merge. */
export function mergeInlineEventEdits(
  original: string,
  wiredText: string,
  codeInsertOffset: number,
  codeInsertText: string,
  expectedCodeText: string,
): string | null {
  if (!Number.isInteger(codeInsertOffset) || codeInsertOffset < 0 || codeInsertOffset > original.length
    || !codeInsertText || original.slice(0, codeInsertOffset) + codeInsertText + original.slice(codeInsertOffset) !== expectedCodeText)
    return null;

  let prefix = 0;
  const prefixLimit = Math.min(original.length, wiredText.length);
  while (prefix < prefixLimit && original.charCodeAt(prefix) === wiredText.charCodeAt(prefix)) prefix++;
  let suffix = 0;
  while (suffix < original.length - prefix && suffix < wiredText.length - prefix
    && original.charCodeAt(original.length - 1 - suffix) === wiredText.charCodeAt(wiredText.length - 1 - suffix)) suffix++;
  const removedLength = original.length - prefix - suffix;
  const insertedLength = wiredText.length - prefix - suffix;
  if (removedLength !== 0 || insertedLength <= 0) return null;
  // Same-position insertions have no stable semantic order, so keep the generated-code wiring before the class-level
  // handler stub. That matches the two distinct regions the engine normally chooses and remains deterministic.
  const adjustedOffset = codeInsertOffset + (prefix <= codeInsertOffset ? insertedLength : 0);
  return wiredText.slice(0, adjustedOffset) + codeInsertText + wiredText.slice(adjustedOffset);
}
