import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  artifactFingerprint,
  detectEol,
  readLocalArtifactSnapshot,
  sameArtifactFingerprint,
  sha256Hex,
  snapshotArtifactBytes,
  snapshotMissingArtifact,
} from './documentStore';

const scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfd-doc-store-'));
  scratch.push(dir);
  return dir;
}

describe('document store snapshots', () => {
  it('captures exact bytes, stripped text, BOM and hashes', () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('one\r\ntwo\r\n', 'utf8')]);
    const snapshot = snapshotArtifactBytes('Form1.Designer.cs', bytes, { documentVersion: 7, mtimeMs: 123 });

    expect(snapshot.exists).toBe(true);
    expect(snapshot.bom).toBe(true);
    expect(snapshot.text).toBe('one\r\ntwo\r\n');
    expect(snapshot.eol).toBe('crlf');
    expect(snapshot.byteLength).toBe(bytes.length);
    expect(snapshot.bytesSha256).toBe(sha256Hex(bytes));
    expect(snapshot.textSha256).toBe(sha256Hex('one\r\ntwo\r\n'));
    expect(snapshot.documentVersion).toBe(7);
    expect(snapshot.mtimeMs).toBe(123);
  });

  it('represents missing artifacts without fake hashes', () => {
    expect(snapshotMissingArtifact('Form1.resx')).toEqual({
      target: 'Form1.resx',
      exists: false,
      bom: false,
      bytesSha256: null,
      textSha256: null,
      text: null,
      byteLength: null,
      mtimeMs: null,
      documentVersion: null,
      eol: 'none',
    });
  });

  it('reads local file mtime and compares fingerprints exactly', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'Form1.cs');
    fs.writeFileSync(file, 'partial class Form1 {}\n', 'utf8');

    const first = artifactFingerprint(await readLocalArtifactSnapshot(file, { documentVersion: 'v1' }));
    const second = artifactFingerprint(await readLocalArtifactSnapshot(file, { documentVersion: 'v1' }));
    const changedVersion = { ...second, documentVersion: 'v2' };

    expect(first.exists).toBe(true);
    expect(first.bytesSha256).toBe(sha256Hex('partial class Form1 {}\n'));
    expect(first.byteLength).toBe(Buffer.byteLength('partial class Form1 {}\n'));
    expect(first.mtimeMs).toBeTypeOf('number');
    expect(sameArtifactFingerprint(first, second)).toBe(true);
    expect(sameArtifactFingerprint(first, changedVersion)).toBe(false);
  });

  it('detects the EOL style needed for preservation checks', () => {
    expect(detectEol('abc')).toBe('none');
    expect(detectEol('a\nb\n')).toBe('lf');
    expect(detectEol('a\r\nb\r\n')).toBe('crlf');
    expect(detectEol('a\rb\r')).toBe('cr');
    expect(detectEol('a\r\nb\n')).toBe('mixed');
  });
});
