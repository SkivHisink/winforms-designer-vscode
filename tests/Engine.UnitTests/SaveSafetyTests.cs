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

    /// <summary>
    /// Adding then removing a control restores the original bytes EXCEPT for the layout scaffold a first drop
    /// installs on a form that had none (1.9.0's Visual-Studio-shaped emit). Visual Studio keeps that scaffold
    /// after a delete too, so the invariant is now "nothing but the scaffold survives" — still byte-exact, and
    /// still enough to catch any stray edit the add/remove pair might leave behind.
    /// </summary>
    [Fact]
    public void AddThenRemove_LeafControl_RestoresOriginalBytesApartFromTheLayoutScaffold()
    {
        var add = DesignerControlEditor.AddControl(BaseSource, "this", "Label", locX: 12, locY: 18);
        Assert.True(add.Safe, add.Reason);
        Assert.NotNull(add.NewText);

        var remove = DesignerControlEditor.RemoveControl(add.NewText!, add.Name);
        Assert.True(remove.Safe, remove.Reason);

        string stripped = string.Join("\n", remove.NewText!.Replace("\r\n", "\n").Split('\n')
            .Where(line => line.Trim() is not ("this.SuspendLayout();" or "this.ResumeLayout(false);"
                or "this.PerformLayout();" or "this.Name = \"Form1\";" or "//" or "// Form1")));
        Assert.Equal(BaseSource.Replace("\r\n", "\n"), stripped);

        // A SECOND add/remove cycle changes nothing at all: the scaffold is installed once.
        var again = DesignerControlEditor.AddControl(remove.NewText!, "this", "Label", locX: 12, locY: 18);
        Assert.True(again.Safe, again.Reason);
        var removedAgain = DesignerControlEditor.RemoveControl(again.NewText!, again.Name);
        Assert.True(removedAgain.Safe, removedAgain.Reason);
        Assert.Equal(remove.NewText, removedAgain.NewText);
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
    public void RemoveControl_CanonicalApplyResources_RemovesOnlyTarget_LocalizableShape()
    {
        string source = BaseSource.Replace(
            "this.button1.Name = \"button1\";",
            "resources.ApplyResources(this.button1, \"button1\");\n                    this.button1.Name = \"button1\";")
            .Replace(
                "this.button1 = new System.Windows.Forms.Button();",
                "System.ComponentModel.ComponentResourceManager resources = new System.ComponentModel.ComponentResourceManager(typeof(Form1));\n                    this.button1 = new System.Windows.Forms.Button();");

        var result = DesignerControlEditor.RemoveControl(source, "button1");

        Assert.True(result.Safe, result.Reason);
        Assert.DoesNotContain("this.button1", result.NewText);
        Assert.DoesNotContain("\"button1\"", result.NewText);
        Assert.Contains("ComponentResourceManager resources", result.NewText);

        string nonCanonical = source.Replace(
            "resources.ApplyResources(this.button1, \"button1\");",
            "vendor.ApplyResources(this.button1, \"button1\");");
        Assert.False(DesignerControlEditor.RemoveControl(nonCanonical, "button1").Safe);
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

    [Fact]
    public void Classify_ApplyResourcesMissingFromWholeFileRegenerate_RemainsLocalizable()
    {
        var reason = SaveSafety.Classify(
            Array.Empty<string>(),
            new[] { "resources.ApplyResources(this.button1, \"button1\");" });

        Assert.Equal(SaveSafetyReason.Localizable, reason);
        Assert.Equal("localizable", SaveSafety.CategoryName(reason));
    }

    // The render CLIs used to call any non-empty bitmap a PASS, so a form whose ActiveX/vendor control could not be
    // created rendered without it and still exited 0. DropsControls is what makes that fail closed — and it must
    // stay narrow: the interpreter emits "AddRange: unknown element" for EVERY collection (ListBox Items, ListView
    // Columns, ToolStrip Items, TabPages), so matching it would report a lost list entry as a lost control.
    [Fact]
    public void DropsControls_OnlyFiresForAControlsAddThatLostItsChild()
    {
        Assert.True(SaveSafety.DropsControls(new[] { "Controls.Add unknown child: this.axWindowsMediaPlayer1" }));

        Assert.True(SaveSafety.DropsControls(new[] { "Controls.AddRange unknown element this.axWindowsMediaPlayer1" }));
        Assert.False(SaveSafety.DropsControls(new[] { "AddRange: unknown element \"Alpha\"" }));
        Assert.False(SaveSafety.DropsControls(new[]
        {
            "this.x.Prop = new decimal(...);  [InvalidOperationException: unresolved type decimal]",
        }));
        Assert.False(SaveSafety.DropsControls(System.Array.Empty<string>()));

        // Classify already buckets this signal as UnresolvedType, so the CLI's category token stays one vocabulary.
        Assert.Equal(SaveSafetyReason.UnresolvedType,
            SaveSafety.Classify(new[] { "Controls.Add unknown child: this.axMSComm1" }, System.Array.Empty<string>()));
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
