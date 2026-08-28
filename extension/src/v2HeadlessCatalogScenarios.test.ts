import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ArtifactFingerprint,
  ArtifactSnapshot,
  artifactFingerprint,
  snapshotArtifactBytes,
  snapshotMissingArtifact,
} from './documentStore';
import { PatchOperation, PatchSet } from './patchSet';
import {
  PlannedTargetMutation,
  TransactionRunnerAdapters,
  runPatchSetTransaction,
} from './transactionRunner';
import { runV2Phase0PerformanceSpike } from './v2Phase0Performance';
import {
  V2HeadlessScenario,
  runV2HeadlessValidation,
  validateV2HeadlessValidationReport,
} from './v2HeadlessValidate';

const sourceHash = 'a'.repeat(64);
const payloadHash = 'b'.repeat(64);
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wfd-v2-headless-catalog-'));

afterAll(() => fs.rmSync(testRoot, { recursive: true, force: true }));

const preservation = {
  beforeBom: false,
  afterBom: false,
  beforeEol: 'none' as const,
  afterEol: 'none' as const,
};

function scenario(id: string): V2HeadlessScenario {
  switch (id) {
    case 'V2-FND-001-S113':
      return {
        id,
        runtime: 'modern',
        hostArchitecture: 'x64',
        projectArchitecture: 'anycpu',
        workspaceTrust: 'trusted',
        designTimeTrust: 'sourceFirst',
        requiresVendorArtifact: true,
        capabilityInspection: {
          operation: 'Open property editor',
          target: 'FakeVendor.WinForms.FancyButton.Editor',
          authorityLane: 'ReadOnly',
          reasonCode: 'VENDOR_EDITOR_UNSUPPORTED',
          recoveryOptions: ['Use source-first property editing', 'Install licensed vendor adapter'],
        },
        payload: { sourceFingerprint: sourceHash, payloadHash },
      };
    case 'V2-FND-001-S114':
      return {
        id,
        runtime: 'headless',
        diagnosticValues: [
          { label: 'extensionVersion', value: '2.0.0', sensitivity: 'public' },
          { label: 'projectPath', value: 'C:\\Users\\alice\\src\\VendorApp\\Form1.Designer.cs', sensitivity: 'path' },
          { label: 'sourceSnippet', value: 'this.vendorGrid.LicensePayload = "proprietary-value";', sensitivity: 'proprietary' },
          { label: 'apiToken', value: 'apiToken=super-secret-value', sensitivity: 'secret' },
        ],
      };
    case 'V2-FND-001-S115':
      return {
        id,
        runtime: 'modern',
        hostArchitecture: 'x64',
        projectArchitecture: 'anycpu',
        workspaceTrust: 'trusted',
        designTimeTrust: 'sourceFirst',
        recoveryTimeline: [
          { kind: 'crash', crashId: 'crash-render-001', reasonCode: 'WORKER_PROCESS_EXITED', workerGeneration: 4 },
          { kind: 'cancelled', crashId: 'crash-render-001', reasonCode: 'REQUEST_CANCELLED', workerGeneration: 4 },
          { kind: 'quarantined', crashId: 'crash-render-001', quarantineUntilUtc: '2026-08-20T00:01:00.000Z', workerGeneration: 5 },
          { kind: 'retry', scenarioId: id, workerGeneration: 5 },
          { kind: 'currentRevision', documentRevision: 'revision-after-retry', workerGeneration: 5 },
        ],
        payload: { sourceFingerprint: sourceHash, payloadHash },
      };
    case 'V2-FND-001-S116':
      return {
        id,
        runtime: 'modern',
        hostArchitecture: 'x64',
        projectArchitecture: 'anycpu',
        diagnosticValues: [
          { label: 'resourceKey', value: 'VendorGrid.ConnectionString' },
          { label: 'connectionString', value: 'Server=db;Password=super-secret-value;', sensitivity: 'secret' },
        ],
        payload: { sourceFingerprint: sourceHash, payloadHash },
      };
    case 'V2-FND-001-S117':
      return {
        id,
        runtime: 'modern',
        hostArchitecture: 'x64',
        projectArchitecture: 'anycpu',
        workspaceTrust: 'trusted',
        designTimeTrust: 'sourceFirst',
        baselineSourceText: manyDesignerLines('Before'),
        proposedSourceText: Array.from({ length: 90 }, (_, index) => `rewritten_${index}();`).join('\n'),
        payload: { sourceFingerprint: sourceHash, payloadHash },
      };
    case 'V2-FND-001-S118':
      return {
        id,
        runtime: 'modern',
        hostArchitecture: 'arm64',
        projectArchitecture: 'anycpu',
        workspaceTrust: 'trusted',
        designTimeTrust: 'sourceFirst',
        patchSet: validResourcePatchSet('s118-patchset'),
        payload: { sourceFingerprint: sourceHash, payloadHash },
      };
    case 'V2-FND-001-S119':
      return {
        id,
        runtime: 'net48',
        hostArchitecture: 'x64',
        projectArchitecture: 'x64',
        workspaceTrust: 'trusted',
        designTimeTrust: 'sourceFirst',
        arbitrarySourceExecutionRequired: true,
        payload: { sourceFingerprint: sourceHash, payloadHash },
      };
    case 'V2-FND-001-S120':
      return {
        id,
        runtime: 'visual-studio-reference',
        patchSet: validResourcePatchSet('s120-safety-only'),
      };
    case 'V2-FND-001-S121':
      return {
        id,
        runtime: 'headless',
        requiresVendorArtifact: true,
        renderMode: 'interpreted',
      };
    case 'V2-FND-001-S122':
      return {
        id,
        runtime: 'headless',
        requiresVendorArtifact: true,
        renderMode: 'interpreted',
      };
    case 'V2-FND-001-S123':
      return {
        id,
        runtime: 'headless',
        requiresHostedCode: true,
        requiresVendorArtifact: true,
        workspaceTrust: 'untrusted',
        designTimeTrust: 'parseOnly',
      };
    case 'V2-FND-001-S124':
      return {
        id,
        runtime: 'headless',
        crashContinuation: {
          crashedScenarioId: 'vendor-crashing-form',
          continuedScenarioIds: ['standard-form-after-crash'],
          workerGenerationBefore: 7,
          workerGenerationAfter: 8,
          recoveryRequiredCount: 0,
        },
      };
    case 'V2-FND-001-S125':
      return {
        id,
        runtime: 'modern',
        hostArchitecture: 'x64',
        projectArchitecture: 'anycpu',
        controls: [{
          id: 'imageButton',
          typeName: 'System.Windows.Forms.Button',
          imageOnly: true,
          text: '',
          accessibleName: '',
        }],
        payload: { sourceFingerprint: sourceHash, payloadHash },
      };
    case 'V2-FND-001-S126':
      return {
        id,
        runtime: 'modern',
        hostArchitecture: 'arm64',
        projectArchitecture: 'arm64',
        workspaceTrust: 'trusted',
        designTimeTrust: 'sourceFirst',
        baselineSourceText: [
          'partial class Form1 {',
          '  void InitializeComponent() {',
          '    this.AutoScaleMode = System.Windows.Forms.AutoScaleMode.None;',
          '  }',
          '}',
        ].join('\n'),
        payload: { sourceFingerprint: sourceHash, payloadHash },
      };
    case 'V2-FND-001-S127':
      return {
        id,
        runtime: 'net48',
        hostArchitecture: 'x64',
        projectArchitecture: 'x64',
        expectedLocalizedTextKeys: ['button1.Text'],
        localizedResourceKeys: [],
        payload: { sourceFingerprint: sourceHash, payloadHash },
      };
    case 'V2-FND-001-S128':
      return {
        id,
        runtime: 'modern',
        hostArchitecture: 'x64',
        projectArchitecture: 'anycpu',
        workspaceTrust: 'trusted',
        designTimeTrust: 'sourceFirst',
        baselineSourceText: 'this.button1.Text = "Before";',
        currentSourceText: 'this.button1.Text = "External edit";',
        payload: { sourceFingerprint: sourceHash, payloadHash },
      };
    default:
      throw new Error(`unknown scenario ${id}`);
  }
}

