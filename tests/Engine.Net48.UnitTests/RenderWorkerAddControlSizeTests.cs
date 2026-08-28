using System;
using System.Collections;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Windows.Forms;
using Xunit;

namespace Engine.Net48.UnitTests
{
    public sealed class RenderWorkerAddControlSizeTests
    {
        [Fact]
        public void AddControl_AppliesRequestedSizeToLivePreview()
        {
            object worker = CreateWorker();
            try
            {
                object result = AddControl(worker, "Label", "label1", 7, 8, 160, 24);

                Assert.True((bool)Get(result, "Applied"), (string)Get(result, "Diagnostics"));
                object label = SingleControl(result, "label1");
                Assert.Equal(7, (int)Get(label, "X"));
                Assert.Equal(8, (int)Get(label, "Y"));
                Assert.Equal(160, (int)Get(label, "Width"));
                Assert.Equal(24, (int)Get(label, "Height"));
            }
            finally
            {
                DiscardLive(worker);
            }
        }

        [Fact]
        public void AddControl_RejectsIncompleteRequestedSize()
        {
            object worker = CreateWorker();
            try
            {
                object result = AddControl(worker, "Button", "button1", 7, 8, 160, -1);

                Assert.False((bool)Get(result, "Applied"));
                Assert.Contains("both width and height", (string)Get(result, "Diagnostics"));
                Assert.DoesNotContain(Controls(result), c => (string)Get(c, "Id") == "button1");
            }
            finally
            {
                DiscardLive(worker);
            }
        }

        [Fact]
        public void SplitterPanelSyntheticParent_IsListedAndAcceptsToolboxControl()
        {
            object worker = CreateWorker();
            string assemblyPath = typeof(SplitterDropSurface).Assembly.Location;
            string rootTypeName = typeof(SplitterDropSurface).FullName!;
            try
            {
                object result = AddControl(
                    worker,
                    assemblyPath,
                    rootTypeName,
                    "splitContainer1.Panel2",
                    "Button",
                    "button1",
                    9,
                    11,
                    120,
                    32);

                Assert.True((bool)Get(result, "Applied"), (string)Get(result, "Diagnostics"));
                object panel1 = SingleControl(result, "splitContainer1.Panel1");
                object panel2 = SingleControl(result, "splitContainer1.Panel2");
                object button = SingleControl(result, "button1");
                Assert.Equal("splitContainer1", (string)Get(panel1, "ParentId"));
                Assert.Equal("splitContainer1", (string)Get(panel2, "ParentId"));
                Assert.Equal("splitContainer1.Panel2", (string)Get(button, "ParentId"));
                Assert.Equal(9, (int)Get(button, "X") - (int)Get(panel2, "ClientX"));
                Assert.Equal(11, (int)Get(button, "Y") - (int)Get(panel2, "ClientY"));
            }
            finally
            {
                DiscardLive(worker, assemblyPath, rootTypeName);
            }
        }

        private static object CreateWorker()
        {
            Type workerType = Net48EngineAssembly().GetType(
                "WinFormsDesigner.Engine.Net48.RenderWorker",
                throwOnError: true)!;
            return Activator.CreateInstance(workerType)!;
        }

        private static object AddControl(object worker, string controlTypeKey, string newId, int x, int y, int width, int height)
            => AddControl(worker, TestAssemblyPath, TestRootTypeName, "this", controlTypeKey, newId, x, y, width, height);

        private static object AddControl(object worker, string assemblyPath, string rootTypeName, string parentId,
            string controlTypeKey, string newId, int x, int y, int width, int height)
        {
            MethodInfo method = worker.GetType().GetMethod("AddControl")!;
            return method.Invoke(worker, new object[]
            {
                assemblyPath,
                rootTypeName,
                parentId,
                controlTypeKey,
                newId,
                x,
                y,
                width,
                height,
            })!;
        }

        private static void DiscardLive(object worker)
            => DiscardLive(worker, TestAssemblyPath, TestRootTypeName);

        private static void DiscardLive(object worker, string assemblyPath, string rootTypeName)
        {
            MethodInfo method = worker.GetType().GetMethod("DiscardLive")!;
            method.Invoke(worker, new object[] { assemblyPath, rootTypeName, "" });
        }

        private static object SingleControl(object result, string id) =>
            Controls(result).Single(c => (string)Get(c, "Id") == id);

        private static object[] Controls(object result) =>
            ((IEnumerable)Get(result, "Controls")).Cast<object>().ToArray();

        private static object Get(object instance, string propertyName) =>
            instance.GetType().GetProperty(propertyName)!.GetValue(instance)!;

        private static Assembly Net48EngineAssembly()
        {
            string config = typeof(RenderWorkerAddControlSizeTests).Assembly
                .GetCustomAttribute<AssemblyConfigurationAttribute>()?.Configuration ?? "Debug";
            string path = Path.GetFullPath(Path.Combine(
                AppContext.BaseDirectory,
                "..",
                "..",
                "..",
                "..",
                "..",
                "engine-net48",
                "bin",
                config,
                "net48",
                "WinFormsDesigner.Engine.Net48.exe"));
            Assert.True(File.Exists(path), "Expected built net48 engine at " + path);
            return Assembly.LoadFrom(path);
        }

        private static string TestAssemblyPath => typeof(RectangleDropSurface).Assembly.Location;

        private static string TestRootTypeName => typeof(RectangleDropSurface).FullName!;
    }

    public sealed class RectangleDropSurface : UserControl
    {
        public RectangleDropSurface()
        {
            ClientSize = new System.Drawing.Size(300, 200);
        }
    }

    public sealed class SplitterDropSurface : UserControl
    {
        private readonly SplitContainer splitContainer1;

        public SplitterDropSurface()
        {
            ClientSize = new System.Drawing.Size(320, 200);
            splitContainer1 = new SplitContainer
            {
                Name = "splitContainer1",
                Dock = DockStyle.Fill,
                SplitterDistance = 140,
            };
            Controls.Add(splitContainer1);
        }
    }
}
