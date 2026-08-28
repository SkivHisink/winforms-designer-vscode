import { describe, expect, it } from 'vitest';
import {
  V2_PHASE0_DPI_LEGS,
  V2Phase0PerformanceReport,
  assertV2Phase0PerformanceReport,
  buildV2Phase0Corpus,
  runV2Phase0PerformanceSpike,
  validateV2Phase0PerformanceReport,
} from './v2Phase0Performance';

describe('v2 Phase 0 performance spike', () => {
  it('generates deterministic standard and vendor-heavy corpora', () => {
    const standard50 = buildV2Phase0Corpus('standard-50');
    const standard300 = buildV2Phase0Corpus('standard-300');
    const vendor = buildV2Phase0Corpus('vendor-heavy');

    expect(standard50.controls).toHaveLength(50);
    expect(standard300.controls).toHaveLength(300);
    expect(vendor.controls).toHaveLength(180);
    expect(vendor.controls.filter((control) => control.vendor)).toHaveLength(96);
    expect(vendor.designerText).toContain('FakeVendor.WinForms.FancyButton');
    expect(standard300.designerText).toContain('this.control300.Text = "Control 300";');
    expect(buildV2Phase0Corpus('standard-50').designerText).toBe(standard50.designerText);
  });

  it('runs every corpus through the documented DPI matrix with frozen budgets', async () => {
    const report = await runV2Phase0PerformanceSpike({
      capture: () => ({ samplesMs: [80, 90, 100] }),
      preview: () => ({ samplesMs: [4, 8, 12] }),
      commit: ({ corpus }) => ({ samplesMs: [corpus.id === 'standard-50' ? 40 : 120] }),
      reconciliation: () => ({ samplesMs: [20, 25, 30] }),
    });

    assertV2Phase0PerformanceReport(report);
    expect(report.status).toBe('NOT_EXECUTED');
    expect(report.executionMode).toBe('synthetic-harness');
    expect(report.dpiLegs.map((leg) => `${leg.percent}:${leg.captureScale}`)).toEqual([
      '100:1',
      '125:2',
      '150:2',
      '200:2',
    ]);
    expect(report.measurements).toHaveLength(3 * V2_PHASE0_DPI_LEGS.length);
    expect(report.notExecutedDimensions.map((dimension) => `${dimension.id}:${dimension.status}`)).toEqual([
      'physical-dpi-hardware:NOT_EXECUTED',
      'visual-studio-pixel-reference:NOT_EXECUTED',
      'licensed-vendor-corpus:NOT_EXECUTED',
    ]);
    expect(report.measurements.every((measurement) => measurement.physicalDpiEvidenceStatus === 'NOT_EXECUTED')).toBe(true);
  });

  it('fails validation when a corpus or DPI leg is missing', async () => {
    const report = await runV2Phase0PerformanceSpike({
      capture: () => ({ durationMs: 10 }),
      preview: () => ({ durationMs: 1 }),
      commit: () => ({ durationMs: 10 }),
      reconciliation: () => ({ durationMs: 10 }),
    });
    const broken: V2Phase0PerformanceReport = {
      ...report,
      measurements: report.measurements.filter((measurement) =>
        !(measurement.corpusId === 'standard-300' && measurement.dpiLegId === 'dpi-150')),
    };

    expect(validateV2Phase0PerformanceReport(broken)).toEqual({
      status: 'FAIL',
      failures: ['missing measurement standard-300/dpi-150'],
    });
    expect(() => assertV2Phase0PerformanceReport(broken)).toThrow(/missing measurement standard-300\/dpi-150/);
  });

  it('fails validation on out-of-budget phase and interactive totals', async () => {
    const report = await runV2Phase0PerformanceSpike({
      capture: ({ corpus }) => ({ durationMs: corpus.id === 'standard-300' ? 4_900 : 100 }),
      preview: () => ({ durationMs: 16 }),
      commit: ({ corpus }) => ({ durationMs: corpus.id === 'standard-300' ? 260 : 40 }),
      reconciliation: () => ({ durationMs: 40 }),
    });

    const validation = validateV2Phase0PerformanceReport(report);
    expect(validation.status).toBe('FAIL');
    expect(validation.failures).toContain('standard-300/dpi-100/commit p95 260ms > 250ms');
    expect(validation.failures).toContain('standard-300/dpi-100 interactive conservative bound 5216ms > 5000ms');
  });

  it('allows PASS only for Extension Host-attributed product telemetry', async () => {
    const runners = {
      model: () => ({ durationMs: 10 }),
      capture: () => ({ durationMs: 10 }),
      preview: () => ({ durationMs: 1 }),
      commit: () => ({ durationMs: 10 }),
      reconciliation: () => ({ durationMs: 10 }),
    };
    const synthetic = await runV2Phase0PerformanceSpike(runners);
    const evidence = {
      schemaVersion: '2.0.0-product-performance-evidence.1' as const,
      scenarioId: 'V2-FND-001-S122' as const,
      hostKind: 'vscode-extension-host' as const,
      hostVersion: '1.134.0',
      hostArchitecture: 'x64' as const,
      processId: 1234,
      observedAtUtc: '2026-08-22T00:00:00.000Z',
    };
    const productResult = () => ({ durationMs: 10, source: 'product-telemetry' as const });
    const productRunners = {
      model: productResult,
      capture: productResult,
      preview: productResult,
      commit: productResult,
      reconciliation: productResult,
    };
    const real = await runV2Phase0PerformanceSpike(productRunners, {
      executionMode: 'real-product-path',
      productRunEvidence: evidence,
    });

    expect(synthetic.status).toBe('NOT_EXECUTED');
    expect(validateV2Phase0PerformanceReport(synthetic).status).toBe('NOT_EXECUTED');
    expect(real.status).toBe('PASS');
    expect(validateV2Phase0PerformanceReport(real).status).toBe('PASS');
    await expect(runV2Phase0PerformanceSpike(productRunners, {
      executionMode: 'real-product-path',
    })).rejects.toThrow('product-run evidence');
    await expect(runV2Phase0PerformanceSpike({
      capture: runners.capture,
      preview: runners.preview,
      commit: runners.commit,
      reconciliation: runners.reconciliation,
    }, { executionMode: 'real-product-path', productRunEvidence: evidence })).rejects.toThrow('explicit model runner');
  });

  it('keeps Phase 0 honest about physical DPI and licensed vendor evidence', async () => {
    const report = await runV2Phase0PerformanceSpike({
      capture: () => ({ durationMs: 10 }),
      preview: () => ({ durationMs: 1 }),
      commit: () => ({ durationMs: 10 }),
      reconciliation: () => ({ durationMs: 10 }),
    });
    const claimedPhysicalRun = {
      ...report,
      measurements: report.measurements.map((measurement) => ({
        ...measurement,
        physicalDpiEvidenceStatus: measurement.corpusId === 'vendor-heavy' && measurement.dpiLegId === 'dpi-100'
          ? 'PASS' as 'NOT_EXECUTED'
          : measurement.physicalDpiEvidenceStatus,
      })),
    };
    const missingVendorGate = {
      ...report,
      notExecutedDimensions: report.notExecutedDimensions.filter((dimension) => dimension.id !== 'licensed-vendor-corpus'),
    };

    expect(validateV2Phase0PerformanceReport(claimedPhysicalRun).failures).toEqual([
      'vendor-heavy/dpi-100 physical DPI evidence must be NOT_EXECUTED',
    ]);
    expect(validateV2Phase0PerformanceReport(missingVendorGate).failures).toEqual([
      'missing NOT_EXECUTED dimension licensed-vendor-corpus',
    ]);
  });
});
