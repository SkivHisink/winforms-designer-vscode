using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.Globalization;
using System.Linq;
using System.Reflection;
using System.Windows.Forms;

namespace WinFormsDesigner.Engine
{
    // ============================================================================================================
    // The IR EXECUTOR. Consumes a closed statement IR (produced by the syntax-only front-end in the
    // default domain) and replays it against LIVE, COMPILED instances to build the design-time control tree — the
    // Visual Studio model (parse, never execute the source; instantiate compiled types and set parsed values).
    //
    // In production this runs in the net48 render CHILD AppDomain (compiled vendor types load there). It is shared
    // (compile-linked into both engines) and BCL-only, so it also runs on net10 for tests and the dark-shadow path.
    //
    // SECURITY: the executor NEVER trusts the producer. It re-runs
    // IrValidate.Check first, then SEMANTICALLY validates every operation against the live graph before acting —
    // · a construction / static factory / static read re-checks the SAME DesignerAllowlists the parser used
    // (a forged IR that smuggled a non-allowlisted type past the parser is refused here);
    // · a property path must resolve hop-by-hop through real TypeDescriptor properties;
    // · an AddControl target must be a real Control whose child is a real Control;
    // · a collection add must reach a real IList; an init call a real ISupportInitialize;
    // · a component reference must name the root or an instance THIS document already created.
    // Compiled component code (ctors, setters, collection/init methods) is trusted-to-execute — the boundary stops
    // arbitrary C# EXPRESSION execution from source, it does not sandbox already-compiled controls.
    //
    // FAIL-CLOSED: any unmet precondition aborts with a reason. The caller (RenderWorker) disposes the partial
    // graph and falls back to the disclosed compiled render — a half-built tree is never Snapshotted.
    // ============================================================================================================

    /// <summary>The child-domain services the executor needs. The executor is pure logic; the host owns runtime type
    /// resolution (against the compiled assemblies), component creation + siting (DesignMode=true), and SAFE resource
    /// resolution (binary/SOAP/FileRef refused.</summary>
    public interface IIrHost
    {
        /// <summary>Resolve a reflection-format type name against the project's compiled assemblies; null when absent.</summary>
        Type? ResolveType(string typeName);
        /// <summary>Create a field-backed component of the given type, sited (Name set, DesignMode=true). The
        /// <paramref name="withContainer"/> flag marks a provider/tray ctor (new T(this.components)); the host owns
        /// the container. Throws to signal an unconstructible type (the executor turns it into a fail-closed reason).</summary>
        object CreateComponent(Type type, string name, bool withContainer);
        /// <summary>Resolve a `resources.GetObject/GetString(key)` through a SAFE resolver (never BinaryFormatter on
        /// untrusted bytes). Return null to signal "unsafe/absent" → the owning statement fails closed.</summary>
        object? ResolveResource(string key, bool isString);
        /// <summary>True when the safe resolver deliberately REFUSED the key (a binary/SOAP/typed/file-ref node) — lets
        /// the executor emit the precise unsafeBinaryResource fallback instead of silently assigning null.</summary>
        bool WasResourceRefused(string key);
        /// <summary>True when the resources hold the key at all (served or refused): a GetString that resolves to null
        /// for a key that is present read an entry of another type, which ResourceManager rejects.</summary>
        bool HasResource(string key);
        /// <summary>True when the form has a well-formed resource set (a .resx was read): only there is a missing key a
        /// null, as ResourceManager returns it.</summary>
        bool HasResourceSet { get; }
        /// <summary>Apply `resources.ApplyResources(target, key)` through the SAFE resolver. Returns false with a
        /// reason when a matching resource node was refused, a target property is invalid, or conversion is not
        /// allowlisted. No arbitrary ResourceManager or binary deserialization is allowed here.</summary>
        bool ApplyResources(object target, string key, out string? error);
    }

    /// <summary>The project's build as the authority for an <see cref="IrBuildWitnessedCtor"/>: a value of a type no
    /// allowlist names is constructed only when the designed type's compiled InitializeComponent makes exactly that
    /// construction. A host that is not a witness refuses every such value.</summary>
    public interface IIrConstructionWitness
    {
        /// <summary>Whether the build constructs <paramref name="type"/> through the constructor whose parameter types
        /// are exactly the argument types, with these same constant values. Runs nothing.</summary>
        bool CanConstruct(Type type, object?[] args, out string reason);
        /// <summary>The same decision; when it holds, that constructor is run with these arguments.</summary>
        bool TryConstruct(Type type, object?[] args, out object? value, out string reason);
    }

    /// <summary>Where a named identity came from — the hybrid model. The
    /// root is the LOGICAL designed type; inherited components come from the compiled BASE (VS instantiates the base,
    /// which runs its own InitializeComponent) and must be surfaced but treated as read-only (their edits would have
    /// to persist to the base's own designer file); current-source components are the ones THIS IR created.</summary>
    public enum IrOrigin { Root, Inherited, DeclaredInCurrentSource }

    public sealed class IrExecutionResult
    {
        public bool Ok { get; private set; }
        public string? FailureReason { get; private set; }
        /// <summary>name → live instance for every component this document created; the root is under "".</summary>
        public Dictionary<string, object> Instances { get; private set; } = new Dictionary<string, object>(StringComparer.Ordinal);
        /// <summary>name → origin (root / inherited / declared-in-current-source). Inherited names are the compiled
        /// base's field-backed components (surfaced for Snapshot/selection but marked read-only by the caller).</summary>
        public Dictionary<string, IrOrigin> Origins { get; } = new Dictionary<string, IrOrigin>(StringComparer.Ordinal);
        /// <summary>ISupportInitialize targets whose BeginInit ran but whose EndInit has not yet — used by the caller
        /// to dispose a partially-initialized graph on failure.</summary>
        public List<object> PendingInit { get; } = new List<object>();

        /// <summary>Partial interpretation only: components whose construction threw, by source name, in source order.
        /// Never in <see cref="Instances"/>.</summary>
        public List<IrFailedComponent> FailedComponents { get; } = new List<IrFailedComponent>();
        /// <summary>Partial interpretation only: the engine's stand-in for each failed CONTROL, by source name. Never in
        /// <see cref="Instances"/>, so no describe, edit or reference route can reach one as the component it stands for.</summary>
        public Dictionary<string, IrPlaceholderControl> Placeholders { get; } = new Dictionary<string, IrPlaceholderControl>(StringComparer.Ordinal);
        /// <summary>Partial interpretation only: one line per thing that was not applied, in the shape the host's
        /// diagnostics list reads (a statement, then an optional "  [ExceptionType: message]").</summary>
        public List<string> Omissions { get; } = new List<string>();
        /// <summary>True when a partial interpretation left something out.</summary>
        public bool Partial => FailedComponents.Count != 0 || Omissions.Count != 0;

        public static IrExecutionResult Success(Dictionary<string, object> instances) =>
            new IrExecutionResult { Ok = true, Instances = instances };
        public static IrExecutionResult Fail(string reason) => new IrExecutionResult { Ok = false, FailureReason = reason };
    }

    /// <summary>A component a partial interpretation could not construct: its source name, the type it declares, and
    /// what the constructor threw.</summary>
    public sealed class IrFailedComponent
    {
        public string Name { get; set; } = "";
        public string TypeName { get; set; } = "";
        public string ExceptionType { get; set; } = "";
        public string Message { get; set; } = "";
        public bool IsControl { get; set; }
        /// <summary>Statements that use this component and were therefore not applied.</summary>
        public int SkippedStatements { get; set; }
    }

    /// <summary>The engine's own stand-in for a control whose constructor threw in a partial interpretation. A plain
    /// framework control: it receives only the geometry and the parent the source gives the failed control, never that
    /// control's own property replay, and it paints the source name, the declared type and the exception type.</summary>
    /// <para>It paints no background. The preview is captured with DrawToBitmap, which draws sibling windows in reverse
    /// z-order, so an opaque stand-in would cover the controls that did build; this one lets them show through.</para>
    public sealed class IrPlaceholderControl : Control
    {
        public IrPlaceholderControl(string sourceName, string declaredTypeName, string exceptionType)
        {
            SourceName = sourceName;
            DeclaredTypeName = declaredTypeName;
            ExceptionType = exceptionType;
            Name = sourceName;
            SetStyle(ControlStyles.UserPaint | ControlStyles.ResizeRedraw, true);
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer, false);
        }

        public string SourceName { get; }
        public string DeclaredTypeName { get; }
        public string ExceptionType { get; }

