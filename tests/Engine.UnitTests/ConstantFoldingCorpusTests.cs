using System.Globalization;
using System.Reflection;
using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using WinFormsDesigner.Engine;
using Xunit.Abstractions;

namespace Engine.UnitTests;

/// <summary>
/// Constant expressions compiled by the C# compiler and read back from the compiled assembly, compared with what the
/// modern interpreter evaluates and with what the build confirmation folds (<see cref="DesignerTypeScope"/>). Each
/// either has the compiler's value and type, or is refused. It never has a different value. An expression the compiler
/// rejects is refused too.
/// </summary>
public sealed class ConstantFoldingCorpusTests
{
    private readonly ITestOutputHelper _output;

    public ConstantFoldingCorpusTests(ITestOutputHelper output) => _output = output;

    private const string Declarations = """
        namespace Corpus
        {
            public enum EB : byte { Zero = 0, A = 1, B = 2, Max = 255 }
            public enum ESB : sbyte { Min = -128, MinusOne = -1, Zero = 0, A = 1, Max = 127 }
            public enum ES : short { Min = -32768, A = 1, Max = 32767 }
            public enum EUS : ushort { Zero = 0, A = 1, Max = 65535 }
            [System.Flags] public enum EI { None = 0, A = 1, B = 2, C = 4, All = 7, Min = int.MinValue, Max = int.MaxValue }
            public enum EU : uint { Zero = 0, A = 1, Max = 4294967295 }
            public enum EL : long { Min = long.MinValue, A = 1, Max = long.MaxValue }
            public enum EUL : ulong { Zero = 0, A = 1, Max = 18446744073709551615 }
            public static class K
            {
                public const sbyte SB = -128;
                public const byte B = 255;
                public const short S = -32768;
                public const ushort US = 65535;
                public const int I = int.MinValue;
                public const uint U = uint.MaxValue;
                public const long L = long.MinValue;
                public const ulong UL = ulong.MaxValue;
                public const char C = 'Z';
                public const bool T = true;
                public const float F = float.NaN;
                public const float FI = float.NegativeInfinity;
                public const double D = -0.0;
                public const double DE = double.Epsilon;
                public const decimal M = -1.50m;
                public const decimal MMax = decimal.MaxValue;
                public const string Str = "s";
                public const string NullStr = null;
                public const EB Eb = EB.Max;
                public const EI Ei = EI.All;
            }
        }
        """;

