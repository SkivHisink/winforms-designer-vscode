import { changedLines, diffLines, isByteLocalEdit } from './byteLocal';
import { sha256Hex } from './documentStore';
import { PatchSet, validatePatchSet } from './patchSet';
import {
  V2Phase0PerformanceReport,
  V2Phase0Status,
  validateV2Phase0PerformanceReport,
} from './v2Phase0Performance';
import {
  DesignTimeTrust,
  ProjectArchitecture,
  WorkerArchitecture,
  WorkerPayloadIdentity,
  WorkerRuntime,
  WorkspaceTrust,
  selectWorker,
  workerKeyId,
} from './workerSelection';

export type V2HeadlessStatus = 'PASS' | 'FAIL' | 'NOT_EXECUTED' | 'GATED';
export type V2HeadlessFindingCategory =
  | 'compatibility'
  | 'security'
  | 'fallback'
  | 'diff'
  | 'a11y'
  | 'perf'
  | 'advisor';
export type V2HeadlessSeverity = 'info' | 'warning' | 'error';
export type V2HeadlessRuntime = WorkerRuntime | 'headless' | 'visual-studio-reference';
export type V2HeadlessExternalGateId =
  | 'visual-studio-reference'
  | 'vendor-artifact'
  | 'physical-hardware'
  | 'accessibility-assistive-technology'
  | 'performance-lab';

export interface V2HeadlessControlSnapshot {
  readonly id: string;
  readonly typeName: string;
  readonly text?: string;
  readonly accessibleName?: string;
  readonly imageOnly?: boolean;
  readonly visible?: boolean;
  readonly enabled?: boolean;
  readonly tabIndex?: number;
}

export interface V2HeadlessDiagnosticValue {
  readonly label: string;
  readonly value: string;
  readonly sensitivity?: 'public' | 'path' | 'proprietary' | 'secret';
}

export interface V2HeadlessCapabilityInspection {
  readonly operation: string;
  readonly target: string;
  readonly authorityLane: string;
  readonly reasonCode: string;
  readonly recoveryOptions: readonly string[];
}

export interface V2HeadlessRecoveryEvent {
  readonly kind: 'crash' | 'cancelled' | 'quarantined' | 'retry' | 'currentRevision';
  readonly crashId?: string;
  readonly scenarioId?: string;
  readonly reasonCode?: string;
  readonly quarantineUntilUtc?: string;
  readonly documentRevision?: string;
  readonly workerGeneration?: number;
}

export interface V2HeadlessCrashContinuation {
  readonly crashedScenarioId: string;
  readonly continuedScenarioIds: readonly string[];
  readonly workerGenerationBefore: number;
  readonly workerGenerationAfter: number;
  readonly recoveryRequiredCount: number;
}

export interface V2HeadlessScenario {
  readonly id: string;
  readonly title?: string;
  readonly tier?: 'A' | 'B' | 'C' | 'D';
  readonly runtime?: V2HeadlessRuntime;
  readonly hostArchitecture?: WorkerArchitecture;
  readonly projectArchitecture?: ProjectArchitecture;
  readonly workspaceTrust?: WorkspaceTrust;
  readonly designTimeTrust?: DesignTimeTrust;
  readonly containsComActiveX?: boolean;
  readonly requiresX86?: boolean;
  readonly requiresHostedCode?: boolean;
  readonly requiresVendorArtifact?: boolean;
  readonly renderMode?: 'interpreted' | 'compiledFallback' | 'unavailable';
  readonly fallbackReason?: string;
  readonly payload?: Partial<WorkerPayloadIdentity>;
  readonly baselineSourceText?: string;
  readonly currentSourceText?: string;
  readonly proposedSourceText?: string;
  readonly patchSet?: PatchSet;
  readonly controls?: readonly V2HeadlessControlSnapshot[];
  readonly expectedLocalizedTextKeys?: readonly string[];
  readonly localizedResourceKeys?: readonly string[];
  readonly performanceReport?: V2Phase0PerformanceReport;
  readonly diagnosticValues?: readonly V2HeadlessDiagnosticValue[];
  readonly capabilityInspection?: V2HeadlessCapabilityInspection;
  readonly recoveryTimeline?: readonly V2HeadlessRecoveryEvent[];
  readonly crashContinuation?: V2HeadlessCrashContinuation;
  readonly arbitrarySourceExecutionRequired?: boolean;
}

