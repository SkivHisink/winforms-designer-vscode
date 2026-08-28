import { performance } from 'node:perf_hooks';
import { designerDpiScale } from './dpiScale';

export type V2Phase0CorpusId = 'standard-50' | 'standard-300' | 'vendor-heavy';
export type V2Phase0Phase = 'model' | 'capture' | 'preview' | 'commit' | 'reconciliation';
export type V2Phase0Runtime = 'modern' | 'net48' | 'cross-runtime';
export type V2Phase0Architecture = 'x64' | 'arm64' | 'cross-arch';
export type V2Phase0Status = 'PASS' | 'FAIL' | 'NOT_EXECUTED';
export type V2Phase0ExecutionMode = 'synthetic-harness' | 'real-product-path';
export type V2Phase0MeasurementSource = 'synthetic-harness' | 'product-telemetry';

export interface V2Phase0ProductRunEvidence {
  schemaVersion: '2.0.0-product-performance-evidence.1';
  scenarioId: 'V2-FND-001-S122';
  hostKind: 'vscode-extension-host';
  hostVersion: string;
  hostArchitecture: 'x64' | 'arm64';
  processId: number;
  observedAtUtc: string;
}

export interface V2Phase0DpiLeg {
  id: 'dpi-100' | 'dpi-125' | 'dpi-150' | 'dpi-200';
  percent: 100 | 125 | 150 | 200;
  displayDpr: 1 | 1.25 | 1.5 | 2;
  captureScale: 1 | 2;
}

export interface V2Phase0ControlModel {
  id: string;
  typeName: string;
  parentId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  vendor: boolean;
}

export interface V2Phase0CorpusModel {
  id: V2Phase0CorpusId;
  scenarioIds: readonly string[];
  runtime: V2Phase0Runtime;
  architecture: V2Phase0Architecture;
  expectedControlCount: number;
  vendorControlCount: number;
  controls: readonly V2Phase0ControlModel[];
  designerText: string;
}

export interface V2Phase0PhaseResult {
  samplesMs?: readonly number[];
  durationMs?: number;
  source?: V2Phase0MeasurementSource;
  artifact?: unknown;
}

export interface V2Phase0RunContext {
  corpus: V2Phase0CorpusModel;
  dpi: V2Phase0DpiLeg;
  phase: V2Phase0Phase;
  previousArtifact: unknown;
}

export type V2Phase0PhaseRunner = (context: V2Phase0RunContext) =>
  V2Phase0PhaseResult | Promise<V2Phase0PhaseResult>;

export interface V2Phase0PerformanceRunners {
  model?: V2Phase0PhaseRunner;
  capture: V2Phase0PhaseRunner;
  preview: V2Phase0PhaseRunner;
  commit: V2Phase0PhaseRunner;
  reconciliation: V2Phase0PhaseRunner;
}

export interface V2Phase0PerformanceOptions {
  corpora?: readonly V2Phase0CorpusId[];
  dpiLegs?: readonly V2Phase0DpiLeg[];
  now?: () => number;
  executionMode?: V2Phase0ExecutionMode;
  productRunEvidence?: V2Phase0ProductRunEvidence;
}

export interface V2Phase0PhaseMeasurement {
  phase: V2Phase0Phase;
  source: V2Phase0MeasurementSource;
  samplesMs: readonly number[];
  medianMs: number;
  p95Ms: number;
  budgetMs: number;
  status: V2Phase0Status;
}

export interface V2Phase0LegMeasurement {
  corpusId: V2Phase0CorpusId;
  dpiLegId: V2Phase0DpiLeg['id'];
  runtime: V2Phase0Runtime;
  architecture: V2Phase0Architecture;
  controlCount: number;
  vendorControlCount: number;
  displayDpr: number;
  captureScale: 1 | 2;
  physicalDpiEvidenceStatus: 'NOT_EXECUTED';
  phases: readonly V2Phase0PhaseMeasurement[];
  interactiveConservativeBoundMs: number;
  interactiveBudgetMs: number;
  status: V2Phase0Status;
}

export interface V2Phase0NotExecutedDimension {
  id: 'physical-dpi-hardware' | 'visual-studio-pixel-reference' | 'licensed-vendor-corpus';
  status: 'NOT_EXECUTED';
  reason: string;
}

