using WinFormsDesigner.Engine;

namespace Engine.UnitTests;

public sealed class DesignerCrossFormClipboardTests
{
    private const string Source = """
        namespace Demo
        {
            partial class SourceForm
            {
                private System.Windows.Forms.TextBox nameTextBox;
                private System.Windows.Forms.BindingSource customerBindingSource;
                private System.Windows.Forms.ToolTip toolTip1;

                private void InitializeComponent()
                {
                    this.nameTextBox = new System.Windows.Forms.TextBox();
                    this.customerBindingSource = new System.Windows.Forms.BindingSource();
                    this.toolTip1 = new System.Windows.Forms.ToolTip();
                    this.nameTextBox.DataBindings.Add(new System.Windows.Forms.Binding("Text", this.customerBindingSource, "Name", true));
                    this.nameTextBox.Location = new System.Drawing.Point(10, 20);
                    this.nameTextBox.Name = "nameTextBox";
                    this.toolTip1.SetToolTip(this.nameTextBox, "Customer name");
                    this.Controls.Add(this.nameTextBox);
                }
            }
        }
        """;

    private const string CompatibleTarget = """
        namespace Demo
        {
            partial class TargetForm
            {
                private System.Windows.Forms.Panel panel1;
                private System.Windows.Forms.BindingSource customerBindingSource;
                private System.Windows.Forms.ToolTip toolTip1;

                private void InitializeComponent()
                {
                    this.panel1 = new System.Windows.Forms.Panel();
                    this.customerBindingSource = new System.Windows.Forms.BindingSource();
                    this.toolTip1 = new System.Windows.Forms.ToolTip();
                    this.panel1.Name = "panel1";
                    this.Controls.Add(this.panel1);
                }
            }
        }
        """;

    [Fact]
    public void CopiesAndPastesDataBoundControlAcrossFormsWhenDependencyMatches()
    {
        var copy = DesignerControlEditor.CopyControl(Source, "nameTextBox");
        Assert.True(copy.Safe, copy.Reason);
        Assert.Contains("\"Version\":2", copy.Clip);
        Assert.Contains("customerBindingSource", copy.Clip);
        Assert.Contains("toolTip1", copy.Clip);

        var paste = DesignerControlEditor.PasteControl(CompatibleTarget, copy.Clip!, "panel1");
        Assert.True(paste.Safe, paste.Reason);
        Assert.Empty(paste.MissingDependencies);
        Assert.Contains(
            $"""this.{paste.Name}.DataBindings.Add(new System.Windows.Forms.Binding("Text", this.customerBindingSource, "Name", true));""",
            paste.NewText);
        Assert.Contains($"""this.toolTip1.SetToolTip(this.{paste.Name}, "Customer name");""", paste.NewText);
        Assert.Contains($"this.panel1.Controls.Add(this.{paste.Name});", paste.NewText);
    }

    [Fact]
    public void PasteAtOffset_UsesExactCtrlDragDeltaClampsAtClientOriginAndBoundsRpcInput()
    {
        var copy = DesignerControlEditor.CopyControl(Source, "nameTextBox");
        Assert.True(copy.Safe, copy.Reason);

        var exact = DesignerControlEditor.PasteControlAtOffset(CompatibleTarget, copy.Clip!, "panel1", 23, -50);

        Assert.True(exact.Safe, exact.Reason);
        Assert.Equal(33, exact.X);
        Assert.Equal(0, exact.Y);
        Assert.Contains("new System.Drawing.Point(33, 0)", exact.NewText);

        var ordinary = DesignerControlEditor.PasteControl(CompatibleTarget, copy.Clip!, "panel1");
        Assert.True(ordinary.Safe, ordinary.Reason);
        Assert.Equal((18, 28), (ordinary.X, ordinary.Y));

        var outside = DesignerControlEditor.PasteControlAtOffset(CompatibleTarget, copy.Clip!, "panel1", 100001, 0);
        Assert.False(outside.Safe);
        Assert.Contains("offset", outside.Reason);
        Assert.Null(outside.NewText);
    }

