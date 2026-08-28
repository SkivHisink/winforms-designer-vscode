import { ChildProcess } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  EngineHandle,
  createEngineBackedV2WorkerSupervisor,
  ping,
  recordV2EngineProbeCrash,
  requestV2EngineProbe,
  startEngine,
} from './engineClient';
import { WorkerRecoveryPolicy } from './workerSupervisor';
import { WorkerRuntime } from './workerSelection';

const repoRoot = path.resolve(process.cwd(), '..');
const modernDll = process.env.WFD_ENGINE_DLL
  ?? path.join(repoRoot, 'engine', 'bin', 'Release', 'net10.0-windows', 'WinFormsDesigner.Engine.dll');
const modernExe = path.join(repoRoot, 'engine', 'bin', 'Release', 'net10.0-windows', 'WinFormsDesigner.Engine.exe');
const net48Exe = process.env.WFD_ENGINE_NET48
  ?? path.join(repoRoot, 'engine-net48', 'bin', 'Release', 'net48', 'WinFormsDesigner.Engine.Net48.exe');

const hasModernEngine = process.platform === 'win32' && existsSync(modernDll) && existsSync(modernExe);
const hasNet48Engine = process.platform === 'win32' && existsSync(net48Exe);
const runWithModernEngine = hasModernEngine ? it : it.skip;
const runWithBothEngines = hasModernEngine && hasNet48Engine ? it : it.skip;

class RestartOncePolicy implements WorkerRecoveryPolicy {
  calls = 0;

  recordCrash(): { restart: boolean; delayMs: number; recentCrashes: number } {
    this.calls += 1;
    return { restart: this.calls <= 1, delayMs: 0, recentCrashes: this.calls };
  }
}

class RealEngineHarness {
  private readonly live = new Map<WorkerRuntime, EngineHandle>();
  private modernAttempts = 0;
  readonly started: Array<{ runtime: WorkerRuntime; pid: number }> = [];
  readonly logs: string[] = [];

  constructor(private readonly firstModernEntry?: string) {}

  async getEngine(runtime: WorkerRuntime): Promise<EngineHandle> {
    const cached = this.live.get(runtime);
    if (cached && cached.process.exitCode === null && cached.process.signalCode === null) return cached;

    const modernAttempt = runtime === 'modern' ? this.modernAttempts : 0;
    if (runtime === 'modern') this.modernAttempts += 1;
    const entry = runtime === 'net48'
      ? net48Exe
      : modernAttempt > 0 || !this.firstModernEntry
        ? modernDll
        : this.firstModernEntry;
    const handle = await startEngine(entry, { onLog: (line) => this.logs.push(line) });
    this.live.set(runtime, handle);
    if (handle.process.pid !== undefined) this.started.push({ runtime, pid: handle.process.pid });
    return handle;
  }

  async crash(runtime: WorkerRuntime): Promise<number> {
    const handle = this.live.get(runtime);
    if (!handle?.process.pid) throw new Error(`no live ${runtime} engine to crash`);
    const pid = handle.process.pid;
    this.live.delete(runtime);
    handle.process.kill();
    await waitForExit(handle.process);
    try { handle.dispose(); } catch { /* best effort after intentional crash */ }
    return pid;
  }

  async disposeAll(): Promise<void> {
    const handles = [...this.live.values()];
    this.live.clear();
    for (const handle of handles) {
      const proc = handle.process;
      try { handle.dispose(); } catch { /* best effort cleanup */ }
      await waitForExit(proc).catch(() => undefined);
    }
  }
}

