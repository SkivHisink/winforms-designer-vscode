using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.ComponentModel.Design;
using System.ComponentModel.Design.Serialization;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Security.Cryptography;
using System.Threading;
using System.Windows.Forms;

namespace WinFormsDesigner.Engine
{
    /// <summary>
    /// Bounded product bridge from one exact repository-certified designer action into the hosted service kernel.
    /// The vendor callback mutates only a disposable component graph; this broker returns invariant proposals and the
    /// extension must independently plan every source edit and commit the complete set as one native undo unit.
    /// </summary>
    internal static class HostedServiceKernelProductBroker
    {
        internal const string CertificationId = "repo.fakevendor.hosted-service-kernel.v1";
        internal const string CommandId = "applyServicePreset";
        internal const string ReentrantCommandId = "cancelReentrantServiceAction";
        internal const string ComponentTypeName = "FakeVendor.HostedServiceControl";
        internal const string DesignerTypeName = "FakeVendor.HostedServiceControlDesigner";
        private const string AssemblySimpleName = "FakeVendor";
        internal const string ActionListTypeName = "FakeVendor.HostedServiceControlActionList";
        internal const string ActionMemberName = "ApplyServicePreset";
        internal const string ReentrantActionMemberName = "CancelReentrantServiceAction";

        public static HostedServiceKernelProductResult Inspect(
            string assemblyPath,
            string componentTypeName,
            string certificationId) =>
            Execute(assemblyPath, componentTypeName, certificationId, actionId: null);

        public static HostedServiceKernelProductResult Invoke(
            string assemblyPath,
            string componentTypeName,
            string certificationId,
            string actionId) =>
            Execute(assemblyPath, componentTypeName, certificationId, actionId);

