import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runV2HeadlessValidateCli } from './v2HeadlessValidateCli';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wfd-v2-headless-cli-'));
}

describe('v2 headless validation CLI', () => {
  it('reads a bounded scenario file and writes a deterministic report to stdout', () => {
    const dir = tempDir();
    const input = path.join(dir, 'scenarios.json');
    fs.writeFileSync(input, JSON.stringify({
      schemaVersion: '2.0.0-headless-input.1',
      generatedAtUtc: '2026-08-20T00:00:00.000Z',
      scenarios: [{ id: 'headless-minimal' }],
    }), 'utf8');
    let stdout = '';
    const result = runV2HeadlessValidateCli(['--input', input], {
      io: {
        readFileSync: (file) => fs.readFileSync(file),
        writeFileSync: (file, data) => fs.writeFileSync(file, data, 'utf8'),
        stdout: (data) => { stdout += data; },
        stderr: () => undefined,
      },
    });

    const report = JSON.parse(stdout);
    expect(result).toEqual({ exitCode: 0, reportStatus: 'NOT_EXECUTED' });
    expect(report.generatedAtUtc).toBe('2026-08-20T00:00:00.000Z');
    expect(report.scenarioIds).toEqual(['headless-minimal']);
    expect(report.mutationPolicy).toBe('non-mutating');
    expect(report.externalEvidence.find((entry: { id: string }) => entry.id === 'visual-studio-reference').status).toBe('NOT_EXECUTED');
  });

  it('writes explicit output and exits nonzero only when the validation report fails', () => {
    const dir = tempDir();
    const input = path.join(dir, 'scenarios.json');
    const output = path.join(dir, 'report.json');
    fs.writeFileSync(input, JSON.stringify({
      schemaVersion: '2.0.0-headless-input.1',
      scenarios: [{
        id: 'a11y-fail',
        controls: [{
          id: 'imageButton',
          typeName: 'System.Windows.Forms.Button',
          imageOnly: true,
          text: '',
          accessibleName: '',
        }],
      }],
    }), 'utf8');

    const result = runV2HeadlessValidateCli(['--input', input, '--output', output]);
    const report = JSON.parse(fs.readFileSync(output, 'utf8'));

    expect(result).toEqual({ exitCode: 1, reportStatus: 'FAIL' });
    expect(report.status).toBe('FAIL');
    expect(report.findings.some((finding: { code: string }) => finding.code === 'ACCESSIBLE_NAME_MISSING')).toBe(true);
  });

  it('rejects malformed, oversized, and unknown-root-field inputs before reporting', () => {
    const dir = tempDir();
    const malformed = path.join(dir, 'malformed.json');
    const oversized = path.join(dir, 'oversized.json');
    const unknown = path.join(dir, 'unknown.json');
    fs.writeFileSync(malformed, '{', 'utf8');
    fs.writeFileSync(oversized, JSON.stringify({ scenarios: [{ id: 'x' }] }), 'utf8');
    fs.writeFileSync(unknown, JSON.stringify({ scenarios: [{ id: 'x' }], unexpected: true }), 'utf8');

    expect(runV2HeadlessValidateCli(['--input', malformed]).exitCode).toBe(2);
    expect(runV2HeadlessValidateCli(['--input', oversized], { maxInputBytes: 4 }).exitCode).toBe(2);
    expect(runV2HeadlessValidateCli(['--input', unknown]).exitCode).toBe(2);
  });
});
