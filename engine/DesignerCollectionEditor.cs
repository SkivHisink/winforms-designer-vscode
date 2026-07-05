using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace WinFormsDesigner.Engine
{
    /// <summary>Read side of the string-collection editor: the current items and whether the collection is
    /// editable (every element is a plain string literal — a bound/complex collection is surfaced read-only so
    /// editing can't silently drop non-literal entries).</summary>
    public sealed class CollectionItemsResult
    {
        /// <summary>True when the (owner, property) collection consists solely of string-literal items and can be
        /// edited safely. False when an element isn't a literal (e.g. a data-bound or object collection) — the
        /// webview keeps the field read-only rather than risk losing the non-literal entries.</summary>
        public bool Ok { get; init; }
        public List<string> Items { get; init; } = new();
        public string Reason { get; init; } = "";
    }

    /// <summary>
    /// Targeted edit of a string-item collection — the VS "String Collection Editor" for
    /// <c>ComboBox/ListBox/CheckedListBox.Items</c>. Those collections serialize as
    /// <c>this.comboBox1.Items.AddRange(new object[] { "a", "b" });</c> (or one-off <c>.Items.Add("x")</c>),
    /// so editing the list means rewriting exactly those <c>Add</c>/<c>AddRange</c> calls for that owner+property
    /// and leaving every other statement byte-identical.
    ///
    /// Like <see cref="DesignerTableCellEditor"/>, this is a minimal, byte-local rewrite that never regenerates
    /// InitializeComponent: whole collection statements are replaced/removed via Roslyn node surgery (untouched
    /// nodes keep their exact trivia), the new item strings are emitted through <see cref="SyntaxFactory.Literal(string)"/>
    /// (so any value is correctly escaped and no expression can be injected), and <see cref="OnlyCollectionChanged"/>
    /// verifies the edit touched ONLY that collection and wrote only string literals.
    /// </summary>
    public static class DesignerCollectionEditor
    {
        // ---- read ----

        /// <summary>The collection's current string items, in source order, aggregated across all its
        /// <c>Add</c>/<c>AddRange</c> calls. <see cref="CollectionItemsResult.Ok"/> is false when any element is
        /// not a string literal (don't offer editing) or InitializeComponent can't be found.</summary>
        public static CollectionItemsResult ListItems(string sourceText, string ownerId, string prop)
        {
            if (!IsIdentifier(ownerId)) return new CollectionItemsResult { Ok = false, Reason = "invalid owner id: " + ownerId };
            if (!IsIdentifier(prop)) return new CollectionItemsResult { Ok = false, Reason = "invalid property name: " + prop };

            var init = FindInitializeComponent(CSharpSyntaxTree.ParseText(sourceText).GetRoot());
            if (init?.Body == null) return new CollectionItemsResult { Ok = false, Reason = "InitializeComponent not found" };

            var items = new List<string>();
            foreach (var st in init.Body.Statements)
            {
                if (!IsCollectionCall(st, ownerId, prop, out var inv, out var method)) continue;
                var args = inv!.ArgumentList.Arguments;
                if (method == "Add")
                {
                    if (args.Count != 1 || !TryStringLiteral(args[0].Expression, out var v))
                        return new CollectionItemsResult { Ok = false, Reason = "non-literal item in " + ownerId + "." + prop };
                    items.Add(v!);
                }
                else // AddRange
                {
                    var elems = ArrayElements(args.Count == 1 ? args[0].Expression : null);
                    if (elems == null)
                        return new CollectionItemsResult { Ok = false, Reason = "unexpected AddRange shape in " + ownerId + "." + prop };
                    foreach (var el in elems)
                    {
                        if (!TryStringLiteral(el, out var v))
                            return new CollectionItemsResult { Ok = false, Reason = "non-literal item in " + ownerId + "." + prop };
                        items.Add(v!);
                    }
                }
            }
            return new CollectionItemsResult { Ok = true, Items = items };
        }

        // ---- write ----

        /// <summary>Rewrite the collection to exactly <paramref name="items"/>: consolidate all existing
        /// <c>Add</c>/<c>AddRange</c> calls for <paramref name="ownerId"/>.<paramref name="prop"/> into a single
        /// canonical <c>AddRange(new object[] { … })</c> in place of the FIRST such call (removing the rest); when
        /// <paramref name="items"/> is empty, all calls are removed; when none existed, a new AddRange is inserted
        /// after the owner's last statement. All non-collection statements keep their exact text.</summary>
        public static EditResult SetItems(string sourceText, string ownerId, string prop, IReadOnlyList<string> items)
        {
            if (!IsIdentifier(ownerId)) return Failed("invalid owner id: " + ownerId);
            if (!IsIdentifier(prop)) return Failed("invalid property name: " + prop);

            var root = CSharpSyntaxTree.ParseText(sourceText).GetRoot();
            var init = FindInitializeComponent(root);
            if (init?.Body == null) return Failed("InitializeComponent not found");

            var targets = init.Body.Statements
                .Where(st => IsCollectionCall(st, ownerId, prop, out _, out _))
                .ToList();

            if (targets.Count == 0 && items.Count == 0)
                return new EditResult { NewText = sourceText, Mode = EditMode.Replace }; // no-op

            if (targets.Count > 0)
            {
                // rebuild the statement list: replace the FIRST collection call with the canonical AddRange
                // (inheriting its indentation + trailing newline), drop the rest, keep everything else verbatim.
                var first = targets[0];
                string indent = LineIndent(first);
                ExpressionStatementSyntax? canon = items.Count > 0 ? BuildAddRange(ownerId, prop, items, indent) : null;

                var newStatements = new List<StatementSyntax>();
                bool placed = false;
                foreach (var st in init.Body.Statements)
                {
                    if (ReferenceEquals(st, first))
                    {
                        if (canon != null)
                        {
                            newStatements.Add(canon.WithLeadingTrivia(st.GetLeadingTrivia()).WithTrailingTrivia(st.GetTrailingTrivia()));
                            placed = true;
                        }
                    }
                    else if (targets.Any(t => ReferenceEquals(t, st)))
                    {
                        // a later collection call — drop it (its items were folded into the canonical AddRange)
                    }
                    else newStatements.Add(st);
                }
                _ = placed;
                var newInit = init.WithBody(init.Body.WithStatements(SyntaxFactory.List(newStatements)));
                return new EditResult { NewText = root.ReplaceNode(init, newInit).ToFullString(), Mode = EditMode.Replace };
            }

            // no existing collection call: insert a new AddRange after the owner's last property statement (its
            // config block, matching VS placement); fall back to any statement mentioning it (e.g. Controls.Add).
            var anchor = init.Body.Statements.LastOrDefault(st => TargetsOwner(st, ownerId))
                      ?? init.Body.Statements.LastOrDefault(st => MentionsIdentifier(st, ownerId));
            if (anchor == null) return Failed("no statement references " + ownerId + " to anchor the new items");
            string aindent = LineIndent(anchor);
            var stmt = BuildAddRange(ownerId, prop, items, aindent)
                .WithLeadingTrivia(SyntaxFactory.Whitespace(aindent))
                .WithTrailingTrivia(SyntaxFactory.CarriageReturnLineFeed);
            return new EditResult { NewText = root.InsertNodesAfter(anchor, new[] { stmt }).ToFullString(), Mode = EditMode.Insert };
        }

        /// <summary>safe-save gate: every statement EXCEPT the collection's own <c>Add</c>/<c>AddRange</c> calls is
        /// byte-identical (multiset), and every collection call that remains after the edit is a safe
        /// string-literal-only <c>Add</c>/<c>AddRange</c> on <paramref name="ownerId"/>.<paramref name="prop"/> —
        /// so nothing else moved and no non-literal expression was injected into the list.</summary>
        public static bool OnlyCollectionChanged(string original, string edited, string ownerId, string prop)
        {
            var (oNon, _) = Classify(original, ownerId, prop);
            var (eNon, eTgts) = Classify(edited, ownerId, prop);
            if (!MultisetEqual(oNon, eNon)) return false;
            foreach (var t in eTgts)
                if (!IsSafeStringCollectionCall(t, ownerId, prop)) return false;
            // Consolidating N collection calls into one drops the later statements — and with them any comment /
            // #region / directive that was attached as their trivia. The non-target multiset above can't see that
            // (dropped statements ARE targets, and NormalizeStmt strips whitespace). So compare the full comment +
            // directive stream of the whole InitializeComponent body: if any comment/directive was lost or added,
            // refuse (read-only fallback) rather than silently delete a developer note.
            if (!MultisetEqual(CommentTrivia(original), CommentTrivia(edited))) return false;
            return true;
        }

        // ---- classification ----

        private static (List<string> nonTarget, List<ExpressionStatementSyntax> targets) Classify(string code, string ownerId, string prop)
        {
            var non = new List<string>();
            var tgts = new List<ExpressionStatementSyntax>();
            var init = FindInitializeComponent(CSharpSyntaxTree.ParseText(code).GetRoot());
            if (init?.Body != null)
            {
                foreach (var st in init.Body.Statements)
                {
                    if (IsCollectionCall(st, ownerId, prop, out _, out _)) tgts.Add((ExpressionStatementSyntax)st);
                    else non.Add(NormalizeStmt(st.ToString()));
                }
            }
            return (non, tgts);
        }

        /// <summary>True for <c>this.&lt;owner&gt;.&lt;prop&gt;.Add(...)</c> / <c>.AddRange(...)</c> — an
        /// Add/AddRange whose receiver flattens to exactly [owner, prop].</summary>
        private static bool IsCollectionCall(StatementSyntax st, string ownerId, string prop, out InvocationExpressionSyntax? inv, out string method)
        {
            inv = null; method = "";
            if (st is not ExpressionStatementSyntax es || es.Expression is not InvocationExpressionSyntax i) return false;
            if (i.Expression is not MemberAccessExpressionSyntax ma) return false;
            var m = ma.Name.Identifier.Text;
            if (m != "Add" && m != "AddRange") return false;
            var chain = Flatten(ma.Expression);
            if (chain.Count != 2 || chain[0] != ownerId || chain[1] != prop) return false;
            inv = i; method = m;
            return true;
        }

        /// <summary>Gate check: the call is <c>owner.prop.Add(&lt;string&gt;)</c> or
        /// <c>owner.prop.AddRange(new object[] { &lt;string&gt;, … })</c> with string-literal-only elements.</summary>
        private static bool IsSafeStringCollectionCall(ExpressionStatementSyntax es, string ownerId, string prop)
        {
            if (!IsCollectionCall(es, ownerId, prop, out var inv, out var method)) return false;
            var args = inv!.ArgumentList.Arguments;
            if (method == "Add")
                return args.Count == 1 && TryStringLiteral(args[0].Expression, out _);
            // AddRange
            var elems = ArrayElements(args.Count == 1 ? args[0].Expression : null);
            if (elems == null) return false;
            foreach (var el in elems)
                if (!TryStringLiteral(el, out _)) return false;
            return true;
        }

        // ---- building ----

        private static ExpressionStatementSyntax BuildAddRange(string ownerId, string prop, IReadOnlyList<string> items, string indent)
        {
            var sb = new StringBuilder();
            sb.Append("this.").Append(ownerId).Append('.').Append(prop).Append(".AddRange(new object[] {\r\n");
            for (int i = 0; i < items.Count; i++)
            {
                sb.Append(indent).Append(SyntaxFactory.Literal(items[i] ?? "").ToString());
                sb.Append(i < items.Count - 1 ? ",\r\n" : "});");
            }
            return (ExpressionStatementSyntax)SyntaxFactory.ParseStatement(sb.ToString());
        }

        private static IReadOnlyList<ExpressionSyntax>? ArrayElements(ExpressionSyntax? arg)
        {
            InitializerExpressionSyntax? init = arg switch
            {
                ArrayCreationExpressionSyntax ac => ac.Initializer,
                ImplicitArrayCreationExpressionSyntax iac => iac.Initializer,
                InitializerExpressionSyntax ie => ie,
                _ => null,
            };
            return init?.Expressions.ToList();
        }

        private static bool TryStringLiteral(ExpressionSyntax expr, out string? value)
        {
            if (expr is LiteralExpressionSyntax lit && lit.IsKind(SyntaxKind.StringLiteralExpression))
            {
                value = lit.Token.ValueText;
                return true;
            }
            value = null;
            return false;
        }

        // ---- helpers (kept local so the proven DesignerPropertyEditor stays untouched) ----

        private static EditResult Failed(string reason) => new() { Mode = EditMode.Failed, Reason = reason };

        private static bool IsIdentifier(string s) => !string.IsNullOrEmpty(s) && SyntaxFacts.IsValidIdentifier(s);

        /// <summary>The leading whitespace of the node's PHYSICAL line — correct even when the node is the second
        /// statement on a shared line (<c>a; b;</c>), where the node's own leading trivia is only the inter-statement
        /// space and would otherwise indent the emitted block at column 0.</summary>
        private static string LineIndent(SyntaxNode node)
        {
            var text = node.SyntaxTree.GetText();
            string lineText = text.Lines.GetLineFromPosition(node.SpanStart).ToString();
            int n = lineText.Length - lineText.TrimStart().Length;
            return lineText.Substring(0, n);
        }

        private static bool MentionsIdentifier(StatementSyntax st, string name) =>
            st.DescendantNodes().OfType<IdentifierNameSyntax>().Any(id => id.Identifier.Text == name);

        /// <summary>True when the statement's assignment target / invocation receiver flattens to start with
        /// <paramref name="owner"/> — i.e. it's part of the owner's own config block (<c>this.owner.X = …</c> /
        /// <c>this.owner.X(…)</c>), NOT merely a statement that mentions the owner as an argument.</summary>
        private static bool TargetsOwner(StatementSyntax st, string owner)
        {
            if (st is not ExpressionStatementSyntax es) return false;
            ExpressionSyntax? lhs = es.Expression switch
            {
                AssignmentExpressionSyntax a => a.Left,
                InvocationExpressionSyntax inv when inv.Expression is MemberAccessExpressionSyntax ma => ma.Expression,
                _ => null,
            };
            if (lhs == null) return false;
            var chain = Flatten(lhs);
            return chain.Count >= 1 && chain[0] == owner;
        }

        private static MethodDeclarationSyntax? FindInitializeComponent(SyntaxNode root)
        {
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

        /// <summary>Every comment + directive (trimmed text) in the InitializeComponent body, as a multiset — the
        /// gate compares these so a consolidated/removed collection call can't silently drop a developer note.</summary>
        private static List<string> CommentTrivia(string code)
        {
            var list = new List<string>();
            var init = FindInitializeComponent(CSharpSyntaxTree.ParseText(code).GetRoot());
            if (init?.Body != null)
            {
                foreach (var tr in init.Body.DescendantTrivia(descendIntoTrivia: true))
                {
                    if (tr.IsKind(SyntaxKind.SingleLineCommentTrivia) || tr.IsKind(SyntaxKind.MultiLineCommentTrivia)
                        || tr.IsKind(SyntaxKind.SingleLineDocumentationCommentTrivia)
                        || tr.IsKind(SyntaxKind.MultiLineDocumentationCommentTrivia) || tr.IsDirective)
                        list.Add(tr.ToString().Trim());
                }
            }
            return list;
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
