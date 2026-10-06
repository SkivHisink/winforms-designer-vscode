using System.Security.Cryptography;
using System.Text;
using System.IO.Pipes;
using System.Reflection;
using System.Collections.Concurrent;
using StreamJsonRpc;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using Newtonsoft.Json.Serialization;
using WinFormsDesigner.Engine;
using WinFormsDesigner.Engine.Protocol;

namespace Engine.UnitTests;

public sealed class RuntimeProtocolTests
{
    private const string Source = "partial class Form1 { }";
    private static readonly JsonSerializerSettings Wire = new()
    {
        ContractResolver = new CamelCasePropertyNamesContractResolver(),
        NullValueHandling = NullValueHandling.Ignore,
    };

    [Fact]
    public void Negotiation_SelectsIntersectionAndActualAssemblyIdentity()
    {
        var router = new RuntimeProtocolRouter(new FakeApi());
        var result = router.Negotiate(Handshake(1, 1));
        Assert.True(result.Ok);
        Assert.Equal(1, result.ProtocolVersion);
        Assert.Equal("sha256-" + Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(typeof(FakeApi).Assembly.Location))), result.BuildId);
        Assert.Contains("protocol.rpc-envelope", result.Capabilities);
        Assert.Contains("protocol.binary-identity", result.Capabilities);
        Assert.Equal(V2Protocol.SchemaSha256, result.SchemaSha256);
        Assert.NotEmpty(result.EngineVersion);
        Assert.NotEmpty(result.Architecture);
        Assert.Equal("PROTOCOL_VERSION_UNSUPPORTED", router.Negotiate(Handshake(3, 4)).Outcome.Code);
        Assert.Equal("UNKNOWN_REQUIRED_CAPABILITY", router.Negotiate(Handshake(1, 2, "future.required")).Outcome.Code);
        Assert.Equal("BUILD_ID_MISMATCH", router.Negotiate(Handshake(1, 2, expectedBuildId: "sha256-missing")).Outcome.Code);
        Assert.Equal("INVALID_ENVELOPE", router.Negotiate("{}").Outcome.Code);
    }

    [Fact]
    public async Task RealEngineApi_RoutesPingCapabilitiesPaletteWithLegacyJsonShape()
    {
        var api = new EngineApi(new StaDispatcher());
        var negotiation = api.NegotiateProtocol(Handshake());
        Assert.True(negotiation.Ok);
        foreach (var method in new[] { "Ping", "GetCapabilities", "GetDesignerPalette", "GetV2WorkerUsage" })
        {
            var envelope = Envelope(negotiation.BuildId, method);
            var result = await api.ExecuteV2Envelope(JsonConvert.SerializeObject(envelope, Wire), CancellationToken.None);
            Assert.Equal(V2ProtocolOutcomeKind.Ok, result.Outcome.Kind);
            Assert.Equal(envelope.RequestId, result.RequestId);
            Assert.Equal(envelope.DocumentId, result.DocumentId);
            Assert.Equal(envelope.RenderGeneration, result.Generation);
            Assert.Equal(negotiation.BuildId, result.BuildId);
            Assert.True(V2Protocol.ValidateOutcome(result.Outcome));
            Assert.Equal("ok", JObject.Parse(JsonConvert.SerializeObject(result, Wire))["outcome"]!["kind"]!.Value<string>());
            var value = JToken.Parse(result.ResultJson);
            if (method == "Ping") Assert.Contains("winforms-engine ok", value.Value<string>());
            if (method == "GetCapabilities") Assert.Equal("modern-interpreted", value["engine"]!.Value<string>());
            if (method == "GetDesignerPalette") Assert.NotEmpty((JArray)value["webColors"]!);
            if (method == "GetV2WorkerUsage") Assert.True(value["memoryBytes"]!.Value<long>() > 0);
        }
    }

    [Fact]
    public async Task NamedPipe_ControlRequestsRemainResponsiveWhileOrdinaryRenderWaitsOnSta()
    {
        var sta = new StaDispatcher();
        var api = new EngineApi(sta);
        using var entered = new ManualResetEventSlim();
        using var release = new ManualResetEventSlim();
        var blocker = new Thread(() => sta.Invoke(() =>
        {
            entered.Set();
            release.Wait();
            return true;
        })) { IsBackground = true };
        blocker.Start();
        Assert.True(entered.Wait(TimeSpan.FromSeconds(5)));
        var pipeName = "wfd-protocol-control-" + Guid.NewGuid().ToString("N");
        using var serverPipe = new NamedPipeServerStream(pipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
        using var clientPipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
        var connected = serverPipe.WaitForConnectionAsync();
        await clientPipe.ConnectAsync(5000);
        await connected;
        using var server = new JsonRpc(serverPipe, serverPipe, api);
        using var client = new JsonRpc(clientPipe);
        server.CancelLocallyInvokedMethodsWhenConnectionIsClosed = true;
        server.StartListening();
        client.StartListening();
        try
        {
            var negotiation = await client.InvokeAsync<ProtocolNegotiationResult>("NegotiateProtocol", Handshake());
            var root = new DirectoryInfo(AppContext.BaseDirectory);
            while (root != null && !File.Exists(Path.Combine(root.FullName, "engine", "Engine.csproj"))) root = root.Parent;
            Assert.NotNull(root);
            var designer = Path.Combine(root.FullName, "engine", "samples", "SampleForm.Designer.cs");
            var source = File.ReadAllText(designer);
            var envelope = Envelope(negotiation.BuildId);
            envelope.SourceFingerprint = V2Protocol.Fingerprint("source", Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(source))), Encoding.UTF8.GetByteCount(source));
            envelope.PayloadJson = JsonConvert.SerializeObject(new { method = "RenderWithLayout", args = new object?[] { designer, null, source } });
            envelope.PayloadBytes = V2Protocol.PayloadByteCount(envelope.PayloadJson);
            var pending = client.InvokeAsync<ProtocolExecutionResult>("ExecuteV2Envelope", JsonConvert.SerializeObject(envelope, Wire));
            var queue = (BlockingCollection<Action>)typeof(StaDispatcher).GetField("_queue", BindingFlags.NonPublic | BindingFlags.Instance)!.GetValue(sta)!;
            var observed = DateTime.UtcNow.AddSeconds(5);
            while (queue.Count == 0 && DateTime.UtcNow < observed && !pending.IsCompleted) await Task.Delay(10);
            Assert.True(queue.Count > 0, "Ordinary render must have entered its synchronous STA wait.");
            var usage = await client.InvokeAsync<WorkerUsage>("GetV2WorkerUsage").WaitAsync(TimeSpan.FromSeconds(2));
            Assert.True(usage.MemoryBytes > 0);
            Assert.True(usage.HandleCount > 0);
            Assert.False(pending.IsCompleted);
            var cancelled = await client.InvokeAsync<bool>("CancelV2Request", envelope.SessionId, envelope.CancellationToken).WaitAsync(TimeSpan.FromSeconds(2));
            Assert.True(cancelled);
            Assert.False(pending.IsCompleted);
            release.Set();
            var result = await pending.WaitAsync(TimeSpan.FromSeconds(10));
            Assert.Equal("CANCELLED", result.Outcome.Code);
            Assert.Null(result.ResultJson);
        }
        finally
        {
            release.Set();
            Assert.True(blocker.Join(TimeSpan.FromSeconds(5)));
        }
    }

    [Fact]
    public async Task EngineApi_PreCancelledRpcTokenReturnsStructuredCancellation()
    {
        var api = new EngineApi(new StaDispatcher());
        var negotiation = api.NegotiateProtocol(Handshake());
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        var result = await api.ExecuteV2Envelope(JsonConvert.SerializeObject(Envelope(negotiation.BuildId), Wire), cancellation.Token);
        Assert.Equal("CANCELLED", result.Outcome.Code);
        Assert.Null(result.ResultJson);
    }

    [Fact]
    public async Task MissingNegotiationWrongBinaryAndRecursiveApiAreRefusedBeforeDispatch()
    {
        var fake = new FakeApi();
        var router = new RuntimeProtocolRouter(fake);
        Assert.Equal("PROTOCOL_NOT_NEGOTIATED", (await Send(router, Envelope(router.BuildId))).Outcome.Code);
        Assert.True(router.Negotiate(Handshake()).Ok);
        Assert.Equal("BUILD_ID_MISMATCH", (await Send(router, Envelope("sha256-wrong"))).Outcome.Code);
        Assert.Equal("UNSUPPORTED_OPERATION", (await Send(router, Envelope(router.BuildId, "NegotiateProtocol"))).Outcome.Code);
        Assert.Equal(0, fake.Invocations);
    }

    [Fact]
    public async Task SourceMismatchMissingOperationAndChangedOperationPayloadNeverInvokeMutation()
    {
        var fake = new FakeApi();
        var router = Ready(fake);
        var envelope = Mutation(router);
        envelope.SourceFingerprint.Value = new string('a', 64);
        Assert.Equal("STALE_SOURCE", (await Send(router, envelope)).Outcome.Code);
        envelope = Mutation(router, generation: 2);
        envelope.CommandId = null!;
        Assert.Equal("COMMAND_ID_REQUIRED", (await Send(router, envelope)).Outcome.Code);
        var first = await Send(router, Mutation(router, generation: 2));
        Assert.Equal("OK", first.Outcome.Code);
        var repeated = Mutation(router, request: "retry", generation: 2);
        var retry = await Send(router, repeated);
        Assert.Equal(first.ResultJson, retry.ResultJson);
        Assert.Equal("retry", retry.RequestId);
        var conflict = Mutation(router, request: "conflict", value: "other", generation: 2);
        Assert.Equal("COMMAND_ID_CONFLICT", (await Send(router, conflict)).Outcome.Code);
        Assert.Equal(1, fake.Invocations);
    }

    [Fact]
    public async Task CancelledAndExpiredRequestHaveNoInvocation()
    {
        var fake = new FakeApi();
        var router = Ready(fake);
        var expired = Envelope(router.BuildId);
        expired.DeadlineUnixMilliseconds = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - 1;
        Assert.Equal("DEADLINE_EXCEEDED", (await Send(router, expired)).Outcome.Code);
        var cancelled = Envelope(router.BuildId);
        Assert.True(router.Cancel(cancelled.SessionId, cancelled.CancellationToken));
        Assert.Equal("CANCELLED", (await Send(router, cancelled)).Outcome.Code);
        var cts = new CancellationTokenSource();
        cts.Cancel();
        var different = Envelope(router.BuildId, request: "different");
        Assert.Equal("CANCELLED", (await Send(router, different, cts.Token)).Outcome.Code);
        Assert.Equal(0, fake.Invocations);
    }

    [Fact]
    public async Task NewRevisionInvalidatesInFlightReplyAndOlderQueuedWork()
    {
        var fake = new FakeApi { Completion = new TaskCompletionSource<object>(TaskCreationOptions.RunContinuationsAsynchronously) };
        var router = Ready(fake);
        var old = Send(router, Envelope(router.BuildId));
        await fake.Started.Task.WaitAsync(TimeSpan.FromSeconds(5));
        var newer = Send(router, Envelope(router.BuildId, request: "new", generation: 2, revision: "revision-2"));
        fake.Completion.SetResult(new { Value = 1 });
        Assert.Equal("STALE_GENERATION", (await old).Outcome.Code);
        Assert.Null((await old).ResultJson);
        Assert.Equal("OK", (await newer).Outcome.Code);
        Assert.Equal("STALE_GENERATION", (await Send(router, Envelope(router.BuildId, request: "late-old"))).Outcome.Code);
        Assert.Equal("STALE_REVISION", (await Send(router, Envelope(router.BuildId, request: "wrong-rev", generation: 2))).Outcome.Code);
        Assert.Equal(2, fake.Invocations);
    }

    [Fact]
    public async Task ExplicitCancellationReleasesQueuedRequestBeforeActiveCallbackCompletes()
    {
        var fake = new FakeApi { Completion = new TaskCompletionSource<object>(TaskCreationOptions.RunContinuationsAsynchronously) };
        var router = Ready(fake);
        var first = Send(router, Envelope(router.BuildId));
        await fake.Started.Task.WaitAsync(TimeSpan.FromSeconds(5));
        var queuedEnvelope = Envelope(router.BuildId, request: "queued");
        var queued = Send(router, queuedEnvelope);
        router.Cancel(queuedEnvelope.SessionId, queuedEnvelope.CancellationToken);
        Assert.Equal("CANCELLED", (await queued.WaitAsync(TimeSpan.FromSeconds(5))).Outcome.Code);
        Assert.False(first.IsCompleted);
        Assert.Equal(1, fake.Invocations);
        fake.Completion.SetResult(new { Value = 1 });
        Assert.Equal("OK", (await first).Outcome.Code);
    }

    [Fact]
    public async Task CancellationAfterCallbackSuppressesResultAndSameOperationNeverRunsAgain()
    {
        var fake = new FakeApi { Completion = new TaskCompletionSource<object>(TaskCreationOptions.RunContinuationsAsynchronously) };
        var router = Ready(fake);
        var envelope = Mutation(router);
        var pending = Send(router, envelope);
        await fake.Started.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.True(router.Cancel(envelope.SessionId, envelope.CancellationToken));
        fake.Completion.SetResult(new { NewText = "proposal" });
        var cancelled = await pending;
        Assert.Equal("CANCELLED", cancelled.Outcome.Code);
        Assert.Null(cancelled.ResultJson);
        var retried = Mutation(router, request: "retry");
        var retry = await Send(router, retried);
        Assert.Equal("CANCELLED", retry.Outcome.Code);
        Assert.Null(retry.ResultJson);
        Assert.Equal(1, fake.Invocations);
    }

    [Fact]
    public async Task EventAndLiveTransitionSnapshotsAndResourceOnlyCallsAllowDirtySource()
    {
        var fake = new FakeApi();
        var router = Ready(fake);
        var cases = new[]
        {
            ("GenerateEventHandler", new object[] { "missing.Designer.cs", "button1", "Click", "handler", Source }),
            ("ApplyCachedTextPropertyEdit", new object[] { "graph", "missing.Designer.cs", "button1", "Text", "new", Source, Source + " changed" }),
            ("SetLocalizationCulture", new object[] { "missing.Designer.cs", "fr-FR" }),
        };
        foreach (var (method, args) in cases)
        {
            var envelope = Envelope(router.BuildId, request: method);
            envelope.CommandId = method;
            envelope.PayloadJson = JsonConvert.SerializeObject(new { method, args });
            envelope.PayloadBytes = V2Protocol.PayloadByteCount(envelope.PayloadJson);
            Assert.Equal("OK", (await Send(router, envelope)).Outcome.Code);
        }
        Assert.Equal(3, fake.Invocations);
    }

    [Fact]
    public async Task CancellationTokenCannotBeSuppliedThroughPayload()
    {
        var fake = new FakeApi();
        var router = Ready(fake);
        var envelope = Envelope(router.BuildId, "EditSupportedCollectionEditor");
        envelope.PayloadJson = JsonConvert.SerializeObject(new { method = "EditSupportedCollectionEditor", args = new object[] { "req", "item", Array.Empty<string>(), new { isCancellationRequested = false } } });
        envelope.PayloadBytes = V2Protocol.PayloadByteCount(envelope.PayloadJson);
        Assert.Equal("INVALID_ENVELOPE", (await Send(router, envelope)).Outcome.Code);
        Assert.Equal(0, fake.Invocations);
    }

    private static RuntimeProtocolRouter Ready(FakeApi fake)
    {
        var router = new RuntimeProtocolRouter(fake);
        Assert.True(router.Negotiate(Handshake()).Ok);
        return router;
    }
    private static string Handshake(int minimum = 1, int maximum = 2, string capability = "protocol.rpc-envelope", string? expectedBuildId = null)
    {
        var value = new JObject
        {
            ["protocolId"] = V2Protocol.ProtocolId, ["minimumVersion"] = minimum, ["maximumVersion"] = maximum,
            ["requiredCapabilities"] = new JArray(capability),
        };
        if (expectedBuildId != null) value["expectedBuildId"] = expectedBuildId;
        return value.ToString(Formatting.None);
    }
    private static V2ProtocolEnvelope Envelope(string build, string method = "Ping", string request = "request-1", long generation = 1, string revision = "revision-1") =>
        V2Protocol.CreateEnvelope(V2ProtocolMessageKind.Request, build, "session-1", "document-1", request, request + ":trace", "operation-1",
            revision, generation, V2Protocol.Fingerprint("source", Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(Source))), Encoding.UTF8.GetByteCount(Source)),
            Array.Empty<V2Fingerprint>(), DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 30000, request + ":cancel", V2Protocol.Capabilities,
            new[] { "protocol.rpc-envelope" }, JsonConvert.SerializeObject(new { method, args = Array.Empty<object>() }));
    private static V2ProtocolEnvelope Mutation(RuntimeProtocolRouter router, string request = "request-1", string value = "new", long generation = 1)
    {
        var envelope = Envelope(router.BuildId, request: request, generation: generation);
        envelope.PayloadJson = JsonConvert.SerializeObject(new { method = "SetProperty", args = new object[] { "missing.Designer.cs", "button1", "Text", value, Source } });
        envelope.PayloadBytes = V2Protocol.PayloadByteCount(envelope.PayloadJson);
        return envelope;
    }
    private static Task<ProtocolExecutionResult> Send(RuntimeProtocolRouter router, V2ProtocolEnvelope envelope, CancellationToken token = default) =>
        router.ExecuteAsync(JsonConvert.SerializeObject(envelope, Wire), token);

    public sealed class FakeApi
    {
        public int Invocations;
        public TaskCompletionSource<object>? Completion;
        public TaskCompletionSource<bool> Started = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public Task<object> Ping() => Invoke();
        public Task<object> SetProperty(string designerFilePath, string componentName, string propertyName, string newValueExpr, string sourceText = "") => Invoke();
        public Task<object> GenerateEventHandler(string designerFilePath, string componentId, string eventName, string handlerName, string designerSourceText) => Invoke();
        public Task<object> ApplyCachedTextPropertyEdit(string graphToken, string designerFilePath, string componentId, string propertyName,
            string newValueExpr, string beforeSourceText, string afterSourceText) => Invoke();
        public Task<object> SetLocalizationCulture(string designerFilePath, string cultureName) => Invoke();
        public Task<object> EditSupportedCollectionEditor(string requestId, string itemTypeName, string[] items, CancellationToken cancellationToken) => Invoke();
        private Task<object> Invoke()
        {
            Invocations++;
            Started.TrySetResult(true);
            return Completion?.Task ?? Task.FromResult<object>(new { NewText = "proposal", Safe = true });
        }
    }
}
