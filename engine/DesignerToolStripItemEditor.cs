using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace WinFormsDesigner.Engine
{
    /// <summary>One item of a <c>ToolStrip</c>/<c>MenuStrip</c> <c>Items</c> collection (or a
    /// <c>ToolStripMenuItem.DropDownItems</c> sub-menu), recursively. Unlike TreeNodes, a ToolStrip item is a FIELD
    /// (<c>this.fileToolStripMenuItem = new ToolStripMenuItem()</c>) with its own property block and membership via
    /// <c>owner.Items.AddRange(new ToolStripItem[] { this.fileToolStripMenuItem })</c>. Only the structural view —
    /// the id (field name), display <see cref="Text"/>, <see cref="Name"/>, item <see cref="ItemType"/> and the
    /// nested <see cref="Children"/> — is modelled; every OTHER property (Image/ShortcutKeys/Checked/…) is left
    /// untouched in source, so this editor can reorder a real menu without clobbering its items' properties.</summary>
    public sealed class ToolStripItemModel
    {
        public string Id { get; set; } = "";
        public string Text { get; set; } = "";
        public string Name { get; set; } = "";
        public string ItemType { get; set; } = "";
        public List<ToolStripItemModel> Children { get; set; } = new();
    }

    public sealed class ToolStripItemsResult
    {
        public bool Ok { get; init; }
        public List<ToolStripItemModel> Items { get; init; } = new();
        public string Reason { get; init; } = "";
    }

    /// <summary>
    /// Structural editor for a ToolStrip/MenuStrip item tree. SLICE 1 supports READ + REORDER only: it rewrites the
    /// element ORDER inside each <c>Items</c>/<c>DropDownItems</c> <c>AddRange</c> to a permutation of the SAME items,
    /// leaving every other statement (item constructions, property blocks) byte-identical — so items' unmanaged
    /// properties are preserved and the change is airtight-gateable. Adding / removing / renaming items are follow-up
    /// slices that plug into the same read + wiring.
    /// </summary>
    public static class DesignerToolStripItemEditor
    {
        // The two ToolStripItemCollection properties that hold items (a strip's Items, a menu item's DropDownItems).
        private static readonly HashSet<string> ItemCollections = new(StringComparer.Ordinal) { "Items", "DropDownItems" };

        // Allowlist of ToolStrip item types a NEW ("Type Here") item may be constructed as — short name → full name.
        // Only these ever reach `new <type>()`; an unknown/host-supplied type is refused (no arbitrary type injection).
        private static readonly Dictionary<string, string> ItemTypeFqns = new(StringComparer.Ordinal)
        {
            { "ToolStripMenuItem", "System.Windows.Forms.ToolStripMenuItem" },
            { "ToolStripButton", "System.Windows.Forms.ToolStripButton" },
            { "ToolStripLabel", "System.Windows.Forms.ToolStripLabel" },
            { "ToolStripSeparator", "System.Windows.Forms.ToolStripSeparator" },
            { "ToolStripComboBox", "System.Windows.Forms.ToolStripComboBox" },
            { "ToolStripTextBox", "System.Windows.Forms.ToolStripTextBox" },
            { "ToolStripDropDownButton", "System.Windows.Forms.ToolStripDropDownButton" },
            { "ToolStripSplitButton", "System.Windows.Forms.ToolStripSplitButton" },
            { "ToolStripProgressBar", "System.Windows.Forms.ToolStripProgressBar" },
            { "ToolStripStatusLabel", "System.Windows.Forms.ToolStripStatusLabel" },
        };

        private static string? ItemFqn(string itemTypeShort)
        {
            string key = string.IsNullOrEmpty(itemTypeShort) ? "ToolStripMenuItem" : ShortName(itemTypeShort);
            return ItemTypeFqns.TryGetValue(key, out var fqn) ? fqn : null;
        }

        // Item types that own a DropDownItems collection (not Items) — used to pick the collection name when SYNTHESIZING
        // a fresh AddRange, since the "…" editor can be rooted on a menu item (its DropDownItems), not only on a strip.
        private static readonly HashSet<string> DropDownItemTypes = new(StringComparer.Ordinal)
        {
            "ToolStripMenuItem", "ToolStripDropDownButton", "ToolStripSplitButton",
        };

        private sealed class NewItem
        {
            public string Id = "";
            public string Fqn = "";
            public string Text = "";
        }

        // ---- read ----

        public static ToolStripItemsResult ListItems(string sourceText, string ownerId)
        {
            if (!IsValidIdentifier(ownerId)) return Bad("invalid owner id: " + ownerId);
            var root = CSharpSyntaxTree.ParseText(sourceText).GetRoot();
            var cls = FindClassWithIC(root);
            var init = cls?.Members.OfType<MethodDeclarationSyntax>().FirstOrDefault(m => m.Identifier.Text == "InitializeComponent");
            if (cls == null || init?.Body == null) return Bad("InitializeComponent not found");
            var fields = GatherFieldNames(cls);
            if (!fields.Contains(ownerId)) return Bad("unknown owner " + ownerId);
            var ctorTypes = BuildCtorTypeMap(init, fields);
            var visited = new HashSet<string>(StringComparer.Ordinal);
            if (!TryReadForest(init, ownerId, ctorTypes, fields, visited, out var forest, out var reason))
                return new ToolStripItemsResult { Ok = false, Reason = reason };
            return new ToolStripItemsResult { Ok = true, Items = forest };
        }

        /// <summary>The items directly owned by <paramref name="receiverId"/> (its Items/DropDownItems), recursively.
        /// Every element must be a simple <c>this.&lt;field&gt;</c> reference and each field a modelled item; anything
        /// else (an inline item, a shared/duplicated item, multiple Add/AddRange calls on one collection) makes the
        /// whole tree read-only so a later edit never clobbers a shape it can't round-trip.</summary>
        private static bool TryReadForest(MethodDeclarationSyntax init, string receiverId,
            Dictionary<string, string> ctorTypes, HashSet<string> fields, HashSet<string> visited,
            out List<ToolStripItemModel> forest, out string reason)
        {
            forest = new List<ToolStripItemModel>();
            reason = "";
            if (!GetCollectionElements(init, receiverId, out _, out var elementIds, out reason)) return false;
            if (elementIds == null) return true; // no item collection on this receiver → empty (a leaf item)
            foreach (var id in elementIds)
            {
                if (!fields.Contains(id)) { reason = "item " + id + " is not a field"; return false; }
                if (!visited.Add(id)) { reason = "item " + id + " is referenced more than once (shared item)"; return false; }
                var model = new ToolStripItemModel
                {
                    Id = id,
                    Name = ReadStringProp(init, id, "Name"),
                    Text = ReadStringProp(init, id, "Text"),
                    ItemType = ctorTypes.TryGetValue(id, out var t) ? t : "",
                };
                if (!TryReadForest(init, id, ctorTypes, fields, visited, out var kids, out reason)) return false;
                model.Children = kids;
                forest.Add(model);
            }
            return true;
        }

        /// <summary>The ordered element field-ids of <paramref name="receiverId"/>'s single Items/DropDownItems
        /// Add/AddRange call. <paramref name="elementIds"/> is null when the receiver has no such collection call.
        /// Refuses (returns false) when a collection has MORE THAN ONE add call, or an element isn't a simple
        /// <c>this.&lt;id&gt;</c> ref — either keeps the tree read-only.</summary>
        private static bool GetCollectionElements(MethodDeclarationSyntax init, string receiverId,
            out string? collName, out List<string>? elementIds, out string reason)
        {
            collName = null; elementIds = null; reason = "";
            StatementSyntax? found = null; string? foundColl = null; int calls = 0;
            foreach (var st in init.Body!.Statements)
            {
                // Only Add/AddRange calls that target THIS receiver's Items/DropDownItems matter.
                if (!IsItemCollectionMemberCall(st, receiverId, out var coll)) continue;
                // It populates this receiver's item collection but is a shape we can't model (e.g. the 3-arg
                // Items.Add(string, Image, EventHandler) overload, or an AddRange without an inline array). Refuse the
                // whole tree read-only rather than skipping it and presenting a populated menu as empty — matching how
                // every other unsupported shape (multiple calls, inline/shared items) is refused.
                if (!IsItemCollectionCall(st, receiverId, out _, out _))
                {
                    reason = "item " + receiverId + " populates its items through an unsupported Add/AddRange call";
                    return false;
                }
                calls++;
                if (found == null) { found = st; foundColl = coll; }
                else if (foundColl != coll || calls > 1)
                {
                    reason = "item " + receiverId + " populates its items through more than one Add/AddRange call";
                    return false;
                }
            }
            if (found == null) return true; // no collection → leaf
            collName = foundColl;
            var ids = new List<string>();
            if (!IsItemCollectionCall(found, receiverId, out _, out var elems) || elems == null)
            { reason = "unexpected item collection shape on " + receiverId; return false; }
            foreach (var e in elems)
            {
                var f = Flatten(e);
                if (f.Count != 1) { reason = "item " + receiverId + " has a non-field element"; return false; }
                ids.Add(f[0]);
            }
            elementIds = ids;
            return true;
        }

        /// <summary>True for <c>this.&lt;receiverId&gt;.Items.Add/AddRange(...)</c> or
        /// <c>this.&lt;receiverId&gt;.DropDownItems.Add/AddRange(...)</c>. Emits the collection name and the element
        /// expressions (a single arg for Add; the array-initializer elements for AddRange).</summary>
        private static bool IsItemCollectionCall(StatementSyntax st, string receiverId, out string? collName, out IReadOnlyList<ExpressionSyntax>? elements)
        {
            collName = null; elements = null;
            if (st is not ExpressionStatementSyntax { Expression: InvocationExpressionSyntax inv }) return false;
            if (inv.Expression is not MemberAccessExpressionSyntax ma) return false;
            string method = ma.Name.Identifier.Text;
            if (method != "Add" && method != "AddRange") return false;
            var chain = Flatten(ma.Expression); // [receiverId, coll]
            if (chain.Count != 2 || chain[0] != receiverId || !ItemCollections.Contains(chain[1])) return false;
            collName = chain[1];
            if (method == "Add")
            {
                if (inv.ArgumentList.Arguments.Count != 1) return false;
                elements = new List<ExpressionSyntax> { inv.ArgumentList.Arguments[0].Expression };
                return true;
            }
            var initz = FindArrayInitializer(st);
            if (initz == null) return false;
            elements = initz.Expressions.ToList();
            return true;
        }

        /// <summary>True for ANY <c>this.&lt;receiverId&gt;.Items|DropDownItems.Add|AddRange(...)</c> regardless of the
        /// argument shape. Distinguishes "no item-collection call on this receiver" (a genuine leaf) from "an
        /// item-collection call we can't model" (which must be refused read-only, never shown as an empty leaf).</summary>
        private static bool IsItemCollectionMemberCall(StatementSyntax st, string receiverId, out string? collName)
        {
            collName = null;
            if (st is not ExpressionStatementSyntax { Expression: InvocationExpressionSyntax inv }) return false;
            if (inv.Expression is not MemberAccessExpressionSyntax ma) return false;
            string method = ma.Name.Identifier.Text;
            if (method != "Add" && method != "AddRange") return false;
            var chain = Flatten(ma.Expression); // [receiverId, coll]
            if (chain.Count != 2 || chain[0] != receiverId || !ItemCollections.Contains(chain[1])) return false;
            collName = chain[1];
            return true;
        }

        private static Dictionary<string, string> BuildCtorTypeMap(MethodDeclarationSyntax init, HashSet<string> fields)
        {
            var map = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var st in init.Body!.Statements)
            {
                if (st is not ExpressionStatementSyntax { Expression: AssignmentExpressionSyntax asn }) continue;
                var lhs = Flatten(asn.Left);
                if (lhs.Count != 1 || !fields.Contains(lhs[0])) continue;
                if (asn.Right is ObjectCreationExpressionSyntax oce) map[lhs[0]] = ShortName(oce.Type.ToString());
            }
            return map;
        }

        private static string ReadStringProp(MethodDeclarationSyntax init, string id, string prop)
        {
            foreach (var st in init.Body!.Statements)
            {
                if (st is not ExpressionStatementSyntax { Expression: AssignmentExpressionSyntax asn }) continue;
                var lhs = Flatten(asn.Left);
                if (lhs.Count == 2 && lhs[0] == id && lhs[1] == prop
                    && asn.Right is LiteralExpressionSyntax lit && lit.IsKind(SyntaxKind.StringLiteralExpression))
                    return lit.Token.ValueText;
            }
            return "";
        }

        // ---- write (Slice 2: reorder + ADD "Type Here") ----

        /// <summary>Rewrite the item tree of <paramref name="ownerId"/> to <paramref name="desired"/>. Accepts a
        /// REORDER and/or an ADD: an item with an EMPTY <see cref="ToolStripItemModel.Id"/> is a NEW item — a field +
        /// <c>this.&lt;id&gt; = new &lt;Type&gt;()</c> + Name/Text is synthesized and the id is appended into the
        /// owner's <c>Items</c> / a parent item's <c>DropDownItems</c> AddRange (the AddRange is CREATED if the parent
        /// had none). Every EXISTING item and statement stays byte-identical, so unmanaged item props (Image/
        /// ShortcutKeys/Checked/…) are preserved. Removing, reparenting or renaming an existing item — and adding a
        /// submenu under a brand-new item, or appending onto a non-<c>AddRange</c> collection — are refused (follow-up
        /// slices). The new items' constructions are placed with the other constructions (before any AddRange) so every
        /// referenced field is assigned before the AddRange that uses it.</summary>
        public static EditResult SetItems(string sourceText, string ownerId, IReadOnlyList<ToolStripItemModel> desired)
        {
            if (!IsValidIdentifier(ownerId)) return Failed("invalid owner id: " + ownerId);
            var root = CSharpSyntaxTree.ParseText(sourceText).GetRoot();
            var cls = FindClassWithIC(root);
            var init = cls?.Members.OfType<MethodDeclarationSyntax>().FirstOrDefault(m => m.Identifier.Text == "InitializeComponent");
            if (cls == null || init?.Body == null) return Failed("InitializeComponent not found");
            var fields = GatherFieldNames(cls);
            if (!fields.Contains(ownerId)) return Failed("unknown owner " + ownerId);
            var ctorTypes = BuildCtorTypeMap(init, fields);
            if (!TryReadForest(init, ownerId, ctorTypes, fields, new HashSet<string>(StringComparer.Ordinal), out var current, out var readReason))
                return Failed(readReason);

            // (1) resolve the desired forest: mint a unique field name for every NEW item (empty Id) and validate every
            // existing id. `used` is seeded from all field + local names so a minted name can never shadow one.
            var currentSet = new HashSet<string>(StringComparer.Ordinal);
            CollectItemIds(current, currentSet);
            var used = new HashSet<string>(fields, StringComparer.Ordinal);
            foreach (var l in GatherLocalNames(init)) used.Add(l);
            var newItems = new List<NewItem>();
            if (!ResolveNewIds(desired, currentSet, used, new HashSet<string>(StringComparer.Ordinal), newItems, out var resolved, out var resolveReason))
                return Failed(resolveReason);
            var newIds = new HashSet<string>(newItems.Select(n => n.Id), StringComparer.Ordinal);

            // (2) per-receiver child-order maps. Existing items must be preserved per receiver (⊇); any extra id must be
            // one of the freshly-minted new ids. Removing / reparenting an existing item is refused.
            var cur = new Dictionary<string, List<string>>(StringComparer.Ordinal);
            CollectOrders(ownerId, current, cur);
            var des = new Dictionary<string, List<string>>(StringComparer.Ordinal);
            CollectOrders(ownerId, resolved, des);

            foreach (var kv in cur)
            {
                if (!des.TryGetValue(kv.Key, out var d)) return Failed("removing an item is not supported yet (under " + kv.Key + ")");
                foreach (var id in kv.Value) if (!d.Contains(id)) return Failed("removing/reparenting an existing item is not supported yet (" + id + ")");
                foreach (var id in d) if (!kv.Value.Contains(id) && !newIds.Contains(id)) return Failed("unexpected item under " + kv.Key + ": " + id);
            }
            // a receiver present in desired but not current = a childless item gaining its FIRST child (or a new
            // submenu). It must be an EXISTING item and every one of its children must be new (no reparent).
            foreach (var kv in des)
            {
                if (cur.ContainsKey(kv.Key)) continue;
                if (kv.Key != ownerId && !currentSet.Contains(kv.Key)) return Failed("unknown receiver " + kv.Key);
                foreach (var id in kv.Value) if (!newIds.Contains(id)) return Failed("reparenting an existing item is not supported yet (" + id + " under " + kv.Key + ")");
            }

            // (3) which receivers' AddRange must change, split into GROW (an AddRange exists → append/reorder in place)
            // vs CREATE (no AddRange in source → synthesize one).
            var changed = new List<string>();
            foreach (var kv in des)
            {
                cur.TryGetValue(kv.Key, out var c);
                if (c == null || !c.SequenceEqual(kv.Value)) changed.Add(kv.Key);
            }
            if (changed.Count == 0 && newItems.Count == 0) return new EditResult { NewText = sourceText, Mode = EditMode.Replace }; // no-op
            var grow = new List<string>();
            var create = new List<string>();
            foreach (var recv in changed)
                (init.Body.Statements.Any(s => IsItemCollectionCall(s, recv, out _, out _)) ? grow : create).Add(recv);

            // (4) Phase 1 (text splice): synthesize each new item's construction + Name/Text and any freshly-CREATED
            // AddRange, as one block placed at the end of the leading construction run (before every AddRange / layout
            // call) so a referenced field is assigned before it is used. A created AddRange references the RECEIVER (an
            // existing field) too — if that receiver's own construction is NOT in the leading run (an interleaved/late
            // construction), the created AddRange would precede it → runtime null-ref; refuse rather than emit that.
            string nl = sourceText.Contains("\r\n") ? "\r\n" : "\n";
            string bodyIndent = BodyIndentOf(sourceText, init);
            int insertPos = ConstructionInsertPos(sourceText, init, fields);
            foreach (var recv in create)
            {
                var recvCtor = FindConstruction(init, recv, fields);
                if (recvCtor == null || recvCtor.Span.End > insertPos)
                    return Failed("cannot add a first child to '" + recv + "' — its construction is not in the leading block");
            }
            var block = new StringBuilder();
            void Emit(string s) { block.Append(bodyIndent).Append(s).Append(nl); }
            foreach (var ni in newItems)
            {
                Emit($"this.{ni.Id} = new {ni.Fqn}();");
                Emit($"this.{ni.Id}.Name = {SyntaxFactory.Literal(ni.Id)};");
                // a ToolStripSeparator has no meaningful Text (VS never emits it); every other item type carries it.
                if (ni.Text.Length > 0 && ni.Fqn != "System.Windows.Forms.ToolStripSeparator")
                    Emit($"this.{ni.Id}.Text = {SyntaxFactory.Literal(ni.Text)};");
            }
            foreach (var recv in create)
            {
                // the collection name depends on the RECEIVER's TYPE, not on recv==ownerId: the editor can be rooted on
                // a menu item (whose collection is DropDownItems, NOT Items). A nested modelled item is always DropDownItems.
                string coll;
                if (recv == ownerId)
                {
                    string t = ctorTypes.TryGetValue(ownerId, out var tt) ? tt : "";
                    coll = DropDownItemTypes.Contains(t) ? "DropDownItems" : "Items";
                }
                else coll = "DropDownItems";
                string elems = string.Join(", ", des[recv].Select(id => "this." + id));
                Emit($"this.{recv}.{coll}.AddRange(new System.Windows.Forms.ToolStripItem[] {{ {elems} }});");
            }
            string srcWithItems = sourceText;
            if (block.Length > 0)
                srcWithItems = sourceText.Substring(0, insertPos) + block.ToString() + sourceText.Substring(insertPos);
            foreach (var ni in newItems)
            {
                var withField = InsertFieldDecl(srcWithItems, ni.Fqn, ni.Id, nl);
                if (withField == null) return Failed("could not place the field declaration for " + ni.Id);
                srcWithItems = withField;
            }

            // (5) Phase 2 (Roslyn): grow/reorder each EXISTING AddRange to its full desired order — existing element
            // nodes are reused (trivia preserved), a new id is appended as a `this.<id>` element with sibling
            // indentation and a cloned comma+newline separator. Re-parse the Phase-1 text first.
            var root2 = CSharpSyntaxTree.ParseText(srcWithItems).GetRoot();
            var cls2 = FindClassWithIC(root2);
            var init2 = cls2?.Members.OfType<MethodDeclarationSyntax>().FirstOrDefault(m => m.Identifier.Text == "InitializeComponent");
            if (cls2 == null || init2?.Body == null) return Failed("re-parse lost InitializeComponent");
            var newInit = init2;
            foreach (var recv in grow)
            {
                var target = newInit.Body!.Statements.FirstOrDefault(s => IsItemCollectionCall(s, recv, out _, out _));
                if (target == null) return Failed("could not find the item collection of " + recv);
                var initz = FindArrayInitializer(target);
                if (initz == null) return Failed("collection shape changed for " + recv);
                var origElems = initz.Expressions.ToList();
                if (origElems.Count == 0) return Failed("cannot add to an empty item collection under " + recv);
                var byId = new Dictionary<string, ExpressionSyntax>(StringComparer.Ordinal);
                foreach (var e in origElems) { var f = Flatten(e); if (f.Count == 1) byId[f[0]] = e; }
                // a new element's leading trivia = the sibling's INDENT only (the whitespace after the last newline of
                // the first element's leading trivia). Copying the first element's trivia verbatim would DUPLICATE a
                // leading comment on it, which the comment-multiset gate then rejects — so take just the indent.
                string lead0 = origElems[0].GetLeadingTrivia().ToFullString();
                int lnl = lead0.LastIndexOf('\n');
                var newLeading = SyntaxFactory.TriviaList(SyntaxFactory.Whitespace(lnl >= 0 ? lead0.Substring(lnl + 1) : lead0));
                var reordered = new List<ExpressionSyntax>();
                foreach (var id in des[recv])
                {
                    if (byId.TryGetValue(id, out var node)) reordered.Add(node);
                    else if (newIds.Contains(id)) reordered.Add(SyntaxFactory.ParseExpression("this." + id).WithLeadingTrivia(newLeading));
                    else return Failed("could not locate item " + id + " under " + recv);
                }
                // Reuse the original separators positionally (they carry the inter-element newline as trailing trivia);
                // for each element appended beyond the original count, clone a comma + newline. This keeps existing
                // lines/comments intact and lays a new element on its own line.
                var origSeps = initz.Expressions.GetSeparators().ToList();
                var seps = new List<SyntaxToken>();
                for (int i = 0; i < reordered.Count - 1; i++)
                    seps.Add(i < origSeps.Count ? origSeps[i] : SyntaxFactory.Token(SyntaxKind.CommaToken).WithTrailingTrivia(SyntaxFactory.EndOfLine(nl)));
                var newList = reordered.Count <= 1
                    ? SyntaxFactory.SeparatedList(reordered)
                    : SyntaxFactory.SeparatedList(reordered, seps);
                newInit = newInit.ReplaceNode(initz, initz.WithExpressions(newList));
            }

            var newCls = cls2.ReplaceNode(init2, newInit);
            string edited = root2.ReplaceNode(cls2, newCls).ToFullString();
            // the airtight safe-save gate (OnlyItemsAddedOrReordered) is applied by the DesignerRenderer wrapper,
            // mirroring ApplyNodesEdit/ApplyColumnsEdit (which report parseOk + minimal separately).
            return new EditResult { NewText = edited, Mode = EditMode.Replace };
        }

        /// <summary>Record every receiver→[childIds] pair in a forest: the owner's roots, then each item's children.</summary>
        private static void CollectOrders(string receiverId, IReadOnlyList<ToolStripItemModel> items, Dictionary<string, List<string>> into)
        {
            into[receiverId] = items.Select(i => i.Id).ToList();
            foreach (var it in items)
                if (it.Children.Count > 0) CollectOrders(it.Id, it.Children, into);
        }

        // ---- add ("Type Here") helpers ----

        private static void CollectItemIds(IReadOnlyList<ToolStripItemModel> items, HashSet<string> into)
        {
            foreach (var it in items) { into.Add(it.Id); CollectItemIds(it.Children, into); }
        }

        private static IEnumerable<string> GatherLocalNames(MethodDeclarationSyntax init) =>
            init.Body!.DescendantNodes().OfType<VariableDeclaratorSyntax>().Select(v => v.Identifier.Text);

        /// <summary>Copy the desired forest, validating existing ids and minting a unique field name for every NEW
        /// item (empty Id). A new item must be a whitelisted type and (for this slice) a LEAF — a submenu under a
        /// brand-new item is refused. Every minted name is added to <paramref name="used"/> so two new siblings never
        /// collide, and to <paramref name="seen"/> alongside existing ids.</summary>
        private static bool ResolveNewIds(IReadOnlyList<ToolStripItemModel> items, HashSet<string> currentSet,
            HashSet<string> used, HashSet<string> seen, List<NewItem> newItems, out List<ToolStripItemModel> resolved, out string reason)
        {
            resolved = new List<ToolStripItemModel>();
            reason = "";
            foreach (var d in items)
            {
                string id = d.Id ?? "";
                List<ToolStripItemModel> kids;
                if (id.Length > 0)
                {
                    if (!currentSet.Contains(id)) { reason = "unknown item id: " + id; return false; }
                    if (!seen.Add(id)) { reason = "duplicate item id: " + id; return false; }
                    if (!ResolveNewIds(d.Children ?? new List<ToolStripItemModel>(), currentSet, used, seen, newItems, out kids, out reason)) return false;
                }
                else
                {
                    if ((d.Children?.Count ?? 0) > 0) { reason = "adding a submenu under a new item is not supported yet"; return false; }
                    var fqn = ItemFqn(d.ItemType ?? "");
                    if (fqn == null) { reason = "unsupported new item type: " + (d.ItemType ?? ""); return false; }
                    string baseName = ShortName(fqn);
                    baseName = char.ToLowerInvariant(baseName[0]) + baseName.Substring(1);
                    id = UniqueName(baseName, used);
                    if (!IsValidIdentifier(id)) { reason = "could not generate a valid item name"; return false; }
                    used.Add(id); seen.Add(id);
                    newItems.Add(new NewItem { Id = id, Fqn = fqn, Text = d.Text ?? "" });
                    kids = new List<ToolStripItemModel>();
                }
                resolved.Add(new ToolStripItemModel { Id = id, Text = d.Text ?? "", Name = d.Name ?? "", ItemType = d.ItemType ?? "", Children = kids });
            }
            return true;
        }

        private static string UniqueName(string baseName, HashSet<string> used)
        {
            for (int i = 1; i < 100000; i++) { string c = baseName + i.ToString(System.Globalization.CultureInfo.InvariantCulture); if (!used.Contains(c)) return c; }
            return baseName + "_x";
        }

        /// <summary>The <c>this.&lt;id&gt; = new …();</c> construction statement for field <paramref name="id"/>, or null.</summary>
        private static StatementSyntax? FindConstruction(MethodDeclarationSyntax init, string id, HashSet<string> fields)
        {
            foreach (var st in init.Body!.Statements)
                if (st is ExpressionStatementSyntax { Expression: AssignmentExpressionSyntax { Right: ObjectCreationExpressionSyntax } asn }
                    && Flatten(asn.Left) is { Count: 1 } lhs && lhs[0] == id && fields.Contains(id))
                    return st;
            return null;
        }

        /// <summary>The leading indentation of the first InitializeComponent statement (used for synthesized lines).</summary>
        private static string BodyIndentOf(string src, MethodDeclarationSyntax init)
        {
            var first = init.Body!.Statements.FirstOrDefault();
            int pos = first?.SpanStart ?? init.Body.OpenBraceToken.Span.End;
            return IndentAt(src, pos);
        }

        /// <summary>Source position at the START of the FIRST InitializeComponent statement that is NOT a
        /// <c>this.&lt;field&gt; = new …();</c> construction — i.e. the end of the leading construction run. New items'
        /// constructions splice here, ahead of every AddRange / layout call, so a referenced field is ALWAYS assigned
        /// before it is used (even if the file interleaves an AddRange among later constructions).</summary>
        private static int ConstructionInsertPos(string src, MethodDeclarationSyntax init, HashSet<string> fields)
        {
            foreach (var st in init.Body!.Statements)
            {
                bool isCtor = st is ExpressionStatementSyntax { Expression: AssignmentExpressionSyntax { Right: ObjectCreationExpressionSyntax } asn }
                    && Flatten(asn.Left) is { Count: 1 } lhs && fields.Contains(lhs[0]);
                if (!isCtor) return src.LastIndexOf('\n', Math.Max(0, st.SpanStart - 1)) + 1; // start of this line
            }
            // all statements are constructions (or the body is empty) — append after the last / just inside the brace.
            int anchorEnd = init.Body.Statements.LastOrDefault()?.Span.End ?? init.Body.OpenBraceToken.Span.End;
            int nlIdx = src.IndexOf('\n', anchorEnd);
            return nlIdx < 0 ? src.Length : nlIdx + 1;
        }

        /// <summary>Insert a <c>private &lt;fqn&gt; &lt;id&gt;;</c> field declaration after the last existing field
        /// (re-parses to locate it, mirroring the control editor). Returns null if the class can't be found.</summary>
        private static string? InsertFieldDecl(string text, string fqn, string id, string nl)
        {
            var root = CSharpSyntaxTree.ParseText(text).GetRoot();
            var cls = FindClassWithIC(root);
            if (cls == null) return null;
            var flds = cls.Members.OfType<FieldDeclarationSyntax>().ToList();
            string indent; int pos;
            if (flds.Count > 0)
            {
                var lastF = flds[flds.Count - 1];
                indent = IndentAt(text, lastF.SpanStart);
                int afterSemi = lastF.Span.End;
                int nlIdx = text.IndexOf('\n', afterSemi);
                pos = nlIdx < 0 ? text.Length : nlIdx + 1;
            }
            else
            {
                var m = cls.Members.FirstOrDefault();
                indent = m != null ? IndentAt(text, m.SpanStart) : "    ";
                int cb = cls.CloseBraceToken.SpanStart;
                pos = text.LastIndexOf('\n', Math.Max(0, cb - 1)) + 1;
            }
            return text.Substring(0, pos) + indent + $"private {fqn} {id};" + nl + text.Substring(pos);
        }

        private static string IndentAt(string text, int pos)
        {
            int ls = text.LastIndexOf('\n', Math.Max(0, pos - 1)) + 1;
            int i = ls;
            while (i < text.Length && (text[i] == ' ' || text[i] == '\t')) i++;
            return text.Substring(ls, i - ls);
        }

        // ---- safe-save gate ----

        /// <summary>Airtight gate for a reorder-and/or-ADD edit. Derives the set of NEW ids purely from the field-decl
        /// diff (edited − original), then proves: every ORIGINAL field is kept and exactly the new fields were added
        /// (and exactly that many class members, so no property/method is smuggled via a crafted type token); every
        /// ORIGINAL non-AddRange statement is preserved byte-identical and every ADDED one references ONLY new ids
        /// (so an existing item's construction / property block can never be altered); each ORIGINAL item-collection
        /// AddRange keeps all its element ids (order may differ), any extra element is a new id, and its comment trivia
        /// is intact; any freshly-CREATED AddRange contains only new ids. With no new ids this reduces exactly to the
        /// Slice-1 reorder gate.</summary>
        public static bool OnlyItemsAddedOrReordered(string original, string edited)
        {
            var oRoot = CSharpSyntaxTree.ParseText(original).GetRoot();
            var eRoot = CSharpSyntaxTree.ParseText(edited).GetRoot();

            // fields: originals preserved; the added ones are exactly the new ids (derive newIds from the diff).
            var oF = FieldDeclNames(oRoot); var eF = FieldDeclNames(eRoot);
            var oFset = new HashSet<string>(oF, StringComparer.Ordinal);
            var eFset = new HashSet<string>(eF, StringComparer.Ordinal);
            if (!oFset.IsSubsetOf(eFset)) return false;                       // no original field removed/renamed
            var newIds = new HashSet<string>(eFset, StringComparer.Ordinal); newIds.ExceptWith(oFset);
            if (eF.Count != oF.Count + newIds.Count) return false;            // exactly the new fields, no dup decl
            if (ClassMemberCount(eRoot) != ClassMemberCount(oRoot) + newIds.Count) return false; // no smuggled member

            var oStmts = InitStatementNodes(oRoot);
            var eStmts = InitStatementNodes(eRoot);

            // partition into item-collection AddRanges vs the rest. Keep the EDITED non-AddRange nodes so an added
            // statement's field references are read from the AST — a menu Text literal that happens to contain
            // "this.<field>" must never be mistaken for a code reference to that field.
            var oOther = new List<string>(); var oAdd = new List<(string recv, string coll, HashSet<string> ids, List<string> comments)>();
            var eOtherNodes = new List<StatementSyntax>(); var eAdd = new List<(string recv, string coll, HashSet<string> ids, List<string> comments)>();
            foreach (var st in oStmts) { if (TryItemAddRange(st, out var r, out var c, out var ids)) oAdd.Add((r!, c!, ids!, CommentTexts(st))); else oOther.Add(NormalizeStmt(st.ToString())); }
            foreach (var st in eStmts) { if (TryItemAddRange(st, out var r, out var c, out var ids)) eAdd.Add((r!, c!, ids!, CommentTexts(st))); else eOtherNodes.Add(st); }
            var eOther = eOtherNodes.Select(n => NormalizeStmt(n.ToString())).ToList();

            // every ORIGINAL non-AddRange statement survives; every ADDED one references (via the AST) ONLY new ids
            // (≥1) — so it can only be a new item's construction/Name/Text, never a touch of an existing item.
            if (!MultisetSubset(oOther, eOther)) return false;
            var oOtherLeft = Counter(oOther);
            foreach (var node in eOtherNodes)
            {
                string norm = NormalizeStmt(node.ToString());
                if (oOtherLeft.TryGetValue(norm, out var n) && n > 0) { oOtherLeft[norm] = n - 1; continue; } // matches an original → preserved
                var refd = AstReferencedFields(node, eFset);
                if (refd.Count == 0 || refd.Any(f => !newIds.Contains(f))) return false;
            }

            string Key(string r, string c) => r + "." + c;
            var oByKey = oAdd.GroupBy(a => Key(a.recv, a.coll)).ToDictionary(g => g.Key, g => g.ToList());
            var eByKey = eAdd.GroupBy(a => Key(a.recv, a.coll)).ToDictionary(g => g.Key, g => g.ToList());
            // every ORIGINAL AddRange preserved: all its ids kept (order may differ), extras are new, comments intact.
            foreach (var kv in oByKey)
            {
                if (kv.Value.Count != 1) return false; // read enforced a single AddRange per collection
                if (!eByKey.TryGetValue(kv.Key, out var el) || el.Count != 1) return false;
                var oIds = kv.Value[0].ids; var eIds = el[0].ids;
                if (!oIds.IsSubsetOf(eIds)) return false;                     // no existing element removed
                foreach (var id in eIds) if (!oIds.Contains(id) && !newIds.Contains(id)) return false; // extras are new
                if (!SameMultiset(kv.Value[0].comments, el[0].comments)) return false; // no comment dropped/added
            }
            // a freshly-created AddRange (edited-only key) must hold only new ids.
            foreach (var kv in eByKey)
            {
                if (oByKey.ContainsKey(kv.Key)) continue;
                if (kv.Value.Count != 1) return false;
                foreach (var id in kv.Value[0].ids) if (!newIds.Contains(id)) return false;
            }
            return true;
        }

        private static int ClassMemberCount(SyntaxNode root) => FindClassWithIC(root)?.Members.Count ?? 0;

        private static bool MultisetSubset(List<string> a, List<string> b)
        {
            var cb = Counter(b);
            foreach (var kv in Counter(a)) if (!cb.TryGetValue(kv.Key, out var n) || n < kv.Value) return false;
            return true;
        }

        /// <summary>The set of field ids a statement references as <c>this.&lt;id&gt;</c>, read from the AST — so a
        /// string-literal <c>Text</c> that happens to contain "this.&lt;field&gt;" is never counted as a code reference.</summary>
        private static HashSet<string> AstReferencedFields(StatementSyntax st, HashSet<string> allFields)
        {
            var refd = new HashSet<string>(StringComparer.Ordinal);
            foreach (var ma in st.DescendantNodesAndSelf().OfType<MemberAccessExpressionSyntax>())
                if (ma.Expression is ThisExpressionSyntax && allFields.Contains(ma.Name.Identifier.Text))
                    refd.Add(ma.Name.Identifier.Text);
            return refd;
        }

        /// <summary>The comment-trivia texts within a statement (single- and multi-line, incl. doc comments), as a
        /// multiset — so the reorder gate can prove no comment was silently added or dropped from an AddRange.</summary>
        private static List<string> CommentTexts(SyntaxNode node) =>
            node.DescendantTrivia()
                .Where(t => t.IsKind(SyntaxKind.SingleLineCommentTrivia) || t.IsKind(SyntaxKind.MultiLineCommentTrivia)
                         || t.IsKind(SyntaxKind.SingleLineDocumentationCommentTrivia) || t.IsKind(SyntaxKind.MultiLineDocumentationCommentTrivia))
                .Select(t => t.ToString())
                .ToList();

        /// <summary>True for ANY <c>&lt;recv&gt;.Items|DropDownItems.AddRange(new[]{ this.&lt;id&gt;, … })</c> whose
        /// elements are all simple field refs; emits the receiver id, collection name and element id set.</summary>
        private static bool TryItemAddRange(StatementSyntax st, out string? recv, out string? coll, out HashSet<string>? ids)
        {
            recv = null; coll = null; ids = null;
            if (st is not ExpressionStatementSyntax { Expression: InvocationExpressionSyntax inv }) return false;
            if (inv.Expression is not MemberAccessExpressionSyntax ma || ma.Name.Identifier.Text != "AddRange") return false;
            var chain = Flatten(ma.Expression);
            if (chain.Count != 2 || !ItemCollections.Contains(chain[1])) return false;
            var initz = FindArrayInitializer(st);
            if (initz == null) return false;
            var set = new HashSet<string>(StringComparer.Ordinal);
            foreach (var e in initz.Expressions)
            {
                var f = Flatten(e);
                if (f.Count != 1) return false;
                set.Add(f[0]);
            }
            recv = chain[0]; coll = chain[1]; ids = set;
            return true;
        }

        // ---- helpers (own copies — the proven editors stay untouched) ----

        private static ToolStripItemsResult Bad(string reason) => new() { Ok = false, Reason = reason };
        private static EditResult Failed(string reason) => new() { Mode = EditMode.Failed, Reason = reason };

        private static bool SameSet(List<string> a, List<string> b) =>
            a.Count == b.Count && new HashSet<string>(a, StringComparer.Ordinal).SetEquals(b);

        private static bool SameMultiset(List<string> a, List<string> b)
        {
            if (a.Count != b.Count) return false;
            var ca = Counter(a); var cb = Counter(b);
            if (ca.Count != cb.Count) return false;
            foreach (var kv in ca) if (!cb.TryGetValue(kv.Key, out var n) || n != kv.Value) return false;
            return true;
        }

        private static InitializerExpressionSyntax? FindArrayInitializer(StatementSyntax st)
        {
            if (st is not ExpressionStatementSyntax { Expression: InvocationExpressionSyntax inv }) return null;
            if (inv.ArgumentList.Arguments.Count != 1) return null;
            return inv.ArgumentList.Arguments[0].Expression switch
            {
                ArrayCreationExpressionSyntax a => a.Initializer,
                ImplicitArrayCreationExpressionSyntax ia => ia.Initializer,
                _ => null,
            };
        }

        private static ClassDeclarationSyntax? FindClassWithIC(SyntaxNode root)
        {
            foreach (var cls in root.DescendantNodes().OfType<ClassDeclarationSyntax>())
                if (cls.Members.OfType<MethodDeclarationSyntax>().Any(m => m.Identifier.Text == "InitializeComponent"))
                    return cls;
            return null;
        }

        private static HashSet<string> GatherFieldNames(ClassDeclarationSyntax cls)
        {
            var set = new HashSet<string>(StringComparer.Ordinal);
            foreach (var f in cls.Members.OfType<FieldDeclarationSyntax>())
                foreach (var v in f.Declaration.Variables)
                    set.Add(v.Identifier.Text);
            return set;
        }

        private static List<string> FieldDeclNames(SyntaxNode root)
        {
            var cls = FindClassWithIC(root);
            var list = new List<string>();
            if (cls != null)
                foreach (var f in cls.Members.OfType<FieldDeclarationSyntax>())
                    foreach (var v in f.Declaration.Variables)
                        list.Add(v.Identifier.Text);
            return list;
        }

        private static List<StatementSyntax> InitStatementNodes(SyntaxNode root)
        {
            var cls = FindClassWithIC(root);
            var init = cls?.Members.OfType<MethodDeclarationSyntax>().FirstOrDefault(m => m.Identifier.Text == "InitializeComponent");
            return init?.Body != null ? init.Body.Statements.ToList() : new List<StatementSyntax>();
        }

        private static string NormalizeStmt(string s) => new string(s.Where(c => !char.IsWhiteSpace(c)).ToArray());

        private static Dictionary<string, int> Counter(IEnumerable<string> items)
        {
            var d = new Dictionary<string, int>(StringComparer.Ordinal);
            foreach (var i in items) d[i] = d.TryGetValue(i, out var c) ? c + 1 : 1;
            return d;
        }

        private static string ShortName(string fqn)
        {
            string s = fqn;
            int lt = s.IndexOf('<'); if (lt >= 0) s = s.Substring(0, lt);
            int i = s.LastIndexOf('.');
            return i < 0 ? s : s.Substring(i + 1);
        }

        private static bool IsValidIdentifier(string s)
        {
            if (string.IsNullOrEmpty(s)) return false;
            if (!(char.IsLetter(s[0]) || s[0] == '_')) return false;
            for (int i = 1; i < s.Length; i++)
                if (!(char.IsLetterOrDigit(s[i]) || s[i] == '_')) return false;
            return true;
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
