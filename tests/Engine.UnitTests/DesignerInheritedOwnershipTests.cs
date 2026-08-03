using System.Collections;
using System.ComponentModel;
using System.Drawing;
using System.Windows.Forms;
using WinFormsDesigner.Engine;

namespace Engine.UnitTests;

public class ModernInheritedBaseForm : Form
{
    protected readonly Button inheritedButton;

    public ModernInheritedBaseForm()
    {
        inheritedButton = new Button
        {
            Name = "inheritedButton",
            Text = "Base",
            Location = new Point(8, 8),
            Size = new Size(90, 28),
        };
        Controls.Add(inheritedButton);
    }
}

public partial class ModernInheritedDerivedForm : ModernInheritedBaseForm { }

public sealed class GenericListMetadataControl : Control
{
    [DesignerSerializationVisibility(DesignerSerializationVisibility.Content)]
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
    public void ResolvedBaseGraph_IsVisibleInheritedReadOnly_WhileCurrentSourceRemainsEditable()
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
            Assert.Contains("base type", inherited.ReadOnlyReason, StringComparison.OrdinalIgnoreCase);

            var current = Assert.Single(layout.Controls, c => c.Id == "currentButton");
            Assert.Equal("currentSource", current.Ownership);
            Assert.True(current.Editable);
            Assert.Null(current.ReadOnlyReason);

            var inheritedInfo = Sta.Invoke(() => DesignerRenderer.DescribeComponent(file, "inheritedButton", assembly));
            Assert.NotNull(inheritedInfo);
            Assert.Equal("inherited", inheritedInfo!.Ownership);
            Assert.False(inheritedInfo.Editable);
            Assert.All(inheritedInfo.Properties, p => Assert.True(p.ReadOnly));
            Assert.Null(inheritedInfo.Properties.Single(p => p.Name == "BackColor").UiTypeEditor);

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
            var allowed = DesignerRenderer.ApplyPropertyEdit(file, "currentButton", "Text", "\"changed\"", source);
            Assert.True(allowed.Safe, allowed.Reason);

            var inheritedDrag = Sta.Invoke(() => DesignerRenderer.BeginGeometryDrag(file, "inheritedButton", assembly));
            Assert.False(inheritedDrag.CanMove);
            Assert.Contains("base type", inheritedDrag.Reason, StringComparison.OrdinalIgnoreCase);
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
