using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.ComponentModel.Design;
using System.ComponentModel.Design.Serialization;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using System.Windows.Forms.Design;
using Newtonsoft.Json;
using WinFormsDesigner.Engine;

namespace WinFormsDesigner.Engine.Net48
{
    /// <summary>
    /// net48 process broker for the exact repository-certified hosted-service fixture. The long-lived JSON-RPC
    /// process validates identity and starts a disposable private-desktop child; only the shared DTO comes back.
    /// The child uses the same compile-linked DesignerServiceKernel source as the modern engine.
    /// </summary>
    internal sealed class HostedServiceKernelBroker
    {
        internal const string CertificationId = "repo.fakevendor.hosted-service-kernel.v1";
        internal const string ComponentTypeName = "FakeVendor.HostedServiceControl";
        internal const string DesignerTypeName = "FakeVendor.HostedServiceControlDesigner";
        internal const string ActionListTypeName = "FakeVendor.HostedServiceControlActionList";
        internal const string CommandId = "applyServicePreset";
        internal const string ReentrantCommandId = "cancelReentrantServiceAction";
        private const string ActionMemberName = "ApplyServicePreset";
        private const string ReentrantActionMemberName = "CancelReentrantServiceAction";
        private const string AssemblyName = "FakeVendor";
        private const int WorkerTimeoutMs = 15_000;

        public HostedServiceKernelProductResult Inspect(
            string assemblyPath, string componentTypeName, string certificationId) =>
            ExecuteChild(assemblyPath, componentTypeName, certificationId, actionId: "");

        public HostedServiceKernelProductResult Invoke(
            string assemblyPath, string componentTypeName, string certificationId, string actionId) =>
            ExecuteChild(assemblyPath, componentTypeName, certificationId, actionId ?? "");

        private static HostedServiceKernelProductResult ExecuteChild(
            string assemblyPath, string componentTypeName, string certificationId, string actionId)
        {
            string fullPath;
            string sha;
            HostedServiceKernelProductResult refusal;
            if (!TryValidateRequest(assemblyPath, componentTypeName, certificationId, actionId,
                    out fullPath, out sha, out refusal))
                return refusal;

            string exe = Assembly.GetEntryAssembly()?.Location ?? "";
            if (exe.Length == 0 || !exe.EndsWith(".exe", StringComparison.OrdinalIgnoreCase))
                return Refused(componentTypeName, certificationId, sha, "WORKER_UNAVAILABLE",
                    "The net48 hosted-service executable is unavailable.");

            string resultPath = Path.Combine(Path.GetTempPath(),
                "wfd-hosted-service-" + Guid.NewGuid().ToString("N") + ".json");
            Process? child = null;
            try
            {
                var arguments = new List<string>
                {
                    "--hosted-service-worker",
                    "--assembly", RenderDesktop.Quote(fullPath),
                    "--component-type", RenderDesktop.Quote(componentTypeName),
                    "--certification", RenderDesktop.Quote(certificationId),
                    "--assembly-sha256", RenderDesktop.Quote(sha),
                    "--result", RenderDesktop.Quote(resultPath),
                };
                if (actionId.Length > 0)
                {
                    arguments.Add("--action");
                    arguments.Add(RenderDesktop.Quote(actionId));
                }
                child = Process.Start(new ProcessStartInfo
                {
                    FileName = exe,
                    Arguments = string.Join(" ", arguments),
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    WorkingDirectory = Path.GetDirectoryName(fullPath) ?? AppDomain.CurrentDomain.BaseDirectory,
                });
                if (child == null)
                    return Refused(componentTypeName, certificationId, sha, "WORKER_UNAVAILABLE",
                        "The net48 hosted-service worker could not be started.");
                if (!child.WaitForExit(WorkerTimeoutMs))
                {
                    try { child.Kill(); } catch { }
                    try { child.WaitForExit(2_000); } catch { }
                    return Refused(componentTypeName, certificationId, sha, "HOSTED_SERVICE_WORKER_FAULT",
                        "The net48 hosted-service worker exceeded its bounded deadline.");
                }
                HostedServiceKernelProductResult? result = ReadResult(resultPath);
                if (child.ExitCode != 0 || result == null)
                    return Refused(componentTypeName, certificationId, sha, "HOSTED_SERVICE_WORKER_FAULT",
                        "The net48 hosted-service worker exited without a valid result.");
                if (!string.Equals(result.ComponentType, componentTypeName, StringComparison.Ordinal)
                    || !string.Equals(result.CertificationId, certificationId, StringComparison.Ordinal)
                    || !string.Equals(result.AssemblySha256, sha, StringComparison.OrdinalIgnoreCase)
                    || !string.Equals(result.ActionId, actionId, StringComparison.Ordinal))
                    return Refused(componentTypeName, certificationId, sha, "INVALID_WORKER_RESULT",
                        "The net48 hosted-service worker returned a mismatched identity.");
                return result;
            }
            catch (Exception ex)
            {
                return Refused(componentTypeName, certificationId, sha, "WORKER_UNAVAILABLE",
                    ex.GetBaseException().Message);
            }
            finally
            {
                child?.Dispose();
                try { if (File.Exists(resultPath)) File.Delete(resultPath); } catch { }
            }
        }

