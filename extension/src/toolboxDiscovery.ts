import * as fs from 'fs';
import * as path from 'path';
import { performance } from 'perf_hooks';

const MAX_PROBE_ASSEMBLIES = 256;
const MAX_REGISTERED_ASSEMBLIES = 512;

const DEFAULT_BUILD_OUTPUT_DISCOVERY_LIMITS = {
  maxFiles: 1024,
  maxDirectories: 256,
  maxDepth: 4,
  maxMilliseconds: 750,
  yieldEveryDirectories: 16
} as const;

export interface BuildOutputAssemblyCandidate {
  path: string;
  size: number;
  mtimeMs: number;
  key: string;
}

export interface BuildOutputDiscoveryBudgets {
  maxFiles: number;
  maxDirectories: number;
  maxDepth: number;
  maxMilliseconds: number;
  yieldEveryDirectories: number;
}

export interface BuildOutputDiscoverySkipped {
  duplicateRoots: number;
  missingRoots: number;
  inaccessibleDirectories: number;
  inaccessibleFiles: number;
  duplicateAssemblies: number;
  filesByBudget: number;
  directoriesByBudget: number;
  directoriesByDepth: number;
  timeBudget: number;
  cancelled: number;
}

export interface BuildOutputDiscoveryResult {
  assemblies: BuildOutputAssemblyCandidate[];
  scannedDirectories: string[];
  budgets: BuildOutputDiscoveryBudgets;
  skipped: BuildOutputDiscoverySkipped;
  truncated: boolean;
  cancelled: boolean;
}

export interface BuildOutputDiscoveryOptions {
  maxFiles?: number;
  maxDirectories?: number;
  maxDepth?: number;
  maxMilliseconds?: number;
  yieldEveryDirectories?: number;
  shouldCancel?: () => boolean;
  now?: () => number;
  yieldNow?: () => Promise<void>;
}

export interface ProjectBuildOutputRootOptions {
  maxProjects?: number;
  yieldEveryProjects?: number;
  shouldCancel?: () => boolean;
  yieldNow?: () => Promise<void>;
}

export interface ProjectBuildOutputRootResult {
  roots: string[];
  projects: string[];
  skippedProjects: number;
  skippedReferences: number;
  missingBuildOutputs: number;
  projectBudgetReached: boolean;
  cancelled: boolean;
}

function normalized(value: string): string {
  const full = path.normalize(value);
  return process.platform === 'win32' ? full.toLowerCase() : full;
}

/**
 * Return the conventional bin/ root plus bounded literal output roots declared directly in a project. Full MSBuild
 * property evaluation belongs to the engine resolver; this host-side discovery deliberately accepts only concrete
 * paths so an untrusted $(Property) cannot expand into an unexpected workspace-wide traversal. Scanning below the
 * declared root naturally covers configuration and TFM subdirectories.
 */
