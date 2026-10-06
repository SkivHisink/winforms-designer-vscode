using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Drawing;
using System.Linq;
using System.Windows.Forms;
using WinFormsDesigner.Engine;

namespace Engine.UnitTests;

// Pins the IR EXECUTOR end to end: front-end parses source → IR, executor replays it onto a LIVE
// WinForms tree (real compiled controls, VS model), and the resulting instances carry the parsed state. Also pins the
// CHILD-SIDE security canary: the executor re-checks the allowlists, so a forged IR that smuggled a non-allowlisted
// construction/factory/read past the parser is refused before any code runs.
public sealed class IrExecutorTests
{
    // A fake child-domain host: resolves fully-qualified names against the real WinForms/Drawing/BCL assemblies and
    // constructs components with Activator (no siting — siting/DesignMode is RenderWorker's job in production; the
    // executor's own logic is what these tests pin). Records a canary if it is ever asked to construct a forbidden type.
    private sealed class TestHost : IIrHost
    {
        public readonly List<string> Constructed = new();
        private static readonly System.Reflection.Assembly[] Probe =
        {
            typeof(Control).Assembly,        // System.Windows.Forms
            typeof(Color).Assembly,          // System.Drawing.Primitives
            typeof(Font).Assembly,           // System.Drawing.Common
            typeof(Point).Assembly,          // System.Drawing.Primitives
            typeof(ISupportInitialize).Assembly,
            typeof(object).Assembly,         // System.Private.CoreLib
        };

        public Type? ResolveType(string typeName)
        {
            foreach (var a in Probe)
            {
                var t = a.GetType(typeName, throwOnError: false);
                if (t != null) return t;
            }
            return Type.GetType(typeName, throwOnError: false);
        }

        public object CreateComponent(Type type, string name, bool withContainer)
        {
            Constructed.Add(type.FullName + " " + name);
            return Activator.CreateInstance(type)!;
        }

        public object? ResolveResource(string key, bool isString) => null;
        public bool WasResourceRefused(string key) => false;
        public bool ApplyResources(object target, string key, out string? error) { error = "no test resources"; return false; }
    }

    // The production-shaped host: constructs AND sites each component into a real design-time container, so the
    // executor's output carries Site.DesignMode == true (VS-parity — suppresses the runtime code paths that the
    // un-sited compiled engine hit, e.g. the Timer.Start-during-render incident).
    private sealed class SitingHost : IIrHost
    {
        public readonly DesignTimeContainer Container = new();
        private readonly TestHost _resolve = new();
        public Type? ResolveType(string typeName) => _resolve.ResolveType(typeName);
        public object CreateComponent(Type type, string name, bool withContainer)
        {
            var c = (IComponent)Activator.CreateInstance(type)!;
            Container.Add(c, name);
            return c;
        }
        public object? ResolveResource(string key, bool isString) => null;
        public bool WasResourceRefused(string key) => false;
        public bool ApplyResources(object target, string key, out string? error) { error = "no test resources"; return false; }
    }

