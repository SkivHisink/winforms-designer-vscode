using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using Xunit;

namespace Engine.Net48.UnitTests
{
    public sealed class V2ProtocolTests
    {
        private const string SourceHash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        private const string ResourceHash = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

        [Fact]
        public void Net48EngineAssembly_EnforcesNMinusOneAndUnknownRequiredCapability()
        {
            var api = Net48ProtocolApi.Load();

            Assert.True(api.Validate(api.Envelope(protocolVersion: api.MinimumSupportedVersion)).Ok);

            var futureVersion = api.Validate(api.Envelope(protocolVersion: api.CurrentVersion + 1));
            Assert.False(futureVersion.Ok);
            Assert.Equal("PROTOCOL_VERSION_UNSUPPORTED", futureVersion.Code);

            var unknownRequired = api.Validate(api.Envelope(requiredCapabilities: new[] { "protocol.envelope-v2", "future.required" }));
            Assert.False(unknownRequired.Ok);
            Assert.Equal("UNKNOWN_REQUIRED_CAPABILITY", unknownRequired.Code);
        }

        [Fact]
        public void Net48EngineAssembly_EnforcesPayloadBudgetAndOutcomeKindCodeMapping()
        {
            var api = Net48ProtocolApi.Load();

            var drift = api.Envelope();
            api.Set(drift, "PayloadBytes", (int)api.Get(drift, "PayloadBytes") + 1);
            var driftResult = api.Validate(drift);
            Assert.False(driftResult.Ok);
            Assert.Equal("INVALID_ENVELOPE", driftResult.Code);

            var stale = api.Outcome("Stale", "STALE_SOURCE", "source changed");
            Assert.True(api.ValidateOutcome(stale));

            var mismatched = api.Outcome("Ok", "INTERNAL_ERROR", "wrong bucket");
            Assert.False(api.ValidateOutcome(mismatched));

            var invalidJsonPayload = api.Envelope();
            api.Set(invalidJsonPayload, "PayloadJson", "{not-json}");
            api.Set(invalidJsonPayload, "PayloadBytes", 10);
            var invalidJsonResult = api.Validate(invalidJsonPayload);
            Assert.False(invalidJsonResult.Ok);
            Assert.Equal("INVALID_ENVELOPE", invalidJsonResult.Code);

            var unknownField = api.ValidateJson(api.RawEnvelopeJson(includeUnknownField: true));
            Assert.False(unknownField.Ok);
            Assert.Equal("INVALID_ENVELOPE", unknownField.Code);

            Assert.True(api.ValidateThroughEngineApi(api.RawEnvelopeJson(includeUnknownField: false)).Ok);
            Assert.Equal("INVALID_ENVELOPE",
                api.ValidateThroughEngineApi(api.RawEnvelopeJson(includeUnknownField: true)).Code);
        }

        private sealed class Net48ProtocolApi
        {
            private readonly Type _protocol;
            private readonly Type _messageKind;
            private readonly Type _outcomeKind;
            private readonly Type _envelope;
            private readonly Type _fingerprint;
            private readonly Type _outcome;

            private Net48ProtocolApi(Assembly assembly)
            {
                _protocol = assembly.GetType("WinFormsDesigner.Engine.Net48.V2Protocol", true);
                _messageKind = assembly.GetType("WinFormsDesigner.Engine.Net48.V2ProtocolMessageKind", true);
                _outcomeKind = assembly.GetType("WinFormsDesigner.Engine.Net48.V2ProtocolOutcomeKind", true);
                _envelope = assembly.GetType("WinFormsDesigner.Engine.Net48.V2ProtocolEnvelope", true);
                _fingerprint = assembly.GetType("WinFormsDesigner.Engine.Net48.V2Fingerprint", true);
                _outcome = assembly.GetType("WinFormsDesigner.Engine.Net48.V2ProtocolOutcome", true);
            }

            public int CurrentVersion => (int)_protocol.GetField("CurrentVersion").GetRawConstantValue();
            public int MinimumSupportedVersion => (int)_protocol.GetField("MinimumSupportedVersion").GetRawConstantValue();

            public static Net48ProtocolApi Load()
            {
                var assemblyPath = FindEngineAssembly();
                return new Net48ProtocolApi(Assembly.LoadFrom(assemblyPath));
            }

            public object Envelope(int? protocolVersion = null, string[] capabilities = null, string[] requiredCapabilities = null)
            {
                var caps = capabilities ?? ((string[])_protocol.GetField("Capabilities").GetValue(null)).ToArray();
                var required = requiredCapabilities ?? new[] { "protocol.envelope-v2", "payload.byte-limit" };
                var fingerprint = Fingerprint(SourceHash, 42L);
                Array resources = Array.CreateInstance(_fingerprint, 1);
                resources.SetValue(Fingerprint(ResourceHash, 9L), 0);

                return _protocol.GetMethod("CreateEnvelope").Invoke(null, new object[]
                {
                    Enum.Parse(_messageKind, "Request"),
                    "build-2.0.0",
                    "session-1",
                    "document-1",
                    "request-1",
                    "trace-1",
                    "command-1",
                    "revision-7",
                    12L,
                    fingerprint,
                    resources,
                    4102444800000L,
                    "cancel-1",
                    caps,
                    required,
                    "{\"operation\":\"describe\"}",
                    protocolVersion,
                });
            }

