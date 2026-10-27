using System.Text.Json;
using WinFormsDesigner.Engine;

namespace Engine.UnitTests;

public sealed class DesignerUiTypeEditorInteractionTests
{
    [Fact]
    public async Task Version2_AppliedResultRequiresExactOwnerFocusTypeAndInvariant()
    {
        DesignerUiTypeEditorRequest request = Request();
        var broker = Broker(Response(request, "applied", "Blue", resultType: request.ValueTypeName));

        DesignerUiTypeEditorBrokerResult result = await broker.EditAsync(request);

        Assert.True(result.Ok, result.Reason);
        Assert.True(result.Applied);
        Assert.Equal("Blue", result.InvariantValue);
        Assert.Equal("System.Drawing.Color", result.ResultValueTypeName);
        Assert.Equal(request.UiContext!.OwnerId, result.OwnerId);
        Assert.Equal(request.UiContext.FocusToken, result.FocusToken);
    }

    [Theory]
    [InlineData("owner", "stale_editor_context")]
    [InlineData("focus", "stale_editor_context")]
    [InlineData("type", "INVALID_EDITOR_RESULT")]
    [InlineData("missing-type", "INVALID_EDITOR_RESULT")]
    [InlineData("invariant", "INVALID_EDITOR_RESULT")]
    public async Task Version2_UnrelatedOrWrongTypedResultCannotBecomeAnAppliedValue(string fault, string expectedCode)
    {
        DesignerUiTypeEditorRequest request = Request();
        string output = Response(request, "applied", fault == "invariant" ? "not-a-color" : "Blue",
            owner: fault == "owner" ? "other-owner" : null,
            focus: fault == "focus" ? "other-focus" : null,
            resultType: fault == "missing-type" ? null : fault == "type" ? "System.String" : request.ValueTypeName);

        DesignerUiTypeEditorBrokerResult result = await Broker(output).EditAsync(request);

        Assert.False(result.Ok);
        Assert.False(result.Applied);
        Assert.Null(result.InvariantValue);
        Assert.Equal(expectedCode, result.ErrorCode);
    }

    [Theory]
    [InlineData("escape")]
    [InlineData("cancel")]
    [InlineData("unchanged")]
    public async Task Version2_ExplicitDismissalRestoresOwnershipWithoutAValueOrMutation(string reason)
    {
        DesignerUiTypeEditorRequest request = Request();
        DesignerUiTypeEditorBrokerResult result = await Broker(Response(request, "dismissed", dismissal: reason)).EditAsync(request);

        Assert.True(result.Ok, result.Reason);
        Assert.True(result.Dismissed);
        Assert.False(result.Applied);
        Assert.Equal(reason, result.DismissalReason);
        Assert.Null(result.InvariantValue);
        Assert.Equal(request.UiContext!.FocusToken, result.FocusToken);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("closed")]
    public async Task Version2_MissingOrUnknownDismissalReasonIsNotSilentlyCancel(string? reason)
    {
        DesignerUiTypeEditorRequest request = Request();
        DesignerUiTypeEditorBrokerResult result = await Broker(Response(request, "dismissed", dismissal: reason)).EditAsync(request);
        Assert.False(result.Ok);
        Assert.Equal("malformed_output", result.ErrorCode);
    }

    [Fact]
    public async Task Version2_CollectionResultMustRepeatTheExactItemType()
    {
        DesignerUiTypeEditorRequest request = new()
        {
            RequestId = "collection-ui-2",
            EditorTypeName = DesignerUiTypeEditorPolicy.CollectionEditorTypeName,
            ValueTypeName = DesignerUiTypeEditorPolicy.CollectionValueTypeName,
            CollectionItemTypeName = "System.Int32",
            CollectionItems = new List<string> { "1" },
            UiContext = new DesignerUiTypeEditorUiContext { OwnerId = Guid.NewGuid().ToString("N"), FocusToken = "focus-1" },
        };
        var response = new DesignerUiTypeEditorWorkerResponse
        {
            RequestId = request.RequestId, Status = "applied", OwnerId = request.UiContext.OwnerId,
            FocusToken = request.UiContext.FocusToken, ResultValueTypeName = request.ValueTypeName,
            ResultCollectionItemTypeName = "System.String", CollectionItems = new List<string> { "2" },
        };
        DesignerUiTypeEditorBrokerResult result = await Broker(DesignerUiTypeEditorWireProtocol.SerializeWorkerResponse(response)).EditAsync(request);
        Assert.False(result.Ok);
        Assert.Equal("INVALID_EDITOR_RESULT", result.ErrorCode);
    }

