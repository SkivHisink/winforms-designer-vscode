using System.ComponentModel;
using System.Drawing.Design;
using System.Security.Cryptography;
using System.Text.Json;
using System.Windows.Forms;
using FakeVendor;
using WinFormsDesigner.Engine;

namespace Engine.UnitTests;

public sealed class DesignerUiTypeEditorBrokerTests
{
    [Fact]
    public async Task V2_FND_001_S045_EditAsync_AppliedFrameworkValue_ReturnsValidatedValueAndStableWireRequest()
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
    public async Task V2_FND_001_S046_EditAsync_UserDismissedEditor_IsSuccessfulNoOp()
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
    public async Task V2_FND_001_S071_CollectionEditorBroker_ReturnsOnlyValidatedInvariantItems()
    {
        string? capturedJson = null;
        var runner = new DelegateRunner((json, _) =>
        {
            capturedJson = json;
            return Task.FromResult(Output(CollectionResponse("collection-request-1", "3", "5")));
        });

        DesignerUiTypeEditorBrokerResult result =
            await new DesignerUiTypeEditorBroker(runner).EditAsync(CollectionRequest("1", "2"));

        Assert.True(result.Ok, result.Reason);
        Assert.True(result.Applied);
        Assert.Equal(new[] { "3", "5" }, result.CollectionItems);
        using JsonDocument request = JsonDocument.Parse(capturedJson!);
        Assert.Equal("System.ComponentModel.Design.CollectionEditor", request.RootElement.GetProperty("editorTypeName").GetString());
        Assert.Equal("System.Collections.IList", request.RootElement.GetProperty("valueTypeName").GetString());
        Assert.Equal("System.Int32", request.RootElement.GetProperty("collectionItemTypeName").GetString());
        Assert.Equal(new[] { "1", "2" }, request.RootElement.GetProperty("collectionItems").EnumerateArray().Select(item => item.GetString()));
        Assert.Equal("", request.RootElement.GetProperty("invariantValue").GetString());
    }

    [Fact]
    public async Task V2_FND_001_S071_CollectionEditorBroker_RejectsBadItemBeforeWorker()
    {
        var runner = new DelegateRunner((_, _) => throw new InvalidOperationException("must not run"));

        DesignerUiTypeEditorBrokerResult result =
            await new DesignerUiTypeEditorBroker(runner).EditAsync(CollectionRequest("not-an-int"));

        Assert.False(result.Ok);
        Assert.Equal("invalid_value", result.ErrorCode);
        Assert.Equal(0, runner.CallCount);
    }

    [Fact]
    public async Task V2_FND_001_S071_CollectionWorker_UsesTypedCollectionEnvelopeOnSta()
    {
        ApartmentState apartment = ApartmentState.Unknown;
        var invoker = new DelegateInvoker(request =>
        {
            apartment = Thread.CurrentThread.GetApartmentState();
            Assert.Equal(new[] { "1", "2" }, request.CollectionItems);
            return new DesignerUiTypeEditorInvocationResult
            {
                Applied = true,
                CollectionItems = new List<string> { "8", "13" },
            };
        });
        using var input = new StringReader(DesignerUiTypeEditorWireProtocol.SerializeRequest(CollectionRequest("1", "2")));
        using var output = new StringWriter();
        using var error = new StringWriter();

        int exitCode = await DesignerUiTypeEditorWorker.RunStandardIoAsync(input, output, error, invoker);

        Assert.Equal(0, exitCode);
        Assert.Equal(ApartmentState.STA, apartment);
        using JsonDocument response = JsonDocument.Parse(output.ToString());
        Assert.Equal("applied", response.RootElement.GetProperty("status").GetString());
        Assert.Equal(new[] { "8", "13" }, response.RootElement.GetProperty("collectionItems").EnumerateArray().Select(item => item.GetString()));
        Assert.False(response.RootElement.TryGetProperty("invariantValue", out _));
    }

