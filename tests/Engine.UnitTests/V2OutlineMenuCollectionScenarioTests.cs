using WinFormsDesigner.Engine;

namespace Engine.UnitTests;

[Collection("Modern inherited designer STA")]
public sealed class V2OutlineMenuCollectionScenarioTests
{
    private static readonly StaDispatcher Sta = new();

    [Fact]
    public void V2_FND_001_S061_OutlineRename_IsAtomicAndOnlyRenamesSelectedComponent()
    {
        const string source = """
            namespace Demo
            {
                partial class Form1 : System.Windows.Forms.Form
                {
                    private System.Windows.Forms.Button button1;
                    private System.Windows.Forms.TextBox textBox1;

                    private void InitializeComponent()
                    {
                        this.button1 = new System.Windows.Forms.Button();
                        this.textBox1 = new System.Windows.Forms.TextBox();
                        this.button1.Name = "button1";
                        this.button1.Text = "button1";
                        this.textBox1.Name = "textBox1";
                        this.Controls.Add(this.button1);
                        this.Controls.Add(this.textBox1);
                    }
                }
            }
            """;

        var result = DesignerComponentRename.Rename(source, "button1", "submitButton");

        Assert.True(result.Safe, result.Reason);
        Assert.Contains("private System.Windows.Forms.Button submitButton;", result.NewText);
        Assert.Contains("this.submitButton.Name = \"submitButton\";", result.NewText);
        Assert.Contains("this.submitButton.Text = \"button1\";", result.NewText);
        Assert.Contains("this.Controls.Add(this.submitButton);", result.NewText);
        Assert.Contains("this.textBox1.Name = \"textBox1\";", result.NewText);
        Assert.True(DesignerComponentRename.OnlyComponentRenamed(source, result.NewText!, "button1", "submitButton"));
    }

    [Fact]
    public void V2_FND_001_S062_ComponentTrayTimer_IsDescribedAsSelectableComponentWithoutMutation()
    {
        const string source = """
            namespace Demo
            {
                partial class Form1 : System.Windows.Forms.Form
                {
                    private System.ComponentModel.IContainer components = null;
                    private System.Windows.Forms.Timer timer1;

                    private void InitializeComponent()
                    {
                        this.components = new System.ComponentModel.Container();
                        this.timer1 = new System.Windows.Forms.Timer(this.components);
                        this.timer1.Enabled = false;
                        this.timer1.Interval = 250;
                        this.timer1.Tick += new System.EventHandler(this.timer1_Tick);
                    }
                }
            }
            """;

        var layout = Sta.Invoke(() => DesignerRenderer.DescribeLayout("Form1.Designer.cs", sourceText: source));

        var tray = Assert.Single(layout.Tray, component => component.Id == "timer1");
        Assert.Equal("timer1", tray.Name);
        Assert.Contains("Timer", tray.Type);
        Assert.False(tray.IsStrip);
        Assert.DoesNotContain(layout.Controls, control => control.Id == "timer1");
    }

    [Fact]
    public void V2_FND_001_S063_OutlineDrag_ReparentsLeafBetweenContainersWithBoundedSourceDiff()
    {
        string source = ReparentSource();

        var result = DesignerControlEditor.Reparent(source, "button1", "groupBox1", 18, 22);

        Assert.True(result.Safe, result.Reason);
        Assert.Contains("this.groupBox1.Controls.Add(this.button1);", result.NewText);
        Assert.DoesNotContain("this.panel1.Controls.Add(this.button1);", result.NewText);
        Assert.Contains("this.button1.Location = new System.Drawing.Point(18, 22);", result.NewText);
        Assert.True(DesignerControlEditor.OnlyReparented(source, result.NewText!, "button1", "groupBox1", 18, 22));
    }

    [Fact]
    public void V2_FND_001_S064_OutlineDragToDescendant_RefusesContainmentCycleBeforeMutation()
    {
        string source = ReparentSource();

        var result = DesignerControlEditor.Reparent(source, "panel1", "button1", 0, 0);

        Assert.False(result.Safe);
        Assert.Equal("CONTAINMENT_CYCLE", result.Reason);
        Assert.Null(result.NewText);
    }