    private static readonly string[] Atoms =
    {
        // integers, as the lexer types them
        "0", "1", "2", "7", "127", "128", "255", "256", "32767", "32768", "65535", "65536", "2147483647", "2147483648",
        "4294967295", "4294967296", "9223372036854775807", "9223372036854775808", "18446744073709551615", "0x7F", "0xFF",
        "0x80000000", "0xFFFFFFFF", "0x8000000000000000", "0xFFFFFFFFFFFFFFFF", "0b101", "1_000", "1u", "1L", "1UL", "1Lu",
        "4294967295u", "2147483648L",
        // negated, including the int and long minimum in each spelling
        "-1", "-128", "-129", "-32768", "-32769", "-2147483648", "-2147483649", "-9223372036854775808", "-0",
        "-2147483648u", "-0x80000000", "-(2147483648)", "(-2147483648)", "-9223372036854775808L", "-9223372036854775808UL",
        "-0x8000000000000000", "- 2147483648", "-2_147_483_648", "-(-2147483648)", "-(-9223372036854775807)",
        // characters
        "'A'", "'\\0'", "'\\uffff'", "'\\u0080'",
        // floats and doubles, the edges, -0, NaN and the infinities
        "0F", "1.5F", "0.1F", "2.6F", "16777217F", "3.4028235E+38F", "1E-45F", "-0F", "-2.6F", "0F/0F", "1F/0F",
        "0.0", "0d", "1.5", "0.1", "2.5", "2.6", "3.5", "-2.5", "-2.6", "-3.5", "1e308", "5e-324", "-0.0", "2147483647.5",
        "2147483648.0", "-2147483648.9", "4294967295.9", "4294967296.0", "9223372036854775807.0", "-9223372036854775808.0",
        "1.8446744073709552E+19", "1e30", "0.0/0.0", "1.0/0.0", "-1.0/0.0", "1e39", "3.4028235677973366E+38",
        // decimals, with their scale
        "0m", "1m", "1.50m", "0.1m", "2.6m", "-2.6m", "2.5m", "-0m", "-0.0m", "79228162514264337593543950335m",
        "-79228162514264337593543950335m", "0.0000000000000000000000000001m", "255.9m", "-128.9m", "65535.99m",
        // bool, string, null
        "true", "false", "\"a\"", "\"\"", "null",
        // enum members of every underlying type
        "Corpus.EB.A", "Corpus.EB.Max", "Corpus.EB.Zero", "Corpus.ESB.Min", "Corpus.ESB.MinusOne", "Corpus.ES.Min",
        "Corpus.EUS.Max", "Corpus.EI.A", "Corpus.EI.Min", "Corpus.EI.Max", "Corpus.EI.All", "Corpus.EU.Max", "Corpus.EL.Min",
        "Corpus.EL.Max", "Corpus.EUL.Max", "System.Windows.Forms.AnchorStyles.Top", "System.Windows.Forms.Keys.Modifiers",
        "System.DayOfWeek.Monday",
        "System.Windows.Forms.AnchorStyles.Top | System.Windows.Forms.AnchorStyles.Left",
        "(System.Windows.Forms.AnchorStyles)((System.Windows.Forms.AnchorStyles.Top | System.Windows.Forms.AnchorStyles.Left))",
        // constant fields of every primitive type
        "Corpus.K.SB", "Corpus.K.B", "Corpus.K.S", "Corpus.K.US", "Corpus.K.I", "Corpus.K.U", "Corpus.K.L", "Corpus.K.UL",
        "Corpus.K.C", "Corpus.K.T", "Corpus.K.F", "Corpus.K.FI", "Corpus.K.D", "Corpus.K.DE", "Corpus.K.M", "Corpus.K.MMax",
        "Corpus.K.Str", "Corpus.K.NullStr", "Corpus.K.Eb", "Corpus.K.Ei", "int.MaxValue", "long.MinValue", "double.NaN",
        "float.PositiveInfinity", "decimal.MinusOne", "char.MaxValue", "System.Int32.MinValue", "string.Empty",
    };

    /// <summary>The operands combined pairwise under every binary operator.</summary>
    private static readonly string[] Operands =
    {
        "0", "1", "-1", "7", "2147483647", "-2147483648", "2147483648", "4294967295", "9223372036854775807",
        "18446744073709551615", "1u", "1L", "1UL", "'A'", "(byte)200", "(sbyte)-1", "(ushort)65535", "16777217", "1.5F",
        "0.1F", "0.1", "-0.0", "1.5m", "79228162514264337593543950335m", "true", "\"a\"", "null", "Corpus.EB.Max",
        "Corpus.EI.A", "Corpus.EU.Max", "System.Windows.Forms.AnchorStyles.Top", "Corpus.K.C",
    };

    private static readonly string[] Targets =
    {
        "sbyte", "byte", "short", "ushort", "int", "uint", "long", "ulong", "char", "float", "double", "decimal", "bool",
        "string", "Corpus.EB", "Corpus.ESB", "Corpus.EI", "Corpus.EU", "Corpus.EL", "Corpus.EUL",
        "System.Windows.Forms.AnchorStyles",
    };

    private static readonly string[] BinaryOperators =
        { "+", "-", "*", "/", "%", "<<", ">>", ">>>", "&", "|", "^", "&&", "||", "==", "!=", "<", "<=", ">", ">=" };

