using System;
using System.Collections.Generic;
using System.Collections;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Design;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using System.Windows.Forms.Design;

namespace WinFormsDesigner.Engine
{
    /// <summary>Result of the worker-side editor seam. Production uses the framework invoker below; tests inject a
    /// noninteractive implementation so automation never opens a modal window.</summary>
    public sealed class DesignerUiTypeEditorInvocationResult
    {
        public bool Applied { get; init; }
        public bool Dismissed { get; init; }
        public string? InvariantValue { get; init; }
        public List<string>? CollectionItems { get; init; }
        public string? ResultValueTypeName { get; init; }
        public string? ResultCollectionItemTypeName { get; init; }
        public string? DismissalReason { get; init; }
        public string? ErrorCode { get; init; }
    }

    public interface IDesignerUiTypeEditorInvoker
    {
        DesignerUiTypeEditorInvocationResult Invoke(DesignerUiTypeEditorRequest request);
    }

    /// <summary>
    /// Exported child-process entrypoint. Program integration should dispatch <c>--uitypeeditor-worker</c> here
    /// before starting the normal RPC dispatcher:
    /// <c>return await DesignerUiTypeEditorWorker.RunStandardIoAsync(Console.In, Console.Out, Console.Error);</c>.
    /// The method reads one bounded JSON request, invokes the trusted editor on a dedicated STA, and writes exactly
    /// one JSON response. It never writes diagnostics to stdout.
    /// </summary>
    public static class DesignerUiTypeEditorWorker
    {
        private const int MaximumRequestJsonLength = 256 * 1024;

        public static Task<int> RunStandardIoAsync(
            TextReader input,
            TextWriter output,
            TextWriter error,
            CancellationToken cancellationToken = default) =>
            RunStandardIoAsync(input, output, error, new FrameworkDesignerUiTypeEditorInvoker(), cancellationToken);

