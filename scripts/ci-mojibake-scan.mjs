// Mojibake gate. A source file that made a round trip through a single-byte code page (CP1251/Latin-1) keeps its
// text readable to every syntax check while the non-ASCII glyphs turn into garbage: an ellipsis (UTF-8 E2 80 A6)
// re-read as CP1251 becomes three Cyrillic-looking characters. v1.2.0 shipped seven such literals into the property
// grid's data-binding UI; `node --check` passed and the webview tests select by CSS class, never by text, so nothing
// caught it. This scanner is that missing gate.
//
// Detection is a ROUND TRIP, not a character heuristic: take each run of non-ASCII characters, encode it back through
// the suspect code page, and report it only when those bytes form a VALID multi-byte UTF-8 sequence that decodes to
// non-ASCII text. That is precisely the property mojibake has and natural text does not — genuine Russian text such
// as "Открыть в" followed by an ellipsis encodes to E2 85, which is NOT valid UTF-8 (E2 needs two continuation
// bytes), while the double-encoded ellipsis encodes to E2 80 A6, which is. The ru/hi/zh catalogs pass untouched.
//
// NOTE: this file is scanned like any other, so it must never embed a literal mojibake sequence — describe the bytes.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TEXT_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.cs', '.json', '.md', '.yml', '.yaml',
  '.ps1', '.csproj', '.props', '.html', '.css', '.resx', '.txt',
]);

/** char -> byte for the code pages a Windows editor round-trips through, built by decoding all 256 bytes. */
function encoderFor(label) {
  const decoder = new TextDecoder(label);
  const table = new Map();
  for (let byte = 0x80; byte <= 0xff; byte++) {
    const char = decoder.decode(Uint8Array.of(byte));
    if (char && char !== '�' && !table.has(char)) table.set(char, byte);
  }
  return table;
}

const CODE_PAGES = [
  { label: 'windows-1251', table: encoderFor('windows-1251') },
  { label: 'windows-1252', table: encoderFor('windows-1252') },
];

const utf8Strict = new TextDecoder('utf-8', { fatal: true });

// Two arbitrary Cyrillic letters often encode to a valid 2-byte UTF-8 sequence by luck ("ЖЁ" -> U+01A8), so a
// recovery only counts when it lands in a block this product actually uses. Real mojibake here is 3 characters wide
// (a 3-byte UTF-8 sequence: the typographic and symbol planes) or a long double-encoded Cyrillic/CJK run.
const PLAUSIBLE_BLOCKS = [
  [0x00a0, 0x00ff], // Latin-1 supplement — é, ü, °
  [0x0400, 0x04ff], // Cyrillic — a double-encoded ru catalog
  [0x0900, 0x097f], // Devanagari — the hi catalog
  [0x2000, 0x27bf], // punctuation, arrows, symbols, dingbats — …, ’, —, →, ✓, ✕
  [0x3000, 0x9fff], // CJK — the zh-cn catalog
];

const isPlausible = (char) => {
  const code = char.codePointAt(0);
  return PLAUSIBLE_BLOCKS.some(([low, high]) => code >= low && code <= high);
};

/** The text this run decodes to if it really is double-encoded, or null when it is honest non-ASCII text. */
function recoverOriginal(run) {
  // KNOWN BLIND SPOT, chosen deliberately: runs shorter than three characters are not reported. Two characters is
  // the width of a corrupted single accented letter, but it is also where the false positives are — ANY two
  // characters that happen to encode to a valid 2-byte UTF-8 sequence look identical to the real thing. Measured
  // examples of VALID text that a 2-character rule rejects: the Cyrillic pairs "ЖЁ"/"ЧЁ"/"Щё" (CP1251), and Spanish
  // «GANÓ» whose "Ó»" decodes to U+04FB (CP1252). A gate that fails a correct locale file is worse than one with a
  // documented gap, so the rule stays at three. That is enough for the corruption this exists to stop: the
  // typographic and symbol glyphs in the UI (ellipsis, apostrophe, multiplication sign) are 3-byte sequences, and a
  // double-encoded word of Cyrillic/CJK produces a long run that the windows below decode.
  if (run.length < 3) return null;
  for (const { table } of CODE_PAGES) {
    const bytes = [];
    let encodable = true;
    for (const char of run) {
      const byte = table.get(char);
      if (byte === undefined) { encodable = false; break; }
      bytes.push(byte);
    }
    if (!encodable) continue;
    let decoded;
    try { decoded = utf8Strict.decode(Uint8Array.from(bytes)); } catch { continue; }
    // A real recovery is shorter than the garble and is entirely plausible product text.
    if (decoded.length >= run.length) continue;
    if (![...decoded].every(isPlausible)) continue;
    return decoded;
  }
  return null;
}

const NON_ASCII_RUN = /[^\x00-\x7F]+/gu;

// No arguments = the CI gate over every tracked text file. Explicit paths = an ad-hoc scan (also how the gate itself
// is regression-tested: run it against a pre-fix copy of a file and it must report the sequences it was written for).
const explicit = process.argv.slice(2);
const tracked = explicit.length > 0
  ? explicit
  : execFileSync('git', ['ls-files', '-z'], { cwd: repo, maxBuffer: 64 * 1024 * 1024 })
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .filter((file) => TEXT_EXTENSIONS.has(path.extname(file).toLowerCase()));

const hits = [];
for (const file of tracked) {
  let text;
  // resolve, not join: an explicit argument may be an absolute path.
  try { text = fs.readFileSync(path.resolve(repo, file), 'utf8'); } catch { continue; }
  if (!/[^\x00-\x7F]/.test(text)) continue;
  text.split(/\r?\n/).forEach((line, index) => {
    for (const match of line.matchAll(NON_ASCII_RUN)) {
      // Scan every sub-run: one bad glyph can sit inside a longer legitimate non-ASCII stretch.
      const run = match[0];
      for (let start = 0; start < run.length; start++) {
        for (let end = Math.min(run.length, start + 6); end > start + 1; end--) {
          const original = recoverOriginal(run.slice(start, end));
          if (original === null) continue;
          hits.push({ file, line: index + 1, garbled: run.slice(start, end), original });
          start = end - 1;
          break;
        }
      }
    }
  });
}

if (hits.length === 0) {
  console.log(`mojibake scan ok: ${tracked.length} tracked text files, no double-encoded sequences`);
  process.exit(0);
}

console.error(`mojibake scan FAILED — ${hits.length} double-encoded sequence(s):\n`);
for (const hit of hits) {
  console.error(`  ${hit.file}:${hit.line}  ${JSON.stringify(hit.garbled)} → should be ${JSON.stringify(hit.original)}`);
}
console.error('\nRe-save the file as UTF-8 and retype the affected glyphs.');
process.exit(1);