export interface V2Phase0PerformanceReport {
  schemaVersion: '2.0.0-phase0-performance.2';
  executionMode: V2Phase0ExecutionMode;
  scenarioIds: readonly string[];
  generatedAt: string;
  productRunEvidence: V2Phase0ProductRunEvidence | null;
  dpiLegs: readonly V2Phase0DpiLeg[];
  corpora: readonly V2Phase0CorpusModel[];
  phaseBudgetsMs: Readonly<Record<V2Phase0CorpusId, Readonly<Record<V2Phase0Phase, number>>>>;
  interactiveBudgetsMs: Readonly<Record<V2Phase0CorpusId, number>>;
  notExecutedDimensions: readonly V2Phase0NotExecutedDimension[];
  measurements: readonly V2Phase0LegMeasurement[];
  status: V2Phase0Status;
}

export interface V2Phase0ValidationResult {
  status: V2Phase0Status;
  failures: readonly string[];
}

const PHASES: readonly V2Phase0Phase[] = ['model', 'capture', 'preview', 'commit', 'reconciliation'];
const CANONICAL_CORPUS_IDS: readonly V2Phase0CorpusId[] = ['standard-50', 'standard-300', 'vendor-heavy'];

export const V2_PHASE0_DPI_LEGS: readonly V2Phase0DpiLeg[] = [
  { id: 'dpi-100', percent: 100, displayDpr: 1, captureScale: designerDpiScale(1).captureScale },
  { id: 'dpi-125', percent: 125, displayDpr: 1.25, captureScale: designerDpiScale(1.25).captureScale },
  { id: 'dpi-150', percent: 150, displayDpr: 1.5, captureScale: designerDpiScale(1.5).captureScale },
  { id: 'dpi-200', percent: 200, displayDpr: 2, captureScale: designerDpiScale(2).captureScale },
];

export const V2_PHASE0_PHASE_BUDGETS_MS: Readonly<Record<V2Phase0CorpusId, Readonly<Record<V2Phase0Phase, number>>>> = {
  'standard-50': {
    model: 250,
    capture: 3_000,
    preview: 16,
    commit: 100,
    reconciliation: 100,
  },
  'standard-300': {
    model: 500,
    capture: 5_000,
    preview: 16,
    commit: 250,
    reconciliation: 250,
  },
  'vendor-heavy': {
    model: 750,
    capture: 5_000,
    preview: 16,
    commit: 250,
    reconciliation: 250,
  },
};

export const V2_PHASE0_INTERACTIVE_BUDGETS_MS: Readonly<Record<V2Phase0CorpusId, number>> = {
  'standard-50': 3_000,
  'standard-300': 5_000,
  'vendor-heavy': 5_000,
};

export const V2_PHASE0_NOT_EXECUTED_DIMENSIONS: readonly V2Phase0NotExecutedDimension[] = [
  {
    id: 'physical-dpi-hardware',
    status: 'NOT_EXECUTED',
    reason: 'Phase 0 records logical DPI legs only; no physical monitor or hardware-DPI run is claimed.',
  },
  {
    id: 'visual-studio-pixel-reference',
    status: 'NOT_EXECUTED',
    reason: 'Synthetic corpus timing does not include a Visual Studio reference pixel capture.',
  },
  {
    id: 'licensed-vendor-corpus',
    status: 'NOT_EXECUTED',
    reason: 'Vendor-heavy corpus uses deterministic FakeVendor-shaped controls, not licensed third-party binaries.',
  },
];

export function buildV2Phase0Corpus(id: V2Phase0CorpusId): V2Phase0CorpusModel {
  switch (id) {
    case 'standard-50':
      return buildCorpus(id, 50, 0, ['V2-FND-001-S122', 'V2-SRF-001'], 'modern', 'x64');
    case 'standard-300':
      return buildCorpus(id, 300, 0, ['V2-FND-001-S016', 'V2-FND-001-S122', 'V2-SRF-001'], 'cross-runtime', 'cross-arch');
    case 'vendor-heavy':
      return buildCorpus(id, 180, 96, ['V2-FND-001-S047', 'V2-FND-001-S071', 'V2-FND-001-S122', 'V2-SRF-001'], 'net48', 'x64');
  }
}