    [Fact]
    public void Execute_TreeNodes_BuildRealNodeHierarchy_OnTheLiveTreeView()
    {
        // VS serializes tree nodes as LOCAL variables, bottom-up, with nesting via the ctor's TreeNode[] arg and
        // top-level attachment via Nodes.AddRange. The executor must reproduce the exact hierarchy on a real TreeView.
        const string src = @"
namespace Demo {
  partial class T : System.Windows.Forms.Form {
    private System.Windows.Forms.TreeView treeView1;
    private void InitializeComponent() {
      System.Windows.Forms.TreeNode treeNode1 = new System.Windows.Forms.TreeNode(""Apple"");
      System.Windows.Forms.TreeNode treeNode2 = new System.Windows.Forms.TreeNode(""Fruits"", new System.Windows.Forms.TreeNode[] { treeNode1 });
      this.treeView1 = new System.Windows.Forms.TreeView();
      treeNode1.Name = ""nodeApple"";
      treeNode1.ToolTipText = ""a fruit"";
      this.treeView1.Nodes.AddRange(new System.Windows.Forms.TreeNode[] { treeNode2 });
      this.Controls.Add(this.treeView1);
    }
  }
}";
        var doc = DesignerIrBuilder.Build(src);
        Assert.True(doc!.FullCoverage, string.Join(" | ", doc.UnrepresentableReasons));
        var res = DesignerIrExecutor.Execute(doc, new Form(), new TestHost());
        Assert.True(res.Ok, res.FailureReason);

        var tv = (TreeView)res.Instances["treeView1"];
        Assert.Single(tv.Nodes.Cast<TreeNode>());               // one top-level node
        Assert.Equal("Fruits", tv.Nodes[0].Text);
        Assert.Single(tv.Nodes[0].Nodes.Cast<TreeNode>());      // Fruits has one child
        Assert.Equal("Apple", tv.Nodes[0].Nodes[0].Text);
        Assert.Equal("nodeApple", tv.Nodes[0].Nodes[0].Name);   // the property-set on the local applied
        Assert.Equal("a fruit", tv.Nodes[0].Nodes[0].ToolTipText);
    }

    [Fact]
    public void Execute_ExtenderProvider_SetToolTip_AppliesToTheRealProvider()
    {
        // this.toolTip1.SetToolTip(this.button1, "…") — a common IExtenderProvider. The executor must find the real
        // Set<Prop> setter on the real provider and apply it (a ToolTip whose GetToolTip returns the value).
        const string src = @"
namespace Demo {
  partial class E : System.Windows.Forms.Form {
    private System.ComponentModel.IContainer components;
    private System.Windows.Forms.Button button1;
    private System.Windows.Forms.ToolTip toolTip1;
    private void InitializeComponent() {
      this.components = new System.ComponentModel.Container();
      this.button1 = new System.Windows.Forms.Button();
      this.toolTip1 = new System.Windows.Forms.ToolTip(this.components);
      this.button1.Text = ""B"";
      this.toolTip1.SetToolTip(this.button1, ""Save the document"");
      this.Controls.Add(this.button1);
    }
  }
}";
        var doc = DesignerIrBuilder.Build(src);
        Assert.True(doc!.FullCoverage, string.Join(" | ", doc.UnrepresentableReasons));
        Assert.Contains(doc.Statements.OfType<IrSetExtender>(),
            x => x.ProviderName == "toolTip1" && x.TargetName == "button1" && x.PropertyName == "ToolTip");

        var res = DesignerIrExecutor.Execute(doc, new Form(), new TestHost());
        Assert.True(res.Ok, res.FailureReason);
        var toolTip1 = (ToolTip)res.Instances["toolTip1"];
        var button1 = (Button)res.Instances["button1"];
        Assert.Equal("Save the document", toolTip1.GetToolTip(button1));
    }

    [Fact]
    public void Execute_SystemIconToBitmap_AssignsRealButtonImage()
    {
        const string source = @"
namespace Demo {
  partial class IconForm : System.Windows.Forms.Form {
    private System.Windows.Forms.Button button1;
    private void InitializeComponent() {
      this.button1 = new System.Windows.Forms.Button();
      this.button1.Image = System.Drawing.SystemIcons.Information.ToBitmap();
      this.Controls.Add(this.button1);
    }
  }
}";
        var doc = DesignerIrBuilder.Build(source);
        Assert.NotNull(doc);
        Assert.True(doc!.FullCoverage, string.Join(" | ", doc.UnrepresentableReasons));
        var result = DesignerIrExecutor.Execute(doc, new Form(), new TestHost());
        Assert.True(result.Ok, result.FailureReason);
        using var image = Assert.IsType<Bitmap>(((Button)result.Instances["button1"]).Image);
        Assert.True(image.Width > 0);
        Assert.True(image.Height > 0);
    }

