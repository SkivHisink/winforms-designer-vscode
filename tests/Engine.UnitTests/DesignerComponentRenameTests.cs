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

    /// <summary>`dotnet format` / IDE0003 strips `this.` qualifiers and does not skip designer files. The rewriter
    /// only renames `this.&lt;id&gt;`, and the minimality gate proves reversibility with that same rewriter, so a
    /// half-rename would sail through both and leave a file that does not compile. Refuse instead.</summary>
    [Fact]
    public void RefusesWhenTheFileReferencesTheFieldWithoutAThisQualifier()
    {
        string unqualified = Source.Replace(
            "this.toolTip1.SetToolTip(this.button1, \"Help\");",
            "toolTip1.SetToolTip(this.button1, \"Help\");");

        var result = DesignerComponentRename.Rename(unqualified, "toolTip1", "helpToolTip");

        Assert.False(result.Safe);
        Assert.Contains("without a this. qualifier", result.Reason);
        Assert.Null(result.NewText);
    }

    /// <summary>The refusal must not fire on a LOCAL that merely shares the name — renaming stays available there.
    /// (The base fixture's Observe() declares `var toolTip1` and passes it to Console.WriteLine.)</summary>
    [Fact]
    public void StillRenamesWhenOnlyALocalSharesTheName()
    {
        var result = DesignerComponentRename.Rename(Source, "toolTip1", "helpToolTip");

        Assert.True(result.Safe, result.Reason);
        Assert.Contains("System.Console.WriteLine(toolTip1);", result.NewText);
    }

    /// <summary>Scope matters: a local declared in a NESTED block does not shadow a bare use of the field that
    /// follows it, so that use really is the field and the rename would leave it dangling. A member-wide "is there a
    /// local of this name anywhere" test would wave this through — the walk must be scope-precise.</summary>
    [Fact]
    public void RefusesWhenTheLocalOfTheSameNameIsOutOfScopeAtTheBareReference()
    {
        string nested = Source.Replace(
            """
                        var toolTip1 = "local";
                        System.Console.WriteLine(toolTip1);
            """,
            """
                        { var toolTip1 = "local"; System.Console.WriteLine(toolTip1); }
                        toolTip1.RemoveAll();
            """);
        Assert.Contains("{ var toolTip1 = \"local\";", nested);

        var result = DesignerComponentRename.Rename(nested, "toolTip1", "helpToolTip");

        Assert.False(result.Safe);
        Assert.Contains("without a this. qualifier", result.Reason);
    }

    /// <summary>A `for` variable lives only for that statement, so a bare reference AFTER the loop is the field
    /// again. Treating the loop declaration as if it belonged to the enclosing block would suppress the refusal and
    /// wave through a half-rename.</summary>
    [Fact]
    public void RefusesWhenTheSameNameIsOnlyAForLoopVariableEarlierInTheBlock()
    {
        string loop = Source.Replace(
            """
                        var toolTip1 = "local";
                        System.Console.WriteLine(toolTip1);
            """,
            """
                        for (int toolTip1 = 0; toolTip1 < 1; toolTip1++) { }
                        toolTip1.RemoveAll();
            """);

        var result = DesignerComponentRename.Rename(loop, "toolTip1", "helpToolTip");

        Assert.False(result.Safe);
        Assert.Contains("without a this. qualifier", result.Reason);
    }

    /// <summary>A nested STRUCT is as separate a scope as a nested class. Matching only the nearest enclosing *class*
    /// let one fall through to the form's identity, so its unrelated member was renamed too.</summary>
    [Fact]
    public void DoesNotRenameMembersOfANestedStruct()
    {
        string nestedStruct = Source.Replace(
            """
                    private void Observe()
            """,
            """
                    private struct Helper
                    {
                        public object toolTip1;
                        public void Use() { System.Console.WriteLine(this.toolTip1); }
                    }

                    private void Observe()
            """);

        var result = DesignerComponentRename.Rename(nestedStruct, "toolTip1", "helpToolTip");

        Assert.True(result.Safe, result.Reason);
        Assert.Contains("public object toolTip1;", result.NewText);
        Assert.Contains("System.Console.WriteLine(this.toolTip1);", result.NewText);
        Assert.Contains("this.helpToolTip.SetToolTip", result.NewText);
    }

    /// <summary>A `foreach` variable is scoped to the loop BODY. A reference in the collection expression is still
    /// the field, so it must not be mistaken for the iteration local.</summary>
    [Fact]
    public void RefusesWhenTheBareReferenceIsInAForeachCollectionExpression()
    {
        string loop = Source.Replace(
            """
                        var toolTip1 = "local";
                        System.Console.WriteLine(toolTip1);
            """,
            """
                        foreach (var toolTip1 in new object[] { toolTip1 }) { System.Console.WriteLine(toolTip1); }
            """);

        var result = DesignerComponentRename.Rename(loop, "toolTip1", "helpToolTip");

        Assert.False(result.Safe);
        Assert.Contains("without a this. qualifier", result.Reason);
    }

    /// <summary>A NESTED class has its own scope: its members cannot denote the form's instance field, and the
    /// rewriter skips them, so they must not block the form's own rename.</summary>
    [Fact]
    public void StillRenamesWhenOnlyANestedClassUsesTheNameUnqualified()
    {
        string nestedClass = Source.Replace(
            """
                    private void Observe()
            """,
            """
                    private sealed class Helper
                    {
                        private object toolTip1;
                        public void Use() { System.Console.WriteLine(toolTip1); }
                    }

                    private void Observe()
            """);

        var result = DesignerComponentRename.Rename(nestedClass, "toolTip1", "helpToolTip");

        Assert.True(result.Safe, result.Reason);
        Assert.Contains("private object toolTip1;", result.NewText);
        Assert.Contains("this.helpToolTip.SetToolTip", result.NewText);
    }
}
