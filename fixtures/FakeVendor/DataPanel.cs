using System.ComponentModel;
using System.Windows.Forms;

namespace FakeVendor
{
    // Mimics a DevExpress grid/editor that depends on ISupportInitialize batching: the designer brackets its setup
    // with BeginInit/EndInit, and EndInit finalizes state. The interpreter must REPLAY these on the real instance in
    // source order (a no-op capture would leave IsInitialized false and mis-render vendor controls that lean on it).
    public class DataPanel : Panel, ISupportInitialize
    {
        private bool _initializing;

        /// <summary>True only AFTER a balanced BeginInit/EndInit pair ran — a compiled-only fact the interpreter must
        /// reproduce by actually calling the interface methods (proved by the comparator / a describe of this prop).</summary>
        public bool IsInitialized { get; private set; }

        public void BeginInit() { _initializing = true; }

        public void EndInit()
        {
            _initializing = false;
            IsInitialized = true; // the "finalize layout" a real vendor control does here
        }
    }
}