        public static async Task<int> RunStandardIoAsync(
            TextReader input,
            TextWriter output,
            TextWriter error,
            IDesignerUiTypeEditorInvoker invoker,
            CancellationToken cancellationToken = default)
        {
            if (input == null) throw new ArgumentNullException(nameof(input));
            if (output == null) throw new ArgumentNullException(nameof(output));
            if (error == null) throw new ArgumentNullException(nameof(error));
            if (invoker == null) throw new ArgumentNullException(nameof(invoker));

            DesignerUiTypeEditorRequest? request;
            try
            {
                string json = await ReadBoundedAsync(input, MaximumRequestJsonLength, cancellationToken).ConfigureAwait(false);
                request = DesignerUiTypeEditorWireProtocol.DeserializeRequest(json);
            }
            catch (OperationCanceledException)
            {
                await error.WriteLineAsync("UITypeEditor worker input was cancelled.").ConfigureAwait(false);
                return 3;
            }
            catch
            {
                await error.WriteLineAsync("UITypeEditor worker received an invalid request.").ConfigureAwait(false);
                return 2;
            }

            if (!IsValidRequest(request))
            {
                await error.WriteLineAsync("UITypeEditor worker rejected the request.").ConfigureAwait(false);
                return 2;
            }

            DesignerUiTypeEditorInvocationResult invocation;
            try
            {
                invocation = await InvokeOnStaAsync(invoker, request!, cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                invocation = new DesignerUiTypeEditorInvocationResult { ErrorCode = "worker_cancelled" };
            }
            catch
            {
                invocation = new DesignerUiTypeEditorInvocationResult { ErrorCode = "editor_failed" };
            }

            DesignerUiTypeEditorWorkerResponse response = ToWorkerResponse(request!, invocation);
            await output.WriteAsync(DesignerUiTypeEditorWireProtocol.SerializeWorkerResponse(response)).ConfigureAwait(false);
            await output.FlushAsync().ConfigureAwait(false);
            return 0;
        }

        private static bool IsValidRequest(DesignerUiTypeEditorRequest? request) =>
            request != null
            && request.ProtocolVersion == DesignerUiTypeEditorWireProtocol.ProtocolVersion
            && DesignerUiTypeEditorPolicy.IsSafeRequestId(request.RequestId)
            && DesignerUiTypeEditorPolicy.TryValidateUiContext(request.UiContext, out _)
            && !string.IsNullOrEmpty(request.EditorTypeName)
            && !string.IsNullOrEmpty(request.ValueTypeName)
            && request.EditorTypeName.Length <= DesignerUiTypeEditorPolicy.MaximumTypeNameLength
            && request.ValueTypeName.Length <= DesignerUiTypeEditorPolicy.MaximumTypeNameLength
            && DesignerUiTypeEditorPolicy.TryGetRequestContract(request, out _, out _, out _)
            && DesignerUiTypeEditorPolicy.IsSafeRequestValue(request, request.InvariantValue);

        private static DesignerUiTypeEditorWorkerResponse ToWorkerResponse(
            DesignerUiTypeEditorRequest request,
            DesignerUiTypeEditorInvocationResult? invocation)
        {
            if (request.UiContext != null && invocation != null
                && ((invocation.Applied && (invocation.DismissalReason != null
                    || !string.Equals(invocation.ResultValueTypeName, request.ValueTypeName, StringComparison.Ordinal)
                    || (IsCollectionContract(request)
                        ? !string.Equals(invocation.ResultCollectionItemTypeName, request.CollectionItemTypeName, StringComparison.Ordinal)
                        : invocation.ResultCollectionItemTypeName != null)))
                    || (invocation.Dismissed && (!DesignerUiTypeEditorPolicy.IsSafeDismissalReason(invocation.DismissalReason)
                        || invocation.ResultValueTypeName != null || invocation.ResultCollectionItemTypeName != null))))
                invocation = new DesignerUiTypeEditorInvocationResult { ErrorCode = DesignerUiTypeEditorPolicy.InvalidEditorResultCode };

            if (invocation?.Applied == true
                && !invocation.Dismissed
                && string.IsNullOrEmpty(invocation.ErrorCode)
                && IsCollectionContract(request)
                && invocation.InvariantValue == null
                && DesignerUiTypeEditorPolicy.IsSafeCollectionItems(request.CollectionItemTypeName, invocation.CollectionItems))
            {
                return new DesignerUiTypeEditorWorkerResponse
                {
                    RequestId = request.RequestId,
                    OwnerId = request.UiContext?.OwnerId,
                    FocusToken = request.UiContext?.FocusToken,
                    Status = "applied",
                    ResultValueTypeName = request.UiContext == null ? null : request.ValueTypeName,
                    ResultCollectionItemTypeName = request.UiContext == null ? null : request.CollectionItemTypeName,
                    CollectionItems = invocation.CollectionItems,
                };
            }

            if (invocation?.Applied == true
                && !invocation.Dismissed
                && string.IsNullOrEmpty(invocation.ErrorCode)
                && invocation.CollectionItems == null
                && invocation.InvariantValue != null
                && DesignerUiTypeEditorPolicy.IsSafeWorkerResultValue(request, invocation.InvariantValue))
            {
                return new DesignerUiTypeEditorWorkerResponse
                {
                    RequestId = request.RequestId,
                    OwnerId = request.UiContext?.OwnerId,
                    FocusToken = request.UiContext?.FocusToken,
                    Status = "applied",
                    ResultValueTypeName = request.UiContext == null ? null : request.ValueTypeName,
                    InvariantValue = invocation.InvariantValue,
                };
            }

            if (invocation?.Dismissed == true
                && !invocation.Applied
                && invocation.InvariantValue == null
                && invocation.CollectionItems == null
                && string.IsNullOrEmpty(invocation.ErrorCode))
            {
                return new DesignerUiTypeEditorWorkerResponse
                {
                    RequestId = request.RequestId,
                    OwnerId = request.UiContext?.OwnerId,
                    FocusToken = request.UiContext?.FocusToken,
                    Status = "dismissed",
                    DismissalReason = request.UiContext == null ? null : invocation.DismissalReason,
                };
            }

            string errorCode = invocation?.ErrorCode switch
            {
                "runtime_unsupported" => "runtime_unsupported",
                DesignerUiTypeEditorPolicy.NativeEditorUiUnsupportedCode => DesignerUiTypeEditorPolicy.NativeEditorUiUnsupportedCode,
                "HOST_EDITOR_UI_REQUIRED" => "HOST_EDITOR_UI_REQUIRED",
                "worker_cancelled" => "worker_cancelled",
                "conversion_failed" => "conversion_failed",
                DesignerUiTypeEditorPolicy.InvalidEditorResultCode => DesignerUiTypeEditorPolicy.InvalidEditorResultCode,
                _ => "editor_failed",
            };
            return new DesignerUiTypeEditorWorkerResponse
            {
                RequestId = request.RequestId,
                OwnerId = request.UiContext?.OwnerId,
                FocusToken = request.UiContext?.FocusToken,
                Status = "error",
                ErrorCode = errorCode,
            };
        }

        private static bool IsCollectionContract(DesignerUiTypeEditorRequest request)
        {
            if (!DesignerUiTypeEditorPolicy.TryGetRequestContract(
                    request, out DesignerUiTypeEditorContract contract, out _, out _)) return false;
            return contract.Kind is DesignerUiTypeEditorContractKind.FrameworkCollection
                or DesignerUiTypeEditorContractKind.CertifiedVendorCollection;
        }

        private static Task<DesignerUiTypeEditorInvocationResult> InvokeOnStaAsync(
            IDesignerUiTypeEditorInvoker invoker,
            DesignerUiTypeEditorRequest request,
            CancellationToken cancellationToken)
        {
            var completion = new TaskCompletionSource<DesignerUiTypeEditorInvocationResult>(
                TaskCreationOptions.RunContinuationsAsynchronously);
            var thread = new Thread(() =>
            {
                try { completion.TrySetResult(invoker.Invoke(request)); }
                catch (Exception ex) { completion.TrySetException(ex); }
            })
            {
                IsBackground = true,
                Name = "WinFormsDesigner.UITypeEditor",
            };
            thread.SetApartmentState(ApartmentState.STA);
            thread.Start();
            return completion.Task.WaitAsync(cancellationToken);
        }

        private static async Task<string> ReadBoundedAsync(
            TextReader reader,
            int maximumCharacters,
            CancellationToken cancellationToken)
        {
            char[] buffer = new char[4096];
            var text = new StringBuilder(Math.Min(maximumCharacters, 4096));
            while (true)
            {
                int read = await reader.ReadAsync(buffer.AsMemory(), cancellationToken).ConfigureAwait(false);
                if (read == 0) return text.ToString();
                if (text.Length > maximumCharacters - read) throw new InvalidDataException("Input exceeds the fixed bound.");
                text.Append(buffer, 0, read);
            }
        }
    }

