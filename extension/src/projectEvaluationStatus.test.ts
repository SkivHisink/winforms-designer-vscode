import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { captureProjectEvaluationStatus, projectEvaluationDiagnosticCodes } from './projectEvaluationStatus';

describe('named project evaluation status', () => {
  it('keeps one named item per owning project and clears it after SDK recovery', () => {
    const projectPath = path.resolve('status-fixture', 'App.csproj');
    const line = '[project-evaluation] ' + JSON.stringify({ code: 'MSBUILD_GETPROPERTY_UNSUPPORTED', projectPath });
    expect(captureProjectEvaluationStatus(line)).toBe(true);
    expect(captureProjectEvaluationStatus(line)).toBe(true);
    expect(projectEvaluationDiagnosticCodes(projectPath)).toEqual(['MSBUILD_GETPROPERTY_UNSUPPORTED']);
    expect(projectEvaluationDiagnosticCodes(path.resolve('other.csproj'))).toEqual([]);
    expect(captureProjectEvaluationStatus('[project-evaluation] ' + JSON.stringify({ code: 'MSBUILD_EVALUATION_AVAILABLE', projectPath }))).toBe(true);
    expect(projectEvaluationDiagnosticCodes(projectPath)).toEqual([]);
  });

  it('rejects raw errors and malformed or oversized data', () => {
    for (const line of ['MSBUILD : error MSB1001', '[project-evaluation] {', '[project-evaluation] ' + 'x'.repeat(32769),
      '[project-evaluation] {"code":"PRIVATE_EXCEPTION","projectPath":"x"}']) {
      expect(captureProjectEvaluationStatus(line)).toBe(false);
    }
    expect(projectEvaluationDiagnosticCodes(undefined)).toEqual([]);
  });
});
