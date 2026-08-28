using System.Collections;
using System.ComponentModel;
using System.Drawing;
using System.Windows.Forms;
using WinFormsDesigner.Engine;

namespace Engine.UnitTests;

public class ModernInheritedBaseForm : Form
{
    protected readonly Button inheritedButton;
    protected readonly Button dockedInheritedButton;
    protected readonly FakeVendor.FancyButton inheritedVendorButton;
    private readonly Button privateInheritedButton;
    public readonly LinkLabel publicLinkLabel;
    public readonly Button кнопка;
    public readonly Button @class;

    public ModernInheritedBaseForm()
    {
        inheritedButton = new Button
        {
            Name = "inheritedButton",
            Text = "Base",
            Location = new Point(8, 8),
            Size = new Size(90, 28),
        };
        privateInheritedButton = new Button
        {
            Name = "privateInheritedButton",
            Text = "Private base",
            Location = new Point(8, 44),
            Size = new Size(90, 28),
        };
        dockedInheritedButton = new Button
        {
            Name = "dockedInheritedButton",
            Text = "Docked base",
            Dock = DockStyle.Top,
        };
        inheritedVendorButton = new FakeVendor.FancyButton
        {
            Name = "inheritedVendorButton",
            Text = "Vendor base",
            Location = new Point(8, 80),
            Size = new Size(90, 28),
        };
        publicLinkLabel = new LinkLabel
        {
            Name = "publicLinkLabel",
            Text = "Link",
            Location = new Point(112, 44),
            Size = new Size(90, 28),
        };
        кнопка = new Button
        {
            Name = "кнопка",
            Text = "Unicode",
            Location = new Point(112, 80),
            Size = new Size(90, 28),
        };
        @class = new Button
        {
            Name = "class",
            Text = "Keyword",
            Location = new Point(112, 116),
            Size = new Size(90, 28),
        };
        Controls.Add(inheritedButton);
        Controls.Add(privateInheritedButton);
        Controls.Add(dockedInheritedButton);
        Controls.Add(inheritedVendorButton);
        Controls.Add(publicLinkLabel);
        Controls.Add(кнопка);
        Controls.Add(@class);
    }
}

public partial class ModernInheritedDerivedForm : ModernInheritedBaseForm { }

public sealed class GenericListMetadataControl : Control
{
    [DesignerSerializationVisibility(DesignerSerializationVisibility.Content)]
    [Editor("System.ComponentModel.Design.CollectionEditor, System.Windows.Forms.Design",
        "System.Drawing.Design.UITypeEditor, System.Drawing.Common")]
    public IList<int> Numbers { get; } = new List<int>();

    [DesignerSerializationVisibility(DesignerSerializationVisibility.Content)]
    public IList<object> UnsupportedObjects { get; } = new List<object>();
}

[CollectionDefinition("Modern inherited designer STA", DisableParallelization = true)]
public sealed class ModernInheritedDesignerStaCollection { }

[Collection("Modern inherited designer STA")]
public sealed class DesignerInheritedOwnershipTests
{
    private static readonly StaDispatcher Sta = new();

