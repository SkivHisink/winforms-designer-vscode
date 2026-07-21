using System.ComponentModel;
using System.Linq;
using System.Reflection;
using System.Windows.Forms;
using System.Drawing;
using WinFormsDesigner.Engine;

namespace Engine.UnitTests;

// A base whose OnControlAdded redirects newly-added top-level controls into an INHERITED container — the pattern that
// exposes the ParentOf origin bug: a current-source child ends up parented under an inherited-origin panel, so a
// reference scan that ignores Origins would report the inherited panel's name as the child's parent.
public class ReparentBaseForm : Form
{
    internal Panel inheritedPanel = new Panel();
    public ReparentBaseForm() { inheritedPanel.Name = "inheritedPanel"; Controls.Add(inheritedPanel); }
    protected override void OnControlAdded(ControlEventArgs e)
    {
        base.OnControlAdded(e);
        if (e.Control != null && !ReferenceEquals(e.Control, inheritedPanel) && ReferenceEquals(e.Control.Parent, this))
            inheritedPanel.Controls.Add(e.Control); // reparent into the inherited container (removes from `this`)
    }
}

// White-box coverage of the identity-model resolution behind interpreted describe (InterpretedDescribeResolver) — the
// acceptance-critical filtering that the render worker used to hold privately: which selection is describable, what its
// reference-dropdown siblings are, and its logical root/parent name. Driven end to end on the real Plan pipeline (base
// instantiated, derived IR replayed) so it exercises exactly what the net48 describe path resolves before it hands the
// target to CompiledDescriber. The black-box e2e proves the same invariants through the engine; this pins them fast.
public sealed class InterpretedDescribeResolverTests
{
    private static readonly Assembly[] Probe =
    {
        typeof(PlanBaseForm).Assembly,
        typeof(Control).Assembly, typeof(Color).Assembly, typeof(Point).Assembly, typeof(object).Assembly,
    };

    private static AssemblyIrHost Host() => new(Probe, new DesignTimeContainer(), SafeResxResolver.Parse(""));

    // Derived form: ownBtn + grp are current-source root children; childBtn is a current-source child of grp; the base
    // (PlanBaseForm) contributes an INHERITED inheritedBtn. Exercises current-source vs inherited + nested parent.
    private const string Src = @"
namespace Demo {
  partial class DerivedForm : Engine.UnitTests.PlanBaseForm {
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

    private static InterpretedRenderPlan PlannedForm()
    {
        var doc = DesignerIrBuilder.Build(Src);
        Assert.NotNull(doc);
        Assert.True(doc!.FullCoverage, string.Join(" | ", doc.UnrepresentableReasons));
        var plan = InterpretedRenderPlan.Plan(doc, Host());
        Assert.True(plan.Interpreted, plan.Decision.FallbackReason + ": " + plan.Decision.Detail);
        return plan;
    }

    [Fact]
    public void Root_ResolvesToLogicalDesignedType_NotBaseRuntimeType()
    {
        var plan = PlannedForm();
        var root = (Control)plan.Root!;

        foreach (var rootId in new[] { "", "this" })
        {
            var t = InterpretedDescribeResolver.Resolve(plan.Execution!, plan.DesignedTypeName, root, rootId);
            Assert.NotNull(t);
            Assert.True(t!.IsRoot);
            Assert.Same(root, t.Target);
            Assert.Equal("DerivedForm", t.Name); // the LOGICAL designed type, never the base "PlanBaseForm"
            Assert.Null(t.Parent);
        }
    }

    [Fact]
    public void CurrentSourceComponent_IsDescribable_WithLogicalRootParent_AndCurrentSourceSiblingsOnly()
    {
        var plan = PlannedForm();
        var root = (Control)plan.Root!;
        var exec = plan.Execution!;

        var t = InterpretedDescribeResolver.Resolve(plan.Execution!, plan.DesignedTypeName, root, "ownBtn");
        Assert.NotNull(t);
        Assert.False(t!.IsRoot);
        Assert.Same(exec.Instances["ownBtn"], t.Target);
        Assert.Equal("ownBtn", t.Name);
        Assert.Equal("DerivedForm", t.Parent); // parented on the live root → the LOGICAL type name

        // siblings are the OTHER current-source components, ordinal-sorted, and NEVER the inherited base component.
        var sibIds = t.Siblings.Select(s => s.Key).ToArray();
        Assert.Equal(new[] { "childBtn", "grp" }, sibIds);
        Assert.DoesNotContain("inheritedBtn", sibIds);
        Assert.DoesNotContain("ownBtn", sibIds); // never itself
    }

    [Fact]
    public void NestedControl_ParentResolvesToItsCurrentSourceContainer()
    {
        var plan = PlannedForm();
        var root = (Control)plan.Root!;

        var t = InterpretedDescribeResolver.Resolve(plan.Execution!, plan.DesignedTypeName, root, "childBtn");
        Assert.NotNull(t);
        Assert.Equal("grp", t!.Parent); // nearest identity-backed ancestor is the group box, not the form
    }

    [Fact]
    public void InheritedComponent_IsNotDescribable_ReturnsNull()
    {
        var plan = PlannedForm();
        var root = (Control)plan.Root!;
        // inheritedBtn is real (from the compiled base) and IS in the identity model as Inherited — but describe must
        // refuse it so the host keeps that selection read-only/unavailable, never presenting inherited members as
        // editable current-source ones.
        Assert.Equal(IrOrigin.Inherited, plan.Execution!.Origins["inheritedBtn"]);
        Assert.Null(InterpretedDescribeResolver.Resolve(plan.Execution!, plan.DesignedTypeName, root, "inheritedBtn"));
    }

    [Fact]
    public void UnknownId_ReturnsNull()
    {
        var plan = PlannedForm();
        var root = (Control)plan.Root!;
        Assert.Null(InterpretedDescribeResolver.Resolve(plan.Execution!, plan.DesignedTypeName, root, "noSuchComponent"));
    }

    [Fact]
    public void NestedControl_UnderInheritedContainer_ParentSkipsInheritedName_ToLogicalRoot()
    {
        // A base OnControlAdded reparents the current-source `child` into the INHERITED `inheritedPanel`. ParentOf must
        // NOT report the inherited container's name (the derived source can't spell it as this.<field>); it skips the
        // inherited ancestor and reports the nearest CURRENT-SOURCE ancestor — here the logical root.
        var doc = DesignerIrBuilder.Build(@"
namespace Demo { partial class ReparentForm : Engine.UnitTests.ReparentBaseForm {
  private System.Windows.Forms.Button child;
  private void InitializeComponent() {
    this.child = new System.Windows.Forms.Button();
    this.Controls.Add(this.child);
  }
} }");
        Assert.NotNull(doc);
        Assert.True(doc!.FullCoverage, string.Join(" | ", doc.UnrepresentableReasons));
        var plan = InterpretedRenderPlan.Plan(doc, Host());
        Assert.True(plan.Interpreted, plan.Decision.FallbackReason + ": " + plan.Decision.Detail);
        var root = (Control)plan.Root!;

        // precondition: the base really reparented the current-source child under the inherited panel
        var child = (Control)plan.Execution!.Instances["child"];
        Assert.Equal("inheritedPanel", child.Parent?.Name);
        Assert.Equal(IrOrigin.Inherited, plan.Execution!.Origins["inheritedPanel"]);

        var t = InterpretedDescribeResolver.Resolve(plan.Execution!, plan.DesignedTypeName, root, "child");
        Assert.NotNull(t);
        Assert.Equal("ReparentForm", t!.Parent); // NOT "inheritedPanel"
    }
}
