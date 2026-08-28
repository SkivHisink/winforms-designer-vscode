import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PatchSet } from './patchSet';
import {
  V2HeadlessValidationReport,
  runV2HeadlessValidation,
  validateV2HeadlessValidationReport,
} from './v2HeadlessValidate';
import { runV2Phase0PerformanceSpike } from './v2Phase0Performance';

const sourceHash = 'a'.repeat(64);
const payloadHash = 'b'.repeat(64);

describe('v2 headless validation', () => {
  it('emits a structured non-mutating report with every required category and redacted security evidence', async () => {
    const perf = await runV2Phase0PerformanceSpike({
      capture: () => ({ durationMs: 10 }),
      preview: () => ({ durationMs: 1 }),
      commit: () => ({ durationMs: 10 }),
      reconciliation: () => ({ durationMs: 10 }),
    });
    const report = runV2HeadlessValidation([{
      id: 'V2-FND-001-S121',
      runtime: 'headless',
      requiresHostedCode: true,
      requiresVendorArtifact: true,
      baselineSourceText: [
        'partial class Form1 {',
        '  void InitializeComponent() {',
        '    this.AutoScaleMode = System.Windows.Forms.AutoScaleMode.None;',
        '  }',
        '}',
      ].join('\n'),
      controls: [{
        id: 'imageButton',
        typeName: 'System.Windows.Forms.Button',
        imageOnly: true,
        text: '',
        accessibleName: '',
      }],
      expectedLocalizedTextKeys: ['button1.Text'],
      localizedResourceKeys: [],
      diagnosticValues: [{
        label: 'apiToken',
        value: 'apiToken=super-secret-value',
      }],
      performanceReport: perf,
    }], { generatedAtUtc: '2026-08-20T00:00:00.000Z' });

    expect(validateV2HeadlessValidationReport(report).failures).toEqual([]);
    expect(report.schemaVersion).toBe('2.0.0-headless-validate.1');
    expect(report.mutationPolicy).toBe('non-mutating');
    expect(report.generatedAtUtc).toBe('2026-08-20T00:00:00.000Z');
    expect(new Set(report.findings.map((finding) => finding.category))).toEqual(new Set([
      'compatibility',
      'security',
      'fallback',
      'diff',
      'a11y',
      'perf',
      'advisor',
    ]));
    expect(report.findings.some((finding) =>
      finding.category === 'security' && finding.status === 'PASS' && finding.code === 'TRUST_OPT_IN_REQUIRED')).toBe(true);
    expect(report.findings.some((finding) =>
      finding.category === 'perf' && finding.status === 'NOT_EXECUTED' && finding.code === 'PERFORMANCE_REPORT_VALIDATED')).toBe(true);
    expect(report.findings.filter((finding) => finding.category === 'a11y').map((finding) => finding.code))
      .toEqual(['ACCESSIBLE_NAME_MISSING', 'AUTOSCALEMODE_NONE', 'LOCALIZED_TEXT_FALLBACK_USED']);
    expect(report.findings.some((finding) =>
      finding.category === 'advisor' && finding.code === 'DPI_QUICK_FIX_PREVIEW'
      && finding.quickFix?.mutationStatus === 'NOT_EXECUTED')).toBe(true);
    expect(report.externalEvidence.map((evidence) => `${evidence.id}:${evidence.status}`)).toEqual([
      'visual-studio-reference:NOT_EXECUTED',
      'vendor-artifact:GATED',
      'physical-hardware:NOT_EXECUTED',
      'accessibility-assistive-technology:NOT_EXECUTED',
      'performance-lab:GATED',
    ]);
    expect(JSON.stringify(report)).not.toContain('super-secret-value');
  });

  it('reports deterministic worker compatibility and gates x86 without granting mutation authority', () => {
    const report = runV2HeadlessValidation([
      {
        id: 'modern-ok',
        runtime: 'modern',
        hostArchitecture: 'arm64',
        projectArchitecture: 'arm64',
        workspaceTrust: 'trusted',
        designTimeTrust: 'sourceFirst',
        renderMode: 'interpreted',
        payload: { sourceFingerprint: sourceHash, payloadHash },
      },
      {
        id: 'x86-gated',
        runtime: 'net48',
        hostArchitecture: 'x64',
        projectArchitecture: 'x86',
        workspaceTrust: 'trusted',
        designTimeTrust: 'sourceFirst',
        requiresX86: true,
        payload: { sourceFingerprint: sourceHash, payloadHash },
      },
    ]);

    const selected = report.findings.find((finding) => finding.id === 'modern-ok:compatibility:WORKER_SELECTED');
    const refused = report.findings.find((finding) => finding.id === 'x86-gated:compatibility:X86_WORKER_UNAVAILABLE');
    expect(selected?.status).toBe('PASS');
    expect(selected?.evidence).toMatchObject({
      workerKey: 'modern:arm64:native',
      mutationAuthority: 'sourceFirst',
      canMutateWorkspace: true,
    });
    expect(refused?.status).toBe('GATED');
    expect(refused?.evidence).toMatchObject({
      mutationAuthority: 'none',
      canMutateWorkspace: false,
    });
  });

  it('never turns caller-supplied capability metadata into PASS evidence', () => {
    const report = runV2HeadlessValidation([{
      id: 'fabricated-capability',
      runtime: 'headless',
      capabilityInspection: {
        operation: 'Open an operation that never ran',
        target: 'Missing.Product.Type',
        authorityLane: 'InventedAuthority',
        reasonCode: 'a-crash-that-never-happened',
        recoveryOptions: ['banana'],
      },
    }]);

    const finding = report.findings.find((candidate) => candidate.code === 'CAPABILITY_INSPECTION_NOT_EXECUTED');
    expect(finding).toMatchObject({
      status: 'NOT_EXECUTED',
      evidence: { trustedProductProducer: false, mutationStatus: 'NOT_EXECUTED' },
    });
    expect(report.findings.some((candidate) => candidate.code === 'CAPABILITY_INSPECTOR_EXPLAINED'
      || (candidate.status === 'PASS' && candidate.evidence?.reasonCode === 'a-crash-that-never-happened'))).toBe(false);
    expect(JSON.stringify(finding)).not.toContain('banana');
  });

  it('fails silent compiled fallbacks, stale advisor baselines, and broad source rewrites', () => {
    const baseline = Array.from({ length: 90 }, (_, index) => `this.button${index}.Text = "Before";`).join('\n');
    const report = runV2HeadlessValidation([{
      id: 'stale-rewrite',
      runtime: 'modern',
      hostArchitecture: 'x64',
      projectArchitecture: 'anycpu',
      workspaceTrust: 'trusted',
      designTimeTrust: 'sourceFirst',
      renderMode: 'compiledFallback',
      baselineSourceText: baseline,
      currentSourceText: `${baseline}\n// external edit`,
      proposedSourceText: Array.from({ length: 90 }, (_, index) => `rewritten_${index}();`).join('\n'),
    }]);

    expect(report.status).toBe('FAIL');
    expect(report.findings.find((finding) => finding.category === 'fallback')?.code).toBe('SILENT_FALLBACK');
    expect(report.findings.find((finding) => finding.category === 'diff')?.code).toBe('UNRELATED_SOURCE_DIFF');
    expect(report.findings.find((finding) => finding.category === 'advisor')?.code).toBe('STALE_ADVISOR_BASELINE');
  });

  it('validates PatchSet shape as diff evidence without applying it', () => {
    const workspaceRoot = path.resolve('C:/work/App');
    const validPatchSet: PatchSet = {
      id: 'advisor-preview',
      lane: 'A',
      workspaceRoot,
      operations: [{
        kind: 'replaceTextSpan',
        target: 'Forms/Form1.Designer.cs',
        span: { start: 10, length: 12 },
        preservation: {
          beforeBom: false,
          afterBom: false,
          beforeEol: 'crlf',
          afterEol: 'crlf',
        },
      }],
    };
    const invalidPatchSet: PatchSet = {
      ...validPatchSet,
      id: 'invalid-preview',
      operations: [{
        kind: 'replaceTextSpan',
        target: '../Outside.cs',
        span: { start: 0, length: 1 },
        preservation: validPatchSet.operations[0].preservation,
      }],
    };

    const valid = runV2HeadlessValidation([{ id: 'valid-patchset', patchSet: validPatchSet }]);
    const invalid = runV2HeadlessValidation([{ id: 'invalid-patchset', patchSet: invalidPatchSet }]);

    expect(valid.findings.find((finding) => finding.category === 'diff')).toMatchObject({
      status: 'PASS',
      code: 'PATCHSET_VALIDATED',
    });
    expect(invalid.findings.find((finding) => finding.category === 'diff')).toMatchObject({
      status: 'FAIL',
      code: 'PATCHSET_INVALID',
    });
  });

  it('rejects reports that claim external Visual Studio or hardware evidence as completed', () => {
    const report = runV2HeadlessValidation([{ id: 'external-gates' }]);
    const forged: V2HeadlessValidationReport = {
      ...report,
      externalEvidence: report.externalEvidence.map((entry) => entry.id === 'visual-studio-reference'
        ? { ...entry, status: 'PASS' as 'NOT_EXECUTED' }
        : entry),
    };

    expect(validateV2HeadlessValidationReport(forged).failures).toContain(
      'external evidence visual-studio-reference must not be reported as PASS',
    );
  });

  it('rejects raw sensitive evidence even when a sibling claims redaction', () => {
    const report = runV2HeadlessValidation([{ id: 'redaction-regression' }]);
    const security = report.findings.find((finding) => finding.category === 'security');
    if (!security) throw new Error('missing security finding');

    const rawSecret: V2HeadlessValidationReport = {
      ...report,
      findings: report.findings.map((finding) => finding.id === security.id
        ? { ...finding, evidence: { redacted: true, raw: 'password=super-secret-value' } }
        : finding),
    };
    const rawPath: V2HeadlessValidationReport = {
      ...report,
      findings: report.findings.map((finding) => finding.id === security.id
        ? { ...finding, evidence: { redacted: true, raw: 'C:\\Users\\alice\\src\\VendorApp\\Form1.Designer.cs' } }
        : finding),
    };

    expect(validateV2HeadlessValidationReport(rawSecret).failures).toContain(
      `${security.id} contains unredacted secret-like text`.replace(security.id, `finding ${security.id}`),
    );
    expect(validateV2HeadlessValidationReport(rawPath).failures).toContain(
      `${security.id} contains unredacted secret-like text`.replace(security.id, `finding ${security.id}`),
    );
  });
});