    [Theory]
    [InlineData("native-modal", false)]
    [InlineData("native-dropdown", false)]
    [InlineData("headless", true)]
    public async Task NativeWindowOwnershipIsExplicitlyRefusedBeforeStartingAWorker(string presentation, bool native)
    {
        var runner = new DelegateRunner((_, _) => throw new InvalidOperationException("must not start"));
        DesignerUiTypeEditorBrokerResult result = await new DesignerUiTypeEditorBroker(runner).EditAsync(Request(presentation: presentation, native: native));
        Assert.False(result.Ok);
        Assert.Equal("NATIVE_EDITOR_UI_UNSUPPORTED", result.ErrorCode);
        Assert.Equal(0, runner.Calls);
    }

    [Fact]
    public async Task Version2_NestedDepthIsRefusedBeforeStartingAWorker()
    {
        var runner = new DelegateRunner((_, _) => throw new InvalidOperationException("must not start"));
        DesignerUiTypeEditorBrokerResult result = await new DesignerUiTypeEditorBroker(runner).EditAsync(Request(depth: 1));
        Assert.Equal("nested_editor_invocation", result.ErrorCode);
        Assert.Equal(0, runner.Calls);
    }

    [Fact]
    public async Task Version2_ConcurrentOwnerIsRefusedAcrossBrokersAndReleasedAfterCompletion()
    {
        DesignerUiTypeEditorRequest request = Request();
        var pending = new TaskCompletionSource<DesignerUiTypeEditorProcessOutput>(TaskCreationOptions.RunContinuationsAsynchronously);
        var firstRunner = new DelegateRunner((_, _) => pending.Task);
        Task<DesignerUiTypeEditorBrokerResult> first = new DesignerUiTypeEditorBroker(firstRunner).EditAsync(request);
        var secondRunner = new DelegateRunner((_, _) => Task.FromResult(Output(Response(request, "dismissed", dismissal: "cancel"))));
        var secondBroker = new DesignerUiTypeEditorBroker(secondRunner);

        DesignerUiTypeEditorBrokerResult nested = await secondBroker.EditAsync(request);
        Assert.Equal("nested_editor_invocation", nested.ErrorCode);
        Assert.Equal(0, secondRunner.Calls);

        pending.SetResult(Output(Response(request, "dismissed", dismissal: "escape")));
        Assert.True((await first).Dismissed);
        Assert.True((await secondBroker.EditAsync(request)).Dismissed);
        Assert.Equal(1, secondRunner.Calls);
    }

    [Fact]
    public async Task Version2_TimeoutCancelsTheWorkerAndReleasesTheOwnerForANewInteraction()
    {
        DesignerUiTypeEditorRequest request = Request();
        var cancelled = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var runner = new DelegateRunner(async (_, token) =>
        {
            try { await Task.Delay(Timeout.Infinite, token); }
            catch (OperationCanceledException) { cancelled.TrySetResult(); throw; }
            throw new InvalidOperationException("unreachable");
        });
        DesignerUiTypeEditorBrokerResult timedOut = await new DesignerUiTypeEditorBroker(runner, TimeSpan.FromMilliseconds(40)).EditAsync(request);
        Assert.Equal("editor_timeout", timedOut.ErrorCode);
        await cancelled.Task.WaitAsync(TimeSpan.FromSeconds(2));
        DesignerUiTypeEditorBrokerResult retry = await Broker(Response(request, "dismissed", dismissal: "cancel")).EditAsync(request);
        Assert.True(retry.Dismissed, retry.Reason);
    }