export interface V2HeadlessValidateOptions {
  readonly generatedAtUtc?: string;
}

export interface V2HeadlessQuickFixPreview {
  readonly kind: 'previewOnly';
  readonly target: 'source';
  readonly summary: string;
  readonly beforeSha256: string;
  readonly afterSha256: string;
  readonly mutationStatus: 'NOT_EXECUTED';
}

export interface V2HeadlessFinding {
  readonly id: string;
  readonly scenarioId: string;
  readonly category: V2HeadlessFindingCategory;
  readonly status: V2HeadlessStatus;
  readonly severity: V2HeadlessSeverity;
  readonly code: string;
  readonly message: string;
  readonly evidence?: Readonly<Record<string, unknown>>;
  readonly quickFix?: V2HeadlessQuickFixPreview;
}

export interface V2HeadlessExternalEvidence {
  readonly id: V2HeadlessExternalGateId;
  readonly status: Extract<V2HeadlessStatus, 'NOT_EXECUTED' | 'GATED'>;
  readonly reason: string;
}

export interface V2HeadlessSummary {
  readonly totalFindings: number;
  readonly byStatus: Readonly<Record<V2HeadlessStatus, number>>;
  readonly byCategory: Readonly<Record<V2HeadlessFindingCategory, Readonly<Record<V2HeadlessStatus, number>>>>;
}

export interface V2HeadlessValidationReport {
  readonly schemaVersion: '2.0.0-headless-validate.1';
  readonly generatedAtUtc: string;
  readonly mutationPolicy: 'non-mutating';
  readonly scenarioIds: readonly string[];
  readonly findings: readonly V2HeadlessFinding[];
  readonly externalEvidence: readonly V2HeadlessExternalEvidence[];
  readonly summary: V2HeadlessSummary;
  readonly status: V2HeadlessStatus;
}

export interface V2HeadlessReportValidation {
  readonly status: V2HeadlessStatus;
  readonly failures: readonly string[];
}

const categories: readonly V2HeadlessFindingCategory[] = [
  'compatibility',
  'security',
  'fallback',
  'diff',
  'a11y',
  'perf',
  'advisor',
];
const statuses: readonly V2HeadlessStatus[] = ['PASS', 'FAIL', 'NOT_EXECUTED', 'GATED'];
const externalEvidence: readonly V2HeadlessExternalEvidence[] = [
  {
    id: 'visual-studio-reference',
    status: 'NOT_EXECUTED',
    reason: 'Headless repository validation does not execute or claim Visual Studio reference traces.',
  },
  {
    id: 'vendor-artifact',
    status: 'GATED',
    reason: 'Licensed vendor binaries, manifests, and certification cohorts are outside this repository-only run.',
  },
  {
    id: 'physical-hardware',
    status: 'NOT_EXECUTED',
    reason: 'No physical DPI, ARM64, screen-reader, or long-running hardware lab evidence is produced here.',
  },
  {
    id: 'accessibility-assistive-technology',
    status: 'NOT_EXECUTED',
    reason: 'Advisor diagnostics are static and do not claim live assistive-technology acceptance.',
  },
  {
    id: 'performance-lab',
    status: 'GATED',
    reason: 'Synthetic or injected timings can validate report shape; GA performance claims require lab attribution.',
  },
];
const secretLike = /(secret|token|password|passwd|api[-_ ]?key|connection[-_ ]?string|license[-_ ]?key)/i;
const pathLike = /(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+[\\/]|\/(?:Users|home|mnt|var|tmp|opt)\/)/;