        private static HostedServiceKernelProductResult Execute(
            string assemblyPath,
            string componentTypeName,
            string certificationId,
            string? actionId)
        {
            string sha = "";
            try
            {
                string path = ValidateRequest(assemblyPath, componentTypeName, certificationId, actionId);
                sha = Sha256Hex(path);
                var context = new ControlLoadContext(path, new[] { Path.GetDirectoryName(path)! });
                try
                {
                    Assembly assembly = context.LoadNoLock(path);
                    if (!string.Equals(assembly.GetName().Name, AssemblySimpleName, StringComparison.Ordinal))
                        throw new InvalidOperationException("CERTIFIED_ASSEMBLY_MISMATCH: loaded assembly identity changed.");
                    Type componentType = assembly.GetType(ComponentTypeName, throwOnError: true, ignoreCase: false)!;
                    if (!typeof(Control).IsAssignableFrom(componentType) || componentType.IsAbstract)
                        throw new InvalidOperationException("CERTIFIED_COMPONENT_MISMATCH: component is not a concrete Control.");
                    Type designerType = ResolveCertifiedDesignerType(assembly, componentType);
                    KernelDesignerCreator creator = (component, _) =>
                        component.GetType() == componentType ? Activator.CreateInstance(designerType) : null;

                    bool incompleteHostWithheld;
                    string incompleteHostReason;
                    using (var incompleteComponent = (Control)Activator.CreateInstance(componentType)!)
                    using (var incomplete = DesignerServiceKernel.CreateHostedSession(
                        incompleteComponent,
                        "hostedServiceControl1",
                        DesignerServiceKernel.ImplementedCapabilities.Where(
                            capability => capability != DesignerServiceKernelCapability.Selection),
                        creator))
                    {
                        incompleteHostWithheld = !incomplete.AdvertisesDesignerHost
                            && incomplete.GetService(typeof(IDesignerHost)) == null
                            && incompleteComponent.Site?.GetService(typeof(IDesignerHost)) == null
                            && incomplete.TryGetServiceRefusal(typeof(IDesignerHost), out _);
                        incomplete.TryGetServiceRefusal(typeof(IDesignerHost), out var refusal);
                        incompleteHostReason = refusal?.Reason ?? "";
                    }

                    using var component = (Control)Activator.CreateInstance(componentType)!;
                    component.Text = "Before service action";
                    component.Size = new Size(120, 32);
                    using var session = DesignerServiceKernel.CreateHostedSession(
                        component, "hostedServiceControl1", designerCreator: creator);
                    var inspection = session.InspectDesigner(component);
                    if (!inspection.Ok)
                        return Refused(componentTypeName, certificationId, sha,
                            inspection.ErrorCode.Length == 0 ? "DESIGNER_UNAVAILABLE" : inspection.ErrorCode.ToUpperInvariant(),
                            inspection.Reason);
                    if (session.Host.GetDesigner(component) is not ComponentDesigner designer
                        || !string.Equals(designer.GetType().FullName, DesignerTypeName, StringComparison.Ordinal))
                    {
                        return Refused(componentTypeName, certificationId, sha, "DESIGNER_IDENTITY_MISMATCH",
                            "The hosted kernel did not activate the certified ComponentDesigner.");
                    }

                    bool completeHostObserved = ReadBooleanProperty(designer, "CompleteHostObserved");
                    bool unsupportedObserved = ReadBooleanProperty(designer, "UnsupportedServiceObserved");
                    bool unsupportedRefusalRecorded = session.TryGetServiceRefusal(
                        typeof(IDesignerSerializationService), out var unsupportedRefusal);
                    bool unsupportedRefused = unsupportedObserved && unsupportedRefusalRecorded;
                    string unsupportedReason = unsupportedRefusal?.Reason ?? "";
                    bool completeHostAdvertised = session.AdvertisesDesignerHost
                        && ReferenceEquals(session.Host, session.GetService(typeof(IDesignerHost)))
                        && ReferenceEquals(session.Host, component.Site?.GetService(typeof(IDesignerHost)))
                        && completeHostObserved;
                    if (!completeHostAdvertised || !incompleteHostWithheld || !unsupportedRefused)
                    {
                        return Refused(componentTypeName, certificationId, sha, "INCOMPLETE_SERVICE_CONTRACT",
                            "The hosted service contract did not prove complete-host advertisement, incomplete-host withholding, and explicit unsupported-service refusal together.");
                    }

                    int opened = 0;
                    int committed = 0;
                    int cancelled = 0;
                    int changeEvents = 0;
                    var edits = new List<HostedServiceKernelEdit>();
                    bool actionInvoked = false;
                    if (actionId != null)
                    {
                        DesignerActionList actionList = ResolveCertifiedActionList(designer, actionId, certificationId);
                        var changes = session.GetService(typeof(IComponentChangeService)) as IComponentChangeService
                            ?? throw new InvalidOperationException("IComponentChangeService is unavailable after complete-host validation.");
                        void Opened(object? sender, EventArgs args) => opened++;
                        void Closed(object? sender, DesignerTransactionCloseEventArgs args)
                        {
                            if (args.TransactionCommitted) committed++;
                            else cancelled++;
                        }
                        void Changing(object? sender, ComponentChangingEventArgs args) => changeEvents++;
                        void Changed(object? sender, ComponentChangedEventArgs args) => changeEvents++;
                        session.Host.TransactionOpened += Opened;
                        session.Host.TransactionClosed += Closed;
                        changes.ComponentChanging += Changing;
                        changes.ComponentChanged += Changed;
                        try
                        {
                            string memberName = string.Equals(
                                actionId, ReentrantCommandId, StringComparison.Ordinal)
                                ? ReentrantActionMemberName
                                : ActionMemberName;
                            MethodInfo method = actionList.GetType().GetMethod(
                                memberName, BindingFlags.Instance | BindingFlags.Public,
                                binder: null, types: Type.EmptyTypes, modifiers: null)
                                ?? throw new InvalidOperationException("Certified hosted action method is unavailable.");
                            method.Invoke(actionList, null);
                        }
                        catch (TargetInvocationException ex) when (ex.InnerException != null)
                        {
                            throw new InvalidOperationException("Certified hosted action failed: "
                                + ex.InnerException.GetType().Name + ": " + ex.InnerException.Message, ex.InnerException);
                        }
                        finally
                        {
                            session.Host.TransactionOpened -= Opened;
                            session.Host.TransactionClosed -= Closed;
                            changes.ComponentChanging -= Changing;
                            changes.ComponentChanged -= Changed;
                        }

                        actionInvoked = true;
                        if (string.Equals(actionId, ReentrantCommandId, StringComparison.Ordinal))
                        {
                            bool refusalRecorded = session.TryGetServiceRefusal(
                                typeof(DesignerTransaction), out var reentrantRefusal);
                            bool cancelledExactly = !session.Host.InTransaction
                                && opened == 1 && committed == 0 && cancelled == 1 && changeEvents == 4
                                && component.Text == "Before service action"
                                && component.Size == new Size(120, 32)
                                && refusalRecorded
                                && reentrantRefusal.Reason.Contains("Nested designer transactions", StringComparison.Ordinal);
                            return new HostedServiceKernelProductResult
                            {
                                Ok = false,
                                Status = "cancelled",
                                ErrorCode = cancelledExactly ? "REENTRANT_CANCELLED" : "INVALID_TRANSACTION_RESULT",
                                Reason = cancelledExactly
                                    ? reentrantRefusal.Reason
                                    : "The reentrant hosted action did not restore the disposable graph and cancel exactly once.",
                                ComponentType = componentType.FullName ?? componentType.Name,
                                DesignerType = designer.GetType().FullName ?? designer.GetType().Name,
                                CertificationId = certificationId,
                                AssemblySha256 = sha,
                                ApartmentState = Thread.CurrentThread.GetApartmentState().ToString(),
                                Capabilities = session.Capabilities.Select(capability => capability.ToString()).ToList(),
                                CompleteHostAdvertised = completeHostAdvertised,
                                IncompleteHostWithheld = incompleteHostWithheld,
                                IncompleteHostReason = incompleteHostReason,
                                UnsupportedServiceRefused = unsupportedRefused,
                                UnsupportedServiceReason = unsupportedReason,
                                ActionId = actionId,
                                ActionInvoked = true,
                                TransactionsOpened = opened,
                                TransactionsCommitted = committed,
                                TransactionsCancelled = cancelled,
                                ChangeEvents = changeEvents,
                                Edits = edits,
                            };
                        }
                        if (session.Host.InTransaction || opened != 1 || committed != 1 || cancelled != 0
                            || changeEvents != 4 || component.Text != "Hosted service preset"
                            || component.Size != new Size(180, 42))
                        {
                            return Refused(componentTypeName, certificationId, sha, "INVALID_TRANSACTION_RESULT",
                                "The certified action did not produce one committed transaction, two balanced property changes, and the exact bounded result.");
                        }
                        edits.Add(new HostedServiceKernelEdit
                        {
                            PropertyName = nameof(Control.Text),
                            PropertyType = typeof(string).FullName!,
                            InvariantValue = component.Text,
                        });
                        edits.Add(new HostedServiceKernelEdit
                        {
                            PropertyName = nameof(Control.Size),
                            PropertyType = typeof(Size).FullName!,
                            InvariantValue = component.Width + ", " + component.Height,
                        });
                    }

                    return new HostedServiceKernelProductResult
                    {
                        Ok = true,
                        Status = actionInvoked ? "applied" : "ready",
                        ComponentType = componentType.FullName ?? componentType.Name,
                        DesignerType = designer.GetType().FullName ?? designer.GetType().Name,
                        CertificationId = certificationId,
                        AssemblySha256 = sha,
                        ApartmentState = Thread.CurrentThread.GetApartmentState().ToString(),
                        Capabilities = session.Capabilities.Select(capability => capability.ToString()).ToList(),
                        CompleteHostAdvertised = completeHostAdvertised,
                        IncompleteHostWithheld = incompleteHostWithheld,
                        IncompleteHostReason = incompleteHostReason,
                        UnsupportedServiceRefused = unsupportedRefused,
                        UnsupportedServiceReason = unsupportedReason,
                        ActionId = actionId ?? "",
                        ActionInvoked = actionInvoked,
                        TransactionsOpened = opened,
                        TransactionsCommitted = committed,
                        TransactionsCancelled = cancelled,
                        ChangeEvents = changeEvents,
                        Edits = edits,
                    };
                }
                finally
                {
                    context.Unload();
                }
            }
            catch (Exception ex)
            {
                return Refused(componentTypeName, certificationId, sha, "HOSTED_SERVICE_REFUSED",
                    ex.GetBaseException().Message);
            }
        }