        protected override void OnPaintBackground(PaintEventArgs pevent)
        {
            // Nothing: whatever is already drawn underneath stays visible.
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            var bounds = ClientRectangle;
            if (bounds.Width <= 0 || bounds.Height <= 0) return;
            var accent = System.Drawing.Color.FromArgb(200, 64, 64);
            using (var hatch = new System.Drawing.Drawing2D.HatchBrush(System.Drawing.Drawing2D.HatchStyle.BackwardDiagonal,
                System.Drawing.Color.FromArgb(48, accent), System.Drawing.Color.Transparent))
                e.Graphics.FillRectangle(hatch, bounds);
            using (var pen = new System.Drawing.Pen(accent) { DashStyle = System.Drawing.Drawing2D.DashStyle.Dash })
                e.Graphics.DrawRectangle(pen, 0, 0, bounds.Width - 1, bounds.Height - 1);
            int dot = DeclaredTypeName.LastIndexOf('.');
            string shortType = dot >= 0 ? DeclaredTypeName.Substring(dot + 1) : DeclaredTypeName;
            // The source may place the control partly outside its parent; start the label where it can be seen.
            var label = System.Drawing.Rectangle.FromLTRB(Math.Max(0, -Left) + 4, Math.Max(0, -Top) + 4,
                bounds.Right - 4, bounds.Bottom - 4);
            if (label.Width > 0 && label.Height > 0)
                TextRenderer.DrawText(e.Graphics, SourceName + "\n" + shortType + "\n" + ExceptionType, Font, label, accent,
                    TextFormatFlags.WordBreak | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix);
        }
    }

    public static class DesignerIrExecutor
    {
        /// <summary>Replay <paramref name="doc"/> onto <paramref name="root"/> (already constructed by the host as
        /// the immediate BASE type — VS model). Returns Ok with the instance table, or a fail-closed reason. Only
        /// call for a FullCoverage document — a partial IR is a compiled-fallback case, decided by the caller.</summary>
        public static IrExecutionResult Execute(IrDocument doc, object root, IIrHost host) => Execute(doc, root, host, partial: false);

        /// <summary>
        /// <paramref name="partial"/> = the Visual Studio "Ignore and Continue" model, for a form that has no other
        /// preview. A component whose constructor throws (a design-time license gate included) is recorded instead of
        /// ending the replay: a failed CONTROL gets an engine-owned placeholder, which receives only the geometry and
        /// the parent the source gives it, and every other statement that uses the failed component is not applied and
        /// is counted or listed. Every other failure stays a hard failure exactly as in the strict replay: validation,
        /// identity, unresolved types, refused values, a setter or an init call that throws.
        /// </summary>
        public static IrExecutionResult Execute(IrDocument doc, object root, IIrHost host, bool partial)
        {
            if (root == null) return IrExecutionResult.Fail("null root");
            if (host == null) return IrExecutionResult.Fail("null host");
            // Consume-side revalidation — never trust the producer.
            var structural = IrValidate.Check(doc);
            if (structural != null) return IrExecutionResult.Fail("IR failed validation: " + structural);

            var instances = new Dictionary<string, object>(StringComparer.Ordinal) { [""] = root };
            var inheritedOverrideNames = new HashSet<string>(StringComparer.Ordinal);
            var inheritedSeedError = SeedInheritedOverrideInstances(doc, root, instances, inheritedOverrideNames);
            if (inheritedSeedError != null) return IrExecutionResult.Fail(inheritedSeedError);
            var beganInit = new List<object>();
            // Tree nodes are LOCAL variables (not sited components), kept in their own side-table (mirrors VS's local
            // `TreeNode treeNodeN = …` serialization). Pure objects — TreeNode ctors/setters run no user code.
            var treeNodes = new Dictionary<string, TreeNode>(StringComparer.Ordinal);
            var failed = new Dictionary<string, IrFailedComponent>(StringComparer.Ordinal);
            var failedInOrder = new List<IrFailedComponent>();
            var placeholders = new Dictionary<string, IrPlaceholderControl>(StringComparer.Ordinal);
            var omissions = new List<string>();

            foreach (var stmt in doc!.Statements)
            {
                try
                {
                    if (partial && stmt is IrConstructComponent construct)
                    {
                        var cerr = ConstructComponent(construct, instances, host, failed.ContainsKey(construct.Name), out var thrown, out var type);
                        if (cerr != null) return Abort(beganInit, cerr);
                        if (thrown != null)
                        {
                            var cause = thrown is TargetInvocationException && thrown.InnerException != null ? thrown.InnerException : thrown;
                            var failure = new IrFailedComponent
                            {
                                Name = construct.Name,
                                TypeName = type?.FullName ?? construct.TypeName,
                                ExceptionType = cause.GetType().Name,
                                Message = cause.Message ?? "",
                                IsControl = type != null && typeof(Control).IsAssignableFrom(type),
                            };
                            failed[construct.Name] = failure;
                            failedInOrder.Add(failure);
                            if (failure.IsControl)
                                placeholders[construct.Name] = new IrPlaceholderControl(construct.Name, failure.TypeName, failure.ExceptionType);
                        }
                        continue;
                    }
                    string? uses = partial && failed.Count != 0 ? FirstFailedReference(stmt, failed) : null;
                    if (uses != null)
                    {
                        if (!ApplyToPlaceholder(stmt, instances, placeholders, failed, beganInit, treeNodes, host, inheritedOverrideNames))
                        {
                            failed[uses].SkippedStatements++;
                            string? affected = ShapeAffectingHealthy(stmt, failed);
                            if (affected != null) omissions.Add(affected + "  (not applied: this." + uses + " could not be built)");
                        }
                        continue;
                    }
                    var err = ExecuteStatement(stmt, instances, beganInit, treeNodes, host, inheritedOverrideNames);
                    if (err != null) return Abort(beganInit, err);
                }
                catch (Exception ex)
                {
                    return Abort(beganInit, Describe(stmt) + " threw " + ex.GetType().Name + ": " + ex.Message);
                }
            }

            if (beganInit.Count != 0)
                return Abort(beganInit, "unbalanced ISupportInitialize: " + beganInit.Count + " BeginInit without EndInit");

            // A placeholder no parent could take (a TabControl takes only tab pages, say) is not on the canvas, and
            // neither is anything attached to it: name each of them rather than let them vanish.
            if (placeholders.Count != 0)
            {
                var names = new Dictionary<object, string>(IrReferenceEqualityComparer.Instance);
                foreach (var kv in instances) if (kv.Key.Length != 0 && !names.ContainsKey(kv.Value)) names[kv.Value] = kv.Key;
                foreach (var kv in placeholders) names[kv.Value] = kv.Key;
                foreach (var kv in placeholders)
                {
                    if (kv.Value.Parent != null) continue;
                    omissions.Add("this." + kv.Key + "  (not shown: no parent could take its placeholder)");
                    var pending = new Stack<Control>(kv.Value.Controls.Cast<Control>());
                    while (pending.Count != 0)
                    {
                        var hidden = pending.Pop();
                        if (names.TryGetValue(hidden, out var hiddenName))
                            omissions.Add("this." + hiddenName + "  (not shown: inside this." + kv.Key + ", which could not be built)");
                        foreach (Control child in hidden.Controls) pending.Push(child);
                    }
                }
            }

            var result = IrExecutionResult.Success(instances);
            // A failed component keeps its name: a compiled base component of the same name is the same hiding
            // collision it would be had the component built, and is refused the same way.
            var idErr = BuildIdentityModel(doc, root, instances, result.Origins, inheritedOverrideNames, failed.Keys);
            if (idErr != null) return IrExecutionResult.Fail(idErr);
            foreach (var failure in failedInOrder)
            {
                result.FailedComponents.Add(failure);
                result.Omissions.Add("this." + failure.Name + " = new " + failure.TypeName + "()"
                    + (failure.SkippedStatements == 0 ? "" : "; " + failure.SkippedStatements + " statement(s) using it not applied")
                    + "  [" + failure.ExceptionType + ": " + failure.Message + "]");
            }
            foreach (var placeholder in placeholders) result.Placeholders[placeholder.Key] = placeholder.Value;
            result.Omissions.AddRange(omissions);
            return result;
        }

        /// <summary>Construct one field-backed component, shared by the strict and the partial replay. Returns a hard
        /// failure reason, or null with <paramref name="thrown"/> set when the component's own construction threw.</summary>
        private static string? ConstructComponent(IrConstructComponent c, Dictionary<string, object> inst, IIrHost host,
            bool alreadyFailed, out Exception? thrown, out Type? type)
        {
            thrown = null;
            type = null;
            if (inst.ContainsKey(c.Name) || alreadyFailed) return "duplicate component name " + c.Name;
            var t = host.ResolveType(c.TypeName);
            if (t == null) return "unresolved type " + c.TypeName;
            if (!typeof(IComponent).IsAssignableFrom(t)) return c.TypeName + " is not an IComponent";
            type = t;
            object created;
            try { created = host.CreateComponent(t, c.Name, c.WithComponentsContainer); }
            catch (Exception ex)
            {
                thrown = ex;
                return null;
            }
            inst[c.Name] = created ?? throw new InvalidOperationException("host returned null component for " + c.Name);
            return null;
        }

        /// <summary>The properties a placeholder takes from the source: where the failed control is and how it is laid
        /// out, nothing that belongs to the failed type itself.</summary>
        private static readonly HashSet<string> PlaceholderProperties = new HashSet<string>(StringComparer.Ordinal)
        {
            "Location", "Size", "Dock", "Anchor", "Margin", "MinimumSize", "MaximumSize", "Name", "TabIndex", "Visible",
        };

        /// <summary>Apply a statement that uses a failed component to its placeholder, when it is one a placeholder can
        /// honestly take: attaching it (or a child of it) to a parent, or one of its layout properties. False = the
        /// statement is not applied.</summary>
        private static bool ApplyToPlaceholder(IrStatement stmt, Dictionary<string, object> inst,
            Dictionary<string, IrPlaceholderControl> placeholders, Dictionary<string, IrFailedComponent> failed,
            List<object> beganInit, Dictionary<string, TreeNode> treeNodes, IIrHost host, HashSet<string> inheritedOverrideNames)
        {
            switch (stmt)
            {
                case IrAddControl a:
                    {
                        bool failedParent = !a.ParentIsRoot && failed.ContainsKey(a.ParentName);
                        if (failedParent && (a.ParentPath.Count != 0 || !placeholders.ContainsKey(a.ParentName))) return false;
                        if (failed.ContainsKey(a.ChildName) && !placeholders.ContainsKey(a.ChildName)) return false;
                        try
                        {
                            return ExecuteStatement(a, WithPlaceholders(inst, placeholders), beganInit, treeNodes, host, inheritedOverrideNames) == null;
                        }
                        catch (ArgumentException)
                        {
                            // A parent that takes only children of its own kind refuses a stand-in before adding it
                            // (a TabControl takes tab pages; a tab page goes only into a TabControl). That statement
                            // is not applied; the placeholder left without a parent is named after the replay.
                            return false;
                        }
                    }
                case IrSetProperty p when !p.TargetIsRoot && placeholders.ContainsKey(p.TargetName)
                        && p.PropertyPath.Count == 1 && PlaceholderProperties.Contains(p.PropertyPath[0])
                        && FirstFailedReference(p.Value, failed) == null && IrValidate.WitnessedValuesInPlainPositions(p)
                        && p.Value is not (IrBuildWitnessedCtor or IrArray):
                    return ExecuteStatement(p, WithPlaceholders(inst, placeholders), beganInit, treeNodes, host, inheritedOverrideNames) == null;
                case IrApplyResources ar when !ar.TargetIsRoot && placeholders.ContainsKey(ar.TargetName):
                    // A localized form keeps the failed control's Location and Size in its .resx. They reach the
                    // stand-in through the same safe resolver as everywhere else, onto the engine's own control.
                    return ExecuteStatement(ar, WithPlaceholders(inst, placeholders), beganInit, treeNodes, host, inheritedOverrideNames) == null;
                default:
                    return false;
            }
        }

        private static Dictionary<string, object> WithPlaceholders(Dictionary<string, object> inst,
            Dictionary<string, IrPlaceholderControl> placeholders)
        {
            var view = new Dictionary<string, object>(inst, StringComparer.Ordinal);
            foreach (var placeholder in placeholders) view[placeholder.Key] = placeholder.Value;
            return view;
        }

        /// <summary>The first failed component a statement names, as its receiver, parent, child, provider or in a value.</summary>
        private static string? FirstFailedReference(IrStatement stmt, Dictionary<string, IrFailedComponent> failed)
        {
            string? Named(bool isRoot, string name) => !isRoot && failed.ContainsKey(name) ? name : null;
            switch (stmt)
            {
                case IrSetProperty p: return Named(p.TargetIsRoot, p.TargetName) ?? FirstFailedReference(p.Value, failed);
                case IrAddControl a: return Named(a.ParentIsRoot, a.ParentName) ?? Named(false, a.ChildName);
                case IrAddCollectionItem it: return Named(it.TargetIsRoot, it.TargetName) ?? FirstFailedReference(it.Item, failed);
                case IrSetExtender x:
                    return Named(false, x.ProviderName) ?? Named(x.TargetIsRoot, x.TargetName) ?? FirstFailedReference(x.Value, failed);
                case IrApplyResources ar: return Named(ar.TargetIsRoot, ar.TargetName);
                case IrBeginInit b: return Named(false, b.TargetName);
                case IrEndInit e: return Named(false, e.TargetName);
                case IrLayoutCall l: return Named(l.TargetIsRoot, l.TargetName);
                case IrWireEvent w: return Named(w.TargetIsRoot, w.TargetName);
                case IrSetTreeNodeProp tp: return FirstFailedReference(tp.Value, failed);
                case IrAddTreeNodes ta: return Named(ta.TargetIsRoot, ta.TargetName);
                default: return null;
            }
        }

        private static string? FirstFailedReference(IrValue? value, Dictionary<string, IrFailedComponent> failed)
        {
            switch (value)
            {
                case IrComponentRef r: return !r.IsRoot && failed.ContainsKey(r.Name) ? r.Name : null;
                case IrCast c: return FirstFailedReference(c.Inner, failed);
                case IrArray a: return a.Items.Select(item => FirstFailedReference(item, failed)).FirstOrDefault(name => name != null);
                case IrKnownCtor k: return k.Args.Select(arg => FirstFailedReference(arg, failed)).FirstOrDefault(name => name != null);
                case IrStaticFactory f: return f.Args.Select(arg => FirstFailedReference(arg, failed)).FirstOrDefault(name => name != null);
                default: return null;
            }
        }

        /// <summary>A statement that was not applied but would have changed a component that DID build — its receiver,
        /// or the healthy child it attaches — shaped like its source so the diagnostics list can name it. Null for a
        /// statement about the failed component alone, which is counted on that component's own line.</summary>
        private static string? ShapeAffectingHealthy(IrStatement stmt, Dictionary<string, IrFailedComponent> failed)
        {
            string Receiver(bool isRoot, string name) => isRoot ? "this" : "this." + name;
            bool Healthy(bool isRoot, string name) => isRoot || !failed.ContainsKey(name);
            string Path(List<string> hops) => hops.Count == 0 ? "" : "." + string.Join(".", hops);
            switch (stmt)
            {
                case IrSetProperty p when Healthy(p.TargetIsRoot, p.TargetName):
                    return Receiver(p.TargetIsRoot, p.TargetName) + Path(p.PropertyPath) + " = " + ValueShape(p.Value);
                case IrAddCollectionItem it when Healthy(it.TargetIsRoot, it.TargetName):
                    return Receiver(it.TargetIsRoot, it.TargetName) + Path(it.PropertyPath) + ".Add(" + ValueShape(it.Item) + ")";
                case IrSetExtender x when Healthy(false, x.ProviderName) && Healthy(x.TargetIsRoot, x.TargetName):
                    return "this." + x.ProviderName + ".Set" + x.PropertyName + "(" + Receiver(x.TargetIsRoot, x.TargetName)
                        + ", " + ValueShape(x.Value) + ")";
                case IrAddControl a when Healthy(a.ParentIsRoot, a.ParentName) || Healthy(false, a.ChildName):
                    return Receiver(a.ParentIsRoot, a.ParentName) + Path(a.ParentPath) + ".Controls.Add(this." + a.ChildName + ")";
                default:
                    return null;
            }
        }

        private static string ValueShape(IrValue? value)
        {
            switch (value)
            {
                case IrComponentRef r: return r.IsRoot ? "this" : "this." + r.Name;
                case IrCast c: return "(" + c.TargetTypeName + ")" + ValueShape(c.Inner);
                case IrArray a: return "new " + a.ElementTypeName + "[] { " + string.Join(", ", a.Items.Select(ValueShape)) + " }";
                case IrBuildWitnessedCtor w: return "new " + w.TypeName + "(...)";
                default: return "...";
            }
        }

        /// <summary>
        /// Whether every <see cref="IrBuildWitnessedCtor"/> of <paramref name="candidate"/> — all its statements, every
        /// element of every array — is a construction the host's witness admits. Decided before any of it runs: types
        /// are resolved and checked, the constant arguments materialized, and the witness asked without constructing.
        /// A candidate is put back into a document only when this holds, so a source statement is replayed whole or
        /// stays the gap it was; nothing of a refused one — no receiver getter, no constructor — has run.
        /// </summary>
        /// <param name="namespaceContext">The document's namespace context: a dotted name that one of these namespaces
        /// also makes into another type is ambiguous in C#'s eyes and refused.</param>
        /// <param name="designedType">The compiled designed type: an enum-shaped argument whose first name is one of its
        /// members (a field, a property, a nested type) is that member in C#, not the enum, and is refused.</param>
        public static bool AuthorizeWitnessCandidate(IrWitnessCandidate candidate, IIrHost host,
            IReadOnlyList<string> namespaceContext, Type? designedType, out string reason)
        {
            reason = "";
            if (host is not IIrConstructionWitness witness) { reason = "no build witness"; return false; }
            // C# binds a dotted name inside a namespace relative to it first; a name another context namespace also
            // turns into a type is not provably the one resolved here.
            string? Ambiguous(string name, Type resolved)
            {
                var parts = name.Split('.');
                foreach (var ns in namespaceContext ?? Array.Empty<string>())
                {
                    if (string.IsNullOrEmpty(ns)) continue;
                    var other = host.ResolveType(ns + "." + name);
                    if (other != null && other != resolved) return name + " may name " + other.FullName + " in this file";
                    // A type of that namespace named like a leading part of the name takes that part: `Vendor.Kind.One`
                    // inside a namespace with a type `Vendor` reads its member `Kind`.
                    for (int length = 1; length < parts.Length; length++)
                    {
                        var prefix = host.ResolveType(ns + "." + string.Join(".", parts, 0, length));
                        if (prefix != null) return name + " may start with the type " + prefix.FullName + " in this file";
                    }
                }
                return null;
            }
            // Simple-name lookup finds members before any namespace type: those of the form and of every type enclosing
            // it, including nested types declared in their base types. `Kind.One` with such a member `Kind` reads it.
            string? Member(string name)
            {
                if (designedType == null) return null;
                int dot = name.IndexOf('.');
                string first = dot < 0 ? name : name.Substring(0, dot);
                const BindingFlags all = BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public
                    | BindingFlags.NonPublic | BindingFlags.FlattenHierarchy;
                for (Type? scope = designedType; scope != null; scope = scope.DeclaringType)
                {
                    if (scope.GetMember(first, MemberTypes.All, all).Length != 0) return first + " is a member of " + scope.FullName;
                    for (Type? inherited = scope.BaseType; inherited != null; inherited = inherited.BaseType)
                        if (inherited.GetNestedType(first, BindingFlags.Public | BindingFlags.NonPublic) != null)
                            return first + " is a type nested in " + inherited.FullName;
                }
                return null;
            }
            // Each construction with the array element type it goes into, when it is an element: the value reaches its
            // use unconverted (IrValidate.WitnessedValuesInPlainPositions), and an element only into an array that holds
            // it as it is.
            var constructions = new List<KeyValuePair<IrBuildWitnessedCtor, string?>>();
            foreach (var stmt in candidate?.Statements ?? new List<IrStatement>())
            {
                if (!IrValidate.WitnessedValuesInPlainPositions(stmt)) { reason = "a witnessed construction in an unsupported position"; return false; }
                IrValue? value = stmt switch { IrSetProperty p => p.Value, IrAddCollectionItem item => item.Item, _ => null };
                if (value is IrBuildWitnessedCtor direct) constructions.Add(new KeyValuePair<IrBuildWitnessedCtor, string?>(direct, null));
                else if (value is IrArray array)
                    foreach (var element in array.Items.OfType<IrBuildWitnessedCtor>())
                        constructions.Add(new KeyValuePair<IrBuildWitnessedCtor, string?>(element, array.ElementTypeName));
            }
            if (constructions.Count == 0) { reason = "no build-witnessed construction"; return false; }
            var none = new Dictionary<string, object>(StringComparer.Ordinal);
            foreach (var entry in constructions)
            {
                var w = entry.Key;
                try
                {
                    var type = host.ResolveType(w.TypeName);
                    if (type == null) { reason = "unresolved type " + w.TypeName; return false; }
                    var refusal = WitnessableValueTypeRefusal(type);
                    if (refusal != null) { reason = "construction not allowed: " + w.TypeName + " (" + refusal + ")"; return false; }
                    var unbound = Ambiguous(w.TypeName, type) ?? Member(w.TypeName);
                    if (unbound != null) { reason = unbound; return false; }
                    foreach (var en in w.Args.OfType<IrEnum>())
                    {
                        var enumType = host.ResolveType(en.EnumTypeName);
                        if (enumType == null) { reason = "unresolved enum type " + en.EnumTypeName; return false; }
                        var enumUnbound = Ambiguous(en.EnumTypeName, enumType) ?? Member(en.EnumTypeName);
                        if (enumUnbound != null) { reason = enumUnbound; return false; }
                    }
                    if (entry.Value != null)
                    {
                        var elementType = host.ResolveType(entry.Value);
                        if (elementType == null || !elementType.IsAssignableFrom(type))
                        { reason = w.TypeName + " is not an element of " + entry.Value + " without a conversion"; return false; }
                    }
                    var args = new object?[w.Args.Count];
                    for (int i = 0; i < w.Args.Count; i++)
                    {
                        if (w.Args[i] is not (IrNull or IrBool or IrChar or IrString or IrNumber or IrEnum) || !IrValidate.IsExactWitnessConstant(w.Args[i]))
                        { reason = "a witnessed construction takes exact constant arguments only"; return false; }
                        if (!TryMaterialize(w.Args[i], typeof(object), none, host, out args[i], out var aerr))
                        { reason = aerr ?? "argument not materialized"; return false; }
                    }
                    if (!witness.CanConstruct(type, args, out reason)) return false;
                }
                catch (Exception ex)
                {
                    reason = ex.GetType().Name + ": " + ex.Message;
                    return false;
                }
            }
            return true;
        }


        /// <summary>Merge the two identity sources into one origin table. Every IR-created
        /// name is DeclaredInCurrentSource; the root is Root; every OTHER field-backed IComponent reachable by
        /// reflection over the runtime root type and its bases (the compiled base's own components, e.g. an inherited
        /// button) is surfaced as Inherited under its field name — so Snapshot/selection see it, but the caller marks
        /// it read-only. Fail-closed on a HIDING collision: a current-source name that reflection also finds bound to
        /// a DIFFERENT instance is ambiguous and must not be guessed.</summary>
        private static string? BuildIdentityModel(IrDocument doc, object root, Dictionary<string, object> instances,
            Dictionary<string, IrOrigin> origins, HashSet<string> inheritedOverrideNames, ICollection<string> failedNames)
        {
            origins[""] = IrOrigin.Root;
            foreach (var name in instances.Keys)
                if (name.Length != 0) origins[name] = inheritedOverrideNames.Contains(name)
                    ? IrOrigin.Inherited : IrOrigin.DeclaredInCurrentSource;

            // reflect field-backed IComponents across the runtime root type and its bases (mirrors the compiled
            // engine's field-name map — the analogue of Site.Name for inherited components).
            for (var t = root.GetType(); t != null && t != typeof(object); t = t.BaseType)
            {
                FieldInfo[] fields;
                // GetFields() itself can throw for a pathological vendor type (a custom reflection provider), not just
                // the per-field type resolution below. Skip that type's fields and keep going: interpretation still
                // succeeds for the resolvable types, whereas letting it escape would force a needless compiled fallback
                // (the current-source components the user edits come from the statement replay, not this reflection).
                try { fields = t.GetFields(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly); }
                catch { continue; }
                foreach (var fi in fields)
                {
                    // Reading fi.FieldType forces type resolution, which can throw TypeLoadException/FileNotFoundException
                    // for a field whose type lives in an assembly not loadable in this domain. That must degrade to
                    // "skip this field", not abort the whole identity model (which would escape Execute unguarded).
                    try
                    {
                        if (!typeof(IComponent).IsAssignableFrom(fi.FieldType)) continue;
                        object? val;
                        try { val = fi.GetValue(root); } catch { continue; }
                        if (val == null) continue;
                        string fname = fi.Name;
                        if (failedNames.Contains(fname)) return "ambiguous identity: '" + fname + "' hides an inherited component";
                        if (instances.TryGetValue(fname, out var existing))
                        {
                            // same name already known: only a DIFFERENT instance is a real hiding collision.
                            if (!ReferenceEquals(existing, val)) return "ambiguous identity: '" + fname + "' hides an inherited component";
                            continue; // same instance — already recorded as current-source (a field the IR set)
                        }
                        if (origins.ContainsKey(fname)) continue; // shadowed by a derived field of the same name — keep the derived one
                        instances[fname] = val;
                        origins[fname] = IrOrigin.Inherited;
                    }
                    catch { continue; } // unresolvable field type → skip, don't abort identity
                }
            }
            return null;
        }

        /// <summary>Seed only uniquely field-backed, accessible framework controls from the compiled base so the IR can
        /// replay the narrow derived-source override assignments emitted by the 1.14 writer. Names constructed by the
        /// current document win and are never seeded. All non-property/unsupported mutations remain refused below.</summary>
        private static string? SeedInheritedOverrideInstances(IrDocument doc, object root,
            Dictionary<string, object> instances, HashSet<string> inheritedNames)
        {
            var declared = new HashSet<string>(doc.Statements.OfType<IrConstructComponent>().Select(c => c.Name), StringComparer.Ordinal);
            var byInstance = new Dictionary<object, List<FieldInfo>>(IrReferenceEqualityComparer.Instance);
            // Only source-declared user/vendor hierarchy fields are identities. Framework base classes keep private
            // runtime references (for example the active-control cache) that can alias a real designer field.
            for (Type? type = root.GetType(); type != null && type != typeof(Form) && type != typeof(UserControl)
                 && type != typeof(Control) && type != typeof(Component) && type != typeof(object); type = type.BaseType)
            {
                FieldInfo[] fields;
                try { fields = type.GetFields(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly); }
                catch { continue; }
                foreach (var field in fields)
                {
                    try
                    {
                        if (!typeof(IComponent).IsAssignableFrom(field.FieldType)) continue;
                        if (field.GetValue(root) is not IComponent component) continue;
                        if (!byInstance.TryGetValue(component, out var aliases)) byInstance[component] = aliases = new List<FieldInfo>();
                        aliases.Add(field);
                    }
                    catch { }
                }
            }

            var candidates = new List<(string name, object value)>();
            foreach (var entry in byInstance)
            {
                if (entry.Value.Count != 1 || entry.Key is not Control control) continue;
                var field = entry.Value[0];
                // The interpreter is deliberately given an instance of the immediate BASE type, not an
                // instance of the source-only derived type (see Execute's contract above). Consequently a
                // field declared on root.GetType() is inherited from the logical designer document and must
                // remain eligible. Current-document members are identified by the IR construction set instead.
                if (field.IsStatic || declared.Contains(field.Name)) continue;
                bool accessible = field.IsPublic || field.IsFamily || field.IsFamilyOrAssembly;
                if (!accessible || !IsValidInheritedIdentifier(field.Name)
                    || !typeof(Control).IsAssignableFrom(field.FieldType)
                    || !field.FieldType.IsInstanceOfType(control)
                    || !DesignerAllowlists.IsTrustedFrameworkType(field.FieldType)
                    || !DesignerAllowlists.IsTrustedFrameworkType(control.GetType())) continue;
                candidates.Add((field.Name, entry.Key));
            }

            foreach (var group in candidates.GroupBy(candidate => candidate.name, StringComparer.Ordinal))
            {
                if (group.Count() != 1) continue;
                var candidate = group.Single();
                if (instances.ContainsKey(candidate.name)) return "ambiguous inherited override identity: " + candidate.name;
                instances[candidate.name] = candidate.value;
                inheritedNames.Add(candidate.name);
            }
            return null;
        }

        private static IrExecutionResult Abort(List<object> beganInit, string reason)
        {
            var r = IrExecutionResult.Fail(reason);
            foreach (var o in beganInit) r.PendingInit.Add(o);
            return r;
        }

        // -------------------------------------------------------- statements ----------------------------------------

        // Side-effect-free TreeNode properties the executor will set — re-gated here (the parser also gates), so a
        // forged IR can't set an arbitrary/side-effecting property on a node.
        private static readonly HashSet<string> TreeNodeSettableProps = new HashSet<string>(StringComparer.Ordinal)
        {
            "Name", "Text", "ToolTipText", "ImageKey", "SelectedImageKey", "StateImageKey",
            "ImageIndex", "SelectedImageIndex", "StateImageIndex", "BackColor", "ForeColor", "Checked",
        };

        private static string? ExecuteStatement(IrStatement stmt, Dictionary<string, object> inst, List<object> beganInit,
            Dictionary<string, TreeNode> treeNodes, IIrHost host, HashSet<string> inheritedOverrideNames)
        {
            switch (stmt)
            {
                case IrConstructComponent c:
                    {
                        var cerr = ConstructComponent(c, inst, host, false, out var thrown, out _);
                        if (cerr != null || thrown == null) return cerr;
                        // A vendor control gated by a design-time license (LicenseException) is a distinct, expected
                        // outcome — not a crash. Prefix it so the classifier reports `licenseRequired`, mirroring the
                        // compiled engine's exit-code-3 handling. The compiled fallback hits the same wall,
                        // so the form is honestly un-previewable, but the REASON is precise.
                        if (IsLicenseException(thrown)) return "LICENSE:" + c.TypeName + " requires a design-time license (" + thrown.GetType().Name + ")";
                        return "cannot construct " + c.TypeName + " (" + thrown.GetType().Name + ")";
                    }

                case IrSetProperty p:
                    {
                        if (!TryTarget(p.TargetIsRoot, p.TargetName, inst, out var target, out var terr)) return terr;
                        if (!p.TargetIsRoot && inheritedOverrideNames.Contains(p.TargetName))
                        {
                            if (p.PropertyPath.Count != 1)
                                return "nested inherited override properties are not supported: " + p.TargetName;
                            string inheritedProperty = p.PropertyPath[0];
                            var inheritedDescriptor = TypeDescriptor.GetProperties(target)[inheritedProperty];
                            string inheritedType = inheritedDescriptor?.PropertyType.FullName ?? "";
                            if (inheritedDescriptor == null || inheritedDescriptor.IsReadOnly
                                || !IsSupportedInheritedProperty(inheritedProperty, inheritedType))
                                return "property is not eligible for an inherited override: " + p.TargetName + "." + inheritedProperty;
                            if (IsInheritedGeometryProperty(inheritedProperty)
                                && (target is not Control inheritedControl || !InheritedGeometryAllowed(inheritedControl)))
                                return "inherited geometry is managed by Dock, AutoSize, or a layout-panel parent: " + p.TargetName;
                        }
                        // walk to the owner of the final property (all but the last hop must be readable properties)
                        for (int i = 0; i < p.PropertyPath.Count - 1; i++)
                        {
                            var mid = TypeDescriptor.GetProperties(target)[p.PropertyPath[i]];
                            if (mid == null) return "no property " + p.PropertyPath[i] + " on " + target.GetType().Name;
                            target = mid.GetValue(target);
                            if (target == null) return "null intermediate at " + p.PropertyPath[i];
                        }
                        string leaf = p.PropertyPath[p.PropertyPath.Count - 1];
                        var pd = TypeDescriptor.GetProperties(target)[leaf];
                        if (pd == null) return "no property " + leaf + " on " + target.GetType().Name;
                        if (!TryMaterialize(p.Value, pd.PropertyType, inst, host, out var val, out var verr)) return verr;
                        if (pd.IsReadOnly) return "property " + leaf + " is read-only";
                        pd.SetValue(target, val);
                        return null;
                    }

                case IrAddControl a:
                    {
                        if ((!a.ParentIsRoot && inheritedOverrideNames.Contains(a.ParentName))
                            || inheritedOverrideNames.Contains(a.ChildName))
                            return "structural mutation of an inherited control is not supported";
                        if (!TryTarget(a.ParentIsRoot, a.ParentName, inst, out var parentObj, out var perr)) return perr;
                        foreach (var hop in a.ParentPath)
                        {
                            var mid = TypeDescriptor.GetProperties(parentObj)[hop];
                            if (mid == null) return "no property " + hop + " on " + parentObj.GetType().Name;
                            parentObj = mid.GetValue(parentObj);
                            if (parentObj == null) return "null container at " + hop;
                        }
                        if (parentObj is not Control parent) return "AddControl parent is not a Control";
                        if (!inst.TryGetValue(a.ChildName, out var childObj)) return "unknown child " + a.ChildName;
                        if (childObj is not Control child) return a.ChildName + " is not a Control";
                        if (parent is TableLayoutPanel tlp && a.Column >= 0 && a.Row >= 0)
                            tlp.Controls.Add(child, a.Column, a.Row);
                        else
                            parent.Controls.Add(child);
                        return null;
                    }

                case IrAddCollectionItem it:
                    {
                        if (!it.TargetIsRoot && inheritedOverrideNames.Contains(it.TargetName))
                            return "collection mutation of an inherited control is not supported";
                        if (!TryTarget(it.TargetIsRoot, it.TargetName, inst, out var owner, out var oerr)) return oerr;
                        for (int i = 0; i < it.PropertyPath.Count; i++)
                        {
                            var mid = TypeDescriptor.GetProperties(owner)[it.PropertyPath[i]];
                            if (mid == null) return "no property " + it.PropertyPath[i] + " on " + owner.GetType().Name;
                            owner = mid.GetValue(owner);
                            if (owner == null) return "null collection at " + it.PropertyPath[i];
                        }
                        // element type: try the collection's indexer type for materialization context, else object
                        Type elemType = CollectionElementType(owner.GetType());
                        if (!TryMaterialize(it.Item, elemType, inst, host, out var item, out var ierr)) return ierr;
                        if (owner is IList list) { list.Add(item); return null; }
                        // A designer collection that is NOT IList. Vendor collections routinely are: measured on a real
                        // project, PGMUI/DevExpress's TreeListColumnCollection implements only ICollection + IEnumerable
                        // and a TYPED Add(TreeListColumn). Refusing those dropped the whole form to the compiled
                        // fallback — the one path that constructs the user's real form and runs their code — over a
                        // collection this IR already models. Adding through the typed method is the same operation.
                        var add = SingleArgAdd(owner.GetType(), item);
                        if (add == null) return "collection target is neither an IList nor has an Add(item) method";
                        add.Invoke(owner, new[] { item });
                        return null;
                    }

                case IrLayoutCall l:
                    {
                        if (!l.TargetIsRoot && inheritedOverrideNames.Contains(l.TargetName))
                            return "layout call on an inherited control is not supported";
                        if (!TryTarget(l.TargetIsRoot, l.TargetName, inst, out var lt, out var lterr)) return lterr;
                        var lperr = WalkInitPath(ref lt, l.TargetIsRoot ? "this" : l.TargetName, l.TargetPath, "layout call");
                        if (lperr != null) return lperr;
                        if (lt is not Control lc) return InitTargetName(l.TargetIsRoot ? "this" : l.TargetName, l.TargetPath) + " is not a Control";
                        string lname = l.Op == IrLayoutOp.Suspend ? "SuspendLayout" : l.Op == IrLayoutOp.Resume ? "ResumeLayout" : "PerformLayout";
                        // The SOURCE arity picks the overload: `ResumeLayout()` and `ResumeLayout(bool)` are distinct
                        // declarations, and a type that hides only one of them must not be replayed through the other.
                        var lsig = l.Op == IrLayoutOp.Resume && l.HasArg ? new[] { typeof(bool) } : Type.EmptyTypes;
                        var lm = LayoutMember(lc.GetType(), lname, lsig);
                        if (lm == null) return lname + " on " + lc.GetType().Name + " does not resolve to a Control layout member";
                        // A receiver reached through hops has an unknown static type, so a vendor member HIDING the
                        // framework one cannot be shown to be what C# bound — accept only the framework member there.
                        if (l.TargetPath.Count > 0 && lm.DeclaringType != typeof(Control))
                            return lname + " through " + InitTargetName(l.TargetIsRoot ? "this" : l.TargetName, l.TargetPath) + " resolves to a hiding member whose binding is unprovable";
                        lm.Invoke(lc, l.Op == IrLayoutOp.Resume && l.HasArg ? new object[] { l.Arg } : Array.Empty<object>());
                        return null;
                    }

                case IrBeginInit b:
                    {
                        if (inheritedOverrideNames.Contains(b.TargetName)) return "BeginInit on an inherited control is not supported";
                        if (!inst.TryGetValue(b.TargetName, out var o)) return "BeginInit unknown target " + b.TargetName;
                        var berr = WalkInitPath(ref o, b.TargetName, b.TargetPath, "BeginInit");
                        if (berr != null) return berr;
                        if (o is not ISupportInitialize si) return InitTargetName(b.TargetName, b.TargetPath) + " is not ISupportInitialize";
                        si.BeginInit();
                        beganInit.Add(o);
                        return null;
                    }
                case IrEndInit e:
                    {
                        if (inheritedOverrideNames.Contains(e.TargetName)) return "EndInit on an inherited control is not supported";
                        if (!inst.TryGetValue(e.TargetName, out var o)) return "EndInit unknown target " + e.TargetName;
                        var eerr = WalkInitPath(ref o, e.TargetName, e.TargetPath, "EndInit");
                        if (eerr != null) return eerr;
                        if (o is not ISupportInitialize si) return InitTargetName(e.TargetName, e.TargetPath) + " is not ISupportInitialize";
                        // EndInit must match a pending BeginInit on the SAME instance (LIFO not required by WinForms, but
                        // the target must actually be open) — fail closed on a stray EndInit. A sub-object reached through
                        // TargetPath must therefore be the SAME instance its BeginInit saw: a hop whose getter hands out a
                        // fresh object each read is refused here instead of silently leaving the first one half-open.
                        // Matched by REFERENCE, never by Equals: List.Remove would consult the target's own (vendor,
                        // overridable) equality, so a wrapper that declares two distinct instances equal could close the
                        // bracket on one object while the other stays half-initialized — and the comparison itself would
                        // run vendor code the designer statement never invokes.
                        if (!RemoveByReference(beganInit, o)) return "EndInit without matching BeginInit for " + InitTargetName(e.TargetName, e.TargetPath);
                        si.EndInit();
                        return null;
                    }

                case IrConstructTreeNode tn:
                    {
                        if (treeNodes.ContainsKey(tn.LocalName)) return "duplicate tree-node local " + tn.LocalName;
                        var node = new TreeNode();
                        if (tn.Text != null) node.Text = tn.Text;
                        foreach (var child in tn.ChildLocalNames)
                        {
                            if (!treeNodes.TryGetValue(child, out var cn)) return "unknown tree-node child " + child;
                            node.Nodes.Add(cn); // children are constructed before their parent (VS bottom-up order)
                        }
                        treeNodes[tn.LocalName] = node;
                        return null;
                    }
                case IrSetTreeNodeProp tp:
                    {
                        if (!treeNodes.TryGetValue(tp.LocalName, out var node)) return "unknown tree-node " + tp.LocalName;
                        if (!TreeNodeSettableProps.Contains(tp.PropName)) return "tree-node property not allowed: " + tp.PropName;
                        var pd = TypeDescriptor.GetProperties(node)[tp.PropName];
                        if (pd == null) return "no property " + tp.PropName + " on TreeNode";
                        if (!TryMaterialize(tp.Value, pd.PropertyType, inst, host, out var val, out var verr)) return verr;
                        pd.SetValue(node, Coerce(val, pd.PropertyType));
                        return null;
                    }
                case IrAddTreeNodes ta:
                    {
                        if (!ta.TargetIsRoot && inheritedOverrideNames.Contains(ta.TargetName))
                            return "tree mutation of an inherited control is not supported";
                        if (!TryTarget(ta.TargetIsRoot, ta.TargetName, inst, out var owner, out var oerr)) return oerr;
                        foreach (var hop in ta.PropertyPath)
                        {
                            var pi = owner.GetType().GetProperty(hop, BindingFlags.Public | BindingFlags.Instance);
                            if (pi == null) return "no property " + hop + " on " + owner.GetType().Name;
                            owner = pi.GetValue(owner);
                            if (owner == null) return "null tree-node collection at " + hop;
                        }
                        if (owner is not TreeNodeCollection coll) return "tree-node add target is not a TreeNodeCollection";
                        foreach (var name in ta.NodeLocalNames)
                        {
                            if (!treeNodes.TryGetValue(name, out var node)) return "unknown tree-node " + name;
                            coll.Add(node);
                        }
                        return null;
                    }

                case IrWireEvent:
                    return null; // inert: the design surface never wires source handlers (VS model)

                case IrSetExtender x:
                    {
                        if (inheritedOverrideNames.Contains(x.ProviderName)
                            || (!x.TargetIsRoot && inheritedOverrideNames.Contains(x.TargetName)))
                            return "extender mutation involving an inherited control is not supported";
                        if (!inst.TryGetValue(x.ProviderName, out var prov)) return "unknown extender provider " + x.ProviderName;
                        if (prov is not IExtenderProvider ep) return x.ProviderName + " is not an IExtenderProvider";
                        if (!TryTarget(x.TargetIsRoot, x.TargetName, inst, out var tgt, out var terr)) return terr;
                        // The provider must ADVERTISE this as an extender property via [ProvideProperty] AND accept the
                        // target via CanExtend — otherwise merely implementing IExtenderProvider would expose EVERY public
                        // 2-arg Set* method (e.g. a side-effecting SetCommand) to hostile source. Set<Prop> is
                        // then validated as a real 2-arg setter before invoking (never "any method starting with Set").
                        bool advertised = prov.GetType()
                            .GetCustomAttributes(typeof(ProvidePropertyAttribute), true)
                            .OfType<ProvidePropertyAttribute>()
                            .Any(a => a.PropertyName == x.PropertyName);
                        if (!advertised) return "Set" + x.PropertyName + " is not an advertised extender property on " + x.ProviderName;
                        if (!ep.CanExtend(tgt)) return x.ProviderName + " cannot extend the given target";
                        var mi = prov.GetType().GetMethod("Set" + x.PropertyName, BindingFlags.Public | BindingFlags.Instance);
                        if (mi == null) return "no extender setter Set" + x.PropertyName + " on " + x.ProviderName;
                        var ps = mi.GetParameters();
                        if (ps.Length != 2) return "Set" + x.PropertyName + " is not a 2-arg extender setter";
                        if (!ps[0].ParameterType.IsInstanceOfType(tgt)) return "extender target is not a " + ps[0].ParameterType.Name;
                        if (!TryMaterialize(x.Value, ps[1].ParameterType, inst, host, out var xval, out var xerr)) return xerr;
                        mi.Invoke(prov, new[] { tgt, Coerce(xval, ps[1].ParameterType) });
                        return null;
                    }

                case IrApplyResources ar:
                    {
                        if (!ar.TargetIsRoot && inheritedOverrideNames.Contains(ar.TargetName))
                            return "localized inherited overrides are not supported";
                        if (!TryTarget(ar.TargetIsRoot, ar.TargetName, inst, out var target, out var terr)) return terr;
                        if (!host.ApplyResources(target, ar.ResourceKey, out var aerr))
                            return aerr ?? ("ApplyResources failed for '" + ar.ResourceKey + "'");
                        return null;
                    }

                default:
                    return "unknown statement " + stmt.GetType().Name; // unreachable while IrValidate.Closed is exact
            }
        }

        private static bool InheritedGeometryAllowed(Control control) =>
            control.Parent is not TableLayoutPanel
            && control.Parent is not FlowLayoutPanel
            && control.Dock == DockStyle.None
            && !control.AutoSize;

        // Reflection returns a field's metadata name without the source escape (for example @class -> class).
        // The 1.14 writer cannot safely address a reserved keyword through its deliberately narrow canonical
        // `this.<field>.<property>` grammar, so the replay side must not advertise that identity either.
        private static readonly HashSet<string> CSharpReservedKeywords = new HashSet<string>(StringComparer.Ordinal)
        {
            "abstract", "as", "base", "bool", "break", "byte", "case", "catch", "char", "checked",
            "class", "const", "continue", "decimal", "default", "delegate", "do", "double", "else", "enum",
            "event", "explicit", "extern", "false", "finally", "fixed", "float", "for", "foreach", "goto",
            "if", "implicit", "in", "int", "interface", "internal", "is", "lock", "long", "namespace", "new",
            "null", "object", "operator", "out", "override", "params", "private", "protected", "public",
            "readonly", "ref", "return", "sbyte", "sealed", "short", "sizeof", "stackalloc", "static",
            "string", "struct", "switch", "this", "throw", "true", "try", "typeof", "uint", "ulong",
            "unchecked", "unsafe", "ushort", "using", "virtual", "void", "volatile", "while",
        };

        private static bool IsValidInheritedIdentifier(string value)
        {
            if (string.IsNullOrEmpty(value)) return false;
            if (CSharpReservedKeywords.Contains(value)) return false;
            if (!((value[0] >= 'A' && value[0] <= 'Z') || (value[0] >= 'a' && value[0] <= 'z') || value[0] == '_')) return false;
            for (int i = 1; i < value.Length; i++)
                if (!((value[i] >= 'A' && value[i] <= 'Z') || (value[i] >= 'a' && value[i] <= 'z')
                    || (value[i] >= '0' && value[i] <= '9') || value[i] == '_')) return false;
            return true;
        }

        private static bool IsInheritedGeometryProperty(string propertyName) =>
            propertyName == "Location" || propertyName == "Size" || propertyName == "Bounds";

        private static bool IsSupportedInheritedProperty(string propertyName, string propertyTypeName)
        {
            string type = (propertyTypeName ?? "").Trim();
            return (propertyName == "Location" && type == "System.Drawing.Point")
                || (propertyName == "Size" && type == "System.Drawing.Size")
                || (propertyName == "Bounds" && type == "System.Drawing.Rectangle")
                || (propertyName == "Anchor" && type == "System.Windows.Forms.AnchorStyles")
                || (propertyName == "Dock" && type == "System.Windows.Forms.DockStyle")
                || (propertyName == "Text" && type == "System.String")
                || ((propertyName == "Enabled" || propertyName == "Visible") && type == "System.Boolean")
                || (propertyName == "TabIndex" && type == "System.Int32");
        }

        private sealed class IrReferenceEqualityComparer : IEqualityComparer<object>
        {
            public static readonly IrReferenceEqualityComparer Instance = new IrReferenceEqualityComparer();
            public new bool Equals(object? x, object? y) => ReferenceEquals(x, y);
            public int GetHashCode(object obj) => System.Runtime.CompilerServices.RuntimeHelpers.GetHashCode(obj);
        }

        // -------------------------------------------------------- values --------------------------------------------

        private static bool TryMaterialize(IrValue v, Type target, Dictionary<string, object> inst, IIrHost host, out object? value, out string? err)
        {
            value = null; err = null;
            switch (v)
            {
                case IrNull: value = null; return true;
                case IrBool b: value = b.Value; return true;
                case IrChar c: value = c.Value; return true;
                case IrString s: value = s.Value; return true;
                case IrNumber n:
                    return TryNumber(n, out value, out err);

                case IrComponentRef r:
                    if (r.IsRoot) { value = inst[""]; return true; }
                    if (inst.TryGetValue(r.Name, out var comp)) { value = comp; return true; }
                    err = "unknown component reference " + r.Name; return false;

                case IrEnum en:
                    {
                        var et = host.ResolveType(en.EnumTypeName);
                        if (et == null) { err = "unresolved enum type " + en.EnumTypeName; return false; }
                        if (!et.IsEnum) { err = en.EnumTypeName + " is not an enum"; return false; }
                        long acc = 0;
                        foreach (var m in en.Members)
                        {
                            if (!IsDefinedName(et, m)) { err = "no enum member " + en.EnumTypeName + "." + m; return false; }
                            acc |= Convert.ToInt64(Enum.Parse(et, m), CultureInfo.InvariantCulture);
                        }
                        value = Enum.ToObject(et, acc); return true;
                    }

                case IrStaticRead sr:
                    {
                        var rt = host.ResolveType(sr.TypeName);
                        if (rt == null) { err = "unresolved static-read type " + sr.TypeName; return false; }
                        // SECURITY re-check (child side): only allowlisted side-effect-free value sources.
                        if (!DesignerAllowlists.IsStaticReadAllowed(rt)) { err = "static read not allowed: " + sr.TypeName; return false; }
                        var pi = rt.GetProperty(sr.Member, BindingFlags.Public | BindingFlags.Static);
                        if (pi != null) { value = pi.GetValue(null); return true; }
                        var fi = rt.GetField(sr.Member, BindingFlags.Public | BindingFlags.Static);
                        if (fi != null) { value = fi.GetValue(null); return true; }
                        err = "no static member " + sr.TypeName + "." + sr.Member; return false;
                    }

                case IrStaticFactory f:
                    {
                        var ft = host.ResolveType(f.TypeName);
                        if (ft == null) { err = "unresolved factory type " + f.TypeName; return false; }
                        // SECURITY re-check: only the allowlisted pure Color factories.
                        if (!DesignerAllowlists.IsFactoryInvocationAllowed(ft, f.Method)) { err = "factory not allowed: " + f.TypeName + "." + f.Method; return false; }
                        if (DesignerAllowlists.TryGetSystemIconBitmapMember(ft, f.Method, out string iconMember))
                        {
                            if (f.Args.Count != 0) { err = "system icon bitmap factory requires zero arguments"; return false; }
                            var iconProperty = ft.GetProperty(iconMember, BindingFlags.Public | BindingFlags.Static);
                            if (iconProperty?.GetValue(null) is System.Drawing.Icon icon)
                            {
                                value = icon.ToBitmap();
                                return true;
                            }
                            err = "no system icon member " + iconMember;
                            return false;
                        }
                        if (!TryMaterializeArgs(f.Args, inst, host, out var fargs, out err)) return false;
                        var mi = ResolveStatic(ft, f.Method, fargs);
                        if (mi == null) { err = "no static overload " + f.TypeName + "." + f.Method; return false; }
                        value = mi.Invoke(null, fargs); return true;
                    }

                case IrBuildWitnessedCtor w:
                    {
                        // A candidate reaches the replay only after AuthorizeWitnessCandidate admitted every construction
                        // in it, so a refusal here means a document merged without that (or a host without the build):
                        // the statement is the gap it was, a hard failure that the classifier reports as such.
                        var wt = host.ResolveType(w.TypeName);
                        if (wt == null) { err = UnwitnessedPrefix + "unresolved type " + w.TypeName; return false; }
                        var notWitnessable = WitnessableValueTypeRefusal(wt);
                        if (notWitnessable != null) { err = UnwitnessedPrefix + "construction not allowed: " + w.TypeName + " (" + notWitnessable + ")"; return false; }
                        var wargs = new object?[w.Args.Count];
                        for (int i = 0; i < w.Args.Count; i++)
                        {
                            if (w.Args[i] is not (IrNull or IrBool or IrChar or IrString or IrNumber or IrEnum))
                            { err = UnwitnessedPrefix + "a witnessed construction takes constant arguments only"; return false; }
                            if (!TryMaterialize(w.Args[i], typeof(object), inst, host, out wargs[i], out var aerr))
                            { err = UnwitnessedPrefix + aerr; return false; }
                        }
                        if (host is not IIrConstructionWitness witness)
                        { err = UnwitnessedPrefix + w.TypeName + " is constructed only where the project's build makes the same construction"; return false; }
                        if (!witness.TryConstruct(wt, wargs, out value, out var why)) { err = UnwitnessedPrefix + why; return false; }
                        return true;
                    }

                case IrKnownCtor kc:
                    {
                        var ct = host.ResolveType(kc.TypeName);
                        if (ct == null) { err = "unresolved ctor type " + kc.TypeName; return false; }
                        // The closed CodeDom decimal form (typeof equality: a user type named System.Decimal is not it
                        // and falls to the allowlist below, which refuses it).
                        if (ct == typeof(decimal)) return TryDecimalBits(kc, out value, out err);
                        // SECURITY re-check: only allowlisted pure value-type initializers (Point/Size/Font/…).
                        if (!DesignerAllowlists.IsConstructionAllowed(ct)) { err = "construction not allowed: " + kc.TypeName; return false; }
                        if (!TryMaterializeArgs(kc.Args, inst, host, out var cargs, out err)) return false;
                        value = Activator.CreateInstance(ct, cargs); return true;
                    }

                case IrArray arr:
                    {
                        // An unresolved element type must FAIL, not silently degrade to object[] — a `new string[]{...}`
                        // whose "string" alias can't resolve would otherwise render as System.Object[].
                        var elemType = host.ResolveType(arr.ElementTypeName);
                        if (elemType == null) { err = "unresolved array element type " + arr.ElementTypeName; return false; }
                        var made = Array.CreateInstance(elemType, arr.Items.Count);
                        for (int i = 0; i < arr.Items.Count; i++)
                        {
                            if (!TryMaterialize(arr.Items[i], elemType, inst, host, out var iv, out err)) return false;
                            made.SetValue(Coerce(iv, elemType), i);
                        }
                        value = made; return true;
                    }

                case IrResourceRef rr:
                    {
                        // A REFUSED node (binary/SOAP/typed/ResXFileRef) must fall back with the precise unsafeBinaryResource
                        // reason — NEVER silently assign null, even for GetString (a refused GetString would otherwise read
                        // as empty text and report interpreted success).
                        if (host.WasResourceRefused(rr.Key))
                        {
                            err = "UNSAFE_RESOURCE: '" + rr.Key + "' is a refused binary/SOAP/file-ref resource";
                            return false;
                        }
                        // GetObject returns an object and GetString a string: what takes another type needs a cast
                        // (`this.ImeMode = resources.GetObject(…)` does not compile, whatever the entry holds).
                        var staticType = rr.IsString ? typeof(string) : typeof(object);
                        if (target != null && !target.IsAssignableFrom(staticType))
                        {
                            err = "a value of type " + staticType.Name + " does not convert to " + target.Name + " without a cast: '" + rr.Key + "'";
                            return false;
                        }
                        value = host.ResolveResource(rr.Key, rr.IsString);
                        if (value == null && !rr.IsString) { err = "resource '" + rr.Key + "' unavailable"; return false; }
                        // GetString of a present entry that is no readable string: ResourceManager throws, so no empty
                        // text is shown in its place. A missing key is null, as ResourceManager returns it.
                        if (value == null && host.HasResource(rr.Key)) { err = "resource '" + rr.Key + "' is not a readable string"; return false; }
                        // ...but only in a resource set that exists: without one (or with a broken one) the compiled form
                        // throws MissingManifestResourceException, or the project does not build.
                        if (value == null && !host.HasResourceSet) { err = "resource '" + rr.Key + "' has no resource set to come from"; return false; }
                        return true;
                    }

                case IrCast cast:
                    {
                        if (!TryMaterialize(cast.Inner, typeof(object), inst, host, out var inner, out err)) return false;
                        var ct = host.ResolveType(cast.TargetTypeName);
                        if (ct == null) { err = "unresolved cast type " + cast.TargetTypeName; return false; }
                        // The operand's static type decides the cast. A resource is an object (GetObject) or a string
                        // (GetString), and a cast gives its own type (`(object)resources.GetObject(…)` stays an object):
                        // C# casts such a value by type — an instance of the target, an unboxing to exactly its type or
                        // between an enum and its underlying type — never by converting it (`(long)resources.GetObject(…)`
                        // of a Keys entry, or `(long)(object)…` of an int, throws). A number converts as before.
                        Type? operandType = cast.Inner switch
                        {
                            IrResourceRef resource => resource.IsString ? typeof(string) : typeof(object),
                            IrCast nested => host.ResolveType(nested.TargetTypeName),
                            _ => null,
                        };
                        if (operandType != null && !operandType.IsValueType)
                        {
                            // A string converts by a cast only to a type a string is (`(Font)resources.GetString(…)` does
                            // not compile, null or not).
                            if (operandType == typeof(string) && !ct.IsAssignableFrom(typeof(string)))
                            {
                                err = "a string does not convert to " + cast.TargetTypeName;
                                return false;
                            }
                            if (!TryCastByType(inner, ct, out value))
                            {
                                err = "cast of resource value " + (inner?.GetType().Name ?? "null") + " to " + cast.TargetTypeName + " does not hold";
                                return false;
                            }
                            return true;
                        }
                        // A number converts as C#'s explicit conversion converts it: a floating or decimal value toward zero
                        // (`(int)(double)…` of 300.6 is 300, where Convert would round to 301); a value out of the target's
                        // range is refused rather than wrapped.
                        var numericTarget = Nullable.GetUnderlyingType(ct) ?? ct;
                        if (IsNumber(inner) && IsNumberType(numericTarget))
                        {
                            if (!TryNumericCast(inner!, numericTarget, out value))
                            {
                                err = "cast of " + inner!.GetType().Name + " to " + cast.TargetTypeName + " is out of range";
                                return false;
                            }
                            return true;
                        }
                        value = Coerce(inner, ct);
                        // Coerce returns the ORIGINAL value when it can't convert — for a cast that is a SILENT no-op, so
                        // fail closed unless the value is genuinely the target type. Handle the one designer cast Coerce
                        // misses: (SomeEnum)intLiteral, which must box to the enum.
                        if (value != null && !ct.IsInstanceOfType(value))
                        {
                            if (ct.IsEnum)
                            {
                                try { value = Enum.ToObject(ct, value); return true; }
                                catch { err = "cast to enum " + cast.TargetTypeName + " failed"; return false; }
                            }
                            err = "cast to " + cast.TargetTypeName + " did not convert"; return false;
                        }
                        return true;
                    }

                default:
                    err = "unmaterializable value " + v.GetType().Name; return false;
            }
        }

        /// <summary>Re-check the front-end's closed decimal form on the child side (a forged IR reaches here too): exactly
        /// one Int32 array of four Int32 numbers, nothing else materialized, then Decimal validates the bits.</summary>
        private static bool TryDecimalBits(IrKnownCtor kc, out object? value, out string? err)
        {
            value = null; err = null;
            if (kc.Args.Count != 1 || kc.Args[0] is not IrArray words || words.ElementTypeName != "System.Int32"
                || words.Items.Count != DesignerAllowlists.DecimalBitsLength)
            {
                err = "construction not allowed: System.Decimal outside new decimal(new int[] { lo, mid, hi, flags })";
                return false;
            }
            var bits = new int[words.Items.Count];
            for (int i = 0; i < bits.Length; i++)
            {
                if (words.Items[i] is not IrNumber { Kind: IrNumericKind.Int32 } n || !TryNumber(n, out var w, out err) || w is not int word)
                {
                    err ??= "decimal bits must be Int32 literals";
                    return false;
                }
                bits[i] = word;
            }
            if (!DesignerAllowlists.TryCreateDecimalFromBits(bits, out decimal d, out err)) return false;
            value = d;
            return true;
        }

        private static bool TryMaterializeArgs(List<IrValue> args, Dictionary<string, object> inst, IIrHost host, out object?[] result, out string? err)
        {
            result = new object?[args.Count]; err = null;
            for (int i = 0; i < args.Count; i++)
            {
                if (!TryMaterialize(args[i], typeof(object), inst, host, out var av, out err)) return false;
                result[i] = av;
            }
            return true;
        }

        // -------------------------------------------------------- helpers -------------------------------------------

        private static bool TryTarget(bool isRoot, string name, Dictionary<string, object> inst, out object target, out string? err)
        {
            err = null;
            if (isRoot) { target = inst[""]; return true; }
            if (inst.TryGetValue(name, out target!)) return true;
            target = null!; err = "unknown target " + name; return false;
        }

        /// <summary>Resolve an ISupportInitialize/layout target's optional sub-object hops (`this.textEdit1.Properties`,
        /// `this.splitContainer1.Panel1`). Any missing or null hop is a hard statement failure (→ fallback), never a
        /// skipped call: a vendor editor left un-bracketed can finalize its layout differently from the compiled form.
        /// <para>Resolved through CLR REFLECTION rather than TypeDescriptor. These hops select an object that then
        /// receives a real lifecycle/layout call, so the object must be the one the C# expression denotes — a
        /// synthetic <c>ICustomTypeDescriptor</c>/<c>TypeDescriptionProvider</c> property is a design-time projection
        /// that need not correspond to any CLR member. (IrSetProperty deliberately keeps its TypeDescriptor walk: it
        /// mirrors what the property grid writes.)</para>
        /// <para>A hop hidden by `new` in a derived type is the DevExpress editor pattern — `TextEdit.Properties`
        /// redeclares `BaseEdit.Properties` with a narrower type. The MOST-DERIVED declaration is taken, which is what
        /// C# binds because the front-end only represents these hops for type-certain fields (declared type ==
        /// constructed type); an uncertain field is refused there, before any getter runs.</para></summary>
        private static string? WalkInitPath(ref object target, string name, List<string>? path, string op)
        {
            if (path == null) return null;
            for (int i = 0; i < path.Count; i++)
            {
                string hop = path[i];
                // Hop 0 starts from a type-certain field (or the root), so the instance's most-derived declaration is
                // the one C# bound. Deeper hops start from an object whose STATIC type this IR never recorded, so they
                // are only replayed when the name is declared exactly once in the hierarchy — where most-derived and
                // any-derived are the same member and the choice cannot be wrong.
                var p = MostDerived(target.GetType(), hop, requireUnique: i > 0);
                if (p == null) return op + ": no unambiguous public property " + hop + " on " + target.GetType().Name;
                var next = p.GetValue(target);
                if (next == null) return op + ": null intermediate at " + name + "." + hop;
                target = next;
            }
            return null;
        }

        /// <summary>The most-derived readable, non-indexed instance property with this name, requiring a PUBLIC getter
        /// (a public property may declare a private getter, which the equivalent C# expression could not call). With
        /// <paramref name="requireUnique"/>, refuse when more than one type in the hierarchy declares the name.</summary>
        private static System.Reflection.PropertyInfo? MostDerived(Type t, string name, bool requireUnique)
        {
            System.Reflection.PropertyInfo? best = null;
            int declarations = 0;
            for (var cur = t; cur != null; cur = cur.BaseType)
            {
                var p = cur.GetProperty(name, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.DeclaredOnly);
                if (p == null) continue;
                declarations++;
                if (best == null)
                {
                    if (p.GetIndexParameters().Length != 0) return null;
                    if (p.GetGetMethod(nonPublic: false) == null) return null;
                    best = p;
                    if (!requireUnique) break;
                }
            }
            return requireUnique && declarations > 1 ? null : best;
        }

        /// <summary>A public, non-generic, void instance method whose parameters are exactly this signature — no
        /// optional parameter, params array or by-ref, each of which would let a call with these arguments bind here
        /// while meaning something else.</summary>
        private static bool IsExactLayoutSignature(MethodInfo m, Type[] signature)
        {
            if (!m.IsPublic || m.IsGenericMethodDefinition || m.ReturnType != typeof(void)) return false;
            var ps = m.GetParameters();
            if (ps.Length != signature.Length) return false;
            for (int i = 0; i < ps.Length; i++)
            {
                if (ps[i].ParameterType != signature[i] || ps[i].IsOptional || ps[i].ParameterType.IsByRef) return false;
                if (ps[i].IsDefined(typeof(ParamArrayAttribute), false)) return false;
            }
            return true;
        }

        /// <summary>Whether a call with this many arguments could bind to <paramref name="m"/> — counting optional
        /// parameters and a trailing params array, and treating any generic method as a possible target.</summary>
        private static bool CouldAcceptArgCount(MethodInfo m, int argCount)
        {
            if (m.IsGenericMethodDefinition) return true;
            var ps = m.GetParameters();
            bool hasParamsArray = ps.Length > 0 && ps[ps.Length - 1].IsDefined(typeof(ParamArrayAttribute), false);
            int required = ps.Count(p => !p.IsOptional) - (hasParamsArray ? 1 : 0);
            return argCount >= required && (hasParamsArray || argCount <= ps.Length);
        }

        /// <summary>Remove one pending-init entry by REFERENCE (never <c>Equals</c>), keeping multiset behavior so a
        /// repeated BeginInit on the same instance still needs its own EndInit.</summary>
        private static bool RemoveByReference(List<object> pending, object target)
        {
            for (int i = 0; i < pending.Count; i++)
            {
                if (ReferenceEquals(pending[i], target)) { pending.RemoveAt(i); return true; }
            }
            return false;
        }

        /// <summary>The layout member a call on this instance binds to — the MOST-DERIVED declaration, because a
        /// vendor control may HIDE the framework method with `new` (DevExpress's XtraForm hides SuspendLayout) and the
        /// compiled form runs the vendor one. Calling `Control`'s instead would replay a different method than the
        /// build did. The declaration must still live inside the Control hierarchy, and the front-end only emits these
        /// calls for `this` or a type-certain field, so the instance's most-derived member is the one C# bound.</summary>
        private static MethodInfo? LayoutMember(Type t, string name, Type[] signature)
        {
            for (var cur = t; cur != null; cur = cur.BaseType)
            {
                // C# member lookup stops at the FIRST type declaring the name — base declarations are then not
                // candidates at all. Mirror that, and only accept a declaration whose identity is unambiguous:
                // one public, non-generic, void member matching the source arity EXACTLY. An optional parameter, a
                // params array, a generic overload, or an accessible non-public hider all mean the call may bind
                // somewhere this executor cannot reach, so the honest answer is to fail closed.
                var declared = cur.GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.DeclaredOnly)
                    .Where(m => m.Name == name).ToList();
                if (declared.Count == 0) continue;
                var exact = declared.Where(m => IsExactLayoutSignature(m, signature)).ToList();
                if (exact.Count != 1) return null;
                // Overloading is fine (Control itself declares ResumeLayout() and ResumeLayout(bool)) as long as no
                // OTHER declaration could also take this call — a generic one, or one reachable through optional
                // parameters / a params array, might be what C# picked.
                if (declared.Any(m => m != exact[0] && CouldAcceptArgCount(m, signature.Length))) return null;
                if (!typeof(Control).IsAssignableFrom(exact[0].DeclaringType)) return null;
                return exact[0];
            }
            return null;
        }

        private static string InitTargetName(string name, List<string>? path) =>
            path == null || path.Count == 0 ? name : name + "." + string.Join(".", path);

        private static bool TryNumber(IrNumber n, out object? value, out string? err)
        {
            value = null; err = null;
            string t = n.InvariantText;
            try
            {
                value = n.Kind switch
                {
                    IrNumericKind.Int32 => int.Parse(t, NumberStyles.Integer, CultureInfo.InvariantCulture),
                    IrNumericKind.Int64 => long.Parse(t, NumberStyles.Integer, CultureInfo.InvariantCulture),
                    IrNumericKind.Single => float.Parse(t, NumberStyles.Float, CultureInfo.InvariantCulture),
                    IrNumericKind.Double => double.Parse(t, NumberStyles.Float, CultureInfo.InvariantCulture),
                    IrNumericKind.Decimal => decimal.Parse(t, NumberStyles.Float, CultureInfo.InvariantCulture),
                    IrNumericKind.Byte => byte.Parse(t, NumberStyles.Integer, CultureInfo.InvariantCulture),
                    IrNumericKind.SByte => sbyte.Parse(t, NumberStyles.Integer, CultureInfo.InvariantCulture),
                    IrNumericKind.Int16 => short.Parse(t, NumberStyles.Integer, CultureInfo.InvariantCulture),
                    IrNumericKind.UInt16 => ushort.Parse(t, NumberStyles.Integer, CultureInfo.InvariantCulture),
                    IrNumericKind.UInt32 => uint.Parse(t, NumberStyles.Integer, CultureInfo.InvariantCulture),
                    IrNumericKind.UInt64 => ulong.Parse(t, NumberStyles.Integer, CultureInfo.InvariantCulture),
                    _ => throw new FormatException("kind"),
                };
                return true;
            }
            catch (Exception ex) { err = "bad numeric literal '" + t + "' (" + ex.GetType().Name + ")"; return false; }
        }

        private static bool IsNumberType(Type t) =>
            t.IsEnum || t == typeof(char) || t == typeof(decimal) || (t.IsPrimitive && t != typeof(bool) && t != typeof(IntPtr) && t != typeof(UIntPtr));

        private static bool IsNumber(object? value) => value != null && IsNumberType(value.GetType());

        /// <summary>C#'s explicit numeric conversion of <paramref name="value"/> to <paramref name="to"/> (a numeric
        /// type, char or an enum), checked: a floating or decimal value is truncated toward zero for an integral target,
        /// and a value out of range, a NaN or an infinity going to an integral type, fails.</summary>
        private static bool TryNumericCast(object value, Type to, out object? result)
        {
            result = null;
            var target = to.IsEnum ? Enum.GetUnderlyingType(to) : to;
            object source = value is Enum e ? Convert.ChangeType(e, Enum.GetUnderlyingType(e.GetType()), CultureInfo.InvariantCulture) : value;
            try
            {
                bool integral = target != typeof(float) && target != typeof(double) && target != typeof(decimal);
                if (integral)
                {
                    if (source is float or double)
                    {
                        double d = Convert.ToDouble(source, CultureInfo.InvariantCulture);
                        if (double.IsNaN(d) || double.IsInfinity(d)) return false;
                        source = Math.Truncate(d);
                    }
                    else if (source is decimal m) source = decimal.Truncate(m);
                    if (target == typeof(char) && source is double or decimal) source = Convert.ToInt64(source, CultureInfo.InvariantCulture);
                    else if (source is char c && target != typeof(char)) source = (int)c;
                }
                else if (source is char c) source = (int)c;
                object converted = Convert.ChangeType(source, target, CultureInfo.InvariantCulture);
                result = to.IsEnum ? Enum.ToObject(to, converted) : converted;
                return true;
            }
            catch (Exception ex) when (ex is OverflowException or InvalidCastException or FormatException)
            {
                return false;
            }
        }

        /// <summary>A cast of a value of static type object as C# makes it: null to a class, an interface or a nullable;
        /// an instance of the target; to a value type, unboxing exactly that type, or an enum from its underlying type and
        /// back (not for a nullable, which unboxes only its own type).</summary>
        private static bool TryCastByType(object? value, Type cast, out object? result)
        {
            result = null;
            var underlying = Nullable.GetUnderlyingType(cast);
            if (value == null) return !cast.IsValueType || underlying != null;
            var to = underlying ?? cast;
            if (to.IsInstanceOfType(value)) { result = value; return true; }
            if (underlying != null) return false;
            if (to.IsEnum && value.GetType() == Enum.GetUnderlyingType(to)) { result = Enum.ToObject(to, value); return true; }
            if (value is Enum && Enum.GetUnderlyingType(value.GetType()) == to)
            {
                result = Convert.ChangeType(value, to, CultureInfo.InvariantCulture);
                return true;
            }
            return false;
        }

        private static object? Coerce(object? v, Type target)
        {
            if (v == null) return null;
            if (target.IsInstanceOfType(v)) return v;
            try { return Convert.ChangeType(v, Nullable.GetUnderlyingType(target) ?? target, CultureInfo.InvariantCulture); }
            catch { return v; }
        }

        private static bool IsDefinedName(Type enumType, string name)
        {
            foreach (var n in Enum.GetNames(enumType)) if (n == name) return true;
            return false;
        }

        private static MethodInfo? ResolveStatic(Type t, string name, object?[] args)
        {
            foreach (var mi in t.GetMethods(BindingFlags.Public | BindingFlags.Static))
            {
                if (mi.Name != name) continue;
                var ps = mi.GetParameters();
                if (ps.Length != args.Length) continue;
                bool ok = true;
                for (int i = 0; i < ps.Length; i++)
                {
                    if (args[i] == null) { if (ps[i].ParameterType.IsValueType) { ok = false; break; } continue; }
                    if (!ps[i].ParameterType.IsInstanceOfType(args[i]) && !IsNumericAssignable(args[i]!.GetType(), ps[i].ParameterType)) { ok = false; break; }
                }
                if (ok)
                {
                    for (int i = 0; i < ps.Length; i++) args[i] = Coerce(args[i], ps[i].ParameterType);
                    return mi;
                }
            }
            return null;
        }

        private static bool IsNumericAssignable(Type from, Type to) =>
            (from == typeof(int) || from == typeof(long) || from == typeof(byte) || from == typeof(short))
            && (to == typeof(int) || to == typeof(long) || to == typeof(byte) || to == typeof(short) || to == typeof(float) || to == typeof(double));

        private static Type CollectionElementType(Type collType)
        {
            var indexer = collType.GetProperty("Item", new[] { typeof(int) });
            if (indexer != null && indexer.PropertyType != typeof(object)) return indexer.PropertyType;
            foreach (var i in collType.GetInterfaces())
                if (i.IsGenericType && i.GetGenericTypeDefinition() == typeof(IList<>)) return i.GetGenericArguments()[0];
            foreach (var i in collType.GetInterfaces())
                if (i.IsGenericType && i.GetGenericTypeDefinition() == typeof(IEnumerable<>)) return i.GetGenericArguments()[0];
            return typeof(object);
        }

        /// <summary>The collection's own single-argument <c>Add</c> for this item — how a non-IList designer collection
        /// takes one. Deliberately narrow: exactly one parameter, and the item must fit it, so the no-argument
        /// <c>Add()</c> overload vendors provide (which CREATES an element rather than adding one) can never be
        /// chosen, and neither can an unrelated multi-argument overload.</summary>
        private static MethodInfo? SingleArgAdd(Type collType, object? item)
        {
            MethodInfo? best = null;
            Type? bestParam = null;
            foreach (var m in collType.GetMethods(BindingFlags.Public | BindingFlags.Instance))
            {
                if (m.Name != "Add") continue;
                var ps = m.GetParameters();
                if (ps.Length != 1) continue;
                Type p = ps[0].ParameterType;
                if (item == null ? p.IsValueType : !p.IsInstanceOfType(item)) continue; // not applicable

                // MOST SPECIFIC applicable parameter wins, as C# overload resolution would: a collection that
                // declares both `Add(object)` and `Add(Control)` must get `Add(Control)` for a control. Reflection
                // returns methods in no defined order, so "first applicable" would pick either one from run to run —
                // and a vendor's object-typed overload can behave differently from its typed one.
                if (bestParam == null || (bestParam.IsAssignableFrom(p) && bestParam != p))
                {
                    best = m;
                    bestParam = p;
                }
                else if (!p.IsAssignableFrom(bestParam) && string.CompareOrdinal(p.FullName, bestParam.FullName) < 0)
                {
                    // Unrelated applicable parameter types (an interface each, say): neither is more specific, so
                    // pick deterministically by name rather than by whatever order reflection happened to return.
                    best = m;
                    bestParam = p;
                }
            }
            return best;
        }

        private static string Describe(IrStatement s) => s.GetType().Name;

        /// <summary>Prefix of every refusal of an <see cref="IrBuildWitnessedCtor"/>. The classifier reads it as the
        /// unrepresented statement it was before, and a partial replay leaves that statement out.</summary>
        public const string UnwitnessedPrefix = "UNWITNESSED: ";

        /// <summary>Why <paramref name="type"/> may not be constructed as a build-witnessed value, or null. Framework
        /// types go only through the construction allowlist; components are constructed as fields; delegates, abstract,
        /// generic and other non-plain types never.</summary>
        internal static string? WitnessableValueTypeRefusal(Type type)
        {
            if (type.IsAbstract || type.IsInterface) return "abstract";
            if (type.IsGenericType || type.ContainsGenericParameters) return "generic";
            if (type.IsArray || type.IsPointer || type.IsByRef || type.IsCOMObject) return "not a plain type";
            if (typeof(IComponent).IsAssignableFrom(type)) return "a component";
            if (typeof(Delegate).IsAssignableFrom(type)) return "a delegate";
            if (DesignerAllowlists.IsTrustedFrameworkType(type) || IsPlatformAssembly(type.Assembly)) return "a framework type";
            return null;
        }

        private static readonly HashSet<string> PlatformPublicKeyTokens = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "b77a5c561934e089", "b03f5f7f11d50a3a", "31bf3856ad364e35", "cc7b13ffcd2ddd51", "adb9793829ddae60", "7cec85d7bea7798e",
        };

        /// <summary>An assembly of the .NET platform itself, by its signing key or its name.</summary>
        private static bool IsPlatformAssembly(Assembly assembly)
        {
            var name = assembly.GetName();
            string simple = name.Name ?? "";
            if (simple == "mscorlib" || simple == "netstandard" || simple == "System" || simple == "WindowsBase"
                || simple == "Accessibility" || simple.StartsWith("System.", StringComparison.Ordinal)
                || simple.StartsWith("Microsoft.", StringComparison.Ordinal)
                || simple.StartsWith("Presentation", StringComparison.Ordinal)) return true;
            var token = name.GetPublicKeyToken();
            return token != null && token.Length == 8
                && PlatformPublicKeyTokens.Contains(string.Concat(token.Select(b => b.ToString("x2", CultureInfo.InvariantCulture))));
        }

        /// <summary>Walk the exception chain for a System.ComponentModel.LicenseException (reflection wraps a ctor
        /// throw in TargetInvocationException, so the license failure is usually an inner). Matched by type name so
        /// the shared executor needs no special reference.</summary>
        private static bool IsLicenseException(Exception? ex)
        {
            for (var e = ex; e != null; e = e.InnerException)
                if (e is System.ComponentModel.LicenseException || e.GetType().FullName == "System.ComponentModel.LicenseException")
                    return true;
            return false;
        }
    }
}
