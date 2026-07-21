using System.Linq;
using WinFormsDesigner.Engine;

namespace Engine.UnitTests;

// Pins the SYNTAX-ONLY Roslyn front-end DesignerIrBuilder: which InitializeComponent shapes
// it represents as closed IR, which it honestly reports as coverage gaps (→ compiled fallback), and — crucially —
// that EVERY document it produces passes IrValidate (the front-end can never emit a structurally invalid IR). Uses
// inline VS-canonical (fully-qualified) source, so no assemblies/resx/live host are needed.
public sealed class IrBuilderTests
{
    // A representative form the designer would emit: component construction, root + field property assignments with
    // a string/number/bool literal, a Point ctor, a Color factory, a static-read color, an enum, a flags enum, a
    // component reference, Controls.Add, and ISupportInitialize brackets around a field.
    private const string RepresentableForm = @"
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
      this.button1.TabIndex = 3;
      this.button1.Enabled = true;
      this.button1.Location = new System.Drawing.Point(12, 40);
      this.button1.ForeColor = System.Drawing.Color.FromArgb(10, 20, 30);
      this.button1.BackColor = System.Drawing.Color.Red;
      this.button1.Anchor = System.Windows.Forms.AnchorStyles.Top | System.Windows.Forms.AnchorStyles.Left;
      this.button1.Dock = System.Windows.Forms.DockStyle.Fill;
      this.grid1.Left = -5;
      this.AcceptButton = this.button1;
      this.Controls.Add(this.button1);
      this.Controls.Add(this.grid1);
      ((System.ComponentModel.ISupportInitialize)(this.grid1)).EndInit();
      this.ResumeLayout(false);
    }
  }
}";

    private static IrDocument BuildOk(string src)
    {
        var doc = DesignerIrBuilder.Build(src);
        Assert.NotNull(doc);
        // The front-end MUST never emit a structurally invalid document, representable or not.
        Assert.Null(IrValidate.Check(doc));
        return doc!;
    }

    [Fact]
    public void RepresentableForm_FullCoverage_AndValidates()
    {
        var doc = BuildOk(RepresentableForm);
        Assert.Equal("Demo.MyForm", doc.DesignedTypeName);
        Assert.Equal("System.Windows.Forms.Form", doc.BaseTypeSyntaxName);
        Assert.True(doc.FullCoverage, "expected full coverage; gaps: " + string.Join(" | ", doc.UnrepresentableReasons));
        Assert.Empty(doc.UnrepresentableReasons);
    }

    [Fact]
    public void Construction_EmitsConstructComponent()
    {
        var doc = BuildOk(RepresentableForm);
        var ctors = doc.Statements.OfType<IrConstructComponent>().ToList();
        Assert.Contains(ctors, c => c.Name == "button1" && c.TypeName == "System.Windows.Forms.Button");
        Assert.Contains(ctors, c => c.Name == "grid1" && c.TypeName == "System.Windows.Forms.DataGridView");
        Assert.All(ctors, c => Assert.False(c.WithComponentsContainer));
    }

    [Fact]
    public void PropertyValues_ClassifyToClosedIrShapes()
    {
        var doc = BuildOk(RepresentableForm);
        var sets = doc.Statements.OfType<IrSetProperty>().ToList();

        IrValue ValueOf(string field, string prop) =>
            sets.Single(s => s.TargetName == field && s.PropertyPath.Count == 1 && s.PropertyPath[0] == prop).Value;

        Assert.Equal("Click me", Assert.IsType<IrString>(ValueOf("button1", "Text")).Value);
        Assert.Equal("3", Assert.IsType<IrNumber>(ValueOf("button1", "TabIndex")).InvariantText);
        Assert.True(Assert.IsType<IrBool>(ValueOf("button1", "Enabled")).Value);

        var pt = Assert.IsType<IrKnownCtor>(ValueOf("button1", "Location"));
        Assert.Equal("System.Drawing.Point", pt.TypeName);
        Assert.Equal(2, pt.Args.Count);

        var argb = Assert.IsType<IrStaticFactory>(ValueOf("button1", "ForeColor"));
        Assert.Equal("System.Drawing.Color", argb.TypeName);
        Assert.Equal("FromArgb", argb.Method);
        Assert.Equal(3, argb.Args.Count);

        var red = Assert.IsType<IrStaticRead>(ValueOf("button1", "BackColor"));
        Assert.Equal("System.Drawing.Color", red.TypeName);
        Assert.Equal("Red", red.Member);

        var dock = Assert.IsType<IrEnum>(ValueOf("button1", "Dock"));
        Assert.Equal("System.Windows.Forms.DockStyle", dock.EnumTypeName);
        Assert.Equal(new[] { "Fill" }, dock.Members.ToArray());

        var anchor = Assert.IsType<IrEnum>(ValueOf("button1", "Anchor"));
        Assert.Equal("System.Windows.Forms.AnchorStyles", anchor.EnumTypeName);
        Assert.Equal(new[] { "Top", "Left" }, anchor.Members.ToArray());

        // negative numeric literal keeps its sign in the invariant text
        Assert.Equal("-5", Assert.IsType<IrNumber>(ValueOf("grid1", "Left")).InvariantText);
    }

    [Fact]
    public void ComponentReference_RhsEmitsComponentRef()
    {
        var doc = BuildOk(RepresentableForm);
        // this.AcceptButton = this.button1 — a root property whose value is a component reference.
        var accept = doc.Statements.OfType<IrSetProperty>()
            .Single(s => s.TargetIsRoot && s.PropertyPath.Count == 1 && s.PropertyPath[0] == "AcceptButton");
        var refv = Assert.IsType<IrComponentRef>(accept.Value);
        Assert.False(refv.IsRoot);
        Assert.Equal("button1", refv.Name);
    }

    [Fact]
    public void ControlsAdd_EmitsAddControl_ForEachChild()
    {
        var doc = BuildOk(RepresentableForm);
        var adds = doc.Statements.OfType<IrAddControl>().ToList();
        Assert.Equal(2, adds.Count);
        Assert.All(adds, a => Assert.True(a.ParentIsRoot));
        Assert.Contains(adds, a => a.ChildName == "button1" && a.Column == -1 && a.Row == -1);
        Assert.Contains(adds, a => a.ChildName == "grid1");
    }

    [Fact]
    public void SupportInit_EmitsBeginAndEnd_InSourceOrder()
    {
        var doc = BuildOk(RepresentableForm);
        Assert.Contains(doc.Statements.OfType<IrBeginInit>(), b => b.TargetName == "grid1");
        Assert.Contains(doc.Statements.OfType<IrEndInit>(), e => e.TargetName == "grid1");
        int begin = doc.Statements.FindIndex(s => s is IrBeginInit);
        int end = doc.Statements.FindIndex(s => s is IrEndInit);
        Assert.True(begin >= 0 && end > begin, "BeginInit must precede EndInit in IR order");
    }

    [Fact]
    public void HandEdits_AreHonestCoverageGaps_NotSilentlyRepresented()
    {
        // Two hand-edit shapes the interpreter never emits: a ctor WITH arguments, and an arbitrary method call.
        const string src = @"
namespace Demo {
  partial class HForm : System.Windows.Forms.Form {
    private System.Windows.Forms.Button button1;
    private void InitializeComponent() {
      this.button1 = new System.Windows.Forms.Button(42);
      this.button1.Text = ""ok"";
      System.Diagnostics.Process.Start(""calc"");
    }
  }
}";
        var doc = BuildOk(src);
        Assert.False(doc.FullCoverage);
        Assert.Equal(3, doc.TotalSourceStatements);
        // exactly the one clean property assignment is represented; the ctor-with-args and the Process.Start are gaps.
        Assert.Equal(1, doc.RepresentedStatements);
        Assert.Equal(2, doc.UnrepresentableReasons.Count);
        Assert.DoesNotContain(doc.Statements.OfType<IrConstructComponent>(), c => c.Name == "button1");
    }

    [Fact]
    public void ContainerCtorArg_IsRepresented_AsComponentsContainer()
    {
        const string src = @"
namespace Demo {
  partial class TForm : System.Windows.Forms.Form {
    private System.ComponentModel.IContainer components;
    private System.Windows.Forms.ToolTip toolTip1;
    private void InitializeComponent() {
      this.components = new System.ComponentModel.Container();
      this.toolTip1 = new System.Windows.Forms.ToolTip(this.components);
    }
  }
}";
        var doc = BuildOk(src);
        Assert.True(doc.FullCoverage, "gaps: " + string.Join(" | ", doc.UnrepresentableReasons));
        var tt = doc.Statements.OfType<IrConstructComponent>().Single();
        Assert.Equal("toolTip1", tt.Name);
        Assert.True(tt.WithComponentsContainer);
    }

    [Fact]
    public void MultiElementAddRange_EmitsOneAddPerItem_FullCoverage()
    {
        // menus/toolbars: Items.AddRange(new ToolStripItem[]{a,b,c}) — ONE source statement → N add nodes. This is the
        // coverage that flips common ToolStrip/MenuStrip forms from compiled fallback to interpreted.
        const string src = @"
namespace Demo {
  partial class M : System.Windows.Forms.Form {
    private System.Windows.Forms.MenuStrip menuStrip1;
    private System.Windows.Forms.ToolStripMenuItem fileItem;
    private System.Windows.Forms.ToolStripMenuItem editItem;
    private void InitializeComponent() {
      this.menuStrip1 = new System.Windows.Forms.MenuStrip();
      this.fileItem = new System.Windows.Forms.ToolStripMenuItem();
      this.editItem = new System.Windows.Forms.ToolStripMenuItem();
      this.menuStrip1.Items.AddRange(new System.Windows.Forms.ToolStripItem[] { this.fileItem, this.editItem });
      this.Controls.Add(this.menuStrip1);
    }
  }
}";
        var doc = BuildOk(src);
        Assert.True(doc.FullCoverage, "gaps: " + string.Join(" | ", doc.UnrepresentableReasons));
        var adds = doc.Statements.OfType<IrAddCollectionItem>().ToList();
        Assert.Equal(2, adds.Count); // the single AddRange became two add-item nodes
        Assert.All(adds, a => Assert.Equal("menuStrip1", a.TargetName));
        Assert.All(adds, a => Assert.Equal(new[] { "Items" }, a.PropertyPath.ToArray()));
        Assert.Equal(new[] { "editItem", "fileItem" },
            adds.Select(a => ((IrComponentRef)a.Item).Name).OrderBy(n => n).ToArray());
    }

    [Fact]
    public void NoUniqueFormClass_ReturnsNull_FailClosed()
    {
        // two classes each declaring InitializeComponent → ambiguous → FormClassResolver refuses → Build returns null.
        const string src = @"
namespace Demo {
  partial class A { private void InitializeComponent() { } }
  partial class B { private void InitializeComponent() { } }
}";
        Assert.Null(DesignerIrBuilder.Build(src));
    }

    // ---- FAIL-CLOSED fidelity (independent review) — each risky shape must be a coverage GAP, never a silent wrong
    // render. A minimal form whose InitializeComponent body is exactly `body` (button1 + listView1 available).
    private static IrDocument BuildBody(string body) => BuildOk(@"
namespace Demo {
  partial class F : System.Windows.Forms.Form {
    private System.Windows.Forms.Button button1;
    private System.Windows.Forms.ListView listView1;
    private void InitializeComponent() {
      this.button1 = new System.Windows.Forms.Button();
      this.listView1 = new System.Windows.Forms.ListView();
" + body + @"
    }
  }
}");

    [Fact] // A compound assignment (x.Left += Delta) is NOT inert event wiring
    public void CompoundAssignment_FallsBack() =>
        Assert.False(BuildBody("this.button1.Left = 100; this.button1.Left += 10;").FullCoverage);

    [Fact] // A real delegate-ctor event wiring is still a represented no-op
    public void EventWiring_DelegateCtor_IsRepresented()
    {
        var doc = BuildBody("this.button1.Click += new System.EventHandler(this.OnClick);");
        Assert.True(doc.FullCoverage, string.Join(" | ", doc.UnrepresentableReasons));
        Assert.Contains(doc.Statements, s => s is IrWireEvent);
    }

    [Fact] // Named ctor args reorder vs positional replay
    public void NamedCtorArgs_FallBack() =>
        Assert.False(BuildBody("this.button1.Location = new System.Drawing.Point(y: 20, x: 10);").FullCoverage);

    [Fact] // A multi-arg Add builds ONE composite item, not two
    public void MultiArgAdd_FallsBack() =>
        Assert.False(BuildBody("this.listView1.Items.Add(\"Item1\", \"iconKey\");").FullCoverage);

    [Fact] // A zero-arg Add() is a vendor default-insert we can't model
    public void ZeroArgAdd_FallsBack() =>
        Assert.False(BuildBody("this.listView1.Items.Add();").FullCoverage);

    [Fact] // Hex literals mangle under decimal suffix inference
    public void HexLiteral_FallsBack() =>
        Assert.False(BuildBody("this.button1.TabIndex = 0xFF;").FullCoverage);

    [Fact] // A layout call with a computed (non-bool-literal) arg is not the canonical inert shape
    public void CustomLayoutCall_FallsBack() =>
        Assert.False(BuildBody("this.button1.ResumeLayout(this.button1.Enabled);").FullCoverage);

    [Fact] // A vendor type whose last segment is "TreeNode" is not System.Windows.Forms.TreeNode
    public void VendorTreeNodeType_FallsBack() =>
        Assert.False(BuildBody("Vendor.TreeNode n = new Vendor.TreeNode(\"x\");").FullCoverage);

    // ---- RE-REVIEW regression guards: the fixes above must NOT drop LEGITIMATE VS-canonical shapes to fallback.

    [Fact] // The classic VS Font ctor with a ((byte)(0)) GdiCharSet arg must still INTERPRET (the
    // keyword alias 'byte' resolves to System.Byte; the strict-cast fix must not reject this common shape).
    public void FontCtor_WithByteCharsetCast_Interprets() =>
        Assert.True(BuildBody("this.button1.Font = new System.Drawing.Font(\"Tahoma\", 8.25F, System.Drawing.FontStyle.Regular, System.Drawing.GraphicsUnit.Point, ((byte)(0)));").FullCoverage);

    [Fact] // A keyword-aliased array element (new string[]{...}) must resolve, not degrade/fall back.
    public void KeywordArray_Interprets() =>
        Assert.True(BuildBody("this.button1.Tag = new string[] { \"a\", \"b\" };").FullCoverage);

    [Fact] // Claude re-review — VS emits panel-level layout calls for a populated SplitContainer; the two-hop receiver
    // must stay a represented no-op, not drop the whole form to compiled fallback.
    public void SplitContainerPanelLayout_TwoHop_IsRepresented()
    {
        var doc = BuildOk(@"
namespace Demo {
  partial class F : System.Windows.Forms.Form {
    private System.Windows.Forms.SplitContainer splitContainer1;
    private void InitializeComponent() {
      this.splitContainer1 = new System.Windows.Forms.SplitContainer();
      this.splitContainer1.Panel1.SuspendLayout();
      this.splitContainer1.Panel2.SuspendLayout();
      this.splitContainer1.SuspendLayout();
      this.splitContainer1.Panel1.ResumeLayout(false);
      this.splitContainer1.Panel2.ResumeLayout(false);
      this.splitContainer1.ResumeLayout(false);
      this.Controls.Add(this.splitContainer1);
    }
  }
}");
        Assert.True(doc.FullCoverage, "gaps: " + string.Join(" | ", doc.UnrepresentableReasons));
    }

    [Fact] // A ComponentResourceManager(typeof(OtherForm)) reads a DIFFERENT resource set; its GetString
    // must NOT be served from THIS form's .resx, so it falls back.
    public void ForeignResourceManager_GetString_FallsBack()
    {
        var doc = BuildOk(@"
namespace Demo {
  partial class F : System.Windows.Forms.Form {
    private void InitializeComponent() {
      System.ComponentModel.ComponentResourceManager resources = new System.ComponentModel.ComponentResourceManager(typeof(Demo.OtherForm));
      this.Text = resources.GetString(""$this.Text"");
    }
  }
}");
        Assert.False(doc.FullCoverage);
    }

    [Fact] // The canonical same-form manager still registers, so its GetString is representable (no over-Gap).
    public void SameFormResourceManager_GetString_Representable()
    {
        var doc = BuildOk(@"
namespace Demo {
  partial class F : System.Windows.Forms.Form {
    private void InitializeComponent() {
      System.ComponentModel.ComponentResourceManager resources = new System.ComponentModel.ComponentResourceManager(typeof(F));
      this.Text = resources.GetString(""$this.Text"");
    }
  }
}");
        Assert.True(doc.FullCoverage, "gaps: " + string.Join(" | ", doc.UnrepresentableReasons));
    }
}