    [Fact]
    public void ResolvedBaseGraph_ExposesOnlyBoundedAccessibleDerivedOverrides()
    {
        WithDesigner(ResolvedSource, file =>
        {
            string assembly = typeof(ModernInheritedDerivedForm).Assembly.Location;
            var layout = Sta.Invoke(() => DesignerRenderer.DescribeLayout(file, assembly));

            var root = Assert.Single(layout.Controls, c => c.Id == "this");
            Assert.Equal("root", root.Ownership);
            Assert.True(root.Editable);

            var inherited = Assert.Single(layout.Controls, c => c.Name == "inheritedButton");
            Assert.Equal("inherited", inherited.Ownership);
            Assert.False(inherited.Editable);
            Assert.True(inherited.InheritedOverrideEditable);
            Assert.True(inherited.InheritedGeometryOverrideEditable);
            Assert.StartsWith("sha256:", inherited.BaseIdentityToken, StringComparison.Ordinal);
            Assert.Contains("base type", inherited.ReadOnlyReason, StringComparison.OrdinalIgnoreCase);

            var dockedInherited = Assert.Single(layout.Controls, c => c.Name == "dockedInheritedButton");
            Assert.True(dockedInherited.InheritedOverrideEditable);
            Assert.False(dockedInherited.InheritedGeometryOverrideEditable);

            var privateInherited = Assert.Single(layout.Controls, c => c.Name == "privateInheritedButton");
            Assert.Equal("inherited", privateInherited.Ownership);
            Assert.False(privateInherited.Editable);
            Assert.False(privateInherited.InheritedOverrideEditable);
            Assert.False(privateInherited.InheritedGeometryOverrideEditable);
            Assert.Empty(privateInherited.BaseIdentityToken);

            var linkLabel = Assert.Single(layout.Controls, c => c.Name == "publicLinkLabel");
            Assert.Equal("inherited", linkLabel.Ownership);
            Assert.False(linkLabel.Editable);
            Assert.True(linkLabel.InheritedOverrideEditable);
            Assert.StartsWith("sha256:", linkLabel.BaseIdentityToken, StringComparison.Ordinal);

            var vendor = Assert.Single(layout.Controls, c => c.Name == "inheritedVendorButton");
            Assert.Equal("inherited", vendor.Ownership);
            Assert.False(vendor.Editable);
            Assert.True(vendor.InheritedOverrideEditable);
            Assert.True(vendor.InheritedGeometryOverrideEditable);
            Assert.StartsWith("sha256:", vendor.BaseIdentityToken, StringComparison.Ordinal);
            Assert.False(DesignerInheritedOverrideEditor.SupportsInheritedField(
                "inheritedVendorButton", typeof(FakeVendor.FancyButton).FullName!));
            Assert.True(DesignerInheritedOverrideEditor.SupportsInheritedField(
                "inheritedVendorButton", typeof(FakeVendor.FancyButton), typeof(FakeVendor.FancyButton)));

            Assert.False(DesignerInheritedOverrideEditor.SupportsInheritedField("кнопка", "System.Windows.Forms.Button"));
            Assert.False(DesignerInheritedOverrideEditor.SupportsInheritedField("class", "System.Windows.Forms.Button"));
            Assert.DoesNotContain(layout.Controls, c => (c.Id == "кнопка" || c.Name == "кнопка" || c.Id == "class" || c.Name == "class")
                && c.InheritedOverrideEditable);

            var current = Assert.Single(layout.Controls, c => c.Id == "currentButton");
            Assert.Equal("currentSource", current.Ownership);
            Assert.True(current.Editable);
            Assert.Null(current.ReadOnlyReason);

            var inheritedInfo = Sta.Invoke(() => DesignerRenderer.DescribeComponent(file, "inheritedButton", assembly));
            Assert.NotNull(inheritedInfo);
            Assert.Equal("inherited", inheritedInfo!.Ownership);
            Assert.False(inheritedInfo.Editable);
            Assert.True(inheritedInfo.InheritedOverrideEditable);
            Assert.Equal(inherited.BaseIdentityToken, inheritedInfo.BaseIdentityToken);
            Assert.False(inheritedInfo.Properties.Single(p => p.Name == "Text").ReadOnly);
            Assert.True(inheritedInfo.Properties.Single(p => p.Name == "Text").InheritedOverrideEditable);
            Assert.False(inheritedInfo.Properties.Single(p => p.Name == "Location").ReadOnly);
            Assert.True(inheritedInfo.Properties.Single(p => p.Name == "Location").InheritedOverrideEditable);
            Assert.True(inheritedInfo.Properties.Single(p => p.Name == "Location").InheritedOverrideResettable);
            Assert.True(inheritedInfo.Properties.Single(p => p.Name == "BackColor").ReadOnly);
            Assert.Null(inheritedInfo.Properties.Single(p => p.Name == "BackColor").UiTypeEditor);

            var dockedInfo = Sta.Invoke(() => DesignerRenderer.DescribeComponent(file, "dockedInheritedButton", assembly));
            Assert.NotNull(dockedInfo);
            Assert.False(dockedInfo!.Properties.Single(p => p.Name == "Location").InheritedOverrideEditable);
            Assert.True(dockedInfo.Properties.Single(p => p.Name == "Location").InheritedOverrideResettable);
            Assert.True(dockedInfo.Properties.Single(p => p.Name == "Location").ReadOnly);
            Assert.False(dockedInfo.Properties.Single(p => p.Name == "Text").ReadOnly);
            var dockedGridGeometry = Sta.Invoke(() => DesignerRenderer.ApplyInheritedPropertyOverride(
                file, "dockedInheritedButton", "Location", "new System.Drawing.Point(1, 2)",
                dockedInherited.BaseIdentityToken, assembly, File.ReadAllText(file)));
            Assert.False(dockedGridGeometry.Safe);
            Assert.Contains("managed", dockedGridGeometry.Reason, StringComparison.OrdinalIgnoreCase);

            var currentInfo = Sta.Invoke(() => DesignerRenderer.DescribeComponent(file, "currentButton", assembly));
            Assert.NotNull(currentInfo);
            Assert.Equal("currentSource", currentInfo!.Ownership);
            Assert.True(currentInfo.Editable);
            Assert.Equal("System.Drawing.Design.ColorEditor", currentInfo.Properties.Single(p => p.Name == "BackColor").UiTypeEditor);
            Assert.Equal("System.Drawing.Design.FontEditor", currentInfo.Properties.Single(p => p.Name == "Font").UiTypeEditor);

            string source = File.ReadAllText(file);
            var denied = DesignerRenderer.ApplyPropertyEdit(file, "inheritedButton", "Text", "\"changed\"", source);
            Assert.False(denied.Safe);
            Assert.Contains("read-only", denied.Reason);
            var overridden = Sta.Invoke(() => DesignerRenderer.ApplyInheritedPropertyOverride(
                file, "inheritedButton", "Text", "\"changed\"", inherited.BaseIdentityToken, assembly, source));
            Assert.True(overridden.Safe, overridden.Reason);
            Assert.Contains("this.inheritedButton.Text = \"changed\";", overridden.NewText);
            Assert.DoesNotContain("privateInheritedButton.Text = \"changed\"", overridden.NewText);
            var linked = Sta.Invoke(() => DesignerRenderer.ApplyInheritedPropertyOverride(
                file, "publicLinkLabel", "Text", "\"linked\"", linkLabel.BaseIdentityToken, assembly, source));
            Assert.True(linked.Safe, linked.Reason);
            Assert.Contains("this.publicLinkLabel.Text = \"linked\";", linked.NewText);
            var vendorOverride = Sta.Invoke(() => DesignerRenderer.ApplyInheritedPropertyOverride(
                file, "inheritedVendorButton", "Text", "\"vendor derived\"", vendor.BaseIdentityToken, assembly, source));
            Assert.True(vendorOverride.Safe, vendorOverride.Reason);
            Assert.Contains("this.inheritedVendorButton.Text = \"vendor derived\";", vendorOverride.NewText);
            var vendorReset = Sta.Invoke(() => DesignerRenderer.RemoveInheritedPropertyOverride(
                file, "inheritedVendorButton", "Text", vendor.BaseIdentityToken, assembly, vendorOverride.NewText));
            Assert.True(vendorReset.Safe, vendorReset.Reason);
            Assert.Equal(source, vendorReset.NewText);
            var overriddenInfo = Sta.Invoke(() => DesignerRenderer.DescribeComponent(
                file, "inheritedButton", assembly, overridden.NewText));
            Assert.True(overriddenInfo!.Properties.Single(p => p.Name == "Text").SourceExplicit);
            Assert.True(overriddenInfo.Properties.Single(p => p.Name == "Text").InheritedOverrideResettable);
            var removed = Sta.Invoke(() => DesignerRenderer.RemoveInheritedPropertyOverride(
                file, "inheritedButton", "Text", inherited.BaseIdentityToken, assembly, overridden.NewText));
            Assert.True(removed.Safe, removed.Reason);
            Assert.Equal(source, removed.NewText);
            var staleRemove = Sta.Invoke(() => DesignerRenderer.RemoveInheritedPropertyOverride(
                file, "inheritedButton", "Text", "stale", assembly, overridden.NewText));
            Assert.False(staleRemove.Safe);
            var stale = Sta.Invoke(() => DesignerRenderer.ApplyInheritedPropertyOverride(
                file, "inheritedButton", "Text", "\"stale\"", inherited.BaseIdentityToken + "stale", assembly, source));
            Assert.False(stale.Safe);
            Assert.Contains("stale", stale.Reason, StringComparison.OrdinalIgnoreCase);
            var allowed = DesignerRenderer.ApplyPropertyEdit(file, "currentButton", "Text", "\"changed\"", source);
            Assert.True(allowed.Safe, allowed.Reason);

            var inheritedDrag = Sta.Invoke(() => DesignerRenderer.BeginGeometryDrag(file, "inheritedButton", assembly));
            Assert.True(inheritedDrag.CanMove, inheritedDrag.Reason);
            Assert.Equal(inherited.BaseIdentityToken, inheritedDrag.BaseIdentityToken);
            var inheritedMove = Sta.Invoke(() => DesignerRenderer.CommitGeometryBounds(
                file, "inheritedButton", 18, 18, 90, 28, assembly, source, inheritedDrag.BaseIdentityToken));
            Assert.True(inheritedMove.Ok, inheritedMove.Reason);
            Assert.Contains("this.inheritedButton.Location = new System.Drawing.Point(18, 18);", inheritedMove.DesignerText);
            var staleMove = Sta.Invoke(() => DesignerRenderer.CommitGeometryBounds(
                file, "inheritedButton", 20, 20, 90, 28, assembly, source, "stale"));
            Assert.False(staleMove.Ok);
            Assert.Contains("stale", staleMove.Reason, StringComparison.OrdinalIgnoreCase);
            var dockedDrag = Sta.Invoke(() => DesignerRenderer.BeginGeometryDrag(file, "dockedInheritedButton", assembly));
            Assert.False(dockedDrag.CanMove);
            Assert.True(dockedDrag.CanResize);
            Assert.Contains("Dock-managed", dockedDrag.Reason, StringComparison.OrdinalIgnoreCase);
            var currentDrag = Sta.Invoke(() => DesignerRenderer.BeginGeometryDrag(file, "currentButton", assembly));
            Assert.True(currentDrag.Ok, currentDrag.Reason);
            Assert.True(currentDrag.CanMove, currentDrag.Reason);
        });
    }

