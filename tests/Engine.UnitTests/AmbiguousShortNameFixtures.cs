// Two components with the SAME short name in different namespaces, for the "which one does an unqualified name bind
// to?" test. C# picks the one in the form's own namespace over one reached through a `using`, and the interpreter
// must agree — otherwise it silently constructs, renders and mutates a different component type than the source.
namespace Engine.UnitTests.OwnScope
{
    /// <summary>Stands for a control declared in the FORM's own namespace.</summary>
    public sealed class Ambiguous : System.Windows.Forms.UserControl { }
}

namespace Engine.UnitTests.ImportedScope
{
    /// <summary>The same short name, reachable only through a `using`.</summary>
    public sealed class Ambiguous : System.Windows.Forms.UserControl { }
}

namespace Engine.UnitTests.Overloads
{
    using System.Collections;
    using System.Collections.Generic;
    using System.Windows.Forms;

    /// <summary>A collection declaring `Add(object)` BEFORE `Add(Control)`. Compiled `collection.Add(button)` binds
    /// the Control overload; reflection returns methods in no defined order, so a "first applicable wins" replay
    /// could invoke the object one — a different vendor code path with different collection state.</summary>
    public sealed class OverloadedAddCollection : ICollection, IEnumerable<Control>
    {
        private readonly List<Control> _items = new List<Control>();
        public string LastOverload { get; private set; } = "";

        public int Add(object item) { LastOverload = "object"; _items.Add((Control)item); return _items.Count - 1; }
        public int Add(Control item) { LastOverload = "Control"; _items.Add(item); return _items.Count - 1; }

        public IEnumerator<Control> GetEnumerator() { return _items.GetEnumerator(); }
        IEnumerator IEnumerable.GetEnumerator() { return _items.GetEnumerator(); }
        public void CopyTo(System.Array array, int index) { ((ICollection)_items).CopyTo(array, index); }
        public int Count { get { return _items.Count; } }
        public bool IsSynchronized { get { return false; } }
        public object SyncRoot { get { return this; } }
    }

    public sealed class OverloadedAddHost : UserControl
    {
        public OverloadedAddCollection Items { get; } = new OverloadedAddCollection();
    }
}
