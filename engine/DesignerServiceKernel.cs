using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.ComponentModel.Design;
using System.ComponentModel.Design.Serialization;
using System.Drawing;
using System.Drawing.Design;
using System.Linq;
using System.Reflection;
using System.Threading;
using System.Windows.Forms;
using System.Windows.Forms.Design;
using Microsoft.CodeAnalysis.CSharp;

namespace WinFormsDesigner.Engine
{
    internal enum DesignerServiceKernelCapability
    {
        ContainerSiting,
        Naming,
        ComponentChange,
        Selection,
        Transactions,
        MenuCommands,
    }

    internal static class DesignerServiceKernelGuard
    {
        public static void ThrowIfNull(object? value)
        {
            if (value == null) throw new ArgumentNullException();
        }
    }

    internal sealed class DesignerServiceRefusal
    {
        public required Type ServiceType { get; init; }
        public required string Capability { get; init; }
        public required string Reason { get; init; }
    }

    internal sealed class HostedDesignerInspectionResult
    {
        public bool Ok { get; init; }
        public string ComponentType { get; init; } = "";
        public string DesignerType { get; init; } = "";
        public List<string> ActionListTypes { get; init; } = new();
        public List<string> ActionItems { get; init; } = new();
        public string EditorType { get; set; } = "";
        public string ErrorCode { get; init; } = "";
        public string Reason { get; init; } = "";
        public bool QuarantineRecommended { get; init; }
    }

    internal sealed class HostedDesignerAdornerResult
    {
        public bool Ok { get; init; }
        public string ComponentType { get; init; } = "";
        public string DesignerType { get; init; } = "";
        public List<DesignerAdornerInfo> Adorners { get; init; } = new();
        public bool Hit { get; init; }
        public string HitAdornerId { get; init; } = "";
        public string ErrorCode { get; init; } = "";
        public string Reason { get; init; } = "";
        public bool DeadlineExceeded { get; init; }
        public bool RequiresWorkerTermination { get; init; }
        public bool QuarantineRecommended { get; init; }
    }

    internal sealed class HostedDesignerActionResult
    {
        public bool Ok { get; init; }
        public string ActionName { get; init; } = "";
        public string ComponentType { get; init; } = "";
        public string DesignerType { get; init; } = "";
        public string TargetProperty { get; init; } = "";
        public string OldValue { get; init; } = "";
        public string NewValue { get; init; } = "";
        public int TransactionsOpened { get; init; }
        public int TransactionsCommitted { get; init; }
        public int TransactionsCancelled { get; init; }
        public int ChangeEvents { get; init; }
        public bool RestorationAttempted { get; init; }
        public bool Restored { get; init; }
        public bool RecoveryRequired { get; init; }
        public string ErrorCode { get; init; } = "";
        public string Reason { get; init; } = "";
        public bool DeadlineExceeded { get; init; }
        public bool RequiresWorkerTermination { get; init; }
        public bool QuarantineRecommended { get; init; }
    }

    internal delegate object? KernelDesignerCreator(IComponent component, Type designerBaseType);

    internal static class DesignerServiceKernel
    {
        public static IReadOnlyCollection<DesignerServiceKernelCapability> ImplementedCapabilities { get; } =
            Enum.GetValues(typeof(DesignerServiceKernelCapability))
                .Cast<DesignerServiceKernelCapability>()
                .ToArray();

        public static DesignerServiceKernelSession CreateFormSession(string rootName = "form1",
            IEnumerable<DesignerServiceKernelCapability>? capabilities = null)
        {
            EnsureStaThread();
            return CreateSessionCore(new Form(), rootName, capabilities);
        }

        public static DesignerServiceKernelSession CreateUserControlSession(string rootName = "userControl1",
            IEnumerable<DesignerServiceKernelCapability>? capabilities = null)
        {
            EnsureStaThread();
            return CreateSessionCore(new UserControl(), rootName, capabilities);
        }

        public static DesignerServiceKernelSession CreateSession(IComponent rootComponent, string rootName,
            IEnumerable<DesignerServiceKernelCapability>? capabilities = null)
        {
            EnsureStaThread();
            return CreateSessionCore(rootComponent, rootName, capabilities);
        }

        internal static DesignerServiceKernelSession CreateContractTestFormSession(string rootName = "form1",
            IEnumerable<DesignerServiceKernelCapability>? capabilities = null,
            KernelDesignerCreator? designerCreator = null) =>
            CreateSessionCore(new Form(), rootName, capabilities, designerCreator);

        internal static DesignerServiceKernelSession CreateContractTestUserControlSession(
            string rootName = "userControl1",
            IEnumerable<DesignerServiceKernelCapability>? capabilities = null,
            KernelDesignerCreator? designerCreator = null) =>
            CreateSessionCore(new UserControl(), rootName, capabilities, designerCreator);

        internal static DesignerServiceKernelSession CreateContractTestSession(IComponent rootComponent,
            string rootName, IEnumerable<DesignerServiceKernelCapability>? capabilities = null,
            KernelDesignerCreator? designerCreator = null) =>
            CreateSessionCore(rootComponent, rootName, capabilities, designerCreator);

        /// <summary>Product entry point for an exact certified hosted designer. The caller still owns assembly/type/
        /// certificate validation; this factory only composes the bounded service contract on the engine STA.</summary>
        internal static DesignerServiceKernelSession CreateHostedSession(IComponent rootComponent,
            string rootName, IEnumerable<DesignerServiceKernelCapability>? capabilities = null,
            KernelDesignerCreator? designerCreator = null) =>
            CreateSessionCore(rootComponent, rootName, capabilities, designerCreator);

        private static DesignerServiceKernelSession CreateSessionCore(IComponent rootComponent, string rootName,
            IEnumerable<DesignerServiceKernelCapability>? capabilities,
            KernelDesignerCreator? designerCreator = null)
        {
            DesignerServiceKernelGuard.ThrowIfNull(rootComponent);
            if (string.IsNullOrWhiteSpace(rootName))
                throw new ArgumentException("Root component name is required.", nameof(rootName));

            var enabled = new HashSet<DesignerServiceKernelCapability>(
                capabilities ?? ImplementedCapabilities);
            if (!enabled.Contains(DesignerServiceKernelCapability.ContainerSiting))
            {
                throw new InvalidOperationException(
                    "The hosted-service kernel requires the ContainerSiting capability to create a session.");
            }

            return new DesignerServiceKernelSession(rootComponent, rootName, enabled, designerCreator);
        }

        private static void EnsureStaThread()
        {
            if (Thread.CurrentThread.GetApartmentState() != ApartmentState.STA)
            {
                throw new InvalidOperationException(
                    "DESIGNER_SERVICE_KERNEL_REQUIRES_STA: create hosted sessions on the engine STA dispatcher.");
            }
        }
    }

    internal sealed class DesignerServiceKernelSession : IDisposable
    {
        private readonly KernelDesignerHost _host;

        internal DesignerServiceKernelSession(IComponent rootComponent, string rootName,
            HashSet<DesignerServiceKernelCapability> capabilities,
            KernelDesignerCreator? designerCreator = null)
        {
            _host = new KernelDesignerHost(rootComponent, rootName, capabilities, designerCreator);
        }

        public IDesignerHost Host => _host;
        public IComponent RootComponent => _host.RootComponent;
        public IContainer Container => _host.Container;
        public IReadOnlyCollection<DesignerServiceKernelCapability> Capabilities => _host.Capabilities;
        public bool AdvertisesDesignerHost => _host.AdvertisesDesignerHost;
        public bool IsDisposed => _host.IsDisposed;

        public object? GetService(Type serviceType) => _host.GetService(serviceType);

        public bool TryGetServiceRefusal(Type serviceType, out DesignerServiceRefusal refusal) =>
            _host.TryGetServiceRefusal(serviceType, out refusal);

