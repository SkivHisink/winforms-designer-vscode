using System;
using System.Collections.Generic;

namespace WinFormsDesigner.Engine
{
    // ============================================================================================================
    // The CLOSED statement IR for live-source interpretation on the net48 engine.
    //
    // COMPILE-LINKED into BOTH engines (like FormClassResolver/DesignerModifiers), because it is a *contract*:
    // the net10 engine's Roslyn front-end PRODUCES it in the net48 process's DEFAULT AppDomain (where Roslyn is
    // allowed to live), and the net48 child-AppDomain executor CONSUMES it (Roslyn must never load there — the
    // child's binding redirects are unified on the USER's assembly versions; see ChildDomainConfig).
    //
    // SECURITY CONTRACT:
    // · CLOSED vocabulary: every node is a SEALED [Serializable] class in THIS file. The executor must refuse a
    // document containing any node whose concrete type is not in IrValidate's closed set — sealed classes stop
    // subclass smuggling at compile time, the closed-set walk stops forged-stream type smuggling at run time.
    // · Capability nodes, not generic invocation: there is deliberately NO "call arbitrary method" node. Each
    // executable operation is a specific capability (construct / set-property / add-control / add-collection-item
    // / set-extender / begin-init / end-init), and the CHILD-side executor must still semantically validate every
    // one against the live graph before acting (parser-side checks are necessary, never sufficient).
    // · Semantic values only: IrValue variants carry typed literals and allowlisted constructions — never source
    // expression text for the consumer to re-parse or evaluate. Verbatim-preservation text (event wirings aside,
    // which are inert metadata) stays in the default domain and is not part of this contract.
    // · No object/Type/MemberInfo/delegate/syntax fields anywhere; strings + primitives + arrays/lists of IR nodes
    // only. Bounds below cap every dimension so a crafted document cannot balloon the executor.
    // · Versioned: SchemaVersion is checked by the executor before anything else; unknown version → refuse.
    //
    // The three Eval allowlists (construction / static factory / static read) remain authoritative in
    // DesignerRenderer for now; this shared core holds them so parser and executor consult ONE
    // set (transient duplication would silently fork the security boundary.
    //
    // Out of scope for schema v1 (coverage-gap → disclosed compiled fallback, NOT silent): TreeNode local-variable
    // subsystem, non-component inline vendor constructions, everything today's interpreter reports unrepresentable.
    // ============================================================================================================

    /// <summary>Hard structural bounds for one IR document. Enforced by <see cref="IrValidate"/> on BOTH sides of
    /// the AppDomain boundary (produce and consume) — the executor never trusts the producer.</summary>
    public static class IrLimits
    {
        public const int SchemaVersion = 1;
        public const int MaxStatements = 20000;
        /// <summary>Max nesting depth of IrValue trees (arrays of casts of ctors …).</summary>
        public const int MaxValueDepth = 16;
        /// <summary>Max hops in a property path (`btn.FlatAppearance.BorderColor` = 2 hops).</summary>
        public const int MaxPathLength = 8;
        public const int MaxIdentifierLength = 512;
        /// <summary>Type names can be namespace-qualified + nested (`Ns.Outer+Inner`).</summary>
        public const int MaxTypeNameLength = 1024;
        public const int MaxStringLength = 1 << 20; // 1 MiB — covers pathological Text/Rtf literals
        public const int MaxArrayItems = 10000;
        public const int MaxEnumMembers = 64;
        public const int MaxCtorArgs = 16;
        /// <summary>Total node budget across the whole document (statements + every nested value).</summary>
        public const int MaxTotalNodes = 200000;
        /// <summary>AGGREGATE string-content budget across the WHOLE document. Each string is bounded by
        /// MaxStringLength and the node count by MaxTotalNodes, but their product (e.g. 10k array items × 1 MiB each)
        /// is multi-gigabyte while passing both — so the total character payload is capped too. ~33M chars ≈ 64 MB
        /// UTF-16, far above any real form yet well below an OOM.</summary>
        public const long MaxTotalStringChars = 1L << 25;
        /// <summary>Bound on the UnrepresentableReasons list.</summary>
        public const int MaxUnrepresentableReasons = 40000;
    }

