using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using WinFormsDesigner.Engine;

namespace Engine.UnitTests;

public sealed class ToolboxExecutableScannerTests
{
    [Fact]
    public void ManagedExecutable_ListsItsOwnControl_WithoutRunningMainOrConstructingIt()
    {
        var directory = Path.Combine(Path.GetTempPath(), "wfd-toolbox-exe-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        var executable = Path.Combine(directory, "Owner.exe");
        try
        {
            const string source = """
                namespace OwnApplication
                {
                    public sealed class OwnControl : System.Windows.Forms.Button
                    {
                        public OwnControl() { throw new System.InvalidOperationException("constructor must not run"); }
                    }
                    internal static class Program
                    {
                        private static void Main() { throw new System.InvalidOperationException("entry point must not run"); }
                    }
                }
                """;
            var references = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!).Split(Path.PathSeparator)
                .Select(file => MetadataReference.CreateFromFile(file));
            var compilation = CSharpCompilation.Create("Owner", [CSharpSyntaxTree.ParseText(source)], references,
                new CSharpCompilationOptions(OutputKind.WindowsApplication));
            var emit = compilation.Emit(executable);
            Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics));

            var result = DesignerRenderer.ScanAssemblyCandidates(executable, fromProject: true);

            Assert.Contains(result.Items, item => item.Name == "OwnControl" && item.Namespace == "OwnApplication");
            File.Delete(executable);
            Assert.False(File.Exists(executable));
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }
}
