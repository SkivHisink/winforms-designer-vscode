using System;
using System.ComponentModel;
using System.ComponentModel.Design;
using System.ComponentModel.Design.Serialization;
using System.Drawing;
using System.Linq;
using System.Threading;
using System.Windows.Forms;
using WinFormsDesigner.Engine;
using Xunit;

namespace Engine.Net48.UnitTests;

public sealed class HostedPreviewServicesNet48Tests
{
    [Fact]
    public void CertifiedV1Projection_ReportsOnlyActualCoreServicesWhilePreviewKeepsNine()
    {
        var allServices = DesignerServiceKernel.ImplementedCapabilities.Select(capability => capability.ToString()).ToArray();
        Assert.Equal(9, allServices.Length);
        Assert.Equal(new[] { "ContainerSiting", "Naming", "ComponentChange", "Selection", "Transactions", "MenuCommands" },
            HostedServiceKernelV1Contract.ProjectCapabilities(allServices));
        Assert.Equal(new[] { "ContainerSiting", "Naming", "ComponentChange", "Transactions", "MenuCommands" },
            HostedServiceKernelV1Contract.ProjectCapabilities(allServices.Where(capability => capability != "Selection")
                .Concat(new[] { "selection", "Unsupported", "Naming" })));
        Assert.Empty(HostedServiceKernelV1Contract.ProjectCapabilities(new[] { "ToolboxCatalog", "TypeResolution", "PropertySerialization" }));
    }

    [Fact]
    public void Registry_DeclaresEveryCapabilityAndExplicitClassicLimits()
    {
        var contracts = DesignerServiceKernel.ServiceContracts;
        Assert.Equal("0.1.0", DesignerServiceKernel.ServiceProfileVersion);
        Assert.Equal(DesignerServiceKernel.ImplementedCapabilities.Select(value => value.ToString()).OrderBy(value => value),
            contracts.Select(value => value.Capability).OrderBy(value => value));
        Assert.All(contracts, contract =>
        {
            Assert.NotEmpty(contract.ServiceType);
            Assert.NotEmpty(contract.Methods);
            Assert.NotEmpty(contract.Threading);
            Assert.NotEmpty(contract.Lifetime);
            Assert.NotEmpty(contract.Cancellation);
            Assert.NotEmpty(contract.Reentrancy);
            Assert.NotEmpty(contract.Refusal);
            Assert.NotEmpty(contract.Scope);
        });
        Assert.Contains("No general classic clipboard/CodeDOM serialization",
            contracts.Single(value => value.Capability == "PropertySerialization").Scope);
    }

    [Theory]
    [InlineData("Form")]
    [InlineData("UserControl")]
    public void ProductInspection_ExecutesActualServicesOnSta(string rootKind) => RunOnSta(() =>
    {
        var result = DesignerServiceKernel.InspectPreviewServices(rootKind);
        Assert.True(result.Ok, result.Reason);
        Assert.Equal("ready", result.Status);
        Assert.Equal("STA", result.ApartmentState);
        Assert.Equal("0.1.0", result.ServiceProfileVersion);
        Assert.Equal(9, result.Contracts.Count);
        Assert.Equal(4, result.ToolboxItems.Count);
        Assert.Equal(typeof(Button).FullName, result.ResolvedType);
        Assert.Equal("Hosted Preview", Assert.Single(result.SerializedProperties).Text);
        Assert.Equal(new[] { "Text", "Size" }, result.Proposals.Select(proposal => proposal.PropertyName));
        Assert.True(result.UnsupportedClassicSerializationRefused);
        Assert.True(result.IncompleteHostWithheld);
    });

    [Fact]
    public void Toolbox_ValidatesBeforeCreatingAndRejectsNestedCalls() => RunOnSta(() =>
    {
        using var session = DesignerServiceKernel.CreateFormSession();
        var toolbox = Assert.IsAssignableFrom<IHostedToolboxCatalog>(session.GetService(typeof(IHostedToolboxCatalog)));
        Assert.Throws<NotSupportedException>(() => toolbox.CreateComponent("Form", "otherForm"));
        Assert.Throws<NotSupportedException>(() => toolbox.CreateComponent("Button", "invalid name"));
        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();
        Assert.Throws<OperationCanceledException>(() => toolbox.CreateComponent("Button", "cancelledButton", cancelled.Token));
        Assert.Single(session.Container.Components.Cast<IComponent>());
        bool nestedRefused = false;
        var changes = (IComponentChangeService)session.GetService(typeof(IComponentChangeService))!;
        changes.ComponentAdding += (_, _) =>
        {
            var error = Assert.Throws<NotSupportedException>(() => toolbox.GetItems());
            nestedRefused = error.Message.IndexOf("HOSTED_SERVICE_REENTRANT", StringComparison.Ordinal) >= 0;
        };
        var created = Assert.IsType<Button>(toolbox.CreateComponent("Button", "button1"));
        Assert.True(nestedRefused);
        Assert.Same(session.Container, created.Site?.Container);
        Assert.True(created.Site?.DesignMode);
        Assert.False(created.IsHandleCreated);
        Assert.Throws<InvalidOperationException>(() => toolbox.CreateComponent("Label", "button1"));
        Assert.Equal(2, session.Container.Components.Count);
        Assert.Equal(4, toolbox.GetItems().Count);
    });