        private static string ValidateRequest(
            string assemblyPath,
            string componentTypeName,
            string certificationId,
            string? actionId)
        {
            if (!string.Equals(componentTypeName, ComponentTypeName, StringComparison.Ordinal)
                || !string.Equals(certificationId, CertificationId, StringComparison.Ordinal)
                || (actionId != null
                    && !string.Equals(actionId, CommandId, StringComparison.Ordinal)
                    && !string.Equals(actionId, ReentrantCommandId, StringComparison.Ordinal)))
            {
                throw new InvalidOperationException("CERTIFIED_HOSTED_SERVICE_MISMATCH: request identity is not allowlisted.");
            }
            if (string.IsNullOrWhiteSpace(assemblyPath))
                throw new InvalidOperationException("CERTIFIED_ASSEMBLY_MISSING: assembly path is required.");
            string path = Path.GetFullPath(assemblyPath);
            if (!File.Exists(path)
                || !string.Equals(Path.GetFileName(path), AssemblySimpleName + ".dll", StringComparison.OrdinalIgnoreCase)
                || !string.Equals(AssemblyName.GetAssemblyName(path).Name, AssemblySimpleName, StringComparison.Ordinal))
            {
                throw new InvalidOperationException("CERTIFIED_ASSEMBLY_MISMATCH: exact FakeVendor.dll identity is required.");
            }
            return path;
        }

