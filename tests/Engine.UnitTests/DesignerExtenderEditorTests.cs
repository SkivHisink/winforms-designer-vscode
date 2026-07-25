using WinFormsDesigner.Engine;

namespace Engine.UnitTests;

public sealed class DesignerExtenderEditorTests
{
    private const string Source = """
        namespace Demo
        {
            partial class Form1
            {
                private System.Windows.Forms.Button button1;
                private System.Windows.Forms.ToolTip toolTip1;
                private System.Windows.Forms.ErrorProvider errorProvider1;

                private void InitializeComponent()
                {
                    this.button1 = new System.Windows.Forms.Button();
                    this.toolTip1 = new System.Windows.Forms.ToolTip();
                    this.errorProvider1 = new System.Windows.Forms.ErrorProvider();
                    this.button1.Name = "button1";
                    this.toolTip1.SetToolTip(this.button1, "Old tip");
                }
            }
        }
        """;

    [Fact]
    public void ReplacesExistingToolTipAsAnEscapedLiteral()
    {
        var edit = DesignerExtenderEditor.SetValue(
            Source, "toolTip1", "button1", "ToolTip", "System.String", "Customer \"name\"");

        Assert.Equal(EditMode.Replace, edit.Mode);
        Assert.Contains("""this.toolTip1.SetToolTip(this.button1, "Customer \"name\"");""", edit.NewText);
        Assert.True(DesignerExtenderEditor.OnlyExtenderChanged(
            Source, edit.NewText, "toolTip1", "button1", "ToolTip", edit.Mode));
    }

    [Fact]
    public void InsertsErrorProviderEnumAndKeepsOtherStatements()
    {
        var edit = DesignerExtenderEditor.SetValue(
            Source, "errorProvider1", "button1", "IconAlignment",
            "System.Windows.Forms.ErrorIconAlignment", "MiddleRight");

        Assert.Equal(EditMode.Insert, edit.Mode);
        Assert.Contains(
            "this.errorProvider1.SetIconAlignment(this.button1, System.Windows.Forms.ErrorIconAlignment.MiddleRight);",
            edit.NewText);
        Assert.True(DesignerExtenderEditor.OnlyExtenderChanged(
            Source, edit.NewText, "errorProvider1", "button1", "IconAlignment", edit.Mode));
    }

    [Fact]
    public void RefusesProviderMismatchUnknownTargetAndInjection()
    {
        Assert.Equal(EditMode.Failed, DesignerExtenderEditor.SetValue(
            Source, "toolTip1", "button1", "Error", "System.String", "x").Mode);
        Assert.Equal(EditMode.Failed, DesignerExtenderEditor.SetValue(
            Source, "toolTip1", "missing", "ToolTip", "System.String", "x").Mode);
        Assert.Equal(EditMode.Failed, DesignerExtenderEditor.SetValue(
            Source, "errorProvider1", "button1", "IconAlignment",
            "System.Windows.Forms.ErrorIconAlignment", "MiddleRight); this.Tag = 1").Mode);
    }
}
