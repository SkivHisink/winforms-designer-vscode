using System.Windows.Forms;

namespace FakeVendor
{
    // The NON-designer partial — declares the base (as a VS form does; the .Designer.cs partial has no base).
    public partial class FakeVendorForm : Form
    {
        public FakeVendorForm() { InitializeComponent(); }
    }
}
