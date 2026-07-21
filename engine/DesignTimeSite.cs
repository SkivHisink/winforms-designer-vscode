using System;
using System.Collections.Generic;
using System.ComponentModel;

namespace WinFormsDesigner.Engine
{
    // ============================================================================================================
    // A NARROW, TRUTHFUL design-time site. The interpreter constructs compiled components and must
    // site them so their design-time behavior matches VS: Site.DesignMode == true suppresses the runtime code paths
    // that plagued the un-sited compiled engine (the Timer.Start incident — a Timer whose Enabled=true would Start()
    // and dispatch its compiled Tick during the render pump). Siting happens immediately after construction, before
    // BeginInit / property replay / handle creation / paint.
    //
    // DELIBERATELY NOT an IDesignerHost: vendor code that detects a full designer host assumes
    // transactions, selection, serialization services, action lists, or modal UI we do not implement. GetService is
    // tightly allowlisted — it answers only for the container itself and returns null otherwise; vendor code that
    // needs more must tolerate null (as it must under any partial host). Services are added ONE AT A TIME only when a
    // supported corpus case proves the need — never speculatively.
    //
    // Documented limits (unavoidable): DesignMode is still false INSIDE a component's constructor (a site cannot be
    // assigned before construction); privately created nested controls may remain unsited; ISite.DesignMode == true
    // does NOT imply LicenseManager.UsageMode == Designtime. Those are separate risks handled elsewhere.
    //
    // BCL-only and shared (compile-linked into both engines) so it runs in the net48 render child domain and in
    // net10 tests. Disposal is deterministic (reverse insertion order), so a fail-closed abort can tear the partial
    // graph down cleanly.
    // ============================================================================================================
    public sealed class DesignTimeContainer : IContainer
    {
        private readonly List<IComponent> _components = new List<IComponent>();
        private bool _disposed;

        public ComponentCollection Components => new ComponentCollection(_components.ToArray());

        public void Add(IComponent component) => Add(component, null);

        public void Add(IComponent component, string? name)
        {
            if (component == null) throw new ArgumentNullException(nameof(component));
            if (_disposed) throw new ObjectDisposedException(nameof(DesignTimeContainer));
            // Re-siting an already-sited component into this container is a no-op-ish move (mirror System.ComponentModel.Container).
            component.Site?.Container?.Remove(component);
            component.Site = new DesignTimeSite(this, component, name);
            _components.Add(component);
        }

        public void Remove(IComponent component)
        {
            if (component == null) return;
            if (component.Site is DesignTimeSite s && ReferenceEquals(s.Container, this))
            {
                _components.Remove(component);
                component.Site = null;
            }
        }

        internal object? GetService(Type serviceType)
        {
            // Tightly allowlisted: only the container itself. Everything else is honestly absent.
            if (serviceType == typeof(IContainer)) return this;
            return null;
        }

        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;
            // Reverse insertion order — children before parents — so a partial graph tears down cleanly.
            for (int i = _components.Count - 1; i >= 0; i--)
            {
                try { _components[i].Dispose(); } catch { /* best effort teardown */ }
            }
            _components.Clear();
        }

        private sealed class DesignTimeSite : ISite
        {
            private readonly DesignTimeContainer _container;
            public DesignTimeSite(DesignTimeContainer container, IComponent component, string? name)
            {
                _container = container; Component = component; Name = name;
            }
            public IComponent Component { get; }
            public IContainer Container => _container;
            public bool DesignMode => true; // THE point of siting — VS-parity design-time behavior
            public string? Name { get; set; }
            public object? GetService(Type serviceType) => _container.GetService(serviceType);
        }
    }
}
