using System;
using System.IO;
using System.Linq;
using WinFormsDesigner.Engine;

namespace Engine.UnitTests;

// The M6 fallback-rate gate, pinned in CI against the feature-surface sample corpus. Source coverage — does the closed
// IR fully represent InitializeComponent? — is the dominant, engine-agnostic driver of the interpreted-vs-fallback
// decision, so a regression that drops a construct out of the IR (raising the fallback rate) is caught here. The floor
// is set below the current rate so adding one deliberately-fail-closed fixture doesn't break the build; the reusable
// CLI `engine --coverage-report <dir> --min-rate <pct>` runs the same gate against a real (e.g. DevExpress) corpus.
public sealed class CoverageGateTests
{
    private static string FindSamplesDir()
    {
        for (var d = new DirectoryInfo(AppContext.BaseDirectory); d != null; d = d.Parent)
        {
            var p = Path.Combine(d.FullName, "engine", "samples");
            if (Directory.Exists(p)) return p;
        }
        throw new DirectoryNotFoundException("engine/samples not found from " + AppContext.BaseDirectory);
    }

    [Fact]
    public void SampleCorpus_SourceCoverageRate_MeetsFloor()
    {
        var dir = FindSamplesDir();
        var files = Directory.EnumerateFiles(dir, "*.Designer.cs", SearchOption.AllDirectories).ToList();
        Assert.True(files.Count >= 20, "expected the sample corpus, found " + files.Count + " in " + dir);

        int interp = 0;
        var fellBack = new System.Collections.Generic.List<string>();
        foreach (var f in files)
        {
            var decision = RenderModeClassifier.FromCoverage(DesignerIrBuilder.Build(File.ReadAllText(f)));
            if (decision.Mode == RenderMode.Interpreted) interp++;
            else fellBack.Add(Path.GetFileName(f) + " (" + decision.FallbackReason + ")");
        }
        double rate = 100.0 * interp / files.Count;
        Assert.True(rate >= 80.0,
            $"source-coverage interpreted rate {rate:F1}% < floor 80% ({interp}/{files.Count}); fallbacks: {string.Join(", ", fellBack)}");
    }
}
