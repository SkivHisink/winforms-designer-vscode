#nullable disable
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using Newtonsoft.Json.Serialization;
#if NETFRAMEWORK
using WinFormsDesigner.Engine.Net48;
#endif

namespace WinFormsDesigner.Engine.Protocol
{
    public sealed class ProtocolNegotiationResult
    {
        public bool Ok { get; set; }
        public string ProtocolId { get; set; }
        public int ProtocolVersion { get; set; }
        public int MinimumSupportedVersion { get; set; }
        public int MaximumSupportedVersion { get; set; }
        public string SchemaSha256 { get; set; }
        public string BuildId { get; set; }
        public string EngineVersion { get; set; }
        public string Runtime { get; set; }
        public string Architecture { get; set; }
        public string[] Capabilities { get; set; }
        public V2ProtocolOutcome Outcome { get; set; }
    }

    public sealed class ProtocolExecutionResult
    {
        public string SessionId { get; set; }
        public string DocumentId { get; set; }
        public string RequestId { get; set; }
        public string DocumentRevision { get; set; }
        public long Generation { get; set; }
        public string BuildId { get; set; }
        public V2ProtocolOutcome Outcome { get; set; }
        public string ResultJson { get; set; }
    }

    public sealed class WorkerUsage
    {
        public long MemoryBytes { get; set; }
        public int HandleCount { get; set; }
        public static WorkerUsage Read()
        {
            using (var process = Process.GetCurrentProcess())
                return new WorkerUsage { MemoryBytes = process.WorkingSet64, HandleCount = process.HandleCount };
        }
    }

    /// <summary>One transport boundary for the existing engine APIs. The registry only forwards established RPCs;
    /// their interpretation, identifier and edit-minimality gates remain the only implementations. All edits are
    /// proposals; the document journal in the Extension Host remains the sole workspace commit owner.</summary>
    public sealed class RuntimeProtocolRouter
    {
        private static readonly HashSet<string> ReadMethods = Names(
            "Ping GetCapabilities GetV2WorkerUsage ProbeHostedServiceKernel InspectCertifiedHostedServiceKernel " +
            "InspectCertifiedHostedDesigner ResolveAssembly ResolveDesignerDocumentOwner " +
            "RenderDesigner RenderWithLayout RenderControl PreviewSave SerializeDesigner DescribeDesigner " +
            "DescribeComponent DescribeLayout HitTestTab HitTestDesignerAdorner BeginGeometryDrag ListControlTypes " +
            "ListToolboxItems ListToolboxCandidates ScanToolboxAssembly GetDesignerPalette ConvertValue " +
            "ListProjectImageResources ReadTableStyles ListCollectionItems ListGenericListItems ListStringArray " +
            "ListColumns ListGridColumns ListBindings GetDataSource ListDataSources ListNodes ListToolStripItems " +
            "ListTabPages CopyControl ListHandlerCandidates FindEventHandlerSourceIndex " +
            "DeserializeImageList SerializeImageList RenderCompiledWithLayout RenderInterpretedWithLayout " +
            "DescribeInterpretedComponent DescribeCompiledComponent ListCompiledVendorSmartTags " +
            "ListCompiledToolboxControls HitTestCompiledTab HitTestInterpretedTab AuthorizeInheritedGeometryOverride");
        private static readonly HashSet<string> MutationMethods = Names(
            "InvokeCertifiedHostedServiceAction EditSupportedUiTypeEditor EditSupportedCollectionEditor " +
            "EditCertifiedVendorCollectionEditor PlanBoundedComponentPatch ApplyCachedTextPropertyEdit SetProperty SetNestedProperty " +
            "PreviewOwnedRegionPropertySet ApplyInheritedPropertyOverride RemoveInheritedPropertyOverride SetProperties " +
            "MakeLocalizable SetLocalizationCulture SetLocalizedResources SetLocalizedImageResource SetModifier " +
            "SetTableCell ResetProperty ResetProperties SetImageResource SetProjectImageResource SetImageList " +
            "SetTableStyle SetCollectionItems SetGenericListItems SetStringArray SetColumns SetDataSource " +
            "GenerateDataSource BindApplicationSetting SetExtender SetBindings SetGridColumns SetNodes " +
            "SetToolStripItems CommitGeometryBounds GenerateEventHandler SetEventWiring AddControl AddLocalizedControl " +
            "RemoveLocalizedComponentResources AddTabPage AddComponent RemoveControl RenameComponent RemoveTabPage " +
            "MoveTabPage SetTabPageOrder PasteControl PasteControlAtOffset MoveZOrder Reparent " +
            "DiscardCompiledLive ReleaseCompiledAssembly ReleaseAllCompiledAssemblies ApplyInterpretedEditsLive " +
            "SetCompiledPropertyLive ResetCompiledPropertyLive SetCompiledCollectionLive SetCompiledTreeNodesLive " +
            "SetCompiledToolStripItemsLive SetCompiledStringArrayLive SetCompiledImageListLive ApplyCompiledEdits " +
            "RemoveCompiledControls SetCompiledZOrder AddCompiledControl SelectCompiledTabAt AddCompiledTab " +
            "RemoveCompiledTab MoveCompiledTab");
        private static readonly HashSet<string> DiskSourceMethods = Names("RenderDesigner DescribeDesigner PreviewSave SerializeDesigner");
        private static readonly JsonSerializerSettings WireSettings = new JsonSerializerSettings
        {
            ContractResolver = new CamelCasePropertyNamesContractResolver(),
            TypeNameHandling = TypeNameHandling.None,
        };
        private readonly object _target;
        private readonly Dictionary<string, MethodInfo> _methods;
        private readonly object _gate = new object();
        private readonly SemaphoreSlim _dispatch = new SemaphoreSlim(1, 1);
        private readonly Dictionary<string, DocumentState> _documents = new Dictionary<string, DocumentState>(StringComparer.Ordinal);
        private readonly HashSet<string> _cancelled = new HashSet<string>(StringComparer.Ordinal);
        private readonly Dictionary<string, HashSet<CancellationTokenSource>> _activeCancellation =
            new Dictionary<string, HashSet<CancellationTokenSource>>(StringComparer.Ordinal);
        private readonly Queue<string> _cancelOrder = new Queue<string>();
        private readonly Dictionary<string, OperationRecord> _operations = new Dictionary<string, OperationRecord>(StringComparer.Ordinal);
        private readonly Queue<string> _operationOrder = new Queue<string>();
        private int _negotiatedVersion;
        private int _pending;
        private long _operationBytes;
        public string BuildId { get; }