    [Fact]
    public void UnresolvedBase_FailsClosedButKeepsKnownCurrentSourceOwnership()
    {
        WithDesigner(UnresolvedSource, file =>
        {
            var frame = Sta.Invoke(() => DesignerRenderer.RenderWithLayout(file));
            Assert.True(frame.InheritedBase);
            Assert.Equal("MissingBaseForm", frame.BaseTypeName);
            Assert.DoesNotContain(frame.Controls, c => c.Name == "baseOnlyButton");

            var current = Assert.Single(frame.Controls, c => c.Id == "currentButton");
            Assert.Equal("currentSource", current.Ownership);
            Assert.True(current.Editable);

            var denied = DesignerRenderer.MoveZOrder(file, "baseOnlyButton", true, File.ReadAllText(file));
            Assert.False(denied.Safe);
            Assert.Contains("read-only", denied.Reason);
        });
    }

    [Fact]
    public void Metadata_RoutesOnlySupportedUnambiguousGenericLists()
    {
        WithDesigner(GenericListSource, file =>
        {
            string assembly = typeof(GenericListMetadataControl).Assembly.Location;
            var info = Sta.Invoke(() => DesignerRenderer.DescribeComponent(file, "listControl", assembly));
            Assert.NotNull(info);

            var numbers = info!.Properties.Single(p => p.Name == "Numbers");
            Assert.True(numbers.IsCollection);
            Assert.True(numbers.GenericCollection);
            Assert.False(numbers.ReadOnly);
            Assert.Equal("System.Int32", numbers.CollectionItemType);
            Assert.Null(numbers.Value);
            Assert.Equal("System.ComponentModel.Design.CollectionEditor", numbers.UiTypeEditor);

            var objects = info.Properties.Single(p => p.Name == "UnsupportedObjects");
            Assert.False(objects.IsCollection);
            Assert.False(objects.GenericCollection);
            Assert.True(objects.ReadOnly);
            Assert.Equal("(Collection)", objects.Value);
        });
    }