        public IComponent CreateComponent(Type componentType, string? name = null) =>
            _host.CreateComponent(componentType, name);

        public HostedDesignerInspectionResult InspectDesigner(
            IComponent component,
            IReadOnlyList<string>? editorPropertyPath = null,
            CancellationToken cancellationToken = default) =>
            _host.InspectDesigner(component, editorPropertyPath, cancellationToken);

        public HostedDesignerAdornerResult DescribeDesignerAdorners(
            IComponent component,
            CancellationToken cancellationToken = default,
            TimeSpan? callbackDeadline = null) =>
            _host.DescribeDesignerAdorners(component, cancellationToken, callbackDeadline);

        public HostedDesignerAdornerResult HitTestDesignerAdorner(
            IComponent component,
            int x,
            int y,
            CancellationToken cancellationToken = default,
            TimeSpan? callbackDeadline = null) =>
            _host.HitTestDesignerAdorner(component, x, y, cancellationToken, callbackDeadline);

        public HostedDesignerActionResult InvokeDesignerActionProperty(
            IComponent component,
            string actionDisplayName,
            string newValue,
            CancellationToken cancellationToken = default,
            TimeSpan? callbackDeadline = null) =>
            _host.InvokeDesignerActionProperty(component, actionDisplayName, newValue, cancellationToken, callbackDeadline);

        public void Dispose() => _host.Dispose();
    }

    internal sealed class KernelDesignerHost : IDesignerHost, IDisposable
    {
        private readonly HashSet<DesignerServiceKernelCapability> _capabilities;
        private readonly Dictionary<Type, object> _services = new();
        private readonly Dictionary<Type, ServiceCreatorCallback> _serviceCallbacks = new();
        private readonly HashSet<Type> _callbacksInProgress = new();
        private readonly Dictionary<Type, DesignerServiceRefusal> _refusals = new();
        private readonly Dictionary<IComponent, IDesigner> _designers = new();
        private readonly HashSet<IComponent> _designerCreationInProgress = new();
        private readonly KernelDesignerCreator _designerCreator;
        private readonly KernelComponentChangeService? _changeService;
        private readonly KernelNameCreationService? _nameService;
        private readonly KernelSelectionService? _selectionService;
        private readonly KernelMenuCommandService? _menuCommandService;
        private readonly string[] _missingHostCapabilities;
        private KernelDesignerTransaction? _activeTransaction;

        public KernelDesignerHost(IComponent rootComponent, string rootName,
            HashSet<DesignerServiceKernelCapability> capabilities,
            KernelDesignerCreator? designerCreator = null)
        {
            _capabilities = capabilities;
            _missingHostCapabilities = DesignerServiceKernel.ImplementedCapabilities
                .Where(capability => !_capabilities.Contains(capability))
                .Select(capability => capability.ToString())
                .ToArray();
            _designerCreator = designerCreator ?? TypeDescriptor.CreateDesigner;
            Container = new KernelDesignContainer(this);
            RootComponent = rootComponent;
            RootComponentClassName = rootComponent.GetType().FullName ?? rootComponent.GetType().Name;

            if (IsEnabled(DesignerServiceKernelCapability.ComponentChange))
                _changeService = new KernelComponentChangeService(this);
            if (IsEnabled(DesignerServiceKernelCapability.Naming))
                _nameService = new KernelNameCreationService(this);
            if (IsEnabled(DesignerServiceKernelCapability.Selection))
                _selectionService = new KernelSelectionService(this);
            if (IsEnabled(DesignerServiceKernelCapability.MenuCommands))
                _menuCommandService = new KernelMenuCommandService(this);

            // Vendor designers interpret a non-null IDesignerHost as a complete Visual Studio-style service promise.
            // Keep that promise conjunctive: individual partial services may be queried truthfully, but the aggregate
            // host is withheld until every capability in this bounded contract is present.
            if (AdvertisesDesignerHost)
            {
                RegisterService(typeof(IDesignerHost), this);
            }
            else
            {
                Refuse(typeof(IDesignerHost), "HostedServiceContract",
                    "IDesignerHost is unavailable because the hosted service contract is incomplete; missing: "
                    + string.Join(", ", _missingHostCapabilities) + ".");
            }
            RegisterService(typeof(IServiceContainer), this);
            RegisterService(typeof(IContainer), Container);
            if (_changeService != null) RegisterService(typeof(IComponentChangeService), _changeService);
            if (_nameService != null) RegisterService(typeof(INameCreationService), _nameService);
            if (_selectionService != null) RegisterService(typeof(ISelectionService), _selectionService);
            if (_menuCommandService != null) RegisterService(typeof(IMenuCommandService), _menuCommandService);

            Container.Add(rootComponent, rootName);
        }

        public IReadOnlyCollection<DesignerServiceKernelCapability> Capabilities => _capabilities;
        public bool AdvertisesDesignerHost => _missingHostCapabilities.Length == 0;
        public bool IsDisposed { get; private set; }
        public IContainer Container { get; }
        public bool InTransaction => _activeTransaction != null;
        public bool Loading => false;
        public IComponent RootComponent { get; }
        public string RootComponentClassName { get; }
        public string TransactionDescription => _activeTransaction?.Description ?? string.Empty;

        public event EventHandler? Activated;
        public event EventHandler? Deactivated;
        public event EventHandler? LoadComplete;
        public event DesignerTransactionCloseEventHandler? TransactionClosed;
        public event DesignerTransactionCloseEventHandler? TransactionClosing;
        public event EventHandler? TransactionOpened;
        public event EventHandler? TransactionOpening;

        public void Activate() => Activated?.Invoke(this, EventArgs.Empty);

        public IComponent CreateComponent(Type componentClass) =>
            CreateComponent(componentClass, CreateGeneratedName(componentClass));

        public IComponent CreateComponent(Type componentClass, string? name)
        {
            DesignerServiceKernelGuard.ThrowIfNull(componentClass);
            ThrowIfDisposed();
            if (!typeof(IComponent).IsAssignableFrom(componentClass))
                throw new ArgumentException("Component type must implement IComponent.", nameof(componentClass));

            name ??= CreateGeneratedName(componentClass);
            ValidateNameForAdd(name, existingComponent: null);

            var component = (IComponent)Activator.CreateInstance(componentClass)!;
            Container.Add(component, name);
            return component;
        }

        public DesignerTransaction CreateTransaction() => CreateTransaction(string.Empty);

        public DesignerTransaction CreateTransaction(string description)
        {
            ThrowIfDisposed();
            if (!IsEnabled(DesignerServiceKernelCapability.Transactions))
            {
                Refuse(typeof(DesignerTransaction), nameof(DesignerServiceKernelCapability.Transactions),
                    "Designer transactions are not enabled for this kernel session.");
                throw new NotSupportedException("Designer transactions are not enabled for this kernel session.");
            }

            if (_activeTransaction != null)
            {
                Refuse(typeof(DesignerTransaction), nameof(DesignerServiceKernelCapability.Transactions),
                    "Nested designer transactions are outside this bounded kernel slice.");
                throw new NotSupportedException("Nested designer transactions are outside this bounded kernel slice.");
            }

            TransactionOpening?.Invoke(this, EventArgs.Empty);
            _activeTransaction = new KernelDesignerTransaction(this, description ?? string.Empty);
            TransactionOpened?.Invoke(this, EventArgs.Empty);
            return _activeTransaction;
        }

        public void DestroyComponent(IComponent component)
        {
            DesignerServiceKernelGuard.ThrowIfNull(component);
            ThrowIfDisposed();
            if (!ReferenceEquals(component.Site?.Container, Container))
                throw new InvalidOperationException("Cannot destroy a component outside this designer session.");
            if (ReferenceEquals(component, RootComponent))
                throw new InvalidOperationException("Destroying the root component is outside this bounded kernel slice.");
            Container.Remove(component);
            component.Dispose();
        }

