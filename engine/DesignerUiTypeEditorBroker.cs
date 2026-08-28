using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;

namespace WinFormsDesigner.Engine
{
    /// <summary>
    /// Wire request for the deliberately small UITypeEditor worker protocol. The future process host writes one
    /// JSON request to the child process's standard input and accepts exactly one JSON response on standard output.
    /// No assembly path or arbitrary type is accepted here: the worker must resolve the policy-approved framework
    /// type names from its own trusted runtime.
    /// </summary>
    public sealed class DesignerUiTypeEditorRequest
    {
        [JsonPropertyName("protocolVersion")]
        public int ProtocolVersion { get; init; } = DesignerUiTypeEditorWireProtocol.ProtocolVersion;

        [JsonPropertyName("requestId")]
        public string RequestId { get; init; } = "";

        [JsonPropertyName("editorTypeName")]
        public string EditorTypeName { get; init; } = "";

        [JsonPropertyName("valueTypeName")]
        public string ValueTypeName { get; init; } = "";

        [JsonPropertyName("invariantValue")]
        public string InvariantValue { get; init; } = "";

        [JsonPropertyName("editorAssemblyPath")]
        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public string? EditorAssemblyPath { get; init; }

        [JsonPropertyName("editorAssemblySha256")]
        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public string? EditorAssemblySha256 { get; init; }

        [JsonPropertyName("editorCertificationId")]
        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public string? EditorCertificationId { get; init; }

        [JsonPropertyName("collectionItemTypeName")]
        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public string? CollectionItemTypeName { get; init; }

        [JsonPropertyName("collectionItems")]
        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public List<string>? CollectionItems { get; init; }
    }

    /// <summary>
    /// Response emitted by the isolated worker. <c>status</c> is one of <c>applied</c>, <c>dismissed</c>, or
    /// <c>error</c>. A dismissed editor is a successful no-op (the user pressed Cancel); infrastructure
    /// cancellation and timeouts are broker errors instead.
    /// </summary>
    public sealed class DesignerUiTypeEditorWorkerResponse
    {
        [JsonPropertyName("protocolVersion")]
        public int ProtocolVersion { get; init; } = DesignerUiTypeEditorWireProtocol.ProtocolVersion;

        [JsonPropertyName("requestId")]
        public string RequestId { get; init; } = "";

        [JsonPropertyName("status")]
        public string Status { get; init; } = "";

        [JsonPropertyName("invariantValue")]
        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public string? InvariantValue { get; init; }

        [JsonPropertyName("collectionItems")]
        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public List<string>? CollectionItems { get; init; }

        [JsonPropertyName("errorCode")]
        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public string? ErrorCode { get; init; }

        [JsonPropertyName("errorMessage")]
        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public string? ErrorMessage { get; init; }
    }

    /// <summary>Raw, bounded child-process result. A production runner owns process creation and must terminate
    /// the complete process tree when its cancellation token is signalled.</summary>
    public sealed class DesignerUiTypeEditorProcessOutput
    {
        public int ExitCode { get; init; }
        public string StandardOutput { get; init; } = "";
        public string StandardError { get; init; } = "";
    }

    /// <summary>
    /// Process seam used by <see cref="DesignerUiTypeEditorBroker"/>. Implementations receive the complete request
    /// JSON (one document, no framing) and return captured output only after the child has exited. They must not use
    /// a shell, must redirect all streams, and must kill the child process tree when <paramref name="cancellationToken"/>
    /// is cancelled. The broker independently bounds its wait, so an incorrect runner cannot block the RPC forever.
    /// </summary>
    public interface IDesignerUiTypeEditorProcessRunner
    {
        Task<DesignerUiTypeEditorProcessOutput> RunAsync(string requestJson, CancellationToken cancellationToken);
    }

