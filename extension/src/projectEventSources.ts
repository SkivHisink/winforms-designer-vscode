import * as fs from 'fs';
import * as path from 'path';

const skippedDirectories = new Set([
  '.git', '.vs', '.vscode-test', '.codex', 'bin', 'obj', 'node_modules', 'packages',
]);

export interface ProjectEventSourceOptions {
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
}

/**
 * Enumerate ordinary project C# sources for the Events tab without executing MSBuild or following links.
 * The engine remains the identity authority: it parses each file separately and keeps only the exact partial
 * form type. This function merely supplies a deterministic, bounded candidate corpus, including files whose
 * handlers live outside the conventional sibling Form1.cs.
 */
export function collectProjectEventSourcePaths(
  projectPath: string | null | undefined,
  primaryCodePath: string | null | undefined,
  options: ProjectEventSourceOptions = {},
): string[] {
  const maxFiles = Math.max(1, Math.min(2048, options.maxFiles ?? 512));
  const maxFileBytes = Math.max(1024, Math.min(8 * 1024 * 1024, options.maxFileBytes ?? 2 * 1024 * 1024));
  const maxTotalBytes = Math.max(maxFileBytes, Math.min(64 * 1024 * 1024, options.maxTotalBytes ?? 16 * 1024 * 1024));
  const projectDir = projectPath ? path.dirname(path.resolve(projectPath)) : null;
  const primary = primaryCodePath ? path.resolve(primaryCodePath) : null;
  const results: string[] = [];
  let totalBytes = 0;

  const add = (file: string): void => {
    if (results.length >= maxFiles) return;
    const resolved = path.resolve(file);
    if (!/\.cs$/i.test(resolved) || /\.Designer\.cs$/i.test(resolved)) return;
    let stat: fs.Stats;
    try { stat = fs.statSync(resolved); } catch { return; }
    if (!stat.isFile() || stat.size > maxFileBytes || totalBytes + stat.size > maxTotalBytes) return;
    if (results.some((candidate) => candidate.toLowerCase() === resolved.toLowerCase())) return;
    results.push(resolved);
    totalBytes += stat.size;
  };

  if (primary) add(primary);
  if (!projectDir || !fs.existsSync(projectDir)) return results;

  const pending = [projectDir];
  while (pending.length > 0 && results.length < maxFiles && totalBytes < maxTotalBytes) {
    const dir = pending.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    // Stack is LIFO: reverse directory insertion keeps the resulting traversal alphabetic.
    const childDirectories: string[] = [];
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skippedDirectories.has(entry.name.toLowerCase())) childDirectories.push(full);
      } else if (entry.isFile()) {
        add(full);
      }
      if (results.length >= maxFiles || totalBytes >= maxTotalBytes) break;
    }
    for (let i = childDirectories.length - 1; i >= 0; i--) pending.push(childDirectories[i]);
  }
  return results;
}
