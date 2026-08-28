using System;
using WinFormsDesigner.Engine;
using Xunit;

namespace Engine.UnitTests;

[Collection("Modern inherited designer STA")]
public sealed class DesignerContainerLayoutScenarioTests
{
    [Fact]
    public void V2_FND_001_S023_ReparentButtonFromPanelToGroupBoxUsesConvertedParentCoordinates()
    {
        const string source = """
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
                        this.panel1.Location = new System.Drawing.Point(20, 20);
                        this.panel1.Name = "panel1";
                        this.panel1.Size = new System.Drawing.Size(160, 110);
                        this.groupBox1.Location = new System.Drawing.Point(80, 50);
                        this.groupBox1.Name = "groupBox1";
                        this.groupBox1.Size = new System.Drawing.Size(180, 120);
                        this.button1.Location = new System.Drawing.Point(70, 45);
                        this.button1.Name = "button1";
                        this.button1.Size = new System.Drawing.Size(75, 23);
                        this.panel1.Controls.Add(this.button1);
                        this.Controls.Add(this.groupBox1);
                        this.Controls.Add(this.panel1);
                    }
                }
            }
            """;

        var edit = DesignerControlEditor.Reparent(source, "button1", "groupBox1", locX: 10, locY: 15);

        Assert.True(edit.Safe, edit.Reason);
        Assert.NotNull(edit.NewText);
        Assert.Contains("this.groupBox1.Controls.Add(this.button1);", edit.NewText);
        Assert.DoesNotContain("this.panel1.Controls.Add(this.button1);", edit.NewText);
        Assert.Contains("this.button1.Location = new System.Drawing.Point(10, 15);", edit.NewText);
        Assert.True(DesignerControlEditor.OnlyReparented(source, edit.NewText!, "button1", "groupBox1", 10, 15));
    }

    [Fact]
    public void Reparent_LocalizableShape_ChangesMembershipWithoutRequiringSourceLocation()
    {
        const string source = """
            namespace Demo
            {
                partial class Form1
                {
                    private System.Windows.Forms.Panel panel1;
                    private System.Windows.Forms.Button button1;
                    private void InitializeComponent()
                    {
                        System.ComponentModel.ComponentResourceManager resources = new System.ComponentModel.ComponentResourceManager(typeof(Form1));
                        this.panel1 = new System.Windows.Forms.Panel();
                        this.button1 = new System.Windows.Forms.Button();
                        resources.ApplyResources(this.panel1, "panel1");
                        resources.ApplyResources(this.button1, "button1");
                        this.Controls.Add(this.button1);
                        this.Controls.Add(this.panel1);
                    }
                }
            }
            """;

        var edit = DesignerControlEditor.Reparent(source, "button1", "panel1");

        Assert.True(edit.Safe, edit.Reason);
        Assert.NotNull(edit.NewText);
        Assert.Contains("this.panel1.Controls.Add(this.button1);", edit.NewText);
        Assert.DoesNotContain("this.Controls.Add(this.button1);", edit.NewText);
        Assert.Contains("resources.ApplyResources(this.button1, \"button1\");", edit.NewText);
        Assert.DoesNotContain("this.button1.Location", edit.NewText);
        Assert.True(DesignerControlEditor.OnlyReparented(source, edit.NewText!, "button1", "panel1"));
    }

    [Fact]
    public void S033_TableLayoutPanelCellMove_RewritesOnlyThreeArgumentCellAdd()
    {
        const string source = """
            namespace Demo
            {
                partial class Form1
                {
                    private System.Windows.Forms.TableLayoutPanel tableLayoutPanel1;
                    private System.Windows.Forms.Button button1;

                    private void InitializeComponent()
                    {
                        this.tableLayoutPanel1 = new System.Windows.Forms.TableLayoutPanel();
                        this.button1 = new System.Windows.Forms.Button();
                        this.tableLayoutPanel1.ColumnCount = 2;
                        this.tableLayoutPanel1.RowCount = 2;
                        this.tableLayoutPanel1.Controls.Add(this.button1, 0, 0);
                        this.button1.Location = new System.Drawing.Point(3, 3);
                        this.button1.Name = "button1";
                        this.Controls.Add(this.tableLayoutPanel1);
                    }
                }
            }
            """;

        var edit = DesignerTableCellEditor.SetCell(source, "button1", 1, 1);

        Assert.Equal(EditMode.Replace, edit.Mode);
        Assert.Contains("this.tableLayoutPanel1.Controls.Add(this.button1, 1, 1);", edit.NewText);
        Assert.True(DesignerTableCellEditor.OnlyTableCellChanged(source, edit.NewText, "button1"));
        Assert.Contains("this.button1.Location = new System.Drawing.Point(3, 3);", edit.NewText);
    }