    /// <summary>
    /// The only production editor implementation. Resolution is by direct framework types, never from a project
    /// assembly or EditorAttribute. Both supported values must round-trip through the existing invariant converter.
    /// </summary>
    internal sealed class FrameworkDesignerUiTypeEditorInvoker : IDesignerUiTypeEditorInvoker
    {
        public DesignerUiTypeEditorInvocationResult Invoke(DesignerUiTypeEditorRequest request)
        {
            if (!DesignerUiTypeEditorPolicy.TryGetRequestContract(
                    request,
                    out DesignerUiTypeEditorContract contract,
                    out _,
                    out _))
                return new DesignerUiTypeEditorInvocationResult { ErrorCode = "runtime_unsupported" };

            if (request.UiContext != null && request.UiContext.Presentation != "headless")
                return new DesignerUiTypeEditorInvocationResult { ErrorCode = "HOST_EDITOR_UI_REQUIRED" };
            if (contract.Kind is DesignerUiTypeEditorContractKind.Framework or DesignerUiTypeEditorContractKind.FrameworkCollection)
                return new DesignerUiTypeEditorInvocationResult { ErrorCode = DesignerUiTypeEditorPolicy.NativeEditorUiUnsupportedCode };

            return contract.Kind == DesignerUiTypeEditorContractKind.CertifiedVendor
                ? InvokeCertifiedVendor(request, contract)
                : InvokeCertifiedVendorCollection(request, contract);
        }

