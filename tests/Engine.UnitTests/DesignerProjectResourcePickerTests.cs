using System.Linq;
using WinFormsDesigner.Engine;

namespace Engine.UnitTests;

public sealed class DesignerProjectResourcePickerTests
{
    private const string Png1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

    private const string Resx = """
<?xml version="1.0" encoding="utf-8"?>
<root>
  <resheader name="resmimetype"><value>text/microsoft-resx</value></resheader>
  <resheader name="version"><value>2.0</value></resheader>
  <data name="Logo" type="System.Drawing.Bitmap, System.Drawing.Common" mimetype="application/x-microsoft.net.object.bytearray.base64">
    <value>iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=</value>
  </data>
  <data name="OpenIcon" type="System.Resources.ResXFileRef, System.Windows.Forms">
    <value>..\Resources\open.ico;System.Drawing.Icon, System.Drawing.Common</value>
  </data>
  <data name="Caption" type="System.String, mscorlib"><value>Not an image</value></data>
  <data name="BinaryBlob" mimetype="application/x-microsoft.net.object.binary.base64"><value>AQID</value></data>
</root>
""";

    private const string ResourcesDesigner = """
namespace Demo.Properties {
  internal class Resources {
    private static global::System.Resources.ResourceManager resourceMan;
    private static global::System.Globalization.CultureInfo resourceCulture;
    internal static global::System.Resources.ResourceManager ResourceManager {
      get {
        if (object.ReferenceEquals(resourceMan, null)) {
          global::System.Resources.ResourceManager temp = new global::System.Resources.ResourceManager("Demo.Properties.Resources", typeof(Resources).Assembly);
          resourceMan = temp;
        }
        return resourceMan;
      }
    }
    internal static global::System.Drawing.Bitmap Logo {
      get {
        object obj = ResourceManager.GetObject("Logo", resourceCulture);
        return ((global::System.Drawing.Bitmap)(obj));
      }
    }
    internal static global::System.Drawing.Icon OpenIcon {
      get {
        object obj = ResourceManager.GetObject("OpenIcon", resourceCulture);
        return ((global::System.Drawing.Icon)(obj));
      }
    }
    internal static string Caption {
      get { return ResourceManager.GetString("Caption", resourceCulture); }
    }
  }
}
""";

    private const string FormSource = """
namespace Demo {
  partial class Form1 {
    private System.Windows.Forms.PictureBox pictureBox1;
    private void InitializeComponent() {
      this.pictureBox1 = new System.Windows.Forms.PictureBox();
      this.pictureBox1.Name = "pictureBox1";
      this.pictureBox1.Size = new System.Drawing.Size(32, 32);
      this.Controls.Add(this.pictureBox1);
    }
  }
}
""";

    [Fact]
    public void ListImageResources_CrossChecksBytearrayAndFileRefMetadataWithoutMaterializingFiles()
    {
        var result = DesignerProjectResourcePicker.ListImageResources(Resx, ResourcesDesigner);

        Assert.True(result.Ok, result.Reason);
        Assert.Equal(2, result.Candidates.Count);
        Assert.Contains(result.Candidates, c => c.Key == "Logo"
            && c.PropertyName == "Logo"
            && c.ResourceClassFullName == "Demo.Properties.Resources"
            && c.ValueTypeName == "System.Drawing.Bitmap"
            && c.StorageKind == "bytearray");
        Assert.Contains(result.Candidates, c => c.Key == "OpenIcon"
            && c.ValueTypeName == "System.Drawing.Icon"
            && c.StorageKind == "fileRef");
        Assert.DoesNotContain(result.Candidates, c => c.Key == "Caption" || c.Key == "BinaryBlob");
    }

    [Fact]
    public void BindProjectImageResource_EditsOnlyTheDesignerPropertyExpression()
    {
        var result = DesignerRenderer.ApplyProjectImageResource(
            "unused.Designer.cs",
            "pictureBox1",
            "Image",
            "System.Drawing.Image",
            Resx,
            ResourcesDesigner,
            "Demo.Properties.Resources",
            "Logo",
            FormSource);

        Assert.True(result.Safe, result.Reason);
        Assert.Contains("this.pictureBox1.Image = global::Demo.Properties.Resources.Logo;", result.NewText);
        Assert.DoesNotContain("resources.GetObject", result.NewText);
        Assert.DoesNotContain(Png1x1, result.NewText);
    }

    [Fact]
    public void ListImageResources_RejectsMalformedXml()
    {
        var result = DesignerProjectResourcePicker.ListImageResources("<root><data name=\"Logo\"", ResourcesDesigner);

        Assert.False(result.Ok);
        Assert.Contains("malformed", result.Reason);
    }

    [Fact]
    public void ListImageResources_RejectsMismatchedGeneratedPropertyAndResxMetadataTypes()
    {
        string badResx = Resx.Replace("System.Drawing.Bitmap, System.Drawing.Common", "System.Drawing.Icon, System.Drawing.Common");
        var result = DesignerProjectResourcePicker.ListImageResources(badResx, ResourcesDesigner);

        Assert.False(result.Ok);
        Assert.Contains("type does not match", result.Reason);
    }

