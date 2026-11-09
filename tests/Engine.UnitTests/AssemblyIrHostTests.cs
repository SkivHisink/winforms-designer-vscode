using System.ComponentModel;
using System.Drawing;
using System.Reflection;
using System.Windows.Forms;
using WinFormsDesigner.Engine;

namespace Engine.UnitTests;

// Ties the production host together: AssemblyIrHost resolves types, SITES components (DesignMode=true),
// and resolves resources through the SAFE resolver. Proves a resx STRING is served and a BINARY resource forces a
// fail-closed compiled fallback (BinaryFormatter is never invoked).
public sealed class AssemblyIrHostTests
{
    private static readonly Assembly[] Probe =
    {
        typeof(Control).Assembly, typeof(Color).Assembly, typeof(Font).Assembly, typeof(Point).Assembly,
        typeof(ISupportInitialize).Assembly, typeof(object).Assembly,
    };

    private const string StringResxForm = @"
namespace Demo {
  partial class F : System.Windows.Forms.Form {
    private System.Windows.Forms.Button button1;
    private void InitializeComponent() {
      System.ComponentModel.ComponentResourceManager resources = new System.ComponentModel.ComponentResourceManager(typeof(F));
      this.button1 = new System.Windows.Forms.Button();
      this.button1.Text = resources.GetString(""greeting"");
      this.Controls.Add(this.button1);
    }
  }
}";

    private const string BinaryResxForm = @"
namespace Demo {
  partial class F : System.Windows.Forms.Form {
    private System.Windows.Forms.Button button1;
    private void InitializeComponent() {
      System.ComponentModel.ComponentResourceManager resources = new System.ComponentModel.ComponentResourceManager(typeof(F));
      this.button1 = new System.Windows.Forms.Button();
      this.button1.BackgroundImage = ((System.Drawing.Image)(resources.GetObject(""bigBlob"")));
      this.Controls.Add(this.button1);
    }
  }
}";

    private const string Resx = @"<root>
  <data name='greeting' xml:space='preserve'><value>Hello</value></data>
  <data name='bigBlob' mimetype='application/x-microsoft.net.object.binary.base64'><value>AAEAAAD/////</value></data>
</root>";

    private static AssemblyIrHost Host() => new(Probe, new DesignTimeContainer(), SafeResxResolver.Parse(Resx));
    private static AssemblyIrHost Host(string neutral, string? culture = null) => new(Probe, new DesignTimeContainer(), SafeResxResolver.Parse(neutral, culture));

    [Fact]
    public void SafeResxString_IsResolved_AndComponentIsSited()
    {
        var doc = DesignerIrBuilder.Build(StringResxForm);
        Assert.True(doc!.FullCoverage, string.Join(" | ", doc.UnrepresentableReasons));
        var res = DesignerIrExecutor.Execute(doc, new Form(), Host());
        Assert.True(res.Ok, res.FailureReason);

        var button1 = (Button)res.Instances["button1"];
        Assert.Equal("Hello", button1.Text);
        Assert.NotNull(button1.Site);
        Assert.True(button1.Site!.DesignMode); // AssemblyIrHost sited it
    }

    [Fact]
    public void BinaryResource_FailsClosed_ToCompiledFallback()
    {
        var doc = DesignerIrBuilder.Build(BinaryResxForm);
        Assert.True(doc!.FullCoverage, string.Join(" | ", doc.UnrepresentableReasons));
        var res = DesignerIrExecutor.Execute(doc, new Form(), Host());
        Assert.False(res.Ok); // the binary node is REFUSED by the safe resolver → executor fails closed
        var mode = RenderModeClassifier.FromExecution(res);
        Assert.Equal(RenderMode.CompiledFallback, mode.Mode);
        // A REFUSED resource carries the precise unsafeBinaryResource reason (not a generic executorFailure), so the
        // host can disclose "unsafe resource" (this assertion previously pinned the wrong reason).
        Assert.Equal(RenderFallbackReason.UnsafeBinaryResource, mode.FallbackReason);
    }

