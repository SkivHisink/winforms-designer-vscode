import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { artifactFingerprint, snapshotArtifactBytes } from './documentStore';
import { HostMutationLedger } from './mutationOperation';
import { readRecoveryTimeline } from './recoveryTimeline';
import { createJournalRecord, writeJournalFile } from './transactionJournal';

const scratch: string[] = [];
function temp(): string { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfd-timeline-')); scratch.push(dir); return dir; }
afterEach(() => { for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe('redacted recovery timeline', () => {
  it('projects failure and restore points without source images or raw errors', async () => {
    const root = temp(); const storage = temp();
    const source = path.join(root, 'Form1.Designer.cs');
    const document = path.join(root, 'Form1.cs');
    const privateSource = 'private-source-and-error-must-not-appear';
    const before = Buffer.from(privateSource); const after = Buffer.from('after-source');
    const record = createJournalRecord({ transactionId: 'failed-operation', patchSetId: 'patch', workspaceRoot: root,
      nowUtc: '2026-10-22T00:00:00.000Z', baseFingerprints: { 'Form1.Designer.cs': artifactFingerprint(snapshotArtifactBytes('source', before)) },
      afterFingerprints: { 'Form1.Designer.cs': artifactFingerprint(snapshotArtifactBytes('source', after)) },
      beforeBytesBase64: { 'Form1.Designer.cs': before.toString('base64') }, afterBytesBase64: { 'Form1.Designer.cs': after.toString('base64') } });
    await writeJournalFile(path.join(storage, 'v2-transactions', 'workspace', 'failed.json'),
      { ...record, state: 'recoveryRequired', error: privateSource });
    const timeline = await readRecoveryTimeline(storage, document, source);
    expect(timeline).toEqual([{ id: 'failed-operation', timeUtc: '2026-10-22T00:00:00.000Z', state: 'recoveryRequired',
      affectedFiles: ['Form1.Designer.cs'], restorePoint: true, failure: true }]);
    expect(JSON.stringify(timeline)).not.toContain(privateSource);
    expect(JSON.stringify(timeline)).not.toContain(before.toString('base64'));
    expect(JSON.stringify(timeline)).not.toContain(root.replace(/\\/g, '\\\\'));
  });

  it('retains only the latest 20 document operations and ignores unrelated documents', async () => {
    const root = temp(); const storage = temp(); const document = path.join(root, 'Form1.cs');
    const ledger = new HostMutationLedger(storage, document, () => ({ sourceText: 'baseline', revision: 0 }));
    for (let index = 0; index < 25; index++) await ledger.run({ type: 'property', index }, async () => {
      ledger.stageCommit(`source-${index}`); ledger.finishCommit(true, true);
    }, `operation-${index}`);
    const unrelated = new HostMutationLedger(storage, path.join(root, 'Other.cs'), () => ({ sourceText: 'other', revision: 0 }));
    await unrelated.run({ type: 'other' }, async () => unrelated.finishCommit(false, false), 'other-operation');
    const timeline = await readRecoveryTimeline(storage, document, null);
    expect(timeline).toHaveLength(20);
    expect(timeline.every((entry) => entry.state === 'committed')).toBe(true);
    expect(timeline.find((entry) => entry.id === 'other-operation')).toBeUndefined();
  });
});