export function runV2HeadlessValidation(
  scenarios: readonly V2HeadlessScenario[],
  options: V2HeadlessValidateOptions = {},
): V2HeadlessValidationReport {
  const findings = scenarios.flatMap((scenario) => analyzeScenario(scenario));
  const summary = summarizeFindings(findings);
  const report: V2HeadlessValidationReport = {
    schemaVersion: '2.0.0-headless-validate.1',
    generatedAtUtc: options.generatedAtUtc ?? new Date(0).toISOString(),
    mutationPolicy: 'non-mutating',
    scenarioIds: scenarios.map((scenario) => scenario.id),
    findings,
    externalEvidence,
    summary,
    status: aggregateStatus(findings),
  };
  const validation = validateV2HeadlessValidationReport(report);
  return validation.status === 'FAIL' ? { ...report, status: 'FAIL' } : report;
}

export function validateV2HeadlessValidationReport(report: V2HeadlessValidationReport): V2HeadlessReportValidation {
  const failures: string[] = [];
  if (report.schemaVersion !== '2.0.0-headless-validate.1') failures.push('schemaVersion must be 2.0.0-headless-validate.1');
  if (report.mutationPolicy !== 'non-mutating') failures.push('mutationPolicy must be non-mutating');

  const findingIds = new Set<string>();
  for (const finding of report.findings) {
    if (!finding.id || findingIds.has(finding.id)) failures.push(`finding id is empty or duplicated: ${finding.id}`);
    findingIds.add(finding.id);
    if (!categories.includes(finding.category)) failures.push(`unknown finding category ${String(finding.category)}`);
    if (!statuses.includes(finding.status)) failures.push(`unknown finding status ${String(finding.status)}`);
    if (!finding.scenarioId) failures.push(`finding ${finding.id} is missing scenarioId`);
    if (!finding.code || !finding.message) failures.push(`finding ${finding.id} is missing code or message`);
    if (containsUnredactedSecret(finding)) failures.push(`finding ${finding.id} contains unredacted secret-like text`);
  }

  for (const category of categories) {
    if (!report.findings.some((finding) => finding.category === category)) {
      failures.push(`missing required finding category ${category}`);
    }
  }

  const evidenceIds = new Set<V2HeadlessExternalGateId>();
  for (const evidence of report.externalEvidence) {
    evidenceIds.add(evidence.id);
    if (evidence.status !== 'NOT_EXECUTED' && evidence.status !== 'GATED') {
      failures.push(`external evidence ${evidence.id} must not be reported as ${String(evidence.status)}`);
    }
  }
  for (const expected of externalEvidence) {
    if (!evidenceIds.has(expected.id)) failures.push(`missing external evidence gate ${expected.id}`);
  }

  const actualSummary = summarizeFindings(report.findings);
  if (JSON.stringify(actualSummary) !== JSON.stringify(report.summary)) {
    failures.push('summary does not match findings');
  }
  const expectedStatus = aggregateStatus(report.findings);
  if (report.status !== expectedStatus && !(report.status === 'FAIL' && failures.length > 0)) {
    failures.push(`report status ${report.status} does not match findings status ${expectedStatus}`);
  }

  return {
    status: failures.length > 0 ? 'FAIL' : report.status,
    failures,
  };
}

export function assertV2HeadlessValidationReport(report: V2HeadlessValidationReport): void {
  const validation = validateV2HeadlessValidationReport(report);
  if (validation.status === 'FAIL') {
    throw new Error(`v2 headless validation report failed:\n${validation.failures.join('\n')}`);
  }
}

function analyzeScenario(scenario: V2HeadlessScenario): readonly V2HeadlessFinding[] {
  return [
    ...analyzeCapabilityInspection(scenario),
    analyzeCompatibility(scenario),
    analyzeSecurity(scenario),
    analyzeFallback(scenario),
    analyzeDiff(scenario),
    ...analyzeRecovery(scenario),
    ...analyzeA11y(scenario),
    analyzePerformance(scenario),
    ...analyzeAdvisor(scenario),
  ];
}

function analyzeCapabilityInspection(scenario: V2HeadlessScenario): readonly V2HeadlessFinding[] {
  const inspection = scenario.capabilityInspection;
  if (!inspection) return [];
  // This DTO is caller input, not the output of a product capability inspector. Treating it as PASS let arbitrary
  // reason codes and recovery options (including nonexistent values) manufacture release evidence. Preserve the
  // diagnostic shape for backwards-compatible report readers, but never promote unverified input to PASS.
  return [finding(scenario, 'compatibility', 'NOT_EXECUTED', 'warning', 'CAPABILITY_INSPECTION_NOT_EXECUTED', 'Caller-supplied capability metadata is not product execution evidence.', {
    inputFieldsPresent: Object.keys(inspection).sort(),
    trustedProductProducer: false,
    mutationStatus: 'NOT_EXECUTED',
  })];
}

