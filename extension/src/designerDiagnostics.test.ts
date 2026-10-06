import { describe, expect, test } from 'vitest';
import { categorizeUnrepresentable } from './renderDiagnostics';
import {
  buildDesignerDiagnosticBundle, createDesignerDiagnostic, diagnosticsFromRenderItems,
  DESIGNER_DIAGNOSTIC_REASONS, DesignerDiagnosticSnapshot, engineInstallationDiagnosticCode,
} from './designerDiagnostics';

const sample: DesignerDiagnosticSnapshot = {
  generatedAt: '2026-09-22T12:34:56.000Z', correlationId: 'ba7adc0e-d4d6-450b-92ed-80a7b0fa9061',
  versions: { extension: '2.1.0', vscode: '1.110.3', node: '22.10.0' },
  platform: 'win32', architecture: 'x64', workspaceTrusted: true,
  engines: [{ kind: 'modern', running: true, starts: 2, recentCrashes: 1, lastStartupMs: 120.5, lastExitCode: null }],
  session: { engineKind: 'modern', renderOk: false, dirty: true, revision: 7, controlCount: 30, componentCount: 34, representable: 90, totalStatements: 91, roundTripSafe: false },
  capabilities: { engine: 'modern-interpreted', runtime: '.NET 9.0.9', render: true, edit: true, livePreviewUnsavedEdits: true },
  timings: { captureMs: 100, modelMs: 5, previewMs: 3.2, totalMeasuredMs: 108.2 },
  diagnostics: [createDesignerDiagnostic('MISSING_TYPE', { target: 'this.widget1', control: 'widget1', property: 'Text', assembly: 'Acme.Widgets.dll' })],
};

