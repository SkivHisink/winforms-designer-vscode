using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Reflection;

namespace WinFormsDesigner.Engine
{
    // ============================================================================================================
    // The production IIrHost: resolves compiled types against the user's loaded assembly graph,
    // constructs + SITES each component (DesignMode=true) into a design-time container, and resolves resources
    // through the SAFE resx resolver (binary/SOAP/FileRef refused). The render child domain wires one
    // of these per interpreted render; the executor stays pure and talks only to this interface.
    //
    // Shared (BCL-only) so it runs in the net48 child domain and in tests. Type resolution mirrors the compiled
    // engine's probe order: the user's own assemblies first, then the framework/BCL probe assemblies, then a global
    // Type.GetType. It NEVER widens the security boundary — the executor still re-checks the value allowlists.
    // ============================================================================================================
    public sealed class AssemblyIrHost : IIrHost
    {
        private readonly Assembly[] _assemblies;
        private readonly DesignTimeContainer _container;
        private readonly SafeResxResolver _resx;
        private readonly string[] _namespaceContext;
        private readonly Dictionary<string, Type?> _typeCache = new Dictionary<string, Type?>(StringComparer.Ordinal);

        /// <param name="namespaceContext">The source file's own resolution scope (its usings + enclosing namespace
        /// chain) for UNQUALIFIED type names — see <see cref="IrDocument.NamespaceContext"/>. Empty is valid and
        /// means "qualified names only", which is what Visual Studio's generator always writes.</param>
        public AssemblyIrHost(IEnumerable<Assembly> assemblies, DesignTimeContainer container, SafeResxResolver resx,
            IEnumerable<string>? namespaceContext = null)
        {
            _assemblies = new List<Assembly>(assemblies ?? throw new ArgumentNullException(nameof(assemblies))).ToArray();
            _container = container ?? throw new ArgumentNullException(nameof(container));
            _resx = resx ?? throw new ArgumentNullException(nameof(resx));
            _namespaceContext = namespaceContext == null ? Array.Empty<string>() : new List<string>(namespaceContext).ToArray();
        }

        private bool _referencesLoaded;

        public Type? ResolveType(string typeName)
        {
            if (string.IsNullOrEmpty(typeName)) return null;
            if (_typeCache.TryGetValue(typeName, out var cached)) return cached;
            Type? found = SearchLoaded(typeName);
            if (found == null && typeName.IndexOf('.') < 0)
            {
                // An UNQUALIFIED name — `new VelModelControl()` under `using Vendor.Controls;`. Legal C#, and no
                // Assembly.GetType call can find it, because the CLR only knows namespace-qualified names. Try the
                // file's own scope, innermost first, exactly as the compiler would have bound it. Names only: what may
                // be CONSTRUCTED is still decided by the executor's own gates.
                found = SearchQualified(typeName);
                if (found == null)
                {
                    EnsureReferencesLoaded(); // the owning assembly may simply not be loaded yet
                    found = SearchQualified(typeName);
                }
            }
            if (found == null)
            {
                // A control from a REFERENCED vendor/sibling assembly (e.g. DevExpress.XtraEditors.SimpleButton) is not in
                // the fixed probe set, and a non-assembly-qualified name is invisible to Type.GetType. Force-load the probe
                // assemblies' references once (resolved via the child domain's probe handler), then search everything loaded
                // in this AppDomain — so real vendor forms interpret instead of falling back on every render.
                // This does not widen the value-security boundary: the executor still re-gates static reads/factories/inline
                // ctors by IsTrustedFrameworkType; broad resolution only serves component (control) construction, the
                // documented trusted-to-execute path.
                EnsureReferencesLoaded();
                found = SearchLoaded(typeName);
            }
            _typeCache[typeName] = found;
            return found;
        }

        /// <summary>Try the unqualified name against each namespace the file has in scope, in the order the compiler
        /// would consider them. The FIRST hit wins, so a `using` written closest to the code beats an ancestor
        /// namespace — the same precedence C# gives it.</summary>
        private Type? SearchQualified(string simpleName)
        {
            foreach (var ns in _namespaceContext)
            {
                if (string.IsNullOrEmpty(ns)) continue;
                var t = SearchLoaded(ns + "." + simpleName);
                if (t != null) return t;
            }
            return null;
        }

        private Type? SearchLoaded(string typeName)
        {
            foreach (var a in _assemblies)
            {
                try { var t = a.GetType(typeName, throwOnError: false); if (t != null) return t; } catch { }
            }
            try { var g = Type.GetType(typeName, throwOnError: false); if (g != null) return g; } catch { }
            foreach (var a in AppDomain.CurrentDomain.GetAssemblies())
            {
                try { var t = a.GetType(typeName, throwOnError: false); if (t != null) return t; } catch { }
            }
            return null;
        }

