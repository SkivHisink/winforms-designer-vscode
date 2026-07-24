import * as fs from 'fs';
import * as path from 'path';

const MAX_PROBE_ASSEMBLIES = 256;
const MAX_REGISTERED_ASSEMBLIES = 512;

function normalized(value: string): string {
  const full = path.normalize(value);
  return process.platform === 'win32' ? full.toLowerCase() : full;
}

function dllsBelow(root: string, maxDepth: number, maxItems: number, acceptTop?: (name: string) => boolean): string[] {
  if (!root || !fs.existsSync(root)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const stack: Array<{ dir: string; depth: number; top: string }> = [{ dir: root, depth: 0, top: '' }];
  while (stack.length && out.length < maxItems) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(current.dir, { withFileTypes: true }); } catch { continue; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (out.length >= maxItems) break;
      const top = current.depth === 0 ? entry.name : current.top;
      if (current.depth === 0 && acceptTop && !acceptTop(top)) continue;
      const full = path.join(current.dir, entry.name);
      if (entry.isDirectory() && current.depth < maxDepth) {
        stack.push({ dir: full, depth: current.depth + 1, top });
      } else if (entry.isFile() && /\.dll$/i.test(entry.name)) {
        const key = normalized(full);
        if (!seen.has(key)) { seen.add(key); out.push(full); }
      }
    }
  }
  return out;
}

/** Assemblies in explicit probe directories. Two levels covers normal vendor layouts (`bin`, `lib/net48`) without
 * recursively walking an SDK tree forever; the result is deliberately bounded before any reflection occurs. */
export function discoverProbeAssemblies(probeDirectories: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const dir of probeDirectories) {
    for (const dll of dllsBelow(dir, 2, MAX_PROBE_ASSEMBLIES - out.length)) {
      const key = normalized(dll);
      if (!seen.has(key)) { seen.add(key); out.push(dll); }
    }
    if (out.length >= MAX_PROBE_ASSEMBLIES) break;
  }
  return out;
}

const FRAMEWORK_PREFIX = /^(System(?:\.|$)|Microsoft(?:\.|$)|mscorlib$|netstandard$|Accessibility$|WindowsBase$|Presentation)/i;

/** Third-party assemblies registered in the machine-wide .NET Framework GAC. Framework/Microsoft assemblies are
 * already represented by the engine's cached standard candidate set, so filtering them keeps this scan useful and
 * bounded while surfacing installed control suites. */
export function discoverRegisteredAssemblies(windowsDirectory = process.env.WINDIR ?? ''): string[] {
  if (!windowsDirectory) return [];
  const assemblyRoot = path.join(windowsDirectory, 'Microsoft.NET', 'assembly');
  const roots = ['GAC_MSIL', 'GAC_32', 'GAC_64'].map((name) => path.join(assemblyRoot, name));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    for (const dll of dllsBelow(root, 3, MAX_REGISTERED_ASSEMBLIES - out.length,
      (top) => !FRAMEWORK_PREFIX.test(top))) {
      const key = normalized(dll);
      if (!seen.has(key)) { seen.add(key); out.push(dll); }
    }
    if (out.length >= MAX_REGISTERED_ASSEMBLIES) break;
  }
  return out;
}

export function uniqueAssemblyPaths(paths: readonly (string | undefined)[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of paths) {
    if (!value || !/\.dll$/i.test(value)) continue;
    let full: string;
    try { full = path.resolve(value); } catch { continue; }
    if (!fs.existsSync(full)) continue;
    const key = normalized(full);
    if (!seen.has(key)) { seen.add(key); out.push(full); }
  }
  return out;
}