        public IDesigner? GetDesigner(IComponent component)
        {
            DesignerServiceKernelGuard.ThrowIfNull(component);
            ThrowIfDisposed();
            if (!ContainsComponent(component))
            {
                Refuse(typeof(IDesigner), "Designers",
                    "Designer creation is limited to components owned by this kernel session.");
                throw new InvalidOperationException(
                    "Designer creation is limited to components owned by this kernel session.");
            }

            if (_designers.TryGetValue(component, out var cached))
                return cached;

            if (!_designerCreationInProgress.Add(component))
            {
                Refuse(typeof(IDesigner), "Designers",
                    "Reentrant designer creation is not allowed in this kernel session.");
                return null;
            }

            object? created = null;
            try
            {
                created = _designerCreator(component, typeof(IDesigner));
                if (created == null)
                {
                    if (!TryGetServiceRefusal(typeof(IDesigner), out _))
                    {
                        Refuse(typeof(IDesigner), "Designers",
                            "No truthful designer is available for " + ComponentTypeName(component) + ".");
                    }
                    return null;
                }

                if (created is not IDesigner designer)
                {
                    Refuse(typeof(IDesigner), "Designers",
                        "Designer factory returned an object that does not implement IDesigner.");
                    DisposeIfPossible(created);
                    return null;
                }

                designer.Initialize(component);
                _designers.Add(component, designer);
                return designer;
            }
            catch (Exception ex)
            {
                Refuse(typeof(IDesigner), "Designers",
                    "DESIGNER_WORKER_FAULT: Designer creation failed: " + ex.GetType().Name
                    + ". Worker supervisor must quarantine the hosted designer adapter before retry.");
                DisposeIfPossible(created);
                return null;
            }
            finally
            {
                _designerCreationInProgress.Remove(component);
            }
        }

        public Type? GetType(string typeName)
        {
            if (string.IsNullOrWhiteSpace(typeName)) return null;
            return Type.GetType(typeName, ResolveLoadedAssembly, ResolveLoadedType, throwOnError: false,
                ignoreCase: false);
        }

        public object? GetService(Type serviceType)
        {
            DesignerServiceKernelGuard.ThrowIfNull(serviceType);
            ThrowIfDisposed();

            if (_services.TryGetValue(serviceType, out var service))
                return service;

            if (serviceType == typeof(IDesignerHost) && !AdvertisesDesignerHost)
                return null; // the constructor recorded the exact missing-capability refusal

            if (_serviceCallbacks.TryGetValue(serviceType, out var callback))
            {
                if (!_callbacksInProgress.Add(serviceType))
                {
                    Refuse(serviceType, "ServiceRegistration",
                        "Reentrant service creation is not allowed in this kernel session.");
                    throw new InvalidOperationException(
                        "Reentrant service creation is not allowed in this kernel session.");
                }
                try
                {
                    var created = callback(this, serviceType);
                    if (created != null && !serviceType.IsInstanceOfType(created))
                    {
                        Refuse(serviceType, "ServiceRegistration",
                            "Service callback returned an object that does not implement the requested service type.");
                        return null;
                    }
                    if (created != null)
                    {
                        _services[serviceType] = created;
                        return created;
                    }
                }
                catch (Exception ex)
                {
                    Refuse(serviceType, "ServiceRegistration",
                        "Service callback failed: " + ex.GetType().Name + ".");
                    return null;
                }
                finally
                {
                    _callbacksInProgress.Remove(serviceType);
                }
            }

            Refuse(serviceType, CapabilityNameFor(serviceType), RefusalReasonFor(serviceType));
            return null;
        }

        public void AddService(Type serviceType, ServiceCreatorCallback callback) =>
            AddService(serviceType, callback, promote: false);

        public void AddService(Type serviceType, ServiceCreatorCallback callback, bool promote)
        {
            DesignerServiceKernelGuard.ThrowIfNull(serviceType);
            DesignerServiceKernelGuard.ThrowIfNull(callback);
            ThrowIfDisposed();
            if (promote)
                throw new NotSupportedException("Promoted service registration is outside this kernel slice.");
            RefuseControlledServiceRegistration(serviceType);
            if (_services.ContainsKey(serviceType) || _serviceCallbacks.ContainsKey(serviceType))
                throw new InvalidOperationException("Service already registered: " + serviceType.FullName);
            _serviceCallbacks.Add(serviceType, callback);
        }

        public void AddService(Type serviceType, object serviceInstance) =>
            AddService(serviceType, serviceInstance, promote: false);

        public void AddService(Type serviceType, object serviceInstance, bool promote)
        {
            DesignerServiceKernelGuard.ThrowIfNull(serviceType);
            DesignerServiceKernelGuard.ThrowIfNull(serviceInstance);
            ThrowIfDisposed();
            if (promote)
                throw new NotSupportedException("Promoted service registration is outside this kernel slice.");
            RefuseControlledServiceRegistration(serviceType);
            if (!serviceType.IsInstanceOfType(serviceInstance))
                throw new ArgumentException("Service instance does not implement the requested service type.",
                    nameof(serviceInstance));
            if (_services.ContainsKey(serviceType) || _serviceCallbacks.ContainsKey(serviceType))
                throw new InvalidOperationException("Service already registered: " + serviceType.FullName);
            _services.Add(serviceType, serviceInstance);
        }

        public void RemoveService(Type serviceType) => RemoveService(serviceType, promote: false);

        public void RemoveService(Type serviceType, bool promote)
        {
            DesignerServiceKernelGuard.ThrowIfNull(serviceType);
            ThrowIfDisposed();
            if (promote)
                throw new NotSupportedException("Promoted service removal is outside this kernel slice.");
            if (IsBuiltInService(serviceType))
                throw new InvalidOperationException("Built-in kernel services cannot be removed.");
            _services.Remove(serviceType);
            _serviceCallbacks.Remove(serviceType);
        }

        public bool TryGetServiceRefusal(Type serviceType, out DesignerServiceRefusal refusal)
        {
            DesignerServiceKernelGuard.ThrowIfNull(serviceType);
            if (_refusals.TryGetValue(serviceType, out var found))
            {
                refusal = found;
                return true;
            }

            refusal = null!;
            return false;
        }

        public bool ContainsComponent(IComponent component) =>
            Container.Components.Cast<IComponent>().Contains(component);

        internal HostedDesignerInspectionResult InspectDesigner(
            IComponent component,
            IReadOnlyList<string>? editorPropertyPath,
            CancellationToken cancellationToken)
        {
            if (cancellationToken.IsCancellationRequested)
                return DesignerInspectionError(component, "request_cancelled", "The hosted designer request was cancelled.");

            IDesigner? designer;
            try
            {
                designer = GetDesigner(component);
            }
            catch (Exception ex)
            {
                return DesignerInspectionError(component, "designer_refused", ex.Message);
            }

            if (designer == null)
            {
                var reason = TryGetServiceRefusal(typeof(IDesigner), out var refusal)
                    ? refusal.Reason
                    : "No truthful designer is available for " + ComponentTypeName(component) + ".";
                return DesignerInspectionError(component, DesignerErrorCodeFor(reason), reason);
            }

            if (cancellationToken.IsCancellationRequested)
                return DesignerInspectionError(component, "request_cancelled", "The hosted designer request was cancelled.");

            string editorType = "";
            if (editorPropertyPath is { Count: > 0 }
                && !TryResolveEditor(component, editorPropertyPath, out editorType, out string editorReason))
            {
                return DesignerInspectionError(component, "editor_unavailable", editorReason);
            }

            var result = new HostedDesignerInspectionResult
            {
                Ok = true,
                ComponentType = ComponentTypeName(component),
                DesignerType = designer.GetType().FullName ?? designer.GetType().Name,
                EditorType = editorType,
            };

            try
            {
                if (designer is ComponentDesigner componentDesigner)
                {
                    foreach (DesignerActionList list in componentDesigner.ActionLists)
                    {
                        result.ActionListTypes.Add(list.GetType().FullName ?? list.GetType().Name);
                        foreach (DesignerActionItem item in list.GetSortedActionItems())
                        {
                            if (!string.IsNullOrEmpty(item.DisplayName))
                                result.ActionItems.Add(item.DisplayName);
                        }
                    }
                }

                return result;
            }
            catch (Exception ex)
            {
                return DesignerInspectionError(component, "designer_failed",
                    "Hosted designer inspection failed: " + ex.GetType().Name + ".");
            }
        }