    // ---------------------------------------------------------------- values --------------------------------------

    /// <summary>Base of the closed value vocabulary. Carries no data; every leaf is sealed and listed in
    /// <see cref="IrValidate"/>. The executor materializes values itself (invariant-culture parsing, allowlisted
    /// construction) — an IrValue is data, never code.</summary>
    [Serializable] public abstract class IrValue { }

    [Serializable] public sealed class IrNull : IrValue { }
    [Serializable] public sealed class IrBool : IrValue { public bool Value { get; set; } }
    [Serializable] public sealed class IrChar : IrValue { public char Value { get; set; } }
    [Serializable] public sealed class IrString : IrValue { public string Value { get; set; } = ""; }

    /// <summary>The numeric kinds a .Designer.cs literal can carry. Closed — the executor refuses others.</summary>
    [Serializable]
    public enum IrNumericKind { Int32, Int64, Single, Double, Decimal, Byte, SByte, Int16, UInt16, UInt32, UInt64 }

    /// <summary>A typed numeric literal as invariant-culture text (`"42"`, `"-6.5"`). Text (not binary) keeps
    /// decimal/float round-trips exact and unary minus explicit; the executor parses with the declared kind and
    /// invariant culture — this is a literal, not an expression.</summary>
    [Serializable]
    public sealed class IrNumber : IrValue
    {
        public IrNumericKind Kind { get; set; }
        public string InvariantText { get; set; } = "";
    }

    /// <summary>`EnumType.Member` or a bitwise-or chain of members of ONE enum type (flags). Member NAMES only —
    /// numeric enum spellings are not representable in v1 (coverage gap, honest fallback).</summary>
    [Serializable]
    public sealed class IrEnum : IrValue
    {
        public string EnumTypeName { get; set; } = "";
        public List<string> Members { get; set; } = new List<string>();
    }

    /// <summary>`new T(args…)` where T is in the shared construction allowlist (Point/Size/Font/Padding/…-class
    /// value types ONLY — never user/vendor/corelib types). Parser refuses non-allowlisted T at produce time; the
    /// executor re-checks at consume time.</summary>
    [Serializable]
    public sealed class IrKnownCtor : IrValue
    {
        public string TypeName { get; set; } = "";
        public List<IrValue> Args { get; set; } = new List<IrValue>();
    }

    /// <summary>Allowlisted static factory call (`Color.FromArgb(…)`, `Color.FromName(…)` — nothing else).</summary>
    [Serializable]
    public sealed class IrStaticFactory : IrValue
    {
        public string TypeName { get; set; } = "";
        public string Method { get; set; } = "";
        public List<IrValue> Args { get; set; } = new List<IrValue>();
    }

    /// <summary>Allowlisted static/property read (`Color.Red`, `SystemColors.Control`, `Cursors.Hand`).</summary>
    [Serializable]
    public sealed class IrStaticRead : IrValue
    {
        public string TypeName { get; set; } = "";
        public string Member { get; set; } = "";
    }

    /// <summary>Reference to the root (`this`) or a component this SAME document constructed (`this.button1`).
    /// The executor refuses names its own construction table doesn't contain (or, for inherited components, its
    /// merged base-identity table).</summary>
    [Serializable]
    public sealed class IrComponentRef : IrValue
    {
        public bool IsRoot { get; set; }
        public string Name { get; set; } = "";
    }

    /// <summary>`new T[] { … }` — element TYPE is a name the executor resolves and validates; elements are IrValues.</summary>
    [Serializable]
    public sealed class IrArray : IrValue
    {
        public string ElementTypeName { get; set; } = "";
        public List<IrValue> Items { get; set; } = new List<IrValue>();
    }

