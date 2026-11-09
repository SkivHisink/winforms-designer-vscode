using System.ComponentModel;
using System.Reflection;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using WinFormsDesigner.Engine;
using Xunit.Abstractions;

namespace Engine.UnitTests;

/// <summary>
/// The evaluation paths that are not constant folding — constructions, factory calls, casts of boxed values, arrays —
/// compiled by the C# compiler and run, then interpreted. A statement the compiler rejects, or whose compiled form
/// throws, is unrepresentable; one that runs gives its property the compiled value, or is refused. It is never given
/// another value.
/// </summary>
[Collection("Modern localization designer STA")]
public sealed class NonConstantCorpusTests
{
    private static readonly StaDispatcher Sta = new();
    private readonly ITestOutputHelper _output;

    public NonConstantCorpusTests(ITestOutputHelper output) => _output = output;

    private static IEnumerable<(string Property, string Statement)> Statements()
    {
        string[] ints = { "12", "(object)12", "(int)(object)12", "(int?)12", "(long)12", "12L", "(short)12", "'A'", "12.0",
            "(byte)12", "(int)(object)12L", "(sbyte)-1", "unchecked((int)4294967295)", "null", "(int)(object)null", "default",
            "System.DayOfWeek.Monday", "(int)System.DayOfWeek.Monday" };
        foreach (string a in ints)
        {
            yield return ("Location", "this.textBox1.Location = new System.Drawing.Point(" + a + ", 3);");
            yield return ("BackColor", "this.textBox1.BackColor = System.Drawing.Color.FromArgb(" + a + ", 0, 0);");
            yield return ("Size", "this.textBox1.Size = new System.Drawing.Size(40, " + a + ");");
            yield return ("MaxLength", "this.textBox1.MaxLength = " + a + ";");
        }
        foreach (string k in new[] { "0", "(System.Drawing.KnownColor)7", "System.Drawing.KnownColor.Red", "7", "(object)System.Drawing.KnownColor.Red", "0L", "0.0" })
            yield return ("BackColor", "this.textBox1.BackColor = System.Drawing.Color.FromKnownColor(" + k + ");");
        foreach (string n in new[] { "\"Red\"", "(object)\"Red\"", "(string)null", "null", "\"Re\" + \"d\"" })
            yield return ("BackColor", "this.textBox1.BackColor = System.Drawing.Color.FromName(" + n + ");");
        foreach (string s in new[] { "9F", "9", "9.0", "9m", "(float)9.5", "(object)9F", "(float)(object)9F", "'\\t'" })
            yield return ("Font", "this.textBox1.Font = new System.Drawing.Font(\"Segoe UI\", " + s + ");");
        foreach (string c in new[] { "0", "204", "300", "(byte)204", "204L", "200 + 4", "(object)204", "(byte)(object)(byte)204", "-1" })
            yield return ("Font", "this.textBox1.Font = new System.Drawing.Font(\"Segoe UI\", 9F, System.Drawing.FontStyle.Bold, System.Drawing.GraphicsUnit.Point, " + c + ");");
        foreach (string l in new[] { "2", "2L", "2u", "(byte)2", "2.0", "(object)2", "(int?)2", "-1", "(int)(object)2", "'\\u0003'", "System.DayOfWeek.Monday" })
            yield return ("Text", "this.textBox1.Lines = new string[" + l + "];");
        foreach (string l in new[] { "2", "2L", "(int)(object)2", "3", "1 + 1" })
            yield return ("Text", "this.textBox1.Lines = new string[" + l + "] { \"a\", \"b\" };");
        foreach (string e in new[] { "new[] { \"a\", null }", "new[] { 1 }", "new[] { null }", "new string[] { \"a\", null }", "new string[] { (string)(object)\"a\" }",
            "new string[] { (string)(object)1 }", "new[] { (object)\"a\" }", "new string[] { 'a' + \"b\" }" })
            yield return ("Text", "this.textBox1.Lines = " + e + ";");
        foreach (string t in new[] { "(object)\"a\"", "(string)(object)\"a\"", "(string)(object)2", "null", "(string)null", "'a'", "default", "\"a\" + (object)null",
            "(string)(System.IComparable)\"a\"", "(System.IComparable)\"a\"" })
            yield return ("Text", "this.textBox1.Text = " + t + ";");
        foreach (string a in new[] { "(System.Windows.Forms.AnchorStyles)(object)5", "(System.Windows.Forms.AnchorStyles)(object)5L", "(System.Windows.Forms.AnchorStyles?)(object)5",
            "(System.Windows.Forms.AnchorStyles)(object)System.Windows.Forms.AnchorStyles.Top", "0", "0.0", "5", "(object)System.Windows.Forms.AnchorStyles.Top",
            "(System.Windows.Forms.AnchorStyles)(object)System.DayOfWeek.Monday", "(System.Windows.Forms.AnchorStyles)(System.Enum)System.Windows.Forms.AnchorStyles.Left",
            "-((object)2)", "(System.Windows.Forms.AnchorStyles)((object)System.Windows.Forms.AnchorStyles.Top) | System.Windows.Forms.AnchorStyles.Left" })
            yield return ("Anchor", "this.textBox1.Anchor = " + a + ";");
        foreach (string p in new[] { "new System.Drawing.Point(1, 2) { X = 99 }", "new System.Drawing.Point(y: 1, x: 2)", "new System.Drawing.Point(x: 1, y: 2)",
            "new System.Drawing.Point()", "new System.Drawing.Point(new System.Drawing.Size(4, 5))", "new System.Drawing.Point(0x00050004)",
            "(System.Drawing.Point)(object)new System.Drawing.Point(7, 8)", "(System.Drawing.Point)(System.ValueType)new System.Drawing.Point(7, 8)" })
            yield return ("Location", "this.textBox1.Location = " + p + ";");
    }

