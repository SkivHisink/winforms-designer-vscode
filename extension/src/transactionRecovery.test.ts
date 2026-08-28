import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runDesignerResourceTransaction } from './resourceTransactionCoordinator';
import { readJournalFile } from './transactionJournal';
import { recoverPendingTransactions } from './transactionRecovery';
import { TransactionCrashInjectionError, TransactionCrashPoint } from './transactionRunner';

const scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfd-recovery-'));
  scratch.push(dir);
  return dir;
}

async function readNullable(filePath: string): Promise<Uint8Array | null> {
  try { return await fs.promises.readFile(filePath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

describe('startup transaction recovery', () => {
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
    'recovers a process death at %s occurrence %i to the durable %s image',
    async (crashPoint, crashOccurrence, expectedImage) => {
      const workspaceRoot = tempDir();
      const globalStorage = tempDir();
      const journalRoot = path.join(globalStorage, 'v2-transactions', 'workspace-hash');
      const designer = path.join(workspaceRoot, 'Form1.Designer.cs');
      const resx = path.join(workspaceRoot, 'Form1.resx');
      const beforeDesigner = 'designer-before';
      const beforeResx = 'resx-before';
      const afterDesigner = 'designer-after';
      const afterResx = 'resx-after';
      await fs.promises.writeFile(designer, beforeDesigner, 'utf8');
      await fs.promises.writeFile(resx, beforeResx, 'utf8');
      let occurrences = 0;

      await expect(runDesignerResourceTransaction({
        label: 'crash recovery proof',
        workspaceRoot,
        journalRoot,
        transactionId: `crash-${crashPoint}-${crashOccurrence}`,
        targets: [
          { filePath: designer, before: beforeDesigner, after: afterDesigner, bom: false },
          { filePath: resx, before: beforeResx, after: afterResx, bom: false },
        ],
        readBytes: readNullable,
        writeBytes: async (filePath, bytes) => {
          await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
          await fs.promises.writeFile(filePath, bytes);
        },
        deleteFile: async (filePath) => { await fs.promises.rm(filePath, { force: true }); },
        registerUndo: () => true,
        crashHook: (point: TransactionCrashPoint) => {
          if (point !== crashPoint || ++occurrences !== crashOccurrence) return;
          throw new TransactionCrashInjectionError(`process died at ${point}`);
        },
      })).rejects.toThrow(`process died at ${crashPoint}`);

      const summary = await recoverPendingTransactions(globalStorage);
      const committed = expectedImage === 'after';
      expect(summary.committed).toBe(committed ? 1 : 0);
      expect(summary.rolledBack + summary.discarded).toBe(committed ? 0 : 1);
      expect(await fs.promises.readFile(designer, 'utf8')).toBe(committed ? afterDesigner : beforeDesigner);
      expect(await fs.promises.readFile(resx, 'utf8')).toBe(committed ? afterResx : beforeResx);
      expect(fs.existsSync(path.join(journalRoot, `crash-${crashPoint}-${crashOccurrence}.json`))).toBe(false);
    },
  );

  it('retains a recoveryRequired journal and never overwrites an unexpected user edit', async () => {
    const workspaceRoot = tempDir();
    const globalStorage = tempDir();
    const journalRoot = path.join(globalStorage, 'v2-transactions', 'workspace-hash');
    const designer = path.join(workspaceRoot, 'Form1.Designer.cs');
    const resx = path.join(workspaceRoot, 'Form1.resx');
    await fs.promises.writeFile(designer, 'designer-before', 'utf8');
    await fs.promises.writeFile(resx, 'resx-before', 'utf8');

    await expect(runDesignerResourceTransaction({
      label: 'conflicting crash recovery proof',
      workspaceRoot,
      journalRoot,
      transactionId: 'conflicting-recovery',
      targets: [
        { filePath: designer, before: 'designer-before', after: 'designer-after', bom: false },
        { filePath: resx, before: 'resx-before', after: 'resx-after', bom: false },
      ],
      readBytes: readNullable,
      writeBytes: async (filePath, bytes) => { await fs.promises.writeFile(filePath, bytes); },
      deleteFile: async (filePath) => { await fs.promises.rm(filePath, { force: true }); },
      registerUndo: () => true,
      crashHook: (point) => {
        if (point === 'appliedPersisted') throw new TransactionCrashInjectionError('process died after apply');
      },
    })).rejects.toThrow('process died after apply');

    await fs.promises.writeFile(resx, 'user-edited-after-crash', 'utf8');
    const summary = await recoverPendingTransactions(globalStorage);
    expect(summary.manual).toBe(1);
    expect(await fs.promises.readFile(designer, 'utf8')).toBe('designer-after');
    expect(await fs.promises.readFile(resx, 'utf8')).toBe('user-edited-after-crash');
    expect((await readJournalFile(path.join(journalRoot, 'conflicting-recovery.json')))?.state).toBe('recoveryRequired');
  });

  it('retains corrupt journals for diagnosis instead of guessing or deleting them', async () => {
    const globalStorage = tempDir();
    const journalRoot = path.join(globalStorage, 'v2-transactions', 'workspace-hash');
    const journal = path.join(journalRoot, 'corrupt.json');
    await fs.promises.mkdir(journalRoot, { recursive: true });
    await fs.promises.writeFile(journal, '{"schemaVersion":"2.0.0","state":"applying"}', 'utf8');

    const summary = await recoverPendingTransactions(globalStorage);
    expect(summary.corrupt).toBe(1);
    expect(fs.existsSync(journal)).toBe(true);
  });
});