    [Fact]
    public void V2_FND_001_S024_PasteWithExistingClipboardNameGeneratesNonCollidingNameBeforeReturningText()
    {
        const string target = """
            namespace Demo
            {
                partial class TargetForm
                {
                    private System.Windows.Forms.Button submitButton;

                    private void InitializeComponent()
                    {
                        this.submitButton = new System.Windows.Forms.Button();
                        this.submitButton.Name = "submitButton";
                        this.submitButton.Location = new System.Drawing.Point(4, 5);
                        this.Controls.Add(this.submitButton);
                    }
                }
            }
            """;
        const string clip = """
            {
              "Fqn":"System.Windows.Forms.Button",
              "Name":"submitButton",
              "Statements":[
                "this.submitButton = new System.Windows.Forms.Button();",
                "this.submitButton.Name = \"submitButton\";",
                "this.submitButton.Location = new System.Drawing.Point(10, 20);"
              ]
            }
            """;

        var paste = DesignerControlEditor.PasteControl(target, clip, "this");

        Assert.True(paste.Safe, paste.Reason);
        Assert.NotEqual("submitButton", paste.Name);
        Assert.Contains($"private System.Windows.Forms.Button {paste.Name};", paste.NewText);
        Assert.Contains($"this.{paste.Name}.Name = \"{paste.Name}\";", paste.NewText);
        Assert.Contains($"this.Controls.Add(this.{paste.Name});", paste.NewText);
        Assert.Contains("private System.Windows.Forms.Button submitButton;", paste.NewText);
        Assert.Contains("this.submitButton.Name = \"submitButton\";", paste.NewText);
        Assert.DoesNotContain("private System.Windows.Forms.Button submitButton;\r\n                    private System.Windows.Forms.Button submitButton;", paste.NewText);
        Assert.DoesNotContain("this.Controls.Add(this.submitButton);\r\n                        this.Controls.Add(this.submitButton);", paste.NewText);
    }

    /// <summary>Drop whole lines from a fixture whatever the file's line endings are. A raw string literal keeps
    /// the source file's terminators, so on a fresh CRLF checkout (what CI does) a `\n`-anchored Replace silently
    /// no-ops and the "dependency missing" fixture still declares the dependency.</summary>
    private static string WithoutLines(string source, params string[] lines)
    {
        foreach (string line in lines) source = source.Replace(line + "\r\n", "").Replace(line + "\n", "");
        return source;
    }

    [Fact]
    public void ReportsUnavailableDependencyByNameAndTypeWithoutChangingTarget()
    {
        var copy = DesignerControlEditor.CopyControl(Source, "nameTextBox");
        string missingTarget = WithoutLines(CompatibleTarget,
            "private System.Windows.Forms.BindingSource customerBindingSource;",
            "this.customerBindingSource = new System.Windows.Forms.BindingSource();");

        var paste = DesignerControlEditor.PasteControl(missingTarget, copy.Clip!, "panel1");

        Assert.False(paste.Safe);
        var missing = Assert.Single(paste.MissingDependencies);
        Assert.Equal("customerBindingSource (System.Windows.Forms.BindingSource)", missing);
        Assert.Contains("unavailable dependencies", paste.Reason);
        Assert.Null(paste.NewText);
    }

    [Fact]
    public void ReportsUnavailableExtenderProviderDependency()
    {
        var copy = DesignerControlEditor.CopyControl(Source, "nameTextBox");
        string missingProvider = WithoutLines(CompatibleTarget,
            "private System.Windows.Forms.ToolTip toolTip1;",
            "this.toolTip1 = new System.Windows.Forms.ToolTip();");

        var paste = DesignerControlEditor.PasteControl(missingProvider, copy.Clip!, "panel1");

        Assert.False(paste.Safe);
        Assert.Contains("toolTip1 (System.Windows.Forms.ToolTip)", paste.MissingDependencies);
        Assert.Contains("unavailable dependencies", paste.Reason);
        Assert.Null(paste.NewText);
    }

    [Fact]
    public void ReportsTypeMismatchAndRejectsCraftedUndeclaredReference()
    {
        var copy = DesignerControlEditor.CopyControl(Source, "nameTextBox");
        string wrongType = CompatibleTarget.Replace(
            "System.Windows.Forms.BindingSource customerBindingSource",
            "System.Windows.Forms.Timer customerBindingSource");
        var mismatch = DesignerControlEditor.PasteControl(wrongType, copy.Clip!, "panel1");
        Assert.False(mismatch.Safe);
        Assert.Single(mismatch.MissingDependencies);

        string crafted = """
            {"Fqn":"System.Windows.Forms.TextBox","Name":"nameTextBox","Statements":[
              "this.nameTextBox = new System.Windows.Forms.TextBox();",
              "this.nameTextBox.DataSource = this.customerBindingSource;"
            ]}
            """;
        var undeclared = DesignerControlEditor.PasteControl(CompatibleTarget, crafted, "panel1");
        Assert.False(undeclared.Safe);
        Assert.Contains("unsupported statement", undeclared.Reason);
    }
}