    [Theory]
    [InlineData("Demo.Properties.Resources;this.evil", "Logo")]
    [InlineData("Demo.Properties.Resources", "Logo);this.evil=1")]
    public void BindProjectImageResource_RejectsInjectionShapedNames(string className, string propertyName)
    {
        string? expr = DesignerProjectResourcePicker.BuildResourceExpression(
            Resx, ResourcesDesigner, className, propertyName, "System.Drawing.Image", out string reason);

        Assert.Null(expr);
        Assert.NotEmpty(reason);
    }

    [Fact]
    public void BindProjectImageResource_RejectsUnknownResource()
    {
        string? expr = DesignerProjectResourcePicker.BuildResourceExpression(
            Resx, ResourcesDesigner, "Demo.Properties.Resources", "Missing", "System.Drawing.Image", out string reason);

        Assert.Null(expr);
        Assert.Contains("not found", reason);
    }

    [Fact]
    public void BindProjectImageResource_RejectsTargetTypeMismatch()
    {
        string? expr = DesignerProjectResourcePicker.BuildResourceExpression(
            Resx, ResourcesDesigner, "Demo.Properties.Resources", "Logo", "System.Drawing.Icon", out string reason);

        Assert.Null(expr);
        Assert.Contains("cannot be assigned", reason);
    }

    [Fact]
    public void ListImageResources_RejectsAmbiguousGeneratedResourceProperties()
    {
        string ambiguousSource = ResourcesDesigner.Replace(
            "internal static string Caption",
            "internal static global::System.Drawing.Bitmap LogoAlias { get { return ((global::System.Drawing.Bitmap)(ResourceManager.GetObject(\"Logo\", resourceCulture))); } }\n    internal static string Caption");

        var result = DesignerProjectResourcePicker.ListImageResources(Resx, ambiguousSource);

        Assert.False(result.Ok);
        Assert.Contains("multiple", result.Reason);
    }

    [Fact]
    public void ListImageResources_RejectsGetterWithSideEffects()
    {
        string unsafeSource = ResourcesDesigner.Replace(
            "object obj = ResourceManager.GetObject(\"Logo\", resourceCulture);",
            "System.Console.WriteLine(\"side effect\");\n        object obj = ResourceManager.GetObject(\"Logo\", resourceCulture);");

        var result = DesignerProjectResourcePicker.ListImageResources(Resx, unsafeSource);

        Assert.True(result.Ok, result.Reason);
        Assert.DoesNotContain(result.Candidates, c => c.PropertyName == "Logo");
        Assert.Contains(result.Candidates, c => c.PropertyName == "OpenIcon");
    }

    [Fact]
    public void ListImageResources_RejectsNonResourceManagerGetObjectReceiver()
    {
        string unsafeSource = ResourcesDesigner.Replace(
            "ResourceManager.GetObject(\"Logo\", resourceCulture)",
            "SomeOther.GetObject(\"Logo\", resourceCulture)");

        var result = DesignerProjectResourcePicker.ListImageResources(Resx, unsafeSource);

        Assert.True(result.Ok, result.Reason);
        Assert.DoesNotContain(result.Candidates, c => c.PropertyName == "Logo");
        Assert.Contains(result.Candidates, c => c.PropertyName == "OpenIcon");
    }

    [Fact]
    public void BindProjectImageResource_RejectsWhenOnlyMatchingAccessorIsNonCanonical()
    {
        string unsafeSource = ResourcesDesigner.Replace(
            "ResourceManager.GetObject(\"Logo\", resourceCulture)",
            "SomeOther.GetObject(\"Logo\", resourceCulture)");

        string? expr = DesignerProjectResourcePicker.BuildResourceExpression(
            Resx, unsafeSource, "Demo.Properties.Resources", "Logo", "System.Drawing.Image", out string reason);

        Assert.Null(expr);
        Assert.Contains("not found", reason);
    }

    [Fact]
    public void ListImageResources_RejectsResourceClassWithStaticConstructor()
    {
        string unsafeSource = ResourcesDesigner.Replace(
            "internal class Resources {",
            "internal class Resources {\n    static Resources() { System.Console.WriteLine(\"side effect\"); }");

        var result = DesignerProjectResourcePicker.ListImageResources(Resx, unsafeSource);

        Assert.False(result.Ok);
        Assert.Empty(result.Candidates);
    }

    [Fact]
    public void ListImageResources_RejectsResourceClassWithStaticFieldInitializer()
    {
        string unsafeSource = ResourcesDesigner.Replace(
            "internal class Resources {",
            "internal class Resources {\n    private static object evil = System.Console.Out;");

        var result = DesignerProjectResourcePicker.ListImageResources(Resx, unsafeSource);

        Assert.False(result.Ok);
        Assert.Empty(result.Candidates);
    }

    [Fact]
    public void ListImageResources_RejectsNonCanonicalResourceManagerGetter()
    {
        string unsafeSource = ResourcesDesigner.Replace(
            "if (object.ReferenceEquals(resourceMan, null)) {",
            "System.Console.WriteLine(\"side effect\");\n        if (object.ReferenceEquals(resourceMan, null)) {");

        var result = DesignerProjectResourcePicker.ListImageResources(Resx, unsafeSource);

        Assert.False(result.Ok);
        Assert.Empty(result.Candidates);
    }
}
