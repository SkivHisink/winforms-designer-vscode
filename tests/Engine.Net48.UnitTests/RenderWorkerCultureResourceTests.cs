using System;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Windows.Forms;
using Xunit;

namespace Engine.Net48.UnitTests
{
    public sealed class RenderWorkerCultureResourceTests
    {
        [Fact]
        public void SetDesignerCulture_NormalizesAndClearsCulture()
        {
            var workerType = RenderWorkerType();
            var worker = Activator.CreateInstance(workerType);
            var designer = Path.Combine(Path.GetTempPath(), "DesignerCulture-" + Guid.NewGuid().ToString("N"), "Form.Designer.cs");

            Assert.Equal("fr-FR", InvokeInstance<string>(worker, "SetDesignerCulture", designer, "fr-fr"));
            Assert.Equal("fr-FR", InvokeInstance<string>(worker, "GetDesignerCulture", designer));

            Assert.Equal("", InvokeInstance<string>(worker, "SetDesignerCulture", designer, ""));
            Assert.Equal("", InvokeInstance<string>(worker, "GetDesignerCulture", designer));

            var ex = Assert.Throws<TargetInvocationException>(() =>
                InvokeInstance<string>(worker, "SetDesignerCulture", designer, "bad/culture"));
            Assert.IsType<CultureNotFoundException>(ex.InnerException);
        }

        [Fact]
        public void LoadSiblingResx_MergesNeutralParentAndExactCulture()
        {
            var dir = NewTempDir();
            try
            {
                var designer = Path.Combine(dir, "Form.Designer.cs");
                WriteResx(Path.Combine(dir, "Form.resx"),
                    Data("title", "Neutral"),
                    Data("neutralOnly", "Neutral only"));
                WriteResx(Path.Combine(dir, "Form.fr.resx"),
                    Data("title", "Parent"),
                    Data("parentOnly", "Parent only"));
                WriteResx(Path.Combine(dir, "Form.fr-CA.resx"),
                    Data("title", "Exact"),
                    Data("exactOnly", "Exact only"));

                var resolver = InvokeStatic("LoadSiblingResx", designer, "fr-CA");

                Assert.Equal("Exact", Resolve(resolver, "title"));
                Assert.Equal("Parent only", Resolve(resolver, "parentOnly"));
                Assert.Equal("Neutral only", Resolve(resolver, "neutralOnly"));
                Assert.Equal("Exact only", Resolve(resolver, "exactOnly"));
            }
            finally
            {
                TryDelete(dir);
            }
        }

        [Fact]
        public void LoadSiblingResx_UsesFinalOverlayForUnsafeRefusal()
        {
            var dir = NewTempDir();
            try
            {
                var designer = Path.Combine(dir, "Form.Designer.cs");
                WriteResx(Path.Combine(dir, "Form.resx"),
                    Data("danger", "Neutral safe"),
                    UnsafeData("rescued"));
                WriteResx(Path.Combine(dir, "Form.fr.resx"),
                    Data("rescued", "Parent safe"));
                WriteResx(Path.Combine(dir, "Form.fr-CA.resx"),
                    UnsafeData("danger"));

                var resolver = InvokeStatic("LoadSiblingResx", designer, "fr-CA");

                Assert.Null(Resolve(resolver, "danger"));
                Assert.True(WasRefused(resolver, "danger"));
                Assert.Equal("Parent safe", Resolve(resolver, "rescued"));
                Assert.False(WasRefused(resolver, "rescued"));
            }
            finally
            {
                TryDelete(dir);
            }
        }