    private static readonly string[] Extras =
    {
        "1 + 2 * 3", "(1 + 2) * 3", "1 << 31", "1 << 32", "1L << 63", "-1 >> 1", "-1 >>> 1", "-1L >>> 1", "1u << 31",
        "~0", "~0u", "~0UL", "~(byte)1", "~'a'", "~Corpus.EB.A", "~Corpus.ESB.Min", "~Corpus.EUL.Zero",
        "~System.Windows.Forms.AnchorStyles.Top", "!true", "+'a'", "+1UL", "-1UL", "-1u", "-(byte)1", "-'a'", "-Corpus.EB.A",
        "+Corpus.EB.A", "Corpus.EB.Max + 1", "Corpus.EB.A - Corpus.EB.B", "Corpus.EB.B - Corpus.EB.A", "Corpus.EI.A - 0",
        "Corpus.EB.A - 0", "Corpus.EI.A | 0", "0 | Corpus.EI.A", "Corpus.EI.A == 0", "Corpus.EI.A + 0.0", "1 + Corpus.EI.A",
        "Corpus.EI.B - Corpus.EI.A", "Corpus.EI.A < Corpus.EI.B", "unchecked(Corpus.EB.Max + 1)", "Corpus.EI.Max + 1",
        "unchecked(Corpus.EI.Max + 1)", "Corpus.EB.A | Corpus.EB.B", "Corpus.EB.A ^ Corpus.EB.Max", "Corpus.EB.A & 0",
        "Corpus.EB.A | (Corpus.EB)0", "(Corpus.EB)0 | 0", "Corpus.EI.A | 0L", "Corpus.EI.A | 0u", "Corpus.EI.A | (byte)0",
        "Corpus.EI.A | '\\0'", "Corpus.EI.A | 0.0", "Corpus.EI.A | 0m", "Corpus.EI.A | 1",
        "\"a\" + \"b\" + \"c\"", "\"a\" + null", "null + \"a\"", "null + null", "\"a\" + 'b'", "\"a\" + 1", "\"a\" == \"a\"",
        "\"a\" != null", "null == null", "\"a\" + \"b\" == \"ab\"", "(string)null", "(string)null + \"x\"",
        // literals the compiler rejects, alone and in a CodeDom-style chain
        "\"\\q\"", "\"\\q\" + \"x\"", "\"x\" + \"\\uZZZZ\"", "'\\q'", "1__", "0x", "1e", "1L + 1L", "1m + 0m",
        "unchecked(2147483647 + 1)", "checked(unchecked(2147483647 + 1))", "unchecked(checked(2147483647 + 1))",
        "unchecked((int)4294967295)", "unchecked((byte)-1)", "unchecked((int)2147483648.0)", "unchecked((int)(0.0/0.0))",
        "unchecked((uint)-1.0)", "unchecked((byte)256m)", "unchecked(-(-2147483648))", "unchecked((int)0x80000000)",
        "unchecked((short)(sbyte)-1)", "unchecked((ulong)-1)", "unchecked((char)-1)", "unchecked((char)65536)",
        "unchecked(-(-9223372036854775808))", "unchecked((Corpus.EB)256)", "unchecked((Corpus.EB)(-1))",
        "unchecked(int.MinValue / -1)", "unchecked(int.MinValue % -1)", "int.MinValue / -1", "int.MinValue % -1",
        "long.MinValue / -1", "5 % -1", "-5 / 2", "-5 % 2", "5.5 % 2", "-5.5 % 2", "1 / 0", "1.0 / 0", "1 % 0", "1m / 0m",
        "1m / 3m", "1.0m + 2.00m", "1.50m * 2", "79228162514264337593543950335m + 1m", "0m * -1m", "-0m + 0m", "1m % 0.3m",
        "(decimal)0.1F", "(decimal)0.1", "(decimal)1e28", "(decimal)1e29", "(decimal)(-0.0)", "(decimal)float.NaN",
        "(double)0.1m", "(float)0.1m", "(float)0.1", "(double)0.1F", "(float)16777217", "(float)16777217L",
        "(float)9007199254740993L", "(float)18446744073709551615UL", "(double)18446744073709551615UL",
        "(double)9007199254740993L", "(float)(double)16777217", "(int)(float)2147483520", "(long)9.2233720368547748E+18",
        "(ulong)1.8446744073709550E+19", "(int)-2.6", "(int)(-2.6)", "(int)-3.5", "(int)-2.6m", "(int)-0.9", "(uint)-0.9",
        "(byte)-0.9", "(char)65.9", "(char)-0.5", "(int)2147483647.9", "(int)-2147483648.9", "(int)-2147483649.0",
        "(Corpus.EB)255.9", "(Corpus.EB)256.0", "(Corpus.ESB)(-128.5)", "(System.Windows.Forms.AnchorStyles)5",
        "(System.Windows.Forms.AnchorStyles)(-1)", "(int)System.Windows.Forms.AnchorStyles.Left",
        "(byte)Corpus.EI.Max", "(Corpus.EB)Corpus.EI.A", "(Corpus.EI)Corpus.EB.Max", "(Corpus.EUL)(-1)", "(Corpus.EL)Corpus.EUL.Max",
        "(double)(-0)", "(float)(-0)", "(double)-0.0F", "(float)-0.0", "-(sbyte)(-128)", "-(short)(-32768)",
        "-(int)(-2147483647)", "(sbyte)(-128)", "(short)-32768", "(int)-2147483648", "-(long)(-2147483648)",
        "(long)-2147483648", "(int)(-(2147483648))", "(long)(-(2147483648))", "unchecked((int)(-(2147483648)))",
        "(IComparable)(-2147483648)", "((((-2147483648))))", "-((2147483648))", "(int)(((-2147483648)))",
        "0.0 * -1", "0F * -1F", "-0.0 + 0.0", "-0.0 - 0.0", "1e308 * 10", "-1e308 * 10", "1e-320 / 1e10", "float.MaxValue * 2",
        "(float)1e308", "(float)-1e308", "(float)1e-50", "(float)-1e-50", "0.1F + 0.2F", "0.1 + 0.2", "0.1F * 3", "16777216F + 1",
        "16777217 + 1F", "1F / 3", "1.0 / 3", "1 / 3F", "2147483647 + 1F", "1e10F % 3F", "true & false", "true | false",
        "true ^ true", "true && false", "false || true", "!false == true", "1 < 2 == true", "1.0 < double.NaN", "double.NaN == double.NaN",
        "double.NaN != double.NaN", "0.0 == -0.0", "1m == 1.00m", "'a' < 'b'", "'a' + 'b'", "'a' + 1", "(char)('a' + 1)",
        "(byte)200 + (byte)100", "(sbyte)-1 + 1u", "1u + 1", "1u + -1", "1u - 2", "1UL + 1", "1UL + -1", "1L + 1UL", "1u * 1L",
        "4294967295u + 1", "4294967295u + 1L", "(ushort)65535 * (ushort)65535", "65535 * 65535", "46341 * 46341",
        "-2147483648 - 1", "-2147483648 * -1", "2147483647 * 2", "9223372036854775807 + 1", "18446744073709551615 + 1",
        "18446744073709551615 * 2", "1 << -1", "1 << 33", "1L << 65", "-8 >> 1", "-8 >>> 1", "(byte)1 << 8", "'a' << 1",
        "1u >> 1", "1 << 2L", "1 << 2u", "1.0 << 1", "1 >> 'a'", "0x7FFFFFFF + 0x7FFFFFFF", "0xFFFFFFFF + 1",
        "0xFFFFFFFF + 1u", "unchecked(0xFFFFFFFF + 1u)", "unchecked((uint)(0xFFFFFFFF + 1))", "1 + 2 + 3 + 4 + 5 + 6 + 7 + 8",
        "1 - - 1", "1 - -1", "- - 1", "-(-1)", "~~1", "!!true", "+-1", "-+1", "(1)", "((1))", "(1 + 2)", "checked(1)",
    };