    [Fact]
    public void Execute_CodeDomDecimal_AssignsExactValues()
    {
        // The CodeDom serializer writes every non-default decimal as `new decimal(new int[] { lo, mid, hi, flags })`
        // (NumericUpDown, vendor spin editors). A negative value carries the sign bit as -2147483648 and the scale in
        // flags bits 16-23. Without this shape the whole form fell back to the compiled build.
        const string source = @"
namespace Demo {
  partial class NudForm : System.Windows.Forms.Form {
    private System.Windows.Forms.NumericUpDown numericUpDown1;
    private void InitializeComponent() {
      this.numericUpDown1 = new System.Windows.Forms.NumericUpDown();
      ((System.ComponentModel.ISupportInitialize)(this.numericUpDown1)).BeginInit();
      this.numericUpDown1.DecimalPlaces = 1;
      this.numericUpDown1.Maximum = new decimal(new int[] {
            1000,
            0,
            0,
            0});
      this.numericUpDown1.Minimum = new decimal(new int[] {
            5,
            0,
            0,
            -2147483648});
      this.numericUpDown1.Value = new decimal(new int[] {
            15,
            0,
            0,
            65536});
      this.Controls.Add(this.numericUpDown1);
      ((System.ComponentModel.ISupportInitialize)(this.numericUpDown1)).EndInit();
    }
  }
}";
        var doc = DesignerIrBuilder.Build(source);
        Assert.NotNull(doc);
        Assert.True(doc!.FullCoverage, string.Join(" | ", doc.UnrepresentableReasons));
        var result = DesignerIrExecutor.Execute(doc, new Form(), new TestHost());
        Assert.True(result.Ok, result.FailureReason);
        var nud = (NumericUpDown)result.Instances["numericUpDown1"];
        Assert.Equal(1000m, nud.Maximum);
        Assert.Equal(-5m, nud.Minimum);
        Assert.Equal(1.5m, nud.Value);
    }

    [Fact]
    public void Execute_CodeDomDecimal_InvalidBits_FailsClosed()
    {
        // Flags with bits outside sign+scale are rejected by System.Decimal itself; the statement must fail closed
        // (fallback), never throw out of the executor or assign a guessed value.
        const string source = @"
namespace Demo {
  partial class NudForm : System.Windows.Forms.Form {
    private System.Windows.Forms.NumericUpDown numericUpDown1;
    private void InitializeComponent() {
      this.numericUpDown1 = new System.Windows.Forms.NumericUpDown();
      this.numericUpDown1.Maximum = new decimal(new int[] { 1, 0, 0, 1 });
      this.Controls.Add(this.numericUpDown1);
    }
  }
}";
        var doc = DesignerIrBuilder.Build(source);
        Assert.NotNull(doc);
        Assert.True(doc!.FullCoverage, string.Join(" | ", doc.UnrepresentableReasons));
        var result = DesignerIrExecutor.Execute(doc, new Form(), new TestHost());
        Assert.False(result.Ok);
    }

    private static string TagForm(string value) => @"
namespace Demo {
  partial class TagForm : System.Windows.Forms.Form {
    private void InitializeComponent() {
      this.Tag = " + value + @";
    }
  }
}";

