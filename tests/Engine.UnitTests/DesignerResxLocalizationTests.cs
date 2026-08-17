using System.Drawing;
using System.Windows.Forms;
using WinFormsDesigner.Engine;

namespace Engine.UnitTests;

[CollectionDefinition("Modern localization designer STA", DisableParallelization = true)]
public sealed class ModernLocalizationDesignerStaCollection { }

[Collection("Modern localization designer STA")]
public sealed class DesignerResxLocalizationTests
{
    private static readonly StaDispatcher Sta = new();

    [Fact]
    public void CultureSelection_NormalizesAndStoresPerDesignerPath()
    {
        string a = Path.Combine(Path.GetTempPath(), Guid.NewGuid() + ".Designer.cs");
        string b = Path.Combine(Path.GetTempPath(), Guid.NewGuid() + ".Designer.cs");

        Assert.True(DesignerCultureSelection.TrySetCultureName(a, "fr-fr", out var normalized, out var reason), reason);
        Assert.Equal("fr-FR", normalized);
        Assert.Equal("fr-FR", DesignerCultureSelection.GetCultureName(a));
        Assert.Equal("", DesignerCultureSelection.GetCultureName(b));

        Assert.True(DesignerCultureSelection.TrySetCultureName(a, "neutral", out normalized, out reason), reason);
        Assert.Equal("", normalized);
        Assert.Equal("", DesignerCultureSelection.GetCultureName(a));

        Assert.False(DesignerCultureSelection.TrySetCultureName(a, "not a culture!", out _, out reason));
        Assert.Contains("invalid culture", reason);

        // A well-formed but non-existent tag is rejected too: ICU would happily manufacture "en-EN", and the
        // resulting Form.en-EN.resx is a file no ResourceManager ever loads.
        Assert.False(DesignerCultureSelection.TrySetCultureName(a, "en-EN", out _, out reason));
        Assert.Contains("invalid culture", reason);
        Assert.True(DesignerCultureSelection.TrySetCultureName(a, "en-US", out normalized, out reason), reason);
        Assert.Equal("en-US", normalized);
        Assert.True(DesignerCultureSelection.TrySetCultureName(a, "", out _, out reason), reason);
    }

    [Fact]
    public void Resolver_OverlaysNeutralParentAndExactCulture()
    {
        WithTempDesigner("""
namespace Sample
{
    partial class Form1
    {
        private System.Windows.Forms.Button button1;
        private void InitializeComponent()
        {
            this.button1 = new System.Windows.Forms.Button();
        }
    }
}
""",
            new Dictionary<string, string>
            {
                ["Form1.resx"] = Resx("""
  <data name="button1.Text" xml:space="preserve"><value>Neutral</value></data>
  <data name="button1.Size" type="System.Drawing.Size, System.Drawing"><value>120, 32</value></data>
"""),
                ["Form1.fr.resx"] = Resx("""
  <data name="button1.Text" xml:space="preserve"><value>Parent FR</value></data>
"""),
                ["Form1.fr-FR.resx"] = Resx("""
  <data name="button1.Location" type="System.Drawing.Point, System.Drawing"><value>10, 20</value></data>
"""),
            },
            file =>
            {
                var resolver = ResxResolver.TryLoadForDesigner(file, "fr-FR");
                Assert.NotNull(resolver);
                using var button = new Button();
                Assert.True(resolver!.ApplyResources(button, "button1"));
                Assert.Equal("Parent FR", button.Text);
                Assert.Equal(new Size(120, 32), button.Size);
                Assert.Equal(new Point(10, 20), button.Location);
            });
    }

    [Fact]
    public void Resolver_AppliesFrenchAndArabicSampleResources()
    {
        string sample = SamplePath("LocalizableForm.Designer.cs");
        var fr = ResxResolver.TryLoadForDesigner(sample, "fr-FR");
        Assert.NotNull(fr);
        using var button = new Button();
        Assert.True(fr!.ApplyResources(button, "button1"));
        Assert.Equal("Cliquez-moi", button.Text);

        var ar = ResxResolver.TryLoadForDesigner(sample, "ar-SA");
        Assert.NotNull(ar);
        using var form = new Form();
        Assert.True(ar!.ApplyResources(form, "$this"));
        Assert.Equal(RightToLeft.Yes, form.RightToLeft);
        Assert.True(form.RightToLeftLayout);
        Assert.Equal("نموذج قابل للتعريب", form.Text);
    }

