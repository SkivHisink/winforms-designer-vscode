using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace WinFormsDesigner.Engine
{
    // ============================================================================================================
    // The Roslyn FRONT-END: parse a form's InitializeComponent into the closed statement IR.
    //
    // Runs in the net48 engine process's DEFAULT AppDomain (and, for the "dark net9" differential path, in the
    // net10 engine) — SYNTAX ONLY. It never loads the user's assemblies, resolves a runtime type, or executes a
    // statement (default-domain = syntax + built-in allowlists + literal/value IR + operation
    // shape + bounds; the child-domain executor does runtime type resolution and semantic validation before acting).
    //
    // Classification rests on the fact that VS-generated .Designer.cs is FULLY QUALIFIED
    // (System.Drawing.Color.FromArgb, System.Windows.Forms.Padding). So a value's syntactic type prefix can be
    // matched straight against the FullName allowlists in DesignerAllowlists — a non-qualified / non-allowlisted
    // shape is a hand-edit and becomes an honest UNREPRESENTABLE reason (→ disclosed compiled fallback), never a
    // silent guess. Enum-valued members are emitted as an IrEnum SHAPE the executor validates (is the type really an
    // enum, is the member real) and fails closed on — the parser deliberately does not need enum type knowledge.
    //
    // Coverage in schema v1 (everything else → unrepresentable, honest fallback): component construction, property
    // assignment (incl. property chains and component-reference / (this) RHS), Controls.Add (incl. TLP cell and a
    // container sub-path), collection Add/AddRange, ISupportInitialize BeginInit/EndInit, Suspend/Resume/PerformLayout
    // (inert), the ComponentResourceManager local, and event wiring (inert metadata). Out of v1: the TreeNode local
    // subsystem and IExtenderProvider.Set* (recognized but reported as coverage gaps for a later step).
    // ============================================================================================================
    public static class DesignerIrBuilder
    {
        /// <summary>Parse <paramref name="designerSource"/> (a full .Designer.cs buffer) into an IrDocument for the
        /// form it declares. Never throws for a malformed form — an unresolvable form or a bad statement becomes a
        /// coverage gap / reason, and <see cref="IrValidate"/> still passes on the result (the caller checks
        /// FullCoverage to decide interpreted vs fallback). Returns null only when no single form class resolves.</summary>
        public static IrDocument? Build(string designerSource)
        {
            var tree = CSharpSyntaxTree.ParseText(designerSource ?? "");
            var root = tree.GetRoot();
            var cls = FormClassResolver.FormClass(root);
            if (cls == null) return null; // no unique form class (fail-closed identity) — caller handles

            var doc = new IrDocument
            {
                DesignedTypeName = FormClassResolver.QualifiedName(cls),
                BaseTypeSyntaxName = FirstBaseTypeName(cls) ?? "",
            };

            var init = FormClassResolver.InitMethodOf(cls);
            if (init?.Body == null)
            {
                doc.UnrepresentableReasons.Add("InitializeComponent not found");
                return doc;
            }

            // Field names across ALL partials (a form may split fields into a sibling partial — mirror Interpret).
            var fieldNames = new HashSet<string>(StringComparer.Ordinal);
            foreach (var part in DesignerModifiers.PartialsOf(cls))
                foreach (var f in part.Members.OfType<FieldDeclarationSyntax>())
                    foreach (var v in f.Declaration.Variables)
                        fieldNames.Add(v.Identifier.Text);

            // `IContainer components = new Container()` names (lets a `new T(this.components)` ctor be recognized),
            // and ComponentResourceManager locals (lets `resources.GetObject("k")` be recognized). Both are collected
            // in a first pass because a statement can reference a local declared earlier.
            var containerNames = new HashSet<string>(StringComparer.Ordinal);
            var resxVars = new HashSet<string>(StringComparer.Ordinal);
            var treeNodeLocals = new HashSet<string>(StringComparer.Ordinal);
            string designedShort = LastTypeSegment(doc.DesignedTypeName);
            foreach (var stmt in init.Body.Statements)
            {
                if (stmt is LocalDeclarationStatementSyntax lds)
                {
                    var typeName = LastTypeSegment(lds.Declaration.Type.ToString());
                    if (typeName == "ComponentResourceManager")
                    {
                        // Only register a manager that reads THIS form's resource set. `new ComponentResourceManager(
                        // typeof(OtherForm))` reads a DIFFERENT set — the interpreter's resolver only has this form's
                        // sibling .resx, so registering a foreign manager would make its GetString/GetObject silently
                        // read the wrong set; skipping it makes those calls fall back honestly instead.
                        foreach (var v in lds.Declaration.Variables)
                            if (ResxManagerTargetsThisForm(v, designedShort)) resxVars.Add(v.Identifier.Text);
                    }
                    else if (typeName == "TreeNode")
                        foreach (var v in lds.Declaration.Variables) treeNodeLocals.Add(v.Identifier.Text);
                }
                if (stmt is ExpressionStatementSyntax es0 && es0.Expression is AssignmentExpressionSyntax a0
                    && Flatten(a0.Left) is { Count: 1 } lhs && fieldNames.Contains(lhs[0])
                    && a0.Right is ObjectCreationExpressionSyntax cc && (cc.ArgumentList?.Arguments.Count ?? 0) == 0
                    && cc.Initializer == null && LastTypeSegment(cc.Type.ToString()) == "Container")
                {
                    containerNames.Add(lhs[0]);
                }
            }

            var ctx = new Ctx(fieldNames, containerNames, resxVars, treeNodeLocals);
            foreach (var stmt in init.Body.Statements)
            {
                doc.TotalSourceStatements++;
                var (nodes, represented, reason) = Classify(stmt, ctx);
                if (represented)
                {
                    doc.RepresentedStatements++;
                    doc.Statements.AddRange(nodes); // one source statement may map to N IR nodes (e.g. a multi-item AddRange)
                }
                else
                {
                    doc.UnrepresentableReasons.Add(reason ?? Trim(stmt));
                }
            }
            return doc;
        }

        /// <summary>Whether a ComponentResourceManager local's `typeof(X)` target IS this form — only then does the
        /// interpreter's sibling-.resx resolver read the right set. A clear FOREIGN target returns false (its lookups
        /// fall back); an undeterminable shape (no arg, non-typeof arg) keeps the prior behavior (registers) since VS
        /// canonically emits `typeof(ThisForm)` and over-Gapping a normal form would be worse.</summary>
        private static bool ResxManagerTargetsThisForm(VariableDeclaratorSyntax v, string designedShort)
        {
            if (v.Initializer?.Value is not ObjectCreationExpressionSyntax oc) return true;
            var args = oc.ArgumentList?.Arguments;
            if (args == null || args.Value.Count == 0) return true;
            if (args.Value[0].Expression is TypeOfExpressionSyntax tof)
                return LastTypeSegment(tof.Type.ToString()) == designedShort;
            return true;
        }

        private sealed class Ctx
        {
            public readonly HashSet<string> Fields;
            public readonly HashSet<string> Containers;
            public readonly HashSet<string> ResxVars;
            public readonly HashSet<string> TreeNodeLocals;
            public Ctx(HashSet<string> f, HashSet<string> c, HashSet<string> r, HashSet<string> tn) { Fields = f; Containers = c; ResxVars = r; TreeNodeLocals = tn; }
        }

        /// <summary>Side-effect-free properties the designer sets on a TreeNode local — the ONLY writes the tree-node
        /// subsystem admits (mirrors the net9 interpreter's TreeNodeSettableProps). Anything else fails the statement
        /// closed (→ fallback), never runs.</summary>
        private static readonly HashSet<string> TreeNodeSettableProps = new HashSet<string>(StringComparer.Ordinal)
        {
            "Name", "Text", "ToolTipText", "ImageKey", "SelectedImageKey", "StateImageKey",
            "ImageIndex", "SelectedImageIndex", "StateImageIndex", "BackColor", "ForeColor", "Checked",
        };

        // ------------------------------------------------------ statements ------------------------------------------

        // Result helpers: a statement maps to a LIST of IR nodes (usually 0 or 1, but a multi-item AddRange emits N).
        private static (List<IrStatement>, bool, string?) NoOp() => (new List<IrStatement>(), true, null);
        private static (List<IrStatement>, bool, string?) Gap(string reason) => (new List<IrStatement>(), false, reason);
        private static (List<IrStatement>, bool, string?) One(IrStatement n) => (new List<IrStatement> { n }, true, null);
        private static (List<IrStatement>, bool, string?) Rep(List<IrStatement> nodes) => (nodes, true, null);

        /// <summary>Classify one InitializeComponent statement into the IR nodes it maps to (0 for a represented no-op
        /// like Suspend/Resume or the container/resx local; 1 for most; N for a multi-item AddRange). An unrepresented
        /// statement carries a reason and drives compiled fallback.</summary>
        private static (List<IrStatement> nodes, bool represented, string? reason) Classify(StatementSyntax stmt, Ctx ctx)
        {
            // A represented no-op: the `resources = new ComponentResourceManager(...)` / `components = new Container()`
            // locals create nothing to model (their effect is honored elsewhere), exactly as Interpret treats them.
            if (stmt is LocalDeclarationStatementSyntax ld)
            {
                if (ld.Declaration.Variables.Any(v => ctx.ResxVars.Contains(v.Identifier.Text))) return NoOp();
                if (LastTypeSegment(ld.Declaration.Type.ToString()) == "ComponentResourceManager") return NoOp();
                if (IsWinFormsTreeNodeType(ld.Declaration.Type.ToString())) return ClassifyTreeNodeLocal(ld, ctx);
                return Gap(Trim(stmt));
            }

            if (stmt is not ExpressionStatementSyntax es) return Gap(Trim(stmt));

            if (es.Expression is AssignmentExpressionSyntax asg)
            {
                if (asg.IsKind(SyntaxKind.AddAssignmentExpression) || asg.IsKind(SyntaxKind.SubtractAssignmentExpression))
                    return ClassifyEventWiring(asg);
                if (asg.IsKind(SyntaxKind.SimpleAssignmentExpression))
                    return ClassifyAssignment(asg, ctx);
                return Gap(Trim(stmt));
            }
            if (es.Expression is InvocationExpressionSyntax inv)
                return ClassifyInvocation(inv, ctx);

            return Gap(Trim(stmt));
        }

        private static (List<IrStatement>, bool, string?) ClassifyEventWiring(AssignmentExpressionSyntax asg)
        {
            // `this.X.Event += new Handler(this.method)` — inert metadata (the design surface never wires handlers).
            // ONLY a delegate-CONSTRUCTION RHS is real event wiring; VS always emits `+= new SomeEventHandler(...)`.
            // A `+=`/`-=` whose RHS is a value (e.g. `this.button1.Left += Delta`) is a COMPOUND ASSIGNMENT that
            // actually changes state — treating it as inert would SILENTLY mis-render, so it must fall back.
            if (asg.Right is not ObjectCreationExpressionSyntax) return Gap(Trim(asg));
            var lhs = Flatten(asg.Left);
            if (lhs.Count < 1) return Gap(Trim(asg));
            var (targetIsRoot, targetName, eventName) = SplitTargetAndLeaf(lhs);
            if (eventName == null) return Gap(Trim(asg));
            // Handler name is best-effort metadata (the last identifier of the RHS); never resolved.
            string handler = HandlerNameOf(asg.Right) ?? "";
            return One(new IrWireEvent { TargetIsRoot = targetIsRoot, TargetName = targetName, EventName = eventName, HandlerName = handler });
        }

        // `TreeNode nodeLocal = new TreeNode("text"[, new TreeNode[]{children}]);` — one or more tree-node locals.
        private static (List<IrStatement>, bool, string?) ClassifyTreeNodeLocal(LocalDeclarationStatementSyntax ld, Ctx ctx)
        {
            var built = new List<IrStatement>();
            foreach (var v in ld.Declaration.Variables)
            {
                var node = new IrConstructTreeNode { LocalName = v.Identifier.Text };
                if (v.Initializer?.Value is ObjectCreationExpressionSyntax oc && IsWinFormsTreeNodeType(oc.Type.ToString()))
                {
                    var args = oc.ArgumentList?.Arguments ?? default;
                    for (int i = 0; i < args.Count; i++)
                    {
                        var e = args[i].Expression;
                        if (i == 0 && e is LiteralExpressionSyntax lit && lit.IsKind(SyntaxKind.StringLiteralExpression))
                            node.Text = (string)(lit.Token.Value ?? "");
                        else if (e is ArrayCreationExpressionSyntax arr && arr.Initializer != null
                            && IsWinFormsTreeNodeType(arr.Type.ElementType.ToString()))
                        {
                            foreach (var el in arr.Initializer.Expressions)
                            {
                                var c = Flatten(el);
                                if (c.Count == 1 && ctx.TreeNodeLocals.Contains(c[0])) node.ChildLocalNames.Add(c[0]);
                                else return Gap("unrepresentable TreeNode child " + Trim(ld));
                            }
                        }
                        else return Gap("unrepresentable TreeNode ctor arg " + Trim(ld)); // e.g. the imageIndex-int ctor (v1 gap)
                    }
                }
                else if (v.Initializer != null) return Gap(Trim(ld));
                if (!IrValidate.ValidIdent(node.LocalName)) return Gap(Trim(ld));
                built.Add(node);
            }
            return built.Count == 0 ? NoOp() : Rep(built);
        }

        private static (List<IrStatement>, bool, string?) ClassifyAssignment(AssignmentExpressionSyntax asg, Ctx ctx)
        {
            var chain = Flatten(asg.Left);
            if (chain.Count == 0) return Gap(Trim(asg));

            // tree-node local property: `treeNode1.Name = "…"` — chain[0] is a tree-node LOCAL (NOT a field), so it must
            // be intercepted BEFORE the root-property fallback below (which would mis-target root.treeNode1.Name).
            if (chain.Count == 2 && ctx.TreeNodeLocals.Contains(chain[0]))
            {
                if (!TreeNodeSettableProps.Contains(chain[1])) return Gap("unrepresentable TreeNode property " + chain[1]);
                var tv = ClassifyValue(asg.Right, ctx);
                if (tv == null) return Gap(Trim(asg));
                return One(new IrSetTreeNodeProp { LocalName = chain[0], PropName = chain[1], Value = tv });
            }

            // `this.f = new T()` / `new T(this.components)` — component construction.
            if (chain.Count == 1 && ctx.Fields.Contains(chain[0]) && asg.Right is ObjectCreationExpressionSyntax oc)
            {
                // container disposal holder: represented no-op (host owns lifetime) — collected already.
                if ((oc.ArgumentList?.Arguments.Count ?? 0) == 0 && oc.Initializer == null
                    && LastTypeSegment(oc.Type.ToString()) == "Container" && ctx.Containers.Contains(chain[0]))
                    return NoOp();

                int argCount = oc.ArgumentList?.Arguments.Count ?? 0;
                bool containerCtor = argCount == 1 && oc.Initializer == null
                    && IsContainerArg(oc.ArgumentList!.Arguments[0].Expression, ctx.Containers);
                if ((argCount > 0 && !containerCtor) || oc.Initializer != null)
                    return Gap("non-designer object creation (ctor args / initializer) for " + chain[0]);

                var node = new IrConstructComponent
                {
                    Name = chain[0],
                    TypeName = QualifiedTypeName(oc.Type),
                    WithComponentsContainer = containerCtor,
                };
                if (!IrValidate.ValidIdent(node.Name) || !IrValidate.ValidTypeName(node.TypeName))
                    return Gap("unrepresentable construction " + Trim(asg));
                return One(node);
            }

            // property assignment: `this.Prop[.Sub] = value` (root) or `this.f.Prop[.Sub] = value` (a named field).
            bool targetIsRoot;
            string targetName;
            List<string> path;
            if (chain.Count >= 2 && ctx.Fields.Contains(chain[0]))
            {
                targetIsRoot = false; targetName = chain[0]; path = chain.Skip(1).ToList();
            }
            else if (chain.Count >= 1 && !ctx.Fields.Contains(chain[0]))
            {
                // a chain that does NOT start with a known field is a root property (`this.Text = ...` flattens to [Text]).
                targetIsRoot = true; targetName = ""; path = chain;
            }
            else
            {
                return Gap("unrecognized LHS " + Trim(asg.Left));
            }
            if (path.Count == 0 || path.Count > IrLimits.MaxPathLength) return Gap(Trim(asg));

            var val = ClassifyValue(asg.Right, ctx);
            if (val == null) return Gap(Trim(asg));
            return One(new IrSetProperty { TargetIsRoot = targetIsRoot, TargetName = targetName, PropertyPath = path, Value = val });
        }

        private static (List<IrStatement>, bool, string?) ClassifyInvocation(InvocationExpressionSyntax inv, Ctx ctx)
        {
            if (inv.Expression is not MemberAccessExpressionSyntax ma) return Gap(Trim(inv));
            string method = ma.Name.Identifier.Text;

            // layout scaffolding — inert, represented (regenerated canonically by the serializer). ONLY the canonical
            // VS shapes qualify: receiver is `this` or a FIELD-ROOTED member chain, args are empty or a single bool
            // literal. A non-canonical shape (a receiver not rooted at this/a field, or a computed/dropped arg) must NOT
            // be silently dropped as a no-op — fall back. The receiver may be DEEP: VS emits panel-level
            // calls like `this.splitContainer1.Panel1.SuspendLayout()` / `.Panel2.ResumeLayout(false)` for every
            // populated SplitContainer/ToolStripContainer panel — those flatten to [field, Panel1], so requiring a
            // single-hop receiver would needlessly drop a whole common form to fallback.
            if (method is "SuspendLayout" or "ResumeLayout" or "PerformLayout")
            {
                var lrecv = Flatten(ma.Expression);
                bool okRecv = lrecv.Count == 0 || ctx.Fields.Contains(lrecv[0]);
                var largs = inv.ArgumentList.Arguments;
                bool okArgs = largs.Count == 0
                    || (largs.Count == 1 && largs[0].Expression is LiteralExpressionSyntax ll
                        && (ll.IsKind(SyntaxKind.TrueLiteralExpression) || ll.IsKind(SyntaxKind.FalseLiteralExpression)));
                return okRecv && okArgs ? NoOp() : Gap(Trim(inv));
            }

            // ((System.ComponentModel.ISupportInitialize)(this.x)).BeginInit()/.EndInit() — REAL replay on net48.
            if (method is "BeginInit" or "EndInit" && ma.Expression is ParenthesizedExpressionSyntax pe
                && pe.Expression is CastExpressionSyntax ce && ce.Type.ToString() == "System.ComponentModel.ISupportInitialize")
            {
                var initTarget = Flatten(ce.Expression); // the cast operand, e.g. (this.dataGridView1)
                if (initTarget.Count == 1 && ctx.Fields.Contains(initTarget[0]))
                {
                    IrStatement n = method == "BeginInit"
                        ? new IrBeginInit { TargetName = initTarget[0] }
                        : (IrStatement)new IrEndInit { TargetName = initTarget[0] };
                    return One(n);
                }
                return Gap(Trim(inv));
            }

            // collection add: `this.f.Coll.Add(item)` / `.AddRange(new T[]{...})`, and Controls.Add (special-cased).
            if (method is "Add" or "AddRange")
            {
                var recv = Flatten(ma.Expression); // e.g. [f, Controls] or [Controls] or [f, Items]
                if (recv.Count == 0) return Gap(Trim(inv));
                bool recvIsRoot = !ctx.Fields.Contains(recv[0]);
                string recvName = recvIsRoot ? "" : recv[0];
                var collPath = recvIsRoot ? recv : recv.Skip(1).ToList();
                if (collPath.Count == 0 || collPath.Count > IrLimits.MaxPathLength) return Gap(Trim(inv));

                // Controls.Add — model as IrAddControl (incl. the 3-arg TLP cell form: Add(child, col, row)).
                if (collPath.Count >= 1 && collPath[collPath.Count - 1] == "Controls" && method == "Add")
                {
                    var args = inv.ArgumentList.Arguments;
                    if (args.Count is 1 or 3)
                    {
                        var childChain = Flatten(args[0].Expression);
                        if (childChain.Count == 1 && ctx.Fields.Contains(childChain[0]))
                        {
                            int col = -1, row = -1;
                            if (args.Count == 3 && !(TryConstInt(args[1].Expression, out col) && TryConstInt(args[2].Expression, out row)))
                                return Gap(Trim(inv));
                            var parentPath = collPath.Take(collPath.Count - 1).ToList(); // drop "Controls"
                            return One(new IrAddControl
                            {
                                ParentIsRoot = recvIsRoot,
                                ParentName = recvName,
                                ParentPath = parentPath,
                                ChildName = childChain[0],
                                Column = col,
                                Row = row,
                            });
                        }
                    }
                    return Gap(Trim(inv));
                }

                // <control>.Nodes.Add/AddRange(<tree-node locals>) — attach tree-node locals to a TreeNodeCollection.
                if (collPath[collPath.Count - 1] == "Nodes")
                {
                    var nodeEls = new List<ExpressionSyntax>();
                    if (method == "AddRange" && inv.ArgumentList.Arguments.Count == 1
                        && inv.ArgumentList.Arguments[0].Expression is ArrayCreationExpressionSyntax narr && narr.Initializer != null)
                        nodeEls.AddRange(narr.Initializer.Expressions);
                    else
                        foreach (var a in inv.ArgumentList.Arguments) nodeEls.Add(a.Expression);

                    var refs = new List<string>();
                    bool allNodes = nodeEls.Count > 0;
                    foreach (var e in nodeEls)
                    {
                        var c = Flatten(e);
                        if (c.Count == 1 && ctx.TreeNodeLocals.Contains(c[0])) refs.Add(c[0]);
                        else { allNodes = false; break; }
                    }
                    if (allNodes)
                        return One(new IrAddTreeNodes { TargetIsRoot = recvIsRoot, TargetName = recvName, PropertyPath = collPath, NodeLocalNames = refs });
                    return Gap(Trim(inv)); // a Nodes.Add of something that isn't a tree-node local → honest fallback
                }

                // generic collection Add / AddRange elements (named component ref or an inline allowlisted value). A
                // multi-item AddRange (menus/toolbars: Items.AddRange(new ToolStripItem[]{a,b,c})) now emits N nodes —
                // ONE represented statement, N adds — so common ToolStrip/MenuStrip forms interpret instead of falling
                // back. Any element the value classifier can't represent still fails the WHOLE statement closed.
                var elements = new List<ExpressionSyntax>();
                if (method == "AddRange")
                {
                    // Only the canonical single-array-initializer AddRange is modelable as N element adds; an
                    // AddRange(non-array) or parameterless AddRange() cannot be.
                    if (inv.ArgumentList.Arguments.Count == 1
                        && inv.ArgumentList.Arguments[0].Expression is ArrayCreationExpressionSyntax arr
                        && arr.Initializer != null)
                        elements.AddRange(arr.Initializer.Expressions);
                    else
                        return Gap(Trim(inv));
                }
                else // "Add"
                {
                    // A single-argument Add is the ONLY append shape IrAddCollectionItem is valid for. A multi-arg Add
                    // (e.g. ListView.Items.Add(text, imageKey) builds ONE composite item, not two) or a zero-arg Add
                    // (a vendor default-insert) cannot be modeled as independent element adds — fall back.
                    if (inv.ArgumentList.Arguments.Count != 1) return Gap(Trim(inv));
                    elements.Add(inv.ArgumentList.Arguments[0].Expression);
                }

                var built = new List<IrStatement>();
                foreach (var e in elements)
                {
                    var item = ClassifyValue(e, ctx);
                    if (item == null) return Gap(Trim(inv));
                    built.Add(new IrAddCollectionItem { TargetIsRoot = recvIsRoot, TargetName = recvName, PropertyPath = collPath, Item = item });
                }
                return built.Count == 0 ? NoOp() : Rep(built); // an empty AddRange adds nothing → represented no-op
            }

            // IExtenderProvider.SetX(target, value) — e.g. this.toolTip1.SetToolTip(this.button1, "Save"). The provider
            // is a field, arg0 is the target (a field or `this`), arg1 is the value. The executor validates the provider
            // really is an IExtenderProvider and Set<Prop> is a real 2-arg setter (not any method named Set*).
            if (method.Length > 3 && method.StartsWith("Set") && inv.ArgumentList.Arguments.Count == 2)
            {
                var provChain = Flatten(ma.Expression);
                if (provChain.Count == 1 && ctx.Fields.Contains(provChain[0]))
                {
                    var tgtExpr = inv.ArgumentList.Arguments[0].Expression;
                    bool tgtRoot = tgtExpr is ThisExpressionSyntax;
                    var tgtChain = Flatten(tgtExpr);
                    string tgtName = tgtRoot ? "" : (tgtChain.Count == 1 ? tgtChain[0] : "");
                    if (tgtRoot || (tgtName.Length != 0 && ctx.Fields.Contains(tgtName)))
                    {
                        var xval = ClassifyValue(inv.ArgumentList.Arguments[1].Expression, ctx);
                        if (xval != null && IrValidate.ValidIdent(method.Substring(3)))
                            return One(new IrSetExtender
                            {
                                ProviderName = provChain[0],
                                TargetIsRoot = tgtRoot,
                                TargetName = tgtName,
                                PropertyName = method.Substring(3),
                                Value = xval,
                            });
                    }
                }
            }
            return Gap(Trim(inv));
        }

        // ------------------------------------------------------ values ----------------------------------------------

        /// <summary>Classify an RHS expression into a closed IrValue, or null when it is not representable in schema
        /// v1 (→ the owning statement becomes a coverage gap). Syntax-only: matches VS-canonical fully-qualified
        /// shapes against the FullName allowlists; an enum member is emitted as a SHAPE the executor validates.</summary>
        private static IrValue? ClassifyValue(ExpressionSyntax expr, Ctx ctx, int depth = 0)
        {
            if (depth > IrLimits.MaxValueDepth) return null;
            switch (expr)
            {
                case LiteralExpressionSyntax lit:
                    return LiteralValue(lit);

                case PrefixUnaryExpressionSyntax pre when pre.IsKind(SyntaxKind.UnaryMinusExpression)
                        && pre.Operand is LiteralExpressionSyntax numLit && numLit.IsKind(SyntaxKind.NumericLiteralExpression):
                    {
                        var n = NumericValue(numLit);
                        return n == null ? null : new IrNumber { Kind = n.Kind, InvariantText = "-" + n.InvariantText };
                    }

                case ThisExpressionSyntax:
                    return new IrComponentRef { IsRoot = true, Name = "" };

                case CastExpressionSyntax cast:
                    {
                        var inner = ClassifyValue(Unparen(cast.Expression), ctx, depth + 1);
                        if (inner == null) return null;
                        return new IrCast { TargetTypeName = QualifiedTypeName(cast.Type), Inner = inner };
                    }

                case ObjectCreationExpressionSyntax oc:
                    {
                        string tn = QualifiedTypeName(oc.Type);
                        // inline value construction is allowed ONLY for the FullName allowlist (Point/Size/Font/…).
                        if (!AllowlistHasConstruction(tn)) return null;
                        if (oc.Initializer != null) return null;
                        var args = new List<IrValue>();
                        foreach (var a in oc.ArgumentList?.Arguments ?? default)
                        {
                            if (a.NameColon != null) return null; // named args reorder vs positional replay → can't model
                            var av = ClassifyValue(a.Expression, ctx, depth + 1);
                            if (av == null) return null;
                            args.Add(av);
                        }
                        if (args.Count > IrLimits.MaxCtorArgs) return null;
                        return new IrKnownCtor { TypeName = tn, Args = args };
                    }

                case ArrayCreationExpressionSyntax arr when arr.Initializer != null:
                    {
                        var items = new List<IrValue>();
                        foreach (var e in arr.Initializer.Expressions)
                        {
                            var iv = ClassifyValue(e, ctx, depth + 1);
                            if (iv == null) return null;
                            items.Add(iv);
                        }
                        if (items.Count > IrLimits.MaxArrayItems) return null;
                        return new IrArray { ElementTypeName = QualifiedTypeName(arr.Type.ElementType), Items = items };
                    }

                case InvocationExpressionSyntax inv when inv.Expression is MemberAccessExpressionSyntax ima:
                    {
                        string recv = FullDottedName(ima.Expression);
                        string method = ima.Name.Identifier.Text;
                        // resources.GetObject("k") / GetString("k")
                        if (ctx.ResxVars.Contains(recv) && method is "GetObject" or "GetString"
                            && inv.ArgumentList.Arguments.Count == 1
                            && inv.ArgumentList.Arguments[0].Expression is LiteralExpressionSyntax keyLit
                            && keyLit.IsKind(SyntaxKind.StringLiteralExpression))
                            return new IrResourceRef { Key = (string)keyLit.Token.Value!, IsString = method == "GetString" };
                        // allowlisted static factory (System.Drawing.Color.FromArgb/FromName/FromKnownColor)
                        if (AllowlistHasFactory(recv, method))
                        {
                            var fargs = new List<IrValue>();
                            foreach (var a in inv.ArgumentList.Arguments)
                            {
                                if (a.NameColon != null) return null; // named args reorder vs positional replay → can't model
                                var av = ClassifyValue(a.Expression, ctx, depth + 1);
                                if (av == null) return null;
                                fargs.Add(av);
                            }
                            return new IrStaticFactory { TypeName = recv, Method = method, Args = fargs };
                        }
                        return null;
                    }

                case MemberAccessExpressionSyntax ma:
                    {
                        var chain = Flatten(ma);
                        // component reference: `this.field`
                        if (chain.Count == 1 && ctx.Fields.Contains(chain[0]))
                            return new IrComponentRef { IsRoot = false, Name = chain[0] };
                        string prefix = FullDottedName(ma.Expression);
                        string member = ma.Name.Identifier.Text;
                        // allowlisted static read (System.Drawing.Color.Red, System.Drawing.SystemColors.Control, Cursors.*)
                        if (AllowlistHasStaticRead(prefix))
                            return new IrStaticRead { TypeName = prefix, Member = member };
                        // otherwise a candidate ENUM member — emit the shape; the executor validates (enum? real member?)
                        // and fails closed → fallback, so a mis-guess is never a wrong render.
                        if (IrValidate.ValidTypeName(prefix) && IrValidate.ValidIdent(member))
                            return new IrEnum { EnumTypeName = prefix, Members = new List<string> { member } };
                        return null;
                    }

                case BinaryExpressionSyntax bin when bin.IsKind(SyntaxKind.BitwiseOrExpression):
                    {
                        // flags enum: A.B | A.C | ... — collect members; every operand must be an enum member of ONE type.
                        var members = new List<string>();
                        string? enumType = null;
                        if (!CollectFlagMembers(bin, ctx, ref enumType, members)) return null;
                        if (enumType == null || members.Count == 0 || members.Count > IrLimits.MaxEnumMembers) return null;
                        return new IrEnum { EnumTypeName = enumType, Members = members };
                    }

                case ParenthesizedExpressionSyntax par:
                    return ClassifyValue(par.Expression, ctx, depth + 1);

                default:
                    return null;
            }
        }

        private static bool CollectFlagMembers(ExpressionSyntax expr, Ctx ctx, ref string? enumType, List<string> members)
        {
            if (expr is BinaryExpressionSyntax bin && bin.IsKind(SyntaxKind.BitwiseOrExpression))
                return CollectFlagMembers(bin.Left, ctx, ref enumType, members)
                    && CollectFlagMembers(bin.Right, ctx, ref enumType, members);
            if (Unparen(expr) is MemberAccessExpressionSyntax ma)
            {
                string prefix = FullDottedName(ma.Expression);
                string member = ma.Name.Identifier.Text;
                if (AllowlistHasStaticRead(prefix)) return false; // a color-or isn't a flags enum we model
                if (!IrValidate.ValidTypeName(prefix) || !IrValidate.ValidIdent(member)) return false;
                if (enumType == null) enumType = prefix;
                else if (enumType != prefix) return false; // members must share one enum type
                members.Add(member);
                return true;
            }
            return false;
        }

        private static IrValue? LiteralValue(LiteralExpressionSyntax lit)
        {
            if (lit.IsKind(SyntaxKind.StringLiteralExpression)) return new IrString { Value = (string)(lit.Token.Value ?? "") };
            if (lit.IsKind(SyntaxKind.CharacterLiteralExpression)) return new IrChar { Value = (char)lit.Token.Value! };
            if (lit.IsKind(SyntaxKind.TrueLiteralExpression)) return new IrBool { Value = true };
            if (lit.IsKind(SyntaxKind.FalseLiteralExpression)) return new IrBool { Value = false };
            if (lit.IsKind(SyntaxKind.NullLiteralExpression)) return new IrNull();
            if (lit.IsKind(SyntaxKind.NumericLiteralExpression)) return NumericValue(lit);
            return null;
        }

        private static IrNumber? NumericValue(LiteralExpressionSyntax lit)
        {
            string raw = lit.Token.Text; // preserve exact spelling (suffix carries the kind)
                                         // Hex/binary literals (0xFF, 0b1010) don't fit the DECIMAL suffix inference below: the trailing hex digit
                                         // F/D and the exponent letter E are mistaken for float/double suffixes, and StripNumericSuffix then mangles
                                         // "0xFF" → "0x", which the executor can never parse. Fall back honestly (an unrepresented statement) rather
                                         // than emit a node doomed to a post-execution failure that inflates coverage first.
            if (raw.Length > 1 && raw[0] == '0' && (raw[1] == 'x' || raw[1] == 'X' || raw[1] == 'b' || raw[1] == 'B'))
                return null;
            var kind = InferNumericKind(raw);
            string text = StripNumericSuffix(raw);
            if (text.Length == 0 || text.Length > 64) return null;
            return new IrNumber { Kind = kind, InvariantText = text };
        }

        // A TreeNode local is modeled ONLY for the canonical WinForms type (VS fully-qualifies designer code). A
        // user/vendor type whose final segment merely happens to be "TreeNode" (e.g. MyNamespace.TreeNode) must NOT be
        // silently treated as a System.Windows.Forms.TreeNode — it falls through to the Gap path.
        private static bool IsWinFormsTreeNodeType(string typeName)
        {
            var n = typeName.Replace(" ", "");
            return n == "System.Windows.Forms.TreeNode" || n == "TreeNode";
        }

        // ------------------------------------------------------ helpers ---------------------------------------------

        private static bool AllowlistHasConstruction(string fullName) => DesignerAllowlists.IsConstructionName(fullName);
        private static bool AllowlistHasStaticRead(string fullName) => DesignerAllowlists.IsStaticReadName(fullName);
        private static bool AllowlistHasFactory(string type, string method) => DesignerAllowlists.IsFactoryName(type, method);

        /// <summary>Flatten a member-access / identifier chain into its identifier segments, dropping a leading
        /// `this.`. `this.f.Prop.Sub` → [f, Prop, Sub]; `Text` → [Text]; `this` → []. Non-identifier links abort
        /// (returns what was gathered so callers reject unexpected shapes).</summary>
        private static List<string> Flatten(ExpressionSyntax expr)
        {
            var parts = new List<string>();
            void Walk(ExpressionSyntax e)
            {
                switch (e)
                {
                    case MemberAccessExpressionSyntax ma:
                        Walk(ma.Expression);
                        parts.Add(ma.Name.Identifier.Text);
                        break;
                    case IdentifierNameSyntax id:
                        parts.Add(id.Identifier.Text);
                        break;
                    case ThisExpressionSyntax:
                        break; // drop the leading this.
                    case ParenthesizedExpressionSyntax pe:
                        Walk(pe.Expression);
                        break;
                    default:
                        parts.Add("\0"); // sentinel: an unexpected link → callers see an invalid ident and reject
                        break;
                }
            }
            Walk(expr);
            return parts;
        }

        /// <summary>Split a flattened LHS chain into (targetIsRoot, targetName, leaf). `[Event]` → (root, "", Event);
        /// `[btn, Click]` → (field btn, Click). Leaf null when the shape can't split.</summary>
        private static (bool, string, string?) SplitTargetAndLeaf(List<string> chain)
        {
            if (chain.Count == 1) return (true, "", chain[0]);
            if (chain.Count == 2) return (false, chain[0], chain[1]);
            return (false, chain[0], chain[chain.Count - 1]); // deeper wiring targets are rare; keep the field + event leaf
        }

        private static string? HandlerNameOf(ExpressionSyntax rhs)
        {
            // new Handler(this.method) → method ; or a bare this.method → method
            if (rhs is ObjectCreationExpressionSyntax oc && oc.ArgumentList?.Arguments.Count == 1)
                rhs = oc.ArgumentList.Arguments[0].Expression;
            var chain = Flatten(rhs);
            return chain.Count >= 1 ? chain[chain.Count - 1] : null;
        }

        private static bool IsContainerArg(ExpressionSyntax arg, HashSet<string> containerNames)
        {
            var c = Flatten(arg);
            return c.Count == 1 && containerNames.Contains(c[0]);
        }

        private static bool TryConstInt(ExpressionSyntax e, out int value)
        {
            value = 0;
            e = Unparen(e);
            bool neg = false;
            if (e is PrefixUnaryExpressionSyntax pre && pre.IsKind(SyntaxKind.UnaryMinusExpression)) { neg = true; e = pre.Operand; }
            if (e is LiteralExpressionSyntax lit && lit.IsKind(SyntaxKind.NumericLiteralExpression)
                && int.TryParse(StripNumericSuffix(lit.Token.Text), NumberStyles.Integer, CultureInfo.InvariantCulture, out value))
            {
                if (neg) value = -value;
                return true;
            }
            return false;
        }

        private static ExpressionSyntax Unparen(ExpressionSyntax e)
        {
            while (e is ParenthesizedExpressionSyntax p) e = p.Expression;
            return e;
        }

        /// <summary>The source's dotted type/member prefix as written (VS emits fully-qualified). `System.Drawing.Color`
        /// stays `System.Drawing.Color`. Used to match the FullName allowlists directly.</summary>
        private static string FullDottedName(ExpressionSyntax e)
        {
            switch (e)
            {
                case IdentifierNameSyntax id: return id.Identifier.Text;
                case MemberAccessExpressionSyntax ma: return FullDottedName(ma.Expression) + "." + ma.Name.Identifier.Text;
                case QualifiedNameSyntax qn: return qn.ToString();
                case ParenthesizedExpressionSyntax pe: return FullDottedName(pe.Expression);
                default: return e.ToString();
            }
        }

        /// <summary>C# predefined-type keyword → CLR FullName. VS emits keyword aliases in cast/array positions — the
        /// classic Font ctor's charset arg `((byte)(0))` and `new string[] {...}` (RichTextBox.Lines) — which the
        /// reflection-format host resolver can't resolve as "byte"/"string". Normalizing them keeps those canonical
        /// forms interpreting instead of falling back.</summary>
        private static readonly Dictionary<string, string> KeywordTypeAliases = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["bool"] = "System.Boolean",
            ["byte"] = "System.Byte",
            ["sbyte"] = "System.SByte",
            ["char"] = "System.Char",
            ["decimal"] = "System.Decimal",
            ["double"] = "System.Double",
            ["float"] = "System.Single",
            ["int"] = "System.Int32",
            ["uint"] = "System.UInt32",
            ["long"] = "System.Int64",
            ["ulong"] = "System.UInt64",
            ["object"] = "System.Object",
            ["short"] = "System.Int16",
            ["ushort"] = "System.UInt16",
            ["string"] = "System.String",
        };

        /// <summary>A type syntax as a reflection-ish qualified name (dots between namespace parts). VS emits
        /// fully-qualified names, so this is the source text with whitespace removed; a bare C# keyword alias (byte,
        /// string, …) is mapped to its CLR FullName so the host can resolve it; nested/generic forms that the designer
        /// never emits fall through to the raw string (and are rejected downstream by IrValidate).</summary>
        private static string QualifiedTypeName(TypeSyntax t)
        {
            string s = t.ToString().Replace(" ", "");
            return KeywordTypeAliases.TryGetValue(s, out var fqn) ? fqn : s;
        }

        private static string? FirstBaseTypeName(ClassDeclarationSyntax cls)
        {
            var b = cls.BaseList?.Types.FirstOrDefault();
            return b == null ? null : b.Type.ToString().Replace(" ", "");
        }

        private static string LastTypeSegment(string typeName)
        {
            int lt = typeName.IndexOf('<');
            if (lt >= 0) typeName = typeName.Substring(0, lt);
            int dot = typeName.LastIndexOf('.');
            return dot >= 0 ? typeName.Substring(dot + 1) : typeName;
        }

        private static IrNumericKind InferNumericKind(string raw)
        {
            string s = raw.ToUpperInvariant();
            bool u = s.Contains("U");
            if (s.EndsWith("UL") || s.EndsWith("LU")) return IrNumericKind.UInt64;
            if (s.EndsWith("L")) return u ? IrNumericKind.UInt64 : IrNumericKind.Int64;
            if (s.EndsWith("F")) return IrNumericKind.Single;
            if (s.EndsWith("D")) return IrNumericKind.Double;
            if (s.EndsWith("M")) return IrNumericKind.Decimal;
            if (u) return IrNumericKind.UInt32;
            if (s.Contains(".") || s.Contains("E")) return IrNumericKind.Double; // designer float literals carry F; a bare decimal point → double
            return IrNumericKind.Int32;
        }

        private static string StripNumericSuffix(string raw)
        {
            int end = raw.Length;
            while (end > 0 && "uUlLfFdDmM".IndexOf(raw[end - 1]) >= 0) end--;
            return raw.Substring(0, end);
        }

        private static string Trim(SyntaxNode n) => n.ToString().Trim();
    }
}
