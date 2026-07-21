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
}