        private static DesignerUiTypeEditorInvocationResult InvokeCertifiedVendorCollection(
            DesignerUiTypeEditorRequest request,
            DesignerUiTypeEditorContract contract)
        {
            if (!DesignerUiTypeEditorPolicy.IsSafeCollectionItems(
                    request.CollectionItemTypeName, request.CollectionItems))
                return new DesignerUiTypeEditorInvocationResult { ErrorCode = "conversion_failed" };
            Type? itemType = ResolveCollectionItemType(request.CollectionItemTypeName!);
            if (itemType == null) return new DesignerUiTypeEditorInvocationResult { ErrorCode = "runtime_unsupported" };

            IList current;
            Type listType;
            UITypeEditor editor;
            try
            {
                listType = typeof(List<>).MakeGenericType(itemType);
                current = (IList)Activator.CreateInstance(listType)!;
                TypeConverter converter = TypeDescriptor.GetConverter(itemType);
                foreach (string invariant in request.CollectionItems!)
                {
                    object? value = converter.ConvertFromInvariantString(invariant);
                    if (value == null || !itemType.IsInstanceOfType(value))
                        return new DesignerUiTypeEditorInvocationResult { ErrorCode = "conversion_failed" };
                    current.Add(value);
                }

                Assembly assembly = Assembly.LoadFrom(contract.AssemblyPath);
                Type? editorType = assembly.GetType(request.EditorTypeName, throwOnError: false, ignoreCase: false);
                if (editorType == null || !typeof(UITypeEditor).IsAssignableFrom(editorType))
                    return new DesignerUiTypeEditorInvocationResult { ErrorCode = "runtime_unsupported" };
                editor = Activator.CreateInstance(editorType) as UITypeEditor
                    ?? throw new InvalidOperationException("Certified collection editor could not be created.");
            }
            catch
            {
                return new DesignerUiTypeEditorInvocationResult { ErrorCode = "runtime_unsupported" };
            }

            object? edited;
            try
            {
                using var service = new FrameworkEditorService();
                edited = editor.EditValue(context: null, provider: service, value: current);
                if (service.NativeUiRequested)
                    return new DesignerUiTypeEditorInvocationResult { ErrorCode = DesignerUiTypeEditorPolicy.NativeEditorUiUnsupportedCode };
            }
            catch
            {
                return new DesignerUiTypeEditorInvocationResult { ErrorCode = "editor_failed" };
            }

            if (edited is not IList editedItems || editedItems.Count > DesignerUiTypeEditorPolicy.MaximumCollectionItems)
                return new DesignerUiTypeEditorInvocationResult
                {
                    ErrorCode = DesignerUiTypeEditorPolicy.InvalidEditorResultCode,
                };

            var invariants = new List<string>(editedItems.Count);
            try
            {
                TypeConverter converter = TypeDescriptor.GetConverter(itemType);
                foreach (object? value in editedItems)
                {
                    if (value == null || !itemType.IsInstanceOfType(value))
                        return new DesignerUiTypeEditorInvocationResult
                        {
                            ErrorCode = DesignerUiTypeEditorPolicy.InvalidEditorResultCode,
                        };
                    string? invariant = converter.ConvertToInvariantString(value);
                    if (invariant == null) return new DesignerUiTypeEditorInvocationResult
                    {
                        ErrorCode = DesignerUiTypeEditorPolicy.InvalidEditorResultCode,
                    };
                    invariants.Add(invariant);
                }
            }
            catch
            {
                return new DesignerUiTypeEditorInvocationResult
                {
                    ErrorCode = DesignerUiTypeEditorPolicy.InvalidEditorResultCode,
                };
            }
            if (!DesignerUiTypeEditorPolicy.IsSafeCollectionItems(request.CollectionItemTypeName, invariants))
                return new DesignerUiTypeEditorInvocationResult
                {
                    ErrorCode = DesignerUiTypeEditorPolicy.InvalidEditorResultCode,
                };
            if (invariants.SequenceEqual(request.CollectionItems!, StringComparer.Ordinal))
                return new DesignerUiTypeEditorInvocationResult { Dismissed = true, DismissalReason = "unchanged" };
            return new DesignerUiTypeEditorInvocationResult
            {
                Applied = true, CollectionItems = invariants,
                ResultValueTypeName = request.ValueTypeName, ResultCollectionItemTypeName = request.CollectionItemTypeName,
            };
        }

        internal static UITypeEditor CreateFrameworkCollectionEditor(Type collectionType)
        {
            Assembly assembly = Assembly.Load(new AssemblyName("System.Windows.Forms.Design"));
            Type? editorType = assembly.GetType(
                DesignerUiTypeEditorPolicy.CollectionEditorTypeName,
                throwOnError: false,
                ignoreCase: false);
            if (editorType == null || !typeof(UITypeEditor).IsAssignableFrom(editorType))
                throw new InvalidOperationException("Framework CollectionEditor is unavailable.");
            object? editor = Activator.CreateInstance(editorType, new object[] { collectionType });
            return editor as UITypeEditor
                ?? throw new InvalidOperationException("Framework CollectionEditor could not be created.");
        }