        internal static int RunWorker(
            string assemblyPath,
            string componentTypeName,
            string certificationId,
            string expectedSha256,
            string actionId,
            string resultPath)
        {
            HostedServiceKernelProductResult result;
            try
            {
                string fullPath;
                string actualSha;
                HostedServiceKernelProductResult refusal;
                if (!TryValidateRequest(assemblyPath, componentTypeName, certificationId, actionId,
                        out fullPath, out actualSha, out refusal)
                    || !string.Equals(actualSha, expectedSha256, StringComparison.OrdinalIgnoreCase))
                {
                    result = Refused(componentTypeName, certificationId, actualSha,
                        "CERTIFICATION_MISMATCH",
                        "The hosted-service assembly identity changed before worker activation.", actionId);
                    WriteResult(resultPath, result);
                    return 0;
                }

                HostedServiceKernelProductResult? staResult = null;
                Exception? staError = null;
                var thread = new Thread(() =>
                {
                    try { staResult = ExecuteOnSta(fullPath, componentTypeName, certificationId, actualSha, actionId); }
                    catch (Exception ex) { staError = ex.GetBaseException(); }
                })
                {
                    IsBackground = false,
                    Name = "WinFormsDesigner.HostedService.STA",
                };
                thread.SetApartmentState(ApartmentState.STA);
                thread.Start();
                if (!thread.Join(WorkerTimeoutMs - 2_000))
                    Environment.FailFast("Certified hosted-service execution timed out.");
                result = staError == null && staResult != null
                    ? staResult
                    : Refused(componentTypeName, certificationId, actualSha,
                        "HOSTED_SERVICE_WORKER_FAULT",
                        staError == null ? "The hosted-service worker returned no result." : staError.Message,
                        actionId);
            }
            catch (Exception ex)
            {
                result = Refused(componentTypeName, certificationId, expectedSha256,
                    "HOSTED_SERVICE_WORKER_FAULT", ex.GetBaseException().Message, actionId);
            }
            try { WriteResult(resultPath, result); } catch { return 4; }
            return 0;
        }