    /// <summary>Fail-closed broker outcome. <see cref="Ok"/> is true only for an applied value or a user-dismissed
    /// editor. Callers must commit source only when <see cref="Applied"/> is true.</summary>
    public sealed class DesignerUiTypeEditorBrokerResult
    {
        public bool Ok { get; init; }
        public bool Applied { get; init; }
        public bool Dismissed { get; init; }
        public string? InvariantValue { get; init; }
        public List<string>? CollectionItems { get; init; }
        public string ErrorCode { get; init; } = "";
        public string Reason { get; init; } = "";
    }

    /// <summary>
    /// Stable JSON helpers shared by the broker and the future worker entrypoint. Unknown members, comments,
    /// trailing documents, case-mismatched members, and excessive nesting are rejected rather than tolerated.
    /// </summary>
    public static class DesignerUiTypeEditorWireProtocol
    {
        public const int ProtocolVersion = 1;

        private static readonly JsonSerializerOptions JsonOptions = new()
        {
            PropertyNameCaseInsensitive = false,
            ReadCommentHandling = JsonCommentHandling.Disallow,
            AllowTrailingCommas = false,
            UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
            MaxDepth = 8,
        };

        public static string SerializeRequest(DesignerUiTypeEditorRequest request) =>
            JsonSerializer.Serialize(request, JsonOptions);

        public static string SerializeWorkerResponse(DesignerUiTypeEditorWorkerResponse response) =>
            JsonSerializer.Serialize(response, JsonOptions);

        internal static DesignerUiTypeEditorRequest? DeserializeRequest(string json) =>
            JsonSerializer.Deserialize<DesignerUiTypeEditorRequest>(json, JsonOptions);

        internal static DesignerUiTypeEditorWorkerResponse? DeserializeWorkerResponse(string json) =>
            JsonSerializer.Deserialize<DesignerUiTypeEditorWorkerResponse>(json, JsonOptions);
    }

    /// <summary>
    /// Security policy for modal/drop-down editor execution. Only framework editors whose invariant values already
    /// round-trip through <see cref="DesignerValueConverter"/> are enabled. File, folder, image, binary/resource,
    /// custom/vendor, and assembly-qualified editors are intentionally absent: they need separate source/resource
    /// transactions and must never become executable merely because a project advertises an EditorAttribute.
    /// </summary>
    public static class DesignerUiTypeEditorPolicy
    {
        public const int MaximumRequestIdLength = 128;
        public const int MaximumTypeNameLength = 256;
        public const int MaximumInvariantValueLength = 16 * 1024;
        public const int MaximumWorkerOutputLength = 256 * 1024;
        public const int MaximumCollectionItems = 128;
        public const int MaximumCollectionItemLength = 1024;
        public const string InvalidEditorResultCode = "INVALID_EDITOR_RESULT";
        public const string CollectionEditorTypeName = "System.ComponentModel.Design.CollectionEditor";
        public const string CollectionValueTypeName = "System.Collections.IList";

        private static readonly HashSet<string> SupportedPairs = new(StringComparer.Ordinal)
        {
            Pair("System.Drawing.Design.ColorEditor", "System.Drawing.Color"),
            Pair("System.Drawing.Design.FontEditor", "System.Drawing.Font"),
        };

        private const string FakeVendorCertificationId = "repo.fakevendor.complex-value.v1";
        private const string FakeVendorAssemblyName = "FakeVendor";
        private const string FakeVendorComponentTypeName = "FakeVendor.VendorEdit";
        private const string FakeVendorPropertyName = "ComplexValue";
        private const string FakeVendorEditorTypeName = "FakeVendor.VendorComplexValueEditor";
        private const string FakeVendorValueTypeName = "System.String";
        private const string FakeVendorCollectionCertificationId = "repo.fakevendor.thresholds.v1";
        private const string FakeVendorCollectionPropertyName = "Thresholds";
        private const string FakeVendorCollectionEditorTypeName = "FakeVendor.VendorThresholdsEditor";
        private const string FakeVendorCollectionItemTypeName = "System.Int32";

