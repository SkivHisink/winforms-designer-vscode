using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using WinFormsDesigner.Engine;
using Xunit;

namespace Engine.UnitTests;

// The serving engine confines itself to a kill-on-close job before it accepts work, so the MSBuild evaluation and the
// UITypeEditor worker it starts cannot outlive a recycled or crashed engine.
public sealed class EngineProcessJobTests
{
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);

    [Fact]
    public async Task ServingEngine_ConfinesItselfBeforeListening()
    {
        string exe = Path.ChangeExtension(typeof(EngineProcessJob).Assembly.Location, ".exe");
        Assert.True(File.Exists(exe), "Expected the engine apphost at " + exe);
        using var engine = Process.Start(new ProcessStartInfo
        {
            FileName = exe,
            ArgumentList = { "--pipe", "wfd-job-test-" + Guid.NewGuid().ToString("N") },
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardError = true,
            RedirectStandardOutput = true,
        })!;
        try
        {
            string? first = await engine.StandardError.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(30));
            string? second = await engine.StandardError.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(30));
            Assert.Equal("[engine] helper processes are confined to the engine's lifetime", first);
            Assert.StartsWith("[engine] listening on pipe: ", second);
            Assert.True(IsProcessInJob(engine.Handle, IntPtr.Zero, out bool inJob));
            Assert.True(inJob);
        }
        finally
        {
            try { engine.Kill(true); } catch { }
            await engine.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10));
        }
    }

    [Fact]
    public void EditPathWarmup_SourceIsAValidSafeEdit()
    {
        // The warmup is only worth its CPU if it runs the whole edit path, not an early refusal.
        var result = DesignerRenderer.ApplyPropertyEdit("WarmupForm.Designer.cs", "button1", "Text", "\"warm\"", EditPathWarmup.Source);
        Assert.True(result.Safe, result.Reason);
        Assert.Contains("this.button1.Text = \"warm\";", result.NewText);
    }

    [Fact]
    public void CommandLineModes_StillStartHelpers()
    {
        // The test host never called ConfineServingEngine: it behaves like the CLI, which is not owned by the extension.
        Assert.True(EngineProcessJob.HelpersAllowed);
    }
}
