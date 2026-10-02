using System.ComponentModel;
using System.Drawing;
using System.Reflection;
using System.Reflection.Emit;
using System.Windows.Forms;
using WinFormsDesigner.Engine;

namespace Engine.UnitTests
{
    /// <summary>A root base shaped like DevExpress XtraForm: form-level appearance lives in a nested object that the
    /// designer assigns through the root (`this.Appearance.BackColor = …`).</summary>
    public class AppearanceRootForm : Form
    {
        public AppearanceRootForm() { Appearance = new RootAppearance(this); }

        [DesignerSerializationVisibility(DesignerSerializationVisibility.Content)]
        public RootAppearance Appearance { get; }
    }

    public sealed class RootAppearance
    {
        private readonly Form _owner;
        public RootAppearance(Form owner) { _owner = owner; }
        public Color BackColor { get => _owner.BackColor; set => _owner.BackColor = value; }

        [DesignerSerializationVisibility(DesignerSerializationVisibility.Content)]
        public RootAppearanceOptions Options { get; } = new();
    }

    public sealed class RootAppearanceOptions
    {
        public bool UseBackColor { get; set; }
    }

    public partial class AppearanceDerivedForm : AppearanceRootForm { }

    /// <summary>A compiled base whose constructor needs a runtime the designer host does not provide.</summary>
    public class ThrowingCtorBaseForm : Form
    {
        public ThrowingCtorBaseForm() => throw new InvalidOperationException("vendor base needs its runtime");
    }

    public partial class ThrowingCtorDerivedForm : ThrowingCtorBaseForm { }

    /// <summary>Records which IUIService a real ControlDesigner sees — the lookup DisplayError performs before it would
    /// fall back to a modal MessageBox.</summary>
    public sealed class UiServiceProbeDesigner : System.Windows.Forms.Design.ControlDesigner
    {
        public static string? SeenService;

        public override void Initialize(IComponent component)
        {
            base.Initialize(component);
            SeenService = GetService(typeof(System.Windows.Forms.Design.IUIService))?.GetType().Name;
        }
    }

    [Designer(typeof(UiServiceProbeDesigner))]
    public class UiServiceProbePanel : Panel { }

    /// <summary>A component whose EndInit always fails, like a vendor control rejecting its batched state.</summary>
    public class FailingInitPanel : Panel, ISupportInitialize
    {
        public void BeginInit() { }
        public void EndInit() => throw new InvalidOperationException("batched state rejected");
    }
}

namespace DevExpress.XtraLayout.Utils
{
    /// <summary>Impersonates the DevExpress struct by FullName from an assembly that is not DevExpress's.</summary>
    public struct Padding
    {
        public Padding(int left, int right, int top, int bottom) { Left = left; Right = right; Top = top; Bottom = bottom; }
        public int Left { get; }
        public int Right { get; }
        public int Top { get; }
        public int Bottom { get; }
    }
}

namespace Engine.UnitTests
{
    // GitHub #6 — DevExpress forms on the modern engine.
    [Collection("Modern inherited designer STA")]
    public sealed class VendorDesignerSourceTests
    {
        private static readonly StaDispatcher Sta = new();

        private const string Png1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

        [Fact]
        public void ProjectResource_InlineAndProjectFileImages_RenderWithoutUnrepresentableStatements()
        {
            WithProject(dir =>
            {
                string file = WriteForm(dir, "global::Demo.Properties.Resources.Logo", "Properties.Resources.OpenImage");

                var frame = Sta.Invoke(() => DesignerRenderer.RenderWithLayout(file));

                Assert.Empty(frame.Unrepresentable);
                Assert.True(Assert.Single(frame.Controls, c => c.Id == "button1").HasImage);
                Assert.True(Assert.Single(frame.Controls, c => c.Id == "button2").HasImage);
            });
        }

        [Fact]
        // A file reference is repository input: one that leaves the project (or names another machine) is never read,
        // and the form still renders without that image rather than turning read-only.
        public void ProjectResource_FileReferenceOutsideTheProject_IsNotRead()
        {
            WithProject(dir =>
            {
                File.WriteAllBytes(Path.Combine(Path.GetDirectoryName(dir)!, Path.GetFileName(dir) + "-outside.png"),
                    Convert.FromBase64String(Png1x1));
                string file = WriteForm(dir, "global::Demo.Properties.Resources.Escape", "global::Demo.Properties.Resources.Network");

                var frame = Sta.Invoke(() => DesignerRenderer.RenderWithLayout(file));

                Assert.Empty(frame.Unrepresentable);
                Assert.False(Assert.Single(frame.Controls, c => c.Id == "button1").HasImage);
                Assert.False(Assert.Single(frame.Controls, c => c.Id == "button2").HasImage);
            }, cleanupSibling: "-outside.png");
        }

        [Fact]
        // C# binds Properties.Resources inside namespace Demo.Forms to Demo.Forms.Properties.Resources. When that class
        // has no usable Logo payload the image stays unset; the outer Demo.Properties.Resources.Logo must not stand in.
        public void ProjectResource_InnerNamespaceClassWithoutPayload_NeverFallsBackToAnOuterClass()
        {
            WithFiles(new Dictionary<string, string>
            {
                ["Demo.csproj"] = "<Project Sdk=\"Microsoft.NET.Sdk\" />",
                ["Properties/Resources.resx"] = ResxWith(("Logo", Png1x1)),
                ["Properties/Resources.Designer.cs"] = Accessors("Demo.Properties", "Demo.Properties.Resources", "Logo"),
                ["Forms/Properties/Resources.resx"] = ResxWith(),
                ["Forms/Properties/Resources.Designer.cs"] = Accessors("Demo.Forms.Properties", "Demo.Forms.Properties.Resources", "Logo"),
            }, dir =>
            {
                string file = WriteForm(dir, "Properties.Resources.Logo", "global::Demo.Properties.Resources.Logo", "Demo.Forms", "Forms");

                var frame = Sta.Invoke(() => DesignerRenderer.RenderWithLayout(file));

                Assert.Empty(frame.Unrepresentable);
                Assert.False(Assert.Single(frame.Controls, c => c.Id == "button1").HasImage);
                Assert.True(Assert.Single(frame.Controls, c => c.Id == "button2").HasImage);
            });
        }

        [Fact]
        // The preview culture's .resx overlays the neutral one; an entry it holds but cannot be read shadows the neutral
        // image instead of exposing it.
        public void ProjectResource_PreviewCultureOverlay_ShadowsTheNeutralPayload()
        {
            WithFiles(new Dictionary<string, string>
            {
                ["Demo.csproj"] = "<Project Sdk=\"Microsoft.NET.Sdk\" />",
                ["Properties/Resources.resx"] = ResxWith(("Logo", Png1x1), ("Other", Png1x1)),
                ["Properties/Resources.fr.resx"] = """
                    <?xml version="1.0" encoding="utf-8"?>
                    <root>
                      <data name="Logo" mimetype="application/x-microsoft.net.object.binary.base64"><value>AAEAAAD/////AQAAAAAAAAA=</value></data>
                    </root>
                    """,
                ["Properties/Resources.Designer.cs"] = Accessors("Demo.Properties", "Demo.Properties.Resources", "Logo", "Other"),
            }, dir =>
            {
                string file = WriteForm(dir, "global::Demo.Properties.Resources.Logo", "global::Demo.Properties.Resources.Other");
                Assert.True(DesignerCultureSelection.TrySetCultureName(file, "fr-FR", out _, out string reason), reason);
                try
                {
                    var frame = Sta.Invoke(() => DesignerRenderer.RenderWithLayout(file));

                    Assert.Empty(frame.Unrepresentable);
                    Assert.False(Assert.Single(frame.Controls, c => c.Id == "button1").HasImage);
                    Assert.True(Assert.Single(frame.Controls, c => c.Id == "button2").HasImage);
                }
                finally { DesignerCultureSelection.Clear(file); }
            });
        }

