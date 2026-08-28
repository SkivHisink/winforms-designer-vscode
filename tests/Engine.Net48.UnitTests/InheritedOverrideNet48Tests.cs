using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Windows.Forms;
using Xunit;

namespace Engine.Net48.UnitTests
{
    public sealed class InheritedOverrideNet48Tests : IDisposable
    {
        private readonly List<object> liveWorkers = new List<object>();

        [Fact]
        public void InheritedFrameworkControl_AdvertisesPropertyMetadataAndAppliesDerivedSourceOverride()
        {
            WithDesignerSource((designerPath, sourceText) =>
            {
                object worker = CreateWorker();
                object component = Describe(worker, "protectedButton")!;
                Assert.False((bool)Get(component, "Editable"));
                Assert.True((bool)Get(component, "InheritedOverrideEditable"));
                string token = (string)Get(component, "BaseIdentityToken");
                Assert.StartsWith("sha256:", token);
                Assert.Equal("System.Windows.Forms.Button", (string)Get(component, "InheritedFieldType"));
                Assert.Equal("protected", (string)Get(component, "EffectiveAccessibility"));

                object text = Property(component, "Text");
                Assert.True((bool)Get(text, "InheritedOverrideEditable"));
                Assert.True((bool)Get(text, "InheritedOverrideResettable"));
                Assert.False((bool)Get(text, "ReadOnly"));

                object click = Event(component, "Click");
                Assert.NotNull(click);

                object result = Apply(worker, "protectedButton", "Text", "\"Edited\"", token, sourceText);
                Assert.True((bool)Get(result, "Safe"), (string)Get(result, "Reason"));
                Assert.Equal("Insert", Get(result, "Mode").ToString());
                string edited = TextOf(result);
                Assert.Contains("this.protectedButton.Text = \"Edited\";", edited);
                Assert.DoesNotContain("System.Windows.Forms.Button protectedButton", edited);

                object removed = Remove(worker, "protectedButton", "Text", token, edited);
                Assert.True((bool)Get(removed, "Safe"), (string)Get(removed, "Reason"));
                Assert.Equal(sourceText, TextOf(removed));
                Assert.False((bool)Get(Remove(worker, "protectedButton", "Text", token + "STALE", edited), "Safe"));
            });
        }

        [Fact]
        public void InheritedOverride_RefusesStaleTokensInaccessibleFieldsAndPropertyMismatches_ButAcceptsResolvedCustomControls()
        {
            WithDesignerSource((designerPath, sourceText) =>
            {
                object worker = CreateWorker();
                object publicComponent = Describe(worker, "publicButton")!;
                string token = (string)Get(publicComponent, "BaseIdentityToken");

                object stale = Apply(worker, "publicButton", "Text", "\"Edited\"", token + "STALE", sourceText);
                Assert.False((bool)Get(stale, "Safe"));
                Assert.Contains("token", (string)Get(stale, "Reason"), StringComparison.OrdinalIgnoreCase);

                object font = Apply(worker, "publicButton", "Font", "null", token, sourceText);
                Assert.False((bool)Get(font, "Safe"));
                Assert.Contains("not supported", (string)Get(font, "Reason"), StringComparison.OrdinalIgnoreCase);

                AssertNotInheritedOverride(Describe(worker, "internalButton")!);
                AssertNotInheritedOverride(Describe(worker, "privateProtectedButton")!);

                object customComponent = Describe(worker, "customButton")!;
                Assert.True((bool)Get(customComponent, "InheritedOverrideEditable"));
                string customToken = (string)Get(customComponent, "BaseIdentityToken");
                object custom = Apply(worker, "customButton", "Text", "\"Custom derived\"", customToken, sourceText);
                Assert.True((bool)Get(custom, "Safe"), (string)Get(custom, "Reason"));
                Assert.Contains("this.customButton.Text = \"Custom derived\";", TextOf(custom));

                object vendorComponent = Describe(worker, "vendorButton")!;
                Assert.True((bool)Get(vendorComponent, "InheritedOverrideEditable"));
                Assert.Equal("FakeVendor.FancyButton", (string)Get(vendorComponent, "InheritedFieldType"));
                string vendorToken = (string)Get(vendorComponent, "BaseIdentityToken");
                object vendor = Apply(worker, "vendorButton", "Text", "\"Vendor derived\"", vendorToken, sourceText);
                Assert.True((bool)Get(vendor, "Safe"), (string)Get(vendor, "Reason"));
                string vendorEdited = TextOf(vendor);
                Assert.Contains("this.vendorButton.Text = \"Vendor derived\";", vendorEdited);
                object vendorReset = Remove(worker, "vendorButton", "Text", vendorToken, vendorEdited);
                Assert.True((bool)Get(vendorReset, "Safe"), (string)Get(vendorReset, "Reason"));
                Assert.Equal(sourceText, TextOf(vendorReset));
            });
        }