        internal HostedDesignerAdornerResult DescribeDesignerAdorners(
            IComponent component,
            CancellationToken cancellationToken,
            TimeSpan? callbackDeadline)
        {
            if (cancellationToken.IsCancellationRequested)
                return AdornerError(component, "request_cancelled", "The hosted designer request was cancelled.");
            if (IsDeadlineExceeded(callbackDeadline))
                return AdornerDeadlineExceeded(component);

            if (!TryGetOwnedControlDesigner(component, out var designer, out string errorCode, out string reason))
                return AdornerError(component, errorCode, reason);

            try
            {
                return new HostedDesignerAdornerResult
                {
                    Ok = true,
                    ComponentType = ComponentTypeName(component),
                    DesignerType = designer.GetType().FullName ?? designer.GetType().Name,
                    Adorners = HostedDesignerAdornerContract.Read(designer),
                };
            }
            catch (Exception ex)
            {
                return AdornerError(component, "designer_failed",
                    "Hosted designer adorner inspection failed: " + ex.GetType().Name + ".");
            }
        }

        internal HostedDesignerAdornerResult HitTestDesignerAdorner(
            IComponent component,
            int x,
            int y,
            CancellationToken cancellationToken,
            TimeSpan? callbackDeadline)
        {
            if (cancellationToken.IsCancellationRequested)
                return AdornerError(component, "request_cancelled", "The hosted designer request was cancelled.");
            if (IsDeadlineExceeded(callbackDeadline))
                return AdornerDeadlineExceeded(component);

            if (!TryGetOwnedControlDesigner(component, out var designer, out string errorCode, out string reason))
                return AdornerError(component, errorCode, reason);

            try
            {
                var point = new Point(x, y);
                var adorners = HostedDesignerAdornerContract.Read(designer);
                foreach (var adorner in adorners)
                {
                    if (!adorner.HitTestable) continue;
                    var bounds = new Rectangle(adorner.Left, adorner.Top, adorner.Width, adorner.Height);
                    if (bounds.Contains(point) && HostedDesignerAdornerContract.ConfirmsHit(designer, adorner.Id, point))
                    {
                        return new HostedDesignerAdornerResult
                        {
                            Ok = true,
                            ComponentType = ComponentTypeName(component),
                            DesignerType = designer.GetType().FullName ?? designer.GetType().Name,
                            Adorners = adorners,
                            Hit = true,
                            HitAdornerId = adorner.Id,
                        };
                    }
                }

                return new HostedDesignerAdornerResult
                {
                    Ok = true,
                    ComponentType = ComponentTypeName(component),
                    DesignerType = designer.GetType().FullName ?? designer.GetType().Name,
                    Adorners = adorners,
                };
            }
            catch (Exception ex)
            {
                return AdornerError(component, "designer_failed",
                    "Hosted designer adorner hit-test failed: " + ex.GetType().Name + ".");
            }
        }

        internal HostedDesignerActionResult InvokeDesignerActionProperty(
            IComponent component,
            string actionDisplayName,
            string newValue,
            CancellationToken cancellationToken,
            TimeSpan? callbackDeadline)
        {
            if (cancellationToken.IsCancellationRequested)
                return ActionError(component, actionDisplayName, "request_cancelled",
                    "The hosted designer action was cancelled.");
            if (IsDeadlineExceeded(callbackDeadline))
                return ActionDeadlineExceeded(component, actionDisplayName);
            if (string.IsNullOrWhiteSpace(actionDisplayName) || actionDisplayName.Length > 128)
                return ActionError(component, actionDisplayName, "invalid_action",
                    "The hosted designer action name is invalid.");
            if (newValue == null || newValue.Length > 4096 || newValue.IndexOf('\0') >= 0)
                return ActionError(component, actionDisplayName, "invalid_value",
                    "The hosted designer action value is invalid.");

            if (!TryGetOwnedComponentDesigner(component, out var designer, out string errorCode, out string reason))
                return ActionError(component, actionDisplayName, errorCode, reason);

            DesignerActionList? actionList;
            DesignerActionPropertyItem? actionItem;
            try
            {
                (actionList, actionItem) = FindUniqueActionProperty(designer, actionDisplayName);
            }
            catch (Exception ex)
            {
                return ActionError(component, actionDisplayName, "designer_failed",
                    "Hosted designer action discovery failed: " + ex.GetType().Name + ".");
            }

            if (actionList == null || actionItem == null)
                return ActionError(component, actionDisplayName, "action_unavailable",
                    "No unique DesignerActionPropertyItem is available for '" + actionDisplayName + "'.");
            if (TryFindPathIntent(actionList, out string pathReason))
                return ActionError(component, actionDisplayName, "path_intent_rejected", pathReason);

            string memberName = ReadActionMemberName(actionItem);
            if (string.IsNullOrWhiteSpace(memberName))
                return ActionError(component, actionDisplayName, "invalid_action",
                    "The DesignerActionPropertyItem does not expose a member name.");

            System.Reflection.PropertyInfo? actionProperty = actionList.GetType().GetProperty(
                memberName,
                BindingFlags.Public | BindingFlags.Instance);
            if (actionProperty == null || !actionProperty.CanWrite)
                return ActionError(component, actionDisplayName, "invalid_action",
                    "The hosted designer action property is not writable.");
            if (actionProperty.PropertyType != typeof(string))
                return ActionError(component, actionDisplayName, "unsupported_action_type",
                    "Only string DesignerActionPropertyItem setters are supported in this kernel slice.");

            string targetPropertyName = ResolveActionTargetProperty(actionList, memberName);
            if (LooksLikePathAuthority(memberName) || LooksLikePathAuthority(actionDisplayName)
                || LooksLikePathAuthority(targetPropertyName) || LooksLikePathAuthority(newValue))
            {
                return ActionError(component, actionDisplayName, "path_intent_rejected",
                    "Hosted designer actions cannot receive workspace path or write authority.");
            }

            var targetProperty = TypeDescriptor.GetProperties(component).Find(targetPropertyName, ignoreCase: false);
            if (targetProperty == null || targetProperty.IsReadOnly || targetProperty.PropertyType != typeof(string))
                return ActionError(component, actionDisplayName, "target_unavailable",
                    "The hosted designer action target property is not a writable string property.");

            var changeService = GetService(typeof(IComponentChangeService)) as IComponentChangeService;
            if (changeService == null)
                return ActionError(component, actionDisplayName, "change_service_unavailable",
                    "The ComponentChange service is required for hosted designer actions.");

            int opened = 0;
            int committed = 0;
            int cancelled = 0;
            int changes = 0;
            void Opened(object? sender, EventArgs args) => opened++;
            void Closed(object? sender, DesignerTransactionCloseEventArgs args)
            {
                if (args.TransactionCommitted) committed++;
                else cancelled++;
            }
            void Changing(object? sender, ComponentChangingEventArgs args) => changes++;
            void Changed(object? sender, ComponentChangedEventArgs args) => changes++;

            TransactionOpened += Opened;
            TransactionClosed += Closed;
            changeService.ComponentChanging += Changing;
            changeService.ComponentChanged += Changed;

            string oldValue = Convert.ToString(targetProperty.GetValue(component),
                System.Globalization.CultureInfo.InvariantCulture) ?? "";
            try
            {
                using DesignerTransaction transaction = CreateTransaction("DesignerActionProperty:" + actionDisplayName);
                changeService.OnComponentChanging(component, targetProperty);
                actionProperty.SetValue(actionList, newValue);
                string appliedValue = Convert.ToString(targetProperty.GetValue(component),
                    System.Globalization.CultureInfo.InvariantCulture) ?? "";
                changeService.OnComponentChanged(component, targetProperty, oldValue, appliedValue);
                transaction.Commit();

                return new HostedDesignerActionResult
                {
                    Ok = true,
                    ActionName = actionDisplayName,
                    ComponentType = ComponentTypeName(component),
                    DesignerType = designer.GetType().FullName ?? designer.GetType().Name,
                    TargetProperty = targetPropertyName,
                    OldValue = oldValue,
                    NewValue = appliedValue,
                    TransactionsOpened = opened,
                    TransactionsCommitted = committed,
                    TransactionsCancelled = cancelled,
                    ChangeEvents = changes,
                };
            }
            catch (Exception ex)
            {
                var (restorationAttempted, restored, recoveryRequired, restoreReason) =
                    RestoreTargetProperty(component, targetProperty, oldValue);
                string errorCodeAfterRestore = recoveryRequired ? "recovery_required" : "action_failed";
                string restoreSuffix = recoveryRequired
                    ? " Restoration is ambiguous: " + restoreReason
                    : " Target property was restored to its exact old value.";
                return new HostedDesignerActionResult
                {
                    ActionName = actionDisplayName,
                    ComponentType = ComponentTypeName(component),
                    DesignerType = designer.GetType().FullName ?? designer.GetType().Name,
                    TargetProperty = targetPropertyName,
                    OldValue = oldValue,
                    TransactionsOpened = opened,
                    TransactionsCommitted = committed,
                    TransactionsCancelled = cancelled,
                    ChangeEvents = changes,
                    RestorationAttempted = restorationAttempted,
                    Restored = restored,
                    RecoveryRequired = recoveryRequired,
                    ErrorCode = errorCodeAfterRestore,
                    Reason = "Hosted designer action failed: " + ex.GetType().Name + "." + restoreSuffix,
                };
            }
            finally
            {
                TransactionOpened -= Opened;
                TransactionClosed -= Closed;
                changeService.ComponentChanging -= Changing;
                changeService.ComponentChanged -= Changed;
            }
        }

