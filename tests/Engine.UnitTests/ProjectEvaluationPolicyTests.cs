using WinFormsDesigner.Engine;

namespace Engine.UnitTests;

public sealed class ProjectEvaluationPolicyTests
{
    [Theory]
    [InlineData("<PropertyGroup><TargetFramework>net48</TargetFramework></PropertyGroup>", true)]
    [InlineData("<PropertyGroup><TargetFramework>NET472</TargetFramework></PropertyGroup>", true)]
    [InlineData("<PropertyGroup><TargetFrameworkVersion>v4.8</TargetFrameworkVersion></PropertyGroup>", true)]
    [InlineData("<!-- <TargetFramework>net10.0-windows</TargetFramework> --><PropertyGroup><TargetFramework>net48</TargetFramework></PropertyGroup>", true)]
    [InlineData("<PropertyGroup><TargetFrameworks>net48;net10.0-windows</TargetFrameworks></PropertyGroup>", false)]
    [InlineData("<PropertyGroup Condition=\"'$(Configuration)'=='Debug'\"><TargetFramework>net48</TargetFramework></PropertyGroup>", false)]
    [InlineData("<PropertyGroup><TargetFramework Condition=\"'$(Configuration)'=='Debug'\">net48</TargetFramework></PropertyGroup>", false)]
    [InlineData("<PropertyGroup><TargetFramework>$(Framework)</TargetFramework></PropertyGroup>", false)]
    [InlineData("<PropertyGroup><TargetFramework>net10.0-windows</TargetFramework></PropertyGroup>", false)]
    [InlineData("<PropertyGroup><TargetFramework>net48</TargetFramework><TargetFramework>net10.0-windows</TargetFramework></PropertyGroup>", false)]
    [InlineData("<Import Project=\"Directory.Build.props\" />", false)]
    public void FrameworkSkipRequiresOneUnconditionalLiteralDeclaration(string body, bool expected)
    {
        string root = Path.Combine(Path.GetTempPath(), "wfd-eval-policy-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        string project = Path.Combine(root, "Probe.csproj");
        try
        {
            File.WriteAllText(project, "<Project>" + body + "</Project>");
            Assert.Equal(expected, ProjectResolver.IsDeclaredSingleFrameworkProject(project));
        }
        finally { File.Delete(project); Directory.Delete(root); }
    }

    [Theory]
    [InlineData("MSBUILD : error MSB1001: Unknown switch.\nSwitch: -getProperty:TargetPath", "", true)]
    [InlineData("", "MSBUILD : Fehler MSB1001\nSchalter: -getProperty:TargetPath", true)]
    [InlineData("MSB1001: Unknown switch -bad", "", false)]
    [InlineData("MSB1009: project not found", "getProperty", false)]
    public void OnlyNamedUnsupportedSwitchBecomesAnSdkCapabilityFailure(string stdout, string stderr, bool expected) =>
        Assert.Equal(expected, ProjectResolver.IsGetPropertyUnsupported(stdout, stderr));

    [Fact]
    public void UnsupportedSwitchSurvivesNegativeTtlAndProjectEditsButNewSdkRetries()
    {
        var cache = new UnsupportedMSBuildCache();
        long now = DateTime.UtcNow.Ticks;
        int probes = 0;
        string sdk = "7.0.410";
        string? Selected() { probes++; return sdk; }
        Assert.False(cache.ShouldSkip("project", now, Selected));
        Assert.True(cache.Remember("project", sdk, now));
        Assert.False(cache.Remember("PROJECT", sdk, now)); // one named report per project and SDK
        Assert.True(cache.ShouldSkip("project", now + TimeSpan.FromSeconds(9).Ticks, Selected));
        Assert.Equal(0, probes);
        Assert.True(cache.ShouldSkip("project", now + TimeSpan.FromSeconds(11).Ticks, Selected));
        Assert.Equal(1, probes);
        Assert.True(cache.ShouldSkip("project", now + TimeSpan.FromMinutes(2).Ticks, Selected));
        sdk = "10.0.100";
        Assert.False(cache.ShouldSkip("project", now + TimeSpan.FromMinutes(3).Ticks, Selected));
        Assert.False(cache.ShouldSkip("project", now + TimeSpan.FromMinutes(4).Ticks, Selected));
        Assert.False(cache.ShouldSkip("other-project", now, Selected));
        Assert.False(cache.Remember("unknown-sdk", null, now));
    }
}
