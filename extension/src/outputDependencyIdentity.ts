import * as fs from 'node:fs';
import * as path from 'node:path';

export interface OutputDependencyFiles { files: readonly string[]; complete: boolean; reason?: string; }

/** Capture actual private dependencies beside the selected output without loading a control or following links. */
export function selectedOutputDependencyFiles(assemblyPath: string | undefined): OutputDependencyFiles {
  if (!assemblyPath) return { files: [], complete: true };
  if (/(?:^|[\\/])secrets(?:[\\/]|$)|(?:^|[\\/])\.env(?:\.|$)|\.(?:pfx|pem|key)$/i.test(assemblyPath)) {
    return { files: [], complete: false, reason: 'OUTPUT_DEPENDENCY_SECRET_PATH' };
  }
  const directory = path.dirname(path.resolve(assemblyPath));
  const files: string[] = [];
  let entriesSeen = 0;
  const deadline = Date.now() + 100;
  try {
    for (let candidate = directory; ; candidate = path.dirname(candidate)) {
      if (Date.now() > deadline) throw new Error('OUTPUT_DEPENDENCY_SCAN_BUDGET');
      if (fs.lstatSync(candidate).isSymbolicLink()) throw new Error('OUTPUT_DEPENDENCY_LINK');
      if (candidate === path.dirname(candidate)) break;
    }
    const visit = (folder: string, depth: number): void => {
      if (Date.now() > deadline || depth > 3) throw new Error('OUTPUT_DEPENDENCY_SCAN_BUDGET');
      const stat = fs.lstatSync(folder);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('OUTPUT_DEPENDENCY_LINK');
      const entries = fs.readdirSync(folder, { withFileTypes: true });
      for (const entry of entries) {
        if (++entriesSeen > 512 || Date.now() > deadline) throw new Error('OUTPUT_DEPENDENCY_SCAN_BUDGET');
        if (entry.name.toLowerCase() === 'secrets') throw new Error('OUTPUT_DEPENDENCY_SECRET_PATH');
        const file = path.join(folder, entry.name);
        if (entry.isSymbolicLink()) throw new Error('OUTPUT_DEPENDENCY_LINK');
        if (entry.isDirectory()) { visit(file, depth + 1); continue; }
        if (entry.isFile() && /(?:\.(?:dll|exe|config)|\.deps\.json|\.runtimeconfig\.json)$/i.test(entry.name)) {
          files.push(file);
          if (files.length > 256) throw new Error('OUTPUT_DEPENDENCY_FILE_BUDGET');
        }
      }
    };
    visit(directory, 0);
    if (!files.some((file) => file.toLowerCase() === path.resolve(assemblyPath).toLowerCase())) files.push(path.resolve(assemblyPath));
    return { files: files.sort((a, b) => a.localeCompare(b)), complete: true };
  } catch (error) {
    return { files: files.sort((a, b) => a.localeCompare(b)), complete: false,
      reason: error instanceof Error && /^OUTPUT_DEPENDENCY_/.test(error.message) ? error.message : 'OUTPUT_DEPENDENCY_UNAVAILABLE' };
  }
}
