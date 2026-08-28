using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.ComponentModel.Design;
using System.ComponentModel.Design.Serialization;
using System.Linq;
using System.Windows.Forms;
using System.Threading;
using FakeVendor;
using WinFormsDesigner.Engine;

namespace Engine.UnitTests;

public sealed class DesignerServiceKernelTests
{
    [Fact(DisplayName = "V2-FND-001-S092 unavailable incomplete service returns explicit refusal")]
    [Trait("V2Scenario", "V2-FND-001-S092")]
    public void FormSession_SitesRootAndCreatedComponents_AndExposesOnlyEnabledCoreServices()
    {
        using var session = DesignerServiceKernel.CreateContractTestFormSession();
        var host = session.Host;

        Assert.IsType<Form>(host.RootComponent);
        Assert.Equal("form1", host.RootComponent.Site?.Name);
        Assert.True(host.RootComponent.Site?.DesignMode);
        Assert.Same(host, host.RootComponent.Site?.GetService(typeof(IDesignerHost)));
        Assert.Same(host.Container, host.RootComponent.Site?.GetService(typeof(IContainer)));

        var button = Assert.IsType<Button>(host.CreateComponent(typeof(Button)));
        Assert.Equal("button1", button.Site?.Name);
        Assert.True(button.Site?.DesignMode);
        Assert.Same(host.Container, button.Site?.Container);

        Assert.Same(host, session.GetService(typeof(IDesignerHost)));
        Assert.Same(host.Container, session.GetService(typeof(IContainer)));
        Assert.IsAssignableFrom<INameCreationService>(session.GetService(typeof(INameCreationService)));
        Assert.IsAssignableFrom<IComponentChangeService>(session.GetService(typeof(IComponentChangeService)));
        Assert.IsAssignableFrom<ISelectionService>(session.GetService(typeof(ISelectionService)));
        Assert.IsAssignableFrom<IMenuCommandService>(session.GetService(typeof(IMenuCommandService)));

        Assert.Null(session.GetService(typeof(IDesignerSerializationService)));
        Assert.True(session.TryGetServiceRefusal(typeof(IDesignerSerializationService), out var refusal));
        Assert.Equal("Unsupported", refusal.Capability);
        Assert.Contains("No truthful implementation", refusal.Reason);
    }

    [Fact]
    public void UserControlSession_SitesRootAndSupportsExplicitComponentNames()
    {
        using var session = DesignerServiceKernel.CreateContractTestUserControlSession("editorRoot");
        var root = Assert.IsType<UserControl>(session.Host.RootComponent);
        var label = Assert.IsType<Label>(session.CreateComponent(typeof(Label), "captionLabel"));

        root.Controls.Add(label);

        Assert.Equal("editorRoot", root.Site?.Name);
        Assert.Equal("captionLabel", label.Site?.Name);
        Assert.Contains(label, root.Controls.Cast<Control>());
        Assert.Equal(new[] { "editorRoot", "captionLabel" },
            session.Container.Components.Cast<IComponent>().Select(component => component.Site?.Name).ToArray());
    }

    [Fact]
    public void Naming_RefusesInvalidAndDuplicateNames()
    {
        using var session = DesignerServiceKernel.CreateContractTestFormSession();
        var names = Assert.IsAssignableFrom<INameCreationService>(session.GetService(typeof(INameCreationService)));
        session.CreateComponent(typeof(Button), "button1");

        Assert.False(names.IsValidName("button1"));
        Assert.Throws<ArgumentException>(() => names.ValidateName("1bad"));
        Assert.Throws<ArgumentException>(() => session.CreateComponent(typeof(Label), "not valid"));
        var duplicate = Assert.Throws<InvalidOperationException>(() => session.CreateComponent(typeof(TextBox), "button1"));
        Assert.Contains("Duplicate component name", duplicate.Message);

        Assert.Equal("label1", names.CreateName(session.Container, typeof(Label)));
    }

