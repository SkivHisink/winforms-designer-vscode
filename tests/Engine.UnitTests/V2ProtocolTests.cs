using System;
using System.Linq;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using Newtonsoft.Json.Serialization;
using WinFormsDesigner.Engine;

namespace Engine.UnitTests;

public sealed class V2ProtocolTests
{
    private const string SourceHash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string ResourceHash = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    [Fact]
    public void CurrentEnvelope_WithFingerprintsAndRequiredCapabilities_Passes()
    {
        var result = V2Protocol.ValidateEnvelope(Envelope());

        Assert.True(result.Ok, result.Outcome?.Message);
        Assert.Equal(SourceHash, result.Envelope.SourceFingerprint.Value);
        Assert.Equal("source", result.Envelope.SourceFingerprint.ArtifactId);
        Assert.Equal("resource.resx", Assert.Single(result.Envelope.ResourceFingerprints).ArtifactId);
        Assert.Equal(ResourceHash, result.Envelope.ResourceFingerprints[0].Value);
        Assert.Equal("revision-7", result.Envelope.DocumentRevision);
        Assert.Equal(12, result.Envelope.RenderGeneration);
    }

    [Fact]
    public void NMinusOneVersion_Passes_AndFutureVersionIsRefused()
    {
        Assert.True(V2Protocol.ValidateEnvelope(Envelope(protocolVersion: V2Protocol.MinimumSupportedVersion)).Ok);

        var result = V2Protocol.ValidateEnvelope(Envelope(protocolVersion: V2Protocol.CurrentVersion + 1));

        Assert.False(result.Ok);
        Assert.Equal("PROTOCOL_VERSION_UNSUPPORTED", result.Outcome.Code);
        Assert.Equal(V2ProtocolOutcomeKind.Refused, result.Outcome.Kind);
    }

    [Fact]
    public void OptionalFutureCapability_Passes_ButUnknownRequiredCapabilityIsRefused()
    {
        var optionalFuture = Envelope(capabilities: V2Protocol.Capabilities.Concat(new[] { "future.optional" }).ToArray());
        Assert.True(V2Protocol.ValidateEnvelope(optionalFuture).Ok);

        var requiredFuture = Envelope(requiredCapabilities: new[] { "protocol.envelope-v2", "future.required" });
        var result = V2Protocol.ValidateEnvelope(requiredFuture);

        Assert.False(result.Ok);
        Assert.Equal("UNKNOWN_REQUIRED_CAPABILITY", result.Outcome.Code);
        Assert.Contains("future.required", result.Outcome.Message);
    }

    [Fact]
    public void PayloadLimit_AndPayloadByteCount_AreEnforced()
    {
        var drift = Envelope();
        drift.PayloadBytes++;
        var driftResult = V2Protocol.ValidateEnvelope(drift);
        Assert.False(driftResult.Ok);
        Assert.Equal("INVALID_ENVELOPE", driftResult.Outcome.Code);

        var overLimitPayload = "\"" + new string('x', V2Protocol.MaxPayloadBytes) + "\"";
        var overLimit = Envelope(payloadJson: overLimitPayload);
        var limitResult = V2Protocol.ValidateEnvelope(overLimit);
        Assert.False(limitResult.Ok);
        Assert.Equal("PAYLOAD_TOO_LARGE", limitResult.Outcome.Code);

        var invalidJson = Envelope(payloadJson: "{not-json}");
        var invalidJsonResult = V2Protocol.ValidateEnvelope(invalidJson);
        Assert.False(invalidJsonResult.Ok);
        Assert.Equal("INVALID_ENVELOPE", invalidJsonResult.Outcome.Code);
    }