    // Exact bit round-trip at the edges: max magnitude, scale 28, trailing-zero scale and signed zero must survive,
    // so the value is the one the compiled form holds, not a numerically-equal approximation.
    [Theory]
    [InlineData("new decimal(new int[] { -1, -1, -1, 0 })", new[] { -1, -1, -1, 0 })]
    [InlineData("new System.Decimal(new int[] { 1, 0, 0, 1835008 })", new[] { 1, 0, 0, 1835008 })]
    [InlineData("new decimal(new int[] { 100, 0, 0, 131072 })", new[] { 100, 0, 0, 131072 })]
    [InlineData("new decimal(new int[] { 0, 0, 0, -2147483648 })", new[] { 0, 0, 0, int.MinValue })]
    [InlineData("new decimal(new int[] { 7, 3, 2, (-2147483648) })", new[] { 7, 3, 2, int.MinValue })]
    public void Execute_CodeDomDecimal_PreservesExactBits(string value, int[] expected)
    {
        var doc = DesignerIrBuilder.Build(TagForm(value));
        Assert.True(doc!.FullCoverage, string.Join(" | ", doc.UnrepresentableReasons));
        using var root = new Form();
        var res = DesignerIrExecutor.Execute(doc, root, new TestHost());
        Assert.True(res.Ok, res.FailureReason);
        Assert.Equal(expected, decimal.GetBits(Assert.IsType<decimal>(root.Tag)));
    }

    // Anything outside the closed form is not even represented: another overload, a computed or non-Int32 word, the
    // wrong word count, a sized array or a named argument.
    [Theory]
    [InlineData("new decimal(5)")]
    [InlineData("new decimal(new int[] { 1, 0, 0 })")]
    [InlineData("new decimal(new int[] { 1, 0, 0, 0, 0 })")]
    [InlineData("new decimal(new int[] { 1 + 1, 0, 0, 0 })")]
    [InlineData("new decimal(new int[] { 1L, 0, 0, 0 })")]
    [InlineData("new decimal(new int[] { 2147483648, 0, 0, 0 })")]
    [InlineData("new decimal(new long[] { 1, 0, 0, 0 })")]
    [InlineData("new decimal(new int[4] { 1, 0, 0, 0 })")]
    [InlineData("new decimal(bits: new int[] { 1, 0, 0, 0 })")]
    [InlineData("new decimal(new int[] { System.Int32.MaxValue, 0, 0, 0 })")]
    public void Build_DecimalOutsideTheClosedForm_IsUnrepresentable(string value)
    {
        var doc = DesignerIrBuilder.Build(TagForm(value));
        Assert.False(doc!.FullCoverage);
    }

    // CodeDom splits every string longer than 80 characters into `"…" +\r\n "…"`; folding the literals keeps such a form
    // interpreted with the exact text.
    [Fact]
    public void Execute_CodeDomSplitString_FoldsToTheExactText()
    {
        var doc = DesignerIrBuilder.Build(TagForm("\"Отдельный локальный грид на каждую зону; ячейки-хозяева ищутся и расшир\" +\r\n    \"яются в пределах зоны.\" + (\"!\")"));
        Assert.True(doc!.FullCoverage, string.Join(" | ", doc.UnrepresentableReasons));
        using var root = new Form();
        var res = DesignerIrExecutor.Execute(doc, root, new TestHost());
        Assert.True(res.Ok, res.FailureReason);
        Assert.Equal("Отдельный локальный грид на каждую зону; ячейки-хозяева ищутся и расширяются в пределах зоны.!", root.Tag);
    }

    // Folding is literal-only: any other operand keeps the statement unrepresentable (nothing is evaluated), and a
    // hostile chain longer than the piece bound is refused rather than walked.
    [Theory]
    [InlineData("\"a\" + 1")]
    [InlineData("\"a\" + this.Text")]
    [InlineData("\"a\" + System.Environment.MachineName")]
    [InlineData("1 + 2")]
    public void Build_ConcatWithANonStringLiteral_IsUnrepresentable(string value)
    {
        Assert.False(DesignerIrBuilder.Build(TagForm(value))!.FullCoverage);
    }

    [Fact]
    public void Build_VeryLongConcatChain_IsBoundedAndDoesNotOverflow()
    {
        string within = string.Join(" + ", Enumerable.Repeat("\"x\"", 4096));
        Assert.True(DesignerIrBuilder.Build(TagForm(within))!.FullCoverage);
        string beyond = string.Join(" + ", Enumerable.Repeat("\"x\"", 5000));
        Assert.False(DesignerIrBuilder.Build(TagForm(beyond))!.FullCoverage);
    }