    [Fact]
    public async Task Version2_RequestCancellationReleasesOwnerWithoutApplyingALateResult()
    {
        DesignerUiTypeEditorRequest request = Request();
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var runner = new DelegateRunner(async (_, token) =>
        {
            started.TrySetResult();
            await Task.Delay(Timeout.Infinite, token);
            throw new InvalidOperationException("unreachable");
        });
        using var cancellation = new CancellationTokenSource();
        Task<DesignerUiTypeEditorBrokerResult> pending = new DesignerUiTypeEditorBroker(runner).EditAsync(request, cancellation.Token);
        await started.Task.WaitAsync(TimeSpan.FromSeconds(2));
        cancellation.Cancel();
        DesignerUiTypeEditorBrokerResult result = await pending;
        Assert.False(result.Applied);
        Assert.Equal("request_cancelled", result.ErrorCode);
        Assert.Equal(request.UiContext!.FocusToken, result.FocusToken);
        Assert.True((await Broker(Response(request, "dismissed", dismissal: "cancel")).EditAsync(request)).Dismissed);
    }

    [Theory]
    [InlineData(1, "owner-1", "focus-1", "headless", 0)]
    [InlineData(2, "owner-1", "", "headless", 0)]
    [InlineData(2, "C:/project/Form1.cs", "focus-1", "headless", 0)]
    [InlineData(2, "owner-1", "focus-1", "arbitrary", 0)]
    [InlineData(2, "owner-1", "focus-1", "headless", -1)]
    public async Task Version2_InvalidInteractionContextIsRejectedBeforeWorker(int version, string owner, string focus, string presentation, int depth)
    {
        var request = new DesignerUiTypeEditorRequest
        {
            RequestId = "invalid-context", EditorTypeName = "System.Drawing.Design.ColorEditor",
            ValueTypeName = "System.Drawing.Color", InvariantValue = "Red",
            UiContext = new DesignerUiTypeEditorUiContext
            {
                Version = version, OwnerId = owner, FocusToken = focus, Presentation = presentation, InvocationDepth = depth,
            },
        };
        var runner = new DelegateRunner((_, _) => throw new InvalidOperationException("must not run"));
        DesignerUiTypeEditorBrokerResult result = await new DesignerUiTypeEditorBroker(runner).EditAsync(request);
        Assert.Equal("invalid_ui_context", result.ErrorCode);
        Assert.Equal(0, runner.Calls);
    }

    [Theory]
    [InlineData("System.Drawing.Design.ColorEditor", "System.Drawing.Color", "Red")]
    [InlineData("System.Drawing.Design.FontEditor", "System.Drawing.Font", "Segoe UI, 9pt")]
    public async Task ActualFrameworkWorker_RefusesNativeEditorsWithoutOpeningWindows(string editor, string type, string invariant)
    {
        var request = new DesignerUiTypeEditorRequest { RequestId = "native-refusal", EditorTypeName = editor, ValueTypeName = type, InvariantValue = invariant };
        using JsonDocument response = await RunWorker(request);
        Assert.Equal("error", response.RootElement.GetProperty("status").GetString());
        Assert.Equal("NATIVE_EDITOR_UI_UNSUPPORTED", response.RootElement.GetProperty("errorCode").GetString());
    }

    [Fact]
    public async Task ActualWorker_RefusesHostPresentationInsteadOfPretendingItOpenedHostUi()
    {
        using JsonDocument response = await RunWorker(Request(presentation: "host-modal"));
        Assert.Equal("error", response.RootElement.GetProperty("status").GetString());
        Assert.Equal("HOST_EDITOR_UI_REQUIRED", response.RootElement.GetProperty("errorCode").GetString());
    }

