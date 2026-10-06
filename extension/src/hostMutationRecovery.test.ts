import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sha256Hex } from './documentStore';
import { HostMutationLedger, currentHostMutationIdentity, hostMutationRecordPath } from './mutationOperation';
import { runDesignerResourceTransaction } from './resourceTransactionCoordinator';
import { recoverPendingTransactions, reconcileRestoredDocumentTransactions } from './transactionRecovery';
import { readJournalFile, writeJournalFile } from './transactionJournal';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
async function fixture(hostCommitted: boolean) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wfd-host-outcome-')); directories.push(root);
  const storage = path.join(root, 'storage'); const workspace = path.join(root, 'project'); fs.mkdirSync(workspace);
  const resource = path.join(workspace, 'Form1.resx'); fs.writeFileSync(resource, 'resource-before');
  const source = path.join(workspace, 'Form1.Designer.cs'); fs.writeFileSync(source, 'source-before');
  const state = { sourceText: 'source-before', revision: 0, sourceFilePath: source };
  const ledger = new HostMutationLedger(storage, path.join(workspace, 'Form1.cs'), () => state);
  const journalRoot = path.join(storage, 'v2-transactions', 'project');
  await ledger.run({ type: 'resource', value: 'after' }, async () => {
    ledger.stageCommit('source-after', [{ filePath: resource, beforeSha256: sha256Hex('resource-before'), afterSha256: sha256Hex('resource-after') }], 'tx');
    const identity = currentHostMutationIdentity()!;
    const result = await runDesignerResourceTransaction({
      transactionId: 'tx', label: 'resource', workspaceRoot: workspace, journalRoot,
      hostOperation: { ...identity, commit: 'pending' },
      targets: [{ filePath: resource, before: 'resource-before', after: 'resource-after', bom: false }],
      readBytes: async (file) => { try { return fs.readFileSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; } },
      writeBytes: async (file, bytes) => { fs.writeFileSync(file, bytes); },
      deleteFile: async (file) => { fs.unlinkSync(file); }, registerUndo: () => true,
    });
    expect(result.status).toBe('committed');
    if (hostCommitted) {
      state.sourceText = 'source-after'; state.revision++;
      ledger.finishCommit(true, true);
    }
    // Simulate an interrupted host stack. The process-termination suite covers this boundary without catches.
    if (!hostCommitted) throw new Error('simulated host stop');
  }, 'op').catch((error) => { if (hostCommitted) throw error; });
  return { storage, resource, ledger, state, source, workspace, journalRoot, documentId: path.join(workspace, 'Form1.cs'), journal: path.join(journalRoot, 'tx.json') };
}
describe('resource runner to sole host owner crash reconciliation', () => {
  it('compensates runner-committed resources when the host did not commit source/Undo', async () => {
    const { storage, resource, documentId } = await fixture(false);
    const recovered = await recoverPendingTransactions(storage);
    expect(recovered.deferred).toBe(1);
    const restored = await reconcileRestoredDocumentTransactions(storage, documentId, 'source-before');
    expect(restored.entries[0].outcome).toBe('rolledBack'); expect(restored.requiresManual).toBe(false);
    expect(fs.readFileSync(resource, 'utf8')).toBe('resource-before');
  });
  it('retains the established host commit after verifying the actual journal targets', async () => {
    const { storage, resource, ledger, documentId } = await fixture(true);
    const recovered = await recoverPendingTransactions(storage);
    expect(recovered.deferred).toBe(1); expect(recovered.committed).toBe(0);
    expect((await reconcileRestoredDocumentTransactions(storage, documentId, 'source-after')).entries[0].outcome).toBe('committed');
    expect(fs.readFileSync(resource, 'utf8')).toBe('resource-after');
    expect(ledger.observe('op')?.commitCount).toBe(1);
  });
  it('preserves a conflicting external resource and retains a journal requiring manual resolution', async () => {
    const { storage, resource, journal, documentId } = await fixture(true);
    fs.writeFileSync(resource, 'external');
    const recovered = await recoverPendingTransactions(storage);
    expect(recovered.deferred).toBe(1); expect(recovered.committed).toBe(0);
    expect((await reconcileRestoredDocumentTransactions(storage, documentId, 'source-after')).requiresManual).toBe(true);
    expect(fs.readFileSync(resource, 'utf8')).toBe('external');
    expect((await readJournalFile(journal))?.state).toBe('recoveryRequired');
  });
  it('reconciles a fully acknowledged resource journal against a stale backup instead of assuming native Undo survived', async () => {
    const { storage, resource, journal, documentId, ledger } = await fixture(true);
    const record = (await readJournalFile(journal))!;
    await writeJournalFile(journal, { ...record, hostOperation: { ...record.hostOperation!, commit: 'committed' } });
    expect((await recoverPendingTransactions(storage)).deferred).toBe(1);
    expect((await reconcileRestoredDocumentTransactions(storage, documentId, 'source-before')).requiresManual).toBe(false);
    expect(fs.readFileSync(resource, 'utf8')).toBe('resource-before');
    expect(ledger.observe('op')).toMatchObject({ status: 'committed', commitCount: 1 });
  });
  it('retains resources after a later established scalar edit supersedes their source image', async () => {
    const { storage, resource, ledger, state, documentId } = await fixture(true);
    await ledger.run({ type: 'edit', value: 'latest' }, async () => {
      ledger.stageCommit('source-latest'); state.sourceText = 'source-latest'; state.revision++; ledger.finishCommit(true, true);
    }, 'scalar');
    expect((await recoverPendingTransactions(storage)).deferred).toBe(1);
    const restored = await reconcileRestoredDocumentTransactions(storage, documentId, 'source-latest');
    expect(restored.requiresManual).toBe(false); expect(restored.entries[0].outcome).toBe('committed');
    expect(fs.readFileSync(resource, 'utf8')).toBe('resource-after');
  });
  it.each(['source-latest', 'source-after', 'source-before'])('reconciles successive resource edits against actual restored %s', async (restoredSource) => {
    const { storage, resource, ledger, state, documentId, workspace, journalRoot } = await fixture(true);
    await ledger.run({ type: 'resource', value: 'latest' }, async () => {
      ledger.stageCommit('source-latest', [{ filePath: resource, beforeSha256: sha256Hex('resource-after'), afterSha256: sha256Hex('resource-latest') }], 'tx-next');
      const result = await runDesignerResourceTransaction({ transactionId: 'tx-next', label: 'resource-next', workspaceRoot: workspace, journalRoot,
        hostOperation: { ...currentHostMutationIdentity()!, commit: 'pending' },
        targets: [{ filePath: resource, before: 'resource-after', after: 'resource-latest', bom: false }],
        readBytes: async (file) => fs.readFileSync(file), writeBytes: async (file, bytes) => { fs.writeFileSync(file, bytes); },
        deleteFile: async (file) => { fs.unlinkSync(file); }, registerUndo: () => true });
      expect(result.status).toBe('committed'); state.sourceText = 'source-latest'; state.revision++; ledger.finishCommit(true, true);
    }, 'resource-next');
    expect((await recoverPendingTransactions(storage)).deferred).toBe(2);
    const restored = await reconcileRestoredDocumentTransactions(storage, documentId, restoredSource);
    expect(restored.requiresManual).toBe(false);
    expect(fs.readFileSync(resource, 'utf8')).toBe(restoredSource === 'source-latest' ? 'resource-latest' : restoredSource === 'source-after' ? 'resource-after' : 'resource-before');
  });
  it('includes an established resource-only successor with unchanged source hashes', async () => {
    const { storage, resource, ledger, state, documentId } = await fixture(true);
    await ledger.run({ type: 'resource', value: 'latest' }, async () => {
      ledger.stageCommit(state.sourceText, [{ filePath: resource, beforeSha256: sha256Hex('resource-after'), afterSha256: sha256Hex('resource-latest') }]);
      fs.writeFileSync(resource, 'resource-latest'); state.revision++; ledger.finishCommit(true, true);
    }, 'resource-only');
    expect((await recoverPendingTransactions(storage)).deferred).toBe(1);
    const restored = await reconcileRestoredDocumentTransactions(storage, documentId, 'source-after');
    expect(restored.requiresManual).toBe(false); expect(restored.entries[0].outcome).toBe('committed');
    expect(fs.readFileSync(resource, 'utf8')).toBe('resource-latest');
  });
  it('terminalizes an acknowledged exact no-change source/resource transaction at startup', async () => {
    const { storage, resource, ledger, state, documentId, workspace, journalRoot } = await fixture(true);
    fs.writeFileSync(resource, 'resource-after'); fs.writeFileSync(state.sourceFilePath, state.sourceText);
    await ledger.run({ type: 'resource', value: 'same' }, async () => {
      ledger.stageCommit(state.sourceText, [{ filePath: resource, beforeSha256: sha256Hex('resource-after'), afterSha256: sha256Hex('resource-after') }], 'tx-same');
      const result = await runDesignerResourceTransaction({ transactionId: 'tx-same', label: 'resource-same', workspaceRoot: workspace, journalRoot,
        hostOperation: { ...currentHostMutationIdentity()!, commit: 'committed' },
        targets: [{ filePath: resource, before: 'resource-after', after: 'resource-after', bom: false }], readBytes: async (file) => fs.readFileSync(file),
        writeBytes: async () => {}, deleteFile: async () => {}, registerUndo: () => true });
      expect(result.status).toBe('committed'); ledger.finishCommit(true, false);
    }, 'same');
    const recovered = await recoverPendingTransactions(storage);
    expect(recovered.manual + recovered.corrupt).toBe(0); expect(recovered.deferred).toBe(1); expect(recovered.committed).toBe(1);
    expect(ledger.observe('same')).toMatchObject({ status: 'noChange', commitCount: 0 });
    expect((await reconcileRestoredDocumentTransactions(storage, documentId, state.sourceText)).requiresManual).toBe(false);
  });

  it('refuses a linked outcome receipt before reading its redirected bytes', async () => {
    const { storage, journal, documentId } = await fixture(true);
    const original = hostMutationRecordPath(storage, documentId, 'op');
    const otherDirectory = path.join(storage, 'other'); fs.mkdirSync(otherDirectory);
    const redirected = path.join(otherDirectory, path.basename(original)); fs.renameSync(original, redirected);
    // A directory junction works without Windows symlink privilege and redirects the exact JSON receipt path.
    fs.rmdirSync(path.dirname(original));
    fs.symlinkSync(otherDirectory, path.dirname(original), process.platform === 'win32' ? 'junction' : 'dir');
    expect((await recoverPendingTransactions(storage)).manual).toBe(1);
    expect((await readJournalFile(journal))?.error).toContain('traverses a link');
  });
  it('refuses a linked source witness before reading outside the owning project', async () => {
    const { storage, journal, source, workspace, ledger, documentId } = await fixture(true);
    const linkedDirectory = path.join(workspace, 'linked');
    const outside = path.join(storage, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'Form1.Designer.cs'), 'source-after');
    fs.symlinkSync(outside, linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir');
    const receiptPath = hostMutationRecordPath(storage, documentId, 'op');
    const receipt = ledger.observe('op')!;
    fs.writeFileSync(receiptPath, JSON.stringify({ ...receipt, sourceFilePath: path.join(linkedDirectory, path.basename(source)) }));
    expect((await recoverPendingTransactions(storage)).manual).toBe(1);
    expect((await readJournalFile(journal))?.error).toContain('traverses a link');
  });

  it('accepts a saved/reopened ledger successor whose local document revision restarts at zero', async () => {
    const { storage, ledger, resource, state, source, documentId } = await fixture(true);
    fs.writeFileSync(source, state.sourceText);
    const reopenedState = { sourceText: state.sourceText, revision: 0, sourceFilePath: source };
    const reopened = new HostMutationLedger(storage, documentId, () => reopenedState);
    await reopened.run({ type: 'edit', value: 'reopened' }, async () => {
      reopened.stageCommit('source-reopened'); reopenedState.sourceText = 'source-reopened'; reopenedState.revision++; reopened.finishCommit(true, true);
    }, 'reopened');
    expect(ledger.observe('op')?.baseRevision).toBe(0); expect(reopened.observe('reopened')?.baseRevision).toBe(0);
    fs.writeFileSync(source, reopenedState.sourceText);
    expect((await recoverPendingTransactions(storage)).deferred).toBe(1);
    expect((await reconcileRestoredDocumentTransactions(storage, documentId, reopenedState.sourceText)).requiresManual).toBe(false);
    expect(fs.readFileSync(resource, 'utf8')).toBe('resource-after');
  });
  it('does not delete a changed-source journal just because disk matches before an older backup is restored', async () => {
    const { storage, source, resource, state, documentId } = await fixture(true);
    fs.writeFileSync(source, state.sourceText);
    expect((await recoverPendingTransactions(storage)).deferred).toBe(1);
    const restored = await reconcileRestoredDocumentTransactions(storage, documentId, 'source-before');
    expect(restored.requiresManual).toBe(true); expect(restored.entries[0].outcome).toBe('manual');
    expect(fs.readFileSync(resource, 'utf8')).toBe('resource-after');
    // Reopening the actual saved forward source verifies the preserved resources and clears the durable conflict.
    const reopened = await reconcileRestoredDocumentTransactions(storage, documentId, state.sourceText);
    expect(reopened.requiresManual).toBe(false); expect(reopened.entries[0].outcome).toBe('committed');
  });

});