    /// <summary>`resources.GetObject("key")` / `GetString("key")` — resolved by the SAFE resx resolver only
    /// (binary/SOAP/FileRef nodes refused → `unsafeBinaryResource` fallback).</summary>
    [Serializable]
    public sealed class IrResourceRef : IrValue
    {
        public string Key { get; set; } = "";
        public bool IsString { get; set; } // GetString vs GetObject
    }

    /// <summary>A pure conversion cast (`(byte)5`, `(AnchorStyles)(…)`) — conversion only, never execution.</summary>
    [Serializable]
    public sealed class IrCast : IrValue
    {
        public string TargetTypeName { get; set; } = "";
        public IrValue Inner { get; set; } = new IrNull();
    }

    // -------------------------------------------------------------- statements ------------------------------------

    /// <summary>Base of the closed statement vocabulary — capability nodes, source order preserved.</summary>
    [Serializable] public abstract class IrStatement { }

    /// <summary>`this.f = new T();` / `new T(this.components);` — construct a field-backed component of compiled
    /// type T. The executor resolves T in the CHILD domain, requires IComponent (or Control where the consuming
    /// capability demands it), sites it (real IContainer/ISite, DesignMode=true), and records Name in its
    /// construction table. Parameterless (or the components-container ctor) ONLY.</summary>
    [Serializable]
    public sealed class IrConstructComponent : IrStatement
    {
        public string Name { get; set; } = "";
        public string TypeName { get; set; } = "";
        public bool WithComponentsContainer { get; set; }
    }

    /// <summary>`target.Prop = value;` or `target.Sub.Prop = value;` — PropertyPath is identifier hops walked via
    /// TypeDescriptor on the live instance (executor validates every hop resolves to a real readable property and
    /// the leaf to a writable one).</summary>
    [Serializable]
    public sealed class IrSetProperty : IrStatement
    {
        public bool TargetIsRoot { get; set; }
        public string TargetName { get; set; } = "";
        public List<string> PropertyPath { get; set; } = new List<string>();
        public IrValue Value { get; set; } = new IrNull();
    }

    /// <summary>`parent.Controls.Add(child)` — incl. the TLP 3-arg cell form (Column/Row = -1 when absent) and a
    /// container sub-path (`splitContainer1.Panel1`, ParentPath). Executor validates the resolved collection IS a
    /// real Control.ControlCollection.</summary>
    [Serializable]
    public sealed class IrAddControl : IrStatement
    {
        public bool ParentIsRoot { get; set; }
        public string ParentName { get; set; } = "";
        public List<string> ParentPath { get; set; } = new List<string>();
        public string ChildName { get; set; } = "";
        public int Column { get; set; } = -1;
        public int Row { get; set; } = -1;
    }

    /// <summary>`target.SomeCollection.Add(item)` / one AddRange element — Item is a named component ref or an
    /// inline allowlisted value. Executor validates the target collection against its modeled collection shapes.</summary>
    [Serializable]
    public sealed class IrAddCollectionItem : IrStatement
    {
        public bool TargetIsRoot { get; set; }
        public string TargetName { get; set; } = "";
        public List<string> PropertyPath { get; set; } = new List<string>();
        public IrValue Item { get; set; } = new IrNull();
    }

    /// <summary>`provider.SetX(target, value)` (IExtenderProvider — SetToolTip/SetColumnSpan/…). Executor validates
    /// the provider really is an IExtenderProvider exposing extender property X for the target — never "any public
    /// method starting with Set".</summary>
    [Serializable]
    public sealed class IrSetExtender : IrStatement
    {
        public string ProviderName { get; set; } = "";
        public bool TargetIsRoot { get; set; }
        public string TargetName { get; set; } = "";
        public string PropertyName { get; set; } = "";
        public IrValue Value { get; set; } = new IrNull();
    }

