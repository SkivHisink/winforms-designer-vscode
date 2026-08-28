import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  V2_ADAPTER_MANIFEST_CAPABILITIES,
  V2_ADAPTER_MANIFEST_DEFAULT_MAX_PATH_LENGTH,
  V2AdapterManifest,
  evaluateV2AdapterManifest,
  validateV2AdapterManifestJson,
} from './v2AdapterManifest';
import { V2_PROTOCOL_CURRENT_VERSION, V2_PROTOCOL_ID, V2_PROTOCOL_MINIMUM_SUPPORTED_VERSION } from './v2Protocol';

function manifest(overrides: Partial<V2AdapterManifest> = {}): V2AdapterManifest {
  const base: V2AdapterManifest = {
    schemaId: 'winforms-designer.v2.adapter-manifest',
    schemaVersion: 1,
    adapter: {
      id: 'acme.winforms.adapter',
      version: '2.0.0',
      displayName: 'Acme WinForms Adapter',
      publisher: {
        id: 'acme',
        displayName: 'Acme',
      },
    },
    protocol: {
      id: V2_PROTOCOL_ID,
      supportedVersions: [V2_PROTOCOL_MINIMUM_SUPPORTED_VERSION, V2_PROTOCOL_CURRENT_VERSION],
      requiredCapabilities: ['protocol.envelope-v2', 'protocol.n-minus-one'],
    },
    compatibility: {
      productId: 'winforms-designer-vscode',
      cohorts: [{
        productId: 'winforms-designer-vscode',
        minProductVersion: '2.0.0',
        maxProductVersionExclusive: '3.0.0',
        runtimes: ['modern', 'net48'],
        architectures: ['x64', 'arm64'],
      }],
    },
    capabilities: [...V2_ADAPTER_MANIFEST_CAPABILITIES],
    trust: {
      signature: 'signed-vendor',
      workspaceTrust: 'trusted',
      loadVendorCode: true,
      mutationAuthority: 'sourceFirst',
    },
    bounds: {
      maxPayloadBytes: 65536,
      maxPathLength: V2_ADAPTER_MANIFEST_DEFAULT_MAX_PATH_LENGTH,
      allowAbsolutePaths: false,
      allowParentDirectoryTraversal: false,
    },
    unsupportedFeatures: ['vs-designer-sdk-rehost', 'vendor-smart-tag-actions', 'com-activex', 'x86-worker'],
    diagnostics: {
      format: 'v2-adapter-diagnostics',
      deterministic: true,
    },
  };
  return {
    ...base,
    ...overrides,
  };
}

