using System.Drawing;
using System.Windows.Forms;
using WinFormsDesigner.Engine;

namespace Engine.UnitTests;

// The interpreted resx resolver serves allowlisted invariant scalars and bounded raw image/icon bytes. It REFUSES
// binary/SOAP/object-serialized/ResXFileRef nodes (BinaryFormatter is never invoked on repo-controlled bytes).
public sealed class SafeResxResolverTests
{
    private const string Resx = @"<root>
  <data name='greeting' xml:space='preserve'><value>Hello</value></data>
  <data name='explicitString' type='System.String, mscorlib'><value>Typed but safe</value></data>
  <data name='binaryBlob' mimetype='application/x-microsoft.net.object.binary.base64'><value>AAEAAAD/////</value></data>
  <data name='soapBlob' mimetype='application/x-microsoft.net.object.soap.base64'><value>xxx</value></data>
  <data name='fileRef' type='System.Resources.ResXFileRef, System.Windows.Forms'><value>evil.bin;System.Byte[]</value></data>
  <data name='serializedIcon' type='System.Drawing.Icon, System.Drawing'><value>base64==</value></data>
</root>";

    [Fact]
    public void PlainStringNode_IsServed()
    {
        var r = SafeResxResolver.Parse(Resx);
        Assert.Equal("Hello", r.Resolve("greeting", isString: true));
    }

    [Fact]
    public void ExplicitSystemStringType_IsServed()
    {
        var r = SafeResxResolver.Parse(Resx);
        Assert.Equal("Typed but safe", r.Resolve("explicitString", isString: true));
    }

    [Theory]
    [InlineData("binaryBlob")]
    [InlineData("soapBlob")]
    [InlineData("fileRef")]
    public void UnsafeNodes_AreRefused_ReturnNull(string key)
    {
        var r = SafeResxResolver.Parse(Resx);
        Assert.Null(r.Resolve(key, isString: false));
        Assert.True(r.WasRefused(key), $"{key} must be recorded as refused (drives the unsafeBinaryResource reason)");
    }

    [Fact]
    public void AllowlistedIconType_WithInvalidInlinePayload_IsUnavailableButNotBinaryRefused()
    {
        var r = SafeResxResolver.Parse(Resx);
        Assert.Null(r.Resolve("serializedIcon", isString: false));
        Assert.False(r.WasRefused("serializedIcon"));
    }

    [Fact]
    public void AbsentKey_IsNull_ButNotRefused()
    {
        var r = SafeResxResolver.Parse(Resx);
        Assert.Null(r.Resolve("nope", isString: false));
        Assert.False(r.WasRefused("nope"));
    }

    [Fact]
    public void MalformedXml_YieldsEmptyResolver_NoThrow()
    {
        var r = SafeResxResolver.Parse("<root><data name='x'"); // truncated
        Assert.Null(r.Resolve("x", isString: true));
    }

    [Fact]
    public void NullOrEmpty_IsEmptyResolver()
    {
        Assert.Null(SafeResxResolver.Parse(null).Resolve("x", true));
        Assert.Null(SafeResxResolver.Parse("").Resolve("x", true));
    }

    [Fact]
    public void Parse_WithCultureOverlay_OverridesAndFallsBack()
    {
        const string neutral = @"<root>
  <data name='button1.Text'><value>Hello</value></data>
  <data name='button1.Location' type='System.Drawing.Point, System.Drawing'><value>12, 40</value></data>
</root>";
        const string culture = @"<root>
  <data name='button1.Text'><value>Bonjour</value></data>
</root>";

        var r = SafeResxResolver.Parse(neutral, culture);
        var button = new Button();
        Assert.True(r.ApplyResources(button, "button1", out var error), error);

        Assert.Equal("Bonjour", button.Text);
        Assert.Equal(new Point(12, 40), button.Location); // neutral fallback
    }