    /// <summary>`((ISupportInitialize)x).BeginInit();` — REAL replay on the net48 executor (vendor grids depend on
    /// the batching): interface dispatch only, zero args, target must exist and implement the real interface;
    /// unmatched/failed pairs are a HARD interpreted-render failure → dispose graph → fallback (never Snapshot a
    /// half-initialized vendor tree).</summary>
    [Serializable] public sealed class IrBeginInit : IrStatement { public string TargetName { get; set; } = ""; }
    /// <summary>`((ISupportInitialize)x).EndInit();` — see <see cref="IrBeginInit"/>.</summary>
    [Serializable] public sealed class IrEndInit : IrStatement { public string TargetName { get; set; } = ""; }

    /// <summary>`target.Click += this.Handler;` — INERT METADATA. The executor never wires events (design surface
    /// must not run user handlers); carried for describe parity (bold/handler columns) and re-emit.</summary>
    [Serializable]
    public sealed class IrWireEvent : IrStatement
    {
        public bool TargetIsRoot { get; set; }
        public string TargetName { get; set; } = "";
        public string EventName { get; set; } = "";
        public string HandlerName { get; set; } = "";
    }

    // ---- TreeView.Nodes subsystem: VS serializes tree nodes as LOCAL variables (not fields), bottom-up. A dedicated,
    // pure vocabulary (TreeNode ctors + a small settable-prop allowlist) keeps it OUT of the general value allowlist. --

    /// <summary>`TreeNode nodeLocal = new TreeNode("text", new TreeNode[]{child…});` — construct a TreeNode LOCAL.
    /// Text is a string literal (null for the parameterless ctor); children are other tree-node locals (constructed
    /// earlier). The executor keeps a side-table keyed by LocalName — these are NOT sited components.</summary>
    [Serializable]
    public sealed class IrConstructTreeNode : IrStatement
    {
        public string LocalName { get; set; } = "";
        public string? Text { get; set; }
        public List<string> ChildLocalNames { get; set; } = new List<string>();
    }

    /// <summary>`nodeLocal.Name/Text/ToolTipText/ImageKey/… = value;` — set an allowlisted, side-effect-free property
    /// on a tree-node local (the executor gates PropName to a fixed set).</summary>
    [Serializable]
    public sealed class IrSetTreeNodeProp : IrStatement
    {
        public string LocalName { get; set; } = "";
        public string PropName { get; set; } = "";
        public IrValue Value { get; set; } = new IrNull();
    }

    /// <summary>`this.treeView1.Nodes.AddRange(new TreeNode[]{node…});` (or a node's own .Nodes) — attach tree-node
    /// locals to a TreeNodeCollection reached from a control target via PropertyPath (e.g. ["Nodes"]).</summary>
    [Serializable]
    public sealed class IrAddTreeNodes : IrStatement
    {
        public bool TargetIsRoot { get; set; }
        public string TargetName { get; set; } = "";
        public List<string> PropertyPath { get; set; } = new List<string>();
        public List<string> NodeLocalNames { get; set; } = new List<string>();
    }

    // -------------------------------------------------------------- document -------------------------------------

    /// <summary>One parsed InitializeComponent, plus the coverage report the per-form mode classifier reads.
    /// FullCoverage (every source statement represented) is a precondition of interpreted mode; anything less is a
    /// named, disclosed compiled fallback — never a silent partial render.
    ///
    /// [Serializable] because it is BUILT in the engine's default AppDomain (where Roslyn lives) and MARSHALED into
    /// the render child domain (where Roslyn must NOT load — its binding redirects are unified on the user's versions;
    /// this is the whole reason the parser and executor are split across the boundary).
    /// Every member is itself serializable (sealed IR nodes + strings/ints), so it round-trips cleanly.</summary>
    [Serializable]
    public sealed class IrDocument
    {
        public int SchemaVersion { get; set; } = IrLimits.SchemaVersion;
        /// <summary>The LOGICAL designed class (reflection format) — what the user is editing. Distinct from the
        /// runtime root the executor instantiates (the immediate BASE type; VS model).</summary>
        public string DesignedTypeName { get; set; } = "";
        /// <summary>The base type exactly as the source declares it (syntax name); the executor resolves it against
        /// the compiled assembly and refuses on mismatch (`baseTypeChangedRebuildRequired` — stale-type handshake).</summary>
        public string BaseTypeSyntaxName { get; set; } = "";
        public List<IrStatement> Statements { get; set; } = new List<IrStatement>();
        public int TotalSourceStatements { get; set; }
        public int RepresentedStatements { get; set; }
        /// <summary>Named reasons for every statement NOT represented (drives the fallback reason codes).</summary>
        public List<string> UnrepresentableReasons { get; set; } = new List<string>();
        public bool FullCoverage => RepresentedStatements == TotalSourceStatements;
    }