    [Fact]
    public void TypeResolution_UsesExactAdmittedAssembliesAndNeverAmbientTypes() => RunOnSta(() =>
    {
        using var session = DesignerServiceKernel.CreateFormSession();
        var types = (ITypeResolutionService)session.GetService(typeof(ITypeResolutionService))!;
        Assert.Same(typeof(Button), types.GetType(typeof(Button).FullName!));
        Assert.Same(typeof(Button), types.GetType(typeof(Button).AssemblyQualifiedName!, true));
        Assert.Same(typeof(Button), types.GetType("system.windows.forms.button", true, true));
        var framework = typeof(Control).Assembly;
        Assert.Same(framework, types.GetAssembly(framework.GetName(), true));
        Assert.Equal(framework.Location, types.GetPathOfAssembly(framework.GetName()));
        types.ReferenceAssembly(framework.GetName());
        Assert.Null(types.GetAssembly(typeof(HostedPreviewServicesNet48Tests).Assembly.GetName()));
        Assert.Null(types.GetType(typeof(HostedPreviewServicesNet48Tests).AssemblyQualifiedName!));
        Assert.Throws<NotSupportedException>(() => types.ReferenceAssembly(typeof(HostedPreviewServicesNet48Tests).Assembly.GetName()));
        Assert.Throws<NotSupportedException>(() => types.GetType("Missing.Type, Missing.Assembly", true));
        Assert.Null(types.GetType("System.Windows.Forms.Design.ButtonBaseDesigner, System.Design, Version=5.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a"));
        Assert.Null(types.GetType("System.Windows.Forms.Button[]"));
        Assert.True(session.TryGetServiceRefusal(typeof(ITypeResolutionService), out var refusal));
        Assert.Equal("TypeResolution", refusal.Capability);
        Assert.Same(typeof(Label), types.GetType(typeof(Label).FullName!));
    });

    [Fact]
    public void TypeResolution_ResolvesAdmittedFrameworkDesignerMetadata() => RunOnSta(() =>
    {
        using var session = DesignerServiceKernel.CreateFormSession();
        session.CreateComponent(typeof(Button), "button1");
        var types = (ITypeResolutionService)session.GetService(typeof(ITypeResolutionService))!;
        foreach (DesignerAttribute attribute in TypeDescriptor.GetAttributes(typeof(Button)).OfType<DesignerAttribute>())
            Assert.True(types.GetType(attribute.DesignerTypeName) != null, attribute.DesignerTypeName);
    });

    [Fact]
    public void PropertySerialization_RoundTripsClosedDataToProposalsWithoutMutation() => RunOnSta(() =>
    {
        using var session = DesignerServiceKernel.CreateFormSession();
        var button = (Button)session.CreateComponent(typeof(Button), "button1");
        button.Text = "До 😀";
        button.Size = new Size(123, 45);
        var serializer = (IHostedPropertySerialization)session.GetService(typeof(IHostedPropertySerialization))!;
        var captured = Assert.Single(serializer.Capture(new[] { button }));
        Assert.Equal("До 😀", captured.Text);
        Assert.Equal(123, captured.Width);
        var updated = new HostedComponentPropertySnapshot
        {
            ComponentName = captured.ComponentName,
            ComponentType = captured.ComponentType,
            Text = "After",
            Width = 321,
            Height = 54,
        };
        var proposals = serializer.ReadProposals(new[] { updated });
        Assert.Equal("After", proposals.Single(value => value.PropertyName == "Text").InvariantValue);
        Assert.Equal("321, 54", proposals.Single(value => value.PropertyName == "Size").InvariantValue);
        Assert.All(proposals, proposal => Assert.Equal("button1", proposal.ComponentName));
        Assert.Equal("До 😀", button.Text);
        Assert.Equal(new Size(123, 45), button.Size);
        Assert.Null(session.GetService(typeof(IDesignerSerializationService)));
    });