describe('v2 catalog diagnostics/headless/advisor scenarios S113-S128', () => {
  it('automates S113-S121 repo-side diagnostics and safety while leaving S120 reference trace unexecuted', async () => {
    const performanceReport = await runV2Phase0PerformanceSpike({
      capture: () => ({ durationMs: 10 }),
      preview: () => ({ durationMs: 1 }),
      commit: () => ({ durationMs: 10 }),
      reconciliation: () => ({ durationMs: 10 }),
    });
    const scenarios = [
      scenario('V2-FND-001-S113'),
      scenario('V2-FND-001-S114'),
      scenario('V2-FND-001-S115'),
      scenario('V2-FND-001-S116'),
      scenario('V2-FND-001-S117'),
      scenario('V2-FND-001-S118'),
      scenario('V2-FND-001-S119'),
      scenario('V2-FND-001-S120'),
      { ...scenario('V2-FND-001-S121'), performanceReport },
      { ...scenario('V2-FND-001-S122'), performanceReport },
    ];
    const report = runV2HeadlessValidation(scenarios, { generatedAtUtc: '2026-08-20T00:00:00.000Z' });

    expect(report.scenarioIds).toEqual([
      'V2-FND-001-S113',
      'V2-FND-001-S114',
      'V2-FND-001-S115',
      'V2-FND-001-S116',
      'V2-FND-001-S117',
      'V2-FND-001-S118',
      'V2-FND-001-S119',
      'V2-FND-001-S120',
      'V2-FND-001-S121',
      'V2-FND-001-S122',
    ]);
    expect(find(report, 'V2-FND-001-S113', 'CAPABILITY_INSPECTION_NOT_EXECUTED')).toMatchObject({
      status: 'NOT_EXECUTED',
      evidence: {
        trustedProductProducer: false,
        mutationStatus: 'NOT_EXECUTED',
      },
    });
    const serialized = JSON.stringify(report);
    expect(serialized).toContain('2.0.0');
    expect(serialized).not.toContain('C:\\Users\\alice');
    expect(serialized).not.toContain('proprietary-value');
    expect(serialized).not.toContain('super-secret-value');
    expect(find(report, 'V2-FND-001-S115', 'RECOVERY_TIMELINE_RECORDED')).toMatchObject({
      status: 'PASS',
      evidence: {
        eventKinds: ['crash', 'cancelled', 'quarantined', 'retry', 'currentRevision'],
        currentRevision: 'revision-after-retry',
      },
    });
    expect(find(report, 'V2-FND-001-S117', 'UNRELATED_SOURCE_DIFF')).toMatchObject({ status: 'FAIL' });
    expect(find(report, 'V2-FND-001-S118', 'PATCHSET_VALIDATED')).toMatchObject({ status: 'PASS' });
    expect(find(report, 'V2-FND-001-S119', 'WORKER_SELECTED')).toMatchObject({
      status: 'PASS',
      evidence: { canLoadProjectCode: false, canMutateWorkspace: true },
    });
    expect(find(report, 'V2-FND-001-S119', 'ARBITRARY_SOURCE_EXECUTION_REQUIRED')).toMatchObject({
      status: 'PASS',
      evidence: { loadAttempted: false, mutationStatus: 'NOT_EXECUTED' },
    });
    expect(find(report, 'V2-FND-001-S120', 'VISUAL_STUDIO_REFERENCE_NOT_EXECUTED')).toMatchObject({ status: 'NOT_EXECUTED' });
    expect(find(report, 'V2-FND-001-S120', 'PATCHSET_VALIDATED')).toMatchObject({ status: 'PASS' });
    expect(report.externalEvidence.find((entry) => entry.id === 'visual-studio-reference')?.status).toBe('NOT_EXECUTED');
    expect(find(report, 'V2-FND-001-S121', 'HEADLESS_READONLY_MATRIX')).toMatchObject({ status: 'PASS' });
    expect(find(report, 'V2-FND-001-S121', 'PERFORMANCE_REPORT_VALIDATED')).toMatchObject({
      status: 'NOT_EXECUTED',
      evidence: { executionMode: 'synthetic-harness' },
    });
    expect(find(report, 'V2-FND-001-S122', 'PERFORMANCE_REPORT_VALIDATED')).toMatchObject({
      status: 'NOT_EXECUTED',
      evidence: { executionMode: 'synthetic-harness' },
    });
    expect(validateV2HeadlessValidationReport(report).failures).toEqual([]);
  });

  it('automates S123-S128 repo-side headless recovery and advisor refusals', () => {
    const report = runV2HeadlessValidation([
      scenario('V2-FND-001-S123'),
      scenario('V2-FND-001-S124'),
      scenario('V2-FND-001-S125'),
      scenario('V2-FND-001-S126'),
      scenario('V2-FND-001-S127'),
      scenario('V2-FND-001-S128'),
    ]);

    expect(find(report, 'V2-FND-001-S123', 'TRUST_OPT_IN_REQUIRED')).toMatchObject({
      status: 'PASS',
      evidence: { loadAttempted: false },
    });
    expect(find(report, 'V2-FND-001-S124', 'HEADLESS_CRASH_CONTINUED')).toMatchObject({
      status: 'PASS',
      evidence: {
        crashedScenarioId: 'vendor-crashing-form',
        continuedScenarioIds: ['standard-form-after-crash'],
        workerGenerationBefore: 7,
        workerGenerationAfter: 8,
        recoveryRequiredCount: 0,
      },
    });
    expect(find(report, 'V2-FND-001-S125', 'ACCESSIBLE_NAME_MISSING')).toMatchObject({
      status: 'FAIL',
      evidence: { controlIds: ['imageButton'] },
    });
    expect(find(report, 'V2-FND-001-S125', 'ACCESSIBLE_NAME_QUICK_FIX_PREVIEW')).toMatchObject({
      status: 'PASS',
      evidence: { mutationStatus: 'NOT_EXECUTED' },
    });
    expect(find(report, 'V2-FND-001-S126', 'AUTOSCALEMODE_NONE')).toMatchObject({ status: 'FAIL' });
    const dpiFix = find(report, 'V2-FND-001-S126', 'DPI_QUICK_FIX_PREVIEW');
    expect(dpiFix.status).toBe('PASS');
    expect(dpiFix.quickFix).toMatchObject({
      kind: 'previewOnly',
      target: 'source',
      mutationStatus: 'NOT_EXECUTED',
    });
    expect(find(report, 'V2-FND-001-S127', 'LOCALIZED_TEXT_FALLBACK_USED')).toMatchObject({
      status: 'FAIL',
      evidence: { missingKeys: ['button1.Text'] },
    });
    expect(find(report, 'V2-FND-001-S128', 'STALE_ADVISOR_BASELINE')).toMatchObject({
      status: 'FAIL',
      evidence: { mutationStatus: 'NOT_EXECUTED' },
    });
    expect(validateV2HeadlessValidationReport(report).failures).toEqual([]);
  });

  it('proves S118 transaction rollback restores exact bytes after a failed multi-artifact commit', async () => {
    const adapters = new MemoryTransactionAdapters(
      new Map([
        ['Form1.Designer.cs', Buffer.from('source-before', 'utf8')],
        ['Form1.resx', Buffer.from('resx-before', 'utf8')],
      ]),
      new Map([
        ['Form1.Designer.cs', Buffer.from('source-after', 'utf8')],
        ['Form1.resx', Buffer.from('resx-after', 'utf8')],
      ]),
    );
    adapters.failWriteTarget = 'Form1.resx';

    const result = await runPatchSetTransaction(validResourcePatchSet('V2-FND-001-S118'), adapters, {
      transactionId: 'V2-FND-001-S118-rollback',
    });

    expect(result.status).toBe('rolledBack');
    expect(result.error).toContain('forced write failure');
    expect(Buffer.from((await adapters.read('Form1.Designer.cs'))!).toString('utf8')).toBe('source-before');
    expect(Buffer.from((await adapters.read('Form1.resx'))!).toString('utf8')).toBe('resx-before');
    expect(adapters.journalStates()).toContain('rollingBack');
    expect(adapters.journalStates().at(-1)).toBe('rolledBack');
  });
});

