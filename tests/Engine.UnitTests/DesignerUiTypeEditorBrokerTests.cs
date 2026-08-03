using System.Text.Json;
using WinFormsDesigner.Engine;

namespace Engine.UnitTests;

public sealed class DesignerUiTypeEditorBrokerTests
{
    [Fact]
    public async Task EditAsync_AppliedFrameworkValue_ReturnsValidatedValueAndStableWireRequest()
    {
        string? capturedJson = null;
        var runner = new DelegateRunner((json, _) =>
        {
            capturedJson = json;
            return Task.FromResult(Output(Response("request-1", "applied", "Blue")));
        });
        var broker = new DesignerUiTypeEditorBroker(runner);

        DesignerUiTypeEditorBrokerResult result = await broker.EditAsync(ColorRequest());

        Assert.True(result.Ok, result.Reason);
        Assert.True(result.Applied);
        Assert.False(result.Dismissed);
        Assert.Equal("Blue", result.InvariantValue);
        Assert.NotNull(capturedJson);
        using JsonDocument request = JsonDocument.Parse(capturedJson);
        Assert.Equal(1, request.RootElement.GetProperty("protocolVersion").GetInt32());
        Assert.Equal("request-1", request.RootElement.GetProperty("requestId").GetString());
        Assert.Equal("System.Drawing.Design.ColorEditor", request.RootElement.GetProperty("editorTypeName").GetString());
        Assert.Equal("System.Drawing.Color", request.RootElement.GetProperty("valueTypeName").GetString());
        Assert.Equal("Red", request.RootElement.GetProperty("invariantValue").GetString());
    }

    [Fact]
    public async Task EditAsync_UserDismissedEditor_IsSuccessfulNoOp()
    {
        var runner = new DelegateRunner((_, _) =>
            Task.FromResult(Output(Response("request-1", "dismissed"))));

        DesignerUiTypeEditorBrokerResult result =
            await new DesignerUiTypeEditorBroker(runner).EditAsync(ColorRequest());

        Assert.True(result.Ok, result.Reason);
        Assert.False(result.Applied);
        Assert.True(result.Dismissed);
        Assert.Null(result.InvariantValue);
    }

    [Fact]
    public async Task EditAsync_UnsupportedEditorPair_RefusesBeforeStartingWorker()
    {
        var runner = new DelegateRunner((_, _) => throw new InvalidOperationException("must not run"));
        DesignerUiTypeEditorRequest request = WithEditor(ColorRequest(), "Custom.Project.DangerousEditor");

        DesignerUiTypeEditorBrokerResult result =
            await new DesignerUiTypeEditorBroker(runner).EditAsync(request);

        Assert.False(result.Ok);
        Assert.Equal("unsupported_editor", result.ErrorCode);
        Assert.Equal(0, runner.CallCount);
    }

    [Fact]
    public async Task EditAsync_CallerCancellation_CancelsRunnerAndReturnsDeterministicError()
    {
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var runnerCancelled = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var runner = new DelegateRunner(async (_, token) =>
        {
            using var registration = token.Register(() => runnerCancelled.TrySetResult());
            started.TrySetResult();
            await Task.Delay(Timeout.InfiniteTimeSpan, token);
            throw new InvalidOperationException("unreachable");
        });
        using var cancellation = new CancellationTokenSource();
        var broker = new DesignerUiTypeEditorBroker(runner);

        Task<DesignerUiTypeEditorBrokerResult> edit = broker.EditAsync(ColorRequest(), cancellation.Token);
        await started.Task.WaitAsync(TimeSpan.FromSeconds(2));
        cancellation.Cancel();
        DesignerUiTypeEditorBrokerResult result = await edit;

        Assert.False(result.Ok);
        Assert.Equal("request_cancelled", result.ErrorCode);
        await runnerCancelled.Task.WaitAsync(TimeSpan.FromSeconds(2));
    }

    [Fact]
    public async Task EditAsync_FixedTimeout_CancelsRunnerAndReturnsTimeout()
    {
        var runnerCancelled = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var runner = new DelegateRunner(async (_, token) =>
        {
            using var registration = token.Register(() => runnerCancelled.TrySetResult());
            await Task.Delay(Timeout.InfiniteTimeSpan, token);
            throw new InvalidOperationException("unreachable");
        });
        var broker = new DesignerUiTypeEditorBroker(runner, TimeSpan.FromMilliseconds(40));

        DesignerUiTypeEditorBrokerResult result = await broker.EditAsync(ColorRequest());

        Assert.False(result.Ok);
        Assert.Equal("editor_timeout", result.ErrorCode);
        await runnerCancelled.Task.WaitAsync(TimeSpan.FromSeconds(2));
    }

