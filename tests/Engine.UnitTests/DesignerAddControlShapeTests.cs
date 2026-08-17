using WinFormsDesigner.Engine;
using Xunit;

namespace Engine.UnitTests;

/// <summary>
/// 1.9.0 — the code a dropped control produces must match what Visual Studio's designer writes: VS field naming,
/// constructors as one leading run, a commented property block per control, Controls.Add newest-first (z-order),
/// the layout scaffold and form members on a form that has none, and the field below the generated-code region.
/// </summary>
public sealed class DesignerAddControlShapeTests
{
    private const string ScaffoldedForm = """
namespace DemoApp
{
    partial class Form1
    {
        /// <summary>
        /// Required designer variable.
        /// </summary>
        private System.ComponentModel.IContainer components = null;

        /// <summary>
        /// Clean up any resources being used.
        /// </summary>
        /// <param name="disposing">true if managed resources should be disposed; otherwise, false.</param>
        protected override void Dispose(bool disposing)
        {
            if (disposing && (components != null))
            {
                components.Dispose();
            }
            base.Dispose(disposing);
        }

        #region Windows Form Designer generated code

        /// <summary>
        /// Required method for Designer support - do not modify
        /// the contents of this method with the code editor.
        /// </summary>
        private void InitializeComponent()
        {
            this.components = new System.ComponentModel.Container();
            this.AutoScaleMode = System.Windows.Forms.AutoScaleMode.Font;
            this.ClientSize = new System.Drawing.Size(800, 450);
            this.Text = "Form1";
        }

        #endregion
    }
}

""";

    [Fact]
    public void AddControl_UsesVisualStudioFieldNames()
    {
        var check = DesignerControlEditor.AddControl(ScaffoldedForm, "this", "CheckBox");
        Assert.True(check.Safe, check.Reason);
        Assert.Equal("checkBox1", check.Name); // not "checkbox1"

        var grid = DesignerControlEditor.AddControl(ScaffoldedForm, "this", "DataGridView");
        Assert.True(grid.Safe, grid.Reason);
        Assert.Equal("dataGridView1", grid.Name);
    }

    [Fact]
    public void FirstDrop_ProducesTheVisualStudioMethodShape()
    {
        var result = DesignerControlEditor.AddControl(ScaffoldedForm, "this", "Button", null, 124, 80);
        Assert.True(result.Safe, result.Reason);

        Assert.Contains("""
            this.components = new System.ComponentModel.Container();
            this.button1 = new System.Windows.Forms.Button();
            this.SuspendLayout();
            //
            // button1
            //
            this.button1.Location = new System.Drawing.Point(124, 80);
            this.button1.Name = "button1";
            this.button1.Size = new System.Drawing.Size(75, 23);
            this.button1.TabIndex = 0;
            this.button1.Text = "button1";
            this.button1.UseVisualStyleBackColor = true;
            //
            // Form1
            //
            this.AutoScaleMode = System.Windows.Forms.AutoScaleMode.Font;
            this.ClientSize = new System.Drawing.Size(800, 450);
            this.Controls.Add(this.button1);
            this.Name = "Form1";
            this.Text = "Form1";
            this.ResumeLayout(false);
        }
""", Normalized(result.NewText!));

        // The field goes below #endregion, where Visual Studio keeps control fields.
        Assert.Contains("""
        #endregion

        private System.Windows.Forms.Button button1;
""", Normalized(result.NewText!));
    }