        private static HostedServiceKernelProductResult ExecuteOnSta(
            string assemblyPath,
            string componentTypeName,
            string certificationId,
            string sha,
            string actionId)
        {
            string directory = Path.GetDirectoryName(assemblyPath) ?? "";
            ResolveEventHandler resolver = (_, eventArgs) =>
            {
                try
                {
                    string candidate = Path.Combine(directory,
                        new System.Reflection.AssemblyName(eventArgs.Name).Name + ".dll");
                    return File.Exists(candidate) ? Assembly.LoadFrom(candidate) : null;
                }
                catch { return null; }
            };
            AppDomain.CurrentDomain.AssemblyResolve += resolver;
            try
            {
                Assembly assembly = Assembly.LoadFrom(assemblyPath);
                Type componentType = assembly.GetType(componentTypeName, throwOnError: true);
                if (!typeof(Control).IsAssignableFrom(componentType) || componentType.IsAbstract)
                    return Refused(componentTypeName, certificationId, sha, "CERTIFIED_COMPONENT_MISMATCH",
                        "The certified component is not a concrete WinForms Control.", actionId);

                bool incompleteHostWithheld;
                string incompleteHostReason;
                using (var incompleteComponent = (Control)Activator.CreateInstance(componentType))
                using (var incomplete = DesignerServiceKernel.CreateHostedSession(
                    incompleteComponent,
                    "hostedServiceControl1",
                    DesignerServiceKernel.ImplementedCapabilities.Where(
                        capability => capability != DesignerServiceKernelCapability.Selection),
                    CreateDesigner))
                {
                    incompleteHostWithheld = !incomplete.AdvertisesDesignerHost
                        && incomplete.GetService(typeof(IDesignerHost)) == null
                        && incompleteComponent.Site?.GetService(typeof(IDesignerHost)) == null
                        && incomplete.TryGetServiceRefusal(typeof(IDesignerHost), out _);
                    incomplete.TryGetServiceRefusal(typeof(IDesignerHost), out var refusal);
                    incompleteHostReason = refusal?.Reason ?? "";
                }

                using (var component = (Control)Activator.CreateInstance(componentType))
                {
                    component.Text = "Before service action";
                    component.Size = new Size(100, 30);
                    using (var session = DesignerServiceKernel.CreateHostedSession(
                        component, "hostedServiceControl1", designerCreator: CreateDesigner))
                    {
                        IDesigner designer = session.Host.GetDesigner(component)
                            ?? throw new InvalidOperationException("The certified ComponentDesigner is unavailable.");
                        if (!(designer is ControlDesigner)
                            || !string.Equals(designer.GetType().FullName, DesignerTypeName, StringComparison.Ordinal))
                            throw new InvalidOperationException("The hosted designer type does not match its certificate.");

                        bool completeObserved = ReadBooleanProperty(designer, "CompleteHostObserved");
                        bool unsupportedObserved = ReadBooleanProperty(designer, "UnsupportedServiceObserved");
                        bool unsupportedRefusalRecorded = session.TryGetServiceRefusal(
                            typeof(IDesignerSerializationService), out var unsupportedRefusal);
                        bool unsupportedRefused = unsupportedObserved && unsupportedRefusalRecorded;
                        string unsupportedReason = unsupportedRefusal?.Reason ?? "";
                        bool completeHostAdvertised = session.AdvertisesDesignerHost
                            && ReferenceEquals(session.Host, session.GetService(typeof(IDesignerHost)))
                            && ReferenceEquals(session.Host, component.Site?.GetService(typeof(IDesignerHost)))
                            && completeObserved;
                        if (!completeHostAdvertised || !incompleteHostWithheld || !unsupportedRefused)
                            return Refused(componentTypeName, certificationId, sha, "INCOMPLETE_SERVICE_CONTRACT",
                                "The net48 service graph did not prove complete-host advertisement, incomplete-host withholding, and unsupported-service refusal together.",
                                actionId);

                        int opened = 0;
                        int committed = 0;
                        int cancelled = 0;
                        int changeEvents = 0;
                        var edits = new List<HostedServiceKernelEdit>();
                        if (actionId.Length > 0)
                        {
                            DesignerActionList actionList = ResolveActionList(designer, actionId, certificationId);
                            var changes = session.GetService(typeof(IComponentChangeService)) as IComponentChangeService
                                ?? throw new InvalidOperationException("IComponentChangeService is unavailable.");
                            DesignerTransactionCloseEventHandler closed = (_, args) =>
                            {
                                if (args.TransactionCommitted) committed++;
                                else cancelled++;
                            };
                            EventHandler openedHandler = (_, __) => opened++;
                            ComponentChangingEventHandler changing = (_, __) => changeEvents++;
                            ComponentChangedEventHandler changed = (_, __) => changeEvents++;
                            session.Host.TransactionOpened += openedHandler;
                            session.Host.TransactionClosed += closed;
                            changes.ComponentChanging += changing;
                            changes.ComponentChanged += changed;
                            try
                            {
                                string memberName = string.Equals(actionId, ReentrantCommandId, StringComparison.Ordinal)
                                    ? ReentrantActionMemberName
                                    : ActionMemberName;
                                MethodInfo method = actionList.GetType().GetMethod(memberName,
                                    BindingFlags.Instance | BindingFlags.Public, null, Type.EmptyTypes, null)
                                    ?? throw new InvalidOperationException("The certified hosted action method is unavailable.");
                                method.Invoke(actionList, null);
                            }
                            catch (TargetInvocationException ex) when (ex.InnerException != null)
                            {
                                throw new InvalidOperationException("Certified hosted action failed: "
                                    + ex.InnerException.GetType().Name + ": " + ex.InnerException.Message,
                                    ex.InnerException);
                            }
                            finally
                            {
                                session.Host.TransactionOpened -= openedHandler;
                                session.Host.TransactionClosed -= closed;
                                changes.ComponentChanging -= changing;
                                changes.ComponentChanged -= changed;
                            }

                            if (string.Equals(actionId, ReentrantCommandId, StringComparison.Ordinal))
                            {
                                bool refusalRecorded = session.TryGetServiceRefusal(
                                    typeof(DesignerTransaction), out var reentrantRefusal);
                                bool cancelledExactly = !session.Host.InTransaction
                                    && opened == 1 && committed == 0 && cancelled == 1 && changeEvents == 4
                                    && component.Text == "Before service action"
                                    && component.Size == new Size(100, 30)
                                    && refusalRecorded
                                    && reentrantRefusal.Reason.IndexOf(
                                        "Nested designer transactions", StringComparison.Ordinal) >= 0;
                                return Result(
                                    ok: false,
                                    status: "cancelled",
                                    errorCode: cancelledExactly ? "REENTRANT_CANCELLED" : "INVALID_TRANSACTION_RESULT",
                                    reason: cancelledExactly
                                        ? reentrantRefusal.Reason
                                        : "The reentrant hosted action did not restore the graph and cancel exactly once.",
                                    componentTypeName, designer, certificationId, sha, session,
                                    completeHostAdvertised, incompleteHostWithheld, incompleteHostReason,
                                    unsupportedRefused, unsupportedReason, actionId, true,
                                    opened, committed, cancelled, changeEvents, edits);
                            }

                            if (session.Host.InTransaction || opened != 1 || committed != 1 || cancelled != 0
                                || changeEvents != 4 || component.Text != "Hosted service preset"
                                || component.Size != new Size(180, 42))
                                return Refused(componentTypeName, certificationId, sha,
                                    "INVALID_TRANSACTION_RESULT",
                                    "The certified net48 action did not produce one committed transaction and the exact bounded result.",
                                    actionId);
                            edits.Add(new HostedServiceKernelEdit
                            {
                                PropertyName = nameof(Control.Text),
                                PropertyType = typeof(string).FullName,
                                InvariantValue = component.Text,
                            });
                            edits.Add(new HostedServiceKernelEdit
                            {
                                PropertyName = nameof(Control.Size),
                                PropertyType = typeof(Size).FullName,
                                InvariantValue = component.Width + ", " + component.Height,
                            });
                        }

                        return Result(
                            ok: true,
                            status: actionId.Length == 0 ? "ready" : "applied",
                            errorCode: "",
                            reason: "",
                            componentTypeName, designer, certificationId, sha, session,
                            completeHostAdvertised, incompleteHostWithheld, incompleteHostReason,
                            unsupportedRefused, unsupportedReason, actionId, actionId.Length > 0,
                            opened, committed, cancelled, changeEvents, edits);
                    }
                }
            }
            finally { AppDomain.CurrentDomain.AssemblyResolve -= resolver; }
        }

