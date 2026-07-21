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
        private readonly Dictionary<string, Type?> _typeCache = new Dictionary<string, Type?>(StringComparer.Ordinal);

        public AssemblyIrHost(IEnumerable<Assembly> assemblies, DesignTimeContainer container, SafeResxResolver resx)
        {
            _assemblies = new List<Assembly>(assemblies ?? throw new ArgumentNullException(nameof(assemblies))).ToArray();
            _container = container ?? throw new ArgumentNullException(nameof(container));
            _resx = resx ?? throw new ArgumentNullException(nameof(resx));
        }

        private bool _referencesLoaded;

        public Type? ResolveType(string typeName)
        {
            if (string.IsNullOrEmpty(typeName)) return null;
            if (_typeCache.TryGetValue(typeName, out var cached)) return cached;
            Type? found = SearchLoaded(typeName);
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
            object instance = withContainer ? ConstructWithContainer(type) : Activator.CreateInstance(type)!;
            // Site it immediately (before BeginInit / property replay / paint) so DesignMode==true suppresses runtime
            // code paths (the Timer.Start-during-render class of bugs). Non-IComponent is impossible here — the
            // executor only calls CreateComponent for an Ir construction it already type-checked as IComponent.
            if (instance is IComponent component) _container.Add(component, name);
            return instance;
        }

        public object? ResolveResource(string key, bool isString) => _resx.Resolve(key, isString);

        public bool WasResourceRefused(string key) => _resx.WasRefused(key);

        /// <summary>The `new T(this.components)` provider/tray shape: pass the design-time container to a ctor that
        /// takes an IContainer; otherwise fall back to the parameterless ctor (the executor already restricted this
        /// to the container-arg case, so a missing IContainer ctor is a genuine mismatch).</summary>
        private object ConstructWithContainer(Type type)
        {
            var ctor = type.GetConstructor(new[] { typeof(IContainer) });
            if (ctor != null) return ctor.Invoke(new object[] { _container });
            return Activator.CreateInstance(type)!;
        }
    }
}