    [Fact]
    public void FirstDrop_PersistsTheLiveAutoScalePair()
    {
        // The value comes from the rendering engine's live form, so a net4x form records 6,13 and a modern one 7,15.
        var framework = DesignerControlEditor.AddControl(ScaffoldedForm, "this", "Button", null, 10, 10, "6F, 13F");
        Assert.True(framework.Safe, framework.Reason);
        Assert.Contains("""
            this.AutoScaleDimensions = new System.Drawing.SizeF(6F, 13F);
            this.AutoScaleMode = System.Windows.Forms.AutoScaleMode.Font;
""", Normalized(framework.NewText!));

        var modern = DesignerControlEditor.AddControl(ScaffoldedForm, "this", "Button", null, 10, 10, "7F, 15F");
        Assert.True(modern.Safe, modern.Reason);
        Assert.Contains("this.AutoScaleDimensions = new System.Drawing.SizeF(7F, 15F);", modern.NewText!);

        // A second drop must not add a second pair.
        var second = DesignerControlEditor.AddControl(modern.NewText!, "this", "Label", null, 20, 20, "7F, 15F");
        Assert.True(second.Safe, second.Reason);
        Assert.Single(AllIndexesOf(second.NewText!, "this.AutoScaleDimensions"));

        // Anything that is not the designer's own literal pair never reaches generated source.
        foreach (var bogus in new[] { "7, 15", "0F, 0F);this.Close(", "7F,15F", "" })
        {
            var rejected = DesignerControlEditor.AddControl(ScaffoldedForm, "this", "Button", null, 10, 10, bogus);
            Assert.True(rejected.Safe, rejected.Reason);
            Assert.DoesNotContain("AutoScaleDimensions", rejected.NewText!);
        }
    }

    /// <summary>Text-sized controls arrive with AutoSize on, as Visual Studio's designers set them, and the form
    /// then gains the PerformLayout() that ResumeLayout(false) needs to actually lay them out.</summary>
    [Fact]
    public void TextSizedControls_ArriveAutoSizedWithPerformLayout()
    {
        var check = DesignerControlEditor.AddControl(ScaffoldedForm, "this", "CheckBox", null, 168, 143);
        Assert.True(check.Safe, check.Reason);
        Assert.Contains("""
            this.checkBox1.AutoSize = true;
            this.checkBox1.Location = new System.Drawing.Point(168, 143);
""", Normalized(check.NewText!));
        Assert.Contains("""
            this.ResumeLayout(false);
            this.PerformLayout();
""", Normalized(check.NewText!));

        // A second text-sized control does not add a second PerformLayout.
        var label = DesignerControlEditor.AddControl(check.NewText!, "this", "Label", null, 10, 10);
        Assert.True(label.Safe, label.Reason);
        Assert.Single(AllIndexesOf(label.NewText!, "this.PerformLayout();"));

        // A control that sizes itself from a designed Size gets neither.
        var button = DesignerControlEditor.AddControl(ScaffoldedForm, "this", "Button", null, 10, 10);
        Assert.True(button.Safe, button.Reason);
        Assert.DoesNotContain("AutoSize", button.NewText!);
        Assert.DoesNotContain("PerformLayout", button.NewText!);
    }

    [Fact]
    public void SecondDrop_AddsNewestFirstForZOrderAndReusesTheExistingScaffold()
    {
        var first = DesignerControlEditor.AddControl(ScaffoldedForm, "this", "Button", null, 124, 80);
        Assert.True(first.Safe, first.Reason);
        var second = DesignerControlEditor.AddControl(first.NewText!, "this", "CheckBox", null, 168, 143);
        Assert.True(second.Safe, second.Reason);
        string text = Normalized(second.NewText!);

        // Constructors stay one run; the newest Add comes FIRST so the new control is on top, as in VS.
        Assert.Contains("""
            this.button1 = new System.Windows.Forms.Button();
            this.checkBox1 = new System.Windows.Forms.CheckBox();
            this.SuspendLayout();
""", text);
        Assert.Contains("""
            this.Controls.Add(this.checkBox1);
            this.Controls.Add(this.button1);
""", text);
        // Each control keeps its own header, and the form's block header is written once.
        Assert.Single(AllIndexesOf(text, "// checkBox1"));
        Assert.Single(AllIndexesOf(text, "// Form1"));
        // Exactly one scaffold and one Name, no matter how many controls are dropped.
        Assert.Single(AllIndexesOf(text, "this.SuspendLayout();"));
        Assert.Single(AllIndexesOf(text, "this.ResumeLayout(false);"));
        Assert.Single(AllIndexesOf(text, "this.Name = \"Form1\";"));
        Assert.Contains("""
        private System.Windows.Forms.Button button1;
        private System.Windows.Forms.CheckBox checkBox1;
""", text);
    }