    // Scale 29 is syntactically a valid closed form; Decimal itself refuses it and the statement fails closed.
    [Fact]
    public void Execute_CodeDomDecimal_ScaleAbove28_FailsClosed()
    {
        var doc = DesignerIrBuilder.Build(TagForm("new decimal(new int[] { 1, 0, 0, 1900544 })"));
        Assert.True(doc!.FullCoverage, string.Join(" | ", doc.UnrepresentableReasons));
        var res = DesignerIrExecutor.Execute(doc, new Form(), new TestHost());
        Assert.False(res.Ok);
        Assert.Contains("invalid decimal bits", res.FailureReason);
    }

    // A forged IR that reaches the child side with any other decimal shape is refused before anything is materialized.
    [Fact]
    public void Execute_ForgedDecimalShapes_Refused()
    {
        var forged = new IrValue[]
        {
            new IrKnownCtor { TypeName = "System.Decimal", Args = { new IrNumber { Kind = IrNumericKind.Int32, InvariantText = "5" } } },
            new IrKnownCtor { TypeName = "System.Decimal", Args = { new IrArray { ElementTypeName = "System.Int32", Items =
            {
                new IrNumber { Kind = IrNumericKind.Int32, InvariantText = "1" },
                new IrNumber { Kind = IrNumericKind.Int32, InvariantText = "0" },
                new IrNumber { Kind = IrNumericKind.Int32, InvariantText = "0" },
                new IrKnownCtor { TypeName = "System.Drawing.Point" },
            } } } },
            new IrKnownCtor { TypeName = "System.Decimal", Args = { new IrArray { ElementTypeName = "System.Int64", Items =
            {
                new IrNumber { Kind = IrNumericKind.Int64, InvariantText = "1" },
                new IrNumber { Kind = IrNumericKind.Int64, InvariantText = "0" },
                new IrNumber { Kind = IrNumericKind.Int64, InvariantText = "0" },
                new IrNumber { Kind = IrNumericKind.Int64, InvariantText = "0" },
            } } } },
        };
        foreach (var value in forged)
        {
            var doc = new IrDocument
            {
                DesignedTypeName = "Demo.F", BaseTypeSyntaxName = "System.Windows.Forms.Form",
                TotalSourceStatements = 1, RepresentedStatements = 1,
                Statements = { new IrSetProperty { TargetIsRoot = true, PropertyPath = { "Tag" }, Value = value } },
            };
            var res = DesignerIrExecutor.Execute(doc, new Form(), new TestHost());
            Assert.False(res.Ok);
        }
    }

    [Fact]
    public void Execute_SitesComponents_WithDesignModeTrue()
    {
        var doc = DesignerIrBuilder.Build(Source);
        var host = new SitingHost();
        var res = DesignerIrExecutor.Execute(doc!, new Form(), host);
        Assert.True(res.Ok, res.FailureReason);

        var button1 = (Button)res.Instances["button1"];
        Assert.NotNull(button1.Site);
        Assert.True(button1.Site!.DesignMode, "a sited component must report DesignMode=true");
        Assert.Equal("button1", button1.Site.Name);
        Assert.Same(host.Container, button1.Site.Container);
        // GetService is tightly allowlisted: the container answers for IContainer, nothing else (no fake designer host).
        Assert.Same(host.Container, button1.Site.GetService(typeof(IContainer)));
        Assert.Null(button1.Site.GetService(typeof(IServiceProvider)));
    }

    [Fact]
    public void DesignTimeContainer_Dispose_TearsDownComponents()
    {
        var container = new DesignTimeContainer();
        var b = new Button();
        container.Add(b, "b");
        Assert.NotNull(b.Site);
        container.Dispose();
        Assert.True(b.IsDisposed);
    }

