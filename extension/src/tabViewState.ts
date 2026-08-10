export type SelectedTabState = Record<string, string>;

const MAX_TAB_SELECTIONS = 128;
const MAX_TAB_ID_LENGTH = 256;

function safeTabId(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_TAB_ID_LENGTH) return undefined;
  // The engine protocol encodes an entry as host=page. Control characters and '=' cannot be represented safely.
  if (/[=\u0000-\u001f\u007f]/.test(value)) return undefined;
  return value;
}

/** Sanitize workspace metadata before it reaches an engine request. The engine still resolves every id exactly and
* validates TabControl -> TabPage membership; this host-side bound prevents untrusted/stale memento growth. */
export function sanitizeSelectedTabs(value: unknown): SelectedTabState | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const result: SelectedTabState = {};
  let count = 0;
  for (const [rawHost, rawPage] of Object.entries(value as Record<string, unknown>)) {
    if (count >= MAX_TAB_SELECTIONS) break;
    const host = safeTabId(rawHost);
    const page = safeTabId(rawPage);
    if (!host || !page || host === '__proto__' || host === 'constructor' || host === 'prototype') continue;
    result[host] = page;
    count++;
  }
  return result;
}

/** Serialize a session map through the same bound used for restored workspace data. */
export function selectedTabsFromEntries(entries: Iterable<readonly [string, string]>): SelectedTabState {
  return sanitizeSelectedTabs(Object.fromEntries(entries)) ?? {};
}