        private static object? CreateDesigner(IComponent component, Type designerBaseType) =>
            TypeDescriptor.CreateDesigner(component, designerBaseType);

        private static DesignerActionList ResolveActionList(
            IDesigner designer, string actionId, string certificationId)
        {
            if (!(designer is ComponentDesigner componentDesigner))
                throw new InvalidOperationException("The certified designer has no action-list surface.");
            string expectedMember = string.Equals(actionId, ReentrantCommandId, StringComparison.Ordinal)
                ? ReentrantActionMemberName
                : ActionMemberName;
            foreach (DesignerActionList list in componentDesigner.ActionLists)
            {
                if (!string.Equals(list.GetType().FullName, ActionListTypeName, StringComparison.Ordinal)) continue;
                foreach (DesignerActionItem item in list.GetSortedActionItems())
                {
                    var methodItem = item as DesignerActionMethodItem;
                    if (methodItem == null || !string.Equals(
                            methodItem.MemberName, expectedMember, StringComparison.Ordinal)) continue;
                    string declaredAction = InvokeStringAdapter(list, "GetHostedDesignerCommandId", expectedMember);
                    string declaredCertificate = InvokeStringAdapter(
                        list, "GetHostedDesignerCommandCertificationId", expectedMember);
                    if (string.Equals(declaredAction, actionId, StringComparison.Ordinal)
                        && string.Equals(declaredCertificate, certificationId, StringComparison.Ordinal))
                        return list;
                }
            }
            throw new InvalidOperationException("CERTIFIED_ACTION_MISMATCH: exact hosted service action is unavailable.");
        }