    [Fact]
    public void EveryStatement_HasTheCompiledValue_OrIsUnrepresentable()
    {
        var cases = Statements().Distinct().ToList();
        var compiled = Compile(cases.Select(c => c.Statement).ToList(), out var compileErrors);

        var failures = new List<string>();
        int agreed = 0, refused = 0, rejected = 0;
        for (int i = 0; i < cases.Count; i++)
        {
            var (property, statement) = cases[i];
            // What the compiled form does: a compile error, an exception, or the property's value.
            string? expected = null;
            string? compiledFailure = compileErrors[i];
            if (compiledFailure == null)
            {
                try { expected = Sta.Invoke(() => CompiledValue(compiled!, i, property)); }
                catch (Exception ex) { compiledFailure = "throws " + (ex is TargetInvocationException t ? t.InnerException?.GetType().Name : ex.GetType().Name); }
            }

            var (unrepresentable, described) = Interpret(statement, property);
            if (compiledFailure != null)
            {
                rejected++;
                if (!unrepresentable) failures.Add(statement + "  —  the compiled form " + compiledFailure + ", the preview takes " + (described ?? "null"));
            }
            else if (unrepresentable)
            {
                refused++;
                _output.WriteLine("  refused: " + statement + "  —  the compiled form has " + (expected ?? "null"));
            }
            else if (!string.Equals(expected, described, StringComparison.Ordinal))
                failures.Add(statement + "  —  the compiled form has " + (expected ?? "null") + ", the preview " + (described ?? "null"));
            else agreed++;
        }
        _output.WriteLine($"{cases.Count} statements: {agreed} agreed, {refused} refused, {rejected} rejected by the compiler or at run time, {failures.Count} failed");
        Assert.True(failures.Count == 0, string.Join(Environment.NewLine, failures));
    }

    // ------------------------------------------------------------------ compiled -------------------------------------

    private static Assembly? Compile(List<string> statements, out string?[] errors)
    {
        errors = new string?[statements.Count];
        var trees = statements.Select((s, i) => CSharpSyntaxTree.ParseText(FormSource("Form" + i, s), path: "Form" + i + ".cs")).ToList();
        var references = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!)
            .Split(Path.PathSeparator).Select(p => MetadataReference.CreateFromFile(p)).ToList();
        var options = new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary, nullableContextOptions: NullableContextOptions.Disable);
        var all = CSharpCompilation.Create("NonConstantCorpusProbe", trees, references, options);
        foreach (var d in all.GetDiagnostics().Where(d => d.Severity == DiagnosticSeverity.Error))
        {
            int index = trees.IndexOf(d.Location.SourceTree!);
            if (index >= 0) errors[index] ??= "does not compile (" + d.Id + ")";
        }
        var errorsCopy = errors;
        var clean = trees.Where((t, i) => errorsCopy[i] == null).ToList();
        using var stream = new MemoryStream();
        var emitted = CSharpCompilation.Create("NonConstantCorpus", clean, references, options).Emit(stream);
        Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error).Take(10)));
        return Assembly.Load(stream.ToArray());
    }

    private static string FormSource(string name, string statement) => """
        namespace CorpusForm
        {
            public partial class NAME : System.Windows.Forms.Form
            {
                public System.Windows.Forms.TextBox textBox1;
                public void InitializeComponent()
                {
                    this.textBox1 = new System.Windows.Forms.TextBox();
                    STATEMENT
                    this.Controls.Add(this.textBox1);
                }
            }
        }
        """.Replace("NAME", name).Replace("STATEMENT", statement);

    private static string? CompiledValue(Assembly assembly, int index, string property)
    {
        using var form = (System.Windows.Forms.Form)Activator.CreateInstance(assembly.GetType("CorpusForm.Form" + index, throwOnError: true)!)!;
        form.GetType().GetMethod("InitializeComponent")!.Invoke(form, null);
        var box = (System.Windows.Forms.TextBox)form.GetType().GetField("textBox1")!.GetValue(form)!;
        var pd = TypeDescriptor.GetProperties(box)[property]!;
        object? value = pd.GetValue(box);
        return value == null ? null : pd.Converter.ConvertToInvariantString(value);
    }

    // ------------------------------------------------------------------ interpreted ----------------------------------

    private static (bool Unrepresentable, string? Described) Interpret(string statement, string property)
    {
        string dir = Path.Combine(Path.GetTempPath(), "wfd-nonconstant-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        try
        {
            string file = Path.Combine(dir, "Form1.Designer.cs");
            string source = FormSource("Form1", statement);
            File.WriteAllText(file, source);
            var layout = Sta.Invoke(() => DesignerRenderer.RenderWithLayout(file, sourceText: source));
            bool unrepresentable = layout.Unrepresentable.Any(u => u.StartsWith(statement, StringComparison.Ordinal));
            if (unrepresentable) return (true, null);
            var info = Sta.Invoke(() => DesignerRenderer.DescribeComponent(file, "textBox1", sourceText: source));
            return (false, info?.Properties.SingleOrDefault(p => p.Name == property)?.Value);
        }
        finally
        {
            try { Directory.Delete(dir, recursive: true); } catch { /* best effort */ }
        }
    }
}
