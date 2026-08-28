using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Windows.Forms;
using WinFormsDesigner.Engine;

namespace Engine.UnitTests;

/// <summary>
/// The toolbox palette is reflection-driven, so a framework type that merely looks eligible can slip in. These pin
/// the two failure modes that reflection alone cannot see: offering a type that cannot be constructed on this
/// runtime, and dropping a type that falls between the control and component filters.
/// </summary>
public sealed class ToolboxPaletteTests
{
    private static IReadOnlyList<ToolboxItemInfo> Palette() =>
        DesignerControlEditor.ToolboxItems.Concat(DesignerControlEditor.DiscoverComponents()).ToList();

    /// <summary>
    /// The strong pin: EVERY offered framework item must actually construct on the runtime the engine runs on.
    /// .NET kept a set of .NET Framework types public purely for assembly-load compatibility — DataGrid, ToolBar,
    /// StatusBar, MainMenu, ContextMenu and the DataGrid*Column pair — and their constructors throw
    /// PlatformNotSupportedException. They pass every static gate (public, concrete, parameterless ctor, in the
    /// reference assembly so the generated line even compiles) and carry only [Obsolete], never [ToolboxItem(false)].
    /// Offering one is a trap: `new DataGrid()` throws at interpret time, the control never enters the graph, and
    /// the form renders permanently short a control.
    /// <para/>
    /// Constructing every item is deliberate — an attribute check would re-encode the same assumption the shim
    /// filter makes, and could not catch a type that becomes unconstructible for a different reason.
    /// </summary>
    [Fact]
    public void EveryOfferedToolboxItem_ConstructsOnThisRuntime()
    {
        var broken = new List<string>();
        // On an STA thread, as the engine itself renders (see the sta.Invoke calls in Program.cs). WebBrowser hosts
        // an ActiveX site and throws ThreadStateException on xUnit's default MTA pool thread, which would be a
        // harness artifact rather than a product defect.
        var probe = new Thread(() =>
        {
            // FrameworkOnly items are expected to throw here — that is what the flag records. The host offers them
            // only for a net4x form, where they construct fine on the .NET Framework engine.
            foreach (var item in Palette().Where(i => !i.FromProject && !i.FrameworkOnly))
            {
                var type = ResolvePaletteType(item.Fqn);
                if (type == null) { broken.Add($"{item.Name}: type not found"); continue; }
                try
                {
                    var instance = Activator.CreateInstance(type);
                    (instance as IDisposable)?.Dispose();
                }
                catch (Exception ex)
                {
                    broken.Add($"{item.Name} ({item.Category}): {(ex.InnerException ?? ex).GetType().Name}");
                }
            }
        });
        probe.SetApartmentState(ApartmentState.STA);
        probe.Start();
        Assert.True(probe.Join(TimeSpan.FromMinutes(2)), "toolbox construction probe did not finish");

        Assert.True(broken.Count == 0,
            "the toolbox offers types that cannot be constructed here: " + string.Join(", ", broken));
    }

    /// <summary>
    /// The seven compat shims stay in the palette — they are real, working controls for a <c>net4x</c> form and
    /// Visual Studio offers them there — but each MUST carry the flag, because that flag is the only thing standing
    /// between a modern form and a control whose constructor throws. Named rather than counted so a filter change
    /// that silently untags one fails with the type that regressed.
    /// </summary>
    [Theory]
    [InlineData("DataGrid")]
    [InlineData("ToolBar")]
    [InlineData("StatusBar")]
    [InlineData("MainMenu")]
    [InlineData("ContextMenu")]
    [InlineData("DataGridBoolColumn")]
    [InlineData("DataGridTextBoxColumn")]
    public void BinaryCompatibilityShims_AreOfferedButFlaggedFrameworkOnly(string name)
    {
        var item = Palette().SingleOrDefault(i => string.Equals(i.Name, name, StringComparison.Ordinal));
        Assert.NotNull(item);
        Assert.True(item!.FrameworkOnly, $"{name} must be flagged FrameworkOnly — its ctor throws on modern .NET");
    }

    /// <summary>The flag is not decoration: nothing else in the palette may carry it, or the modern route would
    /// silently lose working controls.</summary>
    [Fact]
    public void OnlyTheKnownShims_AreFlaggedFrameworkOnly()
    {
        string[] expected =
        [
            "ContextMenu", "DataGrid", "DataGridBoolColumn", "DataGridTextBoxColumn", "MainMenu", "StatusBar", "ToolBar",
        ];
        var flagged = Palette().Where(i => i.FrameworkOnly).Select(i => i.Name).OrderBy(n => n, StringComparer.Ordinal);
        Assert.Equal(expected, flagged);
    }

