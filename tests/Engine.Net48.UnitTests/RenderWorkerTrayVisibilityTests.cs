using System;
using System.ComponentModel;
using System.IO;
using System.Reflection;
using System.Windows.Forms;
using Xunit;

namespace Engine.Net48.UnitTests
{
    // Visual Studio's tray shows only [DesignTimeVisible(true)] components. The .NET Framework engine marks the others
    // (a ColumnHeader, a DataGridViewColumn, a vendor grid view or layout item) TrayHidden instead of dropping them, so
    // the panel's component list can still select them, as Visual Studio's Properties window does.
    public sealed class RenderWorkerTrayVisibilityTests
    {
        [Theory]
        [InlineData(typeof(ColumnHeader), true)]
        [InlineData(typeof(DataGridViewTextBoxColumn), true)]
        [InlineData(typeof(ImageList), false)]
        [InlineData(typeof(Timer), false)]
        [InlineData(typeof(ContextMenuStrip), false)]
        [InlineData(typeof(HiddenVendorComponent), true)]
        [InlineData(typeof(InheritsHiddenVendorComponent), true)]
        public void DesignTimeVisibleFalse_IsTrayHidden(Type type, bool hidden)
        {
            Assert.Equal(hidden, IsTrayHidden(type));
        }

        [DesignTimeVisible(false)]
        public class HiddenVendorComponent : Component { }

        public sealed class InheritsHiddenVendorComponent : HiddenVendorComponent { }

        private static bool IsTrayHidden(Type type)
        {
            Type worker = Net48EngineAssembly().GetType("WinFormsDesigner.Engine.Net48.RenderWorker", throwOnError: true)!;
            MethodInfo method = worker.GetMethod("IsTrayHidden", BindingFlags.NonPublic | BindingFlags.Static)!;
            Assert.NotNull(method);
            return (bool)method.Invoke(null, new object[] { type })!;
        }

        private static Assembly Net48EngineAssembly()
        {
            string config = typeof(RenderWorkerTrayVisibilityTests).Assembly
                .GetCustomAttribute<AssemblyConfigurationAttribute>()?.Configuration ?? "Debug";
            string path = Path.GetFullPath(Path.Combine(
                AppContext.BaseDirectory, "..", "..", "..", "..", "..", "engine-net48", "bin", config, "net48",
                "WinFormsDesigner.Engine.Net48.exe"));
            Assert.True(File.Exists(path), "Expected built net48 engine at " + path);
            return Assembly.LoadFrom(path);
        }
    }
}
