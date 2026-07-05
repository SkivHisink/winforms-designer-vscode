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
    /// <summary>One <c>ColumnHeader</c> of a <c>ListView.Columns</c> collection, as the typed collection editor
    /// sees it: the field id (empty for a NEW column) plus the three managed properties. Everything else on the
    /// column is intentionally NOT modelled — a column that carries any other property is surfaced read-only so
    /// the editor can never clobber a value it doesn't round-trip (mirrors the string editor's literal-only gate).</summary>
    public sealed class ColumnItem
    {
        /// <summary>The column's field id (e.g. "colName"); empty/null for a column being ADDED (a fresh id is
        /// generated). A non-empty id must name an existing column of the owner — otherwise the edit is refused.</summary>
        public string Id { get; set; } = "";
        public string Text { get; set; } = "";
        /// <summary>Column width in pixels. Negative sentinels are legal (<c>-1</c> = size-to-content,
        /// <c>-2</c> = size-to-header), so any int is accepted.</summary>
        public int Width { get; set; } = 60;
        /// <summary>Header text alignment: "Left" (default), "Center" or "Right".</summary>
        public string TextAlign { get; set; } = "Left";
    }

    /// <summary>Read side of the ListView.Columns editor: the ordered columns and whether the collection is
    /// editable. <see cref="Ok"/> is false when a column isn't a plain named <c>ColumnHeader</c> field with only
    /// Text/Width/TextAlign set (e.g. an inline column, a cast construction, or an unmanaged property like
    /// ImageIndex) — the webview then keeps the collection read-only rather than risk dropping a value.</summary>
    public sealed class ColumnItemsResult
    {
        public bool Ok { get; init; }
        public List<ColumnItem> Columns { get; init; } = new();
        public string Reason { get; init; } = "";
    }

    /// <summary>
    /// Targeted edit of a <c>ListView.Columns</c> collection — the typed counterpart of the string
    /// <see cref="DesignerCollectionEditor"/>. Each column serializes as a NAMED field:
    /// <code>
    ///   this.colName = new System.Windows.Forms.ColumnHeader();
    ///   this.listView1.Columns.AddRange(new System.Windows.Forms.ColumnHeader[] { this.colName, this.colSize });
    ///   this.colName.Text = "Name";
    ///   this.colName.Width = 220;
    /// </code>
    /// so editing the collection means reconciling three things atomically: the column field declarations, their
    /// construction + property statements, and the owner's <c>Columns.AddRange</c>. Only the three managed
    /// properties (Text/Width/TextAlign) are rewritten; a column that carries any other property makes the whole
    /// collection read-only (see <see cref="ListColumns"/>). Values are emitted through Roslyn literal/enum-member
    /// syntax, so nothing is interpolated and no expression can be injected. <see cref="OnlyColumnsChanged"/>
    /// verifies the edit touched ONLY this owner's columns and left every other statement + field byte-identical.
    /// </summary>
    public static class DesignerListColumnEditor
    {
        private static readonly string[] Aligns = { "Left", "Center", "Right" };
        private const int DefaultWidth = 60;
        private const string DefaultColumnType = "System.Windows.Forms.ColumnHeader";

        // ---- read ----

        /// <summary>The owner's current columns, in <c>Columns.Add/AddRange</c> order. <see cref="ColumnItemsResult.Ok"/>
        /// is false when the collection can't be safely represented as [id, Text, Width, TextAlign] rows.</summary>
        public static ColumnItemsResult ListColumns(string sourceText, string ownerId)
        {
            if (!IsIdentifier(ownerId)) return new ColumnItemsResult { Ok = false, Reason = "invalid owner id: " + ownerId };

            var init = FindInitializeComponent(CSharpSyntaxTree.ParseText(sourceText).GetRoot());
            if (init?.Body == null) return new ColumnItemsResult { Ok = false, Reason = "InitializeComponent not found" };

            if (!TryColumnIds(init, ownerId, out var ids, out var reason))
                return new ColumnItemsResult { Ok = false, Reason = reason };

            var cols = new List<ColumnItem>();
            foreach (var id in ids)
            {
                if (!TryReadColumn(init, id, out var col, out var whyCol))
                    return new ColumnItemsResult { Ok = false, Reason = whyCol };
                cols.Add(col);
            }
            return new ColumnItemsResult { Ok = true, Columns = cols };
        }

        // ---- write ----

        /// <summary>Rewrite <paramref name="ownerId"/>'s columns to exactly <paramref name="desired"/>: reconcile the
        /// field declarations, per-column construction/property statements and the <c>Columns.AddRange</c> in one
        /// pass. Kept columns keep their id; a column with an empty id is added (fresh id); a current column absent
        /// from the list is removed. Refuses (Failed) when a current column carries an unmanaged property, an
        /// unknown id is referenced, or a value is invalid — a read-only fallback, never a silent clobber.</summary>
        public static EditResult SetColumns(string sourceText, string ownerId, IReadOnlyList<ColumnItem> desired)
        {
            if (!IsIdentifier(ownerId)) return Failed("invalid owner id: " + ownerId);

            var root = CSharpSyntaxTree.ParseText(sourceText).GetRoot();
            var cls = FindClass(root);
            var init = cls?.Members.OfType<MethodDeclarationSyntax>().FirstOrDefault(m => m.Identifier.Text == "InitializeComponent");
            if (cls == null || init?.Body == null) return Failed("InitializeComponent not found");

            if (!TryColumnIds(init, ownerId, out var currentIds, out var reason)) return Failed(reason);
            // every CURRENT column must be fully managed — else dropping/regenerating its block would lose a value.
            foreach (var id in currentIds)
                if (!TryReadColumn(init, id, out _, out var whyCol)) return Failed(whyCol);

            // resolve the desired ids: keep an existing id, generate one for a new column, refuse an unknown/dup id.
            var fieldNames = GatherFieldNames(cls);
            var currentSet = new HashSet<string>(currentIds, StringComparer.Ordinal);
            var finalIds = new List<string>();
            var seen = new HashSet<string>(StringComparer.Ordinal);
            var normalized = new List<ColumnItem>();
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
                    id = UniqueName("columnHeader", used);
                    used.Add(id);
                    seen.Add(id);
                }
                string align = d.TextAlign ?? "Left";
                if (!Aligns.Contains(align, StringComparer.Ordinal)) return Failed("invalid TextAlign: " + align);
                finalIds.Add(id);
                normalized.Add(new ColumnItem { Id = id, Text = d.Text ?? "", Width = d.Width, TextAlign = align });
            }

            // removing a column that is referenced OUTSIDE its own block (e.g. a ColumnHeader shared with a second
            // ListView's Columns, or captured elsewhere) would leave a dangling reference — refuse rather than
            // delete the field out from under another statement. Its own construction/property/AddRange statements
            // are excluded (those are dropped by this edit).
            var currentColumnStmts = init.Body.Statements.Where(st => IsColumnRelated(st, ownerId, currentSet)).ToList();
            foreach (var rid in currentIds.Where(id => !finalIds.Contains(id)))
            {
                // an IdentifierName occurrence of the field id that isn't inside one of the dropped column
                // statements — a field declaration names the variable with a TOKEN (not an IdentifierName), so
                // decls never match here; only real references (this.colX / bare colX uses) do.
                bool referencedOutside = cls.DescendantNodes().OfType<IdentifierNameSyntax>()
                    .Any(idn => idn.Identifier.Text == rid && !currentColumnStmts.Any(cs => cs.Span.Contains(idn.Span)));
                if (referencedOutside) return Failed("column " + rid + " is referenced outside the collection; can't remove it here");
                // a column sharing a multi-variable declaration (`private ColumnHeader a, b;`) can't be removed
                // cleanly (dropping the whole decl would delete its sibling) — refuse rather than leave a vestige.
                if (IsMultiVarDecl(cls, rid)) return Failed("column " + rid + " shares a field declaration; can't remove it here");
            }

            string colType = ExistingColumnType(init, currentIds) ?? DefaultColumnType;
            string nl = sourceText.Contains("\r\n") ? "\r\n" : "\n";
            string indent = BodyIndent(init);

            // rebuild InitializeComponent: drop every column-related statement, splice the regenerated block at the
            // position of the FIRST one (or, when the owner had no columns yet, right after its construction).
            var oldStatements = init.Body.Statements.ToList();
            int anchor = -1;
            var kept = new List<StatementSyntax>();
            for (int i = 0; i < oldStatements.Count; i++)
            {
                var st = oldStatements[i];
                if (IsColumnRelated(st, ownerId, currentSet))
                {
                    if (anchor < 0) anchor = kept.Count;
                }
                else kept.Add(st);
            }
            if (anchor < 0)
            {
                // adding the first column(s): anchor after the owner's construction, else after any owner statement.
                int ctorIdx = kept.FindIndex(st => IsOwnerConstruction(st, ownerId));
                if (ctorIdx >= 0) anchor = ctorIdx + 1;
                else
                {
                    int mentionIdx = kept.FindLastIndex(st => TargetsOwner(st, ownerId));
                    if (mentionIdx < 0) return Failed("no statement references " + ownerId + " to anchor the columns");
                    anchor = mentionIdx + 1;
                }
            }

            var block = BuildColumnBlock(ownerId, colType, finalIds, normalized, indent, nl);
            var newStatements = new List<StatementSyntax>(kept);
            newStatements.InsertRange(Math.Min(anchor, newStatements.Count), block);

            var newInit = init.WithBody(init.Body.WithStatements(SyntaxFactory.List(newStatements)));

            // rebuild class members: drop removed columns' field decls, add the new columns' decls after the owner's.
            var removed = new HashSet<string>(currentIds.Where(id => !finalIds.Contains(id)), StringComparer.Ordinal);
            var addedIds = finalIds.Where(id => !currentSet.Contains(id)).ToList();
            var newMembers = new List<MemberDeclarationSyntax>();
            int ownerDeclPos = -1;
            foreach (var m in cls.Members)
            {
                if (ReferenceEquals(m, init)) { newMembers.Add(newInit); continue; }
                if (m is FieldDeclarationSyntax fd && fd.Declaration.Variables.Count == 1
                    && removed.Contains(fd.Declaration.Variables[0].Identifier.Text))
                    continue; // drop a removed column's declaration
                newMembers.Add(m);
                if (m is FieldDeclarationSyntax od && od.Declaration.Variables.Any(v => v.Identifier.Text == ownerId))
                    ownerDeclPos = newMembers.Count; // insert new decls right after the owner's field decl
            }
            if (addedIds.Count > 0)
            {
                string fieldIndent = FieldIndentOf(cls);
                var decls = addedIds.Select(id => ColumnFieldDecl(colType, id, fieldIndent, nl)).ToList();
                int at = ownerDeclPos >= 0 ? ownerDeclPos : newMembers.FindLastIndex(m => m is FieldDeclarationSyntax) + 1;
                if (at < 0) at = 0;
                newMembers.InsertRange(Math.Min(at, newMembers.Count), decls);
            }

            var newCls = cls.WithMembers(SyntaxFactory.List(newMembers));
            return new EditResult { NewText = root.ReplaceNode(cls, newCls).ToFullString(), Mode = EditMode.Replace };
        }

        /// <summary>safe-save gate: every statement + field declaration that is NOT part of <paramref name="ownerId"/>'s
        /// columns is byte-identical (multiset), every remaining column statement is a safe construction / managed
        /// (Text/Width/TextAlign) assignment / string-literal-field <c>Columns.AddRange</c>, every ColumnHeader field
        /// declaration is well-formed, and no comment/directive in the InitializeComponent body was lost or added.</summary>
        public static bool OnlyColumnsChanged(string original, string edited, string ownerId)
        {
            var oRoot = CSharpSyntaxTree.ParseText(original).GetRoot();
            var eRoot = CSharpSyntaxTree.ParseText(edited).GetRoot();
            var oInit = FindInitializeComponent(oRoot);
            var eInit = FindInitializeComponent(eRoot);
            if (oInit?.Body == null || eInit?.Body == null) return false;

            // the union of column ids across both versions — a removed id is only in the original, a new id only in
            // the edited; statements referencing any of them are treated as column-related (allowed to change).
            if (!TryColumnIds(oInit, ownerId, out var oIds, out _)) return false;
            if (!TryColumnIds(eInit, ownerId, out var eIds, out _)) return false;
            var union = new HashSet<string>(oIds, StringComparer.Ordinal);
            union.UnionWith(eIds);

            // non-column statements must match exactly; every edited column statement must be safe.
            var oNon = NonColumnStatements(oInit, ownerId, union);
            var (eNon, eCols) = SplitStatements(eInit, ownerId, union);
            if (!MultisetEqual(oNon, eNon)) return false;
            foreach (var st in eCols)
                if (!IsSafeColumnStatement(st, ownerId, eIds)) return false;

            // field declarations: non-column decls byte-identical; every column decl (edited) is a clean single-var
            // ColumnHeader declaration.
            var oClass = FindClassOf(oInit);
            var eClass = FindClassOf(eInit);
            if (oClass == null || eClass == null) return false;
            if (!MultisetEqual(NonColumnFieldDecls(oClass, union), NonColumnFieldDecls(eClass, union))) return false;
            foreach (var fd in eClass.Members.OfType<FieldDeclarationSyntax>())
            {
                if (fd.Declaration.Variables.Count != 1) continue;
                var nm = fd.Declaration.Variables[0].Identifier.Text;
                if (union.Contains(nm) && eIds.Contains(nm) && !IsColumnHeaderDecl(fd)) return false;
            }

            // a removed column's field id must not survive anywhere in the edited tree — if it does, the edit left a
            // dangling reference (its field was deleted but something still names it). Catches an incomplete removal
            // and a column shared with another statement/collection.
            foreach (var rid in oIds.Where(id => !eIds.Contains(id)))
                if (eClass.DescendantNodes().OfType<IdentifierNameSyntax>().Any(idn => idn.Identifier.Text == rid))
                    return false;

            // no comment / directive anywhere in the class may be silently dropped or added — scanned over the WHOLE
            // class (not just the IC body) so a comment attached to a REMOVED column's field declaration is caught
            // too. EXCEPT VS component separators (`//`, `// <field>`, `// <class>`): those are boilerplate that
            // legitimately moves/vanishes when a column's block is regenerated (a real VS form emits `// <colName>`
            // before each column block). Real developer notes (multi-word / unknown identifier) stay protected.
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

        /// <summary>Ordered field ids of the owner's <c>Columns.Add/AddRange</c> elements. Fails (returns false)
        /// when a column call has any element that isn't a plain <c>this.&lt;field&gt;</c> reference (inline column,
        /// cast, etc.) — that collection can't be represented as editable rows.</summary>
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
                else // AddRange
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
            // a duplicated id in the collection is not something we round-trip cleanly — treat as read-only.
            if (ids.Count != ids.Distinct(StringComparer.Ordinal).Count()) { reason = "duplicate column id"; return false; }
            return true;
        }

        /// <summary>Read one column's managed values. Fails when its construction isn't a plain
        /// <c>new ColumnHeader()</c> or it carries a property outside Text/Width/TextAlign (or a non-literal value).</summary>
        private static bool TryReadColumn(MethodDeclarationSyntax init, string id, out ColumnItem col, out string reason)
        {
            col = new ColumnItem();
            reason = "";
            string text = "", align = "Left";
            int width = DefaultWidth;
            bool constructed = false;
            foreach (var st in init.Body!.Statements)
            {
                if (st is not ExpressionStatementSyntax es) continue;
                // construction: this.<id> = new <...ColumnHeader>();
                if (es.Expression is AssignmentExpressionSyntax asn)
                {
                    var lhs = Flatten(asn.Left);
                    if (lhs.Count == 1 && lhs[0] == id)
                    {
                        // must be a bare `new ColumnHeader()` — a ctor arg or an object-initializer (`{ Tag = … }`)
                        // carries state this editor doesn't model, so refuse (read-only) rather than drop it silently.
                        if (asn.Right is not ObjectCreationExpressionSyntax oce || SimpleTypeName(oce.Type) != "ColumnHeader"
                            || (oce.ArgumentList?.Arguments.Count ?? 0) != 0 || oce.Initializer != null)
                        { reason = "column " + id + " has a non-trivial construction"; return false; }
                        constructed = true;
                        continue;
                    }
                    // property: this.<id>.<prop> = <value>;
                    if (lhs.Count == 2 && lhs[0] == id)
                    {
                        switch (lhs[1])
                        {
                            case "Text":
                                if (!TryStringLiteral(asn.Right, out var tv)) { reason = "column " + id + ".Text is not a literal"; return false; }
                                text = tv!; break;
                            case "Width":
                                if (!TryIntLiteral(asn.Right, out var wv)) { reason = "column " + id + ".Width is not an int literal"; return false; }
                                width = wv; break;
                            case "TextAlign":
                                if (!TryAlignMember(asn.Right, out var av)) { reason = "column " + id + ".TextAlign is unsupported"; return false; }
                                align = av!; break;
                            default:
                                reason = "column " + id + " has unsupported property " + lhs[1]; return false;
                        }
                        continue;
                    }
                    if (lhs.Count >= 1 && lhs[0] == id) { reason = "column " + id + " has a nested assignment"; return false; }
                }
            }
            // a column referenced in the collection but never `new`-constructed is malformed source (null at runtime);
            // refuse rather than synthesize a construction that could mismatch the field's declared type.
            if (!constructed) { reason = "column " + id + " has no construction"; return false; }
            col = new ColumnItem { Id = id, Text = text, Width = width, TextAlign = align };
            return true;
        }

        // ---- write helpers ----

        private static List<StatementSyntax> BuildColumnBlock(string ownerId, string colType, List<string> ids,
            List<ColumnItem> cols, string indent, string nl)
        {
            var list = new List<StatementSyntax>();
            foreach (var id in ids)
                list.Add(Stmt($"this.{id} = new {colType}();", indent, nl));
            if (ids.Count > 0)
            {
                var sb = new StringBuilder();
                sb.Append("this.").Append(ownerId).Append(".Columns.AddRange(new ").Append(colType).Append("[] {").Append(nl);
                for (int i = 0; i < ids.Count; i++)
                {
                    sb.Append(indent).Append("this.").Append(ids[i]);
                    sb.Append(i < ids.Count - 1 ? "," + nl : "});");
                }
                list.Add(Stmt(sb.ToString(), indent, nl));
            }
            foreach (var c in cols)
            {
                if (c.Text.Length > 0)
                    list.Add(Stmt($"this.{c.Id}.Text = {SyntaxFactory.Literal(c.Text)};", indent, nl));
                if (c.Width != DefaultWidth)
                    list.Add(Stmt($"this.{c.Id}.Width = {c.Width.ToString(CultureInfo.InvariantCulture)};", indent, nl));
                if (!string.Equals(c.TextAlign, "Left", StringComparison.Ordinal))
                    list.Add(Stmt($"this.{c.Id}.TextAlign = System.Windows.Forms.HorizontalAlignment.{c.TextAlign};", indent, nl));
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

        /// <summary>True for <c>this.&lt;owner&gt;.Columns.Add(...)</c> / <c>.AddRange(...)</c> — the receiver
        /// flattens to exactly [owner, Columns].</summary>
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

        /// <summary>A statement that belongs to the owner's columns: the owner's Columns call, or a construction /
        /// assignment whose target flattens to start with one of the column ids.</summary>
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

        /// <summary>Gate check for a single edited column statement: a plain <c>new ColumnHeader()</c> construction,
        /// a managed (Text/Width/TextAlign literal) assignment, or the owner's <c>Columns.AddRange</c> of only
        /// <c>this.&lt;column-field&gt;</c> references.</summary>
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
            if (lhs.Count == 1) // construction — bare `new ColumnHeader()` only (no ctor arg, no object-initializer)
                return columnIds.Contains(lhs[0]) && asn.Right is ObjectCreationExpressionSyntax oce
                    && SimpleTypeName(oce.Type) == "ColumnHeader" && (oce.ArgumentList?.Arguments.Count ?? 0) == 0
                    && oce.Initializer == null;
            if (lhs.Count == 2 && columnIds.Contains(lhs[0]))
            {
                return lhs[1] switch
                {
                    "Text" => TryStringLiteral(asn.Right, out _),
                    "Width" => TryIntLiteral(asn.Right, out _),
                    "TextAlign" => TryAlignMember(asn.Right, out _),
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
                // a decl declaring exactly one of the column ids is column-owned; anything else must be preserved.
                if (fd.Declaration.Variables.Count == 1 && columnIds.Contains(fd.Declaration.Variables[0].Identifier.Text))
                    continue;
                list.Add(NormalizeStmt(fd.ToString()));
            }
            return list;
        }

        private static bool IsColumnHeaderDecl(FieldDeclarationSyntax fd) =>
            fd.Declaration.Variables.Count == 1 && SimpleTypeName(fd.Declaration.Type) == "ColumnHeader";

        // ---- value parsing ----

        private static bool TryFieldRef(ExpressionSyntax expr, out string? id)
        {
            // this.<field>  or  <field>
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

        private static bool TryAlignMember(ExpressionSyntax expr, out string? member)
        {
            member = null;
            // <...>.HorizontalAlignment.<Left|Center|Right>
            if (expr is not MemberAccessExpressionSyntax ma) return false;
            var name = ma.Name.Identifier.Text;
            if (!Aligns.Contains(name, StringComparer.Ordinal)) return false;
            var recv = Flatten(ma.Expression);
            if (recv.Count == 0 || recv[recv.Count - 1] != "HorizontalAlignment") return false;
            member = name;
            return true;
        }

        private static string? ExistingColumnType(MethodDeclarationSyntax init, List<string> ids)
        {
            var set = new HashSet<string>(ids, StringComparer.Ordinal);
            foreach (var st in init.Body!.Statements)
            {
                if (st is ExpressionStatementSyntax { Expression: AssignmentExpressionSyntax asn }
                    && asn.Right is ObjectCreationExpressionSyntax oce)
                {
                    var lhs = Flatten(asn.Left);
                    if (lhs.Count == 1 && set.Contains(lhs[0]) && SimpleTypeName(oce.Type) == "ColumnHeader")
                        return oce.Type.ToString();
                }
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

        /// <summary>True when <paramref name="id"/> is declared in a field declaration that also declares other
        /// variables (<c>private ColumnHeader a, b;</c>) — such a decl can't be dropped without losing its siblings.</summary>
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

        /// <summary>Leading whitespace of the first InitializeComponent statement (the body indent), used for the
        /// generated column statements. Falls back to 12 spaces (the WinForms designer default).</summary>
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
