using WinFormsDesigner.Engine;
using Xunit;

namespace Engine.UnitTests;

/// <summary>
/// 1.9.0 — converting a plain form to a localizable one (Visual Studio's Localizable = true): localizable values
/// move into the neutral .resx behind ComponentResourceManager.ApplyResources, and everything else stays put.
/// </summary>
[Collection("Modern localization designer STA")]
public sealed class DesignerLocalizeFormTests
{
    private static readonly StaDispatcher Sta = new();

    private const string PlainForm = """
namespace Demo
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
            this.button1.Text = "Click me";
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

        #endregion

        private System.Windows.Forms.Button button1;
    }
}

""";

    private static LocalizeFormResult Convert(string source, string? resx = null)
    {
        string dir = Path.Combine(Path.GetTempPath(), "wfd-loc-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        string designer = Path.Combine(dir, "Form1.Designer.cs");
        File.WriteAllText(designer, source);
        try { return Sta.Invoke(() => DesignerRenderer.MakeLocalizable(designer, null, source, resx)); }
        finally { try { Directory.Delete(dir, true); } catch { /* best effort */ } }
    }

    [Fact]
    public void PlainForm_BecomesResourceDriven()
    {
        var result = Convert(PlainForm);
        Assert.True(result.Safe, result.Reason);
        string text = result.NewText!.Replace("\r\n", "\n");

        // The manager is declared first, and each component's localizable values are read back through it.
        Assert.Contains("System.ComponentModel.ComponentResourceManager resources = new System.ComponentModel.ComponentResourceManager(typeof(Form1));", text);
        Assert.Contains("resources.ApplyResources(this.button1, \"button1\");", text);
        Assert.Contains("resources.ApplyResources(this, \"$this\");", text);

        // Localizable assignments are gone from code...
        Assert.DoesNotContain("this.button1.Text = \"Click me\";", text);
        Assert.DoesNotContain("this.button1.Location", text);
        Assert.DoesNotContain("this.button1.Size", text);
        Assert.DoesNotContain("this.Text = \"Form1\";", text);
        Assert.DoesNotContain("this.ClientSize", text);
        // TabIndex is [Localizable] in WinForms — a right-to-left translation may reorder the tab sequence — so
        // Visual Studio moves it into resources too.
        Assert.DoesNotContain("this.button1.TabIndex", text);
        Assert.Contains("button1.TabIndex", result.ResxText!);
        // ...and non-localizable state is untouched, exactly as Visual Studio leaves it.
        Assert.Contains("this.button1.Name = \"button1\";", text);
        Assert.Contains("this.button1.UseVisualStyleBackColor = true;", text);
        Assert.Contains("this.Controls.Add(this.button1);", text);
        Assert.Contains("this.Name = \"Form1\";", text);
        Assert.Contains("this.SuspendLayout();", text);
        Assert.Contains("this.ResumeLayout(false);", text);
        Assert.Contains("this.button1 = new System.Windows.Forms.Button();", text);

        // Every moved value is in the neutral .resx under Visual Studio's own key names.
        Assert.Contains("button1.Text", result.ResxText!);
        Assert.Contains("Click me", result.ResxText!);
        Assert.Contains("$this.Text", result.ResxText!);
        Assert.Contains("button1.Location", result.ResxText!);
        Assert.Contains("$this.ClientSize", result.ResxText!);
        Assert.Contains("button1.Text", result.Keys);
        Assert.Contains("$this.ClientSize", result.Keys);
    }

    [Fact]
    public void ConvertedForm_IsRecognizedAsLocalizableAndRendersTheSameValues()
    {
        var result = Convert(PlainForm);
        Assert.True(result.Safe, result.Reason);

        // The converted source is what the extension's own localizable detector looks for.
        Assert.Contains("ApplyResources", result.NewText!);

        // Converting twice is refused — the form is already resource-driven.
        var second = Convert(result.NewText!);
        Assert.False(second.Safe);
        Assert.Contains("already localizable", second.Reason);
    }

    [Fact]
    public void FormWithNothingToLocalize_IsRefusedInsteadOfRewritten()
    {
        const string bare = """
namespace Demo
{
    partial class Form1
    {
        private void InitializeComponent()
        {
            this.SuspendLayout();
            this.Name = "Form1";
            this.ResumeLayout(false);
        }
    }
}

""";
        var result = Convert(bare);
        Assert.False(result.Safe);
        Assert.Null(result.NewText);
    }
}
