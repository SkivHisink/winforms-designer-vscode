using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace WinFormsDesigner.Engine
{
    /// <summary>One node of a <c>TreeView.Nodes</c> collection, recursively. Unlike the flat column editors a node is
    /// a LOCAL variable (not a field): <c>Id</c> is the generated local name (empty for a NEW node — a fresh
    /// <c>treeNodeN</c> is named on commit). Text (the constructor label), Name (the node key) and the four image
    /// properties (ImageKey/ImageIndex + SelectedImageKey/SelectedImageIndex) are modelled; a node that carries any
    /// OTHER property, or an image-index CONSTRUCTOR overload, still makes the whole collection read-only, so the
    /// editor never clobbers a value it can't round-trip.</summary>
    public sealed class TreeNodeItem
    {
        public string Id { get; set; } = "";
        public string Text { get; set; } = "";
        public string Name { get; set; } = "";
        // TreeNode image properties, defaults matching System.Windows.Forms.TreeNode ('no image' = "" key / -1 index)
        // so an image-less node emits nothing new and existing fixtures stay byte-identical. Key and index are
        // mutually exclusive in WinForms (setting one clears the other) — round-trip whichever the source carries.
        public string ImageKey { get; set; } = "";
        public int ImageIndex { get; set; } = -1;
        public string SelectedImageKey { get; set; } = "";
        public int SelectedImageIndex { get; set; } = -1;
        // Other round-tripped node value properties (simple literals only): the hover tooltip (string) and the
        // check-box state (bool). Defaults match TreeNode so an untouched node emits nothing new.
        public string ToolTipText { get; set; } = "";
        public bool Checked { get; set; } = false;
        // Visual-style node properties, carried as the property-grid INVARIANT string (e.g. "Red" / "64, 128, 255"
        // for a color, "Segoe UI, 9pt, style=Bold" for a font); "" = default/unset. On read the source expression is
        // evaluated to this invariant via DesignerValueConverter.FromExpression; on emit it is turned back into the
        // idiomatic initializer via DesignerValueConverter.ToExpression (both funnel through the same TypeConverter,
        // so the round-trip is stable). A color/font the converter can't represent keeps the node read-only.
        public string ForeColor { get; set; } = "";
        public string BackColor { get; set; } = "";
        public string NodeFont { get; set; } = "";
        public List<TreeNodeItem> Children { get; set; } = new();
    }

    /// <summary>Read side of the TreeView.Nodes editor: the node forest (roots in <c>Nodes.AddRange</c> order,
    /// children in constructor order) and whether it is editable.</summary>
    public sealed class TreeNodeItemsResult
    {
        public bool Ok { get; init; }
        public List<TreeNodeItem> Nodes { get; init; } = new();
        public string Reason { get; init; } = "";
    }

    /// <summary>
    /// Targeted edit of a <c>TreeView.Nodes</c> collection — the recursive counterpart of the flat column editors.
    /// VS serializes tree nodes as LOCAL variables, bottom-up, with the text + children in the constructor:
    /// <code>
    ///   System.Windows.Forms.TreeNode treeNode1 = new System.Windows.Forms.TreeNode("Apple");
    ///   System.Windows.Forms.TreeNode treeNode2 = new System.Windows.Forms.TreeNode("Fruits", new System.Windows.Forms.TreeNode[] { treeNode1 });
    ///   treeNode1.Name = "nodeApple";
    ///   this.treeView1.Nodes.AddRange(new System.Windows.Forms.TreeNode[] { treeNode2 });
    /// </code>
    /// so there are NO field declarations to reconcile; instead the whole forest is dropped and regenerated in
    /// post-order (children declared before their parent, as C# definite-assignment requires) and re-spliced in two
    /// places — the declarations at the top of InitializeComponent, the <c>Nodes.AddRange</c> after the owner's
    /// construction. Text/Name are emitted through Roslyn literal syntax (no interpolation → no injection).
    /// <see cref="OnlyTreeNodesChanged"/> verifies the edit touched ONLY this owner's nodes and left everything else
    /// byte-identical.
    /// </summary>
    public static class DesignerTreeNodeEditor
    {
        private const string DefaultNodeType = "System.Windows.Forms.TreeNode";

        // ---- read ----

        /// <summary>The owner's node forest. <see cref="TreeNodeItemsResult.Ok"/> is false when the nodes can't be
        /// safely represented as [Id, Text, Name, Children] (an unmanaged property, an unsupported constructor
        /// overload, a non-local child/root reference, a shared subtree, or an unattached node).</summary>
        public static TreeNodeItemsResult ListNodes(string sourceText, string ownerId)
        {
            if (!IsIdentifier(ownerId)) return new TreeNodeItemsResult { Ok = false, Reason = "invalid owner id: " + ownerId };
            var init = FindInitializeComponent(CSharpSyntaxTree.ParseText(sourceText).GetRoot());
            if (init?.Body == null) return new TreeNodeItemsResult { Ok = false, Reason = "InitializeComponent not found" };
            if (!TryReadForest(init, ownerId, out var nodes, out var reason))
                return new TreeNodeItemsResult { Ok = false, Reason = reason };
            return new TreeNodeItemsResult { Ok = true, Nodes = nodes };
        }

        /// <summary>Parse every <c>TreeNode</c> local (ctor text + child locals), every <c>&lt;local&gt;.Name</c>
        /// assignment, and the owner's <c>Nodes.Add/AddRange</c> roots, then build the forest recursively — refusing
        /// (read-only) on anything the [Text, Name, Children] model can't round-trip.</summary>
        private static bool TryReadForest(MethodDeclarationSyntax init, string ownerId, out List<TreeNodeItem> forest, out string reason)
        {
            forest = new List<TreeNodeItem>();
            reason = "";
            var ctorText = new Dictionary<string, string>(StringComparer.Ordinal);
            var ctorChildren = new Dictionary<string, List<string>>(StringComparer.Ordinal);

            // (1) ALL TreeNode local declarations on the form → text + child local names. Form-global because a child
            // ref resolves by name; the owner scoping happens in step (3) (a TreeNode belongs to exactly one tree).
            foreach (var st in init.Body!.Statements)
            {
                if (!IsTreeNodeDecl(st, out var lds)) continue;
                if (lds!.Declaration.Variables.Count != 1) { reason = "a TreeNode declaration declares multiple variables"; return false; }
                var v = lds.Declaration.Variables[0];
                string local = v.Identifier.Text;
                if (ctorText.ContainsKey(local)) { reason = "duplicate TreeNode local: " + local; return false; }
                if (v.Initializer?.Value is not ObjectCreationExpressionSyntax oce)
                { reason = "TreeNode " + local + " has no constructor"; return false; }
                if (!TryParseCtor(oce, out var text, out var kids, out var whyCtor)) { reason = whyCtor; return false; }
                ctorText[local] = text;
                ctorChildren[local] = kids;
            }

            // (2) roots from the owner's Nodes.Add/AddRange. Every element MUST be a plain declared local — an inline
            // `Nodes.Add(new TreeNode(...))` (non-canonical / hand-edited) is refused rather than silently modelled as
            // an empty forest (which a later regenerate would then drop). This runs even when there are 0 locals.
            var roots = new List<string>();
            foreach (var st in init.Body.Statements)
            {
                if (!IsOwnerNodesCall(st, ownerId, out var inv, out var method)) continue;
                var args = inv!.ArgumentList.Arguments;
                if (method == "Add")
                {
                    if (args.Count != 1 || !TryLocalRef(args[0].Expression, out var rid)) { reason = "non-local element in " + ownerId + ".Nodes"; return false; }
                    roots.Add(rid!);
                }
                else
                {
                    var elems = ArrayElements(args.Count == 1 ? args[0].Expression : null);
                    if (elems == null) { reason = "unexpected " + ownerId + ".Nodes.AddRange shape"; return false; }
                    foreach (var el in elems)
                    {
                        if (!TryLocalRef(el, out var rid)) { reason = "non-local element in " + ownerId + ".Nodes"; return false; }
                        roots.Add(rid!);
                    }
                }
            }

            // (3) build THIS owner's forest recursively (children from ctors), ensuring every node is reached exactly
            // once (no shared subtree / cycle). `used` becomes exactly this owner's node locals — locals belonging to
            // ANOTHER TreeView on the same form are simply not reached, so they are left untouched (not orphans).
            var used = new HashSet<string>(StringComparer.Ordinal);
            foreach (var r in roots)
            {
                if (!BuildNode(r, ctorText, ctorChildren, used, out var item, out reason)) return false;
                forest.Add(item!);
            }

            // (4) property statements — ONLY for THIS owner's locals (`used`): `.Name = "literal"` and the four image
            // props (ImageKey/SelectedImageKey string literals, ImageIndex/SelectedImageIndex int literals) are
            // modelled; any OTHER property, or children attached outside the ctor via `<local>.Nodes.Add`, makes it
            // read-only. The accepted set here MUST match EmitPostOrder + IsSafeNodeStatement exactly (closed loop).
            var names = new Dictionary<string, string>(StringComparer.Ordinal);
            var imageKeys = new Dictionary<string, string>(StringComparer.Ordinal);
            var selImageKeys = new Dictionary<string, string>(StringComparer.Ordinal);
            var imageIndexes = new Dictionary<string, int>(StringComparer.Ordinal);
            var selImageIndexes = new Dictionary<string, int>(StringComparer.Ordinal);
            var toolTips = new Dictionary<string, string>(StringComparer.Ordinal);
            var checkeds = new Dictionary<string, bool>(StringComparer.Ordinal);
            var foreColors = new Dictionary<string, string>(StringComparer.Ordinal);
            var backColors = new Dictionary<string, string>(StringComparer.Ordinal);
            var nodeFonts = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var st in init.Body.Statements)
            {
                if (st is not ExpressionStatementSyntax es) continue;
                if (es.Expression is AssignmentExpressionSyntax asn)
                {
                    var lhs = Flatten(asn.Left);
                    if (lhs.Count >= 1 && used.Contains(lhs[0]))
                    {
                        if (lhs.Count == 2 && lhs[1] == "Name")
                        {
                            if (!TryStringLiteral(asn.Right, out var nv)) { reason = "node " + lhs[0] + ".Name is not a literal"; return false; }
                            names[lhs[0]] = nv!;
                        }
                        else if (lhs.Count == 2 && (lhs[1] == "ImageKey" || lhs[1] == "SelectedImageKey"))
                        {
                            if (!TryStringLiteral(asn.Right, out var iv)) { reason = "node " + lhs[0] + "." + lhs[1] + " is not a literal"; return false; }
                            // ImageKey and ImageIndex are MUTUALLY EXCLUSIVE (setting one clears the other; the LAST
                            // assignment wins at runtime). Statements are visited in source order, so a key assignment
                            // clears any earlier sibling index for this local — the parsed model carries exactly the
                            // one effective member, and a later index would in turn clear this key. (Same for Selected*.)
                            if (lhs[1] == "ImageKey") { imageKeys[lhs[0]] = iv!; imageIndexes.Remove(lhs[0]); }
                            else { selImageKeys[lhs[0]] = iv!; selImageIndexes.Remove(lhs[0]); }
                        }
                        else if (lhs.Count == 2 && (lhs[1] == "ImageIndex" || lhs[1] == "SelectedImageIndex"))
                        {
                            if (!TryIntLiteral(asn.Right, out var ix)) { reason = "node " + lhs[0] + "." + lhs[1] + " is not an int literal"; return false; }
                            if (lhs[1] == "ImageIndex") { imageIndexes[lhs[0]] = ix; imageKeys.Remove(lhs[0]); }
                            else { selImageIndexes[lhs[0]] = ix; selImageKeys.Remove(lhs[0]); }
                        }
                        else if (lhs.Count == 2 && lhs[1] == "ToolTipText")
                        {
                            if (!TryStringLiteral(asn.Right, out var tv)) { reason = "node " + lhs[0] + ".ToolTipText is not a literal"; return false; }
                            toolTips[lhs[0]] = tv!;
                        }
                        else if (lhs.Count == 2 && lhs[1] == "Checked")
                        {
                            if (!TryBoolLiteral(asn.Right, out var cv)) { reason = "node " + lhs[0] + ".Checked is not a bool literal"; return false; }
                            checkeds[lhs[0]] = cv;
                        }
                        else if (lhs.Count == 2 && (lhs[1] == "ForeColor" || lhs[1] == "BackColor"))
                        {
                            // evaluate the color expression to its invariant string; a color the bounded converter
                            // can't represent (a computed value, a user type, an unsafe member) keeps the node read-only.
                            var inv = DesignerValueConverter.FromExpression("System.Drawing.Color", asn.Right.ToString());
                            if (inv == null) { reason = "node " + lhs[0] + "." + lhs[1] + " is not a representable color"; return false; }
                            if (lhs[1] == "ForeColor") foreColors[lhs[0]] = inv; else backColors[lhs[0]] = inv;
                        }
                        else if (lhs.Count == 2 && lhs[1] == "NodeFont")
                        {
                            var inv = DesignerValueConverter.FromExpression("System.Drawing.Font", asn.Right.ToString());
                            if (inv == null) { reason = "node " + lhs[0] + ".NodeFont is not a representable font"; return false; }
                            nodeFonts[lhs[0]] = inv;
                        }
                        else { reason = "node " + lhs[0] + " has unsupported property " + string.Join(".", lhs.Skip(1)); return false; }
                    }
                }
                else if (es.Expression is InvocationExpressionSyntax inv && inv.Expression is MemberAccessExpressionSyntax ma
                    && (ma.Name.Identifier.Text == "Add" || ma.Name.Identifier.Text == "AddRange"))
                {
                    var recv = Flatten(ma.Expression);
                    if (recv.Count == 2 && recv[1] == "Nodes" && used.Contains(recv[0]))
                    { reason = "node " + recv[0] + " attaches children outside its constructor"; return false; }
                }
            }
            ApplyNames(forest, names);
            ApplyImages(forest, imageKeys, imageIndexes, selImageKeys, selImageIndexes);
            ApplyExtras(forest, toolTips, checkeds);
            ApplyStyles(forest, foreColors, backColors, nodeFonts);
            return true;
        }

        private static bool BuildNode(string local, Dictionary<string, string> ctorText, Dictionary<string, List<string>> ctorChildren,
            HashSet<string> used, out TreeNodeItem? item, out string reason)
        {
            item = null; reason = "";
            if (!ctorText.ContainsKey(local)) { reason = "unknown TreeNode reference: " + local; return false; }
            if (!used.Add(local)) { reason = "TreeNode " + local + " is referenced more than once (shared subtree)"; return false; }
            var node = new TreeNodeItem { Id = local, Text = ctorText[local], Name = "" };
            foreach (var ch in ctorChildren[local])
            {
                if (!BuildNode(ch, ctorText, ctorChildren, used, out var childItem, out reason)) return false;
                node.Children.Add(childItem!);
            }
            item = node;
            return true;
        }

        /// <summary>Apply the parsed <c>.Name</c> assignments to the built forest (a post-pass so the recursive build
        /// stays name-agnostic and owner-scoped).</summary>
        private static void ApplyNames(List<TreeNodeItem> items, Dictionary<string, string> names)
        {
            foreach (var n in items)
            {
                if (names.TryGetValue(n.Id, out var nm)) n.Name = nm;
                ApplyNames(n.Children, names);
            }
        }

        /// <summary>Apply the parsed image-property assignments to the built forest (post-pass, like <see cref="ApplyNames"/>).</summary>
        private static void ApplyImages(List<TreeNodeItem> items,
            Dictionary<string, string> imageKeys, Dictionary<string, int> imageIndexes,
            Dictionary<string, string> selImageKeys, Dictionary<string, int> selImageIndexes)
        {
            foreach (var n in items)
            {
                if (imageKeys.TryGetValue(n.Id, out var ik)) n.ImageKey = ik;
                if (imageIndexes.TryGetValue(n.Id, out var ii)) n.ImageIndex = ii;
                if (selImageKeys.TryGetValue(n.Id, out var sk)) n.SelectedImageKey = sk;
                if (selImageIndexes.TryGetValue(n.Id, out var si)) n.SelectedImageIndex = si;
                ApplyImages(n.Children, imageKeys, imageIndexes, selImageKeys, selImageIndexes);
            }
        }

        /// <summary>Apply the parsed scalar node properties (ToolTipText / Checked) to the built forest (post-pass,
        /// like <see cref="ApplyNames"/>).</summary>
        private static void ApplyExtras(List<TreeNodeItem> items,
            Dictionary<string, string> toolTips, Dictionary<string, bool> checkeds)
        {
            foreach (var n in items)
            {
                if (toolTips.TryGetValue(n.Id, out var tt)) n.ToolTipText = tt;
                if (checkeds.TryGetValue(n.Id, out var ck)) n.Checked = ck;
                ApplyExtras(n.Children, toolTips, checkeds);
            }
        }

        /// <summary>Apply the parsed visual-style node properties (ForeColor / BackColor / NodeFont, as invariant
        /// strings) to the built forest (post-pass, like <see cref="ApplyNames"/>).</summary>
        private static void ApplyStyles(List<TreeNodeItem> items,
            Dictionary<string, string> foreColors, Dictionary<string, string> backColors, Dictionary<string, string> nodeFonts)
        {
            foreach (var n in items)
            {
                if (foreColors.TryGetValue(n.Id, out var fc)) n.ForeColor = fc;
                if (backColors.TryGetValue(n.Id, out var bc)) n.BackColor = bc;
                if (nodeFonts.TryGetValue(n.Id, out var nf)) n.NodeFont = nf;
                ApplyStyles(n.Children, foreColors, backColors, nodeFonts);
            }
        }

        // ---- write ----

        /// <summary>Rewrite <paramref name="ownerId"/>'s nodes to exactly <paramref name="desired"/>: drop every node
        /// declaration / Name assignment / <c>Nodes.AddRange</c> and regenerate them in post-order. A kept node keeps
        /// its local id; a node with an empty id is added (fresh <c>treeNodeN</c>); a current node absent from the tree
        /// is removed. Refuses (Failed) when the current forest isn't fully modelled or an unknown id is referenced.</summary>
        public static EditResult SetNodes(string sourceText, string ownerId, IReadOnlyList<TreeNodeItem> desired)
        {
            if (!IsIdentifier(ownerId)) return Failed("invalid owner id: " + ownerId);
            var root = CSharpSyntaxTree.ParseText(sourceText).GetRoot();
            var cls = FindClass(root);
            var init = cls?.Members.OfType<MethodDeclarationSyntax>().FirstOrDefault(m => m.Identifier.Text == "InitializeComponent");
            if (cls == null || init?.Body == null) return Failed("InitializeComponent not found");

            // the whole current forest must be modelled — else dropping it would lose a value.
            if (!TryReadForest(init, ownerId, out _, out var readReason)) return Failed(readReason);
            // OWNER-scoped node set (this TreeView's reachable locals only) — a sibling TreeView's nodes on the same
            // form are NOT touched: they stay declared, named, and attached.
            var currentSet = OwnerNodeLocals(init, ownerId);

            // resolve desired ids recursively: keep an existing local, generate one for a new node, refuse unknown/dup.
            var used = new HashSet<string>(GatherLocalAndFieldNames(cls, init), StringComparer.Ordinal);
            var seen = new HashSet<string>(StringComparer.Ordinal);
            if (!ResolveIds(desired, currentSet, used, seen, out var normalized, out var resolveReason)) return Failed(resolveReason);
            var finalSet = new HashSet<string>(StringComparer.Ordinal);
            CollectIds(normalized, finalSet);

            // never clobber: refuse the whole edit if any node carries a color/font invariant that can't be turned
            // back into an initializer (the pickers only ever produce representable values, so this is defensive).
            if (!AllStylesRepresentable(normalized, out var styleReason)) return Failed(styleReason);

            // removing a node whose local is referenced OUTSIDE the node statements would dangle — refuse.
            var nodeStmts = init.Body.Statements.Where(st => IsNodeRelated(st, ownerId, currentSet)).ToList();
            foreach (var rid in currentSet.Where(id => !finalSet.Contains(id)))
            {
                bool referencedOutside = init.Body.DescendantNodes().OfType<IdentifierNameSyntax>()
                    .Any(idn => idn.Identifier.Text == rid && !nodeStmts.Any(ns => ns.Span.Contains(idn.Span)));
                if (referencedOutside) return Failed("node " + rid + " is referenced outside the collection; can't remove it here");
            }

            string nodeType = ExistingNodeType(init) ?? DefaultNodeType;
            string nl = sourceText.Contains("\r\n") ? "\r\n" : "\n";
            string indent = BodyIndent(init);

            // drop node statements; remember where the declarations began and where the owner's AddRange sat.
            var kept = new List<StatementSyntax>();
            int declAnchor = -1, addRangeAnchor = -1;
            foreach (var st in init.Body.Statements)
            {
                // drop ONLY this owner's node declarations — a sibling TreeView's TreeNode decls must be kept.
                if (IsTreeNodeDecl(st, out var dLds) && dLds!.Declaration.Variables.Count == 1
                    && currentSet.Contains(dLds.Declaration.Variables[0].Identifier.Text))
                { if (declAnchor < 0) declAnchor = kept.Count; continue; }
                if (IsNodeLocalAssignment(st, currentSet)) continue; // owner's Name assignment — re-emitted with the decl
                if (IsOwnerNodesCall(st, ownerId, out _, out _)) { if (addRangeAnchor < 0) addRangeAnchor = kept.Count; continue; }
                kept.Add(st);
            }

            var declBlock = new List<StatementSyntax>();
            foreach (var n in normalized) EmitPostOrder(n, nodeType, indent, nl, declBlock);
            StatementSyntax? addRange = normalized.Count > 0
                ? BuildAddRange(ownerId, nodeType, normalized.Select(n => n.Id).ToList(), indent, nl)
                : null;

            var newStatements = new List<StatementSyntax>(kept);
            if (addRange != null)
            {
                int aa = addRangeAnchor;
                if (aa < 0)
                {
                    int ctorIdx = kept.FindIndex(st => IsOwnerConstruction(st, ownerId));
                    if (ctorIdx >= 0) aa = ctorIdx + 1;
                    else
                    {
                        int m = kept.FindLastIndex(st => TargetsOwner(st, ownerId));
                        if (m < 0) return Failed("no statement references " + ownerId + " to anchor the nodes");
                        aa = m + 1;
                    }
                }
                newStatements.Insert(Math.Min(aa, newStatements.Count), addRange);
            }
            int da = declAnchor < 0 ? 0 : declAnchor; // adding the first nodes → declarations go at the top of the body
            newStatements.InsertRange(Math.Min(da, newStatements.Count), declBlock);

            var newInit = init.WithBody(init.Body.WithStatements(SyntaxFactory.List(newStatements)));
            var newCls = cls.ReplaceNode(init, newInit);
            return new EditResult { NewText = root.ReplaceNode(cls, newCls).ToFullString(), Mode = EditMode.Replace };
        }

        /// <summary>safe-save gate: every statement that is NOT part of <paramref name="ownerId"/>'s nodes is byte-identical
        /// (multiset), every remaining node statement is a safe declaration / <c>.Name</c> assignment / owner
        /// <c>Nodes.AddRange</c>, every field declaration is byte-identical (nodes are locals — they touch no fields),
        /// no removed node local dangles, and no comment/directive was lost or added.</summary>
        public static bool OnlyTreeNodesChanged(string original, string edited, string ownerId)
        {
            var oRoot = CSharpSyntaxTree.ParseText(original).GetRoot();
            var eRoot = CSharpSyntaxTree.ParseText(edited).GetRoot();
            var oInit = FindInitializeComponent(oRoot);
            var eInit = FindInitializeComponent(eRoot);
            if (oInit?.Body == null || eInit?.Body == null) return false;

            // OWNER-scoped node locals (this TreeView's forest only) so a sibling TreeView's decls/.Name/AddRange are
            // treated as ordinary non-node statements and must stay byte-identical.
            var oLocals = OwnerNodeLocals(oInit, ownerId);
            var eLocals = OwnerNodeLocals(eInit, ownerId);
            var union = new HashSet<string>(oLocals, StringComparer.Ordinal);
            union.UnionWith(eLocals);

            var oNon = NonNodeStatements(oInit, ownerId, union);
            var (eNon, eNodes) = SplitStatements(eInit, ownerId, union);
            if (!MultisetEqual(oNon, eNon)) return false;
            foreach (var st in eNodes)
                if (!IsSafeNodeStatement(st, ownerId, eLocals)) return false;

            var oClass = FindClassOf(oInit);
            var eClass = FindClassOf(eInit);
            if (oClass == null || eClass == null) return false;
            // nodes are LOCAL variables — no field declaration should change at all.
            if (!MultisetEqual(AllFieldDecls(oClass), AllFieldDecls(eClass))) return false;

            // a removed node's local must not survive anywhere in the edited InitializeComponent body.
            foreach (var rid in oLocals.Where(id => !eLocals.Contains(id)))
                if (eInit.Body.DescendantNodes().OfType<IdentifierNameSyntax>().Any(idn => idn.Identifier.Text == rid))
                    return false;

            if (!MultisetEqual(CommentTrivia(oClass, StructuralNames(oClass)), CommentTrivia(eClass, StructuralNames(eClass)))) return false;
            return true;
        }

        // ---- resolve / regenerate helpers ----

        private static bool ResolveIds(IReadOnlyList<TreeNodeItem> items, HashSet<string> currentSet, HashSet<string> used,
            HashSet<string> seen, out List<TreeNodeItem> normalized, out string reason)
        {
            normalized = new List<TreeNodeItem>();
            reason = "";
            foreach (var d in items)
            {
                string id = d.Id ?? "";
                if (id.Length > 0)
                {
                    if (!currentSet.Contains(id)) { reason = "unknown node id: " + id; return false; }
                    if (!seen.Add(id)) { reason = "duplicate node id: " + id; return false; }
                }
                else
                {
                    id = UniqueName("treeNode", used);
                    used.Add(id);
                    seen.Add(id);
                }
                if (!ResolveIds(d.Children ?? new List<TreeNodeItem>(), currentSet, used, seen, out var kids, out reason)) return false;
                normalized.Add(new TreeNodeItem
                {
                    Id = id, Text = d.Text ?? "", Name = d.Name ?? "",
                    ImageKey = d.ImageKey ?? "", ImageIndex = d.ImageIndex,
                    SelectedImageKey = d.SelectedImageKey ?? "", SelectedImageIndex = d.SelectedImageIndex,
                    ToolTipText = d.ToolTipText ?? "", Checked = d.Checked,
                    ForeColor = d.ForeColor ?? "", BackColor = d.BackColor ?? "", NodeFont = d.NodeFont ?? "",
                    Children = kids,
                });
            }
            return true;
        }

        private static void CollectIds(IReadOnlyList<TreeNodeItem> items, HashSet<string> into)
        {
            foreach (var n in items) { into.Add(n.Id); CollectIds(n.Children, into); }
        }

        /// <summary>Every non-empty ForeColor/BackColor/NodeFont invariant must convert to an initializer expression;
        /// otherwise the edit is refused (rather than emit a node that silently drops the color/font).</summary>
        private static bool AllStylesRepresentable(IReadOnlyList<TreeNodeItem> items, out string reason)
        {
            foreach (var n in items)
            {
                if (n.ForeColor.Length > 0 && DesignerValueConverter.ToExpression("System.Drawing.Color", n.ForeColor) == null)
                { reason = "node " + n.Id + " ForeColor is not representable: " + n.ForeColor; return false; }
                if (n.BackColor.Length > 0 && DesignerValueConverter.ToExpression("System.Drawing.Color", n.BackColor) == null)
                { reason = "node " + n.Id + " BackColor is not representable: " + n.BackColor; return false; }
                if (n.NodeFont.Length > 0 && DesignerValueConverter.ToExpression("System.Drawing.Font", n.NodeFont) == null)
                { reason = "node " + n.Id + " NodeFont is not representable: " + n.NodeFont; return false; }
                if (!AllStylesRepresentable(n.Children, out reason)) return false;
            }
            reason = "";
            return true;
        }

        private static void EmitPostOrder(TreeNodeItem node, string nodeType, string indent, string nl, List<StatementSyntax> outList)
        {
            foreach (var ch in node.Children) EmitPostOrder(ch, nodeType, indent, nl, outList);
            var sb = new StringBuilder();
            sb.Append(nodeType).Append(' ').Append(node.Id).Append(" = new ").Append(nodeType).Append('(');
            if (node.Children.Count > 0)
            {
                sb.Append(SyntaxFactory.Literal(node.Text).ToString());
                sb.Append(", new ").Append(nodeType).Append("[] {").Append(nl);
                for (int i = 0; i < node.Children.Count; i++)
                {
                    sb.Append(indent).Append(node.Children[i].Id);
                    sb.Append(i < node.Children.Count - 1 ? "," + nl : "})");
                }
            }
            else if (node.Text.Length > 0) sb.Append(SyntaxFactory.Literal(node.Text).ToString()).Append(')');
            else sb.Append(')');
            sb.Append(';');
            outList.Add(Stmt(sb.ToString(), indent, nl));
            if (node.Name.Length > 0)
                outList.Add(Stmt($"{node.Id}.Name = {SyntaxFactory.Literal(node.Name)};", indent, nl));
            // image properties — emit ONLY the EFFECTIVE member of each mutually-exclusive pair (key preferred), never
            // both: setting ImageKey then ImageIndex would let the index silently shadow the key at runtime. Key-first
            // matches the net48 live apply (BuildLiveTreeNode) so the live picture and a rebuild render the same glyph.
            // Emitting at most one per pair also keeps the read recognizer + IsSafeNodeStatement gate satisfied.
            if (node.ImageKey.Length > 0)
                outList.Add(Stmt($"{node.Id}.ImageKey = {SyntaxFactory.Literal(node.ImageKey)};", indent, nl));
            else if (node.ImageIndex >= 0)
                outList.Add(Stmt($"{node.Id}.ImageIndex = {node.ImageIndex.ToString(System.Globalization.CultureInfo.InvariantCulture)};", indent, nl));
            if (node.SelectedImageKey.Length > 0)
                outList.Add(Stmt($"{node.Id}.SelectedImageKey = {SyntaxFactory.Literal(node.SelectedImageKey)};", indent, nl));
            else if (node.SelectedImageIndex >= 0)
                outList.Add(Stmt($"{node.Id}.SelectedImageIndex = {node.SelectedImageIndex.ToString(System.Globalization.CultureInfo.InvariantCulture)};", indent, nl));
            // other scalar props — emit only when non-default (tooltip set / checked). Must match the read recognizer
            // + IsSafeNodeStatement gate.
            if (node.ToolTipText.Length > 0)
                outList.Add(Stmt($"{node.Id}.ToolTipText = {SyntaxFactory.Literal(node.ToolTipText)};", indent, nl));
            if (node.Checked)
                outList.Add(Stmt($"{node.Id}.Checked = true;", indent, nl));
            // visual-style props — turn the invariant string back into the idiomatic initializer. SetNodes has already
            // pre-validated that every non-empty style converts (else it Failed), so ToExpression can't be null here;
            // the null-guard is belt-and-braces so a value is never silently dropped.
            EmitStyle(node.ForeColor, "ForeColor", "System.Drawing.Color", node.Id, indent, nl, outList);
            EmitStyle(node.BackColor, "BackColor", "System.Drawing.Color", node.Id, indent, nl, outList);
            EmitStyle(node.NodeFont, "NodeFont", "System.Drawing.Font", node.Id, indent, nl, outList);
        }

        private static void EmitStyle(string invariant, string prop, string typeName, string id, string indent, string nl, List<StatementSyntax> outList)
        {
            if (invariant.Length == 0) return;
            var e = DesignerValueConverter.ToExpression(typeName, invariant);
            if (e != null) outList.Add(Stmt($"{id}.{prop} = {e};", indent, nl));
        }

        private static StatementSyntax BuildAddRange(string ownerId, string nodeType, List<string> rootIds, string indent, string nl)
        {
            var sb = new StringBuilder();
            sb.Append("this.").Append(ownerId).Append(".Nodes.AddRange(new ").Append(nodeType).Append("[] {").Append(nl);
            for (int i = 0; i < rootIds.Count; i++)
            {
                sb.Append(indent).Append(rootIds[i]);
                sb.Append(i < rootIds.Count - 1 ? "," + nl : "});");
            }
            return Stmt(sb.ToString(), indent, nl);
        }

        // ---- constructor / classification ----

        /// <summary>Parse a <c>new TreeNode(...)</c> — the recognized overloads are <c>()</c>, <c>(text)</c> and
        /// <c>(text, TreeNode[] children)</c>. Anything else (image-index overloads, object initializer, non-literal
        /// text, non-local child) is refused so the node stays read-only rather than round-trip lossily.</summary>
        private static bool TryParseCtor(ObjectCreationExpressionSyntax oce, out string text, out List<string> children, out string reason)
        {
            text = ""; children = new List<string>(); reason = "";
            if (SimpleTypeName(oce.Type) != "TreeNode") { reason = "not a TreeNode construction"; return false; }
            if (oce.Initializer != null) { reason = "TreeNode object initializer is not supported"; return false; }
            var args = oce.ArgumentList?.Arguments;
            int n = args?.Count ?? 0;
            if (n == 0) return true;
            if (!TryStringLiteral(args!.Value[0].Expression, out var t)) { reason = "TreeNode text is not a literal"; return false; }
            text = t!;
            if (n == 1) return true;
            if (n == 2)
            {
                var elems = ArrayElements(args.Value[1].Expression);
                if (elems == null) { reason = "unsupported TreeNode constructor overload"; return false; }
                foreach (var el in elems)
                {
                    if (!TryLocalRef(el, out var cid)) { reason = "non-local child in TreeNode constructor"; return false; }
                    children.Add(cid!);
                }
                return true;
            }
            reason = "unsupported TreeNode constructor overload";
            return false;
        }

        private static bool IsTreeNodeDecl(StatementSyntax st, out LocalDeclarationStatementSyntax? lds)
        {
            lds = st as LocalDeclarationStatementSyntax;
            return lds != null && SimpleTypeName(lds.Declaration.Type) == "TreeNode";
        }

        /// <summary>The TreeNode locals belonging to <paramref name="ownerId"/> — the transitive closure of the owner's
        /// <c>Nodes.Add/AddRange</c> roots through their constructor children. Nodes of OTHER TreeViews on the same form
        /// are excluded, so every operation (read / regenerate / gate) is scoped to this one owner. Best-effort: a local
        /// whose ctor doesn't parse isn't traversed (the strict read refuses such forms before any write).</summary>
        private static HashSet<string> OwnerNodeLocals(MethodDeclarationSyntax init, string ownerId)
        {
            var kids = new Dictionary<string, List<string>>(StringComparer.Ordinal);
            foreach (var st in init.Body!.Statements)
                if (IsTreeNodeDecl(st, out var lds) && lds!.Declaration.Variables.Count == 1
                    && lds.Declaration.Variables[0].Initializer?.Value is ObjectCreationExpressionSyntax oce
                    && TryParseCtor(oce, out _, out var ck, out _))
                    kids[lds.Declaration.Variables[0].Identifier.Text] = ck;

            var roots = new List<string>();
            foreach (var st in init.Body.Statements)
            {
                if (!IsOwnerNodesCall(st, ownerId, out var inv, out var method)) continue;
                var args = inv!.ArgumentList.Arguments;
                var exprs = method == "Add"
                    ? (args.Count == 1 ? new List<ExpressionSyntax> { args[0].Expression } : null)
                    : (ArrayElements(args.Count == 1 ? args[0].Expression : null)?.ToList());
                if (exprs == null) continue;
                foreach (var el in exprs) if (TryLocalRef(el, out var rid)) roots.Add(rid!);
            }

            var set = new HashSet<string>(StringComparer.Ordinal);
            void Visit(string l) { if (!kids.ContainsKey(l) || !set.Add(l)) return; foreach (var c in kids[l]) Visit(c); }
            foreach (var r in roots) Visit(r);
            return set;
        }

        private static bool IsNodeLocalAssignment(StatementSyntax st, HashSet<string> nodeLocals)
        {
            if (st is not ExpressionStatementSyntax { Expression: AssignmentExpressionSyntax asn }) return false;
            var lhs = Flatten(asn.Left);
            return lhs.Count >= 1 && nodeLocals.Contains(lhs[0]);
        }

        /// <summary>True for <c>this.&lt;owner&gt;.Nodes.Add(...)</c> / <c>.AddRange(...)</c>.</summary>
        private static bool IsOwnerNodesCall(StatementSyntax st, string ownerId, out InvocationExpressionSyntax? inv, out string method)
        {
            inv = null; method = "";
            if (st is not ExpressionStatementSyntax es || es.Expression is not InvocationExpressionSyntax i) return false;
            if (i.Expression is not MemberAccessExpressionSyntax ma) return false;
            var m = ma.Name.Identifier.Text;
            if (m != "Add" && m != "AddRange") return false;
            var chain = Flatten(ma.Expression);
            if (chain.Count != 2 || chain[0] != ownerId || chain[1] != "Nodes") return false;
            inv = i; method = m;
            return true;
        }

        private static bool IsNodeRelated(StatementSyntax st, string ownerId, HashSet<string> nodeLocals)
        {
            // a TreeNode decl belongs to THIS owner only when its local is in the owner's set — a sibling TreeView's
            // decl is an ordinary (non-node) statement here, so the gate pins it byte-identical instead of dropping it.
            if (IsTreeNodeDecl(st, out var lds))
                return lds!.Declaration.Variables.Count == 1 && nodeLocals.Contains(lds.Declaration.Variables[0].Identifier.Text);
            if (IsOwnerNodesCall(st, ownerId, out _, out _)) return true;
            return IsNodeLocalAssignment(st, nodeLocals);
        }

        private static List<string> NonNodeStatements(MethodDeclarationSyntax init, string ownerId, HashSet<string> nodeLocals) =>
            SplitStatements(init, ownerId, nodeLocals).nonNode;

        private static (List<string> nonNode, List<StatementSyntax> node) SplitStatements(
            MethodDeclarationSyntax init, string ownerId, HashSet<string> nodeLocals)
        {
            var non = new List<string>();
            var node = new List<StatementSyntax>();
            foreach (var st in init.Body!.Statements)
            {
                if (IsNodeRelated(st, ownerId, nodeLocals)) node.Add(st);
                else non.Add(NormalizeStmt(st.ToString()));
            }
            return (non, node);
        }

        /// <summary>Gate check for a single edited node statement: a modelled TreeNode declaration, a <c>.Name</c>
        /// literal assignment on a node local, or the owner's <c>Nodes.Add/AddRange</c> of only known node locals.</summary>
        private static bool IsSafeNodeStatement(StatementSyntax st, string ownerId, HashSet<string> nodeLocals)
        {
            if (IsTreeNodeDecl(st, out var lds))
            {
                if (lds!.Declaration.Variables.Count != 1) return false;
                if (lds.Declaration.Variables[0].Initializer?.Value is not ObjectCreationExpressionSyntax oce) return false;
                if (!TryParseCtor(oce, out _, out var kids, out _)) return false;
                return kids.All(nodeLocals.Contains);
            }
            if (IsOwnerNodesCall(st, ownerId, out var inv, out var method))
            {
                var args = inv!.ArgumentList.Arguments;
                if (method == "Add")
                    return args.Count == 1 && TryLocalRef(args[0].Expression, out var aid) && nodeLocals.Contains(aid!);
                var elems = ArrayElements(args.Count == 1 ? args[0].Expression : null);
                if (elems == null) return false;
                return elems.All(el => TryLocalRef(el, out var id) && nodeLocals.Contains(id!));
            }
            if (st is ExpressionStatementSyntax { Expression: AssignmentExpressionSyntax asn })
            {
                var lhs = Flatten(asn.Left);
                if (lhs.Count != 2 || !nodeLocals.Contains(lhs[0])) return false;
                // must exactly mirror the read recognizer + EmitPostOrder: Name/ImageKey/SelectedImageKey/ToolTipText
                // are string literals, ImageIndex/SelectedImageIndex are int literals, Checked is a bool literal,
                // ForeColor/BackColor are representable colors and NodeFont a representable font (both re-validated
                // through the same bounded converter the read/emit sides use, so the three sites can't drift).
                return ((lhs[1] is "Name" or "ImageKey" or "SelectedImageKey" or "ToolTipText") && TryStringLiteral(asn.Right, out _))
                    || ((lhs[1] is "ImageIndex" or "SelectedImageIndex") && TryIntLiteral(asn.Right, out _))
                    || (lhs[1] is "Checked" && TryBoolLiteral(asn.Right, out _))
                    || (lhs[1] is "ForeColor" or "BackColor" && IsSafeColorExpr(asn.Right))
                    || (lhs[1] is "NodeFont" && IsSafeFontExpr(asn.Right));
            }
            return false;
        }

        private static string? ExistingNodeType(MethodDeclarationSyntax init)
        {
            foreach (var st in init.Body!.Statements)
                if (IsTreeNodeDecl(st, out var lds)) return lds!.Declaration.Type.ToString();
            return null;
        }

        // ---- value parsing ----

        private static bool TryLocalRef(ExpressionSyntax expr, out string? id)
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

        /// <summary>A plain int literal (image index), tolerating a unary-minus wrapper (<c>-1</c>). Non-literal /
        /// non-int is refused so a computed image index keeps the node read-only rather than round-trip lossily.</summary>
        private static bool TryIntLiteral(ExpressionSyntax expr, out int value)
        {
            value = 0;
            bool neg = false;
            ExpressionSyntax e = expr;
            if (e is PrefixUnaryExpressionSyntax u && u.IsKind(SyntaxKind.UnaryMinusExpression)) { neg = true; e = u.Operand; }
            if (e is LiteralExpressionSyntax lit && lit.IsKind(SyntaxKind.NumericLiteralExpression) && lit.Token.Value is int i)
            { value = neg ? -i : i; return true; }
            return false;
        }

        /// <summary>A color expression the bounded converter can evaluate (named/system color / Color.FromArgb(...)).
        /// Delegates to FromExpression so read, emit and this gate share ONE definition of "representable color".</summary>
        private static bool IsSafeColorExpr(ExpressionSyntax expr) =>
            DesignerValueConverter.FromExpression("System.Drawing.Color", expr.ToString()) != null;

        /// <summary>A font expression the bounded converter can evaluate (a lossless <c>new Font(...)</c>).</summary>
        private static bool IsSafeFontExpr(ExpressionSyntax expr) =>
            DesignerValueConverter.FromExpression("System.Drawing.Font", expr.ToString()) != null;

        /// <summary>A plain <c>true</c>/<c>false</c> literal (TreeNode.Checked). A non-literal (computed / named const)
        /// keeps the node read-only rather than round-trip lossily.</summary>
        private static bool TryBoolLiteral(ExpressionSyntax expr, out bool value)
        {
            if (expr is LiteralExpressionSyntax lit && (lit.IsKind(SyntaxKind.TrueLiteralExpression) || lit.IsKind(SyntaxKind.FalseLiteralExpression)))
            { value = lit.IsKind(SyntaxKind.TrueLiteralExpression); return true; }
            value = false; return false;
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

        private static HashSet<string> GatherLocalAndFieldNames(ClassDeclarationSyntax cls, MethodDeclarationSyntax init)
        {
            var set = new HashSet<string>(StringComparer.Ordinal);
            foreach (var fd in cls.Members.OfType<FieldDeclarationSyntax>())
                foreach (var v in fd.Declaration.Variables) set.Add(v.Identifier.Text);
            foreach (var lds in init.Body!.Statements.OfType<LocalDeclarationStatementSyntax>())
                foreach (var v in lds.Declaration.Variables) set.Add(v.Identifier.Text);
            return set;
        }

        private static HashSet<string> StructuralNames(ClassDeclarationSyntax cls)
        {
            var set = new HashSet<string>(StringComparer.Ordinal);
            foreach (var fd in cls.Members.OfType<FieldDeclarationSyntax>())
                foreach (var v in fd.Declaration.Variables) set.Add(v.Identifier.Text);
            set.Add(cls.Identifier.Text);
            return set;
        }

        private static string UniqueName(string baseName, HashSet<string> used)
        {
            for (int i = 1; ; i++)
            {
                string cand = baseName + i.ToString(System.Globalization.CultureInfo.InvariantCulture);
                if (!used.Contains(cand)) return cand;
            }
        }

        private static string BodyIndent(MethodDeclarationSyntax init)
        {
            var first = init.Body!.Statements.FirstOrDefault();
            return first != null ? LineIndent(first) : "            ";
        }

        private static string LineIndent(SyntaxNode node)
        {
            var text = node.SyntaxTree.GetText();
            string lineText = text.Lines.GetLineFromPosition(node.SpanStart).ToString();
            int n = lineText.Length - lineText.TrimStart().Length;
            return lineText.Substring(0, n);
        }

        private static StatementSyntax Stmt(string code, string indent, string nl) =>
            SyntaxFactory.ParseStatement(code)
                .WithLeadingTrivia(SyntaxFactory.Whitespace(indent))
                .WithTrailingTrivia(SyntaxFactory.EndOfLine(nl));

        private static bool IsOwnerConstruction(StatementSyntax st, string ownerId)
        {
            if (st is not ExpressionStatementSyntax { Expression: AssignmentExpressionSyntax asn }) return false;
            var lhs = Flatten(asn.Left);
            return lhs.Count == 1 && lhs[0] == ownerId && asn.Right is ObjectCreationExpressionSyntax;
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

        private static List<string> AllFieldDecls(ClassDeclarationSyntax cls) =>
            cls.Members.OfType<FieldDeclarationSyntax>().Select(fd => NormalizeStmt(fd.ToString())).ToList();

        private static bool MultisetEqual(List<string> a, List<string> b)
        {
            if (a.Count != b.Count) return false;
            var ca = Counter(a); var cb = Counter(b);
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
                    if (IsStructuralSeparator(tr.ToString(), structural)) continue;
                    list.Add(tr.ToString().Trim());
                }
                else if (tr.IsKind(SyntaxKind.MultiLineCommentTrivia)
                    || tr.IsKind(SyntaxKind.SingleLineDocumentationCommentTrivia)
                    || tr.IsKind(SyntaxKind.MultiLineDocumentationCommentTrivia) || tr.IsDirective)
                    list.Add(tr.ToString().Trim());
            }
            return list;
        }

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
