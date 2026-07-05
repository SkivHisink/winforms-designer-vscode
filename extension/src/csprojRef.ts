/**
 * Pure helpers for the "auto-add a project reference when a control from a browsed / non-referenced
 * assembly is dropped" flow. When the chosen control source is an assembly the form's .csproj doesn't
 * reference, the generated `new Ns.Foo()` won't compile — Visual Studio adds a <Reference> in that case,
 * and so do we. Kept vscode-free (only node `fs`/`path`) so the parsing/insertion logic is unit-testable
 * headless (see src/e2e.ts); the vscode glue lives in designerEditor.ts.
 */
import * as fs from 'fs';
import * as path from 'path';

/**
 * Walk up from `startDir` and return the first directory's `*.csproj` (alphabetically first when several),
 * or null. Bounded by `stopDir` (inclusive — the workspace folder, so we never edit a project above it) and
 * a hard depth cap. A directory that can't be read ends the walk.
 */
export function findNearestCsproj(startDir: string, stopDir?: string): string | null {
  const stop = stopDir ? path.resolve(stopDir) : null;
  let dir = path.resolve(startDir);
  for (let i = 0; i < 40; i++) {
    let entries: string[];
    try { entries = fs.readdirSync(dir); } catch { return null; }
    const csprojs = entries.filter((e) => /\.csproj$/i.test(e)).sort((a, b) => a.localeCompare(b));
    if (csprojs.length) return path.join(dir, csprojs[0]);
    if (stop && dir === stop) return null; // reached the workspace folder without a match — don't climb out
    const parent = path.dirname(dir);
    if (parent === dir) return null; // filesystem root
    dir = parent;
  }
  return null;
}

/** The assembly a .csproj produces: its <AssemblyName>, or the project file name without the extension. */
export function projectAssemblyName(csprojText: string, csprojPath: string): string {
  const m = /<AssemblyName>\s*([^<]+?)\s*<\/AssemblyName>/i.exec(csprojText);
  if (m) return m[1].trim();
  return path.basename(csprojPath).replace(/\.csproj$/i, '');
}

/**
 * True when the .csproj already brings in `assemblyName` by NAME — via a <Reference> (plain or strong-named),
 * a <ProjectReference> whose Include file base name matches, or a <PackageReference>. String-only (no file
 * reads): it can miss a <ProjectReference> to a project whose <AssemblyName> differs from its .csproj file
 * name — use `projectReferencesAssembly` (which resolves that) for the offer/write gate. Deliberately loose:
 * a match by simple name / file base name is enough.
 */
export function csprojReferencesAssembly(csprojText: string, assemblyName: string): boolean {
  const target = assemblyName.trim().toLowerCase();
  if (!target) return false;
  const re = /<(?:Reference|ProjectReference|PackageReference)\b[^>]*\bInclude\s*=\s*"([^"]+)"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(csprojText)) !== null) {
    const include = m[1].trim();
    const candidates = new Set<string>([include.toLowerCase()]);
    const comma = include.indexOf(','); // strong name "Name, Version=…, Culture=…"
    if (comma >= 0) candidates.add(include.slice(0, comma).trim().toLowerCase());
    const base = include.replace(/\\/g, '/').split('/').pop() ?? include; // path → file name
    candidates.add(base.toLowerCase());
    candidates.add(base.replace(/\.(csproj|dll)$/i, '').toLowerCase()); // strip .csproj / .dll
    if (candidates.has(target)) return true;
  }
  return false;
}

/**
 * True when `assemblyName` is ALREADY brought into the .csproj at `csprojPath` — the authoritative gate for
 * offering / writing a reference. Beyond the name-level match (`csprojReferencesAssembly`), this resolves each
 * `<ProjectReference>` by READING the pointed-to .csproj and comparing its produced assembly (its
 * <AssemblyName>, or file name) — so a ProjectReference to a project whose <AssemblyName> differs from its
 * file name is still recognized, and we don't write a redundant <Reference> next to it.
 */
