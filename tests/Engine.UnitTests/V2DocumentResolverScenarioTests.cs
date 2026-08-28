using WinFormsDesigner.Engine;

namespace Engine.UnitTests;

public sealed class V2DocumentResolverScenarioTests
{
    [Fact]
    public void V2_FND_001_S009_RefusesNestedPartialFormLikeVisualStudio()
    {
        string root = CreateTempDir();
        try
        {
            string project = Path.Combine(root, "Catalog.App.csproj");
            string designer = Path.Combine(root, "Views", "InnerForm.Designer.cs");
            Directory.CreateDirectory(Path.GetDirectoryName(designer)!);
            File.WriteAllText(project, "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><UseWindowsForms>true</UseWindowsForms></PropertyGroup></Project>");
            File.WriteAllText(designer, """
                namespace Catalog.App.Views
                {
                    public partial class Outer
                    {
                        public partial class InnerForm
                        {
                            private void InitializeComponent()
                            {
                            }
                        }
                    }
                }
                """);

            var result = ProjectResolver.ResolveDesignerDocumentOwner(designer, new[] { project });

            Assert.Equal(DesignerDocumentOwnerStatus.UnsupportedNestedDesigner, result.Status);
            Assert.Equal("NESTED_DESIGNER_UNSUPPORTED", result.DiagnosticCode);
            Assert.Empty(result.ProjectPath);
            Assert.Equal("Catalog.App.Views.Outer+InnerForm", result.TypeName);
        }
        finally
        {
            TryDelete(root);
        }
    }

    [Fact]
    public void V2_FND_001_S010_RefusesAmbiguousPartialDesignerOwnership()
    {
        string root = CreateTempDir();
        try
        {
            string shared = Path.Combine(root, "Shared", "SharedForm.Designer.cs");
            Directory.CreateDirectory(Path.GetDirectoryName(shared)!);
            File.WriteAllText(shared, "namespace Catalog.Shared { partial class SharedForm { private void InitializeComponent() { } } }");

            string firstDir = Path.Combine(root, "AppOne");
            string secondDir = Path.Combine(root, "AppTwo");
            Directory.CreateDirectory(firstDir);
            Directory.CreateDirectory(secondDir);
            string firstProject = Path.Combine(firstDir, "AppOne.csproj");
            string secondProject = Path.Combine(secondDir, "AppTwo.csproj");
            File.WriteAllText(firstProject, ProjectWithCompile(@"..\Shared\SharedForm.Designer.cs"));
            File.WriteAllText(secondProject, ProjectWithCompile(@"..\Shared\SharedForm.Designer.cs"));

            var result = ProjectResolver.ResolveDesignerDocumentOwner(shared, new[] { firstProject, secondProject });

            Assert.Equal(DesignerDocumentOwnerStatus.AmbiguousOwner, result.Status);
            Assert.Equal("AMBIGUOUS_OWNER", result.DiagnosticCode);
            Assert.Equal("Catalog.Shared.SharedForm", result.TypeName);
            Assert.Equal(new[] { firstProject, secondProject }.OrderBy(p => p, StringComparer.OrdinalIgnoreCase), result.Owners);
        }
        finally
        {
            TryDelete(root);
        }
    }

    // Refusing on candidate COUNT alone made every shared-project / linked-file workspace unrenderable — worse than
    // the previous release, which rendered them. Naming one contender is safe exactly where the owner cannot reach
    // the renderer: the modern route passes no assembly and the engine finds its own project from the designer file.
    [Fact]
    public void TwoModernOwners_PickTheOrdinalFirstDeterministically_AndReportEveryContender()
    {
        string root = CreateTempDir();
        try
        {
            var (shared, first, second) = SharedByTwo(root, include => SdkProjectWithCompile(include, "net10.0-windows"));

            var result = ProjectResolver.ResolveDesignerDocumentOwner(shared, new[] { first, second });
            Assert.Equal(DesignerDocumentOwnerStatus.Resolved, result.Status);
            Assert.Equal("NONE", result.DiagnosticCode);
            Assert.True(result.SelectedAmongEquivalentOwners);
            Assert.Equal(new[] { first, second }.OrderBy(p => p, StringComparer.OrdinalIgnoreCase), result.Owners);
            Assert.Equal(new[] { first, second }.OrderBy(p => p, StringComparer.OrdinalIgnoreCase).First(), result.ProjectPath);

            // Independent of the order the workspace happened to enumerate the projects in.
            var reversed = ProjectResolver.ResolveDesignerDocumentOwner(shared, new[] { second, first });
            Assert.Equal(result.ProjectPath, reversed.ProjectPath);
        }
        finally
        {
            TryDelete(root);
        }
    }

