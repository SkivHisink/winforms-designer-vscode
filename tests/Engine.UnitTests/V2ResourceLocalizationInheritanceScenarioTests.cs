using System;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Text;
using System.Windows.Forms;
using WinFormsDesigner.Engine;

namespace Engine.UnitTests;

[Collection("Modern inherited designer STA")]
public sealed class V2ResourceLocalizationInheritanceScenarioTests
{
    private static readonly StaDispatcher Sta = new();
    private static readonly string ImageListBlob =
        Convert.ToBase64String(Encoding.ASCII.GetBytes("safe ImageListStreamer test payload"));

    [Fact]
    public void V2_FND_001_S073_ProjectImageResourceBinding_ReferencesStronglyTypedResourceWithoutCopyingBytes()
    {
        var result = DesignerRenderer.ApplyProjectImageResource(
            "unused.Designer.cs",
            "button1",
            "Image",
            "System.Drawing.Image",
            ProjectResourcesResx,
            ProjectResourcesDesigner,
            "Demo.Properties.Resources",
            "Logo",
            ResourceFormSource);

        Assert.True(result.Minimal, result.Reason);
        Assert.Contains("this.button1.Image = global::Demo.Properties.Resources.Logo;", result.NewText);
        Assert.DoesNotContain("resources.GetObject", result.NewText);
        Assert.DoesNotContain(ProjectImageBase64, result.NewText);
    }

    [Fact]
    public void V2_FND_001_S074_LocalIconImport_PreservesOpaqueResxNodes()
    {
        byte[] iconBytes;
        using (var icon = (Icon)SystemIcons.Application.Clone())
        using (var stream = new MemoryStream())
        {
            icon.Save(stream);
            iconBytes = stream.ToArray();
        }

        var result = DesignerLocalizedResxEditor.ApplyEdits(OpaqueResx, new[]
        {
            new LocalizedResourceEdit
            {
                Kind = LocalizedResourceEditKind.UpsertIcon,
                ComponentId = "",
                PropertyName = "Icon",
                BinaryValue = iconBytes,
            },
        });

        Assert.True(result.Ok, result.Reason);
        Assert.Contains("opaque.Payload", result.ResxText);
        Assert.Contains("application/x-microsoft.net.object.binary.base64", result.ResxText);
        Assert.Contains("$this.Icon", result.ResxText);
        Assert.Contains("System.Drawing.Icon", result.ResxText);
    }

    [Fact]
    public void V2_FND_001_S075_ImageListEdit_ReturnsSourceAndResourcePlanTogether()
    {
        var result = DesignerRenderer.ApplySetImageList(
            "unused.Designer.cs",
            "imageList1",
            ImageListBlob,
            new[] { "red", "blue" },
            OpaqueResx,
            ImageListSource);

        Assert.True(result.Ok, result.Reason);
        Assert.NotNull(result.DesignerText);
        Assert.NotNull(result.ResxText);
        Assert.Contains("this.imageList1.ImageStream = ((System.Windows.Forms.ImageListStreamer)(resources.GetObject(\"imageList1.ImageStream\")));", result.DesignerText);
        Assert.Contains("this.imageList1.Images.SetKeyName(0, \"red\");", result.DesignerText);
        Assert.Contains("this.imageList1.Images.SetKeyName(1, \"blue\");", result.DesignerText);
        Assert.Contains("imageList1.ImageStream", result.ResxText);
        Assert.Contains("opaque.Payload", result.ResxText);
    }

    [Fact]
    public void V2_FND_001_S076_UnsafeProjectResourceExpression_IsRefusedBeforeSourceEdit()
    {
        string? expr = DesignerProjectResourcePicker.BuildResourceExpression(
            ProjectResourcesResx,
            ProjectResourcesDesigner,
            "Demo.Properties.Resources;this.evil",
            "Logo",
            "System.Drawing.Image",
            out string reason);

        Assert.Null(expr);
        Assert.Contains("invalid resource class name", reason);
    }

    [Fact]
    public void V2_FND_001_S077_LocalizableNeutralEdit_WritesNeutralResourceKey()
    {
        var result = DesignerLocalizedResxEditor.ApplyScalarEdits(null, new[]
        {
            new LocalizedResourceEdit
            {
                ComponentId = "label1",
                PropertyName = "Text",
                ValueTypeName = "System.String",
                ScalarValue = "Neutral caption",
            },
        });

        Assert.True(result.Ok, result.Reason);
        Assert.Equal(new[] { "label1.Text" }, result.Keys);
        Assert.Contains("label1.Text", result.ResxText);
        Assert.Contains("Neutral caption", result.ResxText);
    }

