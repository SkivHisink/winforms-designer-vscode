using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace WinFormsDesigner.Engine
{
    public enum EditMode { Replace, Insert, Failed }

    public sealed class EditResult
    {
        public string NewText { get; init; } = "";
        public EditMode Mode { get; init; }
        public string Reason { get; init; } = "";
    }

    public sealed class PropertyEditResult
    {
        public EditMode Mode { get; init; }
        /// <summary>The edited file text, or null when the edit was rejected.</summary>
        public string? NewText { get; init; }
        public Encoding Encoding { get; init; } = new UTF8Encoding(false);
        public bool ParseOk { get; init; }
        public bool Minimal { get; init; }
        public string Reason { get; init; } = "";
        /// <summary>True only when an edit was produced, it still parses, and it changed only the target.</summary>
        public bool Safe => NewText != null && Mode != EditMode.Failed && ParseOk && Minimal;
    }

    /// <summary>
    /// Targeted single-property edit (plan §6.3 sentinel / byte-zero-diff): change one property's
    /// value directly in the existing .Designer.cs as a MINIMAL text edit, instead of regenerating
    /// the whole InitializeComponent (which reorders). Two modes:
    ///   • Replace — the assignment exists ⇒ swap only its right-hand value (one-line diff). When the
    ///               source has duplicate assignments, the LAST (effective at runtime) one is edited.
    ///   • Insert  — it doesn't, but the component already has property assignments ⇒ add a new
    ///               statement after the component's last assignment LINE (keeps grouping; never
    ///               displaces that line's trailing comment).
    /// If the component has no assignments to anchor against, returns Failed so the caller can fall
    /// back to full re-serialize/splice. Because it never regenerates, it works even on files that
    /// don't fully round-trip; safety is enforced by <see cref="OnlyTargetChanged"/>.
    ///
    /// The root form's own properties use componentName "this" (e.g. this.Text).
    /// </summary>
    public static class DesignerPropertyEditor
    {
        public static EditResult EditProperty(string sourceText, string componentName, string propertyName, string newValueExpr)
        {
            bool isRoot = componentName is "this" or "";

            // reject anything that is not exactly one expression — stops a value like
            // `5; this.evil = 1` from injecting extra statements through the splice.
            if (!IsSingleExpression(newValueExpr))
            {
                return new EditResult { Mode = EditMode.Failed, Reason = "value is not a single C# expression: " + newValueExpr };
            }

            var init = FindInitializeComponent(sourceText);
            if (init?.Body == null)
            {
                return new EditResult { Mode = EditMode.Failed, Reason = "InitializeComponent not found" };
            }

            // scan once: last matching target assignment (effective value) + last assignment to the
            // component (insert anchor when the property has no assignment yet)
            AssignmentExpressionSyntax? lastTarget = null;
            AssignmentExpressionSyntax? lastOwner = null;
            foreach (var st in init.Body.Statements)
            {
                if (st is not ExpressionStatementSyntax es || es.Expression is not AssignmentExpressionSyntax asg) continue;
                var chain = Flatten(asg.Left);
                if (TargetMatches(chain, componentName, propertyName, isRoot)) lastTarget = asg;
                else if (OwnerMatches(chain, componentName, isRoot)) lastOwner = asg;
            }

            if (lastTarget != null)
            {
                int s = lastTarget.Right.SpanStart;
                int e = lastTarget.Right.Span.End;
                string newText = sourceText.Substring(0, s) + newValueExpr + sourceText.Substring(e);
                return new EditResult { NewText = newText, Mode = EditMode.Replace };
            }

            if (lastOwner == null)
            {
                return new EditResult
                {
                    Mode = EditMode.Failed,
                    Reason = "no existing assignment to '" + componentName + "' to anchor an insert (fall back to full serialize)"
                };
            }

            var anchorStmt = lastOwner.FirstAncestorOrSelf<ExpressionStatementSyntax>()!;
            string nl = sourceText.Contains("\r\n") ? "\r\n" : "\n";
            string indent = LeadingIndent(sourceText, anchorStmt.SpanStart);
            string lhs = isRoot ? "this." + propertyName : "this." + componentName + "." + propertyName;
            string newStmtLine = indent + lhs + " = " + newValueExpr + ";" + nl;

            // insert at the START of the line after the anchor — past the anchor's own trailing
            // comment/trivia — so we never move that comment onto the new statement.
            int afterSemi = anchorStmt.Span.End;
            int nlIdx = sourceText.IndexOf('\n', afterSemi);
            int insertPos = nlIdx < 0 ? sourceText.Length : nlIdx + 1;
            string inserted = sourceText.Substring(0, insertPos) + newStmtLine + sourceText.Substring(insertPos);
            return new EditResult { NewText = inserted, Mode = EditMode.Insert };
        }

        /// <summary>
        /// Safety gate (§6.5 for edits): every NON-target InitializeComponent statement must be
        /// unchanged (compared syntactically, so qualified `this.x.P` and unqualified `x.P` are
        /// treated alike), AND the count of target (component, property) statements changes by
        /// exactly the amount the mode implies (Replace: 0, Insert: +1). Together this rejects both
        /// "changed something else" and "injected extra target statements".
        /// </summary>
        public static bool OnlyTargetChanged(string original, string edited, string componentName, string propertyName, EditMode mode)
        {
            bool isRoot = componentName is "this" or "";
            var (origNon, origTgt) = Classify(original, componentName, propertyName, isRoot);
            var (editNon, editTgt) = Classify(edited, componentName, propertyName, isRoot);

            int expectedDelta = mode == EditMode.Insert ? 1 : 0;
            if (editTgt != origTgt + expectedDelta) return false;
            return MultisetEqual(origNon, editNon);
        }

        // ---- classification ----

        private static (List<string> nonTarget, int targetCount) Classify(string code, string comp, string prop, bool isRoot)
        {
            var nonTarget = new List<string>();
            int targetCount = 0;
            var init = FindInitializeComponent(code);
            if (init?.Body != null)
            {
                foreach (var st in init.Body.Statements)
                {
                    if (IsTargetAssignment(st, comp, prop, isRoot)) targetCount++;
                    else nonTarget.Add(NormalizeStmt(st.ToString()));
                }
            }
            return (nonTarget, targetCount);
        }

        private static bool IsTargetAssignment(StatementSyntax st, string comp, string prop, bool isRoot) =>
            st is ExpressionStatementSyntax { Expression: AssignmentExpressionSyntax asg }
            && TargetMatches(Flatten(asg.Left), comp, prop, isRoot);

        private static bool TargetMatches(List<string> chain, string comp, string prop, bool isRoot) =>
            isRoot ? (chain.Count == 1 && chain[0] == prop)
                   : (chain.Count == 2 && chain[0] == comp && chain[1] == prop);

        private static bool OwnerMatches(List<string> chain, string comp, bool isRoot) =>
            isRoot ? chain.Count == 1 : (chain.Count == 2 && chain[0] == comp);

        // ---- helpers ----

        private static bool IsSingleExpression(string value)
        {
            var expr = SyntaxFactory.ParseExpression(value);
            if (expr.GetDiagnostics().Any(d => d.Severity == DiagnosticSeverity.Error)) return false;
            // ToString() excludes leading/trailing trivia but keeps everything the parse consumed;
            // if anything trails (e.g. "; this.evil=1"), it won't round-trip → reject.
            if (expr.ToString().Trim() != value.Trim()) return false;

            // a property value is never a side-effecting expression — reject nested assignments
            // (e.g. "this.optionA.Checked = true") and ++/-- which the count/minimal gate can't catch.
            // Pure factory calls like Color.FromArgb(...) and `new Size(...)` stay allowed.
            foreach (var n in expr.DescendantNodesAndSelf())
            {
                if (n is AssignmentExpressionSyntax) return false;
                if (n.IsKind(SyntaxKind.PreIncrementExpression) || n.IsKind(SyntaxKind.PostIncrementExpression)
                    || n.IsKind(SyntaxKind.PreDecrementExpression) || n.IsKind(SyntaxKind.PostDecrementExpression))
                {
                    return false;
                }
            }
            return true;
        }

        /// <summary>First class that actually declares InitializeComponent (skips helper classes).</summary>
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

        private static bool MultisetEqual(List<string> a, List<string> b)
        {
            if (a.Count != b.Count) return false;
            var ca = Counter(a);
            var cb = Counter(b);
            if (ca.Count != cb.Count) return false;
            foreach (var kv in ca)
            {
                if (!cb.TryGetValue(kv.Key, out var n) || n != kv.Value) return false;
            }
            return true;
        }

        private static Dictionary<string, int> Counter(IEnumerable<string> items)
        {
            var d = new Dictionary<string, int>(StringComparer.Ordinal);
            foreach (var i in items) d[i] = d.TryGetValue(i, out var c) ? c + 1 : 1;
            return d;
        }

        private static string NormalizeStmt(string s) => new string(s.Where(c => !char.IsWhiteSpace(c)).ToArray());

        private static string LeadingIndent(string text, int pos)
        {
            int lineStart = text.LastIndexOf('\n', Math.Max(0, pos - 1)) + 1;
            int i = lineStart;
            while (i < text.Length && (text[i] == ' ' || text[i] == '\t')) i++;
            return text.Substring(lineStart, i - lineStart);
        }

        private static List<string> Flatten(ExpressionSyntax expr)
        {
            var names = new List<string>();
            void Walk(ExpressionSyntax e)
            {
                switch (e)
                {
                    case MemberAccessExpressionSyntax m: Walk(m.Expression); names.Add(m.Name.Identifier.Text); break;
                    case ThisExpressionSyntax: break;
                    case IdentifierNameSyntax id: names.Add(id.Identifier.Text); break;
                    case ParenthesizedExpressionSyntax p: Walk(p.Expression); break;
                    default: names.Add("?" + e.Kind()); break;
                }
            }
            Walk(expr);
            return names;
        }
    }
}
