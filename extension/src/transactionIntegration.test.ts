import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { readJournalFile } from './transactionJournal';
import { runDesignerResourceTransaction } from './resourceTransactionCoordinator';

const scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfd-designer-resource-tx-'));
  scratch.push(dir);
  return dir;
}

function io() {
  return {
    readBytes: async (filePath: string): Promise<Uint8Array | null> => {
      try {
        return await fs.promises.readFile(filePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
    writeBytes: async (filePath: string, bytes: Uint8Array): Promise<void> => {
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      await fs.promises.writeFile(filePath, bytes);
    },
    deleteFile: async (filePath: string): Promise<void> => {
      await fs.promises.rm(filePath, { force: true });
    },
  };
}

describe('designer resource transaction integration', () => {
  it('writes .resx bytes and persists committed only after undo registration', async () => {
    const workspaceRoot = tempDir();
    const journalRoot = path.join(tempDir(), 'journals');
    const resx = path.join(workspaceRoot, 'Form1.resx');
    await fs.promises.writeFile(resx, 'old', 'utf8');
    const undoRegistrations: string[] = [];

    const result = await runDesignerResourceTransaction({
      label: 'Set button1.Text',
      workspaceRoot,
      journalRoot,
      transactionId: 'tx-resource-1',
      targets: [{ filePath: resx, before: 'old', after: 'new', bom: false }],
      ...io(),
      registerUndo: async () => {
        undoRegistrations.push(await fs.promises.readFile(resx, 'utf8'));
        return true;
      },
    });

    expect(result.status).toBe('committed');
    expect(await fs.promises.readFile(resx, 'utf8')).toBe('new');
    expect(undoRegistrations).toEqual(['new']);
    expect((await readJournalFile(path.join(journalRoot, 'tx-resource-1.json')))?.state).toBe('committed');
  });

  it('keeps the journal-backed registration for native undo and redoes as a fresh durable transaction', async () => {
    const workspaceRoot = tempDir();
    const journalRoot = path.join(tempDir(), 'journals');
    const resx = path.join(workspaceRoot, 'Form1.resx');
    await fs.promises.writeFile(resx, 'old', 'utf8');

    const applied = await runDesignerResourceTransaction({
      label: 'Edit image resource',
      workspaceRoot,
      journalRoot,
      transactionId: 'tx-native-undo-redo',
      targets: [{ filePath: resx, before: 'old', after: 'new', bom: false }],
      ...io(),
      registerUndo: () => true,
    });
    expect(applied.status).toBe('committed');
    expect(applied.undoRegistration).toBeDefined();

    const undone = await applied.undoRegistration!.undo();
    expect(undone.status).toBe('rolledBack');
    expect(await fs.promises.readFile(resx, 'utf8')).toBe('old');

    const redone = await applied.undoRegistration!.redo();
    expect(redone.status).toBe('committed');
    expect(redone.undoRegistration).toBeDefined();
    expect(await fs.promises.readFile(resx, 'utf8')).toBe('new');

    expect((await redone.undoRegistration!.undo()).status).toBe('rolledBack');
    expect(await fs.promises.readFile(resx, 'utf8')).toBe('old');
  });

  it('binds a declared before image and refuses a stale resource before creating a journal', async () => {
    const workspaceRoot = tempDir();
    const journalRoot = path.join(tempDir(), 'journals');
    const resx = path.join(workspaceRoot, 'Form1.resx');
    await fs.promises.writeFile(resx, 'external', 'utf8');

    await expect(runDesignerResourceTransaction({
      label: 'Stale image import',
      workspaceRoot,
      journalRoot,
      transactionId: 'tx-stale-declared-before',
      targets: [{ filePath: resx, before: 'old', after: 'new', bom: false }],
      ...io(),
      registerUndo: () => true,
    })).rejects.toThrow('resource transaction baseline is stale');

    expect(await fs.promises.readFile(resx, 'utf8')).toBe('external');
    expect(fs.existsSync(path.join(journalRoot, 'tx-stale-declared-before.json'))).toBe(false);
  });

  it('rolls back the resource when VS Code undo registration refuses', async () => {
    const workspaceRoot = tempDir();
    const journalRoot = path.join(tempDir(), 'journals');
    const resx = path.join(workspaceRoot, 'Form1.resx');
    await fs.promises.writeFile(resx, 'old', 'utf8');

    const result = await runDesignerResourceTransaction({
      label: 'Set button1.Text',
      workspaceRoot,
      journalRoot,
      transactionId: 'tx-resource-refused',
      targets: [{ filePath: resx, before: 'old', after: 'new', bom: false }],
      ...io(),
      registerUndo: () => false,
    });

    expect(result.status).toBe('rolledBack');
    expect(result.error).toContain('undo registration refused');
    expect(await fs.promises.readFile(resx, 'utf8')).toBe('old');
    expect((await readJournalFile(path.join(journalRoot, 'tx-resource-refused.json')))?.state).toBe('rolledBack');
  });

  it('V2-FND-001-S118 restores exact resource bytes when the verified forward postcondition is rejected', async () => {
    const workspaceRoot = tempDir();
    const journalRoot = path.join(tempDir(), 'journals');
    const resx = path.join(workspaceRoot, 'Form1.resx');
    const before = '<root>\r\n  <data name="opaque"><value>keep</value></data>\r\n</root>\r\n';
    const after = '<root>\r\n  <data name="imageList1.ImageStream"><value>binary</value></data>\r\n</root>\r\n';
    await fs.promises.writeFile(resx, before, 'utf8');
    const phases: string[] = [];

    const result = await runDesignerResourceTransaction({
      label: 'Edit imageList1 images',
      workspaceRoot,
      journalRoot,
      transactionId: 'tx-s118-postcondition',
      targets: [{ filePath: resx, before, after, bom: false }],
      ...io(),
      afterVerifiedPostconditions: (phase) => {
        phases.push(phase);
        return phase !== 'forward';
      },
      registerUndo: () => true,
    });

    expect(result.status).toBe('rolledBack');
    expect(result.error).toContain('transaction postcondition verification failed');
    expect(await fs.promises.readFile(resx, 'utf8')).toBe(before);
    expect(phases).toEqual(['forward', 'rollback']);
    expect((await readJournalFile(path.join(journalRoot, 'tx-s118-postcondition.json')))?.state).toBe('rolledBack');
  });

  it('rolls back the resource when undo registration throws', async () => {
    const workspaceRoot = tempDir();
    const journalRoot = path.join(tempDir(), 'journals');
    const resx = path.join(workspaceRoot, 'Form1.resx');
    await fs.promises.writeFile(resx, 'old', 'utf8');
    let sourceFlushAttempted = false;

    const result = await runDesignerResourceTransaction({
      label: 'Register native undo',
      workspaceRoot,
      journalRoot,
      transactionId: 'tx-localizable-source-flush-failed',
      targets: [{ filePath: resx, before: 'old', after: 'new', bom: false }],
      ...io(),
      registerUndo: async () => {
        sourceFlushAttempted = true;
        throw new Error('source flush failed');
      },
    });

    expect(sourceFlushAttempted).toBe(true);
    expect(result.status).toBe('rolledBack');
    expect(result.error).toContain('source flush failed');
    expect(await fs.promises.readFile(resx, 'utf8')).toBe('old');
    expect((await readJournalFile(path.join(journalRoot, 'tx-localizable-source-flush-failed.json')))?.state).toBe('rolledBack');
  });

  it.each(['applied', 'undoRegistered', 'committed'] as const)(
    'restores explicit designer source and resx targets when %s journal persistence fails',
    async (failedState) => {
      const workspaceRoot = tempDir();
      const journalRoot = path.join(tempDir(), 'journals');
      const designer = path.join(workspaceRoot, 'Form1.Designer.cs');
      const resx = path.join(workspaceRoot, 'Form1.resx');
      const beforeDesigner = 'partial class Form1 { /* plain */ }\r\n';
      const afterDesigner = 'partial class Form1 { /* ApplyResources */ }\r\n';
      const beforeResx = '<root />\r\n';
      const afterResx = '<root><data name="$this.Text" /></root>\r\n';
      await fs.promises.writeFile(designer, beforeDesigner, 'utf8');
      await fs.promises.writeFile(resx, beforeResx, 'utf8');
      let injected = false;

      const result = await runDesignerResourceTransaction({
        label: 'Make localizable',
        workspaceRoot,
        journalRoot,
        transactionId: `tx-localizable-${failedState}-failed`,
        targets: [
          { filePath: designer, before: beforeDesigner, after: afterDesigner, bom: false },
          { filePath: resx, before: beforeResx, after: afterResx, bom: false },
        ],
        ...io(),
        beforePersistJournal: (record) => {
          if (record.state !== failedState || injected) return;
          injected = true;
          throw new Error(`forced ${failedState} journal failure`);
        },
        registerUndo: () => true,
      });

      expect(injected).toBe(true);
      expect(result.status).toBe('rolledBack');
      expect(result.error).toContain(`forced ${failedState} journal failure`);
      expect(await fs.promises.readFile(designer, 'utf8')).toBe(beforeDesigner);
      expect(await fs.promises.readFile(resx, 'utf8')).toBe(beforeResx);
      expect((await readJournalFile(path.join(
        journalRoot,
        `tx-localizable-${failedState}-failed.json`,
      )))?.state).toBe('rolledBack');
    },
  );

  it('refuses when a target changes between baseline snapshot and write', async () => {
    const workspaceRoot = tempDir();
    const journalRoot = path.join(tempDir(), 'journals');
    const resx = path.join(workspaceRoot, 'Form1.resx');
    await fs.promises.writeFile(resx, 'old', 'utf8');
    let readCount = 0;

    const result = await runDesignerResourceTransaction({
      label: 'Set button1.Text',
      workspaceRoot,
      journalRoot,
      transactionId: 'tx-resource-conflict',
      targets: [{ filePath: resx, before: 'old', after: 'new', bom: false }],
      ...io(),
      readBytes: async (filePath) => {
        readCount++;
        if (readCount === 2) await fs.promises.writeFile(filePath, 'external', 'utf8');
        return await fs.promises.readFile(filePath);
      },
      registerUndo: () => true,
    });

    expect(result.status).toBe('aborted');
    expect(result.error).toContain('changed after baseline capture');
    expect(await fs.promises.readFile(resx, 'utf8')).toBe('external');
    expect((await readJournalFile(path.join(journalRoot, 'tx-resource-conflict.json')))?.state).toBe('aborted');
  });

  it('V2-FND-001-S080: refuses a localized resource write when the culture resx is stale', async () => {
    const workspaceRoot = tempDir();
    const journalRoot = path.join(tempDir(), 'journals');
    const localizedResx = path.join(workspaceRoot, 'Form1.fr-FR.resx');
    await fs.promises.writeFile(localizedResx, 'old localized text', 'utf8');
    let readCount = 0;

    const result = await runDesignerResourceTransaction({
      label: 'Set fr-FR label1.Text',
      workspaceRoot,
      journalRoot,
      transactionId: 'tx-s080-stale-localized-resx',
      targets: [{ filePath: localizedResx, before: 'old localized text', after: 'new localized text', bom: false }],
      ...io(),
      readBytes: async (filePath) => {
        readCount++;
        if (readCount === 2) await fs.promises.writeFile(filePath, 'external fr-FR edit', 'utf8');
        return await fs.promises.readFile(filePath);
      },
      registerUndo: () => true,
    });

    expect(result.status).toBe('aborted');
    expect(result.error).toContain('changed after baseline capture');
    expect(await fs.promises.readFile(localizedResx, 'utf8')).toBe('external fr-FR edit');
    expect((await readJournalFile(path.join(journalRoot, 'tx-s080-stale-localized-resx.json')))?.state).toBe('aborted');
  });

  it('rejects non-journalable targets outside the workspace before writing', async () => {
    const workspaceRoot = tempDir();
    const outsideRoot = tempDir();
    const journalRoot = path.join(tempDir(), 'journals');
    const outside = path.join(outsideRoot, 'Form1.resx');
    await fs.promises.writeFile(outside, 'old', 'utf8');
    let wrote = false;

    await expect(runDesignerResourceTransaction({
      label: 'Set button1.Text',
      workspaceRoot,
      journalRoot,
      transactionId: 'tx-resource-outside',
      targets: [{ filePath: outside, before: 'old', after: 'new', bom: false }],
      ...io(),
      writeBytes: async (filePath, bytes) => {
        wrote = true;
        await io().writeBytes(filePath, bytes);
      },
      registerUndo: () => true,
    })).rejects.toThrow('escapes workspace root');

    expect(wrote).toBe(false);
    expect(await fs.promises.readFile(outside, 'utf8')).toBe('old');
  });
});