    [Fact]
    public void V2_FND_001_S078_CultureSpecificEdit_PreservesNeutralFallbackText()
    {
        const string neutral = "<root><data name=\"label1.Text\" xml:space=\"preserve\"><value>Neutral fallback</value></data></root>";
        var result = DesignerLocalizedResxEditor.ApplyScalarEdits(null, new[]
        {
            new LocalizedResourceEdit
            {
                ComponentId = "label1",
                PropertyName = "Text",
                ValueTypeName = "System.String",
                ScalarValue = "Bonjour",
            },
        });

        Assert.True(result.Ok, result.Reason);
        Assert.Contains("Bonjour", result.ResxText);
        Assert.Contains("Neutral fallback", neutral);
        Assert.DoesNotContain("Neutral fallback", result.ResxText);
    }

    [Fact]
    public void V2_FND_001_S079_RtlLayout_UsesStaticMirroredGeometryContract()
    {
        string sample = SamplePath("LocalizableForm.Designer.cs");
        using var temp = new TempDesigner(sample);
        foreach (var file in Directory.GetFiles(Path.GetDirectoryName(sample)!, "LocalizableForm*.resx"))
            File.Copy(file, Path.Combine(temp.DirectoryPath, Path.GetFileName(file)));

        Assert.True(DesignerCultureSelection.TrySetCultureName(temp.DesignerPath, "", out _, out var reason), reason);
        var neutral = Sta.Invoke(() => DesignerRenderer.RenderWithLayout(temp.DesignerPath));
        var neutralButton = Assert.Single(neutral.Controls, c => c.Id == "button1");

        Assert.True(DesignerCultureSelection.TrySetCultureName(temp.DesignerPath, "ar-SA", out _, out reason), reason);
        var rtl = Sta.Invoke(() => DesignerRenderer.RenderWithLayout(temp.DesignerPath));
        var rtlButton = Assert.Single(rtl.Controls, c => c.Id == "button1");

        Assert.True(rtlButton.X > neutralButton.X);
        Assert.Equal(neutralButton.Width, rtlButton.Width);
    }

    [Fact]
    public void V2_FND_001_S085_AccessibleInheritedPropertyOverride_WritesOnlyDerivedSource()
    {
        WithInheritedDesigner((file, source, assembly) =>
        {
            var info = Sta.Invoke(() => DesignerRenderer.DescribeComponent(file, "inheritedButton", assembly));
            Assert.NotNull(info);
            Assert.True(info!.InheritedOverrideEditable);
            var text = info.Properties.Single(p => p.Name == "Text");
            Assert.True(text.InheritedOverrideEditable);

            var result = Sta.Invoke(() => DesignerRenderer.ApplyInheritedPropertyOverride(
                file, "inheritedButton", "Text", "\"Derived caption\"",
                info.BaseIdentityToken, assembly, source));

            Assert.True(result.Minimal, result.Reason);
            Assert.Contains("this.inheritedButton.Text = \"Derived caption\";", result.NewText);
            Assert.DoesNotContain("privateInheritedButton.Text = \"Derived caption\"", result.NewText);
        });
    }

    [Fact]
    public void V2_FND_001_S086_InheritedPrivateControl_IsSelectableReadOnly()
    {
        WithInheritedDesigner((file, _, assembly) =>
        {
            var layout = Sta.Invoke(() => DesignerRenderer.RenderWithLayout(file, controlAssemblyPath: assembly));
            var locked = Assert.Single(layout.Controls, c => c.Name == "privateInheritedButton");

            Assert.Equal("inherited", locked.Ownership);
            Assert.False(locked.Editable);
            Assert.False(locked.InheritedOverrideEditable);
            Assert.False(locked.InheritedGeometryOverrideEditable);
            Assert.False(string.IsNullOrWhiteSpace(locked.ReadOnlyReason));
        });
    }

    [Fact]
    public void V2_FND_001_S087_AddDerivedOnlyControl_ToInheritedFormEditsOnlyDerivedDesignerSource()
    {
        var result = DesignerControlEditor.AddControl(InheritedDesignerSource, "this", "Button", locX: 18, locY: 24);

        Assert.True(result.Safe, result.Reason);
        Assert.Equal("button1", result.Name);
        Assert.Contains("private System.Windows.Forms.Button button1;", result.NewText);
        Assert.Contains("this.Controls.Add(this.button1);", result.NewText);
        Assert.Contains("partial class ModernInheritedDerivedForm : ModernInheritedBaseForm", result.NewText);
        Assert.DoesNotContain("privateInheritedButton", result.NewText);
    }

