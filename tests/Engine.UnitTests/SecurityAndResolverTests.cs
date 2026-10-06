using System.Drawing;
using System.Reflection.PortableExecutable;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using WinFormsDesigner.Engine;

namespace Engine.UnitTests;

public sealed class SecurityAndResolverTests
{
    [Theory]
    [InlineData("button1")]
    [InlineData("_root")]
    [InlineData("MenuItem42")]
    public void IsValidIdentifier_OrdinaryDesignerName_Accepts(string value) =>
        Assert.True(DesignerControlEditor.IsValidIdentifier(value));

    [Theory]
    [InlineData("")]
    [InlineData("1button")]
    [InlineData("class")]
    [InlineData("x;System.Diagnostics.Process.Start(\"calc\")")]
    [InlineData("buttоn1")] // Cyrillic 'о': visually confusable with Latin 'o'.
    [InlineData("@class")]
    public void IsValidIdentifier_UntrustedOrConfusableName_Rejects(string value) =>
        Assert.False(DesignerControlEditor.IsValidIdentifier(value));

    // Pin the SHARED security boundary directly (DesignerAllowlists — compile-linked into both
    // engines), plus assert the DesignerRenderer forwarders still agree so the net10 Eval path can't drift.
    [Fact]
    public void InterpreterAllowlists_KnownPureShapes_Accept()
    {
        Assert.True(DesignerAllowlists.IsConstructionAllowed(typeof(Point)));
        Assert.True(DesignerAllowlists.IsConstructionAllowed(typeof(Padding)));
        Assert.True(DesignerAllowlists.IsFactoryInvocationAllowed(typeof(Color), "FromArgb"));
        Assert.True(DesignerAllowlists.IsFactoryInvocationAllowed(typeof(SystemIcons), "InformationToBitmap"));
        Assert.True(DesignerAllowlists.TryGetSystemIconBitmapMember(typeof(SystemIcons), "InformationToBitmap", out string iconMember));
        Assert.Equal("Information", iconMember);
        Assert.True(DesignerAllowlists.IsStaticReadAllowed(typeof(SystemColors)));
    }

    [Fact]
    public void InterpreterAllowlists_SideEffectingShapes_Reject()
    {
        Assert.False(DesignerAllowlists.IsConstructionAllowed(typeof(FileStream)));
        Assert.False(DesignerAllowlists.IsConstructionAllowed(typeof(Bitmap)));
        Assert.False(DesignerAllowlists.IsConstructionAllowed(typeof(Cursor)));
        // decimal is reachable only through its closed CodeDom bits form, never as a general construction.
        Assert.False(DesignerAllowlists.IsConstructionAllowed(typeof(decimal)));
        Assert.False(DesignerAllowlists.IsConstructionName("System.Decimal"));
        Assert.False(DesignerAllowlists.IsFactoryInvocationAllowed(typeof(MessageBox), "Show"));
        Assert.False(DesignerAllowlists.IsFactoryInvocationAllowed(typeof(Image), "FromFile"));
        Assert.False(DesignerAllowlists.IsStaticReadAllowed(typeof(Environment)));
    }

    private static readonly StaDispatcher Sta = new();

    private static string NumericUpDownForm(string maximum) => $$"""
        namespace Demo
        {
            partial class Form1 : System.Windows.Forms.Form
            {
                private System.Windows.Forms.NumericUpDown numericUpDown1;

                private void InitializeComponent()
                {
                    this.numericUpDown1 = new System.Windows.Forms.NumericUpDown();
                    this.numericUpDown1.Location = new System.Drawing.Point(12, 12);
                    this.numericUpDown1.Maximum = {{maximum}};
                    this.numericUpDown1.Name = "numericUpDown1";
                    this.Controls.Add(this.numericUpDown1);
                }
            }
        }
        """;

    // The modern Eval path resolved `new decimal(...)` by source text, so the keyword alias was an "unresolved type"
    // and every NumericUpDown Maximum/Value silently kept its default.
    [Fact]
    public void ModernEval_CodeDomDecimal_IsRepresented()
    {
        var layout = Sta.Invoke(() => DesignerRenderer.RenderWithLayout("Form1.Designer.cs",
            sourceText: NumericUpDownForm("new decimal(new int[] {\n            1000,\n            0,\n            0,\n            0})")));
        Assert.Empty(layout.Unrepresentable);
    }