        private static Type? ResolveCollectionItemType(string typeName)
        {
            if (!DesignerGenericListEditor.SupportsItemType(typeName)) return null;
            try
            {
                return Type.GetType(typeName, throwOnError: false, ignoreCase: false)
                    ?? typeof(Form).Assembly.GetType(typeName, throwOnError: false, ignoreCase: false)
                    ?? typeof(Color).Assembly.GetType(typeName, throwOnError: false, ignoreCase: false)
                    ?? typeof(object).Assembly.GetType(typeName, throwOnError: false, ignoreCase: false);
            }
            catch { return null; }
        }

        private static DesignerUiTypeEditorInvocationResult InvokeCertifiedVendor(
            DesignerUiTypeEditorRequest request,
            DesignerUiTypeEditorContract contract)
        {
            UITypeEditor editor;
            try
            {
                Assembly assembly = Assembly.LoadFrom(contract.AssemblyPath);
                Type? editorType = assembly.GetType(request.EditorTypeName, throwOnError: false, ignoreCase: false);
                if (editorType == null || !typeof(UITypeEditor).IsAssignableFrom(editorType))
                    return new DesignerUiTypeEditorInvocationResult { ErrorCode = "runtime_unsupported" };
                object? created = Activator.CreateInstance(editorType);
                if (created is not UITypeEditor typedEditor)
                    return new DesignerUiTypeEditorInvocationResult { ErrorCode = "runtime_unsupported" };
                editor = typedEditor;
            }
            catch
            {
                return new DesignerUiTypeEditorInvocationResult { ErrorCode = "runtime_unsupported" };
            }

            object? edited;
            try
            {
                using var service = new FrameworkEditorService();
                edited = editor.EditValue(context: null, provider: service, value: request.InvariantValue);
                if (service.NativeUiRequested)
                    return new DesignerUiTypeEditorInvocationResult { ErrorCode = DesignerUiTypeEditorPolicy.NativeEditorUiUnsupportedCode };
            }
            catch
            {
                return new DesignerUiTypeEditorInvocationResult { ErrorCode = "editor_failed" };
            }

            if (edited is not string invariant
                || !DesignerUiTypeEditorPolicy.IsSafeWorkerResultValue(request, invariant))
                return new DesignerUiTypeEditorInvocationResult
                {
                    ErrorCode = DesignerUiTypeEditorPolicy.InvalidEditorResultCode,
                };

            if (string.Equals(invariant, request.InvariantValue, StringComparison.Ordinal))
                return new DesignerUiTypeEditorInvocationResult { Dismissed = true, DismissalReason = "unchanged" };
            return new DesignerUiTypeEditorInvocationResult
            {
                Applied = true, InvariantValue = invariant, ResultValueTypeName = request.ValueTypeName,
            };
        }

        private sealed class FrameworkEditorService : IServiceProvider, IDisposable
        {
            public bool NativeUiRequested { get; private set; }

            public object? GetService(Type serviceType)
            {
                if (serviceType == typeof(IWindowsFormsEditorService)) NativeUiRequested = true;
                // No incomplete native editor service is advertised. The caller returns a named refusal even
                // when an editor reacts to the unavailable service by returning its unchanged input.
                return null;
            }

            public void Dispose() { }
        }
    }

    /// <summary>Creates the no-shell runner for the currently executing engine. Refuses to launch when called from
    /// a test host or another embedding process, so the worker target cannot accidentally become an arbitrary host.</summary>
    public static class DesignerUiTypeEditorProcessRunnerFactory
    {
        public static IDesignerUiTypeEditorProcessRunner CreateForCurrentEngine()
        {
            Assembly engineAssembly = typeof(DesignerUiTypeEditorWorker).Assembly;
            Assembly? entryAssembly = Assembly.GetEntryAssembly();
            if (entryAssembly == null || !string.Equals(
                    entryAssembly.GetName().Name,
                    engineAssembly.GetName().Name,
                    StringComparison.Ordinal))
                throw new InvalidOperationException("UITypeEditor worker runner must be created by the engine executable.");

            string? processPath = Environment.ProcessPath;
            if (string.IsNullOrWhiteSpace(processPath) || !Path.IsPathFullyQualified(processPath)
                || !File.Exists(processPath))
                throw new InvalidOperationException("The current engine executable path is unavailable.");

            var prefixArguments = new List<string>();
            if (string.Equals(Path.GetFileNameWithoutExtension(processPath), "dotnet", StringComparison.OrdinalIgnoreCase))
            {
                string entryPath = entryAssembly.Location;
                if (string.IsNullOrWhiteSpace(entryPath) || !Path.IsPathFullyQualified(entryPath) || !File.Exists(entryPath))
                    throw new InvalidOperationException("The current engine assembly path is unavailable.");
                prefixArguments.Add(entryPath);
            }
            return new CurrentEngineDesignerUiTypeEditorProcessRunner(processPath, prefixArguments);
        }
    }

