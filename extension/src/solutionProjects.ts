import * as fs from 'fs';
import * as path from 'path';

const projectExtension = /\.(?:csproj)$/i;

function boundedProjectPath(solutionPath: string, relative: string): string | null {
  const value = relative.trim().replace(/^['"]|['"]$/g, '');
  if (!value || value.length > 2048 || !projectExtension.test(value)) return null;
  const resolved = path.resolve(path.dirname(solutionPath), value.replace(/[\\/]/g, path.sep));
  try { return fs.statSync(resolved).isFile() ? resolved : null; } catch { return null; }
}

/** Parse project identities from the two Visual Studio solution formats without executing solution/MSBuild content. */
export function projectPathsFromSolution(solutionPath: string, text: string): string[] {
  const results: string[] = [];
  const seen = new Set<string>();
  const add = (candidate: string): void => {
    const resolved = boundedProjectPath(solutionPath, candidate);
    if (!resolved) return;
    const key = resolved.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    results.push(resolved);
  };

  if (/\.slnx$/i.test(solutionPath)) {
    // Current SLNX uses <Project Path="..." />. Accept single or double quotes and arbitrary attribute order.
    const projectTag = /<Project\b[^>]*>/gi;
    for (const match of text.matchAll(projectTag)) {
      const pathAttribute = /\bPath\s*=\s*(?:"([^"]+)"|'([^']+)')/i.exec(match[0]);
      if (pathAttribute) add(pathAttribute[1] ?? pathAttribute[2] ?? '');
    }
  } else {
    // Project("{TYPE-GUID}") = "Name", "relative\\App.csproj", "{PROJECT-GUID}"
    const projectLine = /^Project\s*\([^\r\n]*\)\s*=\s*"[^"]*"\s*,\s*"([^"]+)"/gim;
    for (const match of text.matchAll(projectLine)) add(match[1]);
  }
  return results;
}

export function projectPathsFromSolutionFile(solutionPath: string, maxBytes = 4 * 1024 * 1024): string[] {
  let stat: fs.Stats;
  try { stat = fs.statSync(solutionPath); } catch { return []; }
  if (!stat.isFile() || stat.size > maxBytes) return [];
  try { return projectPathsFromSolution(solutionPath, fs.readFileSync(solutionPath, 'utf8')); }
  catch { return []; }
}