export function buildV2Phase0Corpora(ids: readonly V2Phase0CorpusId[] = CANONICAL_CORPUS_IDS):
  readonly V2Phase0CorpusModel[] {
  return ids.map((id) => buildV2Phase0Corpus(id));
}

export async function runV2Phase0PerformanceSpike(
  runners: V2Phase0PerformanceRunners,
  options: V2Phase0PerformanceOptions = {},
): Promise<V2Phase0PerformanceReport> {
  const corpora = buildV2Phase0Corpora(options.corpora);
  const dpiLegs = options.dpiLegs ?? V2_PHASE0_DPI_LEGS;
  const now = options.now ?? (() => performance.now());
  const executionMode = options.executionMode ?? 'synthetic-harness';
  if (executionMode === 'real-product-path' && !runners.model) {
    throw new Error('real-product-path performance runs require an explicit model runner');
  }
  if (executionMode === 'real-product-path' && !options.productRunEvidence) {
    throw new Error('real-product-path performance runs require Extension Host product-run evidence');
  }
  if (executionMode === 'synthetic-harness' && options.productRunEvidence) {
    throw new Error('synthetic-harness performance runs cannot carry product-run evidence');
  }
  const measurements: V2Phase0LegMeasurement[] = [];

  for (const corpus of corpora) {
    for (const dpi of dpiLegs) {
      const phases: V2Phase0PhaseMeasurement[] = [];
      let previousArtifact: unknown = corpus;
      for (const phase of PHASES) {
        const runner = phase === 'model' ? runners.model ?? defaultModelRunner : runners[phase];
        const result = await measurePhase(runner, { corpus, dpi, phase, previousArtifact }, now);
        previousArtifact = result.artifact ?? previousArtifact;
        const p95Ms = percentile(result.samplesMs, 0.95);
        const budgetMs = V2_PHASE0_PHASE_BUDGETS_MS[corpus.id][phase];
        phases.push({
          phase,
          source: result.source,
          samplesMs: result.samplesMs,
          medianMs: round1(percentile(result.samplesMs, 0.5)),
          p95Ms: round1(p95Ms),
          budgetMs,
          status: p95Ms <= budgetMs ? 'PASS' : 'FAIL',
        });
      }

      // This is deliberately named a conservative bound: summing per-phase p95 values is not an end-to-end p95.
      // A GA performance artifact must come from real-product-path runners and may use this stricter bound.
      const interactiveConservativeBoundMs = round1(phases
        .filter((measurement) => measurement.phase !== 'model')
        .reduce((total, measurement) => total + measurement.p95Ms, 0));
      const interactiveBudgetMs = V2_PHASE0_INTERACTIVE_BUDGETS_MS[corpus.id];
      const withinBudgets = phases.every((phase) => phase.status === 'PASS')
        && interactiveConservativeBoundMs <= interactiveBudgetMs;
      const status: V2Phase0Status = withinBudgets
        ? executionMode === 'real-product-path' ? 'PASS' : 'NOT_EXECUTED'
        : 'FAIL';

      measurements.push({
        corpusId: corpus.id,
        dpiLegId: dpi.id,
        runtime: corpus.runtime,
        architecture: corpus.architecture,
        controlCount: corpus.expectedControlCount,
        vendorControlCount: corpus.vendorControlCount,
        displayDpr: dpi.displayDpr,
        captureScale: dpi.captureScale,
        physicalDpiEvidenceStatus: 'NOT_EXECUTED',
        phases,
        interactiveConservativeBoundMs,
        interactiveBudgetMs,
        status,
      });
    }
  }

  const report: V2Phase0PerformanceReport = {
    schemaVersion: '2.0.0-phase0-performance.2',
    executionMode,
    scenarioIds: unique(corpora.flatMap((corpus) => corpus.scenarioIds)),
    generatedAt: options.productRunEvidence?.observedAtUtc ?? new Date(0).toISOString(),
    productRunEvidence: options.productRunEvidence ?? null,
    dpiLegs,
    corpora,
    phaseBudgetsMs: V2_PHASE0_PHASE_BUDGETS_MS,
    interactiveBudgetsMs: V2_PHASE0_INTERACTIVE_BUDGETS_MS,
    notExecutedDimensions: V2_PHASE0_NOT_EXECUTED_DIMENSIONS,
    measurements,
    status: 'NOT_EXECUTED',
  };
  const validation = validateV2Phase0PerformanceReport(report);
  return { ...report, status: validation.status };
}

