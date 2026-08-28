using WinFormsDesigner.Engine;
using Xunit;

namespace Engine.Net48.UnitTests;

public sealed class SaveSafetyNet48Tests
{
    [Fact]
    public void DropsControls_UsesTheSharedSingleAndAddRangeFailClosedSignals()
    {
        Assert.True(SaveSafety.DropsControls(new[] { "Controls.Add unknown child: this.axControl1" }));
        Assert.True(SaveSafety.DropsControls(new[] { "Controls.AddRange unknown element this.axControl1" }));
        Assert.False(SaveSafety.DropsControls(new[] { "AddRange: unknown element \"list item\"" }));
    }
}