    private static readonly CSharpParseOptions Parse = new(LanguageVersion.Latest);

    // ------------------------------------------------------------------ the tests -----------------------------------

    [Fact]
    public void EveryCompiledConstant_IsTheValueAndTypeTheInterpreterTakes_OrIsRefused()
    {
        var corpus = Shared.Value;
        var report = new Report();
        foreach (var c in corpus.Cases)
        {
            Type? target = c.Target == null ? null : corpus.TypeOf(c.Target);
            var outcome = Interpret(c.Expression, target, corpus.Assembly);
            if (c.Compiled)
            {
                if (outcome.Error != null)
                {
                    if (ExpectedRefusal(c.Expression, outcome.Error)) report.Refused(c, "compiles to " + Show(c.Value, c.Type) + ": " + outcome.Error);
                    else report.Fail(c, "refused, where the compiler stores " + Show(c.Value, c.Type) + ": " + outcome.Error);
                    continue;
                }
                if (!SameConstant(c.Value, c.Type, outcome.Value))
                    report.Fail(c, "the interpreter takes " + Show(outcome.Value) + " where the compiler stores " + Show(c.Value, c.Type));
                else report.Agreed();
            }
            else if (c.Target == null ? c.ExpressionError : c.StatementError && corpus.Natural(c.Expression) is { Compiled: true })
            {
                // An expression the compiler rejects, or a constant it does not convert to the target implicitly (an
                // explicit conversion needs a cast in the source, even one that would keep the value): refused.
                if (outcome.Error != null) report.Agreed();
                else report.Fail(c, "the interpreter takes " + Show(outcome.Value) + " for "
                    + (c.Target == null ? "an expression" : "an assignment") + " the compiler rejects");
            }
        }
        _output.WriteLine("interpreter: " + report.Summary());
        foreach (var line in report.Failures) _output.WriteLine("  failed: " + line);
        foreach (var line in report.RefusedLines(int.MaxValue)) _output.WriteLine("  refused: " + line);
        Assert.True(report.Failures.Count == 0, report.FailureText());
    }

