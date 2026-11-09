using System.ComponentModel;
using System.Drawing;
using System.Reflection;
using System.Windows.Forms;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using WinFormsDesigner.Engine;

namespace Engine.UnitTests;

/// <summary>
/// The .resx values both engines serve: only types of a fixed registry, named in the resource's type attribute with an
/// assembly of their own, made from the invariant text by the registry type's own converter — never by a converter a
/// project type or a property names. ApplyResources applies a value only to a property that takes it as it is, and
/// checks every entry before setting any.
/// </summary>
[Collection("Modern localization designer STA")]
public sealed class ResourceTrustTests
{
    private static readonly StaDispatcher Sta = new();

    public static IEnumerable<object[]> LocalizableValues() => new[]
    {
        new object[] { 'A' },
        new object[] { ImageLayout.Zoom },
        new object[] { Keys.Control | Keys.A },
        new object[] { new LinkArea(1, 3) },
        new object[] { FormStartPosition.CenterScreen },
        new object[] { TextImageRelation.ImageBeforeText },
        new object[] { Orientation.Vertical },
        new object[] { Appearance.Button },
        new object[] { AutoSizeMode.GrowAndShrink },
        new object[] { Day.Monday },
        new object[] { FlowDirection.TopDown },
        new object[] { HorizontalAlignment.Center },
        new object[] { ImeMode.Hiragana },
        new object[] { LeftRightAlignment.Right },
        new object[] { ListViewAlignment.Left },
        new object[] { PictureBoxSizeMode.Zoom },
        new object[] { RichTextBoxScrollBars.Vertical },
        new object[] { ScrollBars.Both },
        new object[] { TabAlignment.Bottom },
        new object[] { TabAppearance.Buttons },
        new object[] { TableLayoutPanelCellBorderStyle.Single },
        new object[] { ToolStripItemImageScaling.None },
    };

    [Theory]
    [MemberData(nameof(LocalizableValues))]
    public void ALocalizableValueType_IsServedAsItself(object expected)
    {
        // The text the framework's resource writer writes for the value, read back by both resolvers.
        Type type = expected.GetType();
        string text = TypeDescriptor.GetConverter(type).ConvertToInvariantString(expected)!;
        string resx = "<root><data name=\"v\" type=\"" + type.FullName + ", " + type.Assembly.GetName().Name + "\"><value>"
            + System.Security.SecurityElement.Escape(text) + "</value></data></root>";

        var shared = SafeResxResolver.Parse(resx);
        Assert.Equal(ResourceLookup.Value, shared.Lookup("v", asString: false, out var value, out var error));
        Assert.True(error == null, error);
        Assert.Equal(type, value!.GetType());
        Assert.Equal(expected, value);

        WithResx(resx, file =>
        {
            var modern = ResxResolver.TryLoadForDesigner(file, "");
            Assert.NotNull(modern);
            Assert.Equal(expected, modern!.GetObject("v"));
        });
    }

    [Fact]
    public void Keys_AreReadAsTheResourceWriterWritesThem()
    {
        var r = SafeResxResolver.Parse("<root><data name=\"k\" type=\"System.Windows.Forms.Keys, System.Windows.Forms\"><value>Ctrl+A</value></data></root>");
        Assert.Equal(Keys.Control | Keys.A, r.Resolve("k", isString: false));
    }

    [Theory]
    // a framework name in another assembly is another type: nothing of it is loaded or run
    [InlineData("System.Drawing.Point, identity-probe")]
    [InlineData("System.Windows.Forms.Keys, Corporate.Forms")]
    // a type outside the registry
    [InlineData("System.Windows.Forms.Cursor, System.Windows.Forms")]
    [InlineData("System.Windows.Forms.FormBorderStyle, System.Windows.Forms")]
    public void ATypeOutsideTheRegistry_IsRefused(string typeAttribute)
    {
        var r = SafeResxResolver.Parse("<root><data name=\"v\" type=\"" + typeAttribute + "\"><value>1, 2</value></data></root>");

        Assert.Equal(ResourceLookup.Refused, r.Lookup("v", asString: false, out var value, out _));
        Assert.Null(value);
        Assert.True(r.WasRefused("v"));
    }