    [Fact]
    public void V2_FND_001_S065_InsertStandardItems_AddsMenuStripItemsInReferenceOrder()
    {
        const string source = """
            namespace Demo
            {
                partial class Form1
                {
                    private System.Windows.Forms.MenuStrip menuStrip1;

                    private void InitializeComponent()
                    {
                        this.menuStrip1 = new System.Windows.Forms.MenuStrip();
                        this.menuStrip1.Name = "menuStrip1";
                        this.Controls.Add(this.menuStrip1);
                    }
                }
            }
            """;

        var result = DesignerToolStripItemEditor.SetItems(source, "menuStrip1", new[]
        {
            NewMenuItem("File"),
            NewMenuItem("Edit"),
            NewMenuItem("Tools"),
            NewMenuItem("Help"),
        });

        Assert.Equal(EditMode.Replace, result.Mode);
        Assert.True(DesignerToolStripItemEditor.OnlyItemsChanged(source, result.NewText));
        Assert.Contains(
            "this.menuStrip1.Items.AddRange(new System.Windows.Forms.ToolStripItem[] { this.toolStripMenuItem1, this.toolStripMenuItem2, this.toolStripMenuItem3, this.toolStripMenuItem4 });",
            result.NewText);
        AssertOrder(result.NewText, ".Text = \"File\";", ".Text = \"Edit\";", ".Text = \"Tools\";", ".Text = \"Help\";");
    }

    [Fact]
    public void V2_FND_001_S066_TopLevelToolStripDrag_ReordersDeterministically()
    {
        string source = ToolStripSource();
        var current = DesignerToolStripItemEditor.ListItems(source, "toolStrip1");
        Assert.True(current.Ok, current.Reason);

        var open = current.Items.Single(item => item.Id == "openButton");
        var desired = new[] { open }
            .Concat(current.Items.Where(item => item.Id != "openButton"))
            .ToArray();

        var result = DesignerToolStripItemEditor.SetItems(source, "toolStrip1", desired);

        Assert.Equal(EditMode.Replace, result.Mode);
        Assert.True(DesignerToolStripItemEditor.OnlyItemsChanged(source, result.NewText));
        AssertOrder(result.NewText, "this.openButton,", "this.newButton,", "this.saveButton}");
        Assert.Contains("this.saveButton.Text = \"Save\";", result.NewText);
    }

    [Fact]
    public void V2_FND_001_S067_MenuItemCanMoveFromTopLevelIntoDropdown()
    {
        string source = MenuWithHelpSource();
        var current = DesignerToolStripItemEditor.ListItems(source, "menuStrip1");
        Assert.True(current.Ok, current.Reason);
        var file = current.Items.Single(item => item.Id == "fileMenu");
        var tools = current.Items.Single(item => item.Id == "toolsMenu");
        var help = current.Items.Single(item => item.Id == "helpMenu");
        tools.Children.Add(help);

        var result = DesignerToolStripItemEditor.SetItems(source, "menuStrip1", new[] { file, tools });

        Assert.Equal(EditMode.Replace, result.Mode);
        Assert.True(DesignerToolStripItemEditor.OnlyItemsChanged(source, result.NewText));
        Assert.Contains("this.toolsMenu.DropDownItems.AddRange(new System.Windows.Forms.ToolStripItem[] { this.helpMenu });", result.NewText);
        AssertOrder(result.NewText, "this.menuStrip1.Items.AddRange", "this.fileMenu,", "this.toolsMenu}");
    }

    [Fact]
    public void V2_FND_001_S068_MenuItemDropOntoNonDropdownItem_IsRefusedWithoutMutation()
    {
        string source = ToolStripSource();
        var desired = new[]
        {
            new ToolStripItemModel
            {
                Id = "newButton",
                Text = "New",
                ItemType = "ToolStripButton",
                Children = [new ToolStripItemModel { Id = "openButton", Text = "Open", ItemType = "ToolStripButton" }],
            },
            new ToolStripItemModel { Id = "saveButton", Text = "Save", ItemType = "ToolStripButton" },
        };

        var result = DesignerToolStripItemEditor.SetItems(source, "toolStrip1", desired);

        Assert.Equal(EditMode.Failed, result.Mode);
        Assert.Contains("has no DropDownItems collection", result.Reason);
        Assert.Equal("", result.NewText);
    }