function find(report: ReturnType<typeof runV2HeadlessValidation>, scenarioId: string, code: string) {
  const finding = report.findings.find((entry) => entry.scenarioId === scenarioId && entry.code === code);
  if (!finding) throw new Error(`missing finding ${scenarioId}:${code}`);
  return finding;
}

function validResourcePatchSet(id: string): PatchSet {
  return {
    id,
    lane: 'A',
    workspaceRoot: testRoot,
    operations: [
      { kind: 'writeResourceText', target: 'Form1.Designer.cs', preservation },
      { kind: 'writeResourceText', target: 'Form1.resx', preservation },
    ],
  };
}

function manyDesignerLines(value: string): string {
  return [
    'namespace CatalogSafety',
    '{',
    '  partial class Form1',
    '  {',
    ...Array.from({ length: 90 }, (_, index) => `    this.button${index}.Text = "${value}";`),
    '  }',
    '}',
  ].join('\n');
}

function fingerprint(target: string, bytes: Uint8Array | null): ArtifactFingerprint {
  return artifactFingerprint(bytes === null
    ? snapshotMissingArtifact(target)
    : snapshotArtifactBytes(target, bytes));
}

class MemoryTransactionAdapters implements TransactionRunnerAdapters {
  public failWriteTarget: string | null = null;
  private readonly journals: string[] = [];