    // On the .NET Framework route the host instantiates the form from the OWNER project's compiled binary, so an
    // arbitrary pick could render the wrong build. Multi-target and TFM-less projects are equally unprovable.
    [Theory]
    [InlineData("classic")]
    [InlineData("multiTarget")]
    [InlineData("mixed")]
    public void OwnersThatCanInfluenceTheRender_StayAmbiguous(string shape)
    {
        string root = CreateTempDir();
        try
        {
            var (shared, first, second) = shape switch
            {
                "classic" => SharedByTwo(root, ClassicProjectWithCompile),
                "multiTarget" => SharedByTwo(root, MultiTargetProjectWithCompile),
                _ => SharedByTwo(root, include => SdkProjectWithCompile(include, "net10.0-windows")),
            };
            if (shape == "mixed") File.WriteAllText(second, ClassicProjectWithCompile(@"..\Shared\SharedForm.Designer.cs"));

            var result = ProjectResolver.ResolveDesignerDocumentOwner(shared, new[] { first, second });
            Assert.Equal(DesignerDocumentOwnerStatus.AmbiguousOwner, result.Status);
            Assert.Equal("AMBIGUOUS_OWNER", result.DiagnosticCode);
            Assert.False(result.SelectedAmongEquivalentOwners);
            Assert.Equal("", result.ProjectPath);
        }
        finally
        {
            TryDelete(root);
        }
    }

    [Fact]
    public void SharedProjitemsForm_ResolvesToTheImportingProject()
    {
        string root = CreateTempDir();
        try
        {
            string sharedDir = Path.Combine(root, "Shared");
            string appDir = Path.Combine(root, "App");
            Directory.CreateDirectory(sharedDir);
            Directory.CreateDirectory(appDir);
            string designer = Path.Combine(sharedDir, "SharedForm.Designer.cs");
            string projitems = Path.Combine(sharedDir, "Shared.projitems");
            string project = Path.Combine(appDir, "App.csproj");
            File.WriteAllText(designer,
                "namespace Shared { partial class SharedForm { private void InitializeComponent() { } } }");
            File.WriteAllText(projitems, """
                <Project>
                  <ItemGroup>
                    <Compile Include="$(MSBuildThisFileDirectory)SharedForm.Designer.cs" />
                  </ItemGroup>
                </Project>
                """);
            File.WriteAllText(project, """
                <Project Sdk="Microsoft.NET.Sdk">
                  <Import Project="..\Shared\Shared.projitems" Label="Shared" />
                </Project>
                """);

            var result = ProjectResolver.ResolveDesignerDocumentOwner(designer, new[] { project });

            Assert.Equal(DesignerDocumentOwnerStatus.Resolved, result.Status);
            Assert.Equal(project, result.ProjectPath);
        }
        finally
        {
            TryDelete(root);
        }
    }

    [Fact]
    public void NestedSdkProjectForm_IsOwnedOnlyByTheNestedProject()
    {
        string root = CreateTempDir();
        try
        {
            string childDir = Path.Combine(root, "Child");
            Directory.CreateDirectory(childDir);
            string outerProject = Path.Combine(root, "Outer.csproj");
            string childProject = Path.Combine(childDir, "Child.csproj");
            string designer = Path.Combine(childDir, "ChildForm.Designer.cs");
            const string sdkProject = "<Project Sdk=\"Microsoft.NET.Sdk\" />";
            File.WriteAllText(outerProject, sdkProject);
            File.WriteAllText(childProject, sdkProject);
            File.WriteAllText(designer,
                "namespace Child { partial class ChildForm { private void InitializeComponent() { } } }");

            var result = ProjectResolver.ResolveDesignerDocumentOwner(
                designer, new[] { outerProject, childProject });

            Assert.Equal(DesignerDocumentOwnerStatus.Resolved, result.Status);
            Assert.Equal(childProject, result.ProjectPath);
            Assert.Equal(new[] { childProject }, result.Owners);
        }
        finally
        {
            TryDelete(root);
        }
    }

    [Fact]
    public void V2_FND_001_S012_OpensProvenEmptyFormSurfaceWithoutSynthesizingSource()
    {
        string root = CreateTempDir();
        try
        {
            string project = Path.Combine(root, "Catalog.App.csproj");
            string designer = Path.Combine(root, "MissingInit.Designer.cs");
            File.WriteAllText(project, "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><UseWindowsForms>true</UseWindowsForms></PropertyGroup></Project>");
            File.WriteAllText(designer, "namespace Catalog.App { partial class MissingInit { } }");

            var result = ProjectResolver.ResolveDesignerDocumentOwner(
                designer,
                new[] { project },
                File.ReadAllText(designer),
                "namespace Catalog.App { partial class MissingInit : System.Windows.Forms.Form { } }");

            Assert.Equal(DesignerDocumentOwnerStatus.Resolved, result.Status);
            Assert.Equal("NONE", result.DiagnosticCode);
            Assert.Equal("Catalog.App.MissingInit", result.TypeName);
            Assert.Equal(project, result.ProjectPath);
            Assert.Equal(new[] { project }, result.Owners);
            Assert.True(result.EmptyInitializeComponentSurface);
        }
        finally
        {
            TryDelete(root);
        }
    }