describe('v2 runtime lifecycle process harness', () => {
  runWithModernEngine('V2-FND-001-S103 recovers after a real modern apphost dependency/start failure', async () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'wfd-v2-runtime-s103-'));
    const brokenApphost = path.join(tempRoot, 'WinFormsDesigner.Engine.exe');
    copyFileSync(modernExe, brokenApphost);

    const policy = new RestartOncePolicy();
    const harness = new RealEngineHarness(brokenApphost);
    const supervisor = createEngineBackedV2WorkerSupervisor(
      (runtime) => harness.getEngine(runtime),
      { sessionId: 'runtime-lifecycle-s103', recoveryPolicy: policy },
    );

    try {
      const failed = await requestV2EngineProbe(supervisor, {
        runtime: 'modern',
        command: 'ping',
        documentLabel: 'S103-missing-modern-dependency',
        hostArchitecture: 'x64',
        timeoutMs: 3_000,
      });
      expect(failed).toMatchObject({
        status: 'faulted',
        reasonCode: 'WORKER_REQUEST_FAULTED',
        workerKey: 'modern:x64:native',
        generation: 1,
      });
      expect(harness.logs.join('\n')).toContain('The application to execute does not exist');

      expect(recordV2EngineProbeCrash(supervisor, 'modern', 'x64')).toEqual({
        restart: true,
        delayMs: 0,
        recentCrashes: 1,
      });

      const recovered = await requestV2EngineProbe(supervisor, {
        runtime: 'modern',
        command: 'ping',
        documentLabel: 'S103-after-recycle',
        documentRevision: 'fresh-worker',
        sourceFingerprintSeed: 'no-stale-canvas',
        hostArchitecture: 'x64',
        timeoutMs: 3_000,
      });
      expect(recovered).toMatchObject({
        status: 'ok',
        workerKey: 'modern:x64:native',
        generation: 2,
      });
      expect(recovered.status === 'ok' ? recovered.result.value : '').toContain('winforms-engine ok');
      expect(harness.started.filter((start) => start.runtime === 'modern')).toHaveLength(1);
    } finally {
      await harness.disposeAll();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 15_000);

  runWithBothEngines('V2-FND-001-S104 repeatedly starts, pings, and disposes real workers within the repo process-count budget', async () => {
    const entries: Array<{ label: WorkerRuntime; path: string; expectedPing: string }> = [
      { label: 'modern', path: modernDll, expectedPing: 'winforms-engine ok' },
      { label: 'net48', path: net48Exe, expectedPing: 'winforms-engine-net48 ok' },
    ];
    const observedPids: number[] = [];

    for (const entry of entries) {
      for (let cycle = 0; cycle < 2; cycle += 1) {
        const handle = await startEngine(entry.path, { onLog: () => undefined });
        try {
          expect(await ping(handle)).toContain(entry.expectedPing);
          expect(handle.process.pid).toBeGreaterThan(0);
          observedPids.push(handle.process.pid as number);
        } finally {
          const proc = handle.process;
          handle.dispose();
          await waitForExit(proc);
          expect(await isPidRunning(proc.pid)).toBe(false);
        }
      }
    }

    expect(new Set(observedPids).size).toBe(observedPids.length);
  }, 30_000);

  runWithBothEngines('V2-FND-001-S107 restarts a real net48 worker crash without mutating live source bytes', async () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'wfd-v2-runtime-s107-'));
    const designerPath = path.join(tempRoot, 'Form1.Designer.cs');
    const sourceText = [
      'namespace Demo',
      '{',
      '    partial class Form1 : System.Windows.Forms.Form',
      '    {',
      '        private void InitializeComponent()',
      '        {',
      '            this.Text = "live-source";',
      '        }',
      '    }',
      '}',
      '',
    ].join('\r\n');
    mkdirSync(tempRoot, { recursive: true });
    writeFileSync(designerPath, sourceText, 'utf8');

    const policy = new RestartOncePolicy();
    const harness = new RealEngineHarness();
    const supervisor = createEngineBackedV2WorkerSupervisor(
      (runtime) => harness.getEngine(runtime),
      { sessionId: 'runtime-lifecycle-s107', recoveryPolicy: policy },
    );

    try {
      const before = readFileSync(designerPath, 'utf8');
      const first = await requestV2EngineProbe(supervisor, {
        runtime: 'net48',
        command: 'ping',
        documentLabel: designerPath,
        documentRevision: 'rev-before-crash',
        sourceFingerprintSeed: sourceText,
        hostArchitecture: 'x64',
        timeoutMs: 3_000,
      });
      expect(first).toMatchObject({
        status: 'ok',
        workerKey: 'net48:x64:native',
        generation: 1,
      });

      const crashedPid = await harness.crash('net48');
      expect(await isPidRunning(crashedPid)).toBe(false);
      expect(recordV2EngineProbeCrash(supervisor, 'net48', 'x64')).toEqual({
        restart: true,
        delayMs: 0,
        recentCrashes: 1,
      });

      const recovered = await requestV2EngineProbe(supervisor, {
        runtime: 'net48',
        command: 'ping',
        documentLabel: designerPath,
        documentRevision: 'rev-after-crash',
        sourceFingerprintSeed: sourceText,
        hostArchitecture: 'x64',
        timeoutMs: 3_000,
      });
      expect(recovered).toMatchObject({
        status: 'ok',
        workerKey: 'net48:x64:native',
        generation: 2,
      });
      expect(recovered.status === 'ok' ? recovered.result.value : '').toContain('winforms-engine-net48 ok');
      expect(readFileSync(designerPath, 'utf8')).toBe(before);
      const net48Starts = harness.started.filter((start) => start.runtime === 'net48');
      expect(net48Starts).toHaveLength(2);
      expect(net48Starts[1].pid).not.toBe(net48Starts[0].pid);
    } finally {
      await harness.disposeAll();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 20_000);
});

function waitForExit(proc: ChildProcess, timeoutMs = 5_000): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      proc.off('exit', onExit);
      reject(new Error(`process ${proc.pid ?? '<unknown>'} did not exit within ${timeoutMs} ms`));
    }, timeoutMs);
    const onExit = (): void => {
      clearTimeout(timer);
      resolve();
    };
    proc.once('exit', onExit);
  });
}

async function isPidRunning(pid: number | undefined): Promise<boolean> {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