    [Fact(DisplayName = "V2-FND-001-S071 certified vendor collection editor runs in the actual isolated worker contract")]
    [Trait("V2Scenario", "V2-FND-001-S071")]
    public async Task V2_FND_001_S071_CertifiedVendorCollectionEditor_ReturnsValidatedItems()
    {
        string? capturedJson = null;
        var runner = new DelegateRunner(async (json, token) =>
        {
            capturedJson = json;
            return await RunWorkerAsync(json, token);
        });
        string? oldAutomation = Environment.GetEnvironmentVariable(VendorThresholdsEditor.AutomationEnvironmentVariable);
        Environment.SetEnvironmentVariable(VendorThresholdsEditor.AutomationEnvironmentVariable, "3;5");
        try
        {
            DesignerUiTypeEditorBrokerResult result =
                await new DesignerUiTypeEditorBroker(runner).EditAsync(FakeVendorCollectionRequest("1", "2"));

            Assert.True(result.Ok, result.Reason);
            Assert.True(result.Applied);
            Assert.Equal(new[] { "3", "5" }, result.CollectionItems);
            using JsonDocument request = JsonDocument.Parse(capturedJson!);
            Assert.Equal("FakeVendor.VendorThresholdsEditor", request.RootElement.GetProperty("editorTypeName").GetString());
            Assert.Equal("System.Collections.IList", request.RootElement.GetProperty("valueTypeName").GetString());
            Assert.Equal("System.Int32", request.RootElement.GetProperty("collectionItemTypeName").GetString());
            Assert.Equal(FakeVendorAssemblyPath(), request.RootElement.GetProperty("editorAssemblyPath").GetString());
            Assert.Equal(FakeVendorAssemblySha256(), request.RootElement.GetProperty("editorAssemblySha256").GetString());
            Assert.Equal("repo.fakevendor.thresholds.v1", request.RootElement.GetProperty("editorCertificationId").GetString());
        }
        finally
        {
            Environment.SetEnvironmentVariable(VendorThresholdsEditor.AutomationEnvironmentVariable, oldAutomation);
        }
    }

    [Fact]
    public void V2_FND_001_S071_ProductFactory_CreatesTheFrameworkCollectionEditor()
    {
        UITypeEditor editor = FrameworkDesignerUiTypeEditorInvoker.CreateFrameworkCollectionEditor(typeof(List<int>));

        Assert.Equal("System.ComponentModel.Design.CollectionEditor", editor.GetType().FullName);
        Assert.Equal("System.Windows.Forms.Design", editor.GetType().Assembly.GetName().Name);
    }

    [Fact]
    public async Task V2_FND_001_S047_UnsupportedVendorEditorPair_RefusesBeforeStartingWorker()
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
    public async Task V2_FND_001_S047_CertifiedFakeVendorDropdown_ReturnsBoundedIntentForNormalSourceTransaction()
    {
        string? capturedJson = null;
        var runner = new DelegateRunner(async (json, token) =>
        {
            capturedJson = json;
            return await RunWorkerAsync(json, token);
        });
        string? oldAutomation = Environment.GetEnvironmentVariable(VendorComplexValueEditor.AutomationEnvironmentVariable);
        Environment.SetEnvironmentVariable(VendorComplexValueEditor.AutomationEnvironmentVariable, "Vendor Beta");
        try
        {
            DesignerUiTypeEditorBrokerResult result =
                await new DesignerUiTypeEditorBroker(runner).EditAsync(FakeVendorRequest());

            Assert.True(result.Ok, result.Reason);
            Assert.True(result.Applied);
            Assert.Equal("Vendor Beta", result.InvariantValue);
            Assert.NotNull(capturedJson);
            using JsonDocument requestJson = JsonDocument.Parse(capturedJson);
            Assert.Equal("FakeVendor.VendorComplexValueEditor", requestJson.RootElement.GetProperty("editorTypeName").GetString());
            Assert.Equal("System.String", requestJson.RootElement.GetProperty("valueTypeName").GetString());
            Assert.Equal(FakeVendorAssemblyPath(), requestJson.RootElement.GetProperty("editorAssemblyPath").GetString());
            Assert.Equal(FakeVendorAssemblySha256(), requestJson.RootElement.GetProperty("editorAssemblySha256").GetString());
            Assert.Equal("repo.fakevendor.complex-value.v1", requestJson.RootElement.GetProperty("editorCertificationId").GetString());

            string source = """
                namespace Demo
                {
                    partial class Form1
                    {
                        private FakeVendor.VendorEdit vendorEdit1;
                        private void InitializeComponent()
                        {
                            this.vendorEdit1 = new FakeVendor.VendorEdit();
                            this.vendorEdit1.ComplexValue = "Vendor Alpha";
                        }
                    }
                }
                """;
            string expression = JsonSerializer.Serialize(result.InvariantValue);
            EditResult edit = DesignerPropertyEditor.EditProperty(source, "vendorEdit1", "ComplexValue", expression);
            Assert.Equal(EditMode.Replace, edit.Mode);
            Assert.True(DesignerPropertyEditor.OnlyTargetChanged(source, edit.NewText, "vendorEdit1", "ComplexValue", edit.Mode));
            Assert.Contains("this.vendorEdit1.ComplexValue = \"Vendor Beta\";", edit.NewText, StringComparison.Ordinal);
        }
        finally
        {
            Environment.SetEnvironmentVariable(VendorComplexValueEditor.AutomationEnvironmentVariable, oldAutomation);
        }
    }

