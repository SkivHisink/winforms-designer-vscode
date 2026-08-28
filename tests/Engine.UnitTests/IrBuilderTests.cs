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
    public void SystemIconToBitmap_ClassifiesAsClosedAllowlistedFactory()
    {
        var doc = BuildOk(RepresentableForm.Replace(
            "this.button1.Text = \"Click me\";",
            "this.button1.Text = \"Click me\"; this.button1.Image = System.Drawing.SystemIcons.Information.ToBitmap();"));
        Assert.True(doc.FullCoverage, string.Join(" | ", doc.UnrepresentableReasons));
        var image = doc.Statements.OfType<IrSetProperty>().Single(s => s.TargetName == "button1" && s.PropertyPath.Single() == "Image");
        var factory = Assert.IsType<IrStaticFactory>(image.Value);
        Assert.Equal("System.Drawing.SystemIcons", factory.TypeName);
        Assert.Equal("InformationToBitmap", factory.Method);
        Assert.Empty(factory.Args);
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

    [Fact]
    public void SameFormResourceManager_ApplyResources_EmitsClosedCapability()
    {
        var doc = BuildOk(@"
namespace Demo {
  partial class F : System.Windows.Forms.Form {
    private System.Windows.Forms.Button button1;
    private void InitializeComponent() {
      System.ComponentModel.ComponentResourceManager resources = new System.ComponentModel.ComponentResourceManager(typeof(F));
      this.button1 = new System.Windows.Forms.Button();
      resources.ApplyResources(this.button1, ""button1"");
      resources.ApplyResources(this, ""$this"");
    }
  }
}");
        Assert.True(doc.FullCoverage, "gaps: " + string.Join(" | ", doc.UnrepresentableReasons));
        var calls = doc.Statements.OfType<IrApplyResources>().ToList();
        Assert.Equal(2, calls.Count);
        Assert.False(calls[0].TargetIsRoot);
        Assert.Equal("button1", calls[0].TargetName);
        Assert.Equal("button1", calls[0].ResourceKey);
        Assert.True(calls[1].TargetIsRoot);
        Assert.Equal("$this", calls[1].ResourceKey);
    }

    [Theory]
    [InlineData("resources.ApplyResources(this.button1, GetKey());")]
    [InlineData("resources.ApplyResources(this.button1, key: \"button1\");")]
    [InlineData("resources.ApplyResources(this.button1.Text, \"button1\");")]
    public void NonCanonicalApplyResources_IsGap(string statement)
    {
        var doc = BuildOk(@"
namespace Demo {
  partial class F : System.Windows.Forms.Form {
    private System.Windows.Forms.Button button1;
    private void InitializeComponent() {
      System.ComponentModel.ComponentResourceManager resources = new System.ComponentModel.ComponentResourceManager(typeof(F));
      this.button1 = new System.Windows.Forms.Button();
      " + statement + @"
    }
  }
}");
        Assert.False(doc.FullCoverage, "must not represent: " + statement);
    }

    // The shape VS emits for THREE OR MORE flags: left-nested and parenthesized, one operand per line. A collector
    // that only descended through bare binary nodes stopped at the parenthesized left operand and dropped the whole
    // form to fallback — which hit every control anchored on 3+ sides, not just vendor forms.
    [Fact]
    public void NestedParenthesizedFlags_AreOneEnumValue()
    {
        var doc = BuildOk(@"
namespace Demo {
  partial class F : System.Windows.Forms.Form {
    private System.Windows.Forms.Panel panel1;
    private void InitializeComponent() {
      this.panel1 = new System.Windows.Forms.Panel();
      this.panel1.Anchor = ((System.Windows.Forms.AnchorStyles)((((System.Windows.Forms.AnchorStyles.Top | System.Windows.Forms.AnchorStyles.Bottom)
            | System.Windows.Forms.AnchorStyles.Left)
            | System.Windows.Forms.AnchorStyles.Right)));
    }
  }
}");
        Assert.True(doc.FullCoverage, "gaps: " + string.Join(" | ", doc.UnrepresentableReasons));
        var anchor = doc.Statements.OfType<IrSetProperty>().Single(s => s.PropertyPath.Count == 1 && s.PropertyPath[0] == "Anchor");
        var en = Assert.IsType<IrEnum>(anchor.Value is IrCast c ? c.Inner : anchor.Value);
        Assert.Equal("System.Windows.Forms.AnchorStyles", en.EnumTypeName);
        Assert.Equal(new[] { "Top", "Bottom", "Left", "Right" }, en.Members.ToArray());
    }

    // Every DevExpress XtraEditors control brackets its RepositoryItem, not itself:
    // ((ISupportInitialize)(this.textEdit1.Properties)).BeginInit(). The bracket must carry the hop chain so the
    // executor initializes the SUB-OBJECT — dropping the hop would have silently un-bracketed the vendor editor.
    [Fact]
    public void ChainedSupportInitBracket_CarriesTargetPath()
    {
        var doc = BuildOk(@"
namespace Demo {
  partial class F : System.Windows.Forms.Form {
    private Vendor.TextEdit textEdit1;
    private void InitializeComponent() {
      this.textEdit1 = new Vendor.TextEdit();
      ((System.ComponentModel.ISupportInitialize)(this.textEdit1.Properties)).BeginInit();
      ((System.ComponentModel.ISupportInitialize)(this.textEdit1.Properties)).EndInit();
    }
  }
}");
        Assert.True(doc.FullCoverage, "gaps: " + string.Join(" | ", doc.UnrepresentableReasons));
        var begin = doc.Statements.OfType<IrBeginInit>().Single();
        Assert.Equal("textEdit1", begin.TargetName);
        Assert.Equal(new[] { "Properties" }, begin.TargetPath.ToArray());
        var end = doc.Statements.OfType<IrEndInit>().Single();
        Assert.Equal("textEdit1", end.TargetName);
        Assert.Equal(new[] { "Properties" }, end.TargetPath.ToArray());
    }

    // The un-chained bracket keeps its exact previous shape: an EMPTY path, so an executor built before the chain
    // existed and one built after agree on what `((ISupportInitialize)(this.grid1)).BeginInit()` means.
    [Fact]
    public void UnchainedSupportInitBracket_HasEmptyTargetPath()
    {
        var doc = BuildOk(RepresentableForm);
        Assert.Empty(doc.Statements.OfType<IrBeginInit>().Single(b => b.TargetName == "grid1").TargetPath);
        Assert.Empty(doc.Statements.OfType<IrEndInit>().Single(e => e.TargetName == "grid1").TargetPath);
    }

    // The layout bracket is REPLAYED, not dropped: with layout live, assigning the form's ClientSize after an
    // anchored child was added resizes that child, which the compiled form (bracketed) never does.
    [Fact]
    public void LayoutBracket_IsExecutableIr_NotDropped()
    {
        var doc = BuildOk(@"
namespace Demo {
  partial class F : System.Windows.Forms.Form {
    private System.Windows.Forms.SplitContainer splitContainer1;
    private void InitializeComponent() {
      this.splitContainer1 = new System.Windows.Forms.SplitContainer();
      this.SuspendLayout();
      this.splitContainer1.Panel1.SuspendLayout();
      this.splitContainer1.Panel1.ResumeLayout(false);
      this.splitContainer1.PerformLayout();
      this.ResumeLayout(true);
    }
  }
}");
        Assert.True(doc.FullCoverage, "gaps: " + string.Join(" | ", doc.UnrepresentableReasons));
        var calls = doc.Statements.OfType<IrLayoutCall>().ToList();
        Assert.Equal(5, calls.Count);
        Assert.True(calls[0].TargetIsRoot && calls[0].Op == IrLayoutOp.Suspend && calls[0].TargetPath.Count == 0);
        Assert.Equal(new[] { "Panel1" }, calls[1].TargetPath.ToArray());
        Assert.Equal("splitContainer1", calls[1].TargetName);
        Assert.False(calls[1].TargetIsRoot);
        Assert.True(calls[2].Op == IrLayoutOp.Resume && !calls[2].Arg, "ResumeLayout(false) must carry Arg=false");
        Assert.Equal(IrLayoutOp.Perform, calls[3].Op);
        Assert.True(calls[4].Op == IrLayoutOp.Resume && calls[4].Arg, "ResumeLayout(true) must carry Arg=true");
    }

    // `Control.ResumeLayout()` IS `ResumeLayout(true)` — it performs the pending layout. Modeling the absent argument
    // as false would resume WITHOUT laying out, so a later statement in the same replay reads pre-layout geometry
    // the compiled form never had.
    [Fact]
    public void ParameterlessResumeLayout_MeansResumeLayoutTrue()
    {
        var doc = BuildOk(@"
namespace Demo {
  partial class F : System.Windows.Forms.Form {
    private void InitializeComponent() {
      this.ResumeLayout();
    }
  }
}");
        Assert.True(doc.FullCoverage, "gaps: " + string.Join(" | ", doc.UnrepresentableReasons));
        var call = doc.Statements.OfType<IrLayoutCall>().Single();
        Assert.Equal(IrLayoutOp.Resume, call.Op);
        Assert.True(call.Arg, "a parameterless ResumeLayout() must carry Arg=true");
    }

    // Shapes that COMPILE but bind to a different member than the IR models: a generic name, an argument the
    // framework member does not take (so the call binds to a vendor/extension overload), and a named argument.
    // Representing any of them would drop the real call and replay the framework one instead.
    [Theory]
    [InlineData("this.panel1.SuspendLayout(true);")]
    [InlineData("this.panel1.PerformLayout(true);")]
    [InlineData("this.panel1.ResumeLayout(GetFlag());")]
    [InlineData("this.panel1.ResumeLayout(performLayout: false);")]
    [InlineData("this.panel1.SuspendLayout<int>();")]
    [InlineData("((System.ComponentModel.ISupportInitialize)(this.panel1.Properties)).BeginInit(7);")]
    [InlineData("((System.ComponentModel.ISupportInitialize)(this.panel1)).EndInit<int>();")]
    public void MisboundCapabilityShapes_AreGaps(string statement)
    {
        var doc = BuildOk(@"
namespace Demo {
  partial class F : System.Windows.Forms.Form {
    private System.Windows.Forms.Panel panel1;
    private void InitializeComponent() {
      this.panel1 = new System.Windows.Forms.Panel();
      " + statement + @"
    }
  }
}");
        Assert.False(doc.FullCoverage, "must not represent: " + statement);
    }

    // C# binds a hidden (`new`) member through the receiver's STATIC type, but the executor only sees the instance.
    // When a field's declared type is not the type constructed into it, those two can disagree — so the front-end
    // refuses to represent calls and hops whose meaning depends on that binding. (DevExpress's XtraForm really does
    // hide SuspendLayout, so this is not hypothetical.)
    [Theory]
    [InlineData("this.edit1.SuspendLayout();")]
    [InlineData("((System.ComponentModel.ISupportInitialize)(this.edit1.Properties)).BeginInit();")]
    public void CallsOnATypeUncertainField_AreGaps(string statement)
    {
        var doc = BuildOk(@"
namespace Demo {
  partial class F : System.Windows.Forms.Form {
    private Vendor.BaseEdit edit1;
    private void InitializeComponent() {
      this.edit1 = new Vendor.DerivedEdit();
      " + statement + @"
    }
  }
}");
        Assert.False(doc.FullCoverage, "must not represent: " + statement);
    }

    // The hop-free bracket does NOT need type certainty: the cast makes it an interface dispatch, which binds the
    // same member whatever the field's static type is.
    [Fact]
    public void HopFreeBracket_OnATypeUncertainField_StaysRepresentable()
    {
        var doc = BuildOk(@"
namespace Demo {
  partial class F : System.Windows.Forms.Form {
    private Vendor.BaseEdit edit1;
    private void InitializeComponent() {
      this.edit1 = new Vendor.DerivedEdit();
      ((System.ComponentModel.ISupportInitialize)(this.edit1)).BeginInit();
      ((System.ComponentModel.ISupportInitialize)(this.edit1)).EndInit();
    }
  }
}");
        Assert.True(doc.FullCoverage, "gaps: " + string.Join(" | ", doc.UnrepresentableReasons));
        Assert.Empty(doc.Statements.OfType<IrBeginInit>().Single().TargetPath);
    }

    // The interpreted root is an instance of the designed class's BASE, so a layout method the designed class itself
    // declares is not on it at all. Replaying the base's member would run something the build never ran.
    [Fact]
    public void RootLayoutCall_WhenTheDesignedClassDeclaresThatMethod_IsAGap()
    {
        var doc = BuildOk(@"
namespace Demo {
  partial class F : System.Windows.Forms.Form {
    private new void SuspendLayout() { }
    private void InitializeComponent() {
      this.SuspendLayout();
    }
  }
}");
        Assert.False(doc.FullCoverage);
    }

    // Two types can share a simple name. Certainty is decided on the type text AS WRITTEN, so `A.Edit e = new B.Edit()`
    // is uncertain — otherwise C# would bind hidden members through A.Edit while the executor searched B.Edit.
    [Fact]
    public void SameSimpleNameFromDifferentNamespaces_IsNotTypeCertain()
    {
        var doc = BuildOk(@"
namespace Demo {
  partial class F : System.Windows.Forms.Form {
    private A.Edit edit1;
    private void InitializeComponent() {
      this.edit1 = new B.Edit();
      this.edit1.SuspendLayout();
    }
  }
}");
        Assert.False(doc.FullCoverage);
    }

    // The source's arity is carried, not just its meaning: `ResumeLayout()` and `ResumeLayout(bool)` are distinct
    // declarations, and a type that hides one must not be replayed through the other.
    [Fact]
    public void LayoutCall_CarriesWhetherTheSourcePassedAnArgument()
    {
        var doc = BuildOk(@"
namespace Demo {
  partial class F : System.Windows.Forms.Form {
    private void InitializeComponent() {
      this.ResumeLayout();
      this.ResumeLayout(false);
    }
  }
}");
        var calls = doc.Statements.OfType<IrLayoutCall>().ToList();
        Assert.False(calls[0].HasArg);
        Assert.True(calls[0].Arg, "parameterless ResumeLayout() means ResumeLayout(true)");
        Assert.True(calls[1].HasArg);
        Assert.False(calls[1].Arg);
    }

    // A layout call on something that isn't `this` or a field stays a gap — the executor resolves by field name, so
    // representing it would replay it onto the wrong object (or silently swallow a call that changes layout).
    [Fact]
    public void LayoutCall_OnNonFieldReceiver_IsGap()
    {
        var doc = BuildOk(@"
namespace Demo {
  partial class F : System.Windows.Forms.Form {
    private void InitializeComponent() {
      Something.Else.SuspendLayout();
    }
  }
}");
        Assert.False(doc.FullCoverage);
    }

    // A bracket whose target is not rooted in a field (a local, a call result) stays an honest gap — the executor
    // resolves targets by field name only, so representing it would mean replaying it onto the wrong object.
    [Fact]
    public void SupportInitBracket_OnNonFieldTarget_IsGap()
    {
        var doc = BuildOk(@"
namespace Demo {
  partial class F : System.Windows.Forms.Form {
    private void InitializeComponent() {
      ((System.ComponentModel.ISupportInitialize)(Something.Else.Properties)).BeginInit();
    }
  }
}");
        Assert.False(doc.FullCoverage);
    }
}
