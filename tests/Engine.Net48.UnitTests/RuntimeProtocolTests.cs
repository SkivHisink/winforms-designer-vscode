using System;
using System.IO;
using System.IO.Pipes;
using System.Linq;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Xunit;

namespace Engine.Net48.UnitTests
{
    public sealed class RuntimeProtocolTests
    {
        [Fact]
        public async Task ActualNet48NamedPipe_ControlRequestsBypassBlockedSynchronousOrdinaryDispatch()
        {
            var api = Load();
            var cultureGate = api.GetType().GetField("_cultureGate", BindingFlags.NonPublic | BindingFlags.Instance).GetValue(api);
            var router = api.GetType().GetField("_protocol", BindingFlags.NonPublic | BindingFlags.Instance).GetValue(api);
            var dispatcher = (SemaphoreSlim)router.GetType().GetField("_dispatch", BindingFlags.NonPublic | BindingFlags.Instance).GetValue(router);
            using (var entered = new ManualResetEventSlim())
            using (var release = new ManualResetEventSlim())
            {
                var blocker = new Thread(() =>
                {
                    lock (cultureGate)
                    {
                        entered.Set();
                        release.Wait();
                    }
                }) { IsBackground = true };
                blocker.Start();
                Assert.True(entered.Wait(TimeSpan.FromSeconds(5)));
                var name = "wfd-net48-protocol-control-" + Guid.NewGuid().ToString("N");
                using (var serverPipe = new NamedPipeServerStream(name, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous))
                using (var clientPipe = new NamedPipeClientStream(".", name, PipeDirection.InOut, PipeOptions.Asynchronous))
                {
                    var connected = serverPipe.WaitForConnectionAsync();
                    await clientPipe.ConnectAsync(5000);
                    await connected;
                    var rpcType = Assembly.LoadFrom(Path.Combine(Path.GetDirectoryName(api.GetType().Assembly.Location), "StreamJsonRpc.dll"))
                        .GetType("StreamJsonRpc.JsonRpc", true);
                    using (var server = (IDisposable)Activator.CreateInstance(rpcType, new object[] { serverPipe, serverPipe, api }))
                    using (var client = (IDisposable)Activator.CreateInstance(rpcType, new object[] { clientPipe }))
                    {
                        Call(server, "StartListening");
                        Call(client, "StartListening");
                        try
                        {
                            var negotiationType = api.GetType().Assembly.GetType("WinFormsDesigner.Engine.Protocol.ProtocolNegotiationResult", true);
                            var executionType = api.GetType().Assembly.GetType("WinFormsDesigner.Engine.Protocol.ProtocolExecutionResult", true);
                            var usageType = api.GetType().Assembly.GetType("WinFormsDesigner.Engine.Protocol.WorkerUsage", true);
                            var negotiation = await Rpc(client, negotiationType, "NegotiateProtocol", Handshake());
                            var build = Get<string>(negotiation, "BuildId");
                            var pending = Rpc(client, executionType, "ExecuteV2Envelope", Envelope(build, "SetLocalizationCulture", args: "[\"missing.Designer.cs\",\"fr-FR\"]"));
                            var observed = DateTime.UtcNow.AddSeconds(5);
                            while (dispatcher.CurrentCount != 0 && DateTime.UtcNow < observed && !pending.IsCompleted) await Task.Delay(10);
                            Assert.Equal(0, dispatcher.CurrentCount);
                            var usageTask = Rpc(client, usageType, "GetV2WorkerUsage");
                            await Within(usageTask, 2000);
                            var usage = await usageTask;
                            Assert.True(Get<long>(usage, "MemoryBytes") > 0);
                            Assert.True(Get<int>(usage, "HandleCount") > 0);
                            Assert.False(pending.IsCompleted);
                            var cancellation = Rpc(client, typeof(bool), "CancelV2Request", "session-1", "cancel-1");
                            await Within(cancellation, 2000);
                            Assert.True((bool)await cancellation);
                            Assert.False(pending.IsCompleted);
                            release.Set();
                            await Within(pending, 10000);
                            var result = await pending;
                            Assert.Equal("CANCELLED", Code(result));
                            Assert.Null(Get<string>(result, "ResultJson"));
                        }
                        finally
                        {
                            release.Set();
                            Assert.True(blocker.Join(TimeSpan.FromSeconds(5)));
                        }
                    }
                }
            }
        }