describe('designer reason catalogue', () => {
  test('incompatible installations offer repair instructions without an ineffective automatic restart', () => {
    for (const code of ['ENGINE_PROTOCOL_PARTIAL_UPDATE', 'ENGINE_PAYLOAD_UNAVAILABLE', 'MISSING_ENGINE_PAYLOAD',
      'BUILD_ID_MISMATCH', 'PROTOCOL_VERSION_UNSUPPORTED', 'UNKNOWN_REQUIRED_CAPABILITY', 'PROTOCOL_NOT_NEGOTIATED']) {
      const diagnostic = createDesignerDiagnostic(engineInstallationDiagnosticCode({ code, message: 'PRIVATE_EXCEPTION_VALUE' }));
      expect(diagnostic.code).toBe('ENGINE_INSTALLATION_INCOMPATIBLE');
      expect(diagnostic.message).toContain('Reinstall');
      expect(diagnostic.message).toContain('Reload Window');
      // An executable repair that is not a restart: it opens the extension so the payload can be reinstalled.
      expect(diagnostic.actions).toEqual(['reinstall']);
      expect(diagnostic.message).not.toContain('PRIVATE_EXCEPTION_VALUE');
    }
    expect(engineInstallationDiagnosticCode({ code: 'WORKER_CRASH_LOOP' })).toBe('ENGINE_UNAVAILABLE');
    expect(engineInstallationDiagnosticCode(null)).toBe('ENGINE_UNAVAILABLE');
  });

  test('distinguishes missing type, failed initialization and unsupported source without copying exception detail', () => {
    const raw = [
      'this.widget1 = new Acme.Widget(); [TypeLoadException: unresolved type Acme.Widget]',
      'this.label1.Text = "PRIVATE_PROPERTY_VALUE"; [InvalidOperationException: Password=PRIVATE_EXCEPTION_VALUE]',
      'this.panel1.Layout += DoCustomLayout;',
    ];
    const reasons = diagnosticsFromRenderItems(categorizeUnrepresentable(raw));
    expect(reasons.map((reason) => reason.code)).toEqual(['MISSING_TYPE', 'CONTROL_INITIALIZATION_FAILED', 'UNSUPPORTED_CONSTRUCT']);
    expect(reasons[0]).toMatchObject({ target: 'this.widget1', control: 'widget1', actions: ['rebuild', 'chooseAssembly', 'viewCode'] });
    expect(reasons[1].actions).toContain('retry');
    expect(reasons[2].actions).toEqual(['viewCode']);
    expect(JSON.stringify(reasons)).not.toMatch(/PRIVATE_|new Acme|DoCustomLayout/);
  });

  test('unknown and prototype-key codes get a conservative inspection action', () => {
    for (const code of ['FUTURE_NEW_REFUSAL', '__proto__', 'constructor', { toString: () => 'MISSING_TYPE' }, null]) {
      expect(createDesignerDiagnostic(code)).toMatchObject({ code: 'UNKNOWN_REASON', severity: 'warning', actions: ['viewCode'] });
    }
    expect(createDesignerDiagnostic('ENGINE_CRASH_LOOP').actions).toEqual(['viewCode', 'restart']);
    expect(createDesignerDiagnostic('CACHE_CORRUPT').actions).toEqual(['clearCache']);
    expect(createDesignerDiagnostic('COM_ACTIVEX_UNSUPPORTED').actions).toEqual(['viewCode']);
  });

  test('offers cache rebuilding only for a disposable cache failure, never for retained preferences', () => {
    const cache = createDesignerDiagnostic('CACHE_WRITE_FAILED');
    expect(cache).toMatchObject({ code: 'CACHE_WRITE_FAILED', severity: 'warning', actions: ['clearCache'] });
    const retained = ['STATE_MIGRATION_FAILED', 'PERSISTED_STATE_INVALID'].map(code => createDesignerDiagnostic(code));
    for (const [index, reason] of retained.entries()) {
      expect(reason.code).toBe(index === 0 ? 'STATE_MIGRATION_FAILED' : 'PERSISTED_STATE_INVALID');
      expect(reason.severity).toBe('warning');
      expect(reason.actions).toEqual([]);
    }
    // Export must not turn a retained user preference problem into a cache-clear or worker-restart action.
    const forged = retained.map(reason => ({ ...reason, actions: ['clearCache', 'restart'] as const }));
    expect(buildDesignerDiagnosticBundle({ diagnostics: [cache, ...forged] }).bundle.diagnostics.map(reason => reason.actions))
      .toEqual([['clearCache'], [], []]);
  });

  test('only permits the documented recovery action identifiers and refuses path/statement context', () => {
    const allowed = new Set(['retry', 'rebuild', 'chooseAssembly', 'viewCode', 'clearCache', 'restart', 'reinstall']);
    for (const reason of Object.values(DESIGNER_DIAGNOSTIC_REASONS)) {
      expect(reason.actions.every((action) => allowed.has(action))).toBe(true);
    }
    const reason = createDesignerDiagnostic('MISSING_TYPE', {
      target: 'this.control.Text = "SECRET";', control: 'C:\\Users\\private\\Control.cs',
      property: 'Password=SECRET', assembly: '\\\\private-server\\share\\secret.dll',
    });
    expect(reason.target).toBeUndefined();
    expect(reason.control).toBeUndefined();
    expect(reason.property).toBeUndefined();
    expect(reason.assembly).toBeUndefined();
  });
});

