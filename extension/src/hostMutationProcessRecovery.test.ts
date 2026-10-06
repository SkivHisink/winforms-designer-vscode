import { fork } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HostMutationLedger } from './mutationOperation';
import { recoverPendingTransactions, reconcileRestoredDocumentTransactions } from './transactionRecovery';

const scratch: string[] = [];
let bundle = '';
function temporary(): string { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wfd-host-process-')); scratch.push(root); return root; }
beforeAll(async () => {
  bundle = path.join(temporary(), 'host-crash.cjs');
  await build({ entryPoints: [path.join(__dirname, 'hostMutationCrashChild.ts')], outfile: bundle,
    bundle: true, platform: 'node', target: 'node18', format: 'cjs', logLevel: 'silent' });
});
afterAll(() => { for (const root of scratch) fs.rmSync(root, { recursive: true, force: true }); });

describe('OS process termination after host commit before source backup survival', () => {
  it.each([
    [false, 'missing'], [false, 'stale'], [false, 'current'],
    [true, 'missing'], [true, 'stale'], [true, 'current'],
  ] as const)('acknowledged=%s backup=%s uses the actual restored source witness', async (acknowledged, backup) => {
    const workspace = temporary(); const storage = temporary();
    const source = path.join(workspace, 'Form1.Designer.cs'); const resource = path.join(workspace, 'Form1.resx');
    fs.writeFileSync(source, 'source-before'); fs.writeFileSync(resource, 'resource-before');
    const child = fork(bundle, [Buffer.from(JSON.stringify({ workspace, storage, acknowledged, backup })).toString('base64url')], { silent: true });
    const stderr: Buffer[] = []; child.stderr?.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error(`host child timed out: ${Buffer.concat(stderr)}`)); }, 10_000);
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`host child exited ${code}: ${Buffer.concat(stderr)}`)); });
      child.once('message', (message: { type?: string }) => { if (message.type === 'host-commit-ready') { clearTimeout(timer); resolve(); } });
    });
    const exited = once(child, 'exit'); expect(child.kill()).toBe(true); await exited;
    expect((await recoverPendingTransactions(storage)).deferred).toBe(1);
    const backupPath = path.join(storage, 'source.backup');
    const restoredSource = fs.existsSync(backupPath) ? fs.readFileSync(backupPath, 'utf8') : fs.readFileSync(source, 'utf8');
    const result = await reconcileRestoredDocumentTransactions(storage, path.join(workspace, 'Form1.cs'), restoredSource);
    expect(result.requiresManual).toBe(false); expect(result.entries[0].outcome).toBe(backup === 'current' ? 'committed' : 'rolledBack');
    expect(fs.readFileSync(resource, 'utf8')).toBe(backup === 'current' ? 'resource-after' : 'resource-before');
    const ledger = new HostMutationLedger(storage, path.join(workspace, 'Form1.cs'), () => ({ sourceText: restoredSource, revision: 0, sourceFilePath: source }));
    expect(ledger.observe('op')).toMatchObject({ status: 'committed', commitCount: 1 });
    let secondEdits = 0;
    expect(await ledger.run({ type: 'resource', value: 'after' }, async () => { secondEdits++; }, 'op')).toMatchObject({ replayed: true, status: 'committed' });
    expect(secondEdits).toBe(0);
  }, 20_000);
});