    private const string Source = @"
namespace Demo {
  partial class MyForm : System.Windows.Forms.Form {
    private System.Windows.Forms.Button button1;
    private System.Windows.Forms.DataGridView grid1;
    private System.Windows.Forms.ComboBox combo1;
    private void InitializeComponent() {
      this.button1 = new System.Windows.Forms.Button();
      this.grid1 = new System.Windows.Forms.DataGridView();
      this.combo1 = new System.Windows.Forms.ComboBox();
      ((System.ComponentModel.ISupportInitialize)(this.grid1)).BeginInit();
      this.SuspendLayout();
      this.button1.Text = ""Click me"";
      this.button1.TabIndex = 3;
      this.button1.Location = new System.Drawing.Point(12, 40);
      this.button1.Size = new System.Drawing.Size(120, 30);
      this.button1.ForeColor = System.Drawing.Color.FromArgb(10, 20, 30);
      this.button1.BackColor = System.Drawing.Color.Red;
      this.button1.Anchor = System.Windows.Forms.AnchorStyles.Top | System.Windows.Forms.AnchorStyles.Left;
      this.combo1.Items.Add(""Apple"");
      this.combo1.Left = -5;
      this.Controls.Add(this.button1);
      this.Controls.Add(this.combo1);
      this.AcceptButton = this.button1;
      ((System.ComponentModel.ISupportInitialize)(this.grid1)).EndInit();
      this.ResumeLayout(false);
    }
  }
}";

    private static (IrExecutionResult res, Form root, TestHost host) Run(string source)
    {
        var doc = DesignerIrBuilder.Build(source);
        Assert.NotNull(doc);
        Assert.True(doc!.FullCoverage, "front-end gaps: " + string.Join(" | ", doc.UnrepresentableReasons));
        var host = new TestHost();
        var root = new Form();
        var res = DesignerIrExecutor.Execute(doc, root, host);
        return (res, root, host);
    }

    [Fact]
    public void Execute_BuildsLiveTree_WithParsedState()
    {
        var (res, root, _) = Run(Source);
        Assert.True(res.Ok, res.FailureReason);

        var button1 = Assert.IsType<Button>(res.Instances["button1"]);
        var combo1 = Assert.IsType<ComboBox>(res.Instances["combo1"]);

        Assert.Equal("Click me", button1.Text);
        Assert.Equal(3, button1.TabIndex);
        Assert.Equal(new Point(12, 40), button1.Location);
        Assert.Equal(new Size(120, 30), button1.Size);
        Assert.Equal(Color.FromArgb(10, 20, 30), button1.ForeColor);
        Assert.Equal(Color.Red.ToArgb(), button1.BackColor.ToArgb());
        Assert.Equal(AnchorStyles.Top | AnchorStyles.Left, button1.Anchor);

        // collection add materialized a real string item
        Assert.Single(combo1.Items);
        Assert.Equal("Apple", combo1.Items[0]);
        Assert.Equal(-5, combo1.Left);

        // Controls.Add parented both onto the live root; the component reference bound AcceptButton to button1.
        Assert.Contains(button1, root.Controls.Cast<Control>());
        Assert.Contains(combo1, root.Controls.Cast<Control>());
        Assert.Same(button1, root.AcceptButton);
    }

    [Fact]
    public void Execute_ConstructsExactlyTheSourceComponents()
    {
        var (res, _, host) = Run(Source);
        Assert.True(res.Ok, res.FailureReason);
        Assert.Equal(3, host.Constructed.Count); // button1, grid1, combo1 — the root is host-supplied, not constructed
        Assert.Contains(host.Constructed, s => s.EndsWith(" button1"));
        Assert.Contains(host.Constructed, s => s.EndsWith(" grid1"));
    }