    [Fact]
    public void PropertySerialization_RejectsDerivedUnownedOversizedDuplicateAndWrongType() => RunOnSta(() =>
    {
        using var session = DesignerServiceKernel.CreateFormSession();
        var serializer = (IHostedPropertySerialization)session.GetService(typeof(IHostedPropertySerialization))!;
        var button = (Button)session.CreateComponent(typeof(Button), "button1");
        var derived = (ObservedButton)session.CreateComponent(typeof(ObservedButton), "derived1");
        derived.TextReads = 0;
        Assert.Throws<NotSupportedException>(() => serializer.Capture(new[] { derived }));
        Assert.Equal(0, derived.TextReads);
        using var unowned = new Button();
        Assert.Throws<NotSupportedException>(() => serializer.Capture(new[] { unowned }));
        Assert.Throws<NotSupportedException>(() => serializer.Capture(Enumerable.Repeat<IComponent>(button, 17).ToArray()));
        var valid = Assert.Single(serializer.Capture(new[] { button }));
        Assert.Throws<NotSupportedException>(() => serializer.ReadProposals(new[] { valid, valid }));
        Assert.Throws<NotSupportedException>(() => serializer.ReadProposals(new[]
        {
            new HostedComponentPropertySnapshot { ComponentName = "button1", ComponentType = typeof(Label).FullName!, Text = "bad" },
        }));
        Assert.Throws<NotSupportedException>(() => serializer.ReadProposals(new[]
        {
            new HostedComponentPropertySnapshot { ComponentName = "BUTTON1", ComponentType = typeof(Button).FullName!, Text = "case is an identity boundary" },
        }));
        Assert.Throws<NotSupportedException>(() => serializer.ReadProposals(new[]
        {
            new HostedComponentPropertySnapshot { ComponentName = "button1", ComponentType = typeof(Button).FullName!, Text = new string('x', 4097) },
        }));
        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();
        Assert.Throws<OperationCanceledException>(() => serializer.Capture(new[] { button }, cancelled.Token));
        Assert.Throws<OperationCanceledException>(() => serializer.ReadProposals(new[] { valid }, cancelled.Token));
        Assert.Equal(2, serializer.ReadProposals(new[] { valid }).Count);
    });

    [Fact]
    public void Services_RejectCrossThreadRetainedReferencesAndDisposedSessions() => RunOnSta(() =>
    {
        var session = DesignerServiceKernel.CreateFormSession();
        var toolbox = (IHostedToolboxCatalog)session.GetService(typeof(IHostedToolboxCatalog))!;
        var types = (ITypeResolutionService)session.GetService(typeof(ITypeResolutionService))!;
        var serializer = (IHostedPropertySerialization)session.GetService(typeof(IHostedPropertySerialization))!;
        Exception? crossThread = null;
        var other = new Thread(() =>
        {
            try { toolbox.GetItems(); } catch (Exception ex) { crossThread = ex; }
        });
        other.SetApartmentState(ApartmentState.STA);
        other.Start();
        Assert.True(other.Join(TimeSpan.FromSeconds(10)));
        Assert.Contains("HOSTED_SERVICE_REQUIRES_OWNING_STA", Assert.IsType<NotSupportedException>(crossThread).Message);
        Assert.Equal(4, toolbox.GetItems().Count);
        session.Dispose();
        Assert.Throws<ObjectDisposedException>(() => toolbox.GetItems());
        Assert.Throws<ObjectDisposedException>(() => types.GetType(typeof(Button).FullName!));
        Assert.Throws<ObjectDisposedException>(() => serializer.Capture(Array.Empty<IComponent>()));
    });

    [Fact]
    public void MissingEachPreviewService_WithholdsAggregateHostAndCannotBeReplaced() => RunOnSta(() =>
    {
        foreach (var entry in new[]
        {
            (DesignerServiceKernelCapability.ToolboxCatalog, typeof(IHostedToolboxCatalog)),
            (DesignerServiceKernelCapability.TypeResolution, typeof(ITypeResolutionService)),
            (DesignerServiceKernelCapability.PropertySerialization, typeof(IHostedPropertySerialization)),
        })
        {
            using var session = DesignerServiceKernel.CreateFormSession(capabilities:
                DesignerServiceKernel.ImplementedCapabilities.Where(value => value != entry.Item1));
            Assert.False(session.AdvertisesDesignerHost);
            Assert.Null(session.GetService(typeof(IDesignerHost)));
            Assert.Null(session.GetService(entry.Item2));
            Assert.True(session.TryGetServiceRefusal(entry.Item2, out var refusal));
            Assert.Equal(entry.Item1.ToString(), refusal.Capability);
            var services = (IServiceContainer)session.GetService(typeof(IServiceContainer))!;
            Assert.Throws<NotSupportedException>(() => services.AddService(entry.Item2, (_, _) => null));
        }
    });