    [Fact]
    public void EveryCompiledConstant_IsTheValueAndTypeTheBuildConfirmationFolds_OrIsNotFolded()
    {
        var corpus = Shared.Value;
        var natural = corpus.Cases.Where(c => c.Target == null).ToList();
        string designer = "namespace CorpusForm { partial class Form1 : System.Windows.Forms.Form { private void InitializeComponent() {\n"
            + string.Concat(natural.Select(c => "this.Tag = " + c.Expression + ";\n")) + "} } }";
        var tree = CSharpSyntaxTree.ParseText(designer, Parse);
        var cls = tree.GetRoot().DescendantNodes().OfType<ClassDeclarationSyntax>().Single();
        var statements = tree.GetRoot().DescendantNodes().OfType<MethodDeclarationSyntax>().Single().Body!.Statements;
        Assert.Equal(natural.Count, statements.Count);
        var search = new[] { corpus.Assembly, typeof(System.Windows.Forms.Control).Assembly, typeof(object).Assembly };
        var scope = new DesignerTypeScope(DesignerIrBuilder.SourceScopesOf(cls), search, corpus.Assembly,
            name => search.Select(a => a.GetType(name)).FirstOrDefault(t => t != null), () => new ProjectSourceFacts());

        var report = new Report();
        for (int i = 0; i < natural.Count; i++)
        {
            var c = natural[i];
            var ops = scope.Describe(statements[i]).Ops;
            // The statement compares as one constant stored into Tag, or not as a constant at all (then the build, which
            // stores one constant, does not confirm it).
            if (ops is not [{ Kind: "const" } constant, { Kind: "inst", Name: "set_Tag" }])
            {
                if (!c.Compiled) continue;
                // What the interpreter applies, the build confirmation must be able to confirm: the same folder.
                if (Interpret(c.Expression, null, corpus.Assembly).Error == null)
                    report.Fail(c, "the interpreter folds it, the build confirmation does not compare it as one constant");
                else report.Refused(c, "compiles to " + Show(c.Value, c.Type) + ", not compared as one constant");
                continue;
            }
            if (!c.Compiled)
            {
                if (c.ExpressionError || !c.HasConstant)
                    report.Fail(c, "the build confirmation folds " + Show(constant.Value) + " where the compiler has no constant");
                continue;
            }
            if (constant.Type != c.Type || !SameNormalized(Normalized(c.Value), constant.Value))
                report.Fail(c, "the build confirmation folds " + Show(constant.Value) + " (" + constant.Type + ") where the compiler stores "
                    + Show(c.Value, c.Type));
            else report.Agreed();
        }
        _output.WriteLine("build confirmation: " + report.Summary());
        foreach (var line in report.Failures) _output.WriteLine("  failed: " + line);
        foreach (var line in report.RefusedLines(int.MaxValue)) _output.WriteLine("  not folded: " + line);
        Assert.True(report.Failures.Count == 0, report.FailureText());
    }

    [Fact]
    public void TheVisualStudioShapes_AreFolded()
    {
        // What Visual Studio writes, and what the issue lists as rejected before, must not be refused.
        var corpus = Shared.Value;
        string[] required =
        {
            "(System.Windows.Forms.AnchorStyles)((System.Windows.Forms.AnchorStyles.Top | System.Windows.Forms.AnchorStyles.Left))",
            "-2147483648", "-9223372036854775808", "(int)-2.6", "(int)-2.6m", "(decimal)0.1F", "1 + 2 * 3", "1 << 31", "~0u",
            "unchecked(2147483647 + 1)", "unchecked((int)4294967295)", "0.0/0.0", "1.0/0.0", "-0.0", "1u + 1", "1UL + 1",
            "1.0m + 2.00m", "Corpus.EB.A | Corpus.EB.B", "~Corpus.EB.A", "\"a\" + \"b\" + \"c\"", "(byte)200 + (byte)100",
        };
        var missing = new List<string>();
        foreach (string expression in required)
        {
            var c = corpus.Natural(expression);
            Assert.True(c is { Compiled: true }, expression + " is not a compiled constant of the corpus");
            var outcome = Interpret(expression, null, corpus.Assembly);
            if (outcome.Error != null || !SameConstant(c!.Value, c.Type, outcome.Value)) missing.Add(expression + " -> " + (outcome.Error ?? Show(outcome.Value)));
        }
        Assert.True(missing.Count == 0, string.Join(Environment.NewLine, missing));
    }

