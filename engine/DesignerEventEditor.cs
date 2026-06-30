using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace WinFormsDesigner.Engine
{
    /// <summary>Result of <see cref="DesignerRenderer.GenerateEventHandler"/>: the (optional) new texts for
    /// the .Designer.cs (wiring) and the .cs code-behind (stub), plus the resolved handler name. Null text
    /// means "no change to that file". <see cref="AlreadyWired"/> = the event already had a handler (the
    /// designer was left untouched; navigate to it). The host applies the texts as unsaved WorkspaceEdits.</summary>
    public sealed class EventGenResult
    {
        public bool Safe { get; init; }
        public string Reason { get; init; } = "";
        public string HandlerName { get; init; } = "";
        public bool AlreadyWired { get; init; }
        public string? DesignerText { get; init; }
        public string? CodeText { get; init; }
        public bool StubCreated { get; init; }
    }

    /// <summary>One event's compatible code-behind handler methods (events-dropdown data). Returned as a LIST
    /// (not a Dictionary) because the JSON-RPC camelCase resolver would lowercase dictionary KEYS, mangling
    /// event names like "Click" → "click"; here the name is a property VALUE and is preserved.</summary>
    public sealed class EventCandidates
    {
        public string Event { get; init; } = "";
        public List<string> Handlers { get; init; } = new();
    }

    /// <summary>Result of <see cref="DesignerRenderer.SetEventWiring"/>: the new .Designer.cs text after a
    /// wire/rewire/unwire (the events-dropdown write path; code-behind is not touched). Null text on reject.</summary>
    public sealed class EventWiringResult
    {
        public bool Safe { get; init; }
        public string Reason { get; init; } = "";
        public string HandlerName { get; init; } = "";
        public string? DesignerText { get; init; }
    }

    /// <summary>
    /// Targeted, byte-minimal edits for the EVENTS side (mirrors <see cref="DesignerPropertyEditor"/> for
    /// properties, but kept SEPARATE so the proven property-edit path is untouched — §6.5 sensitive):
    ///   • <see cref="WireEvent"/>      — add one <c>this.comp.Event += new Delegate(this.handler);</c>
    ///                                    statement to InitializeComponent (.Designer.cs), nothing else.
    ///   • <see cref="GenerateHandlerStub"/> — insert one empty handler method into the form's partial
    ///                                    class in the code-behind (.cs); purely additive at the class end.
    /// Both are text inserts (no re-serialize), so they work even on files that don't fully round-trip.
    /// Safety is enforced by <see cref="OnlyWiringAdded"/> (designer) and a parse check + additive-by-
    /// construction insert (code-behind).
    /// </summary>
    public static class DesignerEventEditor
    {
        // ---- (a) wire an event in InitializeComponent (.Designer.cs) ----

        /// <summary>
        /// Insert <c>this.&lt;comp&gt;.&lt;evt&gt; += new &lt;delegateFqn&gt;(this.&lt;handler&gt;);</c> after the
        /// component's last statement in InitializeComponent. Root form uses <c>this.&lt;evt&gt; += …</c>.
        /// Returns <see cref="EditMode.Failed"/> when there is no anchor statement for the component (the
        /// caller can fall back / report). Never replaces — events are always added.
        /// </summary>
        public static EditResult WireEvent(string src, string comp, string evt, string delegateFqn, string handler)
        {
            bool isRoot = comp is "this" or "";
            // §6.5: comp/evt/handler are interpolated into generated C# — reject anything that isn't a plain
            // identifier so a crafted name can't inject statements / break out of the wiring expression.
            if (!isRoot && !IsValidIdentifier(comp))
                return new EditResult { Mode = EditMode.Failed, Reason = "component name is not a valid identifier: " + comp };
            if (!IsValidIdentifier(evt))
                return new EditResult { Mode = EditMode.Failed, Reason = "event name is not a valid identifier: " + evt };
            if (!IsValidIdentifier(handler))
                return new EditResult { Mode = EditMode.Failed, Reason = "handler name is not a valid identifier: " + handler };
            var init = FindInitializeComponent(src);
            if (init?.Body == null)
            {
                return new EditResult { Mode = EditMode.Failed, Reason = "InitializeComponent not found" };
            }

            // anchor on the LAST statement that assigns/wires the component (or any top-level this.X for root)
            ExpressionStatementSyntax? anchor = null;
            foreach (var st in init.Body.Statements)
            {
                if (st is not ExpressionStatementSyntax es || es.Expression is not AssignmentExpressionSyntax asg) continue;
                var chain = Flatten(asg.Left);
                if (OwnerMatches(chain, comp, isRoot)) anchor = es;
            }
            if (anchor == null)
            {
                return new EditResult
                {
                    Mode = EditMode.Failed,
                    Reason = "no existing statement for '" + comp + "' to anchor the event wiring"
                };
            }

            string nl = src.Contains("\r\n") ? "\r\n" : "\n";
            string indent = LeadingIndent(src, anchor.SpanStart);
            string lhs = isRoot ? "this." + evt : "this." + comp + "." + evt;
            string stmtLine = indent + lhs + " += new " + delegateFqn + "(this." + handler + ");" + nl;

            // insert at the START of the line AFTER the anchor (past its own trailing comment/trivia)
            int afterSemi = anchor.Span.End;
            int nlIdx = src.IndexOf('\n', afterSemi);
            int insertPos = nlIdx < 0 ? src.Length : nlIdx + 1;
            string inserted = src.Substring(0, insertPos) + stmtLine + src.Substring(insertPos);
            return new EditResult { NewText = inserted, Mode = EditMode.Insert };
        }

        /// <summary>
        /// §6.5 gate for a wiring insert: the edited InitializeComponent must equal the original PLUS exactly
        /// one new <c>+=</c> statement for (comp, evt); every other statement byte-identical (compared with
        /// whitespace stripped, like the property gate). Rejects "wired something else" / "touched more".
        /// </summary>
        public static bool OnlyWiringAdded(string original, string edited, string comp, string evt) =>
            OnlyWiringChanged(original, edited, comp, evt, 1);

        /// <summary>General §6.5 gate for any wiring edit: every NON-(comp,evt) statement is byte-identical
        /// (whitespace-normalized multiset), AND the count of (comp,evt) wiring statements changed by exactly
        /// <paramref name="targetDelta"/> (+1 add, -1 unwire, 0 rewire). The (comp,evt) statement content is
        /// safe by construction (handler is identifier-validated, delegate from reflection), so only the rest
        /// needs pinning. Mirrors DesignerPropertyEditor.OnlyTargetChanged.</summary>
        public static bool OnlyWiringChanged(string original, string edited, string comp, string evt, int targetDelta)
        {
            bool isRoot = comp is "this" or "";
            var (origNon, origCnt) = ClassifyWirings(original, comp, evt, isRoot);
            var (editNon, editCnt) = ClassifyWirings(edited, comp, evt, isRoot);
            if (editCnt != origCnt + targetDelta) return false;
            return MultisetEqual(origNon, editNon);
        }

        /// <summary>
        /// Wire / rewire / unwire an event (used by the events dropdown, .Designer.cs only — the chosen
        /// handler must already exist in code, so no stub is generated here):
        ///   • handler == null      → remove the existing (comp,evt) wiring (unwire)
        ///   • handler, no wiring    → add a wiring (like WireEvent)
        ///   • handler, has wiring   → replace the existing wiring's handler (rewire)
        /// Returns Failed when there's nothing to do / no anchor. Identifier-validated like WireEvent.
        /// </summary>
        public static EditResult SetEventWiring(string src, string comp, string evt, string? handler, string delegateFqn)
        {
            bool isRoot = comp is "this" or "";
            if (!isRoot && !IsValidIdentifier(comp))
                return new EditResult { Mode = EditMode.Failed, Reason = "component name is not a valid identifier: " + comp };
            if (!IsValidIdentifier(evt))
                return new EditResult { Mode = EditMode.Failed, Reason = "event name is not a valid identifier: " + evt };
            if (handler != null && !IsValidIdentifier(handler))
                return new EditResult { Mode = EditMode.Failed, Reason = "handler name is not a valid identifier: " + handler };

            var init = FindInitializeComponent(src);
            if (init?.Body == null)
                return new EditResult { Mode = EditMode.Failed, Reason = "InitializeComponent not found" };

            ExpressionStatementSyntax? existing = null;
            foreach (var st in init.Body.Statements)
            {
                if (st is ExpressionStatementSyntax es && es.Expression is AssignmentExpressionSyntax asg
                    && asg.IsKind(SyntaxKind.AddAssignmentExpression) && WiringMatches(Flatten(asg.Left), comp, evt, isRoot))
                    existing = es;
            }

            if (handler == null)
            {
                if (existing == null)
                    return new EditResult { Mode = EditMode.Failed, Reason = "event is not wired" };
                return new EditResult { NewText = RemoveStatementLine(src, existing), Mode = EditMode.Replace };
            }

            if (existing != null)
            {
                // rewire: swap only the right-hand side (new Delegate(this.handler)) of the existing statement
                var asg = (AssignmentExpressionSyntax)existing.Expression;
                int s = asg.Right.SpanStart, e = asg.Right.Span.End;
                string newRhs = "new " + delegateFqn + "(this." + handler + ")";
                return new EditResult { NewText = src.Substring(0, s) + newRhs + src.Substring(e), Mode = EditMode.Replace };
            }

            return WireEvent(src, comp, evt, delegateFqn, handler); // not wired → add
        }

        /// <summary>Delete a whole statement line (from its line start through the trailing newline).</summary>
        private static string RemoveStatementLine(string src, StatementSyntax st)
        {
            int lineStart = src.LastIndexOf('\n', Math.Max(0, st.SpanStart - 1)) + 1;
            int afterSemi = st.Span.End;
            int nlIdx = src.IndexOf('\n', afterSemi);
            int lineEnd = nlIdx < 0 ? src.Length : nlIdx + 1;
            return src.Substring(0, lineStart) + src.Substring(lineEnd);
        }

        /// <summary>Methods in the FORM class whose signature matches an event delegate: same parameter count,
        /// matching parameter type simple-names, and the same void-ness. Best-effort syntactic match (no
        /// semantic model) — good enough to offer "compatible handlers" in the dropdown.</summary>
        public static List<string> FindCompatibleHandlers(string codeText, string formClassName,
            IReadOnlyList<string> paramTypeNames, bool returnsVoid)
        {
            var result = new List<string>();
            var root = CSharpSyntaxTree.ParseText(codeText).GetRoot();
            var cls = root.DescendantNodes().OfType<ClassDeclarationSyntax>().FirstOrDefault(c => c.Identifier.Text == formClassName);
            if (cls == null) return result;
            foreach (var m in cls.Members.OfType<MethodDeclarationSyntax>())
            {
                var ps = m.ParameterList.Parameters;
                if (ps.Count != paramTypeNames.Count) continue;
                bool mVoid = m.ReturnType is PredefinedTypeSyntax pt && pt.Keyword.IsKind(SyntaxKind.VoidKeyword);
                if (mVoid != returnsVoid) continue;
                bool ok = true;
                for (int i = 0; i < ps.Count; i++)
                {
                    if (!TypeSimpleNameMatches(ps[i].Type?.ToString() ?? "", paramTypeNames[i])) { ok = false; break; }
                }
                if (ok) result.Add(m.Identifier.Text);
            }
            return result;
        }

        /// <summary>Compare a syntactic parameter type (e.g. "object", "System.EventArgs", "MouseEventArgs")
        /// against a reflected type's simple Name (e.g. "Object", "EventArgs", "MouseEventArgs").</summary>
        private static bool TypeSimpleNameMatches(string syntacticType, string reflectedName)
        {
            string s = syntacticType.Trim();
            int dot = s.LastIndexOf('.');
            if (dot >= 0) s = s.Substring(dot + 1);
            // map C# keyword aliases to their CLR type Name
            s = s switch
            {
                "object" => "Object", "string" => "String", "bool" => "Boolean", "int" => "Int32",
                "long" => "Int64", "short" => "Int16", "byte" => "Byte", "double" => "Double",
                "float" => "Single", "char" => "Char", "decimal" => "Decimal", "uint" => "UInt32",
                _ => s,
            };
            return string.Equals(s, reflectedName, StringComparison.Ordinal);
        }

        private static (List<string> nonTarget, int targetCount) ClassifyWirings(string code, string comp, string evt, bool isRoot)
        {
            var nonTarget = new List<string>();
            int targetCount = 0;
            var init = FindInitializeComponent(code);
            if (init?.Body != null)
            {
                foreach (var st in init.Body.Statements)
                {
                    if (IsWiringTarget(st, comp, evt, isRoot)) targetCount++;
                    else nonTarget.Add(NormalizeStmt(st.ToString()));
                }
            }
            return (nonTarget, targetCount);
        }

        private static bool IsWiringTarget(StatementSyntax st, string comp, string evt, bool isRoot) =>
            st is ExpressionStatementSyntax { Expression: AssignmentExpressionSyntax asg }
            && asg.IsKind(SyntaxKind.AddAssignmentExpression)
            && WiringMatches(Flatten(asg.Left), comp, evt, isRoot);

        private static bool WiringMatches(List<string> chain, string comp, string evt, bool isRoot) =>
            isRoot ? (chain.Count == 1 && chain[0] == evt)
                   : (chain.Count == 2 && chain[0] == comp && chain[1] == evt);

        // ---- (b) generate a handler stub in the code-behind (.cs) ----

        /// <summary>True when the FORM class (by name) already declares a method with this name. Scoped to the
        /// target class so a same-named method in a nested/other class doesn't mask a missing handler.</summary>
        public static bool HasMethod(string codeText, string formClassName, string name)
        {
            var root = CSharpSyntaxTree.ParseText(codeText).GetRoot();
            var cls = root.DescendantNodes().OfType<ClassDeclarationSyntax>().FirstOrDefault(c => c.Identifier.Text == formClassName);
            return cls != null && cls.Members.OfType<MethodDeclarationSyntax>().Any(m => m.Identifier.Text == name);
        }

        /// <summary>A plain C# identifier (letter/underscore start, then letters/digits/underscore). Used to
        /// reject crafted component/event/handler names before they're interpolated into generated code.</summary>
        public static bool IsValidIdentifier(string s)
        {
            if (string.IsNullOrEmpty(s)) return false;
            if (!(char.IsLetter(s[0]) || s[0] == '_')) return false;
            for (int i = 1; i < s.Length; i++)
                if (!(char.IsLetterOrDigit(s[i]) || s[i] == '_')) return false;
            return true;
        }

        public sealed class StubResult
        {
            public bool Ok { get; init; }
            public string? NewText { get; init; }
            public string Reason { get; init; } = "";
        }

        /// <summary>
        /// Insert <c>private void &lt;handler&gt;(&lt;params&gt;) { &lt;blank line&gt; }</c> as the LAST member of the
        /// form's partial class in the code-behind. Additive by construction (a string insert before the
        /// class close-brace); verified to still parse. Returns Failed if the class isn't found or the
        /// result doesn't parse (then the caller skips the code edit).
        /// </summary>
        public static StubResult GenerateHandlerStub(string codeText, string formClassName, string handler,
            string returnTypeFqn, IReadOnlyList<(string type, string name)> parameters)
        {
            if (!IsValidIdentifier(handler))
            {
                return new StubResult { Ok = false, Reason = "handler name is not a valid identifier: " + handler };
            }
            var root = CSharpSyntaxTree.ParseText(codeText).GetRoot();
            // require the form class BY NAME — never fall back to "the first class", which could insert the
            // stub into a nested/helper class and corrupt the file.
            var cls = root.DescendantNodes().OfType<ClassDeclarationSyntax>()
                .FirstOrDefault(c => c.Identifier.Text == formClassName);
            if (cls == null)
            {
                return new StubResult { Ok = false, Reason = "form class '" + formClassName + "' not found in code-behind" };
            }

            string nl = codeText.Contains("\r\n") ? "\r\n" : "\n";
            // member indent: an existing member's indent, else the class indent + 4 spaces
            string classIndent = LeadingIndent(codeText, cls.SpanStart);
            string memberIndent = cls.Members.Count > 0
                ? LeadingIndent(codeText, cls.Members[0].SpanStart)
                : classIndent + "    ";

            string paramList = string.Join(", ", parameters.Select(p => p.type + " " + p.name));
            string method =
                nl + memberIndent + "private " + returnTypeFqn + " " + handler + "(" + paramList + ")" + nl
                + memberIndent + "{" + nl
                + memberIndent + nl                  // empty body line — the caret lands here (VS-style)
                + memberIndent + "}" + nl;

            // insert just before the class's closing brace (additive — keeps every existing member intact)
            int insertPos = cls.CloseBraceToken.SpanStart;
            int lineStart = codeText.LastIndexOf('\n', Math.Max(0, insertPos - 1)) + 1;
            // insert at the START of the close-brace's line (before its indent) so the new method is the
            // last member and the brace stays on its own line — additive, every existing member intact.
            string edited = codeText.Substring(0, lineStart) + method + codeText.Substring(lineStart);

            bool parseOk = !CSharpSyntaxTree.ParseText(edited).GetDiagnostics()
                .Any(d => d.Severity == DiagnosticSeverity.Error);
            if (!parseOk)
            {
                return new StubResult { Ok = false, Reason = "generated stub did not parse" };
            }
            return new StubResult { Ok = true, NewText = edited };
        }

        // ---- shared syntax helpers (own copies — DesignerPropertyEditor stays untouched, §6.5) ----

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

        private static string NormalizeStmt(string s) => new string(s.Where(c => !char.IsWhiteSpace(c)).ToArray());

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

        private static string LeadingIndent(string text, int pos)
        {
            int lineStart = text.LastIndexOf('\n', Math.Max(0, pos - 1)) + 1;
            int i = lineStart;
            while (i < text.Length && (text[i] == ' ' || text[i] == '\t')) i++;
            return text.Substring(lineStart, i - lineStart);
        }

        private static bool OwnerMatches(List<string> chain, string comp, bool isRoot) =>
            isRoot ? chain.Count == 1 : (chain.Count == 2 && chain[0] == comp);

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
