using WinFormsDesigner.Engine;

namespace Engine.UnitTests;

public sealed class DesignerMultiPropertyTests
{
    private const string Source = """
        namespace Sample;

        partial class Form1
        {
            private System.Windows.Forms.Button button1;
            private System.Windows.Forms.TextBox textBox1;
            private System.Windows.Forms.CheckBox untouched;

            private void InitializeComponent()
            {
                this.button1 = new System.Windows.Forms.Button();
                this.textBox1 = new System.Windows.Forms.TextBox();
                this.untouched = new System.Windows.Forms.CheckBox();
                this.button1.Text = "Button";
                this.textBox1.Text = "Text";
                this.untouched.Text = "Keep";
            }
        }
        """;

    [Fact]
    public void ApplyPropertyEdits_ChangesEveryTargetAndOnlyThoseTargets()
    {
        var result = DesignerRenderer.ApplyPropertyEdits(
            "unused.Designer.cs", ["button1", "textBox1"], "Text", "\"Shared\"", Source);

        Assert.True(result.Safe, result.Reason);
        Assert.NotNull(result.NewText);
        Assert.Contains("this.button1.Text = \"Shared\";", result.NewText);
        Assert.Contains("this.textBox1.Text = \"Shared\";", result.NewText);
        Assert.Contains("this.untouched.Text = \"Keep\";", result.NewText);
    }

    [Theory]
    [InlineData("BackColor", "System.Drawing.Color.Red")]
    [InlineData("ForeColor", "System.Drawing.Color.White")]
    [InlineData("Font", "new System.Drawing.Font(\"Segoe UI\", 10F)")]
    public void BuiltInEditorPropertyEdit_AppliesToBothSelectedButtons(string propertyName, string expression)
    {
        const string source = """
            partial class Form1
            {
                private System.Windows.Forms.Button button1;
                private System.Windows.Forms.Button button2;
                private void InitializeComponent()
                {
                    this.button1 = new System.Windows.Forms.Button();
                    this.button2 = new System.Windows.Forms.Button();
                }
            }
            """;

        var result = DesignerRenderer.ApplyPropertyEdits(
            "unused.Designer.cs", ["button1", "button2"], propertyName, expression, source);

        Assert.True(result.Safe, result.Reason);
        Assert.NotNull(result.NewText);
        Assert.Contains($"this.button1.{propertyName} = {expression};", result.NewText);
        Assert.Contains($"this.button2.{propertyName} = {expression};", result.NewText);
    }

    [Fact]
    public void ApplyPropertyEdits_WhenAnyTargetIsIneligible_ReturnsNoPartialText()
    {
        var result = DesignerRenderer.ApplyPropertyEdits(
            "unused.Designer.cs", ["button1", "missingControl"], "Text", "\"Shared\"", Source);

        Assert.False(result.Safe);
        Assert.Null(result.NewText);
        Assert.Contains("missingControl", result.Reason);
        Assert.Contains("read-only", result.Reason);
    }

    [Fact]
    public void V2_FND_001_S039_ApplyPropertyResets_RemovesEveryTargetAsOnePreview()
    {
        var result = DesignerRenderer.ApplyPropertyResets(
            "unused.Designer.cs", ["button1", "textBox1"], "Text", Source);

        Assert.True(result.Ok, result.Reason);
        Assert.True(result.Changed);
        Assert.NotNull(result.NewText);
        Assert.DoesNotContain("this.button1.Text", result.NewText);
        Assert.DoesNotContain("this.textBox1.Text", result.NewText);
        Assert.Contains("this.untouched.Text = \"Keep\";", result.NewText);
    }

    [Fact]
    public void ApplyPropertyResets_WhenAnyTargetWouldLoseTrivia_ReturnsNoPartialText()
    {
        string unsafeSource = Source.Replace(
            "this.textBox1.Text = \"Text\";",
            "this.textBox1.Text = \"Text\"; // keep this rationale",
            StringComparison.Ordinal);

        var result = DesignerRenderer.ApplyPropertyResets(
            "unused.Designer.cs", ["button1", "textBox1"], "Text", unsafeSource);

        Assert.False(result.Ok);
        Assert.False(result.Changed);
        Assert.Null(result.NewText);
        Assert.Contains("comment", result.Reason);
    }

    [Fact]
    public void MultiPropertyAdapters_RejectNonClosedTargetSets()
    {
        foreach (string[] ids in new[] { new[] { "button1" }, new[] { "button1", "button1" } })
        {
            var edit = DesignerRenderer.ApplyPropertyEdits("unused.Designer.cs", ids, "Text", "\"Shared\"", Source);
            var reset = DesignerRenderer.ApplyPropertyResets("unused.Designer.cs", ids, "Text", Source);

            Assert.False(edit.Safe);
            Assert.Null(edit.NewText);
            Assert.False(reset.Ok);
            Assert.Null(reset.NewText);
        }
    }
}