export function validateV2Phase0PerformanceReport(report: V2Phase0PerformanceReport): V2Phase0ValidationResult {
  const failures: string[] = [];
  const seen = new Set<string>();
  const corpusIds = report.corpora.map((corpus) => corpus.id);
  const dpiIds = report.dpiLegs.map((dpi) => dpi.id);

  if (report.executionMode !== 'synthetic-harness' && report.executionMode !== 'real-product-path') {
    failures.push(`unknown execution mode ${String(report.executionMode)}`);
  }
  validateProductRunEvidence(report, failures);

  for (const corpusId of CANONICAL_CORPUS_IDS) {
    if (!corpusIds.includes(corpusId)) failures.push(`missing corpus ${corpusId}`);
  }
  for (const corpusId of corpusIds) {
    if (!CANONICAL_CORPUS_IDS.includes(corpusId)) failures.push(`unexpected corpus ${corpusId}`);
  }
  for (const dpi of V2_PHASE0_DPI_LEGS) {
    if (!dpiIds.includes(dpi.id)) failures.push(`missing DPI leg ${dpi.id}`);
  }
  for (const dpiId of dpiIds) {
    if (!V2_PHASE0_DPI_LEGS.some((dpi) => dpi.id === dpiId)) failures.push(`unexpected DPI leg ${dpiId}`);
  }

  for (const dimension of V2_PHASE0_NOT_EXECUTED_DIMENSIONS) {
    const actual = report.notExecutedDimensions.find((entry) => entry.id === dimension.id);
    if (!actual) failures.push(`missing NOT_EXECUTED dimension ${dimension.id}`);
    else if (actual.status !== 'NOT_EXECUTED') failures.push(`${dimension.id} must stay NOT_EXECUTED in Phase 0`);
  }

  for (const corpus of report.corpora) {
    if (corpus.controls.length !== corpus.expectedControlCount) {
      failures.push(`${corpus.id} generated ${corpus.controls.length} controls, expected ${corpus.expectedControlCount}`);
    }
    const actualVendorCount = corpus.controls.filter((control) => control.vendor).length;
    if (actualVendorCount !== corpus.vendorControlCount) {
      failures.push(`${corpus.id} generated ${actualVendorCount} vendor controls, expected ${corpus.vendorControlCount}`);
    }
  }

  for (const corpusId of corpusIds) {
    for (const dpiId of dpiIds) {
      const measurement = report.measurements.find((entry) => entry.corpusId === corpusId && entry.dpiLegId === dpiId);
      const key = `${corpusId}/${dpiId}`;
      if (!measurement) {
        failures.push(`missing measurement ${key}`);
        continue;
      }
      seen.add(key);
      if (measurement.physicalDpiEvidenceStatus !== 'NOT_EXECUTED') {
        failures.push(`${key} physical DPI evidence must be NOT_EXECUTED`);
      }
      for (const phase of PHASES) {
        const phaseMeasurement = measurement.phases.find((entry) => entry.phase === phase);
        if (!phaseMeasurement) {
          failures.push(`missing measurement ${key}/${phase}`);
          continue;
        }
        validatePhaseMeasurement(key, phaseMeasurement, report.phaseBudgetsMs[corpusId][phase], failures);
        const expectedSource: V2Phase0MeasurementSource = report.executionMode === 'real-product-path'
          ? 'product-telemetry'
          : 'synthetic-harness';
        if (phaseMeasurement.source !== expectedSource) {
          failures.push(`${key}/${phase} source ${String(phaseMeasurement.source)} != ${expectedSource}`);
        }
      }
      if (!Number.isFinite(measurement.interactiveConservativeBoundMs)
        || measurement.interactiveConservativeBoundMs < 0) {
        failures.push(`${key} interactive conservative bound must be a finite non-negative number`);
      } else if (measurement.interactiveConservativeBoundMs > report.interactiveBudgetsMs[corpusId]) {
        failures.push(`${key} interactive conservative bound ${measurement.interactiveConservativeBoundMs}ms > ${report.interactiveBudgetsMs[corpusId]}ms`);
      }
      if (measurement.status === 'PASS' && measurement.phases.some((phase) => phase.status !== 'PASS')) {
        failures.push(`${key} status PASS conflicts with a failed phase`);
      }
    }
  }

  for (const measurement of report.measurements) {
    const key = `${measurement.corpusId}/${measurement.dpiLegId}`;
    if (!seen.has(key)) failures.push(`unexpected measurement ${key}`);
  }

  return {
    status: failures.length > 0
      ? 'FAIL'
      : report.executionMode === 'real-product-path' ? 'PASS' : 'NOT_EXECUTED',
    failures,
  };
}

