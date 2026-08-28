using System.Drawing;
using System.Drawing.Imaging;
using WinFormsDesigner.Engine;

namespace Engine.UnitTests;

public sealed class DesignerLocalizedResxEditorTests
{
    [Fact]
    public void ApplyScalarEdits_UpsertsBatchAndPreservesUnknownCommentAndBinaryNodes()
    {
        const string existing = """
<?xml version="1.0" encoding="utf-8"?>
<root>
  <!-- keep me -->
  <data name="unknown.Payload" mimetype="application/x-microsoft.net.object.binary.base64">
    <value>AAEAAAD/////</value>
  </data>
  <data name="button1.Text" xml:space="preserve">
    <value>Old</value>
  </data>
</root>
""";

        var result = DesignerLocalizedResxEditor.ApplyScalarEdits(existing, new[]
        {
            new LocalizedResourceEdit
            {
                ComponentId = "button1",
                PropertyName = "Text",
                ValueTypeName = "System.String",
                ScalarValue = "Bonjour",
            },
            new LocalizedResourceEdit
            {
                ComponentId = "this",
                PropertyName = "RightToLeftLayout",
                ValueTypeName = "System.Boolean",
                ScalarValue = "true",
            },
        });

        Assert.True(result.Ok, result.Reason);
        Assert.Contains("<!-- keep me -->", result.ResxText);
        Assert.Contains("unknown.Payload", result.ResxText);
        Assert.Contains("application/x-microsoft.net.object.binary.base64", result.ResxText);
        Assert.Contains("<value>Bonjour</value>", result.ResxText);
        Assert.Contains("name=\"$this.RightToLeftLayout\"", result.ResxText);
        Assert.Contains("<value>True</value>", result.ResxText);
        Assert.Equal(new[] { "button1.Text", "$this.RightToLeftLayout" }, result.Keys);
    }

    [Theory]
    [InlineData("\n", true)]
    [InlineData("\n", false)]
    [InlineData("\r\n", true)]
    [InlineData("\r\n", false)]
    public void ApplyScalarEdits_PreservesInputLineEndingAndTerminalNewline(string newLine, bool terminalNewline)
    {
        string existing = string.Join(newLine, new[]
        {
            "<?xml version=\"1.0\" encoding=\"utf-8\"?>",
            "<root>",
            "  <!-- keep exact structure -->",
            "  <data name=\"label1.Text\" xml:space=\"preserve\">",
            "    <value>Old</value>",
            "  </data>",
            "</root>",
        }) + (terminalNewline ? newLine : "");

        var result = DesignerLocalizedResxEditor.ApplyScalarEdits(existing, new[]
        {
            new LocalizedResourceEdit
            {
                ComponentId = "label1",
                PropertyName = "Text",
                ValueTypeName = "System.String",
                ScalarValue = "New",
            },
        });

        Assert.True(result.Ok, result.Reason);
        Assert.Equal(existing.Replace("<value>Old</value>", "<value>New</value>", StringComparison.Ordinal), result.ResxText);
    }

    [Fact]
    public void RemoveOverride_RemovesOnlyTargetDataNode()
    {
        string text = MinimalResx("""
  <data name="button1.Text" xml:space="preserve"><value>Remove</value></data>
  <data name="button2.Text" xml:space="preserve"><value>Keep</value></data>
""");

        var result = DesignerLocalizedResxEditor.ApplyEdits(text, new[]
        {
            new LocalizedResourceEdit
            {
                Kind = LocalizedResourceEditKind.RemoveOverride,
                ComponentId = "button1",
                PropertyName = "Text",
            },
        });

        Assert.True(result.Ok, result.Reason);
        Assert.DoesNotContain("button1.Text", result.ResxText);
        Assert.Contains("button2.Text", result.ResxText);
    }