    [Fact]
    public void ResolveType_FindsFrameworkTypes()
    {
        var host = Host();
        Assert.Equal(typeof(Button), host.ResolveType("System.Windows.Forms.Button"));
        Assert.Equal(typeof(Point), host.ResolveType("System.Drawing.Point"));
        Assert.Null(host.ResolveType("No.Such.Type"));
    }

    [Fact] // A type in a loaded assembly OUTSIDE the fixed probe set resolves via the AppDomain scan (the
    // referenced-vendor-assembly case: the control's assembly isn't in the frozen probe list but is loaded).
    public void ResolveType_FindsLoadedTypeOutsideProbeSet()
    {
        // Frozen probe set = corlib ONLY. Button lives in System.Windows.Forms (loaded in this AppDomain, not in the set).
        var host = new AssemblyIrHost(new[] { typeof(object).Assembly }, new DesignTimeContainer(), SafeResxResolver.Parse(""));
        Assert.Equal(typeof(Button), host.ResolveType("System.Windows.Forms.Button"));
        Assert.Null(host.ResolveType("No.Such.Vendor.Control"));
    }

    [Fact]
    public void ApplyResources_ReplaysSafeScalarOverlay_AndSitesComponent()
    {
        const string source = @"
namespace Demo {
  partial class F : System.Windows.Forms.Form {
    private System.Windows.Forms.Button button1;
    private void InitializeComponent() {
      System.ComponentModel.ComponentResourceManager resources = new System.ComponentModel.ComponentResourceManager(typeof(F));
      this.button1 = new System.Windows.Forms.Button();
      resources.ApplyResources(this.button1, ""button1"");
      resources.ApplyResources(this, ""$this"");
      this.Controls.Add(this.button1);
    }
  }
}";
        const string neutral = @"<root>
  <data name='button1.Text'><value>Neutral</value></data>
  <data name='button1.Location' type='System.Drawing.Point, System.Drawing'><value>5, 6</value></data>
  <data name='button1.Size' type='System.Drawing.Size, System.Drawing'><value>100, 25</value></data>
  <data name='$this.RightToLeft' type='System.Windows.Forms.RightToLeft, System.Windows.Forms'><value>Yes</value></data>
  <data name='$this.RightToLeftLayout' type='System.Boolean, mscorlib'><value>True</value></data>
</root>";
        const string culture = @"<root>
  <data name='button1.Text'><value>Culture</value></data>
</root>";

        var doc = DesignerIrBuilder.Build(source);
        Assert.True(doc!.FullCoverage, string.Join(" | ", doc.UnrepresentableReasons));
        var root = new Form();
        var res = DesignerIrExecutor.Execute(doc, root, Host(neutral, culture));
        Assert.True(res.Ok, res.FailureReason);

        var button1 = (Button)res.Instances["button1"];
        Assert.Equal("Culture", button1.Text);
        Assert.Equal(new Point(5, 6), button1.Location);
        Assert.Equal(new Size(100, 25), button1.Size);
        Assert.Equal(RightToLeft.Yes, root.RightToLeft);
        Assert.True(root.RightToLeftLayout);
        Assert.NotNull(button1.Site);
    }

    [Fact]
    public void ApplyResources_RefusedMatchingNode_FailsClosed()
    {
        const string source = @"
namespace Demo {
  partial class F : System.Windows.Forms.Form {
    private System.Windows.Forms.Button button1;
    private void InitializeComponent() {
      System.ComponentModel.ComponentResourceManager resources = new System.ComponentModel.ComponentResourceManager(typeof(F));
      this.button1 = new System.Windows.Forms.Button();
      resources.ApplyResources(this.button1, ""button1"");
    }
  }
}";
        const string resx = @"<root>
  <data name='button1.BackgroundImage' mimetype='application/x-microsoft.net.object.binary.base64'><value>AAEAAAD/////</value></data>
</root>";

        var doc = DesignerIrBuilder.Build(source);
        Assert.True(doc!.FullCoverage, string.Join(" | ", doc.UnrepresentableReasons));
        var res = DesignerIrExecutor.Execute(doc, new Form(), Host(resx));
        Assert.False(res.Ok);
        Assert.Contains("UNSAFE_RESOURCE", res.FailureReason);
    }

