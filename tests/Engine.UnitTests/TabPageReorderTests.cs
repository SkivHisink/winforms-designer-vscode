using WinFormsDesigner.Engine;

namespace Engine.UnitTests;

public sealed class TabPageReorderTests
{
    private const string SeparateAdds = """
        namespace Demo;
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
                this.tabs.Controls.Add(this.pageA);
                this.tabs.Controls.Add(this.pageB);
                this.tabs.Controls.Add(this.pageC);
                this.pageA.TabIndex = 0;
                this.pageB.TabIndex = 1;
                this.pageC.TabIndex = 2;
                this.Controls.Add(this.tabs);
            }
        }
        """;

    private const string AddRange = """
        namespace Demo;
        partial class Form1
        {
            private System.Windows.Forms.TabControl tabs;
            private System.Windows.Forms.TabPage pageA;
            private System.Windows.Forms.TabPage pageB;
            private System.Windows.Forms.TabPage pageC;
            private System.Windows.Forms.TabPage pageD;

            private void InitializeComponent()
            {
                this.tabs = new System.Windows.Forms.TabControl();
                this.pageA = new System.Windows.Forms.TabPage();
                this.pageB = new System.Windows.Forms.TabPage();
                this.pageC = new System.Windows.Forms.TabPage();
                this.pageD = new System.Windows.Forms.TabPage();
                this.tabs.TabPages.AddRange(new System.Windows.Forms.TabPage[] {
                    this.pageA,
                    this.pageB,
                    this.pageC});
                this.tabs.TabPages.Add(this.pageD);
                this.Controls.Add(this.tabs);
            }
        }
        """;

    private const string VendorAddRange = """
        namespace Demo;
        partial class Form1
        {
            private DevExpress.XtraTab.XtraTabControl tabs;
            private DevExpress.XtraTab.XtraTabPage pageA;
            private DevExpress.XtraTab.XtraTabPage pageB;

            private void InitializeComponent()
            {
                this.tabs = new DevExpress.XtraTab.XtraTabControl();
                this.pageA = new DevExpress.XtraTab.XtraTabPage();
                this.pageB = new DevExpress.XtraTab.XtraTabPage();
                this.tabs.SelectedTabPage = this.pageA;
                this.tabs.TabPages.AddRange(new DevExpress.XtraTab.XtraTabPage[] {
                    this.pageA,
                    this.pageB});
                this.Controls.Add(this.tabs);
            }
        }
        """;

    [Fact]
    public void SeparateAdds_MoveRight_SwapsOnlyTheAdjacentPageReferences()
    {
        var result = DesignerControlEditor.MoveTabPage(SeparateAdds, "tabs", "pageA", left: false);

        Assert.True(result.Safe, result.Reason);
        Assert.NotNull(result.NewText);
        AssertOrder(result.NewText!,
            "this.tabs.Controls.Add(this.pageB);",
            "this.tabs.Controls.Add(this.pageA);",
            "this.tabs.Controls.Add(this.pageC);");
        Assert.Contains("this.pageA.TabIndex = 0;", result.NewText);
        Assert.Contains("this.pageB.TabIndex = 1;", result.NewText);
        Assert.True(DesignerControlEditor.OnlyTabPageMoved(SeparateAdds, result.NewText!, "tabs", "pageA", left: false));
    }

    [Fact]
    public void AddRange_MoveMiddleRight_ReordersOnlyArrayElements()
    {
        var result = DesignerControlEditor.MoveTabPage(AddRange, "tabs", "pageB", left: false);

        Assert.True(result.Safe, result.Reason);
        Assert.NotNull(result.NewText);
        AssertOrder(result.NewText!, "this.pageA,", "this.pageC,", "this.pageB}");
        Assert.Contains("this.tabs.TabPages.Add(this.pageD);", result.NewText);
        Assert.True(DesignerControlEditor.OnlyTabPageMoved(AddRange, result.NewText!, "tabs", "pageB", left: false));
    }

    [Fact]
    public void AddRangePlusAdd_MoveAcrossStatementBoundary_IsStillOneAdjacentPermutation()
    {
        var result = DesignerControlEditor.MoveTabPage(AddRange, "tabs", "pageD", left: true);

        Assert.True(result.Safe, result.Reason);
        Assert.NotNull(result.NewText);
        AssertOrder(result.NewText!, "this.pageA,", "this.pageB,", "this.pageD}");
        Assert.Contains("this.tabs.TabPages.Add(this.pageC);", result.NewText);
        Assert.True(DesignerControlEditor.OnlyTabPageMoved(AddRange, result.NewText!, "tabs", "pageD", left: true));
    }

    [Fact]
    public void VendorAddRange_MoveLeft_PreservesSelectedPageStatementAndCollectionShape()
    {
        var result = DesignerControlEditor.MoveTabPage(VendorAddRange, "tabs", "pageB", left: true);

        Assert.True(result.Safe, result.Reason);
        Assert.NotNull(result.NewText);
        AssertOrder(result.NewText!, "this.pageB,", "this.pageA}");
        Assert.Contains("this.tabs.SelectedTabPage = this.pageA;", result.NewText);
        Assert.Single(result.NewText!.Split("TabPages.AddRange", StringSplitOptions.None).Skip(1));
        Assert.True(DesignerControlEditor.OnlyTabPageMoved(VendorAddRange, result.NewText!, "tabs", "pageB", left: true));
    }

    [Fact]
    public void RequestedEdge_IsAnExplicitNoOp()
    {
        var first = DesignerControlEditor.MoveTabPage(SeparateAdds, "tabs", "pageA", left: true);
        var last = DesignerControlEditor.MoveTabPage(SeparateAdds, "tabs", "pageC", left: false);

        Assert.True(first.Safe, first.Reason);
        Assert.True(last.Safe, last.Reason);
        Assert.Equal(SeparateAdds, first.NewText);
        Assert.Equal(SeparateAdds, last.NewText);
    }

    [Fact]
    public void DuplicateOrNonTrivialAttachment_FailsClosed()
    {
        var duplicate = SeparateAdds.Replace(
            "this.tabs.Controls.Add(this.pageC);",
            "this.tabs.Controls.Add(this.pageB);");
        var nonTrivial = AddRange.Replace("this.pageB,", "GetPage(),");

        Assert.False(DesignerControlEditor.MoveTabPage(duplicate, "tabs", "pageA", left: false).Safe);
        Assert.False(DesignerControlEditor.MoveTabPage(nonTrivial, "tabs", "pageA", left: false).Safe);
    }

    [Fact]
    public void SafetyGateRejectsAnAdjacentMoveBundledWithAnotherChange()
    {
        var moved = DesignerControlEditor.MoveTabPage(SeparateAdds, "tabs", "pageB", left: true);
        Assert.True(moved.Safe, moved.Reason);
        var tampered = moved.NewText!.Replace("this.pageC.TabIndex = 2;", "this.pageC.TabIndex = 99;");

        Assert.False(DesignerControlEditor.OnlyTabPageMoved(SeparateAdds, tampered, "tabs", "pageB", left: true));
    }

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
}