    [Theory]
    [InlineData("not-json")]
    [InlineData("{\"protocolVersion\":1,\"requestId\":\"request-1\",\"status\":\"dismissed\",\"unexpected\":true}")]
    [InlineData("{\"protocolVersion\":1,\"requestId\":\"other-request\",\"status\":\"dismissed\"}")]
    public async Task EditAsync_MalformedOrMismatchedWorkerOutput_FailsClosed(string stdout)
    {
        var runner = new DelegateRunner((_, _) => Task.FromResult(Output(stdout)));

        DesignerUiTypeEditorBrokerResult result =
            await new DesignerUiTypeEditorBroker(runner).EditAsync(ColorRequest());

        Assert.False(result.Ok);
        Assert.Equal("malformed_output", result.ErrorCode);
    }

    [Fact]
    public async Task EditAsync_AppliedUnrepresentableValue_RejectsWorkerResult()
    {
        var runner = new DelegateRunner((_, _) =>
            Task.FromResult(Output(Response("request-1", "applied", "not-a-color"))));

        DesignerUiTypeEditorBrokerResult result =
            await new DesignerUiTypeEditorBroker(runner).EditAsync(ColorRequest());

        Assert.False(result.Ok);
        Assert.Equal("invalid_result", result.ErrorCode);
    }

    [Fact]
    public async Task EditAsync_NonzeroExit_DoesNotTrustStdout()
    {
        var runner = new DelegateRunner((_, _) => Task.FromResult(new DesignerUiTypeEditorProcessOutput
        {
            ExitCode = 7,
            StandardOutput = Response("request-1", "applied", "Blue"),
            StandardError = "platform-specific diagnostic that must not cross the broker boundary",
        }));

        DesignerUiTypeEditorBrokerResult result =
            await new DesignerUiTypeEditorBroker(runner).EditAsync(ColorRequest());

        Assert.False(result.Ok);
        Assert.Equal("worker_exit", result.ErrorCode);
        Assert.DoesNotContain("platform-specific", result.Reason, StringComparison.Ordinal);
    }

