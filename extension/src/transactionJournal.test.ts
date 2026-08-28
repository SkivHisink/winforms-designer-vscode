import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { artifactFingerprint, snapshotArtifactBytes } from './documentStore';
import {
  classifyJournalForRecovery,
  createJournalRecord,
  readJournalFile,
  transitionJournal,
  writeJournalFile,
} from './transactionJournal';

const scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfd-journal-'));
  scratch.push(dir);
  return dir;
}

const base = {
  'Form1.Designer.cs': artifactFingerprint(snapshotArtifactBytes('Form1.Designer.cs', Buffer.from('old', 'utf8'))),
};
const after = {
  'Form1.Designer.cs': artifactFingerprint(snapshotArtifactBytes('Form1.Designer.cs', Buffer.from('new', 'utf8'))),
};

function createTestJournal(nowUtc?: string) {
  return createJournalRecord({
    transactionId: 'tx1',
    patchSetId: 'ps1',
    workspaceRoot: path.resolve('C:/workspace'),
    baseFingerprints: base,
    afterFingerprints: after,
    beforeBytesBase64: { 'Form1.Designer.cs': Buffer.from('old', 'utf8').toString('base64') },
    afterBytesBase64: { 'Form1.Designer.cs': Buffer.from('new', 'utf8').toString('base64') },
    nowUtc,
  });
}

describe('transaction journal', () => {
  it('moves through valid states and appends applied targets immutably', () => {
    const created = createTestJournal('2026-08-20T00:00:00.000Z');
    const prepared = transitionJournal(created, 'prepared', { nowUtc: '2026-08-20T00:00:01.000Z' });
    const applying = transitionJournal(prepared, 'applying', {
      nowUtc: '2026-08-20T00:00:02.000Z',
      appliedTarget: 'Form1.Designer.cs',
    });
    const applied = transitionJournal(applying, 'applied');
    const undoRegistered = transitionJournal(applied, 'undoRegistered');
    const committed = transitionJournal(undoRegistered, 'committed');

    expect(created.state).toBe('created');
    expect(prepared.state).toBe('prepared');
    expect(applying.appliedTargets).toEqual(['Form1.Designer.cs']);
    expect(applied.state).toBe('applied');
    expect(committed.state).toBe('committed');
    expect(() => transitionJournal(applied, 'prepared')).toThrow('invalid journal transition');
  });

  it('classifies recovery work from an atomically replaced process-crash journal', () => {
    const created = createTestJournal();
    const prepared = transitionJournal(created, 'prepared');
    const applyingNothingWritten = transitionJournal(prepared, 'applying');
    const applyingWithWrite = { ...applyingNothingWritten, appliedTargets: ['Form1.Designer.cs'] };
    const applied = transitionJournal(applyingNothingWritten, 'applied');
    const undoRegistered = transitionJournal(applied, 'undoRegistered');
    const committed = transitionJournal(undoRegistered, 'committed');
    const rollingBack = transitionJournal(applied, 'rollingBack');

    expect(classifyJournalForRecovery(null)).toBe('clean');
    expect(classifyJournalForRecovery(created)).toBe('clean');
    expect(classifyJournalForRecovery(prepared)).toBe('clean');
    expect(classifyJournalForRecovery(applyingNothingWritten)).toBe('rollbackRequired');
    expect(classifyJournalForRecovery(applyingWithWrite)).toBe('rollbackRequired');
    expect(classifyJournalForRecovery(applied)).toBe('rollbackRequired');
    expect(classifyJournalForRecovery(undoRegistered)).toBe('rollbackRequired');
    expect(classifyJournalForRecovery(rollingBack)).toBe('resumeRollback');
    expect(classifyJournalForRecovery(committed)).toBe('terminal');
    expect(classifyJournalForRecovery({ ...committed, schemaVersion: '1.0.0' as '2.0.0' })).toBe('corrupt');
  });

  it('writes and reads an atomically replaced journal file', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'transactions', 'tx1.json');
    const record = transitionJournal(createTestJournal(), 'prepared');

    expect(await readJournalFile(file)).toBeNull();
    await writeJournalFile(file, record);
    await writeJournalFile(file, transitionJournal(record, 'applying'));

    expect((await readJournalFile(file))?.state).toBe('applying');
    expect(fs.readdirSync(path.dirname(file))).toEqual(['tx1.json']);
  });

  it('rejects malformed or incomplete journal JSON', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'bad.json');
    fs.writeFileSync(file, '{"schemaVersion":"2.0.0","state":"mystery"}', 'utf8');
    await expect(readJournalFile(file)).rejects.toThrow('invalid transaction journal');
  });

  it('rejects corrupt or internally inconsistent recovery fingerprints', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'bad-fingerprint.json');
    const valid = createTestJournal();
    const variants = [
      { ...base['Form1.Designer.cs'], bytesSha256: 'abc' },
      { ...base['Form1.Designer.cs'], textSha256: 'g'.repeat(64) },
      { ...base['Form1.Designer.cs'], exists: false, bom: false, byteLength: null },
      { ...base['Form1.Designer.cs'], exists: true, bytesSha256: null },
    ];

    for (const fingerprint of variants) {
      fs.writeFileSync(file, JSON.stringify({
        ...valid,
        baseFingerprints: { 'Form1.Designer.cs': fingerprint },
      }), 'utf8');
      await expect(readJournalFile(file)).rejects.toThrow('invalid transaction journal');
    }
  });
});