        private static readonly IReadOnlyDictionary<string, string> WorkerErrorReasons =
            new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["editor_failed"] = "The supported editor could not complete.",
                ["conversion_failed"] = "The editor result could not be converted to a supported invariant value.",
                ["runtime_unsupported"] = "The supported editor is unavailable in this runtime.",
                ["worker_cancelled"] = "The editor worker was cancelled.",
                [InvalidEditorResultCode] = "The editor result was rejected before any source mutation.",
            };

        public static bool IsSupported(string editorTypeName, string valueTypeName) =>
            editorTypeName != null && valueTypeName != null && SupportedPairs.Contains(Pair(editorTypeName, valueTypeName));

        public static bool IsSupportedCollectionEditor(string editorTypeName, string valueTypeName) =>
            string.Equals(editorTypeName, CollectionEditorTypeName, StringComparison.Ordinal)
            && string.Equals(valueTypeName, CollectionValueTypeName, StringComparison.Ordinal);

        internal static bool TryDescribeCertifiedVendorEditor(
            Type componentType,
            string propertyName,
            string valueTypeName,
            string? advertisedEditorTypeName,
            string? componentAssemblyPath,
            out string editorTypeName,
            out string editorAssemblyPath,
            out string editorAssemblySha256,
            out string editorCertificationId)
        {
            editorTypeName = "";
            editorAssemblyPath = "";
            editorAssemblySha256 = "";
            editorCertificationId = "";

            if (componentType.FullName != FakeVendorComponentTypeName)
                return false;

            bool scalarEditor = propertyName == FakeVendorPropertyName
                && valueTypeName == FakeVendorValueTypeName
                && (advertisedEditorTypeName == FakeVendorEditorTypeName
                    || HasExactEditorAttribute(componentType, propertyName,
                        FakeVendorEditorTypeName, "System.Drawing.Design.UITypeEditor"));
            bool collectionEditor = IsExactVendorCollectionProperty(componentType, propertyName, valueTypeName)
                && (advertisedEditorTypeName == FakeVendorCollectionEditorTypeName
                    || HasExactEditorAttribute(componentType, propertyName,
                        FakeVendorCollectionEditorTypeName, "System.Drawing.Design.UITypeEditor"));
            if (!scalarEditor && !collectionEditor) return false;

            if (!string.Equals(componentType.Assembly.GetName().Name, FakeVendorAssemblyName, StringComparison.Ordinal))
                return false;

            // User assemblies are deliberately byte-loaded into a collectible ALC so an open designer never pins
            // the project's build output. Assembly.Location is therefore empty on the real product path; use the
            // already-resolved graph input path, while retaining every exact type/name/hash check below.
            string path = string.IsNullOrWhiteSpace(componentAssemblyPath)
                ? componentType.Assembly.Location
                : componentAssemblyPath;
            if (string.IsNullOrWhiteSpace(path) || !Path.IsPathFullyQualified(path) || !File.Exists(path))
                return false;

            try
            {
                path = Path.GetFullPath(path);
                if (!string.Equals(AssemblyName.GetAssemblyName(path).Name, FakeVendorAssemblyName, StringComparison.Ordinal))
                    return false;
                editorAssemblySha256 = ComputeSha256(path);
            }
            catch
            {
                return false;
            }

            editorTypeName = collectionEditor ? FakeVendorCollectionEditorTypeName : FakeVendorEditorTypeName;
            editorAssemblyPath = path;
            editorCertificationId = collectionEditor
                ? FakeVendorCollectionCertificationId
                : FakeVendorCertificationId;
            return true;
        }

        private static bool IsExactVendorCollectionProperty(
            Type componentType,
            string propertyName,
            string valueTypeName)
        {
            if (propertyName != FakeVendorCollectionPropertyName) return false;
            try
            {
                System.Reflection.PropertyInfo? property = componentType.GetProperty(
                    propertyName,
                    BindingFlags.Instance | BindingFlags.Public);
                Type propertyType = property?.PropertyType!;
                return propertyType != null
                    && valueTypeName == propertyType.FullName
                    && propertyType.IsGenericType
                    && propertyType.GetGenericTypeDefinition() == typeof(IList<>)
                    && propertyType.GetGenericArguments().Length == 1
                    && propertyType.GetGenericArguments()[0] == typeof(int);
            }
            catch { return false; }
        }

