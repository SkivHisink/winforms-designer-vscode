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
    public void ReportsUnavailableDependencyByNameAndTypeWithoutChangingTarget()
    {
        var copy = DesignerControlEditor.CopyControl(Source, "nameTextBox");
        string missingTarget = CompatibleTarget
            .Replace("private System.Windows.Forms.BindingSource customerBindingSource;\n", "")
            .Replace("this.customerBindingSource = new System.Windows.Forms.BindingSource();\n", "");

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
        string missingProvider = CompatibleTarget
            .Replace("private System.Windows.Forms.ToolTip toolTip1;\n", "")
            .Replace("this.toolTip1 = new System.Windows.Forms.ToolTip();\n", "");

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
