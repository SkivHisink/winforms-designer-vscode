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

    /// <summary>Result of <see cref="DesignerPropertyEditor.ResetProperty"/> (VS "Reset" / Dock↔Anchor
    /// mutual-exclusivity): delete a property's assignment(s) so it reverts to its default.</summary>
    public sealed class PropertyResetResult
    {
        /// <summary>The edited text with the (comp, prop) assignment(s) removed. Null both when nothing changed
        /// (already default) and when the reset was rejected — use <see cref="Changed"/>/<see cref="Ok"/>.</summary>
        public string? NewText { get; init; }
        /// <summary>True when an assignment existed AND was removed cleanly (<see cref="NewText"/> carries the result).</summary>
        public bool Changed { get; init; }
        /// <summary>Safe to apply: a clean removal OR a no-op (the property had no assignment, already default).
        /// False only when an assignment existed but the edit failed the parse/gate check.</summary>
        public bool Ok { get; init; }
        public string Reason { get; init; } = "";
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

        /// <summary>
        /// Reset a property to its default by DELETING its assignment statement(s) from InitializeComponent —
        /// the mechanism behind VS's "Reset" and Dock↔Anchor mutual exclusivity (setting Dock clears Anchor and
        /// vice versa). NOTHING is interpolated into the source: only whole target-statement lines are removed,
        /// so this has no value-injection surface. A property with no explicit assignment is already default →
        /// a safe no-op (<see cref="PropertyResetResult.Changed"/> false, <see cref="PropertyResetResult.NewText"/>
        /// null). <see cref="OnlyPropertyReset"/> verifies the edit removed ONLY the target (comp, prop) assignments
        /// and changed nothing else. The root form uses comp "this".
        /// </summary>
        public static PropertyResetResult ResetProperty(string sourceText, string componentName, string propertyName)
        {
            bool isRoot = componentName is "this" or "";
            if (!isRoot && !DesignerControlEditor.IsValidIdentifier(componentName))
                return new PropertyResetResult { Reason = "invalid component id: " + componentName };
            if (!DesignerControlEditor.IsValidIdentifier(propertyName))
                return new PropertyResetResult { Reason = "invalid property name: " + propertyName };

            var init = FindInitializeComponent(sourceText);
            if (init?.Body == null)
                return new PropertyResetResult { Reason = "InitializeComponent not found" };

            var targets = new List<StatementSyntax>();
            foreach (var st in init.Body.Statements)
                if (IsTargetAssignment(st, componentName, propertyName, isRoot))
                    targets.Add(st);

            // no explicit assignment → already default → safe no-op (nothing to remove)
            if (targets.Count == 0)
                return new PropertyResetResult { Ok = true, Changed = false, NewText = null, Reason = "property has no explicit assignment (already default)" };

            var ranges = new List<(int s, int e)>();
            foreach (var st in targets) ranges.Add(LineRange(sourceText, st.SpanStart, st.Span.End));
            ranges.Sort((a, b) => b.s.CompareTo(a.s)); // descending so earlier splices don't shift later offsets
            string text = sourceText;
            // Merge overlapping/duplicate ranges before splicing: two target assignments sharing ONE physical line
            // (a hand-edited "this.x.P = a; this.x.P = b;") yield the IDENTICAL whole-line span, so each physical
            // line must be deleted at most once — otherwise the second splice re-applies the stale (s,e) and eats
            // the bytes that FOLLOW the line (which the gate only sometimes catches, e.g. not a pure-trivia comment).
            int lastStart = int.MaxValue;
            foreach (var (s, e) in ranges)
            {
                if (e > lastStart) continue; // overlaps a line already removed (a lower/equal range) → skip
                text = text.Substring(0, s) + text.Substring(e);
                lastStart = s;
            }

            bool parseOk = !CSharpSyntaxTree.ParseText(text).GetDiagnostics().Any(d => d.Severity == DiagnosticSeverity.Error);
            bool gated = OnlyPropertyReset(sourceText, text, componentName, propertyName);
            bool ok = parseOk && gated;
            return new PropertyResetResult
            {
                Ok = ok,
                Changed = ok,
                NewText = ok ? text : null,
                Reason = ok ? "" : (!parseOk ? "reset text has syntax errors" : "reset changed more than the target property"),
            };
        }

        /// <summary>§6.5 gate for a property reset: the source HAD at least one (comp, prop) assignment, the edit
        /// removed ALL of them (none remain), every OTHER InitializeComponent statement is the same multiset, and
        /// the field declarations are unchanged. A shared-line statement dragged along by the whole-line delete
        /// changes the non-target multiset → rejected (the reset never corrupts, it only declines).</summary>
        public static bool OnlyPropertyReset(string original, string edited, string componentName, string propertyName)
        {
            bool isRoot = componentName is "this" or "";
            var (origNon, origTgt) = Classify(original, componentName, propertyName, isRoot);
            var (editNon, editTgt) = Classify(edited, componentName, propertyName, isRoot);
            if (origTgt == 0) return false;                       // nothing was there to reset
            if (editTgt != 0) return false;                       // every target assignment must be gone
            if (!MultisetEqual(origNon, editNon)) return false;   // no other statement changed
            return MultisetEqual(FieldNames(original), FieldNames(edited)); // fields untouched
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

        // An insert anchor is any statement that names the component: for a child, either its property assignment
        // `this.comp.X = …` (chain [comp, X]) OR its own creation `this.comp = new …` (chain [comp]) — so setting
        // the FIRST property on a component whose only statement is the `new` line still finds an anchor (e.g.
        // importing an Image onto a freshly-added tray component) instead of failing with "no anchor".
        private static bool OwnerMatches(List<string> chain, string comp, bool isRoot) =>
            isRoot ? chain.Count == 1 : ((chain.Count == 1 || chain.Count == 2) && chain[0] == comp);

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

        /// <summary>The whole-line span [start, end) covering a statement — from the start of the line its span
        /// begins on to the start of the line after its span ends (so a multi-line assignment is removed entirely).</summary>
        private static (int s, int e) LineRange(string src, int spanStart, int spanEnd)
        {
            int start = src.LastIndexOf('\n', Math.Max(0, spanStart - 1)) + 1;
            int nl = src.IndexOf('\n', spanEnd);
            int end = nl < 0 ? src.Length : nl + 1;
            return (start, end);
        }

        /// <summary>Field-declaration names of the class that declares InitializeComponent — used by
        /// <see cref="OnlyPropertyReset"/> to assert a reset touched no field declaration.</summary>
        private static List<string> FieldNames(string code)
        {
            var root = CSharpSyntaxTree.ParseText(code).GetRoot();
            var list = new List<string>();
            foreach (var cls in root.DescendantNodes().OfType<ClassDeclarationSyntax>())
            {
                if (!cls.Members.OfType<MethodDeclarationSyntax>().Any(m => m.Identifier.Text == "InitializeComponent")) continue;
                foreach (var f in cls.Members.OfType<FieldDeclarationSyntax>())
                    foreach (var v in f.Declaration.Variables)
                        list.Add(v.Identifier.Text);
                break;
            }
            return list;
        }

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
