using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Drawing;
using System.Linq;
using System.Reflection;
using System.Windows.Forms;
using WinFormsDesigner.Engine;

namespace Engine.UnitTests;

// A TOP-LEVEL compiled "base" whose InitializeComponent (in the ctor) creates a field-backed component — as VS's base
// does. Top-level (not nested) so its reflection name equals its dotted source name (a nested type would need '+').
public class PlanBaseForm : Form
{
    internal Button inheritedBtn = new Button();
    public PlanBaseForm() { inheritedBtn.Name = "inheritedBtn"; Controls.Add(inheritedBtn); }
}

// The interpreted-render PLAN end to end (VS model): cover-check → resolve + instantiate the
// BASE type → replay the derived IR onto it → classify. Uses real base/derived Form types compiled into the test
// assembly, so it exercises the exact pipeline the render child domain runs (minus the off-screen Snapshot).
public sealed class InterpretedRenderPlanTests
{
    private static readonly Assembly[] Probe =
    {
        typeof(PlanBaseForm).Assembly, // the "user" assembly declaring the base
        typeof(Control).Assembly, typeof(Color).Assembly, typeof(Point).Assembly, typeof(object).Assembly,
    };

    private static AssemblyIrHost Host() => new(Probe, new DesignTimeContainer(), SafeResxResolver.Parse(""));

    // Source for the DERIVED form (its own .Designer.cs). Its base is the compiled PlanBaseForm.
    private const string DerivedSource = @"
namespace Demo {
  partial class DerivedForm : Engine.UnitTests.PlanBaseForm {
    private System.Windows.Forms.Button ownBtn;
    private void InitializeComponent() {
      this.ownBtn = new System.Windows.Forms.Button();
      this.ownBtn.Text = ""Own"";
      this.ownBtn.Location = new System.Drawing.Point(5, 5);
      this.Controls.Add(this.ownBtn);
    }
  }
}";

    [Fact]
    public void Plan_InterpretsDerived_OnCompiledBase_MergingIdentities()
    {
        var doc = DesignerIrBuilder.Build(DerivedSource);
        Assert.NotNull(doc);
        Assert.True(doc!.FullCoverage, string.Join(" | ", doc.UnrepresentableReasons));

        var plan = InterpretedRenderPlan.Plan(doc, Host());
        Assert.True(plan.Interpreted, plan.Decision.FallbackReason + ": " + plan.Decision.Detail);
        Assert.Equal(RenderMode.Interpreted, plan.Decision.Mode);

        var root = Assert.IsType<PlanBaseForm>(plan.Root); // the BASE type was instantiated (VS model)
        var exec = plan.Execution!;

        // the derived's own component is present, editable, with its parsed state, parented onto the live root.
        var ownBtn = (Button)exec.Instances["ownBtn"];
        Assert.Equal("Own", ownBtn.Text);
        Assert.Equal(new Point(5, 5), ownBtn.Location);
        Assert.Equal(IrOrigin.DeclaredInCurrentSource, exec.Origins["ownBtn"]);
        Assert.Contains(ownBtn, root.Controls.Cast<Control>());

        // the base's component is surfaced as INHERITED (from the real compiled base instance), not re-created.
        Assert.Equal(IrOrigin.Inherited, exec.Origins["inheritedBtn"]);
        Assert.Same(root.inheritedBtn, exec.Instances["inheritedBtn"]);
    }

    [Fact]
    public void Plan_MissingBaseType_FallsBack_BaseTypeChanged()
    {
        // The source declares a base the "assembly" doesn't contain → stale-type handshake → named fallback.
        var doc = DesignerIrBuilder.Build(@"
namespace Demo { partial class F : Demo.NotBuiltBase {
  private System.Windows.Forms.Button b;
  private void InitializeComponent() { this.b = new System.Windows.Forms.Button(); this.Controls.Add(this.b); }
} }");
        var plan = InterpretedRenderPlan.Plan(doc, Host());
        Assert.False(plan.Interpreted);
        Assert.Equal(RenderFallbackReason.BaseTypeChanged, plan.Decision.FallbackReason);
    }

    [Fact]
    public void Plan_PartialCoverage_FallsBack_WithoutInstantiating()
    {
        var doc = DesignerIrBuilder.Build(@"
namespace Demo { partial class F : System.Windows.Forms.Form {
  private void InitializeComponent() { System.Diagnostics.Process.Start(""calc""); }
} }");
        var plan = InterpretedRenderPlan.Plan(doc, Host());
        Assert.False(plan.Interpreted);
        Assert.Equal(RenderFallbackReason.UnrepresentableStatements, plan.Decision.FallbackReason);
        Assert.Null(plan.Root); // never instantiated anything — fell back on coverage alone
    }
}