    [Fact]
    public async Task EditAsync_KnownWorkerError_MapsToStableBrokerReason()
    {
        string json = DesignerUiTypeEditorWireProtocol.SerializeWorkerResponse(new DesignerUiTypeEditorWorkerResponse
        {
            RequestId = "request-1",
            Status = "error",
            ErrorCode = "runtime_unsupported",
            ErrorMessage = "localized framework loader details",
        });
        var runner = new DelegateRunner((_, _) => Task.FromResult(Output(json)));

        DesignerUiTypeEditorBrokerResult result =
            await new DesignerUiTypeEditorBroker(runner).EditAsync(ColorRequest());

        Assert.False(result.Ok);
        Assert.Equal("runtime_unsupported", result.ErrorCode);
        Assert.Equal("The supported editor is unavailable in this runtime.", result.Reason);
        Assert.DoesNotContain("localized", result.Reason, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Worker_AppliedResult_RunsInvokerOnStaAndWritesOneProtocolResponse()
    {
        ApartmentState apartment = ApartmentState.Unknown;
        var invoker = new DelegateInvoker(_ =>
        {
            apartment = Thread.CurrentThread.GetApartmentState();
            return new DesignerUiTypeEditorInvocationResult { Applied = true, InvariantValue = "Blue" };
        });
        using var input = new StringReader(DesignerUiTypeEditorWireProtocol.SerializeRequest(ColorRequest()));
        using var output = new StringWriter();
        using var error = new StringWriter();

        int exitCode = await DesignerUiTypeEditorWorker.RunStandardIoAsync(input, output, error, invoker);

        Assert.Equal(0, exitCode);
        Assert.Equal(ApartmentState.STA, apartment);
        Assert.Equal("", error.ToString());
        using JsonDocument response = JsonDocument.Parse(output.ToString());
        Assert.Equal(1, response.RootElement.GetProperty("protocolVersion").GetInt32());
        Assert.Equal("request-1", response.RootElement.GetProperty("requestId").GetString());
        Assert.Equal("applied", response.RootElement.GetProperty("status").GetString());
        Assert.Equal("Blue", response.RootElement.GetProperty("invariantValue").GetString());
    }

    [Fact]
    public async Task Worker_InvalidRequest_ExitsWithoutInvokingEditorOrWritingStdout()
    {
        var invoker = new DelegateInvoker(_ => throw new InvalidOperationException("must not run"));
        using var input = new StringReader("{ not json }");
        using var output = new StringWriter();
        using var error = new StringWriter();

        int exitCode = await DesignerUiTypeEditorWorker.RunStandardIoAsync(input, output, error, invoker);

        Assert.Equal(2, exitCode);
        Assert.Equal(0, invoker.CallCount);
        Assert.Equal("", output.ToString());
        Assert.Contains("invalid request", error.ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task Worker_InvokerFailure_WritesDeterministicErrorEnvelope()
    {
        var invoker = new DelegateInvoker(_ => throw new InvalidOperationException("localized vendor detail"));
        using var input = new StringReader(DesignerUiTypeEditorWireProtocol.SerializeRequest(ColorRequest()));
        using var output = new StringWriter();
        using var error = new StringWriter();

        int exitCode = await DesignerUiTypeEditorWorker.RunStandardIoAsync(input, output, error, invoker);

        Assert.Equal(0, exitCode);
        Assert.Equal("", error.ToString());
        Assert.DoesNotContain("localized", output.ToString(), StringComparison.Ordinal);
        using JsonDocument response = JsonDocument.Parse(output.ToString());
        Assert.Equal("error", response.RootElement.GetProperty("status").GetString());
        Assert.Equal("editor_failed", response.RootElement.GetProperty("errorCode").GetString());
    }

    [Fact]
    public async Task Worker_Cancellation_ReturnsWorkerCancelledEnvelopeWithoutWaitingForInvoker()
    {
        using var release = new ManualResetEventSlim();
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var invoker = new DelegateInvoker(_ =>
        {
            started.TrySetResult();
            release.Wait();
            return new DesignerUiTypeEditorInvocationResult { Dismissed = true };
        });
        using var input = new StringReader(DesignerUiTypeEditorWireProtocol.SerializeRequest(ColorRequest()));
        using var output = new StringWriter();
        using var error = new StringWriter();
        using var cancellation = new CancellationTokenSource();

        Task<int> worker = DesignerUiTypeEditorWorker.RunStandardIoAsync(input, output, error, invoker, cancellation.Token);
        await started.Task.WaitAsync(TimeSpan.FromSeconds(2));
        cancellation.Cancel();
        int exitCode = await worker;
        release.Set();

        Assert.Equal(0, exitCode);
        using JsonDocument response = JsonDocument.Parse(output.ToString());
        Assert.Equal("error", response.RootElement.GetProperty("status").GetString());
        Assert.Equal("worker_cancelled", response.RootElement.GetProperty("errorCode").GetString());
    }

    [Fact]
    public void ProcessRunnerFactory_OutsideEngineEntryAssembly_RefusesToLaunchEmbeddingHost()
    {
        InvalidOperationException error = Assert.Throws<InvalidOperationException>(
            () => DesignerUiTypeEditorProcessRunnerFactory.CreateForCurrentEngine());

        Assert.Contains("engine executable", error.Message, StringComparison.Ordinal);
    }

    private static DesignerUiTypeEditorRequest ColorRequest() => new()
    {
        RequestId = "request-1",
        EditorTypeName = "System.Drawing.Design.ColorEditor",
        ValueTypeName = "System.Drawing.Color",
        InvariantValue = "Red",
    };

    private static DesignerUiTypeEditorRequest WithEditor(DesignerUiTypeEditorRequest request, string editor) => new()
    {
        ProtocolVersion = request.ProtocolVersion,
        RequestId = request.RequestId,
        EditorTypeName = editor,
        ValueTypeName = request.ValueTypeName,
        InvariantValue = request.InvariantValue,
    };

    private static DesignerUiTypeEditorProcessOutput Output(string stdout) => new()
    {
        ExitCode = 0,
        StandardOutput = stdout,
    };

    private static string Response(string requestId, string status, string? invariantValue = null) =>
        DesignerUiTypeEditorWireProtocol.SerializeWorkerResponse(new DesignerUiTypeEditorWorkerResponse
        {
            RequestId = requestId,
            Status = status,
            InvariantValue = invariantValue,
        });

    private sealed class DelegateRunner : IDesignerUiTypeEditorProcessRunner
    {
        private readonly Func<string, CancellationToken, Task<DesignerUiTypeEditorProcessOutput>> _run;

        public DelegateRunner(Func<string, CancellationToken, Task<DesignerUiTypeEditorProcessOutput>> run) =>
            _run = run;

        public int CallCount { get; private set; }

        public Task<DesignerUiTypeEditorProcessOutput> RunAsync(string requestJson, CancellationToken cancellationToken)
        {
            CallCount++;
            return _run(requestJson, cancellationToken);
        }
    }

    private sealed class DelegateInvoker : IDesignerUiTypeEditorInvoker
    {
        private readonly Func<DesignerUiTypeEditorRequest, DesignerUiTypeEditorInvocationResult> _invoke;

        public DelegateInvoker(Func<DesignerUiTypeEditorRequest, DesignerUiTypeEditorInvocationResult> invoke) =>
            _invoke = invoke;

        public int CallCount { get; private set; }

        public DesignerUiTypeEditorInvocationResult Invoke(DesignerUiTypeEditorRequest request)
        {
            CallCount++;
            return _invoke(request);
        }
    }
}