export function assertV2Phase0PerformanceReport(report: V2Phase0PerformanceReport): void {
  const validation = validateV2Phase0PerformanceReport(report);
  if (validation.status === 'FAIL') {
    throw new Error(`v2 Phase 0 performance report failed:\n${validation.failures.join('\n')}`);
  }
}

function buildCorpus(
  id: V2Phase0CorpusId,
  count: number,
  vendorCount: number,
  scenarioIds: readonly string[],
  runtime: V2Phase0Runtime,
  architecture: V2Phase0Architecture,
): V2Phase0CorpusModel {
  const controls = Array.from({ length: count }, (_, index) => makeControl(index, index < vendorCount));
  return {
    id,
    scenarioIds,
    runtime,
    architecture,
    expectedControlCount: count,
    vendorControlCount: vendorCount,
    controls,
    designerText: buildDesignerText(id, controls),
  };
}

function makeControl(index: number, vendor: boolean): V2Phase0ControlModel {
  const row = Math.floor(index / 10);
  const column = index % 10;
  const standardTypes = [
    'System.Windows.Forms.Button',
    'System.Windows.Forms.TextBox',
    'System.Windows.Forms.Label',
    'System.Windows.Forms.CheckBox',
    'System.Windows.Forms.ComboBox',
  ];
  const vendorTypes = [
    'FakeVendor.WinForms.FancyButton',
    'FakeVendor.WinForms.DataPanel',
    'FakeVendor.WinForms.ActionGrid',
    'FakeVendor.WinForms.ValidatingTextBox',
  ];
  const typeName = vendor ? vendorTypes[index % vendorTypes.length] : standardTypes[index % standardTypes.length];
  return {
    id: `control${String(index + 1).padStart(3, '0')}`,
    typeName,
    parentId: 'this',
    x: 12 + column * 86,
    y: 12 + row * 32,
    width: vendor ? 104 : 78,
    height: 24,
    text: vendor ? `Vendor ${index + 1}` : `Control ${index + 1}`,
    vendor,
  };
}

function buildDesignerText(id: V2Phase0CorpusId, controls: readonly V2Phase0ControlModel[]): string {
  const className = toPascal(id);
  const declarations = controls
    .map((control) => `        private ${control.typeName} ${control.id};`)
    .join('\n');
  const body = controls
    .map((control) => [
      `            this.${control.id} = new ${control.typeName}();`,
      `            this.${control.id}.Location = new System.Drawing.Point(${control.x}, ${control.y});`,
      `            this.${control.id}.Name = "${control.id}";`,
      `            this.${control.id}.Size = new System.Drawing.Size(${control.width}, ${control.height});`,
      `            this.${control.id}.Text = "${control.text}";`,
      `            this.Controls.Add(this.${control.id});`,
    ].join('\n'))
    .join('\n');
  const height = Math.max(180, 56 + Math.ceil(controls.length / 10) * 32);
  return [
    'namespace V2Phase0PerformanceFixtures',
    '{',
    `    partial class ${className} : System.Windows.Forms.Form`,
    '    {',
    declarations,
    '',
    '        private void InitializeComponent()',
    '        {',
    body,
    `            this.ClientSize = new System.Drawing.Size(900, ${height});`,
    `            this.Name = "${className}";`,
    `            this.Text = "${id}";`,
    '        }',
    '    }',
    '}',
    '',
  ].join('\n');
}