    // -------------------------------------------------------------- validation ------------------------------------

    /// <summary>Structural validation of an IrDocument — the SAME code runs on the producer (parser, default
    /// domain) and the consumer (executor, child domain); the consumer NEVER skips it. Checks: schema version,
    /// closed concrete-type set, every bound in <see cref="IrLimits"/>, identifier/type-name shape. Semantic
    /// validation (does the type resolve, is the property real, is the target constructed) is the executor's own
    /// second layer and deliberately NOT here — it needs the live graph.</summary>
    public static class IrValidate
    {
        /// <summary>Closed set of every concrete node type a document may contain. Extending the vocabulary =
        /// adding the sealed class AND listing it here AND bumping SchemaVersion AND teaching the executor — by
        /// construction there is no way to smuggle behavior in data.</summary>
        private static readonly HashSet<Type> Closed = new HashSet<Type>
        {
            typeof(IrNull), typeof(IrBool), typeof(IrChar), typeof(IrString), typeof(IrNumber), typeof(IrEnum),
            typeof(IrKnownCtor), typeof(IrStaticFactory), typeof(IrStaticRead), typeof(IrComponentRef),
            typeof(IrArray), typeof(IrResourceRef), typeof(IrCast),
            typeof(IrConstructComponent), typeof(IrSetProperty), typeof(IrAddControl), typeof(IrAddCollectionItem),
            typeof(IrSetExtender), typeof(IrBeginInit), typeof(IrEndInit), typeof(IrWireEvent),
            typeof(IrConstructTreeNode), typeof(IrSetTreeNodeProp), typeof(IrAddTreeNodes),
        };

        /// <summary>Validate structure; returns null when valid, else a diagnostic reason (the caller refuses the
        /// whole document — there is no partial acceptance).</summary>
        public static string? Check(IrDocument? doc)
        {
            if (doc == null) return "document is null";
            if (doc.SchemaVersion != IrLimits.SchemaVersion) return "unknown IR schema version " + doc.SchemaVersion;
            if (!ValidTypeName(doc.DesignedTypeName)) return "invalid DesignedTypeName";
            // BaseTypeSyntaxName is OPTIONAL: a VS form declares its base in the NON-designer partial, so the parsed
            // .Designer.cs often has no base at all (empty). The executor resolves the base from the compiled designed
            // type; a non-empty name is only a hint for the stale-base handshake. Validate it only when present.
            if (doc.BaseTypeSyntaxName == null) return "BaseTypeSyntaxName is null";
            if (doc.BaseTypeSyntaxName.Length != 0 && !ValidTypeName(doc.BaseTypeSyntaxName)) return "invalid BaseTypeSyntaxName";
            if (doc.Statements == null) return "Statements is null";
            if (doc.Statements.Count > IrLimits.MaxStatements) return "too many statements";
            if (doc.TotalSourceStatements < 0 || doc.RepresentedStatements < 0
                || doc.RepresentedStatements > doc.TotalSourceStatements) return "invalid coverage counts";
            // Forged-doc robustness: UnrepresentableReasons is read by the coverage classifier BEFORE
            // this validator normally runs; a null or unbounded list is refused here (and the classifier null-guards too).
            if (doc.UnrepresentableReasons == null) return "UnrepresentableReasons is null";
            if (doc.UnrepresentableReasons.Count > IrLimits.MaxUnrepresentableReasons) return "too many unrepresentable reasons";
            long chars = 0;
            foreach (var r in doc.UnrepresentableReasons)
            {
                if (r != null) chars += r.Length;
                if (chars > IrLimits.MaxTotalStringChars) return "string budget exceeded";
            }
            int nodes = 0;
            foreach (var s in doc.Statements)
            {
                var err = CheckStatement(s, ref nodes, ref chars);
                if (err != null) return err;
            }
            return null;
        }