    /// <summary>A form Visual Studio itself generated must be added to in place, never rearranged.</summary>
    [Fact]
    public void VisualStudioForm_KeepsItsOwnShape()
    {
        const string vsForm = """
namespace Sample
{
    partial class Form1
    {
        private System.ComponentModel.IContainer components = null;

        #region Windows Form Designer generated code

        private void InitializeComponent()
        {
            this.button1 = new System.Windows.Forms.Button();
            this.SuspendLayout();
            //
            // button1
            //
            this.button1.Location = new System.Drawing.Point(124, 80);
            this.button1.Name = "button1";
            this.button1.Size = new System.Drawing.Size(75, 23);
            this.button1.TabIndex = 0;
            this.button1.Text = "button1";
            this.button1.UseVisualStyleBackColor = true;
            //
            // Form1
            //
            this.AutoScaleDimensions = new System.Drawing.SizeF(6F, 13F);
            this.AutoScaleMode = System.Windows.Forms.AutoScaleMode.Font;
            this.ClientSize = new System.Drawing.Size(800, 450);
            this.Controls.Add(this.button1);
            this.Name = "Form1";
            this.Text = "Form1";
            this.ResumeLayout(false);
        }

        #endregion

        private System.Windows.Forms.Button button1;
    }
}

""";
        var result = DesignerControlEditor.AddControl(vsForm, "this", "TextBox", null, 30, 40, "7F, 15F");
        Assert.True(result.Safe, result.Reason);
        string text = Normalized(result.NewText!);

        Assert.Contains("""
            this.button1 = new System.Windows.Forms.Button();
            this.textBox1 = new System.Windows.Forms.TextBox();
            this.SuspendLayout();
""", text);
        Assert.Contains("""
            this.Controls.Add(this.textBox1);
            this.Controls.Add(this.button1);
            this.Name = "Form1";
""", text);
        // The new block lands above the form's block, under its own header.
        Assert.Contains("""
            //
            // textBox1
            //
            this.textBox1.Location = new System.Drawing.Point(30, 40);
""", text);
        // Nothing the form already had is duplicated or replaced.
        Assert.Single(AllIndexesOf(text, "this.SuspendLayout();"));
        Assert.Single(AllIndexesOf(text, "// Form1"));
        Assert.Single(AllIndexesOf(text, "this.Name = \"Form1\";"));
        Assert.Contains("this.AutoScaleDimensions = new System.Drawing.SizeF(6F, 13F);", text);
        Assert.Single(AllIndexesOf(text, "this.AutoScaleDimensions"));
    }

    [Fact]
    public void ChildControl_LandsInItsParentBlock()
    {
        var withPanel = DesignerControlEditor.AddControl(ScaffoldedForm, "this", "Panel", null, 10, 10);
        Assert.True(withPanel.Safe, withPanel.Reason);
        var child = DesignerControlEditor.AddControl(withPanel.NewText!, "panel1", "Button", null, 5, 5);
        Assert.True(child.Safe, child.Reason);
        string text = Normalized(child.NewText!);

        // The child's own block precedes its parent's, and its Add lands on the parent.
        Assert.True(text.IndexOf("// button1", System.StringComparison.Ordinal)
            < text.IndexOf("// panel1", System.StringComparison.Ordinal));
        Assert.Contains("this.panel1.Controls.Add(this.button1);", text);
        Assert.DoesNotContain("this.Controls.Add(this.button1);", text);
    }

    /// <summary>Trailing spaces (Visual Studio writes "// " headers) are irrelevant to these assertions.</summary>
    private static string Normalized(string text) =>
        string.Join("\n", text.Replace("\r\n", "\n").Split('\n').Select(line => line.TrimEnd()));

    private static List<int> AllIndexesOf(string haystack, string needle)
    {
        var found = new List<int>();
        for (int i = haystack.IndexOf(needle, System.StringComparison.Ordinal); i >= 0;
             i = haystack.IndexOf(needle, i + needle.Length, System.StringComparison.Ordinal))
        {
            found.Add(i);
        }
        return found;
    }
}