    [Fact]
    public async Task V2_FND_001_S047_CertifiedVendorHashMismatch_RefusesBeforeStartingWorker()
    {
        var runner = new DelegateRunner((_, _) => throw new InvalidOperationException("must not run"));
        DesignerUiTypeEditorRequest request = FakeVendorRequest(editorAssemblySha256: new string('0', 64));

        DesignerUiTypeEditorBrokerResult result =
            await new DesignerUiTypeEditorBroker(runner).EditAsync(request);

        Assert.False(result.Ok);
        Assert.Equal("unsupported_editor", result.ErrorCode);
        Assert.Equal(0, runner.CallCount);
    }

    [Fact]
    public void V2_FND_001_S047_DescribeComponent_PublishesCertifiedFakeVendorEditorMetadata()
    {
        using var container = new Container();
        using var root = new Form();
        using var vendor = new VendorEdit();
        container.Add(root, "root");
        container.Add(vendor, "vendorEdit1");
        var host = new TestDesignerHost(container, root);

        ComponentInfo? component = DesignerDescribe.DescribeComponent(
            host,
            rootName: nameof(Form),
            explicitMembers: new HashSet<(IComponent, string)>(),
            componentId: "vendorEdit1");

        Assert.NotNull(component);
        WinFormsDesigner.Engine.PropertyInfo property =
            Assert.Single(component!.Properties, p => p.Name == nameof(VendorEdit.ComplexValue));
        Assert.Equal("System.String", property.Type);
        Assert.Equal("FakeVendor.VendorComplexValueEditor", property.UiTypeEditor);
        Assert.Equal(FakeVendorAssemblyPath(), property.UiTypeEditorAssemblyPath);
        Assert.Equal(FakeVendorAssemblySha256(), property.UiTypeEditorAssemblySha256);
        Assert.Equal("repo.fakevendor.complex-value.v1", property.UiTypeEditorCertificationId);
    }

    [Fact(DisplayName = "V2-FND-001-S071 live modern metadata publishes the exact certified vendor collection tuple")]
    [Trait("V2Scenario", "V2-FND-001-S071")]
    public void V2_FND_001_S071_DescribeComponent_PublishesCertifiedFakeVendorCollectionMetadata()
    {
        using var container = new Container();
        using var root = new Form();
        using var vendor = new VendorEdit();
        container.Add(root, "root");
        container.Add(vendor, "vendorEdit1");
        var host = new TestDesignerHost(container, root);

        ComponentInfo? component = DesignerDescribe.DescribeComponent(
            host,
            rootName: nameof(Form),
            explicitMembers: new HashSet<(IComponent, string)>(),
            componentId: "vendorEdit1");

        Assert.NotNull(component);
        WinFormsDesigner.Engine.PropertyInfo property =
            Assert.Single(component!.Properties, p => p.Name == nameof(VendorEdit.Thresholds));
        Assert.True(property.GenericCollection);
        Assert.True(property.IsCollection);
        Assert.Equal("System.Int32", property.CollectionItemType);
        Assert.Equal("FakeVendor.VendorThresholdsEditor", property.UiTypeEditor);
        Assert.Equal(FakeVendorAssemblyPath(), property.UiTypeEditorAssemblyPath);
        Assert.Equal(FakeVendorAssemblySha256(), property.UiTypeEditorAssemblySha256);
        Assert.Equal("repo.fakevendor.thresholds.v1", property.UiTypeEditorCertificationId);
    }

