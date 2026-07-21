using WinFormsDesigner.Engine;

namespace Engine.UnitTests;

// Pins the per-form render-mode decision + stable fallback reason codes the two-axis host
// contract switches on. No silent partial: every non-full or failed result is a named compiled fallback.
public sealed class RenderModeClassifierTests
{
    private const string FullForm = @"
namespace Demo { partial class F : System.Windows.Forms.Form {
  private System.Windows.Forms.Button b;
  private void InitializeComponent() { this.b = new System.Windows.Forms.Button(); this.b.Text = ""x""; this.Controls.Add(this.b); }
} }";

    [Fact]
    public void FullCoverageForm_IsInterpreted()
    {
        var doc = DesignerIrBuilder.Build(FullForm);
        var d = RenderModeClassifier.FromCoverage(doc);
        Assert.Equal(RenderMode.Interpreted, d.Mode);
        Assert.Null(d.FallbackReason);
    }

    [Fact]
    public void NoUniqueFormClass_FallsBack_NoFormClass()
    {
        var doc = DesignerIrBuilder.Build("namespace D { partial class A { private void InitializeComponent(){} } partial class B { private void InitializeComponent(){} } }");
        var d = RenderModeClassifier.FromCoverage(doc); // doc is null
        Assert.Equal(RenderMode.CompiledFallback, d.Mode);
        Assert.Equal(RenderFallbackReason.NoFormClass, d.FallbackReason);
    }

    [Fact]
    public void ClassWithoutInitializeComponent_IsNotAForm_FallsBack_NoFormClass()
    {
        // The form-identity rule requires a UNIQUE class declaring parameterless InitializeComponent; a class without
        // it is not recognized as a form, so Build returns null → noFormClass (the honest outcome). InitNotFound is a
        // defensive reason kept for a class whose IC exists but has no body — not reachable through the identity rule.
        var doc = DesignerIrBuilder.Build("namespace D { partial class F : System.Windows.Forms.Form { } }");
        var d = RenderModeClassifier.FromCoverage(doc);
        Assert.Equal(RenderMode.CompiledFallback, d.Mode);
        Assert.Equal(RenderFallbackReason.NoFormClass, d.FallbackReason);
    }

    [Fact]
    public void PartialCoverage_FallsBack_UnrepresentableStatements_WithDetail()
    {
        // an arbitrary invocation the front-end can't represent → coverage gap
        var doc = DesignerIrBuilder.Build(@"
namespace D { partial class F : System.Windows.Forms.Form {
  private void InitializeComponent() { System.Diagnostics.Process.Start(""calc""); }
} }");
        var d = RenderModeClassifier.FromCoverage(doc);
        Assert.Equal(RenderMode.CompiledFallback, d.Mode);
        Assert.Equal(RenderFallbackReason.UnrepresentableStatements, d.FallbackReason);
        Assert.False(string.IsNullOrEmpty(d.Detail));
    }

    [Fact]
    public void ExecutorFailure_FallsBack_ExecutorFailure_WithReason()
    {
        var bad = IrExecutionResult.Fail("no property Frobnicate on Button");
        var d = RenderModeClassifier.FromExecution(bad);
        Assert.Equal(RenderMode.CompiledFallback, d.Mode);
        Assert.Equal(RenderFallbackReason.ExecutorFailure, d.FallbackReason);
        Assert.Contains("Frobnicate", d.Detail);
    }
}
