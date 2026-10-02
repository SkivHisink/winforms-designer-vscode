import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export type CompatibilityArchitecture = 'x86' | 'x64' | 'arm64' | 'anycpu' | 'unknown';
export type CompatibilityRuntime = 'modern' | 'net48';
export type ProjectCompatibilityCode = 'WORKSPACE_TRUST_REQUIRED' | 'ARCHITECTURE_UNKNOWN'
  | 'DEPENDENCY_ARCHITECTURE_MISMATCH' | 'OUTPUT_ARCHITECTURE_MISMATCH' | 'OUTPUT_NOT_MANAGED'
  | 'DEPENDENCY_ARCHITECTURE_UNKNOWN' | 'ARCHITECTURE_COMPATIBLE' | 'PROJECT_ARCHITECTURE_MISMATCH';
export interface ProjectCompatibilityOptions {
  projectPath?: string;
  assemblyPath?: string;
  runtime: CompatibilityRuntime;
  trusted: boolean;
  configuration?: string;
  platform?: string;
  targetFramework?: string;
  workerArchitecture?: Exclude<CompatibilityArchitecture, 'anycpu'>;
  /** Known load dependencies only; do not pass every architecture variant in a package. */
  nativeDependencyPaths?: readonly string[];
}
export interface EvaluatedProjectArchitecture {
  configuration: string;
  platform: string;
  targetFramework: string;
  platformTarget: string;
  prefer32Bit: boolean | null;
  targetPath: string;
  knownDependencyPaths: string[];
  importPaths: string[];
}
export interface PeArchitectureEvidence {
  architecture: CompatibilityArchitecture;
  managed: boolean | null;
  machine?: number;
  corFlags?: number;
  requires32Bit?: boolean;
  prefers32Bit?: boolean;
  isDll?: boolean;
  reason: string;
}
export interface ProjectCompatibilityResult {
  /** This is an architecture check, never certification of runtime/vendor/native availability. */
  status: 'compatible' | 'incompatible' | 'unknown';
  code: ProjectCompatibilityCode;
  message: string;
  workerArchitecture: Exclude<CompatibilityArchitecture, 'anycpu'>;
  evaluated?: EvaluatedProjectArchitecture;
  output?: PeArchitectureEvidence & { path: string };
  nativeDependencies: Array<PeArchitectureEvidence & { path: string }>;
  limitations: string[];
  /** Cache invalidation hints, not a complete file dependency graph. New imports still require refresh. */
  observedPaths: string[];
}
export type ProjectEvaluationRequest = ProjectCompatibilityOptions & { projectPath: string };
export type ProjectEvaluationResult =
  | { ok: true; project: EvaluatedProjectArchitecture }
  | { ok: false; reason: string };
export interface ProjectCompatibilityDependencies {
  evaluate?: (request: ProjectEvaluationRequest) => Promise<ProjectEvaluationResult>;
  /** Reads at most maxBytes from the start of an image; never loads or executes it. */
  readImage?: (filePath: string, maxBytes: number) => Promise<Uint8Array>;
}

const MAX_IMAGE_BYTES = 1024 * 1024;
const MAX_DEPENDENCIES = 16;
const EVALUATION_BUDGET_MS = 12_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const PROPERTIES = 'Configuration,Platform,TargetFramework,TargetFrameworks,TargetFrameworkVersion,PlatformTarget,Prefer32Bit,TargetPath,MSBuildAllProjects';

function architecture(value: string): CompatibilityArchitecture {
  switch (value.replace(/\s/g, '').toLowerCase()) {
    case 'x86': case 'ia32': return 'x86';
    case 'x64': case 'amd64': return 'x64';
    case 'arm64': return 'arm64';
    case 'anycpu': return 'anycpu';
    default: return 'unknown';
  }
}