        internal void ValidateNameForAdd(string? name, IComponent? existingComponent)
        {
            if (string.IsNullOrEmpty(name)) return;
            if (!KernelNameCreationService.IsValidIdentifier(name))
                throw new ArgumentException("Invalid component name: " + name, nameof(name));

            foreach (IComponent component in Container.Components)
            {
                if (ReferenceEquals(component, existingComponent)) continue;
                if (StringComparer.Ordinal.Equals(component.Site?.Name, name))
                    throw new InvalidOperationException("Duplicate component name: " + name);
            }
        }

        internal void RenameComponent(IComponent component, string? oldName, string? newName)
        {
            _changeService?.RaiseComponentRename(component, oldName ?? string.Empty, newName ?? string.Empty);
        }

        internal void RaiseComponentAdding(IComponent component) =>
            _changeService?.RaiseComponentAdding(component);

        internal void RaiseComponentAdded(IComponent component) =>
            _changeService?.RaiseComponentAdded(component);

        internal void RaiseComponentRemoving(IComponent component) =>
            _changeService?.RaiseComponentRemoving(component);

        internal void RaiseComponentRemoved(IComponent component) =>
            _changeService?.RaiseComponentRemoved(component);

        internal void DisposeDesigner(IComponent component)
        {
            if (!_designers.TryGetValue(component, out var designer)) return;
            _designers.Remove(component);
            try { designer.Dispose(); } catch { /* best effort hosted-designer teardown */ }
        }

        internal void RecordServiceRefusal(Type serviceType, string capability, string reason) =>
            Refuse(serviceType, capability, reason);

        internal void CloseTransaction(KernelDesignerTransaction transaction, bool commit)
        {
            if (!ReferenceEquals(_activeTransaction, transaction))
                return;

            TransactionClosing?.Invoke(this, new DesignerTransactionCloseEventArgs(commit, lastTransaction: true));
            _activeTransaction = null;
            TransactionClosed?.Invoke(this, new DesignerTransactionCloseEventArgs(commit, lastTransaction: true));
        }

        public void Dispose()
        {
            if (IsDisposed) return;
            _activeTransaction?.Cancel();
            IsDisposed = true;
            foreach (var designer in _designers.Values.ToArray())
            {
                try { designer.Dispose(); } catch { /* best effort kernel teardown */ }
            }
            _designers.Clear();
            ((KernelDesignContainer)Container).Dispose();
            Deactivated?.Invoke(this, EventArgs.Empty);
        }

        internal void CompleteLoad() => LoadComplete?.Invoke(this, EventArgs.Empty);

        private string CreateGeneratedName(Type componentClass)
        {
            if (_nameService == null)
            {
                Refuse(typeof(INameCreationService), nameof(DesignerServiceKernelCapability.Naming),
                    "Implicit component naming requires the Naming capability.");
                throw new NotSupportedException("Implicit component naming requires the Naming capability.");
            }

            return _nameService.CreateName(Container, componentClass);
        }

        private bool IsEnabled(DesignerServiceKernelCapability capability) => _capabilities.Contains(capability);

        private void RegisterService(Type type, object service) => _services.Add(type, service);

        private bool IsBuiltInService(Type serviceType) =>
            serviceType == typeof(IDesignerHost)
            || serviceType == typeof(IServiceContainer)
            || serviceType == typeof(IContainer)
            || serviceType == typeof(IComponentChangeService)
            || serviceType == typeof(INameCreationService)
            || serviceType == typeof(ISelectionService)
            || serviceType == typeof(IMenuCommandService);

        private bool IsKernelControlledService(Type serviceType) =>
            IsBuiltInService(serviceType)
            || StringComparer.Ordinal.Equals(serviceType.Namespace, typeof(IDesignerHost).Namespace)
            || StringComparer.Ordinal.Equals(serviceType.Namespace, typeof(IDesignerSerializationService).Namespace);

        private void RefuseControlledServiceRegistration(Type serviceType)
        {
            if (!IsKernelControlledService(serviceType)) return;
            Refuse(serviceType, CapabilityNameFor(serviceType),
                "Kernel-controlled design-time services cannot be supplied by hosted code.");
            throw new NotSupportedException(
                "Kernel-controlled design-time services cannot be supplied by hosted code: " + serviceType.FullName);
        }

        private static Assembly? ResolveLoadedAssembly(AssemblyName requested) =>
            AppDomain.CurrentDomain.GetAssemblies().FirstOrDefault(loaded =>
                AssemblyName.ReferenceMatchesDefinition(loaded.GetName(), requested));

        private static Type? ResolveLoadedType(Assembly? assembly, string typeName, bool ignoreCase) =>
            assembly != null
                ? assembly.GetType(typeName, throwOnError: false, ignoreCase)
                : AppDomain.CurrentDomain.GetAssemblies()
                    .Select(loaded => loaded.GetType(typeName, throwOnError: false, ignoreCase))
                    .FirstOrDefault(type => type != null);

        private void ThrowIfDisposed()
        {
            if (IsDisposed) throw new ObjectDisposedException(nameof(DesignerServiceKernelSession));
        }

        private void Refuse(Type serviceType, string capability, string reason)
        {
            _refusals[serviceType] = new DesignerServiceRefusal
            {
                ServiceType = serviceType,
                Capability = capability,
                Reason = reason,
            };
        }

