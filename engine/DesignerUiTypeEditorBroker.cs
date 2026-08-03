using System;
using System.Collections.Generic;
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
        public const int MaximumWorkerOutputLength = 64 * 1024;

        private static readonly HashSet<string> SupportedPairs = new(StringComparer.Ordinal)
        {
            Pair("System.Drawing.Design.ColorEditor", "System.Drawing.Color"),
            Pair("System.Drawing.Design.FontEditor", "System.Drawing.Font"),
        };

        private static readonly IReadOnlyDictionary<string, string> WorkerErrorReasons =
            new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["editor_failed"] = "The supported editor could not complete.",
                ["conversion_failed"] = "The editor result could not be converted to a supported invariant value.",
                ["runtime_unsupported"] = "The supported editor is unavailable in this runtime.",
                ["worker_cancelled"] = "The editor worker was cancelled.",
            };

        public static bool IsSupported(string editorTypeName, string valueTypeName) =>
            editorTypeName != null && valueTypeName != null && SupportedPairs.Contains(Pair(editorTypeName, valueTypeName));

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

        internal static bool TryGetWorkerErrorReason(string errorCode, out string reason) =>
            WorkerErrorReasons.TryGetValue(errorCode, out reason!);

        private static string Pair(string editorTypeName, string valueTypeName) =>
            editorTypeName + "\0" + valueTypeName;
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
            if (string.IsNullOrEmpty(request.EditorTypeName) || string.IsNullOrEmpty(request.ValueTypeName)
                || request.EditorTypeName.Length > DesignerUiTypeEditorPolicy.MaximumTypeNameLength
                || request.ValueTypeName.Length > DesignerUiTypeEditorPolicy.MaximumTypeNameLength
                || !DesignerUiTypeEditorPolicy.IsSupported(request.EditorTypeName, request.ValueTypeName))
                return Error("unsupported_editor", "The requested editor and value type pair is not supported.");
            if (!DesignerUiTypeEditorPolicy.IsSafeInvariantValue(request.ValueTypeName, request.InvariantValue))
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
                if (!string.IsNullOrEmpty(response.ErrorCode) || !string.IsNullOrEmpty(response.ErrorMessage)
                    || response.InvariantValue == null
                    || !DesignerUiTypeEditorPolicy.IsSafeInvariantValue(request.ValueTypeName, response.InvariantValue))
                    return Error("invalid_result", "The editor worker returned an unsafe value.");
                return new DesignerUiTypeEditorBrokerResult
                {
                    Ok = true,
                    Applied = true,
                    InvariantValue = response.InvariantValue,
                };
            }

            if (string.Equals(response.Status, "dismissed", StringComparison.Ordinal))
            {
                if (response.InvariantValue != null || !string.IsNullOrEmpty(response.ErrorCode)
                    || !string.IsNullOrEmpty(response.ErrorMessage))
                    return Error("malformed_output", "The editor worker returned malformed output.");
                return new DesignerUiTypeEditorBrokerResult { Ok = true, Dismissed = true };
            }

            if (string.Equals(response.Status, "error", StringComparison.Ordinal)
                && response.InvariantValue == null
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