    [Fact]
    public void MalformedInvalidAndOversizeInputs_AreRefused()
    {
        var malformed = DesignerLocalizedResxEditor.ApplyScalarEdits("<root><data", new[]
        {
            new LocalizedResourceEdit { ComponentId = "button1", PropertyName = "Text", ScalarValue = "x" },
        });
        Assert.False(malformed.Ok);
        Assert.Contains("malformed", malformed.Reason);

        var invalid = DesignerLocalizedResxEditor.ApplyScalarEdits(null, new[]
        {
            new LocalizedResourceEdit { ComponentId = "button1", PropertyName = "Location", ValueTypeName = "System.Drawing.Point", ScalarValue = "not a point" },
        });
        Assert.False(invalid.Ok);
        Assert.Contains("invalid invariant", invalid.Reason);

        var oversize = DesignerLocalizedResxEditor.ApplyScalarEdits(null, new[]
        {
            new LocalizedResourceEdit { ComponentId = "button1", PropertyName = "Text", ScalarValue = new string('x', 1024 * 1024 + 1) },
        });
        Assert.False(oversize.Ok);
        Assert.Contains("too large", oversize.Reason);
    }

    [Fact]
    public void UpsertImageAndIcon_UseRawByteArrayShapeAndRefuseBadBytes()
    {
        byte[] png;
        using (var bmp = new Bitmap(2, 2))
        using (var ms = new MemoryStream())
        {
            bmp.SetPixel(0, 0, Color.Red);
            bmp.Save(ms, ImageFormat.Png);
            png = ms.ToArray();
        }
        byte[] ico;
        using (var icon = (Icon)SystemIcons.Application.Clone())
        using (var ms = new MemoryStream())
        {
            icon.Save(ms);
            ico = ms.ToArray();
        }

        var ok = DesignerLocalizedResxEditor.ApplyEdits(null, new[]
        {
            new LocalizedResourceEdit
            {
                Kind = LocalizedResourceEditKind.UpsertImage,
                ComponentId = "pictureBox1",
                PropertyName = "Image",
                BinaryValue = png,
            },
            new LocalizedResourceEdit
            {
                Kind = LocalizedResourceEditKind.UpsertIcon,
                ComponentId = "",
                PropertyName = "Icon",
                BinaryValue = ico,
            },
        });
        Assert.True(ok.Ok, ok.Reason);
        Assert.Contains("pictureBox1.Image", ok.ResxText);
        Assert.Contains("$this.Icon", ok.ResxText);
        Assert.Contains("System.Drawing.Icon", ok.ResxText);
        Assert.Contains("application/x-microsoft.net.object.bytearray.base64", ok.ResxText);

        var bad = DesignerLocalizedResxEditor.ApplyEdits(null, new[]
        {
            new LocalizedResourceEdit
            {
                Kind = LocalizedResourceEditKind.UpsertImage,
                ComponentId = "pictureBox1",
                PropertyName = "Image",
                BinaryValue = new byte[] { 1, 2, 3 },
            },
        });
        Assert.False(bad.Ok);
        Assert.Contains("not a valid image", bad.Reason);
    }

    [Fact]
    public void StructuralDelete_RemovesEveryTargetKeyAndPreservesOtherComponents()
    {
        string text = MinimalResx("""
  <data name="button1.Text" xml:space="preserve"><value>Delete</value></data>
  <data name="button1.Location" type="System.Drawing.Point, System.Drawing"><value>1, 2</value></data>
  <data name="button2.Text" xml:space="preserve"><value>Keep</value></data>
  <!-- opaque vendor node stays -->
""");

        var result = DesignerLocalizedResxEditor.RemoveComponents(text, new[] { "button1" });

        Assert.True(result.Ok, result.Reason);
        Assert.DoesNotContain("button1.", result.ResxText);
        Assert.Contains("button2.Text", result.ResxText);
        Assert.Contains("opaque vendor node stays", result.ResxText);
        Assert.Equal(new[] { "button1.Text", "button1.Location" }, result.Keys);

        var noMatch = DesignerLocalizedResxEditor.RemoveComponents(text, new[] { "missing" });
        Assert.True(noMatch.Ok, noMatch.Reason);
        Assert.Equal(text, noMatch.ResxText);
        Assert.False(DesignerLocalizedResxEditor.RemoveComponents("<root><data", new[] { "button1" }).Ok);
        Assert.False(DesignerLocalizedResxEditor.RemoveComponents(text, new[] { "button1.evil" }).Ok);
    }

    private static string MinimalResx(string body) => """
<?xml version="1.0" encoding="utf-8"?>
<root>
""" + body + """
</root>
""";
}