    [Fact]
    public async Task WorkerVersion2_DoesNotFillInAResultTypeTheInvokerDidNotProve()
    {
        DesignerUiTypeEditorRequest request = Request();
        using var input = new StringReader(DesignerUiTypeEditorWireProtocol.SerializeRequest(request));
        using var output = new StringWriter();
        using var error = new StringWriter();
        var invoker = new DelegateInvoker(_ => new DesignerUiTypeEditorInvocationResult
        {
            Applied = true, InvariantValue = "Blue", ResultValueTypeName = "System.String",
        });
        Assert.Equal(0, await DesignerUiTypeEditorWorker.RunStandardIoAsync(input, output, error, invoker));
        using JsonDocument response = JsonDocument.Parse(output.ToString());
        Assert.Equal("INVALID_EDITOR_RESULT", response.RootElement.GetProperty("errorCode").GetString());
        Assert.Equal(request.UiContext!.OwnerId, response.RootElement.GetProperty("ownerId").GetString());
        Assert.False(response.RootElement.TryGetProperty("invariantValue", out _));
    }

    private static DesignerUiTypeEditorRequest Request(string presentation = "headless", int depth = 0, bool native = false) => new()
    {
        RequestId = "editor-ui-2", EditorTypeName = "System.Drawing.Design.ColorEditor",
        ValueTypeName = "System.Drawing.Color", InvariantValue = "Red",
        UiContext = new DesignerUiTypeEditorUiContext
        {
            OwnerId = Guid.NewGuid().ToString("N"), FocusToken = "focus-1", Presentation = presentation,
            InvocationDepth = depth, RequiresNativeWindow = native,
        },
    };

    private static string Response(DesignerUiTypeEditorRequest request, string status, string? value = null,
        string? owner = null, string? focus = null, string? resultType = null, string? dismissal = null) =>
        DesignerUiTypeEditorWireProtocol.SerializeWorkerResponse(new DesignerUiTypeEditorWorkerResponse
        {
            RequestId = request.RequestId, Status = status, InvariantValue = value,
            OwnerId = owner ?? request.UiContext!.OwnerId, FocusToken = focus ?? request.UiContext!.FocusToken,
            ResultValueTypeName = resultType, DismissalReason = dismissal,
        });

    private static DesignerUiTypeEditorBroker Broker(string json) => new(new DelegateRunner((_, _) => Task.FromResult(Output(json))));
    private static DesignerUiTypeEditorProcessOutput Output(string json) => new() { ExitCode = 0, StandardOutput = json };

    private static async Task<JsonDocument> RunWorker(DesignerUiTypeEditorRequest request)
    {
        using var input = new StringReader(DesignerUiTypeEditorWireProtocol.SerializeRequest(request));
        using var output = new StringWriter();
        using var error = new StringWriter();
        Assert.Equal(0, await DesignerUiTypeEditorWorker.RunStandardIoAsync(input, output, error));
        Assert.Equal("", error.ToString());
        return JsonDocument.Parse(output.ToString());
    }

    private sealed class DelegateRunner : IDesignerUiTypeEditorProcessRunner
    {
        private readonly Func<string, CancellationToken, Task<DesignerUiTypeEditorProcessOutput>> _run;
        public int Calls { get; private set; }
        public DelegateRunner(Func<string, CancellationToken, Task<DesignerUiTypeEditorProcessOutput>> run) => _run = run;
        public Task<DesignerUiTypeEditorProcessOutput> RunAsync(string requestJson, CancellationToken cancellationToken)
        { Calls++; return _run(requestJson, cancellationToken); }
    }

    private sealed class DelegateInvoker : IDesignerUiTypeEditorInvoker
    {
        private readonly Func<DesignerUiTypeEditorRequest, DesignerUiTypeEditorInvocationResult> _invoke;
        public DelegateInvoker(Func<DesignerUiTypeEditorRequest, DesignerUiTypeEditorInvocationResult> invoke) => _invoke = invoke;
        public DesignerUiTypeEditorInvocationResult Invoke(DesignerUiTypeEditorRequest request) => _invoke(request);
    }
}