            public Validation Validate(object envelope)
            {
                var result = _protocol.GetMethod("ValidateEnvelope").Invoke(null, new[] { envelope, null });
                var ok = (bool)Get(result, "Ok");
                if (ok) return new Validation(true, null);
                var outcome = Get(result, "Outcome");
                return new Validation(false, (string)Get(outcome, "Code"));
            }

            public Validation ValidateJson(string envelopeJson)
            {
                var result = _protocol.GetMethod("ValidateEnvelopeJson").Invoke(null, new object[] { envelopeJson, null });
                var ok = (bool)Get(result, "Ok");
                if (ok) return new Validation(true, null);
                var outcome = Get(result, "Outcome");
                return new Validation(false, (string)Get(outcome, "Code"));
            }

            public Validation ValidateThroughEngineApi(string envelopeJson)
            {
                var engineApiType = _protocol.Assembly.GetType("WinFormsDesigner.Engine.Net48.EngineApi", true);
                var engineApi = Activator.CreateInstance(engineApiType);
                var result = engineApiType.GetMethod("ValidateV2Envelope").Invoke(engineApi, new object[] { envelopeJson });
                var ok = (bool)Get(result, "Ok");
                if (ok) return new Validation(true, null);
                return new Validation(false, (string)Get(Get(result, "Outcome"), "Code"));
            }

            public string RawEnvelopeJson(bool includeUnknownField)
            {
                var unknown = includeUnknownField ? ",\"forged\":true" : string.Empty;
                return "{"
                    + "\"protocolId\":\"designer-protocol-v2\","
                    + "\"protocolVersion\":2,\"messageKind\":\"request\","
                    + "\"buildId\":\"build-2.0.0\",\"sessionId\":\"session-1\",\"documentId\":\"document-1\","
                    + "\"requestId\":\"request-1\",\"traceId\":\"trace-1\",\"commandId\":\"command-1\","
                    + "\"documentRevision\":\"revision-7\",\"renderGeneration\":12,"
                    + "\"sourceFingerprint\":{\"algorithm\":\"sha256\",\"artifactId\":\"source\",\"value\":\"" + SourceHash + "\",\"byteLength\":42},"
                    + "\"resourceFingerprints\":[{\"algorithm\":\"sha256\",\"artifactId\":\"resource.resx\",\"value\":\"" + ResourceHash + "\",\"byteLength\":9}],"
                    + "\"deadlineUnixMilliseconds\":4102444800000,\"cancellationToken\":\"cancel-1\","
                    + "\"capabilities\":[\"protocol.envelope-v2\",\"payload.byte-limit\"],"
                    + "\"requiredCapabilities\":[\"protocol.envelope-v2\",\"payload.byte-limit\"],"
                    + "\"payloadContentType\":\"application/json\",\"payloadBytes\":24,"
                    + "\"payloadJson\":\"{\\\"operation\\\":\\\"describe\\\"}\""
                    + unknown + "}";
            }

            public object Outcome(string kind, string code, string message)
            {
                var value = Activator.CreateInstance(_outcome);
                Set(value, "Kind", Enum.Parse(_outcomeKind, kind));
                Set(value, "RequestId", "request-1");
                Set(value, "TraceId", "trace-1");
                Set(value, "Code", code);
                Set(value, "Message", message);
                Set(value, "Retryable", false);
                Set(value, "DiagnosticId", code);
                return value;
            }

            public bool ValidateOutcome(object outcome)
            {
                return (bool)_protocol.GetMethod("ValidateOutcome").Invoke(null, new[] { outcome });
            }

            public object Get(object instance, string propertyName)
            {
                return instance.GetType().GetProperty(propertyName).GetValue(instance);
            }

            public void Set(object instance, string propertyName, object value)
            {
                instance.GetType().GetProperty(propertyName).SetValue(instance, value);
            }

            private object Fingerprint(string hash, long byteLength)
            {
                var artifactId = hash == SourceHash ? "source" : "resource.resx";
                return _protocol.GetMethod("Fingerprint").Invoke(null, new object[] { artifactId, hash, byteLength });
            }

            private static string FindEngineAssembly()
            {
                var configuration = typeof(V2ProtocolTests).Assembly
                    .GetCustomAttribute<AssemblyConfigurationAttribute>()?.Configuration ?? "Debug";
                var current = new DirectoryInfo(AppDomain.CurrentDomain.BaseDirectory);
                while (current != null)
                {
                    var project = Path.Combine(current.FullName, "engine-net48", "Engine.Net48.csproj");
                    if (File.Exists(project))
                    {
                        var candidate = Path.Combine(current.FullName, "engine-net48", "bin", configuration, "net48", "WinFormsDesigner.Engine.Net48.exe");
                        if (File.Exists(candidate)) return candidate;
                        throw new FileNotFoundException("Expected built net48 engine at " + candidate);
                    }
                    current = current.Parent;
                }
                throw new FileNotFoundException("Could not locate WinFormsDesigner.Engine.Net48.exe from the test output directory.");
            }
        }

        private sealed class Validation
        {
            public Validation(bool ok, string code)
            {
                Ok = ok;
                Code = code;
            }

            public bool Ok { get; }
            public string Code { get; }
        }
    }
}