        [Fact]
        public void InheritedEligibility_SupportsAllFirstPartyControlsButNeverPublishesUnwritableIdentifiers()
        {
            WithDesignerSource((designerPath, sourceText) =>
            {
                object worker = CreateWorker();
                object link = Describe(worker, "publicLinkLabel")!;
                Assert.True((bool)Get(link, "InheritedOverrideEditable"));
                string token = (string)Get(link, "BaseIdentityToken");
                Assert.StartsWith("sha256:", token);
                Assert.Equal("System.Windows.Forms.LinkLabel", (string)Get(link, "InheritedFieldType"));
                object applied = Apply(worker, "publicLinkLabel", "Text", "\"Linked\"", token, sourceText);
                Assert.True((bool)Get(applied, "Safe"), (string)Get(applied, "Reason"));
                Assert.Contains("this.publicLinkLabel.Text = \"Linked\";", TextOf(applied));

                AssertNotInheritedOverride(Describe(worker, "кнопка")!);
                AssertNotInheritedOverride(Describe(worker, "class")!);
            });
        }

        [Fact]
        public void CompiledInheritedAuthority_RefusesUnknownOrChangedCurrentSourceBase()
        {
            object worker = CreateWorker();
            MethodInfo method = worker.GetType().GetMethod("ValidateCurrentSourceBase")!;

            string accepted = (string)method.Invoke(worker, new object?[]
                { TestAssemblyPath, TestRootTypeName, typeof(Net48InheritedBaseForm).FullName! })!;
            Assert.Equal("", accepted);

            string ambiguousShortName = (string)method.Invoke(worker, new object?[]
                { TestAssemblyPath, TestRootTypeName, nameof(Net48InheritedBaseForm) })!;
            Assert.Contains("source base", ambiguousShortName, StringComparison.OrdinalIgnoreCase);

            string changed = (string)method.Invoke(worker, new object?[]
                { TestAssemblyPath, TestRootTypeName, typeof(Form).FullName! })!;
            Assert.Contains("source base", changed, StringComparison.OrdinalIgnoreCase);
            Assert.Contains("compiled base", changed, StringComparison.OrdinalIgnoreCase);
            Assert.Contains("rebuild", changed, StringComparison.OrdinalIgnoreCase);

            string unknown = (string)method.Invoke(worker, new object?[]
                { TestAssemblyPath, TestRootTypeName, "" })!;
            Assert.Contains("could not be resolved", unknown, StringComparison.OrdinalIgnoreCase);
        }