    [Fact]
    public void ComponentChangeService_RoutesAddRemoveRenameAndPropertyEvents()
    {
        using var session = DesignerServiceKernel.CreateContractTestFormSession();
        var changes = Assert.IsAssignableFrom<IComponentChangeService>(
            session.GetService(typeof(IComponentChangeService)));
        var observed = new List<string>();

        changes.ComponentAdding += (_, e) => observed.Add("adding:" + e.Component?.GetType().Name);
        changes.ComponentAdded += (_, e) => observed.Add("added:" + e.Component?.Site?.Name);
        changes.ComponentRename += (_, e) => observed.Add("rename:" + e.OldName + ">" + e.NewName);
        changes.ComponentChanging += (_, e) => observed.Add("changing:" + e.Member?.Name);
        changes.ComponentChanged += (_, e) => observed.Add("changed:" + e.Member?.Name + ":" + e.OldValue + ">" + e.NewValue);
        changes.ComponentRemoving += (_, e) => observed.Add("removing:" + e.Component?.Site?.Name);
        changes.ComponentRemoved += (_, e) => observed.Add("removed:" + e.Component?.GetType().Name);

        var button = Assert.IsType<Button>(session.CreateComponent(typeof(Button), "okButton"));
        button.Site!.Name = "saveButton";
        var textProperty = TypeDescriptor.GetProperties(button)[nameof(Button.Text)];
        changes.OnComponentChanging(button, textProperty);
        changes.OnComponentChanged(button, textProperty, "Old", "New");
        session.Host.DestroyComponent(button);

        Assert.Equal(new[]
        {
            "adding:Button",
            "added:okButton",
            "rename:okButton>saveButton",
            "changing:Text",
            "changed:Text:Old>New",
            "removing:saveButton",
            "removed:Button",
        }, observed);
        Assert.Null(button.Site);
        Assert.True(button.IsDisposed);
    }

    [Fact(DisplayName = "V2-FND-001-S090 designer transaction commit produces one undo unit")]
    [Trait("V2Scenario", "V2-FND-001-S090")]
    public void Transactions_RaiseCommitCancelAndRefuseNestedTransactions()
    {
        using var session = DesignerServiceKernel.CreateContractTestFormSession();
        var host = session.Host;
        var observed = new List<string>();

        host.TransactionOpening += (_, _) => observed.Add("opening");
        host.TransactionOpened += (_, _) => observed.Add("opened:" + host.TransactionDescription);
        host.TransactionClosing += (_, e) => observed.Add("closing:" + e.TransactionCommitted + ":" + e.LastTransaction);
        host.TransactionClosed += (_, e) => observed.Add("closed:" + e.TransactionCommitted + ":" + e.LastTransaction);

        using (var transaction = host.CreateTransaction("commit change"))
        {
            Assert.True(host.InTransaction);
            Assert.Equal("commit change", host.TransactionDescription);
            var nested = Assert.Throws<NotSupportedException>(() => host.CreateTransaction("nested"));
            Assert.Contains("Nested designer transactions", nested.Message);
            transaction.Commit();
        }

        Assert.False(host.InTransaction);

        using (var transaction = host.CreateTransaction("cancel change"))
        {
            transaction.Cancel();
        }

        Assert.Equal(new[]
        {
            "opening",
            "opened:commit change",
            "closing:True:True",
            "closed:True:True",
            "opening",
            "opened:cancel change",
            "closing:False:True",
            "closed:False:True",
        }, observed);
    }

    [Fact]
    public void SelectionService_RoutesSelectionAndRefusesForeignComponents()
    {
        using var session = DesignerServiceKernel.CreateContractTestFormSession();
        var selection = Assert.IsAssignableFrom<ISelectionService>(
            session.GetService(typeof(ISelectionService)));
        var button = session.CreateComponent(typeof(Button), "okButton");
        var label = session.CreateComponent(typeof(Label), "captionLabel");
        var observed = new List<string>();

        selection.SelectionChanging += (_, _) => observed.Add("changing");
        selection.SelectionChanged += (_, _) => observed.Add("changed:" + selection.SelectionCount);

        selection.SetSelectedComponents(new object[] { button });
        selection.SetSelectedComponents(new object[] { label }, SelectionTypes.Add | SelectionTypes.Primary);
        selection.SetSelectedComponents(new object[] { button }, SelectionTypes.Remove);

        Assert.True(selection.GetComponentSelected(label));
        Assert.False(selection.GetComponentSelected(button));
        Assert.Same(label, selection.PrimarySelection);
        Assert.Equal(new[] { label }, selection.GetSelectedComponents().Cast<object>().ToArray());
        Assert.Equal(new[] { "changing", "changed:1", "changing", "changed:2", "changing", "changed:1" },
            observed);

        using var foreign = new Button();
        var refused = Assert.Throws<InvalidOperationException>(() =>
            selection.SetSelectedComponents(new object[] { foreign }));
        Assert.Contains("owned by this kernel session", refused.Message);
        Assert.True(session.TryGetServiceRefusal(typeof(ISelectionService), out var refusal));
        Assert.Equal(nameof(DesignerServiceKernelCapability.Selection), refusal.Capability);
    }

