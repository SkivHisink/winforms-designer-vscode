#!/usr/bin/env node
// Localization key-parity check.
//
// Compares every locale against the English source of truth for BOTH layers:
//   • Layer B (runtime catalog): extension/src/i18n/en.ts  vs  <lang>.json
//   • Layer A (package.nls):     extension/package.nls.json vs package.nls.<lang>.json
//
// Checks per locale: missing keys, extra keys, {placeholder} slot parity, and — for pluralized
// entries — that the required CLDR categories for that language are present (a missing category
// falls back to `other` at runtime, so only a missing `other` is an error).
//
// SOFT by default (always exits 0, prints a report so partial translations can still ship — a
// missing key just falls back to English). Pass --strict to exit non-zero when any issue is found
// (use in CI once translations are meant to be complete).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ext = join(root, 'extension');
const LANGS = ['ru', 'zh-cn', 'fr', 'de', 'es'];
const strict = process.argv.includes('--strict');

/** Load the English runtime catalog by transpiling en.ts (TS) in-memory with the bundler's esbuild. */
function loadEn() {
  const esbuild = require(join(ext, 'node_modules', 'esbuild'));
  const src = readFileSync(join(ext, 'src', 'i18n', 'en.ts'), 'utf8');
  const cjs = esbuild.transformSync(src, { loader: 'ts', format: 'cjs' }).code;
  const m = { exports: {} };
  new Function('module', 'exports', 'require', cjs)(m, m.exports, require);
  return m.exports.en;
}

const slots = (s) => new Set([...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]));
const eqSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

let hadIssue = false;
const problem = (msg) => { hadIssue = true; console.log('  ✖ ' + msg); };
const warn = (msg) => { hadIssue = true; console.log('  ⚠ ' + msg); };

/** Compare one locale catalog against an English reference; `pluralAware` enables CLDR-category checks. */
function compare(label, en, loc, lang, pluralAware) {
  console.log(`\n${label} [${lang}]`);
  const enKeys = Object.keys(en), locKeys = new Set(Object.keys(loc));
  const missing = enKeys.filter((k) => !locKeys.has(k));
  const extra = [...locKeys].filter((k) => !(k in en));
  if (missing.length) problem(`${missing.length} missing key(s): ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? ', …' : ''}`);
  if (extra.length) warn(`${extra.length} extra key(s): ${extra.slice(0, 8).join(', ')}${extra.length > 8 ? ', …' : ''}`);
  const cats = pluralAware ? new Intl.PluralRules(lang).resolvedOptions().pluralCategories : ['other'];
  for (const k of enKeys) {
    if (!locKeys.has(k)) continue;
    const ev = en[k], lv = loc[k];
    if (typeof ev === 'object') { // pluralized
      if (typeof lv !== 'object') { problem(`${k}: expected a pluralized object`); continue; }
      if (lv.other == null) problem(`${k}: missing required 'other' form`);
      // categories that Intl produces for this language should be present (else silent 'other' fallback)
      for (const c of cats) if (lv[c] == null && c !== 'other') warn(`${k}: missing plural category '${c}'`);
      for (const c of Object.keys(lv)) {
        if (!eqSet(slots(ev.other), slots(lv[c]))) problem(`${k}.${c}: placeholder mismatch (want {${[...slots(ev.other)].join(',')}})`);
      }
    } else {
      if (typeof lv !== 'string') { problem(`${k}: expected a string`); continue; }
      if (!eqSet(slots(ev), slots(lv))) problem(`${k}: placeholder mismatch (want {${[...slots(ev)].join(',')}}, got {${[...slots(lv)].join(',')}})`);
    }
  }
  if (!missing.length && !extra.length) console.log(`  ✓ ${enKeys.length} keys`);
}

const en = loadEn();
const nlsEn = JSON.parse(readFileSync(join(ext, 'package.nls.json'), 'utf8'));

for (const lang of LANGS) {
  let loc;
  try { loc = JSON.parse(readFileSync(join(ext, 'src', 'i18n', `${lang}.json`), 'utf8')); }
  catch (e) { problem(`runtime [${lang}]: cannot read/parse ${lang}.json — ${e.message}`); loc = {}; }
  compare('runtime', en, loc, lang, true);

  let nls;
  try { nls = JSON.parse(readFileSync(join(ext, `package.nls.${lang}.json`), 'utf8')); }
  catch (e) { problem(`package.nls [${lang}]: cannot read/parse package.nls.${lang}.json — ${e.message}`); nls = {}; }
  compare('package.nls', nlsEn, nls, lang, false);
}

console.log(`\n${hadIssue ? (strict ? 'FAIL' : 'DONE (soft — issues reported above)') : 'OK — all locales in parity'}`);
process.exit(hadIssue && strict ? 1 : 0);
