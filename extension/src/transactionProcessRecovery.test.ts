import { ChildProcess, fork } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { recoverPendingTransactions } from './transactionRecovery';
import { TransactionCrashPoint } from './transactionRunner';

const scratch: string[] = [];
let childBundle = '';

function tempDir(prefix = 'wfd-process-recovery-'): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratch.push(directory);
  return directory;
}

beforeAll(async () => {
  const bundleDirectory = tempDir('wfd-crash-child-bundle-');
  childBundle = path.join(bundleDirectory, 'transaction-crash-child.cjs');
  await build({
    entryPoints: [path.resolve(__dirname, 'transactionCrashChild.ts')],
    outfile: childBundle,
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    logLevel: 'silent',
  });
});

afterEach(() => {
  for (const directory of scratch.splice(1)) fs.rmSync(directory, { recursive: true, force: true });
});

afterAll(() => {
  for (const directory of scratch.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

async function terminateAt(child: ChildProcess, point: TransactionCrashPoint, occurrence: number): Promise<void> {
  const stderr: Buffer[] = [];
  child.stderr?.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(
      `child did not reach ${point} #${occurrence}: ${Buffer.concat(stderr).toString('utf8')}`,
    )), 10_000);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`child exited ${code} before ${point} #${occurrence}: ${Buffer.concat(stderr).toString('utf8')}`));
    });
    child.on('message', (message: { type?: string; point?: string; occurrence?: number }) => {
      if (message.type !== 'crash-point-ready' || message.point !== point || message.occurrence !== occurrence) return;
      clearTimeout(timer);
      resolve();
    });
  });
  const exited = once(child, 'exit');
  expect(child.kill()).toBe(true);
  await exited;
}

describe('real process termination transaction recovery', () => {
  it.each([
    ['createdPersisted', 1, 'before'],
    ['preparedPersisted', 1, 'before'],
    ['applyingPersisted', 1, 'before'],
    ['targetWritten', 1, 'before'],
    ['targetWritten', 2, 'before'],
    ['targetApplied', 1, 'before'],
    ['targetApplied', 2, 'before'],
    ['appliedPersisted', 1, 'before'],
    ['undoRegistered', 1, 'before'],
    ['beforeCommit', 1, 'before'],
    ['committedPersisted', 1, 'after'],
  ] as const)(
    'recovers OS termination at %s occurrence %i to %s',
    async (crashPoint, crashOccurrence, expectedImage) => {
      const workspaceRoot = tempDir();
      const globalStorage = tempDir();
      const journalRoot = path.join(globalStorage, 'v2-transactions', 'workspace-hash');
      const designer = path.join(workspaceRoot, 'Form1.Designer.cs');
      const resx = path.join(workspaceRoot, 'Form1.resx');
      await fs.promises.writeFile(designer, 'designer-before', 'utf8');
      await fs.promises.writeFile(resx, 'resx-before', 'utf8');
      const config = {
        workspaceRoot,
        journalRoot,
        transactionId: `real-${crashPoint}-${crashOccurrence}`,
        crashPoint,
        crashOccurrence,
        targets: [
          { filePath: designer, before: 'designer-before', after: 'designer-after', bom: false },
          { filePath: resx, before: 'resx-before', after: 'resx-after', bom: false },
        ],
      };
      const child = fork(
        childBundle,
        [Buffer.from(JSON.stringify(config), 'utf8').toString('base64url')],
        { silent: true },
      );
      await terminateAt(child, crashPoint, crashOccurrence);

      const summary = await recoverPendingTransactions(globalStorage);
      const committed = expectedImage === 'after';
      expect(summary.manual + summary.corrupt).toBe(0);
      expect(summary.committed).toBe(committed ? 1 : 0);
      expect(await fs.promises.readFile(designer, 'utf8')).toBe(committed ? 'designer-after' : 'designer-before');
      expect(await fs.promises.readFile(resx, 'utf8')).toBe(committed ? 'resx-after' : 'resx-before');
    },
    20_000,
  );
});