        public RuntimeProtocolRouter(object target)
        {
            _target = target ?? throw new ArgumentNullException(nameof(target));
            _methods = target.GetType().GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly)
                .Where(method => ReadMethods.Contains(method.Name) || MutationMethods.Contains(method.Name))
                .ToDictionary(method => method.Name, StringComparer.Ordinal);
            using (var stream = File.OpenRead(target.GetType().Assembly.Location))
            using (var sha = SHA256.Create()) BuildId = "sha256-" + Hex(sha.ComputeHash(stream));
        }

        public ProtocolNegotiationResult Negotiate(string handshakeJson)
        {
            var result = new ProtocolNegotiationResult
            {
                ProtocolId = V2Protocol.ProtocolId,
                MinimumSupportedVersion = V2Protocol.MinimumSupportedVersion,
                MaximumSupportedVersion = V2Protocol.CurrentVersion,
                SchemaSha256 = V2Protocol.SchemaSha256,
                BuildId = BuildId,
                EngineVersion = _target.GetType().Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion
                    ?? _target.GetType().Assembly.GetName().Version.ToString(),
                Runtime = RuntimeInformation.FrameworkDescription,
                Architecture = RuntimeInformation.ProcessArchitecture.ToString().ToLowerInvariant(),
                Capabilities = V2Protocol.Capabilities.ToArray(),
            };
            try
            {
                if (V2Protocol.PayloadByteCount(handshakeJson) > 16384) throw new FormatException();
                var request = JObject.Parse(handshakeJson);
                if (request.Properties().Any(p => p.Name != "protocolId" && p.Name != "minimumVersion"
                    && p.Name != "maximumVersion" && p.Name != "requiredCapabilities" && p.Name != "expectedBuildId"))
                    throw new FormatException();
                if (request["protocolId"]?.Type != JTokenType.String || (string)request["protocolId"] != V2Protocol.ProtocolId
                    || request["minimumVersion"]?.Type != JTokenType.Integer || request["maximumVersion"]?.Type != JTokenType.Integer
                    || request["requiredCapabilities"]?.Type != JTokenType.Array) throw new FormatException();
                var minimum = (int)request["minimumVersion"];
                var maximum = (int)request["maximumVersion"];
                if (minimum < 1 || maximum < minimum) throw new FormatException();
                var version = Math.Min(maximum, V2Protocol.CurrentVersion);
                if (version < Math.Max(minimum, V2Protocol.MinimumSupportedVersion))
                    return NegotiationRefusal(result, "PROTOCOL_VERSION_UNSUPPORTED");
                var required = (JArray)request["requiredCapabilities"];
                if (required.Count > V2Protocol.MaxCapabilities || required.Any(cap => cap.Type != JTokenType.String)
                    || required.Select(cap => (string)cap).Distinct(StringComparer.Ordinal).Count() != required.Count)
                    throw new FormatException();
                if (required.Any(cap => !V2Protocol.Capabilities.Contains((string)cap, StringComparer.Ordinal)))
                    return NegotiationRefusal(result, "UNKNOWN_REQUIRED_CAPABILITY");
                if (request.Property("expectedBuildId") != null)
                {
                    if (request["expectedBuildId"].Type != JTokenType.String) throw new FormatException();
                    if ((string)request["expectedBuildId"] != BuildId) return NegotiationRefusal(result, "BUILD_ID_MISMATCH");
                }
                lock (_gate) _negotiatedVersion = version;
                result.Ok = true;
                result.ProtocolVersion = version;
                return result;
            }
            catch
            {
                return NegotiationRefusal(result, "INVALID_ENVELOPE");
            }
        }

