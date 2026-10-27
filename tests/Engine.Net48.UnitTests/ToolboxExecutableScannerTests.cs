using System;
using System.IO;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using WinFormsDesigner.Engine.Net48;
using Xunit;

namespace Engine.Net48.UnitTests
{
    public sealed class ToolboxExecutableScannerTests
    {
        [Fact]
        public void ManagedExecutable_ListsItsOwnControl_WithoutRunningMainOrConstructingIt()
        {
            var directory = Path.Combine(Path.GetTempPath(), "wfd-toolbox-exe-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(directory);
            var executable = Path.Combine(directory, "Owner.exe");
            AppDomain domain = null;
            try
            {
                const string source = @"
                    namespace OwnApplication
                    {
                        public sealed class OwnControl : System.Windows.Forms.Button
                        {
                            public OwnControl() { throw new System.InvalidOperationException(""constructor must not run""); }
                        }
                        internal static class Program
                        {
                            private static void Main() { throw new System.InvalidOperationException(""entry point must not run""); }
                        }
                    }";
                var references = new[] { typeof(object).Assembly.Location,
                    typeof(System.ComponentModel.IComponent).Assembly.Location,
                    typeof(System.Windows.Forms.Button).Assembly.Location,
                    typeof(System.Drawing.Image).Assembly.Location }
                    .Distinct().Select(file => MetadataReference.CreateFromFile(file));
                var compilation = CSharpCompilation.Create("Owner", new[] { CSharpSyntaxTree.ParseText(source) }, references,
                    new CSharpCompilationOptions(OutputKind.WindowsApplication));
                var emit = compilation.Emit(executable);
                Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics));

                domain = AppDomain.CreateDomain("WfdToolboxExe-" + Guid.NewGuid().ToString("N"), null,
                    new AppDomainSetup { ApplicationBase = AppContext.BaseDirectory });
                var scanner = (ToolboxAssemblyScanner)domain.CreateInstanceAndUnwrap(
                    typeof(ToolboxAssemblyScanner).Assembly.FullName, typeof(ToolboxAssemblyScanner).FullName);
                var result = scanner.Scan(executable, new[] { AppContext.BaseDirectory });

                Assert.Contains(result.Items, item => item.Name == "OwnControl" && item.Namespace == "OwnApplication");
                AppDomain.Unload(domain);
                domain = null;
                File.Delete(executable);
                Assert.False(File.Exists(executable));
            }
            finally
            {
                if (domain != null) AppDomain.Unload(domain);
                Directory.Delete(directory, recursive: true);
            }
        }
    }
}