        private string CapabilityNameFor(Type serviceType)
        {
            if (serviceType == typeof(IDesignerHost))
                return "HostedServiceContract";
            if (serviceType == typeof(IComponentChangeService))
                return nameof(DesignerServiceKernelCapability.ComponentChange);
            if (serviceType == typeof(INameCreationService))
                return nameof(DesignerServiceKernelCapability.Naming);
            if (serviceType == typeof(ISelectionService))
                return nameof(DesignerServiceKernelCapability.Selection);
            if (serviceType == typeof(IMenuCommandService))
                return nameof(DesignerServiceKernelCapability.MenuCommands);
            if (serviceType == typeof(DesignerTransaction))
                return nameof(DesignerServiceKernelCapability.Transactions);
            return "Unsupported";
        }

        private string RefusalReasonFor(Type serviceType)
        {
            var capability = CapabilityNameFor(serviceType);
            if (capability != "Unsupported")
                return "Capability is not enabled for this kernel session: " + capability + ".";

            return "No truthful implementation is available in this kernel slice for " + serviceType.FullName + ".";
        }

        private static void DisposeIfPossible(object? instance)
        {
            if (instance is IDisposable disposable)
            {
                try { disposable.Dispose(); } catch { /* best effort failed-designer teardown */ }
            }
        }

        private static string ComponentTypeName(IComponent component) =>
            component.GetType().FullName ?? component.GetType().Name;

        private static HostedDesignerInspectionResult DesignerInspectionError(
            IComponent? component,
            string code,
            string reason) => new()
            {
                ComponentType = component == null ? "" : ComponentTypeName(component),
                ErrorCode = code,
                Reason = reason,
                QuarantineRecommended = string.Equals(code, "designer_worker_fault", StringComparison.Ordinal),
            };

        private static HostedDesignerAdornerResult AdornerError(
            IComponent? component,
            string code,
            string reason) => new()
            {
                ComponentType = component == null ? "" : ComponentTypeName(component),
                ErrorCode = code,
                Reason = reason,
            };

        private static HostedDesignerAdornerResult AdornerDeadlineExceeded(IComponent? component) => new()
        {
            ComponentType = component == null ? "" : ComponentTypeName(component),
            ErrorCode = "deadline_exceeded",
            Reason = "Hosted designer callback deadline elapsed before safe in-process execution. "
                + "A running or stuck hosted worker must be terminated by the outer worker supervisor; "
                + "the kernel must not use Thread.Abort.",
            DeadlineExceeded = true,
            RequiresWorkerTermination = true,
            QuarantineRecommended = true,
        };

        private static HostedDesignerActionResult ActionError(
            IComponent? component,
            string actionName,
            string code,
            string reason) => new()
            {
                ActionName = actionName ?? "",
                ComponentType = component == null ? "" : ComponentTypeName(component),
                ErrorCode = code,
                Reason = reason,
                QuarantineRecommended = string.Equals(code, "designer_worker_fault", StringComparison.Ordinal),
            };

        private static HostedDesignerActionResult ActionDeadlineExceeded(
            IComponent? component,
            string actionName) => new()
            {
                ActionName = actionName ?? "",
                ComponentType = component == null ? "" : ComponentTypeName(component),
                ErrorCode = "deadline_exceeded",
                Reason = "Hosted designer callback deadline elapsed before safe in-process execution. "
                    + "A running or stuck hosted worker must be terminated by the outer worker supervisor; "
                    + "the kernel must not use Thread.Abort.",
                DeadlineExceeded = true,
                RequiresWorkerTermination = true,
                QuarantineRecommended = true,
            };

        private static bool IsDeadlineExceeded(TimeSpan? callbackDeadline) =>
            callbackDeadline.HasValue && callbackDeadline.Value <= TimeSpan.Zero;

        private static string DesignerErrorCodeFor(string reason) =>
            reason.StartsWith("DESIGNER_WORKER_FAULT:", StringComparison.Ordinal)
                ? "designer_worker_fault"
                : "designer_unavailable";

        private bool TryGetOwnedComponentDesigner(
            IComponent component,
            out ComponentDesigner designer,
            out string errorCode,
            out string reason)
        {
            designer = null!;
            errorCode = "";
            reason = "";
            IDesigner? created;
            try
            {
                created = GetDesigner(component);
            }
            catch (Exception ex)
            {
                errorCode = "designer_refused";
                reason = ex.Message;
                return false;
            }

            if (created is ComponentDesigner componentDesigner)
            {
                designer = componentDesigner;
                return true;
            }

            reason = created == null && TryGetServiceRefusal(typeof(IDesigner), out var refusal)
                ? refusal.Reason
                : "No ComponentDesigner is available for " + ComponentTypeName(component) + ".";
            errorCode = DesignerErrorCodeFor(reason);
            return false;
        }

        private bool TryGetOwnedControlDesigner(
            IComponent component,
            out ControlDesigner designer,
            out string errorCode,
            out string reason)
        {
            designer = null!;
            if (!TryGetOwnedComponentDesigner(component, out var componentDesigner, out errorCode, out reason))
                return false;
            if (componentDesigner is ControlDesigner controlDesigner)
            {
                designer = controlDesigner;
                return true;
            }

            errorCode = "designer_unavailable";
            reason = "No ControlDesigner is available for " + ComponentTypeName(component) + ".";
            return false;
        }

        private static (DesignerActionList? ActionList, DesignerActionPropertyItem? ActionItem) FindUniqueActionProperty(
            ComponentDesigner designer,
            string actionDisplayName)
        {
            DesignerActionList? matchedList = null;
            DesignerActionPropertyItem? matchedItem = null;
            foreach (DesignerActionList list in designer.ActionLists)
            {
                foreach (DesignerActionItem item in list.GetSortedActionItems())
                {
                    if (item is not DesignerActionPropertyItem propertyItem) continue;
                    if (!string.Equals(item.DisplayName, actionDisplayName, StringComparison.Ordinal)) continue;
                    if (matchedItem != null)
                        return (null, null);
                    matchedList = list;
                    matchedItem = propertyItem;
                }
            }

            return (matchedList, matchedItem);
        }

        private static string ReadActionMemberName(DesignerActionPropertyItem actionItem) =>
            Convert.ToString(ReadPublicProperty(actionItem, "MemberName"),
                System.Globalization.CultureInfo.InvariantCulture) ?? "";

        private static string ResolveActionTargetProperty(DesignerActionList actionList, string memberName)
        {
            var method = actionList.GetType().GetMethod(
                "GetHostedDesignerPropertyTarget",
                BindingFlags.Public | BindingFlags.Instance,
                binder: null,
                types: new[] { typeof(string) },
                modifiers: null);
            if (method?.ReturnType != typeof(string)) return memberName;
            return Convert.ToString(method.Invoke(actionList, new object[] { memberName }),
                System.Globalization.CultureInfo.InvariantCulture) ?? "";
        }

        private static bool TryFindPathIntent(DesignerActionList actionList, out string reason)
        {
            reason = "";
            // Advisory adapter check only: in-process vendor designer code is not a workspace-write security boundary.
            // Real containment must come from the hosted worker process and planner-owned file transactions.
            var method = actionList.GetType().GetMethod(
                "GetHostedDesignerIntents",
                BindingFlags.Public | BindingFlags.Instance,
                binder: null,
                types: Type.EmptyTypes,
                modifiers: null);
            if (method == null) return false;
            if (method.ReturnType == typeof(string) || !typeof(IEnumerable).IsAssignableFrom(method.ReturnType))
            {
                reason = "Hosted designer intent provider must return IEnumerable.";
                return true;
            }

            object? raw = method.Invoke(actionList, Array.Empty<object>());
            if (raw is not IEnumerable intents) return false;
            foreach (object? intent in intents)
            {
                if (intent == null) continue;
                string kind = Convert.ToString(ReadPublicProperty(intent, "Kind"),
                    System.Globalization.CultureInfo.InvariantCulture) ?? "";
                string targetPath = Convert.ToString(ReadPublicProperty(intent, "TargetPath"),
                    System.Globalization.CultureInfo.InvariantCulture) ?? "";
                string path = Convert.ToString(ReadPublicProperty(intent, "Path"),
                    System.Globalization.CultureInfo.InvariantCulture) ?? "";
                string workspacePath = Convert.ToString(ReadPublicProperty(intent, "WorkspacePath"),
                    System.Globalization.CultureInfo.InvariantCulture) ?? "";
                if (LooksLikePathAuthority(kind) || !string.IsNullOrWhiteSpace(targetPath)
                    || !string.IsNullOrWhiteSpace(path) || !string.IsNullOrWhiteSpace(workspacePath))
                {
                    reason = "Hosted designer returned a path/write intent; workspace writes must route through the planner.";
                    return true;
                }
            }

            return false;
        }