    [Fact]
    public void MenuCommandService_RoutesCommandsAndVerbs_AndRefusesHeadlessContextMenu()
    {
        using var session = DesignerServiceKernel.CreateContractTestFormSession();
        var menu = Assert.IsAssignableFrom<IMenuCommandService>(
            session.GetService(typeof(IMenuCommandService)));
        var commandId = new CommandID(Guid.NewGuid(), 7);
        var invokes = 0;
        var command = new MenuCommand((_, _) => invokes++, commandId);
        var verb = new DesignerVerb("Configure", (_, _) => invokes += 10);

        menu.AddCommand(command);
        menu.AddVerb(verb);

        Assert.Same(command, menu.FindCommand(commandId));
        Assert.True(menu.GlobalInvoke(commandId));
        Assert.Equal(1, invokes);
        Assert.Equal(new[] { "Configure" }, menu.Verbs.Cast<DesignerVerb>().Select(v => v.Text).ToArray());

        verb.Invoke();
        Assert.Equal(11, invokes);

        Assert.Throws<InvalidOperationException>(() => menu.AddCommand(command));
        menu.RemoveCommand(command);
        Assert.False(menu.GlobalInvoke(commandId));

        var refused = Assert.Throws<NotSupportedException>(() => menu.ShowContextMenu(commandId, 1, 2));
        Assert.Contains("Context menu UI display", refused.Message);
        Assert.True(session.TryGetServiceRefusal(typeof(IMenuCommandService), out var refusal));
        Assert.Equal(nameof(DesignerServiceKernelCapability.MenuCommands), refusal.Capability);
    }

    [Fact]
    public void DisabledCapability_MakesServiceUnavailableWithNamedRefusal()
    {
        using var session = DesignerServiceKernel.CreateContractTestSession(new Form(), "form1", new[]
        {
            DesignerServiceKernelCapability.ContainerSiting,
            DesignerServiceKernelCapability.Naming,
        });

        Assert.Null(session.GetService(typeof(ISelectionService)));
        Assert.True(session.TryGetServiceRefusal(typeof(ISelectionService), out var refusal));
        Assert.Equal(nameof(DesignerServiceKernelCapability.Selection), refusal.Capability);
        Assert.Contains("Capability is not enabled", refusal.Reason);
        Assert.False(session.AdvertisesDesignerHost);
        Assert.Null(session.GetService(typeof(IDesignerHost)));
        Assert.Null(session.RootComponent.Site?.GetService(typeof(IDesignerHost)));
        Assert.True(session.TryGetServiceRefusal(typeof(IDesignerHost), out var hostRefusal));
        Assert.Equal("HostedServiceContract", hostRefusal.Capability);
        Assert.Contains(nameof(DesignerServiceKernelCapability.Selection), hostRefusal.Reason);

        var host = session.Host;
        var transaction = Assert.Throws<NotSupportedException>(() => host.CreateTransaction("not enabled"));
        Assert.Contains("not enabled", transaction.Message);
    }

    [Fact]
    public void ServiceContainer_CannotOverrideKernelControlledServices_AndRejectsBadCallbacks()
    {
        using var session = DesignerServiceKernel.CreateContractTestSession(new Form(), "form1", new[]
        {
            DesignerServiceKernelCapability.ContainerSiting,
            DesignerServiceKernelCapability.Naming,
        });
        var services = Assert.IsAssignableFrom<IServiceContainer>(session.GetService(typeof(IServiceContainer)));

        Assert.Throws<NotSupportedException>(() =>
            services.AddService(typeof(ISelectionService), new FakeSelectionService()));
        Assert.Throws<NotSupportedException>(() =>
            services.AddService(typeof(IDesignerSerializationService), new object()));
        Assert.Null(session.GetService(typeof(ISelectionService)));

        services.AddService(typeof(IFormatProvider), (_, _) => "wrong type");
        Assert.Null(session.GetService(typeof(IFormatProvider)));
        Assert.True(session.TryGetServiceRefusal(typeof(IFormatProvider), out var wrongType));
        Assert.Contains("does not implement", wrongType.Reason);

        services.AddService(typeof(ICloneable), (provider, type) => provider.GetService(type)!);
        Assert.Null(session.GetService(typeof(ICloneable)));
        Assert.True(session.TryGetServiceRefusal(typeof(ICloneable), out var reentrant));
        Assert.Contains("failed", reentrant.Reason);
    }