    /// <summary>
    /// ContextMenuStrip used to fall between the two filters: the control path drops ToolStripDropDown-derived
    /// types because they throw if parented, and the component path required "not a Control". It was therefore
    /// impossible to create one, even though the designer already renders and edits context menus. It belongs in
    /// the tray, beside MenuStrip in Visual Studio's Menus &amp; Toolbars tab.
    /// </summary>
    [Fact]
    public void ContextMenuStrip_IsOfferedAsATrayComponent()
    {
        var item = Palette().SingleOrDefault(i => i.Name == "ContextMenuStrip");
        Assert.NotNull(item);
        Assert.True(item!.IsComponent, "ContextMenuStrip must take the AddComponent (tray) path, not Controls.Add");
        Assert.Equal("Menus & Toolbars", item.Category);
    }

    /// <summary>
    /// Closes the reverse direction of the runtime split. The palette is always enumerated from the MODERN
    /// System.Windows.Forms — the net48 engine has no toolbox verb — so a type that exists only on modern .NET would
    /// be offered for a <c>net4x</c> form with nothing to mark it, and the emitted line would not even compile.
    /// <para/>
    /// Today that set is empty: every offered type is also public in the .NET Framework 4.8 reference assembly. This
    /// pins that, so the day it stops being true the build says so and forces the choice — flag the type the way
    /// FrameworkOnly flags the other direction, or leave it out. Building that flag now would be machinery with no
    /// values to put in it.
    /// <para/>
    /// Read straight out of the reference assembly's metadata (PEReader is in the shared framework, so this needs no
    /// package). The 4.8 targeting pack is already required to build <c>engine-net48</c> from source, so a missing
    /// pack is a real environment error rather than a reason to skip.
    /// </summary>
    [Fact]
    public void EveryFrameworkPaletteType_AlsoExistsOnNetFramework48()
    {
        var referenceDirectory = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
            @"Reference Assemblies\Microsoft\Framework\.NETFramework\v4.8");
        Assert.True(Directory.Exists(referenceDirectory),
            $"the .NET Framework 4.8 targeting pack is required to build engine-net48 and is missing: {referenceDirectory}");

        // Every reference assembly, not just System.Windows.Forms: the curated components come from System.dll,
        // System.Data.dll and System.Drawing.dll, and they need the same guarantee.
        var net48 = new HashSet<string>(StringComparer.Ordinal);
        foreach (var dll in Directory.GetFiles(referenceDirectory, "*.dll")) net48.UnionWith(PublicTypeNames(dll));
        // Self-check, so a wrong path or a metadata reader that quietly yields nothing cannot turn this into a test
        // that always passes: Button shipped in 1.0, TaskDialog only arrived in .NET 5.
        Assert.Contains("System.Windows.Forms.Button", net48);
        Assert.DoesNotContain("System.Windows.Forms.TaskDialog", net48);

        var missing = Palette()
            .Where(i => !i.FromProject)
            .Select(i => i.Fqn)
            .Where(fqn => !net48.Contains(fqn))
            .OrderBy(fqn => fqn, StringComparer.Ordinal)
            .ToList();

        Assert.True(missing.Count == 0,
            "the palette offers types that do not exist on .NET Framework 4.8, so a net4x form would be offered a "
            + "control it cannot even compile against — flag or exclude them: " + string.Join(", ", missing));
    }

    /// <summary>Palette entries no longer all live in System.Windows.Forms — the curated Components/Printing/Data
    /// additions come from sibling in-box assemblies. Building the palette already loaded those into this process,
    /// so searching what is loaded resolves them without hard-coding assembly names here.</summary>
    private static Type? ResolvePaletteType(string fqn) =>
        typeof(Control).Assembly.GetType(fqn)
        ?? Type.GetType(fqn)
        ?? AppDomain.CurrentDomain.GetAssemblies().Select(a => a.GetType(fqn)).FirstOrDefault(t => t != null);

    private static HashSet<string> PublicTypeNames(string assemblyPath)
    {
        var names = new HashSet<string>(StringComparer.Ordinal);
        using var stream = File.OpenRead(assemblyPath);
        using var pe = new PEReader(stream);
        // The targeting pack also ships native/resource-only DLLs; they carry no managed metadata.
        if (!pe.HasMetadata) return names;
        var md = pe.GetMetadataReader();
        foreach (var handle in md.TypeDefinitions)
        {
            var type = md.GetTypeDefinition(handle);
            if ((type.Attributes & TypeAttributes.VisibilityMask) != TypeAttributes.Public) continue;
            var ns = md.GetString(type.Namespace);
            var name = md.GetString(type.Name);
            names.Add(string.IsNullOrEmpty(ns) ? name : ns + "." + name);
        }
        return names;
    }

    /// <summary>Its two bases are public and constructible once the tray path admits the family, but Visual Studio
    /// lists only ContextMenuStrip — they are infrastructure, not palette items.</summary>
    [Theory]
    [InlineData("ToolStripDropDown")]
    [InlineData("ToolStripDropDownMenu")]
    public void ToolStripDropDownBases_AreNotOffered(string name)
    {
        Assert.DoesNotContain(Palette(), i => string.Equals(i.Name, name, StringComparison.Ordinal));
    }
}
