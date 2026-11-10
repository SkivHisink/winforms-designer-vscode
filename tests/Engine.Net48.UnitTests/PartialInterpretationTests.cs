using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Windows.Forms;
using Xunit;
using WinFormsDesigner.Engine;

namespace Engine.Net48.UnitTests
{
    /// <summary>A control whose constructor needs the application, like a control that asks a service locator.</summary>
    public sealed class PartialThrowingControl : Control
    {
        public PartialThrowingControl() => throw new InvalidOperationException("needs the application");
    }

    /// <summary>A non-visual component whose constructor needs the application.</summary>
    public sealed class PartialThrowingComponent : Component
    {
        public PartialThrowingComponent() => throw new InvalidOperationException("component needs the application");
    }

    /// <summary>A tab page whose constructor needs the application.</summary>
    public sealed class PartialThrowingTabPage : TabPage
    {
        public PartialThrowingTabPage() => throw new InvalidOperationException("page needs the application");
    }

    /// <summary>A compiled base that already has a component named like one the derived source declares.</summary>
    public class PartialBaseWithButton : UserControl
    {
        protected Button broken1 = new Button();
    }

    /// <summary>The designed root of the worker test: its own constructor needs the application, so the compiled build
    /// cannot be constructed and only the partial interpretation can show the form.</summary>
    public sealed class PartialRootControl : UserControl
    {
        public static int Constructions;
        public PartialRootControl()
        {
            Constructions++;
            throw new InvalidOperationException("root needs the application");
        }
    }

    // The partial interpretation (Visual Studio's "Ignore and Continue"): a component whose constructor throws becomes a
    // named, read-only placeholder at its source geometry; what uses it and what the front-end could not represent is
    // listed; everything else stays exactly as strict as the complete interpretation.
    public sealed class PartialInterpretationTests
    {
        private const string Source = @"
namespace Engine.Net48.UnitTests {
  partial class PartialRootControl : System.Windows.Forms.UserControl {
    private System.Windows.Forms.Panel panel1;
    private Engine.Net48.UnitTests.PartialThrowingControl broken1;
    private Engine.Net48.UnitTests.PartialThrowingComponent brokenComponent1;
    private System.Windows.Forms.Button button1;
    private void InitializeComponent() {
      this.panel1 = new System.Windows.Forms.Panel();
      this.broken1 = new Engine.Net48.UnitTests.PartialThrowingControl();
      this.brokenComponent1 = new Engine.Net48.UnitTests.PartialThrowingComponent();
      this.button1 = new System.Windows.Forms.Button();
      this.panel1.SuspendLayout();
      this.SuspendLayout();
      this.panel1.Controls.Add(this.broken1);
      this.panel1.Controls.Add(this.button1);
      this.panel1.Location = new System.Drawing.Point(5, 6);
      this.panel1.Size = new System.Drawing.Size(300, 200);
      this.broken1.Location = new System.Drawing.Point(10, 20);
      this.broken1.Size = new System.Drawing.Size(120, 80);
      this.broken1.Text = ""vendor text"";
      this.broken1.Click += new System.EventHandler(this.OnBrokenClick);
      this.button1.Location = new System.Drawing.Point(150, 20);
      this.button1.Text = ""OK"";
      this.button1.Tag = this.broken1;
      this.button1.AccessibleName = new System.Text.StringBuilder(""x"").ToString();
      this.Controls.Add(this.panel1);
      this.panel1.ResumeLayout(false);
      this.ResumeLayout(false);
    }
  }
}";

        private sealed class Host : IIrHost
        {
            private static readonly Assembly[] Probe =
            {
                typeof(PartialInterpretationTests).Assembly, typeof(Control).Assembly, typeof(Color).Assembly,
                typeof(Point).Assembly, typeof(ISupportInitialize).Assembly, typeof(object).Assembly,
            };
            private readonly SafeResxResolver? _resx;
            public Host(string? resxXml = null) { _resx = resxXml == null ? null : SafeResxResolver.Parse(resxXml); }
            public Type? ResolveType(string typeName)
            {
                foreach (var a in Probe) { var t = a.GetType(typeName, false); if (t != null) return t; }
                return null;
            }
            public object CreateComponent(Type type, string name, bool withContainer) => Activator.CreateInstance(type)!;
            public object? ResolveResource(string key, bool isString) => null;
            public bool WasResourceRefused(string key) => false;
            public bool HasResource(string key) => false;
            public bool HasResourceSet => _resx != null;
            public bool ApplyResources(object target, string key, out string? error)
            {
                if (_resx == null) { error = "no test resources"; return false; }
                return _resx.ApplyResources(target, key, out error);
            }
        }