        [Fact]
        public async Task ActualNet48Engine_NegotiatesBinaryAndPreservesOrdinaryRpcJson()
        {
            var api = Load();
            var negotiate = Call(api, "NegotiateProtocol", Handshake());
            Assert.True(Get<bool>(negotiate, "Ok"));
            Assert.Equal(2, Get<int>(negotiate, "ProtocolVersion"));
            var build = Get<string>(negotiate, "BuildId");
            Assert.Equal("sha256-" + Hash(File.ReadAllBytes(api.GetType().Assembly.Location)), build);
            Assert.Contains("protocol.rpc-envelope", Get<string[]>(negotiate, "Capabilities"));
            foreach (var method in new[] { "Ping", "GetCapabilities", "GetV2WorkerUsage" })
            {
                var result = await Send(api, Envelope(build, method));
                Assert.Equal("OK", Code(result));
                Assert.Equal("request-1", Get<string>(result, "RequestId"));
                Assert.Equal("session-1", Get<string>(result, "SessionId"));
                Assert.Equal("document-1", Get<string>(result, "DocumentId"));
                Assert.Equal("revision-1", Get<string>(result, "DocumentRevision"));
                Assert.Equal(1L, Get<long>(result, "Generation"));
                Assert.Equal(build, Get<string>(result, "BuildId"));
                var json = Get<string>(result, "ResultJson");
                if (method == "Ping") Assert.Contains("winforms-engine-net48 ok", json);
                if (method == "GetCapabilities") Assert.Contains("\"engine\":\"net48-compiled\"", json);
                if (method == "GetV2WorkerUsage") Assert.Contains("\"memoryBytes\":", json);
            }
            Assert.Equal("PROTOCOL_VERSION_UNSUPPORTED", Code(Call(api, "NegotiateProtocol", Handshake(3, 4))));
            Assert.Equal("UNKNOWN_REQUIRED_CAPABILITY", Code(Call(api, "NegotiateProtocol", Handshake(capability: "future.required"))));
        }

        [Fact]
        public async Task ActualNet48Engine_RejectsLateCancelledExpiredAndWrongBinaryRequests()
        {
            var api = Load();
            Assert.Equal("PROTOCOL_NOT_NEGOTIATED", Code(await Send(api, Envelope("not-negotiated", "Ping"))));
            var build = Get<string>(Call(api, "NegotiateProtocol", Handshake()), "BuildId");
            Assert.Equal("BUILD_ID_MISMATCH", Code(await Send(api, Envelope("wrong-binary", "Ping"))));
            Assert.Equal("DEADLINE_EXCEEDED", Code(await Send(api, Envelope(build, "Ping", deadline: 1))));
            Assert.True((bool)Call(api, "CancelV2Request", "session-1", "cancel-1"));
            Assert.Equal("CANCELLED", Code(await Send(api, Envelope(build, "Ping"))));
            Assert.Equal("OK", Code(await Send(api, Envelope(build, "Ping", request: "new", generation: 2, revision: "revision-2"))));
            Assert.Equal("STALE_GENERATION", Code(await Send(api, Envelope(build, "Ping", request: "late", generation: 1))));
            Assert.Equal("STALE_REVISION", Code(await Send(api, Envelope(build, "Ping", request: "wrong-revision", generation: 2))));
            Assert.Equal("UNSUPPORTED_OPERATION", Code(await Send(api, Envelope(build, "GetType", request: "recursive"))));
            using (var cancellation = new CancellationTokenSource())
            {
                cancellation.Cancel();
                var task = (Task)Call(api, "ExecuteV2Envelope", Envelope(build, "Ping", request: "pre-cancelled"), cancellation.Token);
                await task;
                Assert.Equal("CANCELLED", Code(Get<object>(task, "Result")));
            }
        }