describe('v2 adapter manifest', () => {
  it('accepts the committed sample manifest with machine-readable diagnostics', () => {
    const samplePath = path.resolve(process.cwd(), '..', 'docs', 'v2', 'adapter-manifest.sample.json');
    const result = validateV2AdapterManifestJson(fs.readFileSync(samplePath, 'utf8'), {
      requiredCapabilities: ['adapter.manifest-v1', 'diagnostics.machine-readable'],
      productVersion: '2.0.0',
      runtime: 'modern',
      architecture: 'x64',
      payloadBytes: 1024,
      paths: ['controls/FancyButton.cs', 'resources/FancyButton.resx'],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.diagnostics).toEqual([]);
      expect(result.manifest.protocol.supportedVersions).toContain(V2_PROTOCOL_CURRENT_VERSION);
      expect(result.manifest.protocol.supportedVersions).toContain(V2_PROTOCOL_CURRENT_VERSION - 1);
      expect(result.manifestDeclaresVendorCodeLoad).toBe(false);
      expect(result.manifestDeclaresWorkspaceMutation).toBe(true);
    }
  });

  it('rejects unknown fields and unsupported protocol versions with deterministic codes', () => {
    const candidate = {
      ...manifest(),
      protocol: {
        id: V2_PROTOCOL_ID,
        supportedVersions: [V2_PROTOCOL_CURRENT_VERSION + 1],
        requiredCapabilities: ['protocol.envelope-v2'],
      },
      extra: true,
    };

    const result = evaluateV2AdapterManifest(candidate);

    expect(result.ok).toBe(false);
    expect(result.manifestDeclaresVendorCodeLoad).toBe(false);
    expect(result.manifestDeclaresWorkspaceMutation).toBe(false);
    expect(result.diagnostics.map((item) => `${item.path}:${item.code}`)).toEqual([
      '$.extra:ADAPTER_MANIFEST_UNKNOWN_FIELD',
      '$.protocol.supportedVersions:ADAPTER_PROTOCOL_UNSUPPORTED',
    ]);
  });

  it('requires protocol N/N-1 compatibility', () => {
    const result = evaluateV2AdapterManifest(manifest({
      protocol: {
        id: V2_PROTOCOL_ID,
        supportedVersions: [V2_PROTOCOL_CURRENT_VERSION],
        requiredCapabilities: ['protocol.envelope-v2'],
      },
    }));

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'ADAPTER_PROTOCOL_UNSUPPORTED',
      path: '$.protocol.supportedVersions',
    }));
  });

  it('fails closed for undeclared capabilities without granting vendor code load', () => {
    const result = evaluateV2AdapterManifest(manifest({
      capabilities: ['adapter.manifest-v1', 'adapter.compatibility-v1', 'diagnostics.machine-readable'],
    }), {
      requiredCapabilities: ['property-grid.metadata'],
      mayLoadVendorCode: true,
    });

    expect(result.ok).toBe(false);
    expect(result.manifestDeclaresVendorCodeLoad).toBe(false);
    expect(result.manifestDeclaresWorkspaceMutation).toBe(false);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'ADAPTER_CAPABILITY_UNDECLARED',
      path: '$.capabilities',
    }));
  });

  it('refuses unsupported product runtime architecture cohorts', () => {
    const result = evaluateV2AdapterManifest(manifest(), {
      productVersion: '2.0.0',
      runtime: 'net48',
      architecture: 'arm64',
    });

    expect(result.ok).toBe(true);

    const unsupported = evaluateV2AdapterManifest(manifest(), {
      productVersion: '3.0.0',
      runtime: 'modern',
      architecture: 'x64',
    });

    expect(unsupported.ok).toBe(false);
    expect(unsupported.diagnostics).toContainEqual(expect.objectContaining({
      code: 'ADAPTER_COHORT_UNSUPPORTED',
    }));
  });

  it('enforces payload and path bounds before any adapter can run', () => {
    const result = evaluateV2AdapterManifest(manifest(), {
      payloadBytes: 65537,
      paths: ['..\\escape.cs', 'C:\\repo\\absolute.cs'],
      mayLoadVendorCode: true,
    });

    expect(result.ok).toBe(false);
    expect(result.manifestDeclaresVendorCodeLoad).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toEqual([
      'ADAPTER_PAYLOAD_TOO_LARGE',
      'ADAPTER_PATH_OUT_OF_BOUNDS',
      'ADAPTER_PATH_OUT_OF_BOUNDS',
    ]);
    expect(JSON.stringify(result.diagnostics)).not.toContain('escape.cs');
    expect(JSON.stringify(result.diagnostics)).not.toContain('C:\\repo');
  });

  it('rejects drive-relative, alternate-stream, and ambiguous relative path forms', () => {
    const result = evaluateV2AdapterManifest(manifest(), {
      paths: ['C:relative.cs', 'controls/Foo.cs:Zone.Identifier', './controls/Foo.cs', 'controls//Foo.cs'],
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toEqual([
      'ADAPTER_PATH_OUT_OF_BOUNDS',
      'ADAPTER_PATH_OUT_OF_BOUNDS',
      'ADAPTER_PATH_OUT_OF_BOUNDS',
      'ADAPTER_PATH_OUT_OF_BOUNDS',
    ]);
    expect(JSON.stringify(result.diagnostics)).not.toContain('relative.cs');
    expect(JSON.stringify(result.diagnostics)).not.toContain('Zone.Identifier');
  });

  it('requires signed-vendor trust before a manifest may declare vendor code loading', () => {
    const result = evaluateV2AdapterManifest(manifest({
      trust: {
        signature: 'unsigned-local',
        workspaceTrust: 'trusted',
        loadVendorCode: true,
        mutationAuthority: 'sourceFirst',
      },
    }), { mayLoadVendorCode: true });

    expect(result.ok).toBe(false);
    expect(result.manifestDeclaresVendorCodeLoad).toBe(false);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'ADAPTER_VENDOR_CODE_LOAD_DENIED',
      path: '$.trust',
    }));
  });
});