    [Fact]
    public void S034_FlowLayoutPanelReorder_ChangesChildCollectionOrderNotCoordinates()
    {
        const string source = """
            namespace Demo
            {
                partial class Form1
                {
                    private System.Windows.Forms.FlowLayoutPanel flowLayoutPanel1;
                    private System.Windows.Forms.Button btnA;
                    private System.Windows.Forms.Button btnB;
                    private System.Windows.Forms.Button btnC;

                    private void InitializeComponent()
                    {
                        this.flowLayoutPanel1 = new System.Windows.Forms.FlowLayoutPanel();
                        this.btnA = new System.Windows.Forms.Button();
                        this.btnB = new System.Windows.Forms.Button();
                        this.btnC = new System.Windows.Forms.Button();
                        this.flowLayoutPanel1.Controls.Add(this.btnA);
                        this.flowLayoutPanel1.Controls.Add(this.btnB);
                        this.flowLayoutPanel1.Controls.Add(this.btnC);
                        this.btnA.Name = "btnA";
                        this.btnB.Name = "btnB";
                        this.btnC.Name = "btnC";
                        this.Controls.Add(this.flowLayoutPanel1);
                    }
                }
            }
            """;

        var edit = DesignerControlEditor.MoveZOrder(source, "btnC", toFront: true);

        Assert.True(edit.Safe, edit.Reason);
        Assert.NotNull(edit.NewText);
        Assert.True(IndexOfAdd(edit.NewText!, "btnC") < IndexOfAdd(edit.NewText!, "btnA"));
        Assert.True(IndexOfAdd(edit.NewText!, "btnA") < IndexOfAdd(edit.NewText!, "btnB"));
        Assert.DoesNotContain("btnC.Location", edit.NewText);
        Assert.True(DesignerControlEditor.OnlyReordered(source, edit.NewText!));
    }

    [Fact]
    public void S035_TabPageReparent_SetsSelectedPageOwnershipAndParentRelativeLocation()
    {
        const string source = """
            namespace Demo
            {
                partial class Form1
                {
                    private System.Windows.Forms.TabControl tabControl1;
                    private System.Windows.Forms.TabPage tabPage1;
                    private System.Windows.Forms.TabPage tabPage2;
                    private System.Windows.Forms.TextBox textBox1;

                    private void InitializeComponent()
                    {
                        this.tabControl1 = new System.Windows.Forms.TabControl();
                        this.tabPage1 = new System.Windows.Forms.TabPage();
                        this.tabPage2 = new System.Windows.Forms.TabPage();
                        this.textBox1 = new System.Windows.Forms.TextBox();
                        this.tabControl1.Controls.Add(this.tabPage1);
                        this.tabControl1.Controls.Add(this.tabPage2);
                        this.tabControl1.SelectedIndex = 1;
                        this.textBox1.Location = new System.Drawing.Point(120, 80);
                        this.textBox1.Name = "textBox1";
                        this.Controls.Add(this.textBox1);
                        this.Controls.Add(this.tabControl1);
                    }
                }
            }
            """;

        var edit = DesignerControlEditor.Reparent(source, "textBox1", "tabPage2", locX: 24, locY: 36);

        Assert.True(edit.Safe, edit.Reason);
        Assert.NotNull(edit.NewText);
        Assert.Contains("this.tabPage2.Controls.Add(this.textBox1);", edit.NewText);
        Assert.DoesNotContain("this.Controls.Add(this.textBox1);", edit.NewText);
        Assert.Contains("this.textBox1.Location = new System.Drawing.Point(24, 36);", edit.NewText);
        Assert.DoesNotContain("new System.Drawing.Point(120, 80)", edit.NewText);
        Assert.True(DesignerControlEditor.OnlyReparented(source, edit.NewText!, "textBox1", "tabPage2", 24, 36));
    }

    [Fact]
    public void V2_FND_001_S036_StaleSplitContainerPanelTarget_RefusesBeforeMutationWithMissingContainer()
    {
        const string source = """
            namespace Demo
            {
                partial class Form1
                {
                    private System.Windows.Forms.Panel splitContainer1;
                    private System.Windows.Forms.TextBox textBox1;

                    private void InitializeComponent()
                    {
                        this.splitContainer1 = new System.Windows.Forms.Panel();
                        this.textBox1 = new System.Windows.Forms.TextBox();
                        this.textBox1.Location = new System.Drawing.Point(10, 20);
                        this.textBox1.Name = "textBox1";
                        this.Controls.Add(this.textBox1);
                        this.Controls.Add(this.splitContainer1);
                    }
                }
            }
            """;

        var edit = DesignerControlEditor.Reparent(source, "textBox1", "splitContainer1.Panel2", locX: 5, locY: 6);

        Assert.False(edit.Safe);
        Assert.Equal("MISSING_CONTAINER", edit.Reason);
        Assert.Null(edit.NewText);
    }

    private static int IndexOfAdd(string source, string id) =>
        source.IndexOf("Controls.Add(this." + id + ");", StringComparison.Ordinal);
}