/** PE32/I386 alone is not x86: pure IL without Required32Bit is AnyCPU. */
export function inspectPeArchitecture(bytes: Uint8Array): PeArchitectureEvidence {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const unknown = (reason: string): PeArchitectureEvidence => ({ architecture: 'unknown', managed: null, reason });
  const fits = (offset: number, count: number): boolean => offset >= 0 && offset + count <= b.length;
  if (!fits(0, 64) || b.readUInt16LE(0) !== 0x5a4d) return unknown('Missing or truncated DOS header.');
  const pe = b.readUInt32LE(0x3c);
  if (!fits(pe, 24) || b.readUInt32LE(pe) !== 0x4550) return unknown('Missing or truncated PE header.');
  const machine = b.readUInt16LE(pe + 4);
  const sections = b.readUInt16LE(pe + 6);
  const size = b.readUInt16LE(pe + 20);
  const isDll = (b.readUInt16LE(pe + 22) & 0x2000) !== 0;
  const optional = pe + 24;
  if (!fits(optional, size) || size < 2) return unknown('Truncated PE optional header.');
  const magic = b.readUInt16LE(optional);
  const directoryOffset = magic === 0x10b ? 96 : magic === 0x20b ? 112 : 0;
  if (!directoryOffset || size < directoryOffset) return unknown('Unsupported PE optional header.');
  const machineArchitecture = machine === 0x14c ? 'x86' : machine === 0x8664 ? 'x64' : machine === 0xaa64 ? 'arm64' : 'unknown';
  if ((machine === 0x14c && magic !== 0x10b) || ((machine === 0x8664 || machine === 0xaa64) && magic !== 0x20b)) {
    return unknown('Inconsistent PE machine and optional header.');
  }
  // The declared directory count is authoritative; bytes after a short optional header are section data.
  const directoryCount = b.readUInt32LE(optional + directoryOffset - 4);
  if (directoryCount > 14 && size < directoryOffset + 15 * 8) return unknown('Truncated PE data directories.');
  const cliRva = directoryCount > 14 ? b.readUInt32LE(optional + directoryOffset + 14 * 8) : 0;
  if (!cliRva) return { architecture: machineArchitecture, machine, managed: false, isDll, reason: 'Native PE machine architecture.' };
  if (b.readUInt32LE(optional + directoryOffset + 14 * 8 + 4) < 72) return unknown('Truncated CLR data directory.');
  const sectionTable = optional + size;
  if (!fits(sectionTable, sections * 40)) return unknown('Truncated PE section table.');
  let cli = -1;
  const sizeOfHeaders = b.readUInt32LE(optional + 60);
  if (cliRva < sizeOfHeaders) cli = cliRva;
  for (let i = 0; cli < 0 && i < sections; i++) {
    const s = sectionTable + i * 40;
    const start = b.readUInt32LE(s + 12);
    const rawSize = b.readUInt32LE(s + 16);
    const delta = cliRva - start;
    if (delta >= 0 && delta + 72 <= rawSize) cli = b.readUInt32LE(s + 20) + delta;
  }
  if (!fits(cli, 72) || b.readUInt32LE(cli) < 72) return unknown('CLR header is invalid or outside the bounded image read.');
  const corFlags = b.readUInt32LE(cli + 16);
  const prefers32Bit = (corFlags & 0x20000) !== 0;
  // The compiler encodes AnyCPU/prefer32 as both bits. Preference is not a hard EXE load requirement.
  const requires32Bit = (corFlags & 2) !== 0 && !prefers32Bit;
  const pureIl = (corFlags & 1) !== 0;
  const resultArchitecture = machine === 0x14c && magic === 0x10b && pureIl && !requires32Bit
    ? 'anycpu' : machineArchitecture;
  return {
    architecture: resultArchitecture, managed: true, machine, corFlags, requires32Bit, prefers32Bit, isDll,
    reason: resultArchitecture === 'anycpu' ? 'Pure IL image; I386 does not require an x86 worker.' : 'CLR flags and PE machine constrain the worker architecture.',
  };
}

async function readImage(filePath: string, maxBytes: number): Promise<Uint8Array> {
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally { await handle.close(); }
}