function analyzeCompatibility(scenario: V2HeadlessScenario): V2HeadlessFinding {
  const runtime = scenario.runtime ?? 'headless';
  if (runtime === 'headless') {
    return finding(scenario, 'compatibility', 'PASS', 'info', 'HEADLESS_READONLY_MATRIX', 'Scenario is validated by the headless read-only report path.');
  }
  if (runtime === 'visual-studio-reference') {
    return finding(scenario, 'compatibility', 'NOT_EXECUTED', 'warning', 'VISUAL_STUDIO_REFERENCE_NOT_EXECUTED', 'Visual Studio reference compatibility is not executed by this headless run.');
  }

  const selection = selectWorker({
    runtime,
    hostArchitecture: scenario.hostArchitecture ?? 'x64',
    projectArchitecture: scenario.projectArchitecture ?? 'anycpu',
    workspaceTrust: scenario.workspaceTrust ?? 'untrusted',
    designTimeTrust: scenario.designTimeTrust ?? 'parseOnly',
    containsComActiveX: scenario.containsComActiveX,
    requiresX86: scenario.requiresX86,
    payload: payloadIdentity(scenario),
  });
  if (!selection.ok) {
    const expectedPhaseGate = selection.refusal.reasonCode === 'X86_WORKER_UNAVAILABLE'
      || selection.refusal.reasonCode === 'COM_ACTIVE_X_UNSUPPORTED';
    return finding(
      scenario,
      'compatibility',
      expectedPhaseGate ? 'GATED' : 'FAIL',
      expectedPhaseGate ? 'warning' : 'error',
      selection.refusal.reasonCode,
      selection.refusal.message,
      { mutationAuthority: selection.refusal.mutationAuthority, canMutateWorkspace: selection.refusal.canMutateWorkspace },
    );
  }

  return finding(scenario, 'compatibility', 'PASS', 'info', 'WORKER_SELECTED', 'Managed worker selection is deterministic for this scenario.', {
    workerKey: workerKeyId(selection.worker.key),
    mutationAuthority: selection.worker.mutationAuthority,
    canLoadProjectCode: selection.worker.capabilities.canLoadProjectCode,
    canMutateWorkspace: selection.worker.capabilities.canMutateWorkspace,
  });
}

function analyzeSecurity(scenario: V2HeadlessScenario): V2HeadlessFinding {
  const diagnosticValues = redactDiagnosticValues(scenario.diagnosticValues ?? []);

  if (scenario.arbitrarySourceExecutionRequired) {
    return finding(
      scenario,
      'security',
      'PASS',
      'info',
      'ARBITRARY_SOURCE_EXECUTION_REQUIRED',
      'Metadata inspection refused a value path that would require running arbitrary project code.',
      { loadAttempted: false, mutationStatus: 'NOT_EXECUTED', diagnosticValues },
    );
  }

  if (scenario.requiresHostedCode) {
    const hasOptIn = scenario.workspaceTrust === 'trusted' && scenario.designTimeTrust === 'hostedDesignTime';
    return finding(
      scenario,
      'security',
      hasOptIn ? 'GATED' : 'PASS',
      hasOptIn ? 'warning' : 'info',
      hasOptIn ? 'HOSTED_CODE_NOT_EXECUTED_HEADLESS' : 'TRUST_OPT_IN_REQUIRED',
      hasOptIn
        ? 'Hosted design-time code is opted in, but the headless validator does not load project or vendor code.'
        : 'Hosted design-time code is refused without explicit workspace and design-time trust.',
      { loadAttempted: false, diagnosticValues },
    );
  }

  return finding(scenario, 'security', 'PASS', 'info', 'READONLY_SECURITY_BOUNDARY', 'Headless validation performs no workspace mutation and loads no project code.', {
    loadAttempted: false,
    diagnosticValues,
  });
}

