using System;
using System.Collections;
using System.IO;
using System.Linq;
using System.Reflection;
using FakeVendor;
using Xunit;

namespace Engine.Net48.UnitTests
{
    // Nested property editing on the .NET Framework engine (the DevExpress `ImageOptions.Location` case): the compiled
    // describe offers an editor exactly where the live edit accepts one, under the one shared NestedPropertyPath rule.
    public sealed class RenderWorkerNestedPropertyTests
    {
        [Fact]
        public void Describe_OffersNestedEditors_OnlyForLiteralLeavesUnderAContentHop()
        {
            object worker = CreateWorker();
            try
            {
                object appearance = SingleProperty(Describe(worker, "fancyButton1"), nameof(FancyButton.Appearance));
                object[] children = Children(appearance);

                object style = Child(children, nameof(FakeAppearance.BorderStyle));
                Assert.Equal("Appearance.BorderStyle", Get<string>(style, "PropertyPath"));
                Assert.True(Get<bool>(style, "NestedEditable"));
                Assert.True(Get<bool>(style, "IsEnum"));
                Assert.Contains("Dashed", Get<System.Collections.Generic.List<string>>(style, "StandardValues")!);

                Assert.True(Get<bool>(Child(children, nameof(FakeAppearance.BorderWidth)), "NestedEditable"));
                // a Color is a complex value, not a literal the host writes for a nested row
                Assert.False(Get<bool>(Child(children, nameof(FakeAppearance.BorderColor)), "NestedEditable"));
            }
            finally
            {
                DiscardLive(worker);
            }
        }

        [Fact]
        public void LiveEdit_AppliesANestedEnum_AndTheNextDescribeShowsIt()
        {
            object worker = CreateWorker();
            try
            {
                object result = SetPropertyLive(worker, "fancyButton1", "Appearance.BorderStyle", "Dashed");
                Assert.True(Get<bool>(result, "Applied"), Get<string>(result, "Diagnostics"));

                object appearance = SingleProperty(Describe(worker, "fancyButton1"), nameof(FancyButton.Appearance));
                Assert.Equal("Dashed", Get<string>(Child(Children(appearance), nameof(FakeAppearance.BorderStyle)), "Value"));
            }
            finally
            {
                DiscardLive(worker);
            }
        }

        [Theory]
        [InlineData("fancyButton1", "Appearance.BorderColor", "Red")]     // complex leaf: not offered, not accepted
        [InlineData("fancyButton1", "Text.Length", "3")]                  // a string is not a Content hop
        [InlineData("fancyButton1", "Appearance.Missing", "1")]           // no such member
        [InlineData("fancyButton1", "Appearance", "x")]                   // not a nested path (top-level, read-only)
        [InlineData("fancyButton1", "A.B.C.D.E", "1")]                    // deeper than the bound
        public void LiveEdit_RefusesEverythingTheDescribeDoesNotOffer(string id, string path, string value)
        {
            object worker = CreateWorker();
            try
            {
                object result = SetPropertyLive(worker, id, path, value);
                Assert.False(Get<bool>(result, "Applied"));
            }
            finally
            {
                DiscardLive(worker);
            }
        }

        private static object CreateWorker()
        {
            Type workerType = Net48EngineAssembly().GetType("WinFormsDesigner.Engine.Net48.RenderWorker", throwOnError: true)!;
            return Activator.CreateInstance(workerType)!;
        }

        private static object Describe(object worker, string id)
        {
            object? component = worker.GetType().GetMethod("DescribeComponent")!
                .Invoke(worker, new object[] { VendorAssemblyPath, typeof(FakeVendorForm).FullName!, id });
            Assert.NotNull(component);
            return component!;
        }

        private static object SetPropertyLive(object worker, string id, string prop, string value) =>
            worker.GetType().GetMethod("SetPropertyLive")!
                .Invoke(worker, new object[] { VendorAssemblyPath, typeof(FakeVendorForm).FullName!, id, prop, value })!;

        private static object SingleProperty(object component, string name) =>
            ((IEnumerable)Get<object>(component, "Properties")!).Cast<object>().Single(p => Get<string>(p, "Name") == name);

        private static object[] Children(object property)
        {
            var children = Get<IEnumerable>(property, "Properties");
            Assert.NotNull(children);
            return children!.Cast<object>().ToArray();
        }

        private static object Child(object[] children, string name) => children.Single(c => Get<string>(c, "Name") == name);

        private static T? Get<T>(object instance, string propertyName) =>
            (T?)instance.GetType().GetProperty(propertyName)!.GetValue(instance);

        private static void DiscardLive(object worker) =>
            worker.GetType().GetMethod("DiscardLive")!
                .Invoke(worker, new object[] { VendorAssemblyPath, typeof(FakeVendorForm).FullName!, "" });

        private static Assembly Net48EngineAssembly()
        {
            var config = typeof(RenderWorkerNestedPropertyTests).Assembly
                .GetCustomAttribute<AssemblyConfigurationAttribute>()?.Configuration ?? "Debug";
            string path = Path.GetFullPath(Path.Combine(RepoRoot(), "engine-net48", "bin", config, "net48", "WinFormsDesigner.Engine.Net48.exe"));
            Assert.True(File.Exists(path), "Expected built net48 engine at " + path);
            return Assembly.LoadFrom(path);
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

        private static string VendorAssemblyPath => Path.GetFullPath(typeof(VendorEdit).Assembly.Location);
    }
}