    // ------------------------------------------------------------------ the corpus ----------------------------------

    private sealed class Case
    {
        public required string Expression;
        /// <summary>The declared type, or null for the expression's own type.</summary>
        public string? Target;
        /// <summary>An error inside the expression itself.</summary>
        public bool ExpressionError;
        /// <summary>Any error in its declaration; for a target, also a conversion the compiler does not make.</summary>
        public bool StatementError;
        public bool HasConstant;
        public string? TypeText;
        /// <summary>Compiled into the probe assembly, its constant read back as <see cref="Value"/> of <see cref="Type"/>.</summary>
        public bool Compiled;
        public object? Value;
        public Type? Type;

        public override string ToString() => Target == null ? Expression : Target + " = " + Expression;
    }

    private sealed class Corpus
    {
        public required List<Case> Cases;
        public required Assembly Assembly;
        public required Dictionary<string, Case> NaturalByText;

        public Case? Natural(string expression) => NaturalByText.TryGetValue(expression, out var c) ? c : null;

        public Type TypeOf(string target) => target switch
        {
            "sbyte" => typeof(sbyte), "byte" => typeof(byte), "short" => typeof(short), "ushort" => typeof(ushort),
            "int" => typeof(int), "uint" => typeof(uint), "long" => typeof(long), "ulong" => typeof(ulong),
            "char" => typeof(char), "float" => typeof(float), "double" => typeof(double), "decimal" => typeof(decimal),
            "bool" => typeof(bool), "string" => typeof(string),
            _ => Assembly.GetType(target) ?? typeof(System.Windows.Forms.Control).Assembly.GetType(target, throwOnError: true)!,
        };
    }

    private static readonly Lazy<Corpus> Shared = new(BuildCorpus);

    private static List<Case> Generate()
    {
        var cases = new List<Case>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        void Add(string expression, string? target = null)
        {
            if (seen.Add((target ?? "") + "|" + expression)) cases.Add(new Case { Expression = expression, Target = target });
        }
        foreach (string a in Atoms) Add(a);
        foreach (string a in Extras) Add(a);
        foreach (string a in Atoms)
        {
            foreach (string op in new[] { "-", "+", "~", "!" })
            {
                Add(op + "(" + a + ")");
                if (char.IsDigit(a[0]) || a[0] == '\'') Add(op + a);
            }
            foreach (string t in Targets)
            {
                Add("(" + t + ")(" + a + ")");
                Add("unchecked((" + t + ")(" + a + "))");
                Add(a, t);
            }
        }
        foreach (string t in Targets)
            foreach (string e in Extras)
            {
                Add("(" + t + ")(" + e + ")");
                Add(e, t);
            }
        foreach (string a in Operands)
            foreach (string b in Operands)
                foreach (string op in BinaryOperators)
                {
                    Add("(" + a + ") " + op + " (" + b + ")");
                    if (op is "+" or "-" or "*" or "/" or "%" or "<<") Add("unchecked((" + a + ") " + op + " (" + b + "))");
                }
        return cases;
    }

