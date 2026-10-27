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
        ToolboxCatalog,
        TypeResolution,
        PropertySerialization,
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
        public const string ServiceProfileVersion = "0.1.0";

        public static IReadOnlyList<HostedServiceContractDescriptor> ServiceContracts => new[]
        {
            Contract(DesignerServiceKernelCapability.ContainerSiting, typeof(IContainer),
                "Components;Add(component);Add(component,name);Remove(component);Dispose();ISite.Name;ISite.Component;ISite.Container;ISite.DesignMode;ISite.GetService(type)",
                "Session-owned named components and design-mode sites; no workspace or window ownership."),
            Contract(DesignerServiceKernelCapability.Naming, typeof(INameCreationService),
                "CreateName(container,type);IsValidName(name);ValidateName(name)",
                "C# identifiers and unique names in the owning container."),
            Contract(DesignerServiceKernelCapability.ComponentChange, typeof(IComponentChangeService),
                "OnComponentChanging(component,member);OnComponentChanged(component,member,oldValue,newValue);ComponentChanging/Changed/Adding/Added/Removing/Removed/Rename events",
                "Synchronous notifications for owned components; no persistence authority."),
            Contract(DesignerServiceKernelCapability.Selection, typeof(ISelectionService),
                "PrimarySelection;SelectionCount;GetSelectedComponents();GetComponentSelected(component);SetSelectedComponents(components);SetSelectedComponents(components,selectionType);SelectionChanging/Changed events",
                "Owned component identities only; no global Visual Studio selection service."),
            Contract(DesignerServiceKernelCapability.Transactions, typeof(DesignerTransaction),
                "CreateTransaction();CreateTransaction(description);Commit();Cancel();TransactionOpening/Opened/Closing/Closed events",
                "One non-nested disposable graph transaction. Cancellation notification alone does not roll back arbitrary hosted code."),
            Contract(DesignerServiceKernelCapability.MenuCommands, typeof(IMenuCommandService),
                "AddCommand(command);AddVerb(verb);FindCommand(id);GlobalInvoke(id);RemoveCommand(command);RemoveVerb(verb);Verbs;ShowContextMenu(id,x,y)",
                "Headless command/verb registry. Disabled commands do not invoke; native context-menu UI is explicitly refused."),
            Contract(DesignerServiceKernelCapability.ToolboxCatalog, typeof(IHostedToolboxCatalog),
                "GetItems(cancellationToken);CreateComponent(itemId,name,cancellationToken)",
                "Exact Button, Label, Panel and TextBox framework types, created through the owning design host; no assembly discovery, clipboard or native toolbox UI.", true),
            Contract(DesignerServiceKernelCapability.TypeResolution, typeof(ITypeResolutionService),
                "GetAssembly(name);GetAssembly(name,throwOnError);GetPathOfAssembly(name);GetType(name);GetType(name,throwOnError);GetType(name,throwOnError,ignoreCase);ReferenceAssembly(name)",
                "Lookup in admitted, already-loaded framework/design/root/owned-component assemblies; legacy System.Design 4.0 framework-designer metadata maps to the current loaded framework design assembly. No ambient probing, project mutation or assembly loading."),
            Contract(DesignerServiceKernelCapability.PropertySerialization, typeof(IHostedPropertySerialization),
                "Capture(components,cancellationToken);ReadProposals(snapshots,cancellationToken)",
                "Data-only Text/Size property snapshots for at most 16 exact framework controls; proposals remain subject to the source planner. No general classic clipboard/CodeDOM serialization.", true),
        };

        private static HostedServiceContractDescriptor Contract(DesignerServiceKernelCapability capability,
            Type serviceType, string methods, string scope, bool cancellable = false) => new()
            {
                Capability = capability.ToString(),
                ServiceType = serviceType.FullName ?? serviceType.Name,
                Methods = methods.Split(';').ToList(),
                Cancellation = capability == DesignerServiceKernelCapability.ToolboxCatalog
                    ? "CancellationToken checked before component creation; an admitted synchronous framework callback finishes normally; the caller owns disposal of an aborted graph"
                    : cancellable
                    ? "CancellationToken checked before admission, for each bounded item and before publishing data; cancellation never grants file authority"
                    : "Synchronous public design-time API has no CancellationToken; caller checks before STA dispatch; running hosted callbacks require worker deadline/termination",
                Reentrancy = capability == DesignerServiceKernelCapability.Transactions
                    ? "Nested transactions refused before opening another transaction"
                    : cancellable || capability == DesignerServiceKernelCapability.TypeResolution
                        ? "Nested Preview service calls refused before mutation"
                        : "Synchronous events may call read APIs; recursive service construction/designer creation is refused; callers must not start nested graph mutations",
                Scope = scope,
            };

        /// <summary>Product call-through proof: all three Preview extensions execute against a disposable graph on
        /// the engine STA and only bounded data is returned. This is not a full designer-host compatibility claim.</summary>
        public static HostedServiceKernelCapabilitiesResult InspectPreviewServices(string rootKind = "Form",
            CancellationToken cancellationToken = default)
        {
            try
            {
                cancellationToken.ThrowIfCancellationRequested();
                EnsureStaThread();
                using var session = rootKind == "Form" ? CreateFormSession()
                    : rootKind == "UserControl" ? CreateUserControlSession()
                    : throw new NotSupportedException("UNSUPPORTED_HOSTED_ROOT_KIND: only Form and UserControl are admitted.");
                var toolbox = (IHostedToolboxCatalog)session.GetService(typeof(IHostedToolboxCatalog))!;
                var types = (ITypeResolutionService)session.GetService(typeof(ITypeResolutionService))!;
                var serializer = (IHostedPropertySerialization)session.GetService(typeof(IHostedPropertySerialization))!;
                var items = toolbox.GetItems(cancellationToken);
                var component = (Control)toolbox.CreateComponent("Button", "previewButton1", cancellationToken);
                component.Text = "Hosted Preview";
                component.Size = new Size(144, 32);
                var resolved = types.GetType(component.GetType().AssemblyQualifiedName!, throwOnError: true);
                var snapshots = serializer.Capture(new[] { component }, cancellationToken);
                var proposals = serializer.ReadProposals(snapshots, cancellationToken);
                bool classicRefused = session.GetService(typeof(IDesignerSerializationService)) == null
                    && session.TryGetServiceRefusal(typeof(IDesignerSerializationService), out _);
                using var incomplete = CreateFormSession(capabilities: ImplementedCapabilities.Where(
                    capability => capability != DesignerServiceKernelCapability.PropertySerialization));
                bool withheld = !incomplete.AdvertisesDesignerHost
                    && incomplete.GetService(typeof(IDesignerHost)) == null
                    && incomplete.GetService(typeof(IHostedPropertySerialization)) == null;
                cancellationToken.ThrowIfCancellationRequested();
                if (resolved != typeof(Button) || snapshots.Count != 1 || proposals.Count != 2
                    || !classicRefused || !withheld)
                    throw new InvalidOperationException("INCOMPLETE_SERVICE_CONTRACT: Preview service postconditions were not proved.");
                return new HostedServiceKernelCapabilitiesResult
                {
                    Ok = true,
                    Status = "ready",
                    ApartmentState = Thread.CurrentThread.GetApartmentState().ToString(),
                    RootType = session.RootComponent.GetType().FullName ?? "",
                    Contracts = ServiceContracts.ToList(),
                    ToolboxItems = items.ToList(),
                    ResolvedType = resolved?.FullName ?? "",
                    SerializedProperties = snapshots.ToList(),
                    Proposals = proposals.ToList(),
                    UnsupportedClassicSerializationRefused = classicRefused,
                    IncompleteHostWithheld = withheld,
                };
            }
            catch (Exception ex)
            {
                return new HostedServiceKernelCapabilitiesResult
                {
                    ErrorCode = ex is OperationCanceledException ? "REQUEST_CANCELLED" : "HOSTED_SERVICE_REFUSED",
                    Reason = ex.Message,
                    Contracts = ServiceContracts.ToList(),
                };
            }
        }

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
            KernelDesignerCreator? designerCreator = null)
        {
            EnsureStaThread();
            return CreateSessionCore(rootComponent, rootName, capabilities, designerCreator);
        }

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
        private readonly int _creatingThreadId = Thread.CurrentThread.ManagedThreadId;
        private bool _previewServiceInProgress;
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

            // Advertise the aggregate only when all entries of this bounded service profile are present. This does
            // not promise the entire Visual Studio service surface: classic serializers and native UI stay refused.
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
            if (IsEnabled(DesignerServiceKernelCapability.ToolboxCatalog))
                RegisterService(typeof(IHostedToolboxCatalog), new KernelToolboxCatalog(this));
            if (IsEnabled(DesignerServiceKernelCapability.TypeResolution))
                RegisterService(typeof(ITypeResolutionService), new KernelTypeResolutionService(this, rootComponent.GetType()));
            if (IsEnabled(DesignerServiceKernelCapability.PropertySerialization))
                RegisterService(typeof(IHostedPropertySerialization), new KernelPropertySerialization(this));

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

        public void Activate()
        {
            ThrowIfDisposed();
            Activated?.Invoke(this, EventArgs.Empty);
        }

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
            ThrowIfDisposed();
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
            ThrowIfDisposed();
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

        internal IDisposable BeginPreviewService(Type serviceType, CancellationToken cancellationToken)
        {
            if (IsDisposed) throw new ObjectDisposedException(nameof(DesignerServiceKernelSession));
            if (Thread.CurrentThread.ManagedThreadId != _creatingThreadId
                || Thread.CurrentThread.GetApartmentState() != ApartmentState.STA)
                throw PreviewRefusal(serviceType, "HOSTED_SERVICE_REQUIRES_OWNING_STA: use the creating engine STA.");
            cancellationToken.ThrowIfCancellationRequested();
            if (_previewServiceInProgress)
                throw PreviewRefusal(serviceType, "HOSTED_SERVICE_REENTRANT: nested Preview service calls are refused.");
            _previewServiceInProgress = true;
            return new PreviewServiceLease(() => _previewServiceInProgress = false);
        }

        internal NotSupportedException PreviewRefusal(Type serviceType, string reason)
        {
            Refuse(serviceType, CapabilityNameFor(serviceType), reason);
            return new NotSupportedException(reason);
        }

        internal void CloseTransaction(KernelDesignerTransaction transaction, bool commit)
        {
            if (!ReferenceEquals(_activeTransaction, transaction))
                return;
            ThrowIfDisposed();

            TransactionClosing?.Invoke(this, new DesignerTransactionCloseEventArgs(commit, lastTransaction: true));
            _activeTransaction = null;
            TransactionClosed?.Invoke(this, new DesignerTransactionCloseEventArgs(commit, lastTransaction: true));
        }

        public void Dispose()
        {
            if (IsDisposed) return;
            ThrowIfDisposed();
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
            || serviceType == typeof(IMenuCommandService)
            || serviceType == typeof(IHostedToolboxCatalog)
            || serviceType == typeof(ITypeResolutionService)
            || serviceType == typeof(IHostedPropertySerialization);

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
            EnsureOwningThread();
        }

        internal void EnsureOwningThread()
        {
            if (Thread.CurrentThread.ManagedThreadId != _creatingThreadId)
                throw new NotSupportedException("DESIGNER_SERVICE_REQUIRES_OWNING_THREAD: use the creating engine STA.");
        }

        internal void EnsureServiceAccess() => ThrowIfDisposed();

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
            if (serviceType == typeof(IHostedToolboxCatalog))
                return nameof(DesignerServiceKernelCapability.ToolboxCatalog);
            if (serviceType == typeof(ITypeResolutionService))
                return nameof(DesignerServiceKernelCapability.TypeResolution);
            if (serviceType == typeof(IHostedPropertySerialization))
                return nameof(DesignerServiceKernelCapability.PropertySerialization);
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

    internal sealed class PreviewServiceLease : IDisposable
    {
        private Action? _release;
        public PreviewServiceLease(Action release) => _release = release;
        public void Dispose()
        {
            var release = _release;
            _release = null;
            release?.Invoke();
        }
    }

    internal static class KernelPreviewTypes
    {
        public static readonly Type[] Toolbox = { typeof(Button), typeof(Label), typeof(Panel), typeof(TextBox) };
        public static bool IsSerializable(Type type) => Toolbox.Contains(type)
            || type == typeof(Form) || type == typeof(UserControl);
    }

    internal sealed class KernelToolboxCatalog : IHostedToolboxCatalog
    {
        private readonly KernelDesignerHost _host;
        public KernelToolboxCatalog(KernelDesignerHost host) => _host = host;

        public IReadOnlyList<HostedToolboxItem> GetItems(CancellationToken cancellationToken = default)
        {
            using var lease = _host.BeginPreviewService(typeof(IHostedToolboxCatalog), cancellationToken);
            return KernelPreviewTypes.Toolbox.Select(type => new HostedToolboxItem
            {
                Id = type.Name,
                TypeName = type.FullName ?? type.Name,
            }).ToArray();
        }

        public IComponent CreateComponent(string itemId, string name, CancellationToken cancellationToken = default)
        {
            using var lease = _host.BeginPreviewService(typeof(IHostedToolboxCatalog), cancellationToken);
            Type? type = KernelPreviewTypes.Toolbox.FirstOrDefault(candidate => candidate.Name == itemId);
            if (type == null)
                throw _host.PreviewRefusal(typeof(IHostedToolboxCatalog),
                    "TOOLBOX_ITEM_UNAVAILABLE: only exact framework catalogue identities are admitted.");
            if (string.IsNullOrEmpty(name) || name.Length > 128 || !KernelNameCreationService.IsValidIdentifier(name))
                throw _host.PreviewRefusal(typeof(IHostedToolboxCatalog), "TOOLBOX_NAME_INVALID: a bounded C# component name is required.");
            if (_host.Container.Components.Count >= 128)
                throw _host.PreviewRefusal(typeof(IHostedToolboxCatalog), "TOOLBOX_COMPONENT_LIMIT: the disposable session already owns 128 components.");
            // Cancellation is an admission boundary for this synchronous framework operation. No callback or source
            // mutation is started when it is already cancelled; cancellation during a callback is observed by its caller.
            cancellationToken.ThrowIfCancellationRequested();
            return _host.CreateComponent(type, name);
        }
    }

    internal sealed class KernelTypeResolutionService : ITypeResolutionService
    {
        private readonly KernelDesignerHost _host;
        private readonly Assembly[] _assemblies;

        public KernelTypeResolutionService(KernelDesignerHost host, Type rootType)
        {
            _host = host;
            _assemblies = new[] { typeof(object).Assembly, typeof(Component).Assembly,
                typeof(Control).Assembly, typeof(ControlDesigner).Assembly, typeof(ComponentDesigner).Assembly,
                rootType.Assembly }.Distinct().ToArray();
        }

        private Assembly[] AdmittedAssemblies => _assemblies.Concat(_host.Container.Components.Cast<IComponent>()
            .Select(component => component.GetType().Assembly)).Distinct().ToArray();

        public Assembly? GetAssembly(AssemblyName name) => GetAssembly(name, false);

        public Assembly? GetAssembly(AssemblyName name, bool throwOnError)
        {
            using var lease = _host.BeginPreviewService(typeof(ITypeResolutionService), default);
            return FindAssembly(name, throwOnError);
        }

        private Assembly? FindAssembly(AssemblyName name, bool throwOnError)
        {
            DesignerServiceKernelGuard.ThrowIfNull(name);
            var assembly = AdmittedAssemblies.FirstOrDefault(candidate =>
                string.Equals(candidate.GetName().FullName, name.FullName, StringComparison.Ordinal));
            if (assembly == null)
            {
                var refusal = _host.PreviewRefusal(typeof(ITypeResolutionService),
                    "TYPE_ASSEMBLY_NOT_ADMITTED: exact already-loaded assembly identity is required.");
                if (throwOnError) throw refusal;
            }
            return assembly;
        }

        public string? GetPathOfAssembly(AssemblyName name)
        {
            using var lease = _host.BeginPreviewService(typeof(ITypeResolutionService), default);
            return FindAssembly(name, false)?.Location;
        }

        public void ReferenceAssembly(AssemblyName name)
        {
            using var lease = _host.BeginPreviewService(typeof(ITypeResolutionService), default);
            // Existing session admission is idempotent. This never adds a project reference or loads an assembly.
            FindAssembly(name, true);
        }

        public Type? GetType(string name) => GetType(name, false, false);
        public Type? GetType(string name, bool throwOnError) => GetType(name, throwOnError, false);

        public Type? GetType(string name, bool throwOnError, bool ignoreCase)
        {
            using var lease = _host.BeginPreviewService(typeof(ITypeResolutionService), default);
            Type? found = null;
            if (!string.IsNullOrWhiteSpace(name) && name.Length <= 1024
                && name.IndexOfAny(new[] { '[', ']', '\0' }) < 0)
            {
                try
                {
                    var admitted = AdmittedAssemblies;
                    if (name.IndexOf(',') >= 0)
                        found = Type.GetType(name,
                            requested => admitted.FirstOrDefault(candidate =>
                                string.Equals(candidate.GetName().FullName, requested.FullName, StringComparison.Ordinal))
                                ?? ResolveFrameworkDesignMetadataAlias(requested),
                            (assembly, typeName, caseInsensitive) => assembly?.GetType(typeName, false, caseInsensitive),
                            false, ignoreCase);
                    else
                    {
                        var matches = admitted.Select(assembly => assembly.GetType(name, false, ignoreCase))
                            .Where(type => type != null).Distinct().Take(2).ToArray();
                        if (matches.Length == 1) found = matches[0];
                    }
                }
                catch (ArgumentException) { /* malformed names receive the same bounded refusal */ }
                catch (System.IO.FileNotFoundException) { /* never fall through to ambient loading */ }
                catch (TypeLoadException) { /* unresolved metadata remains unavailable */ }
            }
            if (found == null)
            {
                var refusal = _host.PreviewRefusal(typeof(ITypeResolutionService),
                    "TYPE_NOT_ADMITTED: a unique non-generic type in an admitted loaded assembly is required.");
                if (throwOnError) throw refusal;
            }
            return found;
        }

        private static Assembly? ResolveFrameworkDesignMetadataAlias(AssemblyName requested) =>
            string.Equals(requested.FullName,
                "System.Design, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a",
                StringComparison.Ordinal)
                ? typeof(ControlDesigner).Assembly
                : null;
    }

    internal sealed class KernelPropertySerialization : IHostedPropertySerialization
    {
        private readonly KernelDesignerHost _host;
        public KernelPropertySerialization(KernelDesignerHost host) => _host = host;

        public IReadOnlyList<HostedComponentPropertySnapshot> Capture(
            IReadOnlyList<IComponent> components, CancellationToken cancellationToken = default)
        {
            using var lease = _host.BeginPreviewService(typeof(IHostedPropertySerialization), cancellationToken);
            CheckCount(components?.Count ?? -1);
            var snapshots = new List<HostedComponentPropertySnapshot>();
            var names = new HashSet<string>(StringComparer.Ordinal);
            foreach (var component in components!)
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (component == null || !_host.ContainsComponent(component)
                    || !KernelPreviewTypes.IsSerializable(component.GetType()))
                    throw Refuse("PROPERTY_SERIALIZATION_TYPE_REFUSED: only owned exact framework controls are admitted.");
                var control = (Control)component;
                var snapshot = new HostedComponentPropertySnapshot
                {
                    ComponentName = component.Site?.Name ?? "",
                    ComponentType = component.GetType().FullName ?? "",
                    Text = control.Text,
                    Width = control.Width,
                    Height = control.Height,
                };
                ValidateSnapshot(snapshot, names);
                snapshots.Add(snapshot);
            }
            cancellationToken.ThrowIfCancellationRequested();
            return snapshots.ToArray();
        }

        public IReadOnlyList<HostedComponentPropertyProposal> ReadProposals(
            IReadOnlyList<HostedComponentPropertySnapshot> snapshots, CancellationToken cancellationToken = default)
        {
            using var lease = _host.BeginPreviewService(typeof(IHostedPropertySerialization), cancellationToken);
            CheckCount(snapshots?.Count ?? -1);
            var proposals = new List<HostedComponentPropertyProposal>();
            var names = new HashSet<string>(StringComparer.Ordinal);
            foreach (var snapshot in snapshots!)
            {
                cancellationToken.ThrowIfCancellationRequested();
                ValidateSnapshot(snapshot, names);
                var component = _host.Container.Components.Cast<IComponent>().FirstOrDefault(candidate =>
                    string.Equals(candidate.Site?.Name, snapshot.ComponentName, StringComparison.Ordinal));
                if (component == null || !KernelPreviewTypes.IsSerializable(component.GetType())
                    || component.GetType().FullName != snapshot.ComponentType)
                    throw Refuse("PROPERTY_SERIALIZATION_OWNER_MISMATCH: component identity/type is not owned by this session.");
                proposals.Add(new HostedComponentPropertyProposal
                {
                    ComponentName = snapshot.ComponentName,
                    ComponentType = snapshot.ComponentType,
                    PropertyName = nameof(Control.Text),
                    PropertyType = typeof(string).FullName!,
                    InvariantValue = snapshot.Text,
                });
                proposals.Add(new HostedComponentPropertyProposal
                {
                    ComponentName = snapshot.ComponentName,
                    ComponentType = snapshot.ComponentType,
                    PropertyName = nameof(Control.Size),
                    PropertyType = typeof(Size).FullName!,
                    InvariantValue = snapshot.Width.ToString(System.Globalization.CultureInfo.InvariantCulture)
                        + ", " + snapshot.Height.ToString(System.Globalization.CultureInfo.InvariantCulture),
                });
            }
            cancellationToken.ThrowIfCancellationRequested();
            return proposals.ToArray();
        }

        private void CheckCount(int count)
        {
            if (count < 1 || count > 16)
                throw Refuse("PROPERTY_SERIALIZATION_LIMIT: between 1 and 16 components are required.");
        }

        private void ValidateSnapshot(HostedComponentPropertySnapshot? snapshot, HashSet<string> names)
        {
            if (snapshot == null || string.IsNullOrEmpty(snapshot.ComponentName) || snapshot.ComponentName.Length > 128
                || !KernelNameCreationService.IsValidIdentifier(snapshot.ComponentName)
                || string.IsNullOrEmpty(snapshot.ComponentType) || snapshot.ComponentType.Length > 512
                || snapshot.Text == null || snapshot.Text.Length > 4096
                || snapshot.Width < 0 || snapshot.Width > 32767 || snapshot.Height < 0 || snapshot.Height > 32767
                || !names.Add(snapshot.ComponentName))
                throw Refuse("PROPERTY_SERIALIZATION_DATA_INVALID: identity, duplicate, text or geometry limit was violated.");
        }

        private NotSupportedException Refuse(string reason) =>
            _host.PreviewRefusal(typeof(IHostedPropertySerialization), reason);
    }

    internal sealed class KernelDesignContainer : IContainer
    {
        private readonly KernelDesignerHost _host;
        private readonly List<IComponent> _components = new();
        private bool _disposed;

        public KernelDesignContainer(KernelDesignerHost host) => _host = host;

        public ComponentCollection Components
        {
            get { _host.EnsureServiceAccess(); return new ComponentCollection(_components.ToArray()); }
        }

        public void Add(IComponent? component) => Add(component, null);

        public void Add(IComponent? component, string? name)
        {
            if (component == null) return;
            if (_disposed) throw new ObjectDisposedException(nameof(KernelDesignContainer));
            _host.EnsureServiceAccess();

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
            _host.EnsureServiceAccess();
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
            _host.EnsureOwningThread();
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
            _host.EnsureServiceAccess();
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

        public bool IsValidName(string name)
        {
            _host.EnsureServiceAccess();
            return IsValidIdentifier(name) && IsAvailable(_host.Container, name);
        }

        public void ValidateName(string name)
        {
            _host.EnsureServiceAccess();
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
            _host.EnsureServiceAccess();
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

        public object? PrimarySelection
        {
            get { _host.EnsureServiceAccess(); return _selection.Count == 0 ? null : _selection[0]; }
        }
        public int SelectionCount
        {
            get { _host.EnsureServiceAccess(); return _selection.Count; }
        }

        public bool GetComponentSelected(object component)
        {
            _host.EnsureServiceAccess();
            return _selection.Contains(component);
        }

        public ICollection GetSelectedComponents()
        {
            _host.EnsureServiceAccess();
            return _selection.ToArray();
        }

        public void SetSelectedComponents(ICollection? components) =>
            SetSelectedComponents(components, SelectionTypes.Replace);

        public void SetSelectedComponents(ICollection? components, SelectionTypes selectionType)
        {
            _host.EnsureServiceAccess();
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

        public DesignerVerbCollection Verbs
        {
            get { _host.EnsureServiceAccess(); return new DesignerVerbCollection(_verbs.ToArray()); }
        }

        public void AddCommand(MenuCommand command)
        {
            _host.EnsureServiceAccess();
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
            _host.EnsureServiceAccess();
            DesignerServiceKernelGuard.ThrowIfNull(verb);
            if (!_verbs.Contains(verb))
                _verbs.Add(verb);
        }

        public MenuCommand? FindCommand(CommandID commandID)
        {
            _host.EnsureServiceAccess();
            DesignerServiceKernelGuard.ThrowIfNull(commandID);
            _commands.TryGetValue(Key(commandID), out var command);
            return command;
        }

        public bool GlobalInvoke(CommandID commandID)
        {
            _host.EnsureServiceAccess();
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
            _host.EnsureServiceAccess();
            DesignerServiceKernelGuard.ThrowIfNull(command);
            var commandId = command.CommandID
                ?? throw new ArgumentException("Menu command must have a CommandID.", nameof(command));
            _commands.Remove(Key(commandId));
        }

        public void RemoveVerb(DesignerVerb verb)
        {
            _host.EnsureServiceAccess();
            DesignerServiceKernelGuard.ThrowIfNull(verb);
            _verbs.Remove(verb);
        }

        public void ShowContextMenu(CommandID menuID, int x, int y)
        {
            _host.EnsureServiceAccess();
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
