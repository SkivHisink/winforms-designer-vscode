import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { atomicWriteLocalFile } from './atomicFile';
import { runDesignerResourceTransaction } from './resourceTransactionCoordinator';
import { recoverPendingTransactions } from './transactionRecovery';
import { TransactionCrashInjectionError, TransactionCrashPoint } from './transactionRunner';

const scratch: string[] = [];
function temp(): string { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wfd-r23-transaction-')); scratch.push(root); return root; }
afterEach(() => { for (const root of scratch.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
async function read(file: string): Promise<Buffer | null> {
  try { return await fs.promises.readFile(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
interface Artifact { name: string; before: string | null; after: string | null; }
const sets: Array<{ name: string; artifacts: Artifact[] }> = [
  { name: 'event source files', artifacts: [
    { name: 'Form1.Designer.cs', before: 'wiring-before', after: 'wiring-after' },
    { name: 'Form1.cs', before: 'code-before', after: 'code-with-handler' },
  ] },
  { name: 'localized control add/delete', artifacts: [
    { name: 'Form1.Designer.cs', before: 'controls-before', after: 'controls-after' },
    { name: 'Form1.resx', before: 'neutral-before', after: 'neutral-after' },
    { name: 'Form1.fr.resx', before: 'culture-before', after: 'culture-after' },
  ] },
  { name: 'image import', artifacts: [
    { name: 'Form1.Designer.cs', before: 'source-before', after: 'source-with-image' },
    { name: 'Form1.resx', before: null, after: 'resx-with-base64-image' },
  ] },
  { name: 'Save As linked form/project', artifacts: [
    { name: 'Copy.cs', before: null, after: 'new-main' },
    { name: 'Copy.Designer.cs', before: null, after: 'new-generated' },
    { name: 'Copy.resx', before: null, after: 'new-neutral' },
    { name: 'Copy.fr.resx', before: null, after: 'new-culture' },
    { name: 'App.csproj', before: 'project-before', after: 'project-with-copy-membership' },
  ] },
];

describe.each(sets)('2.3 transaction file-set mechanics: $name', ({ artifacts }) => {
  const crashes: Array<{ point: TransactionCrashPoint; occurrence: number }> = [
    ...(['preparedPersisted', 'undoRegistered', 'committedPersisted'] as const).map((point) => ({ point, occurrence: 1 })),
    ...artifacts.map((_, index) => ({ point: 'targetWritten' as const, occurrence: index + 1 })),
    ...artifacts.map((_, index) => ({ point: 'targetApplied' as const, occurrence: index + 1 })),
  ];
  it.each(crashes)('recovers $point occurrence $occurrence', async ({ point, occurrence }) => {
    const root = temp(); const storage = temp();
    for (const artifact of artifacts) if (artifact.before !== null) fs.writeFileSync(path.join(root, artifact.name), artifact.before);
    let seen = 0;
    await expect(runDesignerResourceTransaction({ label: '2.3 file-set mechanics', workspaceRoot: root,
      journalRoot: path.join(storage, 'v2-transactions', 'workspace'),
      targets: artifacts.map((artifact) => ({ filePath: path.join(root, artifact.name), before: artifact.before, after: artifact.after, bom: false })),
      readBytes: read, writeBytes: atomicWriteLocalFile, deleteFile: (file) => fs.promises.unlink(file), registerUndo: () => true,
      crashHook: (phase) => { if (phase === point && ++seen === occurrence) throw new TransactionCrashInjectionError('injected process death'); },
    })).rejects.toThrow('injected process death');
    const crashBytes = await Promise.all(artifacts.map((artifact) => read(path.join(root, artifact.name))));
    const recovery = await recoverPendingTransactions(storage);
    const committed = point === 'committedPersisted';
    const unacknowledgedCreate = point === 'targetWritten' && artifacts[occurrence - 1].before !== artifacts[occurrence - 1].after;
    if (unacknowledgedCreate) {
      expect(recovery.manual).toBe(1);
      expect(recovery.entries[0].detail).toContain('ownership of unacknowledged write');
      for (let index = 0; index < artifacts.length; index++) expect(await read(path.join(root, artifacts[index].name))).toEqual(crashBytes[index]);
      return;
    }
    expect(recovery.manual + recovery.corrupt).toBe(0);
    expect(recovery.committed).toBe(committed ? 1 : 0);
    for (const artifact of artifacts) expect((await read(path.join(root, artifact.name)))?.toString() ?? null)
      .toBe(committed ? artifact.after : artifact.before);
  });
});

describe('2.3 deterministic filesystem and cancellation faults', () => {
  it.each(['EACCES', 'ENOSPC', 'cancel'] as const)('compensates source after injected %s before a linked write', async (fault) => {
    const root = temp(); const storage = temp(); let cancelled = false;
    const source = path.join(root, 'Form1.Designer.cs'); const resx = path.join(root, 'Form1.resx');
    fs.writeFileSync(source, 'before-source'); fs.writeFileSync(resx, 'before-resx');
    const result = await runDesignerResourceTransaction({ label: `injected ${fault}`, workspaceRoot: root,
      journalRoot: path.join(storage, 'v2-transactions', 'workspace'),
      targets: [{ filePath: source, before: 'before-source', after: 'after-source', bom: false },
        { filePath: resx, before: 'before-resx', after: 'after-resx', bom: false }],
      readBytes: read, isCancellationRequested: () => cancelled,
      writeBytes: async (file, bytes) => {
        if (file === resx && fault !== 'cancel') throw Object.assign(new Error(`injected ${fault}`), { code: fault });
        await atomicWriteLocalFile(file, bytes);
      }, deleteFile: (file) => fs.promises.unlink(file), registerUndo: () => true,
      crashHook: (point) => { if (fault === 'cancel' && point === 'targetApplied') cancelled = true; },
    });
    expect(result.status).toBe('rolledBack');
    expect(await fs.promises.readFile(source, 'utf8')).toBe('before-source');
    expect(await fs.promises.readFile(resx, 'utf8')).toBe('before-resx');
  });
});