        private static bool HasExactEditorAttribute(
            Type componentType,
            string propertyName,
            string expectedEditorTypeName,
            string expectedBaseTypeName)
        {
            try
            {
                System.Reflection.PropertyInfo? property = componentType.GetProperty(
                    propertyName,
                    BindingFlags.Instance | BindingFlags.Public);
                if (property == null) return false;
                foreach (CustomAttributeData attribute in property.CustomAttributes)
                {
                    if (attribute.AttributeType.FullName != typeof(EditorAttribute).FullName
                        || attribute.ConstructorArguments.Count != 2)
                        continue;
                    string editorTypeName = MetadataTypeName(attribute.ConstructorArguments[0]);
                    string baseTypeName = MetadataTypeName(attribute.ConstructorArguments[1]);
                    if (editorTypeName == expectedEditorTypeName && baseTypeName == expectedBaseTypeName)
                        return true;
                }
            }
            catch { /* incomplete or hostile metadata is not certified */ }
            return false;
        }

        private static string MetadataTypeName(CustomAttributeTypedArgument argument)
        {
            if (argument.Value is Type type) return type.FullName ?? "";
            if (argument.Value is not string text || string.IsNullOrWhiteSpace(text)) return "";
            int separator = text.IndexOf(',');
            return (separator < 0 ? text : text.Substring(0, separator)).Trim();
        }

        internal static bool TryGetRequestContract(
            DesignerUiTypeEditorRequest request,
            out DesignerUiTypeEditorContract contract,
            out string errorCode,
            out string reason)
        {
            contract = DesignerUiTypeEditorContract.None;
            errorCode = "";
            reason = "";

            if (IsSupported(request.EditorTypeName, request.ValueTypeName))
            {
                if (request.EditorAssemblyPath != null || request.EditorAssemblySha256 != null || request.EditorCertificationId != null
                    || request.CollectionItemTypeName != null || request.CollectionItems != null)
                {
                    errorCode = "unsupported_editor";
                    reason = "Scalar framework editors must not carry vendor or collection fields.";
                    return false;
                }
                contract = DesignerUiTypeEditorContract.Framework;
                return true;
            }

            if (IsSupportedCollectionEditor(request.EditorTypeName, request.ValueTypeName))
            {
                if (request.EditorAssemblyPath != null || request.EditorAssemblySha256 != null || request.EditorCertificationId != null
                    || string.IsNullOrEmpty(request.CollectionItemTypeName) || request.CollectionItems == null)
                {
                    errorCode = "unsupported_editor";
                    reason = "Framework CollectionEditor requests require only a bounded item type and item list.";
                    return false;
                }
                contract = DesignerUiTypeEditorContract.FrameworkCollection;
                return true;
            }

            if (request.EditorTypeName == FakeVendorCollectionEditorTypeName
                && request.ValueTypeName == CollectionValueTypeName
                && request.EditorCertificationId == FakeVendorCollectionCertificationId
                && request.CollectionItemTypeName == FakeVendorCollectionItemTypeName
                && request.CollectionItems != null)
            {
                if (!TryNormalizeVendorAssembly(request.EditorAssemblyPath, request.EditorAssemblySha256,
                        out string collectionPath, out reason))
                {
                    errorCode = "unsupported_editor";
                    return false;
                }
                contract = DesignerUiTypeEditorContract.CertifiedVendorCollection(collectionPath);
                return true;
            }

            if (request.EditorTypeName != FakeVendorEditorTypeName
                || request.ValueTypeName != FakeVendorValueTypeName
                || request.EditorCertificationId != FakeVendorCertificationId
                || request.CollectionItemTypeName != null || request.CollectionItems != null)
            {
                errorCode = "unsupported_editor";
                reason = "The requested editor and value type pair is not supported.";
                return false;
            }

            if (!TryNormalizeVendorAssembly(request.EditorAssemblyPath, request.EditorAssemblySha256, out string path, out reason))
            {
                errorCode = "unsupported_editor";
                return false;
            }

            contract = DesignerUiTypeEditorContract.CertifiedVendor(path);
            return true;
        }