    // Resolving keyword aliases must not widen construction: `object` is a keyword too and stays refused, and decimal
    // outside its closed bits form (another overload, a computed word, the wrong word count) stays refused as well.
    [Theory]
    [InlineData("new object()")]
    [InlineData("new decimal(5)")]
    [InlineData("new System.Decimal(1.5)")]
    [InlineData("new decimal(new int[] { 1, 0, 0 })")]
    [InlineData("new decimal(new int[] { 1 + 1, 0, 0, 0 })")]
    [InlineData("new decimal(new int[] { System.Int32.MaxValue, 0, 0, 0 })")]
    public void ModernEval_ConstructionOutsideTheClosedForms_StillGated(string value)
    {
        var layout = Sta.Invoke(() => DesignerRenderer.RenderWithLayout("Form1.Designer.cs",
            sourceText: NumericUpDownForm(value)));
        Assert.Contains(layout.Unrepresentable, u => u.Contains("construction not allowed", StringComparison.Ordinal));
    }

    // CodeDom's split of a long string is folded on the modern path too; a non-literal operand is not evaluated.
    [Fact]
    public void ModernEval_CodeDomSplitString_Folds_NonLiteralOperandRefused()
    {
        var folded = Sta.Invoke(() => DesignerRenderer.RenderWithLayout("Form1.Designer.cs",
            sourceText: NumericUpDownForm("100").Replace("this.numericUpDown1.Name = \"numericUpDown1\";",
                "this.numericUpDown1.Name = \"numericUpDown1\";\n this.Text = \"first half \" +\r\n    \"second half\";")));
        Assert.Empty(folded.Unrepresentable);

        var refused = Sta.Invoke(() => DesignerRenderer.RenderWithLayout("Form1.Designer.cs",
            sourceText: NumericUpDownForm("100").Replace("this.numericUpDown1.Name = \"numericUpDown1\";",
                "this.numericUpDown1.Name = \"numericUpDown1\";\n this.Text = \"a\" + System.Environment.MachineName;")));
        Assert.Contains(refused.Unrepresentable, u => u.Contains("only string literals can be concatenated", StringComparison.Ordinal));
    }

    // Decimal validates the words itself: reserved flag bits are refused, never assigned as a guessed value.
    [Fact]
    public void ModernEval_CodeDomDecimal_InvalidBits_Unrepresentable()
    {
        var layout = Sta.Invoke(() => DesignerRenderer.RenderWithLayout("Form1.Designer.cs",
            sourceText: NumericUpDownForm("new decimal(new int[] { 1, 0, 0, 1 })")));
        Assert.Contains(layout.Unrepresentable, u => u.Contains("invalid decimal bits", StringComparison.Ordinal));
    }

    // The net10 Eval path forwards to the shared sets — pin that the forwarders match, so a future refactor
    // that re-inlines a copy would break here rather than silently forking the RCE-on-open boundary.
    [Fact]
    public void InterpreterAllowlists_RendererForwardersMatchSharedCore()
    {
        Assert.Equal(DesignerAllowlists.IsConstructionAllowed(typeof(Point)), DesignerRenderer.IsConstructionAllowed(typeof(Point)));
        Assert.Equal(DesignerAllowlists.IsConstructionAllowed(typeof(FileStream)), DesignerRenderer.IsConstructionAllowed(typeof(FileStream)));
        Assert.Equal(DesignerAllowlists.IsFactoryInvocationAllowed(typeof(Color), "FromArgb"), DesignerRenderer.IsFactoryInvocationAllowed(typeof(Color), "FromArgb"));
        Assert.Equal(DesignerAllowlists.IsStaticReadAllowed(typeof(SystemColors)), DesignerRenderer.IsStaticReadAllowed(typeof(SystemColors)));
    }

    [Theory]
    [InlineData("net8.0-windows", true)]
    [InlineData("net10.0-windows10.0.19041.0", true)]
    [InlineData("NET9.0-WINDOWS", true)]
    [InlineData("net48", false)]
    [InlineData("netstandard2.0", false)]
    [InlineData("garbage", false)]
    public void NetCoreTfm_RecognizesModernTfms(string tfm, bool expected) =>
        Assert.Equal(expected, ProjectResolver.NetCoreTfm.IsMatch(tfm));