        public bool Cancel(string sessionId, string cancellationToken)
        {
            if (string.IsNullOrEmpty(sessionId) || string.IsNullOrEmpty(cancellationToken)
                || sessionId.Length > V2Protocol.MaxIdentifierLength || cancellationToken.Length > V2Protocol.MaxIdentifierLength) return false;
            CancellationTokenSource[] active;
            lock (_gate)
            {
                var key = sessionId + "/" + cancellationToken;
                if (_cancelled.Add(key)) _cancelOrder.Enqueue(key);
                while (_cancelOrder.Count > 256) _cancelled.Remove(_cancelOrder.Dequeue());
                HashSet<CancellationTokenSource> sources;
                active = _activeCancellation.TryGetValue(key, out sources) ? sources.ToArray() : new CancellationTokenSource[0];
            }
            foreach (var source in active)
                try { source.Cancel(); } catch (ObjectDisposedException) { /* completion raced cancellation */ }
            return true;
        }

        public async Task<ProtocolExecutionResult> ExecuteAsync(string envelopeJson, CancellationToken cancellationToken)
        {
            if (V2Protocol.PayloadByteCount(envelopeJson) > V2Protocol.MaxPayloadBytes * 2 + 32768)
                return Reply(null, Outcome(null, V2ProtocolOutcomeKind.Refused, "PAYLOAD_TOO_LARGE"));
            var validation = V2Protocol.ValidateEnvelopeJson(envelopeJson);
            if (!validation.Ok) return Reply(null, validation.Outcome);
            var envelope = validation.Envelope;
            if (envelope.MessageKind != V2ProtocolMessageKind.Request)
                return Reply(envelope, Outcome(envelope, V2ProtocolOutcomeKind.Refused, "INVALID_ENVELOPE"));
            lock (_gate)
            {
                if (_negotiatedVersion == 0 || envelope.ProtocolVersion != _negotiatedVersion)
                    return Reply(envelope, Outcome(envelope, V2ProtocolOutcomeKind.Refused, "PROTOCOL_NOT_NEGOTIATED"));
                if (envelope.BuildId != BuildId)
                    return Reply(envelope, Outcome(envelope, V2ProtocolOutcomeKind.Refused, "BUILD_ID_MISMATCH"));
            }
            MethodInfo method;
            JArray arguments;
            try
            {
                var payload = JObject.Parse(envelope.PayloadJson);
                if (payload.Count != 2 || payload["method"]?.Type != JTokenType.String || payload["args"]?.Type != JTokenType.Array)
                    return Reply(envelope, Outcome(envelope, V2ProtocolOutcomeKind.Refused, "INVALID_ENVELOPE"));
                if (!_methods.TryGetValue((string)payload["method"], out method))
                    return Reply(envelope, Outcome(envelope, V2ProtocolOutcomeKind.Unsupported, "UNSUPPORTED_OPERATION"));
                arguments = (JArray)payload["args"];
                if (MutationMethods.Contains(method.Name) && string.IsNullOrEmpty(envelope.CommandId))
                    return Reply(envelope, Outcome(envelope, V2ProtocolOutcomeKind.Refused, "COMMAND_ID_REQUIRED"));
            }
            catch { return Reply(envelope, Outcome(envelope, V2ProtocolOutcomeKind.Refused, "INVALID_ENVELOPE")); }
            var documentKey = envelope.SessionId + "/" + envelope.DocumentId;
            lock (_gate)
            {
                var early = Check(envelope, documentKey, cancellationToken);
                if (early != null) return Reply(envelope, early);
                DocumentState current;
                var knownDocument = _documents.TryGetValue(documentKey, out current);
                if (_pending >= 64 || (!knownDocument && _documents.Count >= 1024))
                    return Reply(envelope, Outcome(envelope, V2ProtocolOutcomeKind.Refused, "REQUEST_QUEUE_FULL"));
                if (!knownDocument || envelope.RenderGeneration > current.Generation)
                    _documents[documentKey] = new DocumentState(envelope);
                _pending++;
            }
            var entered = false;
            CancellationTokenSource activeSource = null;
            var cancellationKey = envelope.SessionId + "/" + envelope.CancellationToken;
            try
            {
                using (var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken))
                {
                    activeSource = linked;
                    lock (_gate)
                    {
                        HashSet<CancellationTokenSource> sources;
                        if (!_activeCancellation.TryGetValue(cancellationKey, out sources))
                            _activeCancellation[cancellationKey] = sources = new HashSet<CancellationTokenSource>();
                        sources.Add(linked);
                        if (_cancelled.Contains(cancellationKey)) linked.Cancel();
                    }
                    linked.CancelAfter((int)Math.Min(int.MaxValue, Math.Max(1, envelope.DeadlineUnixMilliseconds - Now())));
                    await _dispatch.WaitAsync(linked.Token).ConfigureAwait(false);
                    entered = true;
                    lock (_gate)
                    {
                        var early = Check(envelope, documentKey, linked.Token);
                        if (early != null) return Reply(envelope, early);
                    }
                    object[] bound;
                    try { bound = Bind(method, arguments, linked.Token); }
                    catch { return Reply(envelope, Outcome(envelope, V2ProtocolOutcomeKind.Refused, "INVALID_ENVELOPE")); }
                    var source = CheckSource(envelope, method, bound);
                    if (source != null) return Reply(envelope, source);
                    var operationKey = documentKey + "/" + envelope.CommandId;
                    var payloadHash = Hash(envelope.PayloadJson);
                    if (MutationMethods.Contains(method.Name))
                    {
                        lock (_gate)
                        {
                            OperationRecord prior;
                            if (_operations.TryGetValue(operationKey, out prior))
                            {
                                if (prior.PayloadHash != payloadHash)
                                    return Reply(envelope, Outcome(envelope, V2ProtocolOutcomeKind.Refused, "COMMAND_ID_CONFLICT"));
                                if (prior.Revision != envelope.DocumentRevision || prior.SourceHash != envelope.SourceFingerprint.Value)
                                    return Reply(envelope, Outcome(envelope, V2ProtocolOutcomeKind.Stale, "STALE_SOURCE"));
                                return Reply(envelope, Outcome(envelope, prior.Kind, prior.Code),
                                    prior.Kind == V2ProtocolOutcomeKind.Ok ? prior.ResultJson : null);
                            }
                        }
                    }
                    object value;
                    try
                    {
                        value = method.Invoke(_target, bound);
                        var task = value as Task;
                        if (task != null)
                        {
                            await task.ConfigureAwait(false);
                            value = task.GetType().GetProperty("Result")?.GetValue(task);
                        }
                    }
                    catch (Exception ex)
                    {
                        var cancelled = ex.GetBaseException() is OperationCanceledException;
                        var failure = Outcome(envelope, cancelled ? V2ProtocolOutcomeKind.Cancelled : V2ProtocolOutcomeKind.Fault,
                            cancelled ? "CANCELLED" : "UNHANDLED_EXCEPTION");
                        if (MutationMethods.Contains(method.Name)) Record(operationKey, envelope, payloadHash, failure, null);
                        return Reply(envelope, failure);
                    }
                    var resultJson = JsonConvert.SerializeObject(value, WireSettings);
                    V2ProtocolOutcome outcome;
                    lock (_gate) outcome = Check(envelope, documentKey, linked.Token)
                        ?? Outcome(envelope, V2ProtocolOutcomeKind.Ok, "OK");
                    if (MutationMethods.Contains(method.Name)) Record(operationKey, envelope, payloadHash, outcome, resultJson);
                    return Reply(envelope, outcome, outcome.Kind == V2ProtocolOutcomeKind.Ok ? resultJson : null);
                }
            }
            catch (OperationCanceledException)
            {
                return Reply(envelope, Outcome(envelope, V2ProtocolOutcomeKind.Cancelled,
                    Now() >= envelope.DeadlineUnixMilliseconds ? "DEADLINE_EXCEEDED" : "CANCELLED"));
            }
            finally
            {
                if (entered) _dispatch.Release();
                lock (_gate)
                {
                    _pending--;
                    HashSet<CancellationTokenSource> sources;
                    if (activeSource != null && _activeCancellation.TryGetValue(cancellationKey, out sources))
                    {
                        sources.Remove(activeSource);
                        if (sources.Count == 0) _activeCancellation.Remove(cancellationKey);
                    }
                }
            }
        }

        private V2ProtocolOutcome Check(V2ProtocolEnvelope envelope, string documentKey, CancellationToken cancellationToken)
        {
            if (Now() >= envelope.DeadlineUnixMilliseconds)
                return Outcome(envelope, V2ProtocolOutcomeKind.Cancelled, "DEADLINE_EXCEEDED");
            if (cancellationToken.IsCancellationRequested || _cancelled.Contains(envelope.SessionId + "/" + envelope.CancellationToken))
                return Outcome(envelope, V2ProtocolOutcomeKind.Cancelled, "CANCELLED");
            DocumentState current;
            if (_documents.TryGetValue(documentKey, out current))
            {
                if (envelope.RenderGeneration < current.Generation)
                    return Outcome(envelope, V2ProtocolOutcomeKind.Stale, "STALE_GENERATION");
                if (envelope.RenderGeneration == current.Generation && (envelope.DocumentRevision != current.Revision
                    || envelope.SourceFingerprint.Value != current.SourceHash))
                    return Outcome(envelope, V2ProtocolOutcomeKind.Stale, "STALE_REVISION");
            }
            return null;
        }

        private static object[] Bind(MethodInfo method, JArray arguments, CancellationToken token)
        {
            var parameters = method.GetParameters();
            var suppliedCount = parameters.Count(parameter => parameter.ParameterType != typeof(CancellationToken));
            if (arguments.Count > suppliedCount) throw new FormatException();
            var serializer = JsonSerializer.Create(WireSettings);
            var result = new object[parameters.Length];
            var index = 0;
            for (var i = 0; i < parameters.Length; i++)
            {
                var parameter = parameters[i];
                if (parameter.ParameterType == typeof(CancellationToken)) result[i] = token;
                else if (index < arguments.Count) result[i] = arguments[index++].ToObject(parameter.ParameterType, serializer);
                else if (parameter.HasDefaultValue) result[i] = parameter.DefaultValue;
                else throw new FormatException();
            }
            return result;
        }

        private static V2ProtocolOutcome CheckSource(V2ProtocolEnvelope envelope, MethodInfo method, object[] arguments)
        {
            var parameters = method.GetParameters();
            string source = null;
            var hasSource = false;
            var hasSourceParameter = false;
            var designerPath = "";
            for (var i = 0; i < parameters.Length; i++)
            {
                if (parameters[i].Name == "sourceText" || parameters[i].Name == "designerSourceText"
                    || parameters[i].Name == "beforeSourceText")
                {
                    hasSourceParameter = true;
                    if (arguments[i] is string) { source = (string)arguments[i]; hasSource = true; }
                }
                if (parameters[i].Name == "designerFilePath") designerPath = arguments[i] as string;
            }
            try
            {
                if (!hasSource && (hasSourceParameter || DiskSourceMethods.Contains(method.Name)) && !string.IsNullOrEmpty(designerPath))
                {
                    source = File.ReadAllText(designerPath);
                    hasSource = true;
                }
                if (hasSource && (Hash(source) != envelope.SourceFingerprint.Value
                    || Encoding.UTF8.GetByteCount(source) != envelope.SourceFingerprint.ByteLength))
                    return Outcome(envelope, V2ProtocolOutcomeKind.Stale, "STALE_SOURCE");
                return null;
            }
            catch { return Outcome(envelope, V2ProtocolOutcomeKind.Stale, "STALE_SOURCE"); }
        }

        private void Record(string key, V2ProtocolEnvelope envelope, string payloadHash, V2ProtocolOutcome outcome, string resultJson)
        {
            lock (_gate)
            {
                _operations[key] = new OperationRecord
                {
                    PayloadHash = payloadHash, Revision = envelope.DocumentRevision, SourceHash = envelope.SourceFingerprint.Value,
                    Kind = outcome.Kind, Code = outcome.Code, ResultJson = resultJson,
                };
                _operationBytes += V2Protocol.PayloadByteCount(resultJson);
                _operationOrder.Enqueue(key);
                while (_operationOrder.Count > 256 || _operationBytes > 16 * 1024 * 1024)
                {
                    var oldest = _operationOrder.Dequeue();
                    OperationRecord removed;
                    if (_operations.TryGetValue(oldest, out removed))
                        _operationBytes -= V2Protocol.PayloadByteCount(removed.ResultJson);
                    _operations.Remove(oldest);
                }
            }
        }

        private ProtocolExecutionResult Reply(V2ProtocolEnvelope envelope, V2ProtocolOutcome outcome, string resultJson = null) =>
            new ProtocolExecutionResult
            {
                SessionId = envelope?.SessionId ?? "invalid-session", DocumentId = envelope?.DocumentId ?? "invalid-document",
                RequestId = envelope?.RequestId ?? outcome.RequestId, DocumentRevision = envelope?.DocumentRevision ?? "invalid-revision",
                Generation = envelope?.RenderGeneration ?? 0, BuildId = BuildId, Outcome = outcome, ResultJson = resultJson,
            };
        private static ProtocolNegotiationResult NegotiationRefusal(ProtocolNegotiationResult result, string code)
        {
            result.Outcome = Outcome(null, V2ProtocolOutcomeKind.Refused, code);
            return result;
        }
        private static V2ProtocolOutcome Outcome(V2ProtocolEnvelope envelope, V2ProtocolOutcomeKind kind, string code) =>
            new V2ProtocolOutcome
            {
                Kind = kind, Code = code, Message = code, RequestId = envelope?.RequestId ?? "negotiation",
                TraceId = envelope?.TraceId ?? "negotiation-trace", DiagnosticId = code, Retryable = false,
            };
        private static HashSet<string> Names(string names) => new HashSet<string>(names.Split(' '), StringComparer.Ordinal);
        private static long Now() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        private static string Hash(string text)
        {
            using (var sha = SHA256.Create()) return Hex(sha.ComputeHash(Encoding.UTF8.GetBytes(text)));
        }
        private static string Hex(byte[] bytes) => string.Concat(bytes.Select(value => value.ToString("x2")));
        private sealed class DocumentState
        {
            public DocumentState(V2ProtocolEnvelope envelope)
            { Generation = envelope.RenderGeneration; Revision = envelope.DocumentRevision; SourceHash = envelope.SourceFingerprint.Value; }
            public long Generation { get; }
            public string Revision { get; }
            public string SourceHash { get; }
        }
        private sealed class OperationRecord
        {
            public string PayloadHash;
            public string Revision;
            public string SourceHash;
            public V2ProtocolOutcomeKind Kind;
            public string Code;
            public string ResultJson;
        }
    }
}