        private static string? CheckStatement(IrStatement? s, ref int nodes, ref long chars)
        {
            if (s == null) return "null statement";
            if (!Closed.Contains(s.GetType())) return "unknown statement type " + s.GetType().Name;
            if (++nodes > IrLimits.MaxTotalNodes) return "node budget exceeded";
            switch (s)
            {
                case IrConstructComponent c:
                    if (!ValidIdent(c.Name)) return "invalid component name";
                    if (!ValidTypeName(c.TypeName)) return "invalid component type name";
                    return OverBudget(ref chars, c.Name) || OverBudget(ref chars, c.TypeName) ? "string budget exceeded" : null;
                case IrSetProperty p:
                    if (!ValidTarget(p.TargetIsRoot, p.TargetName)) return "invalid set-property target";
                    var pe = CheckPath(p.PropertyPath, min: 1); if (pe != null) return pe;
                    return CheckValue(p.Value, 0, ref nodes, ref chars);
                case IrAddControl a:
                    if (!ValidTarget(a.ParentIsRoot, a.ParentName)) return "invalid add-control parent";
                    var ape = CheckPath(a.ParentPath, min: 0); if (ape != null) return ape;
                    if (!ValidIdent(a.ChildName)) return "invalid add-control child";
                    if (a.Column < -1 || a.Row < -1 || a.Column > 10000 || a.Row > 10000) return "invalid cell";
                    return null;
                case IrAddCollectionItem i:
                    if (!ValidTarget(i.TargetIsRoot, i.TargetName)) return "invalid add-item target";
                    var ipe = CheckPath(i.PropertyPath, min: 1); if (ipe != null) return ipe;
                    return CheckValue(i.Item, 0, ref nodes, ref chars);
                case IrSetExtender x:
                    if (!ValidIdent(x.ProviderName)) return "invalid extender provider";
                    if (!ValidTarget(x.TargetIsRoot, x.TargetName)) return "invalid extender target";
                    if (!ValidIdent(x.PropertyName)) return "invalid extender property";
                    return CheckValue(x.Value, 0, ref nodes, ref chars);
                case IrBeginInit b: return ValidIdent(b.TargetName) ? null : "invalid BeginInit target";
                case IrEndInit e: return ValidIdent(e.TargetName) ? null : "invalid EndInit target";
                case IrWireEvent w:
                    if (!ValidTarget(w.TargetIsRoot, w.TargetName)) return "invalid event target";
                    if (!ValidIdent(w.EventName) || !ValidIdent(w.HandlerName)) return "invalid event/handler name";
                    return null;
                case IrConstructTreeNode tn:
                    if (!ValidIdent(tn.LocalName)) return "invalid tree-node local name";
                    if (tn.Text != null && tn.Text.Length > IrLimits.MaxStringLength) return "tree-node text too long";
                    if (OverBudget(ref chars, tn.LocalName) || OverBudget(ref chars, tn.Text)) return "string budget exceeded";
                    if (tn.ChildLocalNames == null || tn.ChildLocalNames.Count > IrLimits.MaxArrayItems) return "invalid tree-node children";
                    foreach (var ch in tn.ChildLocalNames) { if (!ValidIdent(ch)) return "invalid tree-node child name"; if (OverBudget(ref chars, ch)) return "string budget exceeded"; }
                    return null;
                case IrSetTreeNodeProp tp:
                    if (!ValidIdent(tp.LocalName) || !ValidIdent(tp.PropName)) return "invalid tree-node property";
                    return CheckValue(tp.Value, 0, ref nodes, ref chars);
                case IrAddTreeNodes ta:
                    if (!ValidTarget(ta.TargetIsRoot, ta.TargetName)) return "invalid tree-node add target";
                    var tae = CheckPath(ta.PropertyPath, min: 1); if (tae != null) return tae;
                    if (ta.NodeLocalNames == null || ta.NodeLocalNames.Count == 0 || ta.NodeLocalNames.Count > IrLimits.MaxArrayItems) return "invalid tree-node add list";
                    foreach (var n in ta.NodeLocalNames) { if (!ValidIdent(n)) return "invalid tree-node ref"; if (OverBudget(ref chars, n)) return "string budget exceeded"; }
                    return null;
                default: return "unhandled statement type " + s.GetType().Name; // unreachable while Closed is exact
            }
        }

