import * as fs from 'node:fs';
import * as path from 'node:path';

/** Authorize a local artifact immediately before I/O. A lexical workspace boundary does not authorize a junction.
 * Check ancestors from the volume root down, including the workspace root itself, before following any child. */
export async function assertLocalArtifactPath(workspaceRoot: string, target: string): Promise<void> {
  if (!path.isAbsolute(workspaceRoot) || !path.isAbsolute(target)) throw new Error('artifact path must be absolute');
  const root = path.resolve(workspaceRoot);
  const absolute = path.resolve(target);
  const relative = path.relative(root, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('artifact path escapes its owning root');
  if (absolute.split(/[\\/]/).some((part) => part.toLowerCase() === 'secrets')
    || /^\.env(?:\.|$)/i.test(path.basename(absolute)) || /\.(?:pfx|key|pem)$/i.test(absolute)) throw new Error('secret artifact path');
  const volume = path.parse(absolute).root;
  let current = volume;
  for (const segment of absolute.slice(volume.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      if ((await fs.promises.lstat(current)).isSymbolicLink()) throw new Error('artifact path crosses a symbolic link or junction');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
}