    [Fact]
    public void V2_FND_001_S012_RefusesUnprovenOrNonemptyMissingInitializeComponentSurface()
    {
        string root = CreateTempDir();
        try
        {
            string project = Path.Combine(root, "Catalog.App.csproj");
            string designer = Path.Combine(root, "MissingInit.Designer.cs");
            File.WriteAllText(project, "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><UseWindowsForms>true</UseWindowsForms></PropertyGroup></Project>");
            File.WriteAllText(designer, "namespace Catalog.App { partial class MissingInit { private int unexpected; } }");

            var nonempty = ProjectResolver.ResolveDesignerDocumentOwner(
                designer,
                new[] { project },
                File.ReadAllText(designer),
                "namespace Catalog.App { partial class MissingInit : System.Windows.Forms.Form { } }");
            var unproven = ProjectResolver.ResolveDesignerDocumentOwner(
                designer,
                new[] { project },
                "namespace Catalog.App { partial class MissingInit { } }",
                "namespace Catalog.App { partial class MissingInit : Catalog.App.CustomSurface { } }");

            Assert.Equal(DesignerDocumentOwnerStatus.MissingInitializeComponent, nonempty.Status);
            Assert.Equal("MISSING_INITIALIZE_COMPONENT", nonempty.DiagnosticCode);
            Assert.False(nonempty.EmptyInitializeComponentSurface);
            Assert.Equal(DesignerDocumentOwnerStatus.MissingInitializeComponent, unproven.Status);
            Assert.Equal("MISSING_INITIALIZE_COMPONENT", unproven.DiagnosticCode);
            Assert.False(unproven.EmptyInitializeComponentSurface);
        }
        finally
        {
            TryDelete(root);
        }
    }

    [Fact]
    public void V2_FND_001_S012_UsesHostSuppliedDesignerSourceForOpenGate()
    {
        string root = CreateTempDir();
        try
        {
            string project = Path.Combine(root, "Catalog.App.csproj");
            string designer = Path.Combine(root, "Recovered.Designer.cs");
            File.WriteAllText(project, "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><UseWindowsForms>true</UseWindowsForms></PropertyGroup></Project>");
            File.WriteAllText(designer, "namespace Catalog.App { partial class Recovered { } }");

            var result = ProjectResolver.ResolveDesignerDocumentOwner(
                designer,
                new[] { project },
                "namespace Catalog.App { partial class Recovered { private void InitializeComponent() { } } }");

            Assert.Equal(DesignerDocumentOwnerStatus.Resolved, result.Status);
            Assert.Equal("NONE", result.DiagnosticCode);
            Assert.Equal("Catalog.App.Recovered", result.TypeName);
            Assert.False(result.EmptyInitializeComponentSurface);
        }
        finally
        {
            TryDelete(root);
        }
    }

    private static string ProjectWithCompile(string include) => $"""
        <Project>
          <ItemGroup>
            <Compile Include="{include}" />
          </ItemGroup>
        </Project>
        """;

    private static string SdkProjectWithCompile(string include, string targetFramework) => $"""
        <Project Sdk="Microsoft.NET.Sdk">
          <PropertyGroup>
            <TargetFramework>{targetFramework}</TargetFramework>
            <UseWindowsForms>true</UseWindowsForms>
          </PropertyGroup>
          <ItemGroup>
            <Compile Include="{include}" />
          </ItemGroup>
        </Project>
        """;

    private static string ClassicProjectWithCompile(string include) => $"""
        <Project ToolsVersion="15.0">
          <PropertyGroup>
            <TargetFrameworkVersion>v4.8</TargetFrameworkVersion>
          </PropertyGroup>
          <ItemGroup>
            <Compile Include="{include}" />
          </ItemGroup>
        </Project>
        """;

    private static string MultiTargetProjectWithCompile(string include) => $"""
        <Project Sdk="Microsoft.NET.Sdk">
          <PropertyGroup>
            <TargetFrameworks>net10.0-windows;net48</TargetFrameworks>
          </PropertyGroup>
          <ItemGroup>
            <Compile Include="{include}" />
          </ItemGroup>
        </Project>
        """;

    /// <summary>Two co-owning projects around one shared designer file, written with the given project bodies.</summary>
    private static (string Designer, string First, string Second) SharedByTwo(
        string root, Func<string, string> projectBody)
    {
        string shared = Path.Combine(root, "Shared", "SharedForm.Designer.cs");
        Directory.CreateDirectory(Path.GetDirectoryName(shared)!);
        File.WriteAllText(shared, "namespace Catalog.Shared { partial class SharedForm { private void InitializeComponent() { } } }");
        string firstDir = Path.Combine(root, "AppOne");
        string secondDir = Path.Combine(root, "AppTwo");
        Directory.CreateDirectory(firstDir);
        Directory.CreateDirectory(secondDir);
        string first = Path.Combine(firstDir, "AppOne.csproj");
        string second = Path.Combine(secondDir, "AppTwo.csproj");
        File.WriteAllText(first, projectBody(@"..\Shared\SharedForm.Designer.cs"));
        File.WriteAllText(second, projectBody(@"..\Shared\SharedForm.Designer.cs"));
        return (shared, first, second);
    }

    private static string CreateTempDir()
    {
        string dir = Path.Combine(Path.GetTempPath(), "WfdV2DocResolver." + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        return dir;
    }

    private static void TryDelete(string dir)
    {
        try { Directory.Delete(dir, recursive: true); } catch { }
    }
}
