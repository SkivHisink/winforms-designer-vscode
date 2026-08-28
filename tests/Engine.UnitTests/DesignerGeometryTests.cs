using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Windows.Forms;
using WinFormsDesigner.Engine;

namespace Engine.UnitTests;

[Collection("Modern inherited designer STA")]
public sealed class DesignerGeometryTests
{
    private static readonly StaDispatcher Sta = new();

    [Fact]
    public void V2_FND_001_S013_RenderLayout_ReportsStandardButtonTextImageAndFlatStyleMetadata()
    {
        string dir = Path.Combine(Path.GetTempPath(), "wfd-s013-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        try
        {
            string file = Path.Combine(dir, "ButtonImageForm.Designer.cs");
            File.WriteAllText(file, """
                namespace Demo
                {
                    partial class ButtonImageForm : System.Windows.Forms.Form
                    {
                        private System.Windows.Forms.Button button1;

                        private void InitializeComponent()
                        {
                            System.ComponentModel.ComponentResourceManager resources = new System.ComponentModel.ComponentResourceManager(typeof(ButtonImageForm));
                            this.button1 = new System.Windows.Forms.Button();
                            this.button1.FlatStyle = System.Windows.Forms.FlatStyle.Popup;
                            this.button1.Image = ((System.Drawing.Image)(resources.GetObject("button1.Image")));
                            this.button1.Location = new System.Drawing.Point(12, 16);
                            this.button1.Name = "button1";
                            this.button1.Size = new System.Drawing.Size(96, 32);
                            this.button1.Text = "Run";
                            this.Controls.Add(this.button1);
                            this.ClientSize = new System.Drawing.Size(240, 120);
                            this.Name = "ButtonImageForm";
                        }
                    }
                }
                """);
            File.WriteAllText(Path.Combine(dir, "ButtonImageForm.resx"), """
                <?xml version="1.0" encoding="utf-8"?>
                <root>
                  <resheader name="resmimetype"><value>text/microsoft-resx</value></resheader>
                  <resheader name="version"><value>2.0</value></resheader>
                  <resheader name="reader"><value>System.Resources.ResXResourceReader, System.Windows.Forms</value></resheader>
                  <resheader name="writer"><value>System.Resources.ResXResourceWriter, System.Windows.Forms</value></resheader>
                  <data name="button1.Image" type="System.Drawing.Bitmap, System.Drawing.Common" mimetype="application/x-microsoft.net.object.bytearray.base64">
                    <value>iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAAdSURBVDhPY1BIOPCfEsyALkAqHjVg1IBRAwaLAQDB4j8ffOS2lgAAAABJRU5ErkJggg==</value>
                  </data>
                </root>
                """);

            var layout = Sta.Invoke(() => DesignerRenderer.RenderWithLayout(file));

            var button = Assert.Single(layout.Controls, c => c.Id == "button1");
            Assert.Equal("Run", button.Text);
            Assert.True(button.HasImage);
            Assert.Equal("Popup", button.FlatStyle);
        }
        finally
        {
            if (Directory.Exists(dir)) Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public void V2_FND_001_S013_SystemIconToBitmap_IsVisibleInRenderedPixels()
    {
        const string source = """
            namespace Demo;
            partial class Form1 : System.Windows.Forms.Form
            {
                private System.Windows.Forms.Button button1 = null!;
                private void InitializeComponent()
                {
                    this.button1 = new System.Windows.Forms.Button();
                    this.button1.FlatStyle = System.Windows.Forms.FlatStyle.Popup;
                    this.button1.Image = System.Drawing.SystemIcons.Information.ToBitmap();
                    this.button1.ImageAlign = System.Drawing.ContentAlignment.MiddleLeft;
                    this.button1.Location = new System.Drawing.Point(36, 42);
                    this.button1.Size = new System.Drawing.Size(208, 54);
                    this.button1.Text = "Button reference";
                    this.button1.TextImageRelation = System.Windows.Forms.TextImageRelation.ImageBeforeText;
                    this.Controls.Add(this.button1);
                    this.ClientSize = new System.Drawing.Size(360, 180);
                }
            }
            """;
        var withIcon = Sta.Invoke(() => DesignerRenderer.RenderWithLayout("Form1.Designer.cs", sourceText: source));
        var withoutIcon = Sta.Invoke(() => DesignerRenderer.RenderWithLayout(
            "Form1.Designer.cs", sourceText: source.Replace(
                "this.button1.Image = System.Drawing.SystemIcons.Information.ToBitmap();", "")));

        var button = Assert.Single(withIcon.Controls, c => c.Id == "button1");
        Assert.True(button.HasImage);
        Assert.False(withIcon.Png.SequenceEqual(withoutIcon.Png), "the rendered PNG must include the icon pixels");
    }

    [Fact]
    public void V2_FND_001_S014_RenderLayout_ReportsMultilineTextBoxScrollbarsAndBorderStyle()
    {
        const string source = """
            namespace Demo
            {
                partial class Form1 : System.Windows.Forms.Form
                {
                    private System.Windows.Forms.TextBox notesBox;

                    private void InitializeComponent()
                    {
                        this.notesBox = new System.Windows.Forms.TextBox();
                        this.notesBox.BorderStyle = System.Windows.Forms.BorderStyle.FixedSingle;
                        this.notesBox.Location = new System.Drawing.Point(20, 24);
                        this.notesBox.Multiline = true;
                        this.notesBox.Name = "notesBox";
                        this.notesBox.ScrollBars = System.Windows.Forms.ScrollBars.Vertical;
                        this.notesBox.Size = new System.Drawing.Size(180, 90);
                        this.Controls.Add(this.notesBox);
                    }
                }
            }
            """;

        var layout = Sta.Invoke(() => DesignerRenderer.RenderWithLayout("Form1.Designer.cs", sourceText: source));

        var textBox = Assert.Single(layout.Controls, c => c.Id == "notesBox");
        Assert.True(textBox.Multiline);
        Assert.Equal("Vertical", textBox.ScrollBars);
        Assert.Equal("FixedSingle", textBox.BorderStyle);
        Assert.Equal("System.Windows.Forms.TextBox", textBox.Type);
    }

    [Fact]
    public void ProgressBarValue_ChangesFullAndDirtyRegionPixels()
    {
        const string source = """
            namespace Demo
            {
                partial class Form1 : System.Windows.Forms.Form
                {
                    private System.Windows.Forms.ProgressBar progressBar1;

                    private void InitializeComponent()
                    {
                        this.progressBar1 = new System.Windows.Forms.ProgressBar();
                        this.progressBar1.Location = new System.Drawing.Point(20, 24);
                        this.progressBar1.Name = "progressBar1";
                        this.progressBar1.Size = new System.Drawing.Size(180, 24);
                        this.progressBar1.Value = VALUE;
                        this.Controls.Add(this.progressBar1);
                        this.ClientSize = new System.Drawing.Size(240, 100);
                    }
                }
            }
            """;

        var empty = Sta.Invoke(() => DesignerRenderer.RenderWithLayout(
            "Form1.Designer.cs", sourceText: source.Replace("VALUE", "0")));
        var filled = Sta.Invoke(() => DesignerRenderer.RenderWithLayout(
            "Form1.Designer.cs", sourceText: source.Replace("VALUE", "90")));
        var emptyPatch = Sta.Invoke(() => DesignerRenderer.RenderControl(
            "Form1.Designer.cs", "progressBar1", sourceText: source.Replace("VALUE", "0")));
        var filledPatch = Sta.Invoke(() => DesignerRenderer.RenderControl(
            "Form1.Designer.cs", "progressBar1", sourceText: source.Replace("VALUE", "90")));

        Assert.False(empty.Png.SequenceEqual(filled.Png), "Value=90 must not render byte-identically to Value=0");
        Assert.True(emptyPatch.Found);
        Assert.True(filledPatch.Found);
        Assert.False(emptyPatch.Png.SequenceEqual(filledPatch.Png), "dirty-region ProgressBar patches must carry Value");
    }

    [Fact]
    public void V2_FND_001_S015_RenderLayout_SortsOverlappingSameSizeLabelsByWinFormsZOrder()
    {
        const string source = """
            namespace Demo
            {
                partial class Form1 : System.Windows.Forms.Form
                {
                    private System.Windows.Forms.Label bottomLabel;
                    private System.Windows.Forms.Label topLabel;

                    private void InitializeComponent()
                    {
                        this.bottomLabel = new System.Windows.Forms.Label();
                        this.topLabel = new System.Windows.Forms.Label();
                        this.bottomLabel.Location = new System.Drawing.Point(20, 20);
                        this.bottomLabel.Name = "bottomLabel";
                        this.bottomLabel.Size = new System.Drawing.Size(100, 24);
                        this.bottomLabel.Text = "Bottom";
                        this.topLabel.Location = new System.Drawing.Point(20, 20);
                        this.topLabel.Name = "topLabel";
                        this.topLabel.Size = new System.Drawing.Size(100, 24);
                        this.topLabel.Text = "Top";
                        this.Controls.Add(this.bottomLabel);
                        this.Controls.Add(this.topLabel);
                        this.topLabel.BringToFront();
                    }
                }
            }
            """;

        var layout = Sta.Invoke(() => DesignerRenderer.RenderWithLayout("Form1.Designer.cs", sourceText: source));

        var top = Assert.Single(layout.Controls, c => c.Id == "topLabel");
        var bottom = Assert.Single(layout.Controls, c => c.Id == "bottomLabel");
        Assert.True(top.ZOrder < bottom.ZOrder);
        int hitX = Math.Max(top.X, bottom.X) + 1;
        int hitY = Math.Max(top.Y, bottom.Y) + 1;
        Assert.True(hitX < top.X + top.Width && hitX < bottom.X + bottom.Width);
        Assert.True(hitY < top.Y + top.Height && hitY < bottom.Y + bottom.Height);
        Assert.Equal("topLabel", layout.Controls
            .Where(c => c.Id == "topLabel" || c.Id == "bottomLabel")
            .OrderBy(c => c.ZOrder)
            .First(c => hitX >= c.X && hitX < c.X + c.Width && hitY >= c.Y && hitY < c.Y + c.Height).Id);
    }

    [Fact]
    public void V2_FND_001_S016_RenderWithLayout_HandlesThreeHundredStandardControlsWithinFrozenRepoBudget()
    {
        string source = ThreeHundredControlSource();
        var elapsed = Stopwatch.StartNew();

        var layout = Sta.Invoke(() => DesignerRenderer.RenderWithLayout("Form1.Designer.cs", sourceText: source));

        elapsed.Stop();
        Assert.Equal(301, layout.Controls.Count);
        Assert.True(layout.Png.Length > 0);
        Assert.InRange(elapsed.ElapsedMilliseconds, 0, 15000);
    }

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
    public void RenderLayout_ReportsExactNestedClientsSpacingAndMeasuredTextBaselinesWithoutDrift()
    {
        var file = Sample("SampleForm.Designer.cs");
        var source = File.ReadAllText(file)
            .Replace("this.nameLabel.Name = \"nameLabel\";", "this.nameLabel.Margin = new System.Windows.Forms.Padding(9, 8, 7, 6);\r\n            this.nameLabel.Name = \"nameLabel\";")
            .Replace("this.optionsGroup.Name = \"optionsGroup\";", "this.optionsGroup.Name = \"optionsGroup\";\r\n            this.optionsGroup.Padding = new System.Windows.Forms.Padding(11, 12, 13, 14);");

        var first = Sta.Invoke(() => DesignerRenderer.RenderWithLayout(file, sourceText: source));
        var second = Sta.Invoke(() => DesignerRenderer.RenderWithLayout(file, sourceText: source));
        var root = Assert.Single(first.Controls, c => c.Id == "this");
        var group = Assert.Single(first.Controls, c => c.Id == "optionsGroup");
        var option = Assert.Single(first.Controls, c => c.Id == "optionA");
        var label = Assert.Single(first.Controls, c => c.Id == "nameLabel");
        var text = Assert.Single(first.Controls, c => c.Id == "nameTextBox");

        Assert.Equal(first.ClientWidth, root.ClientWidth);
        Assert.Equal(first.ClientHeight, root.ClientHeight);
        Assert.Equal(group.ClientX + 16, option.X);
        Assert.Equal(group.ClientY + 24, option.Y);
        Assert.True(group.ClientX >= group.X && group.ClientY >= group.Y);
        Assert.Equal((9, 8, 7, 6), (label.Margin.Left, label.Margin.Top, label.Margin.Right, label.Margin.Bottom));
        Assert.Equal((11, 12, 13, 14), (group.Padding.Left, group.Padding.Top, group.Padding.Right, group.Padding.Bottom));
        Assert.InRange(label.TextBaseline, label.ClientY, label.ClientY + label.ClientHeight);
        Assert.InRange(text.TextBaseline, text.ClientY, text.ClientY + text.ClientHeight);
        Assert.InRange(Math.Abs(label.TextBaseline - text.TextBaseline), 0, 2);

        foreach (var current in first.Controls)
        {
            var repeated = Assert.Single(second.Controls, c => c.Id == current.Id);
            Assert.Equal(
                (current.X, current.Y, current.Width, current.Height, current.ClientX, current.ClientY, current.ClientWidth, current.ClientHeight, current.TextBaseline),
                (repeated.X, repeated.Y, repeated.Width, repeated.Height, repeated.ClientX, repeated.ClientY, repeated.ClientWidth, repeated.ClientHeight, repeated.TextBaseline));
        }
    }

    [Fact]
    // V2-FND-001-S022 — the engine-authoritative resize changes Size without rewriting Anchor or Location.
    public void V2_FND_001_S022_AnchoredResizeChangesSizeWithoutChangingAnchorAssignment()
    {
        const string source = """
            namespace Demo
            {
                partial class Form1 : System.Windows.Forms.Form
                {
                    private System.Windows.Forms.Button button1;

                    private void InitializeComponent()
                    {
                        this.button1 = new System.Windows.Forms.Button();
                        this.button1.Anchor = ((System.Windows.Forms.AnchorStyles)(((System.Windows.Forms.AnchorStyles.Top | System.Windows.Forms.AnchorStyles.Left)
                            | System.Windows.Forms.AnchorStyles.Right)));
                        this.button1.Location = new System.Drawing.Point(20, 30);
                        this.button1.Name = "button1";
                        this.button1.Size = new System.Drawing.Size(90, 24);
                        this.Controls.Add(this.button1);
                    }
                }
            }
            """;

        var commit = Sta.Invoke(() => DesignerRenderer.CommitGeometryBounds(
            "Form1.Designer.cs", "button1", 20, 30, 140, 24, sourceText: source));

        Assert.True(commit.Ok, commit.Reason);
        Assert.NotNull(commit.DesignerText);
        Assert.Contains("this.button1.Size = new System.Drawing.Size(140, 24);", commit.DesignerText);
        Assert.Contains("this.button1.Anchor = ((System.Windows.Forms.AnchorStyles)(((System.Windows.Forms.AnchorStyles.Top | System.Windows.Forms.AnchorStyles.Left)", commit.DesignerText);
        Assert.DoesNotContain("this.button1.Location = new System.Drawing.Point(20, 30);\r\n            this.button1.Location", commit.DesignerText);
        Assert.DoesNotContain("this.button1.Anchor = System.Windows.Forms.AnchorStyles.None;", commit.DesignerText);
        Assert.Single(commit.SourceValues, v => v.PropertyName == "Size");
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
        Assert.Contains(commit.SourceValues, v => v.PropertyName == "Location"
            && v.PropertyTypeName == "System.Drawing.Point"
            && v.InvariantValue == "151, 205"
            && v.Expression == "new System.Drawing.Point(151, 205)");
        Assert.Contains(commit.SourceValues, v => v.PropertyName == "Size"
            && v.PropertyTypeName == "System.Drawing.Size"
            && v.InvariantValue == "80, 25"
            && v.Expression == "new System.Drawing.Size(80, 25)");
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
    public void DockManagedControl_ResizesOnlyOnItsFreeAxis()
    {
        var file = Sample("AnchorDockForm.Designer.cs");

        var start = Sta.Invoke(() => DesignerRenderer.BeginGeometryDrag(file, "btn2"));
        var bounds = Assert.IsType<GeometryRect>(start.LogicalBounds);
        var commit = Sta.Invoke(() => DesignerRenderer.CommitGeometryBounds(
            file, "btn2", bounds.X - 20, bounds.Y + 20, bounds.Width + 24, bounds.Height + 30));

        Assert.True(start.Ok, start.Reason);
        Assert.False(start.CanMove);
        Assert.True(start.CanResize);
        Assert.True(commit.Ok, commit.Reason);
        Assert.NotNull(commit.DesignerText);
        Assert.Single(commit.SourceValues, value => value.PropertyName == "Size");
        Assert.DoesNotContain(commit.SourceValues, value => value.PropertyName == "Location");
        Assert.Equal(bounds.Height, commit.CorrectedLogicalBounds!.Height);
    }

    [Fact]
    public void AutoSizeControl_CanMoveButCannotResize()
    {
        var file = Sample("SplitterForm.Designer.cs");

        var start = Sta.Invoke(() => DesignerRenderer.BeginGeometryDrag(file, "rightLabel"));
        var layout = Sta.Invoke(() => DesignerRenderer.RenderWithLayout(file));
        var panel1 = Assert.Single(layout.Controls, control => control.Id == "splitContainer1.Panel1");
        var panel2 = Assert.Single(layout.Controls, control => control.Id == "splitContainer1.Panel2");
        var panelDescription = Sta.Invoke(() => DesignerRenderer.DescribeComponent(file, "splitContainer1.Panel2"));
        string source = File.ReadAllText(file);
        var panelEdit = DesignerRenderer.ApplyPropertyEdit(
            file, "splitContainer1.Panel2", "BackColor", "System.Drawing.Color.Red", source);
        var editedPanelDescription = Sta.Invoke(() => DesignerRenderer.DescribeComponent(
            file, "splitContainer1.Panel2", sourceText: panelEdit.NewText));
        var bounds = Assert.IsType<GeometryRect>(start.LogicalBounds);
        var moved = Sta.Invoke(() => DesignerRenderer.CommitGeometryBounds(
            file, "rightLabel", bounds.X + 7, bounds.Y + 5, bounds.Width, bounds.Height));
        var resized = Sta.Invoke(() => DesignerRenderer.CommitGeometryBounds(
            file, "rightLabel", bounds.X, bounds.Y, bounds.Width + 20, bounds.Height));

        Assert.True(start.Ok, start.Reason);
        Assert.True(start.CanMove);
        Assert.False(start.CanResize);
        Assert.Equal("splitContainer1.Panel2", start.ParentId);
        Assert.Equal("splitContainer1", panel1.ParentId);
        Assert.Equal("splitContainer1", panel2.ParentId);
        Assert.Equal("Panel2", panelDescription!.Name);
        Assert.Equal("splitContainer1", panelDescription.Parent);
        Assert.True(panelDescription.Editable);
        Assert.True(panelEdit.Safe, panelEdit.Reason);
        Assert.Contains("this.splitContainer1.Panel2.BackColor = System.Drawing.Color.Red;", panelEdit.NewText);
        Assert.Contains("Red", Assert.Single(editedPanelDescription!.Properties, property => property.Name == "BackColor").Value);
        Assert.Equal("splitContainer1.Panel1", Assert.Single(layout.Controls, control => control.Id == "leftButton").ParentId);
        Assert.Equal("splitContainer1.Panel2", Assert.Single(layout.Controls, control => control.Id == "rightLabel").ParentId);
        Assert.True(moved.Ok, moved.Reason);
        Assert.Single(moved.SourceValues, value => value.PropertyName == "Location");
        Assert.False(resized.Ok);
        Assert.Contains("AutoSize", resized.Reason);
        Assert.Null(resized.DesignerText);
    }

    [Fact]
    public void ManagedCustomControl_UsesLiveSetBoundsAuthorityForMoveAndResize()
    {
        var file = RepoFile("fixtures", "FakeVendor", "FakeVendorForm.Designer.cs");
        var assembly = typeof(FakeVendor.FancyButton).Assembly.Location;

        var start = Sta.Invoke(() => DesignerRenderer.BeginGeometryDrag(file, "fancyButton1", assembly));
        var bounds = Assert.IsType<GeometryRect>(start.LogicalBounds);
        var commit = Sta.Invoke(() => DesignerRenderer.CommitGeometryBounds(
            file, "fancyButton1", bounds.X + 9, bounds.Y + 6, bounds.Width + 15, bounds.Height + 4, assembly));

        Assert.True(start.Ok, start.Reason);
        Assert.True(start.CanMove, start.Reason);
        Assert.True(start.CanResize, start.Reason);
        Assert.Equal("FakeVendor.FancyButton", start.ComponentType);
        Assert.True(commit.Ok, commit.Reason);
        Assert.Contains(commit.SourceValues, value => value.PropertyName == "Location");
        Assert.Contains(commit.SourceValues, value => value.PropertyName == "Size");
        Assert.NotNull(commit.DesignerText);
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

    [Fact]
    public void V2_FND_001_S016_RetainedGraphTextEdit_ReconcilesOneExactLiveSnapshotWithinFrozenBudget()
    {
        string source = ThreeHundredControlSource();
        var initial = Sta.Invoke(() => DesignerRenderer.RenderWithLayout("Form1.Designer.cs", sourceText: source));
        Assert.True(Sta.Invoke(() => DesignerRenderer.RetainedGraphProvesFullCoverage(
            initial.GraphToken, "Form1.Designer.cs", source)));
        Assert.False(Sta.Invoke(() => DesignerRenderer.RetainedGraphProvesFullCoverage(
            initial.GraphToken, "Other.Designer.cs", source)));
        Assert.False(Sta.Invoke(() => DesignerRenderer.RetainedGraphProvesFullCoverage(
            initial.GraphToken, "Form1.Designer.cs", source + " ")));
        var preview = DesignerRenderer.ApplyPropertyEdit(
            "Form1.Designer.cs", "button0", "Text", "\"Cached edit\"", source);
        Assert.True(preview.Safe, preview.Reason);
        string edited = Assert.IsType<string>(preview.NewText);
        var elapsed = Stopwatch.StartNew();

        var cached = Sta.Invoke(() => DesignerRenderer.ApplyCachedTextPropertyEdit(
            initial.GraphToken, "Form1.Designer.cs", "button0", "Text", "\"Cached edit\"", source, edited));

        elapsed.Stop();
        Assert.True(cached.Applied, cached.Reason);
        Assert.False(cached.FullFrame);
        Assert.True(cached.LayoutUnchanged);
        Assert.NotEmpty(cached.GraphToken);
        Assert.NotEmpty(cached.Png);
        Assert.Empty(cached.Controls);
        Assert.Empty(cached.ToolStripItems);
        Assert.Equal(301, initial.Controls.Count); // host retains this exact proven-unchanged hit-test model
        Assert.Equal("Cached edit", Assert.Single(cached.Component!.Properties, property => property.Name == "Text").Value);
        Assert.Equal("button0", cached.Geometry!.ComponentId);
        Assert.True(cached.Geometry.Ok, cached.Geometry.Reason);
        Assert.InRange(elapsed.ElapsedMilliseconds, 0, 500);

        var stale = Sta.Invoke(() => DesignerRenderer.ApplyCachedTextPropertyEdit(
            cached.GraphToken, "Form1.Designer.cs", "button0", "Text", "\"Stale\"", source, edited));
        Assert.False(stale.Applied);
        Assert.Contains("source revision", stale.Reason);

        var refreshed = Sta.Invoke(() => DesignerRenderer.RenderWithLayout("Form1.Designer.cs", sourceText: edited));
        var mismatched = Sta.Invoke(() => DesignerRenderer.ApplyCachedTextPropertyEdit(
            refreshed.GraphToken, "Form1.Designer.cs", "button0", "Text", "\"Next\"", edited, edited + " "));
        Assert.False(mismatched.Applied);
        Assert.Contains("committed bytes", mismatched.Reason);
    }

    [Fact]
    public void V2_FND_001_S122_RetainedGraphTextEdit_PreservesTwoXBackingPatchWithinFrozenBudget()
    {
        string source = ThreeHundredControlSource();
        var initial = Sta.Invoke(() => DesignerRenderer.RenderWithLayout(
            "S122HighDpiForm.Designer.cs", sourceText: source, renderScale: 2));
        Assert.NotEmpty(initial.GraphToken);
        using (var initialStream = new MemoryStream(initial.Png))
        using (var initialImage = System.Drawing.Image.FromStream(initialStream))
        {
            Assert.Equal(initial.Width * 2, initialImage.Width);
            Assert.Equal(initial.Height * 2, initialImage.Height);
        }
        var preview = DesignerRenderer.ApplyPropertyEdit(
            "S122HighDpiForm.Designer.cs", "button0", "Text", "\"High-DPI cached edit\"", source);
        Assert.True(preview.Safe, preview.Reason);
        var elapsed = Stopwatch.StartNew();

        var cached = Sta.Invoke(() => DesignerRenderer.ApplyCachedTextPropertyEdit(
            initial.GraphToken, "S122HighDpiForm.Designer.cs", "button0", "Text", "\"High-DPI cached edit\"",
            source, Assert.IsType<string>(preview.NewText)));

        elapsed.Stop();
        Assert.True(cached.Applied, cached.Reason);
        Assert.False(cached.FullFrame);
        Assert.True(cached.LayoutUnchanged);
        Assert.NotEmpty(cached.Png);
        using (var patchStream = new MemoryStream(cached.Png))
        using (var patchImage = System.Drawing.Image.FromStream(patchStream))
        {
            Assert.Equal(cached.Width * 2, patchImage.Width);
            Assert.Equal(cached.Height * 2, patchImage.Height);
        }
        Assert.Equal("High-DPI cached edit", Assert.Single(cached.Component!.Properties, property => property.Name == "Text").Value);
        Assert.InRange(elapsed.ElapsedMilliseconds, 0, 500);
    }

    [Fact]
    public void V2_FND_001_S016_RetainedTextEditWithAutoSizeGeometryChange_FallsBackToFullFrameAndLayout()
    {
        string source = """
            namespace Demo
            {
                partial class AutoSizeForm : System.Windows.Forms.Form
                {
                    private System.Windows.Forms.Label label1;
                    private void InitializeComponent()
                    {
                        this.label1 = new System.Windows.Forms.Label();
                        this.label1.AutoSize = true;
                        this.label1.Location = new System.Drawing.Point(8, 8);
                        this.label1.Name = "label1";
                        this.label1.Text = "A";
                        this.Controls.Add(this.label1);
                        this.ClientSize = new System.Drawing.Size(400, 200);
                    }
                }
            }
            """.Replace("\n", "\r\n");
        var initial = Sta.Invoke(() => DesignerRenderer.RenderWithLayout("AutoSizeForm.Designer.cs", sourceText: source));
        var preview = DesignerRenderer.ApplyPropertyEdit(
            "AutoSizeForm.Designer.cs", "label1", "Text", "\"A much longer caption\"", source);
        Assert.True(preview.Safe, preview.Reason);

        var cached = Sta.Invoke(() => DesignerRenderer.ApplyCachedTextPropertyEdit(
            initial.GraphToken, "AutoSizeForm.Designer.cs", "label1", "Text", "\"A much longer caption\"",
            source, Assert.IsType<string>(preview.NewText)));

        Assert.True(cached.Applied, cached.Reason);
        Assert.True(cached.FullFrame);
        Assert.False(cached.LayoutUnchanged);
        Assert.NotEmpty(cached.Png);
        Assert.Equal(2, cached.Controls.Count);
        Assert.Equal("A much longer caption", Assert.Single(cached.Component!.Properties, property => property.Name == "Text").Value);
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

    private static string RepoFile(params string[] segments)
    {
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory != null; directory = directory.Parent)
        {
            var path = segments.Aggregate(directory.FullName, Path.Combine);
            if (File.Exists(path)) return path;
        }
        throw new FileNotFoundException("repository file not found: " + Path.Combine(segments));
    }

    private static string ThreeHundredControlSource()
    {
        var fields = new System.Text.StringBuilder();
        var body = new System.Text.StringBuilder();
        for (int i = 0; i < 300; i++)
        {
            string id = i % 3 == 0 ? "button" + i : i % 3 == 1 ? "label" + i : "textBox" + i;
            string type = i % 3 == 0 ? "Button" : i % 3 == 1 ? "Label" : "TextBox";
            int x = 8 + (i % 20) * 38;
            int y = 8 + (i / 20) * 26;
            fields.Append("                    private System.Windows.Forms.").Append(type).Append(' ').Append(id).AppendLine(";");
            body.Append("                        this.").Append(id).Append(" = new System.Windows.Forms.").Append(type).AppendLine("();");
            body.Append("                        this.").Append(id).Append(".Location = new System.Drawing.Point(").Append(x).Append(", ").Append(y).AppendLine(");");
            body.Append("                        this.").Append(id).Append(".Name = \"").Append(id).AppendLine("\";");
            body.Append("                        this.").Append(id).Append(".Size = new System.Drawing.Size(32, 20);").AppendLine();
            if (type != "TextBox")
                body.Append("                        this.").Append(id).Append(".Text = \"").Append(id).AppendLine("\";");
            body.Append("                        this.Controls.Add(this.").Append(id).AppendLine(");");
        }

        return
            "namespace Demo\r\n" +
            "{\r\n" +
            "    partial class Form1 : System.Windows.Forms.Form\r\n" +
            "    {\r\n" +
            fields +
            "        private void InitializeComponent()\r\n" +
            "        {\r\n" +
            body +
            "            this.ClientSize = new System.Drawing.Size(800, 430);\r\n" +
            "            this.Name = \"Form1\";\r\n" +
            "        }\r\n" +
            "    }\r\n" +
            "}\r\n";
    }

    [Fact]
    public void V2_FND_001_S025_RenderLayoutPublishesActualVsButtonAndTextBoxBaselineOffsets()
    {
        const string source = """
            namespace Demo;
            partial class S025BaselineSnapForm : System.Windows.Forms.Form
            {
                private System.Windows.Forms.Button snapButton = null!;
                private System.Windows.Forms.TextBox referenceTextBox = null!;

                private void InitializeComponent()
                {
                    snapButton = new System.Windows.Forms.Button();
                    referenceTextBox = new System.Windows.Forms.TextBox();
                    snapButton.Location = new System.Drawing.Point(32, 80);
                    snapButton.Name = "snapButton";
                    snapButton.Size = new System.Drawing.Size(100, 30);
                    snapButton.Text = "Snap button";
                    snapButton.UseVisualStyleBackColor = true;
                    referenceTextBox.Location = new System.Drawing.Point(180, 40);
                    referenceTextBox.Name = "referenceTextBox";
                    referenceTextBox.Size = new System.Drawing.Size(120, 23);
                    referenceTextBox.Text = "Reference text";
                    Controls.Add(referenceTextBox);
                    Controls.Add(snapButton);
                    ClientSize = new System.Drawing.Size(360, 180);
                }
            }
            """;

        var layout = Sta.Invoke(() => DesignerRenderer.RenderWithLayout(
            "S025BaselineSnapForm.Designer.cs", sourceText: source));
        var button = Assert.Single(layout.Controls, control => control.Id == "snapButton");
        var textBox = Assert.Single(layout.Controls, control => control.Id == "referenceTextBox");

        Assert.Equal(21, button.TextBaseline - button.Y);
        Assert.Equal(16, textBox.TextBaseline - textBox.Y);
        Assert.Equal(button.Y - 80, textBox.Y - 40);
        Assert.Equal(button.TextBaseline - 101, textBox.TextBaseline - 56);
    }
}