    [Fact]
    public void ChangeService_RefusesForeignComponents_AndDisposeCancelsActiveTransaction()
    {
        var session = DesignerServiceKernel.CreateContractTestFormSession();
        var changes = Assert.IsAssignableFrom<IComponentChangeService>(
            session.GetService(typeof(IComponentChangeService)));
        using var foreign = new Button();
        Assert.Throws<InvalidOperationException>(() => changes.OnComponentChanging(foreign, null));
        Assert.True(session.TryGetServiceRefusal(typeof(IComponentChangeService), out var refusal));
        Assert.Contains("owned by this kernel session", refusal.Reason);

        var host = session.Host;
        var closed = new List<bool>();
        host.TransactionClosed += (_, e) => closed.Add(e.TransactionCommitted);
        _ = host.CreateTransaction("active during dispose");
        session.Dispose();

        Assert.Equal(new[] { false }, closed);
        Assert.False(host.InTransaction);
    }

    [Fact]
    public void TypeResolution_UsesOnlyAlreadyLoadedAssemblies()
    {
        using var session = DesignerServiceKernel.CreateContractTestFormSession();
        var attemptedLoads = 0;
        ResolveEventHandler handler = (_, _) =>
        {
            attemptedLoads++;
            return null;
        };
        AppDomain.CurrentDomain.AssemblyResolve += handler;
        try
        {
            Assert.Same(typeof(Button), session.Host.GetType(typeof(Button).AssemblyQualifiedName!));
            Assert.Null(session.Host.GetType("Never.Load.Type, Never.Load.Assembly"));
            Assert.Equal(0, attemptedLoads);
        }
        finally
        {
            AppDomain.CurrentDomain.AssemblyResolve -= handler;
        }
    }

    [Fact(DisplayName = "V2-FND-001-S089 hosted service kernel advertises IDesignerHost only when complete")]
    [Trait("V2Scenario", "V2-FND-001-S089")]
    public void HostedDesigner_CreatesFrameworkDesigner_AndRefusesForeignComponents()
    {
        RunOnSta(() =>
        {
            using var session = DesignerServiceKernel.CreateFormSession();
            var button = Assert.IsType<Button>(session.CreateComponent(typeof(Button), "button1"));

            var inspection = session.InspectDesigner(button);

            Assert.True(session.AdvertisesDesignerHost);
            Assert.Same(session.Host, session.GetService(typeof(IDesignerHost)));
            Assert.Same(session.Host, button.Site?.GetService(typeof(IDesignerHost)));
            Assert.True(inspection.Ok, inspection.Reason);
            Assert.Equal(typeof(Button).FullName, inspection.ComponentType);
            Assert.Contains("Designer", inspection.DesignerType);
            Assert.Empty(inspection.ErrorCode);
            Assert.Same(session.Host.GetDesigner(button), session.Host.GetDesigner(button));

            using var foreign = new Button();
            var refused = Assert.Throws<InvalidOperationException>(() => session.Host.GetDesigner(foreign));
            Assert.Contains("owned by this kernel session", refused.Message);
            Assert.True(session.TryGetServiceRefusal(typeof(IDesigner), out var refusal));
            Assert.Equal("Designers", refusal.Capability);
        });
    }

