using System;
using System.ComponentModel;
using System.IO;
using System.Windows.Forms;
using WinFormsDesigner.Engine;

namespace Engine.UnitTests;

public sealed class DesignerGeometryTests
{
    private static readonly StaDispatcher Sta = new();

    [Fact]
    public void BeginGeometryDrag_ReturnsEngineReadBoundsAndAllowsFreeControl()
    {
        var file = Sample("SampleForm.Designer.cs");

        var start = Sta.Invoke(() => DesignerRenderer.BeginGeometryDrag(file, "okButton"));

        Assert.True(start.Ok, start.Reason);
        Assert.True(start.CanMove);
        Assert.True(start.CanResize);
        Assert.Equal("okButton", start.ComponentId);
        Assert.Equal("this", start.ParentId);
        Assert.Equal("None", start.Dock);
        Assert.False(start.AutoSize);
        Assert.Equal(150, start.LogicalBounds!.X);
        Assert.Equal(204, start.LogicalBounds.Y);
        Assert.Equal(85, start.LogicalBounds.Width);
        Assert.Equal(30, start.LogicalBounds.Height);
        Assert.NotNull(start.Margin);
        Assert.NotNull(start.Padding);
        Assert.NotNull(start.ParentPadding);
    }

    [Fact]
    public void CommitGeometryBounds_AppliesSetBoundsAndReturnsCorrectedSourcePreview()
    {
        var file = Sample("SampleForm.Designer.cs");
        var source = File.ReadAllText(file).Replace(
            "this.okButton.Size = new System.Drawing.Size(85, 30);",
            "this.okButton.Size = new System.Drawing.Size(85, 30);\r\n            this.okButton.MinimumSize = new System.Drawing.Size(80, 25);");

        var commit = Sta.Invoke(() => DesignerRenderer.CommitGeometryBounds(
            file,
            "okButton",
            151,
            205,
            10,
            10,
            sourceText: source));

        Assert.True(commit.Ok, commit.Reason);
        Assert.True(commit.Corrected);
        Assert.Equal(151, commit.CorrectedLogicalBounds!.X);
        Assert.Equal(205, commit.CorrectedLogicalBounds.Y);
        Assert.Equal(80, commit.CorrectedLogicalBounds.Width);
        Assert.Equal(25, commit.CorrectedLogicalBounds.Height);
        Assert.NotNull(commit.DesignerText);
        Assert.Contains("this.okButton.Location = new System.Drawing.Point(151, 205);", commit.DesignerText);
        Assert.Contains("this.okButton.Size = new System.Drawing.Size(80, 25);", commit.DesignerText);
        Assert.Contains(commit.SourceValues, v => v.PropertyName == "Location" && v.Expression == "new System.Drawing.Point(151, 205)");
        Assert.Contains(commit.SourceValues, v => v.PropertyName == "Size" && v.Expression == "new System.Drawing.Size(80, 25)");
    }

    [Fact]
    public void CommitGeometryBounds_RefusesTableLayoutPanelManagedChild()
    {
        var file = Sample("TableLayoutForm.Designer.cs");

        var commit = Sta.Invoke(() => DesignerRenderer.CommitGeometryBounds(file, "cellButton", 20, 20, 90, 30));

        Assert.False(commit.Ok);
        Assert.Contains("TableLayoutPanel", commit.Reason);
        Assert.Null(commit.DesignerText);
    }

    [Fact]
    public void CommitGeometryBounds_RefusesFlowLayoutPanelManagedChild()
    {
        var file = Sample("FlowForm.Designer.cs");

        var commit = Sta.Invoke(() => DesignerRenderer.CommitGeometryBounds(file, "btnA", 20, 20, 90, 30));

        Assert.False(commit.Ok);
        Assert.Contains("FlowLayoutPanel", commit.Reason);
        Assert.Null(commit.DesignerText);
    }

    [Fact]
    public void CommitGeometryBounds_RefusesDockManagedControl()
    {
        var file = Sample("AnchorDockForm.Designer.cs");

        var commit = Sta.Invoke(() => DesignerRenderer.CommitGeometryBounds(file, "btn2", 20, 20, 90, 30));

        Assert.False(commit.Ok);
        Assert.Contains("Dock-managed", commit.Reason);
        Assert.Null(commit.DesignerText);
    }

    [Fact]
    public void CommitGeometryBounds_RefusesAutoSizeControl()
    {
        var file = Sample("SplitterForm.Designer.cs");

        var commit = Sta.Invoke(() => DesignerRenderer.CommitGeometryBounds(file, "rightLabel", 20, 20, 90, 30));

        Assert.False(commit.Ok);
        Assert.Contains("AutoSize", commit.Reason);
        Assert.Null(commit.DesignerText);
    }

    [Fact]
    public void CommitGeometryBounds_RefusesUnknownComponent()
    {
        var file = Sample("SampleForm.Designer.cs");

        var commit = Sta.Invoke(() => DesignerRenderer.CommitGeometryBounds(file, "missingButton", 20, 20, 90, 30));

        Assert.False(commit.Ok);
        Assert.Contains("component not found", commit.Reason);
        Assert.Null(commit.DesignerText);
    }

    [Fact]
    public void UnresolvedInheritedBase_RefusesGeometryEvenForCurrentSourceControl()
    {
        using var container = new Container();
        using var root = new Form();
        using var currentButton = new Button { Bounds = new System.Drawing.Rectangle(10, 20, 80, 24) };
        container.Add(root, "DerivedForm");
        container.Add(currentButton, "currentButton");
        root.Controls.Add(currentButton);
        const string source = """
            partial class DerivedForm
            {
                private System.Windows.Forms.Button currentButton;
                private void InitializeComponent() { }
            }
            """;

        var start = DesignerGeometry.Begin(
            container, root, "DerivedForm", "currentButton", source, inheritedBase: true,
            control => GeometryRect.From(control.Bounds));
        var commit = DesignerGeometry.Commit(
            container, root, "DerivedForm", "currentButton",
            new GeometryRect { X = 30, Y = 40, Width = 90, Height = 25 },
            source, inheritedBase: true,
            control => GeometryRect.From(control.Bounds));

        Assert.True(start.Ok);
        Assert.False(start.CanMove);
        Assert.False(start.CanResize);
        Assert.Contains("base graph is not fully addressable", start.Reason);
        Assert.False(commit.Ok);
        Assert.Contains("base graph is not fully addressable", commit.Reason);
        Assert.Null(commit.DesignerText);
    }

    private static string Sample(string name)
    {
        for (var d = new DirectoryInfo(AppContext.BaseDirectory); d != null; d = d.Parent)
        {
            var p = Path.Combine(d.FullName, "engine", "samples", name);
            if (File.Exists(p)) return p;
        }
        throw new FileNotFoundException("sample not found: " + name);
    }
}