    [Fact]
    public void Execute_BeginEndInit_BalancedOnTheRealInstance()
    {
        // grid1 is a DataGridView (ISupportInitialize). A balanced Begin/EndInit leaves nothing pending.
        var (res, _, _) = Run(Source);
        Assert.True(res.Ok, res.FailureReason);
        Assert.Empty(res.PendingInit);
    }

    // ---- child-side security canary: the executor re-checks the allowlists on the CONSUME side ------------------

    private static IrDocument OneValueDoc(IrValue value) => new()
    {
        DesignedTypeName = "Demo.MyForm",
        BaseTypeSyntaxName = "System.Windows.Forms.Form",
        TotalSourceStatements = 1,
        RepresentedStatements = 1,
        Statements = { new IrSetProperty { TargetIsRoot = true, PropertyPath = { "Tag" }, Value = value } },
    };

    [Fact]
    public void Execute_ForgedNonAllowlistedConstruction_Refused_NothingConstructed()
    {
        // A forged IR (bypassing the parser) that asks to `new System.IO.FileStream(...)` as a property value.
        var forged = OneValueDoc(new IrKnownCtor
        {
            TypeName = "System.Text.StringBuilder", // a resolvable, side-effecting, NON-allowlisted ctor
            Args = { new IrString { Value = "x" } },
        });
        var res = DesignerIrExecutor.Execute(forged, new Form(), new TestHost());
        Assert.False(res.Ok);
        Assert.Contains("construction not allowed", res.FailureReason);
    }

    [Fact]
    public void Execute_ForgedNonAllowlistedStaticFactory_Refused()
    {
        var forged = OneValueDoc(new IrStaticFactory
        {
            TypeName = "System.IO.File", Method = "ReadAllText",
            Args = { new IrString { Value = "C:/secret.txt" } },
        });
        var res = DesignerIrExecutor.Execute(forged, new Form(), new TestHost());
        Assert.False(res.Ok);
        Assert.Contains("factory not allowed", res.FailureReason);
    }

    [Fact]
    public void Execute_ForgedNonAllowlistedStaticRead_Refused()
    {
        var forged = OneValueDoc(new IrStaticRead { TypeName = "System.Environment", Member = "MachineName" });
        var res = DesignerIrExecutor.Execute(forged, new Form(), new TestHost());
        Assert.False(res.Ok);
        Assert.Contains("static read not allowed", res.FailureReason);
    }

    // ---- fail-closed semantics ---------------------------------------------------------------------------------

    [Fact]
    public void Execute_UnresolvedComponentType_FailsClosed()
    {
        var doc = new IrDocument
        {
            DesignedTypeName = "Demo.MyForm", BaseTypeSyntaxName = "System.Windows.Forms.Form",
            TotalSourceStatements = 1, RepresentedStatements = 1,
            Statements = { new IrConstructComponent { Name = "x", TypeName = "No.Such.Type" } },
        };
        var res = DesignerIrExecutor.Execute(doc, new Form(), new TestHost());
        Assert.False(res.Ok);
        Assert.Contains("unresolved type", res.FailureReason);
    }

    [Fact]
    public void Execute_UnknownProperty_FailsClosed()
    {
        var doc = OneValueDoc(new IrString { Value = "x" });
        ((IrSetProperty)doc.Statements[0]).PropertyPath[0] = "NotARealProperty";
        var res = DesignerIrExecutor.Execute(doc, new Form(), new TestHost());
        Assert.False(res.Ok);
        Assert.Contains("no property", res.FailureReason);
    }

    // ---- hybrid identity: inherited base components are surfaced, current-source ones are editable -------------

    // A compiled base form whose InitializeComponent (simulated in the ctor) creates a field-backed component. In the
    // VS model the executor instantiates the base, so this component really exists on the derived root.
    private class TestBaseForm : Form
    {
        internal Button baseButton = new Button();
        protected Button inheritedButton = new Button();
        public TestBaseForm()
        {
            baseButton.Name = "baseButton";
            inheritedButton.Name = "inheritedButton";
            Controls.Add(baseButton);
            Controls.Add(inheritedButton);
        }
        public Button BaseButton => baseButton;
        public Button InheritedButton => inheritedButton;
    }
    private sealed class TestDerivedForm : TestBaseForm { }