        private static bool LooksLikePathAuthority(string? value)
        {
            if (string.IsNullOrWhiteSpace(value)) return false;
            string normalized = value.Trim();
            if (normalized.IndexOf("://", StringComparison.Ordinal) >= 0) return true;
            if (normalized.IndexOfAny(new[] { '\\', '/' }) >= 0) return true;
            if (normalized.Length >= 3 && char.IsLetter(normalized[0]) && normalized[1] == ':') return true;
            string lower = normalized.ToLowerInvariant();
            return lower.IndexOf("workspace", StringComparison.Ordinal) >= 0
                || lower.IndexOf("write", StringComparison.Ordinal) >= 0
                || lower.IndexOf("path", StringComparison.Ordinal) >= 0
                || lower.IndexOf("file", StringComparison.Ordinal) >= 0
                || lower.IndexOf("directory", StringComparison.Ordinal) >= 0;
        }

        private static object? ReadPublicProperty(object instance, string propertyName)
        {
            var property = instance.GetType().GetProperty(
                propertyName,
                BindingFlags.Public | BindingFlags.Instance);
            return property?.GetValue(instance);
        }

        private static (bool Attempted, bool Restored, bool RecoveryRequired, string Reason) RestoreTargetProperty(
            object component,
            PropertyDescriptor targetProperty,
            string oldValue)
        {
            try
            {
                var clrProperty = component.GetType().GetProperty(
                    targetProperty.Name,
                    BindingFlags.Public | BindingFlags.Instance);
                if (clrProperty != null && clrProperty.CanWrite && clrProperty.PropertyType == typeof(string))
                    clrProperty.SetValue(component, oldValue);
                else
                    targetProperty.SetValue(component, oldValue);

                string restoredValue = Convert.ToString(targetProperty.GetValue(component),
                    System.Globalization.CultureInfo.InvariantCulture) ?? "";
                if (string.Equals(restoredValue, oldValue, StringComparison.Ordinal))
                    return (true, true, false, "");
                return (true, false, true, "target property readback did not match old value");
            }
            catch (Exception ex)
            {
                return (true, false, true, ex.GetType().Name);
            }
        }

        private static bool TryResolveEditor(
            object component,
            IReadOnlyList<string> propertyPath,
            out string editorType,
            out string reason)
        {
            editorType = "";
            reason = "";
            try
            {
                object current = component;
                for (int index = 0; index < propertyPath.Count; index++)
                {
                    string propertyName = propertyPath[index];
                    if (string.IsNullOrWhiteSpace(propertyName))
                    {
                        reason = "Editor property path contains an empty segment.";
                        return false;
                    }

                    var property = TypeDescriptor.GetProperties(current).Find(propertyName, ignoreCase: false);
                    if (property == null)
                    {
                        reason = "Editor property path segment '" + propertyName + "' was not found.";
                        return false;
                    }

                    if (index == propertyPath.Count - 1)
                    {
                        object? editor = property.GetEditor(typeof(UITypeEditor));
                        if (editor == null)
                        {
                            reason = "No UITypeEditor is available for property '" + propertyName + "'.";
                            return false;
                        }
                        editorType = editor.GetType().FullName ?? editor.GetType().Name;
                        return true;
                    }

                    object? next = property.GetValue(current);
                    if (next == null)
                    {
                        reason = "Editor property path segment '" + propertyName + "' resolved to null.";
                        return false;
                    }
                    current = next;
                }
            }
            catch (Exception ex)
            {
                reason = "Editor property path failed: " + ex.GetType().Name + ".";
                return false;
            }

            reason = "Editor property path is required.";
            return false;
        }

    }

    internal sealed class KernelDesignContainer : IContainer
    {
        private readonly KernelDesignerHost _host;
        private readonly List<IComponent> _components = new();
        private bool _disposed;

        public KernelDesignContainer(KernelDesignerHost host) => _host = host;

        public ComponentCollection Components => new ComponentCollection(_components.ToArray());

        public void Add(IComponent? component) => Add(component, null);

        public void Add(IComponent? component, string? name)
        {
            if (component == null) return;
            if (_disposed) throw new ObjectDisposedException(nameof(KernelDesignContainer));

            _host.ValidateNameForAdd(name, existingComponent: component);
            _host.RaiseComponentAdding(component);

            component.Site?.Container?.Remove(component);
            if (!_components.Contains(component))
                _components.Add(component);
            component.Site = new KernelDesignSite(_host, this, component, name);

            _host.RaiseComponentAdded(component);
        }