    [Fact]
    public void V2_FND_001_S088_PrivateInheritedMove_IsRefusedWithoutSourceMutation()
    {
        WithInheritedDesigner((file, source, assembly) =>
        {
            var drag = Sta.Invoke(() => DesignerRenderer.BeginGeometryDrag(file, "privateInheritedButton", assembly));
            Assert.False(drag.CanMove);
            Assert.Contains("not public or protected", drag.Reason, StringComparison.OrdinalIgnoreCase);

            var commit = Sta.Invoke(() => DesignerRenderer.CommitGeometryBounds(
                file, "privateInheritedButton", 22, 28, 90, 24, assembly, source, drag.BaseIdentityToken));

            Assert.False(commit.Ok);
            Assert.Null(commit.DesignerText);
        });
    }

    private static void WithInheritedDesigner(Action<string, string, string> test)
    {
        using var temp = new TempDesigner(InheritedDesignerSource);
        test(temp.DesignerPath, File.ReadAllText(temp.DesignerPath), typeof(ModernInheritedDerivedForm).Assembly.Location);
    }

    private static string SamplePath(string fileName)
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null && !Directory.Exists(Path.Combine(dir.FullName, "engine"))) dir = dir.Parent;
        if (dir == null) throw new DirectoryNotFoundException("engine samples root not found");
        return Path.Combine(dir.FullName, "engine", "samples", fileName);
    }

    private sealed class TempDesigner : IDisposable
    {
        public TempDesigner(string sourceOrPath)
        {
            DirectoryPath = Path.Combine(Path.GetTempPath(), "wfd-v2-scenarios-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(DirectoryPath);
            DesignerPath = Path.Combine(DirectoryPath, Path.GetFileName(sourceOrPath.EndsWith(".cs", StringComparison.OrdinalIgnoreCase)
                ? sourceOrPath
                : "ModernInheritedDerivedForm.Designer.cs"));
            File.WriteAllText(DesignerPath,
                File.Exists(sourceOrPath) ? File.ReadAllText(sourceOrPath) : sourceOrPath);
        }

        public string DirectoryPath { get; }
        public string DesignerPath { get; }
        public void Dispose()
        {
            try { Directory.Delete(DirectoryPath, recursive: true); } catch { }
        }
    }

    private const string ProjectImageBase64 =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

    private const string ProjectResourcesResx = """
        <?xml version="1.0" encoding="utf-8"?>
        <root>
          <data name="Logo" type="System.Drawing.Bitmap, System.Drawing.Common" mimetype="application/x-microsoft.net.object.bytearray.base64">
            <value>iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=</value>
          </data>
        </root>
        """;

    private const string ProjectResourcesDesigner = """
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
          }
        }
        """;

    private const string ResourceFormSource = """
        namespace Demo
        {
            partial class Form1
            {
                private System.Windows.Forms.Button button1;
                private void InitializeComponent()
                {
                    this.button1 = new System.Windows.Forms.Button();
                    this.button1.Name = "button1";
                    this.Controls.Add(this.button1);
                }
            }
        }
        """;

    private const string OpaqueResx = """
        <?xml version="1.0" encoding="utf-8"?>
        <root>
          <data name="opaque.Payload" mimetype="application/x-microsoft.net.object.binary.base64">
            <value>AAEAAAD/////</value>
          </data>
        </root>
        """;

    private const string ImageListSource = """
        namespace Demo
        {
            partial class Form1
            {
                private System.Windows.Forms.ImageList imageList1;
                private void InitializeComponent()
                {
                    this.imageList1 = new System.Windows.Forms.ImageList();
                    this.imageList1.ImageSize = new System.Drawing.Size(16, 16);
                }
            }
        }
        """;

    private const string InheritedDesignerSource = """
        namespace Engine.UnitTests
        {
            partial class ModernInheritedDerivedForm : ModernInheritedBaseForm
            {
                private void InitializeComponent()
                {
                    this.SuspendLayout();
                    this.ClientSize = new System.Drawing.Size(320, 180);
                    this.Name = "ModernInheritedDerivedForm";
                    this.ResumeLayout(false);
                }
            }
        }
        """;
}