    [Fact]
    public void V2_FND_001_S069_CollectionEditorAddsListViewColumnWithBoundedPatch()
    {
        const string source = """
            namespace Demo
            {
                partial class Form1
                {
                    private System.Windows.Forms.ListView listView1;

                    private void InitializeComponent()
                    {
                        this.listView1 = new System.Windows.Forms.ListView();
                        this.listView1.Name = "listView1";
                        this.Controls.Add(this.listView1);
                    }
                }
            }
            """;

        var result = DesignerListColumnEditor.SetColumns(source, "listView1", new[]
        {
            new ColumnItem { Text = "Name", Width = 180, TextAlign = "Left" },
        });

        Assert.Equal(EditMode.Replace, result.Mode);
        Assert.True(DesignerListColumnEditor.OnlyColumnsChanged(source, result.NewText, "listView1"));
        Assert.Contains("private System.Windows.Forms.ColumnHeader columnHeader1;", result.NewText);
        Assert.Contains("this.listView1.Columns.AddRange", result.NewText);
        Assert.Contains("this.columnHeader1.Text = \"Name\";", result.NewText);
        Assert.Contains("this.columnHeader1.Width = 180;", result.NewText);
    }

    [Fact]
    public void V2_FND_001_S070_CollectionEditorReordersTabPagesBySourceOrder()
    {
        string source = TabSource();

        var listed = DesignerControlEditor.ListTabPages(source, "tabs");
        Assert.True(listed.Ok, listed.Reason);
        Assert.Equal(new[] { "pageA", "pageB", "pageC" }, listed.Pages);

        var reordered = DesignerControlEditor.SetTabPageOrder(source, "tabs", new[] { "pageC", "pageA", "pageB" });

        Assert.True(reordered.Safe, reordered.Reason);
        AssertOrder(reordered.NewText!, "this.pageC,", "this.pageA,", "this.pageB}");
        Assert.True(DesignerControlEditor.OnlyTabPageOrderChanged(
            source, reordered.NewText!, "tabs", new[] { "pageC", "pageA", "pageB" }));
    }

    [Fact]
    public void V2_FND_001_S071_VendorCollectionPatch_IsInspectableAndBoundedToDeclaredComponent()
    {
        string source = VendorOwnedRegionSource();
        string proposed = source.Replace(
            "this.vendorEdit1.Properties.Caption = \"One\";",
            "this.vendorEdit1.Properties.Caption = \"Two\";");

        var result = DesignerOwnedRegionSerializer.PlanBoundedComponentPatch(new DesignerOwnedRegionPatchRequest
        {
            SourceText = source,
            ExpectedSourceSha256 = DesignerOwnedRegionSerializer.Sha256Hex(source),
            ProposedSourceText = proposed,
            ComponentName = "vendorEdit1",
            PatchLabel = "FakeVendor.Columns",
        });

        Assert.True(result.Safe, result.Reason);
        Assert.True(result.OutsideRegionPreserved);
        Assert.True(result.SemanticEquivalence);
        Assert.Equal(proposed, result.PlannedSourceText);
        Assert.Contains("this.vendorEdit1.Properties.Caption = \"Two\";", result.ReplacementText);
        Assert.Contains("bounded component patch", result.NormalizationPreview);
    }

    [Fact]
    public void V2_FND_001_S072_VendorCollectionPatchChangingOutsideOwnedRegion_IsRefused()
    {
        string source = VendorOwnedRegionSource();
        string proposed = source
            .Replace("this.vendorEdit1.Properties.Caption = \"One\";", "this.vendorEdit1.Properties.Caption = \"Two\";")
            .Replace("this.Text = \"Original\";", "this.Text = \"Tampered\";");

        var result = DesignerOwnedRegionSerializer.PlanBoundedComponentPatch(new DesignerOwnedRegionPatchRequest
        {
            SourceText = source,
            ExpectedSourceSha256 = DesignerOwnedRegionSerializer.Sha256Hex(source),
            ProposedSourceText = proposed,
            ComponentName = "vendorEdit1",
            PatchLabel = "FakeVendor.Columns",
        });

        Assert.False(result.Safe);
        Assert.Contains("owned-region violation", result.Reason);
        Assert.Equal("", result.PlannedSourceText);
    }

    private static ToolStripItemModel NewMenuItem(string text) =>
        new() { Text = text, ItemType = "ToolStripMenuItem" };

    private static void AssertOrder(string text, params string[] fragments)
    {
        var previous = -1;
        foreach (var fragment in fragments)
        {
            var next = text.IndexOf(fragment, StringComparison.Ordinal);
            Assert.True(next > previous, $"Expected '{fragment}' after offset {previous}.\n{text}");
            previous = next;
        }
    }