    [Theory]
    // GetObject is an object: a property of another type takes it only through a cast
    [InlineData("this.ImeMode = resources.GetObject(\"k\");", "without a cast")]
    // a cast of a resource is by type: the compiled form throws for these
    [InlineData("this.Tag = (long)resources.GetObject(\"keys\");", "does not hold")]
    [InlineData("this.Tag = (string)resources.GetObject(\"keys\");", "does not hold")]
    [InlineData("this.Font = (System.Drawing.Font)resources.GetString(\"missing\");", "does not convert")]
    // a cast to object keeps the operand an object: the outer cast is by type too
    [InlineData("this.Tag = (long)(object)resources.GetObject(\"n\");", "does not hold")]
    [InlineData("this.Tag = (string)(object)resources.GetObject(\"n\");", "does not hold")]
    // GetString of an entry of another type throws in the compiled form
    [InlineData("this.Text = resources.GetString(\"k\");", "not a readable string")]
    public void AResourceTheCompiledFormCannotRead_FailsTheSharedExecution(string statement, string reason)
    {
        string source = @"
namespace Demo {
  partial class F : System.Windows.Forms.Form {
    private void InitializeComponent() {
      System.ComponentModel.ComponentResourceManager resources = new System.ComponentModel.ComponentResourceManager(typeof(F));
      STATEMENT
    }
  }
}".Replace("STATEMENT", statement);
        const string resx = @"<root>
  <data name='k' type='System.Windows.Forms.ImeMode, System.Windows.Forms'><value>Hiragana</value></data>
  <data name='keys' type='System.Windows.Forms.Keys, System.Windows.Forms'><value>Ctrl+A</value></data>
  <data name='n' type='System.Int32, mscorlib'><value>3</value></data>
</root>";

        var doc = DesignerIrBuilder.Build(source);
        Assert.NotNull(doc);
        if (!doc!.FullCoverage) return; // refused by the front end is refused too
        var res = DesignerIrExecutor.Execute(doc, new Form(), Host(resx));
        Assert.False(res.Ok, statement);
        Assert.Contains(reason, res.FailureReason);
    }

    [Fact]
    public void AResourceCast_ConvertsANumberOfAKnownType_AndGetStringOfAMissingKeyIsNull()
    {
        const string source = @"
namespace Demo {
  partial class F : System.Windows.Forms.Form {
    private void InitializeComponent() {
      System.ComponentModel.ComponentResourceManager resources = new System.ComponentModel.ComponentResourceManager(typeof(F));
      this.Tag = (long)(int)resources.GetObject(""n"");
      this.Width = (int)(double)resources.GetObject(""d"");
      this.Height = (int)(decimal)resources.GetObject(""m"");
      this.Text = resources.GetString(""absent"");
    }
  }
}";
        var doc = DesignerIrBuilder.Build(source);
        Assert.True(doc!.FullCoverage, string.Join(" | ", doc.UnrepresentableReasons));
        var form = new Form { Text = "Before" };
        var res = DesignerIrExecutor.Execute(doc, form, Host("<root><data name='n' type='System.Int32, mscorlib'><value>3</value></data>"
            + "<data name='d' type='System.Double, mscorlib'><value>300.6</value></data>"
            + "<data name='m' type='System.Decimal, mscorlib'><value>200.6</value></data></root>"));

        Assert.True(res.Ok, res.FailureReason);
        Assert.Equal(3L, form.Tag);
        // a floating or decimal value cast to an integer is truncated, as C# does
        Assert.Equal(300, form.Width);
        Assert.Equal(200, form.Height);
        Assert.Equal("", form.Text);
    }