        [Fact]
        // A subdirectory with its own project file is another project; its resources are not this form's.
        public void ProjectResource_NestedProjectsResources_AreNotThisFormsResources()
        {
            WithFiles(new Dictionary<string, string>
            {
                ["Demo.csproj"] = "<Project Sdk=\"Microsoft.NET.Sdk\"><ItemGroup><Compile Remove=\"Plugin/**\" /></ItemGroup></Project>",
                ["Plugin/Plugin.csproj"] = "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><RootNamespace>Demo</RootNamespace></PropertyGroup></Project>",
                ["Plugin/Properties/Resources.resx"] = ResxWith(("Logo", Png1x1)),
                ["Plugin/Properties/Resources.Designer.cs"] = Accessors("Demo.Properties", "Demo.Properties.Resources", "Logo"),
            }, dir =>
            {
                string file = WriteForm(dir, "global::Demo.Properties.Resources.Logo", "global::Demo.Properties.Resources.Logo");

                var frame = Sta.Invoke(() => DesignerRenderer.RenderWithLayout(file));

                Assert.Contains(frame.Unrepresentable, u => u.Contains("cannot evaluate member access global::Demo.Properties.Resources.Logo"));
            });
        }

        [Fact]
        // The generated ResourceManager reads the resource set its base name names; a base name that is not the
        // manifest name of the .resx beside it is an association the designer cannot prove.
        public void ProjectResource_AccessorReadingAnotherResourceSet_StaysUnrepresentable()
        {
            WithFiles(new Dictionary<string, string>
            {
                ["Demo.csproj"] = "<Project Sdk=\"Microsoft.NET.Sdk\" />",
                ["Properties/Resources.resx"] = ResxWith(("Logo", Png1x1)),
                ["Properties/Resources.Designer.cs"] = Accessors("Demo.Properties", "Other.Properties.Resources", "Logo"),
            }, dir =>
            {
                string file = WriteForm(dir, "global::Demo.Properties.Resources.Logo", "global::Demo.Properties.Resources.Logo");

                var frame = Sta.Invoke(() => DesignerRenderer.RenderWithLayout(file));

                Assert.Contains(frame.Unrepresentable, u => u.Contains("cannot evaluate member access global::Demo.Properties.Resources.Logo"));
            });
        }

        [Theory]
        // MSBuild names the manifest from the root namespace (the SDK default turns spaces into '_') and the folder path
        // made valid identifiers; the accessor's base name has to be exactly that name.
        [InlineData("Demo App.csproj", "", "Properties", "Demo_App.Properties", "Demo_App.Properties.Resources", true)]
        [InlineData("Demo.csproj", "", "Images-Foo", "Demo.Images_Foo", "Demo.Images_Foo.Resources", true)]
        [InlineData("Demo.csproj", "", "Images-Foo", "Demo.Images_Foo", "Demo.Images-Foo.Resources", false)]
        [InlineData("Demo.csproj", "<ItemGroup><EmbeddedResource Update=\"Properties\\Resources.resx\" LogicalName=\"Demo.Other.resources\" /></ItemGroup>", "Properties", "Demo.Properties", "Demo.Properties.Resources", false)]
        [InlineData("Demo.csproj", "<ItemGroup><EmbeddedResource Remove=\"Properties\\Resources.resx\" /></ItemGroup>", "Properties", "Demo.Properties", "Demo.Properties.Resources", false)]
        [InlineData("Demo.csproj", "<ItemGroup><EmbeddedResource Update=\"Form1.resx\"><DependentUpon>Form1.cs</DependentUpon></EmbeddedResource></ItemGroup>", "Properties", "Demo.Properties", "Demo.Properties.Resources", true)]
        public void ProjectResource_ManifestNameMustBeProvenFromTheProjectFile(string projectFile, string items, string folder,
            string ns, string baseName, bool rendersImage)
        {
            WithFiles(new Dictionary<string, string>
            {
                [projectFile] = "<Project Sdk=\"Microsoft.NET.Sdk\">" + items + "</Project>",
                [folder + "/Resources.resx"] = ResxWith(("Logo", Png1x1)),
                [folder + "/Resources.Designer.cs"] = Accessors(ns, baseName, "Logo"),
            }, dir =>
            {
                string expression = "global::" + ns + ".Resources.Logo";
                var frame = Sta.Invoke(() => DesignerRenderer.RenderWithLayout(WriteForm(dir, expression, expression)));

                if (rendersImage)
                {
                    Assert.Empty(frame.Unrepresentable);
                    Assert.True(Assert.Single(frame.Controls, c => c.Id == "button1").HasImage);
                }
                else Assert.Contains(frame.Unrepresentable, u => u.Contains("cannot evaluate member access " + expression));
            });
        }

        [Fact]
        // With a same-named .cs beside the .resx, the SDK's DependentUpon convention names the manifest after that
        // file's class, which this reader does not evaluate.
        public void ProjectResource_ResxWithASameNamedCodeFile_StaysUnrepresentable()
        {
            WithFiles(new Dictionary<string, string>
            {
                ["Demo.csproj"] = "<Project Sdk=\"Microsoft.NET.Sdk\" />",
                ["Properties/Resources.resx"] = ResxWith(("Logo", Png1x1)),
                ["Properties/Resources.Designer.cs"] = Accessors("Demo.Properties", "Demo.Properties.Resources", "Logo"),
                ["Properties/Resources.cs"] = "namespace Demo.Other { partial class Settings { } }",
            }, dir =>
            {
                var frame = Sta.Invoke(() => DesignerRenderer.RenderWithLayout(
                    WriteForm(dir, "global::Demo.Properties.Resources.Logo", "global::Demo.Properties.Resources.Logo")));

                Assert.NotEmpty(frame.Unrepresentable);
            });
        }

