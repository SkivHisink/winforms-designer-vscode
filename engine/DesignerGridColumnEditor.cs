using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace WinFormsDesigner.Engine
{
    /// <summary>One column of a <c>DataGridView.Columns</c> collection, as the typed grid-column editor sees it:
    /// the field id (empty for a NEW column) plus the managed properties. The column's concrete type
    /// (DataGridViewTextBoxColumn/…) is preserved from source but not modelled here; a column carrying any
    /// property outside this set is surfaced read-only so the editor can't clobber a value it doesn't round-trip.</summary>
    public sealed class GridColumnItem
    {
        /// <summary>The column's field id (e.g. "nameColumn"); empty/null for a column being ADDED (a fresh id is
        /// generated, and a DataGridViewTextBoxColumn is created). A non-empty id must name an existing column.</summary>
        public string Id { get; set; } = "";
        public string HeaderText { get; set; } = "";
        /// <summary>Column width in pixels (DataGridView column default is 100).</summary>
        public int Width { get; set; } = 100;
        public bool ReadOnly { get; set; }
        public bool Visible { get; set; } = true;
    }

    /// <summary>Read side of the DataGridView.Columns editor. <see cref="Ok"/> is false when a column isn't a plain
    /// named column field with a canonical <c>Name</c> (== field id) and only the managed properties set (e.g. an
    /// inline/cast/initializer construction, a data-bound column with DataPropertyName, or any unmanaged property).</summary>
    public sealed class GridColumnItemsResult
    {
        public bool Ok { get; init; }
        public List<GridColumnItem> Columns { get; init; } = new();
        public string Reason { get; init; } = "";
    }

    /// <summary>
    /// Targeted edit of a <c>DataGridView.Columns</c> collection — the typed counterpart of
    /// <see cref="DesignerListColumnEditor"/> (same named-field-per-item + <c>Columns.AddRange</c> shape), for the
    /// richer DataGridView column model:
    /// <code>
    ///   this.nameColumn = new System.Windows.Forms.DataGridViewTextBoxColumn();
    ///   this.dataGridView1.Columns.AddRange(new System.Windows.Forms.DataGridViewColumn[] { this.nameColumn });
    ///   this.nameColumn.HeaderText = "Name";
    ///   this.nameColumn.Name = "nameColumn";
    /// </code>
    /// Notes vs ListView: the AddRange ARRAY type is the base <c>DataGridViewColumn</c> while each column's
    /// CONSTRUCTION type is the concrete column type (preserved on edit; new columns get a TextBoxColumn); the
    /// managed properties are HeaderText/Width/ReadOnly/Visible plus a canonical <c>Name</c> (kept in sync with the
    /// field id). The <c>ISupportInitialize</c> BeginInit/EndInit statements aren't column-related, so they're left
    /// byte-identical. Values are emitted through Roslyn literal/keyword syntax — nothing is interpolated.
    /// </summary>
    public static class DesignerGridColumnEditor
    {
        private const int DefaultWidth = 100;
        private const string DefaultColumnType = "System.Windows.Forms.DataGridViewTextBoxColumn";
        private const string ArrayElementType = "System.Windows.Forms.DataGridViewColumn";

        // ---- read ----

        public static GridColumnItemsResult ListColumns(string sourceText, string ownerId)
        {
            if (!IsIdentifier(ownerId)) return new GridColumnItemsResult { Ok = false, Reason = "invalid owner id: " + ownerId };

            var init = FindInitializeComponent(CSharpSyntaxTree.ParseText(sourceText).GetRoot());
            if (init?.Body == null) return new GridColumnItemsResult { Ok = false, Reason = "InitializeComponent not found" };

            if (!TryColumnIds(init, ownerId, out var ids, out var reason))
                return new GridColumnItemsResult { Ok = false, Reason = reason };

            var cols = new List<GridColumnItem>();
            foreach (var id in ids)
            {
                if (!TryReadColumn(init, id, out var col, out var whyCol))
                    return new GridColumnItemsResult { Ok = false, Reason = whyCol };
                cols.Add(col);
            }
            return new GridColumnItemsResult { Ok = true, Columns = cols };
        }

        // ---- write ----

        public static EditResult SetColumns(string sourceText, string ownerId, IReadOnlyList<GridColumnItem> desired)
        {
            if (!IsIdentifier(ownerId)) return Failed("invalid owner id: " + ownerId);

            var root = CSharpSyntaxTree.ParseText(sourceText).GetRoot();
            var cls = FindClass(root);
            var init = cls?.Members.OfType<MethodDeclarationSyntax>().FirstOrDefault(m => m.Identifier.Text == "InitializeComponent");
            if (cls == null || init?.Body == null) return Failed("InitializeComponent not found");

            if (!TryColumnIds(init, ownerId, out var currentIds, out var reason)) return Failed(reason);
            foreach (var id in currentIds)
                if (!TryReadColumn(init, id, out _, out var whyCol)) return Failed(whyCol);

            var fieldNames = GatherFieldNames(cls);
            var currentSet = new HashSet<string>(currentIds, StringComparer.Ordinal);
            // capture each current column's concrete construction type so kept columns keep it (only new ones default).
            var typeOf = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var id in currentIds) typeOf[id] = ColumnType(init, id) ?? DefaultColumnType;

            var finalIds = new List<string>();
            var seen = new HashSet<string>(StringComparer.Ordinal);
            var normalized = new List<GridColumnItem>();
            var used = new HashSet<string>(fieldNames, StringComparer.Ordinal);
            foreach (var d in desired)
            {
                string id = d.Id ?? "";
                if (id.Length > 0)
                {
                    if (!currentSet.Contains(id)) return Failed("unknown column id: " + id);
                    if (!seen.Add(id)) return Failed("duplicate column id: " + id);
                }
                else
                {
                    id = UniqueName("dataGridViewColumn", used);
                    used.Add(id);
                    seen.Add(id);
                    typeOf[id] = DefaultColumnType;
                }
                finalIds.Add(id);
                normalized.Add(new GridColumnItem { Id = id, HeaderText = d.HeaderText ?? "", Width = d.Width, ReadOnly = d.ReadOnly, Visible = d.Visible });
            }

            // refuse removing a column referenced outside its own block (shared field / captured elsewhere).
            var currentColumnStmts = init.Body.Statements.Where(st => IsColumnRelated(st, ownerId, currentSet)).ToList();
            foreach (var rid in currentIds.Where(id => !finalIds.Contains(id)))
            {
                bool referencedOutside = cls.DescendantNodes().OfType<IdentifierNameSyntax>()
                    .Any(idn => idn.Identifier.Text == rid && !currentColumnStmts.Any(cs => cs.Span.Contains(idn.Span)));
                if (referencedOutside) return Failed("column " + rid + " is referenced outside the collection; can't remove it here");
                // a column sharing a multi-variable declaration can't be removed cleanly — refuse rather than vestige.
                if (IsMultiVarDecl(cls, rid)) return Failed("column " + rid + " shares a field declaration; can't remove it here");
            }

            string arrType = ExistingArrayType(init, ownerId) ?? ArrayElementType;
            string nl = sourceText.Contains("\r\n") ? "\r\n" : "\n";
            string indent = BodyIndent(init);

            var oldStatements = init.Body.Statements.ToList();
            int anchor = -1;
            var kept = new List<StatementSyntax>();
            for (int i = 0; i < oldStatements.Count; i++)
            {
                var st = oldStatements[i];
                if (IsColumnRelated(st, ownerId, currentSet)) { if (anchor < 0) anchor = kept.Count; }
                else kept.Add(st);
            }
            if (anchor < 0)
            {
                int ctorIdx = kept.FindIndex(st => IsOwnerConstruction(st, ownerId));
                if (ctorIdx >= 0) anchor = ctorIdx + 1;
                else
                {
                    int mentionIdx = kept.FindLastIndex(st => TargetsOwner(st, ownerId));
                    if (mentionIdx < 0) return Failed("no statement references " + ownerId + " to anchor the columns");
                    anchor = mentionIdx + 1;
                }
            }

            var block = BuildColumnBlock(ownerId, arrType, finalIds, normalized, typeOf, indent, nl);
            var newStatements = new List<StatementSyntax>(kept);
            newStatements.InsertRange(Math.Min(anchor, newStatements.Count), block);
            var newInit = init.WithBody(init.Body.WithStatements(SyntaxFactory.List(newStatements)));

            var removed = new HashSet<string>(currentIds.Where(id => !finalIds.Contains(id)), StringComparer.Ordinal);
            var addedIds = finalIds.Where(id => !currentSet.Contains(id)).ToList();
            var newMembers = new List<MemberDeclarationSyntax>();
            int ownerDeclPos = -1;
            foreach (var m in cls.Members)
            {
                if (ReferenceEquals(m, init)) { newMembers.Add(newInit); continue; }
                if (m is FieldDeclarationSyntax fd && fd.Declaration.Variables.Count == 1
                    && removed.Contains(fd.Declaration.Variables[0].Identifier.Text))
                    continue;
                newMembers.Add(m);
                if (m is FieldDeclarationSyntax od && od.Declaration.Variables.Any(v => v.Identifier.Text == ownerId))
                    ownerDeclPos = newMembers.Count;
            }
            if (addedIds.Count > 0)
            {
                string fieldIndent = FieldIndentOf(cls);
                var decls = addedIds.Select(id => ColumnFieldDecl(typeOf[id], id, fieldIndent, nl)).ToList();
                int at = ownerDeclPos >= 0 ? ownerDeclPos : newMembers.FindLastIndex(m => m is FieldDeclarationSyntax) + 1;
                if (at < 0) at = 0;
                newMembers.InsertRange(Math.Min(at, newMembers.Count), decls);
            }

            var newCls = cls.WithMembers(SyntaxFactory.List(newMembers));
            return new EditResult { NewText = root.ReplaceNode(cls, newCls).ToFullString(), Mode = EditMode.Replace };
        }

        public static bool OnlyColumnsChanged(string original, string edited, string ownerId)
        {
            var oRoot = CSharpSyntaxTree.ParseText(original).GetRoot();
            var eRoot = CSharpSyntaxTree.ParseText(edited).GetRoot();
            var oInit = FindInitializeComponent(oRoot);
            var eInit = FindInitializeComponent(eRoot);
            if (oInit?.Body == null || eInit?.Body == null) return false;

            if (!TryColumnIds(oInit, ownerId, out var oIds, out _)) return false;
            if (!TryColumnIds(eInit, ownerId, out var eIds, out _)) return false;
            var union = new HashSet<string>(oIds, StringComparer.Ordinal);
            union.UnionWith(eIds);

            var oNon = NonColumnStatements(oInit, ownerId, union);
            var (eNon, eCols) = SplitStatements(eInit, ownerId, union);
            if (!MultisetEqual(oNon, eNon)) return false;
            foreach (var st in eCols)
                if (!IsSafeColumnStatement(st, ownerId, eIds)) return false;

            var oClass = FindClassOf(oInit);
            var eClass = FindClassOf(eInit);
            if (oClass == null || eClass == null) return false;
            if (!MultisetEqual(NonColumnFieldDecls(oClass, union), NonColumnFieldDecls(eClass, union))) return false;
            foreach (var fd in eClass.Members.OfType<FieldDeclarationSyntax>())
            {
                if (fd.Declaration.Variables.Count != 1) continue;
                var nm = fd.Declaration.Variables[0].Identifier.Text;
                if (union.Contains(nm) && eIds.Contains(nm) && !IsColumnFieldDecl(fd)) return false;
            }

            foreach (var rid in oIds.Where(id => !eIds.Contains(id)))
                if (eClass.DescendantNodes().OfType<IdentifierNameSyntax>().Any(idn => idn.Identifier.Text == rid))
                    return false;

            // Comments/directives must survive — EXCEPT VS component separators (`//`, `// <field>`, `// <class>`),
            // which are boilerplate that legitimately moves/vanishes when a column's block is regenerated. Real
            // developer notes (multi-word, or a non-field identifier) are still protected. Names computed per-class
            // so a removed column's own `// <field>` separator is excluded on the original side too.
            if (!MultisetEqual(CommentTrivia(oClass, StructuralNames(oClass)), CommentTrivia(eClass, StructuralNames(eClass)))) return false;
            return true;
        }

        /// <summary>Field variable names + the class name — the labels VS uses in its `//\n// &lt;name&gt;\n//` component
        /// separator comments, which the comment-loss gate treats as boilerplate rather than developer notes.</summary>
        private static HashSet<string> StructuralNames(ClassDeclarationSyntax cls)
        {
            var set = GatherFieldNames(cls);
            set.Add(cls.Identifier.Text);
            return set;
        }

        // ---- column id + read helpers ----

        /// <summary>Ordered field ids of the owner's <c>Columns.Add/AddRange</c> elements — every element must be a
        /// plain <c>this.&lt;field&gt;</c> reference (no inline column).</summary>
        private static bool TryColumnIds(MethodDeclarationSyntax init, string ownerId, out List<string> ids, out string reason)
        {
            ids = new List<string>();
            reason = "";
            foreach (var st in init.Body!.Statements)
            {
                if (!IsColumnsCall(st, ownerId, out var inv, out var method)) continue;
                var args = inv!.ArgumentList.Arguments;
                if (method == "Add")
                {
                    if (args.Count != 1 || !TryFieldRef(args[0].Expression, out var id))
                    { reason = "non-field element in " + ownerId + ".Columns"; return false; }
                    ids.Add(id!);
                }
                else
                {
                    var elems = ArrayElements(args.Count == 1 ? args[0].Expression : null);
                    if (elems == null) { reason = "unexpected Columns.AddRange shape"; return false; }
                    foreach (var el in elems)
                    {
                        if (!TryFieldRef(el, out var id))
                        { reason = "non-field element in " + ownerId + ".Columns"; return false; }
                        ids.Add(id!);
                    }
                }
            }
            if (ids.Count != ids.Distinct(StringComparer.Ordinal).Count()) { reason = "duplicate column id"; return false; }
            return true;
        }

        private static bool TryReadColumn(MethodDeclarationSyntax init, string id, out GridColumnItem col, out string reason)
        {
            col = new GridColumnItem();
            reason = "";
            string header = "";
            int width = DefaultWidth;
            bool readOnly = false, visible = true;
            bool nameSeen = false, constructed = false;
            foreach (var st in init.Body!.Statements)
            {
                if (st is not ExpressionStatementSyntax es || es.Expression is not AssignmentExpressionSyntax asn) continue;
                var lhs = Flatten(asn.Left);
                if (lhs.Count == 1 && lhs[0] == id)
                {
                    // construction: this.<id> = new <ConcreteColumnType>();  (no args, no object-initializer)
                    if (asn.Right is not ObjectCreationExpressionSyntax oce || !IsColumnTypeName(oce.Type)
                        || (oce.ArgumentList?.Arguments.Count ?? 0) != 0 || oce.Initializer != null)
                    { reason = "column " + id + " has a non-trivial construction"; return false; }
                    constructed = true;
                    continue;
                }
                if (lhs.Count == 2 && lhs[0] == id)
                {
                    switch (lhs[1])
                    {
                        case "HeaderText":
                            if (!TryStringLiteral(asn.Right, out var hv)) { reason = "column " + id + ".HeaderText is not a literal"; return false; }
                            header = hv!; break;
                        case "Name":
                            // canonical Name must equal the field id (VS always emits this); anything else → read-only.
                            if (!TryStringLiteral(asn.Right, out var nv) || nv != id) { reason = "column " + id + ".Name is not the field id"; return false; }
                            nameSeen = true; break;
                        case "Width":
                            if (!TryIntLiteral(asn.Right, out var wv)) { reason = "column " + id + ".Width is not an int literal"; return false; }
                            width = wv; break;
                        case "ReadOnly":
                            if (!TryBoolLiteral(asn.Right, out var rv)) { reason = "column " + id + ".ReadOnly is not a bool literal"; return false; }
                            readOnly = rv; break;
                        case "Visible":
                            if (!TryBoolLiteral(asn.Right, out var vv)) { reason = "column " + id + ".Visible is not a bool literal"; return false; }
                            visible = vv; break;
                        default:
                            reason = "column " + id + " has unsupported property " + lhs[1]; return false;
                    }
                    continue;
                }
                if (lhs.Count >= 1 && lhs[0] == id) { reason = "column " + id + " has a nested assignment"; return false; }
            }
            _ = nameSeen;
            // a column referenced in the collection but never `new`-constructed is malformed source; refuse rather
            // than synthesize a TextBoxColumn construction that could mismatch the field's declared type.
            if (!constructed) { reason = "column " + id + " has no construction"; return false; }
            col = new GridColumnItem { Id = id, HeaderText = header, Width = width, ReadOnly = readOnly, Visible = visible };
            return true;
        }

        // ---- write helpers ----

        private static List<StatementSyntax> BuildColumnBlock(string ownerId, string arrType, List<string> ids,
            List<GridColumnItem> cols, Dictionary<string, string> typeOf, string indent, string nl)
        {
            var list = new List<StatementSyntax>();
            foreach (var id in ids)
                list.Add(Stmt($"this.{id} = new {typeOf[id]}();", indent, nl));
            if (ids.Count > 0)
            {
                var sb = new StringBuilder();
                sb.Append("this.").Append(ownerId).Append(".Columns.AddRange(new ").Append(arrType).Append("[] {").Append(nl);
                for (int i = 0; i < ids.Count; i++)
                {
                    sb.Append(indent).Append("this.").Append(ids[i]);
                    sb.Append(i < ids.Count - 1 ? "," + nl : "});");
                }
                list.Add(Stmt(sb.ToString(), indent, nl));
            }
            foreach (var c in cols)
            {
                if (c.HeaderText.Length > 0)
                    list.Add(Stmt($"this.{c.Id}.HeaderText = {SyntaxFactory.Literal(c.HeaderText)};", indent, nl));
                // Name is always emitted, kept in sync with the field id (DataGridView columns are keyed by Name)
                list.Add(Stmt($"this.{c.Id}.Name = {SyntaxFactory.Literal(c.Id)};", indent, nl));
                if (c.Width != DefaultWidth)
                    list.Add(Stmt($"this.{c.Id}.Width = {c.Width.ToString(CultureInfo.InvariantCulture)};", indent, nl));
                if (c.ReadOnly)
                    list.Add(Stmt($"this.{c.Id}.ReadOnly = true;", indent, nl));
                if (!c.Visible)
                    list.Add(Stmt($"this.{c.Id}.Visible = false;", indent, nl));
            }
            return list;
        }

        private static StatementSyntax Stmt(string code, string indent, string nl) =>
            SyntaxFactory.ParseStatement(code)
                .WithLeadingTrivia(SyntaxFactory.Whitespace(indent))
                .WithTrailingTrivia(SyntaxFactory.EndOfLine(nl));

        private static FieldDeclarationSyntax ColumnFieldDecl(string colType, string id, string indent, string nl) =>
            (FieldDeclarationSyntax)SyntaxFactory.ParseMemberDeclaration($"private {colType} {id};")!
                .WithLeadingTrivia(SyntaxFactory.Whitespace(indent))
                .WithTrailingTrivia(SyntaxFactory.EndOfLine(nl));

        // ---- classification ----

        private static bool IsColumnsCall(StatementSyntax st, string ownerId, out InvocationExpressionSyntax? inv, out string method)
        {
            inv = null; method = "";
            if (st is not ExpressionStatementSyntax es || es.Expression is not InvocationExpressionSyntax i) return false;
            if (i.Expression is not MemberAccessExpressionSyntax ma) return false;
            var m = ma.Name.Identifier.Text;
            if (m != "Add" && m != "AddRange") return false;
            var chain = Flatten(ma.Expression);
            if (chain.Count != 2 || chain[0] != ownerId || chain[1] != "Columns") return false;
            inv = i; method = m;
            return true;
        }

        private static bool IsOwnerConstruction(StatementSyntax st, string ownerId)
        {
            if (st is not ExpressionStatementSyntax { Expression: AssignmentExpressionSyntax asn }) return false;
            var lhs = Flatten(asn.Left);
            return lhs.Count == 1 && lhs[0] == ownerId && asn.Right is ObjectCreationExpressionSyntax;
        }

        private static bool IsColumnRelated(StatementSyntax st, string ownerId, HashSet<string> columnIds)
        {
            if (IsColumnsCall(st, ownerId, out _, out _)) return true;
            if (st is ExpressionStatementSyntax { Expression: AssignmentExpressionSyntax asn })
            {
                var lhs = Flatten(asn.Left);
                return lhs.Count >= 1 && columnIds.Contains(lhs[0]);
            }
            return false;
        }

        private static List<string> NonColumnStatements(MethodDeclarationSyntax init, string ownerId, HashSet<string> columnIds) =>
            SplitStatements(init, ownerId, columnIds).nonColumn;

        private static (List<string> nonColumn, List<StatementSyntax> column) SplitStatements(
            MethodDeclarationSyntax init, string ownerId, HashSet<string> columnIds)
        {
            var non = new List<string>();
            var col = new List<StatementSyntax>();
            foreach (var st in init.Body!.Statements)
            {
                if (IsColumnRelated(st, ownerId, columnIds)) col.Add(st);
                else non.Add(NormalizeStmt(st.ToString()));
            }
            return (non, col);
        }

        private static bool IsSafeColumnStatement(StatementSyntax st, string ownerId, List<string> columnIds)
        {
            if (IsColumnsCall(st, ownerId, out var inv, out var method))
            {
                var args = inv!.ArgumentList.Arguments;
                if (method == "Add")
                    return args.Count == 1 && TryFieldRef(args[0].Expression, out var aid) && columnIds.Contains(aid!);
                var elems = ArrayElements(args.Count == 1 ? args[0].Expression : null);
                if (elems == null) return false;
                foreach (var el in elems)
                    if (!TryFieldRef(el, out var id) || !columnIds.Contains(id!)) return false;
                return true;
            }
            if (st is not ExpressionStatementSyntax { Expression: AssignmentExpressionSyntax asn }) return false;
            var lhs = Flatten(asn.Left);
            if (lhs.Count == 1) // construction — a plain `new <…Column>()` (no arg, no initializer)
                return columnIds.Contains(lhs[0]) && asn.Right is ObjectCreationExpressionSyntax oce
                    && IsColumnTypeName(oce.Type) && (oce.ArgumentList?.Arguments.Count ?? 0) == 0 && oce.Initializer == null;
            if (lhs.Count == 2 && columnIds.Contains(lhs[0]))
            {
                return lhs[1] switch
                {
                    "HeaderText" => TryStringLiteral(asn.Right, out _),
                    "Name" => TryStringLiteral(asn.Right, out var nv) && nv == lhs[0],
                    "Width" => TryIntLiteral(asn.Right, out _),
                    "ReadOnly" => TryBoolLiteral(asn.Right, out _),
                    "Visible" => TryBoolLiteral(asn.Right, out _),
                    _ => false,
                };
            }
            return false;
        }

        private static List<string> NonColumnFieldDecls(ClassDeclarationSyntax cls, HashSet<string> columnIds)
        {
            var list = new List<string>();
            foreach (var fd in cls.Members.OfType<FieldDeclarationSyntax>())
            {
                if (fd.Declaration.Variables.Count == 1 && columnIds.Contains(fd.Declaration.Variables[0].Identifier.Text))
                    continue;
                list.Add(NormalizeStmt(fd.ToString()));
            }
            return list;
        }

        private static bool IsColumnFieldDecl(FieldDeclarationSyntax fd) =>
            fd.Declaration.Variables.Count == 1 && IsColumnTypeName(fd.Declaration.Type);

        /// <summary>A DataGridView column type name — matched by its simple name ending in "Column" (covers the
        /// framework columns and vendor subclasses). Pure text; excludes the base collection/array checks.</summary>
        private static bool IsColumnTypeName(TypeSyntax t)
        {
            string s = SimpleTypeName(t);
            return s.EndsWith("Column", StringComparison.Ordinal) && s.Length > "Column".Length;
        }

        // ---- value parsing ----

        private static bool TryFieldRef(ExpressionSyntax expr, out string? id)
        {
            var chain = Flatten(expr);
            if (chain.Count == 1 && IsIdentifier(chain[0])) { id = chain[0]; return true; }
            id = null; return false;
        }

        private static bool TryStringLiteral(ExpressionSyntax expr, out string? value)
        {
            if (expr is LiteralExpressionSyntax lit && lit.IsKind(SyntaxKind.StringLiteralExpression))
            { value = lit.Token.ValueText; return true; }
            value = null; return false;
        }

        private static bool TryIntLiteral(ExpressionSyntax expr, out int value)
        {
            value = 0;
            bool neg = false;
            if (expr is PrefixUnaryExpressionSyntax pu && pu.IsKind(SyntaxKind.UnaryMinusExpression)) { neg = true; expr = pu.Operand; }
            if (expr is LiteralExpressionSyntax lit && lit.IsKind(SyntaxKind.NumericLiteralExpression) && lit.Token.Value is int v)
            { value = neg ? -v : v; return true; }
            return false;
        }

        private static bool TryBoolLiteral(ExpressionSyntax expr, out bool value)
        {
            if (expr is LiteralExpressionSyntax lit)
            {
                if (lit.IsKind(SyntaxKind.TrueLiteralExpression)) { value = true; return true; }
                if (lit.IsKind(SyntaxKind.FalseLiteralExpression)) { value = false; return true; }
            }
            value = false; return false;
        }

        private static string? ColumnType(MethodDeclarationSyntax init, string id)
        {
            foreach (var st in init.Body!.Statements)
            {
                if (st is ExpressionStatementSyntax { Expression: AssignmentExpressionSyntax asn }
                    && asn.Right is ObjectCreationExpressionSyntax oce)
                {
                    var lhs = Flatten(asn.Left);
                    if (lhs.Count == 1 && lhs[0] == id && IsColumnTypeName(oce.Type))
                        return oce.Type.ToString();
                }
            }
            return null;
        }

        /// <summary>The base element type of the owner's <c>Columns.AddRange(new T[]{…})</c> array (usually
        /// <c>System.Windows.Forms.DataGridViewColumn</c>) so a rebuilt AddRange keeps the source's type syntax.</summary>
        private static string? ExistingArrayType(MethodDeclarationSyntax init, string ownerId)
        {
            foreach (var st in init.Body!.Statements)
            {
                if (IsColumnsCall(st, ownerId, out var inv, out var method) && method == "AddRange"
                    && inv!.ArgumentList.Arguments.Count == 1
                    && inv.ArgumentList.Arguments[0].Expression is ArrayCreationExpressionSyntax ac)
                    return ac.Type.ElementType.ToString();
            }
            return null;
        }

        private static IReadOnlyList<ExpressionSyntax>? ArrayElements(ExpressionSyntax? arg)
        {
            InitializerExpressionSyntax? initz = arg switch
            {
                ArrayCreationExpressionSyntax ac => ac.Initializer,
                ImplicitArrayCreationExpressionSyntax iac => iac.Initializer,
                InitializerExpressionSyntax ie => ie,
                _ => null,
            };
            return initz?.Expressions.ToList();
        }

        private static string SimpleTypeName(TypeSyntax t)
        {
            string s = t.ToString();
            int lt = s.IndexOf('<'); if (lt >= 0) s = s.Substring(0, lt);
            int dot = s.LastIndexOf('.');
            return dot >= 0 ? s.Substring(dot + 1) : s;
        }

        // ---- shared syntax helpers (kept local so the proven editors stay untouched) ----

        private static EditResult Failed(string reason) => new() { Mode = EditMode.Failed, Reason = reason };

        private static bool IsIdentifier(string s) => !string.IsNullOrEmpty(s) && SyntaxFacts.IsValidIdentifier(s);

        private static MethodDeclarationSyntax? FindInitializeComponent(SyntaxNode root)
        {
            foreach (var cls in root.DescendantNodes().OfType<ClassDeclarationSyntax>())
            {
                var m = cls.Members.OfType<MethodDeclarationSyntax>().FirstOrDefault(x => x.Identifier.Text == "InitializeComponent");
                if (m != null) return m;
            }
            return null;
        }

        private static ClassDeclarationSyntax? FindClass(SyntaxNode root) =>
            root.DescendantNodes().OfType<ClassDeclarationSyntax>()
                .FirstOrDefault(c => c.Members.OfType<MethodDeclarationSyntax>().Any(m => m.Identifier.Text == "InitializeComponent"));

        private static ClassDeclarationSyntax? FindClassOf(SyntaxNode node) =>
            node.Ancestors().OfType<ClassDeclarationSyntax>().FirstOrDefault();

        private static HashSet<string> GatherFieldNames(ClassDeclarationSyntax cls)
        {
            var set = new HashSet<string>(StringComparer.Ordinal);
            foreach (var fd in cls.Members.OfType<FieldDeclarationSyntax>())
                foreach (var v in fd.Declaration.Variables) set.Add(v.Identifier.Text);
            return set;
        }

        /// <summary>True when <paramref name="id"/> shares a multi-variable field declaration — such a decl can't be
        /// dropped on removal without losing its siblings.</summary>
        private static bool IsMultiVarDecl(ClassDeclarationSyntax cls, string id) =>
            cls.Members.OfType<FieldDeclarationSyntax>()
               .Any(fd => fd.Declaration.Variables.Count > 1 && fd.Declaration.Variables.Any(v => v.Identifier.Text == id));

        private static string UniqueName(string baseName, HashSet<string> used)
        {
            for (int i = 1; ; i++)
            {
                string cand = baseName + i.ToString(CultureInfo.InvariantCulture);
                if (!used.Contains(cand)) return cand;
            }
        }

        private static string BodyIndent(MethodDeclarationSyntax init)
        {
            var first = init.Body!.Statements.FirstOrDefault();
            if (first != null) return LineIndent(first);
            return "            ";
        }

        private static string FieldIndentOf(ClassDeclarationSyntax cls)
        {
            var fd = cls.Members.OfType<FieldDeclarationSyntax>().FirstOrDefault();
            if (fd != null) return LineIndent(fd);
            return "        ";
        }

        private static string LineIndent(SyntaxNode node)
        {
            var text = node.SyntaxTree.GetText();
            string lineText = text.Lines.GetLineFromPosition(node.SpanStart).ToString();
            int n = lineText.Length - lineText.TrimStart().Length;
            return lineText.Substring(0, n);
        }

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

        private static List<string> CommentTrivia(SyntaxNode node, HashSet<string> structural)
        {
            var list = new List<string>();
            foreach (var tr in node.DescendantTrivia(descendIntoTrivia: true))
            {
                if (tr.IsKind(SyntaxKind.SingleLineCommentTrivia))
                {
                    if (IsStructuralSeparator(tr.ToString(), structural)) continue; // VS boilerplate — ignore
                    list.Add(tr.ToString().Trim());
                }
                else if (tr.IsKind(SyntaxKind.MultiLineCommentTrivia)
                    || tr.IsKind(SyntaxKind.SingleLineDocumentationCommentTrivia)
                    || tr.IsKind(SyntaxKind.MultiLineDocumentationCommentTrivia) || tr.IsDirective)
                    list.Add(tr.ToString().Trim());
            }
            return list;
        }

        /// <summary>True for a VS component-separator line: a <c>//</c> comment whose body is empty or is a single
        /// identifier that names a field / the class. A developer note (multiple words, or an unknown identifier) is
        /// NOT a separator and stays protected.</summary>
        private static bool IsStructuralSeparator(string commentText, HashSet<string> structural)
        {
            string body = commentText.TrimStart('/').Trim();
            if (body.Length == 0) return true;
            return SyntaxFacts.IsValidIdentifier(body) && structural.Contains(body);
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