        private static string? CheckValue(IrValue? v, int depth, ref int nodes, ref long chars)
        {
            if (v == null) return "null value";
            if (!Closed.Contains(v.GetType())) return "unknown value type " + v.GetType().Name;
            if (++nodes > IrLimits.MaxTotalNodes) return "node budget exceeded";
            if (depth > IrLimits.MaxValueDepth) return "value nesting too deep";
            // Every string this node carries is added to the whole-document aggregate (type names,
            // resource keys, and enum members are individually bounded but multiply by the node count into gigabytes;
            // the per-string caps and node budget alone don't stop it). NOTE the deserialization allocation itself is a
            // separate, deferred concern (a SerializationBinder / stream-level bound) — this bounds downstream work.
            switch (v)
            {
                case IrNull _: case IrBool _: case IrChar _: return null;
                case IrString s:
                    if (s.Value == null || s.Value.Length > IrLimits.MaxStringLength) return "string too long/null";
                    return OverBudget(ref chars, s.Value) ? "string budget exceeded" : null;
                case IrNumber n:
                    if (n.InvariantText == null || n.InvariantText.Length == 0 || n.InvariantText.Length > 64) return "invalid numeric literal";
                    if (!Enum.IsDefined(typeof(IrNumericKind), n.Kind)) return "invalid numeric kind";
                    return null;
                case IrEnum en:
                    if (!ValidTypeName(en.EnumTypeName)) return "invalid enum type";
                    if (en.Members == null || en.Members.Count == 0 || en.Members.Count > IrLimits.MaxEnumMembers) return "invalid enum member list";
                    foreach (var m in en.Members) if (!ValidIdent(m)) return "invalid enum member";
                    if (OverBudget(ref chars, en.EnumTypeName)) return "string budget exceeded";
                    foreach (var m in en.Members) if (OverBudget(ref chars, m)) return "string budget exceeded";
                    return null;
                case IrKnownCtor kc:
                    if (!ValidTypeName(kc.TypeName)) return "invalid ctor type";
                    if (kc.Args == null || kc.Args.Count > IrLimits.MaxCtorArgs) return "invalid ctor args";
                    if (OverBudget(ref chars, kc.TypeName)) return "string budget exceeded";
                    foreach (var a in kc.Args) { var e = CheckValue(a, depth + 1, ref nodes, ref chars); if (e != null) return e; }
                    return null;
                case IrStaticFactory f:
                    if (!ValidTypeName(f.TypeName) || !ValidIdent(f.Method)) return "invalid factory";
                    if (f.Args == null || f.Args.Count > IrLimits.MaxCtorArgs) return "invalid factory args";
                    if (OverBudget(ref chars, f.TypeName) || OverBudget(ref chars, f.Method)) return "string budget exceeded";
                    foreach (var a in f.Args) { var e = CheckValue(a, depth + 1, ref nodes, ref chars); if (e != null) return e; }
                    return null;
                case IrStaticRead r:
                    if (!ValidTypeName(r.TypeName) || !ValidIdent(r.Member)) return "invalid static read";
                    return OverBudget(ref chars, r.TypeName) || OverBudget(ref chars, r.Member) ? "string budget exceeded" : null;
                case IrComponentRef cr:
                    if (cr.IsRoot) return string.IsNullOrEmpty(cr.Name) ? null : "root ref carries a name";
                    if (!ValidIdent(cr.Name)) return "invalid component ref";
                    return OverBudget(ref chars, cr.Name) ? "string budget exceeded" : null;
                case IrArray arr:
                    if (!ValidTypeName(arr.ElementTypeName)) return "invalid array element type";
                    if (arr.Items == null || arr.Items.Count > IrLimits.MaxArrayItems) return "invalid array size";
                    if (OverBudget(ref chars, arr.ElementTypeName)) return "string budget exceeded";
                    foreach (var it in arr.Items) { var e = CheckValue(it, depth + 1, ref nodes, ref chars); if (e != null) return e; }
                    return null;
                case IrResourceRef rr:
                    if (rr.Key == null || rr.Key.Length == 0 || rr.Key.Length > IrLimits.MaxIdentifierLength) return "invalid resource key";
                    return OverBudget(ref chars, rr.Key) ? "string budget exceeded" : null;
                case IrCast c:
                    if (!ValidTypeName(c.TargetTypeName)) return "invalid cast type";
                    if (OverBudget(ref chars, c.TargetTypeName)) return "string budget exceeded";
                    return CheckValue(c.Inner, depth + 1, ref nodes, ref chars);
                default: return "unhandled value type " + v.GetType().Name; // unreachable while Closed is exact
            }
        }