        [Fact]
        public async Task ActualNet48Engine_MutationRetryReturnsEstablishedProposalAndRejectsDifferentPayload()
        {
            var api = Load();
            var build = Get<string>(Call(api, "NegotiateProtocol", Handshake()), "BuildId");
            var directory = Path.Combine(Path.GetTempPath(), "wfd-net48-protocol-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(directory);
            var designer = Path.Combine(directory, "Form1.Designer.cs");
            const string source = "partial class Form1 { }";
            File.WriteAllText(designer, source);
            try
            {
                var args = "[\"" + Escape(designer) + "\",\"fr-FR\"]";
                var first = await Send(api, Envelope(build, "SetLocalizationCulture", args: args, source: source));
                Assert.Equal("OK", Code(first));
                Assert.Equal("\"fr-FR\"", Get<string>(first, "ResultJson"));
                var retry = await Send(api, Envelope(build, "SetLocalizationCulture", request: "retry", args: args, source: source));
                Assert.Equal("OK", Code(retry));
                Assert.Equal("retry", Get<string>(retry, "RequestId"));
                Assert.Equal(Get<string>(first, "ResultJson"), Get<string>(retry, "ResultJson"));
                Assert.Equal("COMMAND_ID_CONFLICT", Code(await Send(api, Envelope(build, "SetLocalizationCulture", request: "conflict",
                    args: "[\"" + Escape(designer) + "\",\"de-DE\"]", source: source))));
                File.WriteAllText(designer, source + " // external change");
                Assert.Equal("OK", Code(await Send(api, Envelope(build, "SetLocalizationCulture", request: "external", args: args, source: source))));
                Assert.Equal("STALE_SOURCE", Code(await Send(api, Envelope(build, "DescribeInterpretedComponent", request: "source-mismatch",
                    args: "[\"" + Escape(designer) + "\",\"missing.dll\",\"" + source + " changed\",\"this\"]", source: source))));
            }
            finally
            {
                File.Delete(designer);
                Directory.Delete(directory);
            }
        }

        private static object Load()
        {
            var configuration = typeof(RuntimeProtocolTests).Assembly.GetCustomAttribute<AssemblyConfigurationAttribute>()?.Configuration ?? "Debug";
            var directory = new DirectoryInfo(AppDomain.CurrentDomain.BaseDirectory);
            while (directory != null)
            {
                var project = Path.Combine(directory.FullName, "engine-net48", "Engine.Net48.csproj");
                if (File.Exists(project))
                {
                    var assembly = Assembly.LoadFrom(Path.Combine(directory.FullName, "engine-net48", "bin", configuration, "net48", "WinFormsDesigner.Engine.Net48.exe"));
                    return Activator.CreateInstance(assembly.GetType("WinFormsDesigner.Engine.Net48.EngineApi", true));
                }
                directory = directory.Parent;
            }
            throw new FileNotFoundException("Built net48 engine was not found.");
        }
        private static object Call(object api, string method, params object[] args) => api.GetType().GetMethod(method).Invoke(api, args);
        private static T Get<T>(object value, string property) => (T)value.GetType().GetProperty(property).GetValue(value);
        private static string Code(object value) => Get<string>(Get<object>(value, "Outcome"), "Code");
        private static async Task<object> Rpc(object client, Type resultType, string method, params object[] args)
        {
            var invocation = client.GetType().GetMethods().Single(candidate => candidate.Name == "InvokeWithCancellationAsync"
                && candidate.IsGenericMethodDefinition && candidate.GetParameters().Length == 3).MakeGenericMethod(resultType);
            var task = (Task)invocation.Invoke(client, new object[] { method, args, CancellationToken.None });
            await task;
            return Get<object>(task, "Result");
        }
        private static async Task Within(Task task, int milliseconds)
        {
            Assert.Same(task, await Task.WhenAny(task, Task.Delay(milliseconds)));
            await task;
        }
        private static async Task<object> Send(object api, string json)
        {
            var task = (Task)Call(api, "ExecuteV2Envelope", json, CancellationToken.None);
            await task;
            return Get<object>(task, "Result");
        }
        private static string Handshake(int minimum = 1, int maximum = 2, string capability = "protocol.rpc-envelope") =>
            "{\"protocolId\":\"designer-protocol-v2\",\"minimumVersion\":" + minimum + ",\"maximumVersion\":" + maximum
            + ",\"requiredCapabilities\":[\"" + capability + "\"]}";
        private static string Envelope(string build, string method, string request = "request-1", long generation = 1,
            string revision = "revision-1", long deadline = 4102444800000L, string args = "[]", string source = "")
        {
            var payload = "{\"method\":\"" + method + "\",\"args\":" + args + "}";
            return "{\"protocolId\":\"designer-protocol-v2\",\"protocolVersion\":2,\"messageKind\":\"request\","
                + "\"buildId\":\"" + build + "\",\"sessionId\":\"session-1\",\"documentId\":\"document-1\","
                + "\"requestId\":\"" + request + "\",\"traceId\":\"trace-1\",\"commandId\":\"operation-1\","
                + "\"documentRevision\":\"" + revision + "\",\"renderGeneration\":" + generation + ","
                + "\"sourceFingerprint\":{\"algorithm\":\"sha256\",\"artifactId\":\"source\",\"value\":\"" + Hash(Encoding.UTF8.GetBytes(source))
                + "\",\"byteLength\":" + Encoding.UTF8.GetByteCount(source) + "},\"resourceFingerprints\":[],"
                + "\"deadlineUnixMilliseconds\":" + deadline + ",\"cancellationToken\":\"" + (request == "request-1" ? "cancel-1" : request + ":cancel") + "\","
                + "\"capabilities\":[\"protocol.rpc-envelope\"],\"requiredCapabilities\":[\"protocol.rpc-envelope\"],"
                + "\"payloadContentType\":\"application/json\",\"payloadBytes\":" + Encoding.UTF8.GetByteCount(payload) + ",\"payloadJson\":\"" + Escape(payload) + "\"}";
        }
        private static string Escape(string value) => value.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "\\r").Replace("\n", "\\n");
        private static string Hash(byte[] value)
        {
            using (var sha = SHA256.Create()) return string.Concat(sha.ComputeHash(value).Select(item => item.ToString("x2")));
        }
    }
}