    [Fact]
    public void CoreServices_CheckOwnerBeforeEffectsAndInvalidateRetainedReferences() => RunOnSta(() =>
    {
        var session = DesignerServiceKernel.CreateFormSession();
        var button = session.CreateComponent(typeof(Button), "button1");
        var names = (INameCreationService)session.GetService(typeof(INameCreationService))!;
        var selection = (ISelectionService)session.GetService(typeof(ISelectionService))!;
        var menu = (IMenuCommandService)session.GetService(typeof(IMenuCommandService))!;
        var changes = (IComponentChangeService)session.GetService(typeof(IComponentChangeService))!;
        var commandId = new CommandID(new Guid("49685e23-d83d-4e0a-bcbc-c75ecc0d342a"), 1);
        int invocations = 0;
        int notifications = 0;
        menu.AddCommand(new MenuCommand((_, _) => invocations++, commandId));
        changes.ComponentChanging += (_, _) => notifications++;
        Exception? threadError = null;
        var other = new Thread(() =>
        {
            try
            {
                Assert.Throws<NotSupportedException>(() => names.IsValidName("otherName"));
                Assert.Throws<NotSupportedException>(() => selection.SetSelectedComponents(new[] { button }));
                Assert.Throws<NotSupportedException>(() => menu.GlobalInvoke(commandId));
                Assert.Throws<NotSupportedException>(() => changes.OnComponentChanging(button, null));
                Assert.Throws<NotSupportedException>(() => session.Host.CreateComponent(typeof(Label), "otherLabel"));
                Assert.Throws<NotSupportedException>(() => { _ = session.Container.Components; });
                Assert.Throws<NotSupportedException>(() => session.Container.Dispose());
            }
            catch (Exception ex) { threadError = ex; }
        });
        other.SetApartmentState(ApartmentState.STA);
        other.Start();
        Assert.True(other.Join(TimeSpan.FromSeconds(10)));
        if (threadError != null) throw threadError;
        Assert.Equal(0, selection.SelectionCount);
        Assert.Equal(0, invocations);
        Assert.Equal(0, notifications);
        Assert.Equal(2, session.Container.Components.Count);
        session.Dispose();
        Assert.Throws<ObjectDisposedException>(() => names.IsValidName("otherName"));
        Assert.Throws<ObjectDisposedException>(() => selection.GetSelectedComponents());
        Assert.Throws<ObjectDisposedException>(() => menu.GlobalInvoke(commandId));
        Assert.Throws<ObjectDisposedException>(() => changes.OnComponentChanging(button, null));
        Assert.Throws<ObjectDisposedException>(() => session.Host.GetType(typeof(Button).FullName!));
        Assert.Throws<ObjectDisposedException>(() => { _ = session.Container.Components; });
    });

    [Fact]
    public void ProductInspection_RefusesCancellationUnsupportedRootAndMta()
    {
        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();
        Assert.Equal("REQUEST_CANCELLED", DesignerServiceKernel.InspectPreviewServices("Form", cancelled.Token).ErrorCode);
        RunOnSta(() => Assert.Contains("UNSUPPORTED_HOSTED_ROOT_KIND",
            DesignerServiceKernel.InspectPreviewServices("Panel").Reason));
        HostedServiceKernelCapabilitiesResult? result = null;
        var mta = new Thread(() => result = DesignerServiceKernel.InspectPreviewServices());
        mta.SetApartmentState(ApartmentState.MTA);
        mta.Start();
        Assert.True(mta.Join(TimeSpan.FromSeconds(10)));
        Assert.False(result!.Ok);
        Assert.Contains("DESIGNER_SERVICE_KERNEL_REQUIRES_STA", result.Reason);
    }

    private static void RunOnSta(Action action)
    {
        Exception? error = null;
        var thread = new Thread(() => { try { action(); } catch (Exception ex) { error = ex; } }) { IsBackground = true };
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        Assert.True(thread.Join(TimeSpan.FromSeconds(30)), "Headless service contract exceeded 30 seconds.");
        if (error != null) System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(error).Throw();
    }

    public sealed class ObservedButton : Button
    {
        public int TextReads;
#if !NETFRAMEWORK
        [System.Diagnostics.CodeAnalysis.AllowNull]
#endif
        public override string Text { get { TextReads++; return base.Text; } set => base.Text = value; }
    }
}