    [Fact]
    public async Task EditAsync_CallerCancellation_CancelsRunnerAndReturnsDeterministicError()
    {
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var runnerCancelled = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var runner = new DelegateRunner(async (_, token) =>
        {
            started.TrySetResult();
            // Observe cancellation through the delay itself: a token.Register callback races with the
            // registration Task.Delay makes on the same token (callbacks run LIFO, and the resumed body
            // would dispose ours before the source reaches it).
            try { await Task.Delay(Timeout.InfiniteTimeSpan, token); }
            catch (OperationCanceledException) { runnerCancelled.TrySetResult(); throw; }
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
            try { await Task.Delay(Timeout.InfiniteTimeSpan, token); }
            catch (OperationCanceledException) { runnerCancelled.TrySetResult(); throw; }
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
    public async Task V2_FND_001_S048_EditAsync_AppliedUnrepresentableValue_RejectsWorkerResult()
    {
        var runner = new DelegateRunner((_, _) =>
            Task.FromResult(Output(Response("request-1", "applied", "not-a-color"))));

        DesignerUiTypeEditorBrokerResult result =
            await new DesignerUiTypeEditorBroker(runner).EditAsync(ColorRequest());

        Assert.False(result.Ok);
        Assert.Equal("INVALID_EDITOR_RESULT", result.ErrorCode);
    }

    [Fact(DisplayName = "V2-FND-001-S048 certified vendor wrong-type result is rejected before mutation")]
    [Trait("V2Scenario", "V2-FND-001-S048")]
    public async Task V2_FND_001_S048_CertifiedVendorWrongTypeResult_IsRejectedBeforeMutation()
    {
        var runner = new DelegateRunner((json, token) => RunWorkerAsync(json, token));
        string? oldAutomation = Environment.GetEnvironmentVariable(VendorComplexValueEditor.AutomationEnvironmentVariable);
        Environment.SetEnvironmentVariable(VendorComplexValueEditor.AutomationEnvironmentVariable, "__invalid_object__");
        try
        {
            DesignerUiTypeEditorBrokerResult result =
                await new DesignerUiTypeEditorBroker(runner).EditAsync(FakeVendorRequest());

            Assert.False(result.Ok);
            Assert.False(result.Applied);
            Assert.Equal("INVALID_EDITOR_RESULT", result.ErrorCode);
        }
        finally
        {
            Environment.SetEnvironmentVariable(VendorComplexValueEditor.AutomationEnvironmentVariable, oldAutomation);
        }
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

    private static DesignerUiTypeEditorRequest CollectionRequest(params string[] items) => new()
    {
        RequestId = "collection-request-1",
        EditorTypeName = DesignerUiTypeEditorPolicy.CollectionEditorTypeName,
        ValueTypeName = DesignerUiTypeEditorPolicy.CollectionValueTypeName,
        InvariantValue = "",
        CollectionItemTypeName = "System.Int32",
        CollectionItems = items.ToList(),
    };

    private static DesignerUiTypeEditorRequest FakeVendorRequest(string? editorAssemblySha256 = null) => new()
    {
        RequestId = "vendor-request-1",
        EditorTypeName = "FakeVendor.VendorComplexValueEditor",
        ValueTypeName = "System.String",
        InvariantValue = "Vendor Alpha",
        EditorAssemblyPath = FakeVendorAssemblyPath(),
        EditorAssemblySha256 = editorAssemblySha256 ?? FakeVendorAssemblySha256(),
        EditorCertificationId = "repo.fakevendor.complex-value.v1",
    };

    private static DesignerUiTypeEditorRequest FakeVendorCollectionRequest(params string[] items) => new()
    {
        RequestId = "vendor-collection-request-1",
        EditorTypeName = "FakeVendor.VendorThresholdsEditor",
        ValueTypeName = DesignerUiTypeEditorPolicy.CollectionValueTypeName,
        InvariantValue = "",
        CollectionItemTypeName = "System.Int32",
        CollectionItems = items.ToList(),
        EditorAssemblyPath = FakeVendorAssemblyPath(),
        EditorAssemblySha256 = FakeVendorAssemblySha256(),
        EditorCertificationId = "repo.fakevendor.thresholds.v1",
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

    private static async Task<DesignerUiTypeEditorProcessOutput> RunWorkerAsync(
        string requestJson,
        CancellationToken cancellationToken)
    {
        using var input = new StringReader(requestJson);
        using var output = new StringWriter();
        using var error = new StringWriter();
        int exitCode = await DesignerUiTypeEditorWorker.RunStandardIoAsync(input, output, error, cancellationToken);
        return new DesignerUiTypeEditorProcessOutput
        {
            ExitCode = exitCode,
            StandardOutput = output.ToString(),
            StandardError = error.ToString(),
        };
    }

    private static string FakeVendorAssemblyPath() => typeof(VendorEdit).Assembly.Location;

    private static string FakeVendorAssemblySha256()
    {
        using var stream = File.OpenRead(FakeVendorAssemblyPath());
        return Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
    }

    private static string Response(string requestId, string status, string? invariantValue = null) =>
        DesignerUiTypeEditorWireProtocol.SerializeWorkerResponse(new DesignerUiTypeEditorWorkerResponse
        {
            RequestId = requestId,
            Status = status,
            InvariantValue = invariantValue,
        });

    private static string CollectionResponse(string requestId, params string[] items) =>
        DesignerUiTypeEditorWireProtocol.SerializeWorkerResponse(new DesignerUiTypeEditorWorkerResponse
        {
            RequestId = requestId,
            Status = "applied",
            CollectionItems = items.ToList(),
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