function toPascal(id: V2Phase0CorpusId): string {
  return id.split('-').map((part) => part[0].toUpperCase() + part.slice(1)).join('');
}

async function measurePhase(
  runner: V2Phase0PhaseRunner,
  context: V2Phase0RunContext,
  now: () => number,
): Promise<{ samplesMs: readonly number[]; source: V2Phase0MeasurementSource; artifact: unknown }> {
  const started = now();
  const result = await runner(context);
  const elapsed = now() - started;
  const samplesMs = result.samplesMs ?? [result.durationMs ?? elapsed];
  const normalized = samplesMs.map((sample) => round1(sample));
  return { samplesMs: normalized, source: result.source ?? 'synthetic-harness', artifact: result.artifact };
}

function defaultModelRunner(context: V2Phase0RunContext): V2Phase0PhaseResult {
  return {
    durationMs: Math.max(1, context.corpus.expectedControlCount / 10),
    source: 'synthetic-harness',
    artifact: context.corpus,
  };
}

function validateProductRunEvidence(report: V2Phase0PerformanceReport, failures: string[]): void {
  const evidence = report.productRunEvidence;
  if (report.executionMode === 'synthetic-harness') {
    if (evidence !== null) failures.push('synthetic-harness report must not carry product-run evidence');
    return;
  }
  if (!evidence) {
    failures.push('real-product-path report is missing product-run evidence');
    return;
  }
  if (evidence.schemaVersion !== '2.0.0-product-performance-evidence.1') {
    failures.push(`unexpected product-run evidence schema ${String(evidence.schemaVersion)}`);
  }
  if (evidence.scenarioId !== 'V2-FND-001-S122') {
    failures.push(`unexpected product-run scenario ${String(evidence.scenarioId)}`);
  }
  if (evidence.hostKind !== 'vscode-extension-host') {
    failures.push(`unexpected product-run host ${String(evidence.hostKind)}`);
  }
  if (!evidence.hostVersion.trim()) failures.push('product-run host version must be non-empty');
  if (evidence.hostArchitecture !== 'x64' && evidence.hostArchitecture !== 'arm64') {
    failures.push(`unexpected product-run host architecture ${String(evidence.hostArchitecture)}`);
  }
  if (!Number.isInteger(evidence.processId) || evidence.processId <= 0) {
    failures.push('product-run process id must be a positive integer');
  }
  if (!Number.isFinite(Date.parse(evidence.observedAtUtc))) {
    failures.push('product-run observedAtUtc must be an ISO timestamp');
  }
  if (report.generatedAt !== evidence.observedAtUtc) {
    failures.push('report generatedAt must match product-run observedAtUtc');
  }
}

function validatePhaseMeasurement(
  key: string,
  measurement: V2Phase0PhaseMeasurement,
  expectedBudgetMs: number,
  failures: string[],
): void {
  if (measurement.budgetMs !== expectedBudgetMs) {
    failures.push(`${key}/${measurement.phase} budget ${measurement.budgetMs}ms != frozen ${expectedBudgetMs}ms`);
  }
  if (measurement.samplesMs.length === 0) {
    failures.push(`${key}/${measurement.phase} has no samples`);
  }
  for (const sample of measurement.samplesMs) {
    if (!Number.isFinite(sample) || sample < 0) failures.push(`${key}/${measurement.phase} has invalid sample ${sample}`);
  }
  if (!Number.isFinite(measurement.p95Ms) || measurement.p95Ms < 0) {
    failures.push(`${key}/${measurement.phase} p95 must be a finite non-negative number`);
  } else if (measurement.p95Ms > expectedBudgetMs) {
    failures.push(`${key}/${measurement.phase} p95 ${measurement.p95Ms}ms > ${expectedBudgetMs}ms`);
  }
  if (measurement.status === 'PASS' && measurement.p95Ms > expectedBudgetMs) {
    failures.push(`${key}/${measurement.phase} status PASS conflicts with p95 ${measurement.p95Ms}ms`);
  }
}

function percentile(values: readonly number[], ratio: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

function round1(value: number): number {
  return Number(value.toFixed(1));
}

function unique(values: readonly string[]): readonly string[] {
  return Array.from(new Set(values));
}
