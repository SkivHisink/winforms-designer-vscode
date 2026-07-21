import * as fs from 'node:fs';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { ping, renderWithLayout, startEngine } from './engineClient';

type Thresholds = {
  startupMs: number;
  warmMedianMs: number;
  warmP95Ms: number;
};

const envNumber = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number, got ${raw}`);
  return value;
};

const percentile = (values: number[], ratio: number): number => {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
};

async function main(): Promise<void> {
  const repo = path.resolve(__dirname, '..', '..');
  const exe = path.join(repo, 'engine', 'bin', 'Release', 'net10.0-windows', 'win-x64', 'WinFormsDesigner.Engine.exe');
  const dll = path.join(repo, 'engine', 'bin', 'Release', 'net10.0-windows', 'WinFormsDesigner.Engine.dll');
  const engineEntry = process.env.WFD_ENGINE || (fs.existsSync(exe) ? exe : dll);
  const designer = path.join(repo, 'engine', 'samples', 'SampleForm.Designer.cs');
  if (!fs.existsSync(engineEntry)) throw new Error(`Release engine not found: ${engineEntry}`);
  if (!fs.existsSync(designer)) throw new Error(`performance fixture not found: ${designer}`);

  const thresholds: Thresholds = {
    startupMs: envNumber('WFD_PERF_STARTUP_MS', 15_000),
    warmMedianMs: envNumber('WFD_PERF_WARM_MEDIAN_MS', 1_000),
    warmP95Ms: envNumber('WFD_PERF_WARM_P95_MS', 2_500),
  };

  const startedAt = performance.now();
  const engine = await startEngine(engineEntry, { onLog: (line) => console.error(line) });
  try {
    await ping(engine);
    const startupMs = performance.now() - startedAt;

    // One unmeasured render pays JIT, Roslyn and WinForms initialization. The seven measured samples then pin the
    // interactive steady-state path while remaining short enough for every PR and release build.
    await renderWithLayout(engine, designer);
    const warmMs: number[] = [];
    for (let i = 0; i < 7; i++) {
      const sampleAt = performance.now();
      await renderWithLayout(engine, designer);
      warmMs.push(performance.now() - sampleAt);
    }
    const warmMedianMs = percentile(warmMs, 0.5);
    const warmP95Ms = percentile(warmMs, 0.95);
    const report = {
      fixture: path.relative(repo, designer),
      samples: warmMs.length,
      startupMs: Number(startupMs.toFixed(1)),
      warmMedianMs: Number(warmMedianMs.toFixed(1)),
      warmP95Ms: Number(warmP95Ms.toFixed(1)),
      thresholds,
    };
    console.log(JSON.stringify(report, null, 2));

    const failures: string[] = [];
    if (startupMs > thresholds.startupMs) failures.push(`startup ${startupMs.toFixed(1)}ms > ${thresholds.startupMs}ms`);
    if (warmMedianMs > thresholds.warmMedianMs) failures.push(`warm median ${warmMedianMs.toFixed(1)}ms > ${thresholds.warmMedianMs}ms`);
    if (warmP95Ms > thresholds.warmP95Ms) failures.push(`warm p95 ${warmP95Ms.toFixed(1)}ms > ${thresholds.warmP95Ms}ms`);
    if (failures.length) throw new Error(`performance baseline regression: ${failures.join('; ')}`);
  } finally {
    engine.dispose();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
