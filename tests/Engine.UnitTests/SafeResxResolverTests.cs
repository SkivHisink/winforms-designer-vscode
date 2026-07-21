using WinFormsDesigner.Engine;

namespace Engine.UnitTests;

// The interpreted resx resolver must serve ONLY plain inline strings and REFUSE
// every binary/SOAP/mimetyped/ResXFileRef/typed node (BinaryFormatter is never invoked on repo-controlled bytes).
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
    [InlineData("serializedIcon")]
    public void UnsafeNodes_AreRefused_ReturnNull(string key)
    {
        var r = SafeResxResolver.Parse(Resx);
        Assert.Null(r.Resolve(key, isString: false));
        Assert.True(r.WasRefused(key), $"{key} must be recorded as refused (drives the unsafeBinaryResource reason)");
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
}