    [Fact]
    public void Resolver_UnsafeApplyResourcesNodeRefusesWholeTarget()
    {
        WithTempDesigner("""
namespace Sample { partial class Form1 { private void InitializeComponent() { } } }
""",
            new Dictionary<string, string>
            {
                ["Form1.resx"] = Resx("""
  <data name="button1.Text" xml:space="preserve"><value>Safe text</value></data>
  <data name="button1.Image" mimetype="application/x-microsoft.net.object.binary.base64"><value>AAEAAAD/////</value></data>
"""),
            },
            file =>
            {
                var resolver = ResxResolver.TryLoadForDesigner(file);
                Assert.NotNull(resolver);
                using var button = new Button { Text = "Before" };
                Assert.False(resolver!.ApplyResources(button, "button1"));
                Assert.Equal("Before", button.Text);
            });
    }

    [Fact]
    public void Renderer_RecognizesApplyResourcesAsRepresentable()
    {
        string sampleDesigner = SamplePath("LocalizableForm.Designer.cs");
        string sampleDir = Path.GetDirectoryName(sampleDesigner)!;
        string tempDir = Path.Combine(Path.GetTempPath(), "csharp-winform-loc-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(tempDir);
        try
        {
            foreach (var file in Directory.GetFiles(sampleDir, "LocalizableForm*.resx"))
                File.Copy(file, Path.Combine(tempDir, Path.GetFileName(file)));
            string tempDesigner = Path.Combine(tempDir, "LocalizableForm.Designer.cs");
            File.Copy(sampleDesigner, tempDesigner);

            Assert.True(DesignerCultureSelection.TrySetCultureName(tempDesigner, "fr-FR", out _, out var reason), reason);
            var layout = Sta.Invoke(() => DesignerRenderer.RenderWithLayout(tempDesigner));

            Assert.DoesNotContain(layout.Unrepresentable, u => u.Contains("ApplyResources", StringComparison.Ordinal));
            Assert.Equal(layout.TotalStatements, layout.Representable);

            var neutralButton = Assert.Single(layout.Controls, c => c.Id == "button1");
            Assert.True(DesignerCultureSelection.TrySetCultureName(tempDesigner, "ar-SA", out _, out reason), reason);
            var rtl = Sta.Invoke(() => DesignerRenderer.RenderWithLayout(tempDesigner));
            var rtlButton = Assert.Single(rtl.Controls, c => c.Id == "button1");
            Assert.True(rtlButton.X > neutralButton.X, $"RTL layout did not mirror button1: {neutralButton.X} -> {rtlButton.X}");
            Assert.Equal(neutralButton.Width, rtlButton.Width);
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static void WithTempDesigner(string designerText, IReadOnlyDictionary<string, string> resxFiles, Action<string> test)
    {
        string dir = Path.Combine(Path.GetTempPath(), "csharp-winform-loc-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        try
        {
            string file = Path.Combine(dir, "Form1.Designer.cs");
            File.WriteAllText(file, designerText);
            foreach (var kv in resxFiles) File.WriteAllText(Path.Combine(dir, kv.Key), kv.Value);
            test(file);
        }
        finally
        {
            try { Directory.Delete(dir, recursive: true); } catch { }
        }
    }

    private static string Resx(string body) => """
<?xml version="1.0" encoding="utf-8"?>
<root>
  <resheader name="resmimetype"><value>text/microsoft-resx</value></resheader>
  <resheader name="version"><value>2.0</value></resheader>
  <resheader name="reader"><value>System.Resources.ResXResourceReader, System.Windows.Forms</value></resheader>
  <resheader name="writer"><value>System.Resources.ResXResourceWriter, System.Windows.Forms</value></resheader>
""" + body + """
</root>
""";

    private static string SamplePath(string fileName)
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null)
        {
            string candidate = Path.Combine(dir.FullName, "engine", "samples", fileName);
            if (File.Exists(candidate)) return candidate;
            dir = dir.Parent;
        }
        throw new DirectoryNotFoundException("Could not find engine/samples/" + fileName);
    }
}