        [Theory]
        // An old-style project embeds only what it lists; its forms' own .resx entries carry DependentUpon.
        [InlineData(true)]
        [InlineData(false)]
        public void ProjectResource_OldStyleProject_RequiresTheResxToBeListed(bool listed)
        {
            string items = "<EmbeddedResource Include=\"Form1.resx\"><DependentUpon>Form1.cs</DependentUpon></EmbeddedResource>"
                + (listed ? "<EmbeddedResource Include=\"Properties\\Resources.resx\"><Generator>ResXFileCodeGenerator</Generator></EmbeddedResource>" : "");
            WithFiles(new Dictionary<string, string>
            {
                ["Demo.csproj"] = "<Project ToolsVersion=\"15.0\" xmlns=\"http://schemas.microsoft.com/developer/msbuild/2003\">"
                    + "<PropertyGroup><RootNamespace>Demo</RootNamespace></PropertyGroup><ItemGroup>" + items + "</ItemGroup></Project>",
                ["Properties/Resources.resx"] = ResxWith(("Logo", Png1x1)),
                ["Properties/Resources.Designer.cs"] = Accessors("Demo.Properties", "Demo.Properties.Resources", "Logo"),
            }, dir =>
            {
                var frame = Sta.Invoke(() => DesignerRenderer.RenderWithLayout(
                    WriteForm(dir, "global::Demo.Properties.Resources.Logo", "global::Demo.Properties.Resources.Logo")));

                Assert.Equal(listed, frame.Unrepresentable.Count == 0);
                Assert.Equal(listed, Assert.Single(frame.Controls, c => c.Id == "button1").HasImage);
            });
        }

        private static string ResxWith(params (string Name, string Base64Png)[] images) =>
            "<?xml version=\"1.0\" encoding=\"utf-8\"?>\r\n<root>\r\n"
            + string.Concat(images.Select(i =>
                $"  <data name=\"{i.Name}\" type=\"System.Drawing.Bitmap, System.Drawing.Common\" mimetype=\"application/x-microsoft.net.object.bytearray.base64\"><value>{i.Base64Png}</value></data>\r\n"))
            + "</root>\r\n";

        /// <summary>The strongly typed accessor class Visual Studio generates for <paramref name="properties"/>.</summary>
        private static string Accessors(string ns, string baseName, params string[] properties) => $$"""
            namespace {{ns}} {
              internal class Resources {
                private static global::System.Resources.ResourceManager resourceMan;
                private static global::System.Globalization.CultureInfo resourceCulture;
                internal static global::System.Resources.ResourceManager ResourceManager {
                  get {
                    if (object.ReferenceEquals(resourceMan, null)) {
                      global::System.Resources.ResourceManager temp = new global::System.Resources.ResourceManager("{{baseName}}", typeof(Resources).Assembly);
                      resourceMan = temp;
                    }
                    return resourceMan;
                  }
                }
            {{string.Concat(properties.Select(p => $$"""
                internal static global::System.Drawing.Bitmap {{p}} {
                  get {
                    object obj = ResourceManager.GetObject("{{p}}", resourceCulture);
                    return ((global::System.Drawing.Bitmap)(obj));
                  }
                }

            """))}}
              }
            }
            """;

        private static void WithFiles(Dictionary<string, string> files, Action<string> test)
        {
            string dir = Path.Combine(Path.GetTempPath(), "wfd-projres-" + Guid.NewGuid().ToString("N"));
            foreach (var file in files)
            {
                string path = Path.Combine(dir, file.Key.Replace('/', Path.DirectorySeparatorChar));
                Directory.CreateDirectory(Path.GetDirectoryName(path)!);
                File.WriteAllText(path, file.Value);
            }
            try { test(dir); }
            finally { try { Directory.Delete(dir, recursive: true); } catch { } }
        }

        [Fact]
        // A tiny PNG may declare a huge canvas: it is refused from its header, before any pixel is decoded.
        public void ProjectResource_ImageBeyondTheDimensionLimit_IsNotRendered()
        {
            WithProject(dir =>
            {
                using (var huge = new Bitmap(5000, 5000, System.Drawing.Imaging.PixelFormat.Format1bppIndexed))
                    huge.Save(Path.Combine(dir, "Resources", "open.png"), System.Drawing.Imaging.ImageFormat.Png);
                string file = WriteForm(dir, "global::Demo.Properties.Resources.OpenImage", "global::Demo.Properties.Resources.Logo");

                var frame = Sta.Invoke(() => DesignerRenderer.RenderWithLayout(file));

                Assert.Empty(frame.Unrepresentable);
                Assert.False(Assert.Single(frame.Controls, c => c.Id == "button1").HasImage);
                Assert.True(Assert.Single(frame.Controls, c => c.Id == "button2").HasImage);
            });
        }