export function projectReferencesAssembly(csprojText: string, csprojPath: string, assemblyName: string): boolean {
  if (csprojReferencesAssembly(csprojText, assemblyName)) return true;
  const target = assemblyName.trim().toLowerCase();
  if (!target) return false;
  const dir = path.dirname(csprojPath);
  const re = /<ProjectReference\b[^>]*\bInclude\s*=\s*"([^"]+)"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(csprojText)) !== null) {
    const rel = m[1].trim().replace(/[\\/]/g, path.sep); // MSBuild uses backslashes; normalize for this OS
    const refPath = path.resolve(dir, rel);
    let refText: string;
    try { refText = fs.readFileSync(refPath, 'utf8'); } catch { continue; } // unreadable/missing → can't confirm
    if (projectAssemblyName(refText, refPath).toLowerCase() === target) return true;
  }
  return false;
}

/** The project's <TargetFramework> (or first of <TargetFrameworks>), or null. e.g. "net48", "net9.0-windows". */
export function projectTargetFramework(csprojText: string): string | null {
  const single = /<TargetFramework>\s*([^<]+?)\s*<\/TargetFramework>/i.exec(csprojText);
  if (single) return single[1].trim();
  const multi = /<TargetFrameworks>\s*([^<]+?)\s*<\/TargetFrameworks>/i.exec(csprojText);
  if (multi) return multi[1].split(';').map((s) => s.trim()).filter(Boolean)[0] ?? null;
  return null;
}

/** True for a .NET Framework TFM (net4x / net35 / net20) — the projects the net48 engine renders. */
export function isFrameworkTfm(tfm: string | null | undefined): boolean {
  return !!tfm && /^net(2|3|4)\d?\d?$/i.test(tfm.trim());
}

/**
 * True when the project MULTI-targets and at least one target is .NET Framework — the T1.3 cross-runtime case:
 * a `<TargetFrameworks>` (plural) list with more than one entry that includes a net4x TFM (e.g.
 * "net48;net9.0-windows"). Such a project builds BOTH a net9 and a net48 output, so when the net9 engine
 * renders a vendor form near-empty we can fall back to the net48 compiled preview. A single-target net4x
 * project (`<TargetFramework>net48`) is not this case — it's routed to net48 up front (see resolveRouting).
 */
export function multiTargetHasFramework(csprojText: string): boolean {
  // Strip XML comments first so a commented-out `<TargetFrameworks>` (a common migration leftover) isn't read as
  // live config (mirrors rootCloseOffset's comment-skipping). The opening tag may carry attributes (e.g. a
  // Condition), so allow them — else a conditioned multi-target project would never get the fallback offer.
  const m = /<TargetFrameworks(?:\s[^>]*)?>\s*([^<]+?)\s*<\/TargetFrameworks>/i.exec(stripXmlComments(csprojText));
  if (!m) return false;
  const tfms = m[1].split(';').map((s) => s.trim()).filter(Boolean);
  return tfms.length > 1 && tfms.some(isFrameworkTfm);
}

/** Remove XML comments (`<!-- … -->`) from csproj text so a commented-out element isn't matched as live config. */
function stripXmlComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, '');
}

/** True when the assembly at `assemblyPath` has NO .NET (Core) sidecar (`.deps.json`/`.runtimeconfig.json`) —
 *  i.e. it's a .NET Framework build that only the net48 engine can load. Mirrors the host's detectEngineKind. */
function isFrameworkBuild(assemblyPath: string): boolean {
  const base = assemblyPath.replace(/\.(dll|exe)$/i, '');
  try { return !(fs.existsSync(base + '.deps.json') || fs.existsSync(base + '.runtimeconfig.json')); }
  catch { return true; }
}

/** Every `<AssemblyName>.exe|dll` under the project's bin/ (depth-capped), freshest first, each tagged whether
 *  it's a .NET Framework build (no Core sidecar). Shared walk behind the two output resolvers below. */
