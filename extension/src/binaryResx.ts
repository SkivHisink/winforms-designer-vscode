// 0.10.0 trust-floor S3 — host-side detector for BinaryFormatter/SOAP/ImageStream resources in a form's .resx.
//
// The net9 engine can't materialize these (BinaryFormatter is refused; ImageList.ImageStream serializes as a
// BinaryFormatter blob), so a .resx-regenerating write would DROP them = silent data loss. The extension never
// regenerates the .resx today (image import is a scoped XML upsert that preserves every other node), but this
// detector lets the write path VERIFY that invariant at the moment of writing — a fail-closed tripwire so a future
// refactor of the upsert can't silently regress into loss.
//
// Pure (no vscode / no I/O). It keys on the SAME mimetype substrings the engine's ScanBinaryKeys uses
// (engine/DesignerResx.cs), so host and engine agree by construction.
//
// The COUNT is the tripwire's primary signal: it matches the binary/SOAP mimetype ATTRIBUTE, which never contains a
// quote or a '>', so it is robust to attribute order, single/double quotes, whitespace, uppercase, malformed XML, a
// '>' inside another attribute value, nameless nodes, and duplicate names — every case where a name-keyed scan could
// MISS a node (codex R#2). If the write would leave fewer binary nodes than are on disk, a node was dropped → refuse.

const BINARY_MIME = /mimetype\s*=\s*["'][^"']*(?:binary\.base64|soap\.base64)/gi;

// Decode XML numeric character references (&#46; / &#x2e;) so a mimetype written `binary&#x2e;base64` — which an XML
// parser (the engine) decodes to `binary.base64` — is still recognized by the raw-text scan (codex R: char-ref
// mismatch). base64 <value> content has no '&', so this only affects attribute text; it's a cheap O(n) pass.
function decodeCharRefs(s: string): string {
  if (s.indexOf('&#') < 0) return s;
  return s.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
          .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)));
}

/** How many BinaryFormatter/SOAP/ImageStream resources the .resx holds. Robust (see file header). */
export function binaryResxCount(resxText: string | null | undefined): number {
  if (!resxText) return 0;
  const m = decodeCharRefs(resxText).match(BINARY_MIME);
  return m ? m.length : 0;
}

/** Names of `<data …>` nodes serialized via BinaryFormatter/SOAP (best-effort; for diagnostics/tests, not the guard —
 *  the guard uses the robust count). A '>' inside an attribute value or a nameless node can make this under-report,
 *  which is exactly why the tripwire keys on binaryResxCount, not this set. */
export function binaryResxKeys(resxText: string | null | undefined): Set<string> {
  const keys = new Set<string>();
  if (!resxText) return keys;
  const dataTag = /<data\b([^>]*)>/gi;
  let m: RegExpExecArray | null;
  while ((m = dataTag.exec(resxText)) !== null) {
    const attrs = m[1];
    if (!/mimetype\s*=\s*["'][^"']*(?:binary\.base64|soap\.base64)/i.test(attrs)) continue;
    const nameMatch = /\bname\s*=\s*["']([^"']*)["']/i.exec(attrs);
    if (nameMatch) keys.add(nameMatch[1]);
  }
  return keys;
}

/** True when the .resx holds at least one BinaryFormatter/SOAP/ImageStream resource. */
export function hasBinaryResx(resxText: string | null | undefined): boolean {
  return binaryResxCount(resxText) > 0;
}
