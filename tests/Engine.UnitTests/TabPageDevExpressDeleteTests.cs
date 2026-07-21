using WinFormsDesigner.Engine;

namespace Engine.UnitTests;

// Reproduce the user report: deleting an XtraTabControl page did nothing. RemoveTabPage is pure text (type-agnostic),
// so a DevExpress-shaped source exercises the exact splice a real XtraTabControl form would hit — no DevExpress assembly
// needed. If the splice rejects here, that IS the "confirm → nothing deleted" bug (applyDeleteTab bails on !safe).
public sealed class TabPageDevExpressDeleteTests
{
    // XtraTabControl uses .TabPages.AddRange, a SelectedTabPage assignment, and the host's ISupportInitialize
    // BeginInit/EndInit — the shape a real DevExpress designer emits.
    private const string Src = @"namespace DemoNs {
    partial class XtraForm1 {
        private DevExpress.XtraTab.XtraTabControl xtraTabControl1;
        private DevExpress.XtraTab.XtraTabPage xtraTabPage1;
        private DevExpress.XtraTab.XtraTabPage xtraTabPage2;
        private DevExpress.XtraEditors.SimpleButton simpleButton1;
        private void InitializeComponent() {
            this.xtraTabControl1 = new DevExpress.XtraTab.XtraTabControl();
            this.xtraTabPage1 = new DevExpress.XtraTab.XtraTabPage();
            this.xtraTabPage2 = new DevExpress.XtraTab.XtraTabPage();
            this.simpleButton1 = new DevExpress.XtraEditors.SimpleButton();
            ((System.ComponentModel.ISupportInitialize)(this.xtraTabControl1)).BeginInit();
            this.xtraTabControl1.SuspendLayout();
            this.xtraTabPage1.SuspendLayout();
            this.SuspendLayout();
            this.xtraTabControl1.Name = ""xtraTabControl1"";
            this.xtraTabControl1.SelectedTabPage = this.xtraTabPage1;
            this.xtraTabControl1.TabPages.AddRange(new DevExpress.XtraTab.XtraTabPage[] {
            this.xtraTabPage1,
            this.xtraTabPage2});
            this.xtraTabPage1.Controls.Add(this.simpleButton1);
            this.xtraTabPage1.Name = ""xtraTabPage1"";
            this.xtraTabPage1.Text = ""xtraTabPage1"";
            this.simpleButton1.Name = ""simpleButton1"";
            this.simpleButton1.Text = ""simpleButton1"";
            this.xtraTabPage2.Name = ""xtraTabPage2"";
            this.xtraTabPage2.Text = ""xtraTabPage2"";
            this.Controls.Add(this.xtraTabControl1);
            this.Name = ""XtraForm1"";
            ((System.ComponentModel.ISupportInitialize)(this.xtraTabControl1)).EndInit();
            this.xtraTabControl1.ResumeLayout(false);
            this.xtraTabPage1.ResumeLayout(false);
            this.ResumeLayout(false);
        }
    }
}";

    [Fact]
    public void DeleteSelectedXtraTabPage_RemovesPageAndSubtree()
    {
        var res = DesignerControlEditor.RemoveTabPage(Src, "xtraTabControl1", "xtraTabPage1");
        Assert.True(res.Safe, "RemoveTabPage rejected the XtraTabControl page: " + res.Reason);
        Assert.NotNull(res.NewText);
        Assert.DoesNotContain("this.xtraTabPage1", res.NewText!);   // page detached everywhere
        Assert.DoesNotContain("this.simpleButton1", res.NewText!);  // its subtree gone
        Assert.Contains("this.xtraTabPage2", res.NewText!);         // sibling page survives
        Assert.Contains("this.xtraTabControl1", res.NewText!);      // host survives
    }

    [Fact]
    public void DeleteNonSelectedXtraTabPage_RemovesPageKeepsSelectedSibling()
    {
        var res = DesignerControlEditor.RemoveTabPage(Src, "xtraTabControl1", "xtraTabPage2");
        Assert.True(res.Safe, "RemoveTabPage rejected the non-selected XtraTabControl page: " + res.Reason);
        Assert.DoesNotContain("this.xtraTabPage2", res.NewText!);
        Assert.Contains("this.xtraTabPage1", res.NewText!);         // selected sibling + its SelectedTabPage stay
    }
}
