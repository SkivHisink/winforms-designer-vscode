using System;
using System.Text;
using WinFormsDesigner.Engine;
using Xunit;

namespace Engine.UnitTests;

public sealed class DesignerImageListEditorTests
{
    private static readonly string Blob =
        Convert.ToBase64String(Encoding.ASCII.GetBytes("safe ImageListStreamer test payload"));

    private const string Source = """
namespace Sample
{
    partial class Form1
    {
        private System.Windows.Forms.ImageList imageList1;
        private System.Windows.Forms.ImageList otherImages;
        private System.Windows.Forms.Button button1;
        private System.Windows.Forms.Button button2;

        private void InitializeComponent()
        {
            this.imageList1 = new System.Windows.Forms.ImageList();
            this.otherImages = new System.Windows.Forms.ImageList();
            this.button1 = new System.Windows.Forms.Button();
            this.button2 = new System.Windows.Forms.Button();
            this.button1.ImageList = this.imageList1;
            this.button1.ImageIndex = 0;
            this.button1.ImageKey = "first";
            this.button2.ImageList = this.otherImages;
            this.button2.ImageIndex = 0;
            this.button2.ImageKey = "first";
        }
    }
}
""";

    [Fact]
    public void SetImages_ReorderAndRename_ReconcilesAttachedControlReferencesOnly()
    {
        var result = DesignerImageListEditor.SetImages(
            Source, "imageList1", null, Blob,
            new[] { "second", "renamed" },
            new[] { "first", "second" },
            new[] { 1, 0 });

        Assert.True(result.Ok, result.Reason);
        Assert.NotNull(result.DesignerText);
        Assert.Contains("this.button1.ImageIndex = 1;", result.DesignerText);
        Assert.Contains("this.button1.ImageKey = \"renamed\";", result.DesignerText);
        Assert.Contains("this.button2.ImageIndex = 0;", result.DesignerText);
        Assert.Contains("this.button2.ImageKey = \"first\";", result.DesignerText);
        Assert.Contains("this.imageList1.Images.SetKeyName(0, \"second\");", result.DesignerText);
        Assert.Contains("this.imageList1.Images.SetKeyName(1, \"renamed\");", result.DesignerText);
    }

    [Fact]
    public void SetImages_RemoveReferencedImage_ClearsIndexAndKey()
    {
        var result = DesignerImageListEditor.SetImages(
            Source, "imageList1", null, Blob,
            new[] { "second" },
            new[] { "first", "second" },
            new[] { 1 });

        Assert.True(result.Ok, result.Reason);
        Assert.Contains("this.button1.ImageIndex = -1;", result.DesignerText);
        Assert.Contains("this.button1.ImageKey = \"\";", result.DesignerText);
    }

    [Fact]
    public void SetImages_DuplicateOldKeyWithDifferentOutcomes_RefusesInsteadOfGuessing()
    {
        var result = DesignerImageListEditor.SetImages(
            Source, "imageList1", null, Blob,
            new[] { "left", "right" },
            new[] { "first", "first" },
            new[] { 0, 1 });

        Assert.False(result.Ok);
        Assert.Contains("ambiguous", result.Reason);
    }
}
