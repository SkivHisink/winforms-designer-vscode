using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace WinFormsDesigner.Engine
{
    public sealed class SaveResult
    {
        public RoundTripResult RoundTrip { get; init; } = new();
        public string OriginalText { get; init; } = "";
        /// <summary>The spliced file text, or null when the source was not safe to round-trip.</summary>
        public string? SplicedText { get; init; }
        /// <summary>Original file encoding (incl. BOM); the spliced text must be written with it.</summary>
        public Encoding Encoding { get; init; } = new UTF8Encoding(false);
        /// <summary>
        /// Original InitializeComponent statements NOT reproduced by re-serialization (safe-save
        /// statement-level diff). Non-empty ⇒ a save would silently lose/alter user code ⇒ unsafe.
        /// </summary>
        public List<string> MissingStatements { get; init; } = new();
        /// <summary>True only when the source fully round-trips, a splice was produced, and no statement is lost.</summary>
        public bool Safe => RoundTrip.RoundTripSafe && SplicedText != null && MissingStatements.Count == 0;
    }

    public sealed class SpliceResult
    {
        public string NewText { get; init; } = "";
        public int LinesBefore { get; init; }
        public int LinesAfter { get; init; }
        /// <summary>Char offset range of the source InitializeComponent body that was replaced.</summary>
        public int BodyStart { get; init; }
        public int BodyEnd { get; init; }
    }

    /// <summary>
    /// Save-direction splice (normalization / transactional write): replaces ONLY the body
    /// of the existing <c>InitializeComponent</c> method with a freshly normalized version,
    /// leaving the namespace, usings, partial-class declaration, field declarations,
    /// <c>Dispose</c>, regions, comments and every other member byte-for-byte intact.
    ///
    /// It is a surgical span replacement on the original text — NOT a whole-file regenerate —
    /// so user code outside InitializeComponent is never disturbed. The new body is reindented
    /// to the source file's own indentation/EOL style. Field declarations are intentionally
    /// left untouched (wholesale field regeneration would drop the `components` field that
    /// Dispose references; field sync belongs to the add/remove-control flow, not here).
    /// </summary>
    public static class DesignerSaveSplicer
    {
        /// <param name="sourceText">Original .Designer.cs text.</param>
        /// <param name="generatedCode">Full compile-unit produced by <see cref="DesignerSerializer"/>.</param>
        public static SpliceResult Splice(string sourceText, string generatedCode)
        {
            MethodDeclarationSyntax srcInit = FindInitializeComponent(sourceText)
                ?? throw new InvalidOperationException("InitializeComponent not found in source file");
            MethodDeclarationSyntax genInit = FindInitializeComponent(generatedCode)
                ?? throw new InvalidOperationException("InitializeComponent not found in generated code");

            if (srcInit.Body == null || genInit.Body == null)
            {
                throw new InvalidOperationException("InitializeComponent has no body");
            }

            string nl = sourceText.Contains("\r\n") ? "\r\n" : "\n";
            string methodIndent = LeadingIndent(sourceText, srcInit.SpanStart);
            string bodyIndent = srcInit.Body.Statements.Count > 0
                ? LeadingIndent(sourceText, srcInit.Body.Statements[0].SpanStart)
                : methodIndent + "    ";

            // generated body inner text (between the braces), reindented flat to bodyIndent.
            // InitializeComponent is a flat statement list (no nested blocks), so one level suffices.
            int gOpen = genInit.Body.OpenBraceToken.Span.End;
            int gClose = genInit.Body.CloseBraceToken.SpanStart;
            string inner = generatedCode.Substring(gOpen, gClose - gOpen);

            var reindented = new List<string>();
            foreach (var raw in inner.Replace("\r\n", "\n").Split('\n'))
            {
                string t = raw.Trim();
                reindented.Add(t.Length == 0 ? "" : bodyIndent + t);
            }
            // trim leading/trailing blank lines
            while (reindented.Count > 0 && reindented[0].Length == 0) reindented.RemoveAt(0);
            while (reindented.Count > 0 && reindented[^1].Length == 0) reindented.RemoveAt(reindented.Count - 1);

            string newBody = "{" + nl + string.Join(nl, reindented) + nl + methodIndent + "}";

            int s = srcInit.Body.SpanStart;       // position of '{'
            int e = srcInit.Body.Span.End;        // just past '}'
            string newText = sourceText.Substring(0, s) + newBody + sourceText.Substring(e);

            return new SpliceResult
            {
                NewText = newText,
                LinesBefore = CountLines(sourceText),
                LinesAfter = CountLines(newText),
                BodyStart = s,
                BodyEnd = e,
            };
        }

        /// <summary>
        /// First class that actually declares InitializeComponent — so a multi-class file with a
        /// helper class before the form partial can't make the splicer target the wrong method.
        /// </summary>
        // THE form's InitializeComponent, via the one shared rule (see FormClassResolver). This used to be a private
        // copy taking the first class in the file declaring the method BY NAME; every editor had its own. They agreed
        // only by luck, and a disagreement splices one class's body into another's. Null (no single designer class)
        // is what every caller already turns into a refusal.
        private static MethodDeclarationSyntax? FindInitializeComponent(string code) =>
            FormClassResolver.InitMethod(CSharpSyntaxTree.ParseText(code).GetRoot());

        /// <summary>
        /// Safe-save statement-level diff: the original InitializeComponent statements that the
        /// freshly re-serialized code does NOT reproduce (whitespace-insensitive). Empty ⇒ every
        /// original statement survives the round-trip; non-empty ⇒ a save would lose/alter code.
        /// (Comments are trivia, not statements, so reordering/comment changes are ignored.)
        /// </summary>
        public static List<string> MissingOriginalStatements(string originalText, string generatedText)
        {
            var generated = Counter(CanonicalStatements(generatedText).SelectMany(s => s.Atoms));
            var missing = new List<string>();
            foreach (var source in CanonicalStatements(originalText))
            {
                var needed = Counter(source.Atoms);
                bool available = needed.All(kv => generated.TryGetValue(kv.Key, out int count) && count >= kv.Value);
                if (!available)
                {
                    missing.Add(source.Original);
                    continue;
                }
                foreach (var kv in needed) generated[kv.Key] -= kv.Value;
            }
            return missing;
        }

        private sealed class CanonicalStatement
        {
            public string Original { get; init; } = "";
            public IReadOnlyList<string> Atoms { get; init; } = Array.Empty<string>();
        }

        /// <summary>
        /// Canonical statement atoms used only by the round-trip firewall. Two narrow, semantics-preserving designer
        /// dialect differences are normalized here:
        ///   * generated locals are alpha-renamed by declaration order, so <c>treeNode1</c> and <c>treenode1</c>
        ///     compare equal without ignoring any statement that uses them;
        ///   * a side-effect-free <c>AddRange(new T[] { a, b })</c> is expanded to the same ordered Add atoms as
        ///     <c>Add(a); Add(b);</c>.
        /// Everything else remains token-for-token strict. In particular, an AddRange element containing an
        /// invocation/object construction is NOT normalized: the gate cannot prove that splitting it preserves
        /// evaluation semantics, so it continues to fail closed.
        /// </summary>
        private static IEnumerable<CanonicalStatement> CanonicalStatements(string code)
        {
            var init = FindInitializeComponent(code);
            if (init?.Body == null) return Enumerable.Empty<CanonicalStatement>();
            var locals = BuildLocalMap(init);
            var rewriter = new LocalCanonicalizer(locals);
            // Suspend/Resume/PerformLayout are designer-managed layout scaffolding: the loader treats them as
            // no-ops and the serializer regenerates them canonically (exactly as VS does), so their presence/
            // absence is canonicalization, not user-code loss — exclude from the gate.
            // NOTE: ISupportInitialize BeginInit/EndInit are intentionally still in the gate (NOT excluded here). As of
            // 0.12.0 R1 the serializer re-emits them verbatim (DesignerSerializer.InjectSupportInit, the BeginInit
            // counterpart to InjectEventWirings), so they now MATCH the generated code and pass the gate naturally —
            // and if that re-emit ever regressed (a bracket not re-emitted), keeping them in the gate makes the form
            // fail safe-save and fall back to read-only instead of silently dropping the brackets. Event wirings work
            // the same way: re-emitted verbatim, so they round-trip and legitimately stay in the gate.
            return init.Body.Statements
                .Where(s => !IsLayoutBoilerplate(s))
                .Select(s => new CanonicalStatement
                {
                    Original = s.ToString(),
                    Atoms = CanonicalAtoms(s, locals, rewriter),
                });
        }

        private static Dictionary<string, string> BuildLocalMap(MethodDeclarationSyntax init)
        {
            var map = new Dictionary<string, string>(StringComparer.Ordinal);
            int ordinal = 0;
            if (init.Body == null) return map;
            foreach (var decl in init.Body.Statements.OfType<LocalDeclarationStatementSyntax>())
                foreach (var variable in decl.Declaration.Variables)
                    map[variable.Identifier.ValueText] = "__wfdLocal" + ordinal++;
            return map;
        }

        private static IReadOnlyList<string> CanonicalAtoms(StatementSyntax statement,
            IReadOnlyDictionary<string, string> locals, LocalCanonicalizer rewriter)
        {
            if (statement is ExpressionStatementSyntax
                {
                    Expression: InvocationExpressionSyntax
                    {
                        Expression: MemberAccessExpressionSyntax ma,
                        ArgumentList.Arguments.Count: 1,
                    } invocation,
                }
                && ma.Name.Identifier.ValueText == "AddRange"
                && TryArrayElements(invocation.ArgumentList.Arguments[0].Expression, out var elements)
                && elements.All(e => IsSafeCollectionElement(e, locals)))
            {
                SyntaxNode receiver = rewriter.Visit(ma.Expression) ?? ma.Expression;
                string receiverText = NormalizeSyntax(receiver);
                return elements
                    .Select(e => rewriter.Visit(e) ?? e)
                    .Select(e => receiverText + ".Add(" + NormalizeSyntax(e) + ");")
                    .ToList();
            }

            SyntaxNode rewritten = rewriter.Visit(statement) ?? statement;
            return new[] { NormalizeSyntax(rewritten) };
        }

        private static bool TryArrayElements(ExpressionSyntax expression, out IReadOnlyList<ExpressionSyntax> elements)
        {
            InitializerExpressionSyntax? initializer = expression switch
            {
                ArrayCreationExpressionSyntax a => a.Initializer,
                ImplicitArrayCreationExpressionSyntax a => a.Initializer,
                _ => null,
            };
            if (initializer == null)
            {
                elements = Array.Empty<ExpressionSyntax>();
                return false;
            }
            elements = initializer.Expressions.ToList();
            return true;
        }

        private static bool IsSafeCollectionElement(ExpressionSyntax expression,
            IReadOnlyDictionary<string, string> locals) => expression switch
            {
                LiteralExpressionSyntax => true,
                IdentifierNameSyntax id => locals.ContainsKey(id.Identifier.ValueText),
                MemberAccessExpressionSyntax
                {
                    Expression: ThisExpressionSyntax,
                    Name: SimpleNameSyntax name,
                } => SyntaxFacts.IsValidIdentifier(name.Identifier.ValueText),
                ParenthesizedExpressionSyntax p => IsSafeCollectionElement(p.Expression, locals),
                CastExpressionSyntax c => IsSafeCollectionElement(c.Expression, locals),
                PrefixUnaryExpressionSyntax p when p.IsKind(SyntaxKind.UnaryMinusExpression)
                    || p.IsKind(SyntaxKind.UnaryPlusExpression) => IsSafeCollectionElement(p.Operand, locals),
                _ => false,
            };

        private static string NormalizeSyntax(SyntaxNode node) =>
            string.Concat(node.DescendantTokens().Select(t => t.Text));

        private static Dictionary<string, int> Counter(IEnumerable<string> values)
        {
            var counts = new Dictionary<string, int>(StringComparer.Ordinal);
            foreach (string value in values)
                counts[value] = counts.TryGetValue(value, out int count) ? count + 1 : 1;
            return counts;
        }

        private sealed class LocalCanonicalizer : CSharpSyntaxRewriter
        {
            private readonly IReadOnlyDictionary<string, string> _locals;
            public LocalCanonicalizer(IReadOnlyDictionary<string, string> locals) => _locals = locals;

            public override SyntaxNode? VisitVariableDeclarator(VariableDeclaratorSyntax node)
            {
                var visited = (VariableDeclaratorSyntax)base.VisitVariableDeclarator(node)!;
                if (!_locals.TryGetValue(node.Identifier.ValueText, out string? replacement)) return visited;
                return visited.WithIdentifier(SyntaxFactory.Identifier(replacement).WithTriviaFrom(visited.Identifier));
            }

            public override SyntaxNode? VisitIdentifierName(IdentifierNameSyntax node)
            {
                var visited = (IdentifierNameSyntax)base.VisitIdentifierName(node)!;
                if (!_locals.TryGetValue(node.Identifier.ValueText, out string? replacement)) return visited;
                // In this.field / Type.Member the right-hand identifier names a member/type, never a local binding.
                if (node.Parent is MemberAccessExpressionSyntax ma && ma.Name == node) return visited;
                if (node.Parent is QualifiedNameSyntax or AliasQualifiedNameSyntax or NameColonSyntax or NameEqualsSyntax)
                    return visited;
                return SyntaxFactory.IdentifierName(replacement).WithTriviaFrom(visited);
            }
        }

        private static bool IsLayoutBoilerplate(StatementSyntax s) =>
            s is ExpressionStatementSyntax { Expression: InvocationExpressionSyntax { Expression: MemberAccessExpressionSyntax ma } }
            && ma.Name.Identifier.Text is "SuspendLayout" or "ResumeLayout" or "PerformLayout";

        /// <summary>Leading whitespace of the line containing <paramref name="pos"/>.</summary>
        private static string LeadingIndent(string text, int pos)
        {
            int lineStart = text.LastIndexOf('\n', Math.Max(0, pos - 1)) + 1;
            int i = lineStart;
            while (i < text.Length && (text[i] == ' ' || text[i] == '\t')) i++;
            return text.Substring(lineStart, i - lineStart);
        }

        private static int CountLines(string s) => s.Count(c => c == '\n') + 1;
    }
}