function projectBuildOutputDirectories(project: string, projectText: string): string[] {
  const projectDirectory = path.dirname(project);
  const candidates = [path.join(projectDirectory, 'bin')];
  const withoutComments = projectText.replace(/<!--[\s\S]*?-->/g, '');
  const outputPath = /<(BaseOutputPath|OutputPath|OutDir)\b[^>]*>\s*([^<]+?)\s*<\/\1>/gi;
  for (let match = outputPath.exec(withoutComments); match !== null && candidates.length < 16;
    match = outputPath.exec(withoutComments)) {
    const raw = match[2].trim();
    if (!raw || /\$\(|%\(/.test(raw)) continue;
    const decoded = raw.replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&apos;/gi, "'");
    try { candidates.push(path.resolve(projectDirectory, decoded.replace(/[\\/]/g, path.sep))); }
    catch { /* malformed literal output paths are skipped without widening discovery */ }
  }

  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = normalized(candidate);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeBudget(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function buildOutputBudgets(options: BuildOutputDiscoveryOptions): BuildOutputDiscoveryBudgets {
  return {
    maxFiles: normalizeBudget(options.maxFiles, DEFAULT_BUILD_OUTPUT_DISCOVERY_LIMITS.maxFiles),
    maxDirectories: normalizeBudget(options.maxDirectories, DEFAULT_BUILD_OUTPUT_DISCOVERY_LIMITS.maxDirectories),
    maxDepth: normalizeBudget(options.maxDepth, DEFAULT_BUILD_OUTPUT_DISCOVERY_LIMITS.maxDepth),
    maxMilliseconds: normalizeBudget(options.maxMilliseconds, DEFAULT_BUILD_OUTPUT_DISCOVERY_LIMITS.maxMilliseconds),
    yieldEveryDirectories: Math.max(1,
      normalizeBudget(options.yieldEveryDirectories, DEFAULT_BUILD_OUTPUT_DISCOVERY_LIMITS.yieldEveryDirectories))
  };
}

function emptySkipped(): BuildOutputDiscoverySkipped {
  return {
    duplicateRoots: 0,
    missingRoots: 0,
    inaccessibleDirectories: 0,
    inaccessibleFiles: 0,
    duplicateAssemblies: 0,
    filesByBudget: 0,
    directoriesByBudget: 0,
    directoriesByDepth: 0,
    timeBudget: 0,
    cancelled: 0
  };
}

function defaultYieldNow(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Derive build-output roots only from the project that owns the open designer and its explicit ProjectReference
 * graph. This prevents a default-on toolbox refresh from walking unrelated sibling projects in a monorepo while
 * still finding controls produced by the projects the form can actually reference.
 */
/**
 * Whether a changed text document represents the user editing their code. VS Code raises the same
 * onDidChangeTextDocument for its OWN output channels, so a visible extension log would otherwise retrigger
 * background discovery on every line it prints — and each pass prints another line.
 */
export function isUserEditDocument(scheme: string): boolean {
  return scheme === 'file' || scheme === 'untitled';
}

export async function discoverProjectBuildOutputRoots(
  owningProject: string,
  options: ProjectBuildOutputRootOptions = {}
): Promise<ProjectBuildOutputRootResult> {
  const maxProjects = normalizeBudget(options.maxProjects, 64);
  const yieldEveryProjects = Math.max(1, normalizeBudget(options.yieldEveryProjects, 8));
  const yieldNow = options.yieldNow ?? defaultYieldNow;
  const result: ProjectBuildOutputRootResult = {
    roots: [],
    projects: [],
    skippedProjects: 0,
    skippedReferences: 0,
    missingBuildOutputs: 0,
    projectBudgetReached: false,
    cancelled: false,
  };
  if (!owningProject) {
    result.skippedProjects++;
    return result;
  }

  const queue = [path.resolve(owningProject)];
  const queued = new Set(queue.map(normalized));
  const outputRoots = new Set<string>();
  while (queue.length) {
    if (options.shouldCancel?.()) {
      result.cancelled = true;
      return result;
    }
    if (result.projects.length >= maxProjects) {
      result.projectBudgetReached = true;
      return result;
    }

    const project = queue.shift()!;
    let text: string;
    try { text = await fs.promises.readFile(project, 'utf8'); }
    catch {
      result.skippedProjects++;
      continue;
    }
    result.projects.push(project);

    let foundBuildOutput = false;
    for (const output of projectBuildOutputDirectories(project, text)) {
      try {
        if (!(await fs.promises.stat(output)).isDirectory()) continue;
        foundBuildOutput = true;
        const outputKey = normalized(output);
        if (!outputRoots.has(outputKey)) {
          outputRoots.add(outputKey);
          result.roots.push(output);
        }
      } catch { /* another literal root for this project may still exist */ }
    }
    if (!foundBuildOutput) result.missingBuildOutputs++;

    const withoutComments = text.replace(/<!--[\s\S]*?-->/g, '');
    const reference = /<ProjectReference\b[^>]*\bInclude\s*=\s*(["'])([^"']+)\1/gi;
    for (let match = reference.exec(withoutComments); match !== null; match = reference.exec(withoutComments)) {
      const include = match[2].trim();
      if (!include || /\$\(|%\(/.test(include) || !/\.csproj$/i.test(include)) {
        result.skippedReferences++;
        continue;
      }
      let resolved: string;
      try { resolved = path.resolve(path.dirname(project), include.replace(/[\\/]/g, path.sep)); }
      catch {
        result.skippedReferences++;
        continue;
      }
      const key = normalized(resolved);
      if (queued.has(key)) continue;
      queued.add(key);
      queue.push(resolved);
    }

    if (result.projects.length % yieldEveryProjects === 0) await yieldNow();
  }
  return result;
}

function candidateKey(fullPath: string, stat: fs.Stats): string {
  return `${normalized(fullPath)}|${stat.size}|${Math.trunc(stat.mtimeMs)}`;
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

/**
 * Metadata-only discovery for assemblies under caller-selected build output roots. This intentionally does not derive
 * roots from the workspace and never loads assemblies; callers must pass concrete bin/obj/package output directories.
 */
export async function discoverBuildOutputAssemblies(
  buildOutputRoots: readonly string[],
  options: BuildOutputDiscoveryOptions = {}
): Promise<BuildOutputDiscoveryResult> {
  const budgets = buildOutputBudgets(options);
  const now = options.now ?? (() => performance.now());
  const yieldNow = options.yieldNow ?? defaultYieldNow;
  const start = now();
  const skipped = emptySkipped();
  const assemblies: BuildOutputAssemblyCandidate[] = [];
  const scannedDirectories: string[] = [];
  const seenRoots = new Set<string>();
  const seenAssemblies = new Set<string>();
  let filesScanned = 0;
  let truncated = false;
  let cancelled = false;

  const queue: Array<{ dir: string; depth: number }> = [];
  for (const root of buildOutputRoots) {
    if (!root) {
      skipped.missingRoots++;
      continue;
    }
    let full: string;
    try { full = path.resolve(root); } catch {
      skipped.missingRoots++;
      continue;
    }
    const rootKey = normalized(full);
    if (seenRoots.has(rootKey)) {
      skipped.duplicateRoots++;
      continue;
    }
    seenRoots.add(rootKey);
    try {
      const stat = await fs.promises.stat(full);
      if (!stat.isDirectory()) {
        skipped.missingRoots++;
        continue;
      }
    } catch {
      skipped.missingRoots++;
      continue;
    }
    queue.push({ dir: full, depth: 0 });
  }

  while (queue.length) {
    if (options.shouldCancel?.()) {
      cancelled = true;
      truncated = true;
      skipped.cancelled++;
      break;
    }
    if (now() - start >= budgets.maxMilliseconds) {
      truncated = true;
      skipped.timeBudget++;
      break;
    }

    const current = queue.shift()!;
    if (current.depth > budgets.maxDepth) {
      skipped.directoriesByDepth++;
      truncated = true;
      continue;
    }
    if (scannedDirectories.length >= budgets.maxDirectories) {
      skipped.directoriesByBudget += 1 + queue.length;
      truncated = true;
      break;
    }

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(current.dir, { withFileTypes: true });
    } catch {
      skipped.inaccessibleDirectories++;
      continue;
    }
    scannedDirectories.push(current.dir);
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const full = path.join(current.dir, entry.name);
      if (entry.isDirectory()) {
        if (current.depth >= budgets.maxDepth) {
          skipped.directoriesByDepth++;
          truncated = true;
        } else {
          queue.push({ dir: full, depth: current.depth + 1 });
        }
        continue;
      }

      if (!entry.isFile() || !/\.dll$/i.test(entry.name)) continue;
      if (filesScanned >= budgets.maxFiles) {
        skipped.filesByBudget++;
        truncated = true;
        continue;
      }
      filesScanned++;

      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(full);
      } catch {
        skipped.inaccessibleFiles++;
        continue;
      }
      if (!stat.isFile()) continue;

      const assemblyPathKey = normalized(full);
      if (seenAssemblies.has(assemblyPathKey)) {
        skipped.duplicateAssemblies++;
        continue;
      }
      seenAssemblies.add(assemblyPathKey);
      assemblies.push({
        path: full,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        key: candidateKey(full, stat)
      });
    }

    if (scannedDirectories.length % budgets.yieldEveryDirectories === 0) await yieldNow();
  }

  return {
    assemblies,
    scannedDirectories,
    budgets,
    skipped,
    truncated,
    cancelled
  };
}