    private static Corpus BuildCorpus()
    {
        var cases = Generate();
        var references = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!)
            .Split(Path.PathSeparator).Select(p => MetadataReference.CreateFromFile(p)).ToList();
        var options = new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary, nullableContextOptions: NullableContextOptions.Disable);
        var declarations = CSharpSyntaxTree.ParseText(Declarations, Parse);

        // Bind every case as a local declaration: what it is, and what the compiler reports.
        var bind = new StringBuilder("using System;\nnamespace CorpusProbe { static class P {\n");
        for (int i = 0; i < cases.Count; i++)
        {
            if (i % 400 == 0) bind.Append(i == 0 ? "" : "}\n").Append("static void M").Append(i).Append("() {\n");
            bind.Append(cases[i].Target ?? "var").Append(" v").Append(i).Append(" = ").Append(cases[i].Expression).Append(";\n");
        }
        bind.Append("} } }\n");
        var probe = CSharpSyntaxTree.ParseText(bind.ToString(), Parse);
        var compilation = CSharpCompilation.Create("CorpusBind", new[] { declarations, probe }, references, options);
        var model = compilation.GetSemanticModel(probe);
        var declarators = probe.GetRoot().DescendantNodes().OfType<VariableDeclaratorSyntax>().ToList();
        Assert.Equal(cases.Count, declarators.Count);
        var statementSpans = declarators.Select(d => d.Parent!.Parent!.Span).ToArray();
        foreach (var d in compilation.GetDiagnostics())
        {
            if (d.Severity != DiagnosticSeverity.Error || d.Location.SourceTree != probe) continue;
            var span = d.Location.SourceSpan;
            int lo = 0, hi = statementSpans.Length - 1, at = -1;
            while (lo <= hi)
            {
                int mid = (lo + hi) / 2;
                if (statementSpans[mid].Start <= span.Start) { at = mid; lo = mid + 1; }
                else hi = mid - 1;
            }
            if (at < 0 || !statementSpans[at].Contains(span.Start))
                throw new InvalidOperationException("a diagnostic outside the corpus statements: " + d);
            cases[at].StatementError = true;
            if (declarators[at].Initializer!.Value.Span.Contains(span)) cases[at].ExpressionError = true;
        }
        for (int i = 0; i < cases.Count; i++)
        {
            var value = declarators[i].Initializer!.Value;
            cases[i].HasConstant = model.GetConstantValue(value).HasValue;
            var type = model.GetTypeInfo(value).Type;
            cases[i].TypeText = cases[i].Target
                ?? (type is { SpecialType: not SpecialType.None } || type?.TypeKind == TypeKind.Enum
                    ? type.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat) : null);
        }

        // Compile every constant into a field and read it back from the assembly.
        var compiled = cases.Select((c, i) => (c, i))
            .Where(x => !x.c.StatementError && x.c.HasConstant && x.c.TypeText != null && x.c.TypeText != "object")
            .ToList();
        var fields = new StringBuilder("using System;\nnamespace CorpusProbe { public static class C {\n");
        foreach (var (c, i) in compiled)
            fields.Append("public const ").Append(c.TypeText).Append(" F").Append(i).Append(" = ").Append(c.Expression).Append(";\n");
        fields.Append("} }\n");
        var emitted = CSharpCompilation.Create("ConstantCorpus",
            new[] { declarations, CSharpSyntaxTree.ParseText(fields.ToString(), Parse) }, references, options);
        using var stream = new MemoryStream();
        var result = emitted.Emit(stream);
        if (!result.Success)
            throw new InvalidOperationException(string.Join(Environment.NewLine,
                result.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error).Take(20)));
        var assembly = Assembly.Load(stream.ToArray());
        var holder = assembly.GetType("CorpusProbe.C", throwOnError: true)!;
        foreach (var (c, i) in compiled)
        {
            var field = holder.GetField("F" + i, BindingFlags.Public | BindingFlags.Static)!;
            c.Compiled = true;
            c.Type = field.FieldType;
            if (field.IsLiteral)
            {
                object? raw = field.GetRawConstantValue();
                c.Value = field.FieldType.IsEnum && raw != null ? Enum.ToObject(field.FieldType, raw) : raw;
            }
            else c.Value = DecimalConstant(field);
        }
        return new Corpus
        {
            Cases = cases,
            Assembly = assembly,
            NaturalByText = cases.Where(c => c.Target == null).ToDictionary(c => c.Expression, StringComparer.Ordinal),
        };
    }

    private static decimal DecimalConstant(FieldInfo field)
    {
        var data = field.GetCustomAttributesData()
            .Single(a => a.AttributeType == typeof(System.Runtime.CompilerServices.DecimalConstantAttribute));
        var a = data.ConstructorArguments.Select(x => Convert.ToInt64(x.Value, CultureInfo.InvariantCulture)).ToArray();
        return new decimal(unchecked((int)a[4]), unchecked((int)a[3]), unchecked((int)a[2]), a[1] != 0, (byte)a[0]);
    }

    // ------------------------------------------------------------------ helpers -------------------------------------

    private static readonly System.Text.RegularExpressions.Regex KeywordConstantField =
        new(@"\b(int|long|double|float|decimal|char|string|System\.Int32)\.[A-Z]");

    /// <summary>The refusals the interpreter is meant to make although the compiler has a constant: a constant field of
    /// a class (only enum members are read), a floating value out of an integral type's range in an unchecked context
    /// (C# leaves it unspecified), a comparison with null (a lifted operator), and <c>E - 0</c> for an enum whose
    /// underlying type is not int, where the compiler picks between two equally good operators by a rule of its own.</summary>
    private static bool ExpectedRefusal(string expression, string error) =>
        expression.Contains("Corpus.K.", StringComparison.Ordinal) || KeywordConstantField.IsMatch(expression)
        || error.Contains("in an unchecked context is unspecified", StringComparison.Ordinal)
        || (expression.Contains("null", StringComparison.Ordinal) && error.Contains("EqualsExpression", StringComparison.Ordinal))
        || error.Contains("operator '-' is ambiguous", StringComparison.Ordinal);

    private static readonly MethodInfo EvalMethod =
        typeof(DesignerRenderer).GetMethod("Eval", BindingFlags.NonPublic | BindingFlags.Static)!;

    private static (object? Value, string? Error) Interpret(string expression, Type? target, Assembly corpus)
    {
        try
        {
            return (EvalMethod.Invoke(null, new object?[] { SyntaxFactory.ParseExpression(expression, options: Parse), target, new[] { corpus } }), null);
        }
        catch (TargetInvocationException ex) { return (null, ex.InnerException?.GetType().Name + ": " + ex.InnerException?.Message); }
    }

    private static bool SameConstant(object? expected, Type? expectedType, object? actual)
    {
        if (expected == null) return actual == null;
        if (actual == null || actual.GetType() != expectedType) return false;
        return (expected, actual) switch
        {
            (float x, float y) => BitConverter.SingleToInt32Bits(x) == BitConverter.SingleToInt32Bits(y),
            (double x, double y) => BitConverter.DoubleToInt64Bits(x) == BitConverter.DoubleToInt64Bits(y),
            (decimal x, decimal y) => decimal.GetBits(x).SequenceEqual(decimal.GetBits(y)),
            _ => Equals(expected, actual),
        };
    }

    /// <summary>A constant as the build reading compares it: integral values as long, floating ones as double.</summary>
    private static object? Normalized(object? value) => value switch
    {
        null => null,
        string or decimal or double => value,
        float f => (double)f,
        bool b => b ? 1L : 0L,
        char ch => (long)ch,
        ulong u => unchecked((long)u),
        Enum e => Normalized(Convert.ChangeType(e, Enum.GetUnderlyingType(e.GetType()), CultureInfo.InvariantCulture)),
        IConvertible c => c.ToInt64(CultureInfo.InvariantCulture),
        _ => value,
    };

    private static bool SameNormalized(object? expected, object? actual) => (expected, actual) switch
    {
        (null, null) => true,
        (double x, double y) => BitConverter.DoubleToInt64Bits(x) == BitConverter.DoubleToInt64Bits(y),
        (decimal x, decimal y) => decimal.GetBits(x).SequenceEqual(decimal.GetBits(y)),
        _ => Equals(expected, actual),
    };

    private static string Show(object? value, Type? type = null) => value switch
    {
        null => "null" + (type == null ? "" : " (" + type.Name + ")"),
        float f => f.ToString("R", CultureInfo.InvariantCulture) + "f [" + BitConverter.SingleToInt32Bits(f).ToString("X8") + "]",
        double d => d.ToString("R", CultureInfo.InvariantCulture) + "d [" + BitConverter.DoubleToInt64Bits(d).ToString("X16") + "]",
        decimal m => m.ToString(CultureInfo.InvariantCulture) + "m [" + string.Join(",", decimal.GetBits(m)) + "]",
        string s => "\"" + s + "\"",
        _ => Convert.ToString(value, CultureInfo.InvariantCulture) + " (" + value.GetType().Name + ")",
    };

    private sealed class Report
    {
        public readonly List<string> Failures = new();
        private readonly List<string> _refused = new();
        private int _agreed;

        public void Agreed() => _agreed++;
        public void Refused(Case c, string why) => _refused.Add(c + "  —  " + why);
        public void Fail(Case c, string why) => Failures.Add(c + "  —  " + why);
        public string Summary() => _agreed + " agreed, " + _refused.Count + " refused, " + Failures.Count + " failed";
        public IEnumerable<string> RefusedLines(int max) => _refused.Take(max);
        public string FailureText() => Summary() + Environment.NewLine + string.Join(Environment.NewLine, Failures.Take(80));
    }
}
