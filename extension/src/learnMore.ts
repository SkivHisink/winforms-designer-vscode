// Pure "Learn More Online" URL builder. Extracted so the routing is unit-testable in e2e.ts (the designer editor class
// itself is F5-only), mirroring the other extracted host helpers (selection, renderDiagnostics, csprojRef).

/** Build the docs URL for a control type's "Learn More Online" action.
 *  - a System.* / Microsoft.* fully-qualified type → its .NET API reference page (learn.microsoft.com/dotnet/api/<fqn>).
 *  - any OTHER fully-qualified type (DevExpress.*, Telerik.*, a user's own namespace, …) → a web search for the type
 *    name. Microsoft Learn has no /dotnet/api page for third-party controls, so the old unconditional
 *    /dotnet/api/<fqn> 404'd for e.g. DevExpress.XtraTab.XtraTabControl; a search reliably lands on the vendor's docs.
 *  - an unknown/short/blank name → the WinForms hub. */
export function learnMoreUrl(typeName?: string): string {
  const t = (typeName ?? '').trim();
  const dotted = /^[\w.]+\.[\w.]+$/.test(t);
  if (dotted && /^(System|Microsoft)\./.test(t)) return `https://learn.microsoft.com/dotnet/api/${t.toLowerCase()}`;
  if (dotted) return `https://www.bing.com/search?q=${encodeURIComponent(t)}`;
  return 'https://learn.microsoft.com/dotnet/desktop/winforms/';
}