    [Fact]
    public void ACultureWithoutTheNeutralResx_ServesItsOwnKeys_AndNoOther()
    {
        const string source = @"
namespace Demo {
  partial class F : System.Windows.Forms.Form {
    private void InitializeComponent() {
      System.ComponentModel.ComponentResourceManager resources = new System.ComponentModel.ComponentResourceManager(typeof(F));
      this.Text = resources.GetString(""KEY"");
    }
  }
}";
        var cultureOnly = SafeResxResolver.ParseChain(new[] { null, "<root><data name='existing'><value>localized</value></data></root>" }, allowByteArrays: false);
        AssemblyIrHost HostOf() => new(Probe, new DesignTimeContainer(), cultureOnly);

        var existing = DesignerIrBuilder.Build(source.Replace("KEY", "existing"))!;
        var form = new Form();
        Assert.True(DesignerIrExecutor.Execute(existing, form, HostOf()).Ok);
        Assert.Equal("localized", form.Text);

        // ResourceManager ends a lookup in the neutral set: without it, a key no culture holds throws.
        var absent = DesignerIrBuilder.Build(source.Replace("KEY", "absent"))!;
        Assert.False(DesignerIrExecutor.Execute(absent, new Form(), HostOf()).Ok);
    }

    [Theory]
    [InlineData("")]
    [InlineData("<root><data")]
    public void GetString_WithoutAResourceSet_FailsTheSharedExecution(string resx)
    {
        const string source = @"
namespace Demo {
  partial class F : System.Windows.Forms.Form {
    private void InitializeComponent() {
      System.ComponentModel.ComponentResourceManager resources = new System.ComponentModel.ComponentResourceManager(typeof(F));
      this.Text = resources.GetString(""absent"");
    }
  }
}";
        var doc = DesignerIrBuilder.Build(source);
        Assert.True(doc!.FullCoverage, string.Join(" | ", doc.UnrepresentableReasons));
        var res = DesignerIrExecutor.Execute(doc, new Form(), Host(resx));

        Assert.False(res.Ok);
        Assert.Contains("no resource set", res.FailureReason);
    }

    [Fact]
    public void ApplyResources_WithoutResources_FailsTheSharedExecution()
    {
        const string source = @"
namespace Demo {
  partial class F : System.Windows.Forms.Form {
    private void InitializeComponent() {
      System.ComponentModel.ComponentResourceManager resources = new System.ComponentModel.ComponentResourceManager(typeof(F));
      resources.ApplyResources(this, ""$this"");
    }
  }
}";
        var doc = DesignerIrBuilder.Build(source);
        Assert.True(doc!.FullCoverage, string.Join(" | ", doc.UnrepresentableReasons));

        var none = DesignerIrExecutor.Execute(doc, new Form(), Host(""));
        Assert.False(none.Ok);
        Assert.Contains("has no .resx", none.FailureReason);
        var broken = DesignerIrExecutor.Execute(doc, new Form(), Host("<root><data"));
        Assert.False(broken.Ok);
        Assert.Contains("not well formed", broken.FailureReason);
    }

    [Theory]
    [InlineData("resources.ApplyResources(objectName: this, value: \"$this\");")]
    [InlineData("this.Tag = System.Windows.Forms.AnchorStyles.Top<int>;")]
    [InlineData("this.Location = new System.Drawing.Point(1, 2) { X = 99 };")]
    public void SyntaxNoPathReplays_IsAGapOfTheSharedFrontEnd(string statement)
    {
        string source = @"
namespace Demo {
  partial class F : System.Windows.Forms.Form {
    private void InitializeComponent() {
      System.ComponentModel.ComponentResourceManager resources = new System.ComponentModel.ComponentResourceManager(typeof(F));
      STATEMENT
    }
  }
}".Replace("STATEMENT", statement);
        var doc = DesignerIrBuilder.Build(source);

        Assert.False(doc!.FullCoverage);
        Assert.Contains(doc.UnrepresentableReasons, r => r.StartsWith(statement, StringComparison.Ordinal));
    }
}
