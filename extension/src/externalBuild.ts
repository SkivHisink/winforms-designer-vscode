import * as path from 'path';

/**
 * Pure helpers for detecting a build started OUTSIDE VS Code (Visual Studio, an external `msbuild`) that is about to
 * overwrite the .NET Framework output an open designer pins. Kept free of `vscode`/`fs` so the decisions can be
 * tested directly; extension.ts owns the watchers, the release and the re-render.
 */

/** File extensions whose appearance means a build is producing assemblies — the only writes worth reacting to.
 * A design-time build churns through `.cache` / `.AssemblyInfo.cs` / `.editorconfig` under `obj` constantly, and
 * unloading the preview for those would make every keystroke in another editor cost an assembly reload. */
const ASSEMBLY_EXTENSIONS = new Set(['.exe', '.dll']);

/** Whether a watcher event names a written assembly. `null`/empty (the platform can omit the filename) is NOT
 * treated as a build: acting on an unnamed event would fire on any churn in the directory. */
export function isAssemblyWrite(name: string | Buffer | null | undefined): boolean {
  if (name == null) return false;
  const file = typeof name === 'string' ? name : name.toString();
  if (!file) return false;
  return ASSEMBLY_EXTENSIONS.has(path.extname(file).toLowerCase());
}

/**
 * The `obj` directories MSBuild could be compiling into for an output that lives in `binDir`, most likely first.
 *
 * Only conventional layouts are derived — `<proj>\bin\<Config>` (classic projects) and `<proj>\bin\<Config>\<Tfm>`
 * (SDK-style). A custom `OutputPath` is deliberately NOT guessed at: the caller also watches the output directory
 * itself, so an unusual layout degrades to "noticed when the copy starts" rather than to a wrong guess about where
 * someone else's intermediate files live.
 *
 * Returns [] when `binDir` is not under a `bin` directory at all.
 */
export function intermediateDirCandidates(binDir: string): string[] {
  const candidates: string[] = [];
  for (const depth of [1, 2]) {
    const binRoot = path.resolve(binDir, ...new Array<string>(depth).fill('..'));
    if (path.basename(binRoot).toLowerCase() !== 'bin') continue;
    const obj = path.join(path.dirname(binRoot), 'obj');
    if (!candidates.includes(obj)) candidates.push(obj);
  }
  return candidates;
}

/** Where a watched write happened: the project's intermediate (`obj`) tree, or a pinned build output directory. */
export type BuildWriteOrigin = 'intermediate' | 'output';

export interface ExternalBuildHooks {
  /** The .NET Framework outputs open designers currently pin. Empty ⇒ there is nothing to hand back. */
  outputsInUse(): string[];
  /** Identity of an output file (mtime+size, -1 when absent) — used only to tell "the build already replaced it". */
  stamp(file: string): number;
  /** Make every net48 preview view-only: a build now owns the output. */
  begin(): void;
  /** Unload the compiled domains. Resolution means the handles are really gone. */
  release(): Promise<unknown>;
  /** Put the previews back; they re-render from whatever the build produced. */
  end(): Promise<void>;
  /** Quiet period after the last write before the previews go live again. */
  settleMs?: number;
  /** How many extra quiet periods to wait while the build has compiled but not yet reached THIS output. */
  maxWaits?: number;
}

/**
 * The release state machine for an external build, kept out of extension.ts so its ordering can be tested directly:
 * this is the piece that decides whether the user's build succeeds or dies with MSB3027.
 *
 * Contract, in the order that matters:
 *   1. the FIRST qualifying write releases (begin → release) — later writes only extend the quiet period;
 *   2. the previews come back only after the release promise has RESOLVED, so no re-render can recreate a domain
 *      while the unload is still in flight;
 *   3. "the build is done" is a write into the output directory or a changed output — not merely silence, so the
 *      handles stay off through the gap between compile and copy;
 *   4. that wait is bounded: a build of another configuration/target framework must not park the previews forever.
 */
export class ExternalBuildRelease {
  private settle: ReturnType<typeof setTimeout> | undefined;
  private pending: Map<string, number> | undefined;
  private releasing: Promise<unknown> | undefined;
  private copySeen = false;
  private waits = 0;
  private readonly settleMs: number;
  private readonly maxWaits: number;

  constructor(private readonly hooks: ExternalBuildHooks) {
    this.settleMs = hooks.settleMs ?? 3000;
    this.maxWaits = hooks.maxWaits ?? 9;
  }

  /** True while a detected build owns the output (previews are view-only). */
  get active(): boolean { return this.pending !== undefined; }

  /** A watched directory reported a write that qualifies as build activity. */
  onWrite(origin: BuildWriteOrigin): void {
    const inUse = this.hooks.outputsInUse();
    if (inUse.length === 0) return; // nothing pinned → nothing to hand back
    if (origin === 'output') this.copySeen = true;
    this.waits = 0;
    this.arm();
    if (this.pending) return; // already released for this build — the timer above just extended it
    // Snapshot the outputs BEFORE the release, so `finish` can tell a finished build from one that has only
    // compiled so far and has yet to copy.
    this.pending = new Map(inUse.map((out) => [out, this.hooks.stamp(out)]));
    this.hooks.begin();
    this.releasing = this.hooks.release();
  }

  /** Drop any pending wait (host teardown). Does NOT put the previews back: the window is going away. */
  dispose(): void {
    if (this.settle) { clearTimeout(this.settle); this.settle = undefined; }
  }

  private arm(): void {
    if (this.settle) clearTimeout(this.settle);
    this.settle = setTimeout(() => void this.finish(), this.settleMs);
  }

  private async finish(): Promise<void> {
    this.settle = undefined;
    const pending = this.pending;
    if (!pending) return;
    const landed = this.copySeen || [...pending].some(([out, stamp]) => this.hooks.stamp(out) !== stamp);
    if (!landed && this.waits < this.maxWaits) {
      this.waits++;
      this.arm();
      return;
    }
    this.pending = undefined;
    this.copySeen = false;
    this.waits = 0;
    const releasing = this.releasing;
    this.releasing = undefined;
    try { await releasing; } catch { /* the release path logs its own failures */ }
    await this.hooks.end();
  }
}
