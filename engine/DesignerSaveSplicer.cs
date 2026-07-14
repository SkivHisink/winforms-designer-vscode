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
        private static MethodDeclarationSyntax? FindInitializeComponent(string code)
        {
            var root = CSharpSyntaxTree.ParseText(code).GetRoot();
            foreach (var cls in root.DescendantNodes().OfType<ClassDeclarationSyntax>())
            {
                var m = cls.Members.OfType<MethodDeclarationSyntax>().FirstOrDefault(x => x.Identifier.Text == "InitializeComponent");
                if (m != null) return m;
            }
            return null;
        }

        /// <summary>
        /// Safe-save statement-level diff: the original InitializeComponent statements that the
        /// freshly re-serialized code does NOT reproduce (whitespace-insensitive). Empty ⇒ every
        /// original statement survives the round-trip; non-empty ⇒ a save would lose/alter code.
        /// (Comments are trivia, not statements, so reordering/comment changes are ignored.)
        /// </summary>
        public static List<string> MissingOriginalStatements(string originalText, string generatedText)
        {
            var generated = new HashSet<string>(StatementTexts(generatedText).Select(NormalizeStmt));
            return StatementTexts(originalText)
                .Where(s => !generated.Contains(NormalizeStmt(s)))
                .ToList();
        }

        private static IEnumerable<string> StatementTexts(string code)
        {
            var init = FindInitializeComponent(code);
            if (init?.Body == null) return Enumerable.Empty<string>();
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
                .Select(s => s.ToString());
        }

        private static bool IsLayoutBoilerplate(StatementSyntax s) =>
            s is ExpressionStatementSyntax { Expression: InvocationExpressionSyntax { Expression: MemberAccessExpressionSyntax ma } }
            && ma.Name.Identifier.Text is "SuspendLayout" or "ResumeLayout" or "PerformLayout";

        private static string NormalizeStmt(string s) =>
            new string(s.Where(c => !char.IsWhiteSpace(c)).ToArray());

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