    [Fact]
    public void ApplyResources_RunsNoConverterOfAPropertysType()
    {
        // A project type named System.Drawing.Point, with a converter that counts its calls, on a component's property.
        var assembly = Compile("""
            namespace System.Drawing
            {
                [System.ComponentModel.TypeConverter(typeof(Probe.CountingConverter))]
                public struct Point { public int X; }
            }
            namespace Probe
            {
                public sealed class CountingConverter : System.ComponentModel.TypeConverter
                {
                    public static int Calls;
                    public override bool CanConvertFrom(System.ComponentModel.ITypeDescriptorContext c, System.Type t) { Calls++; return true; }
                    public override object ConvertFrom(System.ComponentModel.ITypeDescriptorContext c, System.Globalization.CultureInfo ci, object v) { Calls++; return new System.Drawing.Point(); }
                }
                public sealed class Host : System.ComponentModel.Component { public System.Drawing.Point Location { get; set; } }
            }
            """);
        object host = Activator.CreateInstance(assembly.GetType("Probe.Host")!)!;
        var calls = assembly.GetType("Probe.CountingConverter")!.GetField("Calls")!;

        var typed = SafeResxResolver.Parse("<root><data name=\"h.Location\" type=\"System.Drawing.Point, System.Drawing\"><value>1, 2</value></data></root>");
        var untyped = SafeResxResolver.Parse("<root><data name=\"h.Location\"><value>1, 2</value></data></root>");

        Assert.False(typed.ApplyResources(host, "h", out var typedError));
        Assert.Contains("does not fit", typedError);
        Assert.False(untyped.ApplyResources(host, "h", out var untypedError));
        Assert.Contains("does not fit", untypedError);
        Assert.Equal(0, (int)calls.GetValue(null)!);
    }

    [Theory]
    // an untyped string for an enum property, and a typed int for a string property: ComponentResourceManager sets
    // neither, so neither is converted into a value
    [InlineData("<data name=\"button1.Dock\"><value>Fill</value></data>")]
    [InlineData("<data name=\"button1.Text\" type=\"System.Int32, mscorlib\"><value>123</value></data>")]
    public void ApplyResources_RefusesAValueThePropertyDoesNotTake_BeforeSettingAny(string entry)
    {
        var r = SafeResxResolver.Parse("<root><data name=\"button1.Location\" type=\"System.Drawing.Point, System.Drawing\"><value>7, 9</value></data>"
            + entry + "</root>");
        using var button = new Button { Text = "Before", Location = new Point(1, 1) };

        Assert.False(r.ApplyResources(button, "button1", out var error));
        Assert.Contains("does not fit", error);
        Assert.Equal("Before", button.Text);
        Assert.Equal(new Point(1, 1), button.Location);
    }

    [Fact]
    public void AByteArray_IsServedAsTheResourceWriterWritesIt_EmptyIncluded()
    {
        // The writer stores a byte array as typed base64 text without a MIME type.
        string resx = "<root><data name=\"b\" type=\"System.Byte[], System.Private.CoreLib\"><value>AQID</value></data>"
            + "<data name=\"e\" type=\"System.Byte[], mscorlib\"><value></value></data></root>";
        WithResx(resx, file =>
        {
            var modern = ResxResolver.TryLoadForDesigner(file, "");
            Assert.Equal(new byte[] { 1, 2, 3 }, modern!.GetObject("b"));
            Assert.Equal(Array.Empty<byte>(), modern.GetObject("e"));
        });
    }

    [Theory]
    [InlineData("<root><data")]
    [InlineData("<Root/>")]
    public void AResxThatIsNotWellFormed_IsNoResourceSet(string resx)
    {
        WithResx(resx, file => Assert.Null(ResxResolver.TryLoadForDesigner(file, "")));
        var shared = SafeResxResolver.Parse(resx);
        Assert.False(shared.IsValid);
        Assert.False(shared.ApplyResources(new Button(), "button1", out var error));
        Assert.Contains("not well formed", error);
    }

    [Fact]
    public void AnEntryWhoseTextIsNoValue_FailsRatherThanServesNull()
    {
        var r = SafeResxResolver.Parse("<root><data name=\"v\" type=\"System.Int32, mscorlib\"><value>bad number</value></data></root>");
        Assert.Equal(ResourceLookup.Failed, r.Lookup("v", asString: false, out _, out _));
    }