        private void EnsureReferencesLoaded()
        {
            if (_referencesLoaded) return;
            _referencesLoaded = true;
            foreach (var root in _assemblies)
            {
                AssemblyName[] refs;
                try { refs = root.GetReferencedAssemblies(); } catch { continue; }
                foreach (var r in refs)
                {
                    try { Assembly.Load(r); } catch { /* best-effort; the probe handler resolves what it can, misses fall back */ }
                }
            }
        }

        public object CreateComponent(Type type, string name, bool withContainer)
        {
            object instance = withContainer ? ConstructWithContainer(type) : Construct(type);
            // Site it immediately (before BeginInit / property replay / paint) so DesignMode==true suppresses runtime
            // code paths (the Timer.Start-during-render class of bugs). Non-IComponent is impossible here — the
            // executor only calls CreateComponent for an Ir construction it already type-checked as IComponent.
            if (instance is IComponent component) _container.Add(component, name);
            return instance;
        }

        public object? ResolveResource(string key, bool isString) => _resx.Resolve(key, isString);

        public bool WasResourceRefused(string key) => _resx.WasRefused(key);

        public bool ApplyResources(object target, string key, out string? error) => _resx.ApplyResources(target, key, out error);

        /// <summary>The `new T(this.components)` provider/tray shape: pass the design-time container to a ctor that
        /// takes an IContainer; otherwise fall back to the parameterless ctor (the executor already restricted this
        /// to the container-arg case, so a missing IContainer ctor is a genuine mismatch).</summary>
        private object ConstructWithContainer(Type type)
        {
            var ctor = type.GetConstructor(AnyInstanceCtor, null, new[] { typeof(IContainer) }, null);
            if (ctor != null && IsCallableFromDesignerSource(ctor)) return ctor.Invoke(new object[] { _container });
            return Construct(type);
        }

        private const BindingFlags AnyInstanceCtor = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic;

        /// <summary>
        /// Whether the designer file's own code could have called this constructor.
        ///
        /// `internal MyControl()` must be callable — InitializeComponent lives in the same assembly, so `new
        /// MyControl()` compiles there, and refusing it was what dropped real forms onto the compiled fallback. A
        /// PRIVATE or PROTECTED constructor is a different thing entirely: no designer file could have called it, so
        /// invoking it would let this interpreter construct what the source it is replaying could not. The rule is
        /// therefore accessibility as C# sees it from the designed assembly, not "any non-public constructor".
        /// </summary>
        private bool IsCallableFromDesignerSource(ConstructorInfo ctor)
        {
            if (ctor.IsPublic) return true;
            // internal / protected internal — visible only inside the declaring assembly.
            if (!ctor.IsAssembly && !ctor.IsFamilyOrAssembly) return false;
            var declaring = ctor.DeclaringType?.Assembly;
            if (declaring == null) return false;
            foreach (var a in _assemblies) if (ReferenceEquals(a, declaring)) return true;
            return false;
        }

        /// <summary>
        /// Construct a component the way the form's own code does — including through a NON-PUBLIC constructor.
        ///
        /// `internal MyControl()` is ordinary in a real project: InitializeComponent lives in the same assembly, so
        /// `new MyControl()` compiles, and a designer that can only call public constructors declares the form
        /// unrenderable over an access modifier. That is not a theoretical case — it is what dropped a real vendor
        /// form onto the compiled fallback, which is the path that runs the user's own code. The compiled path has
        /// always constructed non-public roots (RenderWorker.CreateRoot); this makes the safe path its equal.
        ///
        /// It widens HOW a type is constructed, never WHICH types may be: the executor still decides that, and only
        /// for components it type-checked.
        /// </summary>
        private object Construct(Type type)
        {
            var exact = type.GetConstructor(AnyInstanceCtor, null, Type.EmptyTypes, null);
            if (exact != null && IsCallableFromDesignerSource(exact)) return exact.Invoke(null);

            // `new Widget()` also compiles against `Widget(int value = 17)`. The compiled path has always honored
            // all-optional constructors (RenderWorker.CreateRoot); the interpreted one refused them with a
            // MissingMethodException, which cost the whole form.
            foreach (var ctor in type.GetConstructors(AnyInstanceCtor))
            {
                var ps = ctor.GetParameters();
                if (ps.Length == 0 || !AllOptional(ps) || !IsCallableFromDesignerSource(ctor)) continue;
                var args = new object?[ps.Length];
                for (int i = 0; i < ps.Length; i++) args[i] = ps[i].DefaultValue;
                return ctor.Invoke(args)!;
            }
            if (exact != null)
                throw new MissingMethodException(type.FullName + " has only a non-public constructor the designer source could not call");
            return Activator.CreateInstance(type)!; // no declared ctor at all (value types / compiler default)
        }

        private static bool AllOptional(ParameterInfo[] parameters)
        {
            foreach (var p in parameters) if (!p.IsOptional) return false;
            return true;
        }
    }
}
