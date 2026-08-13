using System.Reflection;
using WinFormsDesigner.Engine;

namespace Engine.UnitTests;

[CollectionDefinition("Modern build-output pinning STA", DisableParallelization = true)]
public sealed class ModernBuildOutputPinningStaCollection { }

/// <summary>
/// The modern engine must never hold the user's build output open. It used to: every load went through
/// AssemblyLoadContext.LoadFromAssemblyPath, which maps the file and keeps an OS handle until the whole context is
/// collected, so an open designer made the user's own build fail with
///   MSB3027 ... The file is locked by: "WinFormsDesigner.Engine"
/// and no command in the product could give it back (the release protocol only ever existed for the net48 engine).
///
/// Every test here asserts the SAME user-visible fact — the file can be replaced and deleted while the engine is
/// still using what it loaded — because that is exactly what MSBuild's Copy task needs to do.
/// </summary>
[Collection("Modern build-output pinning STA")]
public sealed class BuildOutputPinningTests : IDisposable
{
    private static readonly StaDispatcher Sta = new();

    private readonly string _dir = Path.Combine(Path.GetTempPath(), "wfd-pin-" + Guid.NewGuid().ToString("N"));

    public BuildOutputPinningTests() => Directory.CreateDirectory(_dir);

    public void Dispose()
    {
        try { Directory.Delete(_dir, recursive: true); } catch { /* a leftover temp dir must not fail the run */ }
    }

    /// <summary>A private copy of a real assembly, standing in for the user's build output.</summary>
    private string CopyOutput(string fileName)
    {
        string source = typeof(DesignerRenderer).Assembly.Location;
        string target = Path.Combine(_dir, fileName);
        File.Copy(source, target, overwrite: true);
        return target;
    }

    /// <summary>What MSBuild does when it copies a fresh build over the last one: open the destination for writing
    /// with no sharing, then replace it. Returns null on success, else the failure message.</summary>
    private static string? WhyNotOverwritable(string path)
    {
        try
        {
            using (var fs = new FileStream(path, FileMode.Open, FileAccess.ReadWrite, FileShare.None))
            {
                fs.WriteByte(fs.ReadByte() == 0 ? (byte)1 : (byte)0);
            }
            File.Delete(path);
            return null;
        }
        catch (Exception ex) { return ex.GetType().Name + ": " + ex.Message; }
    }

    [Fact]
    public void LoadNoLock_KeepsTheAssemblyUsableWithoutHoldingItsFile()
    {
        string output = CopyOutput("PinnedByLoad.dll");
        var alc = new ControlLoadContext(output);

        Assembly loaded = alc.LoadNoLock(output);

        Assert.NotEmpty(loaded.GetTypes()); // really loaded — the assertion below is not passing by vacuum
        Assert.Equal("", loaded.Location);  // byte-loaded assemblies have no location…
        Assert.Equal(Path.GetFullPath(output), ControlLoadContext.OriginOf(loaded)); // …so the origin is tracked
        Assert.Null(WhyNotOverwritable(output)); // …while the alc is STILL alive and its types still in use
        Assert.NotEmpty(loaded.GetTypes());
    }

    [Fact]
    public void EnumerateProjectControls_DoesNotPinTheProjectOutput()
    {
        // The path that fires for a .NET FRAMEWORK form too: the host asks the MODERN engine for the framework
        // toolbox while the form itself renders on net48, and the engine resolves + loads the project output itself.
        string output = CopyOutput("PinnedByToolbox.dll");

        DesignerRenderer.EnumerateProjectControls(output);

        Assert.Null(WhyNotOverwritable(output));
    }

    [Fact]
    public void ScanAssemblyCandidates_DoesNotPinTheScannedAssembly()
    {
        string output = CopyOutput("PinnedByScan.dll");

        var result = DesignerRenderer.ScanAssemblyCandidates(output, fromProject: true);

        Assert.NotNull(result);
        Assert.Null(WhyNotOverwritable(output));
    }

    [Fact]
    public void Render_WithAControlAssembly_DoesNotPinIt()
    {
        // The heaviest path: LoadGraph loads the resolved output AND every non-shared sibling dll next to it, then
        // builds a live DesignSurface from them. It used to keep every one of those files mapped for the lifetime of
        // the engine process — one leaked context per render.
        string output = CopyOutput("PinnedByRender.dll");
        string designer = Sample("SampleForm.Designer.cs");
        string source = File.ReadAllText(designer);

        var layout = Sta.Invoke(() => DesignerRenderer.RenderWithLayout(designer, output, sourceText: source));

        Assert.NotEmpty(layout.Controls);
        Assert.Null(WhyNotOverwritable(output));
    }

    [Fact]
    public void Render_AfterTheOutputIsReplaced_LoadsTheNewBuild()
    {
        // The other half of the contract: not pinning is only useful if the NEXT render picks the rebuild up. The
        // loaded graph is cached per output, so the cache must key on the file actually changing.
        string output = CopyOutput("RebuiltBetweenRenders.dll");
        string designer = Sample("SampleForm.Designer.cs");
        string source = File.ReadAllText(designer);

        Sta.Invoke(() => DesignerRenderer.RenderWithLayout(designer, output, sourceText: source));
        Assert.Null(WhyNotOverwritable(output)); // "rebuild": the file is replaced (here: deleted) between renders
        File.Copy(typeof(DesignerRenderer).Assembly.Location, output, overwrite: true);

        var after = Sta.Invoke(() => DesignerRenderer.RenderWithLayout(designer, output, sourceText: source));

        Assert.NotEmpty(after.Controls);
        Assert.Null(WhyNotOverwritable(output));
    }

    private static string Sample(string name)
    {
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory != null; directory = directory.Parent)
        {
            var candidate = Path.Combine(directory.FullName, "engine", "samples", name);
            if (File.Exists(candidate)) return candidate;
        }
        throw new FileNotFoundException("sample not found: " + name);
    }
}
