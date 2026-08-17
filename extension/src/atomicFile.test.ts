import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { atomicWriteLocalFile, stagingPath } from './atomicFile';

const scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfd-atomic-'));
  scratch.push(dir);
  return dir;
}

describe('atomic local file replacement', () => {
  it('replaces the target contents and leaves no staging file behind', async () => {
    const dir = tempDir();
    const target = path.join(dir, 'Form1.Designer.cs');
    fs.writeFileSync(target, 'old');

    await atomicWriteLocalFile(target, Buffer.from('new', 'utf8'));

    expect(fs.readFileSync(target, 'utf8')).toBe('new');
    expect(fs.readdirSync(dir)).toEqual(['Form1.Designer.cs']);
  });

  it('creates a target that does not exist yet', async () => {
    const dir = tempDir();
    const target = path.join(dir, 'Form1.resx');

    await atomicWriteLocalFile(target, Buffer.from('<root />', 'utf8'));

    expect(fs.readFileSync(target, 'utf8')).toBe('<root />');
    expect(fs.readdirSync(dir)).toEqual(['Form1.resx']);
  });

  it('never leaves the target absent while it is being replaced', async () => {
    // The regression this guards: replacing through a delete-then-rename sequence (what
    // vscode.workspace.fs.rename does for overwrite) makes the form's .Designer.cs really disappear from disk
    // mid-save, which the file watcher reports and the Explorer shows. A rename-based replace has no such window.
    const dir = tempDir();
    const target = path.join(dir, 'Form1.Designer.cs');
    fs.writeFileSync(target, 'old');
    const payload = Buffer.alloc(4 * 1024 * 1024, 0x41); // large enough that staging spans many event-loop turns

    let missing = 0;
    let polling = true;
    const poll = (async () => {
      while (polling) {
        // Only a real ENOENT counts as "gone". fs.existsSync swallows every stat error, and on Windows a file
        // being replaced can briefly answer EACCES/EBUSY (indexer, scanner) without ever ceasing to exist —
        // treating that as absence made this test flaky rather than strict.
        try { fs.statSync(target); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') missing++; }
        await new Promise((resolve) => setImmediate(resolve));
      }
    })();

    await atomicWriteLocalFile(target, payload);
    polling = false;
    await poll;

    expect(missing).toBe(0);
    expect(fs.statSync(target).size).toBe(payload.length);
  });

  it('cleans up the staging file when the write fails', async () => {
    const dir = tempDir();
    const target = path.join(dir, 'missing-directory', 'Form1.Designer.cs');

    await expect(atomicWriteLocalFile(target, Buffer.from('x', 'utf8'))).rejects.toThrow();
    expect(fs.existsSync(path.join(dir, 'missing-directory'))).toBe(false);
  });

  it('stages beside the target, uniquely per process and call', () => {
    const first = stagingPath('C:\\forms\\Form1.Designer.cs', 4242, 1);
    expect(first).toBe('C:\\forms\\Form1.Designer.cs.wfd-4242-1.tmp');
    expect(path.dirname(first)).toBe('C:\\forms'); // same volume, so the rename stays atomic
    expect(stagingPath('/f/Form1.cs', 1, 1)).not.toBe(stagingPath('/f/Form1.cs', 2, 1));
    expect(stagingPath('/f/Form1.cs')).not.toBe(stagingPath('/f/Form1.cs'));
  });
});