    [Fact]
    public void GetString_OfAnEntryOfAnotherType_IsNotAString()
    {
        var r = SafeResxResolver.Parse("<root><data name=\"n\" type=\"System.Int32, mscorlib\"><value>5</value></data></root>");

        Assert.Equal(ResourceLookup.NotString, r.Lookup("n", asString: true, out _, out _));
        Assert.Equal(ResourceLookup.Missing, r.Lookup("absent", asString: true, out _, out _));
        Assert.True(r.HasResource("n"));
        Assert.False(r.HasResource("absent"));
    }

    // --------------------------------------------------------------------- rendered -----------------------------------

    private const string LocalizedDesigner = """
        namespace Sample
        {
            partial class Form1
            {
                private System.Windows.Forms.TextBox textBox1;
                private System.Windows.Forms.LinkLabel linkLabel1;
                private void InitializeComponent()
                {
                    System.ComponentModel.ComponentResourceManager resources = new System.ComponentModel.ComponentResourceManager(typeof(Form1));
                    this.textBox1 = new System.Windows.Forms.TextBox();
                    this.linkLabel1 = new System.Windows.Forms.LinkLabel();
                    this.textBox1.PasswordChar = ((char)(resources.GetObject("textBox1.PasswordChar")));
                    resources.ApplyResources(this.linkLabel1, "linkLabel1");
                    STATEMENT
                    resources.ApplyResources(this, "$this");
                    this.Controls.Add(this.textBox1);
                    this.Controls.Add(this.linkLabel1);
                }
            }
        }
        """;

    private const string LocalizedResx = """
        <?xml version="1.0" encoding="utf-8"?>
        <root>
          <data name="textBox1.PasswordChar" type="System.Char, mscorlib"><value>*</value></data>
          <data name="textBox1.MaxLength" type="System.Int32, mscorlib"><value>12</value></data>
          <data name="textBox1.Bad" type="System.Int32, mscorlib"><value>bad number</value></data>
          <data name="linkLabel1.LinkArea" type="System.Windows.Forms.LinkArea, System.Windows.Forms"><value>2, 3</value></data>
          <data name="linkLabel1.TextAlign" type="System.Drawing.ContentAlignment, System.Drawing"><value>MiddleRight</value></data>
          <data name="$this.BackgroundImageLayout" type="System.Windows.Forms.ImageLayout, System.Windows.Forms"><value>Zoom</value></data>
          <data name="$this.StartPosition" type="System.Windows.Forms.FormStartPosition, System.Windows.Forms"><value>CenterScreen</value></data>
        </root>
        """;

    [Fact]
    public void ALocalizedForm_TakesItsLocalizableValuesFromTheResx()
    {
        WithForm(LocalizedDesigner.Replace("STATEMENT", ""), LocalizedResx, file =>
        {
            var layout = Sta.Invoke(() => DesignerRenderer.RenderWithLayout(file));
            Assert.Empty(layout.Unrepresentable);

            var box = Sta.Invoke(() => DesignerRenderer.DescribeComponent(file, "textBox1"));
            Assert.Equal("*", box!.Properties.Single(p => p.Name == "PasswordChar").Value);
            var link = Sta.Invoke(() => DesignerRenderer.DescribeComponent(file, "linkLabel1"));
            Assert.Equal("2, 3", link!.Properties.Single(p => p.Name == "LinkArea").Value);
            var form = Sta.Invoke(() => DesignerRenderer.DescribeComponent(file, "this"));
            Assert.Equal("Zoom", form!.Properties.Single(p => p.Name == "BackgroundImageLayout").Value);
            Assert.Equal("CenterScreen", form.Properties.Single(p => p.Name == "StartPosition").Value);
        });
    }

