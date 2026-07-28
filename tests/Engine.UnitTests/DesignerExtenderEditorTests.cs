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

    /// <summary>Matching the call SHAPE is not licence to overwrite the value: a hand-written expression must survive.
    /// The minimal-diff gate cannot catch this on its own — it scrubs every matching call from both files first.</summary>
    [Fact]
    public void RefusesToOverwriteAHandWrittenValueExpression()
    {
        string custom = Source.Replace(
            """this.toolTip1.SetToolTip(this.button1, "Old tip");""",
            """this.toolTip1.SetToolTip(this.button1, GetContextualTip());""");

        var edit = DesignerExtenderEditor.SetValue(
            custom, "toolTip1", "button1", "ToolTip", "System.String", "New tip");

        Assert.Equal(EditMode.Failed, edit.Mode);
        Assert.Contains("custom expression", edit.Reason);

        // …and the gate must not bless such an edit if one were constructed some other way.
        string overwritten = custom.Replace("GetContextualTip()", "\"New tip\"");
        Assert.False(DesignerExtenderEditor.OnlyExtenderChanged(
            custom, overwritten, "toolTip1", "button1", "ToolTip", EditMode.Replace));
    }

    /// <summary>A dotted name is only a value THIS editor emits for an ENUM property. Where a literal belongs, the
    /// same shape is the user's own code — a resource, a constant, a field — and must not be overwritten.</summary>
    [Theory]
    [InlineData("Resources.ContextualTip")]
    [InlineData("tooltipText")]
    [InlineData("Strings.Help + \"!\"")]
    public void RefusesToOverwriteANonLiteralValueOfALiteralValuedProperty(string expression)
    {
        string custom = Source.Replace(
            """this.toolTip1.SetToolTip(this.button1, "Old tip");""",
            "this.toolTip1.SetToolTip(this.button1, " + expression + ");");

        var edit = DesignerExtenderEditor.SetValue(
            custom, "toolTip1", "button1", "ToolTip", "System.String", "New tip");

        Assert.Equal(EditMode.Failed, edit.Mode);
        Assert.Contains("custom expression", edit.Reason);
    }

    /// <summary>An enum member and a negative int are values this editor emits itself, so they stay editable.</summary>
    [Fact]
    public void StillReplacesValuesItCouldHaveEmittedItself()
    {
        string enumValue = Source.Replace(
            """this.toolTip1.SetToolTip(this.button1, "Old tip");""",
            "this.errorProvider1.SetIconAlignment(this.button1, System.Windows.Forms.ErrorIconAlignment.TopLeft);");

        var edit = DesignerExtenderEditor.SetValue(
            enumValue, "errorProvider1", "button1", "IconAlignment",
            "System.Windows.Forms.ErrorIconAlignment", "MiddleRight");

        Assert.Equal(EditMode.Replace, edit.Mode);
        Assert.Contains("ErrorIconAlignment.MiddleRight", edit.NewText);
        // Also drive the production minimality gate: SetValue succeeding is not enough if the gate then refuses.
        Assert.True(DesignerExtenderEditor.OnlyExtenderChanged(
            enumValue, edit.NewText, "errorProvider1", "button1", "IconAlignment", edit.Mode));
    }

    /// <summary>An enum value is only editor-owned when it names THIS enum. A dotted constant of some other type is
    /// the user's own code; the `global::`-qualified form of our own member is not.</summary>
    [Fact]
    public void PinsEnumRepresentabilityToTheDeclaredEnumType()
    {
        string Build(string value) => Source.Replace(
            """this.toolTip1.SetToolTip(this.button1, "Old tip");""",
            "this.errorProvider1.SetIconAlignment(this.button1, " + value + ");");

        var foreign = DesignerExtenderEditor.SetValue(
            Build("UiDefaults.ValidationAlignment"), "errorProvider1", "button1", "IconAlignment",
            "System.Windows.Forms.ErrorIconAlignment", "MiddleRight");
        Assert.Equal(EditMode.Failed, foreign.Mode);
        Assert.Contains("custom expression", foreign.Reason);

        var globalQualified = DesignerExtenderEditor.SetValue(
            Build("global::System.Windows.Forms.ErrorIconAlignment.TopLeft"), "errorProvider1", "button1",
            "IconAlignment", "System.Windows.Forms.ErrorIconAlignment", "MiddleRight");
        Assert.Equal(EditMode.Replace, globalQualified.Mode);
    }

    /// <summary>A comment BETWEEN the SetX arguments is trivia on an inner token, so an edge-only guard never saw it
    /// and the regenerated call dropped it. The contract is to fail closed.</summary>
    [Fact]
    public void RefusesToRewriteAnExtenderCallCarryingAnInnerComment()
    {
        string commented = Source.Replace(
            """this.toolTip1.SetToolTip(this.button1, "Old tip");""",
            """this.toolTip1.SetToolTip(this.button1, /* keep: shown on hover */ "Old tip");""");
        Assert.Contains("keep: shown on hover", commented);

        var edit = DesignerExtenderEditor.SetValue(
            commented, "toolTip1", "button1", "ToolTip", "System.String", "New tip");

        Assert.Equal(EditMode.Failed, edit.Mode);
        Assert.Contains("comments or directives", edit.Reason);
    }
}
