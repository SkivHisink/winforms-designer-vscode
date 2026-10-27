import * as path from 'node:path';

const MARKER = '[project-evaluation] ';
const projectStatuses = new Map<string, 'MSBUILD_GETPROPERTY_UNSUPPORTED'>();
const key = (projectPath: string): string => path.resolve(projectPath).toLocaleLowerCase('en-US');

/** Accept only the engine's bounded structured status; raw MSBuild output never becomes a diagnostic message. */
export function captureProjectEvaluationStatus(line: string): boolean {
  if (!line.startsWith(MARKER) || line.length > 32_768) return false;
  try {
    const status = JSON.parse(line.slice(MARKER.length));
    if (!['MSBUILD_GETPROPERTY_UNSUPPORTED', 'MSBUILD_EVALUATION_AVAILABLE'].includes(status?.code) || typeof status.projectPath !== 'string'
      || !path.isAbsolute(status.projectPath) || !/\.csproj$/i.test(status.projectPath)) return false;
    if (status.code === 'MSBUILD_EVALUATION_AVAILABLE') projectStatuses.delete(key(status.projectPath));
    else projectStatuses.set(key(status.projectPath), status.code);
    return true;
  } catch { return false; }
}

export function projectEvaluationDiagnosticCodes(projectPath: string | undefined): readonly 'MSBUILD_GETPROPERTY_UNSUPPORTED'[] {
  const code = projectPath ? projectStatuses.get(key(projectPath)) : undefined;
  return code ? [code] : [];
}