function analyzeFallback(scenario: V2HeadlessScenario): V2HeadlessFinding {
  if (!scenario.renderMode) {
    return finding(scenario, 'fallback', 'NOT_EXECUTED', 'info', 'RENDER_FALLBACK_NOT_EXECUTED', 'No render-mode observation was supplied to the headless validator.');
  }
  if (scenario.renderMode === 'interpreted') {
    return finding(scenario, 'fallback', 'PASS', 'info', 'INTERPRETED_RENDER', 'Render observation is source-first/interpreted; no compiled fallback was used.');
  }
  if (scenario.renderMode === 'compiledFallback') {
    const reason = scenario.fallbackReason?.trim();
    return finding(
      scenario,
      'fallback',
      reason ? 'PASS' : 'FAIL',
      reason ? 'warning' : 'error',
      reason ? 'FALLBACK_DISCLOSED' : 'SILENT_FALLBACK',
      reason ? 'Compiled fallback is explicitly disclosed with a reason.' : 'Compiled fallback was observed without an explicit reason.',
      reason ? { fallbackReason: reason } : undefined,
    );
  }
  return finding(scenario, 'fallback', scenario.fallbackReason ? 'GATED' : 'FAIL', scenario.fallbackReason ? 'warning' : 'error', 'RENDER_UNAVAILABLE', scenario.fallbackReason ?? 'Render was unavailable without a refusal reason.');
}

function analyzeDiff(scenario: V2HeadlessScenario): V2HeadlessFinding {
  const patchValidation = scenario.patchSet ? validatePatchSet(scenario.patchSet) : null;
  if (patchValidation && !patchValidation.ok) {
    return finding(scenario, 'diff', 'FAIL', 'error', 'PATCHSET_INVALID', 'PatchSet validation failed before any mutation.', {
      errors: patchValidation.errors,
    });
  }

  if (scenario.baselineSourceText === undefined || scenario.proposedSourceText === undefined) {
    return patchValidation
      ? finding(scenario, 'diff', 'PASS', 'info', 'PATCHSET_VALIDATED', 'PatchSet shape is valid and no source diff payload was supplied.', {
        targetCount: patchValidation.normalizedTargets.length,
      })
      : finding(scenario, 'diff', 'NOT_EXECUTED', 'info', 'SOURCE_DIFF_NOT_EXECUTED', 'No proposed source diff was supplied to the headless validator.');
  }

  const local = isByteLocalEdit(scenario.baselineSourceText, scenario.proposedSourceText);
  const diff = diffLines(scenario.baselineSourceText, scenario.proposedSourceText);
  const changed = changedLines(scenario.baselineSourceText, scenario.proposedSourceText);
  return finding(
    scenario,
    'diff',
    local ? 'PASS' : 'FAIL',
    local ? 'info' : 'error',
    local ? 'SOURCE_DIFF_LOCAL' : 'UNRELATED_SOURCE_DIFF',
    local ? 'Proposed source diff is byte-local by the repository guardrail.' : 'Proposed source diff is too broad for the byte-local guardrail.',
    {
      beforeSha256: sha256Hex(scenario.baselineSourceText),
      afterSha256: sha256Hex(scenario.proposedSourceText),
      beforeLines: diff.beforeLines,
      afterLines: diff.afterLines,
      removedLines: diff.removed,
      insertedLines: diff.inserted,
      changedInsertedLineCount: changed.inserted.length,
      changedRemovedLineCount: changed.removed.length,
      patchTargetCount: patchValidation?.normalizedTargets.length ?? 0,
    },
  );
}