        private static string Wrap(string body) => @"
namespace Engine.Net48.UnitTests {
  partial class PartialRootControl : System.Windows.Forms.UserControl {
    " + body + @"
  }
}";

        [Fact]
        public void PartialReplay_NamesAPlaceholderNoParentTakes_AndWhatIsInsideIt()
        {
            var doc = DesignerIrBuilder.Build(Wrap(@"
    private System.Windows.Forms.TabControl tabControl1;
    private Engine.Net48.UnitTests.PartialThrowingTabPage brokenPage;
    private System.Windows.Forms.Button pageButton;
    private void InitializeComponent() {
      this.tabControl1 = new System.Windows.Forms.TabControl();
      this.brokenPage = new Engine.Net48.UnitTests.PartialThrowingTabPage();
      this.pageButton = new System.Windows.Forms.Button();
      this.tabControl1.Controls.Add(this.brokenPage);
      this.brokenPage.Controls.Add(this.pageButton);
      this.Controls.Add(this.tabControl1);
    }"))!;
            var result = DesignerIrExecutor.Execute(doc, new UserControl(), new Host(), partial: true);

            Assert.True(result.Ok, result.FailureReason); // a TabControl refusing the stand-in does not end the replay
            Assert.Null(result.Placeholders["brokenPage"].Parent);
            Assert.Contains("this.brokenPage  (not shown: no parent could take its placeholder)", result.Omissions);
            Assert.Contains("this.pageButton  (not shown: inside this.brokenPage, which could not be built)", result.Omissions);
        }

        [Fact]
        public void PartialReplay_RefusesAFailedNameThatHidesAnInheritedComponent()
        {
            var doc = DesignerIrBuilder.Build(Wrap(@"
    private Engine.Net48.UnitTests.PartialThrowingControl broken1;
    private void InitializeComponent() {
      this.broken1 = new Engine.Net48.UnitTests.PartialThrowingControl();
      this.Controls.Add(this.broken1);
    }"))!;
            var result = DesignerIrExecutor.Execute(doc, new PartialBaseWithButton(), new Host(), partial: true);
            Assert.False(result.Ok);
            Assert.Contains("ambiguous identity: 'broken1'", result.FailureReason);
        }

        [Fact]
        public void PartialReplay_PlacesALocalizedPlaceholderFromItsResources()
        {
            var doc = DesignerIrBuilder.Build(Wrap(@"
    private Engine.Net48.UnitTests.PartialThrowingControl broken1;
    private void InitializeComponent() {
      System.ComponentModel.ComponentResourceManager resources = new System.ComponentModel.ComponentResourceManager(typeof(PartialRootControl));
      this.broken1 = new Engine.Net48.UnitTests.PartialThrowingControl();
      resources.ApplyResources(this.broken1, ""broken1"");
      this.Controls.Add(this.broken1);
    }"))!;
            string resx = "<root>"
                + "<data name=\"broken1.Location\" type=\"System.Drawing.Point, System.Drawing\"><value>10, 20</value></data>"
                + "<data name=\"broken1.Size\" type=\"System.Drawing.Size, System.Drawing\"><value>120, 80</value></data>"
                + "</root>";
            var result = DesignerIrExecutor.Execute(doc, new UserControl(), new Host(resx), partial: true);

            Assert.True(result.Ok, result.FailureReason);
            var placeholder = result.Placeholders["broken1"];
            Assert.Equal(new Point(10, 20), placeholder.Location);
            Assert.Equal(new Size(120, 80), placeholder.Size);
        }

        [Fact]
        public void PartialReplay_KeepsWhatBuilds_PlacesTheFailedControl_AndListsEverythingElse()
        {
            var doc = DesignerIrBuilder.Build(Source)!;
            Assert.False(doc.FullCoverage);
            var root = new UserControl();
            var result = DesignerIrExecutor.Execute(doc, root, new Host(), partial: true);

            Assert.True(result.Ok, result.FailureReason);
            Assert.True(result.Partial);
            Assert.False(result.Instances.ContainsKey("broken1"));
            Assert.False(result.Instances.ContainsKey("brokenComponent1"));
            var panel = Assert.IsType<Panel>(result.Instances["panel1"]);
            var button = Assert.IsType<Button>(result.Instances["button1"]);
            Assert.Equal("OK", button.Text);
            Assert.Null(button.Tag); // a value that names the failed control is not applied
            Assert.Contains(panel, root.Controls.Cast<Control>());

            var placeholder = result.Placeholders["broken1"];
            Assert.Same(panel, placeholder.Parent);
            Assert.Equal(new Point(10, 20), placeholder.Location);
            Assert.Equal(new Size(120, 80), placeholder.Size);
            Assert.NotEqual("vendor text", placeholder.Text); // only geometry and attachment reach a placeholder
            Assert.Equal(typeof(PartialThrowingControl).FullName, placeholder.DeclaredTypeName);
            Assert.Equal(nameof(InvalidOperationException), placeholder.ExceptionType);
            Assert.False(result.Placeholders.ContainsKey("brokenComponent1")); // not a control: listed, not drawn

            Assert.Equal(new[] { "broken1", "brokenComponent1" }, result.FailedComponents.Select(f => f.Name));
            Assert.Contains(result.Omissions, line => line.StartsWith("this.broken1 = new " + typeof(PartialThrowingControl).FullName + "();", StringComparison.Ordinal)
                && line.Contains("3 statement(s) using it not applied")
                && line.EndsWith("[InvalidOperationException: needs the application]", StringComparison.Ordinal));
            Assert.Contains(result.Omissions, line => line.StartsWith("this.brokenComponent1 = new ", StringComparison.Ordinal)
                && line.EndsWith("[InvalidOperationException: component needs the application]", StringComparison.Ordinal));
            Assert.Contains("this.button1.Tag = this.broken1  (not applied: this.broken1 could not be built)", result.Omissions);
            Assert.Empty(result.PendingInit);
        }

        [Fact]
        public void StrictReplay_IsUnchanged_AndRefusesTheSameDocument()
        {
            var doc = DesignerIrBuilder.Build(Source)!;
            var result = DesignerIrExecutor.Execute(doc, new UserControl(), new Host());
            Assert.False(result.Ok);
            Assert.Contains("cannot construct " + typeof(PartialThrowingControl).FullName, result.FailureReason);

            var strictPlan = InterpretedRenderPlan.Plan(doc, new Host(), typeof(UserControl));
            Assert.False(strictPlan.Interpreted);
            Assert.False(strictPlan.Partial);
            Assert.Equal(RenderFallbackReason.UnrepresentableStatements, strictPlan.Decision.FallbackReason);
        }

        [Fact]
        public void PartialPlan_IsNeverReportedAsComplete_AndACompleteReplayStaysComplete()
        {
            var doc = DesignerIrBuilder.Build(Source)!;
            var partialPlan = InterpretedRenderPlan.Plan(doc, new Host(), typeof(UserControl), partial: true);
            Assert.False(partialPlan.Interpreted);
            Assert.True(partialPlan.Partial);
            Assert.Equal(RenderFallbackReason.PartialInterpretation, partialPlan.Decision.FallbackReason);
            (partialPlan.Root as IDisposable)?.Dispose();

            var clean = DesignerIrBuilder.Build(@"
namespace Demo {
  partial class Clean : System.Windows.Forms.UserControl {
    private System.Windows.Forms.Button button1;
    private void InitializeComponent() {
      this.button1 = new System.Windows.Forms.Button();
      this.button1.Text = ""OK"";
      this.Controls.Add(this.button1);
    }
  }
}")!;
            var cleanPlan = InterpretedRenderPlan.Plan(clean, new Host(), typeof(UserControl), partial: true);
            Assert.True(cleanPlan.Interpreted);
            Assert.False(cleanPlan.Partial);
            (cleanPlan.Root as IDisposable)?.Dispose();
        }

        [Fact]
        public void PartialReplay_KeepsEveryOtherRefusalHard()
        {
            var unresolved = DesignerIrBuilder.Build(Source.Replace(
                "new Engine.Net48.UnitTests.PartialThrowingComponent()", "new Engine.Net48.UnitTests.NoSuchComponent()"))!;
            var result = DesignerIrExecutor.Execute(unresolved, new UserControl(), new Host(), partial: true);
            Assert.False(result.Ok);
            Assert.Contains("unresolved type Engine.Net48.UnitTests.NoSuchComponent", result.FailureReason);

            var forged = new IrDocument
            {
                DesignedTypeName = "Demo.MyForm",
                BaseTypeSyntaxName = "System.Windows.Forms.Form",
                TotalSourceStatements = 1,
                RepresentedStatements = 1,
                Statements =
                {
                    new IrSetProperty
                    {
                        TargetIsRoot = true, PropertyPath = { "Tag" },
                        Value = new IrKnownCtor { TypeName = "System.Text.StringBuilder", Args = { new IrString { Value = "x" } } },
                    },
                },
            };
            var refused = DesignerIrExecutor.Execute(forged, new Form(), new Host(), partial: true);
            Assert.False(refused.Ok);
            Assert.Contains("construction not allowed", refused.FailureReason);
        }

        [Fact]
        public void Worker_ShowsThePartialPreviewOnlyWhenTheBuildCannotBeConstructed_AndRemembersIt()
        {
            string designerPath = Path.Combine(Path.GetTempPath(), "PartialRootControl." + Guid.NewGuid().ToString("N") + ".Designer.cs");
            File.WriteAllText(designerPath, Source);
            Assembly engine = Net48EngineAssembly();
            object worker = Activator.CreateInstance(engine.GetType("WinFormsDesigner.Engine.Net48.RenderWorker", throwOnError: true)!)!;
            string assemblyPath = typeof(PartialRootControl).Assembly.Location;
            string rootType = typeof(PartialRootControl).FullName!;
            try
            {
                object document = engine.GetType("WinFormsDesigner.Engine.DesignerIrBuilder", throwOnError: true)!
                    .GetMethod("Build", BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic)!
                    .Invoke(null, new object?[] { Source })!;
                MethodInfo render = worker.GetType().GetMethod("RenderInterpretedWithLayout")!;
                object Render(string key) => render.Invoke(worker, new object?[]
                {
                    designerPath, assemblyPath, document, rootType, 0, 0, null, 1, key, typeof(UserControl).FullName!,
                })!;

                PartialRootControl.Constructions = 0;
                object first = Render("buffer-1");
                Assert.Equal("interpretedPartial", (string)Get(first, "RenderMode"));
                Assert.Equal("partialInterpretation", (string)Get(first, "FallbackReason"));
                Assert.Contains("root needs the application", (string)Get(first, "Diagnostics"));
                Assert.Equal(1, PartialRootControl.Constructions);
                var unrepresentable = ((IEnumerable)Get(first, "Unrepresentable")).Cast<string>().ToList();
                Assert.Contains(unrepresentable, line => line.Contains("System.Text.StringBuilder"));
                Assert.Contains(unrepresentable, line => line.StartsWith("this.broken1 = new ", StringComparison.Ordinal));

                object placeholder = Control(first, "broken1");
                Assert.True((bool)Get(placeholder, "IsPlaceholder"));
                Assert.False((bool)Get(placeholder, "Editable"));
                Assert.Equal("unresolved", (string)Get(placeholder, "Ownership"));
                Assert.Equal(typeof(PartialThrowingControl).FullName, (string)Get(placeholder, "Type"));
                Assert.Equal(120, (int)Get(placeholder, "Width"));
                Assert.Equal(80, (int)Get(placeholder, "Height"));
                Assert.Equal("panel1", (string)Get(placeholder, "ParentId"));
                object button = Control(first, "button1");
                Assert.False((bool)Get(button, "IsPlaceholder"));
                Assert.True((bool)Get(button, "Editable"));

                // A later render of the same build does not run the constructor that already failed.
                Assert.Equal("interpretedPartial", (string)Get(Render("buffer-2"), "RenderMode"));
                Assert.Equal(1, PartialRootControl.Constructions);

                MethodInfo describe = worker.GetType().GetMethod("DescribeInterpretedComponent")!;
                object Describe(string id) => describe.Invoke(worker, new object?[]
                {
                    designerPath, assemblyPath, document, rootType, id, 0, 0, "buffer-2", typeof(UserControl).FullName!,
                })!;
                object placeholderDesc = Describe("broken1");
                Assert.True((bool)Get(placeholderDesc, "IsPlaceholder"));
                Assert.False((bool)Get(placeholderDesc, "Editable"));
                Assert.Empty((IEnumerable<object>)((IEnumerable)Get(placeholderDesc, "Properties")).Cast<object>());
                Assert.Contains("could not be constructed", (string)Get(placeholderDesc, "ReadOnlyReason"));
                object buttonDesc = Describe("button1");
                Assert.False((bool)Get(buttonDesc, "IsPlaceholder"));
                Assert.True((bool)Get(buttonDesc, "Editable"));

                // An edit is never applied to a partial graph; the host renders the edited source again.
                Type editType = engine.GetType("WinFormsDesigner.Engine.Net48.PropEdit", throwOnError: true)!;
                object edit = Activator.CreateInstance(editType)!;
                editType.GetProperty("ComponentId")!.SetValue(edit, "button1");
                editType.GetProperty("PropName")!.SetValue(edit, "Text");
                editType.GetProperty("RawValue")!.SetValue(edit, "Changed");
                Array edits = Array.CreateInstance(editType, 1);
                edits.SetValue(edit, 0);
                object applied = worker.GetType().GetMethod("ApplyInterpretedEdits")!.Invoke(worker, new object?[]
                {
                    designerPath, assemblyPath, rootType, edits, "buffer-2", "buffer-3", null, 1, 0, 0,
                })!;
                Assert.False((bool)Get(applied, "Applied"));
                Assert.Contains("partial interpretation", (string)Get(applied, "Diagnostics"));

                // Discarding starts over, which includes trying the build again.
                worker.GetType().GetMethod("DiscardLive")!.Invoke(worker, new object?[] { assemblyPath, rootType, designerPath });
                Assert.Equal("interpretedPartial", (string)Get(Render("buffer-4"), "RenderMode"));
                Assert.Equal(2, PartialRootControl.Constructions);
            }
            finally
            {
                try { worker.GetType().GetMethod("DiscardLive")!.Invoke(worker, new object?[] { assemblyPath, rootType, designerPath }); } catch { }
                try { File.Delete(designerPath); } catch { }
            }
        }

        private static object Control(object layout, string id) =>
            ((IEnumerable)Get(layout, "Controls")).Cast<object>().Single(c => (string)Get(c, "Id") == id);

        private static object Get(object instance, string propertyName) =>
            instance.GetType().GetProperty(propertyName)!.GetValue(instance)!;

        private static Assembly Net48EngineAssembly()
        {
            var config = typeof(PartialInterpretationTests).Assembly
                .GetCustomAttribute<AssemblyConfigurationAttribute>()?.Configuration ?? "Debug";
            var dir = new DirectoryInfo(AppContext.BaseDirectory);
            while (dir != null && !Directory.Exists(Path.Combine(dir.FullName, "engine-net48"))) dir = dir.Parent;
            Assert.NotNull(dir);
            var enginePath = Path.Combine(dir!.FullName, "engine-net48", "bin", config, "net48", "WinFormsDesigner.Engine.Net48.exe");
            Assert.True(File.Exists(enginePath), "Expected built net48 engine at " + enginePath);
            return Assembly.LoadFrom(enginePath);
        }
    }
}
