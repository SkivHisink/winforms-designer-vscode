using WinFormsDesigner.Engine;

namespace Engine.UnitTests;

public sealed class DesignerComponentRenameTests
{
    private const string Source = """
        namespace Demo
        {
            partial class Form1
            {
                private System.Windows.Forms.ToolTip toolTip1;
                private System.Windows.Forms.Button button1;

                private void InitializeComponent()
                {
                    this.toolTip1 = new System.Windows.Forms.ToolTip();
                    this.button1 = new System.Windows.Forms.Button();
                    this.button1.Name = "button1";
                    this.button1.Text = "toolTip1";
                    this.toolTip1.SetToolTip(this.button1, "Help");
                }

                private void Observe()
                {
                    var toolTip1 = "local";
                    System.Console.WriteLine(toolTip1);
                    this.toolTip1.RemoveAll();
                }
            }

            class Other
            {
                private object toolTip1;
            }
        }
        """;

    [Fact]
    public void RenamesFieldAndThisReferencesWithoutTouchingLocalsOrOtherClasses()
    {
        var result = DesignerComponentRename.Rename(Source, "toolTip1", "helpToolTip");

        Assert.True(result.Safe, result.Reason);
        Assert.Equal("helpToolTip", result.Name);
        Assert.Contains("private System.Windows.Forms.ToolTip helpToolTip;", result.NewText);
        Assert.Contains("this.helpToolTip.SetToolTip", result.NewText);
        Assert.Contains("""var toolTip1 = "local";""", result.NewText);
        Assert.Contains("private object toolTip1;", result.NewText);
        Assert.Contains("""this.button1.Text = "toolTip1";""", result.NewText);
        Assert.True(DesignerComponentRename.OnlyComponentRenamed(Source, result.NewText!, "toolTip1", "helpToolTip"));
    }

    [Fact]
    public void RenamesCanonicalNameValueButNotOtherStrings()
    {
        string source = Source.Replace(
            """this.button1.Name = "button1";""",
            """
            this.toolTip1.Name = "toolTip1";
            this.button1.Name = "button1";
            """);

        var result = DesignerComponentRename.Rename(source, "toolTip1", "helpToolTip");

        Assert.True(result.Safe, result.Reason);
        Assert.Contains("""this.helpToolTip.Name = "helpToolTip";""", result.NewText);
        Assert.Contains("""this.button1.Text = "toolTip1";""", result.NewText);
    }

    [Fact]
    public void RefusesInvalidUnknownAndCollidingNames()
    {
        Assert.False(DesignerComponentRename.Rename(Source, "toolTip1", "bad-name").Safe);
        Assert.False(DesignerComponentRename.Rename(Source, "missing", "helpToolTip").Safe);
        Assert.False(DesignerComponentRename.Rename(Source, "toolTip1", "button1").Safe);
    }
}