        internal static bool IsSafeRequestId(string requestId)
        {
            if (string.IsNullOrEmpty(requestId) || requestId.Length > MaximumRequestIdLength) return false;
            foreach (char c in requestId)
            {
                if (!(char.IsAsciiLetterOrDigit(c) || c is '-' or '_' or '.' or ':')) return false;
            }
            return true;
        }

        internal static bool IsSafeInvariantValue(string typeName, string value) =>
            value != null && value.Length <= MaximumInvariantValueLength
            && value.IndexOf('\0') < 0
            && DesignerValueConverter.ToExpression(typeName, value) != null;

        internal static bool IsSafeRequestValue(DesignerUiTypeEditorRequest request, string value)
        {
            if (!TryGetRequestContract(request, out DesignerUiTypeEditorContract contract, out _, out _)) return false;
            return contract.Kind switch
            {
                DesignerUiTypeEditorContractKind.CertifiedVendor => IsSafeVendorStringValue(value),
                DesignerUiTypeEditorContractKind.FrameworkCollection
                    or DesignerUiTypeEditorContractKind.CertifiedVendorCollection => value.Length == 0
                    && IsSafeCollectionItems(request.CollectionItemTypeName, request.CollectionItems),
                _ => IsSafeInvariantValue(request.ValueTypeName, value),
            };
        }

        internal static bool IsSafeWorkerResultValue(DesignerUiTypeEditorRequest request, string value) =>
            IsSafeRequestValue(request, value);

        internal static bool IsSafeCollectionItems(string? itemTypeName, IReadOnlyList<string>? items)
        {
            if (string.IsNullOrEmpty(itemTypeName) || itemTypeName.Length > MaximumTypeNameLength || items == null
                || items.Count > MaximumCollectionItems) return false;
            foreach (string item in items)
                if (item == null || item.Length > MaximumCollectionItemLength || item.IndexOf('\0') >= 0) return false;
            return DesignerGenericListEditor.AreItemsSupported(itemTypeName, items);
        }

        internal static bool TryGetWorkerErrorReason(string errorCode, out string reason) =>
            WorkerErrorReasons.TryGetValue(errorCode, out reason!);

        private static string Pair(string editorTypeName, string valueTypeName) =>
            editorTypeName + "\0" + valueTypeName;

        private static bool TryNormalizeVendorAssembly(
            string? rawPath,
            string? rawSha256,
            out string path,
            out string reason)
        {
            path = "";
            reason = "";
            if (string.IsNullOrWhiteSpace(rawPath) || string.IsNullOrWhiteSpace(rawSha256))
            {
                reason = "Certified vendor editor requests require an explicit assembly path and SHA-256.";
                return false;
            }
            if (!Path.IsPathFullyQualified(rawPath))
            {
                reason = "Certified vendor editor assembly path must be absolute.";
                return false;
            }
            if (!IsHexSha256(rawSha256))
            {
                reason = "Certified vendor editor SHA-256 is invalid.";
                return false;
            }

            try
            {
                path = Path.GetFullPath(rawPath);
                if (!File.Exists(path))
                {
                    reason = "Certified vendor editor assembly was not found.";
                    return false;
                }
                if (!string.Equals(Path.GetFileName(path), FakeVendorAssemblyName + ".dll", StringComparison.OrdinalIgnoreCase)
                    || !string.Equals(AssemblyName.GetAssemblyName(path).Name, FakeVendorAssemblyName, StringComparison.Ordinal))
                {
                    reason = "Certified vendor editor assembly identity is not authorized.";
                    return false;
                }
                string actual = ComputeSha256(path);
                if (!string.Equals(actual, rawSha256, StringComparison.OrdinalIgnoreCase))
                {
                    reason = "Certified vendor editor assembly hash did not match.";
                    return false;
                }
                return true;
            }
            catch
            {
                reason = "Certified vendor editor assembly could not be verified.";
                return false;
            }
        }