    private static void WithDesigner(string source, Action<string> test)
    {
        string file = Path.Combine(Path.GetTempPath(), "csharp-winform-extension-" + Guid.NewGuid().ToString("N") + ".Designer.cs");
        File.WriteAllText(file, source);
        try { test(file); }
        finally { try { File.Delete(file); } catch { } }
    }

    private const string ResolvedSource = """
        namespace Engine.UnitTests
        {
            partial class ModernInheritedDerivedForm : ModernInheritedBaseForm
            {
                private System.Windows.Forms.Button currentButton;
                private void InitializeComponent()
                {
                    this.currentButton = new System.Windows.Forms.Button();
                    this.currentButton.Name = "currentButton";
                    this.currentButton.Text = "Current";
                    this.currentButton.Location = new System.Drawing.Point(112, 8);
                    this.currentButton.Size = new System.Drawing.Size(90, 28);
                    this.ClientSize = new System.Drawing.Size(240, 90);
                    this.Controls.Add(this.currentButton);
                }
            }
        }
        """;

    private const string UnresolvedSource = """
        namespace Missing
        {
            partial class MissingDerivedForm : MissingBaseForm
            {
                private System.Windows.Forms.Button currentButton;
                private void InitializeComponent()
                {
                    this.currentButton = new System.Windows.Forms.Button();
                    this.currentButton.Name = "currentButton";
                    this.currentButton.Location = new System.Drawing.Point(8, 8);
                    this.currentButton.Size = new System.Drawing.Size(90, 28);
                    this.ClientSize = new System.Drawing.Size(160, 70);
                    this.Controls.Add(this.currentButton);
                }
            }
        }
        """;

    private const string GenericListSource = """
        namespace Engine.UnitTests
        {
            partial class ModernInheritedDerivedForm : ModernInheritedBaseForm
            {
                private Engine.UnitTests.GenericListMetadataControl listControl;
                private void InitializeComponent()
                {
                    this.listControl = new Engine.UnitTests.GenericListMetadataControl();
                    this.listControl.Name = "listControl";
                    this.listControl.Location = new System.Drawing.Point(8, 44);
                    this.listControl.Size = new System.Drawing.Size(120, 28);
                    this.ClientSize = new System.Drawing.Size(240, 90);
                    this.Controls.Add(this.listControl);
                }
            }
        }
        """;
}