    [Fact(DisplayName = "V2-FND-001-S089/S090 certified product broker advertises a complete host and returns one transaction proposal set")]
    [Trait("V2Scenario", "V2-FND-001-S089")]
    [Trait("V2Scenario", "V2-FND-001-S090")]
    public void CertifiedProductBroker_ProvesCompleteHostAndOneTwoPropertyTransaction()
    {
        RunOnSta(() =>
        {
            string assemblyPath = typeof(HostedServiceControl).Assembly.Location;

            var inspected = HostedServiceKernelProductBroker.Inspect(
                assemblyPath,
                HostedServiceKernelProductBroker.ComponentTypeName,
                HostedServiceKernelProductBroker.CertificationId);
            var invoked = HostedServiceKernelProductBroker.Invoke(
                assemblyPath,
                HostedServiceKernelProductBroker.ComponentTypeName,
                HostedServiceKernelProductBroker.CertificationId,
                HostedServiceKernelProductBroker.CommandId);
            var reentrant = HostedServiceKernelProductBroker.Invoke(
                assemblyPath,
                HostedServiceKernelProductBroker.ComponentTypeName,
                HostedServiceKernelProductBroker.CertificationId,
                HostedServiceKernelProductBroker.ReentrantCommandId);

            Assert.True(inspected.Ok, inspected.Reason);
            Assert.Equal("ready", inspected.Status);
            Assert.Equal("STA", inspected.ApartmentState);
            Assert.Equal(typeof(HostedServiceControl).FullName, inspected.ComponentType);
            Assert.Equal(typeof(HostedServiceControlDesigner).FullName, inspected.DesignerType);
            Assert.Equal(64, inspected.AssemblySha256.Length);
            Assert.True(inspected.CompleteHostAdvertised);
            Assert.True(inspected.IncompleteHostWithheld);
            Assert.Contains(nameof(DesignerServiceKernelCapability.Selection), inspected.IncompleteHostReason);
            Assert.True(inspected.UnsupportedServiceRefused);
            Assert.Contains(typeof(IDesignerSerializationService).FullName!, inspected.UnsupportedServiceReason);
            Assert.Equal(DesignerServiceKernel.ImplementedCapabilities.Count, inspected.Capabilities.Count);
            Assert.Empty(inspected.Edits);

            Assert.True(invoked.Ok, invoked.Reason);
            Assert.Equal("applied", invoked.Status);
            Assert.True(invoked.ActionInvoked);
            Assert.Equal(HostedServiceKernelProductBroker.CommandId, invoked.ActionId);
            Assert.Equal(1, invoked.TransactionsOpened);
            Assert.Equal(1, invoked.TransactionsCommitted);
            Assert.Equal(0, invoked.TransactionsCancelled);
            Assert.Equal(4, invoked.ChangeEvents);
            Assert.Collection(invoked.Edits,
                edit =>
                {
                    Assert.Equal(nameof(Control.Text), edit.PropertyName);
                    Assert.Equal(typeof(string).FullName, edit.PropertyType);
                    Assert.Equal("Hosted service preset", edit.InvariantValue);
                },
                edit =>
                {
                    Assert.Equal(nameof(Control.Size), edit.PropertyName);
                    Assert.Equal(typeof(System.Drawing.Size).FullName, edit.PropertyType);
                    Assert.Equal("180, 42", edit.InvariantValue);
                });

            Assert.False(reentrant.Ok);
            Assert.Equal("cancelled", reentrant.Status);
            Assert.Equal("REENTRANT_CANCELLED", reentrant.ErrorCode);
            Assert.Equal(HostedServiceKernelProductBroker.ReentrantCommandId, reentrant.ActionId);
            Assert.True(reentrant.ActionInvoked);
            Assert.Equal(1, reentrant.TransactionsOpened);
            Assert.Equal(0, reentrant.TransactionsCommitted);
            Assert.Equal(1, reentrant.TransactionsCancelled);
            Assert.Equal(4, reentrant.ChangeEvents);
            Assert.Empty(reentrant.Edits);
            Assert.Contains("Nested designer transactions", reentrant.Reason);
        });
    }

    [Fact]
    public void HostedDesigner_InspectsFakeVendorActionListAndEditorPath()
    {
        RunOnSta(() =>
        {
            using var session = DesignerServiceKernel.CreateFormSession();
            var button = Assert.IsType<FancyButton>(
                session.CreateComponent(typeof(FancyButton), "fancyButton1"));
            var edit = Assert.IsType<VendorEdit>(
                session.CreateComponent(typeof(VendorEdit), "vendorEdit1"));

            var buttonDesigner = session.InspectDesigner(button);
            var editDesigner = session.InspectDesigner(edit, new[] { nameof(VendorEdit.Properties), nameof(VendorEditProperties.Caption) });

            Assert.True(buttonDesigner.Ok, buttonDesigner.Reason);
            Assert.Equal(typeof(FancyButtonDesigner).FullName, buttonDesigner.DesignerType);
            Assert.Contains(typeof(FancyButtonActionList).FullName, buttonDesigner.ActionListTypes);
            Assert.Contains("Caption", buttonDesigner.ActionItems);

            Assert.True(editDesigner.Ok, editDesigner.Reason);
            Assert.Equal(typeof(VendorCaptionEditor).FullName, editDesigner.EditorType);
        });
    }

