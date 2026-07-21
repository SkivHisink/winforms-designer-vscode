using WinFormsDesigner.Engine;

namespace Engine.UnitTests;

public sealed class SaveSafetyTests
{
    private const string BaseSource = """
        namespace Demo
        {
            partial class Form1
            {
                private System.Windows.Forms.Button button1;
                private void InitializeComponent()
                {
                    this.button1 = new System.Windows.Forms.Button();
                    this.button1.Name = "button1";
                    this.Controls.Add(this.button1);
                }
            }
        }
        """;

    [Fact]
    public void OnlyTargetChanged_TargetOnly_Accepts_AndSiblingChangeRejects()
    {
        string target = BaseSource.Replace("\"button1\"", "\"renamed\"");
        Assert.True(DesignerPropertyEditor.OnlyTargetChanged(BaseSource, target, "button1", "Name", EditMode.Replace));

        string sibling = target.Replace("this.Controls.Add(this.button1);", "this.Controls.Add(this.button1); this.Text = \"side effect\";");
        Assert.False(DesignerPropertyEditor.OnlyTargetChanged(BaseSource, sibling, "button1", "Name", EditMode.Replace));
    }

    [Fact]
    public void OnlyWiringAdded_OneTargetWiring_Accepts_AndExtraStatementRejects()
    {
        string wiring = BaseSource.Replace("this.Controls.Add(this.button1);",
            "this.Controls.Add(this.button1);\n                this.button1.Click += new System.EventHandler(this.button1_Click);");
        Assert.True(DesignerEventEditor.OnlyWiringAdded(BaseSource, wiring, "button1", "Click"));

        string extra = wiring.Replace("this.button1.Click +=", "this.Text = \"changed\";\n                this.button1.Click +=");
        Assert.False(DesignerEventEditor.OnlyWiringAdded(BaseSource, extra, "button1", "Click"));
    }

    [Fact]
    public void AddThenRemove_LeafControl_RestoresOriginalBytes()
    {
        var add = DesignerControlEditor.AddControl(BaseSource, "this", "Label", locX: 12, locY: 18);
        Assert.True(add.Safe, add.Reason);
        Assert.NotNull(add.NewText);

        var remove = DesignerControlEditor.RemoveControl(add.NewText!, add.Name);
        Assert.True(remove.Safe, remove.Reason);
        Assert.Equal(BaseSource, remove.NewText);
    }

    [Fact]
    public void RemoveControl_RootContainerOrUnknown_Rejects()
    {
        Assert.False(DesignerControlEditor.RemoveControl(BaseSource, "this").Safe);
        Assert.False(DesignerControlEditor.RemoveControl(BaseSource, "missing").Safe);

        string withChild = BaseSource.Replace("this.Controls.Add(this.button1);",
            "this.button1.Controls.Add(this.button2);\n                    this.Controls.Add(this.button1);")
            .Replace("private System.Windows.Forms.Button button1;",
                "private System.Windows.Forms.Button button1;\n            private System.Windows.Forms.Button button2;");
        Assert.False(DesignerControlEditor.RemoveControl(withChild, "button1").Safe);
    }

    [Fact]
    public void MissingOriginalStatements_EquivalentCollectionAndLocalSpelling_Accepts()
    {
        string original = WrapInit("""
            System.Windows.Forms.TreeNode treenode1;
            treenode1 = new System.Windows.Forms.TreeNode("Root");
            this.treeView1.Nodes.AddRange(new System.Windows.Forms.TreeNode[] { treenode1 });
            this.Controls.AddRange(new System.Windows.Forms.Control[] { this.treeView1 });
            """);
        string generated = WrapInit("""
            System.Windows.Forms.TreeNode treeNode1;
            treeNode1 = new System.Windows.Forms.TreeNode("Root");
            this.treeView1.Nodes.Add(treeNode1);
            this.Controls.Add(this.treeView1);
            """);

        Assert.Empty(DesignerSaveSplicer.MissingOriginalStatements(original, generated));
    }

    [Fact]
    public void MissingOriginalStatements_CollectionElementWithInvocation_RemainsFailClosed()
    {
        string original = WrapInit("this.comboBox1.Items.AddRange(new object[] { GetValue() });");
        string generated = WrapInit("this.comboBox1.Items.Add(GetValue());");
        Assert.Single(DesignerSaveSplicer.MissingOriginalStatements(original, generated));
    }

    [Fact]
    public void MissingOriginalStatements_UnrelatedChange_IsReported()
    {
        string original = WrapInit("this.Text = \"original\";");
        string generated = WrapInit("this.Text = \"changed\";");
        Assert.Equal(new[] { "this.Text = \"original\";" },
            DesignerSaveSplicer.MissingOriginalStatements(original, generated));
    }

    private static string WrapInit(string body) => $$"""
        partial class Form1
        {
            private void InitializeComponent()
            {
                {{body}}
            }
        }
        """;
}
