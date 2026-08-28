using FakeVendor;
using System.ComponentModel.Design;
using System.Windows.Forms.Design;
using WinFormsDesigner.Engine;

namespace Engine.UnitTests;

public sealed class DesignerActionListProductTests
{
    [Fact]
    public void DesignSurface_CreatesFakeVendorDesignerForHostedComponent()
    {
        RunSta(() =>
        {
            using var surface = new DesignSurface();
            surface.BeginLoad(typeof(Form));
            var host = Assert.IsAssignableFrom<IDesignerHost>(surface.GetService(typeof(IDesignerHost)));
            var button = Assert.IsType<FancyButton>(host.CreateComponent(typeof(FancyButton), "fancyButton1"));

            var designer = Assert.IsType<FancyButtonDesigner>(host.GetDesigner(button));
            Assert.Single(designer.ActionLists);
            Assert.Single(HostedDesignerAdornerContract.Read(designer));
            return true;
        });
    }

    [Fact]
    public void ProductDescribe_UsesLiveDesignerActionListAndMapsToSourceProperty()
    {
        string designerFile = RepoFile("fixtures", "FakeVendor", "FakeVendorForm.Designer.cs");
        string assembly = typeof(FancyButton).Assembly.Location;

        ComponentInfo? component = RunSta(() =>
            DesignerRenderer.DescribeComponent(designerFile, "fancyButton1", assembly));

        Assert.NotNull(component);
        DesignerActionInfo action = Assert.Single(component!.DesignerActions);
        Assert.Equal("Caption", action.DisplayName);
        Assert.Equal(nameof(FancyButton.Text), action.PropertyName);
        Assert.Equal("FakeVendor", action.Category);
        Assert.Contains("hosted action-list path", action.Description);
        Assert.False(component.Properties.Single(property => property.Name == action.PropertyName).ReadOnly);
        Assert.DoesNotContain(component.DesignerActions, item => item.PropertyName == nameof(FancyButton.Enabled));
    }

    [Fact(DisplayName = "V2-FND-001-S089-S092 product graph publishes only the exact certified hosted-service commands")]
    [Trait("V2Scenario", "V2-FND-001-S089")]
    [Trait("V2Scenario", "V2-FND-001-S090")]
    [Trait("V2Scenario", "V2-FND-001-S091")]
    [Trait("V2Scenario", "V2-FND-001-S092")]
    public void ProductDescribe_PublishesCertifiedHostedServiceCommand()
    {
        string designerFile = RepoFile("fixtures", "FakeVendor", "HostedServiceKernelForm.Designer.cs");
        string assembly = typeof(HostedServiceControl).Assembly.Location;

        ComponentInfo? component = RunSta(() =>
            DesignerRenderer.DescribeComponent(designerFile, "hostedServiceControl1", assembly));

        Assert.NotNull(component);
        Assert.Collection(component!.DesignerActions,
            action =>
            {
                Assert.Equal("Apply Service Preset", action.DisplayName);
                Assert.Equal("", action.PropertyName);
                Assert.Equal(HostedServiceKernelProductBroker.CommandId, action.CommandId);
                Assert.Equal(HostedServiceKernelProductBroker.CertificationId, action.CertificationId);
                Assert.Equal("FakeVendor", action.Category);
                Assert.Contains("one hosted DesignerTransaction", action.Description);
            },
            action =>
            {
                Assert.Equal("Cancel Reentrant Service Action", action.DisplayName);
                Assert.Equal("", action.PropertyName);
                Assert.Equal(HostedServiceKernelProductBroker.ReentrantCommandId, action.CommandId);
                Assert.Equal(HostedServiceKernelProductBroker.CertificationId, action.CertificationId);
                Assert.Equal("FakeVendor", action.Category);
                Assert.Contains("nested hosted transaction", action.Description);
            });
    }