    [Fact(DisplayName = "V2-FND-001-S091 service reentrancy is cancelled without partial mutation")]
    [Trait("V2Scenario", "V2-FND-001-S091")]
    public void HostedDesigner_FailsClosedForCancellationReentrancyCrashAndInvalidReturn()
    {
        RunOnSta(() =>
        {
            using var cancelled = DesignerServiceKernel.CreateFormSession();
            var cancelledButton = Assert.IsType<Button>(cancelled.CreateComponent(typeof(Button), "button1"));
            using var cts = new CancellationTokenSource();
            cts.Cancel();

            var cancellation = cancelled.InspectDesigner(cancelledButton, cancellationToken: cts.Token);

            Assert.False(cancellation.Ok);
            Assert.Equal("request_cancelled", cancellation.ErrorCode);

            using var reentrant = DesignerServiceKernel.CreateContractTestFormSession(
                designerCreator: (component, designerBaseType) =>
                    component.Site!.GetService(typeof(IDesignerHost)) is IDesignerHost host
                        ? host.GetDesigner(component)
                        : null);
            var reentrantButton = reentrant.CreateComponent(typeof(Button), "button1");

            var reentrantResult = reentrant.InspectDesigner(reentrantButton);

            Assert.False(reentrantResult.Ok);
            Assert.Equal("designer_unavailable", reentrantResult.ErrorCode);
            Assert.Contains("Reentrant designer creation", reentrantResult.Reason);

            using var crashing = DesignerServiceKernel.CreateContractTestFormSession(
                designerCreator: (_, _) => throw new InvalidOperationException("boom"));
            var crashButton = crashing.CreateComponent(typeof(Button), "button1");

            var crash = crashing.InspectDesigner(crashButton);

            Assert.False(crash.Ok);
            Assert.Equal("designer_worker_fault", crash.ErrorCode);
            Assert.Contains("DESIGNER_WORKER_FAULT", crash.Reason);
            Assert.True(crash.QuarantineRecommended);

            using var invalid = DesignerServiceKernel.CreateContractTestFormSession(
                designerCreator: (_, _) => new object());
            var invalidButton = invalid.CreateComponent(typeof(Button), "button1");

            var invalidReturn = invalid.InspectDesigner(invalidButton);

            Assert.False(invalidReturn.Ok);
            Assert.Equal("designer_unavailable", invalidReturn.ErrorCode);
            Assert.Contains("does not implement IDesigner", invalidReturn.Reason);
        });
    }

    [Fact(DisplayName = "V2-FND-001-S093 ControlDesigner adorner descriptor and hit test stay bounded")]
    [Trait("V2Scenario", "V2-FND-001-S093")]
    public void HostedDesigner_DescribesFakeVendorAdornerAndHitTestWithoutUiCreation()
    {
        RunOnSta(() =>
        {
            using var session = DesignerServiceKernel.CreateFormSession();
            var button = Assert.IsType<FancyButton>(
                session.CreateComponent(typeof(FancyButton), "fancyButton1"));
            button.SetBounds(10, 20, 120, 32);

            var describe = session.DescribeDesignerAdorners(button);
            var hit = session.HitTestDesignerAdorner(button, 5, 5);
            var miss = session.HitTestDesignerAdorner(button, 110, 25);

            Assert.True(describe.Ok, describe.Reason);
            Assert.Equal(typeof(FancyButtonDesigner).FullName, describe.DesignerType);
            var adorner = Assert.Single(describe.Adorners);
            Assert.Equal("fakevendor.caption", adorner.Id);
            Assert.Equal("Caption adorner", adorner.DisplayName);
            Assert.True(adorner.HitTestable);
            Assert.Equal(0, adorner.Left);
            Assert.Equal(0, adorner.Top);
            Assert.True(adorner.Width > 0);
            Assert.True(adorner.Height > 0);
            Assert.True(hit.Ok, hit.Reason);
            Assert.True(hit.Hit);
            Assert.Equal("fakevendor.caption", hit.HitAdornerId);
            Assert.True(miss.Ok, miss.Reason);
            Assert.False(miss.Hit);
        });
    }

    [Fact(DisplayName = "V2-FND-001-S094 DesignerActionList property intent commits one kernel transaction")]
    [Trait("V2Scenario", "V2-FND-001-S094")]
    public void HostedDesigner_InvokesFakeVendorActionPropertyThroughOneTransactionAndChangePair()
    {
        RunOnSta(() =>
        {
            using var session = DesignerServiceKernel.CreateFormSession();
            var button = Assert.IsType<FancyButton>(
                session.CreateComponent(typeof(FancyButton), "fancyButton1"));
            button.Text = "Old caption";

            var result = session.InvokeDesignerActionProperty(button, "Caption", "Hosted caption");

            Assert.True(result.Ok, result.Reason);
            Assert.Equal("Caption", result.ActionName);
            Assert.Equal(typeof(FancyButtonDesigner).FullName, result.DesignerType);
            Assert.Equal(nameof(FancyButton.Text), result.TargetProperty);
            Assert.Equal("Old caption", result.OldValue);
            Assert.Equal("Hosted caption", result.NewValue);
            Assert.Equal("Hosted caption", button.Text);
            Assert.Equal(1, result.TransactionsOpened);
            Assert.Equal(1, result.TransactionsCommitted);
            Assert.Equal(0, result.TransactionsCancelled);
            Assert.Equal(2, result.ChangeEvents);
        });
    }

