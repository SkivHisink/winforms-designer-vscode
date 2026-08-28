using System;
using System.IO;
using System.Reflection;
using System.Windows.Forms;
using Xunit;

namespace Engine.Net48.UnitTests
{
    public sealed class V2DocumentRootTypeResolverTests
    {
        [Fact]
        public void V2_FND_001_S011_ResolvesGenericBaseFormForConcreteDerivedForm()
        {
            string dir = Path.Combine(Path.GetTempPath(), "WfdV2GenericBase." + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(dir);
            string designerPath = Path.Combine(dir, "ConcreteCustomerForm.Designer.cs");
            const string designerSource = """
                namespace Engine.Net48.UnitTests
                {
                    public partial class ConcreteCustomerForm
                    {
                        private void InitializeComponent()
                        {
                        }
                    }
                }
                """;
            const string codeBehindSource = """
                namespace Engine.Net48.UnitTests
                {
                    public partial class ConcreteCustomerForm : GenericBaseForm<int>
                    {
                    }
                }
                """;
            File.WriteAllText(designerPath, designerSource);

            try
            {
                Type resolver = Net48EngineAssembly().GetType(
                    "WinFormsDesigner.Engine.Net48.RootTypeResolver", throwOnError: true)!;
                MethodInfo method = resolver.GetMethod("ResolveDeclaredBase")!;

                string resolved = (string)method.Invoke(null, new object?[]
                {
                    designerPath,
                    designerSource,
                    codeBehindSource,
                    typeof(ConcreteCustomerForm).Assembly.Location,
                    Array.Empty<string>()
                })!;

                Assert.Equal(typeof(GenericBaseForm<>).FullName + "[" + typeof(int).FullName + "]", resolved);
            }
            finally
            {
                try { Directory.Delete(dir, recursive: true); } catch { }
            }
        }

        [Fact]
        public void V2_FND_001_S011_PreservesOuterAndNestedConcreteGenericArguments()
        {
            string dir = Path.Combine(Path.GetTempPath(), "WfdV2NestedGenericBase." + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(dir);
            string designerPath = Path.Combine(dir, "NestedGenericConcreteForm.Designer.cs");
            const string designerSource = "namespace Engine.Net48.UnitTests { public partial class NestedGenericConcreteForm { private void InitializeComponent() { } } }";
            const string codeBehindSource = "namespace Engine.Net48.UnitTests { public partial class NestedGenericConcreteForm : GenericOuter<int>.NestedBase<string> { } }";
            File.WriteAllText(designerPath, designerSource);

            try
            {
                Type resolver = Net48EngineAssembly().GetType(
                    "WinFormsDesigner.Engine.Net48.RootTypeResolver", throwOnError: true)!;
                string resolved = (string)resolver.GetMethod("ResolveDeclaredBase")!.Invoke(null, new object?[]
                {
                    designerPath,
                    designerSource,
                    codeBehindSource,
                    typeof(NestedGenericConcreteForm).Assembly.Location,
                    Array.Empty<string>()
                })!;
                Type runtimeBase = typeof(NestedGenericConcreteForm).BaseType!;
                string expected = runtimeBase.GetGenericTypeDefinition().FullName + "["
                    + typeof(int).FullName + "," + typeof(string).FullName + "]";

                Assert.Equal(expected, resolved);
            }
            finally
            {
                try { Directory.Delete(dir, recursive: true); } catch { }
            }
        }

        private static Assembly Net48EngineAssembly()
        {
            var config = typeof(V2DocumentRootTypeResolverTests).Assembly
                .GetCustomAttribute<AssemblyConfigurationAttribute>()?.Configuration ?? "Debug";
            string root = RepoRoot();
            string enginePath = Path.Combine(root, "engine-net48", "bin", config, "net48", "WinFormsDesigner.Engine.Net48.exe");
            Assert.True(File.Exists(enginePath), "Expected built net48 engine at " + enginePath);
            return Assembly.LoadFrom(enginePath);
        }

        private static string RepoRoot()
        {
            var dir = new DirectoryInfo(AppContext.BaseDirectory);
            while (dir != null)
            {
                if (Directory.Exists(Path.Combine(dir.FullName, "engine-net48"))) return dir.FullName;
                dir = dir.Parent;
            }
            throw new DirectoryNotFoundException("Could not locate repository root from " + AppContext.BaseDirectory);
        }
    }

    public class GenericBaseForm<T> : Form
    {
    }

    public partial class ConcreteCustomerForm : GenericBaseForm<int>
    {
    }

    public class GenericOuter<TOuter>
    {
        public class NestedBase<TInner> : Form
        {
        }
    }

    public partial class NestedGenericConcreteForm : GenericOuter<int>.NestedBase<string>
    {
    }
}