        [Fact]
        public void CurrentSourceBaseResolver_BindsCurrentDesignerAndCodeBehindSnapshotsToExactRuntimeTypes()
        {
            string dir = Path.Combine(Path.GetTempPath(), "WfdCurrentBase." + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(dir);
            string designerPath = Path.Combine(dir, "Derived.Designer.cs");
            string codePath = Path.Combine(dir, "Derived.cs");
            const string designer =
                "namespace Sample { partial class Derived { private void InitializeComponent() { } } }";
            File.WriteAllText(designerPath, designer);
            File.WriteAllText(codePath,
                "namespace Sample { public partial class Derived : System.Windows.Forms.Form { } } ");
            try
            {
                Type resolver = Net48EngineAssembly().GetType(
                    "WinFormsDesigner.Engine.Net48.RootTypeResolver", throwOnError: true)!;
                MethodInfo method = resolver.GetMethod("ResolveDeclaredBase")!;
                string sibling = (string)method.Invoke(null, new object?[]
                    { designerPath, designer, null, TestAssemblyPath, Array.Empty<string>() })!;
                Assert.Equal("System.Windows.Forms.Form", sibling);

                string dirty = designer.Replace("partial class Derived",
                    "partial class Derived : System.Windows.Forms.UserControl");
                string unsaved = (string)method.Invoke(null, new object?[]
                    { designerPath, dirty, "namespace Sample { partial class Derived { } }", TestAssemblyPath, Array.Empty<string>() })!;
                Assert.Equal("System.Windows.Forms.UserControl", unsaved);
                string conflictingPartials = (string)method.Invoke(null, new object?[]
                    { designerPath, dirty, null, TestAssemblyPath, Array.Empty<string>() })!;
                Assert.Equal("", conflictingPartials);

                const string exactDesigner =
                    "namespace Engine.Net48.UnitTests { partial class Net48InheritedDerivedForm { private void InitializeComponent() { } } }";
                const string sameNamespaceCode =
                    "namespace Engine.Net48.UnitTests { public partial class Net48InheritedDerivedForm : Net48InheritedBaseForm { } }";
                string sameNamespace = (string)method.Invoke(null, new object?[]
                    { designerPath, exactDesigner, sameNamespaceCode, TestAssemblyPath, Array.Empty<string>() })!;
                Assert.Equal(typeof(Net48InheritedBaseForm).FullName, sameNamespace);

                const string changedAliasCode =
                    "using Base = Engine.Net48.UnitTests.Other.Net48InheritedBaseForm; " +
                    "namespace Engine.Net48.UnitTests { public partial class Net48InheritedDerivedForm : Base { } }";
                string changedAlias = (string)method.Invoke(null, new object?[]
                    { designerPath, exactDesigner, changedAliasCode, TestAssemblyPath, Array.Empty<string>() })!;
                Assert.Equal(typeof(Other.Net48InheritedBaseForm).FullName, changedAlias);
                Assert.NotEqual(sameNamespace, changedAlias);
            }
            finally
            {
                try { Directory.Delete(dir, recursive: true); } catch { }
            }
        }

        [Fact]
        public void InheritedGeometryMetadataAndAuthorization_PreserveLayoutRefusals()
        {
            WithDesignerSource((designerPath, sourceText) =>
            {
                object worker = CreateWorker();
                object layout = Render(worker);
                object publicControl = Control(layout, "publicButton");
                string token = (string)Get(publicControl, "BaseIdentityToken");
                Assert.True((bool)Get(publicControl, "InheritedOverrideEditable"));
                Assert.True((bool)Get(publicControl, "InheritedGeometryOverrideEditable"));
                Assert.True((bool)Get(AuthorizeGeometry(worker, "publicButton", token), "Safe"));

                AssertGeometryRefused(worker, layout, "dockedButton", "Dock");
                AssertGeometryRefused(worker, layout, "autoSizeButton", "AutoSize");
                AssertGeometryRefused(worker, layout, "flowButton", "FlowLayoutPanel");
                AssertGeometryRefused(worker, layout, "tableButton", "TableLayoutPanel");
            });
        }

        [Fact]
        public void InterpretedDescribe_UsesTheLiveInheritedIdentityAndPreservesOverrideMetadata()
        {
            WithDesignerSource((designerPath, sourceText) =>
            {
                string overriddenSource = sourceText.Replace(
                    "this.SuspendLayout();",
                    "this.SuspendLayout();\r\n            this.protectedButton.Text = \"Interpreted derived\";");
                Assembly engine = Net48EngineAssembly();
                Type builderType = engine.GetType("WinFormsDesigner.Engine.DesignerIrBuilder", throwOnError: true)!;
                object document = builderType.GetMethod("Build", BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic)!
                    .Invoke(null, new object?[] { overriddenSource })!;
                object worker = CreateWorker();
                MethodInfo method = worker.GetType().GetMethod("DescribeInterpretedComponent")!;
                object? component = method.Invoke(worker, new object?[]
                {
                    designerPath, TestAssemblyPath, document, TestRootTypeName,
                    "protectedButton", 0, 0, "", typeof(Net48InheritedBaseForm).FullName!,
                });

                Assert.NotNull(component);
                // RenderWorker intentionally has no Roslyn/source-text dependency in the child AppDomain.
                // EngineApi performs this exact host-domain post-processing before returning the RPC result.
                Type sourceMetadataType = engine.GetType("WinFormsDesigner.Engine.Net48.SourceMetadata", throwOnError: true)!;
                sourceMetadataType.GetMethod("Apply", BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic)!
                    .Invoke(null, new object?[] { component, designerPath, overriddenSource });
                Assert.Equal("inherited", (string)Get(component!, "Ownership"));
                Assert.False((bool)Get(component!, "Editable"));
                Assert.True((bool)Get(component!, "InheritedOverrideEditable"));
                Assert.StartsWith("sha256:", (string)Get(component!, "BaseIdentityToken"));
                object text = Property(component!, "Text");
                Assert.Equal("Interpreted derived", (string)Get(text, "Value"));
                Assert.True((bool)Get(text, "SourceExplicit"));
                Assert.True((bool)Get(text, "InheritedOverrideEditable"));
                Assert.True((bool)Get(text, "InheritedOverrideResettable"));
                Assert.False((bool)Get(text, "ReadOnly"));

                object? link = method.Invoke(worker, new object?[]
                {
                    designerPath, TestAssemblyPath, document, TestRootTypeName,
                    "publicLinkLabel", 0, 0, "", typeof(Net48InheritedBaseForm).FullName!,
                });
                Assert.NotNull(link);
                Assert.True((bool)Get(link!, "InheritedOverrideEditable"));
                Assert.Equal("System.Windows.Forms.LinkLabel", (string)Get(link!, "InheritedFieldType"));

                object? unicode = method.Invoke(worker, new object?[]
                {
                    designerPath, TestAssemblyPath, document, TestRootTypeName,
                    "кнопка", 0, 0, "", typeof(Net48InheritedBaseForm).FullName!,
                });
                object? keyword = method.Invoke(worker, new object?[]
                {
                    designerPath, TestAssemblyPath, document, TestRootTypeName,
                    "class", 0, 0, "", typeof(Net48InheritedBaseForm).FullName!,
                });
                Assert.NotNull(unicode);
                Assert.NotNull(keyword);
                AssertNotInheritedOverride(unicode!);
                AssertNotInheritedOverride(keyword!);
            });
        }

        [Fact]
        public void InterpretedStaleBase_FallsBackAndScrubsEveryLayoutCapability()
        {
            WithDesignerSource((designerPath, sourceText) =>
            {
                Assembly engine = Net48EngineAssembly();
                Type builderType = engine.GetType("WinFormsDesigner.Engine.DesignerIrBuilder", throwOnError: true)!;
                object document = builderType.GetMethod("Build", BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic)!
                    .Invoke(null, new object?[] { sourceText })!;
                object worker = CreateWorker();

                MethodInfo describe = worker.GetType().GetMethod("DescribeInterpretedComponent")!;
                object? staleDescription = describe.Invoke(worker, new object?[]
                {
                    designerPath, TestAssemblyPath, document, TestRootTypeName,
                    "protectedButton", 0, 0, "", typeof(Form).FullName!,
                });
                Assert.Null(staleDescription);

                MethodInfo render = worker.GetType().GetMethod("RenderInterpretedWithLayout")!;
                object fallback = render.Invoke(worker, new object?[]
                {
                    designerPath, TestAssemblyPath, document, TestRootTypeName,
                    0, 0, null, 1, "", typeof(Form).FullName!,
                })!;
                Assert.Equal("compiledFallback", (string)Get(fallback, "RenderMode"));
                Assert.Equal("baseTypeChanged", (string)Get(fallback, "FallbackReason"));
                object inherited = Control(fallback, "protectedButton");
                Assert.False((bool)Get(inherited, "InheritedOverrideEditable"));
                Assert.False((bool)Get(inherited, "InheritedGeometryOverrideEditable"));
                Assert.Equal("", (string)Get(inherited, "BaseIdentityToken"));
                Assert.Contains("rebuild", (string)Get(inherited, "ReadOnlyReason"), StringComparison.OrdinalIgnoreCase);
            });
        }

        private static void AssertGeometryRefused(object worker, object layout, string id, string reason)
        {
            object control = Control(layout, id);
            Assert.True((bool)Get(control, "InheritedOverrideEditable"));
            Assert.False((bool)Get(control, "InheritedGeometryOverrideEditable"));
            object component = Describe(worker, id)!;
            object location = Property(component, "Location");
            Assert.False((bool)Get(location, "InheritedOverrideEditable"));
            Assert.True((bool)Get(location, "InheritedOverrideResettable"));
            Assert.True((bool)Get(location, "ReadOnly"));
            object auth = AuthorizeGeometry(worker, id, (string)Get(control, "BaseIdentityToken"));
            Assert.False((bool)Get(auth, "Safe"));
            Assert.Contains(reason, (string)Get(auth, "Reason"), StringComparison.OrdinalIgnoreCase);
        }

        private static void AssertNotInheritedOverride(object component)
        {
            Assert.False((bool)Get(component, "Editable"));
            Assert.False((bool)Get(component, "InheritedOverrideEditable"));
            Assert.Equal("", (string)Get(component, "BaseIdentityToken"));
            Assert.All(Properties(component), p => Assert.False((bool)Get(p, "InheritedOverrideEditable")));
        }

        private object CreateWorker()
        {
            Type workerType = Net48EngineAssembly().GetType("WinFormsDesigner.Engine.Net48.RenderWorker", throwOnError: true)!;
            object worker = Activator.CreateInstance(workerType)!;
            liveWorkers.Add(worker);
            return worker;
        }

        public void Dispose()
        {
            Exception? cleanupFailure = null;
            foreach (object worker in liveWorkers)
            {
                try
                {
                    MethodInfo discard = worker.GetType().GetMethod("DiscardLive")!;
                    discard.Invoke(worker, new object?[] { TestAssemblyPath, TestRootTypeName, "" });
                }
                catch (Exception ex)
                {
                    cleanupFailure ??= ex is TargetInvocationException invocation && invocation.InnerException != null
                        ? invocation.InnerException
                        : ex;
                }
            }
            liveWorkers.Clear();
            if (cleanupFailure != null)
                throw new InvalidOperationException("Failed to dispose an inherited-override live render graph.", cleanupFailure);
        }

        private static object? Describe(object worker, string componentId)
        {
            MethodInfo method = worker.GetType().GetMethod("DescribeComponent")!;
            return method.Invoke(worker, new object?[] { TestAssemblyPath, TestRootTypeName, componentId });
        }

        private static object Render(object worker)
        {
            MethodInfo method = worker.GetType().GetMethod("RenderWithLayout")!;
            return method.Invoke(worker, new object?[] { TestAssemblyPath, TestRootTypeName, 0, 0, 1 })!;
        }

        private static object Apply(object worker, string componentId, string propertyName,
            string valueExpression, string expectedBaseIdentityToken, string sourceText)
        {
            object info = GetInheritedTarget(worker, componentId, propertyName, expectedBaseIdentityToken);
            if (!(bool)Get(info, "Safe")) return info;
            object request = BuildInheritedRequest(info, sourceText, valueExpression, expectedBaseIdentityToken);
            Type editor = Net48EngineAssembly().GetType(
                "WinFormsDesigner.Engine.DesignerInheritedOverrideEditor", throwOnError: true)!;
            return editor.GetMethod("TryApplyValidatedLiveTarget", BindingFlags.Static | BindingFlags.NonPublic)!
                .Invoke(null, new[] { request })!;
        }

        private static object AuthorizeGeometry(object worker, string componentId, string expectedBaseIdentityToken)
        {
            MethodInfo method = worker.GetType().GetMethod("AuthorizeInheritedGeometryOverride")!;
            return method.Invoke(worker, new object?[] { TestAssemblyPath, TestRootTypeName, componentId, expectedBaseIdentityToken })!;
        }

        private static object Remove(object worker, string componentId, string propertyName,
            string expectedBaseIdentityToken, string sourceText)
        {
            object info = GetInheritedTarget(worker, componentId, propertyName, expectedBaseIdentityToken);
            if (!(bool)Get(info, "Safe")) return info;
            object request = BuildInheritedRequest(info, sourceText, "", expectedBaseIdentityToken);
            Type editor = Net48EngineAssembly().GetType(
                "WinFormsDesigner.Engine.DesignerInheritedOverrideEditor", throwOnError: true)!;
            return editor.GetMethod("TryRemoveValidatedLiveTarget", BindingFlags.Static | BindingFlags.NonPublic)!
                .Invoke(null, new[] { request })!;
        }

        private static object GetInheritedTarget(object worker, string componentId, string propertyName,
            string expectedBaseIdentityToken)
        {
            MethodInfo method = worker.GetType().GetMethod("GetInheritedOverrideTargetInfo")!;
            return method.Invoke(worker, new object?[]
                { TestAssemblyPath, TestRootTypeName, componentId, propertyName, expectedBaseIdentityToken })!;
        }

        private static object BuildInheritedRequest(object info, string sourceText, string valueExpression,
            string expectedBaseIdentityToken)
        {
            Type requestType = Net48EngineAssembly().GetType(
                "WinFormsDesigner.Engine.InheritedOverrideEditRequest", throwOnError: true)!;
            object request = Activator.CreateInstance(requestType)!;
            Set(request, "SourceText", sourceText);
            Set(request, "FieldId", Get(info, "FieldId"));
            Set(request, "FieldTypeName", Get(info, "FieldTypeName"));
            Set(request, "EffectiveAccessibility", Get(info, "EffectiveAccessibility"));
            Set(request, "PropertyName", Get(info, "PropertyName"));
            Set(request, "PropertyTypeName", Get(info, "PropertyTypeName"));
            Set(request, "ValueExpression", valueExpression);
            Set(request, "ExpectedBaseIdentityToken", expectedBaseIdentityToken);
            Set(request, "ObservedBaseIdentityToken", Get(info, "BaseIdentityToken"));
            return request;
        }

        private static object Control(object layout, string id) =>
            ((IEnumerable)Get(layout, "Controls")).Cast<object>().Single(c => (string)Get(c, "Id") == id);

        private static object Property(object component, string name) =>
            Properties(component).Single(p => (string)Get(p, "Name") == name);

        private static object Event(object component, string name) =>
            ((IEnumerable)Get(component, "Events")).Cast<object>().Single(e => (string)Get(e, "Name") == name);

        private static object[] Properties(object component) =>
            ((IEnumerable)Get(component, "Properties")).Cast<object>().ToArray();

        private static object Get(object instance, string propertyName) =>
            instance.GetType().GetProperty(propertyName)!.GetValue(instance)!;

        private static void Set(object instance, string propertyName, object value) =>
            instance.GetType().GetProperty(propertyName)!.SetValue(instance, value);

        private static string TextOf(object result)
        {
            PropertyInfo? text = result.GetType().GetProperty("Text");
            if (text != null) return (string)text.GetValue(result)!;
            return (string)result.GetType().GetProperty("NewText")!.GetValue(result)!;
        }

        private static void WithDesignerSource(Action<string, string> test)
        {
            string sourceText = DesignerSource();
            string path = Path.Combine(Path.GetTempPath(), "Net48InheritedDerivedForm." + Guid.NewGuid().ToString("N") + ".Designer.cs");
            File.WriteAllText(path, sourceText);
            try { test(path, sourceText); }
            finally { try { File.Delete(path); } catch { } }
        }

        private static string DesignerSource() =>
@"namespace Engine.Net48.UnitTests
{
    public partial class Net48InheritedDerivedForm
    {
        private void InitializeComponent()
        {
            this.SuspendLayout();
            this.ResumeLayout(false);
        }
    }
}
";

        private static Assembly Net48EngineAssembly()
        {
            var config = typeof(InheritedOverrideNet48Tests).Assembly
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

        private static string TestAssemblyPath => typeof(Net48InheritedDerivedForm).Assembly.Location;

        private static string TestRootTypeName => typeof(Net48InheritedDerivedForm).FullName!;
    }

    public class Net48CustomInheritedButton : Button { }

    public class Net48InheritedBaseForm : Form
    {
        public Button publicButton;
        protected Button protectedButton;
        protected internal Button protectedInternalButton;
        internal Button internalButton;
        private protected Button privateProtectedButton;
        public Net48CustomInheritedButton customButton;
        public FakeVendor.FancyButton vendorButton;
        public LinkLabel publicLinkLabel;
        public Button кнопка;
        public Button @class;
        public Button dockedButton;
        public Button autoSizeButton;
        public FlowLayoutPanel flowPanel;
        public Button flowButton;
        public TableLayoutPanel tablePanel;
        public Button tableButton;

        public Net48InheritedBaseForm()
        {
            ClientSize = new System.Drawing.Size(520, 420);
            publicButton = Button("publicButton", 10, 10);
            protectedButton = Button("protectedButton", 10, 45);
            protectedInternalButton = Button("protectedInternalButton", 10, 80);
            internalButton = Button("internalButton", 10, 115);
            privateProtectedButton = Button("privateProtectedButton", 10, 150);
            customButton = new Net48CustomInheritedButton { Name = "customButton", Text = "Custom" };
            customButton.SetBounds(10, 185, 100, 24);
            vendorButton = new FakeVendor.FancyButton { Name = "vendorButton", Text = "Vendor" };
            vendorButton.SetBounds(300, 115, 100, 24);
            publicLinkLabel = new LinkLabel { Name = "publicLinkLabel", Text = "Link" };
            publicLinkLabel.SetBounds(300, 10, 100, 24);
            кнопка = Button("кнопка", 300, 45);
            @class = Button("class", 300, 80);
            dockedButton = Button("dockedButton", 10, 220);
            dockedButton.Dock = DockStyle.Bottom;
            autoSizeButton = Button("autoSizeButton", 130, 10);
            autoSizeButton.AutoSize = true;
            flowPanel = new FlowLayoutPanel { Name = "flowPanel" };
            flowPanel.SetBounds(130, 45, 150, 60);
            flowButton = Button("flowButton", 0, 0);
            tablePanel = new TableLayoutPanel { Name = "tablePanel", ColumnCount = 1, RowCount = 1 };
            tablePanel.SetBounds(130, 120, 150, 60);
            tableButton = Button("tableButton", 0, 0);

            Controls.Add(publicButton);
            Controls.Add(protectedButton);
            Controls.Add(protectedInternalButton);
            Controls.Add(internalButton);
            Controls.Add(privateProtectedButton);
            Controls.Add(customButton);
            Controls.Add(vendorButton);
            Controls.Add(publicLinkLabel);
            Controls.Add(кнопка);
            Controls.Add(@class);
            Controls.Add(dockedButton);
            Controls.Add(autoSizeButton);
            flowPanel.Controls.Add(flowButton);
            Controls.Add(flowPanel);
            tablePanel.Controls.Add(tableButton, 0, 0);
            Controls.Add(tablePanel);
            // ContainerControl keeps a private runtime reference to the active control. That must not be counted as
            // a second source field alias for the protected designer member.
            ActiveControl = protectedButton;
        }

        private static Button Button(string name, int x, int y)
        {
            var button = new Button { Name = name, Text = name };
            button.SetBounds(x, y, 100, 24);
            return button;
        }
    }

    public partial class Net48InheritedDerivedForm : Net48InheritedBaseForm
    {
    }
}

namespace Engine.Net48.UnitTests.Other
{
    public class Net48InheritedBaseForm : System.Windows.Forms.Form { }
}
