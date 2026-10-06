import * as fs from 'node:fs';
import * as path from 'node:path';
import { HostMutationLedger, currentHostMutationIdentity } from './mutationOperation';
import { sha256Hex } from './documentStore';
import { runDesignerResourceTransaction } from './resourceTransactionCoordinator';
import { writeJournalFile } from './transactionJournal';

interface Config { workspace: string; storage: string; acknowledged: boolean; backup: 'missing' | 'stale' | 'current'; }
async function main(): Promise<void> {
  const config = JSON.parse(Buffer.from(process.argv[2], 'base64url').toString('utf8')) as Config;
  const source = path.join(config.workspace, 'Form1.Designer.cs');
  const resource = path.join(config.workspace, 'Form1.resx');
  const state = { sourceText: 'source-before', revision: 0, sourceFilePath: source };
  const documentId = path.join(config.workspace, 'Form1.cs');
  const ledger = new HostMutationLedger(config.storage, documentId, () => state);
  const journalRoot = path.join(config.storage, 'v2-transactions', 'project');
  await ledger.run({ type: 'resource', value: 'after' }, async () => {
    ledger.stageCommit('source-after', [{ filePath: resource, beforeSha256: sha256Hex('resource-before'), afterSha256: sha256Hex('resource-after') }], 'tx');
    const result = await runDesignerResourceTransaction({ transactionId: 'tx', label: 'resource', workspaceRoot: config.workspace, journalRoot,
      hostOperation: { ...currentHostMutationIdentity()!, commit: 'pending' },
      targets: [{ filePath: resource, before: 'resource-before', after: 'resource-after', bom: false }],
      readBytes: async (file) => fs.readFileSync(file), writeBytes: async (file, bytes) => { fs.writeFileSync(file, bytes); },
      deleteFile: async (file) => { fs.unlinkSync(file); }, registerUndo: () => true });
    if (result.status !== 'committed') throw new Error(`resource transaction failed: ${result.status}`);
    state.sourceText = 'source-after'; state.revision++;
    ledger.finishCommit(true, true);
    if (config.acknowledged) await writeJournalFile(path.join(journalRoot, 'tx.json'), {
      ...result.journal, hostOperation: { ...result.journal.hostOperation!, commit: 'committed' },
    });
    if (config.backup !== 'missing') fs.writeFileSync(path.join(config.storage, 'source.backup'),
      config.backup === 'current' ? 'source-after' : 'source-before');
    process.send?.({ type: 'host-commit-ready' });
    // The parent terminates this real process. No finally/catch compensation or synthetic journal rewrite runs.
    await new Promise<void>(() => {});
  }, 'op');
}
void main().catch((error) => { process.stderr.write(`${String(error)}\n`); process.exitCode = 1; });