  public constructor(
    private readonly files: Map<string, Uint8Array | null>,
    private readonly planned: Map<string, Uint8Array | null>,
  ) {
  }

  public async snapshot(target: string): Promise<ArtifactSnapshot> {
    const bytes = this.files.has(target) ? this.files.get(target) ?? null : null;
    return bytes === null ? snapshotMissingArtifact(target) : snapshotArtifactBytes(target, bytes);
  }

  public async read(target: string): Promise<Uint8Array | null> {
    const bytes = this.files.has(target) ? this.files.get(target) ?? null : null;
    return bytes === null ? null : Buffer.from(bytes);
  }

  public async planTargetMutation({ target }: { target: string }): Promise<PlannedTargetMutation> {
    const afterBytes = this.planned.get(target) ?? null;
    return {
      target,
      afterBytes,
      expectedAfterFingerprint: fingerprint(target, afterBytes),
    };
  }

  public async write(target: string, bytes: Uint8Array): Promise<void> {
    if (target === this.failWriteTarget) throw new Error(`forced write failure: ${target}`);
    this.files.set(target, Buffer.from(bytes));
  }

  public async delete(target: string): Promise<void> {
    if (target === this.failWriteTarget) throw new Error(`forced delete failure: ${target}`);
    this.files.set(target, null);
  }

  public async persistJournal(record: { readonly state: string }): Promise<void> {
    this.journals.push(record.state);
  }

  public async verifyPostconditions(): Promise<boolean> {
    return true;
  }

  public journalStates(): readonly string[] {
    return this.journals;
  }
}