/** argv-only execution; no targets or restore. MSBuild evaluation still requires workspace trust. */
export function projectEvaluationArguments(request: ProjectEvaluationRequest): string[] {
  const args = [path.resolve(request.projectPath), '-nologo', '-verbosity:quiet', '-nodeReuse:false', '-noAutoResponse',
    `-getProperty:${PROPERTIES}`, '-getItem:Reference,NativeReference'];
  for (const [name, value] of [['Configuration', request.configuration], ['Platform', request.platform], ['TargetFramework', request.targetFramework]]) {
    if (value === undefined) continue;
    // MSBuild separates global properties on semicolons/commas even when shell=false.
    if (!value.trim() || /[;,\r\n\0"%]/.test(value)) throw new Error(`Invalid ${name} selection.`);
    args.push(`-property:${name}=${value}`);
  }
  return args;
}

function runEvaluationProcess(executable: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1' } });
    let settled = false;
    let size = 0;
    const chunks: Buffer[] = [];
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        child.kill();
        child.stdout.destroy();
        child.stderr.destroy();
        reject(error);
      } else resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const timer = setTimeout(() => finish(new Error('MSBuild evaluation timed out.')), Math.max(1, timeoutMs));
    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_OUTPUT_BYTES) finish(new Error('MSBuild evaluation exceeded the output limit.'));
      else chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_OUTPUT_BYTES) finish(new Error('MSBuild evaluation exceeded the output limit.'));
    });
    child.on('error', () => finish(new Error('MSBuild evaluator could not be started.')));
    // Do not propagate project output into diagnostics: property functions can print arbitrary sensitive data.
    child.on('close', (code) => finish(code === 0 ? undefined : new Error('MSBuild evaluation failed.')));
  });
}

function frameworkTfm(version: string): string {
  return /^v?[234]\.\d+(?:\.\d+)?$/i.test(version) ? 'net' + version.replace(/^v/i, '').replace(/\./g, '') : '';
}
function isFramework(tfm: string): boolean { return /^net[234]\d{1,2}$/i.test(tfm); }
function allowedFile(filePath: string, kind: 'project' | 'image'): boolean {
  return !/(?:^|[\\/])secrets(?:[\\/]|$)/i.test(filePath)
    && (kind === 'project' ? /\.csproj$/i : /\.(?:dll|exe)$/i).test(filePath);
}

