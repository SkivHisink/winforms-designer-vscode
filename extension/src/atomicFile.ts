/**
 * Crash-safe local file replacement for the two files a save must never corrupt: the `.Designer.cs` and its
 * sibling `.resx`.
 *
 * Stage the new bytes into a sibling temp file, then let the PLATFORM swap it over the target — `fs.rename` is
 * `MoveFileEx(MOVEFILE_REPLACE_EXISTING)` on Windows and `rename(2)` elsewhere, both of which replace the target
 * in place. The target is therefore never observably absent: no window in which a crash leaves a truncated form,
 * and none in which the file disappears from the Explorer either.
 *
 * That second property is why this does not go through `vscode.workspace.fs.rename`, whose overwrite is
 * implemented as DELETE-then-rename: the form really does vanish from disk between the two steps, the file
 * watcher reports the deletion, and the user watches their `.Designer.cs` disappear on every Ctrl+S.
 *
 * The temp lives in the target's own directory so the rename stays on one volume, and its name is unique across
 * sessions and processes (pid + counter) so two windows saving the same file cannot stage onto each other.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

let sequence = 0;

/** The staging path used for `target`. Exported for the test that proves it is cleaned up. */
export function stagingPath(target: string, pid = process.pid, seq = sequence++): string {
  return `${target}.wfd-${pid}-${seq}.tmp`;
}

/** Transient Windows failures when something else holds the target open for a moment. */
const contended = new Set(['EPERM', 'EACCES', 'EBUSY']);

/**
 * Replace `target` with `staged`, retrying briefly while the target is held open.
 *
 * On Windows the replace is `MoveFileEx`, which fails outright if any other process has the target open without
 * delete sharing — an on-access virus scanner, the search indexer, or another editor reading the file the instant
 * we save. These holds last milliseconds, so a few spaced retries turn a failed save into a normal one; a genuine
 * permission problem still surfaces, just after ~300 ms of trying.
 */
async function replaceWithRetry(staged: string, target: string): Promise<void> {
  const delaysMs = [0, 5, 10, 20, 40, 80, 150];
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.promises.rename(staged, target);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (attempt >= delaysMs.length - 1 || !contended.has(code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, delaysMs[attempt + 1]));
    }
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(directory, 'r');
    await handle.sync();
  } catch (error) {
    // Windows does not expose directory handles through Node's ordinary fs.open API (EPERM/EISDIR). The staged file
    // itself is still flushed with FlushFileBuffers before MoveFileEx; on platforms that expose a directory fd, the
    // post-rename fsync below also makes the directory entry durable. Do not claim stronger Windows power-loss
    // semantics than Node can provide.
    const code = (error as NodeJS.ErrnoException).code ?? '';
    if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EISDIR', 'EINVAL', 'ENOTSUP'].includes(code)) throw error;
  } finally {
    await handle?.close();
  }
}

/** Delete a local file and flush the containing directory where Node exposes a directory handle. */
export async function durableDeleteLocalFile(target: string): Promise<void> {
  try {
    await fs.promises.unlink(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return;
  }
  await syncDirectory(path.dirname(target));
}

export async function atomicWriteLocalFile(target: string, bytes: Uint8Array): Promise<void> {
  const tmp = stagingPath(target);
  let staged: fs.promises.FileHandle | undefined;
  try {
    staged = await fs.promises.open(tmp, 'wx');
    await staged.writeFile(bytes);
    // `rename` alone protects against torn visibility but not against a power loss that leaves only cached bytes.
    // Flush the complete staging file before publishing its name.
    await staged.sync();
    await staged.close();
    staged = undefined;
    await replaceWithRetry(tmp, target);
    await syncDirectory(path.dirname(target));
  } catch (error) {
    // Clean up a partially staged temp after EITHER a failed write or a failed replace, so an interrupted save
    // does not leak a `.wfd-…tmp` sibling next to the form.
    try { await staged?.close(); } catch { /* best effort */ }
    try { await fs.promises.unlink(tmp); } catch { /* best effort */ }
    throw error;
  }
}
