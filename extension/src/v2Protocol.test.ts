import { describe, expect, test } from 'vitest';
import {
  V2_PROTOCOL_CAPABILITIES,
  V2_PROTOCOL_CURRENT_VERSION,
  V2_PROTOCOL_MAX_PAYLOAD_BYTES,
  V2_PROTOCOL_MINIMUM_SUPPORTED_VERSION,
  V2ProtocolEnvelope,
  createV2Fingerprint,
  createV2ProtocolEnvelope,
  makeV2ProtocolRefusal,
  validateV2ProtocolEnvelope,
  validateV2ProtocolOutcome,
} from './v2Protocol';

const sourceHash = 'a'.repeat(64);
const resourceHash = 'b'.repeat(64);

function envelope(overrides: Partial<V2ProtocolEnvelope> = {}): V2ProtocolEnvelope {
  return {
    ...createV2ProtocolEnvelope({
      messageKind: 'request',
      buildId: 'build-2.0.0',
      sessionId: 'session-1',
      documentId: 'document-1',
      requestId: 'request-1',
      traceId: 'trace-1',
      commandId: 'command-1',
      documentRevision: 'revision-7',
      renderGeneration: 12,
      sourceFingerprint: createV2Fingerprint('source', sourceHash, 42),
      resourceFingerprints: [createV2Fingerprint('resource.resx', resourceHash, 9)],
      deadlineUnixMilliseconds: 4_102_444_800_000,
      cancellationToken: 'cancel-1',
      capabilities: [...V2_PROTOCOL_CAPABILITIES],
      requiredCapabilities: ['protocol.envelope-v2', 'payload.byte-limit'],
      payloadJson: '{"operation":"describe"}',
    }),
    ...overrides,
  };
}

describe('v2 protocol envelope', () => {
  test('accepts a strict current-version envelope with source and resource fingerprints', () => {
    const result = validateV2ProtocolEnvelope(envelope());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.envelope.sourceFingerprint.value).toBe(sourceHash);
      expect(result.envelope.sourceFingerprint.artifactId).toBe('source');
      expect(result.envelope.resourceFingerprints[0].value).toBe(resourceHash);
      expect(result.envelope.resourceFingerprints[0].artifactId).toBe('resource.resx');
      expect(result.envelope.documentRevision).toBe('revision-7');
      expect(result.envelope.renderGeneration).toBe(12);
    }
  });

  test('accepts N-1 and refuses N+1 with a structured protocol-version outcome', () => {
    expect(validateV2ProtocolEnvelope(envelope({ protocolVersion: V2_PROTOCOL_MINIMUM_SUPPORTED_VERSION })).ok)
      .toBe(true);

    const result = validateV2ProtocolEnvelope(envelope({ protocolVersion: V2_PROTOCOL_CURRENT_VERSION + 1 }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.outcome).toMatchObject({
        kind: 'refused',
        code: 'PROTOCOL_VERSION_UNSUPPORTED',
        requestId: 'request-1',
        traceId: 'trace-1',
      });
    }
  });

  test('allows optional future capabilities but refuses unknown required capabilities', () => {
    expect(validateV2ProtocolEnvelope(envelope({
      capabilities: [...V2_PROTOCOL_CAPABILITIES, 'future.optional'],
    })).ok).toBe(true);

    const result = validateV2ProtocolEnvelope(envelope({
      requiredCapabilities: ['protocol.envelope-v2', 'future.required'],
    }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.outcome.code).toBe('UNKNOWN_REQUIRED_CAPABILITY');
      expect(result.outcome.message).toContain('future.required');
    }
  });

  test('keeps the envelope closed and rejects payload byte drift', () => {
    const withExtraField = { ...envelope(), forged: true };
    const extraResult = validateV2ProtocolEnvelope(withExtraField);
    expect(extraResult.ok).toBe(false);
    if (!extraResult.ok) {
      expect(extraResult.outcome.code).toBe('INVALID_ENVELOPE');
    }

    const byteDrift = envelope();
    byteDrift.payloadBytes += 1;
    const driftResult = validateV2ProtocolEnvelope(byteDrift);
    expect(driftResult.ok).toBe(false);
    if (!driftResult.ok) {
      expect(driftResult.outcome.code).toBe('INVALID_ENVELOPE');
    }
  });

  test('rejects ambiguous fingerprints and invalid revision or generation identity', () => {
    const duplicateArtifact = validateV2ProtocolEnvelope(envelope({
      resourceFingerprints: [
        createV2Fingerprint('resource.resx', resourceHash, 9),
        createV2Fingerprint('resource.resx', 'c'.repeat(64), 10),
      ],
    }));
    expect(duplicateArtifact.ok).toBe(false);

    expect(validateV2ProtocolEnvelope(envelope({ documentRevision: '' })).ok).toBe(false);
    expect(validateV2ProtocolEnvelope(envelope({ renderGeneration: -1 })).ok).toBe(false);
    expect(validateV2ProtocolEnvelope(envelope({ commandId: '' })).ok).toBe(false);
  });

  test('refuses payloads over the v2 byte limit', () => {
    const payloadJson = JSON.stringify({ body: 'x'.repeat(V2_PROTOCOL_MAX_PAYLOAD_BYTES) });
    const result = validateV2ProtocolEnvelope(envelope({
      payloadJson,
      payloadBytes: Buffer.byteLength(payloadJson, 'utf8'),
    }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.outcome.code).toBe('PAYLOAD_TOO_LARGE');
    }
  });
});

describe('v2 protocol outcomes', () => {
  test('accepts structured refusal outcomes and rejects mismatched kind/code pairs', () => {
    expect(validateV2ProtocolOutcome(
      makeV2ProtocolRefusal('request-1', 'trace-1', 'UNKNOWN_REQUIRED_CAPABILITY', 'capability is unsupported'),
    )).toBe(true);

    expect(validateV2ProtocolOutcome({
      kind: 'ok',
      requestId: 'request-1',
      traceId: 'trace-1',
      code: 'INTERNAL_ERROR',
      message: 'not ok',
      retryable: false,
      diagnosticId: 'INTERNAL_ERROR',
    })).toBe(false);
  });

  test('rejects outcome objects with unknown top-level fields', () => {
    expect(validateV2ProtocolOutcome({
      ...makeV2ProtocolRefusal('request-1', 'trace-1', 'INVALID_ENVELOPE', 'bad envelope'),
      stack: 'hidden',
    })).toBe(false);
  });

  test('supports the declared partial and unsupported outcome buckets', () => {
    expect(validateV2ProtocolOutcome({
      kind: 'partial', requestId: 'request-1', traceId: 'trace-1', code: 'PARTIAL_RESULT',
      message: 'bounded result', retryable: true, diagnosticId: 'PARTIAL_RESULT',
    })).toBe(true);
    expect(validateV2ProtocolOutcome({
      kind: 'unsupported', requestId: 'request-1', traceId: 'trace-1', code: 'UNSUPPORTED_OPERATION',
      message: 'not advertised', retryable: false, diagnosticId: 'UNSUPPORTED_OPERATION',
    })).toBe(true);
  });
});