function collectBuildOutputs(csprojPath: string): { path: string; mtime: number; framework: boolean }[] {
  let text: string;
  try { text = fs.readFileSync(csprojPath, 'utf8'); } catch { return []; }
  const asm = projectAssemblyName(text, csprojPath).toLowerCase();
  const binDir = path.join(path.dirname(csprojPath), 'bin');
  const hits: { path: string; mtime: number; framework: boolean }[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 4) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full, depth + 1); continue; }
      const lower = e.name.toLowerCase();
      if (lower === asm + '.exe' || lower === asm + '.dll') {
        try { hits.push({ path: full, mtime: fs.statSync(full).mtimeMs, framework: isFrameworkBuild(full) }); } catch { /* ignore */ }
      }
    }
  };
  walk(binDir, 0);
  hits.sort((a, b) => b.mtime - a.mtime); // freshest build wins (Debug vs Release, net48 vs net9)
  return hits;
}

/**
 * Locate a project's build output (`<AssemblyName>.exe|dll`, freshest under bin/) — used for .NET Framework
 * projects, whose output the net9 engine's resolver deliberately refuses (can't load net4x) and whose bin
 * search only looks for `.dll`. This covers OutputType=Exe (net48 WinForms apps), so a Framework control
 * source resolves for the net48 engine — and fixes the "Could not resolve build output" the user hit picking
 * a net48 project. Returns undefined when nothing built yet.
 */
export function resolveFrameworkOutput(csprojPath: string): string | undefined {
  return collectBuildOutputs(csprojPath)[0]?.path; // freshest overall (unchanged semantics)
}

/**
 * The freshest .NET FRAMEWORK build output of a project (the net4x-flavored `<asm>.exe|dll`, identified by the
 * ABSENCE of a `.deps.json`/`.runtimeconfig.json` sidecar), or undefined when none is built. For a MULTI-target
 * project this picks the net48 output even when a (net9) Core output is newer — the assembly the net48 compiled-
 * preview engine can load when net9 renders a vendor form near-empty (T1.3 cross-runtime fallback).
 */
export function resolveFrameworkOnlyOutput(csprojPath: string): string | undefined {
  return collectBuildOutputs(csprojPath).find((h) => h.framework)?.path;
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** The dominant EOL of a text (majority of \r\n vs bare \n) — so inserting into a mostly-LF file that has one
 *  stray CRLF doesn't introduce a CRLF block (and a pure-CRLF file still stays CRLF). */
function dominantEol(text: string): string {
  const crlf = (text.match(/\r\n/g) || []).length;
  const bareLf = (text.match(/\n/g) || []).length - crlf;
  return crlf > bareLf ? '\r\n' : '\n';
}

/** The offset of the ROOT-closing `</Project>` — the last one that isn't inside an XML comment (so a stray
 *  `</Project>` in a trailing/commented-out block doesn't divert an insert into a comment). -1 when none. */
function rootCloseOffset(text: string): number {
  for (let from = text.length; ;) {
    const at = text.lastIndexOf('</Project>', from);
    if (at < 0) return -1;
    const open = text.lastIndexOf('<!--', at);
    const close = open >= 0 ? text.indexOf('-->', open) : -1;
    const insideComment = open >= 0 && (close < 0 || close > at);
    if (!insideComment) return at;
    from = at - 1;
  }
}

/**
 * Return the .csproj text with a new `<ItemGroup>` holding `<Reference Include="includeName"><HintPath>…`
 * inserted just before the ROOT `</Project>` (SDK-style projects allow reference ItemGroups anywhere). The
 * file's dominant EOL style is preserved. If there's no `</Project>` (malformed) the group is appended.
 */
export function addReferenceToCsproj(csprojText: string, includeName: string, hintPath: string): string {
  const eol = dominantEol(csprojText);
  const snippet = [
    '  <ItemGroup>',
    `    <Reference Include="${xmlEscape(includeName)}">`,
    `      <HintPath>${xmlEscape(hintPath)}</HintPath>`,
    '    </Reference>',
    '  </ItemGroup>',
  ].join(eol);
  const idx = rootCloseOffset(csprojText);
  if (idx < 0) return csprojText + eol + snippet + eol;
  let before = csprojText.slice(0, idx).replace(/[ \t]+$/, ''); // drop the indent that preceded </Project>
  const after = csprojText.slice(idx);
  if (!/[\r\n]$/.test(before)) before += eol;
  return before + snippet + eol + after;
}