    private static string ReparentSource() => """
        namespace Demo
        {
            partial class Form1
            {
                private System.Windows.Forms.Panel panel1;
                private System.Windows.Forms.GroupBox groupBox1;
                private System.Windows.Forms.Button button1;

                private void InitializeComponent()
                {
                    this.panel1 = new System.Windows.Forms.Panel();
                    this.groupBox1 = new System.Windows.Forms.GroupBox();
                    this.button1 = new System.Windows.Forms.Button();
                    this.button1.Location = new System.Drawing.Point(3, 4);
                    this.button1.Name = "button1";
                    this.panel1.Controls.Add(this.button1);
                    this.Controls.Add(this.panel1);
                    this.Controls.Add(this.groupBox1);
                }
            }
        }
        """;

    private static string ToolStripSource() => """
        namespace Demo
        {
            partial class Form1
            {
                private System.Windows.Forms.ToolStrip toolStrip1;
                private System.Windows.Forms.ToolStripButton newButton;
                private System.Windows.Forms.ToolStripButton saveButton;
                private System.Windows.Forms.ToolStripButton openButton;

                private void InitializeComponent()
                {
                    this.toolStrip1 = new System.Windows.Forms.ToolStrip();
                    this.newButton = new System.Windows.Forms.ToolStripButton();
                    this.saveButton = new System.Windows.Forms.ToolStripButton();
                    this.openButton = new System.Windows.Forms.ToolStripButton();
                    this.toolStrip1.Items.AddRange(new System.Windows.Forms.ToolStripItem[] {
                    this.newButton,
                    this.saveButton,
                    this.openButton});
                    this.newButton.Text = "New";
                    this.saveButton.Text = "Save";
                    this.openButton.Text = "Open";
                    this.Controls.Add(this.toolStrip1);
                }
            }
        }
        """;

    private static string MenuWithHelpSource() => """
        namespace Demo
        {
            partial class Form1
            {
                private System.Windows.Forms.MenuStrip menuStrip1;
                private System.Windows.Forms.ToolStripMenuItem fileMenu;
                private System.Windows.Forms.ToolStripMenuItem toolsMenu;
                private System.Windows.Forms.ToolStripMenuItem helpMenu;

                private void InitializeComponent()
                {
                    this.menuStrip1 = new System.Windows.Forms.MenuStrip();
                    this.fileMenu = new System.Windows.Forms.ToolStripMenuItem();
                    this.toolsMenu = new System.Windows.Forms.ToolStripMenuItem();
                    this.helpMenu = new System.Windows.Forms.ToolStripMenuItem();
                    this.menuStrip1.Items.AddRange(new System.Windows.Forms.ToolStripItem[] {
                    this.fileMenu,
                    this.toolsMenu,
                    this.helpMenu});
                    this.fileMenu.Text = "File";
                    this.toolsMenu.Text = "Tools";
                    this.helpMenu.Text = "Help";
                    this.Controls.Add(this.menuStrip1);
                }
            }
        }
        """;

    private static string TabSource() => """
        namespace Demo
        {
            partial class Form1
            {
                private System.Windows.Forms.TabControl tabs;
                private System.Windows.Forms.TabPage pageA;
                private System.Windows.Forms.TabPage pageB;
                private System.Windows.Forms.TabPage pageC;

                private void InitializeComponent()
                {
                    this.tabs = new System.Windows.Forms.TabControl();
                    this.pageA = new System.Windows.Forms.TabPage();
                    this.pageB = new System.Windows.Forms.TabPage();
                    this.pageC = new System.Windows.Forms.TabPage();
                    this.tabs.TabPages.AddRange(new System.Windows.Forms.TabPage[] {
                    this.pageA,
                    this.pageB,
                    this.pageC});
                    this.Controls.Add(this.tabs);
                }
            }
        }
        """;

    private static string VendorOwnedRegionSource() => """
        namespace Demo
        {
            partial class Form1
            {
                private FakeVendor.VendorEdit vendorEdit1;

                private void InitializeComponent()
                {
                    this.vendorEdit1 = new FakeVendor.VendorEdit();
                    this.vendorEdit1.Name = "vendorEdit1";
                    this.vendorEdit1.Properties.Caption = "One";
                    this.Controls.Add(this.vendorEdit1);
                    this.Text = "Original";
                }
            }
        }
        """;
}