function analyzeRecovery(scenario: V2HeadlessScenario): readonly V2HeadlessFinding[] {
  const findings: V2HeadlessFinding[] = [];
  if (scenario.recoveryTimeline) {
    const kinds = scenario.recoveryTimeline.map((event) => event.kind);
    const hasCrash = scenario.recoveryTimeline.some((event) => event.kind === 'crash' && !!event.crashId);
    const hasCancellation = kinds.includes('cancelled');
    const hasQuarantine = scenario.recoveryTimeline.some((event) => event.kind === 'quarantined' && !!event.quarantineUntilUtc);
    const hasRetry = kinds.includes('retry');
    const currentRevision = scenario.recoveryTimeline.find((event) => event.kind === 'currentRevision')?.documentRevision;
    const complete = hasCrash && hasCancellation && hasQuarantine && hasRetry && !!currentRevision;
    findings.push(finding(
      scenario,
      'compatibility',
      complete ? 'PASS' : 'FAIL',
      complete ? 'info' : 'error',
      complete ? 'RECOVERY_TIMELINE_RECORDED' : 'RECOVERY_TIMELINE_INCOMPLETE',
      complete
        ? 'Recovery timeline records crash, cancellation, quarantine, retry, and final current revision.'
        : 'Recovery timeline is missing one or more required events.',
      {
        eventKinds: kinds,
        crashIds: scenario.recoveryTimeline.map((event) => event.crashId).filter(Boolean),
        currentRevision,
      },
    ));
  }

  if (scenario.crashContinuation) {
    const continuation = scenario.crashContinuation;
    const complete = continuation.continuedScenarioIds.length > 0
      && continuation.workerGenerationAfter > continuation.workerGenerationBefore
      && continuation.recoveryRequiredCount === 0;
    findings.push(finding(
      scenario,
      'compatibility',
      complete ? 'PASS' : 'FAIL',
      complete ? 'info' : 'error',
      complete ? 'HEADLESS_CRASH_CONTINUED' : 'HEADLESS_CRASH_STOPPED',
      complete
        ? 'Headless validation records the crashing scenario and continues later corpus entries on a newer worker generation.'
        : 'Headless validation did not prove continuation after the crashing scenario.',
      {
        crashedScenarioId: continuation.crashedScenarioId,
        continuedScenarioIds: continuation.continuedScenarioIds,
        workerGenerationBefore: continuation.workerGenerationBefore,
        workerGenerationAfter: continuation.workerGenerationAfter,
        recoveryRequiredCount: continuation.recoveryRequiredCount,
      },
    ));
  }

  return findings;
}

function analyzeA11y(scenario: V2HeadlessScenario): readonly V2HeadlessFinding[] {
  const findings: V2HeadlessFinding[] = [];
  const inaccessibleImageButtons = (scenario.controls ?? []).filter((control) =>
    control.visible !== false
    && control.enabled !== false
    && control.imageOnly === true
    && isButton(control.typeName)
    && !(control.accessibleName?.trim() || control.text?.trim()));
  if (inaccessibleImageButtons.length > 0) {
    findings.push(finding(scenario, 'a11y', 'FAIL', 'warning', 'ACCESSIBLE_NAME_MISSING', 'Image-only button controls need an accessible name or visible text.', {
      controlIds: inaccessibleImageButtons.map((control) => control.id),
    }));
  }

  if (scenario.baselineSourceText?.includes('AutoScaleMode.None')) {
    findings.push(finding(scenario, 'a11y', 'FAIL', 'warning', 'AUTOSCALEMODE_NONE', 'AutoScaleMode.None is a DPI risk and should be reviewed before v2 GA.', {
      advisoryOnly: true,
    }));
  }

  const missingLocalizedKeys = (scenario.expectedLocalizedTextKeys ?? [])
    .filter((key) => !(scenario.localizedResourceKeys ?? []).includes(key));
  if (missingLocalizedKeys.length > 0) {
    findings.push(finding(scenario, 'a11y', 'FAIL', 'warning', 'LOCALIZED_TEXT_FALLBACK_USED', 'Target-culture resource keys are missing and would fall back to neutral text.', {
      missingKeyCount: missingLocalizedKeys.length,
      missingKeys: missingLocalizedKeys,
    }));
  }

  return findings.length > 0
    ? findings
    : [finding(scenario, 'a11y', (scenario.controls || scenario.baselineSourceText) ? 'PASS' : 'NOT_EXECUTED', 'info', (scenario.controls || scenario.baselineSourceText) ? 'STATIC_A11Y_RULES_PASS' : 'STATIC_A11Y_NOT_EXECUTED', (scenario.controls || scenario.baselineSourceText) ? 'Static accessibility advisor rules found no issue in supplied inputs.' : 'No control/source accessibility inputs were supplied.')];
}