    internal sealed class CurrentEngineDesignerUiTypeEditorProcessRunner : IDesignerUiTypeEditorProcessRunner
    {
        private const int MaximumRequestJsonLength = 32 * 1024;
        private const int MaximumErrorLength = 16 * 1024;
        private readonly string _executablePath;
        private readonly IReadOnlyList<string> _prefixArguments;

        internal CurrentEngineDesignerUiTypeEditorProcessRunner(
            string executablePath,
            IReadOnlyList<string> prefixArguments)
        {
            _executablePath = executablePath;
            _prefixArguments = prefixArguments;
        }

        public async Task<DesignerUiTypeEditorProcessOutput> RunAsync(
            string requestJson,
            CancellationToken cancellationToken)
        {
            if (string.IsNullOrWhiteSpace(requestJson) || requestJson.Length > MaximumRequestJsonLength)
                throw new ArgumentException("UITypeEditor worker request exceeds the fixed bound.", nameof(requestJson));

            var start = new ProcessStartInfo
            {
                FileName = _executablePath,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardInputEncoding = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false),
                StandardOutputEncoding = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false),
                StandardErrorEncoding = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false),
                WorkingDirectory = AppContext.BaseDirectory,
            };
            foreach (string argument in _prefixArguments) start.ArgumentList.Add(argument);
            start.ArgumentList.Add("--uitypeeditor-worker");
            start.Environment["WFD_UITYPEEDITOR_WORKER"] = "1";

            // The worker must end with the engine that started it (see EngineProcessJob); otherwise it does not run.
            if (!EngineProcessJob.HelpersAllowed)
                throw new InvalidOperationException("The UITypeEditor worker cannot be tied to the engine's lifetime.");
            using var process = new Process { StartInfo = start, EnableRaisingEvents = true };
            if (!process.Start()) throw new InvalidOperationException("The UITypeEditor worker did not start.");
            using CancellationTokenRegistration registration = cancellationToken.Register(
                static state => KillProcessTree((Process)state!), process);

            Task<string> stdout = ReadBoundedAsync(
                process.StandardOutput,
                DesignerUiTypeEditorPolicy.MaximumWorkerOutputLength,
                cancellationToken);
            Task<string> stderr = ReadBoundedAsync(process.StandardError, MaximumErrorLength, cancellationToken);
            try
            {
                await process.StandardInput.WriteAsync(requestJson.AsMemory(), cancellationToken).ConfigureAwait(false);
                await process.StandardInput.FlushAsync(cancellationToken).ConfigureAwait(false);
                process.StandardInput.Close();

                await process.WaitForExitAsync(cancellationToken).ConfigureAwait(false);
                string capturedOutput = await stdout.ConfigureAwait(false);
                string capturedError = await stderr.ConfigureAwait(false);
                return new DesignerUiTypeEditorProcessOutput
                {
                    ExitCode = process.ExitCode,
                    StandardOutput = capturedOutput,
                    StandardError = capturedError,
                };
            }
            catch
            {
                KillProcessTree(process);
                ObserveLateFault(stdout);
                ObserveLateFault(stderr);
                throw;
            }
        }

        private static async Task<string> ReadBoundedAsync(
            TextReader reader,
            int maximumCharacters,
            CancellationToken cancellationToken)
        {
            char[] buffer = new char[4096];
            var text = new StringBuilder(Math.Min(maximumCharacters, 4096));
            while (true)
            {
                int read = await reader.ReadAsync(buffer.AsMemory(), cancellationToken).ConfigureAwait(false);
                if (read == 0) return text.ToString();
                if (text.Length > maximumCharacters - read) throw new InvalidDataException("Worker output exceeds the fixed bound.");
                text.Append(buffer, 0, read);
            }
        }

        private static void KillProcessTree(Process process)
        {
            try
            {
                if (!process.HasExited) process.Kill(entireProcessTree: true);
            }
            catch
            {
                // Best effort: cancellation still returns to the broker, whose timeout is the outer safety bound.
            }
        }

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