    [Fact]
    public void ChooseTfm_PrefersWindowsThenHighestLoadable()
    {
        Assert.Equal("net9.0-windows", ProjectResolver.ChooseTfm(
            "net48;net10.0;net8.0-windows;net9.0-windows;net11.0-windows", hostMajor: 10));
        Assert.Null(ProjectResolver.ChooseTfm("net48;netstandard2.0;net11.0-windows", hostMajor: 10));
    }

    [Fact]
    public void ResolveOutputAssembly_IgnoresNewerForeignRidOutput()
    {
        string root = Path.Combine(Path.GetTempPath(), "wfd-rid-resolver-" + Guid.NewGuid().ToString("N"));
        try
        {
            string project = Path.Combine(root, "Probe.csproj");
            string compatible = Path.Combine(root, "bin", "Release", "net10.0-windows", "win-compatible", "Probe.dll");
            string foreign = Path.Combine(root, "bin", "Release", "net10.0-windows", "win-foreign", "Probe.dll");
            Directory.CreateDirectory(Path.GetDirectoryName(compatible)!);
            Directory.CreateDirectory(Path.GetDirectoryName(foreign)!);
            File.WriteAllText(project, "<Project><PropertyGroup><AssemblyName>Probe</AssemblyName></PropertyGroup></Project>");
            File.Copy(typeof(SecurityAndResolverTests).Assembly.Location, compatible);
            File.Copy(compatible, foreign);

            Machine incompatibleMachine = RuntimeInformation.ProcessArchitecture == Architecture.Arm64
                ? Machine.Amd64
                : Machine.Arm64;
            RewritePeMachine(foreign, incompatibleMachine);
            File.SetLastWriteTimeUtc(compatible, DateTime.UtcNow.AddMinutes(-2));
            File.SetLastWriteTimeUtc(foreign, DateTime.UtcNow);

            Assert.Equal(Path.GetFullPath(compatible), ProjectResolver.ResolveOutputAssembly(project));
        }
        finally
        {
            try { if (Directory.Exists(root)) Directory.Delete(root, recursive: true); } catch { }
        }
    }

    [Fact]
    public void ResolveOutputAssembly_AcceptsManagedExeFallback()
    {
        string root = Path.Combine(Path.GetTempPath(), "wfd-managed-exe-resolver-" + Guid.NewGuid().ToString("N"));
        try
        {
            string project = Path.Combine(root, "Probe.csproj");
            string managedExe = Path.Combine(root, "bin", "Release", "net48", "Probe.exe");
            Directory.CreateDirectory(Path.GetDirectoryName(managedExe)!);
            File.WriteAllText(project, "<Project><PropertyGroup><AssemblyName>Probe</AssemblyName></PropertyGroup></Project>");
            File.Copy(typeof(SecurityAndResolverTests).Assembly.Location, managedExe);

            Assert.Equal(Path.GetFullPath(managedExe), ProjectResolver.ResolveOutputAssembly(project));
        }
        finally
        {
            try { if (Directory.Exists(root)) Directory.Delete(root, recursive: true); } catch { }
        }
    }

    [Theory]
    [InlineData(Machine.Amd64, CorFlags.ILOnly, Architecture.X64, true)]
    [InlineData(Machine.Arm64, CorFlags.ILOnly, Architecture.X64, false)]
    [InlineData(Machine.I386, CorFlags.ILOnly, Architecture.X64, true)]
    [InlineData(Machine.I386, CorFlags.ILOnly | CorFlags.Requires32Bit, Architecture.X64, false)]
    [InlineData(Machine.Arm64, CorFlags.ILOnly, Architecture.Arm64, true)]
    [InlineData(Machine.Amd64, CorFlags.ILOnly, Architecture.Arm64, false)]
    public void MachineCompatibility_IsProcessBounded(
        Machine machine, CorFlags flags, Architecture architecture, bool expected) =>
        Assert.Equal(expected, ProjectResolver.IsMachineCompatible(machine, flags, architecture));

    private static void RewritePeMachine(string path, Machine machine)
    {
        using var stream = new FileStream(path, FileMode.Open, FileAccess.ReadWrite, FileShare.None);
        using var reader = new BinaryReader(stream, System.Text.Encoding.UTF8, leaveOpen: true);
        stream.Position = 0x3c;
        int peHeader = reader.ReadInt32();
        stream.Position = peHeader + 4;
        using var writer = new BinaryWriter(stream, System.Text.Encoding.UTF8, leaveOpen: true);
        writer.Write((ushort)machine);
        writer.Flush();
    }
}