    [Fact(DisplayName = "V2-FND-001-S093 product graph publishes and confirms the FakeVendor ControlDesigner adorner")]
    [Trait("V2Scenario", "V2-FND-001-S093")]
    public void ProductGraph_PublishesAndHitTestsHostedDesignerAdornerWithoutMutation()
    {
        string designerFile = RepoFile("fixtures", "FakeVendor", "FakeVendorForm.Designer.cs");
        string assembly = typeof(FancyButton).Assembly.Location;
        byte[] before = File.ReadAllBytes(designerFile);

        var proof = RunSta(() =>
        {
            ComponentInfo? component = DesignerRenderer.DescribeComponent(
                designerFile, "fancyButton1", assembly);
            DesignerAdornerHitInfo hit = DesignerRenderer.HitTestDesignerAdorner(
                designerFile, "fancyButton1", "fakevendor.caption", 5, 5, assembly);
            DesignerAdornerHitInfo miss = DesignerRenderer.HitTestDesignerAdorner(
                designerFile, "fancyButton1", "fakevendor.caption", 110, 25, assembly);
            return (component, hit, miss);
        });

        Assert.NotNull(proof.component);
        DesignerAdornerInfo adorner = Assert.Single(proof.component!.DesignerAdorners);
        Assert.Equal("fakevendor.caption", adorner.Id);
        Assert.Equal("Caption adorner", adorner.DisplayName);
        Assert.Equal((0, 0, 96, 18, true),
            (adorner.Left, adorner.Top, adorner.Width, adorner.Height, adorner.HitTestable));

        Assert.True(proof.hit.Ok);
        Assert.True(proof.hit.Hit);
        Assert.Equal("fancyButton1", proof.hit.ComponentId);
        Assert.Equal("FakeVendor.FancyButton", proof.hit.ComponentType);
        Assert.Equal("FakeVendor.FancyButtonDesigner", proof.hit.DesignerType);
        Assert.True(proof.miss.Ok);
        Assert.False(proof.miss.Hit);
        Assert.Equal(before, File.ReadAllBytes(designerFile));
    }

    [Fact(DisplayName = "V2-FND-001-S047 collectible product graph publishes certified vendor editor metadata")]
    [Trait("V2Scenario", "V2-FND-001-S047")]
    public void ProductGraph_PublishesCertifiedVendorEditorFromCollectibleAssemblyContext()
    {
        string designerFile = RepoFile("fixtures", "FakeVendor", "VendorEditorForm.Designer.cs");
        string assembly = typeof(VendorEdit).Assembly.Location;

        ComponentInfo? component = RunSta(() =>
            DesignerRenderer.DescribeComponent(designerFile, "vendorEdit1", assembly));

        Assert.NotNull(component);
        WinFormsDesigner.Engine.PropertyInfo property = Assert.Single(
            component!.Properties, candidate => candidate.Name == nameof(VendorEdit.ComplexValue));
        Assert.False(property.ReadOnly);
        Assert.Equal("FakeVendor.VendorComplexValueEditor", property.UiTypeEditor);
        Assert.Equal(assembly, property.UiTypeEditorAssemblyPath);
        Assert.Matches("^[0-9A-Fa-f]{64}$", property.UiTypeEditorAssemblySha256);
        Assert.Equal("repo.fakevendor.complex-value.v1", property.UiTypeEditorCertificationId);
    }

    private static string RepoFile(params string[] parts)
    {
        for (DirectoryInfo? directory = new DirectoryInfo(AppContext.BaseDirectory);
            directory != null; directory = directory.Parent)
        {
            string path = parts.Aggregate(directory.FullName, Path.Combine);
            if (File.Exists(path)) return path;
        }
        throw new FileNotFoundException("Repository file not found: " + Path.Combine(parts));
    }

    private static T RunSta<T>(Func<T> action)
    {
        T? result = default;
        Exception? failure = null;
        var thread = new Thread(() =>
        {
            try { result = action(); }
            catch (Exception ex) { failure = ex; }
        });
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        thread.Join();
        if (failure != null) throw failure;
        return result!;
    }
}