        private static string InvokeStringAdapter(object target, string methodName, string memberName)
        {
            MethodInfo? method = target.GetType().GetMethod(methodName,
                BindingFlags.Instance | BindingFlags.Public, null, new[] { typeof(string) }, null);
            return method?.ReturnType == typeof(string)
                ? method.Invoke(target, new object[] { memberName }) as string ?? ""
                : "";
        }

        private static bool ReadBooleanProperty(object target, string propertyName) =>
            target.GetType().GetProperty(propertyName,
                BindingFlags.Instance | BindingFlags.Public)?.GetValue(target, null) is true;

        private static HostedServiceKernelProductResult Result(
            bool ok,
            string status,
            string errorCode,
            string reason,
            string componentType,
            IDesigner designer,
            string certificationId,
            string sha,
            DesignerServiceKernelSession session,
            bool completeHostAdvertised,
            bool incompleteHostWithheld,
            string incompleteHostReason,
            bool unsupportedServiceRefused,
            string unsupportedServiceReason,
            string actionId,
            bool actionInvoked,
            int transactionsOpened,
            int transactionsCommitted,
            int transactionsCancelled,
            int changeEvents,
            List<HostedServiceKernelEdit> edits) => new HostedServiceKernelProductResult
        {
            Ok = ok,
            Status = status,
            ErrorCode = errorCode,
            Reason = reason,
            ComponentType = componentType,
            DesignerType = designer.GetType().FullName ?? designer.GetType().Name,
            CertificationId = certificationId,
            AssemblySha256 = sha,
            ApartmentState = Thread.CurrentThread.GetApartmentState().ToString(),
            Capabilities = session.Capabilities.Select(capability => capability.ToString()).ToList(),
            CompleteHostAdvertised = completeHostAdvertised,
            IncompleteHostWithheld = incompleteHostWithheld,
            IncompleteHostReason = incompleteHostReason,
            UnsupportedServiceRefused = unsupportedServiceRefused,
            UnsupportedServiceReason = unsupportedServiceReason,
            ActionId = actionId,
            ActionInvoked = actionInvoked,
            TransactionsOpened = transactionsOpened,
            TransactionsCommitted = transactionsCommitted,
            TransactionsCancelled = transactionsCancelled,
            ChangeEvents = changeEvents,
            Edits = edits,
        };