describe('structured designer diagnostic bundle', () => {
  test('exports measured facts, canonical reasons and correlation without mutating the live snapshot', () => {
    const before = JSON.stringify(sample);
    const result = buildDesignerDiagnosticBundle(sample);
    expect(JSON.parse(result.json)).toEqual(JSON.parse(JSON.stringify(result.bundle)));
    expect(result.byteLength).toBe(Buffer.byteLength(result.json, 'utf8'));
    expect(result.bundle).toMatchObject({
      schemaVersion: 1, correlationId: sample.correlationId, versions: sample.versions,
      environment: { platform: 'win32', architecture: 'x64', workspaceTrusted: true },
      engines: sample.engines, session: sample.session, capabilities: sample.capabilities, timings: sample.timings,
      truncation: { truncated: false, omittedDiagnostics: 0, omittedSections: 0, invalidFields: 0 },
      privacy: { sourceIncluded: false, propertyValuesIncluded: false, rawErrorsIncluded: false, pathsIncluded: false },
    });
    expect(result.bundle.diagnostics[0]).toMatchObject({ code: 'MISSING_TYPE', target: 'target-1', control: 'control-2', property: 'property-3', assembly: 'assembly-4' });
    expect(result.json).not.toMatch(/widget1|Acme.Widgets|"Text"/);
    expect(JSON.stringify(sample)).toBe(before);
  });

  test('real generator excludes adversarial values from every untrusted object branch, not just familiar path shapes', () => {
    const canaries = [
      'PRIVATE_SOURCE_CANARY', 'PRIVATE_PROPERTY_CANARY', 'PRIVATE_EXCEPTION_CANARY', 'PRIVATE_TOKEN_CANARY',
      'PRIVATE_CONNECTION_CANARY', 'PRIVATE_WINDOWS_CANARY', 'PRIVATE_UNC_CANARY', 'PRIVATE_USER_CANARY',
      'PRIVATE_IDENTITY_CANARY', 'PRIVATE-PRERELEASE-CANARY',
    ];
    const injected = {
      ...sample,
      source: `this.label.Text = "${canaries[0]}";`, propertyValues: { Text: canaries[1] },
      error: new Error(canaries[2]), token: canaries[3], connectionString: `Server=host;Password=${canaries[4]}`,
      file: `D:\\clients\\${canaries[5]}\\Form.Designer.cs`, assemblyPath: `\\\\server\\${canaries[6]}\\Library.dll`,
      settings: { userPath: `C:\\Users\\${canaries[7]}\\.config` },
      versions: { extension: `2.1.0-${canaries[9]}`, vscode: '1.110.3', node: '22.10.0', secret: canaries[3] },
      engines: [{ ...sample.engines![0], details: canaries[2], entryPoint: canaries[5] }],
      session: { ...sample.session, designerText: canaries[0], propertyValue: canaries[1], connectionString: canaries[4] },
      capabilities: { ...sample.capabilities, notes: canaries[2], runtime: canaries[7] },
      timings: { ...sample.timings, [canaries[3]]: 10 },
      diagnostics: [{
        code: 'MISSING_TYPE', severity: 'info', message: canaries[2], actions: [canaries[3]],
        target: canaries[8], control: canaries[1], property: canaries[4], assembly: canaries[5],
        text: canaries[0], detail: canaries[2], value: canaries[1],
      }],
    } as unknown as DesignerDiagnosticSnapshot;
    const result = buildDesignerDiagnosticBundle(injected);
    for (const canary of canaries) expect(result.json).not.toContain(canary);
    expect(result.bundle.diagnostics[0]).toMatchObject({ code: 'MISSING_TYPE', severity: 'error', actions: ['rebuild', 'chooseAssembly', 'viewCode'] });
    expect(result.bundle.versions?.extension).toBe('2.1.0');
  });

  test('rejects private paths, connection strings, credentials and nonfinite numbers injected into allowed scalar fields', () => {
    const malicious = {
      ...sample, generatedAt: 'C:\\Users\\private\\file', correlationId: 'Bearer PRIVATE_CORRELATION',
      platform: '\\\\server\\PRIVATE_PLATFORM', architecture: 'Password=PRIVATE_ARCH', workspaceTrusted: 'PRIVATE_BOOLEAN',
      versions: { extension: 'token=PRIVATE_VERSION', vscode: 'https://user:PRIVATE_URL@example.org', node: '/home/PRIVATE_USER' },
      session: { engineKind: 'PRIVATE_ENGINE', net48RenderMode: 'PRIVATE_MODE', renderOk: 'PRIVATE_RENDER', revision: Infinity, controlCount: -4 },
      capabilities: { engine: 'Password=PRIVATE_CAPABILITY', edit: 'PRIVATE_EDIT', livePreviewUnsavedEdits: 'PRIVATE_PREVIEW' },
      timings: { captureMs: NaN, modelMs: -1, plannerMs: 'PRIVATE_TIMING' },
    } as unknown as DesignerDiagnosticSnapshot;
    const result = buildDesignerDiagnosticBundle(malicious);
    expect(result.json).not.toMatch(/PRIVATE_|Users|Bearer|Password|example.org|Infinity|NaN/);
    expect(result.bundle.truncation.invalidFields).toBeGreaterThanOrEqual(15);
    expect(result.bundle.session?.revision).toBeUndefined();
    expect(result.bundle.timings).toEqual({});
  });

  test('retains pseudonym equality within a bundle without serializing even valid identifier secrets', () => {
    const diagnostic = createDesignerDiagnostic('MISSING_TYPE', { control: 'PlainAlphanumericSecret123', assembly: 'PlainAlphanumericSecret123' });
    const result = buildDesignerDiagnosticBundle({ diagnostics: [diagnostic, diagnostic] });
    expect(result.bundle.diagnostics[0].control).toBe(result.bundle.diagnostics[1].control);
    expect(result.bundle.diagnostics[0].control).not.toBe(result.bundle.diagnostics[0].assembly);
    expect(result.json).not.toContain('PlainAlphanumericSecret123');
  });

  test('enforces diagnostic count and byte limits with valid complete JSON and exact omission counts', () => {
    const diagnostics = Array.from({ length: 400 }, (_, i) => createDesignerDiagnostic('MISSING_TYPE', { target: `this.control${i}`, assembly: `Assembly${i}` }));
    const countBounded = buildDesignerDiagnosticBundle({ ...sample, diagnostics }, { maxDiagnostics: 3 });
    expect(countBounded.bundle.diagnostics).toHaveLength(3);
    expect(countBounded.bundle.truncation).toMatchObject({ truncated: true, omittedDiagnostics: 397 });
    for (const maxBytes of [1024, 1400, 2048, 4096, 65536]) {
      const result = buildDesignerDiagnosticBundle({ ...sample, diagnostics }, { maxBytes });
      expect(result.byteLength).toBeLessThanOrEqual(maxBytes);
      expect(() => JSON.parse(result.json)).not.toThrow();
      expect(result.bundle.truncation.omittedDiagnostics + result.bundle.diagnostics.length).toBe(400);
      expect(result.bundle.truncation.truncated).toBe(true);
    }
  });

  test('does not serialize toJSON hooks attached to live source objects and rejects malformed entries', () => {
    let hookCalled = false;
    const hook = () => { hookCalled = true; return 'PRIVATE_TO_JSON'; };
    const snapshot = { ...sample, toJSON: hook,
      session: { ...sample.session, toJSON: hook },
      diagnostics: [null, { code: 'MISSING_TYPE', toJSON: hook }, { code: '__proto__', message: 'PRIVATE_ERROR', toJSON: hook }],
      engines: [null, { kind: 'modern', starts: -1, toJSON: hook }],
    } as unknown as DesignerDiagnosticSnapshot;
    const result = buildDesignerDiagnosticBundle(snapshot);
    expect(hookCalled).toBe(false);
    expect(result.json).not.toContain('PRIVATE_');
    expect(result.bundle.truncation.omittedDiagnostics).toBe(1);
    expect(result.bundle.diagnostics[1].code).toBe('UNKNOWN_REASON');
  });

  test('rejects nonsensical limits instead of silently exceeding caller budget', () => {
    for (const maxBytes of [0, 100, 1023, 65537, NaN, Infinity, 1200.5])
      expect(() => buildDesignerDiagnosticBundle(sample, { maxBytes })).toThrow(RangeError);
    for (const maxDiagnostics of [-1, 101, 0.1, Infinity])
      expect(() => buildDesignerDiagnosticBundle(sample, { maxDiagnostics })).toThrow(RangeError);
    expect(buildDesignerDiagnosticBundle(sample, { maxDiagnostics: 0 }).bundle.truncation.omittedDiagnostics).toBe(1);
  });
});