        [Fact]
        // A junction inside the project is a door out of it: the file behind it is never read, and nothing beneath
        // the link is queried (it could be a UNC target that would receive the user's credentials).
        public void ProjectResource_FileReferenceThroughAJunction_IsNotRead()
        {
            string outside = Path.Combine(Path.GetTempPath(), "wfd-projres-outside-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(outside);
            try
            {
                File.WriteAllBytes(Path.Combine(outside, "open.png"), Convert.FromBase64String(Png1x1));
                WithProject(dir =>
                {
                    Directory.Delete(Path.Combine(dir, "Resources"), recursive: true);
                    CreateJunction(Path.Combine(dir, "Resources"), outside);
                    string file = WriteForm(dir, "global::Demo.Properties.Resources.OpenImage", "global::Demo.Properties.Resources.Logo");

                    var frame = Sta.Invoke(() => DesignerRenderer.RenderWithLayout(file));

                    Assert.Empty(frame.Unrepresentable);
                    Assert.False(Assert.Single(frame.Controls, c => c.Id == "button1").HasImage);
                    Assert.True(Assert.Single(frame.Controls, c => c.Id == "button2").HasImage);
                });
            }
            finally { try { Directory.Delete(outside, recursive: true); } catch { } }
        }

        [Fact]
        public void ProjectResource_ResourcePairBehindAJunction_IsNotUsed()
        {
            string outside = Path.Combine(Path.GetTempPath(), "wfd-projres-outside-" + Guid.NewGuid().ToString("N"));
            try
            {
                WithProject(dir =>
                {
                    Directory.Move(Path.Combine(dir, "Properties"), outside);
                    CreateJunction(Path.Combine(dir, "Properties"), outside);
                    string file = WriteForm(dir, "global::Demo.Properties.Resources.Logo", "global::Demo.Properties.Resources.Logo");

                    var frame = Sta.Invoke(() => DesignerRenderer.RenderWithLayout(file));

                    Assert.Contains(frame.Unrepresentable, u => u.Contains("cannot evaluate member access global::Demo.Properties.Resources.Logo"));
                });
            }
            finally { try { Directory.Delete(outside, recursive: true); } catch { } }
        }

        [Fact]
        // C# binds Properties.Resources inside namespace Demo.Forms to Demo.Forms.Properties.Resources. When that pair
        // lies behind a link the walk does not enter, it may still be the class C# binds: the outer class must not
        // stand in. A fully qualified reference has no outer fallback and still resolves.
        public void ProjectResource_UnreadPartOfTheProject_NeverLetsAnOuterClassStandIn()
        {
            string outside = Path.Combine(Path.GetTempPath(), "wfd-projres-outside-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(outside);
            try
            {
                File.WriteAllText(Path.Combine(outside, "Resources.resx"), ResxWith(("Logo", Png1x1)));
                File.WriteAllText(Path.Combine(outside, "Resources.Designer.cs"),
                    Accessors("Demo.Forms.Properties", "Demo.Forms.Properties.Resources", "Logo"));
                WithProject(dir =>
                {
                    Directory.CreateDirectory(Path.Combine(dir, "Forms"));
                    CreateJunction(Path.Combine(dir, "Forms", "Properties"), outside);
                    string file = WriteForm(dir, "Properties.Resources.Logo", "global::Demo.Properties.Resources.Logo", "Demo.Forms", "Forms");

                    var frame = Sta.Invoke(() => DesignerRenderer.RenderWithLayout(file));

                    Assert.Contains(frame.Unrepresentable, u => u.Contains("cannot evaluate member access Properties.Resources.Logo"));
                    Assert.False(Assert.Single(frame.Controls, c => c.Id == "button1").HasImage);
                    Assert.True(Assert.Single(frame.Controls, c => c.Id == "button2").HasImage);
                });
            }
            finally { try { Directory.Delete(outside, recursive: true); } catch { } }
        }

        [Fact]
        // A nested test project belongs to that project however many files its folder holds: it must not make the
        // walk incomplete and so refuse an ordinary non-qualified reference to this project's own resources.
        public void ProjectResource_OversizedNestedProject_KeepsTheWalkComplete()
        {
            WithProject(dir =>
            {
                string tests = Directory.CreateDirectory(Path.Combine(dir, "Tests")).FullName;
                for (int i = 0; i <= 20_000; i++) File.WriteAllBytes(Path.Combine(tests, i + ".bin"), Array.Empty<byte>());
                File.WriteAllText(Path.Combine(tests, "zz.csproj"), "<Project Sdk=\"Microsoft.NET.Sdk\" />");
                string file = WriteForm(dir, "Properties.Resources.Logo", "global::Demo.Properties.Resources.Logo", "Demo.Forms", "Forms");

                var frame = Sta.Invoke(() => DesignerRenderer.RenderWithLayout(file));

                Assert.Empty(frame.Unrepresentable);
                Assert.True(Assert.Single(frame.Controls, c => c.Id == "button1").HasImage);
            });
        }

        [Fact]
        // A data folder that sorts before Properties and holds more entries than one directory may list is skipped;
        // it must not end the walk before the project's own resources are found.
        public void ProjectResource_OversizedSiblingFolder_DoesNotHideTheProjectsResources()
        {
            WithProject(dir =>
            {
                string data = Directory.CreateDirectory(Path.Combine(dir, "Data")).FullName;
                for (int i = 0; i <= 20_000; i++) File.WriteAllBytes(Path.Combine(data, i + ".bin"), Array.Empty<byte>());
                string file = WriteForm(dir, "global::Demo.Properties.Resources.Logo", "global::Demo.Properties.Resources.OpenImage");

                var frame = Sta.Invoke(() => DesignerRenderer.RenderWithLayout(file));

                Assert.Empty(frame.Unrepresentable);
                Assert.True(Assert.Single(frame.Controls, c => c.Id == "button1").HasImage);
                Assert.True(Assert.Single(frame.Controls, c => c.Id == "button2").HasImage);
            });
        }

        [Fact]
        // A Directory.Build.props that is a link could point anywhere (a UNC target would receive the user's
        // credentials); it is never read, and since it could rename every resource below it, nothing is proven.
        public void ProjectResource_LinkedDirectoryBuildProps_IsNotReadAndProvesNothing()
        {
            string outside = Path.Combine(Path.GetTempPath(), "wfd-projres-outside-" + Guid.NewGuid().ToString("N") + ".props");
            File.WriteAllText(outside, "<Project />");
            try
            {
                WithProject(dir =>
                {
                    File.CreateSymbolicLink(Path.Combine(dir, "Directory.Build.props"), outside);
                    string file = WriteForm(dir, "global::Demo.Properties.Resources.Logo", "global::Demo.Properties.Resources.Logo");

                    var frame = Sta.Invoke(() => DesignerRenderer.RenderWithLayout(file));

                    Assert.Contains(frame.Unrepresentable, u => u.Contains("cannot evaluate member access global::Demo.Properties.Resources.Logo"));
                });
            }
            finally { try { File.Delete(outside); } catch { } }
        }

        [Fact]
        // A directory can be case-sensitive, so a reference that re-enters the project under a differently cased name
        // may be a different tree from the one that was checked: it is not read.
        public void ProjectResource_FileReferenceReenteringTheProjectInAnotherCase_IsNotRead()
        {
            WithProject(dir =>
            {
                string resx = Path.Combine(dir, "Properties", "Resources.resx");
                File.WriteAllText(resx, File.ReadAllText(resx).Replace(@"..\Resources\open.png",
                    @"..\..\" + Path.GetFileName(dir).ToUpperInvariant() + @"\Resources\open.png"));
                string file = WriteForm(dir, "global::Demo.Properties.Resources.OpenImage", "global::Demo.Properties.Resources.Logo");

                var frame = Sta.Invoke(() => DesignerRenderer.RenderWithLayout(file));

                Assert.Empty(frame.Unrepresentable);
                Assert.False(Assert.Single(frame.Controls, c => c.Id == "button1").HasImage);
                Assert.True(Assert.Single(frame.Controls, c => c.Id == "button2").HasImage);
            });
        }

        [Fact]
        // Opened by path, "Res " is trimmed to "Res": the check would inspect one directory and the read go through
        // the other. A name the OS would normalize is not read.
        public void ProjectResource_FileReferenceThroughANameWithATrailingSpace_IsNotRead()
        {
            WithProject(dir =>
            {
                string trailing = @"\\?\" + Path.Combine(dir, "Res ");
                Directory.CreateDirectory(Path.Combine(dir, "Res"));
                Directory.CreateDirectory(trailing);
                File.WriteAllBytes(Path.Combine(trailing, "open.png"), Convert.FromBase64String(Png1x1));
                try
                {
                    string resx = Path.Combine(dir, "Properties", "Resources.resx");
                    File.WriteAllText(resx, File.ReadAllText(resx).Replace(@"..\Resources\open.png", @"..\Res \open.png"));
                    string file = WriteForm(dir, "global::Demo.Properties.Resources.OpenImage", "global::Demo.Properties.Resources.Logo");

                    var frame = Sta.Invoke(() => DesignerRenderer.RenderWithLayout(file));

                    Assert.Empty(frame.Unrepresentable);
                    Assert.False(Assert.Single(frame.Controls, c => c.Id == "button1").HasImage);
                    Assert.True(Assert.Single(frame.Controls, c => c.Id == "button2").HasImage);
                }
                finally { try { Directory.Delete(trailing, recursive: true); } catch { } }
            });
        }

        [Fact]
        // Without an IUIService on the surface, a control that throws makes the WinForms designer open a modal
        // MessageBox on the user's desktop and block the engine. Every designer must find the headless one instead.
        public void Designers_FindTheHeadlessUIService_SoNoErrorWindowCanOpen()
        {
            UiServiceProbeDesigner.SeenService = null;
            WithDesigner("""
                namespace Demo
                {
                    partial class Form1 : System.Windows.Forms.Form
                    {
                        private Engine.UnitTests.UiServiceProbePanel panel1;
                        private void InitializeComponent()
                        {
                            this.panel1 = new Engine.UnitTests.UiServiceProbePanel();
                            this.panel1.Name = "panel1";
                            this.ClientSize = new System.Drawing.Size(200, 100);
                            this.Controls.Add(this.panel1);
                        }
                    }
                }
                """, file =>
            {
                string assembly = typeof(UiServiceProbePanel).Assembly.Location;
                Sta.Invoke(() => DesignerRenderer.RenderWithLayout(file, assembly));

                Assert.Equal(nameof(HeadlessDesignerUIService), UiServiceProbeDesigner.SeenService);
            });
        }

        [Fact]
        public void HeadlessUIService_RecordsErrorsAndAnswersEveryQuestionWithCancel()
        {
            var ui = new HeadlessDesignerUIService();

            ui.ShowError(new InvalidOperationException("The control X has thrown an unhandled exception.\r\n\r\nStack trace:\r\n   at X.OnLayout()"));
            ui.ShowMessage("ignored");

            Assert.Equal("The control X has thrown an unhandled exception. Stack trace: at X.OnLayout()", Assert.Single(ui.Errors));
            Assert.Equal(System.Windows.Forms.DialogResult.Cancel, ui.ShowMessage("?", "?", System.Windows.Forms.MessageBoxButtons.YesNo));
            Assert.Equal(System.Windows.Forms.DialogResult.Cancel, ui.ShowDialog(null!));
            Assert.False(ui.CanShowComponentEditor(new object()));
            Assert.False(ui.ShowToolWindow(Guid.NewGuid()));
        }

        [Theory]
        // DevExpress expands <use> recursively: a reference to its own ancestor overflows the stack and kills the engine.
        [InlineData("<svg xmlns='http://www.w3.org/2000/svg' xmlns:xlink='http://www.w3.org/1999/xlink'><g id='g'><use xlink:href='#g'/></g></svg>", false)]
        [InlineData("<svg xmlns='http://www.w3.org/2000/svg'><g id='a'><use href='#b'/></g><g id='b'><use href='#a'/></g><use href='#a'/></svg>", false)]
        [InlineData("<svg xmlns='http://www.w3.org/2000/svg'><defs><g id='a'><rect/></g></defs><use href='#a'/><use href='#a'/></svg>", true)]
        [InlineData("<svg xmlns='http://www.w3.org/2000/svg'><use href='#missing'/></svg>", true)]
        public void SvgPayload_ReferenceCyclesAreRefused(string svg, bool accepted) =>
            Assert.Equal(accepted, ProjectResourceResolver.IsSafeSvgDocument(System.Text.Encoding.UTF8.GetBytes(svg)));

        [Fact]
        // Illustrator and the DevExpress gallery emit the standard external SVG 1.1 DOCTYPE: it is dropped unread so
        // the icon still renders, while a DOCTYPE that declares entities leaves an undeclared reference and is refused.
        public void SvgPayload_StandardDocumentTypeIsDroppedAndEntityDeclarationsStayRefused()
        {
            const string withDoctype = "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n"
                + "<!DOCTYPE svg PUBLIC \"-//W3C//DTD SVG 1.1//EN\" \"http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd\">\n"
                + "<svg xmlns=\"http://www.w3.org/2000/svg\" xml:space=\"preserve\"><path d=\"M0,0\"/></svg>";
            byte[]? cleaned = ProjectResourceResolver.WithoutDocumentType(System.Text.Encoding.UTF8.GetBytes(withDoctype));
            Assert.NotNull(cleaned);
            string text = System.Text.Encoding.UTF8.GetString(cleaned!);
            Assert.DoesNotContain("DOCTYPE", text);
            Assert.Contains("<path d=\"M0,0\"", text);
            Assert.True(ProjectResourceResolver.IsSafeSvgDocument(cleaned!));

            const string withEntity = "<!DOCTYPE svg [<!ENTITY e \"x\">]><svg xmlns=\"http://www.w3.org/2000/svg\"><text>&e;</text></svg>";
            Assert.Null(ProjectResourceResolver.WithoutDocumentType(System.Text.Encoding.UTF8.GetBytes(withEntity)));
        }

        [Theory]
        // DevExpress decodes SVG as UTF-8 unless a byte order mark says otherwise, whatever the declaration names. The
        // cleaned document must carry the same text the vendor would have read from the original bytes.
        [InlineData(false)]
        [InlineData(true)]
        public void SvgPayload_TextIsDecodedTheWayTheVendorDecodesIt(bool withDoctype)
        {
            string svg = "<?xml version=\"1.0\" encoding=\"ISO-8859-1\"?>\n"
                + (withDoctype ? "<!DOCTYPE svg PUBLIC \"-//W3C//DTD SVG 1.1//EN\" \"http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd\">\n" : "")
                + "<svg xmlns=\"http://www.w3.org/2000/svg\"><text>café</text></svg>";
            byte[]? cleaned = ProjectResourceResolver.WithoutDocumentType(System.Text.Encoding.Latin1.GetBytes(svg));

            Assert.NotNull(cleaned);
            Assert.Contains("<text>caf�</text>", System.Text.Encoding.UTF8.GetString(cleaned!));

            byte[] utf16 = System.Text.Encoding.Unicode.GetPreamble()
                .Concat(System.Text.Encoding.Unicode.GetBytes("<svg xmlns=\"http://www.w3.org/2000/svg\"><text>café</text></svg>")).ToArray();
            Assert.Contains("<text>café</text>", System.Text.Encoding.UTF8.GetString(ProjectResourceResolver.WithoutDocumentType(utf16)!));
        }

        [Fact]
        // Two of the 3063 DevExpress gallery icons repeat an id; that alone must not refuse the icon, but a reference
        // still reaches every element carrying the id when cycles are checked.
        public void SvgPayload_RepeatedIdsAreAcceptedButStillCheckedForCycles()
        {
            static bool Safe(string svg) => ProjectResourceResolver.IsSafeSvgDocument(System.Text.Encoding.UTF8.GetBytes(svg));

            Assert.True(Safe("<svg xmlns='http://www.w3.org/2000/svg'><g id='Icon'><rect/></g><g id='Icon'><circle/></g><use href='#Icon'/></svg>"));
            Assert.False(Safe("<svg xmlns='http://www.w3.org/2000/svg' id='Icon'><g id='Icon'><rect/></g><use href='#Icon'/></svg>"));
        }

        [Fact]
        // Each level doubles the previous one: 2^20 instantiated elements from a 1 KB file.
        public void SvgPayload_ExponentialReferenceExpansion_IsRefused()
        {
            var svg = new System.Text.StringBuilder("<svg xmlns='http://www.w3.org/2000/svg'><defs><g id='g0'><rect/></g>");
            for (int k = 1; k <= 20; k++) svg.Append($"<g id='g{k}'><use href='#g{k - 1}'/><use href='#g{k - 1}'/></g>");
            svg.Append("</defs><use href='#g20'/></svg>");

            Assert.False(ProjectResourceResolver.IsSafeSvgDocument(System.Text.Encoding.UTF8.GetBytes(svg.ToString())));
        }

        [Theory]
        [InlineData(10001, 1, false)]
        [InlineData(1, 65, false)]
        [InlineData(500, 30, true)]
        public void SvgPayload_SizeAndDepthAreBounded(int elements, int depth, bool accepted)
        {
            string svg = "<svg xmlns='http://www.w3.org/2000/svg'>" + string.Concat(Enumerable.Repeat("<g>", depth - 1))
                + string.Concat(Enumerable.Repeat("<rect/>", elements)) + string.Concat(Enumerable.Repeat("</g>", depth - 1)) + "</svg>";
            Assert.Equal(accepted, ProjectResourceResolver.IsSafeSvgDocument(System.Text.Encoding.UTF8.GetBytes(svg)));
        }

        [Fact]
        // GDI+ parses every GIF frame on load; the block walk refuses a frame bomb before GDI+ sees it.
        public void RasterPayload_GifWithTooManyFrames_IsRefusedAndAnOrdinaryGifDecodes()
        {
            var bomb = new List<byte>(System.Text.Encoding.ASCII.GetBytes("GIF89a")) { 1, 0, 1, 0, 0, 0, 0 };
            for (int i = 0; i < 300; i++)
                bomb.AddRange(new byte[] { 0x2C, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0x02, 0x02, 0x44, 0x01, 0x00 });
            bomb.Add(0x3B);
            Assert.Null(ProjectResourceResolver.DecodeBitmap(bomb.ToArray()));

            using var ordinary = new Bitmap(4, 3);
            using var gif = new MemoryStream();
            ordinary.Save(gif, System.Drawing.Imaging.ImageFormat.Gif);
            using var decoded = ProjectResourceResolver.DecodeBitmap(gif.ToArray());
            Assert.Equal(new Size(4, 3), decoded!.Size);
        }

        [Fact]
        // The icon directory alone is not trusted: an entry's embedded PNG declares the real size.
        public void RasterPayload_IconEntryDeclaringAHugeImage_IsRefusedAndAnOrdinaryIconDecodes()
        {
            var huge = new byte[6 + 16 + 24];
            huge[2] = 1; huge[4] = 1;
            BitConverter.GetBytes(24).CopyTo(huge, 6 + 8);
            BitConverter.GetBytes(6 + 16).CopyTo(huge, 6 + 12);
            new byte[] { 0x89, (byte)'P', (byte)'N', (byte)'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, (byte)'I', (byte)'H', (byte)'D', (byte)'R',
                0, 0, 0x13, 0x88, 0, 0, 0x13, 0x88 }.CopyTo(huge, 6 + 16);
            Assert.Null(ProjectResourceResolver.DecodeIcon(huge));

            using var ico = new MemoryStream();
            SystemIcons.Application.Save(ico);
            using var decoded = ProjectResourceResolver.DecodeIcon(ico.ToArray());
            Assert.NotNull(decoded);
        }

        [Fact]
        // Old icons store BITMAPCOREHEADER (12 bytes, 16-bit sizes); the bound must read it rather than refuse it.
        public void RasterPayload_IconWithACoreHeader_Decodes()
        {
            var core = new List<byte> { 0, 0, 1, 0, 1, 0 };
            int dib = 12 + 2 * 3 + 16 * 4 + 16 * 4; // header, 2-colour palette, XOR and AND masks (rows padded to 4 bytes)
            core.AddRange(new byte[] { 16, 16, 2, 0, 1, 0, 1, 0 });
            core.AddRange(BitConverter.GetBytes(dib));
            core.AddRange(BitConverter.GetBytes(6 + 16));
            core.AddRange(BitConverter.GetBytes(12));
            core.AddRange(BitConverter.GetBytes((ushort)16));
            core.AddRange(BitConverter.GetBytes((ushort)32));
            core.AddRange(BitConverter.GetBytes((ushort)1));
            core.AddRange(BitConverter.GetBytes((ushort)1));
            core.AddRange(new byte[] { 0, 0, 0, 0xFF, 0xFF, 0xFF });
            core.AddRange(new byte[16 * 4 + 16 * 4]);

            using var decoded = ProjectResourceResolver.DecodeIcon(core.ToArray());
            Assert.NotNull(decoded);
            Assert.Equal(new Size(16, 16), decoded!.Size);
        }

        [Theory]
        // Metafiles can embed rasters far larger than their frame and TIFF can hold many pages: refused outright.
        [InlineData(new byte[] { 0x01, 0, 0, 0, 0x6C, 0, 0, 0, 0, 0, 0, 0 })]
        [InlineData(new byte[] { (byte)'I', (byte)'I', 0x2A, 0, 8, 0, 0, 0 })]
        [InlineData(new byte[] { 0xD7, 0xCD, 0xC6, 0x9A, 0, 0 })]
        public void RasterPayload_UnlistedFormats_AreRefused(byte[] header) =>
            Assert.Null(ProjectResourceResolver.DecodeBitmap(header));

        [Theory]
        [InlineData("<svg xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M0,0\"/></svg>", "utf-8", true)]
        [InlineData("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<svg version=\"1.1\"/>", "utf-8-bom", true)]
        [InlineData("<?xml version=\"1.0\"?><!DOCTYPE svg [<!ENTITY x SYSTEM \"file:///c:/windows/win.ini\">]><svg>&x;</svg>", "utf-8", false)]
        [InlineData("<?xml version=\"1.0\" encoding=\"UTF-16\"?><!DOCTYPE svg [<!ENTITY x \"y\">]><svg>&x;</svg>", "utf-16-no-bom", false)]
        [InlineData("<html><svg/></html>", "utf-8", false)]
        [InlineData("not markup", "utf-8", false)]
        public void SvgPayload_MustBeAnSvgDocumentWithoutADtd(string text, string encoding, bool accepted)
        {
            byte[] bytes = encoding switch
            {
                "utf-8-bom" => new System.Text.UTF8Encoding(true).GetPreamble().Concat(System.Text.Encoding.UTF8.GetBytes(text)).ToArray(),
                "utf-16-no-bom" => System.Text.Encoding.Unicode.GetBytes(text),
                _ => System.Text.Encoding.UTF8.GetBytes(text),
            };
            Assert.Equal(accepted, ProjectResourceResolver.IsSafeSvgDocument(bytes));
        }

        [Fact]
        public void SvgPayload_SerializedObjectBytes_AreRefused() =>
            Assert.False(ProjectResourceResolver.IsSafeSvgDocument(new byte[] { 0x00, 0x01, 0x00, 0x00, 0x00, 0xFF, 0xFF, 0xFF, 0xFF, 0x01 }));

        private static void CreateJunction(string link, string target)
        {
            var start = new System.Diagnostics.ProcessStartInfo("cmd.exe", $"/c mklink /J \"{link}\" \"{target}\"")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            using var process = System.Diagnostics.Process.Start(start)!;
            process.WaitForExit();
            Assert.True(process.ExitCode == 0 && Directory.Exists(link), "could not create a junction for the test");
        }

        [Fact]
        public void ProjectResource_MemberTheProjectDoesNotDeclare_StaysUnrepresentable()
        {
            WithProject(dir =>
            {
                string file = WriteForm(dir, "global::Demo.Properties.Resources.Missing", "global::Other.Properties.Resources.Logo");

                var frame = Sta.Invoke(() => DesignerRenderer.RenderWithLayout(file));

                Assert.Contains(frame.Unrepresentable, u => u.Contains("cannot evaluate member access global::Demo.Properties.Resources.Missing"));
                Assert.Contains(frame.Unrepresentable, u => u.Contains("cannot evaluate member access global::Other.Properties.Resources.Logo"));
            });
        }

        [Fact]
        public void RootNestedProperty_IsAppliedThroughTheRootInstance()
        {
            WithDesigner("""
                namespace Engine.UnitTests
                {
                    partial class AppearanceDerivedForm : AppearanceRootForm
                    {
                        private void InitializeComponent()
                        {
                            this.Appearance.BackColor = System.Drawing.Color.Red;
                            this.Appearance.Options.UseBackColor = true;
                            this.ClientSize = new System.Drawing.Size(200, 100);
                            this.Name = "AppearanceDerivedForm";
                        }
                    }
                }
                """, file =>
            {
                string assembly = typeof(AppearanceDerivedForm).Assembly.Location;
                var frame = Sta.Invoke(() => DesignerRenderer.RenderWithLayout(file, assembly));
                var root = Sta.Invoke(() => DesignerRenderer.DescribeComponent(file, "this", assembly));

                Assert.Empty(frame.Unrepresentable);
                Assert.Contains("Red", Assert.Single(root!.Properties, p => p.Name == "BackColor").Value);
            });
        }

        [Fact]
        // A field whose creation failed must not be re-targeted at a same-named property of the root.
        public void RootNestedProperty_NeverRetargetsAFieldName()
        {
            WithDesigner("""
                namespace Engine.UnitTests
                {
                    partial class AppearanceDerivedForm : AppearanceRootForm
                    {
                        private Missing.Widget Appearance;
                        private void InitializeComponent()
                        {
                            this.Appearance = new Missing.Widget();
                            this.Appearance.BackColor = System.Drawing.Color.Red;
                            this.ClientSize = new System.Drawing.Size(200, 100);
                        }
                    }
                }
                """, file =>
            {
                string assembly = typeof(AppearanceDerivedForm).Assembly.Location;
                var frame = Sta.Invoke(() => DesignerRenderer.RenderWithLayout(file, assembly));

                Assert.Contains(frame.Unrepresentable, u => u.Contains("unrecognized LHS this.Appearance.BackColor"));
            });
        }

        [Fact]
        // DesignSurface reports a throwing root constructor through LoadErrors, not an exception: the documented
        // framework-surface fallback must still engage instead of failing the whole render.
        public void ThrowingBaseConstructor_FallsBackToTheIncompleteFrameworkPreview()
        {
            WithDesigner("""
                namespace Engine.UnitTests
                {
                    partial class ThrowingCtorDerivedForm : ThrowingCtorBaseForm
                    {
                        private System.Windows.Forms.Button currentButton;
                        private void InitializeComponent()
                        {
                            this.currentButton = new System.Windows.Forms.Button();
                            this.currentButton.Name = "currentButton";
                            this.currentButton.Location = new System.Drawing.Point(8, 8);
                            this.currentButton.Size = new System.Drawing.Size(90, 28);
                            this.ClientSize = new System.Drawing.Size(160, 70);
                            this.Controls.Add(this.currentButton);
                        }
                    }
                }
                """, file =>
            {
                string assembly = typeof(ThrowingCtorDerivedForm).Assembly.Location;
                var frame = Sta.Invoke(() => DesignerRenderer.RenderWithLayout(file, assembly));

                Assert.True(frame.InheritedBase);
                Assert.Equal("System.Windows.Forms.Form", frame.RootType);
                Assert.Single(frame.Controls, c => c.Id == "currentButton");
            });
        }

        [Theory]
        // DevExpress's LayoutControl arranges its items only at EndInit; the bracket must run on the real instance.
        [InlineData(true)]
        // A BeginInit the source never closes is closed when the pass ends instead of leaving the control half-built.
        [InlineData(false)]
        public void SupportInitializeBracket_IsReplayedOnTheRealInstance(bool sourceClosesTheBracket)
        {
            WithDesigner($$"""
                namespace Demo
                {
                    partial class Form1 : System.Windows.Forms.Form
                    {
                        private FakeVendor.DataPanel dataPanel1;
                        private void InitializeComponent()
                        {
                            this.dataPanel1 = new FakeVendor.DataPanel();
                            ((System.ComponentModel.ISupportInitialize)(this.dataPanel1)).BeginInit();
                            this.SuspendLayout();
                            this.dataPanel1.Location = new System.Drawing.Point(8, 8);
                            this.dataPanel1.Name = "dataPanel1";
                            this.dataPanel1.Size = new System.Drawing.Size(120, 60);
                            this.ClientSize = new System.Drawing.Size(200, 100);
                            this.Controls.Add(this.dataPanel1);
                            this.Name = "Form1";
                            {{(sourceClosesTheBracket ? "((System.ComponentModel.ISupportInitialize)(this.dataPanel1)).EndInit();" : "")}}
                            this.ResumeLayout(false);
                        }
                    }
                }
                """, file =>
            {
                string assembly = typeof(FakeVendor.DataPanel).Assembly.Location;
                var panel = Sta.Invoke(() => DesignerRenderer.DescribeComponent(file, "dataPanel1", assembly));

                Assert.Equal("True", Assert.Single(panel!.Properties, p => p.Name == "IsInitialized").Value);
            });
        }

        [Fact]
        // The designer closes a BeginInit the source left open; when that EndInit fails the surface is incomplete and
        // must say so, exactly as it would for the same failure on an explicit EndInit statement.
        public void UnclosedInitBracketWhoseEndInitFails_IsReportedAsUnrepresentable()
        {
            WithDesigner("""
                namespace Demo
                {
                    partial class Form1 : System.Windows.Forms.Form
                    {
                        private Engine.UnitTests.FailingInitPanel panel1;
                        private void InitializeComponent()
                        {
                            this.panel1 = new Engine.UnitTests.FailingInitPanel();
                            ((System.ComponentModel.ISupportInitialize)(this.panel1)).BeginInit();
                            this.panel1.Name = "panel1";
                            this.ClientSize = new System.Drawing.Size(200, 100);
                            this.Controls.Add(this.panel1);
                        }
                    }
                }
                """, file =>
            {
                string assembly = typeof(FailingInitPanel).Assembly.Location;
                var frame = Sta.Invoke(() => DesignerRenderer.RenderWithLayout(file, assembly));

                Assert.Contains(frame.Unrepresentable, u => u.Contains("unclosed EndInit of panel1") && u.Contains("batched state rejected"));
            });
        }

        [Fact]
        public void VendorValueConstruction_RequiresTheVendorsAssemblyIdentity()
        {
            Assert.False(DesignerAllowlists.IsVendorValueConstructionAllowed(typeof(DevExpress.XtraLayout.Utils.Padding)));
            Assert.False(DesignerAllowlists.IsDevExpressAssembly(typeof(DevExpress.XtraLayout.Utils.Padding).Assembly));
            Assert.False(DesignerAllowlists.IsDevExpressAssembly(typeof(object).Assembly));

            var devExpress = DynamicAssembly("DevExpress.XtraLayout.v99.9", Convert.FromHexString(DevExpressPublicKey));
            Assert.True(DesignerAllowlists.IsDevExpressAssembly(devExpress.assembly));
            Assert.True(DesignerAllowlists.IsVendorValueConstructionAllowed(devExpress.padding));
            Assert.False(DesignerAllowlists.IsVendorValueConstructionAllowed(devExpress.other));

            var otherKey = Convert.FromHexString(DevExpressPublicKey);
            otherKey[^1] ^= 0xFF;
            var forged = DynamicAssembly("DevExpress.XtraLayout.v99.9", otherKey);
            Assert.False(DesignerAllowlists.IsVendorValueConstructionAllowed(forged.padding));
        }

        // DevExpress's PUBLIC strong-name key (token b88d1754d700e49a), as carried in the metadata of its assemblies.
        private const string DevExpressPublicKey =
            "0024000004800000940000000602000000240000525341310004000001000100DFCD8CADC2DD24A7CD4CE95C4A9C1B8E"
            + "7CB1DC2D665120556B4B0EC35495FDDB2BD6EED0CA1E56480276295A225BA2A9746F3D3E1A04547CCF5B26ACC3F96EB2"
            + "A13AC467512497AA79208E32F242FD0618014D53C95A36E5DE0E891873841FA8F559566E38E968426488B4AA4D0F0B59"
            + "E59F38DCF3FBCCF25D990AB19C27DDC2";

        private static (Assembly assembly, Type padding, Type other) DynamicAssembly(string name, byte[] publicKey)
        {
            var assemblyName = new AssemblyName(name);
            assemblyName.SetPublicKey(publicKey);
            var builder = AssemblyBuilder.DefineDynamicAssembly(assemblyName, AssemblyBuilderAccess.Run);
            var module = builder.DefineDynamicModule(name);
            var padding = module.DefineType("DevExpress.XtraLayout.Utils.Padding",
                TypeAttributes.Public | TypeAttributes.Sealed, typeof(ValueType)).CreateType()!;
            var other = module.DefineType("DevExpress.XtraLayout.Utils.Location",
                TypeAttributes.Public | TypeAttributes.Sealed, typeof(ValueType)).CreateType()!;
            return (builder, padding, other);
        }

        private static string WriteForm(string dir, string firstImage, string secondImage, string ns = "Demo", string folder = "")
        {
            Directory.CreateDirectory(Path.Combine(dir, folder));
            string file = Path.Combine(dir, folder, "Form1.Designer.cs");
            File.WriteAllText(file, $$"""
                namespace {{ns}}
                {
                    partial class Form1 : System.Windows.Forms.Form
                    {
                        private System.Windows.Forms.Button button1;
                        private System.Windows.Forms.Button button2;
                        private void InitializeComponent()
                        {
                            this.button1 = new System.Windows.Forms.Button();
                            this.button2 = new System.Windows.Forms.Button();
                            this.button1.Image = {{firstImage}};
                            this.button1.Location = new System.Drawing.Point(8, 8);
                            this.button1.Name = "button1";
                            this.button1.Size = new System.Drawing.Size(90, 28);
                            this.button2.Image = {{secondImage}};
                            this.button2.Location = new System.Drawing.Point(8, 44);
                            this.button2.Name = "button2";
                            this.button2.Size = new System.Drawing.Size(90, 28);
                            this.ClientSize = new System.Drawing.Size(200, 100);
                            this.Controls.Add(this.button1);
                            this.Controls.Add(this.button2);
                            this.Name = "Form1";
                        }
                    }
                }
                """);
            return file;
        }

        private static void WithProject(Action<string> test, string? cleanupSibling = null)
        {
            string dir = Path.Combine(Path.GetTempPath(), "wfd-projres-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(Path.Combine(dir, "Properties"));
            Directory.CreateDirectory(Path.Combine(dir, "Resources"));
            File.WriteAllText(Path.Combine(dir, "Demo.csproj"), "<Project Sdk=\"Microsoft.NET.Sdk\" />");
            File.WriteAllBytes(Path.Combine(dir, "Resources", "open.png"), Convert.FromBase64String(Png1x1));
            File.WriteAllText(Path.Combine(dir, "Properties", "Resources.resx"), $$"""
                <?xml version="1.0" encoding="utf-8"?>
                <root>
                  <resheader name="resmimetype"><value>text/microsoft-resx</value></resheader>
                  <resheader name="version"><value>2.0</value></resheader>
                  <data name="Logo" type="System.Drawing.Bitmap, System.Drawing.Common" mimetype="application/x-microsoft.net.object.bytearray.base64">
                    <value>{{Png1x1}}</value>
                  </data>
                  <data name="OpenImage" type="System.Resources.ResXFileRef, System.Windows.Forms">
                    <value>..\Resources\open.png;System.Drawing.Bitmap, System.Drawing.Common</value>
                  </data>
                  <data name="Escape" type="System.Resources.ResXFileRef, System.Windows.Forms">
                    <value>..\..\{{Path.GetFileName(dir)}}-outside.png;System.Drawing.Bitmap, System.Drawing.Common</value>
                  </data>
                  <data name="Network" type="System.Resources.ResXFileRef, System.Windows.Forms">
                    <value>\\resource-host\share\open.png;System.Drawing.Bitmap, System.Drawing.Common</value>
                  </data>
                </root>
                """);
            File.WriteAllText(Path.Combine(dir, "Properties", "Resources.Designer.cs"), """
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
                    internal static global::System.Drawing.Bitmap OpenImage {
                      get {
                        object obj = ResourceManager.GetObject("OpenImage", resourceCulture);
                        return ((global::System.Drawing.Bitmap)(obj));
                      }
                    }
                    internal static global::System.Drawing.Bitmap Escape {
                      get {
                        object obj = ResourceManager.GetObject("Escape", resourceCulture);
                        return ((global::System.Drawing.Bitmap)(obj));
                      }
                    }
                    internal static global::System.Drawing.Bitmap Network {
                      get {
                        object obj = ResourceManager.GetObject("Network", resourceCulture);
                        return ((global::System.Drawing.Bitmap)(obj));
                      }
                    }
                  }
                }
                """);
            try { test(dir); }
            finally
            {
                try { Directory.Delete(dir, recursive: true); } catch { }
                if (cleanupSibling != null)
                    try { File.Delete(Path.Combine(Path.GetDirectoryName(dir)!, Path.GetFileName(dir) + cleanupSibling)); } catch { }
            }
        }

        private static void WithDesigner(string source, Action<string> test)
        {
            string file = Path.Combine(Path.GetTempPath(), "wfd-vendor-" + Guid.NewGuid().ToString("N") + ".Designer.cs");
            File.WriteAllText(file, source);
            try { test(file); }
            finally { try { File.Delete(file); } catch { } }
        }
    }
}