    [Fact]
    public void RawEnvelopeValidation_RejectsUnknownFields_AndFingerprintAmbiguity()
    {
        var serializer = JsonSerializer.Create(new JsonSerializerSettings
        {
            ContractResolver = new CamelCasePropertyNamesContractResolver(),
        });
        var json = JObject.FromObject(Envelope(), serializer);
        json["forged"] = true;
        var unknown = V2Protocol.ValidateEnvelopeJson(json.ToString(Formatting.None));
        Assert.False(unknown.Ok);
        Assert.Equal("INVALID_ENVELOPE", unknown.Outcome.Code);

        json.Remove("forged");
        json["messageKind"] = 0;
        var numericEnum = V2Protocol.ValidateEnvelopeJson(json.ToString(Formatting.None));
        Assert.False(numericEnum.Ok);
        Assert.Equal("INVALID_ENVELOPE", numericEnum.Outcome.Code);

        json["messageKind"] = "request";
        json["commandId"] = JValue.CreateNull();
        var nullOptionalIdentity = V2Protocol.ValidateEnvelopeJson(json.ToString(Formatting.None));
        Assert.False(nullOptionalIdentity.Ok);
        Assert.Equal("INVALID_ENVELOPE", nullOptionalIdentity.Outcome.Code);

        var duplicate = Envelope();
        duplicate.ResourceFingerprints.Add(V2Protocol.Fingerprint("resource.resx", ResourceHash, 9));
        var duplicateResult = V2Protocol.ValidateEnvelope(duplicate);
        Assert.False(duplicateResult.Ok);
        Assert.Equal("INVALID_ENVELOPE", duplicateResult.Outcome.Code);
    }

    [Fact]
    public void EngineApi_UsesTheStrictRawV2ValidationEntryPoint()
    {
        var serializer = JsonSerializer.Create(new JsonSerializerSettings
        {
            ContractResolver = new CamelCasePropertyNamesContractResolver(),
        });
        var json = JObject.FromObject(Envelope(), serializer);
        json["messageKind"] = "request";
        var api = new EngineApi(new StaDispatcher());

        Assert.True(api.ValidateV2Envelope(json.ToString(Formatting.None)).Ok);
        json["forged"] = true;
        var refused = api.ValidateV2Envelope(json.ToString(Formatting.None));
        Assert.False(refused.Ok);
        Assert.Equal("INVALID_ENVELOPE", refused.Outcome.Code);
    }

    [Fact]
    public void OutcomeValidation_RejectsMismatchedKindAndCode()
    {
        Assert.True(V2Protocol.ValidateOutcome(new V2ProtocolOutcome
        {
            Kind = V2ProtocolOutcomeKind.Stale,
            RequestId = "request-1",
            TraceId = "trace-1",
            Code = "STALE_SOURCE",
            Message = "source changed",
            Retryable = true,
            DiagnosticId = "STALE_SOURCE",
            ExpectedSourceFingerprint = V2Protocol.Fingerprint("source", SourceHash, 42),
            ActualSourceFingerprint = V2Protocol.Fingerprint("source", ResourceHash, 43),
        }));

        Assert.False(V2Protocol.ValidateOutcome(new V2ProtocolOutcome
        {
            Kind = V2ProtocolOutcomeKind.Ok,
            RequestId = "request-1",
            TraceId = "trace-1",
            Code = "INTERNAL_ERROR",
            Message = "wrong bucket",
            Retryable = false,
            DiagnosticId = "INTERNAL_ERROR",
        }));
    }

    private static V2ProtocolEnvelope Envelope(
        int? protocolVersion = null,
        string[]? capabilities = null,
        string[]? requiredCapabilities = null,
        string payloadJson = "{\"operation\":\"describe\"}")
    {
        return V2Protocol.CreateEnvelope(
            V2ProtocolMessageKind.Request,
            "build-2.0.0",
            "session-1",
            "document-1",
            "request-1",
            "trace-1",
            "command-1",
            "revision-7",
            12,
            V2Protocol.Fingerprint("source", SourceHash, 42),
            new[] { V2Protocol.Fingerprint("resource.resx", ResourceHash, 9) },
            4102444800000,
            "cancel-1",
            capabilities ?? V2Protocol.Capabilities,
            requiredCapabilities ?? new[] { "protocol.envelope-v2", "payload.byte-limit" },
            payloadJson,
            protocolVersion);
    }
}