function analyzePerformance(scenario: V2HeadlessScenario): V2HeadlessFinding {
  if (!scenario.performanceReport) {
    return finding(scenario, 'perf', 'NOT_EXECUTED', 'info', 'PERFORMANCE_NOT_EXECUTED', 'No performance report was supplied to the headless validator.');
  }
  const validation = validateV2Phase0PerformanceReport(scenario.performanceReport);
  return finding(
    scenario,
    'perf',
    normalizePerfStatus(validation.status),
    validation.status === 'FAIL' ? 'error' : 'info',
    validation.status === 'FAIL' ? 'PERFORMANCE_REPORT_FAIL' : 'PERFORMANCE_REPORT_VALIDATED',
    validation.status === 'FAIL'
      ? 'Performance report failed validation.'
      : 'Performance report shape and frozen budgets validated within its declared execution mode.',
    {
      executionMode: scenario.performanceReport.executionMode,
      performanceStatus: validation.status,
      failures: validation.failures,
      measurementCount: scenario.performanceReport.measurements.length,
    },
  );
}

function analyzeAdvisor(scenario: V2HeadlessScenario): readonly V2HeadlessFinding[] {
  const findings: V2HeadlessFinding[] = [];
  if (
    scenario.baselineSourceText !== undefined
    && scenario.currentSourceText !== undefined
    && scenario.currentSourceText !== scenario.baselineSourceText
  ) {
    findings.push(finding(scenario, 'advisor', 'FAIL', 'error', 'STALE_ADVISOR_BASELINE', 'Advisor preview is stale and must be refreshed before any quick fix can be accepted.', {
      baselineSha256: sha256Hex(scenario.baselineSourceText),
      currentSha256: sha256Hex(scenario.currentSourceText),
      mutationStatus: 'NOT_EXECUTED',
    }));
    return findings;
  }

  const quickFix = autoScaleQuickFix(scenario);
  if (quickFix) {
    findings.push(finding(scenario, 'advisor', 'PASS', 'info', 'DPI_QUICK_FIX_PREVIEW', 'Advisor produced a preview-only AutoScaleMode DPI quick fix.', undefined, quickFix));
  }

  const missingNameControls = (scenario.controls ?? []).filter((control) =>
    control.imageOnly === true && isButton(control.typeName) && !(control.accessibleName?.trim() || control.text?.trim()));
  if (missingNameControls.length > 0) {
    findings.push(finding(scenario, 'advisor', 'PASS', 'info', 'ACCESSIBLE_NAME_QUICK_FIX_PREVIEW', 'Advisor can preview an accessible-name fix; accepting it remains an explicit mutation step outside headless validation.', {
      controlIds: missingNameControls.map((control) => control.id),
      mutationStatus: 'NOT_EXECUTED',
    }));
  }

  return findings.length > 0
    ? findings
    : [finding(scenario, 'advisor', 'NOT_EXECUTED', 'info', 'ADVISOR_NOT_EXECUTED', 'No advisor rule produced a preview for the supplied inputs.')];
}

function autoScaleQuickFix(scenario: V2HeadlessScenario): V2HeadlessQuickFixPreview | null {
  const before = scenario.baselineSourceText;
  if (!before?.includes('AutoScaleMode.None')) return null;
  const after = before.replace('AutoScaleMode.None', 'AutoScaleMode.Font');
  return {
    kind: 'previewOnly',
    target: 'source',
    summary: 'Change AutoScaleMode.None to AutoScaleMode.Font.',
    beforeSha256: sha256Hex(before),
    afterSha256: sha256Hex(after),
    mutationStatus: 'NOT_EXECUTED',
  };
}

function redactDiagnosticValues(values: readonly V2HeadlessDiagnosticValue[]): readonly Record<string, unknown>[] {
  return values.map((value) => {
    const sensitivity = diagnosticSensitivity(value);
    if (sensitivity === 'public') {
      return {
        label: value.label,
        value: value.value,
        redacted: false,
      };
    }
    return {
      label: value.label,
      sha256: sha256Hex(value.value),
      byteLength: Buffer.byteLength(value.value, 'utf8'),
      redacted: true,
      reason: sensitivity,
    };
  });
}

