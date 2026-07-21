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

        public static IrExecutionResult Success(Dictionary<string, object> instances) =>
            new IrExecutionResult { Ok = true, Instances = instances };
        public static IrExecutionResult Fail(string reason) => new IrExecutionResult { Ok = false, FailureReason = reason };
    }

    public static class DesignerIrExecutor
    {
        /// <summary>Replay <paramref name="doc"/> onto <paramref name="root"/> (already constructed by the host as
        /// the immediate BASE type — VS model). Returns Ok with the instance table, or a fail-closed reason. Only
        /// call for a FullCoverage document — a partial IR is a compiled-fallback case, decided by the caller.</summary>
        public static IrExecutionResult Execute(IrDocument doc, object root, IIrHost host)
        {
            if (root == null) return IrExecutionResult.Fail("null root");
            if (host == null) return IrExecutionResult.Fail("null host");
            // Consume-side revalidation — never trust the producer.
            var structural = IrValidate.Check(doc);
            if (structural != null) return IrExecutionResult.Fail("IR failed validation: " + structural);

            var instances = new Dictionary<string, object>(StringComparer.Ordinal) { [""] = root };
            var beganInit = new List<object>();
            // Tree nodes are LOCAL variables (not sited components), kept in their own side-table (mirrors VS's local
            // `TreeNode treeNodeN = …` serialization). Pure objects — TreeNode ctors/setters run no user code.
            var treeNodes = new Dictionary<string, TreeNode>(StringComparer.Ordinal);

            foreach (var stmt in doc!.Statements)
            {
                try
                {
                    var err = ExecuteStatement(stmt, instances, beganInit, treeNodes, host);
                    if (err != null) return Abort(beganInit, err);
                }
                catch (Exception ex)
                {
                    return Abort(beganInit, Describe(stmt) + " threw " + ex.GetType().Name + ": " + ex.Message);
                }
            }

            if (beganInit.Count != 0)
                return Abort(beganInit, "unbalanced ISupportInitialize: " + beganInit.Count + " BeginInit without EndInit");

            var result = IrExecutionResult.Success(instances);
            var idErr = BuildIdentityModel(doc, root, instances, result.Origins);
            if (idErr != null) return IrExecutionResult.Fail(idErr);
            return result;
        }

        /// <summary>Merge the two identity sources into one origin table. Every IR-created
        /// name is DeclaredInCurrentSource; the root is Root; every OTHER field-backed IComponent reachable by
        /// reflection over the runtime root type and its bases (the compiled base's own components, e.g. an inherited
        /// button) is surfaced as Inherited under its field name — so Snapshot/selection see it, but the caller marks
        /// it read-only. Fail-closed on a HIDING collision: a current-source name that reflection also finds bound to
        /// a DIFFERENT instance is ambiguous and must not be guessed.</summary>
        private static string? BuildIdentityModel(IrDocument doc, object root, Dictionary<string, object> instances, Dictionary<string, IrOrigin> origins)
        {
            origins[""] = IrOrigin.Root;
            foreach (var name in instances.Keys)
                if (name.Length != 0) origins[name] = IrOrigin.DeclaredInCurrentSource;

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
            Dictionary<string, TreeNode> treeNodes, IIrHost host)
        {
            switch (stmt)
            {
                case IrConstructComponent c:
                    {
                        if (inst.ContainsKey(c.Name)) return "duplicate component name " + c.Name;
                        var t = host.ResolveType(c.TypeName);
                        if (t == null) return "unresolved type " + c.TypeName;
                        if (!typeof(IComponent).IsAssignableFrom(t)) return c.TypeName + " is not an IComponent";
                        object created;
                        try { created = host.CreateComponent(t, c.Name, c.WithComponentsContainer); }
                        catch (Exception ex)
                        {
                            // A vendor control gated by a design-time license (LicenseException) is a distinct, expected
                            // outcome — not a crash. Prefix it so the classifier reports `licenseRequired`, mirroring the
                            // compiled engine's exit-code-3 handling. The compiled fallback hits the same wall,
                            // so the form is honestly un-previewable, but the REASON is precise.
                            if (IsLicenseException(ex)) return "LICENSE:" + c.TypeName + " requires a design-time license (" + ex.GetType().Name + ")";
                            return "cannot construct " + c.TypeName + " (" + ex.GetType().Name + ")";
                        }
                        inst[c.Name] = created ?? throw new InvalidOperationException("host returned null component for " + c.Name);
                        return null;
                    }

                case IrSetProperty p:
                    {
                        if (!TryTarget(p.TargetIsRoot, p.TargetName, inst, out var target, out var terr)) return terr;
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
                        if (!TryTarget(it.TargetIsRoot, it.TargetName, inst, out var owner, out var oerr)) return oerr;
                        for (int i = 0; i < it.PropertyPath.Count; i++)
                        {
                            var mid = TypeDescriptor.GetProperties(owner)[it.PropertyPath[i]];
                            if (mid == null) return "no property " + it.PropertyPath[i] + " on " + owner.GetType().Name;
                            owner = mid.GetValue(owner);
                            if (owner == null) return "null collection at " + it.PropertyPath[i];
                        }
                        if (owner is not IList list) return "collection target is not an IList";
                        // element type: try the collection's indexer type for materialization context, else object
                        Type elemType = CollectionElementType(owner.GetType());
                        if (!TryMaterialize(it.Item, elemType, inst, host, out var item, out var ierr)) return ierr;
                        list.Add(item);
                        return null;
                    }

                case IrBeginInit b:
                    {
                        if (!inst.TryGetValue(b.TargetName, out var o)) return "BeginInit unknown target " + b.TargetName;
                        if (o is not ISupportInitialize si) return b.TargetName + " is not ISupportInitialize";
                        si.BeginInit();
                        beganInit.Add(o);
                        return null;
                    }
                case IrEndInit e:
                    {
                        if (!inst.TryGetValue(e.TargetName, out var o)) return "EndInit unknown target " + e.TargetName;
                        if (o is not ISupportInitialize si) return e.TargetName + " is not ISupportInitialize";
                        // EndInit must match a pending BeginInit on the SAME instance (LIFO not required by WinForms, but
                        // the target must actually be open) — fail closed on a stray EndInit.
                        if (!beganInit.Remove(o)) return "EndInit without matching BeginInit for " + e.TargetName;
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

                default:
                    return "unknown statement " + stmt.GetType().Name; // unreachable while IrValidate.Closed is exact
            }
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
                        if (!TryMaterializeArgs(f.Args, inst, host, out var fargs, out err)) return false;
                        var mi = ResolveStatic(ft, f.Method, fargs);
                        if (mi == null) { err = "no static overload " + f.TypeName + "." + f.Method; return false; }
                        value = mi.Invoke(null, fargs); return true;
                    }

                case IrKnownCtor kc:
                    {
                        var ct = host.ResolveType(kc.TypeName);
                        if (ct == null) { err = "unresolved ctor type " + kc.TypeName; return false; }
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
                        value = host.ResolveResource(rr.Key, rr.IsString);
                        if (value == null && !rr.IsString) { err = "resource '" + rr.Key + "' unavailable"; return false; }
                        return true;
                    }

                case IrCast cast:
                    {
                        if (!TryMaterialize(cast.Inner, typeof(object), inst, host, out var inner, out err)) return false;
                        var ct = host.ResolveType(cast.TargetTypeName);
                        if (ct == null) { err = "unresolved cast type " + cast.TargetTypeName; return false; }
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
            return typeof(object);
        }

        private static string Describe(IrStatement s) => s.GetType().Name;

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