    [Fact(DisplayName = "V2-FND-001-S095 designer crash maps to worker-fault quarantine handoff signal")]
    [Trait("V2Scenario", "V2-FND-001-S095")]
    public void HostedDesigner_CreatorCrashReturnsExplicitWorkerFaultAdapterSignal()
    {
        RunOnSta(() =>
        {
            using var crashing = DesignerServiceKernel.CreateContractTestFormSession(
                designerCreator: (_, _) => throw new InvalidOperationException("boom"));
            var button = crashing.CreateComponent(typeof(Button), "button1");

            var result = crashing.InspectDesigner(button);

            Assert.False(result.Ok);
            Assert.Equal("designer_worker_fault", result.ErrorCode);
            Assert.True(result.QuarantineRecommended);
            Assert.Contains("DESIGNER_WORKER_FAULT", result.Reason);
            Assert.Contains("quarantine", result.Reason);
        });
    }

    [Fact(DisplayName = "V2-FND-001-S096 hosted designer path/write intents are rejected before invocation")]
    [Trait("V2Scenario", "V2-FND-001-S096")]
    public void HostedDesigner_RejectsReturnedWorkspacePathIntentBeforeActionSetter()
    {
        RunOnSta(() =>
        {
            using var session = DesignerServiceKernel.CreateFormSession();
            var control = Assert.IsType<MaliciousWorkspaceIntentControl>(
                session.CreateComponent(typeof(MaliciousWorkspaceIntentControl), "malicious1"));

            var result = session.InvokeDesignerActionProperty(
                control,
                "WorkspacePath",
                "workspace://malicious-output.txt");

            Assert.False(result.Ok);
            Assert.Equal("path_intent_rejected", result.ErrorCode);
            Assert.Contains("workspace writes", result.Reason);
            Assert.False(control.SetterWasInvoked);
            Assert.Equal(0, result.TransactionsOpened);
            Assert.Equal(0, result.TransactionsCommitted);
            Assert.Equal(0, result.ChangeEvents);
        });
    }

    [Fact(DisplayName = "Hosted security review action setter failure restores exact target property")]
    public void HostedDesigner_ActionSetterThenThrowRestoresOldTargetProperty()
    {
        RunOnSta(() =>
        {
            using var session = DesignerServiceKernel.CreateFormSession();
            var control = Assert.IsType<SetterThenThrowControl>(
                session.CreateComponent(typeof(SetterThenThrowControl), "throwing1"));
            control.Text = "Original caption";

            var result = session.InvokeDesignerActionProperty(control, "Caption", "Mutated caption");

            Assert.False(result.Ok);
            Assert.Equal("action_failed", result.ErrorCode);
            Assert.True(result.RestorationAttempted);
            Assert.True(result.Restored);
            Assert.False(result.RecoveryRequired);
            Assert.True(control.SetterWasInvoked);
            Assert.Equal("Original caption", control.Text);
            Assert.Equal(0, result.TransactionsCommitted);
        });
    }

    [Fact(DisplayName = "Hosted security review changed-event failure restores exact target property")]
    public void HostedDesigner_ComponentChangedThrowRestoresOldTargetProperty()
    {
        RunOnSta(() =>
        {
            using var session = DesignerServiceKernel.CreateFormSession();
            var changes = Assert.IsAssignableFrom<IComponentChangeService>(
                session.GetService(typeof(IComponentChangeService)));
            var button = Assert.IsType<FancyButton>(
                session.CreateComponent(typeof(FancyButton), "fancyButton1"));
            button.Text = "Original caption";
            changes.ComponentChanged += (_, _) => throw new InvalidOperationException("observer failed");

            var result = session.InvokeDesignerActionProperty(button, "Caption", "Mutated caption");

            Assert.False(result.Ok);
            Assert.Equal("action_failed", result.ErrorCode);
            Assert.True(result.RestorationAttempted);
            Assert.True(result.Restored);
            Assert.False(result.RecoveryRequired);
            Assert.Equal("Original caption", button.Text);
            Assert.Equal(0, result.TransactionsCommitted);
            Assert.True(result.ChangeEvents >= 1);
        });
    }