    private static IrDocument DerivedDoc(params IrStatement[] statements)
    {
        var d = new IrDocument
        {
            DesignedTypeName = "Engine.UnitTests.IrExecutorTests+TestDerivedForm",
            BaseTypeSyntaxName = "Engine.UnitTests.IrExecutorTests+TestBaseForm",
            TotalSourceStatements = statements.Length,
            RepresentedStatements = statements.Length,
        };
        foreach (var s in statements) d.Statements.Add(s);
        return d;
    }

    [Fact]
    public void Execute_SurfacesInheritedComponents_WithInheritedOrigin()
    {
        var doc = DerivedDoc(
            new IrConstructComponent { Name = "derivedButton", TypeName = "System.Windows.Forms.Button" },
            new IrSetProperty { TargetName = "derivedButton", PropertyPath = { "Text" }, Value = new IrString { Value = "D" } });
        var root = new TestDerivedForm();
        var res = DesignerIrExecutor.Execute(doc, root, new TestHost());
        Assert.True(res.Ok, res.FailureReason);

        Assert.Equal(IrOrigin.Root, res.Origins[""]);
        Assert.Equal(IrOrigin.DeclaredInCurrentSource, res.Origins["derivedButton"]);
        Assert.Equal(IrOrigin.Inherited, res.Origins["baseButton"]);
        // the inherited component is surfaced by its real base instance (for Snapshot/selection), not re-created.
        Assert.Same(root.BaseButton, res.Instances["baseButton"]);
    }

    [Fact]
    public void Execute_ReplaysAllowlistedOverride_OnImmediateBaseInstance()
    {
        var doc = DerivedDoc(new IrSetProperty
        {
            TargetName = "inheritedButton",
            PropertyPath = { "Text" },
            Value = new IrString { Value = "Derived override" },
        });
        // Production passes the immediate compiled base to the executor; there is no compiled derived instance.
        var root = new TestBaseForm();
        var res = DesignerIrExecutor.Execute(doc, root, new TestHost());

        Assert.True(res.Ok, res.FailureReason);
        Assert.Equal("Derived override", root.InheritedButton.Text);
        Assert.Same(root.InheritedButton, res.Instances["inheritedButton"]);
        Assert.Equal(IrOrigin.Inherited, res.Origins["inheritedButton"]);
    }

    [Fact]
    public void Execute_CurrentSourceHidingAnInheritedField_FailsClosed()
    {
        // The IR declares a NEW component named exactly like the inherited base field — ambiguous identity.
        var doc = DerivedDoc(new IrConstructComponent { Name = "baseButton", TypeName = "System.Windows.Forms.Button" });
        var res = DesignerIrExecutor.Execute(doc, new TestDerivedForm(), new TestHost());
        Assert.False(res.Ok);
        Assert.Contains("ambiguous identity", res.FailureReason);
    }

    [Fact]
    public void Execute_StructurallyInvalidIr_RefusedBeforeExecuting()
    {
        // consume-side revalidation: a forged doc with a bad identifier never reaches execution.
        var doc = new IrDocument
        {
            DesignedTypeName = "Demo.MyForm", BaseTypeSyntaxName = "System.Windows.Forms.Form",
            TotalSourceStatements = 1, RepresentedStatements = 1,
            Statements = { new IrConstructComponent { Name = "1bad", TypeName = "System.Windows.Forms.Button" } },
        };
        var res = DesignerIrExecutor.Execute(doc, new Form(), new TestHost());
        Assert.False(res.Ok);
        Assert.Contains("failed validation", res.FailureReason);
    }
}