        public void Remove(IComponent? component)
        {
            if (component == null) return;
            if (_disposed) return;
            if (!_components.Contains(component)) return;

            _host.RaiseComponentRemoving(component);
            _components.Remove(component);
            _host.DisposeDesigner(component);
            if (component.Site is KernelDesignSite site && ReferenceEquals(site.Container, this))
                component.Site = null;
            _host.RaiseComponentRemoved(component);
        }

        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;
            for (int i = _components.Count - 1; i >= 0; i--)
            {
                try { _components[i].Dispose(); } catch { /* best effort kernel teardown */ }
            }
            _components.Clear();
        }
    }

    internal sealed class KernelDesignSite : ISite
    {
        private readonly KernelDesignerHost _host;
        private string? _name;

        public KernelDesignSite(KernelDesignerHost host, KernelDesignContainer container, IComponent component,
            string? name)
        {
            _host = host;
            Container = container;
            Component = component;
            _name = name;
        }

        public IComponent Component { get; }
        public IContainer Container { get; }
        public bool DesignMode => true;

        public string? Name
        {
            get => _name;
            set
            {
                if (StringComparer.Ordinal.Equals(_name, value)) return;
                _host.ValidateNameForAdd(value, Component);
                var oldName = _name;
                _name = value;
                _host.RenameComponent(Component, oldName, value);
            }
        }

        public object? GetService(Type serviceType) => _host.GetService(serviceType);
    }

    internal sealed class KernelNameCreationService : INameCreationService
    {
        private readonly KernelDesignerHost _host;

        public KernelNameCreationService(KernelDesignerHost host) => _host = host;

        public string CreateName(IContainer? container, Type dataType)
        {
            DesignerServiceKernelGuard.ThrowIfNull(dataType);
            container ??= _host.Container;

            var baseName = VsNameCreationService.CamelCase(dataType.Name);
            for (int index = 1; index < 100000; index++)
            {
                var candidate = baseName + index.ToString(System.Globalization.CultureInfo.InvariantCulture);
                if (IsAvailable(container, candidate))
                    return candidate;
            }

            throw new InvalidOperationException("Unable to create a unique component name for " + dataType.FullName);
        }

        public bool IsValidName(string name) =>
            IsValidIdentifier(name) && IsAvailable(_host.Container, name);

        public void ValidateName(string name)
        {
            if (!IsValidIdentifier(name))
                throw new ArgumentException("Invalid component name: " + name, nameof(name));
            if (!IsAvailable(_host.Container, name))
                throw new ArgumentException("Duplicate component name: " + name, nameof(name));
        }

        internal static bool IsValidIdentifier(string name)
        {
            if (string.IsNullOrEmpty(name)) return false;
            string bare = name[0] == '@' ? name.Substring(1) : name;
            return SyntaxFacts.IsValidIdentifier(bare);
        }

        private static bool IsAvailable(IContainer container, string name) =>
            !container.Components.Cast<IComponent>()
                .Any(component => StringComparer.Ordinal.Equals(component.Site?.Name, name));
    }

    internal sealed class KernelComponentChangeService : IComponentChangeService
    {
        private readonly KernelDesignerHost _host;

        public KernelComponentChangeService(KernelDesignerHost host) => _host = host;

        public event ComponentEventHandler? ComponentAdded;
        public event ComponentEventHandler? ComponentAdding;
        public event ComponentChangedEventHandler? ComponentChanged;
        public event ComponentChangingEventHandler? ComponentChanging;
        public event ComponentEventHandler? ComponentRemoved;
        public event ComponentEventHandler? ComponentRemoving;
        public event ComponentRenameEventHandler? ComponentRename;

        public void OnComponentChanged(object? component, MemberDescriptor? member, object? oldValue, object? newValue)
        {
            ValidateOwnedComponent(component);
            ComponentChanged?.Invoke(this, new ComponentChangedEventArgs(component, member, oldValue, newValue));
        }

        public void OnComponentChanging(object? component, MemberDescriptor? member)
        {
            ValidateOwnedComponent(component);
            ComponentChanging?.Invoke(this, new ComponentChangingEventArgs(component, member));
        }

        private void ValidateOwnedComponent(object? component)
        {
            if (component is IComponent typed && _host.ContainsComponent(typed)) return;
            _host.RecordServiceRefusal(typeof(IComponentChangeService),
                nameof(DesignerServiceKernelCapability.ComponentChange),
                "Component changes are limited to components owned by this kernel session.");
            throw new InvalidOperationException(
                "Component changes are limited to components owned by this kernel session.");
        }

        internal void RaiseComponentAdding(IComponent component) =>
            ComponentAdding?.Invoke(this, new ComponentEventArgs(component));

        internal void RaiseComponentAdded(IComponent component) =>
            ComponentAdded?.Invoke(this, new ComponentEventArgs(component));

        internal void RaiseComponentRemoving(IComponent component) =>
            ComponentRemoving?.Invoke(this, new ComponentEventArgs(component));

        internal void RaiseComponentRemoved(IComponent component) =>
            ComponentRemoved?.Invoke(this, new ComponentEventArgs(component));

        internal void RaiseComponentRename(IComponent component, string oldName, string newName) =>
            ComponentRename?.Invoke(this, new ComponentRenameEventArgs(component, oldName, newName));
    }

    internal sealed class KernelSelectionService : ISelectionService
    {
        private readonly KernelDesignerHost _host;
        private readonly List<object> _selection = new();

        public KernelSelectionService(KernelDesignerHost host) => _host = host;

        public event EventHandler? SelectionChanged;
        public event EventHandler? SelectionChanging;

        public object? PrimarySelection => _selection.Count == 0 ? null : _selection[0];
        public int SelectionCount => _selection.Count;

        public bool GetComponentSelected(object component) => _selection.Contains(component);

        public ICollection GetSelectedComponents() => _selection.ToArray();

        public void SetSelectedComponents(ICollection? components) =>
            SetSelectedComponents(components, SelectionTypes.Replace);

        public void SetSelectedComponents(ICollection? components, SelectionTypes selectionType)
        {
            var incoming = components == null
                ? new List<object>()
                : components.Cast<object>().Distinct().ToList();

            foreach (var component in incoming)
            {
                if (component is not IComponent typed || !_host.ContainsComponent(typed))
                {
                    _host.RecordServiceRefusal(typeof(ISelectionService),
                        nameof(DesignerServiceKernelCapability.Selection),
                        "Selection is limited to components owned by this kernel session.");
                    throw new InvalidOperationException(
                        "Selection is limited to components owned by this kernel session.");
                }
            }

            SelectionChanging?.Invoke(this, EventArgs.Empty);

            if ((selectionType & SelectionTypes.Add) == SelectionTypes.Add)
            {
                foreach (var component in incoming)
                    if (!_selection.Contains(component))
                        _selection.Add(component);
            }
            else if ((selectionType & SelectionTypes.Remove) == SelectionTypes.Remove)
            {
                foreach (var component in incoming)
                    _selection.Remove(component);
            }
            else if ((selectionType & SelectionTypes.Toggle) == SelectionTypes.Toggle)
            {
                foreach (var component in incoming)
                {
                    if (!_selection.Remove(component))
                        _selection.Add(component);
                }
            }
            else
            {
                _selection.Clear();
                _selection.AddRange(incoming);
            }

            if ((selectionType & SelectionTypes.Primary) == SelectionTypes.Primary && incoming.Count > 0)
            {
                var primary = incoming[0];
                _selection.Remove(primary);
                _selection.Insert(0, primary);
            }

            SelectionChanged?.Invoke(this, EventArgs.Empty);
        }
    }

    internal sealed class KernelMenuCommandService : IMenuCommandService
    {
        private readonly KernelDesignerHost _host;
        private readonly Dictionary<string, MenuCommand> _commands = new(StringComparer.Ordinal);
        private readonly List<DesignerVerb> _verbs = new();

        public KernelMenuCommandService(KernelDesignerHost host) => _host = host;

        public DesignerVerbCollection Verbs => new DesignerVerbCollection(_verbs.ToArray());

        public void AddCommand(MenuCommand command)
        {
            DesignerServiceKernelGuard.ThrowIfNull(command);
            var commandId = command.CommandID
                ?? throw new ArgumentException("Menu command must have a CommandID.", nameof(command));
            var key = Key(commandId);
            if (_commands.ContainsKey(key))
                throw new InvalidOperationException("Duplicate menu command: " + commandId);
            _commands.Add(key, command);
        }

        public void AddVerb(DesignerVerb verb)
        {
            DesignerServiceKernelGuard.ThrowIfNull(verb);
            if (!_verbs.Contains(verb))
                _verbs.Add(verb);
        }

        public MenuCommand? FindCommand(CommandID commandID)
        {
            DesignerServiceKernelGuard.ThrowIfNull(commandID);
            _commands.TryGetValue(Key(commandID), out var command);
            return command;
        }

        public bool GlobalInvoke(CommandID commandID)
        {
            DesignerServiceKernelGuard.ThrowIfNull(commandID);
            if (!_commands.TryGetValue(Key(commandID), out var command))
                return false;
            if (!command.Supported || !command.Enabled)
                return false;
            command.Invoke();
            return true;
        }

        public void RemoveCommand(MenuCommand command)
        {
            DesignerServiceKernelGuard.ThrowIfNull(command);
            var commandId = command.CommandID
                ?? throw new ArgumentException("Menu command must have a CommandID.", nameof(command));
            _commands.Remove(Key(commandId));
        }

        public void RemoveVerb(DesignerVerb verb)
        {
            DesignerServiceKernelGuard.ThrowIfNull(verb);
            _verbs.Remove(verb);
        }

        public void ShowContextMenu(CommandID menuID, int x, int y)
        {
            _host.RecordServiceRefusal(typeof(IMenuCommandService),
                nameof(DesignerServiceKernelCapability.MenuCommands),
                "Context menu UI display is outside this headless kernel slice.");
            throw new NotSupportedException("Context menu UI display is outside this headless kernel slice.");
        }

        private static string Key(CommandID commandID) =>
            commandID.Guid.ToString("D") + ":" + commandID.ID.ToString(System.Globalization.CultureInfo.InvariantCulture);
    }

    internal sealed class KernelDesignerTransaction : DesignerTransaction
    {
        private readonly KernelDesignerHost _host;

        public KernelDesignerTransaction(KernelDesignerHost host, string description)
            : base(description)
        {
            _host = host;
        }

        protected override void OnCancel() => _host.CloseTransaction(this, commit: false);

        protected override void OnCommit() => _host.CloseTransaction(this, commit: true);
    }
}
