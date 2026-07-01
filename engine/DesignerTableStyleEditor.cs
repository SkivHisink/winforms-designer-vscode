using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace WinFormsDesigner.Engine
{
    /// <summary>One TableLayoutPanel column/row sizing style, read from a
    /// <c>&lt;panel&gt;.ColumnStyles.Add(new ColumnStyle(SizeType.X, vF))</c> statement (or RowStyles).</summary>
    public sealed class TableStyleInfo
    {
        public string Axis { get; init; } = "";      // "Column" | "Row"
        public int Index { get; init; }              // ordinal within its axis (0-based = column/row index)
        public string SizeType { get; init; } = "";  // "Absolute" | "Percent" | "AutoSize"
        public double Value { get; init; }           // the size (percent or pixels); 0 for AutoSize
    }

    /// <summary>The ordered column + row sizing styles of one TableLayoutPanel (read side for a style editor).</summary>
    public sealed class TableStylesResult
    {
        public bool Found { get; init; }             // true when the panel has ≥1 Column/RowStyles.Add
        public List<TableStyleInfo> Styles { get; init; } = new();
    }

    /// <summary>
    /// Targeted edit of a TableLayoutPanel column/row SIZING STYLE (plan §6.5, Phase 2) — the size-style counterpart
    /// of <see cref="DesignerTableCellEditor"/>. A column's size lives in the Nth
    /// <c>&lt;panel&gt;.ColumnStyles.Add(new System.Windows.Forms.ColumnStyle(SizeType.Percent, 25F))</c> statement
    /// (VS emits one Add per column/row, in order — so the ordinal is the column/row index). Editing a style means
    /// rewriting ONLY that one <c>new ColumnStyle(...)</c>'s argument list to a canonical
    /// <c>(SizeType.&lt;name&gt;, &lt;value&gt;F)</c> (or <c>(SizeType.AutoSize)</c>) — a minimal, byte-local text edit
    /// that never regenerates InitializeComponent and never interpolates arbitrary source.
    ///
    /// Safety mirrors <see cref="DesignerTableCellEditor.OnlyTableCellChanged"/>: the SizeType is a validated enum
    /// MEMBER NAME (one of Absolute/Percent/AutoSize — never free text), the value is a non-negative number emitted as
    /// a plain <c>NNNf</c> literal, and <see cref="OnlyTableStyleChanged"/> verifies every OTHER statement is
    /// byte-identical, the target axis keeps the same number of styles, every non-edited style is byte-identical, and
    /// the edited style is still a valid <c>new ColumnStyle/RowStyle(SizeType.&lt;valid&gt;[, &lt;numeric&gt;])</c>.
    /// </summary>
    public static class DesignerTableStyleEditor
    {
        private static readonly HashSet<string> SizeTypes = new(StringComparer.OrdinalIgnoreCase) { "Absolute", "Percent", "AutoSize" };

        /// <summary>Read every column + row sizing style of <paramref name="panelId"/> in source order.</summary>
        public static TableStylesResult ReadStyles(string sourceText, string panelId)
        {
            var result = new List<TableStyleInfo>();
            if (!IsIdentifier(panelId)) return new TableStylesResult { Found = false };
            var init = FindInitializeComponent(sourceText);
            if (init?.Body == null) return new TableStylesResult { Found = false };

            foreach (var axis in new[] { "Column", "Row" })
            {
                int i = 0;
                foreach (var oce in StyleCtors(init, panelId, axis))
                {
                    result.Add(new TableStyleInfo
                    {
                        Axis = axis,
                        Index = i++,
                        SizeType = ReadSizeType(oce) ?? "Absolute",
                        Value = ReadValue(oce) ?? 0,
                    });
                }
            }
            return new TableStylesResult { Found = result.Count > 0, Styles = result };
        }

        public static EditResult SetStyle(string sourceText, string panelId, string axis, int index, string? sizeType, double? value)
        {
            if (!IsIdentifier(panelId)) return Failed("invalid panel id: " + panelId);
            if (axis is not ("Column" or "Row")) return Failed("axis must be Column or Row");
            if (index < 0) return Failed("index must be >= 0");
            if (sizeType != null && !SizeTypes.Contains(sizeType)) return Failed("invalid size type: " + sizeType);
            if (value is < 0) return Failed("value must be >= 0");
            if (value is double dv && (double.IsNaN(dv) || double.IsInfinity(dv))) return Failed("value must be finite");
            if (sizeType == null && value == null) return Failed("nothing to set (pass sizeType and/or value)");

            var init = FindInitializeComponent(sourceText);
            if (init?.Body == null) return Failed("InitializeComponent not found");

            var ctors = StyleCtors(init, panelId, axis).ToList();
            if (index >= ctors.Count)
                return Failed($"no {axis} style at index {index} for {panelId} (has {ctors.Count})");
            var target = ctors[index];

            // resolve the effective new (sizeType, value): keep whatever the caller didn't pass.
            string curType = ReadSizeType(target) ?? "Absolute";
            string newType = NormalizeSizeType(sizeType ?? curType);
            double newValue = value ?? ReadValue(target) ?? 50;

            string argText = newType == "AutoSize"
                ? "(System.Windows.Forms.SizeType.AutoSize)"
                : "(System.Windows.Forms.SizeType." + newType + ", " + FormatValue(newValue) + ")";

            var al = target.ArgumentList;
            if (al == null) return Failed("style has no argument list");
            string text = sourceText.Substring(0, al.SpanStart) + argText + sourceText.Substring(al.Span.End);
            return new EditResult { NewText = text, Mode = EditMode.Replace };
        }

        /// <summary>§6.5 gate: every non-style statement is byte-identical (multiset), the target axis has the SAME
        /// number of styles before/after, every style EXCEPT the edited index is byte-identical, and the edited style
        /// is a valid <c>new &lt;ColumnStyle|RowStyle&gt;(SizeType.&lt;valid&gt;[, &lt;numeric&gt;])</c> for this panel/axis.</summary>
        public static bool OnlyTableStyleChanged(string original, string edited, string panelId, string axis, int index)
        {
            var (oNon, oCtors) = Classify(original, panelId, axis);
            var (eNon, eCtors) = Classify(edited, panelId, axis);
            if (!MultisetEqual(oNon, eNon)) return false;         // nothing outside this axis's styles changed
            if (oCtors.Count != eCtors.Count) return false;       // no style added/removed
            if (index < 0 || index >= eCtors.Count) return false;
            // every style EXCEPT the edited index must be byte-identical. The edited index is NOT required to differ
            // (a no-op re-apply of the current value is a safe no-op, matching SetTableCell/ResetProperty) — it is only
            // required to be a well-formed, safe style ctor (checked below), so nothing else could have moved.
            for (int i = 0; i < oCtors.Count; i++)
                if (i != index && NormalizeStmt(oCtors[i].ToString()) != NormalizeStmt(eCtors[i].ToString())) return false;
            return IsValidStyleCtor(eCtors[index], axis);         // edited style is well-formed + safe
        }

        // ---- classification / matching ----

        /// <summary>Non-style statements (whitespace-normalized) + the ordered <c>new ColumnStyle/RowStyle(...)</c>
        /// object-creations for <paramref name="panelId"/> on <paramref name="axis"/>. Every statement that is NOT one
        /// of this panel/axis's style Adds falls into nonTarget — so a change anywhere else trips MultisetEqual.</summary>
        private static (List<string> nonTarget, List<ObjectCreationExpressionSyntax> ctors) Classify(string code, string panelId, string axis)
        {
            var non = new List<string>();
            var ctors = new List<ObjectCreationExpressionSyntax>();
            var init = FindInitializeComponent(code);
            if (init?.Body != null)
            {
                foreach (var st in init.Body.Statements)
                {
                    if (st is ExpressionStatementSyntax es && es.Expression is InvocationExpressionSyntax inv
                        && StyleAddCtor(inv, panelId, axis) is { } oce)
                        ctors.Add(oce);
                    else
                        non.Add(NormalizeStmt(st.ToString()));
                }
            }
            return (non, ctors);
        }

        /// <summary>The ordered style ctors for a panel/axis, straight from the InitializeComponent body.</summary>
        private static IEnumerable<ObjectCreationExpressionSyntax> StyleCtors(MethodDeclarationSyntax init, string panelId, string axis)
        {
            foreach (var st in init.Body!.Statements)
                if (st is ExpressionStatementSyntax es && es.Expression is InvocationExpressionSyntax inv
                    && StyleAddCtor(inv, panelId, axis) is { } oce)
                    yield return oce;
        }

        /// <summary>When <paramref name="inv"/> is <c>&lt;panelId&gt;.&lt;axis&gt;Styles.Add(new &lt;axis&gt;Style(...))</c>,
        /// returns the inner object-creation; otherwise null.</summary>
        private static ObjectCreationExpressionSyntax? StyleAddCtor(InvocationExpressionSyntax inv, string panelId, string axis)
        {
            if (inv.Expression is not MemberAccessExpressionSyntax ma || ma.Name.Identifier.Text != "Add") return null;
            if (ma.Expression is not MemberAccessExpressionSyntax coll || coll.Name.Identifier.Text != axis + "Styles") return null;
            var chain = Flatten(coll.Expression); // the receiver before ".ColumnStyles"
            if (chain.Count != 1 || chain[0] != panelId) return null;
            var args = inv.ArgumentList.Arguments;
            if (args.Count != 1) return null;
            if (args[0].Expression is not ObjectCreationExpressionSyntax oce) return null;
            return LastName(oce.Type.ToString()) == axis + "Style" ? oce : null;
        }

        /// <summary>True when <paramref name="oce"/> is a well-formed, safe <c>new ColumnStyle/RowStyle(...)</c>: the
        /// type matches the axis, arg0 is a SizeType enum MEMBER (Absolute/Percent/AutoSize), and there is either no
        /// second arg (AutoSize form) or exactly one numeric-literal second arg — so no expression was injected.</summary>
        private static bool IsValidStyleCtor(ObjectCreationExpressionSyntax oce, string axis)
        {
            if (LastName(oce.Type.ToString()) != axis + "Style") return false;
            var args = oce.ArgumentList?.Arguments;
            if (args == null || args.Value.Count is < 1 or > 2) return false;
            var type = ReadSizeType(oce);
            if (type == null || !SizeTypes.Contains(type)) return false;
            if (args.Value.Count == 2 && !IsNonNegNumericLiteral(args.Value[1].Expression)) return false;
            return true;
        }

        private static string? ReadSizeType(ObjectCreationExpressionSyntax oce)
        {
            var args = oce.ArgumentList?.Arguments;
            if (args == null || args.Value.Count < 1) return null;
            // arg0 is SizeType.X (possibly fully qualified) → the trailing member name is the enum value
            string name = LastName(args.Value[0].Expression.ToString());
            return SizeTypes.Contains(name) ? name : null;
        }

        private static double? ReadValue(ObjectCreationExpressionSyntax oce)
        {
            var args = oce.ArgumentList?.Arguments;
            if (args == null || args.Value.Count < 2) return null;
            return ParseNumericLiteral(args.Value[1].Expression);
        }

        private static bool IsNonNegNumericLiteral(ExpressionSyntax e) => ParseNumericLiteral(e) is >= 0;

        /// <summary>Parse a numeric literal (int or float, with optional F/D/M suffix) to a double, or null.</summary>
        private static double? ParseNumericLiteral(ExpressionSyntax e)
        {
            if (e is not LiteralExpressionSyntax lit || !lit.IsKind(SyntaxKind.NumericLiteralExpression)) return null;
            string t = lit.Token.Text.TrimEnd('f', 'F', 'd', 'D', 'm', 'M');
            return double.TryParse(t, NumberStyles.Float, CultureInfo.InvariantCulture, out var v) ? v : (double?)null;
        }

        private static string NormalizeSizeType(string s) =>
            SizeTypes.FirstOrDefault(x => string.Equals(x, s, StringComparison.OrdinalIgnoreCase)) ?? s;

        /// <summary>Emit a size value as an invariant <c>NNNf</c> literal (e.g. 25 → "25F", 33.5 → "33.5F").</summary>
        private static string FormatValue(double v) => v.ToString("R", CultureInfo.InvariantCulture) + "F";

        // ---- helpers (kept local so the proven editors stay untouched, §6.5) ----

        private static EditResult Failed(string reason) => new() { Mode = EditMode.Failed, Reason = reason };

        private static bool IsIdentifier(string s) => !string.IsNullOrEmpty(s) && SyntaxFacts.IsValidIdentifier(s);

        private static string LastName(string dotted)
        {
            int i = dotted.LastIndexOf('.');
            return i < 0 ? dotted.Trim() : dotted.Substring(i + 1).Trim();
        }

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