        private static bool TryValidateRequest(
            string assemblyPath,
            string componentTypeName,
            string certificationId,
            string actionId,
            out string fullPath,
            out string sha,
            out HostedServiceKernelProductResult refusal)
        {
            fullPath = "";
            sha = "";
            refusal = Refused(componentTypeName, certificationId, "", "CERTIFIED_HOSTED_SERVICE_MISMATCH",
                "The hosted-service request identity is not allowlisted.", actionId);
            if (!string.Equals(componentTypeName, ComponentTypeName, StringComparison.Ordinal)
                || !string.Equals(certificationId, CertificationId, StringComparison.Ordinal)
                || (actionId.Length > 0
                    && !string.Equals(actionId, CommandId, StringComparison.Ordinal)
                    && !string.Equals(actionId, ReentrantCommandId, StringComparison.Ordinal)))
                return false;
            try
            {
                fullPath = Path.GetFullPath(assemblyPath ?? "");
                if (!File.Exists(fullPath)
                    || !string.Equals(Path.GetFileName(fullPath), AssemblyName + ".dll",
                        StringComparison.OrdinalIgnoreCase)
                    || !string.Equals(System.Reflection.AssemblyName.GetAssemblyName(fullPath).Name,
                        AssemblyName, StringComparison.Ordinal))
                {
                    refusal = Refused(componentTypeName, certificationId, "",
                        "CERTIFIED_ASSEMBLY_MISMATCH", "The exact FakeVendor.dll identity is required.", actionId);
                    return false;
                }
                sha = Sha256FileHex(fullPath);
                return sha.Length == 64;
            }
            catch (Exception ex)
            {
                refusal = Refused(componentTypeName, certificationId, sha,
                    "CERTIFIED_ASSEMBLY_MISMATCH", ex.GetBaseException().Message, actionId);
                return false;
            }
        }

        private static string Sha256FileHex(string path)
        {
            using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read,
                       FileShare.ReadWrite | FileShare.Delete))
            using (var algorithm = SHA256.Create())
                return BitConverter.ToString(algorithm.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
        }

        private static HostedServiceKernelProductResult? ReadResult(string path)
        {
            try
            {
                return File.Exists(path)
                    ? JsonConvert.DeserializeObject<HostedServiceKernelProductResult>(
                        File.ReadAllText(path, Encoding.UTF8))
                    : null;
            }
            catch { return null; }
        }

        private static void WriteResult(string path, HostedServiceKernelProductResult result)
        {
            if (string.IsNullOrWhiteSpace(path) || !Path.IsPathRooted(path))
                throw new InvalidOperationException("A rooted hosted-service result path is required.");
            string directory = Path.GetDirectoryName(path) ?? "";
            if (directory.Length == 0 || !Directory.Exists(directory))
                throw new InvalidOperationException("The hosted-service result directory is unavailable.");
            File.WriteAllText(path, JsonConvert.SerializeObject(result), new UTF8Encoding(false));
        }

        private static HostedServiceKernelProductResult Refused(
            string componentType,
            string certificationId,
            string sha,
            string errorCode,
            string reason,
            string actionId = "") => new HostedServiceKernelProductResult
        {
            Ok = false,
            Status = "refused",
            ErrorCode = errorCode,
            Reason = reason,
            ComponentType = componentType ?? "",
            CertificationId = certificationId ?? "",
            AssemblySha256 = sha ?? "",
            ActionId = actionId ?? "",
        };
    }
}
