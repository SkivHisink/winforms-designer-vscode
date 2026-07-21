using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Drawing;
using System.Linq;
using System.Reflection;
using System.Windows.Forms;
using Xunit;
using WinFormsDesigner.Engine;

namespace Engine.Net48.UnitTests
{
    // Proves the compile-linked shared IR core (front-end + validator + executor) builds and behaves
    // IDENTICALLY on the .NET Framework 4.8 runtime, and that the executor drives REAL net48 WinForms controls — the
    // production child-domain runtime. This is the net48 unit floor engine-net48 previously lacked.
    public sealed class SharedIrParityTests
    {
        private const string Source = @"
namespace Demo {
  partial class MyForm : System.Windows.Forms.Form {
    private System.Windows.Forms.Button button1;
    private System.Windows.Forms.DataGridView grid1;
    private void InitializeComponent() {
      this.button1 = new System.Windows.Forms.Button();
      this.grid1 = new System.Windows.Forms.DataGridView();
      ((System.ComponentModel.ISupportInitialize)(this.grid1)).BeginInit();
      this.SuspendLayout();
      this.button1.Text = ""Click me"";
      this.button1.Location = new System.Drawing.Point(12, 40);
      this.button1.ForeColor = System.Drawing.Color.FromArgb(10, 20, 30);
      this.button1.Anchor = System.Windows.Forms.AnchorStyles.Top | System.Windows.Forms.AnchorStyles.Left;
      this.Controls.Add(this.button1);
      this.AcceptButton = this.button1;
      ((System.ComponentModel.ISupportInitialize)(this.grid1)).EndInit();
      this.ResumeLayout(false);
    }
  }
}";

        private sealed class TestHost : IIrHost
        {
            private static readonly Assembly[] Probe =
            {
                typeof(Control).Assembly, typeof(Color).Assembly, typeof(Font).Assembly, typeof(Point).Assembly,
                typeof(ISupportInitialize).Assembly, typeof(object).Assembly,
            };
            public Type ResolveType(string typeName)
            {
                foreach (var a in Probe) { var t = a.GetType(typeName, false); if (t != null) return t; }
                return Type.GetType(typeName, false);
            }
            public object CreateComponent(Type type, string name, bool withContainer) => Activator.CreateInstance(type);
            public object ResolveResource(string key, bool isString) => null;
            public bool WasResourceRefused(string key) => false;
        }

        [Fact]
        public void FrontEnd_ParsesToFullCoverage_OnNet48()
        {
            var doc = DesignerIrBuilder.Build(Source);
            Assert.NotNull(doc);
            Assert.Equal("Demo.MyForm", doc.DesignedTypeName);
            Assert.True(doc.FullCoverage, "gaps: " + string.Join(" | ", doc.UnrepresentableReasons));
            Assert.Null(IrValidate.Check(doc));
        }

        [Fact]
        public void Executor_BuildsRealNet48Tree_WithParsedState()
        {
            var doc = DesignerIrBuilder.Build(Source);
            var root = new Form();
            var res = DesignerIrExecutor.Execute(doc, root, new TestHost());
            Assert.True(res.Ok, res.FailureReason);

            var button1 = Assert.IsType<Button>(res.Instances["button1"]);
            Assert.Equal("Click me", button1.Text);
            Assert.Equal(new Point(12, 40), button1.Location);
            Assert.Equal(Color.FromArgb(10, 20, 30), button1.ForeColor);
            Assert.Equal(AnchorStyles.Top | AnchorStyles.Left, button1.Anchor);
            Assert.Contains(button1, root.Controls.Cast<Control>());
            Assert.Same(button1, root.AcceptButton);
            Assert.Empty(res.PendingInit); // Begin/EndInit balanced on the real DataGridView
        }

        [Fact]
        public void Validator_RefusesForgedIdentifier_OnNet48()
        {
            var doc = new IrDocument
            {
                DesignedTypeName = "Demo.MyForm",
                BaseTypeSyntaxName = "System.Windows.Forms.Form",
                TotalSourceStatements = 1,
                RepresentedStatements = 1,
                Statements = { new IrConstructComponent { Name = "1bad", TypeName = "System.Windows.Forms.Button" } },
            };
            Assert.NotNull(IrValidate.Check(doc));
        }

        [Fact]
        public void Executor_ChildSideSecurityCanary_OnNet48()
        {
            // A forged non-allowlisted construction is refused on net48 too — same shared boundary.
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
            var res = DesignerIrExecutor.Execute(forged, new Form(), new TestHost());
            Assert.False(res.Ok);
            Assert.Contains("construction not allowed", res.FailureReason);
        }

        private sealed class SitingHost : IIrHost
        {
            public readonly DesignTimeContainer Container = new DesignTimeContainer();
            private readonly TestHost _resolve = new TestHost();
            public Type ResolveType(string typeName) => _resolve.ResolveType(typeName);
            public object CreateComponent(Type type, string name, bool withContainer)
            {
                var c = (IComponent)Activator.CreateInstance(type);
                Container.Add(c, name);
                return c;
            }
            public object ResolveResource(string key, bool isString) => null;
            public bool WasResourceRefused(string key) => false;
        }

        [Fact]
        public void Executor_SitesRealNet48Component_DesignModeTrue()
        {
            var doc = DesignerIrBuilder.Build(Source);
            var host = new SitingHost();
            var res = DesignerIrExecutor.Execute(doc, new Form(), host);
            Assert.True(res.Ok, res.FailureReason);
            var button1 = (Button)res.Instances["button1"];
            Assert.NotNull(button1.Site);
            Assert.True(button1.Site.DesignMode); // DesignMode=true on the actual .NET Framework runtime
            Assert.Equal("button1", button1.Site.Name);
        }

        // The closed-set drift guard must hold on net48 too (same shared DesignerIr.cs).
        [Fact]
        public void ClosedValidationSet_CoversEveryIrNode_OnNet48()
        {
            var asm = typeof(IrValidate).Assembly;
            var bases = new[] { typeof(IrStatement), typeof(IrValue) };
            var concrete = asm.GetTypes().Where(t => t.IsClass && !t.IsAbstract && bases.Any(b => b.IsAssignableFrom(t))).ToList();
            Assert.NotEmpty(concrete);
            var closed = (HashSet<Type>)typeof(IrValidate).GetField("Closed", BindingFlags.NonPublic | BindingFlags.Static).GetValue(null);
            var missing = concrete.Where(t => !closed.Contains(t)).Select(t => t.Name).ToList();
            Assert.True(missing.Count == 0, "missing from Closed: " + string.Join(", ", missing));
        }
    }
}