    [Fact(DisplayName = "Hosted security review deadline handoff requires outer worker termination")]
    public void HostedDesigner_ExpiredDeadlineReturnsWorkerTerminationHandoffWithoutThreadAbort()
    {
        RunOnSta(() =>
        {
            using var session = DesignerServiceKernel.CreateFormSession();
            var button = Assert.IsType<FancyButton>(
                session.CreateComponent(typeof(FancyButton), "fancyButton1"));
            button.Text = "Original caption";

            var adorner = session.DescribeDesignerAdorners(button, callbackDeadline: TimeSpan.Zero);
            var action = session.InvokeDesignerActionProperty(
                button,
                "Caption",
                "Mutated caption",
                callbackDeadline: TimeSpan.Zero);

            Assert.False(adorner.Ok);
            Assert.Equal("deadline_exceeded", adorner.ErrorCode);
            Assert.True(adorner.DeadlineExceeded);
            Assert.True(adorner.RequiresWorkerTermination);
            Assert.True(adorner.QuarantineRecommended);
            Assert.Contains("outer worker supervisor", adorner.Reason);

            Assert.False(action.Ok);
            Assert.Equal("deadline_exceeded", action.ErrorCode);
            Assert.True(action.DeadlineExceeded);
            Assert.True(action.RequiresWorkerTermination);
            Assert.True(action.QuarantineRecommended);
            Assert.Contains("Thread.Abort", action.Reason);
            Assert.Equal("Original caption", button.Text);
            Assert.Equal(0, action.TransactionsOpened);
        });
    }

    [Fact]
    public void ProductionFactory_RequiresSta_AndEngineApiUsesItsStaDispatcher()
    {
        Exception? mtaFailure = null;
        var mta = new Thread(() =>
        {
            try { using var ignored = DesignerServiceKernel.CreateFormSession(); }
            catch (Exception ex) { mtaFailure = ex; }
        });
        mta.SetApartmentState(ApartmentState.MTA);
        mta.Start();
        mta.Join();

        Assert.NotNull(mtaFailure);
        Assert.Contains("DESIGNER_SERVICE_KERNEL_REQUIRES_STA", mtaFailure!.Message);

        var api = new EngineApi(new StaDispatcher());
        var form = api.ProbeHostedServiceKernel("Form");
        var userControl = api.ProbeHostedServiceKernel("UserControl");
        var unsupported = api.ProbeHostedServiceKernel("Panel");

        Assert.True(form.Ok, form.Reason);
        Assert.Equal("STA", form.ApartmentState);
        Assert.Equal(typeof(Form).FullName, form.RootType);
        Assert.True(form.RootIsSited);
        Assert.True(form.UnsupportedServiceRefused);
        Assert.Contains(nameof(DesignerServiceKernelCapability.Transactions), form.Capabilities);
        Assert.True(userControl.Ok, userControl.Reason);
        Assert.Equal(typeof(UserControl).FullName, userControl.RootType);
        Assert.False(unsupported.Ok);
        Assert.Contains("UNSUPPORTED_HOSTED_ROOT_KIND", unsupported.Reason);
    }

    [Fact]
    public void Dispose_TearsDownComponentsAndRejectsFurtherUse()
    {
        var session = DesignerServiceKernel.CreateContractTestFormSession();
        var host = session.Host;
        var button = Assert.IsType<Button>(host.CreateComponent(typeof(Button), "okButton"));
        var root = Assert.IsType<Form>(host.RootComponent);

        session.Dispose();

        Assert.True(session.IsDisposed);
        Assert.True(button.IsDisposed);
        Assert.True(root.IsDisposed);
        Assert.Throws<ObjectDisposedException>(() => session.GetService(typeof(IDesignerHost)));
    }

    private static void RunOnSta(Action action)
    {
        Exception? failure = null;
        var thread = new Thread(() =>
        {
            try { action(); }
            catch (Exception ex) { failure = ex; }
        });
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        thread.Join();
        if (failure != null) throw failure;
    }

    private sealed class FakeSelectionService : ISelectionService
    {
        public event EventHandler? SelectionChanged { add { } remove { } }
        public event EventHandler? SelectionChanging { add { } remove { } }
        public object? PrimarySelection => null;
        public int SelectionCount => 0;
        public bool GetComponentSelected(object component) => false;
        public System.Collections.ICollection GetSelectedComponents() => Array.Empty<object>();
        public void SetSelectedComponents(System.Collections.ICollection? components) { }
        public void SetSelectedComponents(System.Collections.ICollection? components, SelectionTypes selectionType) { }
    }
}
