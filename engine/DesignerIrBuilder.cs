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
                NamespaceContext = NamespaceContextOf(cls),
            };

            var init = FormClassResolver.InitMethodOf(cls);
            if (init?.Body == null)
            {
                doc.UnrepresentableReasons.Add("InitializeComponent not found");
                return doc;
            }

            // Field names across ALL partials (a form may split fields into a sibling partial — mirror Interpret).
            // The DECLARED type is kept beside the name: C# binds a hidden (`new`) member through the receiver's
            // STATIC type, so a call or hop on a field whose declared type differs from the instance it is given can
            // denote a different member than the one this syntax-only IR would replay (see TypeCertain below).
            var fieldNames = new HashSet<string>(StringComparer.Ordinal);
            var fieldDeclaredTypes = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var part in DesignerModifiers.PartialsOf(cls))
                foreach (var f in part.Members.OfType<FieldDeclarationSyntax>())
                    foreach (var v in f.Declaration.Variables)
                    {
                        fieldNames.Add(v.Identifier.Text);
                        // Compared as WRITTEN, not by simple name: `private A.Edit e; this.e = new B.Edit();` where
                        // B.Edit derives from A.Edit shares the simple name `Edit`, and treating that as certain would
                        // let a crafted file bind through A.Edit while the executor searches B.Edit.
                        fieldDeclaredTypes[v.Identifier.Text] = NormalizeTypeText(f.Declaration.Type.ToString());
                    }

            var designedMethodNames = new HashSet<string>(StringComparer.Ordinal);
            foreach (var part in DesignerModifiers.PartialsOf(cls))
                foreach (var m in part.Members.OfType<MethodDeclarationSyntax>())
                    designedMethodNames.Add(m.Identifier.Text);

            // `IContainer components = new Container()` names (lets a `new T(this.components)` ctor be recognized),
            // and ComponentResourceManager locals (lets `resources.GetObject("k")` be recognized). Both are collected
            // in a first pass because a statement can reference a local declared earlier.
            var containerNames = new HashSet<string>(StringComparer.Ordinal);
            var resxVars = new HashSet<string>(StringComparer.Ordinal);
            var treeNodeLocals = new HashSet<string>(StringComparer.Ordinal);
            var typeCertain = new HashSet<string>(StringComparer.Ordinal);
            var constructedOnce = new HashSet<string>(StringComparer.Ordinal);
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
                    && a0.Right is ObjectCreationExpressionSyntax cc)
                {
                    string ctorType = NormalizeTypeText(cc.Type.ToString());
                    if ((cc.ArgumentList?.Arguments.Count ?? 0) == 0 && cc.Initializer == null && LastTypeSegment(cc.Type.ToString()) == "Container")
                        containerNames.Add(lhs[0]);
                    // A field constructed EXACTLY ONCE with its own declared type binds hidden members the same way
                    // whether C# resolves them statically or the executor resolves them on the instance. Constructed
                    // twice, or with a different type, and that equivalence is unproven → the field is not certain.
                    if (fieldDeclaredTypes.TryGetValue(lhs[0], out var declared))
                    {
                        if (constructedOnce.Add(lhs[0]) && declared == ctorType) typeCertain.Add(lhs[0]);
                        else typeCertain.Remove(lhs[0]);
                    }
                }
            }

            var ctx = new Ctx(fieldNames, containerNames, resxVars, treeNodeLocals, typeCertain, designedMethodNames);
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
            /// <summary>Fields whose DECLARED type is the type actually constructed into them. Only for those can the
            /// executor's runtime-type member lookup be trusted to select what C# bound at the call site — a
            /// `private BaseEdit e; this.e = new DerivedEdit();` field would bind hidden members through BaseEdit
            /// while the executor sees DerivedEdit.</summary>
            public readonly HashSet<string> TypeCertain;
            /// <summary>Method names the designed class declares in THIS file — a member of the designed class hides
            /// the base's, and the interpreted root (a base instance) cannot carry it.</summary>
            public readonly HashSet<string> DesignedMethodNames;
            public Ctx(HashSet<string> f, HashSet<string> c, HashSet<string> r, HashSet<string> tn, HashSet<string> tc, HashSet<string> dm)
            { Fields = f; Containers = c; ResxVars = r; TreeNodeLocals = tn; TypeCertain = tc; DesignedMethodNames = dm; }
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
            if (chain.Count == 2 && !ctx.Fields.Contains(chain[0]) && IsInheritedOverrideProperty(chain[1]))
            {
                // A derived designer may legally address a public/protected field declared by its compiled base. The
                // syntax-only front-end cannot prove that field, so emit only the exact one-hop allowlisted shape; the
                // executor must independently resolve a unique accessible framework field before it can mutate anything.
                targetIsRoot = false; targetName = chain[0]; path = new List<string> { chain[1] };
            }
            else if (chain.Count >= 2 && ctx.Fields.Contains(chain[0]))
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

        private static bool IsInheritedOverrideProperty(string propertyName) =>
            propertyName is "Location" or "Size" or "Bounds" or "Anchor" or "Dock"
                or "Text" or "Enabled" or "Visible" or "TabIndex";

        private static (List<IrStatement>, bool, string?) ClassifyInvocation(InvocationExpressionSyntax inv, Ctx ctx)
        {
            if (inv.Expression is not MemberAccessExpressionSyntax ma) return Gap(Trim(inv));
            // A GENERIC name (`BeginInit<T>()`) carries the same identifier text but binds to a different member than
            // the one the executor would call. The front-end has no semantic model, so the only safe rule is: a
            // recognized capability must be spelled as a plain identifier. Anything else is an honest gap.
            if (ma.Name is not IdentifierNameSyntax) return Gap(Trim(inv));
            string method = ma.Name.Identifier.Text;
            // Argument shapes the recognized capabilities never have. A named / ref / out / in argument means the call
            // binds to something else (an extension or vendor overload), and dropping it would replay a DIFFERENT
            // method than the source runs.
            static bool PlainArgs(InvocationExpressionSyntax i) =>
                i.ArgumentList.Arguments.All(a => a.NameColon == null && a.RefKindKeyword.IsKind(SyntaxKind.None));

            // resources.ApplyResources(this.button1, "button1") / resources.ApplyResources(this, "$this").
            // Represent ONLY the VS-canonical same-form ComponentResourceManager local. A foreign manager was not
            // registered in ResxVars, and any computed target/key/named/ref argument shape falls back honestly.
            if (method == "ApplyResources")
            {
                string recv = FullDottedName(ma.Expression);
                var args = inv.ArgumentList.Arguments;
                if (ctx.ResxVars.Contains(recv) && args.Count == 2 && PlainArgs(inv)
                    && args[1].Expression is LiteralExpressionSyntax keyLit
                    && keyLit.IsKind(SyntaxKind.StringLiteralExpression))
                {
                    bool targetIsRoot = args[0].Expression is ThisExpressionSyntax;
                    var targetChain = Flatten(args[0].Expression);
                    string targetName = targetIsRoot ? "" : (targetChain.Count == 1 ? targetChain[0] : "");
                    if (targetIsRoot || (targetName.Length != 0 && ctx.Fields.Contains(targetName)))
                    {
                        return One(new IrApplyResources
                        {
                            TargetIsRoot = targetIsRoot,
                            TargetName = targetName,
                            ResourceKey = (string)(keyLit.Token.Value ?? ""),
                        });
                    }
                }
                return Gap(Trim(inv));
            }

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
                bool lrecvIsRoot = lrecv.Count == 0;
                bool okRecv = lrecvIsRoot || ctx.Fields.Contains(lrecv[0]);
                var largs = inv.ArgumentList.Arguments;
                // Per-method arg rules, because these are now EXECUTED. `Control` declares SuspendLayout() and
                // PerformLayout() with no bool overload at all, so `panel1.SuspendLayout(true)` can only bind to a
                // vendor/extension method — accepting it and calling the framework method instead would replay
                // something the compiled form never did. ResumeLayout takes zero args or one bool.
                bool argValue = false;
                bool okArgs;
                bool hasArg = largs.Count == 1;
                if (largs.Count == 0)
                {
                    okArgs = true;
                    // `Control.ResumeLayout()` is `ResumeLayout(true)` — it PERFORMS the pending layout, unlike the
                    // (false) overload VS emits. Modeling the absent argument as false would resume without laying
                    // out, so a later statement in the same replay would read pre-layout geometry.
                    argValue = method == "ResumeLayout";
                }
                else if (method == "ResumeLayout" && largs.Count == 1 && PlainArgs(inv)
                    && largs[0].Expression is LiteralExpressionSyntax ll
                    && (ll.IsKind(SyntaxKind.TrueLiteralExpression) || ll.IsKind(SyntaxKind.FalseLiteralExpression)))
                {
                    okArgs = true;
                    argValue = ll.IsKind(SyntaxKind.TrueLiteralExpression);
                }
                else
                {
                    okArgs = false;
                }
                var lpath = lrecvIsRoot ? lrecv : lrecv.Skip(1).ToList();
                if (!okRecv || !okArgs || lpath.Count > IrLimits.MaxPathLength) return Gap(Trim(inv));
                // A field receiver must be type-certain: the executor picks the layout member off the INSTANCE, and a
                // vendor control that hides SuspendLayout (DevExpress's XtraForm does) makes that the same member C#
                // bound only when the declared and constructed types agree.
                if (!lrecvIsRoot && !ctx.TypeCertain.Contains(lrecv[0])) return Gap(Trim(inv));
                // `this` is NOT automatically safe: the interpreted root is an instance of the designed class's BASE,
                // so a layout method the designed class itself declares (`private new void SuspendLayout()`) is not on
                // the instance at all, and replaying the base's member would run something the build never ran.
                // Only what this file can see is checked — a hider in the code-behind partial stays out of reach.
                if (lrecvIsRoot && ctx.DesignedMethodNames.Contains(method)) return Gap(Trim(inv));
                // REPLAYED, not dropped: the bracket is what keeps a property assignment from re-running layout on an
                // already-added anchored child (see IrLayoutCall). The serializer still regenerates these calls
                // canonically on a whole-file write — this node only drives the interpreted render.
                return One(new IrLayoutCall
                {
                    TargetIsRoot = lrecvIsRoot,
                    TargetName = lrecvIsRoot ? "" : lrecv[0],
                    TargetPath = lpath,
                    Op = method == "SuspendLayout" ? IrLayoutOp.Suspend
                        : method == "ResumeLayout" ? IrLayoutOp.Resume : IrLayoutOp.Perform,
                    Arg = argValue,
                    HasArg = hasArg,
                });
            }

            // ((System.ComponentModel.ISupportInitialize)(this.x)).BeginInit()/.EndInit() — REAL replay on net48.
            if (method is "BeginInit" or "EndInit" && inv.ArgumentList.Arguments.Count == 0
                && ma.Expression is ParenthesizedExpressionSyntax pe
                && pe.Expression is CastExpressionSyntax ce && ce.Type.ToString() == "System.ComponentModel.ISupportInitialize")
            {
                // Zero args is required, not cosmetic: the interface members take none, so `BeginInit(x)` binds to an
                // extension or vendor overload. Representing it would drop that argument and call the interface
                // method instead — a different operation than the source performs.
                // The cast operand is `(this.dataGridView1)` — or, for every DevExpress XtraEditors control,
                // `(this.textEdit1.Properties)`: the bracketed object is the editor's RepositoryItem reached through
                // read-only hops. Model the hops as a path; the executor resolves and type-checks them (a hop that
                // isn't readable, or a target that isn't really ISupportInitialize, fails closed → fallback).
                var initTarget = Flatten(ce.Expression);
                // The bracket itself is exact — the cast makes it an interface dispatch whatever the field's static
                // type is. The HOPS are not: `this.edit1.Properties` binds through the field's declared type, so a
                // chained bracket needs the same type-certainty a layout call does. A hop-free bracket does not.
                if (initTarget.Count >= 1 && initTarget.Count <= IrLimits.MaxPathLength + 1 && ctx.Fields.Contains(initTarget[0])
                    && (initTarget.Count == 1 || ctx.TypeCertain.Contains(initTarget[0])))
                {
                    var initPath = initTarget.Skip(1).ToList();
                    IrStatement n = method == "BeginInit"
                        ? new IrBeginInit { TargetName = initTarget[0], TargetPath = initPath }
                        : (IrStatement)new IrEndInit { TargetName = initTarget[0], TargetPath = initPath };
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
                        // VS emits Image values such as `System.Drawing.SystemIcons.Information.ToBitmap()`. Model
                        // only that exact zero-argument framework shape, encoded as a fixed allowlisted pseudo-factory
                        // so the child executor can re-check both the trusted type and the finite icon-member set.
                        if (method == "ToBitmap" && inv.ArgumentList.Arguments.Count == 0
                            && ima.Expression is MemberAccessExpressionSyntax iconRead)
                        {
                            string iconType = FullDottedName(iconRead.Expression);
                            string iconMember = iconRead.Name.Identifier.Text;
                            if (DesignerAllowlists.TryGetSystemIconBitmapFactoryName(iconType, iconMember, out string iconFactory))
                                return new IrStaticFactory { TypeName = iconType, Method = iconFactory };
                        }
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
                        if (!CollectFlagMembers(bin, ctx, ref enumType, members, 0)) return null;
                        if (enumType == null || members.Count == 0 || members.Count > IrLimits.MaxEnumMembers) return null;
                        return new IrEnum { EnumTypeName = enumType, Members = members };
                    }

                case ParenthesizedExpressionSyntax par:
                    return ClassifyValue(par.Expression, ctx, depth + 1);

                default:
                    return null;
            }
        }

        /// <summary>Collect `A.X | A.Y | …` flag members. Operands are unparenthesized FIRST because VS emits the
        /// left-nested, parenthesized shape for three or more flags — `(((Top | Bottom) | Left) | Right)` — so a
        /// recursion that only descended through bare binary nodes dropped every 3+-side Anchor to fallback. Depth is
        /// bounded: the operand tree is attacker-controlled source, and the walk must not be able to exhaust the stack
        /// before <see cref="IrLimits.MaxEnumMembers"/> is checked by the caller.</summary>
        private static bool CollectFlagMembers(ExpressionSyntax expr, Ctx ctx, ref string? enumType, List<string> members, int depth)
        {
            // Bail on BOTH axes before doing the work: nesting depth (a deep spine must not exhaust the stack) and
            // the member count the caller would reject anyway (a wide balanced tree must not be collected first).
            if (depth > IrLimits.MaxEnumMembers || members.Count > IrLimits.MaxEnumMembers) return false;
            expr = Unparen(expr);
            if (expr is BinaryExpressionSyntax bin && bin.IsKind(SyntaxKind.BitwiseOrExpression))
                return CollectFlagMembers(bin.Left, ctx, ref enumType, members, depth + 1)
                    && CollectFlagMembers(bin.Right, ctx, ref enumType, members, depth + 1);
            if (expr is MemberAccessExpressionSyntax ma)
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

        /// <summary>Type text with all whitespace removed, so a spaced and an unspaced spelling of the SAME name
        /// compare equal while two different namespaces sharing a simple name do not. Deliberately textual: the
        /// front-end has no semantic model, so equality here means "written the same way" — which is what
        /// VS-generated code always is for a field declaration and the construction assigned into it.</summary>
        private static string NormalizeTypeText(string s) => new string(s.Where(c => !char.IsWhiteSpace(c)).ToArray());

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

        /// <summary>
        /// The namespaces an UNQUALIFIED type name in this file may resolve to, most likely first: every `using`
        /// directive that is in scope (file-level and inside the namespace, in source order), then the enclosing
        /// namespace and each ancestor of it.
        ///
        /// Why the enclosing chain and not only the usings: a control declared in the form's own namespace (or in a
        /// parent of it) needs no using at all, and C# would still bind it.
        ///
        /// Deliberately syntax-only and deliberately NOT clever: alias directives (`using DX = Vendor.Controls;`) are
        /// skipped rather than half-resolved — an alias makes the written name itself unresolvable, which is a
        /// different problem from a missing namespace and must not be papered over here. Static usings are skipped
        /// too (they import members, not types). The result is bounded and each entry is validated by IrValidate.
        /// </summary>
        private static List<string> NamespaceContextOf(ClassDeclarationSyntax cls)
        {
            var seen = new HashSet<string>(StringComparer.Ordinal);
            var result = new List<string>();
            void Add(string? candidate)
            {
                if (string.IsNullOrEmpty(candidate)) return;
                string ns = candidate!.Replace(" ", "");
                if (ns.Length == 0 || ns.Length > IrLimits.MaxTypeNameLength) return;
                if (result.Count >= IrLimits.MaxNamespaceContext) return;
                if (seen.Add(ns)) result.Add(ns);
            }

            // Scope by scope, innermost first — and INSIDE each scope the namespace's own members come BEFORE its
            // `using` directives, because that is how C# binds: in
            //     namespace App { using Vendor; class Widget … ; … new Widget(); }
            // the compiler creates `App.Widget`, not `Vendor.Widget`. Getting this backwards would silently construct
            // a different component than the source compiles to. `namespace A.B.C` is equivalent to three nested
            // scopes, so its ancestors are searched after that scope's usings and before the next outer scope.
            // BaseNamespaceDeclarationSyntax, not NamespaceDeclarationSyntax: it also covers the FILE-SCOPED form
            // (`namespace X;`), whose usings and namespace would otherwise be invisible.
            var scopes = new List<BaseNamespaceDeclarationSyntax>();
            CompilationUnitSyntax? unit = null;
            for (SyntaxNode? node = cls; node != null; node = node.Parent)
            {
                if (node is BaseNamespaceDeclarationSyntax ns) scopes.Add(ns);
                else if (node is CompilationUnitSyntax cu) unit = cu;
            }
            for (int i = 0; i < scopes.Count; i++)
            {
                string full = FullNamespaceOf(scopes[i]);
                string outer = i + 1 < scopes.Count ? FullNamespaceOf(scopes[i + 1]) : "";
                Add(full);
                foreach (var u in scopes[i].Usings)
                    if (u.Alias == null && u.StaticKeyword.IsKind(SyntaxKind.None)) Add(u.Name?.ToString());
                // the dotted ancestors this scope stands for, down to (not including) the next scope outward
                for (string cur = full; ; )
                {
                    int dot = cur.LastIndexOf('.');
                    if (dot <= 0) break;
                    cur = cur.Substring(0, dot);
                    if (cur == outer) break;
                    Add(cur);
                }
            }
            if (unit != null)
                foreach (var u in unit.Usings)
                    if (u.Alias == null && u.StaticKeyword.IsKind(SyntaxKind.None)) Add(u.Name?.ToString());
            return result;
        }

        /// <summary>A namespace declaration's FULL name, composed from every enclosing declaration: the inner block of
        /// `namespace Product { namespace Ui { … } }` is `Product.Ui`, not `Ui`. Covers the file-scoped form
        /// (`namespace X;`) too, since both shapes are BaseNamespaceDeclarationSyntax.</summary>
        private static string FullNamespaceOf(BaseNamespaceDeclarationSyntax declaration)
        {
            var parts = new List<string>();
            for (SyntaxNode? n = declaration; n != null; n = n.Parent)
                if (n is BaseNamespaceDeclarationSyntax ns) parts.Insert(0, ns.Name.ToString().Replace(" ", ""));
            return string.Join(".", parts);
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