function diagnosticSensitivity(value: V2HeadlessDiagnosticValue): 'public' | 'path' | 'proprietary' | 'secret' {
  if (value.sensitivity) return value.sensitivity;
  if (secretLike.test(value.label) || secretLike.test(value.value)) return 'secret';
  if (pathLike.test(value.value)) return 'path';
  return 'public';
}

function finding(
  scenario: V2HeadlessScenario,
  category: V2HeadlessFindingCategory,
  status: V2HeadlessStatus,
  severity: V2HeadlessSeverity,
  code: string,
  message: string,
  evidence?: Readonly<Record<string, unknown>>,
  quickFix?: V2HeadlessQuickFixPreview,
): V2HeadlessFinding {
  return {
    id: `${scenario.id}:${category}:${code}`,
    scenarioId: scenario.id,
    category,
    status,
    severity,
    code,
    message,
    evidence,
    quickFix,
  };
}

function payloadIdentity(scenario: V2HeadlessScenario): WorkerPayloadIdentity {
  return {
    sessionId: scenario.payload?.sessionId ?? `${scenario.id}-session`,
    documentId: scenario.payload?.documentId ?? `${scenario.id}-document`,
    documentRevision: scenario.payload?.documentRevision ?? 'revision-0',
    sourceFingerprint: scenario.payload?.sourceFingerprint ?? '0'.repeat(64),
    resourceFingerprint: scenario.payload?.resourceFingerprint,
    payloadHash: scenario.payload?.payloadHash ?? '1'.repeat(64),
  };
}

function summarizeFindings(findings: readonly V2HeadlessFinding[]): V2HeadlessSummary {
  const byStatus = statusCounts();
  const byCategory: Record<V2HeadlessFindingCategory, Record<V2HeadlessStatus, number>> = {
    compatibility: statusCounts(),
    security: statusCounts(),
    fallback: statusCounts(),
    diff: statusCounts(),
    a11y: statusCounts(),
    perf: statusCounts(),
    advisor: statusCounts(),
  };
  for (const finding of findings) {
    byStatus[finding.status]++;
    byCategory[finding.category][finding.status]++;
  }
  return { totalFindings: findings.length, byStatus, byCategory };
}

function statusCounts(): Record<V2HeadlessStatus, number> {
  return { PASS: 0, FAIL: 0, NOT_EXECUTED: 0, GATED: 0 };
}

function aggregateStatus(findings: readonly V2HeadlessFinding[]): V2HeadlessStatus {
  if (findings.some((finding) => finding.status === 'FAIL')) return 'FAIL';
  if (findings.some((finding) => finding.status === 'GATED')) return 'GATED';
  if (findings.some((finding) => finding.status === 'NOT_EXECUTED')) return 'NOT_EXECUTED';
  return 'PASS';
}

function normalizePerfStatus(status: V2Phase0Status): V2HeadlessStatus {
  return status;
}

function isButton(typeName: string): boolean {
  return /(^|\.)(Button|ToolStripButton)$/i.test(typeName);
}

function containsUnredactedSecret(finding: V2HeadlessFinding): boolean {
  return stringContainsSensitiveText(finding.message)
    || containsUnredactedSensitiveValue(finding.evidence)
    || containsUnredactedSensitiveValue(finding.quickFix);
}

function containsUnredactedSensitiveValue(value: unknown): boolean {
  if (typeof value === 'string') return stringContainsSensitiveText(value);
  if (Array.isArray(value)) return value.some((entry) => containsUnredactedSensitiveValue(entry));
  if (!value || typeof value !== 'object') return false;

  const record = value as Record<string, unknown>;
  const isRedactionRecord = record.redacted === true;
  for (const [key, child] of Object.entries(record)) {
    if (isRedactionRecord && (key === 'label' || key === 'reason' || key === 'sha256')) continue;
    if (containsUnredactedSensitiveValue(child)) return true;
  }
  return false;
}

function stringContainsSensitiveText(value: string): boolean {
  return secretLike.test(value) || pathLike.test(value);
}