        /// <summary>Accumulate a string's length into the whole-document aggregate; true when the total is exceeded.</summary>
        private static bool OverBudget(ref long chars, string? s)
        {
            if (s != null) chars += s.Length;
            return chars > IrLimits.MaxTotalStringChars;
        }

        // Null-safe: a forged node could carry a null TargetName; ValidIdent already null-guards, and
        // the root arm must not dereference a null name.
        private static bool ValidTarget(bool isRoot, string? name) => isRoot ? string.IsNullOrEmpty(name) : ValidIdent(name);

        private static string? CheckPath(List<string>? path, int min)
        {
            if (path == null) return "null path";
            if (path.Count < min || path.Count > IrLimits.MaxPathLength) return "invalid path length";
            foreach (var hop in path) if (!ValidIdent(hop)) return "invalid path segment";
            return null;
        }

        /// <summary>Strict ASCII C# identifier (same shape the engine's pinned IsValidIdentifier enforces for
        /// splices: rejects homoglyphs/injection by construction). Semantic checks live in the executor.</summary>
        internal static bool ValidIdent(string? s)
        {
            if (string.IsNullOrEmpty(s) || s!.Length > IrLimits.MaxIdentifierLength) return false;
            if (!(char.IsLetter(s[0]) && s[0] < 128) && s[0] != '_') return false;
            for (int i = 1; i < s.Length; i++)
            {
                char ch = s[i];
                if (!((char.IsLetterOrDigit(ch) && ch < 128) || ch == '_')) return false;
            }
            return true;
        }

        /// <summary>Namespace-qualified, optionally nested (`Ns.Outer+Inner`) type name made of valid identifiers.
        /// No generics/arrays/pointers — the designer vocabulary never needs them in a type position.</summary>
        internal static bool ValidTypeName(string? s)
        {
            if (string.IsNullOrEmpty(s) || s!.Length > IrLimits.MaxTypeNameLength) return false;
            foreach (var part in s.Split('.', '+'))
                if (!ValidIdent(part)) return false;
            return true;
        }
    }
}
