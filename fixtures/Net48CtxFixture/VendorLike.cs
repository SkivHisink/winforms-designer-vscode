using System;
using System.Collections;
using System.Collections.Generic;
using System.Windows.Forms;

namespace SampleApp.VendorLike
{
    /// <summary>
    /// A control shaped like a real vendor one, for the "does this form need the user's own class to be constructed?"
    /// e2e. Two things here are ordinary in real projects and absent from anything Visual Studio's generator emits:
    /// the constructor is INTERNAL (legal — InitializeComponent is in the same assembly), and its item collection is
    /// NOT an IList, only ICollection plus a typed Add (the measured shape of PGMUI/DevExpress's
    /// TreeListColumnCollection). Either one used to drop the whole form to the compiled fallback.
    /// </summary>
    public class VendorWidget : Control
    {
        internal VendorWidget()
        {
            Columns = new VendorColumnCollection();
        }

        public VendorColumnCollection Columns { get; }
    }

    /// <summary>A Component, like a real vendor column (DevExpress columns derive from Component).</summary>
    public class VendorColumn : System.ComponentModel.Component
    {
        public string Caption { get; set; } = "";
    }

    /// <summary>ICollection + a typed Add, deliberately NOT IList — and with the vendor's no-argument Add() overload
    /// that CREATES an element, so picking the wrong overload would be visible as a wrong item.</summary>
    public sealed class VendorColumnCollection : ICollection, IEnumerable<VendorColumn>
    {
        private readonly List<VendorColumn> _items = new List<VendorColumn>();

        public int Add(VendorColumn column) { _items.Add(column); return _items.Count - 1; }
        public VendorColumn Add() { var c = new VendorColumn { Caption = "created-by-collection" }; _items.Add(c); return c; }
        public void AddRange(VendorColumn[] columns) { foreach (var c in columns) Add(c); }

        public VendorColumn this[int index] => _items[index];
        public IEnumerator<VendorColumn> GetEnumerator() { return _items.GetEnumerator(); }
        IEnumerator IEnumerable.GetEnumerator() { return _items.GetEnumerator(); }
        public void CopyTo(Array array, int index) { ((ICollection)_items).CopyTo(array, index); }
        public int Count { get { return _items.Count; } }
        public bool IsSynchronized { get { return false; } }
        public object SyncRoot { get { return this; } }
    }
}