    [Fact]
    public void ApplyResources_AppliesCommonVsScalarTypes()
    {
        const string resx = @"<root>
  <data name='button1.Text'><value>Apply me</value></data>
  <data name='button1.Location' type='System.Drawing.Point, System.Drawing'><value>7, 9</value></data>
  <data name='button1.Size' type='System.Drawing.Size, System.Drawing'><value>120, 30</value></data>
  <data name='$this.RightToLeft' type='System.Windows.Forms.RightToLeft, System.Windows.Forms'><value>Yes</value></data>
  <data name='$this.RightToLeftLayout' type='System.Boolean, mscorlib'><value>True</value></data>
</root>";
        var r = SafeResxResolver.Parse(resx);
        var button = new Button();
        var form = new Form();

        Assert.True(r.ApplyResources(button, "button1", out var buttonError), buttonError);
        Assert.True(r.ApplyResources(form, "$this", out var formError), formError);

        Assert.Equal("Apply me", button.Text);
        Assert.Equal(new Point(7, 9), button.Location);
        Assert.Equal(new Size(120, 30), button.Size);
        Assert.Equal(RightToLeft.Yes, form.RightToLeft);
        Assert.True(form.RightToLeftLayout);
    }

    [Fact]
    public void ApplyResources_AcceptsBoundedRawByteArrayImagesAndIcons_AndRefusesSerializedObjects()
    {
        using var source = new Bitmap(2, 1);
        source.SetPixel(0, 0, Color.Red);
        source.SetPixel(1, 0, Color.Blue);
        using var stream = new MemoryStream();
        source.Save(stream, System.Drawing.Imaging.ImageFormat.Png);
        string encoded = Convert.ToBase64String(stream.ToArray());
        string encodedIcon;
        using (var sourceIcon = (Icon)SystemIcons.Application.Clone())
        using (var iconStream = new MemoryStream())
        {
            sourceIcon.Save(iconStream);
            encodedIcon = Convert.ToBase64String(iconStream.ToArray());
        }
        string resx = $@"<root>
  <data name='button1.Image' type='System.Drawing.Bitmap, System.Drawing.Common' mimetype='application/x-microsoft.net.object.bytearray.base64'><value>{encoded}</value></data>
  <data name='button2.Image' type='System.Drawing.Bitmap, System.Drawing.Common' mimetype='application/x-microsoft.net.object.binary.base64'><value>{encoded}</value></data>
  <data name='$this.Icon' type='System.Drawing.Icon, System.Drawing.Common' mimetype='application/x-microsoft.net.object.bytearray.base64'><value>{encodedIcon}</value></data>
</root>";
        var resolver = SafeResxResolver.Parse(resx);
        using var accepted = new Button();
        using var refused = new Button();
        using var form = new Form();

        Assert.True(resolver.ApplyResources(accepted, "button1", out var acceptedError), acceptedError);
        Assert.NotNull(accepted.Image);
        Assert.Equal(new Size(2, 1), accepted.Image!.Size);
        Assert.True(resolver.ApplyResources(form, "$this", out var iconError), iconError);
        Assert.NotNull(form.Icon);
        Assert.True(form.Icon!.Width > 0);
        Assert.False(resolver.ApplyResources(refused, "button2", out var refusedError));
        Assert.Contains("UNSAFE_RESOURCE", refusedError);
        Assert.True(resolver.WasRefused("button2.Image"));
    }

    [Fact]
    public void Resolve_GetObject_AllowsSafeTypedScalars()
    {
        const string resx = @"<root>
  <data name='p' type='System.Drawing.Point, System.Drawing'><value>3, 4</value></data>
</root>";
        Assert.Equal(new Point(3, 4), SafeResxResolver.Parse(resx).Resolve("p", isString: false));
        Assert.Null(SafeResxResolver.Parse(resx).Resolve("p", isString: true));
    }

    [Fact]
    public void ApplyResources_RefusedOverlayEntry_FailsClosed()
    {
        const string neutral = @"<root>
  <data name='button1.Text'><value>Hello</value></data>
</root>";
        const string culture = @"<root>
  <data name='button1.Text' mimetype='application/x-microsoft.net.object.binary.base64'><value>AAEAAAD/////</value></data>
</root>";
        var r = SafeResxResolver.Parse(neutral, culture);

        Assert.False(r.ApplyResources(new Button(), "button1", out var error));
        Assert.Contains("UNSAFE_RESOURCE", error);
        Assert.True(r.WasRefused("button1.Text"));
        Assert.Null(r.Resolve("button1.Text", isString: true));
    }
}