        private static bool IsSafeVendorStringValue(string value) =>
            value != null && value.Length <= MaximumInvariantValueLength && value.IndexOf('\0') < 0;

        private static bool IsHexSha256(string value)
        {
            if (value.Length != 64) return false;
            foreach (char c in value)
            {
                bool hex = c is >= '0' and <= '9' or >= 'a' and <= 'f' or >= 'A' and <= 'F';
                if (!hex) return false;
            }
            return true;
        }

        private static string ComputeSha256(string path)
        {
            using var stream = File.OpenRead(path);
            byte[] hash = SHA256.HashData(stream);
            return Convert.ToHexString(hash).ToLowerInvariant();
        }
    }

    internal enum DesignerUiTypeEditorContractKind
    {
        None,
        Framework,
        FrameworkCollection,
        CertifiedVendor,
        CertifiedVendorCollection,
    }

    internal readonly struct DesignerUiTypeEditorContract
    {
        public static DesignerUiTypeEditorContract None => new(DesignerUiTypeEditorContractKind.None, "");
        public static DesignerUiTypeEditorContract Framework => new(DesignerUiTypeEditorContractKind.Framework, "");
        public static DesignerUiTypeEditorContract FrameworkCollection =>
            new(DesignerUiTypeEditorContractKind.FrameworkCollection, "");
        public static DesignerUiTypeEditorContract CertifiedVendor(string assemblyPath) =>
            new(DesignerUiTypeEditorContractKind.CertifiedVendor, assemblyPath);
        public static DesignerUiTypeEditorContract CertifiedVendorCollection(string assemblyPath) =>
            new(DesignerUiTypeEditorContractKind.CertifiedVendorCollection, assemblyPath);

        private DesignerUiTypeEditorContract(DesignerUiTypeEditorContractKind kind, string assemblyPath)
        {
            Kind = kind;
            AssemblyPath = assemblyPath;
        }

        public DesignerUiTypeEditorContractKind Kind { get; }
        public string AssemblyPath { get; }
    }

    /// <summary>
    /// Bounded coordinator for an isolated UITypeEditor process. It validates the request before process creation,
    /// applies one broker-owned timeout (requests cannot extend it), cancels the runner on caller cancellation or
    /// timeout, strictly validates the child response, and re-validates the returned invariant value through the
    /// existing source-safe value converter. It never throws for worker or wire failures.
    /// </summary>
    public sealed class DesignerUiTypeEditorBroker
    {
        public static readonly TimeSpan DefaultTimeout = TimeSpan.FromSeconds(30);
        private static readonly TimeSpan MinimumTimeout = TimeSpan.FromMilliseconds(10);
        private static readonly TimeSpan MaximumTimeout = TimeSpan.FromMinutes(2);

        private readonly IDesignerUiTypeEditorProcessRunner _runner;
        private readonly TimeSpan _timeout;

        public DesignerUiTypeEditorBroker(IDesignerUiTypeEditorProcessRunner runner)
            : this(runner, DefaultTimeout)
        {
        }

        /// <summary>The timeout is constructor-owned (not request-controlled). The overload exists so deterministic
        /// tests and hosts with a stricter policy can use a smaller fixed bound.</summary>
        public DesignerUiTypeEditorBroker(IDesignerUiTypeEditorProcessRunner runner, TimeSpan timeout)
        {
            _runner = runner ?? throw new ArgumentNullException(nameof(runner));
            if (timeout < MinimumTimeout || timeout > MaximumTimeout)
                throw new ArgumentOutOfRangeException(nameof(timeout), "UITypeEditor timeout must be between 10 ms and 2 minutes.");
            _timeout = timeout;
        }

        public async Task<DesignerUiTypeEditorBrokerResult> EditAsync(
            DesignerUiTypeEditorRequest request,
            CancellationToken cancellationToken = default)
        {
            if (cancellationToken.IsCancellationRequested) return Error("request_cancelled", "The editor request was cancelled.");
            if (request == null) return Error("invalid_request", "The editor request is required.");
            if (request.ProtocolVersion != DesignerUiTypeEditorWireProtocol.ProtocolVersion)
                return Error("protocol_mismatch", "The editor request protocol version is unsupported.");
            if (!DesignerUiTypeEditorPolicy.IsSafeRequestId(request.RequestId))
                return Error("invalid_request", "The editor request id is invalid.");
            string contractErrorCode = "";
            string contractReason = "";
            bool contractSupported = !string.IsNullOrEmpty(request.EditorTypeName)
                && !string.IsNullOrEmpty(request.ValueTypeName)
                && request.EditorTypeName.Length <= DesignerUiTypeEditorPolicy.MaximumTypeNameLength
                && request.ValueTypeName.Length <= DesignerUiTypeEditorPolicy.MaximumTypeNameLength
                && DesignerUiTypeEditorPolicy.TryGetRequestContract(request, out _, out contractErrorCode, out contractReason);
            if (!contractSupported
                || string.IsNullOrEmpty(request.EditorTypeName) || string.IsNullOrEmpty(request.ValueTypeName)
                || request.EditorTypeName.Length > DesignerUiTypeEditorPolicy.MaximumTypeNameLength
                || request.ValueTypeName.Length > DesignerUiTypeEditorPolicy.MaximumTypeNameLength)
                return Error(
                    string.IsNullOrEmpty(contractErrorCode) ? "unsupported_editor" : contractErrorCode,
                    string.IsNullOrEmpty(contractReason) ? "The requested editor and value type pair is not supported." : contractReason);
            if (!DesignerUiTypeEditorPolicy.IsSafeRequestValue(request, request.InvariantValue))
                return Error("invalid_value", "The current value cannot be represented safely by the supported editor.");

            string requestJson;
            try
            {
                requestJson = DesignerUiTypeEditorWireProtocol.SerializeRequest(request);
            }
            catch
            {
                return Error("invalid_request", "The editor request could not be serialized.");
            }

            using var runnerCancellation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            Task<DesignerUiTypeEditorProcessOutput> runTask;
            try
            {
                runTask = _runner.RunAsync(requestJson, runnerCancellation.Token);
                if (runTask == null) return Error("worker_failed", "The editor worker did not start.");
            }
            catch
            {
                return Error("worker_failed", "The editor worker did not start.");
            }

            DesignerUiTypeEditorProcessOutput output;
            try
            {
                output = await runTask.WaitAsync(_timeout, cancellationToken).ConfigureAwait(false);
            }
            catch (TimeoutException)
            {
                runnerCancellation.Cancel();
                ObserveLateFault(runTask);
                return Error("editor_timeout", "The editor worker exceeded its fixed time limit.");
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                runnerCancellation.Cancel();
                ObserveLateFault(runTask);
                return Error("request_cancelled", "The editor request was cancelled.");
            }
            catch (OperationCanceledException)
            {
                runnerCancellation.Cancel();
                return Error("worker_cancelled", "The editor worker was cancelled.");
            }
            catch
            {
                runnerCancellation.Cancel();
                return Error("worker_failed", "The editor worker failed.");
            }

            if (output == null) return Error("worker_failed", "The editor worker returned no process result.");
            if (output.ExitCode != 0) return Error("worker_exit", "The editor worker exited unsuccessfully.");
            if (string.IsNullOrWhiteSpace(output.StandardOutput)
                || output.StandardOutput.Length > DesignerUiTypeEditorPolicy.MaximumWorkerOutputLength)
                return Error("malformed_output", "The editor worker returned malformed output.");

            DesignerUiTypeEditorWorkerResponse? response;
            try
            {
                response = DesignerUiTypeEditorWireProtocol.DeserializeWorkerResponse(output.StandardOutput);
            }
            catch (JsonException)
            {
                return Error("malformed_output", "The editor worker returned malformed output.");
            }
            catch
            {
                return Error("malformed_output", "The editor worker returned malformed output.");
            }

            if (response == null
                || response.ProtocolVersion != DesignerUiTypeEditorWireProtocol.ProtocolVersion
                || !string.Equals(response.RequestId, request.RequestId, StringComparison.Ordinal))
                return Error("malformed_output", "The editor worker returned malformed output.");

            if (string.Equals(response.Status, "applied", StringComparison.Ordinal))
            {
                if (!string.IsNullOrEmpty(response.ErrorCode) || !string.IsNullOrEmpty(response.ErrorMessage))
                    return Error(DesignerUiTypeEditorPolicy.InvalidEditorResultCode, "The editor worker returned an unsafe value.");
                DesignerUiTypeEditorPolicy.TryGetRequestContract(
                    request, out DesignerUiTypeEditorContract responseContract, out _, out _);
                bool collectionRequest = responseContract.Kind is
                    DesignerUiTypeEditorContractKind.FrameworkCollection
                    or DesignerUiTypeEditorContractKind.CertifiedVendorCollection;
                if (collectionRequest)
                {
                    if (response.InvariantValue != null
                        || !DesignerUiTypeEditorPolicy.IsSafeCollectionItems(request.CollectionItemTypeName, response.CollectionItems))
                        return Error(DesignerUiTypeEditorPolicy.InvalidEditorResultCode, "The editor worker returned an unsafe collection.");
                    return new DesignerUiTypeEditorBrokerResult
                    {
                        Ok = true,
                        Applied = true,
                        CollectionItems = response.CollectionItems,
                    };
                }
                if (response.CollectionItems != null || response.InvariantValue == null
                    || !DesignerUiTypeEditorPolicy.IsSafeWorkerResultValue(request, response.InvariantValue))
                    return Error(DesignerUiTypeEditorPolicy.InvalidEditorResultCode, "The editor worker returned an unsafe value.");
                return new DesignerUiTypeEditorBrokerResult
                {
                    Ok = true,
                    Applied = true,
                    InvariantValue = response.InvariantValue,
                };
            }

            if (string.Equals(response.Status, "dismissed", StringComparison.Ordinal))
            {
                if (response.InvariantValue != null || response.CollectionItems != null || !string.IsNullOrEmpty(response.ErrorCode)
                    || !string.IsNullOrEmpty(response.ErrorMessage))
                    return Error("malformed_output", "The editor worker returned malformed output.");
                return new DesignerUiTypeEditorBrokerResult { Ok = true, Dismissed = true };
            }

            if (string.Equals(response.Status, "error", StringComparison.Ordinal)
                && response.InvariantValue == null
                && response.CollectionItems == null
                && !string.IsNullOrEmpty(response.ErrorCode)
                && DesignerUiTypeEditorPolicy.TryGetWorkerErrorReason(response.ErrorCode, out string reason))
                return Error(response.ErrorCode, reason);

            return Error("malformed_output", "The editor worker returned malformed output.");
        }

        private static DesignerUiTypeEditorBrokerResult Error(string code, string reason) => new()
        {
            ErrorCode = code,
            Reason = reason,
        };

        private static void ObserveLateFault(Task task)
        {
            _ = task.ContinueWith(
                static completed => _ = completed.Exception,
                CancellationToken.None,
                TaskContinuationOptions.ExecuteSynchronously | TaskContinuationOptions.OnlyOnFaulted,
                TaskScheduler.Default);
        }
    }
}
