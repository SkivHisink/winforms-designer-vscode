using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace WinFormsDesigner.Engine
{
    /// <summary>
    /// Targeted edit of a TableLayoutPanel child's cell (column/row), plan §6.5 — the grid-cell counterpart of
    /// <see cref="DesignerPropertyEditor"/>. A child's cell is NOT a normal property assignment; it lives in the
    /// VS-default 3-arg overload <c>tableLayoutPanel1.Controls.Add(this.child, COLUMN, ROW)</c> (the extender
    /// Column/Row properties carry <c>[DesignerSerializationVisibility(Hidden)]</c> precisely because this Add is
    /// their canonical serialization). So editing a cell means swapping arg[1]/arg[2] of that exact Add call —
    /// a minimal, byte-local text edit that never regenerates InitializeComponent.
    ///
    /// Safety mirrors <see cref="DesignerPropertyEditor.OnlyTargetChanged"/>: the new column/row are passed as
    /// plain non-negative integers (never interpolated source), and <see cref="OnlyTableCellChanged"/> verifies
    /// the edit touched ONLY that one Add call, kept it a 3-arg <c>Controls.Add(this.child, …)</c>, and left both
    /// cell args as non-negative integer literals — so nothing else moved and no expression was injected.
    /// </summary>
    public static class DesignerTableCellEditor
    {
        public static EditResult SetCell(string sourceText, string childId, int? column, int? row)
        {
            if (column == null && row == null) return Failed("no column or row to set");
            if (column is < 0) return Failed("column must be >= 0");
            if (row is < 0) return Failed("row must be >= 0");
            if (!IsIdentifier(childId)) return Failed("invalid child id: " + childId);

            var init = FindInitializeComponent(sourceText);
            if (init?.Body == null) return Failed("InitializeComponent not found");

            InvocationExpressionSyntax? target = null;
            foreach (var st in init.Body.Statements)
            {
                if (st is ExpressionStatementSyntax es && es.Expression is InvocationExpressionSyntax inv
                    && IsControlsAdd3(inv, childId))
                {
                    target = inv; // last effective wins (there is normally exactly one)
                }
            }
            if (target == null)
                return Failed("no 3-arg Controls.Add(this." + childId + ", col, row) found — not a TableLayoutPanel cell?");

            var args = target.ArgumentList.Arguments;
            // edit the LATER span (row = arg[2]) first so the EARLIER span (col = arg[1]) stays valid against the
            // unchanged prefix of the original text.
            string text = sourceText;
            if (row != null)
            {
                var r = args[2].Expression;
                text = text.Substring(0, r.SpanStart) + row.Value.ToString(CultureInfo.InvariantCulture) + text.Substring(r.Span.End);
            }
            if (column != null)
            {
                var c = args[1].Expression;
                text = text.Substring(0, c.SpanStart) + column.Value.ToString(CultureInfo.InvariantCulture) + text.Substring(c.Span.End);
            }
            return new EditResult { NewText = text, Mode = EditMode.Replace };
        }

        /// <summary>§6.5 gate: every statement EXCEPT the one target Add is byte-identical (multiset), the target
        /// Add appears exactly once before and after, and the edited Add is still a 3-arg
        /// <c>Controls.Add(this.child, &lt;int&gt;, &lt;int&gt;)</c> with non-negative integer-literal cell args.</summary>
        public static bool OnlyTableCellChanged(string original, string edited, string childId)
        {
            var (oNon, oTgts) = ClassifyCell(original, childId);
            var (eNon, eTgts) = ClassifyCell(edited, childId);
            if (oTgts.Count != 1 || eTgts.Count != 1) return false;
            if (!MultisetEqual(oNon, eNon)) return false;
            var args = eTgts[0].ArgumentList.Arguments;
            if (args.Count != 3) return false;
            // the edited cell args are plain non-negative int literals (no injected expression)
            if (!IsNonNegIntLiteral(args[1].Expression) || !IsNonNegIntLiteral(args[2].Expression)) return false;
            // and EVERYTHING ELSE in the target Add is byte-identical — receiver, method and arg[0] (the child): blank
            // the two cell args to a placeholder and require the skeletons match. This makes the gate self-sufficient
            // (it no longer trusts SetCell to have touched only arg[1]/arg[2] — a tampered receiver/child is rejected).
            return CellSkeleton(oTgts[0]) == CellSkeleton(eTgts[0]);
        }

        /// <summary>The target Add normalized with its two cell args blanked to <c>#</c> — equal skeletons prove that
        /// only arg[1]/arg[2] (column/row) may differ between the original and edited Add (receiver + arg[0] fixed).</summary>
        private static string CellSkeleton(InvocationExpressionSyntax inv)
        {
            var a = inv.ArgumentList.Arguments;
            string arg0 = a.Count > 0 ? NormalizeStmt(a[0].ToString()) : "";
            return NormalizeStmt(inv.Expression.ToString()) + "(" + arg0 + ",#,#)";
        }

        // ---- classification / matching ----

        private static (List<string> nonTarget, List<InvocationExpressionSyntax> targets) ClassifyCell(string code, string childId)
        {
            var non = new List<string>();
            var tgts = new List<InvocationExpressionSyntax>();
            var init = FindInitializeComponent(code);
            if (init?.Body != null)
            {
                foreach (var st in init.Body.Statements)
                {
                    if (st is ExpressionStatementSyntax es && es.Expression is InvocationExpressionSyntax inv
                        && IsControlsAdd3(inv, childId))
                        tgts.Add(inv);
                    else
                        non.Add(NormalizeStmt(st.ToString()));
                }
            }
            return (non, tgts);
        }

        /// <summary>True for <c>&lt;owner&gt;.Controls.Add(this.&lt;childId&gt;, x, y)</c> — a 3-arg Controls.Add whose
        /// first argument names <paramref name="childId"/>.</summary>
        private static bool IsControlsAdd3(InvocationExpressionSyntax inv, string childId)
        {
            if (inv.Expression is not MemberAccessExpressionSyntax ma || ma.Name.Identifier.Text != "Add") return false;
            if (ma.Expression is not MemberAccessExpressionSyntax recv || recv.Name.Identifier.Text != "Controls") return false;
            var args = inv.ArgumentList.Arguments;
            if (args.Count != 3) return false;
            var chain = Flatten(args[0].Expression);
            return chain.Count == 1 && chain[0] == childId;
        }

        private static bool IsNonNegIntLiteral(ExpressionSyntax e) =>
            e is LiteralExpressionSyntax lit && lit.IsKind(SyntaxKind.NumericLiteralExpression)
            && lit.Token.Value is int i && i >= 0;

        // ---- helpers (kept local so the proven DesignerPropertyEditor stays untouched) ----

        private static EditResult Failed(string reason) => new() { Mode = EditMode.Failed, Reason = reason };

        private static bool IsIdentifier(string s) =>
            !string.IsNullOrEmpty(s) && SyntaxFacts.IsValidIdentifier(s);

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
                if (!cb.TryGetValue(kv.Key, out var n) || n != kv.Value) return false;
            return true;
        }

        private static Dictionary<string, int> Counter(IEnumerable<string> items)
        {
            var d = new Dictionary<string, int>(StringComparer.Ordinal);
            foreach (var i in items) d[i] = d.TryGetValue(i, out var c) ? c + 1 : 1;
            return d;
        }

        private static string NormalizeStmt(string s) => new(s.Where(c => !char.IsWhiteSpace(c)).ToArray());

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
