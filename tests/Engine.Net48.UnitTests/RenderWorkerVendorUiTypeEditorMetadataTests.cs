using System;
using System.Collections;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Security.Cryptography;
using FakeVendor;
using Xunit;

namespace Engine.Net48.UnitTests
{
    public sealed class RenderWorkerVendorUiTypeEditorMetadataTests
    {
        [Fact]
        public void V2_FND_001_S047_RenderWorker_PublishesCertifiedFakeVendorEditorMetadata_OnNet48()
        {
            object worker = CreateWorker();
            try
            {
                object component = DescribeVendorEdit(worker);
                object property = SingleProperty(component, nameof(VendorEdit.ComplexValue));

                string assemblyPath = Path.GetFullPath(typeof(VendorEdit).Assembly.Location);
                Assert.Equal("FakeVendor.VendorComplexValueEditor", Get<string>(property, "UiTypeEditor"));
                Assert.Equal(assemblyPath, Get<string>(property, "UiTypeEditorAssemblyPath"));
                Assert.Equal(Sha256FileHex(assemblyPath), Get<string>(property, "UiTypeEditorAssemblySha256"));
                Assert.Equal("repo.fakevendor.complex-value.v1", Get<string>(property, "UiTypeEditorCertificationId"));
            }
            finally
            {
                DiscardLive(worker);
            }
        }

        [Fact]
        public void V2_FND_001_S047_RenderWorker_RefusesArbitraryVendorEditorMetadata_OnNet48()
        {
            object worker = CreateWorker();
            try
            {
                object component = DescribeVendorEdit(worker);
                object property = SingleProperty(component, nameof(VendorEdit.InvalidEditorValue));

                Assert.Null(Get<string>(property, "UiTypeEditor"));
                Assert.Null(Get<string>(property, "UiTypeEditorAssemblyPath"));
                Assert.Null(Get<string>(property, "UiTypeEditorAssemblySha256"));
                Assert.Null(Get<string>(property, "UiTypeEditorCertificationId"));
            }
            finally
            {
                DiscardLive(worker);
            }
        }

        [Fact]
        public void V2_FND_001_S071_RenderWorker_PublishesCertifiedVendorCollectionEditor_OnNet48()
        {
            object worker = CreateWorker();
            try
            {
                object component = DescribeVendorEdit(worker);
                object property = SingleProperty(component, nameof(VendorEdit.Thresholds));

                Assert.True(Get<bool>(property, "GenericCollection"));
                Assert.True(Get<bool>(property, "IsCollection"));
                Assert.Equal("System.Int32", Get<string>(property, "CollectionItemType"));
                string assemblyPath = Path.GetFullPath(typeof(VendorEdit).Assembly.Location);
                Assert.Equal("FakeVendor.VendorThresholdsEditor", Get<string>(property, "UiTypeEditor"));
                Assert.Equal(assemblyPath, Get<string>(property, "UiTypeEditorAssemblyPath"));
                Assert.Equal(Sha256FileHex(assemblyPath), Get<string>(property, "UiTypeEditorAssemblySha256"));
                Assert.Equal("repo.fakevendor.thresholds.v1", Get<string>(property, "UiTypeEditorCertificationId"));
            }
            finally
            {
                DiscardLive(worker);
            }
        }

        private static object CreateWorker()
        {
            Type workerType = Net48EngineAssembly().GetType(
                "WinFormsDesigner.Engine.Net48.RenderWorker",
                throwOnError: true)!;
            return Activator.CreateInstance(workerType)!;
        }

        private static object DescribeVendorEdit(object worker)
        {
            MethodInfo method = worker.GetType().GetMethod("DescribeComponent")!;
            object? component = method.Invoke(worker, new object[]
            {
                VendorAssemblyPath,
                typeof(FakeVendorForm).FullName!,
                "vendorEdit1",
            });
            Assert.NotNull(component);
            return component!;
        }

        private static object SingleProperty(object component, string name) =>
            Properties(component).Single(p => Get<string>(p, "Name") == name);

        private static object[] Properties(object component) =>
            ((IEnumerable)Get<object>(component, "Properties")).Cast<object>().ToArray();

        private static T? Get<T>(object instance, string propertyName) =>
            (T?)instance.GetType().GetProperty(propertyName)!.GetValue(instance);

        private static void DiscardLive(object worker)
        {
            MethodInfo method = worker.GetType().GetMethod("DiscardLive")!;
            method.Invoke(worker, new object[] { VendorAssemblyPath, typeof(FakeVendorForm).FullName!, "" });
        }

        private static Assembly Net48EngineAssembly()
        {
            var config = typeof(RenderWorkerVendorUiTypeEditorMetadataTests).Assembly
                .GetCustomAttribute<AssemblyConfigurationAttribute>()?.Configuration ?? "Debug";
            string path = Path.GetFullPath(Path.Combine(
                RepoRoot(),
                "engine-net48",
                "bin",
                config,
                "net48",
                "WinFormsDesigner.Engine.Net48.exe"));
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

        private static string Sha256FileHex(string path)
        {
            using (var sha = SHA256.Create())
            using (var stream = File.OpenRead(path))
                return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
        }
    }
}