/** Public for fixture tests; consumes evaluated JSON, never regexes conditional project XML. */
export function parseProjectEvaluation(output: string, projectPath: string): EvaluatedProjectArchitecture & { targetFrameworks: string[] } {
  const first = output.indexOf('{');
  const last = output.lastIndexOf('}');
  const value = JSON.parse(output.slice(first, last + 1)) as { Properties?: Record<string, unknown>; Items?: Record<string, unknown> };
  if (!value.Properties || typeof value.Properties !== 'object') throw new Error('Missing evaluated properties.');
  const prop = (name: string): string => typeof value.Properties![name] === 'string' ? (value.Properties![name] as string).trim() : '';
  const knownDependencyPaths: string[] = [];
  const base = path.dirname(path.resolve(projectPath));
  for (const kind of ['Reference', 'NativeReference']) {
    const items = value.Items?.[kind];
    if (!Array.isArray(items)) continue;
    for (const item of items.slice(0, 256)) {
      if (!item || typeof item !== 'object') continue;
      const candidate = kind === 'Reference' ? item.HintPath : item.FullPath || item.Identity;
      if (typeof candidate !== 'string' || !allowedFile(candidate, 'image') || /\$\(|@\(/.test(candidate)) continue;
      const resolved = path.resolve(base, candidate.replace(/[\\/]/g, path.sep));
      if (!knownDependencyPaths.includes(resolved)) knownDependencyPaths.push(resolved);
    }
  }
  const targetPath = prop('TargetPath');
  const targetFrameworks = prop('TargetFrameworks').split(';').map((s) => s.trim()).filter(Boolean);
  return {
    configuration: prop('Configuration'), platform: prop('Platform'),
    targetFramework: prop('TargetFramework') || (targetFrameworks.length ? '' : frameworkTfm(prop('TargetFrameworkVersion'))),
    targetFrameworks,
    platformTarget: prop('PlatformTarget'),
    prefer32Bit: /^true$/i.test(prop('Prefer32Bit')) ? true : /^false$/i.test(prop('Prefer32Bit')) ? false : null,
    targetPath: targetPath ? path.resolve(base, targetPath.replace(/[\\/]/g, path.sep)) : '', knownDependencyPaths,
    importPaths: prop('MSBuildAllProjects').split(';').filter((s) => /\.(?:props|targets|csproj|proj|projitems)$/i.test(s)
      && !/(?:^|[\\/])secrets(?:[\\/]|$)/i.test(s)).slice(0, 256).map((s) => path.resolve(base, s.replace(/[\\/]/g, path.sep))),
  };
}

/** Attempts installed desktop MSBuild for classic projects, then SDK MSBuild, within one shared deadline. */
export async function evaluateProjectArchitecture(request: ProjectEvaluationRequest): Promise<ProjectEvaluationResult> {
  if (!request.trusted) return { ok: false, reason: 'Workspace trust is required for project evaluation.' };
  if (!allowedFile(request.projectPath, 'project')) return { ok: false, reason: 'A supported project path is required.' };
  const deadline = Date.now() + EVALUATION_BUDGET_MS;
  const remaining = (): number => Math.max(1, deadline - Date.now());
  const candidates: Array<{ executable: string; prefix: string[] }> = [];
  if (request.runtime === 'net48' && process.platform === 'win32') {
    const programFiles = process.env['ProgramFiles(x86)'];
    if (programFiles) {
      try {
        const output = await runEvaluationProcess(path.join(programFiles, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe'),
          ['-latest', '-prerelease', '-products', '*', '-requires', 'Microsoft.Component.MSBuild', '-find', 'MSBuild\\**\\Bin\\MSBuild.exe'], Math.min(2000, remaining()));
        const executable = output.split(/\r?\n/).map((s) => s.trim()).find((s) => path.isAbsolute(s) && /[\\/]MSBuild\.exe$/i.test(s));
        if (executable) candidates.push({ executable, prefix: [] });
      } catch { /* SDK MSBuild remains a read-only evaluation fallback. */ }
    }
  }
  candidates.push({ executable: 'dotnet', prefix: ['msbuild'] });
  let reason = 'MSBuild evaluation was unavailable.';
  for (const candidate of candidates) {
    if (Date.now() >= deadline) break;
    try {
      const query = async (selected: ProjectEvaluationRequest) => parseProjectEvaluation(
        await runEvaluationProcess(candidate.executable, [...candidate.prefix, ...projectEvaluationArguments(selected)], remaining()), request.projectPath);
      let project = await query(request);
      if (!project.targetFramework && project.targetFrameworks.length) {
        const matching = project.targetFrameworks.filter((tfm) => isFramework(tfm) === (request.runtime === 'net48'));
        if (matching.length !== 1) return { ok: false, reason: 'A target framework must be selected for this multi-target project.' };
        project = await query({ ...request, targetFramework: matching[0] });
      }
      const { targetFrameworks: _targetFrameworks, ...evaluated } = project;
      if (!evaluated.configuration || !evaluated.platform || !evaluated.targetFramework) {
        return { ok: false, reason: 'MSBuild returned incomplete configuration or target framework evidence.' };
      }
      return { ok: true, project: evaluated };
    } catch (error) { reason = error instanceof SyntaxError ? 'MSBuild returned invalid evaluation data.' : error instanceof Error ? error.message : reason; }
  }
  return { ok: false, reason };
}

function imageMismatch(image: PeArchitectureEvidence, worker: CompatibilityArchitecture): boolean {
  if (worker === 'unknown' || image.architecture === 'unknown') return false;
  if (image.managed && image.prefers32Bit && image.isDll && worker !== 'x86') return true;
  return image.architecture !== 'anycpu' && image.architecture !== worker;
}

export async function inspectProjectCompatibility(
  options: ProjectCompatibilityOptions,
  dependencies: ProjectCompatibilityDependencies = {},
): Promise<ProjectCompatibilityResult> {
  const detected = architecture(process.arch);
  const workerArchitecture = options.workerArchitecture ?? (options.runtime === 'net48' ? 'x64' : detected === 'anycpu' ? 'unknown' : detected);
  const result: ProjectCompatibilityResult = {
    status: 'unknown', code: 'ARCHITECTURE_UNKNOWN', message: 'Project architecture is unknown.', workerArchitecture,
    nativeDependencies: [], observedPaths: [], limitations: ['Architecture evidence does not verify transitive native dependencies, P/Invoke resolution, COM registration, or ActiveX support.'],
  };
  if (!options.trusted) return { ...result, code: 'WORKSPACE_TRUST_REQUIRED', message: 'Workspace trust is required before project evaluation or image inspection.' };
  if (options.projectPath) {
    try {
      const evaluation = await (dependencies.evaluate ?? evaluateProjectArchitecture)({ ...options, projectPath: options.projectPath });
      if (evaluation.ok) result.evaluated = evaluation.project;
      else result.limitations.push(evaluation.reason);
    } catch { result.limitations.push('Project evaluation failed; conditional project properties remain unknown.'); }
  } else result.limitations.push('No owning project was available for evaluation.');
  const read = dependencies.readImage ?? readImage;
  const inspect = async (filePath: string): Promise<PeArchitectureEvidence & { path: string }> => {
    if (!allowedFile(filePath, 'image')) return { path: filePath, architecture: 'unknown', managed: null, reason: 'Unsupported image path.' };
    try { return { ...inspectPeArchitecture(await read(filePath, MAX_IMAGE_BYTES)), path: filePath }; }
    catch { return { path: filePath, architecture: 'unknown', managed: null, reason: 'Image is missing or unreadable.' }; }
  };
  const outputPath = options.assemblyPath || result.evaluated?.targetPath;
  if (outputPath) result.output = await inspect(outputPath);
  const samePath = (a: string, b: string): boolean => process.platform === 'win32'
    ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
  const outputMatchesEvaluation = !options.assemblyPath || !!result.evaluated?.targetPath && samePath(options.assemblyPath, result.evaluated.targetPath);
  if (options.assemblyPath && result.evaluated && !outputMatchesEvaluation) {
    result.limitations.push('The selected assembly differs from the evaluated TargetPath; evaluated reference paths are not confirmed dependencies of that build.');
  }
  const dependencyPaths = [...new Set([...(options.nativeDependencyPaths ?? []), ...(outputMatchesEvaluation ? result.evaluated?.knownDependencyPaths ?? [] : [])])];
  if (dependencyPaths.length > MAX_DEPENDENCIES) result.limitations.push(`Dependency inspection was limited to ${MAX_DEPENDENCIES} known paths.`);
  result.nativeDependencies = await Promise.all(dependencyPaths.slice(0, MAX_DEPENDENCIES).map(inspect));
  result.observedPaths = [...new Set([...(options.projectPath ? [options.projectPath] : []), ...(outputPath ? [outputPath] : []),
    ...dependencyPaths.slice(0, MAX_DEPENDENCIES), ...(result.evaluated?.importPaths ?? [])])]
    .filter((s) => !/(?:^|[\\/])secrets(?:[\\/]|$)/i.test(s));
  if (result.evaluated?.prefer32Bit || result.output?.prefers32Bit) result.limitations.push('Prefer32Bit is an EXE launch preference; the designer uses its existing worker process. Preferred32 DLLs cannot load in a 64-bit worker.');
  const mismatch = result.nativeDependencies.find((image) => imageMismatch(image, workerArchitecture));
  if (mismatch) return { ...result, status: 'incompatible', code: 'DEPENDENCY_ARCHITECTURE_MISMATCH', message: `Known dependency ${path.basename(mismatch.path)} is incompatible with the ${workerArchitecture} designer worker.` };
  if (result.output && imageMismatch(result.output, workerArchitecture)) return { ...result, status: 'incompatible', code: 'OUTPUT_ARCHITECTURE_MISMATCH', message: `The selected output cannot load in the ${workerArchitecture} designer worker (${result.output.architecture}${result.output.prefers32Bit && result.output.isDll ? ', preferred32 DLL' : ''}).` };
  if (result.output?.managed === false) return { ...result, status: 'incompatible', code: 'OUTPUT_NOT_MANAGED', message: 'The selected output is a native PE image; select the managed form assembly.' };
  // Actual built image is stronger evidence than current project settings, which may not describe that build.
  if (result.output?.managed && result.output.architecture !== 'unknown' && workerArchitecture !== 'unknown') {
    if (dependencyPaths.length > MAX_DEPENDENCIES) return { ...result, code: 'DEPENDENCY_ARCHITECTURE_UNKNOWN', message: 'The form assembly matches the worker, but the known dependency set exceeds the inspection limit.' };
    if (result.nativeDependencies.some((image) => image.architecture === 'unknown')) return { ...result, code: 'DEPENDENCY_ARCHITECTURE_UNKNOWN', message: 'The form assembly matches the worker, but a known dependency could not be inspected.' };
    return { ...result, status: 'compatible', code: 'ARCHITECTURE_COMPATIBLE', message: `The inspected form assembly and known dependencies match the ${workerArchitecture} designer worker.` };
  }
  const declared = architecture(result.evaluated?.platformTarget ?? '');
  if (!options.assemblyPath && declared !== 'unknown' && declared !== 'anycpu' && workerArchitecture !== 'unknown' && declared !== workerArchitecture) {
    return { ...result, status: 'incompatible', code: 'PROJECT_ARCHITECTURE_MISMATCH', message: `Evaluated ${result.evaluated!.configuration}|${result.evaluated!.platform} targets ${declared}; the designer worker is ${workerArchitecture}.` };
  }
  return { ...result, message: result.output ? result.output.reason : 'No built managed output was available; architecture compatibility remains unknown.' };
}

interface CompatibilityCacheEntry {
  generation: number;
  expires: number;
  pending?: Promise<ProjectCompatibilityResult>;
  result?: ProjectCompatibilityResult;
  fingerprint?: string;
}
export interface CompatibilityCacheDependencies extends ProjectCompatibilityDependencies {
  inspect?: (options: ProjectCompatibilityOptions) => Promise<ProjectCompatibilityResult>;
  /** Metadata only. This cache is a performance optimization, not a content/trust guarantee. */
  stat?: (filePath: string) => Promise<{ mtimeMs: number; size: number }>;
  now?: () => number;
}

/** Session cache. Watchers must invalidate for new imports/ancestor props and explicit document changes. */
export class ProjectCompatibilityCache {
  private readonly entries = new Map<string, CompatibilityCacheEntry>();
  private generation = 0;
  private readonly inspectUncached?: (options: ProjectCompatibilityOptions) => Promise<ProjectCompatibilityResult>;
  private readonly inspectionDependencies: ProjectCompatibilityDependencies;
  private readonly stat: NonNullable<CompatibilityCacheDependencies['stat']>;
  private readonly now: () => number;

  constructor(dependencies: CompatibilityCacheDependencies = {}) {
    this.inspectUncached = dependencies.inspect;
    this.inspectionDependencies = { evaluate: dependencies.evaluate, readImage: dependencies.readImage };
    this.stat = dependencies.stat ?? ((filePath) => fs.stat(filePath));
    this.now = dependencies.now ?? Date.now;
  }

  invalidate(): void {
    this.generation++;
    this.entries.clear();
  }

  private async stamp(filePath: string): Promise<string> {
    try {
      const info = await this.stat(filePath);
      return JSON.stringify([info.mtimeMs, info.size]);
    } catch { return 'unavailable'; }
  }

  private async fingerprint(paths: string[]): Promise<string> {
    return JSON.stringify(await Promise.all(paths.map(async (filePath) => [filePath, await this.stamp(filePath)])));
  }

  async inspect(options: ProjectCompatibilityOptions, refresh: { force?: boolean } = {}): Promise<ProjectCompatibilityResult> {
    const key = JSON.stringify([options.projectPath, options.assemblyPath, options.runtime, options.trusted,
      options.configuration, options.platform, options.targetFramework, options.workerArchitecture, options.nativeDependencyPaths]);
    const clone = (value: ProjectCompatibilityResult): ProjectCompatibilityResult => JSON.parse(JSON.stringify(value)) as ProjectCompatibilityResult;
    const current = this.entries.get(key);
    if (current?.pending) return clone(await current.pending);
    if (!refresh.force && current?.result && current.expires > this.now()) {
      const fingerprint = await this.fingerprint(current.result.observedPaths);
      // An invalidation while statting must not publish the old cached diagnosis.
      if (this.entries.get(key) !== current) return this.inspect(options, refresh);
      if (fingerprint === current.fingerprint) return clone(current.result);
    }
    const entry: CompatibilityCacheEntry = { generation: this.generation, expires: 0 };
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > 32) this.entries.delete(this.entries.keys().next().value!);
    entry.pending = (async () => {
      // Preserve the stamp from BEFORE the evidence read. Stamping only afterwards would associate an old
      // PE diagnosis with a replacement DLL's metadata and incorrectly reuse it for the complete cache TTL.
      const before = new Map<string, string>();
      const observeBefore = async (filePath: string): Promise<void> => {
        if (!before.has(filePath)) before.set(filePath, await this.stamp(filePath));
      };
      const seedPaths = options.trusted ? [...new Set([
        ...(options.projectPath ? [options.projectPath] : []), ...(options.assemblyPath ? [options.assemblyPath] : []),
        ...(options.nativeDependencyPaths ?? []).slice(0, MAX_DEPENDENCIES), ...(current?.result?.observedPaths ?? []),
      ])].filter((s) => !/(?:^|[\\/])secrets(?:[\\/]|$)/i.test(s)) : [];
      await Promise.all(seedPaths.map(observeBefore));
      const result = this.inspectUncached ? await this.inspectUncached(options) : await inspectProjectCompatibility(options, {
        evaluate: this.inspectionDependencies.evaluate,
        readImage: async (filePath, maxBytes) => {
          // Includes outputs and references discovered by evaluation, which were not known in seedPaths.
          await observeBefore(filePath);
          return (this.inspectionDependencies.readImage ?? readImage)(filePath, maxBytes);
        },
      });
      const paths = [...new Set([...result.observedPaths, ...before.keys()])];
      const after = new Map(await Promise.all(paths.map(async (filePath) => [filePath, await this.stamp(filePath)] as const)));
      const changed = [...before].some(([filePath, stamp]) => after.get(filePath) !== stamp);
      if (entry.generation !== this.generation || changed) {
        return { ...result, status: 'unknown' as const, code: 'ARCHITECTURE_UNKNOWN' as const,
          message: 'Project or output changed during architecture inspection; refresh the diagnosis.',
          evaluated: undefined, output: undefined, nativeDependencies: [], observedPaths: [],
          limitations: [...result.limitations, changed
            ? 'File metadata changed during architecture inspection; the evidence was not cached.'
            : 'The in-flight architecture evidence was invalidated.'] };
      }
      if (this.entries.get(key) === entry) {
        result.observedPaths = paths;
        entry.result = clone(result);
        entry.fingerprint = JSON.stringify([...after]);
        entry.expires = this.now() + (result.status === 'unknown' ? 2_000 : 30_000);
      }
      return result;
    })();
    try { return clone(await entry.pending); }
    finally {
      entry.pending = undefined;
      if (!entry.result && this.entries.get(key) === entry) this.entries.delete(key);
    }
  }
}

const projectCompatibilityCache = new ProjectCompatibilityCache();
export function inspectCachedProjectCompatibility(options: ProjectCompatibilityOptions, refresh: { force?: boolean } = {}): Promise<ProjectCompatibilityResult> {
  return projectCompatibilityCache.inspect(options, refresh);
}
export function invalidateProjectCompatibilityCache(): void { projectCompatibilityCache.invalidate(); }