    [Theory]
    // GetObject is an object: a property of another type takes it only through a cast
    [InlineData("this.textBox1.MaxLength = resources.GetObject(\"textBox1.MaxLength\");", "without a cast")]
    // GetString of an entry of another type throws in the compiled form
    [InlineData("this.Text = resources.GetString(\"textBox1.MaxLength\");", "is not a string")]
    // a resource the reader does not supply has no value of a value type
    [InlineData("this.textBox1.MaxLength = ((int)(resources.GetObject(\"textBox1.Missing\")));", "no value of type Int32")]
    // a string is cast only to a type a string is
    [InlineData("this.textBox1.Font = (System.Drawing.Font)resources.GetString(\"missing\");", "cannot be cast")]
    // syntax no path replays, in the resource calls too
    [InlineData("resources.ApplyResources(objectName: this.textBox1, value: \"textBox1\");", "unsupported argument")]
    [InlineData("this.Text = resources.GetString<int>(\"textBox1.MaxLength\");", "unsupported generic")]
    // an entry of a trusted type whose text makes no value
    [InlineData("this.textBox1.Tag = resources.GetObject(\"textBox1.Bad\");", "cannot be read")]
    public void AResourceTheCompiledFormCannotRead_IsUnrepresentable(string statement, string reason)
    {
        WithForm(LocalizedDesigner.Replace("STATEMENT", statement), LocalizedResx, file =>
        {
            var layout = Sta.Invoke(() => DesignerRenderer.RenderWithLayout(file));
            Assert.Contains(layout.Unrepresentable, u => u.StartsWith(statement, StringComparison.Ordinal) && u.Contains(reason, StringComparison.Ordinal));
        });
    }

    [Fact]
    public void ACultureWithoutTheNeutralResx_ServesItsOwnKeys_AndNoOther()
    {
        // Only Form1.fr.resx: ResourceManager ends a lookup in the neutral set, which the compiled form does not have.
        const string designer = """
            namespace Sample
            {
                partial class Form1
                {
                    private void InitializeComponent()
                    {
                        System.ComponentModel.ComponentResourceManager resources = new System.ComponentModel.ComponentResourceManager(typeof(Form1));
                        STATEMENT
                    }
                }
            }
            """;
        string dir = Path.Combine(Path.GetTempPath(), "wfd-culture-only-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        try
        {
            string file = Path.Combine(dir, "Form1.Designer.cs");
            File.WriteAllText(Path.Combine(dir, "Form1.fr.resx"), "<root><data name=\"existing\"><value>localized</value></data></root>");
            Assert.True(DesignerCultureSelection.TrySetCultureName(file, "fr-FR", out _, out var reason), reason);

            File.WriteAllText(file, designer.Replace("STATEMENT", "this.Text = resources.GetString(\"existing\");"));
            Assert.Empty(Sta.Invoke(() => DesignerRenderer.RenderWithLayout(file)).Unrepresentable);

            const string absent = "this.Text = resources.GetString(\"absent\");";
            File.WriteAllText(file, designer.Replace("STATEMENT", absent));
            Assert.Contains(Sta.Invoke(() => DesignerRenderer.RenderWithLayout(file)).Unrepresentable,
                u => u.StartsWith(absent, StringComparison.Ordinal) && u.Contains("no neutral .resx", StringComparison.Ordinal));
        }
        finally
        {
            DesignerCultureSelection.TrySetCultureName(Path.Combine(dir, "Form1.Designer.cs"), "", out _, out _);
            try { Directory.Delete(dir, recursive: true); } catch { /* best effort */ }
        }
    }

    // --------------------------------------------------------------------- helpers ------------------------------------

    private static void WithResx(string resx, Action<string> test) => WithForm("namespace Sample { partial class Form1 { private void InitializeComponent() { } } }", resx, test);

    private static void WithForm(string designer, string resx, Action<string> test)
    {
        string dir = Path.Combine(Path.GetTempPath(), "wfd-resource-trust-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        try
        {
            string file = Path.Combine(dir, "Form1.Designer.cs");
            File.WriteAllText(file, designer);
            File.WriteAllText(Path.Combine(dir, "Form1.resx"), resx);
            test(file);
        }
        finally
        {
            try { Directory.Delete(dir, recursive: true); } catch { /* best effort */ }
        }
    }

    private static Assembly Compile(string source)
    {
        var references = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!)
            .Split(Path.PathSeparator).Select(p => MetadataReference.CreateFromFile(p));
        var compilation = CSharpCompilation.Create("ImpersonationProbe" + Guid.NewGuid().ToString("N"),
            new[] { CSharpSyntaxTree.ParseText(source) }, references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary, nullableContextOptions: NullableContextOptions.Disable));
        using var stream = new MemoryStream();
        var emitted = compilation.Emit(stream);
        Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error)));
        return Assembly.Load(stream.ToArray());
    }
}