        private static Type ResolveCertifiedDesignerType(Assembly assembly, Type componentType)
        {
            foreach (DesignerAttribute attribute in TypeDescriptor.GetAttributes(componentType).OfType<DesignerAttribute>())
            {
                Type? type = ResolveTypeInAssemblyContext(assembly, attribute.DesignerTypeName);
                if (type != null && string.Equals(type.FullName, DesignerTypeName, StringComparison.Ordinal)
                    && typeof(ComponentDesigner).IsAssignableFrom(type))
                    return type;
            }
            throw new InvalidOperationException("CERTIFIED_DESIGNER_MISMATCH: exact hosted designer attribute is required.");
        }

        private static Type? ResolveTypeInAssemblyContext(Assembly componentAssembly, string? typeName)
        {
            if (string.IsNullOrWhiteSpace(typeName)) return null;
            return Type.GetType(
                typeName,
                requested => AssemblyName.ReferenceMatchesDefinition(componentAssembly.GetName(), requested)
                    ? componentAssembly
                    : AppDomain.CurrentDomain.GetAssemblies().FirstOrDefault(
                        loaded => AssemblyName.ReferenceMatchesDefinition(loaded.GetName(), requested)),
                (assembly, name, ignoreCase) =>
                    (assembly ?? componentAssembly).GetType(name, throwOnError: false, ignoreCase),
                throwOnError: false);
        }

        private static DesignerActionList ResolveCertifiedActionList(
            ComponentDesigner designer,
            string actionId,
            string certificationId)
        {
            string expectedMember = string.Equals(actionId, ReentrantCommandId, StringComparison.Ordinal)
                ? ReentrantActionMemberName
                : ActionMemberName;
            foreach (DesignerActionList list in designer.ActionLists)
            {
                if (!string.Equals(list.GetType().FullName, ActionListTypeName, StringComparison.Ordinal)) continue;
                foreach (DesignerActionItem item in list.GetSortedActionItems())
                {
                    if (item is not DesignerActionMethodItem methodItem) continue;
                    string memberName = methodItem.MemberName ?? "";
                    if (!string.Equals(memberName, expectedMember, StringComparison.Ordinal)) continue;
                    string declaredAction = InvokeStringAdapter(list, "GetHostedDesignerCommandId", memberName);
                    string declaredCertification = InvokeStringAdapter(
                        list, "GetHostedDesignerCommandCertificationId", memberName);
                    if (string.Equals(declaredAction, actionId, StringComparison.Ordinal)
                        && string.Equals(declaredCertification, certificationId, StringComparison.Ordinal))
                        return list;
                }
            }
            throw new InvalidOperationException("CERTIFIED_ACTION_MISMATCH: exact hosted service action is unavailable.");
        }

        private static string InvokeStringAdapter(object target, string methodName, string memberName)
        {
            MethodInfo? method = target.GetType().GetMethod(
                methodName, BindingFlags.Instance | BindingFlags.Public,
                binder: null, types: new[] { typeof(string) }, modifiers: null);
            return method?.ReturnType == typeof(string)
                ? method.Invoke(target, new object[] { memberName }) as string ?? ""
                : "";
        }

        private static bool ReadBooleanProperty(object target, string propertyName) =>
            target.GetType().GetProperty(propertyName, BindingFlags.Instance | BindingFlags.Public)?.GetValue(target)
                is true;

        private static string Sha256Hex(string path)
        {
            using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            return Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
        }

        private static HostedServiceKernelProductResult Refused(
            string componentType,
            string certificationId,
            string assemblySha256,
            string errorCode,
            string reason) => new()
            {
                ComponentType = componentType ?? "",
                CertificationId = certificationId ?? "",
                AssemblySha256 = assemblySha256,
                ErrorCode = errorCode,
                Reason = reason,
            };
    }
}