        [Fact]
        public void ResxStamp_ChangesWhenCultureOrRelevantResourceChanges()
        {
            var dir = NewTempDir();
            try
            {
                var designer = Path.Combine(dir, "Form.Designer.cs");
                WriteResx(Path.Combine(dir, "Form.resx"), Data("title", "Neutral"));

                var neutral = InvokeStatic<string>("ResxStamp", designer, "");
                var beforeParentExists = InvokeStatic<string>("ResxStamp", designer, "es-MX");
                Assert.NotEqual(neutral, beforeParentExists);

                WriteResx(Path.Combine(dir, "Form.es.resx"), Data("title", "Parent one"));
                var withParent = InvokeStatic<string>("ResxStamp", designer, "es-MX");
                Assert.NotEqual(beforeParentExists, withParent);

                WriteResx(Path.Combine(dir, "Form.es.resx"), Data("title", "Parent two"));
                var editedParent = InvokeStatic<string>("ResxStamp", designer, "es-MX");
                Assert.NotEqual(withParent, editedParent);

                WriteResx(Path.Combine(dir, "Form.es-MX.resx"), Data("title", "Exact"));
                var withExact = InvokeStatic<string>("ResxStamp", designer, "es-MX");
                Assert.NotEqual(editedParent, withExact);
            }
            finally
            {
                TryDelete(dir);
            }
        }

        [Fact]
        public void ComputeWindowOffset_MirrorsRtlFormClientCoordinates()
        {
            using (var form = new Form { ClientSize = new System.Drawing.Size(320, 180) })
            using (var button = new Button { Location = new System.Drawing.Point(30, 30), Size = new System.Drawing.Size(120, 32) })
            {
                form.Controls.Add(button);
                var method = RenderWorkerType().GetMethod("ComputeWindowOffset", BindingFlags.Static | BindingFlags.NonPublic);
                Assert.NotNull(method);

                int neutralX = CoordinateX(method.Invoke(null, new object[] { button, form }));
                form.RightToLeft = RightToLeft.Yes;
                form.RightToLeftLayout = true;
                int rtlX = CoordinateX(method.Invoke(null, new object[] { button, form }));

                Assert.True(rtlX > neutralX, "RTL layout did not mirror the painted window coordinate");
                Assert.Equal(form.ClientSize.Width - 30 - button.Width + (form.Width - form.ClientSize.Width) / 2, rtlX);
            }
        }

        private static object InvokeStatic(string method, params object[] args)
        {
            return RenderWorkerType().GetMethod(method, BindingFlags.Static | BindingFlags.NonPublic)
                .Invoke(null, args);
        }

        private static T InvokeStatic<T>(string method, params object[] args)
        {
            return (T)InvokeStatic(method, args);
        }

        private static T InvokeInstance<T>(object instance, string method, params object[] args)
        {
            return (T)instance.GetType().GetMethod(method).Invoke(instance, args);
        }

        private static object Resolve(object resolver, string key)
        {
            return resolver.GetType().GetMethod("Resolve").Invoke(resolver, new object[] { key, true });
        }

        private static bool WasRefused(object resolver, string key)
        {
            return (bool)resolver.GetType().GetMethod("WasRefused").Invoke(resolver, new object[] { key });
        }

        private static int CoordinateX(object coordinate)
        {
            return (int)coordinate.GetType().GetField("Item1").GetValue(coordinate);
        }

        private static Type RenderWorkerType()
        {
            return Net48EngineAssembly().GetType("WinFormsDesigner.Engine.Net48.RenderWorker", throwOnError: true);
        }

        private static Assembly Net48EngineAssembly()
        {
            var config = typeof(RenderWorkerCultureResourceTests).Assembly
                .GetCustomAttribute<AssemblyConfigurationAttribute>()?.Configuration ?? "Debug";
            var root = RepoRoot();
            var enginePath = Path.Combine(root, "engine-net48", "bin", config, "net48", "WinFormsDesigner.Engine.Net48.exe");
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

        private static string NewTempDir()
        {
            var dir = Path.Combine(Path.GetTempPath(), "wfd-net48-culture-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(dir);
            return dir;
        }

        private static string Data(string name, string value)
        {
            return "<data name='" + name + "' xml:space='preserve'><value>" + value + "</value></data>";
        }

        private static string UnsafeData(string name)
        {
            return "<data name='" + name + "' mimetype='application/x-microsoft.net.object.binary.base64'><value>AAEAAAD/////</value></data>";
        }

        private static void WriteResx(string path, params string[] data)
        {
            File.WriteAllText(path, "<root>" + string.Join("", data) + "</root>");
        }

        private static void TryDelete(string dir)
        {
            try
            {
                if (Directory.Exists(dir)) Directory.Delete(dir, recursive: true);
            }
            catch { }
        }
    }
}
