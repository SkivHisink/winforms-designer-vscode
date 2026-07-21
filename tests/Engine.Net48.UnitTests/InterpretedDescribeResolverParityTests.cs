using System;
using System.Drawing;
using System.Linq;
using System.Reflection;
using System.ComponentModel;
using System.Windows.Forms;
using Xunit;
using WinFormsDesigner.Engine;

namespace Engine.Net48.UnitTests
{
    // A compiled net48 "base" whose ctor creates a field-backed inherited component — the analogue of VS's base partial.
    public class NetPlanBaseForm : Form
    {
        internal Button inheritedBtn = new Button();
        public NetPlanBaseForm() { inheritedBtn.Name = "inheritedBtn"; Controls.Add(inheritedBtn); }
    }

    // Proves the shared InterpretedDescribeResolver (the identity-model filtering behind interpreted describe) behaves
    // IDENTICALLY on the actual .NET Framework 4.8 runtime with REAL net48 WinForms controls — the exact runtime the
    // render child domain uses. Drives the real executor onto a compiled base instance (so inherited vs current-source
    // origins are real), then asserts the same acceptance invariants the net10 white-box test pins. BCL-only shared
    // code, so parity is the same guarantee as the IR core's — this closes the net48 side of the describe path.
    public sealed class InterpretedDescribeResolverParityTests
    {
        private sealed class TestHost : IIrHost
        {
            private static readonly Assembly[] Probe =
            {
                typeof(Control).Assembly, typeof(Color).Assembly, typeof(Point).Assembly, typeof(object).Assembly,
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

        private const string Src = @"
namespace Demo {
  partial class DerivedForm : Engine.Net48.UnitTests.NetPlanBaseForm {
    private System.Windows.Forms.Button ownBtn;
    private System.Windows.Forms.GroupBox grp;
    private System.Windows.Forms.Button childBtn;
    private void InitializeComponent() {
      this.ownBtn = new System.Windows.Forms.Button();
      this.grp = new System.Windows.Forms.GroupBox();
      this.childBtn = new System.Windows.Forms.Button();
      this.ownBtn.Text = ""Own"";
      this.grp.Controls.Add(this.childBtn);
      this.Controls.Add(this.ownBtn);
      this.Controls.Add(this.grp);
    }
  }
}";

        private static (IrExecutionResult exec, Control root) Interpret()
        {
            var doc = DesignerIrBuilder.Build(Src);
            Assert.NotNull(doc);
            Assert.True(doc.FullCoverage, string.Join(" | ", doc.UnrepresentableReasons));
            var root = new NetPlanBaseForm(); // the compiled base instance, exactly as the plan instantiates it
            var exec = DesignerIrExecutor.Execute(doc, root, new TestHost());
            Assert.True(exec.Ok, exec.FailureReason);
            return (exec, root);
        }

        [Fact]
        public void Resolve_OnNet48_HonorsOriginFilterAndLogicalNames()
        {
            var (exec, root) = Interpret();
            const string designed = "Demo.DerivedForm";

            // root → the LOGICAL designed type, never the base runtime type
            var rootT = InterpretedDescribeResolver.Resolve(exec, designed, root, "");
            Assert.NotNull(rootT);
            Assert.True(rootT.IsRoot);
            Assert.Same(root, rootT.Target);
            Assert.Equal("DerivedForm", rootT.Name);

            // current-source component → describable, logical root parent, current-source-only siblings
            var own = InterpretedDescribeResolver.Resolve(exec, designed, root, "ownBtn");
            Assert.NotNull(own);
            Assert.Same(exec.Instances["ownBtn"], own.Target);
            Assert.Equal("DerivedForm", own.Parent);
            Assert.Equal(new[] { "childBtn", "grp" }, own.Siblings.Select(s => s.Key).ToArray());
            Assert.DoesNotContain("inheritedBtn", own.Siblings.Select(s => s.Key));

            // nested control → parent is its current-source container, not the form
            Assert.Equal("grp", InterpretedDescribeResolver.Resolve(exec, designed, root, "childBtn").Parent);

            // inherited (real, from the compiled base) → null; unknown → null
            Assert.Equal(IrOrigin.Inherited, exec.Origins["inheritedBtn"]);
            Assert.Null(InterpretedDescribeResolver.Resolve(exec, designed, root, "inheritedBtn"));
            Assert.Null(InterpretedDescribeResolver.Resolve(exec, designed, root, "noSuchComponent"));
        }
    }
}
