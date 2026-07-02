import * as vscode from 'vscode';
import { en } from './en';
import ru from './ru.json';
import zhcn from './zh-cn.json';
import fr from './fr.json';
import de from './de.json';
import es from './es.json';

/** A pluralized entry: forms are picked by the current locale's CLDR plural category (Intl.PluralRules). */
export type Plural = { zero?: string; one?: string; two?: string; few?: string; many?: string; other: string };
export type Catalog = Record<string, string | Plural>;

export type Lang = 'en' | 'ru' | 'zh-cn' | 'fr' | 'de' | 'es';
export const SUPPORTED: readonly Lang[] = ['en', 'ru', 'zh-cn', 'fr', 'de', 'es'];

const CATALOGS: Record<Lang, Catalog> = {
  en,
  ru: ru as Catalog,
  'zh-cn': zhcn as Catalog,
  fr: fr as Catalog,
  de: de as Catalog,
  es: es as Catalog,
};

// The active language. Driven ONLY by the `winformsDesigner.language` setting — it never auto-follows the
// VS Code display language. Cached here and refreshed at activation and on config change (setLocale).
let current: Lang = 'en';

/** Resolve the language purely from the extension setting. Unknown/absent → 'en' (the default). */
export function resolveLocale(): Lang {
  const v = vscode.workspace.getConfiguration('winformsDesigner').get<string>('language', 'en');
  return (SUPPORTED as readonly string[]).includes(v) ? (v as Lang) : 'en';
}

/** Refresh the cached active language from settings (or set explicitly). Call at activation + on change. */
export function setLocale(lang?: Lang): void {
  current = lang ?? resolveLocale();
}

/** The active language. */
export function currentLang(): Lang {
  return current;
}

function lookup(key: string): string | Plural | undefined {
  return CATALOGS[current]?.[key] ?? CATALOGS.en[key];
}

function interpolate(s: string, params?: Record<string, unknown>): string {
  return params ? s.replace(/\{(\w+)\}/g, (_m, name) => String(params[name] ?? '')) : s;
}

/**
 * Translate a simple string key in the active language. `{name}` slots are filled from `params`.
 * Missing key → English fallback → the raw key (a visible marker that a string wasn't extracted/translated).
 */
export function t(key: string, params?: Record<string, unknown>): string {
  const e = lookup(key);
  if (e == null) return key;
  return interpolate(typeof e === 'string' ? e : e.other, params);
}

/**
 * Translate a pluralized key by count `n`, using the active locale's CLDR plural rules. `n` is also exposed
 * to the string as the `{n}` slot. If the entry is a plain string it is used as-is (with `{n}` filled).
 */
export function tn(key: string, n: number, params?: Record<string, unknown>): string {
  const e = lookup(key);
  if (e == null) return key;
  if (typeof e === 'string') return interpolate(e, { ...params, n });
  const cat = new Intl.PluralRules(current).select(n) as keyof Plural;
  return interpolate((e[cat] ?? e.other) as string, { ...params, n });
}

/**
 * A `<script>` tag that hands the active language + a resolved catalog to a webview (Layer B delivery). The
 * catalog is `en` merged with the active locale so a missing translation falls back to English at inject time
 * (the webview shim only has to fall back to the raw key). Must be inserted (under the SAME `nonce` as the CSP)
 * immediately before the webview's own `<script src=…>` so its `t()`/`tn()` shim can read the globals. `<` is
 * escaped so a value containing `</…>` (e.g. the `<code>` placeholder strings) can't prematurely close the tag.
 */
export function injectL10nScript(nonce: string): string {
  const merged: Catalog = { ...en, ...CATALOGS[current] };
  const payload = JSON.stringify(merged).replace(/</g, '\\u003c');
  const lang = JSON.stringify(current);
  return `<script nonce="${nonce}">window.__WFD_LANG__=${lang};window.__WFD_L10N__=${payload};</script>`;
}
